import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { privateDir, sha256File } from '../fsx.js';
import { loadSession, sessionDir } from '../session.js';
import type { Cli } from './context.js';
import { table } from './context.js';

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const listSchema = z.object({
  sessions: z.array(z.looseObject({
    id: idSchema, title: z.string().optional(), ready: z.boolean(), recordedAt: z.string(), uploadId: z.string().optional(), sha256: z.string().optional(),
    /** Words first: transcript, markers, requests and a frameless storyboard, the video still uploading (receivers from 2026-10-04). */
    words: z.boolean().default(false),
  })),
});
const filesSchema = z.object({
  files: z.array(z.object({
    // Validate segments, not a normalized path: neither dot segments nor encoded separators are files.
    path: z.string().refine(path => path.split('/').every(part => idSchema.safeParse(part).success && part !== '.' && part !== '..'), 'unsafe bundle path'),
    bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).refine(files => new Set(files.map(f => f.path)).size === files.length, 'duplicate bundle path')
    .refine(files => files.some(f => f.path === 'session.json'), 'bundle is missing session.json'),
});

export interface SyncOptions { video: boolean; dryRun: boolean; session?: string }
export interface SyncResult { downloaded: string[]; current: string[]; waiting: string[]; skipped: string[]; pruned: string[]; wordsOnly: string[] }

/**
 * A transport like `pull`, from the hosted receiver instead of a headset: copies finished bundles into
 * the local library so `show`, `transcript`, `frames` and the skill work on them unchanged. Every file
 * is checked against the server's byte count and sha256 before it replaces anything. The video is left
 * on the server unless --video. Sync can fetch words before video processing finishes, and
 * `session` limits it to one recording. A mirror prunes files the server no longer has, except
 * video and what this machine's hooks recorded beside the bundle. A local session from another recording is never touched, and nothing is deleted remotely.
 */
export async function sync(cli: Cli, options: SyncOptions): Promise<SyncResult> {
  const { remoteUrl, remoteToken } = cli.config;
  if (!remoteUrl || !remoteToken) throw new UserError('Set POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN (a read token) in ~/.config/polycap/env');
  if (options.session !== undefined) idSchema.parse(options.session);
  const get = async (path: string) => {
    const response = await fetch(`${remoteUrl}${path}`, { redirect: 'error', headers: { authorization: `Bearer ${remoteToken}` }, signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok) throw new UserError(`${remoteUrl}${path.split('?')[0]} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const listed = listSchema.parse(await (await get('/v1/sessions')).json()).sessions;
  const sessions = options.session === undefined ? listed : listed.filter(s => s.id === options.session);
  if (options.session !== undefined && sessions.length !== 1) throw new UserError(`Session ${options.session} is missing or ambiguous on the receiver`);
  // Check before mkdir/chmod: those operations otherwise follow existing directory symlinks.
  const root = cli.config.root;
  const layout = [root, cli.config.raw, cli.config.sessions, cli.config.work, cli.config.logs, cli.config.models];
  for (const dir of layout) await safePath(root, dir);
  for (const dir of layout) await privateDirectory(root, dir);
  const result: SyncResult = { downloaded: [], current: [], waiting: [], skipped: [], pruned: [], wordsOnly: [] };
  const rows: string[][] = [];

  for (const remote of sessions) {
    const label = remote.title && remote.title !== remote.id ? remote.title : '';
    if (!remote.ready && !remote.words) { result.waiting.push(remote.id); rows.push([remote.id, label, 'processing on the server']); continue; }
    const words = remote.ready ? '' : ', words only: frames when the video is in';
    if (!remote.ready) result.wordsOnly.push(remote.id);
    const dir = sessionDir(cli.config, remote.id);
    const localManifest = await safePath(root, join(dir, 'session.json'));
    if (localManifest) {
      if (!localManifest.isFile()) throw new UserError(`Not a regular bundle file: ${join(dir, 'session.json')}`);
      const local = await loadSession(dir).catch(() => undefined);
      // Undefined upload ids are not evidence that two recordings are the same.
      const same = local && local.id === remote.id && ((remote.uploadId !== undefined && local.source.uploadId === remote.uploadId) || (remote.sha256 !== undefined && local.source.sha256 === remote.sha256));
      if (!same) {
        result.skipped.push(remote.id); rows.push([remote.id, label, 'skipped: a different or invalid local session has this id']); continue;
      }
    }
    const { files } = filesSchema.parse(await (await get(`/v1/sessions/${encodeURIComponent(remote.id)}/files`)).json());
    const onServer = new Set(files.map(f => f.path));
    for (const file of files) {
      const parts = file.path.split('/');
      for (let n = 1; n < parts.length; n++) {
        if (onServer.has(parts.slice(0, n).join('/'))) throw new UserError(`Conflicting bundle paths: ${file.path}`);
      }
    }
    const wanted = files.filter(f => options.video || !isVideo(f.path));
    // Walk even unchanged bundles, rejecting links (including dangling links and retained videos).
    const localFiles = await safePath(root, dir) ? await walk(dir, dir, !options.dryRun) : [];
    const stale = [];
    for (const file of wanted) {
      const local = join(dir, file.path);
      const info = await safePath(root, local);
      if (info && !info.isFile()) throw new UserError(`Not a regular bundle file: ${local}`);
      const same = info && info.size === file.bytes && await sha256File(local) === file.sha256;
      if (!same) stale.push(file);
    }
    const extra = localFiles.filter(path => !onServer.has(path) && !isVideo(path) && !isLocalRecord(path));
    if (!stale.length && !extra.length) {
      await validateBundle(dir, remote.id);
      result.current.push(remote.id); rows.push([remote.id, label, `up to date${words}`]); continue;
    }
    const bytes = stale.reduce((sum, f) => sum + f.bytes, 0);
    const what = [stale.length ? `${stale.length} file(s), ${(bytes / 1_048_576).toFixed(1)} MB` : '', extra.length ? `${extra.length} removed from the server` : ''].filter(Boolean).join('; ');
    if (options.dryRun) { rows.push([remote.id, label, `would sync ${what}${words}`]); continue; }

    // A unique private staging directory prevents concurrent syncs sharing temporary files.
    await safePath(root, cli.config.work);
    const staging = await mkdtemp(join(cli.config.work, `sync-${remote.id}-`));
    try {
      for (const file of stale) {
        const target = join(staging, file.path);
        await privateDirectory(root, dirname(target));
        const response = await get(`/v1/sessions/${encodeURIComponent(remote.id)}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`);
        if (!response.body) throw new UserError(`empty response for ${remote.id}/${file.path}`);
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(target, { mode: 0o600, flags: 'wx' }));
        if ((await stat(target)).size !== file.bytes) throw new UserError(`${remote.id}/${file.path} arrived corrupted (byte count mismatch); run sync again`);
        if (await sha256File(target) !== file.sha256) throw new UserError(`${remote.id}/${file.path} arrived corrupted (sha256 mismatch); run sync again`);
      }
      // Reject a validly hashed but invalid or wrong manifest before installing any files.
      await validateBundle(stale.some(f => f.path === 'session.json') ? staging : dir, remote.id);
      await privateDirectory(root, dir);
      // session.json last, so a bundle never claims files it does not have yet.
      for (const file of [...stale].sort((a, b) => Number(a.path === 'session.json') - Number(b.path === 'session.json'))) {
        const target = join(dir, file.path);
        await privateDirectory(root, dirname(target));
        await safePath(root, target);
        await rename(join(staging, file.path), target);
      }
      for (const path of extra) {
        await safePath(root, join(dir, path));
        await rm(join(dir, path), { force: true });
      }
      await validateBundle(dir, remote.id);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    if (stale.length) result.downloaded.push(remote.id);
    if (extra.length) result.pruned.push(remote.id);
    rows.push([remote.id, label, `synced ${what}${words}`]);
  }

  if (cli.json) cli.print(JSON.stringify(result));
  else cli.print(rows.length ? table(rows, ['session', 'title', options.dryRun ? 'would' : 'result']) : `No sessions on ${remoteUrl} yet.`);
  return result;
}

/** The manifest must be this recording's. */
async function validateBundle(dir: string, id: string): Promise<void> {
  const manifest = await loadSession(dir);
  if (manifest.id !== id) throw new UserError(`Session manifest id ${manifest.id} does not match requested session ${id}`);
}

/** The recording's media, left on the server unless --video: the video, and the narration sent ahead of it. */
const isVideo = (path: string) => /^(video\.[a-z0-9]+|narration\.m4a)$/.test(path);
/** What this machine's own hooks recorded beside a bundle (hook-runs.json, hooks/): never on the server, so never pruned. */
const isLocalRecord = (path: string) => path === 'hook-runs.json' || path.startsWith('hooks/');

/** Configured root's parent is trusted (e.g. macOS /var); root and every path inside it must be link-free. */
async function safePath(root: string, path: string) {
  root = resolve(root);
  const rel = relative(root, resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new UserError(`Path escapes sync library: ${path}`);
  const parts = rel ? rel.split(sep) : [];
  let full = root;
  for (let n = 0; n <= parts.length; n++) {
    if (n) full = join(full, parts[n - 1]);
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (info.isSymbolicLink()) throw new UserError(`Refusing symlink in sync library: ${full}`);
    if (n < parts.length && !info.isDirectory()) throw new UserError(`Not a sync directory: ${full}`);
    if (n === parts.length) return info;
  }
}

async function privateDirectory(root: string, dir: string): Promise<void> {
  await safePath(root, dir);
  let full = resolve(root);
  await privateDir(full);
  const rel = relative(full, resolve(dir));
  for (const part of rel ? rel.split(sep) : []) {
    full = join(full, part);
    await privateDir(full);
  }
}

/** Relative paths of every regular file; no symlinks, even when they would not be downloaded. */
async function walk(dir: string, base = dir, makePrivate = false): Promise<string[]> {
  const out: string[] = [];
  if (makePrivate) await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new UserError(`Refusing symlink in sync library: ${full}`);
    if (entry.isDirectory()) out.push(...await walk(full, base, makePrivate));
    else if (entry.isFile()) {
      if (makePrivate) await chmod(full, 0o600);
      out.push(relative(base, full).split(sep).join('/'));
    } else throw new UserError(`Not a regular bundle file: ${full}`);
  }
  return out;
}
