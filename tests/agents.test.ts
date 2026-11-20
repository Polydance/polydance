/**
 * Connecting your own agent (docs/THREADS.md, 2026-11-20): someone signed in on a headset asks for a code, and
 * `polycap connect` redeems it for a token that is the same person as the headset. Shaped like the live
 * receiver's newcomers: Meta sign-ins mapped to nobody, START for their recordings, a Welcome each. The test
 * that matters most is the second newcomer's agent, which must reach nothing of the first's: every answer it
 * gets is searched for what the first one's threads and recordings hold. Bundles are written as the worker
 * leaves them: no ffmpeg, no network beyond this machine.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../src/commands/connect.js';
import { serve } from '../src/commands/serve.js';
import { sync } from '../src/commands/sync.js';
import { projectEdit, projectNew } from '../src/commands/thread.js';
import { readEnvFile } from '../src/config.js';
import { CODE, normalCode } from '../src/pairing.js';
import { AGENT_LIMITS, Agents } from '../src/server/agents.js';
import { CONSENT_VERSION } from '../src/server/privacy.js';
import { expired, newToken, type Grant } from '../src/server/tokens.js';
import { UploadStore } from '../src/server/uploads.js';
import { saveSession, sessionDir, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { testCli, type TestCli } from './helpers/cli.js';
import { makePng } from './helpers/photos.js';

const APP_ID = '1300818073125870';
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', hosts: ['team.example'] }, { key: 'CAP', name: 'Polydance Capture' },
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

describe('a newcomer connects their own agent with a code from the headset (2026-11-20)', () => {
  const mac = newToken(), quest = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'robin' },
  ]);
  const png = makePng(6, 4);
  let base: string; let close: () => Promise<void>; let meta: Awaited<ReturnType<typeof standInMeta>>;
  let server: TestCli; let uploads: UploadStore;
  let clients = 0;
  /** Every answer the second newcomer's agent got. */
  const heard: string[] = [];
  let listening: string | undefined;

  const start = async (testers: object = { projects: ['START'] }) => {
    const running = await serve(server, {
      host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, reports: 'CAP',
      welcome: JSON.stringify({ project: 'START', url: 'https://receiver.example/start' }),
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify(testers) },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  };

  beforeAll(async () => {
    meta = await standInMeta();
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    await start();
    uploads = new UploadStore(server.config.uploads);
  });
  afterAll(async () => { await close?.(); await meta?.close(); });

  const call = async (method: string, path: string, token: string | undefined, body?: unknown, type?: string) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': type ?? 'application/json' } : {}) },
    });
    const raw = await response.text();
    if (token !== undefined && token === listening) heard.push(raw);
    let json: Record<string, any> = {};
    try { json = JSON.parse(raw); } catch { /* a video */ }
    return { status: response.status, json, raw };
  };

  const signIn = async (userId: string, deviceId: string, name: string) => {
    const signed = await call('POST', '/v1/testers/meta', undefined, { userId, nonce: `n-${deviceId}`, deviceId, name, label: 'Quest 3' });
    expect([signed.status, signed.json.grantId]).toEqual([201, `meta-${userId}`]);
    return signed.json.token as string;
  };

  /** A recording sent with `token`, built as the worker leaves it: its own title, summary and video. */
  const record = async (token: string, thread: unknown, words: string) => {
    const created = await call('POST', '/v1/uploads', token, {
      clientId: `r${++clients}`, bytes: VIDEO.length, sha256: createHash('sha256').update(`r${clients}`).digest('hex'), fileName: 'clip.mp4',
      recordedAt: '2026-11-20T10:00:00Z', audioTracks: ['mic'], consent: CONSENT_VERSION, thread,
    });
    expect([words, created.status]).toEqual([words, 201]);
    const stored = (await uploads.get(created.json.id))!;
    const id = `2026-11-20T10-00-${String(clients).padStart(2, '0')}_capture`;
    const dir = sessionDir(server.config, id);
    await saveSession(dir, {
      version: 1, id, title: words, createdAt: new Date().toISOString(), recordedAt: '2026-11-20T10:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId: stored.id, clientId: stored.clientId, originalName: 'clip.mp4', bytes: VIDEO.length, sha256: 'a'.repeat(64), audioTracks: ['mic'] },
      media: { video: 'video.mp4', durationMs: 2000 }, steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      summary: { title: words, text: `${words}, in a sentence`, model: 'stand-in' },
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
    });
    await writeFile(join(dir, 'video.mp4'), VIDEO, { mode: 0o600 });
    await uploads.update(stored.id, { status: 'ready', sessionId: id });
    return { key: stored.threadKey!, message: stored.threadMessage!, uploadId: stored.id, sessionId: id };
  };

  /** What a person does: asks their device for a code, then types it into `polycap connect` on a machine with no settings yet. */
  const pair = async (device: string, label = 'Mac') => {
    const asked = await call('POST', '/v1/agents/codes', device);
    expect(asked.status).toBe(201);
    expect(normalCode(asked.json.code)).toMatch(CODE);
    const cli = await testCli();
    const file = join(await mkdtemp(join(tmpdir(), 'polycap-settings-')), 'polycap', 'env');
    await connect(cli, asked.json.code.toLowerCase(), { url: base, label, configFile: file, env: {} });
    const kept = readEnvFile(file);
    return { token: kept.POLYCAP_REMOTE_TOKEN, url: kept.POLYCAP_REMOTE_URL, file, lines: cli.lines, code: asked.json.code as string };
  };
  /** polycap on the agent's machine, with the token `connect` wrote. */
  const agentCli = (token: string) => testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: token });

  let ana: string, anaAgent: Awaited<ReturnType<typeof pair>>;
  let teamThread: string, teamTake: Awaited<ReturnType<typeof record>>, report: Awaited<ReturnType<typeof record>>;
  let welcomeTake: Awaited<ReturnType<typeof record>>, replyTake: Awaited<ReturnType<typeof record>>;

  it('pairs, syncs the newcomer\'s bundle and posts a launch their headset sees', async () => {
    // The team's own work, which no newcomer's agent may reach.
    const team = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Team walkthrough plans', text: 'Which chair?' });
    teamThread = team.json.key;
    teamTake = await record(quest.token, { key: teamThread }, 'Robin hidden walkthrough');
    report = await record(quest.token, { report: true }, 'Robin bug report take');

    // Ana signs in, finds her Welcome and records into it.
    ana = await signIn('2001', 'a1b2c3d4', 'Ana Newcomer');
    welcomeTake = await record(ana, { key: 'START-1' }, 'Ana looks round the start page');

    // Her inbox says this receiver connects agents, which is what makes the headset offer it.
    expect((await call('GET', '/v1/threads', ana)).json.agents).toBe(true);
    // She asks the headset for a code and types it on her computer. The token is kept, never printed.
    anaAgent = await pair(ana);
    expect(anaAgent.token).toMatch(/^polycap_[0-9a-f]{64}$/);
    expect(anaAgent.url).toBe(base);
    expect((await stat(anaAgent.file)).mode & 0o777).toBe(0o600);
    expect(anaAgent.lines.join('\n')).toMatch(/Connected to .* as Ana Newcomer · Mac \(paired-[0-9a-f]{8}\)/);
    expect(anaAgent.lines.join('\n')).not.toContain(anaAgent.token);
    // The receiver keeps its sha256 alone, in a private file.
    const kept = join(server.config.root, 'agents.json');
    expect((await stat(kept)).mode & 0o777).toBe(0o600);
    expect(await readFile(kept, 'utf8')).not.toContain(anaAgent.token);

    // The agent is the same person as the headset, with read and post, and no team project.
    const me = await call('GET', '/v1/me', anaAgent.token);
    expect([me.status, me.json.person.id, me.json.person.name, me.json.device]).toEqual([200, 'meta-2001', 'Ana Newcomer', 'Mac']);
    expect(me.json.me).toMatch(/^paired-[0-9a-f]{8}$/);
    const projects = await call('GET', '/v1/projects', anaAgent.token);
    expect(projects.json.projects).toEqual([]);
    expect(projects.json.capabilities).toEqual(expect.arrayContaining(['agents-v1', 'projects-edit-v1']));

    // It syncs her bundle and nothing of the team's.
    const cli = await agentCli(anaAgent.token);
    const synced = await sync({ ...cli, print: () => {} }, { video: false, dryRun: false });
    expect(synced.downloaded).toEqual([welcomeTake.sessionId]);
    expect(JSON.parse(await readFile(join(sessionDir(cli.config, welcomeTake.sessionId), 'session.json'), 'utf8')).title).toBe('Ana looks round the start page');

    // It makes her a project and posts a build there; her headset sees the thread and its launch.
    expect(await projectNew(cli, 'Marimba game', { key: 'MARI', hosts: ['marimba.example.com'], packages: [] })).toBe('MARI');
    const build = await call('POST', '/v1/threads', anaAgent.token, { project: 'MARI', title: 'Is the menu easier to find?', text: 'Build 1', as: 'Opus 5.5', launches: [{ steps: [{ do: 'open', url: 'https://marimba.example.com/build/1' }] }] });
    expect([build.status, build.json.key, build.json.by.display]).toEqual([201, 'MARI-1', 'Opus 5.5 on Ana Newcomer\'s Mac']);
    const inbox = await call('GET', '/v1/threads', ana);
    expect((inbox.json.threads as { key: string; waiting: boolean }[]).map(t => [t.key, t.waiting])).toEqual(expect.arrayContaining([['MARI-1', true], ['START-1', false]]));
    const seen = await call('GET', '/v1/threads/MARI-1', ana);
    expect(seen.json.messages[0].launches[0].steps[0].url).toBe('https://marimba.example.com/build/1');
    expect((await call('GET', '/v1/projects', ana)).json.projects).toEqual(expect.arrayContaining([{ key: 'MARI', name: 'Marimba game', mine: true }]));

    // She records her answer; the agent hears it, lists it and may play it.
    replyTake = await record(ana, { key: 'MARI-1', replyTo: { message: 1, launch: 0 } }, 'Ana tries build one');
    expect(((await call('GET', '/v1/sessions', anaAgent.token)).json.sessions as { id: string }[]).map(s => s.id).sort()).toEqual([welcomeTake.sessionId, replyTake.sessionId].sort());
    expect((await call('GET', `/v1/threads/MARI-1/messages/${replyTake.message}/playback`, anaAgent.token)).status).toBe(200);
    const feed = (await call('GET', '/v1/events?after=0', anaAgent.token)).json.events as { thread: string; kind: string }[];
    expect([...new Set(feed.map(e => e.thread))].sort()).toEqual(['MARI-1', 'START-1']);
    // It may answer in her Welcome, a team project's thread she is a member of.
    expect((await call('POST', '/v1/threads/START-1/messages', anaAgent.token, { text: 'Ana\'s agent says hello' })).status).toBe(201);
  });

  it('gives the agent nothing of the team\'s, and none of what belongs to a device', async () => {
    const t = anaAgent.token;
    // No team project: not to list, open a thread in, or read the hosts of.
    for (const project of ['START', 'MUS', 'CAP']) {
      expect([project, (await call('POST', '/v1/threads', t, { project, title: 'Not here', text: 'x' })).status]).toEqual([project, 404]);
      expect([project, (await call('GET', `/v1/projects/${project}`, t)).status]).toEqual([project, 404]);
      expect([project, (await call('POST', `/v1/projects/${project}/photos`, t, png, 'image/png')).status]).toEqual([project, 404]);
    }
    // The team's thread, its recording and a report are the 404 of a key nobody has used.
    const nowhere = (await call('GET', '/v1/threads/MUS-99', t)).json.error.replace('MUS-99', 'KEY');
    for (const take of [teamTake, report]) {
      const got = await call('GET', `/v1/threads/${take.key}`, t);
      expect([got.status, got.json.error?.replace(take.key, 'KEY')]).toEqual([404, nowhere]);
      expect((await call('POST', `/v1/threads/${take.key}/messages`, t, { text: 'x' })).status).toBe(404);
      for (const path of [`/v1/sessions/${take.sessionId}/files`, `/v1/sessions/${take.sessionId}/files/session.json`, `/v1/sessions/${take.sessionId}/frame?at=1`, `/v1/uploads/${take.uploadId}`]) {
        expect([path, (await call('GET', path, t)).status]).toEqual([path, 404]);
      }
    }
    // What only a device does: record, ask for a code, list or disconnect agents, change the person's address.
    expect((await call('POST', '/v1/uploads', t, { clientId: 'x1', bytes: 10, sha256: 'b'.repeat(64), fileName: 'clip.mp4', thread: { key: 'MARI-1' } })).status).toBe(403);
    expect((await call('POST', '/v1/agents/codes', t)).status).toBe(403);
    expect((await call('GET', '/v1/agents', t)).status).toBe(403);
    expect((await call('POST', '/v1/me', t, { email: 'someone@example.com' })).json).toMatchObject({ reason: 'agent' });
    expect((await call('GET', '/v1/me', ana)).json.person.email).toBeUndefined();
  });

  it('gives a second newcomer\'s agent a 404 for all of it', async () => {
    const ben = await signIn('2002', 'b2c3d4e5', 'Ben Other');
    const benAgent = await pair(ben, 'Linux');
    const t = benAgent.token;
    listening = t;
    expect((await call('GET', '/v1/me', t)).json.person.id).toBe('meta-2002');
    // His own: his Welcome, and nothing else.
    expect(((await call('GET', '/v1/threads', t)).json.threads as { key: string }[]).map(x => x.key)).toEqual(['START-2']);
    expect((await call('GET', '/v1/projects', t)).json.projects).toEqual([]);
    expect((await call('GET', '/v1/sessions', t)).json.sessions).toEqual([]);
    expect((await call('GET', '/v1/uploads', t)).json.uploads).toEqual([]);

    // Ana's threads: every route is the 404 a key nobody has used gets.
    const nowhere = (await call('GET', '/v1/threads/MARI-99', t)).json.error.replace('MARI-99', 'KEY');
    for (const { key, message } of [welcomeTake, replyTake]) {
      const got = await call('GET', `/v1/threads/${key}`, t);
      expect([got.status, got.json.error?.replace(key, 'KEY')]).toEqual([404, nowhere]);
      for (const [method, path, body] of [
        ['GET', `/v1/threads/${key}/messages/${message}/playback`], ['GET', `/v1/threads/${key}/messages/${message}/video`], ['HEAD', `/v1/threads/${key}/messages/${message}/video`],
        ['PATCH', `/v1/threads/${key}`, { state: 'closed' }], ['POST', `/v1/threads/${key}/state`, { state: 'closed' }], ['POST', `/v1/threads/${key}/title`, { title: 'Mine now' }],
        ['POST', `/v1/threads/${key}/read`, { seq: 1 }], ['POST', `/v1/threads/${key}/hide`], ['POST', `/v1/threads/${key}/unhide`],
        ['POST', `/v1/threads/${key}/reactions`, { message, reaction: 'heart' }], ['POST', `/v1/threads/${key}/picks`, { message: 1, launch: 0 }],
        ['POST', `/v1/threads/${key}/messages`, { text: 'Let me in' }], ['POST', `/v1/threads/${key}/photos`, png, 'image/png'],
        ['POST', `/v1/threads/${key}/participants`, { add: ['ben@example.com'] }], ['POST', `/v1/threads/${key}/members`, { add: ['meta-2002'] }],
      ] as const) expect([method, path, (await call(method, path, t, body, Buffer.isBuffer(body) ? 'image/png' : undefined)).status]).toEqual([method, path, 404]);
    }
    // Her bundles and uploads, by id.
    for (const { sessionId, uploadId } of [welcomeTake, replyTake]) {
      for (const path of [`/v1/sessions/${sessionId}/files`, `/v1/sessions/${sessionId}/files/session.json`, `/v1/sessions/${sessionId}/files/video.mp4`, `/v1/sessions/${sessionId}/frame?at=1`, `/v1/uploads/${uploadId}`]) {
        expect([path, (await call('GET', path, t)).status]).toEqual([path, 404]);
      }
    }
    // Her project: not to read, change, open a thread in or send a file to.
    for (const [method, path, body, type] of [
      ['GET', '/v1/projects/MARI'], ['POST', '/v1/projects/MARI', { hosts: ['ben.example.com'] }],
      ['POST', '/v1/threads', { project: 'MARI', title: 'Mine', text: 'x' }], ['POST', '/v1/projects/MARI/photos', png, 'image/png'],
      ['PUT', `/v1/projects/MARI/models/${'c'.repeat(64)}`, Buffer.from('glTF'), 'model/gltf-binary'],
    ] as const) expect([method, path, (await call(method, path, t, body, type)).status]).toEqual([method, path, 404]);
    expect((await call('POST', '/v1/projects', t, { key: 'MARI', name: 'Mine' })).status).toBe(409);
    // Her agent is not his to disconnect, from his own token or his headset.
    const anaId = (await call('GET', '/v1/me', anaAgent.token)).json.me as string;
    expect((await call('DELETE', `/v1/agents/${anaId}`, t)).status).toBe(404);
    expect((await call('DELETE', `/v1/agents/${anaId}`, ben)).status).toBe(404);
    expect((await call('GET', '/v1/agents', ben)).json.agents.map((a: { label: string }) => a.label)).toEqual(['Linux']);

    // Nothing of hers reaches his feed, even as it happens.
    const feed = (await call('GET', '/v1/events?after=0', t)).json.events as { thread: string }[];
    expect([...new Set(feed.map(e => e.thread))]).toEqual(['START-2']);
    const last = (await call('GET', '/v1/events', t)).json.last as number;
    const waiting = call('GET', `/v1/events?after=${last}&wait=2`, t);
    expect((await call('POST', '/v1/threads/MARI-1/messages', anaAgent.token, { text: 'Build 2 is up' })).status).toBe(201);
    expect((await waiting).json.events).toEqual([]);
    // His headset fares no better.
    expect((await call('GET', '/v1/threads/MARI-1', ben)).status).toBe(404);

    // Nothing he was answered holds anything of hers, or of the team's.
    listening = undefined;
    const all = heard.join('\n');
    expect(heard.length).toBeGreaterThan(40);
    for (const secret of ['Ana looks round the start page', 'Ana tries build one', 'Is the menu easier to find', 'Build 1', 'Build 2 is up', 'marimba.example.com', 'Marimba game', 'Ana Newcomer',
      'meta-2001', anaId, 'Robin hidden walkthrough', 'Team walkthrough plans', ...[welcomeTake, replyTake, teamTake, report].flatMap(r => [r.uploadId, r.sessionId])]) {
      expect([secret, all.includes(secret)]).toEqual([secret, false]);
    }
  });

  it('takes a code once, and says the same of a wrong, a used and a replaced one', async () => {
    const used = await call('POST', '/v1/agents', undefined, { code: anaAgent.code });
    const wrong = await call('POST', '/v1/agents', undefined, { code: '2222-2222' });
    expect([used.status, used.json.reason]).toEqual([404, 'no_code']);
    expect(wrong.raw).toBe(used.raw);
    expect((await call('POST', '/v1/agents', undefined, { code: 'not a code' })).status).toBe(400);
    expect((await call('POST', '/v1/agents', undefined, { code: anaAgent.code, token: 'x' })).status).toBe(400);
    // Asking again replaces the last one: only the newest works.
    const first = (await call('POST', '/v1/agents/codes', ana)).json.code as string;
    const second = (await call('POST', '/v1/agents/codes', ana)).json.code as string;
    expect((await call('POST', '/v1/agents', undefined, { code: first })).status).toBe(404);
    const made = await call('POST', '/v1/agents', undefined, { code: second, label: 'Second <b>Mac</b>' });
    expect([made.status, made.json.label, made.json.person.name]).toEqual([201, 'Second bMac/b', 'Ana Newcomer']);
    // A code is a person's own device's to ask for, and `polycap connect` will not write over a token without being told.
    expect((await call('POST', '/v1/agents/codes', mac.token)).status).toBe(403);
    expect((await call('POST', '/v1/agents/codes', undefined)).status).toBe(401);
    const again = (await call('POST', '/v1/agents/codes', ana)).json.code as string;
    await expect(connect(await testCli(), again, { url: base, configFile: anaAgent.file, env: {} })).rejects.toThrow(/already holds a token/);
    // The refusal came before the code was spent.
    expect((await call('POST', '/v1/agents', undefined, { code: again })).status).toBe(201);
  });

  it('lets a project\'s owner change its hosts, and nobody else', async () => {
    const cli = await agentCli(anaAgent.token);
    const cwd = cli.config.root;
    const launch = (url: string) => call('POST', '/v1/threads/MARI-1/messages', anaAgent.token, { text: 'Preview', launches: [{ steps: [{ do: 'open', url }] }] });
    expect((await launch('https://marimba-preview.example.net/b2')).status).toBe(400);
    await projectEdit(cli, 'mari', { addHosts: ['marimba-preview.example.net'], addPackages: ['com.example.marimba'] }, { cwd });
    expect(cli.lines.at(-1)).toBe('MARI: Marimba game. Launches may open hosts marimba.example.com, marimba-preview.example.net; packages com.example.marimba.');
    expect((await launch('https://marimba-preview.example.net/b2')).status).toBe(201);
    // A host taken out stops new launches; the one already sent stays as it was.
    await projectEdit(cli, 'MARI', { removeHosts: ['marimba.example.com'] }, { cwd });
    expect((await launch('https://marimba.example.com/build/3')).status).toBe(400);
    expect((await call('GET', '/v1/threads/MARI-1', ana)).json.messages[0].launches[0].steps[0].url).toBe('https://marimba.example.com/build/1');
    await expect(projectEdit(cli, 'MARI', { removeHosts: ['never.example.com'] }, { cwd })).rejects.toThrow(/not one of MARI's hosts/);
    // The rules a new project's hosts keep to, and both lists whole.
    for (const body of [{ hosts: ['*.vercel.app'] }, { hosts: ['a.example.com', 'a.example.com'] }, {}, { name: 'Renamed' }, { hosts: ['not a host'] }]) {
      expect([JSON.stringify(body), (await call('POST', '/v1/projects/MARI', anaAgent.token, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    // Her headset may change it too; the team's token may not, nor read it, and a team project is nobody's to change here.
    expect((await call('POST', '/v1/projects/MARI', ana, { packages: [] })).json.project).toEqual({ key: 'MARI', name: 'Marimba game', mine: true, hosts: ['marimba-preview.example.net'], packages: [] });
    expect((await call('GET', '/v1/projects/MARI', mac.token)).status).toBe(404);
    expect((await call('POST', '/v1/projects/MARI', mac.token, { hosts: ['team.example'] })).status).toBe(404);
    expect((await call('POST', '/v1/projects/MUS', mac.token, { hosts: ['elsewhere.example'] })).status).toBe(404);
    expect((await call('GET', '/v1/projects/MUS', mac.token)).json.project).toEqual({ key: 'MUS', name: 'Marimba', hosts: ['team.example'], packages: [] });
    expect((await call('GET', '/v1/projects/START', ana)).status).toBe(404);
  });

  it('gives a person on the team the same thread-scoped token, never the team\'s', async () => {
    const robins = await pair(quest.token);
    expect((await call('GET', '/v1/me', robins.token)).json.person.id).toBe('robin');
    expect((await call('GET', '/v1/projects', robins.token)).json.projects).toEqual([]);
    expect((await call('GET', `/v1/threads/${teamThread}`, robins.token)).status).toBe(404);
    expect((await call('GET', '/v1/sessions', robins.token)).json.sessions).toEqual([]);
    expect((await call('GET', `/v1/threads/${report.key}`, robins.token)).status).toBe(404);
    // And Robin's headsets still see as the team's do: the agent made nobody thread-scoped.
    expect((await call('GET', `/v1/threads/${teamThread}`, quest.token)).status).toBe(200);
  });

  it('stops at five agents a person, and the headset or the agent itself disconnects one', async () => {
    // Every try in this file comes from this machine, and ten in ten minutes is one sender's limit; the count is
    // kept in memory, so a restart clears it.
    await close();
    await start();
    const cat = await signIn('2003', 'c3d4e5f6', 'Cat Third');
    const agents = [];
    for (let i = 1; i <= AGENT_LIMITS.perPerson; i++) agents.push(await pair(cat, `Machine ${i}`));
    const full = await call('POST', '/v1/agents/codes', cat);
    expect([full.status, full.json.reason]).toEqual([403, 'agent_limit']);
    const listed = await call('GET', '/v1/agents', cat);
    expect(listed.json.limit).toBe(5);
    expect(listed.json.agents.map((a: { label: string; connectedFrom: string }) => [a.label, a.connectedFrom])).toEqual(agents.map((_, i) => [`Machine ${i + 1}`, 'Quest 3']));
    expect(listed.json.agents[0].lastUsedOn).toBeUndefined();

    // From the headset: that agent's token stops at once, and there is room for another.
    const first = listed.json.agents[0].id as string;
    expect((await call('GET', '/v1/me', agents[0].token)).status).toBe(200);
    expect((await call('DELETE', `/v1/agents/${first}`, cat)).json).toEqual({ id: first, disconnected: true });
    expect((await call('GET', '/v1/me', agents[0].token)).status).toBe(401);
    expect((await call('DELETE', `/v1/agents/${first}`, cat)).status).toBe(404);
    expect((await call('POST', '/v1/agents/codes', cat)).status).toBe(201);

    // From the agent's own machine: the receiver forgets the token and it leaves the settings file.
    const cli = await agentCli(agents[1].token);
    await disconnect(cli, { configFile: agents[1].file });
    expect(cli.lines.at(-1)).toMatch(/The receiver has forgotten this token\. It is out of /);
    expect(readEnvFile(agents[1].file)).toEqual({ POLYCAP_REMOTE_URL: base });
    expect((await call('GET', '/v1/me', agents[1].token)).status).toBe(401);
    // An agent disconnects itself alone: another of the same person's is not its to remove.
    const third = listed.json.agents[2].id as string;
    expect((await call('DELETE', `/v1/agents/${third}`, agents[3].token)).status).toBe(404);
    // A token made by hand is not one of these.
    await expect(disconnect(await agentCli(mac.token), { configFile: agents[2].file })).rejects.toThrow(/not made by polycap connect/);
    const remaining = (await call('GET', '/v1/agents', cat)).json.agents as { label: string; lastUsedOn?: string }[];
    expect(remaining.map(a => a.label)).toEqual(['Machine 3', 'Machine 4', 'Machine 5']);
    expect(remaining[1].lastUsedOn).toBe(new Date().toISOString().slice(0, 10));
  });

  it('keeps a token across a restart, and stops it when it expires or its person is blocked', async () => {
    await close();
    await start();
    expect((await call('GET', '/v1/threads/MARI-1', anaAgent.token)).status).toBe(200);

    // Past its 90 days it says so, and how to connect again.
    await close();
    const file = join(server.config.root, 'agents.json');
    const kept = JSON.parse(await readFile(file, 'utf8')) as { agents: { person: string; label: string; expiresAt: string }[] };
    const hers = kept.agents.find(a => a.person === 'meta-2001' && a.label === 'Mac')!;
    const until = hers.expiresAt;
    expect(Math.round((Date.parse(until) - Date.now()) / (24 * 3600_000))).toBe(90);
    hers.expiresAt = '2026-01-01T00:00:00Z';
    await writeFile(file, JSON.stringify(kept), { mode: 0o600 });
    await start();
    const lapsed = await call('GET', '/v1/me', anaAgent.token);
    expect([lapsed.status, lapsed.json.reason]).toEqual([401, 'expired']);
    expect(lapsed.json.error).toContain('polycap connect');
    expect(server.lines.join('\n')).not.toMatch(/expired token\(s\).*paired-/);

    // Back in date, it works; then the team blocks her sign-in, and her agent stops with her headset.
    await close();
    hers.expiresAt = until;
    await writeFile(file, JSON.stringify(kept), { mode: 0o600 });
    await start();
    expect((await call('GET', '/v1/me', anaAgent.token)).status).toBe(200);
    await close();
    await start({ projects: ['START'], blockedUsers: ['2001'] });
    expect((await call('GET', '/v1/me', ana)).status).toBe(401);
    expect((await call('GET', '/v1/me', anaAgent.token)).status).toBe(401);
    expect((await call('GET', '/v1/sessions', anaAgent.token)).status).toBe(401);
  });

  it('refuses a token set by hand that takes an agent\'s id, and an agents.json it cannot read', async () => {
    const other = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const taken = JSON.stringify([{ id: 'paired-0a1b2c3d', sha256: newToken().sha256, scopes: ['read'] }]);
    await expect(serve(other, { host: '127.0.0.1', port: 0, tokens: taken, projects: PROJECTS })).rejects.toThrow(/ids starting paired- belong to agents/);
    await writeFile(join(other.config.root, 'agents.json'), '{"version":1,"agents":[{"id":"mac"}]}', { mode: 0o600 });
    await expect(serve(other, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS })).rejects.toThrow(/agents\.json does not match/);
  });
});

describe('codes and their limits, on a clock the test holds', () => {
  const device: Grant = { id: 'meta-3001', sha256: 'd'.repeat(64), scopes: ['upload'], label: 'Quest 3', user: 'meta-3001' };
  const make = async () => {
    let now = Date.parse('2026-11-20T12:00:00Z');
    const grants: Grant[] = [device];
    const agents = new Agents(await mkdtemp(join(tmpdir(), 'polycap-agents-')), grants, () => {}, () => now);
    await agents.load();
    return { agents, grants, wait: (ms: number) => { now += ms; }, now: () => now };
  };

  it('a code runs out after ten minutes, and a token after ninety days', async () => {
    const { agents, grants, wait, now } = await make();
    const late = agents.code(device);
    expect(Date.parse(late.expiresAt) - now()).toBe(10 * 60_000);
    wait(10 * 60_000);
    await expect(agents.redeem({ code: late.code }, '203.0.113.5')).rejects.toMatchObject({ status: 404, extra: { reason: 'no_code' } });
    wait(60_000);
    const { grant } = await agents.redeem({ code: agents.code(device).code }, '203.0.113.5');
    expect(grant).toMatchObject({ scopes: ['read', 'post'], user: 'meta-3001', threads: 'member', projects: [], issued: true, label: 'Computer' });
    expect(grants).toContain(grant);
    expect(expired(grant, now() + 90 * 24 * 3600_000 - 1000)).toBe(false);
    expect(expired(grant, now() + 90 * 24 * 3600_000)).toBe(true);
    // It counts only while its person has a token of their own that does.
    expect(agents.authorized(grant, () => true)).toBe(true);
    expect(agents.authorized(grant, () => false)).toBe(false);
    grants.splice(grants.indexOf(device), 1);
    expect(agents.authorized(grant, () => true)).toBe(false);
    // And a code asked for before the person's own tokens went gets nothing.
    grants.push(device);
    const orphan = agents.code(device);
    grants.splice(grants.indexOf(device), 1);
    await expect(agents.redeem({ code: orphan.code }, '203.0.113.5')).rejects.toMatchObject({ status: 404 });
  });

  it('limits tries by sender and in all, and codes by person', async () => {
    const { agents, wait } = await make();
    for (let i = 0; i < AGENT_LIMITS.triesPerSender; i++) await expect(agents.redeem({ code: '2222-2222' }, '203.0.113.5')).rejects.toMatchObject({ status: 404 });
    await expect(agents.redeem({ code: '2222-2222' }, '203.0.113.5')).rejects.toMatchObject({ status: 429 });
    // Even the right code waits its turn from that sender; another sender is not held up.
    const real = agents.code(device);
    await expect(agents.redeem({ code: real.code }, '203.0.113.5')).rejects.toMatchObject({ status: 429 });
    for (let i = AGENT_LIMITS.triesPerSender; i < AGENT_LIMITS.triesInAll; i++) await expect(agents.redeem({ code: '2222-2222' }, `198.51.100.${i}`)).rejects.toMatchObject({ status: 404 });
    await expect(agents.redeem({ code: real.code }, '192.0.2.1')).rejects.toMatchObject({ status: 429 });
    wait(AGENT_LIMITS.windowMs);
    // Past the window the code itself has run out too: a new one works.
    await expect(agents.redeem({ code: real.code }, '192.0.2.1')).rejects.toMatchObject({ status: 404 });
    for (let i = 1; i < AGENT_LIMITS.codesPerPerson; i++) agents.code(device);
    const last = agents.code(device);
    expect(() => agents.code(device)).toThrow(/too many codes/);
    expect((await agents.redeem({ code: last.code }, '192.0.2.1')).token).toMatch(/^polycap_/);
  });
});
