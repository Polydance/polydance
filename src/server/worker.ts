/**
 * Turns verified uploads into bundles, one at a time: the same receiver `polycap import` uses
 * (createSession) and the same pipeline `polycap process` runs. The upload's status follows along so
 * the headset can show it. On start-up anything received or half-processed is picked up again. With
 * threads on, the session records its thread (so the summary knows what was asked), and the thread hears
 * when the bundle is ready or has failed.
 *
 * Words first: when a narration arrives ahead of its video, the session is made from it and its words
 * are built (transcript, markers, requests, a storyboard without frames) while the video is still
 * uploading, and the thread hears `recording.words`. The video then joins the same session and the
 * rest is built as usual. The words pass never changes the upload's status, so it cannot get in the
 * way of the video's own upload.
 */
import { join } from 'node:path';
import type { Config } from '../config.js';
import { exists, linkOrCopy } from '../fsx.js';
import { processSession } from '../pipeline/run.js';
import { createSession, loadSession, LOGS_FILE, saveSession, sessionDir, STEP_NAMES, wordsOnly, type SessionSource } from '../session.js';
import { enforceServerLimit } from './storage.js';
import type { ThreadStore, UploadLink } from './threads.js';
import type { Grant } from './tokens.js';
import type { UploadRecord, UploadStore } from './uploads.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class Worker {
  private readonly queue: string[] = [];
  private running?: Promise<void>;
  private current?: string;
  /**
   * Called once a recording's bundle is built and its thread has heard (the Welcome's follow-up, welcome.ts):
   * after the thread store has let go, one upload at a time. A failure is logged and changes nothing else.
   */
  onBuilt?: (link: UploadLink) => Promise<unknown>;

  constructor(
    private readonly config: Config, private readonly store: UploadStore, private readonly log: (line: string) => void,
    private readonly threads?: ThreadStore, private readonly grants: readonly Grant[] = [],
  ) {}

  enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.running ??= this.drain().finally(() => { this.running = undefined; });
  }

  /** True while this upload's bundle is being built: deleting it then would race the pipeline. */
  isWorking(id: string): boolean { return this.current === id; }

  async recover(): Promise<number> {
    await enforceServerLimit(this.config, this.store, this.log).catch(error => this.log(`storage limit check failed: ${message(error)}`));
    const pending = (await this.store.list()).filter(r => r.status === 'received' || r.status === 'processing' || (r.status === 'uploading' && r.narrationAt && !r.sessionId));
    for (const record of pending.reverse()) this.enqueue(record.id);
    return pending.length;
  }

  /**
   * The storage checks with nothing to build (serve.ts, hourly): kept days that ran out, and the safety net. While a
   * recording is being built they wait, since the worker runs them itself once it is done.
   */
  sweep(): void {
    if (this.running) return;
    void enforceServerLimit(this.config, this.store, this.log).catch(error => this.log(`storage limit check failed: ${message(error)}`));
  }

  /** Resolves when the queue is empty; for tests and a clean shutdown. */
  async idle(): Promise<void> { while (this.running) await this.running; }

  private async drain(): Promise<void> {
    for (let id = this.queue.shift(); id; id = this.queue.shift()) {
      this.current = id;
      try { await this.handle(id); }
      catch (error) {
        this.log(`upload ${id} failed: ${message(error)}`);
        const record = await this.store.update(id, { status: 'failed', error: message(error) }).catch(() => undefined);
        const link = record && this.link(record);
        if (link) await this.threads?.recordingFinished(link, { error: message(error) }).catch(e => this.log(`thread ${link.key}: ${message(e)}`));
      } finally { this.current = undefined; }
      await enforceServerLimit(this.config, this.store, this.log).catch(error => this.log(`storage limit check failed: ${message(error)}`));
    }
  }

  private link = (record: UploadRecord): UploadLink | undefined =>
    record.threadKey && record.threadMessage ? { key: record.threadKey, message: record.threadMessage } : undefined;

  /** An upload the HTTP layer could not put in its thread (a crash in between) goes in now. */
  private async ensureThread(record: UploadRecord): Promise<UploadRecord> {
    if (!this.threads?.enabled || record.threadKey) return record;
    const grant = this.grants.find(g => g.id === record.grantId);
    if (!grant) return record;
    const link = await this.threads.attachRecording(grant, record, record.thread);
    return this.store.update(record.id, { threadKey: link.key, threadMessage: link.message });
  }

  /**
   * The session for an upload, made from its video, or from its narration alone while the video is on its way,
   * with its logs when it sent some. A take of logs alone (no media file, docs/LOGS.md) is made from its logs:
   * they are its original, and it says its own length.
   */
  private async newSession(record: UploadRecord, withVideo: boolean): Promise<UploadRecord> {
    const link = this.link(record);
    const thread = link ? await this.threads?.context(link) : undefined;
    const logs = record.logs && (({ bytes: _b, sha256: _s, ...about }) => about)(record.logs);
    const source: Omit<SessionSource, 'bytes' | 'sha256' | 'originalName'> = {
      kind: 'upload', uploadId: record.id, clientId: record.clientId, appPackage: record.appPackage, appBuild: record.app, audioTracks: record.audioTracks, apps: record.apps,
      deviceModel: typeof record.device?.model === 'string' ? record.device.model : undefined, thread, opened: record.opened, ...(logs ? { logs } : {}),
    };
    const media = record.fileName !== undefined;
    if (!media && !(record.logs && record.logsAt)) throw new Error('a take of logs alone arrived without its logs');
    const { manifest } = await createSession(this.config, {
      localFile: withVideo && media ? this.store.videoPath(record.id) : undefined, narrationFile: record.narrationAt ? this.store.narrationPath(record.id) : undefined,
      logsFile: record.logsAt ? this.store.logsPath(record.id) : undefined, durationMs: media ? undefined : record.durationMs,
      originalName: record.fileName ?? LOGS_FILE, bytes: record.bytes ?? record.logs!.bytes, sha256: record.sha256 ?? record.logs!.sha256,
      recordedAt: record.recordedAt ? new Date(record.recordedAt) : undefined, source,
    });
    // The words pass leaves the status alone: the video's upload owns it until the video is in.
    const updated = await this.store.update(record.id, withVideo ? { status: 'processing', sessionId: manifest.id } : { sessionId: manifest.id });
    if (withVideo && media) await this.store.releaseVideo(record.id);
    if (record.narrationAt) await this.store.releaseNarration(record.id);
    if (record.logsAt) await this.store.releaseLogs(record.id);
    this.log(`upload ${record.id} -> session ${manifest.id}${withVideo ? (media ? '' : ' (logs alone)') : ' (words first; the video is still uploading)'}`);
    return updated;
  }

  /** Logs that arrived after the words pass made the session (a client that sent them late) join it, and are read. */
  private async joinLogs(record: UploadRecord, dir: string): Promise<void> {
    if (!record.logs || !record.logsAt || !await exists(this.store.logsPath(record.id))) return;
    const manifest = await loadSession(dir);
    if (!manifest.media.logs) {
      await linkOrCopy(this.store.logsPath(record.id), join(dir, LOGS_FILE));
      const { bytes: _b, sha256: _s, ...about } = record.logs;
      await saveSession(dir, { ...manifest, source: { ...manifest.source, logs: about }, media: { ...manifest.media, logs: LOGS_FILE }, steps: { ...manifest.steps, logs: { status: 'pending' } } });
    }
    await this.store.releaseLogs(record.id);
  }

  /** Words first: transcript, markers, requests and a frameless storyboard from the narration; the thread hears. */
  private async hear(record: UploadRecord): Promise<void> {
    if (!record.sessionId) record = await this.newSession(record, false);
    const dir = sessionDir(this.config, record.sessionId!);
    const before = wordsOnly(await loadSession(dir));
    const manifest = await processSession(this.config, dir, { log: this.log });
    if (before || !wordsOnly(manifest) || manifest.steps.transcribe.status !== 'done') return;
    this.log(`upload ${record.id} words ready${manifest.summary ? `: ${manifest.summary.title}` : ''}`);
    const link = this.link(record);
    if (link) await this.threads?.recordingWords(link, { sessionId: manifest.id, title: manifest.summary?.title, summary: manifest.summary?.text });
  }

  private async handle(id: string): Promise<void> {
    let record = await this.store.get(id);
    if (!record) return;
    if (record.status === 'uploading' && record.narrationAt) {
      // A words pass that fails is logged and left: the video is still coming and the full build follows it.
      try { await this.hear(await this.ensureThread(record)); }
      catch (error) { this.log(`upload ${id} words first failed: ${message(error)}`); }
      return;
    }
    if (record.status !== 'received' && record.status !== 'processing') return;
    record = await this.ensureThread(record);
    if (!record.sessionId) record = await this.newSession(record, true);
    else {
      // The video joins a session its narration began (or one whose build was cut off by a restart).
      const dir = sessionDir(this.config, record.sessionId);
      const name = (await loadSession(dir)).media.video;
      const target = name === undefined ? undefined : join(dir, name);
      if (target && !await exists(target) && await exists(this.store.videoPath(id))) await linkOrCopy(this.store.videoPath(id), target);
      await this.store.releaseVideo(id);
      await this.joinLogs(record, dir);
      if (record.status === 'received') record = await this.store.update(id, { status: 'processing' });
    }
    const manifest = await processSession(this.config, sessionDir(this.config, record.sessionId!), { log: this.log });
    // Ready means the pipeline ran to the end; a failed step is in the manifest and summarised here.
    const failed = STEP_NAMES.filter(name => manifest.steps[name].status === 'failed');
    await this.store.update(id, { status: 'ready', error: failed.length ? `steps failed: ${failed.map(n => `${n} (${manifest.steps[n].error ?? 'no detail'})`).join('; ')}` : undefined });
    this.log(`upload ${id} ready${failed.length ? ` with failed steps: ${failed.join(', ')}` : ''}`);
    const link = this.link(record);
    if (!link || !this.threads) return;
    await this.threads.recordingFinished(link, { sessionId: manifest.id, title: manifest.summary?.title, summary: manifest.summary?.text });
    await this.onBuilt?.(link).catch(error => this.log(`thread ${link.key}: after the bundle: ${message(error)}`));
  }
}
