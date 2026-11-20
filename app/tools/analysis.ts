/**
 * Pure analysis for the headset app's runs: turns the app's timeline and the video's frame timestamps
 * into one answer to "did the recording keep going while the user was in another app, and after
 * they came back?". No I/O here, so every rule is unit tested; cli.ts feeds it real files.
 *
 * Clocks: the timeline's `rel` is milliseconds since MediaRecorder.start(); video times are
 * normalised so the first sample is 0. The two agree to within the delay before the first frame,
 * which is small next to the thresholds below.
 */
import { z } from 'zod';

export const eventSchema = z.looseObject({
  t: z.number(), up: z.number(), rel: z.number().nullable(), src: z.string(), ev: z.string(),
});
export type ProbeEvent = z.infer<typeof eventSchema>;

/** One JSON object per line; a malformed line is an error naming the line, never skipped. */
export function parseTimeline(text: string): ProbeEvent[] {
  const events: ProbeEvent[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let json: unknown;
    try { json = JSON.parse(line); } catch { throw new Error(`timeline line ${i + 1} is not JSON`); }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) throw new Error(`timeline line ${i + 1}: ${parsed.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    events.push(parsed.data);
  });
  return events;
}

export interface Interval { startMs: number; endMs: number }
export interface Window extends Interval { kind: 'hidden' | 'unfocused'; open: boolean }
export interface Gap extends Interval { ms: number }

/** End of recording on the rel clock: the recorder's own stop, else the last event that has a rel. */
export function recordingEndMs(events: ProbeEvent[]): number {
  const stop = events.find(e => e.src === 'recorder' && (e.ev === 'stopped' || e.ev === 'stop_failed') && e.rel !== null);
  if (stop?.rel != null) return stop.rel;
  return Math.max(0, ...events.map(e => e.rel ?? 0));
}

/** Why the run ended, from the service's own record. Missing means the process died or never stopped. */
export function endReason(events: ProbeEvent[]): string | undefined {
  const finishing = events.find(e => e.src === 'service' && e.ev === 'finishing');
  return typeof finishing?.reason === 'string' ? finishing.reason : undefined;
}

/**
 * Hidden: the probe's screen was not visible (onStop to onStart), which is what launching another app
 * does. Unfocused: it was visible but not in front (onPause to onResume), e.g. a system menu over it.
 */
export function windows(events: ProbeEvent[], kind: Window['kind']): Window[] {
  const [open, close] = kind === 'hidden' ? ['stop', 'start'] : ['pause', 'resume'];
  const end = recordingEndMs(events);
  const out: Window[] = [];
  let startMs: number | undefined;
  for (const e of events) {
    if (e.src !== 'activity' || e.rel === null || e.rel > end) continue;
    if (e.ev === open && startMs === undefined) startMs = e.rel;
    else if (e.ev === close && startMs !== undefined) { out.push({ kind, startMs, endMs: e.rel, open: false }); startMs = undefined; }
  }
  if (startMs !== undefined) out.push({ kind, startMs, endMs: end, open: true });
  return out;
}

/**
 * `ffprobe -show_entries packet=pts_time -of csv=p=0` output to sorted milliseconds from the file's
 * start. Blank lines and N/A are skipped: Number('') is 0, which once invented a frame at 0 s.
 */
export function parsePacketTimes(stdout: string, startSec: number): number[] {
  return stdout.split('\n').map(line => line.trim()).filter(line => /^-?\d+(\.\d+)?$/.test(line))
    .map(line => Math.round((Number(line) - startSec) * 1000)).filter(ms => ms >= 0).sort((a, b) => a - b);
}

export function gaps(ptsMs: number[], thresholdMs: number): Gap[] {
  const out: Gap[] = [];
  for (let i = 1; i < ptsMs.length; i++) {
    const ms = ptsMs[i] - ptsMs[i - 1];
    if (ms > thresholdMs) out.push({ startMs: ptsMs[i - 1], endMs: ptsMs[i], ms });
  }
  return out;
}

/** Longest stretch without a frame inside the interval, counting from its edges. */
export function longestSilence(ptsMs: number[], w: Interval): Gap {
  const points = [w.startMs, ...ptsMs.filter(p => p > w.startMs && p < w.endMs), w.endMs];
  let best: Gap = { startMs: w.startMs, endMs: w.startMs, ms: 0 };
  for (let i = 1; i < points.length; i++) {
    const ms = points[i] - points[i - 1];
    if (ms > best.ms) best = { startMs: points[i - 1], endMs: points[i], ms };
  }
  return best;
}

export const framesIn = (ptsMs: number[], w: Interval) => ptsMs.filter(p => p >= w.startMs && p <= w.endMs).length;

/** Milliseconds of the window covered by any of the intervals (black, frozen). */
export function coveredMs(intervals: Interval[], w: Interval): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, Math.min(i.endMs, w.endMs) - Math.max(i.startMs, w.startMs)), 0);
}

const heartbeatSchema = z.looseObject({ intervalMs: z.number(), mic: z.number().nullable().optional(), app: z.number().nullable().optional() });

export function heartbeatsIn(events: ProbeEvent[], w: Interval) {
  const beats = events.filter(e => e.src === 'service' && e.ev === 'heartbeat' && e.rel !== null && e.rel >= w.startMs && e.rel <= w.endMs)
    .map(e => heartbeatSchema.parse(e));
  return {
    count: beats.length,
    maxIntervalMs: Math.max(0, ...beats.map(b => b.intervalMs)),
    micPeak: beats.some(b => typeof b.mic === 'number') ? Math.max(0, ...beats.map(b => b.mic ?? 0)) : null,
    appPeak: beats.some(b => typeof b.app === 'number') ? Math.max(0, ...beats.map(b => b.app ?? 0)) : null,
  };
}

/** Lines like `[blackdetect @ 0x1] black_start:2 black_end:4.5 black_duration:2.5`. */
export function parseBlackdetect(stderr: string): Interval[] {
  return [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)]
    .map(m => ({ startMs: Number(m[1]) * 1000, endMs: Number(m[2]) * 1000 }));
}

/** freezedetect logs start, duration and end on separate lines; a freeze running to EOF may have no end. */
export function parseFreezedetect(stderr: string, durationMs: number): Interval[] {
  const out: Interval[] = [];
  let start: number | undefined;
  for (const m of stderr.matchAll(/freezedetect\.freeze_(start|end): ([\d.]+)/g)) {
    const at = Number(m[2]) * 1000;
    if (m[1] === 'start') start = at;
    else if (start !== undefined) { out.push({ startMs: start, endMs: at }); start = undefined; }
  }
  if (start !== undefined) out.push({ startMs: start, endMs: durationMs });
  return out;
}

export interface Thresholds { minAwayMs: number; maxGapMs: number; maxBlackFraction: number; afterReturnMs: number; minCoverage: number }
export const DEFAULT_THRESHOLDS: Thresholds = { minAwayMs: 5000, maxGapMs: 2000, maxBlackFraction: 0.5, afterReturnMs: 3000, minCoverage: 0.9 };

export interface WindowReport extends Window {
  frames: number; fps: number; longestSilence: Gap; blackFraction: number; frozenFraction: number;
  heartbeats: number; maxHeartbeatIntervalMs: number; micPeak: number | null; appPeak: number | null; framesAfterReturn: number | null;
}

export interface VideoFacts { durationMs: number; ptsMs: number[]; black: Interval[]; frozen: Interval[] }

export function windowReport(w: Window, events: ProbeEvent[], video: VideoFacts, t: Thresholds = DEFAULT_THRESHOLDS): WindowReport {
  const length = Math.max(1, w.endMs - w.startMs);
  const frames = framesIn(video.ptsMs, w);
  const beats = heartbeatsIn(events, w);
  const end = recordingEndMs(events);
  const after = { startMs: w.endMs, endMs: w.endMs + t.afterReturnMs };
  return {
    ...w, frames, fps: frames / (length / 1000), longestSilence: longestSilence(video.ptsMs, w),
    blackFraction: coveredMs(video.black, w) / length, frozenFraction: coveredMs(video.frozen, w) / length,
    heartbeats: beats.count, maxHeartbeatIntervalMs: beats.maxIntervalMs, micPeak: beats.micPeak, appPeak: beats.appPeak,
    framesAfterReturn: !w.open && after.endMs <= end ? framesIn(video.ptsMs, after) : null,
  };
}

export type Answer = 'yes' | 'no' | 'inconclusive';
export interface Verdict { answer: Answer; reasons: string[]; warnings: string[] }

/** mm:ss.s on the recording clock. */
export function formatRel(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * "yes" needs: the run ended because the user stopped it (or the time limit), at least one hidden
 * period long enough to mean something, frames throughout every such period with no long silence,
 * frames that are not mostly black, frames again after returning, and a video as long as the run.
 */
/** `app` is whether in-app audio was asked for; it only ever adds warnings, never changes the answer. */
export interface JudgeInput { reason: string | undefined; recordingMs: number; video: VideoFacts; videoError?: string; hidden: WindowReport[]; mic: boolean; app?: boolean }

export function judge(input: JudgeInput, t: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const reasons: string[] = [], warnings: string[] = [];
  const { reason, recordingMs, video } = input;
  if (input.videoError) reasons.push(`the video cannot be read: ${input.videoError}`);
  if (reason === undefined) reasons.push('the timeline has no stop record: the app was killed or is still recording');
  else if (reason !== 'user' && reason !== 'max_duration') reasons.push(`the recording ended by itself: ${reason}`);
  else if (video.ptsMs.length === 0) reasons.push('the video has no frames');
  const coverage = recordingMs > 0 ? video.durationMs / recordingMs : 0;
  if (recordingMs > 0 && coverage < t.minCoverage) reasons.push(`the video is ${(coverage * 100).toFixed(0)}% as long as the recording ran`);

  const counted = input.hidden.filter(w => w.endMs - w.startMs >= t.minAwayMs);
  for (const w of counted) {
    const label = `away ${formatRel(w.startMs)}–${formatRel(w.endMs)}`;
    if (w.open) reasons.push(`${label}: the recording ended before the probe was shown again`);
    if (w.longestSilence.ms > t.maxGapMs) reasons.push(`${label}: no frames for ${(w.longestSilence.ms / 1000).toFixed(1)} s from ${formatRel(w.longestSilence.startMs)}`);
    if (w.blackFraction > t.maxBlackFraction) reasons.push(`${label}: ${(w.blackFraction * 100).toFixed(0)}% of the frames are black`);
    if (w.framesAfterReturn === 0) reasons.push(`${label}: no frames in the ${t.afterReturnMs / 1000} s after coming back`);
    if (w.frozenFraction > 0.5 && w.blackFraction <= t.maxBlackFraction) warnings.push(`${label}: the picture is frozen for ${(w.frozenFraction * 100).toFixed(0)}%; look at the frame, a still scene also freezes`);
    if (w.maxHeartbeatIntervalMs > 3000) warnings.push(`${label}: a heartbeat came ${(w.maxHeartbeatIntervalMs / 1000).toFixed(1)} s apart, so the process was paused or the device slept`);
    if (input.mic && w.micPeak === 0) warnings.push(`${label}: the microphone read zero throughout: a silent room, or the system muted capture in the background`);
    if (input.app && w.appPeak === 0) warnings.push(`${label}: in-app audio read zero throughout: the app played nothing, or it does not allow capture`);
  }
  if (reasons.length) return { answer: 'no', reasons, warnings };
  if (counted.length === 0) {
    return { answer: 'inconclusive', reasons: [`the probe was never hidden for ${t.minAwayMs / 1000} s or more; switch to another app during the run`], warnings };
  }
  return { answer: 'yes', reasons: [`video continued through ${counted.length} away period(s) and after each return`], warnings };
}
