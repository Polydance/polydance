/** Threads: the shared format, the receiver's store, its routes with real uploads, and the agent's CLI (docs/THREADS.md). */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { findLink, launchesFrom, link, projectList, threadList, threadNew, threadPending, threadReact, threadReply, threadShow, threadUpdate, threadWatch } from '../src/commands/thread.js';
import { exists } from '../src/fsx.js';
import { sleep } from '../src/fsx.js';
import { loadSession } from '../src/session.js';
import { exec } from '../src/exec.js';
import { show } from '../src/commands/inspect.js';
import { sync } from '../src/commands/sync.js';
import { fresh, isMember, joinedWindow, lastActivity, parseNewMemberHistory, ThreadStore, unread, waiting, type Thread } from '../src/server/threads.js';
import { isTeam, memberScoped, newToken, teamPeople, type Grant } from '../src/server/tokens.js';
import { describeLaunch, displayName, hostMatches, launchProblems, launchSchema, parseProjects, parseUsers, reactionName, threadKey } from '../src/threads.js';
import { tokenNew } from '../src/commands/token.js';
import { launchArgs } from '../src/cli.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { fakeTools, hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', hosts: ['marimba-web-*-yourteam.vercel.app'], packages: ['com.example.marimba'] },
  { key: 'CAP', name: 'Polydance Capture', packages: ['net.polydance.capture'] },
]);
const menu = 'https://marimba-web-k2m7q9x4t-yourteam.vercel.app/';

describe('threads: keys, launches and reactions', () => {
  it('reads thread keys, and bare numbers in a project', () => {
    expect(threadKey('mus-12', undefined)).toBe('MUS-12');
    expect(threadKey('12', 'MUS')).toBe('MUS-12');
    expect(() => threadKey('12', undefined)).toThrow(/needs a project/);
    expect(() => threadKey('MUS-0', 'MUS')).toThrow(/not a thread/);
    expect(() => threadKey('../MUS-1', 'MUS')).toThrow(/not a thread/);
  });

  it('knows the six reactions by name or by emoji', () => {
    expect(reactionName('thumbs-up')).toBe('thumbs-up');
    expect(reactionName('👍')).toBe('thumbs-up');
    expect(reactionName('❤️')).toBe('heart');
    expect(reactionName('❤')).toBe('heart');
    expect(reactionName('‼')).toBe('emphasis');
    expect(reactionName('🎉')).toBeUndefined();
    expect(reactionName('approve')).toBeUndefined();
  });

  it('matches hosts with one star in the first label, and nothing looser', () => {
    // The live patterns, with deployment links of the shape every launch so far has used.
    const viverse = 'marimba-viverse-*-yourteam.vercel.app';
    expect(hostMatches(viverse, 'marimba-viverse-k2m7q9x4t-yourteam.vercel.app')).toBe(true);
    expect(hostMatches(viverse, 'MARIMBA-VIVERSE-P4N8R2W6Z-YOURTEAM.vercel.app')).toBe(true);
    expect(hostMatches('marimba-sdk-previews-*-yourteam.vercel.app', 'marimba-sdk-previews-h3j5l7n9q-yourteam.vercel.app')).toBe(true);
    // A team named evil-yourteam: its deployment, branch and production links.
    expect(hostMatches(viverse, 'marimba-viverse-abc123xyz-evil-yourteam.vercel.app')).toBe(false);
    expect(hostMatches(viverse, 'marimba-viverse-git-main-evil-yourteam.vercel.app')).toBe(false);
    expect(hostMatches(viverse, 'marimba-viverse-evil-yourteam.vercel.app')).toBe(false);
    // Our own branch link too: a team named menu-yourteam with a project marimba-viverse-git has it as its production link.
    expect(hostMatches(viverse, 'marimba-viverse-git-menu-yourteam.vercel.app')).toBe(false);
    expect(hostMatches(viverse, 'marimba-viverse-k2m7q9x4-yourteam.vercel.app')).toBe(false);
    expect(hostMatches(viverse, 'marimba-viverse-k2m7q9x4tt-yourteam.vercel.app')).toBe(false);
    expect(hostMatches(viverse, 'marimba-viverse-k2m7q9x4t-yourteam.vercel.app.evil.com')).toBe(false);
    expect(hostMatches('marimba-web-*-yourteam.vercel.app', 'marimba-web-evil.vercel.app')).toBe(false);
    // The limit of any pattern on vercel.app (docs/THREADS.md, Safety): this is also the production link of a team named abcdefghi-yourteam.
    expect(hostMatches(viverse, 'marimba-viverse-abcdefghi-yourteam.vercel.app')).toBe(true);
    // At either end of a label the star takes hyphens; alone it is one whole label.
    expect(hostMatches('pr-*.marimba.example', 'pr-12-menu.marimba.example')).toBe(true);
    expect(hostMatches('*.marimba.example', 'beta.marimba.example')).toBe(true);
    expect(hostMatches('*.marimba.example', 'marimba.example')).toBe(false);
    expect(hostMatches('*.marimba.example', 'a.b.marimba.example')).toBe(false);
    expect(hostMatches('marimba.example', 'MARIMBA.example')).toBe(true);
  });

  it('accepts the launches the format allows and refuses the rest', () => {
    const ok = (launch: unknown) => launchSchema.safeParse(launch).success;
    expect(ok({ label: 'Variant B', steps: [{ do: 'require', package: 'com.example.marimba', versionCode: 231 }, { do: 'app', package: 'com.example.marimba', data: 'marimba://variant/b', extras: { variant: 'b', n: 2, on: true } }] })).toBe(true);
    expect(ok({ steps: [{ do: 'open', url: menu }] })).toBe(true);
    expect(ok({ steps: [{ do: 'open', url: 'http://example.com/' }] })).toBe(false);
    expect(ok({ steps: [{ do: 'open', url: 'https://user:secret@example.com/' }] })).toBe(false);
    expect(ok({ steps: [{ do: 'app', package: 'com.x.y', data: 'file:///sdcard/Download/x' }] })).toBe(false);
    expect(ok({ steps: [{ do: 'app', package: 'com.x.y', data: 'intent://x#Intent;end' }] })).toBe(false);
    expect(ok({ steps: [{ do: 'app', package: 'not a package' }] })).toBe(false);
    expect(ok({ steps: [{ do: 'shell', command: 'rm -rf /sdcard' }] })).toBe(false);
    expect(ok({ steps: [] })).toBe(false);
    expect(ok({ steps: [{ do: 'open', url: menu }], extra: true })).toBe(false);
  });

  it('checks each step against its project and says the launch in words', () => {
    const [mus] = parseProjects(PROJECTS);
    expect(launchProblems([{ steps: [{ do: 'open', url: menu }, { do: 'app', package: 'com.example.marimba' }] }], mus)).toEqual([]);
    expect(launchProblems([{ steps: [{ do: 'open', url: 'https://evil.example/' }, { do: 'app', package: 'com.other.app' }, { do: 'require', package: 'com.other.app' }] }], mus)).toEqual([
      "launch 1 step 1: evil.example is not one of MUS's hosts (marimba-web-*-yourteam.vercel.app)",
      "launch 1 step 2: com.other.app is not one of MUS's packages (com.example.marimba)",
    ]);
    expect(launchProblems([{ steps: [{ do: 'open', url: 'https://marimba-web-git-menu-yourteam.vercel.app/' }] }], mus)).toEqual([
      "launch 1 step 1: marimba-web-git-menu-yourteam.vercel.app is not one of MUS's hosts (marimba-web-*-yourteam.vercel.app)",
    ]);
    expect(describeLaunch({ label: 'Variant B', steps: [{ do: 'require', package: 'com.x.y', versionName: '2.3.1', versionCode: 231 }, { do: 'app', package: 'com.x.y', extras: { variant: 'b' } }] }))
      .toBe('Variant B: require com.x.y 2.3.1 (231); open app com.x.y (variant=b)');
  });

  it('names who sent a message the way a person would say it', () => {
    expect(displayName('Mac', { name: 'Robin' }, 'Opus 5.5')).toBe("Opus 5.5 on Robin's Mac");
    expect(displayName('Quest 3', { name: 'Robin' })).toBe('Robin · Quest 3');
    expect(displayName('mac')).toBe('mac');
    expect(displayName('ci', undefined, 'Sonnet 5.5')).toBe('Sonnet 5.5 on ci');
    // An agent that is its own token, as the receiver's Welcome is (2026-11-10): its name alone.
    expect(displayName('Polydance', undefined, 'Polydance')).toBe('Polydance');
    expect(displayName('Polydance', { name: 'Robin' }, 'Polydance')).toBe("Polydance on Robin's Polydance");
    expect(parseUsers(undefined)).toEqual([]);
    expect(parseUsers('[{"id":"robin","name":"Robin","colour":"#d93a2b"}]')).toEqual([{ id: 'robin', name: 'Robin', colour: '#d93a2b' }]);
    expect(() => parseUsers('[{"id":"Robin","name":"R"}]')).toThrow(/user id/);
    expect(() => parseUsers('[{"id":"robin","name":"R","colour":"red"}]')).toThrow(/#rrggbb/);
    expect(() => parseUsers('[{"id":"a","name":"A"},{"id":"a","name":"B"}]')).toThrow(/duplicate/);
  });

  it('fails closed on a malformed project list, and treats none as threads off', () => {
    expect(parseProjects(undefined)).toEqual([]);
    expect(parseProjects(PROJECTS)[1]).toEqual({ key: 'CAP', name: 'Polydance Capture', hosts: [], packages: ['net.polydance.capture'] });
    expect(() => parseProjects('[')).toThrow(/not JSON/);
    expect(() => parseProjects(JSON.stringify([{ key: 'mus', name: 'x' }]))).toThrow(/project key/);
    expect(() => parseProjects(JSON.stringify([{ key: 'MUS', name: 'x', hosts: ['*.*.example.com'] }]))).toThrow(/star|\*/);
    expect(() => parseProjects(JSON.stringify([{ key: 'MUS', name: 'a' }, { key: 'MUS', name: 'b' }]))).toThrow(/duplicate/);
  });

  it('builds a launch from CLI flags, or reads several from files, never both', async () => {
    expect(await launchesFrom({})).toBeUndefined();
    expect(await launchesFrom({ require: ['com.example.marimba@231', 'net.polydance.capture@0.6.0'], app: 'com.example.marimba', extra: ['variant=b', 'note=a=b'], label: 'B' })).toEqual([{
      label: 'B', steps: [
        { do: 'require', package: 'com.example.marimba', versionCode: 231 },
        { do: 'require', package: 'net.polydance.capture', versionName: '0.6.0' },
        { do: 'app', package: 'com.example.marimba', extras: { variant: 'b', note: 'a=b' } },
      ],
    }]);
    await expect(launchesFrom({ extra: ['variant=b'] })).rejects.toThrow(/go with --app/);
    await expect(launchesFrom({ open: 'http://example.com' })).rejects.toThrow(/https/);
    const dir = await mkdtemp(join(tmpdir(), 'launch-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ label: 'A', steps: [{ do: 'open', url: menu }] }));
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ steps: [{ do: 'shell' }] }));
    expect(await launchesFrom({ launch: [join(dir, 'a.json')] })).toEqual([{ label: 'A', steps: [{ do: 'open', url: menu }] }]);
    await expect(launchesFrom({ launch: [join(dir, 'bad.json')] })).rejects.toThrow(/bad.json is not a launch/);
    await expect(launchesFrom({ launch: [join(dir, 'a.json')], open: menu })).rejects.toThrow(/not both/);
  });

  it('builds options from --option in the order given, sharing the flags before the first', async () => {
    const pkg = 'com.example.marimba';
    const app = launchArgs(['MUS-1', '--text', 'Which?', '--require', `${pkg}@231`, '--app', pkg, '--option', 'Blue', '--extra', 'variant=blue', '--option', 'Red', '--extra', 'variant=red', '--extra', 'size=2']);
    expect(app.positionals).toEqual(['MUS-1']);
    expect(await launchesFrom({ ...app.values, optionGroups: app.optionGroups })).toEqual([
      { label: 'Blue', steps: [{ do: 'require', package: pkg, versionCode: 231 }, { do: 'app', package: pkg, extras: { variant: 'blue' } }] },
      { label: 'Red', steps: [{ do: 'require', package: pkg, versionCode: 231 }, { do: 'app', package: pkg, extras: { variant: 'red', size: '2' } }] },
    ]);
    const web = launchArgs(['--option=Blue menu', '--open', menu, '--option', 'Red menu', `--open=${menu}red`]);
    expect((await launchesFrom({ ...web.values, optionGroups: web.optionGroups }))!.map(l => [l.label, l.steps])).toEqual([
      ['Blue menu', [{ do: 'open', url: menu }]], ['Red menu', [{ do: 'open', url: `${menu}red` }]],
    ]);
    // Without --option the flags make one launch, as before.
    expect(launchArgs(['--open', menu]).optionGroups).toBeUndefined();
    const fails = (args: string[]) => { const a = launchArgs(args); return launchesFrom({ ...a.values, optionGroups: a.optionGroups }); };
    await expect(fails(['--option', 'A', '--require', `${pkg}@231`])).rejects.toThrow(/"A" opens nothing/);
    await expect(fails(['--label', 'X', '--option', 'A', '--open', menu])).rejects.toThrow(/--label is for a single one/);
    await expect(fails(['--option', ' ', '--open', menu])).rejects.toThrow(/needs a name/);
    await expect(fails(Array.from({ length: 7 }, (_, i) => ['--option', `O${i}`, '--open', menu]).flat())).rejects.toThrow(/options: list/);
  });
});

const grant = (id: string, scopes: Grant['scopes'], extra: Partial<Grant> = {}): Grant => ({ id, sha256: '0'.repeat(64), scopes, ...extra });
const team = grant('mac', ['read', 'post'], { label: 'Marimba agent' });
const quest = grant('quest3', ['upload'], { label: "Robin's Quest 3" });
const outsider = grant('other', ['upload'], { projects: ['CAP'] });

describe('the thread store', () => {
  const projects = parseProjects(PROJECTS);
  const store = async () => new ThreadStore(await mkdtemp(join(tmpdir(), 'threads-')), projects);

  it('keeps one star per person on a message\'s options, and the team hears each change', async () => {
    const threads = await store();
    await threads.create(team, { project: 'MUS', title: 'Menus', text: 'Which?', launches: [{ label: 'Blue', steps: [{ do: 'open', url: menu }] }, { label: 'Red', steps: [{ do: 'open', url: `${menu}red` }] }] });
    await threads.create(team, { project: 'MUS', title: 'One', text: 'Try it', launches: [{ steps: [{ do: 'open', url: menu }] }] });
    const before = await threads.lastEventId();
    let t = await threads.pick(quest, 'MUS-1', 1, 1);
    expect(t.messages[0].picks).toEqual([expect.objectContaining({ launch: 1, by: expect.objectContaining({ id: 'quest3' }) })]);
    expect(lastActivity(t).text).toBe('picked option 2: Red in #1');
    expect(fresh(t, 'mac')).toBe(1);
    t = await threads.pick(quest, 'MUS-1', 1, 0);
    expect(t.messages[0].picks.map(p => p.launch)).toEqual([0]);
    t = await threads.pick(quest, 'MUS-1', 1, 0);
    expect(t.messages[0].picks).toEqual([]);
    expect(lastActivity(t).text).toBe('took back a pick in #1');
    expect((await threads.eventsAfter(team, before)).map(e => [e.kind, e.launch])).toEqual([['pick', 1], ['pick', 0], ['pick', null]]);
    await expect(threads.pick(quest, 'MUS-2', 1, 0)).rejects.toThrow(/no options to pick between/);
    await expect(threads.pick(quest, 'MUS-1', 1, 2)).rejects.toThrow(/has 2 options, so there is no option 3/);
    await expect(threads.pick(quest, 'MUS-1', 9, 0)).rejects.toThrow(/no message 9/);
  });

  it('opens threads, posts, reacts and keeps what each token has seen', async () => {
    const threads = await store();
    const thread = await threads.create(team, { project: 'MUS', title: 'New menu', text: 'Is Settings easier to find?', launches: [{ steps: [{ do: 'open', url: menu }] }] });
    expect(thread).toMatchObject({ key: 'MUS-1', state: 'open', titleFromRecording: false, by: { id: 'mac', name: 'Marimba agent' } });
    expect([unread(thread, 'quest3'), unread(thread, 'mac'), waiting(thread, 'quest3'), waiting(thread, 'mac')]).toEqual([true, false, true, false]);
    await expect(threads.create(team, { project: 'MUS', title: 'x', launches: [{ steps: [{ do: 'open', url: 'https://marimba-web-evil.vercel.app/' }] }] })).rejects.toThrow(/not one of MUS's hosts/);
    await expect(threads.create(team, { project: 'MUS', title: 'x' })).rejects.toThrow(/needs text, a launch or a photo/);
    await expect(threads.create(outsider, { project: 'MUS', title: 'x', text: 'y' })).rejects.toThrow(/no project MUS/);
    expect((await threads.create(team, { project: 'MUS', title: 'Drums', text: 'Hit the drum' })).key).toBe('MUS-2');
    await sleep(5);

    // One reaction per person per message: another replaces it, the same again takes it back.
    expect((await threads.react(quest, 'MUS-1', 1, 'thumbs-up')).messages[0].reactions).toEqual([expect.objectContaining({ reaction: 'thumbs-up', by: { id: 'quest3', name: "Robin's Quest 3", display: "Robin's Quest 3" } })]);
    expect((await threads.react(quest, 'MUS-1', 1, 'heart')).messages[0].reactions.map(r => r.reaction)).toEqual(['heart']);
    const back = await threads.react(quest, 'MUS-1', 1, 'heart');
    expect(back.messages[0].reactions).toEqual([]);
    await expect(threads.react(quest, 'MUS-1', 9, 'heart')).rejects.toThrow(/no message 9/);
    expect(lastActivity(back)).toMatchObject({ kind: 'reaction', by: { id: 'quest3' }, text: 'reacted to #1' });

    // Seen up to a seq: never past the end, never backwards; the tester's reactions are news to the team.
    const read = await threads.markRead(quest, 'MUS-1', 999);
    expect(read.reads.quest3).toBe(read.seq);
    expect((await threads.markRead(quest, 'MUS-1', 1)).reads.quest3).toBe(read.seq);
    expect([unread(read, 'quest3'), unread(read, 'mac')]).toEqual([false, true]);

    expect((await threads.list(quest)).map(t => t.key)).toEqual(['MUS-1', 'MUS-2']);
    expect(await threads.list(outsider)).toEqual([]);
    await expect(threads.visible(outsider, 'MUS-1')).rejects.toThrow(/no thread MUS-1/);

    expect((await threads.setState(quest, 'MUS-2', 'closed')).state).toBe('closed');
    expect((await threads.post(team, 'MUS-2', { text: 'Try again' })).state).toBe('open');
    expect((await threads.rename(team, 'MUS-2', 'Drum sticks')).title).toBe('Drum sticks');

    const events = await threads.eventsAfter(quest, 0);
    expect(events.map(e => `${e.thread} ${e.kind}`)).toEqual([
      'MUS-1 thread.new', 'MUS-2 thread.new', 'MUS-1 reaction', 'MUS-1 reaction', 'MUS-1 reaction', 'MUS-2 closed', 'MUS-2 reopened', 'MUS-2 message', 'MUS-2 renamed',
    ]);
    expect(events[4]).toMatchObject({ reaction: null, message: 1, by: { id: 'quest3' } });
    expect(events.map(e => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // A new store on the same folder reads the feed back.
    expect(await new ThreadStore(threads.dir, projects).lastEventId()).toBe(9);
  });

  it('puts each recording in a thread once, and names a thread from its first recording', async () => {
    const threads = await store();
    const opened = await threads.attachRecording(quest, { id: 'up_1', clientId: 'c1', recordedAt: '2026-10-03T14:20:11+01:00' }, { project: 'CAP' });
    expect(opened).toEqual({ key: 'CAP-1', message: 1 });
    expect(await threads.attachRecording(quest, { id: 'up_1', clientId: 'c1' }, { project: 'CAP' })).toEqual(opened);
    expect(await threads.get('CAP-1')).toMatchObject({ title: 'Recording 3 Oct 14:20', titleFromRecording: true, messages: [{ recording: { uploadId: 'up_1', clientId: 'c1' } }] });
    expect(await threads.context(opened)).toEqual({ key: 'CAP-1', project: 'CAP', title: 'Recording 3 Oct 14:20', opened: true });
    // Without a thread: a new one in the token's first project.
    expect(await threads.attachRecording(quest, { id: 'up_2', clientId: 'c2' }, undefined)).toEqual({ key: 'MUS-1', message: 1 });
    expect(await threads.attachRecording(outsider, { id: 'up_9', clientId: 'c9' }, undefined)).toEqual({ key: 'CAP-2', message: 1 });

    const asked = await threads.create(team, { project: 'CAP', title: 'Deck lights', text: 'Do the lamps line up with the timer?', launches: [{ label: 'A', steps: [{ do: 'require', package: 'net.polydance.capture', versionCode: 6 }] }] });
    const reply = await threads.attachRecording(quest, { id: 'up_3', clientId: 'c3' }, { key: asked.key, replyTo: { message: 1, launch: 0 } });
    expect(reply).toEqual({ key: 'CAP-3', message: 2 });
    expect(await threads.context(reply)).toEqual({
      key: 'CAP-3', project: 'CAP', title: 'Deck lights', opened: false,
      replyTo: { message: 1, text: 'Do the lamps line up with the timer?', launch: { label: 'A', steps: [{ do: 'require', package: 'net.polydance.capture', versionCode: 6 }] } },
    });
    expect(waiting((await threads.get('CAP-3'))!, 'quest3')).toBe(false);
    await expect(threads.checkUploadRef(quest, { key: 'CAP-3', replyTo: { message: 9 } })).rejects.toThrow(/no message 9/);
    await expect(threads.checkUploadRef(quest, { key: 'CAP-3', replyTo: { message: 1, launch: 3 } })).rejects.toThrow(/no launch 3/);
    await expect(threads.checkUploadRef(outsider, { key: 'MUS-1' })).rejects.toThrow(/no thread MUS-1/);
    await expect(threads.checkUploadRef(outsider, { project: 'MUS' })).rejects.toThrow(/no project MUS/);
    await expect(threads.checkUploadRef(grant('nobody', ['upload'], { projects: ['ZZ'] }), undefined)).rejects.toThrow(/sees no projects/);

    expect(lastActivity((await threads.get('CAP-1'))!).text).toBe('sent a recording');
    await threads.recordingFinished(opened, { sessionId: 's1', title: 'Lamps too far left', summary: 'Finds the lamps sit left of the timer.' });
    expect(await threads.get('CAP-1')).toMatchObject({ title: 'Lamps too far left', titleFromRecording: false });
    expect(lastActivity((await threads.get('CAP-1'))!).text).toBe('recording ready: Lamps too far left');
    await threads.recordingFinished(reply, { sessionId: 's3', title: 'Not this title', summary: 'x' });
    expect((await threads.get('CAP-3'))!.title).toBe('Deck lights');
    await threads.recordingFinished({ key: 'MUS-1', message: 1 }, { error: 'transcribe failed' });
    const events = await threads.eventsAfter(team, 0);
    expect(events.filter(e => e.kind.startsWith('recording')).map(e => `${e.thread} ${e.kind}`)).toEqual(['CAP-3 recording', 'CAP-1 recording.ready', 'CAP-3 recording.ready', 'MUS-1 recording.failed']);
    expect(events.find(e => e.kind === 'recording.ready')).toMatchObject({ sessionId: 's1', title: 'Lamps too far left', by: { id: 'quest3' } });

    // Recording into a closed thread opens it again.
    await threads.setState(team, 'CAP-3', 'closed');
    await threads.attachRecording(quest, { id: 'up_4', clientId: 'c4' }, { key: 'CAP-3' });
    expect((await threads.get('CAP-3'))!.state).toBe('open');
  });

  it('signs each change with the person behind the token and, for an agent, its own name', async () => {
    const users = parseUsers('[{"id":"robin","name":"Robin","colour":"#d93a2b"}]');
    const threads = new ThreadStore(await mkdtemp(join(tmpdir(), 'threads-')), projects, users);
    const mac = grant('mac', ['read', 'post'], { label: 'Mac', user: 'robin' });
    const headset = grant('quest3', ['upload'], { label: 'Quest 3', user: 'robin' });
    const thread = await threads.create(mac, { project: 'MUS', title: 'Hello', text: 'hi', as: 'Opus 5.5' });
    expect(thread.messages[0].by).toEqual({ id: 'mac', name: 'Mac', user: { id: 'robin', name: 'Robin', colour: '#d93a2b' }, as: 'Opus 5.5', display: "Opus 5.5 on Robin's Mac" });
    expect((await threads.react(headset, 'MUS-1', 1, 'heart')).messages[0].reactions[0].by.display).toBe('Robin · Quest 3');
    expect(lastActivity((await threads.get('MUS-1'))!).by.display).toBe('Robin · Quest 3');
    expect((await threads.eventsAfter(mac, 0))[0].by.display).toBe("Opus 5.5 on Robin's Mac");
  });

  it('waits for the next event it may see, and stops waiting when the client goes away', async () => {
    const threads = await store();
    const next = threads.waitForEvents(quest, await threads.lastEventId(), {}, 5000, new AbortController().signal);
    await threads.create(team, { project: 'MUS', title: 'Hello', text: 'hi' });
    expect((await next).map(e => e.kind)).toEqual(['thread.new']);

    const gone = new AbortController();
    const started = Date.now();
    const abandoned = threads.waitForEvents(quest, await threads.lastEventId(), {}, 5000, gone.signal);
    gone.abort();
    expect(await abandoned).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);

    const hidden = threads.waitForEvents(outsider, await threads.lastEventId(), {}, 300, new AbortController().signal);
    await threads.create(team, { project: 'MUS', title: 'Not for CAP', text: 'x' });
    expect(await hidden).toEqual([]);
    const onlyOne = threads.waitForEvents(quest, await threads.lastEventId(), { thread: 'MUS-1' }, 300, new AbortController().signal);
    await threads.post(team, 'MUS-2', { text: 'elsewhere' });
    expect(await onlyOne).toEqual([]);
  });
});

describe('thread-scoped access for people outside the team (2026-10-21)', () => {
  const projects = parseProjects(PROJECTS);
  const users = parseUsers('[{"id":"robin","name":"Robin"},{"id":"ana","name":"Ana"},{"id":"ben","name":"Ben"}]');
  const store = async () => new ThreadStore(await mkdtemp(join(tmpdir(), 'threads-')), projects, users, 'CAP');
  // Two Marimba testers signed in with Meta, as testers.ts makes their grants, and Ana's own agent.
  const ana = grant('meta-111', ['upload'], { label: 'Quest 3', user: 'ana', projects: ['MUS'] });
  const ben = grant('meta-222', ['upload'], { label: 'Quest 3', user: 'ben', projects: ['MUS'] });
  const anaAgent = grant('ana-agent', ['read', 'post'], { label: "Ana's Mac", user: 'ana', threads: 'member', projects: ['MUS'] });
  // Robin's own Meta sign-in: his person holds a team token, so his headset sees as quest3 does.
  const robinsQuest = grant('meta-999', ['upload'], { label: 'Quest 3', user: 'robin', teamPerson: true });
  const keys = async (g: Grant) => (await threads.list(g)).map(t => t.key);
  let threads: ThreadStore;

  it('says who is thread-scoped and who is the team', () => {
    expect([ana, ben, anaAgent].map(memberScoped)).toEqual([true, true, true]);
    expect([team, quest, outsider, robinsQuest].map(memberScoped)).toEqual([false, false, false, false]);
    expect([team, anaAgent, quest, ana].map(isTeam)).toEqual([true, false, false, false]);
    expect([...teamPeople([grant('mac', ['read', 'post'], { user: 'robin' }), anaAgent, grant('q', ['upload'], { user: 'ben' })])]).toEqual(['robin']);
  });

  it('lets a tester reach only threads they are a member of, and their own new thread only they and the team see', async () => {
    threads = await store();
    await threads.create(team, { project: 'MUS', title: 'Team only', text: 'Not for testers', launches: [{ label: 'A', steps: [{ do: 'open', url: menu }] }, { label: 'B', steps: [{ do: 'open', url: `${menu}b` }] }] });
    // Ana records with no thread open: a thread of her own, with her as its member.
    expect(await threads.attachRecording(ana, { id: 'up_a', clientId: 'a1' }, undefined)).toEqual({ key: 'MUS-2', message: 1 });
    expect((await threads.get('MUS-2'))!.members).toEqual([{ person: 'ana', addedBy: expect.objectContaining({ id: 'meta-111' }), addedAt: expect.any(String) }]);
    expect(await threads.attachRecording(ben, { id: 'up_b', clientId: 'b1' }, { project: 'MUS' })).toEqual({ key: 'MUS-3', message: 1 });

    expect(await keys(ana)).toEqual(['MUS-2']);
    expect(await keys(anaAgent)).toEqual(['MUS-2']);
    expect(await keys(ben)).toEqual(['MUS-3']);
    expect((await keys(team)).sort()).toEqual(['MUS-1', 'MUS-2', 'MUS-3']);
    expect((await keys(quest)).sort()).toEqual(['MUS-1', 'MUS-2', 'MUS-3']);
    expect((await keys(robinsQuest)).sort()).toEqual(['MUS-1', 'MUS-2', 'MUS-3']);

    // Every way in to Ben's thread or the team's is the same 404 as a thread that does not exist.
    for (const key of ['MUS-1', 'MUS-3', 'MUS-99']) {
      const none = new RegExp(`no thread ${key}`);
      await expect(threads.visible(ana, key)).rejects.toThrow(none);
      await expect(threads.checkUploadRef(ana, { key })).rejects.toThrow(none);
      await expect(threads.attachRecording(ana, { id: `up_${key}`, clientId: `x${key}` }, { key })).rejects.toThrow(none);
      await expect(threads.react(ana, key, 1, 'heart')).rejects.toThrow(none);
      await expect(threads.pick(ana, key, 1, 0)).rejects.toThrow(none);
      await expect(threads.setState(ana, key, 'closed')).rejects.toThrow(none);
      await expect(threads.markRead(ana, key, 1)).rejects.toThrow(none);
      await expect(threads.hide(ana, key)).rejects.toThrow(none);
      await expect(threads.post(anaAgent, key, { text: 'hello' })).rejects.toThrow(none);
      await expect(threads.rename(anaAgent, key, 'mine now')).rejects.toThrow(none);
    }
    expect((await threads.eventsAfter(ana, 0)).map(e => e.thread)).toEqual(['MUS-2']);
    expect((await threads.eventsAfter(anaAgent, 0, { thread: 'MUS-1' }))).toEqual([]);
    expect(new Set((await threads.eventsAfter(team, 0)).map(e => e.thread))).toEqual(new Set(['MUS-1', 'MUS-2', 'MUS-3']));
    // Her agent posts in her own thread; it cannot open threads outside its projects.
    expect((await threads.post(anaAgent, 'MUS-2', { text: 'Fixed in build 26', as: 'Opus 5.5' })).messages).toHaveLength(2);
    await expect(threads.create(anaAgent, { project: 'CAP', title: 'x', text: 'y' })).rejects.toThrow(/no project CAP/);
    expect((await threads.create(anaAgent, { project: 'MUS', title: 'Agent opened', text: 'y' })).members).toEqual([expect.objectContaining({ person: 'ana' })]);
  });

  it('lets the team add a tester by person id and take them out again, whatever they posted', async () => {
    const before = await threads.lastEventId();
    // Ana's agent waits on her feed: being added wakes it.
    const woken = threads.waitForEvents(anaAgent, before, {}, 5000, new AbortController().signal);
    let t = await threads.members(team, 'MUS-1', { add: ['ana', 'ana'], remove: [] });
    expect(t.members).toEqual([{ person: 'ana', addedBy: expect.objectContaining({ id: 'mac' }), addedAt: expect.any(String) }]);
    expect((await woken).map(e => [e.thread, e.kind, e.added])).toEqual([['MUS-1', 'people', 1]]);
    expect(lastActivity(t).text).toBe('added 1 person');
    // The event says how many, never who.
    expect(JSON.stringify(await threads.eventsAfter(team, before))).not.toContain('"ana"');
    expect((await threads.members(team, 'MUS-1', { add: ['ana'], remove: [] })).seq).toBe(t.seq);

    expect((await keys(ana)).sort()).toEqual(['MUS-1', 'MUS-2', 'MUS-4']);
    expect(await keys(ben)).toEqual(['MUS-3']);
    // Now she sees it from when she was added (2026-11-12): none of the team's message from before, nor its events.
    const view = async (g: Grant) => (await threads.viewer(g))(await threads.visible(g, 'MUS-1'));
    expect((await view(ana)).messages).toEqual([]);
    expect((await view(ana)).activity.map(a => a.kind)).toEqual(['people']);
    expect(lastActivity(await view(ana)).text).toBe('added 1 person');
    expect((await threads.eventsAfter(ana, 0, { thread: 'MUS-1' })).map(e => e.kind)).toEqual(['people']);
    await expect(threads.react(ana, 'MUS-1', 1, 'heart')).rejects.toThrow(/MUS-1 has no message 1/);
    await expect(threads.pick(ana, 'MUS-1', 1, 1)).rejects.toThrow(/MUS-1 has no message 1/);
    await expect(threads.checkUploadRef(ana, { key: 'MUS-1', replyTo: { message: 1 } })).rejects.toThrow(/MUS-1 has no message 1/);
    // What comes after is hers: she records into it, reacts, picks and closes it.
    await threads.post(team, 'MUS-1', { text: 'Ana, which?', launches: [{ label: 'A', steps: [{ do: 'open', url: menu }] }, { label: 'B', steps: [{ do: 'open', url: `${menu}b` }] }] });
    expect(await threads.attachRecording(ana, { id: 'up_a2', clientId: 'a2' }, { key: 'MUS-1', replyTo: { message: 2, launch: 1 } })).toEqual({ key: 'MUS-1', message: 3 });
    await threads.react(ana, 'MUS-1', 2, 'heart');
    await threads.pick(ana, 'MUS-1', 2, 1);
    expect((await view(ana)).messages.map(m => m.id)).toEqual([2, 3]);
    expect((await threads.eventsAfter(ana, 0, { thread: 'MUS-1' })).map(e => e.kind)).toEqual(['people', 'message', 'recording', 'reaction', 'pick']);
    // The team and Robin's own headsets see all of it.
    for (const g of [team, quest, robinsQuest]) expect((await view(g)).messages.map(m => m.id)).toEqual([1, 2, 3]);
    expect((await threads.setState(ana, 'MUS-1', 'closed')).state).toBe('closed');
    await threads.setState(team, 'MUS-1', 'open');

    // Only the team changes members, and a report has none.
    await expect(threads.members(anaAgent, 'MUS-1', { add: ['ben'], remove: [] })).rejects.toMatchObject({ status: 403 });
    await expect(threads.members(quest, 'MUS-1', { add: ['ben'], remove: [] })).rejects.toMatchObject({ status: 403 });
    await expect(threads.members(anaAgent, 'MUS-3', { add: ['ana'], remove: [] })).rejects.toMatchObject({ status: 404 });
    await expect(threads.members(team, 'MUS-1', { add: ['Not An Id'], remove: [] })).rejects.toThrow(/add.0: a person id/);
    await expect(threads.members(team, 'MUS-1', { add: ['ben'], remove: ['ben'] })).rejects.toThrow(/remove.0: also in add/);
    const report = await threads.attachRecording(ana, { id: 'up_r', clientId: 'r1' }, { report: true });
    expect(report.key).toBe('CAP-1');
    expect(await keys(ana)).not.toContain('CAP-1');
    await expect(threads.members(team, 'CAP-1', { add: ['ana'], remove: [] })).rejects.toThrow(/report/);

    // Taking her out takes her out, though she recorded, reacted and picked there.
    t = await threads.members(team, 'MUS-1', { add: [], remove: ['ana'] });
    expect(t.members).toBeUndefined();
    expect(lastActivity(t).text).toBe('removed 1 person');
    await expect(threads.visible(ana, 'MUS-1')).rejects.toThrow(/no thread MUS-1/);
    await expect(threads.attachRecording(ana, { id: 'up_a3', clientId: 'a3' }, { key: 'MUS-1' })).rejects.toThrow(/no thread MUS-1/);
    expect((await threads.eventsAfter(ana, 0)).some(e => e.thread === 'MUS-1')).toBe(false);
    expect(isMember(ana, t)).toBe(false);
    // A headset of the team's own keeps membership by posting, as before.
    expect(isMember(quest, { messages: [{ by: { id: 'quest3', name: 'Quest 3' } }] as Thread['messages'] })).toBe(true);
  });

  it('counts a verified invitation as membership, and taking the person out takes it out too', async () => {
    const people = { emails: async () => ({ ben: { email: 'ben@example.com', setAt: '2026-10-21T00:00:00.000Z', verified: true } }) };
    const withPeople = new ThreadStore(threads.dir, projects, users, 'CAP', undefined, people);
    await withPeople.participants(team, 'MUS-1', { add: ['ben@example.com'], remove: [] }, () => true);
    expect((await withPeople.list(ben)).map(t => t.key).sort()).toEqual(['MUS-1', 'MUS-3']);
    // Without the verified address (a store that cannot read it), the invitation alone is not enough.
    expect(await keys(ben)).toEqual(['MUS-3']);
    const t = await withPeople.members(team, 'MUS-1', { add: [], remove: ['ben'] }, person => person === 'ben' ? 'ben@example.com' : undefined);
    expect(t.participants).toBeUndefined();
    expect((await withPeople.list(ben)).map(t => t.key)).toEqual(['MUS-3']);
  });

  it('starts someone\'s view at the earliest way they came in, again when they are put back, and keeps the history choice made when they were added (2026-11-12)', async () => {
    const people = { emails: async () => ({ ben: { email: 'ben@example.com', setAt: '2026-11-12T00:00:00.000Z', verified: true } }) };
    const hidden = new ThreadStore(await mkdtemp(join(tmpdir(), 'threads-')), projects, users, 'CAP', undefined, people);
    expect(hidden.history).toBe('hidden');
    const ids = async (store: ThreadStore, g: Grant, key = 'MUS-1') => (await store.viewer(g))(await store.visible(g, key)).messages.map(m => m.id);
    await hidden.create(team, { project: 'MUS', title: 'Before Ben', text: 'one' });
    await hidden.post(team, 'MUS-1', { text: 'two' });
    // Invited by address first and added by id later: he sees from the invitation.
    await hidden.participants(team, 'MUS-1', { add: ['ben@example.com'], remove: [] }, () => true);
    await hidden.post(team, 'MUS-1', { text: 'three' });
    await hidden.members(team, 'MUS-1', { add: ['ben'], remove: [] });
    await hidden.post(team, 'MUS-1', { text: 'four' });
    expect(await ids(hidden, ben)).toEqual([3, 4]);
    // Taken out (his invitation with him) and put back: from the new start.
    await hidden.members(team, 'MUS-1', { add: [], remove: ['ben'] }, person => person === 'ben' ? 'ben@example.com' : undefined);
    await hidden.post(team, 'MUS-1', { text: 'five' });
    await hidden.members(team, 'MUS-1', { add: ['ben'], remove: [] });
    await hidden.post(team, 'MUS-1', { text: 'six' });
    expect(await ids(hidden, ben)).toEqual([6]);
    expect((await hidden.eventsAfter(ben, 0)).map(e => [e.kind, e.message])).toEqual([['people', undefined], ['message', 6]]);
    expect(await ids(hidden, team)).toEqual([1, 2, 3, 4, 5, 6]);
    // A thread the team opens with him in it (the Welcome) is his from its first message.
    await hidden.create(team, { project: 'MUS', title: 'Welcome', text: 'hello', members: ['ben'] });
    expect(await ids(hidden, ben, 'MUS-2')).toEqual([1]);
    // The receiver's setting changed to visible later reveals nothing to those already in: the choice was kept.
    const visible = new ThreadStore(hidden.dir, projects, users, 'CAP', undefined, people, undefined, 'visible');
    expect(await ids(visible, ben)).toEqual([6]);
    // It is the default for those added from then on: Ana sees all of it, and the team can still say otherwise.
    expect((await visible.members(team, 'MUS-1', { add: ['ana'], remove: [] })).members?.find(m => m.person === 'ana')).toMatchObject({ history: 'visible' });
    expect(await ids(visible, ana)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await visible.eventsAfter(ana, 0, { thread: 'MUS-1' }))[0].kind).toBe('thread.new');
    await visible.members(team, 'MUS-1', { add: [], remove: ['ana'] });
    expect((await visible.members(team, 'MUS-1', { add: ['ana'], remove: [], history: 'hidden' })).members?.find(m => m.person === 'ana')).not.toHaveProperty('history');
    expect(await ids(visible, ana)).toEqual([]);
    // With history hidden by default, the team may choose visible for one add, by id or by address.
    await hidden.members(team, 'MUS-1', { add: [], remove: ['ana'] });
    await hidden.members(team, 'MUS-1', { add: ['ana'], remove: [], history: 'visible' });
    expect(await ids(hidden, ana)).toEqual([1, 2, 3, 4, 5, 6]);
    const invited = await hidden.participants(team, 'MUS-1', { add: ['ben@example.com'], remove: [], history: 'visible' }, () => true);
    expect(invited.participants).toEqual([expect.objectContaining({ email: 'ben@example.com', history: 'visible' })]);
    expect(await ids(hidden, ben)).toEqual([1, 2, 3, 4, 5, 6]);
    // Entries from before a people change can be matched start from the last change before they were added.
    const at = (n: number) => `2026-11-12T10:00:0${n}.000Z`;
    const activity = [1, 2, 3].map(seq => ({ seq, at: at(seq), kind: 'message' as const, by: { id: 'mac', name: 'Mac' } }));
    expect(joinedWindow({ activity, createdAt: at(0) }, { addedAt: '2026-11-12T10:00:02.500Z', addedBy: { id: 'mac' } })).toEqual({ since: 2, at: '2026-11-12T10:00:02.500Z' });
    expect(joinedWindow({ activity, createdAt: at(0) }, { addedAt: at(0), addedBy: { id: 'mac' } })).toEqual({ since: 0, at: at(0) });
    expect(joinedWindow({ activity, createdAt: at(0) }, { addedAt: at(3), addedBy: { id: 'mac' }, history: 'visible' })).toEqual({ since: 0, at: at(0) });
    expect([parseNewMemberHistory(undefined), parseNewMemberHistory(' visible '), parseNewMemberHistory('hidden')]).toEqual(['hidden', 'visible', 'hidden']);
    expect(() => parseNewMemberHistory('sometimes')).toThrow(/hidden or visible/);
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('threads on the receiver, end to end', () => {
  const upload = newToken(), mac = newToken(), other = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: upload.sha256, scopes: ['upload'], label: "Robin's Quest 3" },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Marimba agent' },
    { id: 'other', sha256: other.sha256, scopes: ['upload'], projects: ['CAP'] },
  ]);
  let base: string; let close: () => Promise<void>; let video: Buffer; let sha: string;
  let server: Awaited<ReturnType<typeof testCli>>; let claude: Awaited<ReturnType<typeof fakeClaude>>;

  beforeAll(async () => {
    process.env.TZ = 'Europe/London';
    process.env.FAKE_WHISPER_JSON = new URL('./fixtures/whisper-output.json', import.meta.url).pathname;
    const tools = await fakeTools();
    claude = await fakeClaude(body => {
      const asked = JSON.stringify(body.messages).includes('<asked>');
      return { status: 200, body: claudeMessage(JSON.stringify({ title: asked ? 'Settings still hidden' : 'Drum circle idea', summary: asked ? 'Finds Settings still hard to reach from the new menu.' : 'Describes a drum circle to build.', requests: [] })) };
    });
    server = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '4', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    const file = join(await mkdtemp(join(tmpdir(), 'threads-video-')), 'clip.mp4');
    await makeVideo(file, 6);
    video = await readFile(file);
    sha = createHash('sha256').update(video).digest('hex');
  });
  afterAll(async () => { await close?.(); claude?.close(); delete process.env.FAKE_WHISPER_JSON; });

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  /** Creates an upload, sends the whole video and waits until its bundle is built. */
  const record = async (clientId: string, thread?: unknown, extra: Record<string, unknown> = {}) => {
    const created = await call('POST', '/v1/uploads', upload.token, { clientId, bytes: video.length, sha256: sha, fileName: 'clip.mp4', recordedAt: '2026-10-03T14:20:11+01:00', appPackage: 'net.polydance.capture', audioTracks: ['mic'], ...(thread ? { thread } : {}), ...extra });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    await call('PUT', `/v1/uploads/${id}/content`, upload.token, video, { 'content-range': `bytes 0-${video.length - 1}/${video.length}`, 'content-type': 'application/octet-stream' });
    for (let i = 0; i < 200; i++) {
      const status = (await call('GET', `/v1/uploads/${id}`, upload.token)).json;
      if (status.status === 'ready' || status.status === 'failed') {
        // The upload status commits before the thread's receipt/event (and title). Wait for
        // that actual observable event rather than racing the worker's remaining fsyncs.
        await expect.poll(async () => {
          const events=(await call('GET','/v1/events?after=0',mac.token)).json.events as Record<string,unknown>[];
          return events.some(e=>e.thread===status.thread && (e.kind==='recording.ready' || e.kind==='recording.failed') && (status.status==='failed' || e.sessionId===status.sessionId));
        }).toBe(true);
        return status;
      }
      await sleep(50);
    }
    throw new Error('upload never finished');
  };

  it('keeps scopes and projects apart', async () => {
    expect((await call('GET', '/v1/projects', upload.token)).json).toEqual({ me: 'quest3', capabilities: ['idempotent-replies-v1', 'models-v1', 'photos-v1', 'projects-new-v1', 'projects-edit-v1', 'agents-v1'], projects: [{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Polydance Capture' }] });
    expect((await call('GET', '/v1/projects', other.token)).json.projects).toEqual([{ key: 'CAP', name: 'Polydance Capture' }]);
    expect((await call('POST', '/v1/threads', upload.token, { project: 'MUS', title: 'x', text: 'y' })).status).toBe(403);
    const bad = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'x', launches: [{ steps: [{ do: 'open', url: 'https://evil.example/' }] }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/not one of MUS's hosts/);
    expect((await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'x', launches: [{ steps: [{ do: 'shell' }] }] })).status).toBe(400);
    const created = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'New menu', text: 'Is Settings easier to find?', launches: [{ label: 'Menu', steps: [{ do: 'open', url: menu }] }] });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ me: 'mac', key: 'MUS-1', project: { key: 'MUS', name: 'Marimba' }, unread: false, waiting: false });
    expect((await call('GET', '/v1/threads/MUS-1', other.token)).status).toBe(404);
    expect((await call('GET', '/v1/threads', other.token)).json).toMatchObject({ threads: [], unread: 0 });
    const list = (await call('GET', '/v1/threads', upload.token)).json;
    expect(list).toMatchObject({ me: 'quest3', unread: 1, threads: [{ key: 'MUS-1', unread: true, waiting: true, last: { kind: 'thread.new', by: { name: 'Marimba agent' }, text: 'Is Settings easier to find?' } }] });
    expect((await call('PATCH', '/v1/threads/MUS-1', upload.token, { title: 'Mine now' })).status).toBe(403);
    expect((await call('POST', '/v1/threads/MUS-1/title', upload.token, { title: 'Mine now' })).status).toBe(403);
    expect((await call('POST', '/v1/threads/MUS-1/title', mac.token, { title: '  ' })).status).toBe(400);
    expect((await call('POST', '/v1/threads/MUS-1/title', mac.token, { title: 'x', state: 'closed' })).status).toBe(400);
    expect((await call('POST', '/v1/threads/MUS-1/messages', upload.token, { text: 'hello' })).status).toBe(403);
    expect((await call('POST', '/v1/threads/MUS-1/reactions', upload.token, { message: 1, reaction: 'approve' })).status).toBe(400);
    expect((await call('POST', '/v1/threads/MUS-1/read', upload.token, { seq: 99 })).json).toMatchObject({ unread: false, readSeq: 1 });
    expect((await call('GET', '/v1/threads/..%2Fevents', upload.token)).status).toBe(404);
  });

  it('puts a recording in the thread it answers, and tells the bundle what was asked', async () => {
    const before = (await call('GET', '/v1/events', mac.token)).json.last as number;
    const done = await record('quest3-reply', { key: 'MUS-1', replyTo: { message: 1, launch: 0 } }, { opened: [{ atMs: 700, what: `open ${menu}`, label: 'Menu' }] });
    expect(done).toMatchObject({ status: 'ready', thread: 'MUS-1', title: 'Settings still hidden' });
    const thread = (await call('GET', '/v1/threads/MUS-1', mac.token)).json;
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]).toMatchObject({ id: 2, by: { id: 'quest3', name: "Robin's Quest 3" }, recording: { status: 'ready', sessionId: done.sessionId, title: 'Settings still hidden', replyTo: { message: 1, launch: 0 } } });
    expect(thread).toMatchObject({ unread: true, title: 'New menu' });
    const manifest = await loadSession(join(server.config.sessions, done.sessionId));
    expect(manifest.source.thread).toEqual({ key: 'MUS-1', project: 'MUS', title: 'New menu', opened: false, replyTo: { message: 1, text: 'Is Settings easier to find?', launch: { label: 'Menu', steps: [{ do: 'open', url: menu }] } } });
    expect(manifest.source.opened).toEqual([{ atMs: 700, what: `open ${menu}`, label: 'Menu' }]);
    expect(JSON.stringify(claude.calls.at(-1)!.body.messages)).toContain('<asked>\\nIs Settings easier to find?\\n</asked>');
    const storyboard = await readFile(join(server.config.sessions, done.sessionId, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('Thread MUS-1 in MUS, "New menu".\nIt answers the team\'s message #1: Is Settings easier to find?\nStarted with: Menu: open ' + menu);
    // Upload status and the thread's durable receipt/event are separate commits. Wait for the
    // event, rather than assuming a ready status means the worker has finished appending it.
    await expect.poll(async () => ((await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[]).map(e => e.kind)).toEqual(['recording', 'recording.ready']);
    const events = (await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[];
    expect(events[1]).toMatchObject({ thread: 'MUS-1', message: 2, sessionId: done.sessionId, title: 'Settings still hidden', summary: 'Finds Settings still hard to reach from the new menu.' });
  });

  it('opens a thread for a recording that names none, titled by its summary', async () => {
    const done = await record('quest3-idea');
    expect(done).toMatchObject({ status: 'ready', thread: 'MUS-2' });
    const thread = (await call('GET', '/v1/threads/MUS-2', upload.token)).json;
    expect(thread).toMatchObject({ title: 'Drum circle idea', by: { id: 'quest3' }, unread: false, messages: [{ recording: { status: 'ready', title: 'Drum circle idea' } }] });
    expect((await loadSession(join(server.config.sessions, done.sessionId))).source.thread).toMatchObject({ key: 'MUS-2', opened: true });
    expect((await call('POST', '/v1/uploads', upload.token, { clientId: 'x', bytes: 1, sha256: sha, fileName: 'x.mp4', thread: { key: 'MUS-1', replyTo: { message: 7 } } })).status).toBe(400);
    expect((await call('POST', '/v1/uploads', other.token, { clientId: 'x', bytes: 1, sha256: sha, fileName: 'x.mp4', thread: { key: 'MUS-1' } })).status).toBe(404);
  });

  it('holds an events request open until something happens', async () => {
    const last = (await call('GET', '/v1/events', upload.token)).json.last as number;
    const started = Date.now();
    const waitingCall = call('GET', `/v1/events?after=${last}&wait=10&thread=MUS-1`, upload.token);
    await sleep(200);
    await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'Moved Settings to the top.' });
    const answer = (await waitingCall).json;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(answer.events).toEqual([expect.objectContaining({ kind: 'message', thread: 'MUS-1', by: expect.objectContaining({ id: 'mac', name: 'Marimba agent' }) })]);
    expect((await call('GET', '/v1/events?after=x', upload.token)).status).toBe(400);
    expect((await call('GET', '/v1/events?after=0&wait=99', upload.token)).status).toBe(400);
  });

  it('keeps an agent token in a private file, never printed, and uses it from the repository that names it', async () => {
    const config = await mkdtemp(join(tmpdir(), 'polycap-config-'));
    process.env.POLYCAP_CONFIG = join(config, 'env');
    try {
      const maker = await testCli();
      await tokenNew(maker, { id: 'mus-agent', scopes: ['read', 'post'], projects: ['MUS'], user: 'robin', label: 'Mac', team: true, save: 'mus-agent' });
      const printed = maker.lines.join('\n');
      expect(printed).toContain('Token saved to');
      expect(printed).not.toMatch(/polycap_[0-9a-f]{64}/);
      const grantLine = JSON.parse(printed.match(/\{"id":"mus-agent".*\}/)![0]);
      expect(grantLine).toMatchObject({ id: 'mus-agent', scopes: ['read', 'post'], projects: ['MUS'], user: 'robin', label: 'Mac' });
      const file = join(config, 'tokens', 'mus-agent');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(tokenNew(maker, { id: 'again', scopes: ['read'], team: true, save: 'mus-agent' })).rejects.toThrow(/already exists/);
      // The repository names the token; a token the receiver does not know is refused there, which proves it was used.
      const repo = await mkdtemp(join(tmpdir(), 'repo-token-'));
      await writeFile(join(repo, '.polycap.json'), JSON.stringify({ project: 'MUS', token: 'mus-agent' }));
      const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
      await expect(threadList(agent, { cwd: repo })).rejects.toThrow(/401/);
      await writeFile(join(repo, '.polycap.json'), JSON.stringify({ project: 'MUS', token: 'nobody' }));
      await expect(threadList(agent, { cwd: repo })).rejects.toThrow(/does not exist/);
    } finally { delete process.env.POLYCAP_CONFIG; }
  });

  it('gives the agent its commands: link, list, show, new, reply, react, close and watch', async () => {
    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    const repo = await mkdtemp(join(tmpdir(), 'repo-'));
    await mkdir(join(repo, '.git')); await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    await projectList(agent);
    expect(agent.lines.at(-1)).toMatch(/MUS\s+Marimba\s+team\nCAP\s+Polydance Capture\s+team/);
    await expect(link(agent, 'ZZ', repo)).rejects.toThrow(/not a project this token sees/);
    expect(await link(agent, 'mus', join(repo, 'src', 'deep'))).toBe(join(repo, '.polycap.json'));
    expect(await findLink(join(repo, 'src', 'deep'))).toEqual({ file: join(repo, '.polycap.json'), project: 'MUS' });
    const cwd = join(repo, 'src');

    agent.lines.length = 0;
    await threadList(agent, { cwd });
    expect(agent.lines.join('\n')).toMatch(/MUS-1\s+New menu .*Robin's Quest 3: recording|MUS-1\s+New menu/);
    const key = await threadNew(agent, 'Drum sticks', { text: 'Do the sticks still pass through?', app: 'com.example.marimba', extra: ['variant=b'], require: ['com.example.marimba@231'], cwd });
    expect(key).toBe('MUS-3');
    await expect(threadNew(agent, 'x', { text: 'y', open: 'https://evil.example/', cwd })).rejects.toThrow(/not one of MUS's hosts/);
    expect(await threadReply(agent, '3', { text: 'Variant B moves the drum back.', cwd })).toBe(2);
    agent.lines.length = 0;
    await threadShow(agent, 'MUS-1', { cwd });
    const shown = agent.lines.join('\n');
    expect(shown).toContain('MUS-1 · New menu · Marimba · open');
    expect(shown).toContain('    Start: Menu: open ' + menu);
    expect(shown).toMatch(/#2 .* Robin's Quest 3 {2}recording \(answers #1, launch 1\)\n {4}ready · session 2026-10-03T14-20-11_capture · 00:06\n {4}"Settings still hidden": Finds Settings still hard to reach from the new menu\./);
    expect(shown).toContain('polycap show 2026-10-03T14-20-11_capture');
    // show marks it read for the agent's token.
    expect((await call('GET', '/v1/threads/MUS-1', mac.token)).json.unread).toBe(false);

    await threadReact(agent, 'MUS-1', '2', '👍');
    expect(agent.lines.at(-1)).toBe('MUS-1 #2: 👍');
    await expect(threadReact(agent, 'MUS-1', '2', 'approve')).rejects.toThrow(/reactions are heart/);
    // Close and rename both go by POST, so they pass the hosted receiver's nginx, which refuses PATCH (2026-11-02).
    const fetched = vi.spyOn(globalThis, 'fetch');
    await threadUpdate(agent, '3', { state: 'closed' }, { cwd });
    expect(agent.lines.at(-1)).toBe('MUS-3 · Drum sticks · closed');
    await threadUpdate(agent, '3', { title: 'Drum sticks, variant B' }, { cwd });
    expect(agent.lines.at(-1)).toBe('MUS-3 · Drum sticks, variant B · closed');
    expect(fetched.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('PATCH');
    expect(fetched.mock.calls.some(([url, init]) => init?.method === 'POST' && String(url).endsWith('/v1/threads/MUS-3/title'))).toBe(true);
    fetched.mockRestore();
    expect((await call('GET', '/v1/events?after=0&thread=MUS-3', mac.token)).json.events.at(-1)).toMatchObject({ kind: 'renamed', title: 'Drum sticks, variant B' });

    // watch --once returns on the tester's next move and skips the agent's own.
    const watching = threadWatch(agent, 'MUS-1', { once: true, timeout: '20s', cwd, pollSeconds: 2 });
    await sleep(300);
    await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'my own message' });
    await call('POST', '/v1/threads/MUS-1/reactions', upload.token, { message: 3, reaction: 'thumbs-up' });
    const event = await watching;
    expect(event).toMatchObject({ kind: 'reaction', thread: 'MUS-1', reaction: 'thumbs-up', by: { id: 'quest3' } });
    expect(agent.lines.at(-1)).toMatch(/MUS-1 reaction Robin's Quest 3: 👍 on #3$/);
    expect(await threadWatch(agent, 'MUS-1', { once: true, timeout: '1s', cwd, pollSeconds: 1 })).toBeUndefined();
    // An agent names itself, and the message says so.
    await threadReply(agent, 'MUS-1', { text: 'Signed.', as: 'Opus 5.5', cwd });
    expect((await call('GET', '/v1/threads/MUS-1', mac.token)).json.messages.at(-1).by).toMatchObject({ as: 'Opus 5.5', display: 'Opus 5.5 on Marimba agent' });
    await expect(threadReply(agent, 'MUS-1', { text: 'x', as: 'rm -rf /; echo', cwd })).rejects.toThrow(/agent name/);
    // --kind skips what it was not asked for: a reaction does not end a wait for a recording.
    const forRecording = threadWatch(agent, 'MUS-1', { once: true, kinds: ['recording.ready'], timeout: '2s', cwd, pollSeconds: 1 });
    await sleep(200);
    await call('POST', '/v1/threads/MUS-1/reactions', upload.token, { message: 3, reaction: 'heart' });
    expect(await forRecording).toBeUndefined();
    await expect(threadWatch(agent, 'MUS-1', { once: true, kinds: ['ready'], cwd })).rejects.toThrow(/events are thread.new/);
  });

  it('hears the narration before the video: words, a title and an event while the video uploads, then the frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'words-first-'));
    await writeFile(join(dir, 'clip.mp4'), video);
    // The app takes its mic track out without re-encoding it; so does this.
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', join(dir, 'clip.mp4'), '-map', '0:a:0', '-c', 'copy', join(dir, 'narration.m4a')]);
    const narration = await readFile(join(dir, 'narration.m4a'));
    const body = { clientId: 'quest3-words', bytes: video.length, sha256: sha, fileName: 'clip.mp4', recordedAt: '2026-10-04T09:30:00+01:00', appPackage: 'net.polydance.capture', audioTracks: ['mic'], narration: { bytes: narration.length, sha256: createHash('sha256').update(narration).digest('hex') } };
    // Only a recording with a mic can send its narration first.
    expect((await call('POST', '/v1/uploads', upload.token, { ...body, audioTracks: ['app'] })).status).toBe(400);
    const created = await call('POST', '/v1/uploads', upload.token, body);
    expect(created.json).toMatchObject({ status: 'uploading', narration: 'expected' });
    const id = created.json.id as string;
    const before = (await call('GET', '/v1/events', mac.token)).json.last as number;
    const sendNarration = (bytes: Buffer) => call('PUT', `/v1/uploads/${id}/narration`, upload.token, bytes, { 'content-type': 'audio/mp4' });
    expect((await sendNarration(narration.subarray(1))).status).toBe(400);
    const corrupt = Buffer.from(narration); corrupt[corrupt.length - 1] ^= 0xff;
    expect(await sendNarration(corrupt)).toMatchObject({ status: 409, json: { error: expect.stringMatching(/sha256/) } });
    expect((await sendNarration(narration)).json).toMatchObject({ status: 'uploading', narration: 'received' });

    // The words are built before a byte of the video has been sent. Wait for the thread to hear, which is
    // after the whole words pass: the title alone arrives with the summary, before the storyboard is written.
    let heard: Record<string, unknown>[] = [];
    for (let i = 0; i < 200 && !heard.length; i++) {
      heard = ((await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[]).filter(e => e.kind === 'recording.words');
      if (!heard.length) await sleep(50);
    }
    let status = (await call('GET', `/v1/uploads/${id}`, upload.token)).json as Record<string, any>;
    expect(status).toMatchObject({ status: 'uploading', received: 0, thread: 'MUS-4', title: 'Drum circle idea', sessionId: '2026-10-04T09-30-00_capture' });
    const sessionPath = join(server.config.sessions, status.sessionId);
    const words = await loadSession(sessionPath);
    expect(words.steps).toMatchObject({
      probe: { status: 'pending' }, audio: { status: 'done', note: 'the microphone, sent ahead of the video' }, transcribe: { status: 'done' },
      frames: { status: 'pending' }, pointing: { status: 'pending' }, markers: { status: 'done' }, summary: { status: 'done' }, storyboard: { status: 'done' },
    });
    expect(words.media.durationMs).toBeGreaterThan(5000);
    expect(await readFile(join(sessionPath, 'storyboard.md'), 'utf8')).toContain('**Words only so far.**');
    expect(((await call('GET', '/v1/sessions', mac.token)).json.sessions as Record<string, unknown>[]).find(s => s.id === words.id)).toMatchObject({ ready: false, words: true });
    expect(((await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[])).toEqual([
      expect.objectContaining({ kind: 'recording.words', thread: 'MUS-4', sessionId: words.id, title: 'Drum circle idea' }),
    ]);
    const listed = () => call('GET', '/v1/threads?project=MUS', mac.token).then(r => (r.json.threads as { key: string }[]).find(t => t.key === 'MUS-4'));
    expect(await listed()).toMatchObject({ title: 'Drum circle idea', fresh: 1, last: { kind: 'recording.words', text: 'words ready: Drum circle idea' } });

    // An agent syncs the words now, and they say what is still to come.
    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    expect((await sync(agent, { video: false, dryRun: false })).wordsOnly).toEqual([words.id]);
    const local = join(agent.config.sessions, words.id);
    expect(await exists(join(local, 'transcript.md'))).toBe(true);
    expect(await exists(join(local, 'narration.m4a'))).toBe(false);
    expect(await exists(join(local, 'frames.json'))).toBe(false);
    await show(agent, words.id);
    expect(agent.lines.join('\n')).toContain('words only: the video was still uploading');

    // The video arrives: frames and a full storyboard join the same session, and the words are not redone.
    await call('PUT', `/v1/uploads/${id}/content`, upload.token, video, { 'content-range': `bytes 0-${video.length - 1}/${video.length}`, 'content-type': 'application/octet-stream' });
    for (let i = 0; i < 200 && status.status !== 'ready' && status.status !== 'failed'; i++) { await sleep(50); status = (await call('GET', `/v1/uploads/${id}`, upload.token)).json; }
    expect(status).toMatchObject({ status: 'ready', sessionId: words.id, steps: { done: 10, total: 10 } });
    const built = await loadSession(sessionPath);
    expect(built.steps).toMatchObject({ probe: { status: 'done' }, frames: { status: 'done' }, pointing: { status: 'skipped' } });
    expect(built.steps.transcribe.at).toBe(words.steps.transcribe.at);
    expect(built.steps.storyboard.at).not.toBe(words.steps.storyboard.at);
    const storyboard = await readFile(join(sessionPath, 'storyboard.md'), 'utf8');
    expect(storyboard).not.toContain('Words only so far');
    expect(storyboard).toMatch(/- \d\d:\d\d frames\/\d{4}_\d\dm\d\ds\.jpg/);
    await expect.poll(async () => ((await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as { kind: string }[]).map(e => e.kind)).toEqual(['recording.words', 'recording.ready']);
    expect(await listed()).toMatchObject({ fresh: 1, last: { kind: 'recording.ready' } });
    // Too late to help: a narration sent after the video changes nothing.
    expect((await sendNarration(narration)).json).toMatchObject({ status: 'ready', narration: 'received' });
    expect((await sync(agent, { video: false, dryRun: false })).downloaded).toContain(words.id);
    expect((await loadSession(local)).steps.frames.status).toBe('done');
    expect(await exists(join(local, 'frames.json'))).toBe(true);
  });

  it('offers options in one message: a star on one, and a recording says which it tried', async () => {
    const posted = await call('POST', '/v1/threads/MUS-1/messages', mac.token, { text: 'Two menus to compare.', launches: [{ label: 'Blue', steps: [{ do: 'open', url: menu }] }, { label: 'Red', steps: [{ do: 'open', url: `${menu}red` }] }] });
    expect(posted.status).toBe(201);
    const message = posted.json.messages.at(-1).id as number;
    const before = (await call('GET', '/v1/events', mac.token)).json.last as number;
    const picked = await call('POST', '/v1/threads/MUS-1/picks', upload.token, { message, launch: 1 });
    expect(picked.json.messages.at(-1).picks).toEqual([expect.objectContaining({ launch: 1, by: expect.objectContaining({ id: 'quest3' }) })]);
    expect((await call('POST', '/v1/threads/MUS-1/picks', upload.token, { message: 1, launch: 0 })).json.error).toMatch(/no options to pick between/);
    expect((await call('POST', '/v1/threads/MUS-1/picks', upload.token, { message, launch: 5 })).status).toBe(400);
    expect((await call('POST', '/v1/threads/MUS-1/picks', other.token, { message, launch: 0 })).status).toBe(404);
    expect(((await call('GET', `/v1/events?after=${before}`, mac.token)).json.events as Record<string, unknown>[]).map(e => [e.kind, e.launch])).toEqual([['pick', 1]]);
    expect((await call('GET', '/v1/threads?project=MUS', mac.token)).json.threads.find((t: { key: string }) => t.key === 'MUS-1')).toMatchObject({ last: { kind: 'pick', text: `picked option 2: Red in #${message}` } });
    // One take over both: the launch log says which was on screen when, and the card says both were tried.
    const done = await record('quest3-options', { key: 'MUS-1', replyTo: { message, launch: 0 } }, { opened: [
      { atMs: 600, what: `open ${menu}`, label: 'Blue', message, launch: 0 }, { atMs: 3200, what: `open ${menu}red`, label: 'Red', message, launch: 1 },
    ] });
    expect((await call('GET', '/v1/threads/MUS-1', mac.token)).json.messages.at(-1).recording).toMatchObject({ status: 'ready', replyTo: { message, launch: 0 }, tried: [0, 1] });
    const storyboard = await readFile(join(server.config.sessions, done.sessionId, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain(`- [00:00] option 1: Blue: open ${menu}\n- [00:03] option 2: Red: open ${menu}red\n`);
  });
});
