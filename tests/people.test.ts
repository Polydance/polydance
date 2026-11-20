/**
 * People on the receiver (docs/THREADS.md, People, email and participants; Playback): a person's own
 * address, participants by address and the `people` event, who is in a thread and who sees addresses,
 * the inbox's people and snippet, hiding a thread, POST state, and playing a recording with its words and
 * video in ranges. Bundles are written straight into the receiver's library as the worker leaves them, so
 * nothing here needs ffmpeg, a transcriber or the network.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { writeJsonAtomic } from '../src/fsx.js';
import { initialOf } from '../src/server/people.js';
import { byteRange } from '../src/server/playback.js';
import { canPlay, hidden, isMember, lastActivity, ThreadStore, type Thread } from '../src/server/threads.js';
import { newToken, type Grant } from '../src/server/tokens.js';
import { UploadStore } from '../src/server/uploads.js';
import { saveSession, sessionDir, STEP_NAMES, type Opened, type SessionManifest } from '../src/session.js';
import { parseProjects, parseUsers } from '../src/threads.js';
import { TOOL_NAME, TOOL_VERSION } from '../src/version.js';
import { testCli } from './helpers/cli.js';
import { makeGlb } from './helpers/glb.js';

const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', packages: ['com.example.marimba'] },
  { key: 'CAP', name: 'Polydance Capture', packages: ['net.polydance.capture'] },
]);
const USERS = JSON.stringify([{ id: 'robin', name: 'Robin', colour: '#d93a2b' }, { id: 'ana', name: 'Ana' }, { id: 'ben', name: 'Ben', colour: '#2b6cd9' }]);
const grant = (id: string, scopes: Grant['scopes'], extra: Partial<Grant> = {}): Grant => ({ id, sha256: '0'.repeat(64), scopes, ...extra });

describe('people: initials, ranges and who is a member', () => {
  it('takes an avatar letter from the first source that has a letter or digit', () => {
    expect(initialOf('zed.ana@example.com', 'Ana')).toBe('Z');
    expect(initialOf(undefined, 'ana')).toBe('A');
    expect(initialOf('_9@example.com')).toBe('9');
    expect(initialOf(undefined, '  ', '')).toBe('?');
    expect(initialOf('ßen')).toBe('S');
  });

  it('reads one byte range, refuses one past the end and ignores the rest', () => {
    expect(byteRange(undefined, 1000)).toBeUndefined();
    expect(byteRange('bytes=10-19', 1000)).toEqual({ start: 10, end: 19 });
    expect(byteRange('bytes=990-', 1000)).toEqual({ start: 990, end: 999 });
    expect(byteRange('bytes=-5', 1000)).toEqual({ start: 995, end: 999 });
    expect(byteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(byteRange('bytes=99999999999999999999-', 1000)).toBe('unsatisfiable');
    for (const ignored of ['bytes=5-2', 'bytes=0-1,5-6', 'bytes=-', 'items=0-1', 'bytes=a-b', 'bytes = 0-1']) expect(byteRange(ignored, 1000)).toBeUndefined();
  });

  it('counts the team, whoever posted as the token or its person, and verified participants as members', () => {
    const thread = {
      messages: [{ by: { id: 'quest', name: 'Quest 3', user: { id: 'ana', name: 'Ana' } } }, { by: { id: 'legacy-q', name: 'Old Quest' } }],
      participants: [{ email: 'ben@example.com' }],
    } as unknown as Thread;
    expect(isMember(grant('mac', ['read', 'post']), thread)).toBe(true);
    expect(isMember(grant('reader', ['read']), thread)).toBe(true);
    expect(isMember(grant('quest', ['upload']), thread)).toBe(true);
    // Ana's other headset is Ana.
    expect(isMember(grant('quest-2', ['upload'], { user: 'ana' }), thread)).toBe(true);
    const ben = grant('quest-b', ['upload'], { user: 'ben' });
    expect(isMember(ben, thread)).toBe(false);
    expect(isMember(ben, thread, 'ben@example.com')).toBe(true);
    expect(isMember(ben, thread, 'someone@example.com')).toBe(false);
    // Owning the upload is enough to play it: a Meta account linked to a legacy token's recordings.
    const linked = grant('meta-7', ['upload'], { legacyGrantIds: ['legacy-q'] });
    expect(isMember(linked, { ...thread, messages: [] })).toBe(false);
    expect(canPlay(linked, { ...thread, messages: [] }, 'legacy-q')).toBe(true);
    expect(canPlay(linked, { ...thread, messages: [] }, 'someone-else')).toBe(false);
    expect(canPlay(linked, { ...thread, messages: [] }, undefined)).toBe(false);
  });
});

describe('participants and hiding in the thread store', () => {
  const projects = parseProjects(PROJECTS), users = parseUsers(USERS);
  const team = grant('mac', ['read', 'post'], { label: 'Mac', user: 'robin' });
  const ana = grant('quest', ['upload'], { label: 'Quest 3', user: 'ana' });
  const member = () => true;

  it('names people by address, and tells the feed how many but never who', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'people-threads-'));
    const threads = new ThreadStore(dir, projects, users);
    await threads.create(team, { project: 'MUS', title: 'Menu', text: 'Try it' });
    let t = await threads.participants(team, 'MUS-1', { add: [' Friend@Example.com ', 'pal@example.org', 'friend@example.com'], remove: [] }, member);
    expect(t.participants).toEqual([
      { email: 'friend@example.com', addedBy: expect.objectContaining({ id: 'mac', display: 'Robin · Mac' }), addedAt: expect.any(String) },
      { email: 'pal@example.org', addedBy: expect.objectContaining({ id: 'mac' }), addedAt: expect.any(String) },
    ]);
    expect(lastActivity(t).text).toBe('added 2 people');
    // Adding one already there and removing one who is not changes nothing, so nothing is written or heard.
    const seq = t.seq, last = await threads.lastEventId();
    t = await threads.participants(team, 'MUS-1', { add: ['FRIEND@example.com'], remove: ['nobody@example.com'] }, member);
    expect([t.seq, await threads.lastEventId()]).toEqual([seq, last]);
    t = await threads.participants(team, 'MUS-1', { add: [], remove: ['pal@example.org'] }, member);
    expect(lastActivity(t).text).toBe('removed 1 person');
    t = await threads.participants(team, 'MUS-1', { add: ['new@example.net'], remove: ['friend@example.com'] }, member);
    expect(lastActivity(t).text).toBe('added 1 person and removed 1 person');
    t = await threads.participants(team, 'MUS-1', { add: [], remove: ['new@example.net'] }, member);
    // An empty list is not written, so the file reads as it did before participants existed.
    expect(t.participants).toBeUndefined();
    expect(await readFile(join(dir, 'MUS-1.json'), 'utf8')).not.toContain('participants');
    expect((await threads.eventsAfter(team, 0)).filter(e => e.kind === 'people').map(e => [e.added, e.removed])).toEqual([[2, undefined], [undefined, 1], [1, 1], [undefined, 1]]);
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain('@');

    await expect(threads.participants(team, 'MUS-1', { add: ['a@example.com'], remove: ['A@example.com'] }, member)).rejects.toMatchObject({ status: 400, message: 'remove.0: also in add' });
    const bad = threads.participants(team, 'MUS-1', { add: ['ok@example.com', 'robin at home'], remove: [] }, member);
    await expect(bad).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/^add\.1: not an email address/) });
    await expect(bad).rejects.toMatchObject({ message: expect.not.stringContaining('robin at home') });
    await expect(threads.participants(ana, 'MUS-1', { add: ['x@example.com'], remove: [] }, () => false)).rejects.toMatchObject({ status: 403, extra: { reason: 'not_member' } });
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => `p${from + i}@example.com`);
    await threads.participants(team, 'MUS-1', { add: many(0, 50), remove: [] }, member);
    await expect(threads.participants(team, 'MUS-1', { add: many(50, 1), remove: [] }, member)).rejects.toMatchObject({ status: 400, message: 'a thread has at most 50 participants' });
  });

  it('hides a thread from one token until someone else does something in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'people-hide-'));
    const threads = new ThreadStore(dir, projects, users);
    await threads.create(team, { project: 'MUS', title: 'Menu', text: 'Try it' });
    const last = await threads.lastEventId();
    let t = await threads.hide(ana, 'MUS-1');
    expect([t.seq, t.hiddenFor, await threads.lastEventId()]).toEqual([1, { quest: 1 }, last]);
    expect([hidden(t, 'quest'), hidden(t, 'mac')]).toEqual([true, false]);
    t = await threads.react(ana, 'MUS-1', 1, 'heart');
    expect(hidden(t, 'quest')).toBe(true);
    t = await threads.post(team, 'MUS-1', { text: 'Another go?' });
    expect(hidden(t, 'quest')).toBe(false);
    t = await threads.hide(ana, 'MUS-1');
    t = await threads.unhide(ana, 'MUS-1');
    expect(t.hiddenFor).toBeUndefined();
    expect(await readFile(join(dir, 'MUS-1.json'), 'utf8')).not.toContain('hiddenFor');
  });
});

describe('people, participants, hiding and playback on the receiver', () => {
  const mac = newToken(), ana = newToken(), ben = newToken(), reader = newToken(), ci = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest', sha256: ana.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ana' },
    // Ben's headset sees Marimba's threads too, but has not posted in them.
    { id: 'quest-b', sha256: ben.sha256, scopes: ['upload'], label: 'Quest Pro', user: 'ben' },
    { id: 'reader', sha256: reader.sha256, scopes: ['read'] },
    { id: 'ci', sha256: ci.sha256, scopes: ['post'], label: 'CI' },
  ]);
  const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  let base: string; let close: () => Promise<void>; let server: Awaited<ReturnType<typeof testCli>>; let uploads: UploadStore;
  let sessions = 0, bundles = 0;

  beforeAll(async () => {
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, reports: 'CAP' });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    uploads = new UploadStore(server.config.uploads);
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    const raw = Buffer.from(await response.arrayBuffer());
    let json: Record<string, any> | undefined;
    try { json = JSON.parse(raw.toString('utf8')); } catch { json = undefined; }
    return { status: response.status, headers: response.headers, raw, json: json as Record<string, any> };
  };

  /** A recording as the headset creates it: in a thread, with no bytes sent, so the worker leaves it be. */
  const record = async (token: string, thread: unknown, bytes = VIDEO.length) => {
    const created = await call('POST', '/v1/uploads', token, {
      clientId: `c${++sessions}`, bytes, sha256: createHash('sha256').update(String(sessions)).digest('hex'), fileName: 'clip.mp4',
      recordedAt: '2026-10-12T10:00:00+01:00', audioTracks: ['mic'], ...(thread ? { thread } : {}),
    });
    expect(created.status).toBe(201);
    const stored = (await uploads.get(created.json.id))!;
    return { id: stored.id, key: stored.threadKey!, message: stored.threadMessage! };
  };

  /** A bundle as the worker leaves it, words and all; without a video, as words first leaves it. */
  const bundle = async (uploadId: string, options: { video?: Buffer; bytes?: number; summary?: string; status?: 'ready' | 'uploading'; opened?: Opened[]; media?: string } = {}) => {
    const id = `2026-10-12T10-00-${String(++bundles).padStart(2, '0')}_capture`;
    const dir = sessionDir(server.config, id);
    const manifest: SessionManifest = {
      version: 1, id, title: id, createdAt: new Date().toISOString(), recordedAt: '2026-10-12T09:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId, clientId: 'c', originalName: 'clip.mp4', bytes: options.bytes ?? options.video?.length ?? VIDEO.length, sha256: 'a'.repeat(64), audioTracks: ['mic'], ...(options.opened ? { opened: options.opened } : {}) },
      media: { video: options.media ?? 'video.mp4', durationMs: 6000 },
      steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      ...(options.summary ? { summary: { title: 'Menu too small', text: options.summary, model: 'claude-haiku-4-5' } } : {}),
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
    };
    await saveSession(dir, manifest);
    await writeJsonAtomic(join(dir, 'transcript.json'), { version: 1, engine: 'test', segments: [
      { startMs: 0, endMs: 1200, text: 'This menu is broken.', words: [{ text: 'This', startMs: 0, endMs: 200 }] },
      { startMs: 1200, endMs: 2400, text: 'Make it bigger.' },
    ] });
    await writeJsonAtomic(join(dir, 'markers.json'), { version: 1, markers: [{ atMs: 1000, endMs: 1200, kind: 'bug', cue: 'broken', text: 'This menu is broken.' }] });
    await writeJsonAtomic(join(dir, 'requests.json'), { version: 1, model: 'claude-haiku-4-5', requests: [{ atMs: 1500, text: 'Make the menu bigger.' }] });
    if (options.video) await writeFile(join(dir, 'video.mp4'), options.video, { mode: 0o600 });
    await uploads.update(uploadId, { status: options.status ?? 'ready', sessionId: id });
    return dir;
  };

  it('tells a token who it is, and keeps the address its person gives, unverified and unlogged', async () => {
    expect((await call('GET', '/v1/me', ana.token)).json).toEqual({ me: 'quest', device: 'Quest 3', expiresAt: null, person: { id: 'ana', name: 'Ana', emailVerified: false, initial: 'A' } });
    expect((await call('GET', '/v1/me', reader.token)).json).toEqual({ me: 'reader', device: null, expiresAt: null, person: { id: 'reader', name: 'reader', emailVerified: false, initial: 'R' } });
    expect((await call('GET', '/v1/me', mac.token)).json.person).toEqual({ id: 'robin', name: 'Robin', colour: '#d93a2b', emailVerified: false, initial: 'R' });
    expect((await call('GET', '/v1/me')).status).toBe(401);

    const set = await call('POST', '/v1/me', ana.token, { email: ' Zed.Ana@Example.COM ' });
    expect(set.status).toBe(200);
    expect(set.json.person).toEqual({ id: 'ana', name: 'Ana', email: 'zed.ana@example.com', emailVerified: false, initial: 'Z' });
    const file = join(server.config.root, 'people.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, emails: { ana: { email: 'zed.ana@example.com', setAt: expect.any(String), verified: false } } });

    for (const email of ['ana at home', 'a@b', `${'x'.repeat(250)}@example.com`, '', 'a@@example.com']) {
      const refused = await call('POST', '/v1/me', ana.token, { email });
      expect(refused.status).toBe(400);
      if (email) expect(refused.json.error).not.toContain(email);
    }
    expect((await call('POST', '/v1/me', ana.token, { email: 'a@example.com', name: 'x' })).status).toBe(400);
    expect((await call('POST', '/v1/me', ana.token, {})).status).toBe(400);
    expect((await call('POST', '/v1/me', reader.token, { email: 'r@example.com' })).status).toBe(403);

    // The same address again keeps it verified (2026-11-10; before, it undid a Google-verified one); another is not.
    await writeJsonAtomic(file, { version: 1, emails: { ana: { email: 'zed.ana@example.com', setAt: '2026-10-12T00:00:00.000Z', verified: true } } });
    expect((await call('GET', '/v1/me', ana.token)).json.person.emailVerified).toBe(true);
    expect((await call('POST', '/v1/me', ana.token, { email: 'zed.ana@example.com' })).json.person.emailVerified).toBe(true);
    expect((await call('POST', '/v1/me', ana.token, { email: 'other.ana@example.com' })).json.person.emailVerified).toBe(false);
    expect((await call('POST', '/v1/me', ana.token, { email: 'zed.ana@example.com' })).json.person.emailVerified).toBe(false);

    const cleared = await call('POST', '/v1/me', ana.token, { email: null });
    expect(cleared.json.person).toEqual({ id: 'ana', name: 'Ana', emailVerified: false, initial: 'A' });
    expect((await call('POST', '/v1/me', ana.token, { email: null })).status).toBe(200);
    expect(server.lines.join('\n')).not.toContain('zed.ana');
    // A damaged file is an error, never nobody's address.
    await writeFile(file, '{"version":1,"emails":{"ana":{"email":"nope"}}}');
    expect((await call('GET', '/v1/me', ana.token)).status).toBe(500);
    await writeJsonAtomic(file, { version: 1, emails: {} });
  });

  it('names participants for members, shows addresses only to members, and keeps them out of the feed', async () => {
    expect((await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Menu', text: 'Is the menu easier to find?' })).json.key).toBe('MUS-1');
    expect(await record(ana.token, { key: 'MUS-1' })).toMatchObject({ key: 'MUS-1', message: 2 });
    // An agent on Robin's token is Robin; a token with no person is its label.
    await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'Thanks, looking now', as: 'Opus 5.5' });
    await call('POST', '/v1/threads/MUS-1/messages', ci.token, { text: 'Build 18 is up' });
    await call('POST', '/v1/me', ana.token, { email: 'ana@example.com' });
    await call('POST', '/v1/me', mac.token, { email: 'robin@example.com' });

    const before = (await call('GET', '/v1/events', mac.token)).json.last as number;
    const added = await call('POST', '/v1/threads/MUS-1/participants', ana.token, { add: ['Friend@Example.com', 'pal@example.org'] });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ member: true, canPlay: true, participantCount: 2 });
    expect(added.json.participants).toEqual([
      { email: 'friend@example.com', addedBy: 'Ana · Quest 3', addedAt: expect.any(String), emailed: false, emailNote: 'this receiver does not send email' },
      { email: 'pal@example.org', addedBy: 'Ana · Quest 3', addedAt: expect.any(String), emailed: false, emailNote: 'this receiver does not send email' },
    ]);
    expect(added.json.people).toEqual([
      { name: 'Robin', initial: 'R', colour: '#d93a2b', email: 'robin@example.com' },
      { name: 'Ana', initial: 'A', email: 'ana@example.com' },
      { name: 'CI', initial: 'C' },
      { name: 'friend@example.com', initial: 'F', invited: true, email: 'friend@example.com' },
      { name: 'pal@example.org', initial: 'P', invited: true, email: 'pal@example.org' },
    ]);

    // Ben sees the thread through its project, but is not in it: no addresses at all, and he cannot change who is.
    const seen = await call('GET', '/v1/threads/MUS-1', ben.token);
    expect(seen.json).toMatchObject({ member: false, canPlay: false, participantCount: 2 });
    expect(seen.json.participants).toBeUndefined();
    expect(seen.json.people).toEqual([
      { name: 'Robin', initial: 'R', colour: '#d93a2b' }, { name: 'Ana', initial: 'A' }, { name: 'CI', initial: 'C' },
      { name: 'Invited', initial: '?', invited: true }, { name: 'Invited', initial: '?', invited: true },
    ]);
    expect(seen.json.messages[1].recording.canPlay).toBe(false);
    expect(seen.raw.toString()).not.toContain('@');
    expect((await call('GET', '/v1/threads', ben.token)).raw.toString()).not.toContain('@');
    const refused = await call('POST', '/v1/threads/MUS-1/participants', ben.token, { add: ['x@example.com'] });
    expect([refused.status, refused.json.reason]).toEqual([403, 'not_member']);

    // The feed and the inbox line say how many, never who.
    const events = (await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[];
    expect(events).toEqual([expect.objectContaining({ kind: 'people', thread: 'MUS-1', added: 2, by: expect.objectContaining({ id: 'quest' }) })]);
    expect(JSON.stringify(events)).not.toContain('@');
    expect(await readFile(join(server.config.threadsDir, 'events.jsonl'), 'utf8')).not.toContain('@');
    expect((await call('GET', '/v1/threads', mac.token)).json.threads.find((t: { key: string }) => t.key === 'MUS-1').last.text).toBe('added 2 people');

    // The same again is no change: no event.
    const last = (await call('GET', '/v1/events', mac.token)).json.last;
    expect((await call('POST', '/v1/threads/MUS-1/participants', ana.token, { add: ['friend@example.com'], remove: ['gone@example.com'] })).status).toBe(200);
    expect((await call('GET', '/v1/events', mac.token)).json.last).toBe(last);

    const bad = await call('POST', '/v1/threads/MUS-1/participants', ana.token, { add: ['ok@example.com', 'robin at home'] });
    expect([bad.status, bad.json.error]).toEqual([400, 'add.1: not an email address, which looks like name@example.com']);
    for (const body of [{}, { add: [] }, { add: [], remove: [] }, { add: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }, { add: 'a@example.com' }, { add: ['a@example.com'], extra: 1 }]) {
      expect((await call('POST', '/v1/threads/MUS-1/participants', ana.token, body)).status).toBe(400);
    }
    expect((await call('POST', '/v1/threads/MUS-1/participants', reader.token, { add: ['a@example.com'] })).status).toBe(403);

    // A report has no participants; its sender cannot even find it.
    const report = await record(ana.token, { report: true });
    expect(report.key).toBe('CAP-1');
    const onReport = await call('POST', '/v1/threads/CAP-1/participants', mac.token, { add: ['a@example.com'] });
    expect([onReport.status, onReport.json.error]).toEqual([400, 'a report has no participants']);
    expect((await call('POST', '/v1/threads/CAP-1/participants', ana.token, { add: ['a@example.com'] })).status).toBe(404);

    // A participant whose own address is verified is a member; here the file by hand (Google sign-in or a confirmed link do it for real).
    const people = join(server.config.root, 'people.json');
    const emails = JSON.parse(await readFile(people, 'utf8'));
    await writeJsonAtomic(people, { ...emails, emails: { ...emails.emails, ben: { email: 'pal@example.org', setAt: '2026-10-12T00:00:00.000Z', verified: true } } });
    const verified = await call('GET', '/v1/threads/MUS-1', ben.token);
    expect(verified.json).toMatchObject({ member: true, canPlay: true, participantCount: 2, messages: [{}, { recording: { canPlay: true } }, {}, {}] });
    expect(verified.json.participants).toHaveLength(2);
    expect(verified.json.people.map((p: { name: string }) => p.name)).toEqual(['Robin', 'Ana', 'CI', 'friend@example.com', 'pal@example.org']);
    // The same address again keeps it verified (2026-11-10); another address is unverified, and no longer a member.
    await call('POST', '/v1/me', ben.token, { email: 'pal@example.org' });
    expect((await call('GET', '/v1/threads/MUS-1', ben.token)).json.member).toBe(true);
    await call('POST', '/v1/me', ben.token, { email: 'ben@example.org' });
    expect((await call('GET', '/v1/threads/MUS-1', ben.token)).json.member).toBe(false);
  });

  it('lists each thread with its people, a snippet and when its last message came', async () => {
    const opened = await record(ana.token, undefined);
    expect(opened.key).toBe('MUS-2');
    const list = async (token = ana.token) => (await call('GET', '/v1/threads', token)).json.threads as Record<string, any>[];
    const find = async (key: string, token?: string) => (await list(token)).find(t => t.key === key)!;
    // A recording with no summary yet: what happened last.
    expect(await find('MUS-2')).toMatchObject({ snippet: 'sent a recording', peopleCount: 1, people: [{ name: 'Ana', initial: 'A', email: 'ana@example.com' }] });
    await bundle(opened.id, { summary: 'Finds   the menu\n too small to read.' });
    expect((await find('MUS-2')).snippet).toBe('Finds the menu too small to read.');

    const thread = (await call('GET', '/v1/threads/MUS-1', ana.token)).json;
    expect(await find('MUS-1')).toMatchObject({ snippet: 'Build 18 is up', peopleCount: 5, lastMessageAt: thread.messages.at(-1).at });
    expect((await find('MUS-1')).people).toHaveLength(5);
    const long = `${'word '.repeat(60)}\n\nend`;
    await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: long });
    const after = await find('MUS-1');
    expect(after.snippet).toBe(long.replace(/\s+/g, ' ').slice(0, 200));
    expect(after.lastMessageAt > thread.messages.at(-1).at).toBe(true);
    // Six faces at most, with the count beside them.
    await call('POST', '/v1/threads/MUS-1/participants', mac.token, { add: ['c@example.com', 'd@example.com'] });
    const crowded = await find('MUS-1', mac.token);
    expect([crowded.peopleCount, crowded.people.length]).toEqual([7, 6]);
  });

  it('hides a thread from one inbox until someone else adds to it', async () => {
    const before = (await call('GET', '/v1/threads', ana.token)).json;
    expect(before.threads.map((t: { key: string }) => t.key)).toContain('MUS-1');
    const lastEvent = (await call('GET', '/v1/events', mac.token)).json.last;
    const seq = (await call('GET', '/v1/threads/MUS-1', ana.token)).json.seq;

    const hid = await call('POST', '/v1/threads/MUS-1/hide', ana.token);
    expect(hid.status).toBe(200);
    expect(hid.json).toMatchObject({ hidden: true, seq });
    expect((await call('GET', '/v1/events', mac.token)).json.last).toBe(lastEvent);
    const inbox = (await call('GET', '/v1/threads', ana.token)).json;
    expect(inbox.threads.map((t: { key: string }) => t.key)).not.toContain('MUS-1');
    expect(inbox.unread).toBe(before.unread - 1);
    // Still there by key, and for everyone else.
    expect((await call('GET', '/v1/threads/MUS-1', ana.token)).json.hidden).toBe(true);
    expect((await call('GET', '/v1/threads', mac.token)).json.threads.map((t: { key: string }) => t.key)).toContain('MUS-1');
    expect((await call('GET', '/v1/threads/MUS-1', mac.token)).json.hidden).toBeUndefined();

    // Ana's own doing does not bring it back; someone else's does.
    await call('POST', '/v1/threads/MUS-1/reactions', ana.token, { message: 1, reaction: 'heart' });
    expect((await call('GET', '/v1/threads', ana.token)).json.threads.map((t: { key: string }) => t.key)).not.toContain('MUS-1');
    await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'One more thing' });
    const back = (await call('GET', '/v1/threads', ana.token)).json.threads.find((t: { key: string }) => t.key === 'MUS-1');
    expect(back).toMatchObject({ unread: true, snippet: 'One more thing' });

    await call('POST', '/v1/threads/MUS-1/hide', ana.token);
    const unhid = await call('POST', '/v1/threads/MUS-1/unhide', ana.token);
    expect(unhid.json.hidden).toBeUndefined();
    expect((await call('GET', '/v1/threads', ana.token)).json.threads.map((t: { key: string }) => t.key)).toContain('MUS-1');
    expect(await readFile(join(server.config.threadsDir, 'MUS-1.json'), 'utf8')).not.toContain('hiddenFor');
    // Any token may tidy its own inbox.
    expect((await call('POST', '/v1/threads/MUS-1/hide', reader.token)).status).toBe(200);
    expect((await call('POST', '/v1/threads/MUS-1/unhide', reader.token)).status).toBe(200);
    expect((await call('POST', '/v1/threads/MUS-1/hide')).status).toBe(401);
  });

  it('closes and reopens a thread with POST, for proxies that pass nothing else', async () => {
    const closed = await call('POST', '/v1/threads/MUS-2/state', ana.token, { state: 'closed' });
    expect([closed.status, closed.json.state]).toEqual([200, 'closed']);
    expect((await call('POST', '/v1/threads/MUS-2/state', ana.token, { state: 'open' })).json.state).toBe('open');
    const events = (await call('GET', '/v1/events?after=0&thread=MUS-2', mac.token)).json.events as { kind: string }[];
    expect(events.map(e => e.kind).slice(-2)).toEqual(['closed', 'reopened']);
    expect((await call('POST', '/v1/threads/MUS-2/state', ana.token, { state: 'archived' })).status).toBe(400);
    expect((await call('POST', '/v1/threads/MUS-2/state', reader.token, { state: 'closed' })).status).toBe(403);
  });

  it('plays a recording to its thread\'s members and its owner, with its words and moments', async () => {
    await bundle((await uploads.list()).find(r => r.threadKey === 'MUS-1')!.id, {
      video: VIDEO, summary: 'Finds the menu broken.',
      opened: [{ atMs: 500, what: 'open app com.example.marimba (variant=red)', label: 'Red menu', message: 1, launch: 1 }, { atMs: 2500, what: 'open https://marimba.example/' }],
    });
    const played = await call('GET', '/v1/threads/MUS-1/messages/2/playback', ana.token);
    expect(played.status).toBe(200);
    expect(played.json).toEqual({
      key: 'MUS-1', message: 2, title: 'Menu too small', summary: 'Finds the menu broken.', recordedAt: '2026-10-12T09:00:00.000Z', durationMs: 6000,
      status: 'ready', audioTracks: ['mic'], content: 'video', video: { available: true, bytes: 1000, contentType: 'video/mp4' },
      transcript: [{ startMs: 0, endMs: 1200, text: 'This menu is broken.' }, { startMs: 1200, endMs: 2400, text: 'Make it bigger.' }],
      moments: [
        { atMs: 500, kind: 'opened', text: 'Opened option 2: Red menu' },
        { atMs: 1000, kind: 'bug', text: 'This menu is broken.' },
        { atMs: 1500, kind: 'request', text: 'Make the menu bigger.' },
        { atMs: 2500, kind: 'opened', text: 'Opened https://marimba.example/' },
      ],
    });
    // The team plays it, a read-only token included; Ben, who is not in the thread, does not.
    expect((await call('GET', '/v1/threads/MUS-1/messages/2/playback', mac.token)).status).toBe(200);
    expect((await call('GET', '/v1/threads/MUS-1/messages/2/playback', reader.token)).status).toBe(200);
    const refused = await call('GET', '/v1/threads/MUS-1/messages/2/playback', ben.token);
    expect([refused.status, refused.json.reason]).toEqual([403, 'not_member']);
    expect((await call('GET', '/v1/threads/MUS-1/messages/2/video', ben.token)).status).toBe(403);
    expect((await call('GET', '/v1/threads/MUS-1', ana.token)).json.messages[1].recording.canPlay).toBe(true);

    const notRecording = await call('GET', '/v1/threads/MUS-1/messages/1/playback', ana.token);
    expect([notRecording.status, notRecording.json.reason]).toEqual([404, 'no_recording']);
    for (const id of ['99', '0', 'abc', '1e1']) expect((await call('GET', `/v1/threads/MUS-1/messages/${id}/playback`, ana.token)).status).toBe(404);
    expect((await call('POST', '/v1/threads/MUS-1/messages/2/playback', ana.token, {})).status).toBe(404);

    // Not built yet; then words first (the narration is in, the video is not); then deleted.
    const pending = await record(ana.token, { key: 'MUS-1' });
    for (const what of ['playback', 'video']) {
      const early = await call('GET', `/v1/threads/MUS-1/messages/${pending.message}/${what}`, ana.token);
      expect([early.status, early.json.reason]).toEqual([404, 'not_yet']);
    }
    await bundle(pending.id, { status: 'uploading' });
    const words = await call('GET', `/v1/threads/MUS-1/messages/${pending.message}/playback`, ana.token);
    expect(words.json).toMatchObject({ status: 'uploading', video: { available: false }, transcript: [{ text: 'This menu is broken.' }, { text: 'Make it bigger.' }] });
    const noVideo = await call('GET', `/v1/threads/MUS-1/messages/${pending.message}/video`, ana.token);
    expect([noVideo.status, noVideo.json.reason]).toEqual([404, 'not_yet']);
    await uploads.update(pending.id, { status: 'deleted' });
    const gone = await call('GET', `/v1/threads/MUS-1/messages/${pending.message}/playback`, ana.token);
    expect([gone.status, gone.json.reason]).toEqual([404, 'deleted']);

    // A damaged file is an error, not an empty list.
    const damaged = await record(ana.token, { key: 'MUS-1' });
    const dir = await bundle(damaged.id);
    await writeFile(join(dir, 'markers.json'), '{"version":1,"markers":[{"atMs":"soon"}]}');
    expect((await call('GET', `/v1/threads/MUS-1/messages/${damaged.message}/playback`, ana.token)).status).toBe(500);

    // A manifest that names a file outside the session is no video at all.
    const escaping = await record(ana.token, { key: 'MUS-1' });
    await bundle(escaping.id, { media: '../people.json' });
    expect((await call('GET', `/v1/threads/MUS-1/messages/${escaping.message}/playback`, ana.token)).json.video).toEqual({ available: false });
    expect((await call('GET', `/v1/threads/MUS-1/messages/${escaping.message}/video`, ana.token)).status).toBe(404);

    // A report plays for the team alone: its sender's token cannot find the thread.
    const report = (await uploads.list()).find(r => r.threadKey === 'CAP-1')!;
    await bundle(report.id, { video: VIDEO });
    expect((await call('GET', '/v1/threads/CAP-1/messages/1/playback', ana.token)).status).toBe(404);
    expect((await call('GET', '/v1/threads/CAP-1/messages/1/video', ana.token)).status).toBe(404);
    expect((await call('GET', '/v1/threads/CAP-1/messages/1/playback', mac.token)).status).toBe(200);
  });

  it('streams the video whole or in one byte range, and HEAD says how big it is', async () => {
    const path = '/v1/threads/MUS-1/messages/2/video';
    const whole = await call('GET', path, ana.token);
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(['accept-ranges', 'content-type', 'content-length', 'cache-control'].map(h => [h, whole.headers.get(h)])))
      .toEqual({ 'accept-ranges': 'bytes', 'content-type': 'video/mp4', 'content-length': '1000', 'cache-control': 'private, no-store' });
    expect(whole.raw.equals(VIDEO)).toBe(true);

    const ranges: [string, string, number, number][] = [['bytes=10-19', 'bytes 10-19/1000', 10, 20], ['bytes=990-', 'bytes 990-999/1000', 990, 1000], ['bytes=-5', 'bytes 995-999/1000', 995, 1000], ['bytes=0-99999', 'bytes 0-999/1000', 0, 1000]];
    for (const [range, says, from, to] of ranges) {
      const part = await call('GET', path, ana.token, undefined, { range });
      expect([part.status, part.headers.get('content-range'), part.headers.get('content-length'), part.headers.get('accept-ranges')]).toEqual([206, says, String(to - from), 'bytes']);
      expect(part.raw.equals(VIDEO.subarray(from, to))).toBe(true);
    }
    for (const range of ['bytes=1000-', 'bytes=-0']) {
      const none = await call('GET', path, ana.token, undefined, { range });
      expect([none.status, none.headers.get('content-range')]).toEqual([416, 'bytes */1000']);
    }
    for (const range of ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-1']) {
      const all = await call('GET', path, ana.token, undefined, { range });
      expect([all.status, all.raw.length]).toEqual([200, 1000]);
    }

    const head = await call('HEAD', path, ana.token);
    expect([head.status, head.headers.get('content-length'), head.headers.get('accept-ranges'), head.raw.length]).toEqual([200, '1000', 'bytes', 0]);
    const headRange = await call('HEAD', path, ana.token, undefined, { range: 'bytes=0-9' });
    expect([headRange.status, headRange.headers.get('content-range'), headRange.headers.get('content-length'), headRange.raw.length]).toEqual([206, 'bytes 0-9/1000', '10', 0]);
    expect((await call('HEAD', path, ben.token)).status).toBe(403);
    expect((await call('GET', path, mac.token)).raw.equals(VIDEO)).toBe(true);
  });

  it('lets a player go away mid-video without an error', async () => {
    const errors = () => server.lines.filter(line => line.startsWith('error')).length;
    const before = errors();
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    const take = await record(ana.token, { key: 'MUS-1' }, big.length);
    await bundle(take.id, { video: big });
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/threads/MUS-1/messages/${take.message}/video`, { headers: { authorization: `Bearer ${ana.token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect.poll(() => server.lines.some(line => line.startsWith(`GET /v1/threads/MUS-1/messages/${take.message}/video 200`))).toBe(true);
    expect(errors()).toBe(before);
    expect((await call('GET', '/v1/threads/MUS-1/messages/2/video', ana.token, undefined, { range: 'bytes=0-0' })).status).toBe(206);
  });
});

describe('thread-scoped testers on the receiver: members by person id (2026-10-21)', () => {
  const mac = newToken(), quest = newToken(), ana = newToken(), ben = newToken(), anaAgent = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'robin' },
    // Two people outside the team, as a headset token each, and Ana's own agent.
    { id: 'ana-quest', sha256: ana.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ana', projects: ['MUS'], threads: 'member' },
    { id: 'ben-quest', sha256: ben.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ben', projects: ['MUS'], threads: 'member' },
    { id: 'ana-agent', sha256: anaAgent.sha256, scopes: ['read', 'post'], label: "Ana's Mac", user: 'ana', projects: ['MUS'], threads: 'member' },
  ]);
  const VIDEO = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 251));
  const glb = makeGlb();
  const glbSha = createHash('sha256').update(glb).digest('hex');
  let base: string; let close: () => Promise<void>; let server: Awaited<ReturnType<typeof testCli>>; let uploads: UploadStore;
  let clients = 0, bundles = 0;

  beforeAll(async () => {
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, reports: 'CAP' });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    uploads = new UploadStore(server.config.uploads);
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}) },
    });
    const raw = await response.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(raw); } catch { /* a video or a model */ }
    return { status: response.status, json, raw };
  };
  const record = async (token: string, thread?: unknown) => {
    const created = await call('POST', '/v1/uploads', token, {
      clientId: `s${++clients}`, bytes: VIDEO.length, sha256: createHash('sha256').update(`s${clients}`).digest('hex'), fileName: 'clip.mp4',
      recordedAt: '2026-10-21T10:00:00+01:00', audioTracks: ['mic'], ...(thread ? { thread } : {}),
    });
    if (created.status !== 201) return { status: created.status, json: created.json };
    const stored = (await uploads.get(created.json.id))!;
    // The bundle as the worker leaves it, so the recording plays.
    const id = `2026-10-21T10-00-${String(++bundles).padStart(2, '0')}_capture`;
    const dir = sessionDir(server.config, id);
    await saveSession(dir, {
      version: 1, id, title: id, createdAt: new Date().toISOString(), recordedAt: '2026-10-21T09:00:00.000Z', recordedAtSource: 'argument',
      source: { kind: 'upload', uploadId: stored.id, clientId: stored.clientId, originalName: 'clip.mp4', bytes: VIDEO.length, sha256: 'a'.repeat(64), audioTracks: ['mic'] },
      media: { video: 'video.mp4', durationMs: 2000 }, steps: Object.fromEntries(STEP_NAMES.map(name => [name, { status: 'done' }])) as SessionManifest['steps'],
      tool: { name: TOOL_NAME, version: TOOL_VERSION },
    });
    await writeFile(join(dir, 'video.mp4'), VIDEO, { mode: 0o600 });
    await uploads.update(stored.id, { status: 'ready', sessionId: id });
    return { status: 201, json: created.json, key: stored.threadKey!, message: stored.threadMessage! };
  };
  const keys = async (token: string) => ((await call('GET', '/v1/threads', token)).json.threads as { key: string }[]).map(t => t.key).sort();
  /** Every way into a thread a token is not in: each is the 404 a thread that does not exist gets. */
  const shut = async (token: string, key: string) => {
    const missing = await call('GET', '/v1/threads/MUS-99', token);
    const got = await call('GET', `/v1/threads/${key}`, token);
    expect([got.status, got.json.error?.replace(key, 'KEY')]).toEqual([404, missing.json.error.replace('MUS-99', 'KEY')]);
    for (const [method, path, body] of [
      ['GET', `/v1/threads/${key}/messages/2/playback`], ['GET', `/v1/threads/${key}/messages/2/video`], ['HEAD', `/v1/threads/${key}/messages/2/video`],
      ['GET', `/v1/threads/${key}/models/${glbSha}`],
      ['POST', `/v1/threads/${key}/reactions`, { message: 1, reaction: 'heart' }], ['POST', `/v1/threads/${key}/picks`, { message: 1, launch: 0 }],
      ['POST', `/v1/threads/${key}/state`, { state: 'closed' }], ['POST', `/v1/threads/${key}/read`, { seq: 1 }],
      ['POST', `/v1/threads/${key}/participants`, { add: ['x@example.com'] }],
    ] as const) expect([method, path, (await call(method, path, token, body)).status]).toEqual([method, path, 404]);
    // An agent's token has no upload scope to record with at all.
    expect((await record(token, { key })).status).toBe(token === anaAgent.token ? 403 : 404);
    expect(((await call('GET', '/v1/events?after=0', token)).json.events as { thread: string }[]).filter(e => e.thread === key)).toEqual([]);
  };

  it('keeps each tester to their own threads, and gives them a thread when the team adds them', async () => {
    expect((await call('PUT', `/v1/projects/MUS/models/${glbSha}`, mac.token, glb)).status).toBe(201);
    const opened = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Team only', text: 'Which chair?', launches: [
      { label: 'Oak', steps: [{ do: 'model', sha256: glbSha, name: 'oak.glb', bytes: glb.length }] }, { label: 'Pine', steps: [{ do: 'model', sha256: glbSha, name: 'pine.glb', bytes: glb.length }] },
    ] });
    expect(opened.json.key).toBe('MUS-1');
    expect(await record(quest.token, { key: 'MUS-1' })).toMatchObject({ key: 'MUS-1', message: 2 });
    // Each tester records with no thread open: a thread of their own, which the other cannot find.
    expect(await record(ana.token)).toMatchObject({ key: 'MUS-2', message: 1 });
    expect(await record(ben.token)).toMatchObject({ key: 'MUS-3', message: 1 });
    expect(await keys(ana.token)).toEqual(['MUS-2']);
    expect(await keys(anaAgent.token)).toEqual(['MUS-2']);
    expect(await keys(ben.token)).toEqual(['MUS-3']);
    expect(await keys(mac.token)).toEqual(['MUS-1', 'MUS-2', 'MUS-3']);
    expect(await keys(quest.token)).toEqual(['MUS-1', 'MUS-2', 'MUS-3']);
    for (const key of ['MUS-1', 'MUS-3']) await shut(ana.token, key);
    await shut(ben.token, 'MUS-2');
    await shut(anaAgent.token, 'MUS-1');
    expect((await call('POST', '/v1/threads/MUS-1/messages', anaAgent.token, { text: 'hello' })).status).toBe(404);
    // The inbox's people and snippet say nothing of threads it cannot see.
    expect((await call('GET', '/v1/threads', ana.token)).raw).not.toContain('Which chair');

    // Only the team adds people, by an id the receiver knows.
    const notTeam = await call('POST', '/v1/threads/MUS-2/members', anaAgent.token, { add: ['ben'] });
    expect([notTeam.status, notTeam.json.reason]).toEqual([403, 'not_team']);
    expect((await call('POST', '/v1/threads/MUS-3/members', anaAgent.token, { add: ['ana'] })).status).toBe(404);
    // An upload token may manage a thread in a project of its person's own (2026-11-13); one it cannot see is the usual 404.
    expect((await call('POST', '/v1/threads/MUS-1/members', ana.token, { add: ['ana'] })).status).toBe(404);
    const unknown = await call('POST', '/v1/threads/MUS-1/members', mac.token, { add: ['ana', 'nobody'] });
    expect([unknown.status, unknown.json.error]).toEqual([400, expect.stringMatching(/^add\.1: nobody on this receiver has that person id/)]);
    for (const body of [{}, { add: [] }, { add: ['has space'] }, { add: ['ana'], extra: 1 }]) expect((await call('POST', '/v1/threads/MUS-1/members', mac.token, body)).status).toBe(400);
    const added = await call('POST', '/v1/threads/MUS-1/members', mac.token, { add: ['Ana'] });
    expect(added.status).toBe(200);
    expect(added.json.members).toEqual([{ person: 'ana', name: 'Ana', addedBy: 'Robin · Mac', addedAt: expect.any(String) }]);
    expect(added.json.people.map((p: { name: string }) => p.name)).toEqual(['Robin', 'Ana']);

    // Ana's headset and agent now reach MUS-1, from when she was added (2026-11-12): nothing before it, by any
    // route, each the 404 a message that does not exist gets.
    expect(await keys(ana.token)).toEqual(['MUS-1', 'MUS-2']);
    const seen = await call('GET', '/v1/threads/MUS-1', ana.token);
    expect(seen.json).toMatchObject({ member: true, canPlay: true, messages: [] });
    expect(seen.json.members).toBeUndefined();
    expect(seen.raw).not.toContain('Which chair');
    expect((await call('GET', '/v1/threads', ana.token)).raw).not.toContain('Which chair');
    for (const [method, path, body] of [
      ['GET', '/v1/threads/MUS-1/messages/2/playback'], ['GET', '/v1/threads/MUS-1/messages/2/video'], ['GET', `/v1/threads/MUS-1/models/${glbSha}`],
      ['POST', '/v1/threads/MUS-1/reactions', { message: 1, reaction: 'heart' }], ['POST', '/v1/threads/MUS-1/picks', { message: 1, launch: 1 }],
    ] as const) expect([method, path, (await call(method, path, ana.token, body)).status]).toEqual([method, path, 404]);
    expect((await call('GET', '/v1/threads/MUS-1/messages/2/playback', ana.token)).json.error).toBe((await call('GET', '/v1/threads/MUS-1/messages/99/playback', ana.token)).json.error.replace('99', '2'));
    expect((await record(ana.token, { key: 'MUS-1', replyTo: { message: 1, launch: 0 } })).status).toBe(400);
    expect(((await call('GET', '/v1/events?after=0', anaAgent.token)).json.events as { thread: string; kind: string }[]).filter(e => e.thread === 'MUS-1').map(e => e.kind)).toEqual(['people']);
    // What comes after is hers: read, play, fetch its model, record, react and pick; Ben still cannot.
    expect((await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'Ana, which chair?', launches: [
      { label: 'Oak', steps: [{ do: 'model', sha256: glbSha, name: 'oak.glb', bytes: glb.length }] }, { label: 'Pine', steps: [{ do: 'model', sha256: glbSha, name: 'pine.glb', bytes: glb.length }] },
    ] })).status).toBe(201);
    expect(await record(quest.token, { key: 'MUS-1' })).toMatchObject({ key: 'MUS-1', message: 4 });
    expect((await call('GET', '/v1/threads/MUS-1', ana.token)).json.messages.map((m: { id: number }) => m.id)).toEqual([3, 4]);
    expect((await call('GET', '/v1/threads/MUS-1/messages/4/playback', ana.token)).status).toBe(200);
    const video = await call('GET', '/v1/threads/MUS-1/messages/4/video', ana.token);
    expect([video.status, video.raw.length]).toEqual([200, VIDEO.length]);
    expect((await call('GET', `/v1/threads/MUS-1/models/${glbSha}`, ana.token)).status).toBe(200);
    expect(await record(ana.token, { key: 'MUS-1', replyTo: { message: 3, launch: 0 } })).toMatchObject({ key: 'MUS-1', message: 5 });
    expect((await call('POST', '/v1/threads/MUS-1/reactions', ana.token, { message: 3, reaction: 'heart' })).status).toBe(200);
    expect((await call('POST', '/v1/threads/MUS-1/picks', ana.token, { message: 3, launch: 1 })).status).toBe(200);
    expect((await call('POST', '/v1/threads/MUS-1/messages', anaAgent.token, { text: 'Oak reads better', as: 'Opus 5.5' })).status).toBe(201);
    // The team, and Robin's own headset, still see all of it.
    expect((await call('GET', '/v1/threads/MUS-1', mac.token)).json.messages.map((m: { id: number }) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await call('GET', '/v1/threads/MUS-1', quest.token)).json.messages.map((m: { id: number }) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    await shut(ben.token, 'MUS-1');

    // Out is out: what she posted there does not keep her in.
    const removed = await call('POST', '/v1/threads/MUS-1/members', mac.token, { remove: ['ana'] });
    expect([removed.status, removed.json.members]).toEqual([200, []]);
    expect(await keys(ana.token)).toEqual(['MUS-2']);
    await shut(ana.token, 'MUS-1');
    await shut(anaAgent.token, 'MUS-1');
    // The feed counts, never names.
    const events = (await call('GET', '/v1/events?after=0', mac.token)).json.events as { kind: string; added?: number; removed?: number }[];
    expect(events.filter(e => e.kind === 'people').map(e => [e.added, e.removed])).toEqual([[1, undefined], [undefined, 1]]);
    expect(await readFile(join(server.config.threadsDir, 'events.jsonl'), 'utf8')).not.toContain('"person"');
  });

  it('lets the team choose, when adding someone, whether they see what came before; never a tester (2026-11-12)', async () => {
    const key = (await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Earlier', text: 'Before Ben came' })).json.key as string;
    for (const body of [{ history: 'visible' }, { remove: ['ben'], history: 'visible' }, { add: ['ben'], history: 'sometimes' }]) {
      expect((await call('POST', `/v1/threads/${key}/members`, mac.token, body)).status).toBe(400);
    }
    const added = await call('POST', `/v1/threads/${key}/members`, mac.token, { add: ['ben'], history: 'visible' });
    expect(added.json.members).toEqual([expect.objectContaining({ person: 'ben', history: 'visible' })]);
    expect((await call('GET', `/v1/threads/${key}`, ben.token)).json.messages.map((m: { text?: string }) => m.text)).toEqual(['Before Ben came']);
    // A tester in the thread may copy an address in, but not show it what came before.
    const byBen = await call('POST', `/v1/threads/${key}/participants`, ben.token, { add: ['someone@example.com'], history: 'visible' });
    expect([byBen.status, byBen.json.reason]).toEqual([403, 'not_team']);
    const plain = await call('POST', `/v1/threads/${key}/participants`, ben.token, { add: ['someone@example.com'] });
    expect(plain.status).toBe(200);
    expect(plain.json.participants[0]).not.toHaveProperty('history');
    // Robin's own headset counts as the team; the team sees each choice, a tester never does.
    expect((await call('POST', `/v1/threads/${key}/participants`, quest.token, { add: ['friend@example.com'], history: 'visible' })).status).toBe(200);
    expect((await call('GET', `/v1/threads/${key}`, mac.token)).json.participants.find((p: { email: string }) => p.email === 'friend@example.com')).toMatchObject({ history: 'visible' });
    expect((await call('GET', `/v1/threads/${key}`, ben.token)).raw).not.toContain('"history"');
  });

  it('keeps reports the team\'s, whoever sent them', async () => {
    const report = await record(ana.token, { report: true });
    expect(report).toMatchObject({ key: 'CAP-1' });
    expect(await keys(ana.token)).not.toContain('CAP-1');
    expect((await call('GET', '/v1/threads/CAP-1', anaAgent.token)).status).toBe(404);
    expect((await call('POST', '/v1/threads/CAP-1/members', mac.token, { add: ['ana'] })).status).toBe(400);
    expect((await call('GET', '/v1/threads/CAP-1', mac.token)).status).toBe(200);
  });
});
