/**
 * Playing a thread's recording on the headset (2026-10-12): its words and moments as JSON, and its video
 * in byte ranges for a player to seek in. Both are reached through the thread rather than /v1/sessions,
 * so a headset's upload-only token can play without the `read` scope that syncs whole bundles; the routes
 * check canPlay first. The files are the session's own, read through their schemas (a missing one is an
 * empty list, a damaged one an error), and the video is never a path outside the session's folder.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ZodType } from 'zod';
import { exists, readJson } from '../fsx.js';
import { markersFileSchema } from '../pipeline/markers.js';
import { transcriptFileSchema } from '../pipeline/transcribe.js';
import { openedName, requestsFileSchema, sessionPaths, type SessionManifest } from '../session.js';
import { contentOf, type UploadRecord } from './uploads.js';

const CONTENT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.m4a': 'audio/mp4' };
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface VideoFile { path: string; bytes: number; contentType: string }

/**
 * The session's video once all of it is there: the file the manifest names, inside the session's folder,
 * at the size the upload declared. Words first makes the session before the video joins it, and a copy
 * (where a hard link is not possible) is a while in the making.
 */
export async function videoFile(dir: string, manifest: SessionManifest): Promise<VideoFile | undefined> {
  // A take of logs alone has no media file (docs/LOGS.md).
  const name = manifest.media.video;
  if (name === undefined) return undefined;
  const path = resolve(dir, name);
  if (!SAFE_NAME.test(name) || !path.startsWith(dir + sep)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size !== manifest.source.bytes) return undefined;
  return { path, bytes: info.size, contentType: CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream' };
}

const optional = async <T>(file: string, schema: ZodType<T>): Promise<T | undefined> => await exists(file) ? readJson(file, schema) : undefined;

/** What the player shows beside the video: the transcript, and the moments to jump to, in time order. */
export async function playbackView(dir: string, manifest: SessionManifest, record: UploadRecord, at: { key: string; message: number }): Promise<object> {
  const paths = sessionPaths(dir);
  const [transcript, markers, requests, video] = await Promise.all([
    optional(paths.transcriptJson, transcriptFileSchema), optional(paths.markers, markersFileSchema), optional(paths.requests, requestsFileSchema), videoFile(dir, manifest),
  ]);
  const moments = [
    ...(requests?.requests ?? []).map(r => ({ atMs: r.atMs, kind: 'request', text: r.text })),
    ...(markers?.markers ?? []).map(m => ({ atMs: m.atMs, kind: m.kind, text: m.text })),
    // "Opened option 2: Red menu", or for a plain launch what it opened.
    ...(manifest.source.opened ?? []).map(o => ({ atMs: o.atMs, kind: 'opened', text: `Opened ${openedName(o) ?? o.what.replace(/^open /, '')}` })),
  ].sort((a, b) => a.atMs - b.atMs);
  return {
    key: at.key, message: at.message,
    ...(manifest.summary ? { title: manifest.summary.title, summary: manifest.summary.text } : {}),
    recordedAt: manifest.recordedAt, ...(manifest.media.durationMs !== undefined ? { durationMs: manifest.media.durationMs } : {}),
    status: record.status, ...(manifest.source.audioTracks ? { audioTracks: manifest.source.audioTracks } : {}),
    // What there is to play: a picture, sound alone, or nothing (logs alone), and whether the take has logs.
    content: contentOf(record.fileName), ...(manifest.media.logs ? { logs: true } : {}),
    // Gone for good when its kept days ran out (storage.ts): the player says so rather than "still on its way".
    video: video ? { available: true, bytes: video.bytes, contentType: video.contentType }
      : record.videoDeletedAt ? { available: false, deletedAt: record.videoDeletedAt, ...(record.keepVideoDays ? { keptDays: record.keepVideoDays } : {}) } : { available: false },
    transcript: (transcript?.segments ?? []).map(s => ({ startMs: s.startMs, endMs: s.endMs, text: s.text })),
    moments,
  };
}

/**
 * One range from a Range header: what to send, 'unsatisfiable' (416), or undefined to send the whole file,
 * which is also the answer to a header that is malformed or asks for several ranges (RFC 9110 lets a
 * server ignore Range).
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    // A suffix: the last n bytes.
    const n = Number(match[2]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : Infinity;
  if (end < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** Streams the video, or the range asked for; HEAD gets the headers alone. A client going away mid-way is not an error. */
export async function sendVideo(req: IncomingMessage, res: ServerResponse, video: VideoFile): Promise<void> {
  const common = { 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' };
  const range = byteRange(req.headers.range, video.bytes);
  if (range === 'unsatisfiable') {
    const body = JSON.stringify({ error: `range not satisfiable: the video is ${video.bytes} bytes` });
    res.writeHead(416, { ...common, 'content-range': `bytes */${video.bytes}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const { start, end } = range ?? { start: 0, end: video.bytes - 1 };
  const length = end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...common, 'content-type': video.contentType, 'content-length': length, ...(range ? { 'content-range': `bytes ${start}-${end}/${video.bytes}` } : {}),
  });
  if (req.method === 'HEAD' || length <= 0) { res.end(); return; }
  try { await pipeline(createReadStream(video.path, { start, end }), res); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error; }
}
