/**
 * Finding recordings and calls (find.ts, 2026-11-12): `polycap list`'s filters and `--calls` table,
 * `polycap search` over transcript lines, titles and summaries, the day words, the refusals, and the
 * receiver and skill checks `polycap doctor` makes for an agent's setup. Bundles are made here with
 * createSession and hand-written transcripts; nothing reads the real library or ~/.claude/skills.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor.js';
import { findSessions, matchesAll, search, SEARCH_LINES, timeBound } from '../src/commands/find.js';
import { list } from '../src/commands/inspect.js';
import { repoSkillDir, SKILL_NAME } from '../src/commands/install-skill.js';
import { createSession, saveSession, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { testCli, type TestCli } from './helpers/cli.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mac-call-meta.json', import.meta.url), 'utf8'));

interface Line { at: number; text: string; speaker?: 'me' | 'others'; name?: string }

/** A finished bundle: a call when `call` is given, with its transcript lines and the people Meet's ring was seen on. */
async function bundle(cli: TestCli, recordedAt: Date, options: { call?: Record<string, unknown>; lines?: Line[]; seen?: string[]; title?: string; summary?: string; thread?: string }) {
  const file = join(cli.config.root, `v-${Math.random().toString(16).slice(2, 8)}.mp4`);
  await writeFile(file, 'not really a video');
  const call = options.call ? { ...fixture.call, startedAt: recordedAt.toISOString(), endedAt: new Date(recordedAt.getTime() + 2_700_000).toISOString(), ...options.call } : undefined;
  const thread = options.thread ? { key: options.thread, project: options.thread.split('-')[0], title: 'New menu', opened: false } : undefined;
  const { dir, manifest } = await createSession(cli.config, {
    localFile: file, originalName: call ? 'polydance-mac.mp4' : 'capture.mp4', bytes: 18, recordedAt,
    source: { kind: 'import', ...(call ? { call, audioTracks: ['mic', 'app'] } : {}), ...(thread ? { thread } : {}) },
  });
  const steps = Object.fromEntries(STEP_NAMES.map(n => [n, { status: 'done' }])) as SessionManifest['steps'];
  const title = options.title ?? 'A recording';
  await saveSession(dir, { ...manifest, title, summary: { title, text: options.summary ?? 'One sentence.', model: 'claude-test' }, steps, media: { ...manifest.media, durationMs: 2_700_000 } });
  const segments = (options.lines ?? []).map(l => ({ startMs: l.at * 1000, endMs: l.at * 1000 + 2000, text: l.text, ...(l.speaker ? { speaker: l.speaker } : {}), ...(l.name ? { name: l.name } : {}) }));
  await writeFile(join(dir, 'transcript.json'), JSON.stringify({ version: 1, engine: 'test', segments }));
  if (options.seen) await writeFile(join(dir, 'speakers.json'), JSON.stringify({
    version: 1, source: 'meet-ring', reader: { everyMs: 500, sampled: 10, withRing: 8, namesRead: 8, elapsedMs: 100, kinds: { ring: 8, badge: 0, pill: 0 } },
    me: { check: 'unchecked', lines: 0, onMe: 0, othersLines: 0, othersOnMe: 0 },
    people: options.seen.map(name => ({ name, lines: 1, seenMs: 1000, readAs: [name] })),
    lines: { others: 1, named: 1, mixed: 0, unseen: 0 }, timeline: [],
  }));
  return manifest.id;
}

/** Three calls and two walkthroughs over two days, on this machine's calendar. Every name, code and word is made up. */
async function library() {
  const cli = await testCli();
  const ids = {
    fonts: await bundle(cli, new Date(2026, 2, 10, 10, 15), { call: { meetingCode: 'kqr-mnop-stu' }, seen: ['Ana Lima', 'Ben Okafor'], title: 'Choosing a typeface', summary: 'Asking a designer.', lines: [
      { at: 10, speaker: 'me', text: 'Shall we ask a designer about it?' },
      { at: 20, speaker: 'others', name: 'Ana Lima', text: 'My friend could check the SERIF fonts.' },
      { at: 30, speaker: 'others', text: 'The fonts in serif are nearly done.' },
    ] }),
    weekly: await bundle(cli, new Date(2026, 2, 10, 16, 0), { call: { meetingCode: 'abc-defg-hij' }, lines: [{ at: 5, speaker: 'others', name: 'Cleo Park', text: 'Lock the plan first.' }], title: 'Weekly plan' }),
    lastWeek: await bundle(cli, new Date(2026, 2, 3, 16, 0), { call: { meetingCode: 'abc-defg-hij' }, lines: [{ at: 5, speaker: 'me', text: 'Café crème, s\'il vous plaît.' }], title: 'Last week' }),
    walk: await bundle(cli, new Date(2026, 2, 10, 20, 5), { thread: 'APP-3', lines: [{ at: 4, text: 'The settings page is too busy' }], title: 'Settings page too busy' }),
    oldWalk: await bundle(cli, new Date(2026, 1, 2, 12, 0), { lines: Array.from({ length: SEARCH_LINES + 3 }, (_, i) => ({ at: i * 5, text: `gesture test ${i}` })), title: 'Gesture tests' }),
  };
  return { cli, ids };
}

const idsOf = async (cli: TestCli, options: Parameters<typeof findSessions>[1]) => (await findSessions(cli, options)).map(s => s.manifest.id);

describe('finding recordings and calls', () => {
  it('turns days and times into bounds on this machine\'s calendar, and refuses anything else', () => {
    const now = new Date(2026, 2, 11, 9, 30);
    expect(timeBound('2026-03-10', false)).toBe(new Date(2026, 2, 10).getTime());
    expect(timeBound('2026-03-10', true)).toBe(new Date(2026, 2, 11).getTime() - 1);
    expect(timeBound('today', false, now)).toBe(new Date(2026, 2, 11).getTime());
    expect(timeBound('Yesterday', true, now)).toBe(new Date(2026, 2, 11).getTime() - 1);
    expect(timeBound('2026-03-10T13:00:00Z', false)).toBe(Date.parse('2026-03-10T13:00:00Z'));
    for (const bad of ['2026-02-30', 'last week', '10/03/2026', '2026-03-10Tnoon']) expect(() => timeBound(bad, false)).toThrow(/not a day or a time/);
  });

  it('filters by kind, day, meeting code, person, thread and count, newest first', async () => {
    const { cli, ids } = await library();
    const now = new Date(2026, 2, 11, 9, 30);
    expect(await idsOf(cli, { calls: true })).toEqual([ids.weekly, ids.fonts, ids.lastWeek]);
    expect(await idsOf(cli, { walkthroughs: true })).toEqual([ids.walk, ids.oldWalk]);
    expect(await idsOf(cli, { since: 'yesterday', until: 'yesterday', now })).toEqual([ids.walk, ids.weekly, ids.fonts]);
    expect(await idsOf(cli, { calls: true, since: '2026-03-10T12:00:00', until: '2026-03-10' })).toEqual([ids.weekly]);
    // The same code is the same recurring meeting, this week's and last week's.
    expect(await idsOf(cli, { meeting: 'ABC-DEFG-HIJ' })).toEqual([ids.weekly, ids.lastWeek]);
    // A person seen by Meet's ring (speakers.json) or named on a line (transcript.json), any part, any case.
    expect(await idsOf(cli, { with: 'ana' })).toEqual([ids.fonts]);
    expect(await idsOf(cli, { with: 'OKAFOR' })).toEqual([ids.fonts]);
    expect(await idsOf(cli, { with: 'cleo' })).toEqual([ids.weekly]);
    expect(await idsOf(cli, { with: 'nobody' })).toEqual([]);
    expect(await idsOf(cli, { thread: 'app-3' })).toEqual([ids.walk]);
    expect(await idsOf(cli, { calls: true, limit: '1' })).toEqual([ids.weekly]);
  });

  it('refuses filters that cannot mean anything', async () => {
    const { cli } = await library();
    await expect(findSessions(cli, { calls: true, walkthroughs: true })).rejects.toThrow(/match everything/);
    await expect(findSessions(cli, { meeting: 'standup' })).rejects.toThrow(/abc-defg-hij/);
    for (const limit of ['0', '-2', 'many', '1.5']) await expect(findSessions(cli, { limit })).rejects.toThrow(/whole number/);
    await expect(search(cli, ['  '])).rejects.toThrow(/needs words/);
  });

  it('lists calls with who was on them, and says what each recording is in --json', async () => {
    const { cli, ids } = await library();
    await list(cli, { calls: true, since: '2026-03-10', until: '2026-03-10' });
    const text = cli.lines.join('\n');
    expect(text).toMatch(new RegExp(`${ids.fonts}\\s+Choosing a typeface\\s+45:00\\s+Google Meet kqr-mnop-stu in arc\\s+Ana Lima, Ben Okafor`));
    expect(text).toContain('Cleo Park');
    expect(text).not.toContain(ids.lastWeek);

    const json = await testCli({ POLYCAP_ROOT: cli.config.root });
    json.json = true;
    await list(json, {});
    const all = JSON.parse(json.lines.join('\n')) as { id: string; kind: string; call?: { meetingCode: string; people: string[]; told: string }; thread?: { key: string } }[];
    expect(all.find(s => s.id === ids.fonts)).toMatchObject({ kind: 'call', call: { meetingCode: 'kqr-mnop-stu', people: ['Ana Lima', 'Ben Okafor'], told: 'unknown' } });
    expect(all.find(s => s.id === ids.walk)).toMatchObject({ kind: 'walkthrough', thread: { key: 'APP-3' } });
    expect(all.find(s => s.id === ids.walk)?.call).toBeUndefined();

    const none = await testCli({ POLYCAP_ROOT: cli.config.root });
    await list(none, { with: 'nobody' });
    expect(none.lines.join('\n')).toMatch(/No sessions match\. Run `polycap sync` first/);
  });

  it('searches transcript lines for every word, in any order, case or accent, with clocks and speakers', async () => {
    expect(matchesAll('The fonts in serif are nearly done.', ['serif', 'fonts'])).toBe(true);
    expect(matchesAll('Café crème', ['cafe'])).toBe(true);
    expect(matchesAll('The fonts are done', ['serif', 'fonts'])).toBe(false);

    const { cli, ids } = await library();
    const results = await search(cli, ['Serif fonts']);
    expect(results.map(r => r.session.manifest.id)).toEqual([ids.fonts]);
    expect(results[0].hits.map(h => [h.atMs, h.speaker])).toEqual([[20_000, 'Ana Lima'], [30_000, 'Others']]);
    const text = cli.lines.join('\n');
    expect(text).toContain(`${ids.fonts}  Choosing a typeface  (call with Ana Lima, Ben Okafor, 45:00)`);
    expect(text).toContain('  [00:20] Ana Lima: My friend could check the SERIF fonts.');
    expect(text).toContain('  [00:30] Others: The fonts in serif are nearly done.');

    // The title or summary counts, and accents fold both ways.
    const designer = await testCli({ POLYCAP_ROOT: cli.config.root });
    expect((await search(designer, ['designer'])).map(r => [r.session.manifest.id, r.titleHit, r.hits.length])).toEqual([[ids.fonts, true, 1]]);
    expect((await search(designer, ['creme'])).map(r => r.session.manifest.id)).toEqual([ids.lastWeek]);

    // Filters narrow it, --limit counts sessions with a match, and nothing found says so.
    const filtered = await testCli({ POLYCAP_ROOT: cli.config.root });
    expect(await search(filtered, ['the'], { walkthroughs: true, limit: '1' })).toHaveLength(1);
    expect((await search(filtered, ['plan'], { meeting: 'kqr-mnop-stu' }))).toEqual([]);
    expect(filtered.lines.at(-1)).toMatch(/Nothing in the library says "plan" with those filters/);
  });

  it('prints ten lines a session and says where the rest are; --json has them all', async () => {
    const { cli, ids } = await library();
    await search(cli, ['gesture']);
    const text = cli.lines.join('\n');
    expect(text.match(/\[\d\d:\d\d\] gesture test/g)).toHaveLength(SEARCH_LINES);
    expect(text).toContain(`... 3 more lines: polycap search ... --json, or polycap transcript ${ids.oldWalk} --from 00:50`);
    const json = await testCli({ POLYCAP_ROOT: cli.config.root });
    json.json = true;
    await search(json, ['gesture']);
    expect(JSON.parse(json.lines.join('\n'))[0].matches).toHaveLength(SEARCH_LINES + 3);
  });
});

describe('doctor, for an agent\'s setup', () => {
  const lines = async (env: NodeJS.ProcessEnv, skillsDir: string) => { const cli = await testCli(env); await doctor(cli, { skillsDir }); return cli.lines.join('\n'); };

  it('says whether the receiver is set and whether the skill is this polycap\'s, without failing on either', async () => {
    const skills = await mkdtemp(join(tmpdir(), 'polycap-doctor-skills-'));
    const cli = await testCli();
    await doctor(cli, { skillsDir: skills });
    expect(cli.lines.join('\n')).toMatch(/missing\s+receiver\s+not set: threads and polycap sync need POLYCAP_REMOTE_URL/);
    expect(cli.lines.join('\n')).toMatch(/missing\s+skill\s+not installed: polycap install-skill/);
    expect(cli.lines.join('\n')).not.toMatch(/MISSING\s+(receiver|skill)/);

    expect(await lines({ POLYCAP_REMOTE_URL: 'https://receiver.example' }, skills)).toMatch(/missing\s+receiver\s+https:\/\/receiver\.example, but POLYCAP_REMOTE_TOKEN is not set/);
    expect(await lines({ POLYCAP_REMOTE_URL: 'https://receiver.example', POLYCAP_REMOTE_TOKEN: 'secret-token' }, skills)).toMatch(/ok\s+receiver\s+https:\/\/receiver\.example \(threads and polycap sync/);
    expect(await lines({ POLYCAP_REMOTE_URL: 'https://receiver.example', POLYCAP_REMOTE_TOKEN: 'secret-token' }, skills)).not.toContain('secret-token');

    await symlink(repoSkillDir(), join(skills, SKILL_NAME), 'dir');
    expect(await lines({}, skills)).toMatch(/ok\s+skill\s+.*polydance-capture -> this polycap's skill\//);

    const elsewhere = await mkdtemp(join(tmpdir(), 'polycap-doctor-skills-'));
    await symlink(tmpdir(), join(elsewhere, SKILL_NAME), 'dir');
    expect(await lines({}, elsewhere)).toMatch(/missing\s+skill\s+.*links to .*, not this polycap's skill: polycap install-skill --force/);

    const copy = await mkdtemp(join(tmpdir(), 'polycap-doctor-skills-'));
    await mkdir(join(copy, SKILL_NAME));
    expect(await lines({}, copy)).toMatch(/missing\s+skill\s+.*is a copy, which does not update with polycap/);
  });
});
