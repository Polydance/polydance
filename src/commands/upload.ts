/**
 * `polycap upload`: a walkthrough recorded on this Mac sent to the hosted receiver as a reply in a
 * thread (docs/MAC.md T4), as the first message of a new thread in a project, or as a report from the
 * bug key for the Polydance team (docs/THREADS.md, Reports), in the protocol the headset speaks (src/server/http.ts, and the Android
 * app's UploadWorker): POST /v1/uploads with the client's own id, so running it again finds the same
 * upload; the narration (the mic track alone, cut out without re-encoding) whole, so the receiver has
 * the words first; then the video in chunks with Content-Range from the bytes the receiver says it
 * already has, so an interrupted upload resumes where it stopped. It is a transport: the receiver
 * builds the bundle. A call is refused before anything is sent, because calls never leave the Mac
 * (Robin, 2026-11-05); refuseCall says how one is recognised. Nothing retries by itself; a failure
 * says to run it again.
 */
import { createHash } from 'node:crypto';
import { open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CALL_TAG_PREFIX } from '../call.js';
import { UserError } from '../errors.js';
import { exec } from '../exec.js';
import { parseRecordingName } from '../filename.js';
import { importSource, parseImportMeta, readImportMeta, type ImportMeta } from '../import-meta.js';
import { exists, privateDir, sha256File } from '../fsx.js';
import { probe } from '../pipeline/probe.js';
import { TOKEN_PATTERN } from '../server/tokens.js';
import { createUploadSchema, MAX_NARRATION, type CreateUpload } from '../server/uploads.js';
import { listSessions, loadSession, sessionDir } from '../session.js';
import { projectKeySchema, threadKeySchema, USER_ID } from '../threads.js';
import { TOOL_VERSION } from '../version.js';
import type { Cli } from './context.js';
import { RemoteError } from './remote.js';
import { tokensDir } from './thread.js';

/** As the headset sends them; the receiver takes at most 64 MB in one request. */
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface UploadOptions {
  /** Where it goes, exactly one: a reply in this thread, a new thread in this project, or a report. */
  thread?: string; project?: string; report?: boolean;
  replyTo?: string; launch?: string; meta?: string; tracks?: string;
  /** The name of a token saved with `polycap token new --save NAME`; else POLYCAP_UPLOAD_TOKEN. */
  token?: string;
  /** false: the video alone, without sending the narration ahead of it. */
  narration?: boolean;
  /** Tests: smaller chunks than the headset's 8 MB. */
  chunkBytes?: number;
}

export interface UploadResult {
  /** The thread it is in: the one replied in, the one it opened, or the report's (which only the team sees). */
  uploadId: string; thread: string; clientId: string; bytes: number; received: number; status: string;
  /** reply, a new thread, or a report. */
  as: 'reply' | 'thread' | 'report';
  /** What the receiver had before this run sent anything: 0 for a new upload. */
  resumedFrom: number;
  narration?: 'sent' | 'received' | 'not sent';
  sessionId?: string;
}

export const HOW_TO_TOKEN = 'Make one with `polycap token new --id mac-capture --team --expires never --scope upload --scope read --user robin --label Mac --save mac-capture`, '
  + 'add the line it prints to the receiver\'s POLYCAP_SERVER_TOKENS (the receiver must list it, then restart), '
  + 'and pass --token mac-capture or set POLYCAP_UPLOAD_TOKEN=mac-capture in ~/.config/polycap/env (the Mac app uses that).';

/**
 * The upload token: --token names a saved one; POLYCAP_UPLOAD_TOKEN is a token or a saved one's name.
 * The read token sync uses (POLYCAP_REMOTE_TOKEN) is never used: Robin's has no upload scope.
 */
export async function uploadToken(cli: Cli, name?: string): Promise<string> {
  const value = name ?? cli.config.uploadToken;
  if (!value) throw new UserError(`polycap upload needs a receiver token with the upload scope; POLYCAP_REMOTE_TOKEN is not used for uploads. ${HOW_TO_TOKEN}`);
  if (TOKEN_PATTERN.test(value)) {
    if (name !== undefined) throw new UserError('--token takes the name of a token saved with polycap token new --save NAME, never the token itself (a command line is visible to other processes)');
    return value;
  }
  const where = name !== undefined ? `--token ${name}` : 'POLYCAP_UPLOAD_TOKEN';
  if (!USER_ID.test(value)) throw new UserError(`${where} is neither a receiver token (polycap_…) nor the name of one saved in ${tokensDir()}`);
  const file = join(tokensDir(), value);
  const info = await stat(file).catch(() => undefined);
  if (!info) throw new UserError(`${where} names token "${value}", but ${file} does not exist. ${HOW_TO_TOKEN}`);
  if (info.mode & 0o077) throw new UserError(`${file} is readable by other users; run chmod 600 ${file}`);
  const token = (await readFile(file, 'utf8')).trim();
  if (!TOKEN_PATTERN.test(token)) throw new UserError(`${file} does not hold a receiver token`);
  return token;
}

/** The client's own id for a recording: its name and the start of its sha256, so the same file is always the same upload. */
export function uploadClientId(fileName: string, sha256: string): string {
  const stem = basename(fileName, extname(fileName)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60);
  return `mac-${stem ? `${stem}-` : ''}${sha256.slice(0, 16)}`;
}

/** The name the receiver records, within what it accepts. */
function uploadFileName(file: string): string {
  const ext = extname(file).toLowerCase();
  if (!/^\.(mp4|webm|mkv|mov)$/.test(ext)) throw new UserError(`${file}: the receiver takes .mp4, .webm, .mkv or .mov recordings`);
  const stem = basename(file, extname(file)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 90) || 'recording';
  return `${stem}${ext}`;
}

const viewSchema = z.looseObject({
  id: z.string().regex(/^up_[0-9a-f]{16}$/), clientId: z.string(), bytes: z.number(), received: z.number().int().nonnegative(), status: z.string(),
  thread: z.string().optional(), narration: z.enum(['expected', 'received']).optional(), sessionId: z.string().optional(), error: z.string().optional(),
});
type View = z.infer<typeof viewSchema>;
const refusalSchema = z.looseObject({ error: z.string().optional(), received: z.number().int().nonnegative().optional(), status: z.string().optional() });

interface Answer { status: number; json: unknown }

/** One request to the receiver with the upload token; a failure to reach it is a RemoteError with no status. */
async function call(url: string, token: string, method: string, path: string, body?: Uint8Array | object, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<Answer> {
  const raw = body instanceof Uint8Array;
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch (error) {
    throw new RemoteError(`${method} ${path.split('?')[0]}: could not reach ${url} (${error instanceof Error ? error.message : String(error)}); run the same command again to resume`);
  }
  const text = await response.text().catch(() => '');
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  return { status: response.status, json };
}

/** A refusal in words that say what to do. */
function refused(what: string, answer: Answer): RemoteError {
  const said = refusalSchema.safeParse(answer.json).data?.error ?? 'no reason given';
  if (answer.status === 401) return new RemoteError(`${what}: the receiver does not know this token (401). It must be listed in the receiver's POLYCAP_SERVER_TOKENS. ${HOW_TO_TOKEN}`, 401);
  if (answer.status === 403) return new RemoteError(`${what}: ${said} (403). Uploads need a token with the upload scope. ${HOW_TO_TOKEN}`, 403);
  return new RemoteError(`${what}: ${answer.status} ${said}`, answer.status);
}

const view = (what: string, answer: Answer): View => {
  const parsed = viewSchema.safeParse(answer.json);
  if (!parsed.success) throw new RemoteError(`${what} answered in a shape this polycap does not know: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, answer.status);
  return parsed.data;
};

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const NEVER_LEAVES = 'Calls never leave this Mac (docs/MAC.md, decided 2026-11-05): import it with polycap import, and only walkthroughs go to threads.';

/** `<name>.meta.json` beside a recording, as the Mac app writes it. */
export const siblingMeta = (path: string) => join(dirname(path), `${basename(path, extname(path))}.meta.json`);

/**
 * Refuses a file that is a call, before anything is sent (review of 2026-11-05: only --meta was
 * looked at, so a call's own recording without it, its session's video.mp4 or an export of it went
 * to the receiver). A call is recognised by any of: its metadata, given with --meta or beside the
 * file; a sha256 that a call in the library has; a path in a session's folder or its exports folder
 * whose session is a call, or whose session cannot be read, so it cannot be checked; and the tag
 * `polycap export` puts on a call's video and audio. A copy re-encoded by some other tool and renamed
 * carries none of these and is not recognised.
 */
async function refuseCall(cli: Cli, file: string, path: string, digest: string, metas: readonly { meta?: ImportMeta; where: string }[]): Promise<void> {
  for (const { meta, where } of metas) if (meta?.call) throw new UserError(`${where} describes a call. ${NEVER_LEAVES}`);
  const sessions = await listSessions(cli.config, () => {});
  const same = sessions.find(s => s.manifest.source.call && s.manifest.source.sha256 === digest);
  if (same) throw new UserError(`${file} is the recording of call session ${same.manifest.id}. ${NEVER_LEAVES}`);
  const real = await realpath(path);
  for (const folder of [cli.config.sessions, join(cli.config.root, 'exports')]) {
    const base = await realpath(folder).catch(() => resolve(folder));
    if (!real.startsWith(`${base}${sep}`)) continue;
    const id = relative(base, real).split(sep)[0];
    const manifest = await loadSession(sessionDir(cli.config, id)).catch(() => undefined);
    if (!manifest) throw new UserError(`${file} is in the library's folder for ${id}, whose session.json cannot be read, so it cannot be checked for a call; nothing was sent. ${NEVER_LEAVES}`);
    if (manifest.source.call) throw new UserError(`${file} belongs to call session ${id}. ${NEVER_LEAVES}`);
  }
  let tags: Record<string, string>;
  try { tags = (await probe(cli.config.ffprobe, path)).tags; }
  catch (error) { throw new UserError(`${file} could not be read by ffprobe (${error instanceof Error ? error.message.split('\n')[0] : String(error)}), so it cannot be checked for a call; nothing was sent`); }
  const tag = Object.values(tags).find(value => value.startsWith(CALL_TAG_PREFIX));
  if (tag) throw new UserError(`${file} is an export of call session ${tag.slice(CALL_TAG_PREFIX.length)}. ${NEVER_LEAVES}`);
}

/**
 * The narration as the headset makes it: the mic track alone, copied out of the file without
 * re-encoding, when the tracks are known and the file has exactly that many. None when there is no
 * mic track, the file disagrees with the description, or it would be over the receiver's limit.
 */
async function prepareNarration(cli: Cli, file: string, tracks: readonly string[] | undefined, work: string): Promise<string | undefined> {
  const mic = tracks?.indexOf('mic') ?? -1;
  if (!tracks || mic < 0) return undefined;
  try {
    const info = await probe(cli.config.ffprobe, file);
    if (info.audioChannels.length !== tracks.length) { cli.warn(`the file has ${info.audioChannels.length} audio tracks but ${tracks.length} are described, so its narration is not sent ahead; the receiver gets the video alone`); return undefined; }
    await privateDir(work);
    const out = join(work, 'narration.m4a');
    await exec(cli.config.ffmpeg, ['-y', '-v', 'error', '-i', file, '-map', `0:a:${mic}`, '-c', 'copy', '-vn', out], { timeoutMs: 300_000 });
    if ((await stat(out)).size > MAX_NARRATION) { cli.warn('the narration is over the receiver\'s 64 MB, so it is not sent ahead; the video carries the same sound'); return undefined; }
    return out;
  } catch (error) {
    cli.warn(`the narration could not be cut out (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); the video carries the same sound`);
    return undefined;
  }
}

/** Where a recording goes: a reply in a thread, a new thread in a project, or a report. */
type Target = { as: 'reply'; key: string } | { as: 'thread'; project: string } | { as: 'report' };

function target(options: UploadOptions): Target {
  const given = [options.thread !== undefined, options.project !== undefined, Boolean(options.report)].filter(Boolean).length;
  if (given === 0) throw new UserError('say where it goes: --thread KEY for a reply (for example --thread MUS-12), --project KEY for a new thread, or --report for a report to the Polydance team');
  if (given > 1) throw new UserError('--thread, --project and --report each say where a recording goes; give one');
  if (options.report) return { as: 'report' };
  if (options.project !== undefined) {
    const project = projectKeySchema.safeParse(options.project.toUpperCase());
    if (!project.success) throw new UserError(`--project ${options.project} is not a project key such as MUS`);
    return { as: 'thread', project: project.data };
  }
  const key = threadKeySchema.safeParse(options.thread!.toUpperCase());
  if (!key.success) throw new UserError(`--thread ${options.thread} is not a thread key such as MUS-12`);
  return { as: 'reply', key: key.data };
}

export async function upload(cli: Cli, file: string, options: UploadOptions): Promise<UploadResult> {
  const goes = target(options);
  if (goes.as !== 'reply' && (options.replyTo !== undefined || options.launch !== undefined)) throw new UserError('--reply-to and --launch go with --thread: a new thread or a report answers no message');
  const replyTo = options.replyTo === undefined ? undefined : Number(options.replyTo);
  if (replyTo !== undefined && (!Number.isInteger(replyTo) || replyTo < 1)) throw new UserError(`--reply-to ${options.replyTo} is not a message number (1 or more)`);
  if (options.launch !== undefined && replyTo === undefined) throw new UserError('--launch goes with --reply-to: it is which of that message\'s launches was tried');
  const launch = options.launch === undefined ? undefined : Number(options.launch);
  if (launch !== undefined && (!Number.isInteger(launch) || launch < 0 || launch > 5)) throw new UserError(`--launch ${options.launch} is not a launch index (0 for the message's first launch, up to 5)`);

  const path = resolve(file);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new UserError(`${file} does not exist or is not a file`);
  // The metadata given, and the one the Mac app writes beside every recording, which is used when none is given.
  const given = options.meta ? await readImportMeta(resolve(options.meta)) : undefined;
  const besidePath = siblingMeta(path);
  const beside = (!options.meta || resolve(options.meta) !== besidePath) && await exists(besidePath)
    ? parseImportMeta(await readFile(besidePath, 'utf8'), `${besidePath}, beside the recording,`)
    : undefined;
  const digest = await sha256File(path);
  await refuseCall(cli, file, path, digest, [{ meta: given, where: options.meta ?? '--meta' }, { meta: beside, where: `${besidePath}, beside the recording,` }]);
  const meta = given ?? beside;
  const source = importSource({ tracks: options.tracks }, meta);
  if (source.marks?.length) cli.warn(`${source.marks.length} ${source.marks.length === 1 ? 'mark is' : 'marks are'} left out: the receiver does not take marks yet`);
  if (!cli.config.remoteUrl) throw new UserError('Set POLYCAP_REMOTE_URL in ~/.config/polycap/env to upload to the hosted receiver');
  const url = cli.config.remoteUrl;
  const token = await uploadToken(cli, options.token);

  const fileName = uploadFileName(path);
  const clientId = uploadClientId(fileName, digest);
  const recordedAt = source.recordedAt ?? parseRecordingName(basename(path)).recordedAt ?? new Date(info.mtimeMs);
  const work = join(cli.config.work, `upload-${clientId}`);
  const narration = options.narration === false ? undefined : await prepareNarration(cli, path, source.audioTracks, work);
  try {
    const narrationBytes = narration ? await readFile(narration) : undefined;
    const body: CreateUpload = {
      clientId, bytes: info.size, sha256: digest, fileName, recordedAt: recordedAt.toISOString(),
      ...(source.appPackage ? { appPackage: source.appPackage } : {}),
      device: { model: process.platform === 'darwin' ? 'Mac' : type(), os: `${type()} ${release()}`, arch: arch(), client: `polycap ${TOOL_VERSION}` },
      ...(source.audioTracks ? { audioTracks: source.audioTracks } : {}),
      ...(source.appBuild ? { app: source.appBuild } : {}),
      thread: goes.as === 'report' ? { report: true } : goes.as === 'thread' ? { project: goes.project }
        : { key: goes.key, ...(replyTo !== undefined ? { replyTo: { message: replyTo, ...(launch !== undefined ? { launch } : {}) } } : {}) },
      ...(narrationBytes ? { narration: { bytes: narrationBytes.length, sha256: sha256(narrationBytes) } } : {}),
    };
    // Checked as the receiver will check it, so a field it would refuse is named here, before anything is sent.
    const checked = createUploadSchema.safeParse(body);
    if (!checked.success) throw new UserError(`the receiver would refuse this upload: ${checked.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

    const created = await call(url, token, 'POST', '/v1/uploads', checked.data);
    if (created.status !== 200 && created.status !== 201) throw refused('POST /v1/uploads', created);
    let state = view('POST /v1/uploads', created);
    // The same file is the same upload, which is in one thread: an earlier run's, if it went elsewhere, is said.
    if (goes.as === 'reply' && state.thread && state.thread !== goes.key) throw new UserError(`this recording was already uploaded as ${state.id}, a reply in ${state.thread}, not ${goes.key}; a recording is in one thread`);
    if (goes.as === 'thread' && state.thread && !state.thread.startsWith(`${goes.project}-`)) throw new UserError(`this recording was already uploaded as ${state.id}, in ${state.thread}, not a new thread in ${goes.project}; a recording is in one thread`);
    // A receiver with threads off keeps the recording in no thread; a new thread or a report must have one.
    if (goes.as !== 'reply' && !state.thread) throw new RemoteError(`POST /v1/uploads: the receiver took ${state.id} but put it in no thread, so it is ${goes.as === 'report' ? 'no report' : 'in no new thread'}; threads are off on the receiver`);
    const resumedFrom = state.received;

    let narrationState: UploadResult['narration'] = narrationBytes ? 'not sent' : undefined;
    if (state.narration === 'received') narrationState = 'received';
    else if (narrationBytes && state.narration === 'expected' && state.status === 'uploading') {
      const sent = await call(url, token, 'PUT', `/v1/uploads/${state.id}/narration`, narrationBytes, { 'content-type': 'audio/mp4' }, 600_000);
      // The video carries the same sound, so a refused narration costs only time; a refused token stops everything.
      if (sent.status === 401 || sent.status === 403) throw refused('PUT narration', sent);
      if (sent.status === 200) narrationState = 'sent';
      else cli.warn(`the receiver did not take the narration (${refused('PUT narration', sent).message}); the video follows as usual`);
    }

    const chunk = options.chunkBytes ?? CHUNK_BYTES;
    const handle = await open(path, 'r');
    try {
      let offset = state.received, resets = 0;
      while (state.status === 'uploading' && offset < info.size) {
        const end = Math.min(offset + chunk, info.size) - 1;
        const bytes = Buffer.alloc(end - offset + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        if (bytesRead !== bytes.length) throw new UserError(`${file} changed while it was being sent (short read at ${offset}); it must not change once recorded`);
        const answer = await call(url, token, 'PUT', `/v1/uploads/${state.id}/content`, bytes, { 'content-range': `bytes ${offset}-${end}/${info.size}` }, 600_000);
        if (answer.status === 200) {
          state = view('PUT content', answer);
          if (state.status === 'uploading' && state.received <= offset) throw new RemoteError(`PUT content: the receiver still has ${state.received} bytes after a chunk sent at ${offset}; run the same command again to resume`);
        }
        else if (answer.status === 409) {
          // The receiver says what it has: carry on from there. 0 after the last chunk means its copy failed the sha256 and was reset.
          const said = refusalSchema.safeParse(answer.json).data;
          if (said?.received === undefined) throw refused('PUT content', answer);
          if (said.received === offset) throw new RemoteError(`PUT content: ${said.error ?? 'refused'}; run the same command again shortly to resume`, 409);
          if (said.received === 0 && offset > 0 && ++resets > 1) throw new RemoteError('PUT content: the receiver\'s copy failed verification twice; the file may be changing as it is read', 409);
          state = { ...state, received: said.received, status: said.status ?? state.status };
        } else throw refused('PUT content', answer);
        offset = state.received;
      }
    } finally { await handle.close(); }

    const result: UploadResult = {
      uploadId: state.id, thread: state.thread ?? (goes.as === 'reply' ? goes.key : ''), as: goes.as, clientId, bytes: info.size, received: state.received, status: state.status, resumedFrom,
      ...(narrationState ? { narration: narrationState } : {}), ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };
    if (cli.json) cli.print(JSON.stringify(result));
    else {
      const resumed = resumedFrom > 0 && resumedFrom < info.size ? `, resumed from ${resumedFrom} of ${info.size} bytes` : resumedFrom === info.size ? ', already all there' : '';
      const where = goes.as === 'report' ? 'a report for the Polydance team, which only the team sees'
        : goes.as === 'thread' ? `the first message of ${result.thread}, a new thread` : `a reply in ${result.thread}${replyTo ? ` to #${replyTo}` : ''}`;
      const next = goes.as === 'report' ? 'The receiver builds its bundle for the team.' : `The receiver builds its bundle; polycap thread show ${result.thread} names it when it is ready.`;
      cli.print(`uploaded ${basename(path)} as ${result.uploadId}: ${where} (${result.status}${resumed}). ${next}`);
    }
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
