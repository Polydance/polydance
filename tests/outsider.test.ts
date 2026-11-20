/**
 * Someone outside the team reaches none of Robin's recordings outside their own threads (Robin, 2026-11-17).
 * Shaped like the live receiver's first newcomer: a Meta sign-in mapped to nobody in POLYCAP_USERS, newcomers'
 * project START, a Welcome there, and one team thread they were added to with what came before. Robin's
 * recordings sit in a team thread they are not in, in another project, and in a report. Every route that could
 * hand over a recording, its words, a frame, a photo or a model is tried with their token, and every answer
 * they get is searched for what those recordings hold. A thread they are in is tried too, so a 404 elsewhere is
 * the rule and not a broken token. Bundles are written as the worker leaves them: no ffmpeg, no network.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { CONSENT_VERSION } from '../src/server/privacy.js';
import { newToken } from '../src/server/tokens.js';
import { UploadStore } from '../src/server/uploads.js';
import { saveSession, sessionDir, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { testCli } from './helpers/cli.js';
import { makeGlb } from './helpers/glb.js';
import { makePng } from './helpers/photos.js';

const APP_ID = '1300818073125870';
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', packages: ['com.example.marimba'] }, { key: 'CAP', name: 'Polydance Capture' },
  { key: 'START', name: 'Getting started', hosts: ['receiver.example'] },
]);
const USERS = JSON.stringify([{ id: 'robin', name: 'Robin' }]);
const VIDEO = Buffer.from(Array.from({ length: 400 }, (_, i) => i % 251));

/** Meta's two calls, always vouching: who signs in is not what this file tests. */
async function standInMeta(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req) { /* the form body is not read */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/user_nonce_validate' ? { is_valid: true } : { success: true, grant_time: 1744148687 }));
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

describe('a newcomer outside the team reaches none of Robin\'s recordings outside their threads (2026-11-17)', () => {
  const mac = newToken(), quest = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'robin' },
  ]);
  const glb = makeGlb();
  const glbSha = createHash('sha256').update(glb).digest('hex');
  const png = makePng(6, 4);
  let base: string; let close: () => Promise<void>; let meta: Awaited<ReturnType<typeof standInMeta>>;
  let server: Awaited<ReturnType<typeof testCli>>; let uploads: UploadStore;
  let newcomer: string;
  let clients = 0;
  /** Every answer the newcomer's token got, searched at the end for what Robin's other recordings hold. */
  const heard: string[] = [];

  beforeAll(async () => {
    meta = await standInMeta();
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const running = await serve(server, {
      host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, reports: 'CAP',
      welcome: JSON.stringify({ project: 'START', url: 'https://receiver.example/start' }),
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['START'] }) },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    uploads = new UploadStore(server.config.uploads);
  });
  afterAll(async () => { await close?.(); await meta?.close(); });

  const call = async (method: string, path: string, token: string, body?: unknown, type?: string) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': type ?? 'application/json' } : {}) },
    });
    const raw = await response.text();
    // Only what came back: the paths sent carry ids on purpose.
    if (token === newcomer) heard.push(raw);
    let json: Record<string, any> = {};
    try { json = JSON.parse(raw); } catch { /* a video or a model */ }
    return { status: response.status, json, raw };
  };

  /** A recording from Robin's headset, built as the worker leaves it: its own title, summary and video. */
  const record = async (thread: unknown, words: string) => {
    const created = await call('POST', '/v1/uploads', quest.token, {
      clientId: `r${++clients}`, bytes: VIDEO.length, sha256: createHash('sha256').update(`r${clients}`).digest('hex'), fileName: 'clip.mp4',
      recordedAt: '2026-11-17T10:00:00Z', audioTracks: ['mic'], thread,
    });
    expect(created.status).toBe(201);
    const stored = (await uploads.get(created.json.id))!;
    const id = `2026-11-17T10-00-${String(clients).padStart(2, '0')}_capture`;
    const dir = sessionDir(server.config, id);
    await saveSession(dir, {
      version: 1, id, title: words, createdAt: new Date().toISOString(), recordedAt: '2026-11-17T10:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId: stored.id, clientId: stored.clientId, originalName: 'clip.mp4', bytes: VIDEO.length, sha256: 'a'.repeat(64), audioTracks: ['mic'] },
      media: { video: 'video.mp4', durationMs: 2000 }, steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      summary: { title: words, text: `${words}, in a sentence`, model: 'stand-in' },
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
    });
    await writeFile(join(dir, 'video.mp4'), VIDEO, { mode: 0o600 });
    await uploads.update(stored.id, { status: 'ready', sessionId: id });
    return { key: stored.threadKey!, message: stored.threadMessage!, uploadId: stored.id, sessionId: id };
  };

  it('sees only the Welcome and the thread the team added them to, and nothing else by any route', async () => {
    // Robin's recordings where the newcomer is not: a team thread with a model and a photo, another project, a report.
    expect((await call('PUT', `/v1/projects/MUS/models/${glbSha}`, mac.token, glb, 'model/gltf-binary')).status).toBe(201);
    const team = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Team walkthrough plans', text: 'Which chair?', launches: [
      { label: 'Oak', steps: [{ do: 'model', sha256: glbSha, name: 'oak.glb', bytes: glb.length }] },
    ] });
    const hidden = await record({ key: team.json.key }, 'Robin hidden walkthrough');
    const photo = await call('POST', `/v1/threads/${hidden.key}/photos`, mac.token, png, 'image/png');
    expect(photo.status).toBe(201);
    expect((await call('POST', `/v1/threads/${hidden.key}/messages`, mac.token, { text: 'Team photo note', photos: [photo.json.sha256] })).status).toBe(201);
    const elsewhere = await record({ project: 'CAP' }, 'Robin capture project take');
    const report = await record({ report: true }, 'Robin bug report take');
    const shut = [hidden, elsewhere, report];
    // Thread keys are left out: they count up, and a refusal names the key it was asked for.
    const secrets = ['Team walkthrough plans', 'Which chair', 'Team photo note', photo.json.sha256, glbSha, ...shut.flatMap(r => [r.uploadId, r.sessionId]),
      'Robin hidden walkthrough', 'Robin capture project take', 'Robin bug report take'];

    // The newcomer signs in with Meta, mapped to nobody: their Welcome is waiting in START.
    const signed = await fetch(`${base}/v1/testers/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '2001', nonce: 'n-1', deviceId: 'a1b2c3d4', name: 'New Comer', label: 'Quest 3' }) });
    const enrolled = await signed.json() as { token: string; grantId: string; projects: string[] };
    expect([signed.status, enrolled.grantId, enrolled.projects]).toEqual([201, 'meta-2001', ['START']]);
    newcomer = enrolled.token;

    // The team adds them to one thread with what came before, as MUS-31 was, and Robin records there after.
    const shared = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Shared with the newcomer', text: 'Have a look' });
    const before = await record({ key: shared.json.key }, 'Recording before they joined');
    expect((await call('POST', `/v1/threads/${shared.json.key}/members`, mac.token, { add: ['meta-2001'], history: 'visible' })).status).toBe(200);
    const after = await record({ key: shared.json.key }, 'Recording after they joined');

    // Theirs: the Welcome and the shared thread, whose recordings play for them.
    const inbox = await call('GET', '/v1/threads', newcomer);
    expect((inbox.json.threads as { key: string }[]).map(t => t.key).sort()).toEqual([shared.json.key, 'START-1']);
    for (const mine of [before, after]) {
      expect((await call('GET', `/v1/threads/${mine.key}/messages/${mine.message}/playback`, newcomer)).status).toBe(200);
      expect((await call('GET', `/v1/threads/${mine.key}/messages/${mine.message}/video`, newcomer)).raw.length).toBe(VIDEO.length);
    }

    // Not theirs: every way in is the 404 a thread nobody opened gets, or a 403 for a scope they lack.
    const nowhere = (await call('GET', '/v1/threads/MUS-99', newcomer)).json.error.replace('MUS-99', 'KEY');
    for (const { key, message } of shut) {
      const got = await call('GET', `/v1/threads/${key}`, newcomer);
      expect([got.status, got.json.error?.replace(key, 'KEY')]).toEqual([404, nowhere]);
      for (const [method, path, body, type] of [
        ['GET', `/v1/threads/${key}/messages/${message}/playback`], ['GET', `/v1/threads/${key}/messages/${message}/video`], ['HEAD', `/v1/threads/${key}/messages/${message}/video`],
        ['GET', `/v1/threads/${key}/models/${glbSha}`], ['HEAD', `/v1/threads/${key}/models/${glbSha}`],
        ['GET', `/v1/threads/${key}/photos/${photo.json.sha256}`], ['HEAD', `/v1/threads/${key}/photos/${photo.json.sha256}`],
        ['PATCH', `/v1/threads/${key}`, { state: 'closed' }], ['POST', `/v1/threads/${key}/state`, { state: 'closed' }],
        ['POST', `/v1/threads/${key}/read`, { seq: 1 }], ['POST', `/v1/threads/${key}/hide`], ['POST', `/v1/threads/${key}/unhide`],
        ['POST', `/v1/threads/${key}/reactions`, { message, reaction: 'heart' }], ['POST', `/v1/threads/${key}/picks`, { message: 1, launch: 0 }],
        ['POST', `/v1/threads/${key}/messages`, { photos: [photo.json.sha256] }], ['POST', `/v1/threads/${key}/photos`, png, 'image/png'],
        ['POST', `/v1/threads/${key}/participants`, { add: ['newcomer@example.com'] }], ['POST', `/v1/threads/${key}/members`, { add: ['meta-2001'] }],
      ] as const) expect([method, path, (await call(method, path, newcomer, body, type)).status]).toEqual([method, path, 404]);
      // Recording into it, as a reply or not, is refused before an upload exists.
      for (const thread of [{ key }, { key, replyTo: { message } }]) {
        const into = await call('POST', '/v1/uploads', newcomer, { clientId: `try-${key}-${'replyTo' in thread}`, bytes: 10, sha256: 'b'.repeat(64), fileName: 'clip.mp4', audioTracks: ['mic'], consent: CONSENT_VERSION, thread });
        expect([key, into.status]).toEqual([key, 404]);
      }
    }
    // Another project's threads, and a new one there: theirs is START alone.
    for (const project of ['MUS', 'CAP']) {
      expect((await call('GET', `/v1/threads?project=${project}`, newcomer)).json.threads.map((t: { key: string }) => t.key)).toEqual(project === 'MUS' ? [shared.json.key] : []);
      expect((await call('POST', '/v1/uploads', newcomer, { clientId: `new-${project}`, bytes: 10, sha256: 'c'.repeat(64), fileName: 'clip.mp4', audioTracks: ['mic'], consent: CONSENT_VERSION, thread: { project } })).status).toBe(404);
      expect((await call('POST', `/v1/projects/${project}/photos`, newcomer, png, 'image/png')).status).toBe(404);
    }

    // Uploads are their own: Robin's are a 404 by id, to read, delete or write.
    expect((await call('GET', '/v1/uploads', newcomer)).json.uploads).toEqual([]);
    for (const { uploadId } of [...shut, before, after]) {
      for (const [method, path] of [['GET', `/v1/uploads/${uploadId}`], ['DELETE', `/v1/uploads/${uploadId}`]] as const) expect([method, path, (await call(method, path, newcomer)).status]).toEqual([method, path, 404]);
    }
    // Bundles need `read`, which a headset's sign-in never has, even for a recording they may play.
    for (const { sessionId } of [...shut, after]) {
      for (const path of ['/v1/sessions', `/v1/sessions/${sessionId}/files`, `/v1/sessions/${sessionId}/files/session.json`, `/v1/sessions/${sessionId}/frame?at=1`]) {
        expect([path, (await call('GET', path, newcomer)).status]).toEqual([path, 403]);
      }
    }

    // The feed carries only their two threads; waiting on it wakes for nothing of Robin's elsewhere.
    const feed = (await call('GET', '/v1/events?after=0', newcomer)).json.events as { thread: string }[];
    expect([...new Set(feed.map(e => e.thread))].sort()).toEqual([shared.json.key, 'START-1']);
    const last = (await call('GET', '/v1/events', newcomer)).json.last as number;
    const waiting = call('GET', `/v1/events?after=${last}&wait=2`, newcomer);
    expect((await call('POST', `/v1/threads/${hidden.key}/messages`, mac.token, { text: 'Team only, later' })).status).toBe(201);
    expect((await waiting).json.events).toEqual([]);

    // A project of their own cannot take a team project's key, and seeing it whole adds nothing of Robin's.
    expect((await call('POST', '/v1/projects', newcomer, { key: 'MUS', name: 'Mine' })).status).toBeGreaterThanOrEqual(400);
    const own = await call('POST', '/v1/projects', newcomer, { key: 'NEW', name: 'Newcomer' });
    expect(own.status).toBe(201);
    expect((await call('GET', '/v1/threads', newcomer)).json.threads.map((t: { key: string }) => t.key).sort()).toEqual([shared.json.key, 'START-1']);

    // An address of theirs that the team invited elsewhere lets them in only once they confirm it from its email.
    expect((await call('POST', `/v1/threads/${hidden.key}/participants`, mac.token, { add: ['someone@example.com'] })).status).toBe(200);
    expect((await call('POST', '/v1/me', newcomer, { email: 'someone@example.com' })).status).toBe(200);
    expect((await call('GET', `/v1/threads/${hidden.key}`, newcomer)).status).toBe(404);

    // Taken out of the shared thread, they lose it too.
    expect((await call('POST', `/v1/threads/${shared.json.key}/members`, mac.token, { remove: ['meta-2001'] })).status).toBe(200);
    expect((await call('GET', `/v1/threads/${shared.json.key}/messages/${after.message}/playback`, newcomer)).status).toBe(404);

    // Nothing they were answered holds anything of Robin's recordings outside their threads.
    const all = heard.join('\n');
    for (const secret of secrets) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });
});
