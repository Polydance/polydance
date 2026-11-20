/**
 * Photos from the agent's side (docs/THREADS.md, Photos, 2026-11-07). Sending: each --photo is made what
 * the receiver keeps (JPEG or PNG, upright, at most 4096 px a side, at most 20 MB) with ffmpeg when it is
 * not already, stripped here so its location never leaves the machine, then pushed and named in the
 * message by the id the receiver gives it. Reading: `thread show` saves each photo it may see into the
 * library, <root>/photos/<KEY>/<sha256>.jpg, checked against its id, so an agent can read the file.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { exec, ToolError } from '../exec.js';
import { exists, privateDir } from '../fsx.js';
import { cleanPhoto, MAX_PHOTOS, photoExtension, PHOTO_MAX_BYTES, PHOTO_MAX_SIDE, photoSchema, sniff, type Photo, type PhotoFacts } from '../photo.js';
import { megabytes } from '../threads.js';
import type { Cli } from './context.js';
import type { Remote } from './remote.js';

/** Larger than this is not a photo anyone meant to send. */
const READ_LIMIT = 200 * 1024 * 1024;

export interface PreparedPhoto { name: string; data: Buffer; facts: PhotoFacts; note?: string }

/** A file as the receiver will keep it: stripped, and converted with ffmpeg first when it must be. */
export async function preparePhoto(ffmpeg: string, file: string): Promise<PreparedPhoto> {
  const name = basename(file);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new UserError(`--photo ${file}: no such file`);
  if (info.size > READ_LIMIT) throw new UserError(`--photo ${file}: ${megabytes(info.size)} is too large to be a photo`);
  const original = await readFile(file);
  const first = cleanPhoto(original, name);
  if (first.ok && first.photo.length <= PHOTO_MAX_BYTES) return { name, data: first.photo, facts: first.facts };
  if (!first.ok && !first.convert) throw new UserError(first.problem);
  // A PNG stays a PNG, so a screenshot's text stays sharp, unless that is still too large.
  const kind = sniff(original);
  let converted = await convert(ffmpeg, file, kind === 'png' ? 'png' : 'jpeg');
  if (converted.ok && converted.photo.length > PHOTO_MAX_BYTES && kind === 'png') converted = await convert(ffmpeg, file, 'jpeg');
  if (!converted.ok) throw new UserError(`--photo ${file}: after converting it, ${converted.problem}`);
  if (converted.photo.length > PHOTO_MAX_BYTES) throw new UserError(`--photo ${file}: ${megabytes(converted.photo.length)} even as a JPEG, over the ${megabytes(PHOTO_MAX_BYTES)} a photo may be`);
  const from = [first.facts ? `${first.facts.width}×${first.facts.height}` : '', kind?.toUpperCase() ?? 'image'].filter(Boolean).join(' ');
  const to = `${converted.facts.width}×${converted.facts.height} ${converted.facts.type === 'image/png' ? 'PNG' : 'JPEG'}`;
  return { name, data: converted.photo, facts: converted.facts, note: `${name}: ${from} sent as ${to}` };
}

/** One frame of the file, turned upright by ffmpeg (it applies the orientation tag itself) and scaled to fit 4096 px. */
async function convert(ffmpeg: string, file: string, to: 'png' | 'jpeg') {
  const dir = await mkdtemp(join(tmpdir(), 'polycap-photo-'));
  const out = join(dir, to === 'png' ? 'photo.png' : 'photo.jpg');
  try {
    const fit = `scale='min(iw,${PHOTO_MAX_SIDE})':'min(ih,${PHOTO_MAX_SIDE})':force_original_aspect_ratio=decrease`;
    try {
      await exec(ffmpeg, ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-update', '1', '-vf', fit, ...(to === 'jpeg' ? ['-q:v', '2'] : []), out], { timeoutMs: 120_000 });
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      const heic = sniff(await readFile(file)) === 'heic';
      throw new UserError(`--photo ${file}: ffmpeg could not convert it (${error.message.split('\n')[0]})${heic ? '; convert it to JPEG with sips -s format jpeg in.heic --out out.jpg, then send that' : ''}`);
    }
    return cleanPhoto(await readFile(out), basename(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sentSchema = z.looseObject({ sha256: photoSchema.shape.sha256 });

/** Sends every --photo, to the thread or (for a new thread) its project, and gives the ids for the message. */
export async function pushPhotos(cli: Cli, server: Remote, where: { thread: string } | { project: string }, files: readonly string[]): Promise<string[] | undefined> {
  if (!files.length) return undefined;
  if (files.length > MAX_PHOTOS) throw new UserError(`a message holds at most ${MAX_PHOTOS} photos; this one has ${files.length}`);
  const path = 'thread' in where ? `/v1/threads/${where.thread}/photos` : `/v1/projects/${where.project}/photos`;
  const ids: string[] = [];
  for (const file of files) {
    const photo = await preparePhoto(cli.config.ffmpeg, file);
    if (photo.note && !cli.json) cli.print(photo.note);
    const sent = await server.json('POST', path, sentSchema, photo.data, 120_000, photo.facts.type);
    if (!cli.json) cli.print(`${photo.name} (${photo.facts.width}×${photo.facts.height}, ${megabytes(photo.data.length)}) is on the receiver`);
    if (!ids.includes(sent.sha256)) ids.push(sent.sha256);
  }
  return ids;
}

/** Where `thread show` keeps a thread's photo. */
export const photoPath = (photosDir: string, key: string, photo: Pick<Photo, 'sha256' | 'type'>) => join(photosDir, key, `${photo.sha256}.${photoExtension(photo.type)}`);

const sha256Of = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Each photo this token may see, saved once into the library and checked against its id; the path of each
 * one saved, by id. One that cannot be fetched is said and left out, so the rest of the thread still shows.
 */
export async function savePhotos(cli: Cli, server: Remote, key: string, messages: readonly { photos?: Photo[]; canView?: boolean }[]): Promise<Map<string, string>> {
  const saved = new Map<string, string>();
  for (const message of messages) {
    if (!message.photos?.length || message.canView === false) continue;
    for (const photo of message.photos) {
      const file = photoPath(cli.config.photos, key, photo);
      if (await exists(file) && sha256Of(await readFile(file)) === photo.sha256) { saved.set(photo.sha256, file); continue; }
      let data: Buffer;
      try {
        data = await server.bytes(`/v1/threads/${key}/photos/${photo.sha256}`, photo.bytes);
      } catch (error) {
        cli.warn(`photo ${photo.sha256.slice(0, 12)}…: ${(error as Error).message}`);
        continue;
      }
      if (sha256Of(data) !== photo.sha256) { cli.warn(`photo ${photo.sha256.slice(0, 12)}…: what arrived is not the photo the message names; not saved`); continue; }
      await privateDir(cli.config.photos); await privateDir(join(cli.config.photos, key));
      const part = `${file}.part`;
      await writeFile(part, data, { mode: 0o600 });
      await rename(part, file);
      saved.set(photo.sha256, file);
    }
  }
  return saved;
}
