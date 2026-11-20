/**
 * Naming Others' lines from Meet's speaking ring (src/pipeline/speakers.ts): folding the names as read
 * into people, finding the recorder's own tile, the check against Me's lines, and each line's name.
 * Pure logic on made-up reader reports; the reader itself is tested in mac/Tests/SpeakerTilesTests.
 */
import { describe, expect, it } from 'vitest';
import { foldNames, isPersonName, nameKey, nameSpeakers, speakersFileSchema, toolReportSchema, type ToolReport } from '../src/pipeline/speakers.js';
import type { TranscriptSegment } from '../src/pipeline/transcribe.js';

const box = { x: 100, y: 100, width: 300, height: 200 };
/** A report whose samples every 500 ms ring whoever `who(atMs)` names (nothing for undefined). */
function report(untilMs: number, who: (atMs: number) => string | string[] | undefined): ToolReport {
  const samples: ToolReport['samples'] = [];
  for (let atMs = 0; atMs <= untilMs; atMs += 500) {
    const names = [who(atMs)].flat().filter((n): n is string => Boolean(n));
    if (names.length) samples.push({ atMs, rings: names.map(name => ({ box, name, fresh: false })) });
  }
  return { version: 1, tool: 'polydance-speakers', width: 1920, height: 1080, everyMs: 500, sampled: untilMs / 500 + 1, withRing: samples.length, namesRead: 3, elapsedMs: 1200, samples };
}
const me = (startMs: number, endMs: number, text = 'me'): TranscriptSegment => ({ startMs, endMs, text, speaker: 'me' });
const them = (startMs: number, endMs: number, text = 'them'): TranscriptSegment => ({ startMs, endMs, text, speaker: 'others' });

/** Me alone in five lines (0-1 s, 10-11 s ... 40-41 s), Others between them. */
const meLines = [0, 10_000, 20_000, 30_000, 40_000].map(at => me(at, at + 1000));

describe('the names as read', () => {
  it('compares names by their letters alone', () => {
    expect(nameKey('Grace Höpper')).toBe(nameKey('Grace Hopper'));
    expect(nameKey('Grace Ho…')).toBe('graceho');
  });

  it('takes a shared window\'s title for no one', () => {
    expect(isPersonName('Grace Hopper')).toBe(true);
    expect(isPersonName("Siobhán O'Neill-Hart")).toBe(true);
    expect(isPersonName('ScreenRecording_2')).toBe(false);
    expect(isPersonName('Calendar • Musevers')).toBe(false);
    expect(isPersonName("'Grace Hopper")).toBe(false);
    expect(isPersonName('A')).toBe(false);
    // Another app's list item, read beside a badge on the first call.
    expect(isPersonName('Conversational site redesign mockup')).toBe(false);
    expect(isPersonName('Chopin lessons recording sync')).toBe(false);
    expect(isPersonName('Ludwig van Beethoven')).toBe(true);
    expect(isPersonName('robin spottiswoode')).toBe(true);
  });

  it('folds misreadings and names cut short into the people they are part of, as on the first call', () => {
    // The readings and how often each was seen on 2026-11-11 (names changed).
    const seen = new Map([
      ['Ada Lovelace', 1457], ['Grace Hopper', 1448], ['Alan Turing', 1032],
      ['Ada Lo', 65], ['Ada Lovelacy', 12], ['Ada Lo.', 10], ['ScreenRecording_2', 8], ['AdaL', 7], ['Ada Lovelaze', 6], ['da Lovel', 4], ['Grace Höpper', 2], ['Ada Love', 2],
    ].map(([name, samples]) => [name as string, { samples: samples as number, truncated: ['Ada Lo', 'Ada Lo.', 'da Lovel', 'ScreenRecording_2'].includes(name as string) }]));
    const people = foldNames(seen);
    expect(new Set(people.values())).toEqual(new Set(['Ada Lovelace', 'Grace Hopper', 'Alan Turing', undefined]));
    for (const reading of ['Ada Lo', 'Ada Lovelacy', 'Ada Lo.', 'AdaL', 'Ada Lovelaze', 'da Lovel', 'Ada Love']) expect(people.get(reading), reading).toBe('Ada Lovelace');
    expect(people.get('Grace Höpper')).toBe('Grace Hopper');
    expect(people.get('ScreenRecording_2')).toBeUndefined();
  });

  it('keeps a name cut short, or seen only a moment, from becoming a person of its own', () => {
    const people = foldNames(new Map([['Ada Lovelace', { samples: 50, truncated: false }], ['Bob Ga', { samples: 30, truncated: true }], ['Zed Quux', { samples: 2, truncated: false }], ['Al', { samples: 9, truncated: false }]]));
    expect(people.get('Bob Ga')).toBeUndefined();
    expect(people.get('Zed Quux')).toBeUndefined();
    // Two letters are not enough to be part of someone; nine sightings are enough to be someone.
    expect(people.get('Al')).toBe('Al');
  });

  it('leaves a reading that could be either of two people as no one', () => {
    const people = foldNames(new Map([['Sam Smith', { samples: 40, truncated: false }], ['Sam Smythe', { samples: 30, truncated: false }], ['Sam Sm', { samples: 5, truncated: true }]]));
    expect(people.get('Sam Sm')).toBeUndefined();
    expect(people.get('Sam Smythe')).toBe('Sam Smythe');
  });

  it('folds a name cut short into the whole one even when it was read as often, or more', () => {
    const people = foldNames(new Map([['Grace Ho', { samples: 40, truncated: true }], ['Grace Hopper', { samples: 4, truncated: false }]]));
    expect(people.get('Grace Ho')).toBe('Grace Hopper');
  });
});

describe('naming the lines', () => {
  it('names each Others line for the person ringed through it, leaves Me\'s alone, and checks the ring on Me\'s own lines', () => {
    const segments = [...meLines, them(2000, 8000, 'grace speaks'), them(12_000, 18_000, 'alan speaks'), them(22_000, 28_000, 'two at once'), them(32_000, 38_000, 'no ring'), them(42_000, 44_000, 'Ada answers herself?')]
      .sort((a, b) => a.startMs - b.startMs);
    const named = nameSpeakers(segments, report(44_000, at => {
      if (meLines.some(l => at >= l.startMs + 250 && at <= l.endMs + 250)) return 'Ada Lovelace';
      if (at >= 2000 && at <= 8000) return 'Grace Hopper';
      if (at >= 12_000 && at <= 18_000) return at < 13_000 ? ['Alan Turing', 'Ada Lovelace'] : 'Alan Turing';
      if (at >= 22_000 && at <= 28_000) return at % 1000 ? 'Grace Hopper' : 'Alan Turing';
      if (at >= 42_000) return 'Ada Lovelace';
      return undefined;
    }));
    expect(named.trusted).toBe(true);
    expect(named.segments.map(s => [s.text, s.name])).toEqual([
      ['me', undefined], ['grace speaks', 'Grace Hopper'], ['me', undefined], ['alan speaks', 'Alan Turing'], ['me', undefined], ['two at once', undefined],
      ['me', undefined], ['no ring', undefined], ['me', undefined], ['Ada answers herself?', undefined],
    ]);
    expect(named.file.me).toEqual({ name: 'Ada Lovelace', check: 'passed', lines: 5, onMe: 5, othersLines: 4, othersOnMe: 1 });
    expect(named.file.lines).toEqual({ others: 5, named: 2, mixed: 1, unseen: 2 });
    expect(named.file.people.map(p => [p.name, p.lines])).toEqual([['Grace Hopper', 1], ['Alan Turing', 1], ['Ada Lovelace', 0]]);
    expect(named.file.timeline[0]).toEqual({ startMs: 500, endMs: 1000, name: 'Ada Lovelace' });
    expect(speakersFileSchema.parse(named.file)).toEqual(named.file);
    // Counts only: session.json never holds the others' names (T2).
    expect(named.note).toBe("2 of 5 Others lines named from Meet's speaking ring, 2 people; 1 with more than one person ringed and 2 with no ring left as Others; checked on Me's own lines: the ring on Me's tile in 5 of 5, on it in 1 of 4 of Others' own; " + `${named.file.reader.withRing} of 89 frames showed someone speaking (ring), read in 1 s`);
    expect(named.note).not.toMatch(/Grace|Alan|Ada/);
  });

  it('names no one when the ring is not on Me\'s tile while Me speaks: Meet\'s look has changed or the ring is misread', () => {
    const segments = [...meLines, them(2000, 8000)];
    const named = nameSpeakers(segments, report(44_000, at => (at % 10_000 < 1500 ? 'Grace Hopper' : at < 9000 ? 'Grace Hopper' : 'Ada Lovelace')));
    expect(named.trusted).toBe(false);
    expect(named.segments.every(s => s.name === undefined)).toBe(true);
    expect(named.file.me.check).toBe('failed');
    expect(named.note).toMatch(/^not named: the ring was on Me's tile in \d+ of 5 of Me's own lines/);
  });

  it('names lines unchecked when Me has too few lines of their own, and says so', () => {
    const segments = [me(0, 2000), them(3000, 6000, 'grace')];
    const named = nameSpeakers(segments, report(7000, at => (at <= 2250 ? 'Ada Lovelace' : 'Grace Hopper')));
    expect(named.segments[1].name).toBe('Grace Hopper');
    expect(named.file.me).toMatchObject({ name: 'Ada Lovelace', check: 'unchecked', lines: 1 });
    expect(named.note).toContain("unchecked: only 1 of Me's own lines had a ring");
  });

  it('takes the tile Meet labelled "(You…)" as Me\'s, and drops names an earlier run gave', () => {
    const r = report(7000, at => (at <= 2250 ? 'Ada Lovelace' : 'Grace Hopper'));
    r.samples[7].rings.push({ box, name: 'Grace Hopper', you: true, fresh: true });
    const named = nameSpeakers([me(0, 2000), { ...them(3000, 6000), name: 'Someone Old' }], r);
    expect(named.file.me.name).toBe('Grace Hopper');
    expect(named.segments[1].name).toBeUndefined();
  });

  it('names lines from the badge alone and the green pill as from the ring, and counts each', () => {
    // Version 2: the two-person layout's badge for Grace, a pill for Alan while Ada presents, rings for Ada.
    const r = report(44_000, at => {
      if (meLines.some(l => at >= l.startMs + 250 && at <= l.endMs + 250)) return 'Ada Lovelace';
      if (at >= 2000 && at <= 8000) return 'Grace Hopper';
      if (at >= 12_000 && at <= 18_000) return 'Alan Turing';
      return undefined;
    });
    const kinded = { ...r, version: 2 as const, samples: r.samples.map(s => ({ ...s, rings: s.rings.map(ring => ({ ...ring, kind: ring.name === 'Grace Hopper' ? 'badge' as const : ring.name === 'Alan Turing' ? 'pill' as const : 'ring' as const })) })) };
    const named = nameSpeakers([...meLines, them(2000, 8000, 'grace'), them(12_000, 18_000, 'alan')].sort((a, b) => a.startMs - b.startMs), toolReportSchema.parse(kinded));
    expect(named.segments.filter(s => s.name).map(s => [s.text, s.name])).toEqual([['grace', 'Grace Hopper'], ['alan', 'Alan Turing']]);
    expect(named.file.reader.kinds).toEqual({ ring: 10, badge: 13, pill: 13 });
    expect(named.note).toContain('36 of 89 frames showed someone speaking (ring 10, badge 13, pill 13)');
  });

  it('refuses a report that is not the reader\'s', () => {
    expect(() => toolReportSchema.parse({ ...report(1000, () => 'Ada Lovelace'), version: 3 })).toThrow();
    expect(() => toolReportSchema.parse({ ...report(1000, () => 'Ada Lovelace'), samples: [{ atMs: 0, rings: [{ kind: 'halo', box, name: 'Ada', fresh: true }] }] })).toThrow();
    expect(() => toolReportSchema.parse({ ...report(1000, () => 'Ada Lovelace'), samples: [{ atMs: 0, rings: [] }] })).toThrow();
  });
});
