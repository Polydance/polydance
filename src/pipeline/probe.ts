/**
 * What ffprobe says about a recording: its length, picture size and audio tracks, and, separately,
 * where its picture ends. A file's duration is its longest stream's, and a Mac recording's video
 * often stops before its sound does (a still screen sends no frames; a screen capture stopped mid-call
 * ends the video while the audio carries on), so frames are planned to the video's own end.
 */
import { z } from 'zod';
import { exec } from '../exec.js';

const ffprobeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string().optional(), width: z.number().optional(), height: z.number().optional(), channels: z.number().int().optional() })).default([]),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional(), tags: z.record(z.string(), z.string()).optional() }).optional(),
});
/** hasVideo is false for a recording of audio alone, such as a call whose screen was not recorded. */
export interface ProbeResult { durationMs: number; width?: number; height?: number; hasAudio: boolean; hasVideo: boolean; container?: string; audioChannels: number[]; tags: Record<string, string> }

export async function probe(ffprobe: string, file: string): Promise<ProbeResult> {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = ffprobeSchema.parse(JSON.parse(stdout));
  const video = data.streams.find(s => s.codec_type === 'video');
  const seconds = Number(data.format?.duration ?? 'NaN');
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe reported no duration for ${file}`);
  return {
    durationMs: Math.round(seconds * 1000), width: video?.width, height: video?.height,
    hasAudio: data.streams.some(s => s.codec_type === 'audio'), hasVideo: video !== undefined, container: data.format?.format_name?.split(',')[0],
    audioChannels: data.streams.filter(s => s.codec_type === 'audio').map(s => s.channels ?? 1),
    tags: data.format?.tags ?? {},
  };
}

/** `pts_time=12.300000` per video packet and `start_time=0.000000` for the file, as `-of default=nw=1` prints them. */
export function parseVideoEnd(stdout: string): number | undefined {
  let last = Number.NEGATIVE_INFINITY, start = 0;
  for (const line of stdout.split('\n')) {
    const [key, value] = line.trim().split('=');
    const n = Number(value);
    if (!Number.isFinite(n) || value === undefined || value === '') continue;
    if (key === 'pts_time') last = Math.max(last, n);
    else if (key === 'start_time') start = n;
  }
  // On the clock `ffmpeg -ss` seeks on, which counts from the file's start; floored, so a seek there finds the frame.
  return Number.isFinite(last) ? Math.max(0, Math.floor((last - start) * 1000 + 1e-6)) : undefined;
}

/**
 * The time of the first video stream's last frame, in ms from the file's start, or undefined when it
 * has none. Read from the packets' timestamps (they are not in decode order, hence the maximum), never
 * from the stream's duration: AVAssetWriter gives the last frame the one before's duration, and a seek
 * anywhere inside that duration finds no frame (ffmpeg exits 234, measured with 8.0 on 2026-11-05).
 * It reads packets without decoding them. A file cut off by a crash may end in a broken fragment, so
 * whatever ffprobe printed before it gave up is used.
 */
export async function probeVideoEnd(ffprobe: string, file: string): Promise<number | undefined> {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time:format=start_time', '-of', 'default=nw=1', file], { allowFailure: true, timeoutMs: 15 * 60_000, maxBuffer: 256 * 1024 * 1024 });
  return parseVideoEnd(stdout);
}
