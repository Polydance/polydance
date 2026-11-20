/**
 * Uploads on the hosted receiver: uploads/<id>/meta.json plus the bytes as they arrive. The size of
 * the partial file is the only record of progress, so a dropped connection resumes from exactly what
 * reached the disk. A finished upload is accepted only when its sha256 matches what the client
 * declared up front. One recording is one upload, keyed on the client's own id, so a retried create
 * returns the same upload instead of a duplicate.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { exists, privateDir, readJson, sha256File, writeJsonAtomic } from '../fsx.js';
import { appSwitchSchema, LOGS_FILE, logsSourceSchema, MAX_LOGS, NARRATION_FILE, openedSchema } from '../session.js';
import { threadKeySchema } from '../threads.js';
import { uploadThreadSchema } from './threads.js';

export const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** About an hour of the app's 128 kbps mono narration. */
export const MAX_NARRATION = 64 * 1024 * 1024;

/**
 * The upload's fields, before the rule that ties them together (createUploadSchema). `bytes`, `sha256` and
 * `fileName` describe the take's media file: a video, or the microphone alone as .m4a when the screen was not
 * recorded. A take of logs alone has no media file and none of the three (docs/LOGS.md).
 */
const uploadFields = z.strictObject({
  clientId: z.string().regex(CLIENT_ID),
  bytes: z.number().int().positive().optional(),
  sha256: sha.optional(),
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(mp4|webm|mkv|mov|m4a)$/).optional(),
  /** The take's length; what a take of logs alone has instead of a file to probe. */
  durationMs: z.number().int().positive().max(24 * 3_600_000).optional(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
  appPackage: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional(),
  device: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  /** Which app was in front from when during the recording, with its version (the headset app with Usage access). */
  apps: z.array(appSwitchSchema).max(200).optional(),
  /** What each audio track is, in file order (mic, app), so a clip can be cut with one and not the other. */
  audioTracks: z.array(z.enum(['mic', 'app'])).min(1).max(4).optional(),
  /** The build of appPackage that made the recording; the bundle records it so feedback maps to a commit. */
  app: z.strictObject({
    versionName: z.string().regex(/^[A-Za-z0-9._+-]{1,40}$/),
    versionCode: z.number().int().nonnegative().optional(),
    commit: z.string().regex(/^([0-9a-f]{7,40}(-dirty)?|unknown)$/).optional(),
  }).optional(),
  /** The thread this recording replies in, or the project of the new thread it opens (docs/THREADS.md). */
  thread: uploadThreadSchema.optional(),
  /** What the app opened from launches while recording, and when. */
  opened: z.array(openedSchema).max(100).optional(),
  /**
   * The mic track alone as an .m4a, which the client sends whole before the video so the words are
   * transcribed and summarised while the video is still on its way (Robin, 2026-10-04).
   */
  narration: z.strictObject({ bytes: z.number().int().positive().max(MAX_NARRATION), sha256: sha }).optional(),
  /**
   * The headset's log for the take (logcat.txt), sent whole before the narration and the media, with what the
   * pipeline needs to put its lines on the take's clock (docs/LOGS.md).
   */
  logs: logsSourceSchema.extend({ bytes: z.number().int().positive().max(MAX_LOGS), sha256: sha }).optional(),
  /** The notice the person accepted in the app before recording (privacy.ts); testers must send it. */
  consent: z.string().regex(/^capture-hosted-\d{1,3}$/).optional(),
});

/** A media file is all three of bytes, sha256 and fileName, or none; without one, logs and the take's length. */
export const createUploadSchema = uploadFields.superRefine((input, ctx) => {
  const declared = [input.bytes, input.sha256, input.fileName].filter(v => v !== undefined).length;
  if (declared !== 0 && declared !== 3) ctx.addIssue({ code: 'custom', path: ['fileName'], message: 'bytes, sha256 and fileName describe the media file: send all three, or none for a take of logs alone' });
  if (declared === 0 && !input.logs) ctx.addIssue({ code: 'custom', path: ['logs'], message: 'a take with no media file must send its logs' });
  if (declared === 0 && input.durationMs === undefined) ctx.addIssue({ code: 'custom', path: ['durationMs'], message: 'a take with no media file must say how long it was' });
  if (declared === 0 && input.narration) ctx.addIssue({ code: 'custom', path: ['narration'], message: 'a narration goes ahead of a media file, and this take has none' });
});
export type CreateUpload = z.infer<typeof createUploadSchema>;

export const STATUSES = ['uploading', 'received', 'processing', 'ready', 'failed', 'deleted'] as const;
const recordSchema = uploadFields.extend({
  version: z.literal(1),
  id: z.string().regex(/^up_[0-9a-f]{16}$/),
  grantId: z.string(),
  status: z.enum(STATUSES),
  sessionId: z.string().optional(),
  /** The thread and message this recording is, once it is in one. */
  threadKey: threadKeySchema.optional(), threadMessage: z.number().int().positive().optional(),
  /** When the declared narration arrived and matched its sha256. */
  narrationAt: z.string().optional(),
  /** When the declared logs arrived and matched their sha256. */
  logsAt: z.string().optional(),
  error: z.string().optional(),
  /** A deleted upload keeps this small record so the headset can be told why its recording went. */
  deletedAt: z.string().optional(), deletedReason: z.enum(['user', 'server storage limit', 'abandoned upload']).optional(),
  /**
   * For someone outside the team (POLYCAP_MEMBER_VIDEO_DAYS when it arrived, 2026-11-12): the days its video is kept,
   * counted from createdAt. Fixed when the upload is made, so a later change to the setting moves no one's deadline.
   * Without it the video is kept until the recording is deleted.
   */
  keepVideoDays: z.number().int().positive().optional(),
  /** When that time ran out and the video alone was deleted; the bundle and the record stay. */
  videoDeletedAt: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type UploadRecord = z.infer<typeof recordSchema>;

/** What a client sees: progress and outcome, never paths. */
export interface UploadView {
  id: string; clientId: string; bytes: number; received: number; status: UploadRecord['status']; sessionId?: string; thread?: string; error?: string; deletedReason?: UploadRecord['deletedReason'];
  /** A declared narration: still to send, or here. */
  narration?: 'expected' | 'received';
  /** Declared logs: still to send, or here. */
  logs?: 'expected' | 'received';
  /** What the take's media file is: a picture (with or without sound), sound alone, or none (logs alone). */
  content: Content;
  /** Its video was deleted when its kept days ran out (keepVideoDays); the words and frames are still there. */
  videoDeletedAt?: string;
}

export type Content = 'video' | 'sound' | 'none';
/** What an upload's media file is, from its name: a take of logs alone has none. */
export const contentOf = (fileName: string | undefined): Content => fileName === undefined ? 'none' : fileName.toLowerCase().endsWith('.m4a') ? 'sound' : 'video';

export class ConflictError extends Error {}

export class UploadStore {
  private readonly busy = new Set<string>();
  /** One read-modify-write at a time per upload: the HTTP layer and the worker both change records. */
  private readonly updating = new Map<string, Promise<UploadRecord>>();
  constructor(readonly dir: string) {}

  private folder = (id: string) => join(this.dir, id);
  private metaPath = (id: string) => join(this.folder(id), 'meta.json');
  partPath = (id: string) => join(this.folder(id), 'video.part');
  videoPath = (id: string) => join(this.folder(id), 'video.mp4');
  private narrationPart = (id: string) => join(this.folder(id), 'narration.part');
  narrationPath = (id: string) => join(this.folder(id), NARRATION_FILE);
  private logsPart = (id: string) => join(this.folder(id), 'logs.part');
  logsPath = (id: string) => join(this.folder(id), LOGS_FILE);

  async get(id: string): Promise<UploadRecord | undefined> {
    if (!/^up_[0-9a-f]{16}$/.test(id) || !await exists(this.metaPath(id))) return undefined;
    return readJson(this.metaPath(id), recordSchema);
  }

  async list(): Promise<UploadRecord[]> {
    if (!await exists(this.dir)) return [];
    const records: UploadRecord[] = [];
    for (const name of await readdir(this.dir)) { const record = await this.get(name); if (record) records.push(record); }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<Pick<UploadRecord, 'status' | 'sessionId' | 'threadKey' | 'threadMessage' | 'narrationAt' | 'logsAt' | 'error' | 'deletedAt' | 'deletedReason' | 'videoDeletedAt'>>): Promise<UploadRecord> {
    const write = async () => {
      const record = await this.get(id);
      if (!record) throw new Error(`upload ${id} vanished`);
      const next = recordSchema.parse({ ...record, ...patch, updatedAt: new Date().toISOString() });
      await writeJsonAtomic(this.metaPath(id), next);
      return next;
    };
    const next = (this.updating.get(id) ?? Promise.resolve()).catch(() => undefined).then(write);
    this.updating.set(id, next);
    next.finally(() => { if (this.updating.get(id) === next) this.updating.delete(id); }).catch(() => undefined);
    return next;
  }

  /** Same client id from the same grant returns the existing upload; a different file under that id is a conflict. */
  async create(grantId: string, input: CreateUpload, keepVideoDays?: number): Promise<{ record: UploadRecord; created: boolean }> {
    const existing = await this.findLive(grantId, input.clientId);
    if (existing) {
      if (existing.sha256 !== input.sha256 || existing.bytes !== input.bytes || existing.logs?.sha256 !== input.logs?.sha256) throw new ConflictError(`client id ${input.clientId} was already used for a different file`);
      return { record: existing, created: false };
    }
    const id = `up_${randomBytes(8).toString('hex')}`;
    await privateDir(this.folder(id));
    const now = new Date().toISOString();
    const record = recordSchema.parse({ ...input, version: 1, id, grantId, status: 'uploading', ...(keepVideoDays ? { keepVideoDays } : {}), createdAt: now, updatedAt: now });
    await writeJsonAtomic(this.metaPath(id), record);
    return { record, created: true };
  }

  async findLive(grantId: string, clientId: string): Promise<UploadRecord | undefined> {
    return (await this.list()).find(r => r.grantId === grantId && r.clientId === clientId && r.status !== 'deleted');
  }

  async received(record: UploadRecord): Promise<number> {
    if (record.status === 'deleted' || record.bytes === undefined) return 0;
    if (record.status !== 'uploading') return record.bytes;
    return (await stat(this.partPath(record.id)).catch(() => undefined))?.size ?? 0;
  }

  async view(record: UploadRecord): Promise<UploadView> {
    return {
      id: record.id, clientId: record.clientId, bytes: record.bytes ?? 0, received: await this.received(record), status: record.status, sessionId: record.sessionId, thread: record.threadKey, error: record.error, deletedReason: record.deletedReason,
      content: contentOf(record.fileName),
      ...(record.narration && record.status !== 'deleted' ? { narration: record.narrationAt ? 'received' as const : 'expected' as const } : {}),
      ...(record.logs && record.status !== 'deleted' ? { logs: record.logsAt ? 'received' as const : 'expected' as const } : {}),
      ...(record.videoDeletedAt && record.status !== 'deleted' ? { videoDeletedAt: record.videoDeletedAt } : {}),
    };
  }

  /**
   * The declared narration, whole, in one request. It is kept only when its length and sha256 are what
   * the create said; anything else is dropped and the client sends it again or carries on with the
   * video, which holds the same sound.
   */
  async putNarration(record: UploadRecord, length: number, body: Readable): Promise<UploadRecord> {
    const key = `${record.id}/narration`;
    if (this.busy.has(key)) throw new ConflictError('another request is sending this narration');
    this.busy.add(key);
    try {
      if (!record.narration) throw new ConflictError('this upload did not declare a narration');
      if (length !== record.narration.bytes) throw new ConflictError(`the narration is declared as ${record.narration.bytes} bytes`);
      const part = this.narrationPart(record.id);
      let written = 0;
      body.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > length) body.destroy(new ConflictError(`body is longer than the declared ${length} bytes`));
      });
      await pipeline(body, createWriteStream(part, { mode: 0o600 })).catch(async error => { await rm(part, { force: true }); throw error; });
      if (written !== length) { await rm(part, { force: true }); throw new ConflictError('the narration ended early; send it again'); }
      if (await sha256File(part) !== record.narration.sha256) { await rm(part, { force: true }); throw new ConflictError('the narration does not match its sha256; send it again'); }
      await rename(part, this.narrationPath(record.id));
      return await this.update(record.id, { narrationAt: new Date().toISOString() });
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * The declared logs, whole, in one request, kept only when their length and sha256 are what the create said.
   * They come first, so a take of logs alone is complete, and received, once they are here.
   */
  async putLogs(record: UploadRecord, length: number, body: Readable): Promise<UploadRecord> {
    const key = `${record.id}/logs`;
    if (this.busy.has(key)) throw new ConflictError('another request is sending these logs');
    this.busy.add(key);
    try {
      if (!record.logs) throw new ConflictError('this upload did not declare logs');
      if (length !== record.logs.bytes) throw new ConflictError(`the logs are declared as ${record.logs.bytes} bytes`);
      const part = this.logsPart(record.id);
      let written = 0;
      body.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > length) body.destroy(new ConflictError(`body is longer than the declared ${length} bytes`));
      });
      await pipeline(body, createWriteStream(part, { mode: 0o600 })).catch(async error => { await rm(part, { force: true }); throw error; });
      if (written !== length) { await rm(part, { force: true }); throw new ConflictError('the logs ended early; send them again'); }
      if (await sha256File(part) !== record.logs.sha256) { await rm(part, { force: true }); throw new ConflictError('the logs do not match their sha256; send them again'); }
      await rename(part, this.logsPath(record.id));
      return await this.update(record.id, { logsAt: new Date().toISOString(), ...(record.bytes === undefined ? { status: 'received' as const } : {}) });
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * Appends exactly `length` bytes at `offset`, which must be what has already arrived. A body that
   * ends early leaves what did arrive; the client asks for the offset and continues from there.
   * Returns the new received count and whether the file is complete and verified.
   */
  async append(record: UploadRecord, offset: number, length: number, body: Readable): Promise<{ received: number; complete: boolean }> {
    if (this.busy.has(record.id)) throw new ConflictError('another request is writing this upload');
    this.busy.add(record.id);
    try {
      if (record.bytes === undefined || record.sha256 === undefined) throw new ConflictError('this take has no media file: it is its logs alone');
      // The logs go first, so the bundle is never built from the media without the logs it declared.
      if (record.logs && !record.logsAt) throw new ConflictError('send the declared logs first');
      const have = await this.received(record);
      if (record.status !== 'uploading') throw new ConflictError(`upload is ${record.status}`);
      if (offset !== have) throw new ConflictError(`expected offset ${have}`);
      if (offset + length > record.bytes) throw new ConflictError(`chunk ends past the declared ${record.bytes} bytes`);
      let written = 0;
      const out = createWriteStream(this.partPath(record.id), { flags: 'a', mode: 0o600 });
      body.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > length) body.destroy(new ConflictError(`body is longer than the ${length} bytes in Content-Range`));
      });
      await pipeline(body, out).catch(async error => {
        // Keep only whole, declared bytes; anything past the chunk is cut off.
        const size = (await stat(this.partPath(record.id))).size;
        if (size > offset + length) await truncate(this.partPath(record.id), offset + length);
        throw error;
      });
      const now = await this.received(record);
      if (now < record.bytes) return { received: now, complete: false };
      if (await sha256File(this.partPath(record.id)) !== record.sha256) {
        // Corrupt: start over rather than keep bytes that cannot be the declared file.
        await rm(this.partPath(record.id), { force: true });
        throw new ConflictError('sha256 does not match; the upload was reset to 0');
      }
      await rename(this.partPath(record.id), this.videoPath(record.id));
      await this.update(record.id, { status: 'received' });
      return { received: record.bytes, complete: true };
    } finally {
      this.busy.delete(record.id);
    }
  }

  /** Bytes a grant's recordings take, counting an unfinished upload at its declared size so it cannot overshoot. */
  async usage(grantId?: string): Promise<{ bytes: number; recordings: number }> {
    const live = (await this.list()).filter(r => r.status !== 'deleted' && (grantId === undefined || r.grantId === grantId));
    // A video deleted when its kept days ran out no longer takes room (storage.ts, expireVideos).
    return { bytes: live.reduce((sum, r) => sum + (r.videoDeletedAt ? 0 : r.bytes ?? 0) + (r.narration?.bytes ?? 0) + (r.logs?.bytes ?? 0), 0), recordings: live.length };
  }

  /** Drops the upload's own files and leaves a tombstone; the caller removes the session. */
  async markDeleted(id: string, reason: NonNullable<UploadRecord['deletedReason']>): Promise<UploadRecord> {
    await rm(this.partPath(id), { force: true });
    await rm(this.videoPath(id), { force: true });
    await rm(this.narrationPart(id), { force: true });
    await rm(this.narrationPath(id), { force: true });
    await rm(this.logsPart(id), { force: true });
    await rm(this.logsPath(id), { force: true });
    return this.update(id, { status: 'deleted', deletedAt: new Date().toISOString(), deletedReason: reason, error: undefined });
  }

  isBusy(id: string): boolean { return this.busy.has(id) || this.busy.has(`${id}/narration`) || this.busy.has(`${id}/logs`); }

  /** When bytes last arrived for an unfinished upload (its partial file), else when it was created. */
  async lastActivity(record: UploadRecord): Promise<number> {
    return (await stat(this.partPath(record.id)).catch(() => undefined))?.mtimeMs ?? Date.parse(record.createdAt);
  }

  /** After the session holds the video (hard link or copy), the upload's own name for it is dropped. */
  async releaseVideo(id: string): Promise<void> { await rm(this.videoPath(id), { force: true }); }

  /** Likewise the narration, once the session has it. */
  async releaseNarration(id: string): Promise<void> { await rm(this.narrationPath(id), { force: true }); }

  /** And the logs. */
  async releaseLogs(id: string): Promise<void> { await rm(this.logsPath(id), { force: true }); }
}
