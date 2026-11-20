/**
 * People's own projects (Robin, 2026-11-13; docs/THREADS.md "Projects of your own"): anyone makes one, only its
 * owner sees it whole, the people in one of its threads see that thread, and its owner manages who is in it.
 * The team's projects in POLYCAP_PROJECTS are seen as before.
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { projectList, projectNew } from '../src/commands/thread.js';
import { OwnProjects } from '../src/server/projects.js';
import { newToken } from '../src/server/tokens.js';
import { MAX_OWN_PROJECTS, newProjectSchema, ownHostProblem, projectKeyFrom } from '../src/threads.js';
import { testCli, type TestCli } from './helpers/cli.js';

describe('own projects: keys, names and hosts', () => {
  it('makes a key from the name, and the next free one when it is taken', () => {
    const none = () => false;
    expect(projectKeyFrom('Spottisphone', none)).toBe('SPOT');
    expect(projectKeyFrom('Spottisphone', key => key === 'SPOT')).toBe('SPOT2');
    expect(projectKeyFrom('Spottisphone', key => ['SPOT', 'SPOT2'].includes(key))).toBe('SPOT3');
    expect(projectKeyFrom('Café crème', none)).toBe('CAFE');
    expect(projectKeyFrom('3D sketches', none)).toBe('DSKE');
    expect(projectKeyFrom('Go', none)).toBe('GO');
    expect(projectKeyFrom('🎉', none)).toBe('PROJ');
    expect(projectKeyFrom('x', none)).toBe('PROJ');
  });

  it('refuses a * that would let a person\'s launches open anyone\'s site', () => {
    expect(ownHostProblem('*.vercel.app')).toMatch(/anyone names their own hosts/);
    expect(ownHostProblem('myapp-*.vercel.app')).toMatch(/between a prefix and a suffix/);
    expect(ownHostProblem('*-yourteam.vercel.app')).toMatch(/anyone names their own hosts/);
    expect(ownHostProblem('*.app')).toMatch(/two labels after it/);
    expect(ownHostProblem('myapp-*-yourteam.vercel.app')).toBeUndefined();
    expect(ownHostProblem('*.example.com')).toBeUndefined();
    expect(ownHostProblem('spot.example.com')).toBeUndefined();
    expect(ownHostProblem('myapp.vercel.app')).toBeUndefined();
  });

  it('checks what POST /v1/projects takes', () => {
    expect(newProjectSchema.parse({ name: '  Spottisphone ', key: 'spot' })).toEqual({ name: 'Spottisphone', key: 'SPOT' });
    expect(newProjectSchema.safeParse({ name: '' }).success).toBe(false);
    expect(newProjectSchema.safeParse({ name: 'a'.repeat(61) }).success).toBe(false);
    expect(newProjectSchema.safeParse({ name: 'Line\nbreak' }).success).toBe(false);
    expect(newProjectSchema.safeParse({ name: 'X', key: '1AB' }).success).toBe(false);
    expect(newProjectSchema.safeParse({ name: 'X', owner: 'robin' }).success).toBe(false);
    expect(newProjectSchema.safeParse({ name: 'X', hosts: ['*.vercel.app'] }).error?.issues[0].path).toEqual(['hosts', 0]);
    expect(newProjectSchema.safeParse({ name: 'X', packages: ['not a package'] }).success).toBe(false);
  });
});

describe('own projects on the receiver', () => {
  const mac = newToken(), quest = newToken(), anaQuest = newToken(), anaAgent = newToken(), benQuest = newToken(), eve = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'robin' },
    // Testers, as a sign-in or `token new --member` makes them: they see START and the threads they are in.
    { id: 'ana-quest', sha256: anaQuest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ana', projects: ['START'], threads: 'member' },
    { id: 'ana-agent', sha256: anaAgent.sha256, scopes: ['read', 'post'], label: "Ana's Mac", user: 'ana', projects: ['START'], threads: 'member' },
    { id: 'ben-quest', sha256: benQuest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ben', projects: ['START'], threads: 'member' },
    { id: 'eve', sha256: eve.sha256, scopes: ['upload'], label: 'Phone', projects: ['START'], threads: 'member', user: 'eve' },
  ]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }, { id: 'ben', name: 'Ben' }, { id: 'eve', name: 'Eve' }]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba', hosts: ['*.marimba.example'] }, { key: 'START', name: 'Getting started' }]);
  let cli: TestCli; let base: string; let close: () => Promise<void>;

  const start = async () => {
    const running = await serve(cli, { host: '127.0.0.1', port: 0, tokens, projects, users });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  };
  beforeAll(async () => { cli = await testCli(); await start(); });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const listed = async (token: string) => (await call('GET', '/v1/projects', token)).json.projects as { key: string; name: string; mine?: true }[];
  const inbox = async (token: string) => ((await call('GET', '/v1/threads', token)).json.threads as { key: string }[]).map(t => t.key);

  it('says it makes projects, and lets anyone make one, even from an upload-only headset', async () => {
    expect((await call('GET', '/v1/projects', anaQuest.token)).json.capabilities).toContain('projects-new-v1');
    // The apps read it off the inbox, as the bug key reads reports.
    expect((await call('GET', '/v1/threads', anaQuest.token)).json.newProjects).toBe(true);
    const made = await call('POST', '/v1/projects', anaQuest.token, { name: 'Spottisphone' });
    expect(made.status).toBe(201);
    expect(made.json.project).toEqual({ key: 'SPOT', name: 'Spottisphone', mine: true, hosts: [], packages: [] });
    expect(made.json.projects).toEqual([{ key: 'START', name: 'Getting started' }, { key: 'SPOT', name: 'Spottisphone', mine: true }]);
    // The next with the same start gets the next key, and the file is the owner's alone to read.
    expect((await call('POST', '/v1/projects', anaAgent.token, { name: 'Spotlight' })).json.project.key).toBe('SPOT2');
    const file = join(cli.config.root, 'projects.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).projects.map((p: { key: string; owner: string }) => [p.key, p.owner])).toEqual([['SPOT', 'ana'], ['SPOT2', 'ana']]);
  });

  it('refuses a key that is taken, a bad shape, and a host that is too wide', async () => {
    expect(await call('POST', '/v1/projects', benQuest.token, { name: 'Mine', key: 'MUS' })).toMatchObject({ status: 409, json: { reason: 'key_taken' } });
    expect(await call('POST', '/v1/projects', benQuest.token, { name: 'Mine', key: 'spot' })).toMatchObject({ status: 409, json: { reason: 'key_taken' } });
    expect((await call('POST', '/v1/projects', benQuest.token, { name: '' })).status).toBe(400);
    expect((await call('POST', '/v1/projects', benQuest.token, { name: 'Mine', owner: 'ana' })).status).toBe(400);
    const wide = await call('POST', '/v1/projects', benQuest.token, { name: 'Mine', hosts: ['*.vercel.app'] });
    expect(wide.status).toBe(400);
    expect(wide.json.error).toMatch(/anyone names their own hosts/);
  });

  it('shows a project only to its owner, the team\'s tokens included', async () => {
    expect((await listed(anaQuest.token)).map(p => p.key)).toEqual(['START', 'SPOT', 'SPOT2']);
    expect((await listed(mac.token)).map(p => p.key)).toEqual(['MUS', 'START']);
    expect((await listed(benQuest.token)).map(p => p.key)).toEqual(['START']);
    // Nobody else opens a thread in it or sends it anything.
    expect((await call('POST', '/v1/threads', mac.token, { project: 'SPOT', title: 'Peek', text: 'Hello' })).status).toBe(404);
    expect((await call('POST', '/v1/projects/SPOT/photos', mac.token)).status).toBe(404);
  });

  it('keeps a thread in it to its owner, every device of theirs, and the people they add', async () => {
    const opened = await call('POST', '/v1/threads', anaAgent.token, { project: 'SPOT', title: 'First idea', text: 'A phone that spots things' });
    expect(opened.status).toBe(201);
    const key = opened.json.key as string;
    expect(key).toBe('SPOT-1');
    expect(await inbox(anaQuest.token)).toEqual(['SPOT-1']);
    expect((await call('GET', `/v1/threads/${key}`, anaQuest.token)).json).toMatchObject({ member: true, messages: [expect.objectContaining({ text: 'A phone that spots things' })] });
    for (const token of [mac.token, quest.token, benQuest.token]) {
      expect(await inbox(token)).not.toContain(key);
      expect((await call('GET', `/v1/threads/${key}`, token)).status).toBe(404);
    }
    // Its events are the owner's too: the team's feed never carries them.
    expect(((await call('GET', '/v1/events?after=0', mac.token)).json.events as { thread: string }[]).map(e => e.thread)).not.toContain(key);
    expect(((await call('GET', '/v1/events?after=0', anaQuest.token)).json.events as { thread: string }[]).map(e => e.thread)).toContain(key);

    // The owner adds Ben from her headset; nobody else may, and she cannot take herself out.
    expect((await call('POST', `/v1/threads/${key}/members`, benQuest.token, { add: ['ben'] })).status).toBe(404);
    expect((await call('POST', `/v1/threads/${key}/members`, mac.token, { add: ['ben'] })).status).toBe(404);
    const added = await call('POST', `/v1/threads/${key}/members`, anaQuest.token, { add: ['ben'] });
    expect(added.status).toBe(200);
    expect(added.json.members.map((m: { person: string }) => m.person)).toEqual(['ana', 'ben']);
    expect((await call('POST', `/v1/threads/${key}/members`, anaQuest.token, { remove: ['ana'] })).status).toBe(400);
    expect((await call('POST', `/v1/threads/${key}/members`, benQuest.token, { add: ['eve'] })).json.reason).toBe('not_team');

    // Ben sees it from when he was added, as anyone added to a thread does; the owner sees it whole.
    expect(await inbox(benQuest.token)).toEqual([key]);
    const bens = (await call('GET', `/v1/threads/${key}`, benQuest.token)).json;
    expect(bens.messages).toEqual([]);
    expect(bens.members).toBeUndefined();
    expect((await call('POST', `/v1/threads/${key}/messages`, anaAgent.token, { text: 'Welcome, Ben' })).status).toBe(201);
    expect(((await call('GET', `/v1/threads/${key}`, benQuest.token)).json.messages as { text: string }[]).map(m => m.text)).toEqual(['Welcome, Ben']);
    // The team's token is still out, and the owner may choose that the next person sees what came before.
    expect((await call('GET', `/v1/threads/${key}`, mac.token)).status).toBe(404);
    expect((await call('POST', `/v1/threads/${key}/members`, anaQuest.token, { add: ['eve'], history: 'visible' })).status).toBe(200);
    expect(((await call('GET', `/v1/threads/${key}`, eve.token)).json.messages as unknown[]).length).toBe(2);
  });

  it('lets the team in when the owner adds Robin, and from then on only', async () => {
    expect((await call('POST', '/v1/threads/SPOT-1/members', anaAgent.token, { add: ['robin'] })).status).toBe(200);
    expect(await inbox(mac.token)).toContain('SPOT-1');
    const robins = (await call('GET', '/v1/threads/SPOT-1', mac.token)).json;
    expect(robins.messages).toEqual([]);
    // Being a member is not managing: the team adds nobody to someone else's project.
    expect((await call('POST', '/v1/threads/SPOT-1/members', mac.token, { add: ['eve'] })).json.reason).toBe('not_team');
    expect(robins.members).toBeUndefined();
    // And the team's own projects are as they were.
    expect((await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Team thread', text: 'For the team' })).status).toBe(201);
    expect(await inbox(anaQuest.token)).not.toContain('MUS-1');
  });

  it('stops at twenty projects a person', async () => {
    for (let i = 0; i < MAX_OWN_PROJECTS; i += 1) expect((await call('POST', '/v1/projects', eve.token, { name: `Eve ${i}` })).status).toBe(201);
    expect(await call('POST', '/v1/projects', eve.token, { name: 'One more' })).toMatchObject({ status: 403, json: { reason: 'project_limit' } });
    expect((await listed(eve.token)).filter(p => p.mine)).toHaveLength(MAX_OWN_PROJECTS);
  });

  it('keeps them across a restart, and will not start with a key the team\'s projects also have', async () => {
    await close();
    await start();
    expect((await listed(anaQuest.token)).map(p => p.key)).toEqual(['START', 'SPOT', 'SPOT2']);
    expect(await inbox(benQuest.token)).toEqual(['SPOT-1']);
    const other = await testCli();
    await writeFile(join(other.config.root, 'projects.json'), JSON.stringify({ version: 1, projects: [{ key: 'MUS', name: 'Mine', hosts: [], packages: [], owner: 'ana', createdAt: '2026-11-13T20:00:00.000Z' }] }));
    await expect(serve(other, { host: '127.0.0.1', port: 0, tokens, projects, users })).rejects.toThrow(/MUS is a team project and also ana's own/);
    await writeFile(join(other.config.root, 'projects.json'), '{"version":1,"projects":[{"key":"SPOT"}]}');
    await expect(OwnProjects.load(other.config.root)).rejects.toThrow(/does not match/);
  });

  it('makes one from the CLI, and marks yours in the list', async () => {
    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    await expect(projectNew(agent, 'Wide', { hosts: ['*.vercel.app'], packages: [] })).rejects.toThrow(/hosts.0: .*anyone names their own hosts/);
    expect(await projectNew(agent, 'Spottisphone', { key: 'PHONE', hosts: ['phone.example.com'], packages: ['com.example.phone'] })).toBe('PHONE');
    expect(agent.lines.at(-1)).toMatch(/^PHONE: Spottisphone, yours\. Launches may open phone\.example\.com, com\.example\.phone\./);
    await expect(projectNew(agent, 'Again', { key: 'PHONE', hosts: [], packages: [] })).rejects.toThrow(/PHONE is taken/);
    await projectList(agent);
    expect(agent.lines.at(-1)).toMatch(/MUS\s+Marimba\s+team\nSTART\s+Getting started\s+team\nPHONE\s+Spottisphone\s+yours/);
    // What the Mac app reads to offer New project (and Report) only where the receiver has them.
    await projectList({ ...agent, json: true }, { capabilities: true });
    expect(JSON.parse(agent.lines.at(-1)!)).toMatchObject({ projects: expect.arrayContaining([{ key: 'PHONE', name: 'Spottisphone', mine: true }]), capabilities: expect.arrayContaining(['projects-new-v1']) });
    await projectList({ ...agent, json: true });
    expect(Array.isArray(JSON.parse(agent.lines.at(-1)!))).toBe(true);
    await projectList(agent, { capabilities: true });
    expect(agent.lines.at(-2)).toMatch(/^This receiver takes (no )?reports and makes projects of your own\.$/);
    // A launch in it goes only where its owner said.
    expect((await call('POST', '/v1/threads', mac.token, { project: 'PHONE', title: 'Try', launches: [{ label: 'Open', steps: [{ do: 'open', url: 'https://phone.example.com/' }] }] })).status).toBe(201);
    expect((await call('POST', '/v1/threads', mac.token, { project: 'PHONE', title: 'Elsewhere', launches: [{ label: 'Open', steps: [{ do: 'open', url: 'https://elsewhere.example.com/' }] }] })).status).toBe(400);
  });
});
