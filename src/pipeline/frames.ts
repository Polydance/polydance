import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { inVideoGap, type VideoGap } from '../call.js';
import { exec } from '../exec.js';
import { privateDir } from '../fsx.js';
import { formatClock, frameStamp, pad } from '../time.js';
import type { TranscriptSegment } from './transcribe.js';

/** `scene` (where the screen changed) and `mark` (the user's shortcut) since 2026-11-05, docs/MAC.md P5 and P6. */
export const FRAME_REASONS = ['mark', 'scene', 'pointing', 'segment', 'interval', 'edge'] as const;
export type FrameReason = typeof FRAME_REASONS[number];
export interface FramePlanEntry { atMs: number; reason: FrameReason; word?: string }
export const frameRecordSchema = z.strictObject({
  file: z.string(), atMs: z.number().int().nonnegative(), reason: z.enum(FRAME_REASONS),
  /** For a pointing frame, the word it was taken at ("this", "these"...). */
  word: z.string().optional(),
  /** A full-resolution copy, relative to frames/ (full/NNNN_MMmSSs.jpg): mark, scene and pointing frames and references. */
  full: z.string().optional(),
});
export const framesFileSchema = z.strictObject({ version: z.literal(1), width: z.number().int(), frames: z.array(frameRecordSchema) });
export type FrameRecord = z.infer<typeof frameRecordSchema>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * How much of the recording has a picture, as the length frames are planned over: up to and including
 * the last video frame when the probe found it (media.videoEndMs), else the whole recording. Every
 * frame's clock is clamped below this, so no seek lands after the picture has ended.
 */
export const frameSpanMs = (durationMs: number, videoEndMs?: number) => videoEndMs !== undefined ? Math.max(1, Math.min(durationMs, videoEndMs + 1)) : durationMs;

const PRIORITY: Record<FrameReason, number> = { mark: 5, scene: 4, pointing: 3, segment: 2, interval: 1, edge: 0 };

/** The stretches of a call without a picture (call.ts videoGaps): no frame is planned inside one. */
export type PictureGaps = readonly Pick<VideoGap, 'fromMs' | 'toMs'>[];

/** "from 18:31 to 21:34, from 40:02 to the end", or with each gap's reason: "from 18:31 to 21:34 (…); from 40:02 to the end (…)". */
export const gapsText = (gaps: readonly VideoGap[], withReasons = false) =>
  gaps.map(g => `from ${formatClock(g.fromMs)} to ${g.toMs !== undefined ? formatClock(g.toMs) : 'the end'}${withReasons ? ` (${g.reason})` : ''}`).join(withReasons ? '; ' : ', ');

/**
 * Where a mark's frame is taken: at the mark, or, for a mark pressed while there was no picture, at the
 * last picture before that stretch, as a mark after the picture's end is shown by the last picture.
 */
export function markFrameMs(atMs: number, gaps?: PictureGaps): number {
  const gap = (gaps ?? []).find(g => atMs >= g.fromMs && (g.toMs === undefined || atMs < g.toMs));
  return gap ? Math.max(0, gap.fromMs - 1) : atMs;
}

/** The pointing frames the pointing pass reads per recording, in order; here so the storyboard can say so without loading the SDK. */
export const MAX_POINTING = 24;

/** Words people say while pointing at something; the frame at that word shows what they meant. */
export const POINTING_WORDS = /^(this|these|that|those|here|there)$/i;

/**
 * A frame at every pointing word ("this", "these", "that"...) when the transcript has word timings, one
 * per transcript segment midpoint, and evenly spaced wherever nothing is said (the whole recording when
 * there is no transcript), plus both ends. Candidates closer than minGapMs collapse to the more valuable
 * one (pointing over segment over interval over edge), and the list is thinned to maxFrames so a long
 * session cannot flood the agent: frames from silence first, then evenly.
 */
export function planFrames(durationMs: number, segments: readonly TranscriptSegment[], options: { maxFrames: number; intervalMs: number; minGapMs?: number; pointing?: boolean; gaps?: PictureGaps }): FramePlanEntry[] {
  const minGap = options.minGapMs ?? 2000;
  const last = Math.max(0, durationMs - 1);
  const candidates: FramePlanEntry[] = [{ atMs: Math.min(500, last), reason: 'edge' }];
  if (segments.length) {
    for (const s of segments) candidates.push({ atMs: Math.round((s.startMs + s.endMs) / 2), reason: 'segment' });
    // A silence longer than an interval gets frames at the interval, so what was done without a word
    // still shows (until 2026-10-16 a 60 s take with two short lines had 4 frames, and 13 without a
    // transcript). Each stops minGap short of the next line or the closing edge.
    for (const gap of silences(segments, Math.max(0, durationMs - 500))) {
      for (let t = gap.from + options.intervalMs; t < gap.to - minGap; t += options.intervalMs) candidates.push({ atMs: t, reason: 'interval' });
    }
  } else for (let t = options.intervalMs; t < durationMs - 500; t += options.intervalMs) candidates.push({ atMs: t, reason: 'interval' });
  for (const s of options.pointing === false ? [] : segments) {
    for (const w of s.words ?? []) {
      const word = w.text.replace(/[^A-Za-z]/g, '');
      if (POINTING_WORDS.test(word)) candidates.push({ atMs: Math.round((w.startMs + w.endMs) / 2), reason: 'pointing', word: word.toLowerCase() });
    }
  }
  if (durationMs > 1000) candidates.push({ atMs: Math.max(0, durationMs - 500), reason: 'edge' });
  // Where the screen capture stopped mid-call the file is black: no frame there, but one each side of it,
  // the last picture before and the first after (C14).
  for (const gap of options.gaps ?? []) {
    if (gap.fromMs >= 500 && gap.fromMs < durationMs) candidates.push({ atMs: gap.fromMs - 500, reason: 'edge' });
    if (gap.toMs !== undefined && gap.toMs + 500 < durationMs) candidates.push({ atMs: gap.toMs + 500, reason: 'edge' });
  }
  const sorted = candidates.map(c => ({ ...c, atMs: clamp(c.atMs, 0, last) })).filter(c => !inVideoGap(c.atMs, options.gaps)).sort((a, b) => a.atMs - b.atMs);
  const deduped: FramePlanEntry[] = [];
  for (const c of sorted) {
    const prev = deduped.at(-1);
    if (prev && c.atMs - prev.atMs < minGap) { if (PRIORITY[c.reason] > PRIORITY[prev.reason]) deduped[deduped.length - 1] = c; continue; }
    deduped.push(c);
  }
  if (deduped.length <= options.maxFrames) return deduped;
  // With a transcript, silence frames give way before any frame tied to something said.
  const kept = segments.length ? dropEvenly(deduped, entry => entry.reason === 'interval', deduped.length - options.maxFrames) : deduped;
  if (kept.length <= options.maxFrames) return kept;
  const step = (kept.length - 1) / (options.maxFrames - 1);
  const picked = new Set<number>();
  for (let i = 0; i < options.maxFrames; i++) picked.add(Math.round(i * step));
  return [...picked].sort((a, b) => a - b).map(i => kept[i]);
}

/**
 * Where nobody is speaking, from 0 to `end`: the gaps in the union of the lines. A call's two voices
 * overlap (Me says "mm-hm" inside Others' long line), so a gap starts where every line so far has
 * ended, not where the line before it did; measured from consecutive lines, an "mm-hm" at 12 to 14 s
 * inside a line of 10 to 30 s had put "nothing said" frames at 24 and 29 s (review of 2026-11-05).
 */
export function silences(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], end: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let spoken = 0;
  for (const s of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (s.startMs > spoken) out.push({ from: spoken, to: s.startMs });
    spoken = Math.max(spoken, s.endMs);
  }
  if (end > spoken) out.push({ from: spoken, to: end });
  return out;
}

export interface PriorityFrames { durationMs: number; scenes?: readonly number[]; marks?: readonly number[]; maxScenes: number; minGapMs?: number; gaps?: PictureGaps }

/**
 * Mark and scene frames laid over a plan from planFrames, for calls (docs/MAC.md P5, P6). They outrank
 * every other reason: a mark is the user saying "this moment", and in a call the shared screen
 * changing is the moment worth a picture, not a line's midpoint. Marks closer than minGapMs keep the
 * first; a scene that close to a mark gives way to it; scenes beyond maxScenes are thinned evenly. They
 * are capped apart from the plan's own maxFrames, so a talkative hour cannot thin the screen's changes
 * (the cap follows the number of distinct scenes, not the length), and any planned frame within
 * minGapMs of one of them is dropped as showing the same thing. Where there was no picture (gaps), a scene
 * is the black going in and is dropped, and a mark's frame is the last picture before (markFrameMs).
 */
export function addPriorityFrames(plan: readonly FramePlanEntry[], options: PriorityFrames): FramePlanEntry[] {
  const minGap = options.minGapMs ?? 2000, last = Math.max(0, options.durationMs - 1);
  const marks: FramePlanEntry[] = [];
  for (const atMs of [...options.marks ?? []].map(t => clamp(markFrameMs(t, options.gaps), 0, last)).sort((a, b) => a - b)) {
    if (!marks.length || atMs - marks.at(-1)!.atMs >= minGap) marks.push({ atMs, reason: 'mark' });
  }
  const near = (list: readonly FramePlanEntry[], atMs: number) => list.some(p => Math.abs(p.atMs - atMs) < minGap);
  const scenes = [...options.scenes ?? []].map(t => clamp(t, 0, last)).sort((a, b) => a - b).filter(t => !near(marks, t) && !inVideoGap(t, options.gaps));
  const keptScenes = scenes.length <= options.maxScenes ? scenes : Array.from({ length: options.maxScenes }, (_, i) => scenes[options.maxScenes === 1 ? 0 : Math.round(i * (scenes.length - 1) / (options.maxScenes - 1))]);
  const top = [...marks, ...keptScenes.map(atMs => ({ atMs, reason: 'scene' as const }))];
  return [...top, ...plan.filter(p => !near(top, p.atMs))].sort((a, b) => a.atMs - b.atMs || PRIORITY[b.reason] - PRIORITY[a.reason]);
}

/** Removes up to n of the entries that match, spread evenly among them; the others are untouched. */
function dropEvenly<T>(list: readonly T[], matches: (entry: T) => boolean, n: number): T[] {
  const indices = list.flatMap((entry, i) => matches(entry) ? [i] : []);
  const drop = new Set(indices.length <= n ? indices : Array.from({ length: n }, (_, i) => indices[Math.floor((i + 0.5) * indices.length / n)]));
  return list.filter((_, i) => !drop.has(i));
}

export const frameFileName = (index: number, atMs: number) => `${pad(index, 4)}_${frameStamp(atMs)}.jpg`;

/** Which frames also get a full-resolution copy, and how wide it is (the video's width, at most 1920). */
export interface FullFrames { width: number; wants: (entry: FramePlanEntry) => boolean }

async function grab(ffmpeg: string, video: string, atMs: number, width: number, quality: number, out: string): Promise<void> {
  await exec(ffmpeg, ['-y', '-v', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', String(quality), out], { timeoutMs: 120_000 });
  await chmod(out, 0o600).catch(() => { /* best effort */ });
}

/** A planned frame that could not be grabbed (`full`: only its full-size copy), with ffmpeg's first line. */
export interface GrabFailure { atMs: number; full: boolean; error: string }

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 160);

/**
 * One ffmpeg call per frame with input seeking; accurate enough and fast for under a hundred frames.
 * Frames that `full` wants are grabbed a second time at full resolution into frames/full/, because the
 * 1024 px frames were too small to read a panel's text or judge a reference (2026-10-01). A grab that
 * fails costs that frame only: it is left out and returned as a failure, and the files stay numbered
 * without a gap. Until 2026-11-05 one seek past the picture's end failed the whole step and every
 * other frame with it. Only a plan none of whose frames could be grabbed is an error.
 */
export async function extractFrames(ffmpeg: string, video: string, dir: string, plan: readonly FramePlanEntry[], width: number, full?: FullFrames): Promise<{ frames: FrameRecord[]; failures: GrabFailure[] }> {
  await privateDir(dir);
  const records: FrameRecord[] = [], failures: GrabFailure[] = [];
  for (const entry of plan) {
    const file = frameFileName(records.length + 1, entry.atMs);
    try { await grab(ffmpeg, video, entry.atMs, width, 3, join(dir, file)); }
    catch (error) {
      await rm(join(dir, file), { force: true });
      failures.push({ atMs: entry.atMs, full: false, error: firstLine(error) });
      continue;
    }
    let fullFile: string | undefined;
    if (full && full.width > width && full.wants(entry)) {
      await privateDir(join(dir, 'full'));
      try { await grab(ffmpeg, video, entry.atMs, full.width, 2, join(dir, `full/${file}`)); fullFile = `full/${file}`; }
      catch (error) {
        await rm(join(dir, `full/${file}`), { force: true });
        failures.push({ atMs: entry.atMs, full: true, error: firstLine(error) });
      }
    }
    records.push({ file, atMs: entry.atMs, reason: entry.reason, ...(entry.word ? { word: entry.word } : {}), ...(fullFile ? { full: fullFile } : {}) });
  }
  if (plan.length && !records.length) throw new Error(`none of the ${plan.length} planned frames could be grabbed: ${failures[0].error}`);
  return { frames: records, failures };
}

/** What the frames step says about the frames it planned and could not grab, or nothing. */
export function grabFailureNote(failures: readonly GrabFailure[]): string | undefined {
  const frames = failures.filter(f => !f.full).length, copies = failures.length - frames;
  const parts = [
    frames ? `${frames} planned ${frames === 1 ? 'frame' : 'frames'} could not be grabbed` : '',
    copies ? `${copies} full-size ${copies === 1 ? 'copy' : 'copies'} could not be made` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')} (${failures[0].error})` : undefined;
}

/** A thumbnail's caption: its clock, and the word for a pointing frame or the reason for a scene or mark. Letters, digits, colons and spaces only. */
export const frameLabel = (frame: Pick<FrameRecord, 'atMs' | 'reason' | 'word'>) =>
  `${formatClock(frame.atMs)}${frame.reason === 'pointing' && frame.word ? ` ${frame.word}` : frame.reason === 'scene' || frame.reason === 'mark' ? ` ${frame.reason}` : ''}`;

/**
 * The tile filter with each thumbnail's caption drawn on it: one drawtext per frame, switched on for
 * that frame only. Captions come from frameLabel, so the only character needing care is the clock's
 * colon, which drawtext's option parser would read as a separator: it is escaped inside the quotes
 * (checked with ffmpeg 8.0 here and 5.1 in the receiver image, 2026-10-02).
 */
export function contactSheetFilter(frames: readonly Pick<FrameRecord, 'atMs' | 'reason' | 'word'>[], cols: number, rows: number): string {
  const captions = frames.map((frame, n) =>
    `drawtext=text='${frameLabel(frame).replaceAll(':', '\\:')}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=5:enable='eq(n,${n})'`);
  return ['scale=320:-2', ...captions, `tile=${cols}x${rows}`].join(',');
}

/**
 * Thumbnail grid of every extracted frame, six per row, each captioned with its clock (and the word
 * for a pointing frame), so a tile can be matched to the transcript at a glance. If ffmpeg cannot draw
 * text (no font), the grid is made without captions and the returned note says so.
 */
export async function contactSheet(ffmpeg: string, framesDir: string, out: string, frames: readonly FrameRecord[]): Promise<{ note?: string }> {
  if (frames.length < 1) return {};
  const cols = Math.min(6, frames.length), rows = Math.ceil(frames.length / cols);
  const run = (filter: string) => exec(ffmpeg, ['-y', '-v', 'error', '-framerate', '1', '-pattern_type', 'glob', '-i', join(framesDir, '*.jpg'), '-vf', filter, '-frames:v', '1', '-q:v', '4', out], { timeoutMs: 120_000 });
  let note: string | undefined;
  try { await run(contactSheetFilter(frames, cols, rows)); }
  catch (error) {
    note = `contact sheet without clocks: ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 160)}`;
    await run(`scale=320:-2,tile=${cols}x${rows}`);
  }
  await chmod(out, 0o600).catch(() => { /* best effort */ });
  return note ? { note } : {};
}
