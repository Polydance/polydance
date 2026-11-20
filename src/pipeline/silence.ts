/**
 * A guard against whisper inventing lines in a call's quiet stretches (docs/MAC.md P1). Each track of
 * a call is silent for much of the hour (the mic while the recorder listens, the call's sound while
 * they talk), and over such stretches whisper writes lines nobody said ("Thank you.", "Thanks for
 * watching!") or repeats the last real sentence. They pass the bracketed-tag filter, exist on one
 * track only so the bleed rule cannot see them, and would reach the transcript, the storyboard and the
 * summary. ffmpeg's silencedetect finds the stretches on the wav whisper read, and a line that lies
 * mostly inside them is dropped and counted. No model is needed (whisper's own VAD wants a silero
 * model of its own, a download docs/MAC.md avoids unless it proves necessary).
 *
 * The thresholds are a first guess, not measured on a real call (2026-11-05): room tone on a laptop
 * mic is usually well under -45 dBFS and speech well over it. A real word whose line whisper stretched
 * across a long pause after it can be dropped too; the count in the transcribe step's note says how
 * many lines went.
 */
import { exec } from '../exec.js';
import type { TranscriptSegment } from './transcribe.js';

/** Quieter than noiseDb for at least minMs is silence; a line at least `covered` inside silence is dropped. */
export const SILENCE = { noiseDb: -45, minMs: 2000, covered: 0.8 } as const;

export interface Silence { startMs: number; endMs: number }

const START = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const END = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

/** silencedetect's stderr lines ("silence_start: 2.5", "silence_end: 7 | silence_duration: 4.5"); a silence still open at the end runs to the end. */
export function parseSilences(stderr: string): Silence[] {
  const out: Silence[] = [];
  let open: number | undefined;
  for (const line of stderr.split('\n')) {
    if (!line.includes('silencedetect')) continue;
    const start = line.match(START), end = line.match(END);
    if (start) open = Math.max(0, Math.round(Number(start[1]) * 1000));
    else if (end && open !== undefined) { out.push({ startMs: open, endMs: Math.max(open, Math.round(Number(end[1]) * 1000)) }); open = undefined; }
  }
  if (open !== undefined) out.push({ startMs: open, endMs: Number.POSITIVE_INFINITY });
  return out;
}

/** The share of a line's span, 0 to 1, that lies in the silences; a line with no length is wholly in one or not at all. */
export function silentShare(line: Pick<TranscriptSegment, 'startMs' | 'endMs'>, silences: readonly Silence[]): number {
  if (line.endMs <= line.startMs) return silences.some(s => s.startMs <= line.startMs && line.startMs < s.endMs) ? 1 : 0;
  let covered = 0;
  for (const s of silences) covered += Math.max(0, Math.min(line.endMs, s.endMs) - Math.max(line.startMs, s.startMs));
  return Math.min(1, covered / (line.endMs - line.startMs));
}

/** The lines that are not said over silence, and how many were. */
export function dropSilentLines<T extends Pick<TranscriptSegment, 'startMs' | 'endMs'>>(lines: readonly T[], silences: readonly Silence[], covered: number = SILENCE.covered): { kept: T[]; dropped: number } {
  const kept = lines.filter(line => silentShare(line, silences) < covered);
  return { kept, dropped: lines.length - kept.length };
}

/** Runs silencedetect over a wav. */
export async function detectSilences(ffmpeg: string, wav: string): Promise<Silence[]> {
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${SILENCE.noiseDb}dB:d=${SILENCE.minMs / 1000}`, '-f', 'null', '-'], { timeoutMs: 15 * 60_000 });
  return parseSilences(stderr);
}

/**
 * A guard against lines nobody near the microphone said (2026-11-13, SPOT-1). A recording with no
 * narration, only a room's sound or a television across it, was transcribed by Gladia as "I'm going to
 * show you how to make a simple and easy cake", and Claude titled the thread from it. That sound is not
 * silence (room tone on the iPhone sat at -45 to -48 LUFS), so silencedetect cannot see it. What tells
 * them apart is how far a line rises above the recording's own background: the narrator is close to the
 * microphone. ffmpeg's ebur128 gives the momentary loudness (400 ms) every 100 ms; the floor is the 10th
 * percentile of it, and a line whose loudest moment is less than `aboveFloorDb` over the floor, and not
 * louder than `alwaysLufs` anyway, is dropped and counted.
 *
 * The thresholds come from seven of Robin's recordings, measured on 2026-11-13, not more: real lines rose
 * 16 dB ("three," counting on a Quest) to 60 dB over their floor, the iPhone's speech 25 to 33 dB; SPOT-1's
 * invented lines 12 dB, and whisper's "Thank you." over a Quest's digital silence 5 dB. So the margin is
 * about 2 dB on each side, and a soft word across a loud room can be dropped; the transcribe step's note
 * counts what went.
 */
export const FAINT = { aboveFloorDb: 14, alwaysLufs: -30, floorShare: 0.1, windowMs: 400 } as const;

export interface Loudness { atMs: number; lufs: number }

const MOMENTARY = /\bt:\s*(-?\d+(?:\.\d+)?)\s.*?\bM:\s*(-?\d+(?:\.\d+)?)/;

/** ebur128's stderr lines ("t: 1.2  TARGET:-23 LUFS  M: -36.2 S: …"); the first 400 ms, before its window fills, are left out. */
export function parseMomentary(stderr: string): Loudness[] {
  const out: Loudness[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.includes('ebur128')) continue;
    const m = line.match(MOMENTARY);
    if (!m) continue;
    const atMs = Math.round(Number(m[1]) * 1000);
    if (atMs >= FAINT.windowMs) out.push({ atMs, lufs: Number(m[2]) });
  }
  return out;
}

/** The recording's background: the loudness it is at or under for `floorShare` of the time. */
export function loudnessFloor(loudness: readonly Loudness[], share: number = FAINT.floorShare): number | undefined {
  if (!loudness.length) return undefined;
  const sorted = loudness.map(l => l.lufs).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/** A line's loudest moment: the momentary readings whose 400 ms window overlaps it. */
export function linePeak(line: Pick<TranscriptSegment, 'startMs' | 'endMs'>, loudness: readonly Loudness[]): number | undefined {
  let peak: number | undefined;
  for (const l of loudness) if (l.atMs > line.startMs && l.atMs - FAINT.windowMs < line.endMs) peak = Math.max(peak ?? -Infinity, l.lufs);
  return peak;
}

/** The lines that rise far enough above the background to be the narrator's, and how many did not. A line with no reading is kept. */
export function dropFaintLines<T extends Pick<TranscriptSegment, 'startMs' | 'endMs'>>(lines: readonly T[], loudness: readonly Loudness[]): { kept: T[]; dropped: number } {
  const floor = loudnessFloor(loudness);
  if (floor === undefined) return { kept: [...lines], dropped: 0 };
  const kept = lines.filter(line => {
    const peak = linePeak(line, loudness);
    return peak === undefined || peak >= FAINT.alwaysLufs || peak - floor >= FAINT.aboveFloorDb;
  });
  return { kept, dropped: lines.length - kept.length };
}

/** Runs ebur128 over a wav for its momentary loudness. */
export async function measureLoudness(ffmpeg: string, wav: string): Promise<Loudness[]> {
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: 15 * 60_000 });
  return parseMomentary(stderr);
}
