/**
 * Storage on the hosted receiver. Each upload token has an allowance (its grant's maxBytes, else
 * POLYCAP_ALLOWANCE_BYTES); explicitly linked Meta/legacy grants instead share the tester allowance
 * and owner set, with tighter legacy caps preserved. A new upload that would pass it is refused, and the headset app stops
 * recording until the user deletes recordings, which deletes them here too. Above every allowance sits
 * a server-wide safety net for the disk: past POLYCAP_STORAGE_HIGH_BYTES of recordings in total, the
 * oldest finished ones are deleted until the total is under POLYCAP_STORAGE_LOW_BYTES. A recording
 * being uploaded or processed is never deleted. Bundles already synced to a Mac are not touched there.
 * An upload that has had no bytes for a day is abandoned (the headset deleted it mid-way, or gave up)
 * and is removed so it stops counting against the allowance.
 *
 * People outside the team (2026-11-12, Robin's free tier): a thread-scoped token or a signed-in tester whose person
 * holds no team token gets POLYCAP_MEMBER_ALLOWANCE_BYTES instead, and each recording they send is stamped with
 * POLYCAP_MEMBER_VIDEO_DAYS. When those days have passed its video alone is deleted: the transcript, frames, summary
 * and the mic's narration stay, so an agent can still read it, and it stops counting against any limit.
 */
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Config } from '../config.js';
import { loadSession, sessionDir } from '../session.js';
import { isReportRef } from './threads.js';
import { memberScoped, ownsUpload, type Grant } from './tokens.js';
import type { UploadRecord, UploadStore } from './uploads.js';

export const allowanceFor = (config: Config, grant: Grant) => {
  const own = ownAllowance(config, grant);
  return config.memberAllowanceBytes !== undefined && memberScoped(grant) ? Math.min(own, config.memberAllowanceBytes) : own;
};

const ownAllowance = (config: Config, grant: Grant) => {
  if (!grant.quotaOwnerIds) return grant.maxBytes ?? config.allowanceBytes;
  // All linked tokens use the tester allowance (or server default), never a larger legacy allowance.
  // Conservatively keep a tighter explicit legacy maxBytes as an additional cap on aggregate usage;
  // it restricts that credential, not the Meta account or its other devices.
  return Math.min(grant.quotaMaxBytes ?? config.allowanceBytes, grant.maxBytes ?? Infinity);
};

export interface Account { grantId: string; usedBytes: number; allowanceBytes: number; recordings: number }

/** Sent from the deck's bug key: the team's, not the sender's (docs/THREADS.md, Reports). */
export const isReport = (record: Pick<UploadRecord, 'thread'>) => isReportRef(record.thread);

/**
 * What a grant's recordings take against its allowance. Reports have an allowance of their own, the same
 * size: the sender cannot see or delete them, so they must not fill the tape the headset shows, and the
 * separate cap still keeps one headset from filling the disk with them.
 */
export async function account(config: Config, store: UploadStore, grant: Grant, reports = false): Promise<Account> {
  // One pass counts every linked owner once, including unfinished uploads, narration and logs, not tombstones.
  const live = (await store.list()).filter(r => r.status !== 'deleted' && isReport(r) === reports
    && (grant.quotaOwnerIds ? grant.quotaOwnerIds.includes(r.grantId) : ownsUpload(grant, r.grantId)));
  const usedBytes = live.reduce((sum, r) => sum + videoBytes(r) + (r.narration?.bytes ?? 0) + (r.logs?.bytes ?? 0), 0);
  return { grantId: grant.id, usedBytes, allowanceBytes: allowanceFor(config, grant), recordings: live.length };
}

/** What a recording's video takes: nothing once its kept days ran out and it was deleted, or for a take of logs alone. */
export const videoBytes = (record: UploadRecord) => record.videoDeletedAt ? 0 : record.bytes ?? 0;

/** Uploading, waiting for or in the worker: deleting now would race the writer. */
export const inFlight = (record: UploadRecord) => record.status === 'received' || record.status === 'processing';

/** Removes the bundle and the upload's files, keeping a tombstone that says why. */
export async function deleteRecording(config: Config, store: UploadStore, record: UploadRecord, reason: NonNullable<UploadRecord['deletedReason']>): Promise<UploadRecord> {
  if (record.sessionId) await rm(sessionDir(config, record.sessionId), { recursive: true, force: true });
  return store.markDeleted(record.id, reason);
}

const ABANDONED_MS = 24 * 3600_000;

/** The server-wide safety net. Returns the uploads it deleted, oldest first. */
export async function enforceServerLimit(config: Config, store: UploadStore, log: (line: string) => void): Promise<string[]> {
  for (const record of await store.list()) {
    if (record.status !== 'uploading' || store.isBusy(record.id)) continue;
    if (Date.now() - await store.lastActivity(record) < ABANDONED_MS) continue;
    // Its words may already be a session (the narration came first); that goes with it.
    await deleteRecording(config, store, record, 'abandoned upload');
    log(`abandoned upload ${record.id} removed (no bytes for a day)`);
  }
  await expireVideos(config, store, log);
  const records = await store.list();
  let total = records.filter(r => r.status !== 'deleted').reduce((sum, r) => sum + videoBytes(r), 0);
  if (total <= config.storageHighBytes) return [];
  const deleted: string[] = [];
  // A recording whose video already went frees nothing, and its bundle is what was meant to stay.
  const oldestFirst = records.filter(r => (r.status === 'ready' || r.status === 'failed') && !r.videoDeletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of oldestFirst) {
    if (total <= config.storageLowBytes) break;
    await deleteRecording(config, store, record, 'server storage limit');
    total -= videoBytes(record);
    deleted.push(record.id);
    log(`storage limit: deleted ${record.id} (${record.sessionId ?? 'no session'}, ${(videoBytes(record) / 1e9).toFixed(2)} GB); total now ${(total / 1e9).toFixed(2)} GB`);
  }
  if (total > config.storageLowBytes) log(`storage limit: still ${(total / 1e9).toFixed(2)} GB after deleting every finished recording`);
  return deleted;
}

const DAY_MS = 24 * 3600_000;

/**
 * Deletes the video of every finished recording whose kept days (keepVideoDays) have run out, leaving its bundle
 * and record. Runs with the safety net: at start-up, after each recording is built, and hourly (serve.ts).
 * Returns the uploads whose video went. A recording still uploading or in the worker waits for the next pass.
 */
export async function expireVideos(config: Config, store: UploadStore, log: (line: string) => void, now = Date.now()): Promise<string[]> {
  const expired: string[] = [];
  for (const record of await store.list()) {
    // A take of logs alone has no video to expire.
    if (!record.keepVideoDays || record.videoDeletedAt || record.fileName === undefined || (record.status !== 'ready' && record.status !== 'failed')) continue;
    if (store.isBusy(record.id) || Date.parse(record.createdAt) + record.keepVideoDays * DAY_MS > now) continue;
    if (record.sessionId) {
      const dir = sessionDir(config, record.sessionId);
      const name = (await loadSession(dir).catch(() => undefined))?.media.video;
      const path = name ? resolve(dir, name) : undefined;
      // Only ever a file inside the session's own folder, as playback reads it.
      if (path?.startsWith(dir + sep)) await rm(path, { force: true });
    }
    await store.update(record.id, { videoDeletedAt: new Date(now).toISOString() });
    expired.push(record.id);
    log(`video kept ${record.keepVideoDays} day(s): deleted the video of ${record.id} (${record.sessionId ?? 'no session'}, ${((record.bytes ?? 0) / 1e9).toFixed(2)} GB); its bundle stays`);
  }
  return expired;
}
