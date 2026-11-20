/**
 * Where a screen recording's picture changed (docs/MAC.md P5): ffmpeg's scene filter scores each frame
 * against the one before it (0 for identical, 1 for entirely different), `select` keeps the frames over
 * a threshold and `showinfo` prints their clocks, which are parsed here. A call's valuable frames are
 * where the shared screen changes (a new slide, another window, a scrolled page), not where someone
 * says "this".
 *
 * The default threshold is 0.03, lower than the 0.1 to 0.4 usual for film, because screen content
 * changes little of the picture at a time. ffmpeg's score is the change from the previous frame less
 * the change before that, so a sudden change scores and steady motion (a playing video, someone moving
 * in a tile, a smooth scroll) mostly does not. Measured on 2026-11-05 with ffmpeg 8.0 on synthetic
 * 1920x1080 frames: two slides on one template with entirely different text scored 0.036 to 0.046 (the
 * same at 640 px as at full size); a cut between plain colours 0.4 to 1; ffmpeg's moving testsrc2
 * pattern at most 0.025; a slide whose only change was one digit 0.003. So 0.1 would miss slide
 * changes, and 0.03 keeps them while steady motion stays under. Not yet measured on a real call (Meet's
 * tiles, notifications, scrolling code); POLYCAP_SCENE_THRESHOLD changes it.
 */
import { exec } from '../exec.js';

/** One `showinfo` line per selected frame: "[Parsed_showinfo_2 @ 0x…] n:   0 pts:  30720 pts_time:3 …". */
const SHOWINFO = /\[Parsed_showinfo_\d+ @ [^\]]*\]\s+n:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(\S+)/g;

/** The clocks (ms, rounded up so a seek lands on the new picture, never the frame before it) of the frames showinfo printed. */
export function parseShowinfo(stderr: string): number[] {
  const out = new Set<number>();
  for (const match of stderr.matchAll(SHOWINFO)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds >= 0) out.add(Math.ceil(seconds * 1000 - 1e-6));
  }
  return [...out].sort((a, b) => a - b);
}

export interface CollapseOptions { durationMs: number; minGapMs?: number; settleMs?: number }

/**
 * One frame per burst of changes: changes less than minGapMs (2 s) apart are one scene, such as a
 * slide's transition, a window being dragged or a page being scrolled, and its frame is taken settleMs
 * (300 ms) after the burst's last change, when the picture has settled, rather than mid-transition.
 */
export function collapseScenes(changes: readonly number[], options: CollapseOptions): number[] {
  const minGap = options.minGapMs ?? 2000, settle = options.settleMs ?? 300, last = Math.max(0, options.durationMs - 1);
  const sorted = [...changes].filter(t => t >= 0 && t <= last).sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((t, i) => { if (i === sorted.length - 1 || sorted[i + 1] - t >= minGap) out.push(Math.min(t + settle, last)); });
  return out;
}

/**
 * Runs the scene filter over the first video stream, scaled down first (the score is a fraction of the
 * picture, so 640 px gives the same changes as 1920 for a third of the work), audio ignored.
 */
export async function detectScenes(ffmpeg: string, video: string, threshold: number): Promise<number[]> {
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-nostats', '-i', video, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `scale=640:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { timeoutMs: 60 * 60_000 });
  return parseShowinfo(stderr);
}
