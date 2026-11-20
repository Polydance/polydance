/**
 * Reports from the headset's bug key (docs/THREADS.md, Reports): each opens a thread of its own in the
 * reports project, which only the team's tokens see, and counts against a reports allowance of its own.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { threadList, threadShow } from '../src/commands/thread.js';
import { sleep } from '../src/fsx.js';
import { loadSession } from '../src/session.js';
import { ThreadStore } from '../src/server/threads.js';
import { newToken, type Grant } from '../src/server/tokens.js';
import { parseProjects, REPORT_ASK } from '../src/threads.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { fakeTools, hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', packages: ['com.example.marimba'] },
  { key: 'CAP', name: 'Polydance Capture', packages: ['net.polydance.capture'] },
]);

const grant = (id: string, scopes: Grant['scopes'], extra: Partial<Grant> = {}): Grant => ({ id, sha256: '0'.repeat(64), scopes, ...extra });
const team = grant('mac', ['read', 'post']);
/** A tester's headset: upload only, and only Marimba's threads. */
const tester = grant('meta-1', ['upload'], { projects: ['MUS'], label: 'Quest 3' });

describe('reports in the thread store', () => {
  const projects = parseProjects(PROJECTS);
  const store = async (reports?: string) => new ThreadStore(await mkdtemp(join(tmpdir(), 'reports-')), projects, [], reports);

  it('opens a team-only thread in the reports project, whatever the sender sees', async () => {
    const threads = await store('CAP');
    expect(threads.reportsOn).toBe(true);
    await threads.checkUploadRef(tester, { report: true });
    const link = await threads.attachRecording(tester, { id: 'up_r1', clientId: 'r1', recordedAt: '2026-10-12T15:40:02+01:00' }, { report: true });
    expect(link).toEqual({ key: 'CAP-1', message: 1 });
    // Idempotent on the upload, like any recording.
    expect(await threads.attachRecording(tester, { id: 'up_r1', clientId: 'r1' }, { report: true })).toEqual(link);
    expect(await threads.get('CAP-1')).toMatchObject({ report: true, title: 'Report 12 Oct 15:40', titleFromRecording: true, by: { id: 'meta-1' } });
    expect(await threads.context(link)).toEqual({ key: 'CAP-1', project: 'CAP', title: 'Report 12 Oct 15:40', opened: true, report: true });

    // The sender's token cannot find it, by listing, by key or in the feed; nor can any upload-only token.
    expect(await threads.list(tester)).toEqual([]);
    await expect(threads.visible(tester, 'CAP-1')).rejects.toThrow(/no thread CAP-1/);
    await expect(threads.visible(grant('quest3', ['upload']), 'CAP-1')).rejects.toThrow(/no thread CAP-1/);
    await expect(threads.react(tester, 'CAP-1', 1, 'heart')).rejects.toThrow(/no thread CAP-1/);
    expect(await threads.eventsAfter(tester, 0)).toEqual([]);
    expect(await threads.eventsAfter(grant('quest3', ['upload']), 0)).toEqual([]);

    // The team sees it, marked, and hears it as it is built.
    expect((await threads.list(team)).map(t => [t.key, t.report])).toEqual([['CAP-1', true]]);
    await threads.recordingFinished(link, { sessionId: 's1', title: 'Inbox key does nothing', summary: 'Finds the inbox key does not open the inbox.' });
    expect(await threads.get('CAP-1')).toMatchObject({ title: 'Inbox key does nothing', report: true });
    expect((await threads.eventsAfter(team, 0)).map(e => [e.kind, e.report])).toEqual([['thread.new', true], ['recording.ready', true]]);
    // An agent limited to Marimba does not see Polydance Capture's reports either.
    expect(await threads.list(grant('mus-agent', ['read', 'post'], { projects: ['MUS'] }))).toEqual([]);

    // An ordinary recording from the same headset still goes where it always did.
    expect(await threads.attachRecording(tester, { id: 'up_n1', clientId: 'n1' }, undefined)).toEqual({ key: 'MUS-1', message: 1 });
    expect((await threads.list(tester)).map(t => t.key)).toEqual(['MUS-1']);
  });

  it('refuses reports when no reports project is set, and a reports project that is not a project', async () => {
    const threads = await store();
    expect(threads.reportsOn).toBe(false);
    await expect(threads.checkUploadRef(tester, { report: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/does not take reports/) });
    await expect(store('ZZ')).rejects.toThrow(/reports project ZZ is not one of the projects/);
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('reports on the receiver, end to end', () => {
  const quest = newToken(), mac = newToken(), musAgent = newToken(), robinsQuest = newToken();
  let base: string; let close: () => Promise<void>; let video: Buffer; let sha: string;
  let server: Awaited<ReturnType<typeof testCli>>; let claude: Awaited<ReturnType<typeof fakeClaude>>;

  beforeAll(async () => {
    process.env.TZ = 'Europe/London';
    process.env.FAKE_WHISPER_JSON = new URL('./fixtures/whisper-output.json', import.meta.url).pathname;
    const tools = await fakeTools();
    claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Inbox key does nothing', summary: 'Finds the inbox key does not open the inbox.', requests: [] })) }));
    server = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '4', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const file = join(await mkdtemp(join(tmpdir(), 'reports-video-')), 'clip.mp4');
    await makeVideo(file, 6);
    video = await readFile(file);
    sha = createHash('sha256').update(video).digest('hex');
    // The headset's allowance holds one recording and a half: one report fits, a second does not.
    const tokens = JSON.stringify([
      { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: 'Quest 3', projects: ['MUS'], maxBytes: Math.floor(video.length * 1.5) },
      { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: "Robin's Mac" },
      { id: 'mus-agent', sha256: musAgent.sha256, scopes: ['read', 'post'], projects: ['MUS'] },
      // The team's own headset sees every project, the reports project included, and still not a report.
      { id: 'robins-quest', sha256: robinsQuest.sha256, scopes: ['upload'], label: "Robin's Quest 3" },
    ]);
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, reports: 'CAP' });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); claude?.close(); delete process.env.FAKE_WHISPER_JSON; });

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  const create = (clientId: string, thread?: unknown) => call('POST', '/v1/uploads', quest.token, {
    clientId, bytes: video.length, sha256: sha, fileName: 'clip.mp4', recordedAt: '2026-10-12T15:40:02+01:00', appPackage: 'net.polydance.capture', audioTracks: ['mic'], ...(thread ? { thread } : {}),
  });
  /** Sends the whole video, as the headset does, and waits (as the team, who alone can see a report) until it is built. */
  const send = async (id: string) => {
    const put = await call('PUT', `/v1/uploads/${id}/content`, quest.token, video, { 'content-range': `bytes 0-${video.length - 1}/${video.length}`, 'content-type': 'application/octet-stream' });
    // What the headset waits for before deleting its copy: every byte here and verified.
    expect(put.json.status).toBe('received');
    for (let i = 0; i < 200; i++) {
      const status = (await call('GET', `/v1/uploads/${id}`, mac.token)).json;
      if (status.status === 'ready' || status.status === 'failed') {
        await expect.poll(async () => ((await call('GET', '/v1/events?after=0', mac.token)).json.events as Record<string, unknown>[])
          .some(e => e.thread === status.thread && e.kind === 'recording.ready')).toBe(true);
        return status;
      }
      await sleep(50);
    }
    throw new Error('upload never finished');
  };

  it('says it takes reports', async () => {
    expect((await call('GET', '/v1/projects', quest.token)).json.capabilities).toEqual(['idempotent-replies-v1', 'reports-v1', 'models-v1', 'photos-v1', 'projects-new-v1', 'projects-edit-v1', 'agents-v1']);
    expect((await call('GET', '/v1/threads', quest.token)).json).toMatchObject({ reports: true, threads: [] });
  });

  it('takes a report from a headset that cannot see the reports project, and only the team sees it', async () => {
    const created = await create('quest3-report', { report: true });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ thread: 'CAP-1', status: 'uploading' });
    const done = await send(created.json.id);
    expect(done).toMatchObject({ status: 'ready', thread: 'CAP-1', title: 'Inbox key does nothing' });

    // The bundle knows it is a report, and the summary read it against what the bug key asks.
    const manifest = await loadSession(join(server.config.sessions, done.sessionId));
    expect(manifest.source.thread).toEqual({ key: 'CAP-1', project: 'CAP', title: 'Report 12 Oct 15:40', opened: true, report: true });
    expect(JSON.stringify(claude.calls.at(-1)!.body.messages)).toContain(`<asked>\\n${REPORT_ASK}\\n</asked>`);
    expect(await readFile(join(server.config.sessions, done.sessionId, 'storyboard.md'), 'utf8')).toContain("A report from Polydance's bug key, in thread CAP-1 in CAP");

    // The sender: not in its threads, its feed, its server history or by id, and not against its tape.
    expect((await call('GET', '/v1/threads', quest.token)).json.threads).toEqual([]);
    expect((await call('GET', '/v1/threads/CAP-1', quest.token)).status).toBe(404);
    expect((await call('GET', '/v1/events?after=0', quest.token)).json.events).toEqual([]);
    expect((await call('GET', '/v1/uploads', quest.token)).json.uploads).toEqual([]);
    expect((await call('GET', `/v1/uploads?clientId=quest3-report`, quest.token)).json.uploads).toEqual([]);
    expect((await call('GET', `/v1/uploads/${created.json.id}`, quest.token)).status).toBe(404);
    expect((await call('GET', '/v1/account', quest.token)).json).toMatchObject({ usedBytes: 0, recordings: 0 });

    // The team: the thread, marked, titled by its summary, with the recording ready.
    const thread = (await call('GET', '/v1/threads/CAP-1', mac.token)).json;
    expect(thread).toMatchObject({ report: true, title: 'Inbox key does nothing', by: { id: 'quest3' }, messages: [{ recording: { status: 'ready', sessionId: done.sessionId } }] });
    expect((await call('GET', '/v1/threads', mac.token)).json.threads).toMatchObject([{ key: 'CAP-1', report: true }]);
    // Nor does a headset that sees the reports project: reports are for the team's read and post tokens.
    expect((await call('GET', '/v1/threads', robinsQuest.token)).json.threads).toEqual([]);
    expect((await call('GET', '/v1/threads/CAP-1', robinsQuest.token)).status).toBe(404);
    expect((await call('GET', '/v1/events?after=0', robinsQuest.token)).json.events).toEqual([]);
    expect((await call('POST', '/v1/threads/CAP-1/reactions', robinsQuest.token, { message: 1, reaction: 'heart' })).status).toBe(404);
    // A team token limited to another project still does not see it.
    expect((await call('GET', '/v1/threads/CAP-1', musAgent.token)).status).toBe(404);

    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    await threadList(agent, { all: true, reports: true });
    expect(agent.lines.join('\n')).toMatch(/CAP-1\s+Inbox key does nothing .* report unread/);
    agent.lines.length = 0;
    await threadShow(agent, 'CAP-1');
    expect(agent.lines[0]).toBe('CAP-1 · Inbox key does nothing · Polydance Capture · open · report from the bug key, team only');
  });

  it('keeps reports to an allowance of their own, apart from the tape', async () => {
    // The first report filled most of the reports allowance; a second is refused and the receiver logs it.
    const full = await create('quest3-report-2', { report: true });
    expect(full.status).toBe(507);
    expect(full.json.error).toMatch(/reports full/);
    expect(server.lines.join('\n')).toMatch(/report from quest3 refused: its reports allowance is full \(1 report\(s\)\)/);
    // An ordinary recording still has the whole tape, and lands in the headset's own project.
    const ordinary = await create('quest3-ordinary');
    expect(ordinary.status).toBe(201);
    expect(ordinary.json.thread).toBe('MUS-1');
  });

  it('refuses a report the receiver cannot keep apart, rather than putting it in an ordinary thread', async () => {
    const off = await testCli();
    const token = newToken();
    const running = await serve(off, { host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'q', sha256: token.sha256, scopes: ['upload'] }]), projects: PROJECTS });
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/v1/uploads`, {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: 'q-report', bytes: video.length, sha256: sha, fileName: 'clip.mp4', thread: { report: true } }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/does not take reports/);
    } finally { await running.close(); }
    await expect(serve(await testCli(), { host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'q', sha256: token.sha256, scopes: ['upload'] }]), projects: PROJECTS, reports: 'ZZ' }))
      .rejects.toThrow(/POLYCAP_REPORTS is ZZ, which POLYCAP_PROJECTS does not have/);
  });
});
