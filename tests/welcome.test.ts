/**
 * The Welcome (2026-11-10, src/server/welcome.ts): a newcomer's thread opened once per person, and Polydance's
 * one follow-up after their first recording in it is built; then the same end to end through the worker.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { sleep } from '../src/fsx.js';
import { saveSession, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { ThreadStore, unread, waiting, type Thread } from '../src/server/threads.js';
import { newToken, type Grant } from '../src/server/tokens.js';
import { UploadStore } from '../src/server/uploads.js';
import { hello, next, parseWelcome, Welcome, WELCOME_ID } from '../src/server/welcome.js';
import { parseProjects, parseUsers } from '../src/threads.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { fakeTools, hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

const PROJECTS = JSON.stringify([
  { key: 'START', name: 'Getting started', hosts: ['receiver.example'] },
  { key: 'MUS', name: 'Marimba', hosts: ['marimba.example'] },
]);
const URL_ = 'https://receiver.example/start';
const SETTINGS = { project: 'START', url: URL_ };

const grant = (id: string, scopes: Grant['scopes'], extra: Partial<Grant> = {}): Grant => ({ id, sha256: '0'.repeat(64), scopes, ...extra });
const team = grant('mac', ['read', 'post'], { label: 'Mac', user: 'robin' });
/** A Meta tester as sign-in makes them: thread-scoped, their person their own grant id. */
const ana = grant('meta-1001', ['upload'], { label: 'Quest 3', user: 'meta-1001', projects: ['START'] });
const ben = grant('meta-1002', ['upload'], { label: 'Quest 3', user: 'meta-1002', projects: ['START'] });

describe('POLYCAP_WELCOME', () => {
  const projects = parseProjects(PROJECTS);
  it('is off when unset and refused unless it names a project whose hosts take its page', () => {
    expect(parseWelcome(undefined, projects)).toBeUndefined();
    expect(parseWelcome('  ', projects)).toBeUndefined();
    expect(parseWelcome(JSON.stringify(SETTINGS), projects)).toEqual(SETTINGS);
    expect(() => parseWelcome('{', projects)).toThrow(/not JSON/);
    expect(() => parseWelcome(JSON.stringify({ project: 'START' }), projects)).toThrow(/url/);
    expect(() => parseWelcome(JSON.stringify({ project: 'NOPE', url: URL_ }), projects)).toThrow(/POLYCAP_PROJECTS does not have/);
    expect(() => parseWelcome(JSON.stringify({ project: 'START', url: 'http://receiver.example/start' }), projects)).toThrow(/https/);
    expect(() => parseWelcome(JSON.stringify({ project: 'START', url: 'https://elsewhere.example/start' }), projects)).toThrow(/hosts/);
    expect(() => parseWelcome(JSON.stringify({ ...SETTINGS, extra: 1 }), projects)).toThrow(/POLYCAP_WELCOME/);
  });

  it('is refused at start-up when wrong, and its id is the receiver\'s own', async () => {
    const mac = newToken();
    const tokens = JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'] }]);
    await expect(serve(await testCli(), { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, welcome: '{"project":"MUS","url":"https://receiver.example/start"}' }))
      .rejects.toThrow(/POLYCAP_WELCOME.*not one of MUS's hosts/);
    await expect(serve(await testCli(), { host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: WELCOME_ID, sha256: mac.sha256, scopes: ['read'] }]), projects: PROJECTS }))
      .rejects.toThrow(/receiver's own/);
    await expect(serve(await testCli(), { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: JSON.stringify([{ id: WELCOME_ID, name: 'P' }]) }))
      .rejects.toThrow(/receiver's own/);
  });
});

describe('the words', () => {
  it('greets by first name, and the follow-up says what it heard and what is next', () => {
    expect(hello('Ana Bell')).toMatch(/^Hi Ana, welcome to Polydance\./);
    expect(hello(undefined)).toMatch(/^Hi, welcome/);
    expect(hello('Tester')).toMatch(/^Hi, welcome/);
    expect(hello('Ana')).toContain('press Record and open');
    const heard = next({ title: 'Menu labels unclear', summary: 'Finds the menu hard to read.', requests: [{ atMs: 12_000, text: 'Make the labels bigger' }, { atMs: 30_000, text: 'Move Settings' }] }, URL_);
    expect(heard).toContain('"Menu labels unclear". Finds the menu hard to read.');
    expect(heard).toContain('It found 2 requests; the first, at 00:12: "Make the labels bigger"');
    expect(heard).toContain(`${URL_}#your-agent`);
    expect(heard).toContain('Connect your own coding agent');
    expect(next({ title: 'T', requests: [{ atMs: 0, text: 'x' }] }, URL_)).toContain('It found one request, at 00:00: "x"');
    expect(next({ title: 'T', requests: [] }, URL_)).toContain('no requests');
    expect(next({ durationMs: 65_000, requests: [] }, URL_)).toContain('Polydance has your recording (01:05)');
    expect(next(undefined, URL_)).toMatch(/^Polydance has your recording:/);
    expect(next({ title: 'T', requests: [{ atMs: 0, text: 'y'.repeat(300) }] }, URL_)).toContain(`"${'y'.repeat(199)}…"`);
  });
});

describe('the Welcome thread', () => {
  const projects = parseProjects(PROJECTS);
  const users = parseUsers(JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'meta-1001', name: 'Ana Bell' }, { id: 'meta-1002', name: 'Ben' }]));
  let n = 0;

  const setup = async () => {
    const cli = await testCli();
    const threads = new ThreadStore(cli.config.threadsDir, projects, users);
    const uploads = new UploadStore(cli.config.uploads);
    const make = () => new Welcome(cli.config.root, SETTINGS, threads, uploads, cli.config);
    return { cli, threads, uploads, welcome: make(), make };
  };

  /** A recording by `who` in thread `key`, its bundle as the worker leaves it, and its thread told how it ended. */
  const recorded = async (env: Awaited<ReturnType<typeof setup>>, who: Grant, key: string, outcome: { title?: string; summary?: string; requests?: unknown[]; failed?: boolean } = {}) => {
    n += 1;
    const { record } = await env.uploads.create(who.id, { clientId: `c${n}`, bytes: 10, sha256: createHash('sha256').update(`c${n}`).digest('hex'), fileName: 'clip.mp4' });
    const link = await env.threads.attachRecording(who, record, { key, replyTo: { message: 1, launch: 0 } });
    if (outcome.failed) { await env.threads.recordingFinished(link, { error: 'ffmpeg failed' }); return link; }
    const id = `2026-11-10T12-00-${String(n).padStart(2, '0')}_capture`;
    const dir = join(env.cli.config.sessions, id);
    await mkdir(dir, { recursive: true });
    await saveSession(dir, {
      version: 1, id, title: id, createdAt: '2026-11-10T12:00:00.000Z', recordedAt: '2026-11-10T12:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId: record.id, clientId: `c${n}`, originalName: 'clip.mp4', bytes: 10, sha256: 'a'.repeat(64) },
      media: { video: 'video.mp4', durationMs: 42_000 }, steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
      ...(outcome.title ? { summary: { title: outcome.title, text: outcome.summary ?? 'One sentence.', model: 'claude-haiku-4-5' } } : {}),
    });
    if (outcome.requests) await writeFile(join(dir, 'requests.json'), JSON.stringify({ version: 1, model: 'claude-haiku-4-5', requests: outcome.requests }));
    await env.uploads.update(record.id, { status: 'ready', sessionId: id });
    await env.threads.recordingFinished(link, { sessionId: id, title: outcome.title, summary: outcome.summary });
    return link;
  };
  const followUps = (thread: Thread | undefined) => thread!.messages.filter(m => m.by.id === WELCOME_ID && m.deliveryId === 'welcome-next');

  it('opens one thread for the newcomer, written by Polydance, with them its only member and something to try', async () => {
    const { threads, welcome } = await setup();
    expect(await welcome.ensure('meta-1001', 'Ana Bell')).toEqual({ key: 'START-1', opened: true });
    const thread = (await threads.get('START-1'))!;
    expect(thread).toMatchObject({ title: 'Welcome to Polydance', project: 'START', titleFromRecording: false, members: [{ person: 'meta-1001' }] });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ by: { id: WELCOME_ID, name: 'Polydance', as: 'Polydance', display: 'Polydance' }, launches: [{ label: 'Getting started', steps: [{ do: 'open', url: URL_ }] }] });
    expect(thread.messages[0]!.text).toMatch(/^Hi Ana, welcome to Polydance/);
    // Hers, unread and waiting for her; nobody else outside the team sees it.
    expect((await threads.list(ana)).map(t => t.key)).toEqual(['START-1']);
    expect(unread(thread, ana.id)).toBe(true);
    expect(waiting(thread, ana.id)).toBe(true);
    expect(await threads.list(ben)).toEqual([]);
    expect((await threads.list(team)).map(t => t.key)).toEqual(['START-1']);
  });

  it('opens it once per person, across a restart, unless asked again', async () => {
    const env = await setup();
    expect((await env.welcome.ensure('meta-1001', 'Ana')).opened).toBe(true);
    expect(await env.welcome.ensure('meta-1001', 'Ana')).toEqual({ key: 'START-1', opened: false });
    // Two sign-ins at once (two headsets) still open one.
    const both = await Promise.all([env.welcome.ensure('meta-1002', 'Ben'), env.welcome.ensure('meta-1002', 'Ben')]);
    expect(both.map(b => b.key)).toEqual(['START-2', 'START-2']);
    expect(await env.make().ensure('meta-1001', 'Ana')).toEqual({ key: 'START-1', opened: false });
    expect(await env.welcome.ensure('meta-1001', 'Ana', { again: true })).toEqual({ key: 'START-3', opened: true });
    expect(await env.welcome.ensure('meta-1001', 'Ana')).toEqual({ key: 'START-3', opened: false });
    const file = join(env.cli.config.root, 'welcome.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).threads.map((t: { person: string; key: string }) => `${t.person} ${t.key}`))
      .toEqual(['meta-1001 START-1', 'meta-1002 START-2', 'meta-1001 START-3']);
    await expect(env.welcome.ensure('Not A Person', 'x')).rejects.toThrow(/person id/);
  });

  it('adopts the thread a crash left unrecorded, and a damaged record is an error', async () => {
    const env = await setup();
    await env.welcome.ensure('meta-1001', 'Ana');
    const file = join(env.cli.config.root, 'welcome.json');
    await rm(file);
    expect(await env.welcome.ensure('meta-1001', 'Ana')).toEqual({ key: 'START-1', opened: false });
    expect(JSON.parse(await readFile(file, 'utf8')).threads).toHaveLength(1);
    await writeFile(file, '{"version":1,"threads":[{"person":"x"}]}');
    await expect(env.welcome.ensure('meta-1002', 'Ben')).rejects.toThrow();
  });

  it('follows up once, after the newcomer\'s first recording there is built, with what Polydance heard', async () => {
    const env = await setup();
    const { key } = await env.welcome.ensure('meta-1001', 'Ana');
    // Nothing to follow up yet; a failed recording waits for one that builds; someone else's is not hers.
    expect(await env.welcome.reconcile(key)).toBe(false);
    const failed = await recorded(env, ana, key, { failed: true });
    expect(await env.welcome.onBuilt(failed)).toBe(false);
    const robins = await recorded(env, team, key, { title: 'Robin says hi' });
    expect(await env.welcome.onBuilt(robins)).toBe(false);
    const first = await recorded(env, ana, key, { title: 'Menu labels unclear', summary: 'Finds the labels small.', requests: [{ atMs: 3000, text: 'Bigger labels' }, { atMs: 9000, text: 'Move Settings' }] });
    expect(await env.welcome.onBuilt(first)).toBe(true);
    let thread = await env.threads.get(key);
    expect(followUps(thread)).toHaveLength(1);
    expect(followUps(thread)[0]!.text).toContain('"Menu labels unclear". Finds the labels small.');
    expect(followUps(thread)[0]!.text).toContain('It found 2 requests; the first, at 00:03: "Bigger labels"');
    expect(unread(thread!, ana.id)).toBe(true);
    // Once: again for the same recording, for a second one, and after a restart.
    expect(await env.welcome.onBuilt(first)).toBe(false);
    const second = await recorded(env, ana, key, { title: 'Another go' });
    expect(await env.welcome.onBuilt(second)).toBe(false);
    expect(await env.make().sweep(() => undefined)).toBe(0);
    thread = await env.threads.get(key);
    expect(followUps(thread)).toHaveLength(1);
  });

  it('says what it can without a summary, never follows up a thread that is not a Welcome, and the sweep makes good a missed one', async () => {
    const env = await setup();
    const { key } = await env.welcome.ensure('meta-1001', 'Ana');
    await recorded(env, ana, key);
    // The worker never got to say so (a restart): the sweep at start-up does.
    const restarted = env.make();
    expect(await restarted.sweep(() => undefined)).toBe(1);
    expect(followUps(await env.threads.get(key))[0]!.text).toMatch(/^Polydance has your recording \(00:42\)/);
    expect(await restarted.sweep(() => undefined)).toBe(0);
    // Her own new thread in the same project is hers, not a Welcome.
    const { record } = await env.uploads.create(ana.id, { clientId: 'own', bytes: 10, sha256: 'b'.repeat(64), fileName: 'clip.mp4' });
    const own = await env.threads.attachRecording(ana, record, undefined);
    expect(own.key).toBe('START-2');
    await env.threads.recordingFinished(own, { sessionId: 'nope', title: 'My idea' });
    expect(await env.welcome.onBuilt(own)).toBe(false);
    expect(followUps(await env.threads.get('START-2'))).toHaveLength(0);
    // A damaged record is logged at start-up, not a reason not to start.
    await writeFile(join(env.cli.config.root, 'welcome.json'), 'not json');
    const logged: string[] = [];
    expect(await env.make().sweep(line => logged.push(line))).toBe(0);
    expect(logged).toEqual([expect.stringMatching(/^welcome: .*welcome\.json: /)]);
  });
});

describe('the thread store opens a thread with its members', () => {
  const projects = parseProjects(PROJECTS);
  it('lets only the team name members, checks them, and wakes a member waiting on the feed', async () => {
    const threads = new ThreadStore(await mkdtemp(join(tmpdir(), 'threads-')), projects);
    const bob = grant('bob-agent', ['post'], { user: 'bob', threads: 'member', projects: ['START'] });
    await expect(threads.create(bob, { project: 'START', title: 'x', text: 'y', members: ['ana'] })).rejects.toMatchObject({ status: 403 });
    await expect(threads.create(team, { project: 'START', title: 'x', text: 'y', members: ['Ana!'] })).rejects.toMatchObject({ status: 400 });
    await expect(threads.create(team, { project: 'START', title: 'x', text: 'y', members: Array.from({ length: 51 }, (_, i) => `p${i}`) })).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController();
    const waited = threads.waitForEvents(ana, await threads.lastEventId(), {}, 5000, controller.signal);
    await sleep(20);
    const made = await threads.create(team, { project: 'START', title: 'For Ana', text: 'Hello', members: ['meta-1001', 'meta-1001'] });
    expect(made.members).toEqual([{ person: 'meta-1001', addedBy: expect.objectContaining({ id: 'mac' }), addedAt: made.createdAt }]);
    const events = await waited;
    controller.abort();
    expect(events.map(e => `${e.kind} ${e.thread}`)).toEqual(['thread.new START-1']);
  });
});

describe('POST /v1/welcome without a Welcome', () => {
  it('is a 409', async () => {
    const mac = newToken();
    const running = await serve(await testCli(), { host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' }]), projects: PROJECTS, users: JSON.stringify([{ id: 'robin', name: 'Robin' }]) });
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/welcome`, { method: 'POST', headers: { authorization: `Bearer ${mac.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ person: 'robin' }) });
    expect(response.status).toBe(409);
    await running.close();
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('the Welcome on the receiver, end to end', () => {
  const mac = newToken(), anaQuest = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' },
    { id: 'ana-quest', sha256: anaQuest.sha256, scopes: ['upload'], user: 'ana', projects: ['START'], threads: 'member' },
  ]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana Bell' }]);
  let base: string; let close: () => Promise<void>; let video: Buffer; let claude: Awaited<ReturnType<typeof fakeClaude>>;

  beforeAll(async () => {
    process.env.FAKE_WHISPER_JSON = new URL('./fixtures/whisper-output.json', import.meta.url).pathname;
    const tools = await fakeTools();
    claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Getting started page review', summary: 'Looks round the getting-started page.', requests: [] })) }));
    const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '4', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const running = await serve(cli, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users, welcome: JSON.stringify(SETTINGS) });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    const file = join(await mkdtemp(join(tmpdir(), 'welcome-video-')), 'clip.mp4');
    await makeVideo(file, 4);
    video = await readFile(file);
  });
  afterAll(async () => { await close?.(); claude?.close(); delete process.env.FAKE_WHISPER_JSON; });

  const call = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };

  it('opens a Welcome by hand for the team, and Polydance follows up the newcomer\'s recording once it is built', async () => {
    expect((await call('POST', '/v1/welcome', anaQuest.token, { person: 'ana' })).status).toBe(403);
    expect((await call('POST', '/v1/welcome', mac.token, { person: 'nobody' })).status).toBe(400);
    expect((await call('POST', '/v1/welcome', mac.token, { person: 'ana' })).json).toEqual({ key: 'START-1', opened: true });
    const again = await call('POST', '/v1/welcome', mac.token, { person: 'ana' });
    expect(again).toMatchObject({ status: 200, json: { key: 'START-1', opened: false } });
    const listed = (await call('GET', '/v1/threads', anaQuest.token)).json;
    expect(listed.threads).toMatchObject([{ key: 'START-1', title: 'Welcome to Polydance', unread: true, waiting: true }]);

    const sha = createHash('sha256').update(video).digest('hex');
    const created = await call('POST', '/v1/uploads', anaQuest.token, { clientId: 'welcome-1', bytes: video.length, sha256: sha, fileName: 'clip.mp4', audioTracks: ['mic'], thread: { key: 'START-1', replyTo: { message: 1, launch: 0 } } });
    expect(created.status).toBe(201);
    await call('PUT', `/v1/uploads/${created.json.id}/content`, anaQuest.token, video, { 'content-range': `bytes 0-${video.length - 1}/${video.length}`, 'content-type': 'application/octet-stream' });
    await expect.poll(async () => {
      const thread = (await call('GET', '/v1/threads/START-1', anaQuest.token)).json;
      return (thread.messages as { by: { id: string }; text?: string }[]).filter(m => m.by.id === WELCOME_ID).map(m => m.text?.split('\n')[0]);
    }, { timeout: 20_000 }).toEqual([expect.stringMatching(/^Hi Ana/), 'Here is what Polydance made of your recording: "Getting started page review". Looks round the getting-started page.']);
    // The headsets draw Connect your agent under the answer, which they know by its sender and this name (Agents.kt, Agents.swift).
    const served = (await call('GET', '/v1/threads/START-1', anaQuest.token)).json.messages as { by: { id: string }; deliveryId?: string }[];
    expect(served.filter(m => m.by.id === 'polydance').map(m => m.deliveryId)).toEqual([undefined, 'welcome-next']);
  }, 30_000);

});
