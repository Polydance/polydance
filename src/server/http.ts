/**
 * The hosted receiver's HTTP API. It is a transport: it stores verified uploads and hands them to the
 * worker, and it serves finished bundles to `polycap sync`. Every route but /v1/health needs a bearer
 * token; nothing here returns a filesystem path, a token or another grant's uploads.
 *
 *   GET  /privacy                         none     the privacy notice the app and its store listing link to
 *   GET  /start                           none     the getting-started page to send someone new; their Welcome thread opens it (start.ts)
 *   GET|POST /email/confirm/:token        none     the page a confirmation email links to; its button verifies the address (email-pages.ts)
 *   GET|POST /email/stop/:key             none     the page an email's stop link opens; its button, or a mail program's one-click POST, stops all email to it
 *   POST /join                            none     the homepage's form asking to join the trial: guarded, kept, and emailed to the team (join.ts, POLYCAP_JOIN)
 *   GET  /v1/health
 *   POST /v1/testers/meta                 none     a store tester's headset signs in with its Meta account (testers.ts)
 *   POST /v1/testers/google               none     an Android XR tester's headset signs in with its Google account (google-testers.ts)
 *   POST /v1/agents                       none     { code, label? }: redeems a code a device showed for an agent's own token (agents.ts)
 *   POST /v1/agents/codes                 upload   a one-time code for this device's person to type into `polycap connect`
 *   GET  /v1/agents                       upload   that person's connected agents
 *   DELETE /v1/agents/:id                 upload, or the agent itself as `self`   disconnects it
 *   POST /v1/uploads                      upload   create, or return the same upload for a known clientId
 *   GET  /v1/uploads[?clientId=..]        upload|read   with pipeline steps done of total, and the bundle's title and summary
 *   GET  /v1/uploads/:id                  upload|read
 *   PUT  /v1/uploads/:id/content          upload   Content-Range: bytes a-b/total, a = bytes received
 *   PUT  /v1/uploads/:id/logs             upload   the declared logs (docs/LOGS.md), whole, first; a take of logs alone is then received
 *   PUT  /v1/uploads/:id/narration        upload   the declared narration (mic track alone), whole, before the video
 *   DELETE /v1/uploads/:id                upload   the recording and its bundle; a tombstone stays
 *   GET  /v1/account                      upload|read   storage used and allowed
 *   GET  /v1/me                           any      this token, its device and its person, with the address they gave
 *   POST /v1/me                           upload|post   { email: string | null }: their own address, unverified until confirmed from the link it is emailed (people.ts)
 *   GET  /v1/sessions                     read     ready, or words when only the narration's steps are done
 *   GET  /v1/sessions/:id/files           read     path, bytes, sha256 per file
 *   GET  /v1/sessions/:id/files/<path>    read
 *   GET  /v1/sessions/:id/frame?at=S&width=W   read   one JPEG from the video at any moment, up to 3840 px
 *
 * A token past its `expiresAt` (tokens.ts, 2026-11-12) is a 401 with `reason: "expired"` on every route that needs one.
 *
 * `read` is the whole library only for the team's tokens. A thread-scoped token (tokens.ts, 2026-10-21)
 * reads only the sessions and uploads behind recordings in threads its person is a member of, posted after
 * they were added unless POLYCAP_NEW_MEMBER_HISTORY is visible; every other session is a 404 that does not
 * say whether it exists.
 *
 * Projects, threads, messages, reactions, participants, playback and the event feed are in
 * thread-routes.ts. With threads on, every upload is put in a thread when it is created: the one it
 * names, or a new one. A tester's upload must carry the consent they accepted in the app. A report from
 * the bug key (`thread: { report: true }`) is the team's: it counts against a reports allowance of its
 * own, and a headset's token, its sender's included, never sees it in a listing or by id.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { exec } from '../exec.js';
import { exists, privateDir, sha256File } from '../fsx.js';
import { isPending, listSessions, loadSession, sessionDir, wordsOnly, type SessionManifest } from '../session.js';
import { TOOL_VERSION } from '../version.js';
import { emailSchema, personId } from './people.js';
import { describeUpload, HttpError, need, parse, readJsonBody, send, type ServerDeps } from './respond.js';
import { ACCEPTED_CONSENT_VERSIONS, sendPrivacy } from './privacy.js';
import { sendStart } from './start.js';
import { agentRoutes, redeemRoute } from './agents.js';
import { emailPages } from './email-pages.js';
import { joinRoute } from './join.js';
import { account, deleteRecording, inFlight, isReport } from './storage.js';
import { googleEnrollSchema, isGoogleGrant } from './google-testers.js';
import { enrollSchema, isTesterGrant } from './testers.js';
import { threadRoutes } from './thread-routes.js';
import { isReportRef, ThreadError } from './threads.js';
import { authenticate, expired, isTeam, memberScoped, ownsUpload, type Grant } from './tokens.js';
import { ConflictError, createUploadSchema, type UploadRecord } from './uploads.js';

const MAX_CHUNK = 64 * 1024 * 1024;
/** Space kept free beyond the declared upload, so processing still has room for frames and audio. */
const DISK_RESERVE = 1024 ** 3;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const meSchema = z.strictObject({ email: emailSchema.nullable() });

/** Frames rendered on demand at once; more wait their turn with a 429, so one client cannot load the box. */
const MAX_RENDERS = 2;
let renders = 0;

export function createReceiver(deps: ServerDeps): Server {
  const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  // Each expired token is logged once a run, so a headset retrying does not fill the log.
  const expiredSeen = new Set<string>();
  return createServer((req, res) => {
    const started = Date.now();
    let grant: Grant | undefined;
    handle(req, res, deps, hashes, g => { grant = g; }, expiredSeen)
      .catch(error => {
        const status = error instanceof HttpError || error instanceof ThreadError ? error.status : error instanceof ConflictError ? 409 : 500;
        if (status === 500) deps.log(`error ${req.method} ${req.url}: ${error instanceof Error ? error.stack : String(error)}`);
        if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (error as Error).message, ...(error instanceof HttpError || error instanceof ThreadError ? error.extra : {}) });
        else res.destroy();
      })
      .finally(() => deps.log(`${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms${grant ? ` ${grant.id}` : ''}`));
  });
}

/**
 * The uploads behind recordings in the threads a thread-scoped grant is a member of (2026-10-21), from when it
 * was added (ThreadStore.viewer, 2026-11-12).
 */
async function memberUploads(deps: ServerDeps, grant: Grant): Promise<Set<string>> {
  const ids = new Set<string>();
  const view = await deps.threads.viewer(grant);
  for (const thread of await deps.threads.list(grant)) for (const m of view(thread).messages) if (m.recording) ids.add(m.recording.uploadId);
  return ids;
}

/**
 * Which uploads a token sees: its own or explicitly linked ones, reports excepted; a team read token, all.
 * A thread-scoped read token also sees the recordings in threads it is a member of.
 */
async function uploadReader(deps: ServerDeps, grant: Grant): Promise<(record: UploadRecord) => boolean> {
  if (grant.scopes.includes('read') && isTeam(grant)) return () => true;
  const shared = grant.scopes.includes('read') ? await memberUploads(deps, grant) : new Set<string>();
  return record => (ownsUpload(grant, record.grantId) && !isReport(record)) || shared.has(record.id);
}

/** Which sessions a read token syncs: every one for the team (undefined); for a thread-scoped token, those behind recordings in its threads. */
async function sessionReader(deps: ServerDeps, grant: Grant): Promise<((manifest: SessionManifest) => boolean) | undefined> {
  if (!memberScoped(grant)) return undefined;
  const shared = await memberUploads(deps, grant);
  return manifest => manifest.source.uploadId !== undefined && shared.has(manifest.source.uploadId);
}

/**
 * Someone who has just signed in finds their Welcome thread waiting (welcome.ts): every sign-in asks, and it is
 * opened once per person. Before the 201, because the headset loads its threads the moment it has a token.
 * Only a thread-scoped tester gets one; the team's own people see every thread already. A failure is logged
 * and never fails the sign-in.
 */
async function welcomeIn(deps: ServerDeps, grantId: string, name: string): Promise<void> {
  const grant = deps.welcome && deps.grants.find(g => g.id === grantId);
  if (!deps.welcome || !grant || !memberScoped(grant)) return;
  await deps.welcome.ensure(personId(grant), name).catch(error => deps.log(`welcome for ${grantId}: ${error instanceof Error ? error.message : String(error)}`));
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, hashes: Map<string, { size: number; mtimeMs: number; sha256: string }>, onGrant: (g: Grant | undefined) => void, expiredSeen: Set<string>): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://receiver');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, version: TOOL_VERSION });
  if (req.method === 'GET' && url.pathname === '/privacy') return sendPrivacy(res, deps.privacyContact, deps.join?.settings.site, deps.config.memberVideoDays);
  if (req.method === 'GET' && url.pathname === '/start') return sendStart(res, deps.privacyContact);
  if (await emailPages(req, res, url.pathname, deps.invitations, deps.people)) return;
  if (await joinRoute(req, res, url.pathname, deps.join)) return;
  if (req.method === 'POST' && url.pathname === '/v1/testers/meta') {
    if (!deps.testers) throw new HttpError(404, 'Meta sign-in is not set up on this receiver');
    const input = enrollSchema.safeParse(await readJsonBody(req));
    if (!input.success) throw new HttpError(400, input.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const enrolled = await deps.testers.enroll(input.data);
    await welcomeIn(deps, enrolled.grantId, enrolled.name);
    return send(res, 201, enrolled);
  }
  if (req.method === 'POST' && url.pathname === '/v1/testers/google') {
    if (!deps.googleTesters) throw new HttpError(404, 'Google sign-in is not set up on this receiver');
    const input = googleEnrollSchema.safeParse(await readJsonBody(req));
    if (!input.success) throw new HttpError(400, input.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const enrolled = await deps.googleTesters.enroll(input.data);
    await welcomeIn(deps, enrolled.grantId, enrolled.name);
    return send(res, 201, enrolled);
  }
  // The code is the credential here, so this comes before any token is looked at.
  if (await redeemRoute(req, res, url.pathname, deps)) return;
  if (req.headers.authorization && Array.isArray(req.headers.authorization)) throw new HttpError(400, 'one Authorization header only');
  const matched = authenticate(req.headers.authorization, deps.grants);
  // A signed-in tester's token counts only while their sign-in still admits them (testers.ts, google-testers.ts).
  const signedIn = (g: Grant) => isTesterGrant(g) ? Boolean(deps.testers?.authorized(g)) : isGoogleGrant(g) ? Boolean(deps.googleTesters?.authorized(g)) : true;
  // An agent someone connected counts only while that person has a token of their own that does (agents.ts).
  const admitted = (g: Grant) => g.issued ? Boolean(deps.agents?.authorized(g, own => !expired(own) && signedIn(own))) : signedIn(g);
  // An expired token says so, rather than a bare "unknown": its holder needs a new one, not to look for a typo.
  if (matched && expired(matched)) {
    if (!expiredSeen.has(matched.id)) { expiredSeen.add(matched.id); deps.log(`token ${matched.id} refused: it expired ${matched.expiresAt}`); }
    const next = matched.issued ? 'connect again: ask the headset for a code and run polycap connect CODE --replace' : 'ask whoever gave it to you for a new one';
    throw new HttpError(401, `this token expired on ${matched.expiresAt!.slice(0, 10)}; ${next}`, { reason: 'expired' });
  }
  const grant = matched && admitted(matched) ? matched : undefined;
  onGrant(grant);
  if (grant?.issued) deps.agents?.used(grant);
  if (parts[0] !== 'v1') throw new HttpError(404, 'not found');
  const { store } = deps;
  if (await agentRoutes(req, res, parts, grant, deps)) return;
  if (await threadRoutes(req, res, url, parts, grant, deps)) return;

  if (parts[1] === 'uploads') {
    if (req.method === 'POST' && parts.length === 2) {
      const g = need(grant, 'upload');
      const input = createUploadSchema.safeParse(await readJsonBody(req));
      if (!input.success) throw new HttpError(400, input.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
      // A take of logs alone has no media file (docs/LOGS.md): its size is its logs'.
      const mediaBytes = input.data.bytes ?? 0;
      const sideBytes = (input.data.narration?.bytes ?? 0) + (input.data.logs?.bytes ?? 0);
      if (mediaBytes > deps.config.maxUploadBytes) throw new HttpError(413, `upload is larger than ${deps.config.maxUploadBytes} bytes`);
      // The narration is the mic alone, and the pipeline transcribes it as the user's voice.
      if (input.data.narration && !input.data.audioTracks?.includes('mic')) throw new HttpError(400, 'narration: only a recording with a mic track (audioTracks) can send its narration first');
      // A report must never fall back to an ordinary thread, which its sender would see.
      const report = isReportRef(input.data.thread);
      if (report && !deps.threads.reportsOn) throw new HttpError(409, 'this receiver does not take reports: POLYCAP_REPORTS is not set');
      if (!await store.findLive(g.id, input.data.clientId)) {
        if ((isTesterGrant(g) || isGoogleGrant(g)) && !ACCEPTED_CONSENT_VERSIONS.includes(input.data.consent ?? '')) throw new HttpError(400, 'consent: accept the current notice in the app before uploading a new recording');
        const acc = await account(deps.config, store, g, report);
        if (acc.usedBytes + mediaBytes + sideBytes > acc.allowanceBytes) {
          if (report) deps.log(`report from ${g.id} refused: its reports allowance is full (${acc.recordings} report(s))`);
          throw new HttpError(507, report ? 'reports full: this account has sent as much as the team keeps; try again once older reports are cleared' : 'storage full: delete recordings to make room', { usedBytes: acc.usedBytes, allowanceBytes: acc.allowanceBytes });
        }
      }
      const disk = await statfs(store.dir).catch(() => undefined);
      if (disk && disk.bavail * disk.bsize < mediaBytes + sideBytes + DISK_RESERVE) throw new HttpError(507, 'not enough disk space on the receiver');
      // A thread it cannot go in is refused before the upload exists.
      if (deps.threads.enabled) await deps.threads.checkUploadRef(g, input.data.thread);
      else if (input.data.thread) deps.log(`upload from ${g.id} names a thread, but threads are off; it will not be in one`);
      // Someone outside the team: their video is kept for POLYCAP_MEMBER_VIDEO_DAYS, fixed now (storage.ts).
      let { record, created } = await store.create(g.id, input.data, memberScoped(g) ? deps.config.memberVideoDays : undefined);
      if (deps.threads.enabled && !record.threadKey) {
        const link = await deps.threads.attachRecording(g, record, record.thread);
        record = await store.update(record.id, { threadKey: link.key, threadMessage: link.message });
      }
      return send(res, created ? 201 : 200, await store.view(record));
    }
    if (req.method === 'GET' && parts.length === 2) {
      const g = need(grant, 'upload', 'read');
      const wanted = url.searchParams.getAll('clientId');
      const visible = await uploadReader(deps, g);
      const records = (await store.list()).filter(r => visible(r) && (!wanted.length || wanted.includes(r.clientId)));
      return send(res, 200, { uploads: await Promise.all(records.map(r => describeUpload(deps, r))) });
    }
    const record = parts[2] ? await store.get(parts[2]) : undefined;
    if (req.method === 'GET' && parts.length === 3) {
      const g = need(grant, 'upload', 'read');
      if (!record || !(await uploadReader(deps, g))(record)) throw new HttpError(404, 'no such upload');
      return send(res, 200, await describeUpload(deps, record));
    }
    if (req.method === 'DELETE' && parts.length === 3) {
      const g = need(grant, 'upload');
      if (!record || !ownsUpload(g, record.grantId)) throw new HttpError(404, 'no such upload');
      if (record.status === 'deleted') return send(res, 200, await store.view(record));
      if (inFlight(record) || store.isBusy(record.id) || deps.worker.isWorking(record.id)) throw new HttpError(409, 'still being received or processed; try again shortly');
      const gone = await deleteRecording(deps.config, store, record, 'user');
      deps.log(`upload ${record.id} deleted by ${g.id}${record.sessionId ? ` (session ${record.sessionId})` : ''}`);
      return send(res, 200, await store.view(gone));
    }
    if (req.method === 'PUT' && parts.length === 4 && parts[3] === 'content') {
      const g = need(grant, 'upload');
      if (!record || record.grantId !== g.id) throw new HttpError(404, 'no such upload');
      const range = req.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!range) throw new HttpError(400, 'Content-Range: bytes start-end/total is required');
      const [start, end, total] = range.slice(1).map(Number);
      const length = end - start + 1;
      if (total !== record.bytes || end < start) throw new HttpError(400, `Content-Range total must be ${record.bytes} and end at or after start`);
      if (length > MAX_CHUNK) throw new HttpError(413, `chunks are at most ${MAX_CHUNK} bytes`);
      if (Number(req.headers['content-length']) !== length) throw new HttpError(400, 'Content-Length must equal the Content-Range length');
      try {
        const { complete } = await store.append(record, start, length, req);
        if (complete) deps.worker.enqueue(record.id);
      } catch (error) {
        if (error instanceof ConflictError) {
          const fresh = await store.get(record.id);
          throw new HttpError(409, error.message, fresh ? { received: await store.received(fresh), status: fresh.status } : {});
        }
        throw error;
      }
      return send(res, 200, await store.view((await store.get(record.id))!));
    }
    if (req.method === 'PUT' && parts.length === 4 && parts[3] === 'logs') {
      const g = need(grant, 'upload');
      if (!record || record.grantId !== g.id) throw new HttpError(404, 'no such upload');
      if (!record.logs) throw new HttpError(409, 'this upload did not declare logs');
      if (Number(req.headers['content-length']) !== record.logs.bytes) throw new HttpError(400, `Content-Length must be the declared ${record.logs.bytes} bytes`);
      // Here already (a retry after a lost answer): the client carries on.
      if (record.logsAt) { req.resume(); return send(res, 200, await describeUpload(deps, record)); }
      if (record.status !== 'uploading') throw new HttpError(409, `upload is ${record.status}`);
      try { await store.putLogs(record, record.logs.bytes, req); }
      catch (error) { throw error instanceof ConflictError ? new HttpError(409, error.message) : error; }
      const now = (await store.get(record.id))!;
      // A take of logs alone is complete now.
      if (now.status === 'received') deps.worker.enqueue(record.id);
      return send(res, 200, await describeUpload(deps, now));
    }
    if (req.method === 'PUT' && parts.length === 4 && parts[3] === 'narration') {
      const g = need(grant, 'upload');
      if (!record || record.grantId !== g.id) throw new HttpError(404, 'no such upload');
      if (!record.narration) throw new HttpError(409, 'this upload did not declare a narration');
      if (Number(req.headers['content-length']) !== record.narration.bytes) throw new HttpError(400, `Content-Length must be the declared ${record.narration.bytes} bytes`);
      // Already here, or too late to help: the video holds the same sound, so the client carries on.
      if (record.narrationAt || record.status !== 'uploading') { req.resume(); return send(res, 200, await describeUpload(deps, record)); }
      try { await store.putNarration(record, record.narration.bytes, req); }
      catch (error) { throw error instanceof ConflictError ? new HttpError(409, error.message) : error; }
      deps.worker.enqueue(record.id);
      return send(res, 200, await describeUpload(deps, (await store.get(record.id))!));
    }
    throw new HttpError(404, 'not found');
  }

  if (parts[1] === 'me' && parts.length === 2 && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') return send(res, 200, await deps.people.me(need(grant, 'upload', 'read', 'post')));
    const g = need(grant, 'upload', 'post');
    // A copied agent token must not be able to move the address that lets its person into threads.
    if (g.issued) throw new HttpError(403, 'an agent does not change its person\'s address; enter it in Polydance on the headset', { reason: 'agent' });
    // Never logged: the request line carries no address, and a bad one is refused without echoing it.
    const { email } = parse(meSchema, await readJsonBody(req));
    await deps.people.setEmail(personId(g), email);
    // An address not yet verified is emailed a link to confirm it (invitations.ts), each time it is entered;
    // never one someone else has verified, whose owner would be asked to hand it over (people.ts verifiedByOther).
    const entry = email ? (await deps.people.emails())[personId(g)] : undefined;
    const taken = entry && !entry.verified && await deps.people.verifiedByOther(personId(g), entry.email);
    if (taken) deps.log(`${g.id} entered an address another person has confirmed; no link sent`);
    const sent = entry && !entry.verified && !taken && deps.invitations ? await deps.invitations.confirmFor(personId(g), entry.email) : undefined;
    const confirmation = taken ? { confirmation: { status: 'not sent', note: 'Polydance cannot confirm this address for this account; ask whoever invited you' } }
      : sent ? { confirmation: sent.status === 'queued' ? { status: 'sending' } : { status: 'not sent', note: sent.reason } } : {};
    return send(res, 200, { ...await deps.people.me(g), ...confirmation });
  }

  if (parts[1] === 'account' && req.method === 'GET' && parts.length === 2) {
    const g = need(grant, 'upload', 'read');
    if (g.scopes.includes('upload') || !isTeam(g)) return send(res, 200, await account(deps.config, store, g));
    // The team's read token sees the whole receiver against the safety net.
    const all = await store.usage();
    return send(res, 200, { grantId: g.id, usedBytes: all.bytes, allowanceBytes: deps.config.storageHighBytes, recordings: all.recordings });
  }

  if (parts[1] === 'sessions' && req.method === 'GET') {
    const readable = await sessionReader(deps, need(grant, 'read'));
    if (parts.length === 2) {
      const sessions = (await listSessions(deps.config, deps.log)).filter(({ manifest }) => !readable || readable(manifest));
      return send(res, 200, {
        sessions: sessions.map(({ manifest: m }) => ({
          id: m.id, title: m.title, summary: m.summary?.text, recordedAt: m.recordedAt, ready: !isPending(m), words: wordsOnly(m), durationMs: m.media.durationMs,
          steps: Object.fromEntries(Object.entries(m.steps).map(([k, v]) => [k, v.status])), frameCount: m.frameCount, markerCount: m.markerCount,
          uploadId: m.source.uploadId, sha256: m.source.sha256,
        })),
      });
    }
    const id = parts[2];
    if (!SAFE_SEGMENT.test(id)) throw new HttpError(404, 'no such session');
    const dir = sessionDir(deps.config, id);
    if (!await exists(join(dir, 'session.json'))) throw new HttpError(404, 'no such session');
    if (readable && !readable(await loadSession(dir))) throw new HttpError(404, 'no such session');
    if (parts.length === 4 && parts[3] === 'frame') {
      const manifest = await loadSession(dir);
      const at = Number(url.searchParams.get('at'));
      const width = Number(url.searchParams.get('width') ?? 1920);
      const durationMs = manifest.media.durationMs ?? 0;
      if (!Number.isFinite(at) || at < 0 || at * 1000 > durationMs) throw new HttpError(400, `at must be seconds between 0 and ${(durationMs / 1000).toFixed(1)}`);
      if (!Number.isInteger(width) || width < 160 || width > 3840) throw new HttpError(400, 'width must be a whole number of pixels from 160 to 3840');
      if (manifest.media.video === undefined) throw new HttpError(404, 'this session is a take of logs alone: it has no picture');
      const video = join(dir, manifest.media.video);
      if (!await exists(video)) throw new HttpError(404, 'this session has no video on the receiver');
      if (renders >= MAX_RENDERS) throw new HttpError(429, 'busy rendering frames; try again in a moment');
      renders++;
      await privateDir(deps.config.work);
      const out = join(deps.config.work, `frame-${randomBytes(6).toString('hex')}.jpg`);
      try {
        // Input seek: ffmpeg jumps to the keyframe before and decodes forward, so it is fast and, when
        // re-encoding, exact to the frame (accurate_seek is on by default).
        await exec(deps.config.ffmpeg, ['-y', '-v', 'error', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '2', out], { timeoutMs: 60_000 });
        const jpeg = await readFile(out);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, 'cache-control': 'no-store' });
        res.end(jpeg);
        return;
      } finally {
        renders--;
        await rm(out, { force: true });
      }
    }
    if (parts.length === 4 && parts[3] === 'files') {
      const files = [];
      for (const path of await walk(dir)) {
        const full = join(dir, path);
        const info = await stat(full);
        let cached = hashes.get(full);
        if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) {
          cached = { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256File(full) };
          hashes.set(full, cached);
        }
        files.push({ path, bytes: info.size, sha256: cached.sha256 });
      }
      return send(res, 200, { id, files });
    }
    if (parts.length >= 5 && parts[3] === 'files') {
      let segments: string[];
      try { segments = parts.slice(4).map(decodeURIComponent); } catch { throw new HttpError(404, 'no such file'); }
      if (!segments.every(s => SAFE_SEGMENT.test(s))) throw new HttpError(404, 'no such file');
      const full = resolve(dir, ...segments);
      if (!full.startsWith(dir + sep)) throw new HttpError(404, 'no such file');
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) throw new HttpError(404, 'no such file');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' });
      createReadStream(full).pipe(res);
      await new Promise<void>((done, fail) => { res.on('finish', done); res.on('close', done); res.on('error', fail); });
      return;
    }
  }
  throw new HttpError(404, 'not found');
}

/** Relative paths of every regular file under dir, sorted, using forward slashes. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

export { HttpError, type ServerDeps };
