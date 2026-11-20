/**
 * Who of the Others spoke each line of a Meet call (docs/MAC.md P3a, built 2026-11-11). Meet rings the
 * tile of whoever is talking and writes their name on it (or, with two people, shows only its badge; while
 * someone presents, a green pill behind the name); `polydance-speakers` (mac/Sources/SpeakerTiles)
 * reads the recording on the Mac for those rings and names, and this decides what they mean:
 *
 * - The names as read are folded into people: a name cut short beside a shared screen ("Grace Ho…"),
 *   or misread ("Grace Hoppen", "GraceH"), joins the person it is part of or one letter away from; a
 *   label that is not a person's name (a shared window's title, "ScreenRecording_2…") is no one.
 * - The recorder's own tile is the person most ringed while only Me speaks, and the ring is checked on
 *   it: on the first call it was on Me's tile in 92% of such moments and off it in 98% of Others' own.
 *   When that check fails, Meet's look has changed or the ring is being misread, and no line is named.
 * - An Others line is named for the person ringed for most of it (at least 60% of the rings seen, Me's
 *   own left out); with no ring, or two people about evenly, it stays "Others". Never a guess from
 *   who was invited.
 *
 * Names are the other people's, so they stay in the bundle's own files (transcript.json, speakers.json,
 * the markdown) and out of session.json, whose step note gives counts only (T2).
 */
import { z } from 'zod';
import type { TranscriptSegment } from './transcribe.js';

const boxSchema = z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() });

/** How Meet showed someone speaking (mac/Sources/SpeakerTiles/Indicators.swift): a ring round the tile, its badge alone, or a green pill behind the name. */
export const INDICATOR_KINDS = ['ring', 'badge', 'pill'] as const;

/**
 * What polydance-speakers writes (mac/Sources/SpeakerTiles/SpeakerReader.swift SpeakerReport); change both
 * together. Version 2 (2026-11-11) gives each indicator its kind; version 1 had rings only.
 */
export const toolReportSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]), tool: z.literal('polydance-speakers'),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), everyMs: z.number().int().positive(),
  sampled: z.number().int().nonnegative(), withRing: z.number().int().nonnegative(), namesRead: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  samples: z.array(z.strictObject({
    atMs: z.number().int().nonnegative(),
    rings: z.array(z.strictObject({
      kind: z.enum(INDICATOR_KINDS).optional(), box: boxSchema, name: z.string().min(1).max(200).optional(), truncated: z.literal(true).optional(), you: z.literal(true).optional(), fresh: z.boolean(),
    })).min(1),
  })),
});
export type ToolReport = z.infer<typeof toolReportSchema>;

/** speakers.json: what the step concluded, with what it rests on. */
export const speakersFileSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal('meet-ring'),
  reader: z.strictObject({
    everyMs: z.number().int().positive(), sampled: z.number().int().nonnegative(), withRing: z.number().int().nonnegative(), namesRead: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
    /** How many times each of Meet's ways of showing a speaker was seen. */
    kinds: z.strictObject({ ring: z.number().int().nonnegative(), badge: z.number().int().nonnegative(), pill: z.number().int().nonnegative() }),
  }),
  /** The recorder's own tile, and the check of the ring against Me's lines. */
  me: z.strictObject({
    name: z.string().optional(),
    check: z.enum(['passed', 'failed', 'unchecked']),
    /** Me's lines said with no Others line over them that had a ring, and of those how many had it on Me's tile. */
    lines: z.number().int().nonnegative(), onMe: z.number().int().nonnegative(),
    /** Others' lines with no Me line over them that had a ring, and of those how many had it on Me's tile. */
    othersLines: z.number().int().nonnegative(), othersOnMe: z.number().int().nonnegative(),
  }),
  people: z.array(z.strictObject({ name: z.string().min(1), lines: z.number().int().nonnegative(), seenMs: z.number().int().nonnegative(), readAs: z.array(z.string()) })),
  lines: z.strictObject({ others: z.number().int().nonnegative(), named: z.number().int().nonnegative(), mixed: z.number().int().nonnegative(), unseen: z.number().int().nonnegative() }),
  /** Who was ringed when: runs of samples with one person's ring, Me's own included. */
  timeline: z.array(z.strictObject({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), name: z.string().min(1) })),
});
export type SpeakersFile = z.infer<typeof speakersFileSchema>;

export const SPEAKERS = {
  /** Meet's ring trails the voice a little: lines are matched to the rings from 250 ms after they start to 250 ms after they end. */
  lagMs: 250,
  /** Of the rings seen during an Others line, Me's left out, the share one person needs for the line to be theirs. */
  lineShare: 0.6,
  /** The check: the ring on Me's tile in at least this share of Me's own lines, and on it in at most `othersOnMe` of Others' own. */
  meShare: 0.6, othersOnMe: 0.3,
  /** Fewer checked lines than this and the check is not made (said, and the names written). */
  minCheckLines: 5,
  /** A name read in fewer samples than this, and like no one else's, is a misreading rather than a person. */
  minSamples: 4,
} as const;

/** A name as letters only, lower case and without accents, for comparing readings: "Grace Ho…" -> "graceho". */
export const nameKey = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]/gu, '');

/**
 * Whether a label reads as a person's name: letters, spaces, hyphens, apostrophes and full stops, with
 * at least two letters. A shared window's title ("ScreenRecording_2", "Calendar • Team") is not, nor
 * is a phrase of three words or more most of which start in lower case, such as another app's list item
 * read beside a badge on the first call ("Conversational site redesign mockup", 2026-11-11).
 */
export function isPersonName(name: string): boolean {
  if (!/^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(name) || nameKey(name).length < 2) return false;
  const words = name.split(/\s+/).filter(Boolean);
  const lower = words.filter(w => /^\p{Ll}/u.test(w)).length;
  return words.length <= 5 && !(words.length >= 3 && lower * 2 > words.length);
}

/** Levenshtein distance, for one or two misread letters. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Whether a reading is part of, or a letter or two from, a person's name. */
function sameAs(reading: string, person: string): boolean {
  const r = nameKey(reading), p = nameKey(person);
  if (!r || !p) return false;
  if (r === p) return true;
  if (r.length >= 4 && p.startsWith(r)) return true;
  if (r.length >= 5 && p.includes(r)) return true;
  return r.length >= 5 && distance(r, p) <= Math.max(1, Math.floor(p.length / 8));
}

/**
 * The people behind the names as read: most-seen readings first, each a new person unless it is the
 * same as one already found; a reading cut short only ever joins one (on its own it is half a name).
 * Returns each reading's person, or undefined for a reading that is no one.
 */
export function foldNames(readings: ReadonlyMap<string, { samples: number; truncated: boolean }>): Map<string, string | undefined> {
  const people: string[] = [];
  const of = new Map<string, string | undefined>();
  // Whole names first, so a name cut short as often as the whole one is read finds it already there.
  const order = [...readings].filter(([name]) => isPersonName(name))
    .sort((a, b) => Number(a[1].truncated) - Number(b[1].truncated) || b[1].samples - a[1].samples || a[0].localeCompare(b[0]));
  for (const [name, { samples, truncated }] of order) {
    const matches = people.filter(p => sameAs(name, p));
    if (matches.length === 1) { of.set(name, matches[0]); continue; }
    if (matches.length > 1 || truncated || samples < SPEAKERS.minSamples) { of.set(name, undefined); continue; }
    people.push(name);
    of.set(name, name);
  }
  for (const [name] of readings) if (!of.has(name)) of.set(name, undefined);
  return of;
}

const overlaps = (a: Pick<TranscriptSegment, 'startMs' | 'endMs'>, b: Pick<TranscriptSegment, 'startMs' | 'endMs'>) => a.startMs < b.endMs && b.startMs < a.endMs;

export interface Named {
  segments: TranscriptSegment[];
  file: SpeakersFile;
  /** For the step note: counts only, never names (T2). */
  note: string;
  /** False when the check failed and no line was named. */
  trusted: boolean;
}

/** Names Others' lines from the reader's report; Me's lines and the transcript's text are left as they are. */
export function nameSpeakers(segments: readonly TranscriptSegment[], report: ToolReport): Named {
  const readings = new Map<string, { samples: number; truncated: boolean }>();
  for (const sample of report.samples) for (const ring of sample.rings) {
    if (!ring.name) continue;
    const seen = readings.get(ring.name) ?? { samples: 0, truncated: Boolean(ring.truncated) };
    seen.samples++;
    readings.set(ring.name, seen);
  }
  const personOf = foldNames(readings);
  // Each sample as the people ringed in it.
  const samples = report.samples.map(s => ({ atMs: s.atMs, people: [...new Set(s.rings.map(r => r.name && personOf.get(r.name)).filter((p): p is string => Boolean(p)))], you: s.rings.filter(r => r.you && r.name).map(r => personOf.get(r.name!)).filter(Boolean) as string[] }));
  const within = (line: Pick<TranscriptSegment, 'startMs' | 'endMs'>) => samples.filter(s => s.atMs >= line.startMs + SPEAKERS.lagMs && s.atMs <= line.endMs + SPEAKERS.lagMs && s.people.length);
  const mine = segments.filter(s => s.speaker === 'me'), theirs = segments.filter(s => s.speaker !== undefined && s.speaker !== 'me');
  const meAlone = mine.filter(m => !theirs.some(o => overlaps(m, o))), othersAlone = theirs.filter(o => !mine.some(m => overlaps(m, o)));

  // The recorder's tile: the one Meet labelled "(You…)", else the person most ringed while only Me spoke.
  const tally = (list: string[]) => [...list.reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const you = tally(samples.flatMap(s => s.you))[0]?.[0];
  const meName = you ?? tally(meAlone.flatMap(line => within(line).flatMap(s => s.people)))[0]?.[0];
  const majority = (line: TranscriptSegment) => tally(within(line).flatMap(s => s.people))[0]?.[0];
  const checked = meAlone.filter(line => within(line).length), onMe = checked.filter(line => majority(line) === meName).length;
  const theirsChecked = othersAlone.filter(line => within(line).length), othersOnMe = theirsChecked.filter(line => majority(line) === meName).length;
  const check: SpeakersFile['me']['check'] = !meName || checked.length < SPEAKERS.minCheckLines ? 'unchecked'
    : onMe / checked.length >= SPEAKERS.meShare && (!theirsChecked.length || othersOnMe / theirsChecked.length <= SPEAKERS.othersOnMe) ? 'passed' : 'failed';
  const trusted = check !== 'failed';

  let named = 0, mixed = 0, unseen = 0;
  const lines = new Map<string, number>();
  const out = segments.map(segment => {
    const { name: _old, ...line } = segment;
    if (!trusted || line.speaker === undefined || line.speaker === 'me') return line;
    const seen = within(line).flatMap(s => s.people).filter(p => p !== meName);
    if (!seen.length) { unseen++; return line; }
    const [[top, count]] = tally(seen);
    if (count / seen.length < SPEAKERS.lineShare) { mixed++; return line; }
    named++;
    lines.set(top, (lines.get(top) ?? 0) + 1);
    return { ...line, name: top };
  });

  // Runs of one person's ring, for an agent that wants to look; a gap of two samples ends a run.
  const timeline: SpeakersFile['timeline'] = [];
  for (const s of samples) {
    if (s.people.length !== 1) continue;
    const last = timeline.at(-1), name = s.people[0];
    if (last && last.name === name && s.atMs - last.endMs <= 2 * report.everyMs) last.endMs = s.atMs;
    else timeline.push({ startMs: s.atMs, endMs: s.atMs, name });
  }
  const seenMs = (name: string) => timeline.filter(t => t.name === name).reduce((sum, t) => sum + t.endMs - t.startMs + report.everyMs, 0);
  const people = [...new Set(personOf.values())].filter((p): p is string => Boolean(p))
    .map(name => ({ name, lines: lines.get(name) ?? 0, seenMs: seenMs(name), readAs: [...personOf].filter(([, p]) => p === name).map(([r]) => r).sort() }))
    .sort((a, b) => b.seenMs - a.seenMs);

  const kinds = { ring: 0, badge: 0, pill: 0 };
  for (const sample of report.samples) for (const ring of sample.rings) kinds[ring.kind ?? 'ring']++;
  const file: SpeakersFile = {
    version: 1, source: 'meet-ring',
    reader: { everyMs: report.everyMs, sampled: report.sampled, withRing: report.withRing, namesRead: report.namesRead, elapsedMs: report.elapsedMs, kinds },
    me: { ...(meName ? { name: meName } : {}), check, lines: checked.length, onMe, othersLines: theirsChecked.length, othersOnMe },
    people, lines: { others: theirs.length, named, mixed, unseen }, timeline,
  };
  const others = people.filter(p => p.name !== meName).length;
  const checkNote = check === 'passed' ? `checked on Me's own lines: the ring on Me's tile in ${onMe} of ${checked.length}, on it in ${othersOnMe} of ${theirsChecked.length} of Others' own`
    : check === 'failed' ? `not named: the ring was on Me's tile in ${onMe} of ${checked.length} of Me's own lines and ${othersOnMe} of ${theirsChecked.length} of Others' own, so it is not being read right (has Meet's look changed?)`
      : `unchecked: ${meName ? `only ${checked.length} of Me's own lines had a ring` : "Me's tile was never ringed"}`;
  // Which of Meet's styles the names rest on: "ring", or "ring 4000, badge 50, pill 8" when more than one.
  const seenAs = INDICATOR_KINDS.filter(k => kinds[k]).map(k => `${k} ${kinds[k]}`);
  const shown = `${report.withRing} of ${report.sampled} frames showed someone speaking${seenAs.length > 1 ? ` (${seenAs.join(', ')})` : seenAs.length ? ` (${INDICATOR_KINDS.find(k => kinds[k])})` : ''}`;
  const note = trusted
    ? `${named} of ${theirs.length} Others lines named from Meet's speaking ring, ${others} ${others === 1 ? 'person' : 'people'}; ${mixed} with more than one person ringed and ${unseen} with no ring left as Others; ${checkNote}; ${shown}, read in ${Math.round(report.elapsedMs / 1000)} s`
    : `${checkNote}; ${shown}`;
  return { segments: out, file, note, trusted };
}
