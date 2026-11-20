/**
 * Both voices of a call (docs/MAC.md P1, P2): the microphone (Me, the person who recorded it) and the
 * call's sound (Others, everyone else) are transcribed apart and merged by time, each line saying
 * whose it is. Without headphones the mic also hears the far end through the speakers, so a mic line
 * that repeats an app line said at the same moment is dropped as bleed.
 *
 * This is a backstop, not echo cancellation. P2 proper cancels the far end out of a working copy of
 * the mic track with the app track as reference (WebRTC's AEC3, as RecordKit does) before the mic is
 * transcribed; that is out of scope here and the recorded tracks are never changed either way.
 */
import { z } from 'zod';
import type { TranscriptSegment } from './transcribe.js';

/** `me` (the mic), `others` (the call's sound), or `others:N` when a transcriber tells the far end's speakers apart (P3). */
export type Speaker = 'me' | 'others' | `others:${number}`;
export const speakerSchema = z.union([
  z.enum(['me', 'others']),
  z.templateLiteral(['others:', z.int()]).refine(s => /^others:[1-9]\d{0,2}$/.test(s), 'must be others:1 to others:999'),
]);

/** "Me", "Others", "Others 2": how a line names its speaker in transcript.md, the storyboard and the summary. */
export const speakerLabel = (speaker: Speaker) => speaker === 'me' ? 'Me' : speaker === 'others' ? 'Others' : `Others ${speaker.slice('others:'.length)}`;

/** Who said a line, as transcript.md, the storyboard and the summary write it: the name Meet showed on an Others line, else "Me" or "Others". */
export const lineLabel = (segment: Pick<TranscriptSegment, 'speaker' | 'name'>) => segment.name ?? (segment.speaker ? speakerLabel(segment.speaker) : undefined);

/** A line's words with its speaker in front when it has one: "Me: shall we start?", "Ada Lovelace: yes". */
export const lineText = (segment: Pick<TranscriptSegment, 'text' | 'speaker' | 'name'>) => {
  const label = lineLabel(segment);
  return label ? `${label}: ${segment.text}` : segment.text;
};

/** How many of Others' lines each named person has, most first. */
export function nameCounts(segments: readonly Pick<TranscriptSegment, 'name'>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of segments) if (s.name) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The bleed rule. A mic line is the far end heard through the speakers when an app line starts within
 * `windowMs` of it and the two share at least `similarity` of their words by token-set Jaccard
 * (shared words over all words, after lower-casing and dropping punctuation). Jaccard rather than
 * containment, so a short "yes" from Me is not dropped because Others' long line also has a "yes"; and
 * the window is on start times because the bleed and its source begin together, give or take the
 * transcriber's clock. A bleed line the transcriber split differently from its source falls under the
 * threshold and is kept: the rule prefers keeping a duplicate to losing something Me said.
 *
 * A short Me line (under `shortTokens` words) must also overlap the Others line in time. On one or two
 * words the similarity is 1 whenever they match, and both sides of a call say "Okay", "Yeah" or "Bye"
 * within a second of each other: a reply comes after what it answers, while bleed coincides with its
 * source. Without this, Me's "Okay." 0.9 s after Others' "Okay?" was dropped as bleed even with
 * headphones on (review of 2026-11-05). Both tracks are on the file's clock (audio.ts), so real bleed
 * does overlap.
 */
export const BLEED = { windowMs: 1500, similarity: 0.8, shortTokens: 3 } as const;

const tokens = (text: string) => new Set(text.normalize('NFKC').toLowerCase().replace(/['’ʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean));

/** Token-set Jaccard similarity of two lines, 0 to 1; two lines with no words at all are not similar. */
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Mic lines with the bleed taken out, and how many were dropped. */
export function dropBleed(me: readonly TranscriptSegment[], others: readonly TranscriptSegment[], rule: { windowMs: number; similarity: number; shortTokens?: number } = BLEED): { kept: TranscriptSegment[]; dropped: number } {
  const overlap = (m: TranscriptSegment, o: TranscriptSegment) => m.startMs < o.endMs && o.startMs < m.endMs;
  const bleed = (m: TranscriptSegment, o: TranscriptSegment) => Math.abs(o.startMs - m.startMs) <= rule.windowMs && similarity(m.text, o.text) >= rule.similarity
    && (tokens(m.text).size >= (rule.shortTokens ?? 0) || overlap(m, o));
  const kept = me.filter(m => !others.some(o => bleed(m, o)));
  return { kept, dropped: me.length - kept.length };
}

/** Both voices in one list by start time (Me first on a tie), each line labelled, with the bleed dropped from Me's. */
export function mergeVoices(me: readonly TranscriptSegment[], others: readonly TranscriptSegment[]): { segments: TranscriptSegment[]; dropped: number } {
  const { kept, dropped } = dropBleed(me, others);
  const segments = [
    ...kept.map(s => ({ ...s, speaker: 'me' as const })),
    ...others.map(s => ({ ...s, speaker: s.speaker ?? 'others' as const })),
  ].sort((a, b) => a.startMs - b.startMs || (a.speaker === 'me' ? 0 : 1) - (b.speaker === 'me' ? 0 : 1) || a.endMs - b.endMs);
  return { segments, dropped };
}

/** How many lines each speaker has, in the order they first speak. */
export function speakerCounts(segments: readonly Pick<TranscriptSegment, 'speaker'>[]): [Speaker, number][] {
  const counts = new Map<Speaker, number>();
  for (const s of segments) if (s.speaker) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1);
  return [...counts];
}
