/** The hosted receiver, sync, the Gladia transcriber and the Claude summary, over real HTTP on localhost with real ffmpeg. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frames } from '../src/commands/inspect.js';
import { serve } from '../src/commands/serve.js';
import { sync } from '../src/commands/sync.js';
import { me, threadList, threadMembers, threadShow } from '../src/commands/thread.js';
import { DEFAULT_EXPIRY_DAYS, expiryFor, tokenNew } from '../src/commands/token.js';
import { exportCommand } from '../src/commands/export.js';
import { video as fetchVideo } from '../src/commands/video.js';
import { readEnvFile } from '../src/config.js';
import { exec } from '../src/exec.js';
import { GladiaTranscriber, parseGladiaResult } from '../src/pipeline/gladia.js';
import { groundRequests, salvageAnswer, summarize } from '../src/pipeline/summary.js';
import { loadSession, saveSession, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { authenticate, expired, hashToken, newToken, parseGrants } from '../src/server/tokens.js';
import { UploadStore } from '../src/server/uploads.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

describe('receiver tokens', () => {
  const upload = newToken(), read = newToken();
  const grants = parseGrants(JSON.stringify([
    { id: 'quest3', sha256: upload.sha256, scopes: ['upload'] },
    { id: 'mac', sha256: read.sha256, scopes: ['read'] },
  ]));

  it('matches the right grant and nothing else', () => {
    expect(authenticate(`Bearer ${upload.token}`, grants)?.id).toBe('quest3');
    expect(authenticate(`Bearer ${read.token}`, grants)?.id).toBe('mac');
    expect(authenticate(`Bearer ${newToken().token}`, grants)).toBeUndefined();
    expect(authenticate(upload.token, grants)).toBeUndefined();
    expect(authenticate(`Bearer polycap_short`, grants)).toBeUndefined();
    // A token made before the rename (hib_) still works if its hash is listed.
    const legacy = `hib_${'c'.repeat(64)}`;
    expect(authenticate(`Bearer ${legacy}`, parseGrants(JSON.stringify([{ id: 'quest3', sha256: hashToken(legacy), scopes: ['upload'] }])))?.id).toBe('quest3');
    expect(hashToken(upload.token)).toBe(upload.sha256);
  });

  it('fails closed on a missing, malformed or duplicated list', () => {
    expect(() => parseGrants(undefined)).toThrow(/empty/);
    expect(() => parseGrants('{')).toThrow(/not JSON/);
    expect(() => parseGrants('[{"id":"x","sha256":"00","scopes":["upload"]}]')).toThrow();
    expect(() => parseGrants(JSON.stringify([{ id: 'a', sha256: upload.sha256, scopes: ['admin'] }]))).toThrow();
    const twice = { id: 'a', sha256: upload.sha256, scopes: ['upload'] };
    expect(() => parseGrants(JSON.stringify([twice, twice]))).toThrow(/duplicate/);
    // A thread-scoped token is bound to its person, and member is the only kind.
    expect(() => parseGrants(JSON.stringify([{ id: 'a', sha256: upload.sha256, scopes: ['read'], threads: 'member' }]))).toThrow(/threads: a thread-scoped token/);
    expect(() => parseGrants(JSON.stringify([{ id: 'a', sha256: upload.sha256, scopes: ['read'], user: 'ana', threads: 'all' }]))).toThrow();
    expect(parseGrants(JSON.stringify([{ id: 'a', sha256: upload.sha256, scopes: ['read'], user: 'ana', threads: 'member' }]))[0].threads).toBe('member');
  });
});

describe('a thread-scoped agent token syncs only its threads\' sessions (2026-10-21)', () => {
  const mac = newToken(), ana = newToken(), ben = newToken(), anaAgent = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' },
    { id: 'ana-quest', sha256: ana.sha256, scopes: ['upload'], user: 'ana', projects: ['MUS'], threads: 'member' },
    { id: 'ben-quest', sha256: ben.sha256, scopes: ['upload'], user: 'ben', projects: ['MUS'], threads: 'member' },
    { id: 'ana-agent', sha256: anaAgent.sha256, scopes: ['read'], user: 'ana', threads: 'member' },
  ]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba' }]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }, { id: 'ben', name: 'Ben' }]);
  let base: string; let close: () => Promise<void>; let server: Awaited<ReturnType<typeof testCli>>; let uploads: UploadStore;
  let n = 0;
  beforeAll(async () => {
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects, users });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    uploads = new UploadStore(server.config.uploads);
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  /** A recording in a thread, its bundle written as the worker leaves it; returns the upload and session ids. */
  const recording = async (token: string, thread?: unknown) => {
    const created = await call('POST', '/v1/uploads', token, { clientId: `c${++n}`, bytes: 10, sha256: createHash('sha256').update(`c${n}`).digest('hex'), fileName: 'clip.mp4', ...(thread ? { thread } : {}) });
    expect(created.status).toBe(201);
    const id = `2026-10-21T12-00-0${n}_capture`;
    const dir = join(server.config.sessions, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'transcript.md'), `words ${n}\n`);
    await saveSession(dir, {
      version: 1, id, title: id, createdAt: '2026-10-21T11:00:00.000Z', recordedAt: '2026-10-21T11:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId: created.json.id, clientId: `c${n}`, originalName: 'clip.mp4', bytes: 10, sha256: 'a'.repeat(64) },
      media: { video: 'video.mp4', durationMs: 1000 }, steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
    });
    await uploads.update(created.json.id, { status: 'ready', sessionId: id });
    return { upload: created.json.id as string, session: id, thread: (await uploads.get(created.json.id))!.threadKey! };
  };
  const sessionIds = async (token: string) => ((await call('GET', '/v1/sessions', token)).json.sessions as { id: string }[]).map(s => s.id).sort();

  it('lists, serves and syncs only the sessions behind recordings in threads its person is in', async () => {
    const mine = await recording(ana.token);
    const bens = await recording(ben.token);
    expect([mine.thread, bens.thread]).toEqual(['MUS-1', 'MUS-2']);
    expect(await sessionIds(mac.token)).toEqual([mine.session, bens.session].sort());
    expect(await sessionIds(anaAgent.token)).toEqual([mine.session]);
    // Ben's session, its files, a file in it and a frame of it are each a 404, as if it were not there.
    for (const path of [`/v1/sessions/${bens.session}/files`, `/v1/sessions/${bens.session}/files/transcript.md`, `/v1/sessions/${bens.session}/frame?at=0`, '/v1/sessions/nothing-here/files']) {
      const refused = await call('GET', path, anaAgent.token);
      expect([path, refused.status, refused.json.error]).toEqual([path, 404, 'no such session']);
    }
    expect((await call('GET', `/v1/sessions/${mine.session}/files`, anaAgent.token)).status).toBe(200);
    // Uploads the same way; her headset sees only its own; neither headset may sync at all.
    expect(((await call('GET', '/v1/uploads', anaAgent.token)).json.uploads as { id: string }[]).map(u => u.id)).toEqual([mine.upload]);
    expect((await call('GET', `/v1/uploads/${bens.upload}`, anaAgent.token)).status).toBe(404);
    expect((await call('GET', '/v1/sessions', ana.token)).status).toBe(403);
    // Her account is her own, never the whole receiver's.
    expect((await call('GET', '/v1/account', anaAgent.token)).json).toMatchObject({ grantId: 'ana-agent', recordings: 0 });
    expect((await call('GET', '/v1/account', mac.token)).json).toMatchObject({ recordings: 2 });

    const local = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: anaAgent.token });
    expect(await sync({ ...local, print: () => {} }, { video: false, dryRun: false })).toMatchObject({ downloaded: [mine.session] });
    expect(await readdir(local.config.sessions)).toEqual([mine.session]);
    await expect(sync({ ...local, print: () => {} }, { session: bens.session, video: false, dryRun: false })).rejects.toThrow(/missing or ambiguous/);

    // Added to Ben's thread by the team, her agent syncs what is recorded there from then on, never Ben's
    // recording from before (2026-11-12); taken out, it syncs nothing of the thread again.
    expect((await call('POST', '/v1/threads/MUS-2/members', mac.token, { add: ['ana'] })).status).toBe(200);
    expect(await sync({ ...local, print: () => {} }, { video: false, dryRun: false })).toMatchObject({ downloaded: [] });
    expect((await call('GET', `/v1/sessions/${bens.session}/files`, anaAgent.token)).status).toBe(404);
    expect((await call('GET', `/v1/uploads/${bens.upload}`, anaAgent.token)).status).toBe(404);
    const later = await recording(ben.token, { key: 'MUS-2' });
    expect(await sync({ ...local, print: () => {} }, { video: false, dryRun: false })).toMatchObject({ downloaded: [later.session] });
    expect(((await call('GET', '/v1/uploads', anaAgent.token)).json.uploads as { id: string }[]).map(u => u.id).sort()).toEqual([mine.upload, later.upload].sort());
    expect((await call('POST', '/v1/threads/MUS-2/members', mac.token, { remove: ['ana'] })).status).toBe(200);
    expect(await sessionIds(anaAgent.token)).toEqual([mine.session]);
    expect((await call('GET', `/v1/sessions/${later.session}/files`, anaAgent.token)).status).toBe(404);
  });

  it('makes the token and works polycap thread with it: the team adds and removes, the agent sees only its threads', async () => {
    const maker = await testCli();
    await expect(tokenNew(maker, { id: 'ana-agent', scopes: ['read', 'post'], member: true })).rejects.toThrow(/--member needs --user/);
    // Every token says who it is for (2026-11-12): forgetting both flags, or giving both, makes none.
    await expect(tokenNew(maker, { id: 'ana-agent', scopes: ['read', 'post'], user: 'ana' })).rejects.toThrow(/say who this token is for: --member --user ID .* or --team/);
    await expect(tokenNew(maker, { id: 'ana-agent', scopes: ['read'], user: 'ana', member: true, team: true })).rejects.toThrow(/--member and --team: say one/);
    expect(maker.lines).toEqual([]);
    await tokenNew(maker, { id: 'robin-quest', scopes: ['upload'], user: 'robin', team: true, expires: 'never' });
    expect(JSON.parse(maker.lines.join('\n').match(/\{"id":"robin-quest".*\}/)![0])).toEqual({ id: 'robin-quest', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), scopes: ['upload'], user: 'robin' });
    maker.lines.length = 0;
    await tokenNew(maker, { id: 'ana-agent', scopes: ['read', 'post'], user: 'ana', member: true, label: "Ana's Mac" });
    expect(JSON.parse(maker.lines.join('\n').match(/\{"id":"ana-agent".*\}/)![0])).toMatchObject({ id: 'ana-agent', scopes: ['read', 'post'], user: 'ana', threads: 'member' });

    const robin = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: anaAgent.token });
    const repo = await mkdtemp(join(tmpdir(), 'repo-'));
    await threadMembers(robin, 'MUS-2', { add: ['ana'] }, { project: 'MUS', cwd: repo });
    expect(robin.lines.at(-1)).toMatch(/^MUS-2 · .* · members: Ben \(ben\), Ana \(ana\)$/);
    await threadShow(robin, 'MUS-2', { cwd: repo });
    // Ben opened it by recording, so he is in it already.
    expect(robin.lines).toContain('Members: Ben (ben), Ana (ana)');
    await threadList(agent, { all: true, cwd: repo });
    expect(agent.lines.at(-1)).toMatch(/MUS-1/);
    expect(agent.lines.at(-1)).toMatch(/MUS-2/);
    await threadShow(agent, 'MUS-2', { cwd: repo });
    expect(agent.lines.some(line => line.startsWith('Members:'))).toBe(false);
    // Only the team changes who is in a thread.
    await expect(threadMembers(agent, 'MUS-2', { add: ['ben'] }, { cwd: repo })).rejects.toThrow(/403/);
    await threadMembers(robin, 'MUS-2', { remove: ['ana'] }, { cwd: repo });
    expect(robin.lines.at(-1)).toMatch(/members: Ben \(ben\)$/);
    await expect(threadShow(agent, 'MUS-2', { cwd: repo })).rejects.toThrow(/404/);
  });
});

describe('token expiry (2026-11-12)', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  const DAY = 24 * 3600_000;

  it('gives a new token 90 days unless told a number of days, a date or never, and refuses anything else', async () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(90);
    expect(expiryFor(undefined, now)).toBe('2027-02-10T10:00:00Z');
    expect(expiryFor('30d', now)).toBe('2026-12-12T10:00:00Z');
    expect(expiryFor('2027-01-31', now)).toBe('2027-01-31T23:59:59Z');
    expect(expiryFor('2026-11-12', now)).toBe('2026-11-12T23:59:59Z');
    expect(expiryFor('never', now)).toBeUndefined();
    for (const [value, why] of [['0d', /from 1d/], ['3651d', /from 1d/], ['2026-11-11', /that day is over/], ['2026-02-30', /a date/], ['2037-01-01', /ten years/], ['soon', /a date/], ['90', /a date/]] as const) {
      expect(() => expiryFor(value, now)).toThrow(why);
    }
    const maker = await testCli();
    await tokenNew(maker, { id: 'ana-agent', scopes: ['read'], user: 'ana', member: true }, now);
    expect(maker.lines.join('\n')).toContain('It expires 2027-02-10 (90 days); --expires never makes one that does not.');
    expect(JSON.parse(maker.lines.join('\n').match(/\{"id":"ana-agent".*\}/)![0])).toMatchObject({ threads: 'member', expiresAt: '2027-02-10T10:00:00Z' });
    // What it prints is what the receiver accepts.
    const printed = JSON.parse(maker.lines.join('\n').match(/\{"id":"ana-agent".*\}/)![0]);
    expect(parseGrants(JSON.stringify([printed]))[0].expiresAt).toBe('2027-02-10T10:00:00Z');
    const never = await testCli();
    await tokenNew(never, { id: 'quest9', scopes: ['upload'], user: 'robin', team: true, expires: 'never' }, now);
    expect(never.lines.join('\n')).toContain('It never expires.');
  });

  it('refuses a token from the moment it expires, saying so, on every route that needs one', async () => {
    const live = newToken(), lapsed = newToken(), soon = newToken();
    const at = (ms: number) => new Date(ms).toISOString();
    expect([expired({ expiresAt: at(now) }, now), expired({ expiresAt: at(now + 1) }, now), expired({}, now)]).toEqual([true, false, false]);
    expect(() => parseGrants(JSON.stringify([{ id: 'x', sha256: live.sha256, scopes: ['read'], expiresAt: 'next week' }]))).toThrow(/expiresAt/);
    const tokens = JSON.stringify([
      { id: 'live', sha256: live.sha256, scopes: ['read', 'post'], user: 'robin', expiresAt: at(Date.now() + 30 * DAY) },
      { id: 'lapsed', sha256: lapsed.sha256, scopes: ['read', 'post'], user: 'robin', expiresAt: at(Date.now() - 1000) },
      { id: 'soon', sha256: soon.sha256, scopes: ['upload'], user: 'robin', expiresAt: at(Date.now() + 3 * DAY) },
    ]);
    const server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: JSON.stringify([{ key: 'MUS', name: 'Marimba' }]), users: JSON.stringify([{ id: 'robin', name: 'Robin' }]) });
    try {
      const base = `http://127.0.0.1:${running.port}`;
      const call = async (path: string, token: string, method = 'GET') => {
        const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
      };
      expect(server.lines).toContain('expired token(s), refused until replaced: lapsed');
      expect(server.lines.find(l => l.startsWith('token(s) expiring within 14 days: '))).toMatch(/^token\(s\) expiring within 14 days: soon \(\d{4}-\d{2}-\d{2}\)$/);
      for (const path of ['/v1/me', '/v1/threads', '/v1/sessions', '/v1/projects', '/v1/events', '/v1/uploads', '/v1/account']) {
        const refused = await call(path, lapsed.token);
        expect([path, refused.status, refused.json.reason]).toEqual([path, 401, 'expired']);
        expect(refused.json.error).toMatch(/^this token expired on \d{4}-\d{2}-\d{2}; ask whoever gave it to you for a new one$/);
      }
      expect((await call('/v1/uploads', lapsed.token, 'POST')).status).toBe(401);
      // Logged once, never the token.
      expect(server.lines.filter(l => l.startsWith('token lapsed refused: it expired '))).toHaveLength(1);
      expect(server.lines.join('\n')).not.toContain(lapsed.token);
      // The others work, and say when they end; an unknown token is still the plain 401.
      expect((await call('/v1/threads', live.token)).status).toBe(200);
      expect((await call('/v1/me', live.token)).json).toMatchObject({ me: 'live', expiresAt: expect.stringMatching(/^\d{4}-/) });
      expect((await call('/v1/health', lapsed.token)).status).toBe(200);
      expect((await call('/v1/threads', newToken().token)).json).toEqual({ error: 'missing or unknown token' });
      const local = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: live.token });
      await me(local);
      expect(local.lines.at(-1)).toMatch(/^This token \(live\) expires \d{4}-\d{2}-\d{2}$/);
    } finally { await running.close(); }
  });
});

describe('upload store', () => {
  it('never loses one change to another made at the same moment', async () => {
    // The HTTP layer marks a finished video received while the worker records the session its narration began.
    const store = new UploadStore(await mkdtemp(join(tmpdir(), 'uploads-')));
    const { record } = await store.create('quest3', { clientId: 'c1', bytes: 10, sha256: 'a'.repeat(64), fileName: 'x.mp4', audioTracks: ['mic'], narration: { bytes: 4, sha256: 'b'.repeat(64) } });
    await Promise.all([store.update(record.id, { sessionId: 's1' }), store.update(record.id, { status: 'received' }), store.update(record.id, { narrationAt: '2026-10-04T10:00:00Z' })]);
    expect(await store.get(record.id)).toMatchObject({ sessionId: 's1', status: 'received', narrationAt: '2026-10-04T10:00:00Z' });
    expect(await store.view((await store.get(record.id))!)).toMatchObject({ narration: 'received' });
  });
});

describe('user config file', () => {
  it('reads KEY=VALUE and refuses a file others can read', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'polycap-env-')), 'env');
    await writeFile(file, '# remote\nPOLYCAP_REMOTE_URL=https://capture.example\nPOLYCAP_REMOTE_TOKEN="polycap_abc"\n\n', { mode: 0o600 });
    expect(readEnvFile(file)).toEqual({ POLYCAP_REMOTE_URL: 'https://capture.example', POLYCAP_REMOTE_TOKEN: 'polycap_abc' });
    expect(readEnvFile(join(file, '..', 'missing'))).toEqual({});
    await chmod(file, 0o644);
    expect(() => readEnvFile(file)).toThrow(/chmod 600/);
    await writeFile(file, 'not a line\n', { mode: 0o600 }); await chmod(file, 0o600);
    expect(() => readEnvFile(file)).toThrow(/line 1/);
  });
});

describe('Gladia transcriber', () => {
  it('keeps word timings from Gladia, trimmed, in milliseconds', () => {
    const parsed = parseGladiaResult({ id: 'j', status: 'done', result: { transcription: { utterances: [
      { start: 1, end: 2.5, text: ' hide this ', words: [{ word: ' hide', start: 1, end: 1.4, confidence: 0.9 }, { word: ' this', start: 1.5, end: 1.9, confidence: 0.9 }] },
    ] } } });
    expect(parsed.segments).toEqual([{ startMs: 1000, endMs: 2500, text: 'hide this', words: [{ text: 'hide', startMs: 1000, endMs: 1400 }, { text: 'this', startMs: 1500, endMs: 1900 }] }]);
  });

  it('maps utterances to segments in milliseconds, sorted, dropping empty text', () => {
    const parsed = parseGladiaResult({ id: 'j', status: 'done', result: { transcription: { languages: ['en'], utterances: [
      { start: 4.2, end: 6, text: ' bug here ' }, { start: 0.5, end: 2.25, text: 'hello' }, { start: 7, end: 8, text: '  ' },
    ] } } });
    expect(parsed).toEqual({ language: 'en', segments: [{ startMs: 500, endMs: 2250, text: 'hello' }, { startMs: 4200, endMs: 6000, text: 'bug here' }] });
  });

  async function fakeGladia(finalStatus: 'done' | 'error') {
    const calls: string[] = [];
    let polls = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      calls.push(`${req.method} ${req.url} ${req.headers['x-gladia-key']}`);
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/v2/upload') return json(200, { audio_url: 'https://api.gladia.io/file/abc' });
      if (req.url === '/v2/pre-recorded' && req.method === 'POST') return json(201, { id: 'job1', result_url: 'x' });
      if (req.url === '/v2/pre-recorded/job1' && req.method === 'GET') {
        if (polls++ === 0) return json(200, { id: 'job1', status: 'processing' });
        return json(200, finalStatus === 'done'
          ? { id: 'job1', status: 'done', result: { transcription: { languages: ['en'], utterances: [{ start: 1, end: 2, text: 'it would be nice' }] } } }
          : { id: 'job1', status: 'error', error_code: 422 });
      }
      if (req.url === '/v2/pre-recorded/job1' && req.method === 'DELETE') { res.writeHead(202); return res.end(); }
      json(404, { message: 'no' });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  it('uploads, polls, returns segments and deletes the job', async () => {
    const gladia = await fakeGladia('done');
    const wav = join(await mkdtemp(join(tmpdir(), 'gladia-')), 'a.wav');
    await writeFile(wav, 'RIFF fake wav');
    const transcript = await new GladiaTranscriber('k-123', gladia.url, 'en', { pollMs: 5 }).transcribe(wav);
    gladia.close();
    expect(transcript).toMatchObject({ engine: 'gladia', language: 'en', segments: [{ startMs: 1000, endMs: 2000, text: 'it would be nice' }], note: 'Gladia job deleted at Gladia' });
    expect(gladia.calls).toEqual([
      'POST /v2/upload k-123', 'POST /v2/pre-recorded k-123', 'GET /v2/pre-recorded/job1 k-123', 'GET /v2/pre-recorded/job1 k-123', 'DELETE /v2/pre-recorded/job1 k-123',
    ]);
  });

  it('reports a failed job and still deletes it', async () => {
    const gladia = await fakeGladia('error');
    const wav = join(await mkdtemp(join(tmpdir(), 'gladia-')), 'a.wav');
    await writeFile(wav, 'RIFF');
    await expect(new GladiaTranscriber('k', gladia.url, 'en', { pollMs: 5 }).transcribe(wav)).rejects.toThrow(/failed with code 422; job deleted at Gladia/);
    gladia.close();
    expect(gladia.calls.at(-1)).toBe('DELETE /v2/pre-recorded/job1 k');
  });
});

describe('Claude summary', () => {
  const segments = [{ startMs: 1000, endMs: 4000, text: 'The record button should be a red switch.' }, { startMs: 65_000, endMs: 68_000, text: 'It would be nice to have a summary per recording.' }];
  const config = async (url: string) => (await testCli({ POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: url })).config;

  it('sends only the transcript, with the key, to the cheap model, and tidies the answer', async () => {
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({
      title: '"Capture deck redesign."', summary: '  Robin wants a red RECORDING switch and a summary per recording. ',
      requests: [
        { line: 1, quote: 'record button should be a red switch', kind: 'change', request: 'Make the record button a red switch' },
        { line: 2, quote: 'It would be nice to have a summary per recording', kind: 'idea', request: 'Maybe add a summary per recording' },
      ],
    })) }));
    const result = await summarize(await config(claude.url), segments);
    claude.close();
    expect(result.summary).toEqual({ title: 'Capture deck redesign', text: 'Robin wants a red RECORDING switch and a summary per recording.', model: 'claude-haiku-4-5' });
    // Each request is pinned to the start of the line its quote is on.
    expect(result).toMatchObject({ moved: 0, rejected: [], requests: [
      { atMs: 1000, text: 'Make the record button a red switch', kind: 'change', quote: 'record button should be a red switch' },
      { atMs: 65_000, text: 'Maybe add a summary per recording', kind: 'idea', quote: 'It would be nice to have a summary per recording' },
    ] });
    expect(claude.calls).toHaveLength(1);
    const [call] = claude.calls;
    expect(call.url).toBe('/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({ model: 'claude-haiku-4-5', output_config: { format: { type: 'json_schema', schema: { required: ['title', 'summary', 'requests'] } } } });
    expect(call.body.messages).toEqual([{ role: 'user', content: '<transcript>\n[L1] The record button should be a red switch.\n[L2] It would be nice to have a summary per recording.\n</transcript>' }]);
  });

  it('reports a refusal, a refused key and an answer that is not the format, as errors', async () => {
    const refusal = await fakeClaude(() => ({ status: 200, body: claudeMessage('I cannot help with that.', 'refusal') }));
    await expect(summarize(await config(refusal.url), segments)).rejects.toThrow(/declined/);
    refusal.close();
    const badKey = await fakeClaude(() => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    await expect(summarize(await config(badKey.url), segments)).rejects.toThrow(/refused ANTHROPIC_API_KEY/);
    expect(badKey.calls).toHaveLength(1);
    badKey.close();
    const prose = await fakeClaude(() => ({ status: 200, body: claudeMessage('A recording about the deck.') }));
    await expect(summarize(await config(prose.url), segments)).rejects.toThrow(/structured output/);
    prose.close();
  });

  it('keeps the title, the summary and every finished request of an answer cut off at its token limit; a call gets a far higher limit', async () => {
    const whole = JSON.stringify({ title: 'Red switch and summaries', summary: 'Asks for a red switch and a summary per recording.', requests: [
      { line: 1, quote: 'record button should be a red switch', kind: 'change', request: 'Make the record button a red "switch" {now}' },
      { line: 2, quote: 'It would be nice to have a summary per recording', kind: 'idea', request: 'Maybe add a summary per recording' },
    ] });
    // Cut inside the second request, as the API stops at max_tokens.
    const cut = whole.slice(0, whole.indexOf('Maybe add'));
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(cut, 'max_tokens') }));
    const call = { app: 'meet' as const, startedAt: '2026-11-05T11:00:02.120Z' };
    const result = await summarize(await config(claude.url), segments, 'both', undefined, { call, durationMs: 3_600_000 });
    expect(result.summary).toMatchObject({ title: 'Red switch and summaries', text: 'Asks for a red switch and a summary per recording.' });
    expect(result.requests).toEqual([{ atMs: 1000, text: 'Make the record button a red "switch" {now}', kind: 'change', quote: 'record button should be a red switch' }]);
    expect(result.cutOff).toBe("Claude's answer stopped at its 32000-token limit: 1 complete request kept, any after it missing");
    expect(claude.calls[0].body.max_tokens).toBe(32_000);
    claude.close();
    // Cut before the requests began, there is no title to trust.
    const early = await fakeClaude(() => ({ status: 200, body: claudeMessage(whole.slice(0, 40), 'max_tokens') }));
    await expect(summarize(await config(early.url), segments)).rejects.toThrow(/ran out of tokens \(4096\) before finishing the title and summary/);
    expect(early.calls[0].body.max_tokens).toBe(4096);
    early.close();
    // Brackets and escaped quotes inside the strings are not structure.
    expect(salvageAnswer('{"title":"A [b] {c}","summary":"Say \\"]}\\" twice","requests":[{"line":1,"quote":"q}","kind":"change","request":"r"},{"line":2,"quote":"cut')).toEqual({
      title: 'A [b] {c}', summary: 'Say "]}" twice', requests: [{ line: 1, quote: 'q}', kind: 'change', request: 'r' }],
    });
    expect(salvageAnswer('{"title":"A","summary":"B","requests":[')).toEqual({ title: 'A', summary: 'B', requests: [] });
    expect(salvageAnswer('{"title":"A","summ')).toBeUndefined();
  });

  describe('grounding each request in its line', () => {
    const lines = [
      { startMs: 10_000, endMs: 12_000, text: 'Make the button red, and maybe' },
      { startMs: 30_000, endMs: 32_000, text: "hide the title? Don't reduce the deck." },
      { startMs: 40_000, endMs: 42_000, text: 'The deck is too small.' },
      { startMs: 50_000, endMs: 52_000, text: 'Yes, the deck is too small.' },
    ];
    const ask = (line: number, quote: string, request = 'Do it', kind = 'change') => ({ line, quote, kind, request });

    it('pins a request to the line its quote is on, whatever the quote\'s case or punctuation, and may run on into the next line', () => {
      expect(groundRequests([ask(1, 'make the button RED'), ask(1, 'and maybe hide the title', 'Maybe hide the title', 'idea'), ask(2, 'dont reduce the deck')], lines)).toEqual({ moved: 0, rejected: [], requests: [
        { atMs: 10_000, text: 'Do it', kind: 'change', quote: 'make the button RED' },
        { atMs: 10_000, text: 'Maybe hide the title', kind: 'idea', quote: 'and maybe hide the title' },
        { atMs: 30_000, text: 'Do it', kind: 'change', quote: 'dont reduce the deck' },
      ] });
    });

    it('follows a quote across fragment lines, allows a few words it leaves out, and refuses words it adds', () => {
      const fragments = [
        { startMs: 1000, endMs: 2000, text: 'So when the bar is uploading,' }, { startMs: 2000, endMs: 3000, text: 'it should be one colour.' },
        { startMs: 3000, endMs: 4000, text: "When it's processing," }, { startMs: 4000, endMs: 5000, text: 'another colour. Keep the title of the' },
        { startMs: 5000, endMs: 6000, text: 'of the thread at the top.' },
      ];
      const result = groundRequests([
        ask(1, "So when the bar is uploading, it should be one colour. When it's processing, another colour."),
        ask(4, 'Keep the title of the thread at the top'),
        ask(1, 'when the upload bar is uploading it should be one colour'),
        ask(1, 'the bar is uploading, [L2] it should be one colour.'),
      ], fragments);
      expect(result.requests.map(r => r.atMs)).toEqual([1000, 1000, 4000]);
      // The transcript's own line labels, copied into a quote, are not words of it.
      expect(result.requests[1].quote).toBe('the bar is uploading, it should be one colour.');
      expect(result.rejected.map(r => r.reason)).toEqual(['the quote is not on line 1 or any other']);
    });

    it('prefers the line the quote fits exactly over one it fits only by skipping words', () => {
      // Line 2 ends "...the deck" and line 3 is "The deck is too small": starting on line 2 fits only by skipping.
      expect(groundRequests([ask(2, 'the deck is too small')], lines)).toMatchObject({ moved: 0, rejected: [{ reason: 'the quote is not on line 2 and is on 2 other lines' }] });
      expect(groundRequests([ask(3, 'the deck is too small')], lines)).toMatchObject({ moved: 0, requests: [{ atMs: 40_000 }] });
    });

    it('moves a request whose quote is on exactly one other line, and sorts by line', () => {
      expect(groundRequests([ask(3, 'hide the title'), ask(9, 'make the button red')], lines)).toMatchObject({ moved: 2, rejected: [], requests: [{ atMs: 10_000 }, { atMs: 30_000 }] });
    });

    it('rejects, with the reason, a quote on no line, an ambiguous one, a part word and an empty or overlong request, keeping the rest', () => {
      const result = groundRequests([
        ask(1, 'make the button blue'), ask(1, 'the deck is too small'), ask(2, 'duce the deck'),
        ask(1, 'make the button red', ' '), ask(1, 'make the button red', 'x'.repeat(301)), ask(1, '...'), ask(1, 'make the button red', 'Do it', 'praise'),
        ask(3, 'The deck is too small', 'Do it', ' Problem'),
      ], lines);
      expect(result.requests).toEqual([{ atMs: 40_000, text: 'Do it', kind: 'problem', quote: 'The deck is too small' }]);
      expect(result.rejected.map(r => r.reason)).toEqual([
        'the quote is not on line 1 or any other', 'the quote is not on line 1 and is on 2 other lines', 'the quote is not on line 2 or any other',
        'the request is empty', 'the request is 301 characters', 'no quote', 'the kind "praise" is not change, problem, idea, question',
      ]);
      expect(result.rejected[0]).toEqual({ line: 1, quote: 'make the button blue', kind: 'change', text: 'Do it', reason: 'the quote is not on line 1 or any other' });
    });
  });
});

describe('pointing pass', () => {
  it('asks Claude what each pointing frame shows, with the frame and the line, and keeps its answer', async () => {
    const claude = await fakeClaude(body => {
      const content = (body.messages as { content: { type: string; text?: string }[] }[])[0].content;
      const line = content.find(c => c.type === 'text')?.text ?? '';
      return { status: 200, body: claudeMessage(JSON.stringify(line.includes('these') ? { target: 'unclear', sure: true } : { target: 'the TRY label on the CAP-1 row.', sure: true })) };
    });
    const cli = await testCli({ POLYCAP_POINTING: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const dir = await mkdtemp(join(tmpdir(), 'pointing-'));
    await mkdir(join(dir, 'frames', 'full'), { recursive: true });
    await writeFile(join(dir, 'frames', 'full', '0001_00m02s.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(join(dir, 'frames', '0002_00m05s.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const { resolvePointing } = await import('../src/pipeline/pointing.js');
    const named = await resolvePointing(cli.config, dir, [
      { file: '0001_00m02s.jpg', atMs: 2000, reason: 'pointing', word: 'this', full: 'full/0001_00m02s.jpg' },
      { file: '0002_00m05s.jpg', atMs: 5000, reason: 'pointing', word: 'these' },
      { file: '0003_00m09s.jpg', atMs: 9000, reason: 'segment' },
    ], [{ startMs: 1000, endMs: 3000, text: 'This try button is unclear.' }, { startMs: 4000, endMs: 6000, text: 'And these.' }]);
    claude.close();
    expect(named).toEqual({ model: 'claude-haiku-4-5', frames: [
      { file: '0001_00m02s.jpg', atMs: 2000, word: 'this', target: 'the TRY label on the CAP-1 row', sure: true },
      { file: '0002_00m05s.jpg', atMs: 5000, word: 'these', target: 'unclear', sure: false },
    ] });
    expect(claude.calls).toHaveLength(2);
    const first = (claude.calls[0].body.messages as { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }[])[0].content;
    expect(first[0]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') } });
    expect(first[1].text).toBe('<line>This try button is unclear.</line>\nThey point as they say "this".');
    expect(claude.calls[0].body.model).toBe('claude-haiku-4-5');
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('hosted receiver end to end', () => {
  const upload = newToken(), other = newToken(), read = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: upload.sha256, scopes: ['upload'] },
    { id: 'quest-old', sha256: other.sha256, scopes: ['upload'] },
    { id: 'mac', sha256: read.sha256, scopes: ['read'] },
  ]);
  let base: string; let close: () => Promise<void>; let video: Buffer; let sha: string;
  let server: Awaited<ReturnType<typeof testCli>>;

  beforeAll(async () => {
    // Session ids are local time; pin the zone so CI (UTC) names the bundle the same as this Mac.
    process.env.TZ = 'Europe/London';
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none', POLYCAP_MAX_FRAMES: '4' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    const file = join(await mkdtemp(join(tmpdir(), 'receiver-video-')), '20261001-161948.mp4');
    await makeVideo(file, 4);
    video = await readFile(file);
    sha = createHash('sha256').update(video).digest('hex');
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, unknown> };
  };
  const createBody = () => ({ clientId: 'quest3-20261001-161948', bytes: video.length, sha256: sha, fileName: '20261001-161948.mp4', recordedAt: '2026-10-01T16:19:48+01:00', appPackage: 'net.polydance.capture', device: { model: 'Quest 3', sdk: 34 }, app: { versionName: '0.3.0', versionCode: 3, commit: 'e4d58b2' }, audioTracks: ['mic'], apps: [{ atMs: 0, package: 'net.polydance.capture', label: 'Polydance Capture', versionName: '0.4.0', versionCode: 4 }, { atMs: 2100, package: 'com.example.marimba', label: 'Marimba Studio' }] });
  const putChunk = (id: string, start: number, end: number, token = upload.token) =>
    call('PUT', `/v1/uploads/${id}/content`, token, video.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${video.length}`, 'content-type': 'application/octet-stream' });

  /** Sends the header for a whole chunk, writes only part of it, then drops the connection. */
  const cutChunk = (id: string, start: number, end: number, sendBytes: number) => new Promise<void>(done => {
    const req = request(`${base}/v1/uploads/${id}/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${upload.token}`, 'content-range': `bytes ${start}-${end}/${video.length}`, 'content-length': end - start + 1 },
    });
    req.on('error', () => done()); req.on('response', (res: IncomingMessage) => { res.resume(); done(); });
    req.write(video.subarray(start, start + sendBytes), () => setTimeout(() => { req.destroy(); setTimeout(done, 100); }, 50));
  });

  it('refuses requests without the right token or scope', async () => {
    expect((await call('GET', '/v1/health')).json).toMatchObject({ ok: true });
    expect((await call('GET', '/v1/sessions')).status).toBe(401);
    expect((await call('GET', '/v1/sessions', 'polycap_' + 'f'.repeat(64))).status).toBe(401);
    expect((await call('GET', '/v1/sessions', upload.token)).status).toBe(403);
    expect((await call('POST', '/v1/uploads', read.token, createBody())).status).toBe(403);
    expect((await call('POST', '/v1/uploads', upload.token, { ...createBody(), fileName: '../x.mp4' })).status).toBe(400);
    expect((await call('POST', '/v1/uploads', upload.token, { ...createBody(), app: { versionName: '0.3.0', commit: 'HEAD; rm -rf' } })).status).toBe(400);
    expect((await call('POST', '/v1/uploads', upload.token, { ...createBody(), audioTracks: ['narration'] })).status).toBe(400);
    expect((await call('POST', '/v1/uploads', upload.token, { ...createBody(), apps: [{ atMs: 0, package: 'not a package; rm' }] })).status).toBe(400);
  });

  it('takes a chunked upload that is cut off, resumes it, verifies it and builds the bundle', async () => {
    const created = await call('POST', '/v1/uploads', upload.token, createBody());
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ received: 0, status: 'uploading' });
    // Retrying the create returns the same upload; the same client id with other bytes is a conflict.
    expect((await call('POST', '/v1/uploads', upload.token, createBody())).json).toMatchObject({ id, received: 0 });
    expect((await call('POST', '/v1/uploads', upload.token, { ...createBody(), sha256: '0'.repeat(64) })).status).toBe(409);
    // Another upload token cannot see or write it.
    expect((await call('GET', `/v1/uploads/${id}`, other.token)).status).toBe(404);
    expect((await putChunk(id, 0, 99, other.token)).status).toBe(404);

    const third = Math.floor(video.length / 3);
    expect((await putChunk(id, 0, third - 1)).json).toMatchObject({ received: third, status: 'uploading' });
    await cutChunk(id, third, 2 * third - 1, 1000);
    const after = await call('GET', `/v1/uploads/${id}`, upload.token);
    expect(after.json.received).toBe(third + 1000);
    const wrong = await putChunk(id, third, 2 * third - 1);
    expect(wrong.status).toBe(409);
    expect(wrong.json).toMatchObject({ received: third + 1000 });
    expect((await putChunk(id, third + 1000, video.length - 1)).json).toMatchObject({ received: video.length, status: 'received' });

    for (let i = 0; i < 100; i++) {
      const status = (await call('GET', `/v1/uploads/${id}`, upload.token)).json;
      if (status.status === 'ready' || status.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const done = (await call('GET', `/v1/uploads?clientId=quest3-20261001-161948`, upload.token)).json.uploads as Record<string, unknown>[];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id, status: 'ready', sessionId: '2026-10-01T16-19-48_capture' });
    expect(done[0].error).toBeUndefined();
    const manifest = await loadSession(join(server.config.sessions, '2026-10-01T16-19-48_capture'));
    expect(manifest.source).toMatchObject({ kind: 'upload', uploadId: id, clientId: 'quest3-20261001-161948', deviceModel: 'Quest 3', sha256: sha, bytes: video.length, appBuild: { versionName: '0.3.0', versionCode: 3, commit: 'e4d58b2' }, audioTracks: ['mic'], apps: [{ atMs: 0, package: 'net.polydance.capture', label: 'Polydance Capture', versionName: '0.4.0', versionCode: 4 }, { atMs: 2100, package: 'com.example.marimba', label: 'Marimba Studio' }] });
    expect(manifest.steps).toMatchObject({ probe: { status: 'done' }, frames: { status: 'done' }, pointing: { status: 'skipped', note: 'POLYCAP_POINTING is none' }, transcribe: { status: 'skipped' }, summary: { status: 'skipped', note: 'summarizer is none' }, storyboard: { status: 'done' } });
    const storyboard = await readFile(join(server.config.sessions, '2026-10-01T16-19-48_capture', 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('Quest 3 · net.polydance.capture 0.3.0 (3) e4d58b2');
    expect(storyboard).toContain('No transcript (transcribe step: skipped), so frames are at a fixed interval.');
    expect(manifest.summary).toBeUndefined();
    // The upload folder no longer holds a second name for the video.
    expect(await readdir(join(server.config.uploads, id))).toEqual(['meta.json']);
    // Once the bundle has a summary (here written as `process --step summary` would), the headset's status poll carries it.
    const dir = join(server.config.sessions, '2026-10-01T16-19-48_capture');
    await saveSession(dir, { ...manifest, title: 'Deck test', summary: { title: 'Deck test', text: 'A short test of the deck.', model: 'claude-haiku-4-5' } });
    expect((await call('GET', `/v1/uploads?clientId=quest3-20261001-161948`, upload.token)).json.uploads).toEqual([expect.objectContaining({ id, title: 'Deck test', summary: 'A short test of the deck.' })]);
    expect((await call('GET', `/v1/uploads/${id}`, upload.token)).json).toMatchObject({ title: 'Deck test', summary: 'A short test of the deck.', steps: { done: 10, total: 10 } });
    // While a bundle is half built the headset sees how far it has got.
    await saveSession(dir, { ...manifest, steps: { ...manifest.steps, frames: { status: 'pending' }, pointing: { status: 'pending' }, markers: { status: 'pending' }, summary: { status: 'pending' }, storyboard: { status: 'pending' } } });
    expect((await call('GET', `/v1/uploads/${id}`, upload.token)).json).toMatchObject({ steps: { done: 5, total: 10 } });
    await saveSession(dir, { ...manifest, title: 'Deck test', summary: { title: 'Deck test', text: 'A short test of the deck.', model: 'claude-haiku-4-5' } });
  });

  it('serves bundle files to a read token and nothing outside the bundle', async () => {
    const sessions = (await call('GET', '/v1/sessions', read.token)).json.sessions as Record<string, unknown>[];
    expect(sessions).toEqual([expect.objectContaining({ id: '2026-10-01T16-19-48_capture', title: 'Deck test', summary: 'A short test of the deck.', ready: true })]);
    const files = (await call('GET', '/v1/sessions/2026-10-01T16-19-48_capture/files', read.token)).json.files as { path: string }[];
    expect(files.map(f => f.path)).toEqual(expect.arrayContaining(['session.json', 'video.mp4', 'contact-sheet.jpg', 'frames.json']));
    for (const bad of ['/v1/sessions/2026-10-01T16-19-48_capture/files/..%2F..%2Fuploads', '/v1/sessions/..%2Fuploads/files', '/v1/sessions/2026-10-01T16-19-48_capture/files/%2e%2e/session.json']) {
      expect((await call('GET', bad, read.token)).status).toBe(404);
    }
  });

  it('syncs ready bundles into another library, verified, without the video unless asked', async () => {
    const mac = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: read.token });
    const first = await sync(mac, { video: false, dryRun: false });
    expect(first.downloaded).toEqual(['2026-10-01T16-19-48_capture']);
    const dir = join(mac.config.sessions, '2026-10-01T16-19-48_capture');
    expect((await loadSession(dir)).source.uploadId).toMatch(/^up_/);
    expect(await readdir(dir)).not.toContain('video.mp4');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await sync(mac, { video: false, dryRun: false })).current).toEqual(['2026-10-01T16-19-48_capture']);
    expect((await sync(mac, { video: true, dryRun: false })).downloaded).toEqual(['2026-10-01T16-19-48_capture']);
    expect(createHash('sha256').update(await readFile(join(dir, 'video.mp4'))).digest('hex')).toBe(sha);
    // The staging folder is gone and never looked like a session.
    expect(await readdir(mac.config.sessions)).toEqual(['2026-10-01T16-19-48_capture']);
    // The same recording synced from another receiver (other upload id, same bytes) is updated, not refused;
    // a different recording under the same id is never overwritten.
    const manifestPath = join(dir, 'session.json');
    const original = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, original.replace(/"uploadId": "up_[0-9a-f]+"/, '"uploadId": "up_0000000000000000"'));
    await writeFile(join(dir, 'frames', '0098_09m98s.jpg'), 'from the other receiver');
    expect((await sync(mac, { video: false, dryRun: false })).skipped).toEqual([]);
    expect((await loadSession(dir)).source.uploadId).not.toBe('up_0000000000000000');
    await writeFile(manifestPath, original.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'b'.repeat(64)}"`).replace(/"uploadId": "up_[0-9a-f]+"/, '"uploadId": "up_1111111111111111"'));
    expect((await sync(mac, { video: false, dryRun: false })).skipped).toEqual(['2026-10-01T16-19-48_capture']);
    await writeFile(manifestPath, original);
    // A file the server no longer has (old frames after reprocessing) goes; the downloaded video stays.
    await writeFile(join(dir, 'frames', '0099_09m99s.jpg'), 'stale');
    const pruned = await sync(mac, { video: false, dryRun: false });
    expect(pruned.pruned).toEqual(['2026-10-01T16-19-48_capture']);
    expect(await readdir(join(dir, 'frames'))).not.toContain('0099_09m99s.jpg');
    expect(await readdir(dir)).toContain('video.mp4');
  });

  it('fetches one session\'s video from the receiver, verified, and cuts a clip from it', async () => {
    const mac = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: read.token });
    await sync(mac, { video: false, dryRun: false });
    const [id] = await readdir(mac.config.sessions);
    expect(await readdir(join(mac.config.sessions, id))).not.toContain('video.mp4');
    const path = await fetchVideo(mac, id);
    expect(mac.lines.at(-1)).toMatch(/downloaded from the receiver/);
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(sha);
    await fetchVideo(mac, id);
    expect(mac.lines.at(-1)).not.toMatch(/downloaded/);
    const clip = await exportCommand(mac, id, 'video', { sound: 'none', from: '0:01', to: '0:02' });
    expect(JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', clip])).stdout).streams).toEqual([{ codec_type: 'video' }]);
  });

  it('renders an exact frame through the receiver when the video is not here', async () => {
    const mac = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: read.token });
    await sync(mac, { video: false, dryRun: false });
    await frames(mac, '2026-10-01T16-19-48_capture', { at: '2', exact: true, width: '640' });
    const out = mac.lines.at(-1)!.split('\t')[0];
    expect(out).toContain(join('cache', 'frames', '2026-10-01T16-19-48_capture'));
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', out]);
    expect(stdout.trim()).toBe('640');
    // A second ask is served from the cache, and the server refuses nonsense and the wrong scope.
    await frames(mac, '2026-10-01T16-19-48_capture', { at: '2', exact: true, width: '640' });
    expect(mac.lines.at(-1)!.split('\t')[0]).toBe(out);
    const id = '2026-10-01T16-19-48_capture';
    expect((await call('GET', `/v1/sessions/${id}/frame?at=999`, read.token)).status).toBe(400);
    expect((await call('GET', `/v1/sessions/${id}/frame?at=1&width=10`, read.token)).status).toBe(400);
    expect((await call('GET', `/v1/sessions/${id}/frame?at=1`, upload.token)).status).toBe(403);
    await expect(frames(mac, id, { exact: true })).rejects.toThrow(/--exact needs --at/);
  });

  it('rejects a completed upload whose bytes do not match, and starts it over', async () => {
    const body = { ...createBody(), clientId: 'quest3-corrupt', sha256: 'a'.repeat(64) };
    const id = (await call('POST', '/v1/uploads', upload.token, body)).json.id as string;
    const result = await putChunk(id, 0, video.length - 1);
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ received: 0, status: 'uploading' });
  });
});

(ffmpeg ? describe : describe.skip)('receiver storage: allowance, delete everywhere, safety net', () => {
  const quest = newToken(), other = newToken(), mac = newToken(), ana = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'] },
    { id: 'quest-b', sha256: other.sha256, scopes: ['upload'] },
    { id: 'mac', sha256: mac.sha256, scopes: ['read'] },
    // Someone outside the team: thread-scoped, so the member allowance and kept days apply (2026-11-12).
    { id: 'ana-quest', sha256: ana.sha256, scopes: ['upload'], user: 'ana', threads: 'member' },
  ]);
  const users = JSON.stringify([{ id: 'ana', name: 'Ana' }]);
  let video: Buffer; let sha: string;
  beforeAll(async () => {
    process.env.TZ = 'Europe/London';
    const file = join(await mkdtemp(join(tmpdir(), 'storage-video-')), 'clip.mp4');
    await makeVideo(file, 3);
    video = await readFile(file);
    sha = createHash('sha256').update(video).digest('hex');
  });

  async function start(env: Record<string, string>) {
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none', POLYCAP_MAX_FRAMES: '3', ...env });
    const running = await serve(cli, { host: '127.0.0.1', port: 0, tokens, users });
    const base = `http://127.0.0.1:${running.port}`;
    const call = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, {
        method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
      });
      return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, unknown> };
    };
    /** Uploads the clip under a client id and waits until the worker has finished with it. */
    const upload = async (clientId: string, recordedAt: string, token = quest.token) => {
      const created = await call('POST', '/v1/uploads', token, { clientId, bytes: video.length, sha256: sha, fileName: `${clientId}.mp4`, recordedAt });
      if (created.status >= 300) return created;
      const id = created.json.id as string;
      await call('PUT', `/v1/uploads/${id}/content`, token, video, { 'content-range': `bytes 0-${video.length - 1}/${video.length}`, 'content-type': 'application/octet-stream' });
      for (let i = 0; i < 100; i++) {
        const s = (await call('GET', `/v1/uploads/${id}`, token)).json;
        if (s.status === 'ready' || s.status === 'failed') break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { status: 201, json: { id } };
    };
    return { cli, call, upload, close: running.close };
  }

  it('refuses an upload past the allowance and frees space when a recording is deleted everywhere', async () => {
    const server = await start({ POLYCAP_ALLOWANCE_BYTES: String(Math.floor(video.length * 1.5)) });
    try {
      expect((await server.call('GET', '/v1/account', quest.token)).json).toMatchObject({ grantId: 'quest3', usedBytes: 0, recordings: 0 });
      const first = await server.upload('quest3-a', '2026-10-01T10:00:00+01:00');
      const id = first.json.id as string;
      expect((await server.call('GET', '/v1/account', quest.token)).json).toMatchObject({ usedBytes: video.length, recordings: 1 });
      const refused = await server.upload('quest3-b', '2026-10-01T10:05:00+01:00');
      expect(refused.status).toBe(507);
      expect(refused.json).toMatchObject({ error: expect.stringMatching(/storage full/), usedBytes: video.length });

      expect((await server.call('DELETE', `/v1/uploads/${id}`, other.token)).status).toBe(404);
      expect((await server.call('DELETE', `/v1/uploads/${id}`, mac.token)).status).toBe(403);
      const gone = await server.call('DELETE', `/v1/uploads/${id}`, quest.token);
      expect(gone.json).toMatchObject({ status: 'deleted', deletedReason: 'user', received: 0 });
      expect((await server.call('DELETE', `/v1/uploads/${id}`, quest.token)).json).toMatchObject({ status: 'deleted' });
      expect(await readdir(server.cli.config.sessions)).toEqual([]);
      expect((await server.call('GET', '/v1/sessions', mac.token)).json.sessions).toEqual([]);
      expect((await server.call('GET', '/v1/account', quest.token)).json).toMatchObject({ usedBytes: 0, recordings: 0 });
      expect((await server.upload('quest3-b', '2026-10-01T10:05:00+01:00')).status).toBe(201);

      // An upload that stopped a day ago no longer counts once the next check runs.
      const stale = await server.call('POST', '/v1/uploads', quest.token, { clientId: 'quest3-stale', bytes: 10, sha256: 'c'.repeat(64), fileName: 'stale.mp4' });
      const staleId = stale.json.id as string;
      const meta = join(server.cli.config.uploads, staleId, 'meta.json');
      await writeFile(meta, (await readFile(meta, 'utf8')).replace(/"createdAt": "[^"]+"/, '"createdAt": "2026-09-29T10:00:00.000Z"'));
      const { enforceServerLimit } = await import('../src/server/storage.js');
      const { UploadStore } = await import('../src/server/uploads.js');
      await enforceServerLimit(server.cli.config, new UploadStore(server.cli.config.uploads), () => {});
      expect((await server.call('GET', `/v1/uploads/${staleId}`, quest.token)).json).toMatchObject({ status: 'deleted', deletedReason: 'abandoned upload' });
    } finally { await server.close(); }
  });

  it('gives someone outside the team a smaller allowance, and deletes only their video once its kept days run out (2026-11-12)', async () => {
    const server = await start({ POLYCAP_MEMBER_ALLOWANCE_BYTES: String(Math.floor(video.length * 1.5)), POLYCAP_MEMBER_VIDEO_DAYS: '30' });
    try {
      const { expireVideos, enforceServerLimit } = await import('../src/server/storage.js');
      const { playbackView } = await import('../src/server/playback.js');
      const store = new UploadStore(server.cli.config.uploads);
      const meta = (id: string) => join(server.cli.config.uploads, id, 'meta.json');
      const backdate = async (id: string, days: number) => writeFile(meta(id), (await readFile(meta(id), 'utf8'))
        .replace(/"createdAt": "[^"]+"/, `"createdAt": "${new Date(Date.now() - days * 864e5).toISOString()}"`));

      // The member allowance is Ana's; the team's own upload token keeps the default.
      expect((await server.call('GET', '/v1/account', ana.token)).json).toMatchObject({ allowanceBytes: Math.floor(video.length * 1.5) });
      expect((await server.call('GET', '/v1/account', quest.token)).json).toMatchObject({ allowanceBytes: 8 * 1000 ** 3 });
      const hers = (await server.upload('ana-a', '2026-11-12T10:00:00Z', ana.token)).json.id as string;
      const ours = (await server.upload('quest3-a', '2026-11-12T10:05:00Z')).json.id as string;
      expect((await store.get(hers))?.keepVideoDays).toBe(30);
      expect((await store.get(ours))?.keepVideoDays).toBeUndefined();
      expect((await server.upload('ana-b', '2026-11-12T10:10:00Z', ana.token)).status).toBe(507);

      // 29 days on, nothing goes; 31 days on, only Ana's video, while the team's recording of the same age stays whole.
      await backdate(hers, 29); await backdate(ours, 31);
      expect(await expireVideos(server.cli.config, store, () => {})).toEqual([]);
      await backdate(hers, 31);
      const lines: string[] = [];
      expect(await expireVideos(server.cli.config, store, line => lines.push(line))).toEqual([hers]);
      expect(lines.join('\n')).toMatch(/video kept 30 day\(s\): deleted the video of up_/);
      const record = (await store.get(hers))!;
      const dir = join(server.cli.config.sessions, record.sessionId!);
      const left = await readdir(dir);
      expect(left).not.toContain('video.mp4');
      // Transcription is off here, so the bundle is frames, markers and the storyboard; with it on, its words stay too.
      expect(left).toEqual(expect.arrayContaining(['session.json', 'frames', 'frames.json', 'contact-sheet.jpg', 'storyboard.md']));
      expect(await readdir(join(server.cli.config.sessions, (await store.get(ours))!.sessionId!))).toContain('video.mp4');
      expect((await server.call('GET', `/v1/uploads/${hers}`, ana.token)).json).toMatchObject({ status: 'ready', videoDeletedAt: record.videoDeletedAt });
      // Once only once, and the room it took is free again.
      expect(await expireVideos(server.cli.config, store, () => {})).toEqual([]);
      expect((await server.call('GET', '/v1/account', ana.token)).json).toMatchObject({ usedBytes: 0, recordings: 1 });
      expect((await server.upload('ana-b', '2026-11-12T10:10:00Z', ana.token)).status).toBe(201);

      // The player is told the video went, not that it is still on its way.
      const view = await playbackView(dir, await loadSession(dir), record, { key: 'CAP-1', message: 1 }) as { video: object };
      expect(view.video).toEqual({ available: false, deletedAt: record.videoDeletedAt, keptDays: 30 });
      // The safety net never takes a bundle whose video is already gone.
      server.cli.config.storageHighBytes = 1; server.cli.config.storageLowBytes = 0;
      await enforceServerLimit(server.cli.config, store, () => {});
      expect((await store.get(hers))?.status).toBe('ready');
    } finally { await server.close(); }
  });

  it('deletes the oldest finished recordings when the whole server passes its safety limit', async () => {
    const server = await start({
      POLYCAP_STORAGE_HIGH_BYTES: String(Math.floor(video.length * 1.5)),
      POLYCAP_STORAGE_LOW_BYTES: String(Math.floor(video.length * 1.2)),
    });
    try {
      const older = (await server.upload('quest3-old', '2026-10-01T09:00:00+01:00')).json.id as string;
      await new Promise(r => setTimeout(r, 20));
      const newer = (await server.upload('quest3-new', '2026-10-01T11:00:00+01:00')).json.id as string;
      // The worker marks an upload ready and then runs the safety net, so wait for that to land.
      for (let i = 0; i < 50 && (await server.call('GET', `/v1/uploads/${older}`, quest.token)).json.status !== 'deleted'; i++) await new Promise(r => setTimeout(r, 100));
      expect((await server.call('GET', `/v1/uploads/${older}`, quest.token)).json).toMatchObject({ status: 'deleted', deletedReason: 'server storage limit' });
      expect((await server.call('GET', `/v1/uploads/${newer}`, quest.token)).json).toMatchObject({ status: 'ready' });
      expect(await readdir(server.cli.config.sessions)).toEqual(['2026-10-01T11-00-00_recording']);
      expect((await server.call('GET', '/v1/account', mac.token)).json).toMatchObject({ usedBytes: video.length, recordings: 1 });
    } finally { await server.close(); }
  });
});
