/**
 * Cuts a piece out of a recording for use elsewhere: a clip with only the app's sound for promotional
 * material, the narration alone, a time range, or the transcript as text or subtitles (Robin,
 * 2026-10-02). Always from the original video, fetched from the receiver when it is not here, never
 * from the frames. Without --out the file goes to <root>/exports/<id>/, private like the rest of the
 * library: it can show the room and carry voices, so where it goes next is the user's call.
 */
import { chmod, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { callTag } from '../call.js';
import { UserError } from '../errors.js';
import { exec } from '../exec.js';
import { exists, privateDir, readJson } from '../fsx.js';
import { audioRoles } from '../pipeline/audio.js';
import { transcriptFileSchema, type TranscriptSegment } from '../pipeline/transcribe.js';
import { lineText } from '../pipeline/voices.js';
import { resolveSession, screenMissing, sessionPaths, type AudioRole } from '../session.js';
import { formatClock, frameStamp, pad, parseClock } from '../time.js';
import type { Cli } from './context.js';
import { ensureVideo } from './video.js';

export const EXPORT_KINDS = ['video', 'audio', 'transcript'] as const;
export type ExportKind = typeof EXPORT_KINDS[number];
export const TRANSCRIPT_FORMATS = ['md', 'txt', 'srt', 'vtt', 'json'] as const;
export type TranscriptFormat = typeof TRANSCRIPT_FORMATS[number];
export { audioRoles };

export interface AudioStream { channels: number }
export interface Range { fromMs: number; toMs: number }

/** The audio tracks (0-based, file order) a --sound value picks, or an error saying why it cannot. */
export function pickAudio(sound: string, roles: readonly (AudioRole | undefined)[]): number[] {
  if (sound === 'none') return [];
  if (sound === 'both' || sound === 'mix') {
    if (!roles.length) throw new UserError('this recording has no audio');
    return roles.map((_, i) => i);
  }
  if (/^\d+$/.test(sound)) {
    const n = Number(sound);
    if (n < 1 || n > roles.length) throw new UserError(`--sound ${sound}: this recording has ${roles.length} audio track(s)`);
    return [n - 1];
  }
  if (sound === 'mic' || sound === 'app') {
    const index = roles.indexOf(sound);
    if (index >= 0) return [index];
    if (roles.every(Boolean)) throw new UserError(`this recording has no ${sound} track (it has ${roles.length ? roles.join(' and ') : 'no audio'})`);
    throw new UserError(`this recording does not say which of its ${roles.length} audio track(s) is the ${sound}; pick one by number with --sound 1${roles.length > 1 ? ` to ${roles.length}` : ''}`);
  }
  throw new UserError(`--sound must be both, app, mic, mix, none or a track number, not "${sound}"`);
}

/**
 * The ffmpeg arguments. Without a range nothing is re-encoded except a mix, whose tracks become one AAC
 * track. With a range everything is re-encoded, so the cut lands on the moment asked for rather than the
 * keyframe before it (the app writes one a second). `metadata` is written into the file's own tags.
 */
export function planMedia(kind: 'video' | 'audio', audio: readonly number[], mix: boolean, range: Range | undefined, input: string, output: string, metadata: Record<string, string> = {}): string[] {
  if (kind === 'audio' && !audio.length) throw new UserError('an audio export needs sound: --sound both, app, mic, mix or a track number');
  const mixing = mix && audio.length > 1;
  const args = ['-y', '-v', 'error'];
  if (range) args.push('-ss', (range.fromMs / 1000).toFixed(3));
  args.push('-i', input);
  if (range) args.push('-t', ((range.toMs - range.fromMs) / 1000).toFixed(3));
  if (kind === 'video') args.push('-map', '0:v:0');
  if (mixing) {
    const stereo = audio.map(i => `[0:a:${i}]aformat=channel_layouts=stereo[a${i}]`).join(';');
    args.push('-filter_complex', `${stereo};${audio.map(i => `[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0[mixed]`, '-map', '[mixed]');
  } else {
    for (const i of audio) args.push('-map', `0:a:${i}`);
  }
  if (kind === 'video') args.push(...(range ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']));
  else args.push('-vn');
  if (audio.length) args.push(...(range || mixing ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']));
  for (const [key, value] of Object.entries(metadata)) args.push('-metadata', `${key}=${value}`);
  args.push('-movflags', '+faststart', output);
  return args;
}

const cueTime = (ms: number, separator: string) =>
  `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;

/**
 * The transcript lines spoken within the range. Subtitles (srt, vtt) are timed from the start of the
 * range, so they fit a clip cut with the same --from and --to; md, txt and json keep the recording's clocks.
 */
export function transcriptExport(id: string, segments: readonly TranscriptSegment[], format: TranscriptFormat, range?: Range): string {
  const from = range?.fromMs ?? 0, to = range?.toMs ?? Number.POSITIVE_INFINITY;
  const lines = segments.filter(s => s.endMs >= from && s.startMs <= to);
  switch (format) {
    case 'json': return `${JSON.stringify({ version: 1, id, ...(range ?? {}), segments: lines }, null, 2)}\n`;
    // A call's lines say who spoke ("Me: ..."); the json keeps the speaker as its own field.
    case 'txt': return lines.map(lineText).join('\n') + '\n';
    case 'md': return [`# Transcript: ${id}${range ? ` (${formatClock(from)} to ${formatClock(to)})` : ''}`, '', ...lines.map(s => `[${formatClock(s.startMs)}] ${lineText(s)}`)].join('\n') + '\n';
    case 'srt':
    case 'vtt': {
      const separator = format === 'srt' ? ',' : '.';
      const cues = lines.map((s, i) => {
        const start = Math.max(0, s.startMs - from);
        const end = Math.max(start + 1, Math.min(to, s.endMs) - from);
        return `${format === 'srt' ? `${i + 1}\n` : ''}${cueTime(start, separator)} --> ${cueTime(end, separator)}\n${lineText(s)}`;
      });
      return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${cues.join('\n\n')}\n`;
    }
  }
}

function clock(value: string, flag: string): number {
  try { return parseClock(value); } catch (error) { throw new UserError(`${flag}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function rangeOf(options: { from?: string; to?: string }, durationMs: number | undefined): Range | undefined {
  if (!options.from && !options.to) return undefined;
  const fromMs = options.from ? clock(options.from, '--from') : 0;
  let toMs = options.to ? clock(options.to, '--to') : durationMs;
  if (toMs === undefined) throw new UserError('--to is needed: this recording\'s length is not known');
  if (durationMs !== undefined) {
    if (fromMs >= durationMs) throw new UserError(`--from is past the end (${formatClock(durationMs)})`);
    toMs = Math.min(toMs, durationMs);
  }
  if (toMs <= fromMs) throw new UserError('--to must be after --from');
  return { fromMs, toMs };
}

async function audioStreams(ffprobe: string, file: string): Promise<AudioStream[]> {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels', '-of', 'json', file]);
  return z.object({ streams: z.array(z.object({ channels: z.number().int() })).default([]) }).parse(JSON.parse(stdout)).streams;
}

/** --out as a file, or a folder to put the default name in; without it, the session's exports folder. */
async function destination(out: string | undefined, dir: string, name: string): Promise<string> {
  if (!out) { await privateDir(dir); return join(dir, name); }
  const full = resolve(out);
  return (await stat(full).catch(() => undefined))?.isDirectory() ? join(full, name) : full;
}

export interface ExportOptions { sound?: string; from?: string; to?: string; format?: string; out?: string }

export async function exportCommand(cli: Cli, ref: string, what: string | undefined, options: ExportOptions): Promise<string> {
  if (!what || !(EXPORT_KINDS as readonly string[]).includes(what)) throw new UserError('say what to export: polycap export <id> video | audio | transcript');
  const kind = what as ExportKind;
  const session = await resolveSession(cli.config, ref);
  const { manifest } = session;
  const missing = screenMissing(manifest);
  if (kind === 'video' && missing) throw new UserError(`${manifest.id} has no picture: ${missing}; export audio instead`);
  const range = rangeOf(options, manifest.media.durationMs);
  const span = range ? `_${frameStamp(range.fromMs)}-${frameStamp(range.toMs)}` : '';
  const dir = join(cli.config.root, 'exports', manifest.id);
  let out: string, detail: string;
  if (kind === 'transcript') {
    const format = (options.format ?? 'md') as TranscriptFormat;
    if (!TRANSCRIPT_FORMATS.includes(format)) throw new UserError(`--format must be one of ${TRANSCRIPT_FORMATS.join(', ')}`);
    if (options.sound) throw new UserError('--sound is for video and audio exports');
    const paths = sessionPaths(session.dir);
    if (!await exists(paths.transcriptJson)) throw new UserError(`${manifest.id} has no transcript (transcribe step: ${manifest.steps.transcribe.status})`);
    const segments = (await readJson(paths.transcriptJson, transcriptFileSchema)).segments;
    out = await destination(options.out, dir, `${manifest.id}${span}_transcript.${format}`);
    await writeFile(out, transcriptExport(manifest.id, segments, format, range), { mode: 0o600 });
    detail = `transcript as ${format}`;
  } else {
    if (options.format) throw new UserError('--format is for transcript exports');
    const sound = options.sound ?? 'both';
    const input = await ensureVideo(cli, session);
    const roles = audioRoles(manifest, await audioStreams(cli.config.ffprobe, input));
    const audio = pickAudio(sound, roles);
    out = await destination(options.out, dir, `${manifest.id}${span}_${kind}-${sound}.${kind === 'video' ? 'mp4' : 'm4a'}`);
    // A call's piece says so in its own tags, wherever it is put, so polycap upload refuses it (call.ts).
    const tags: Record<string, string> = manifest.source.call ? { comment: callTag(manifest.id) } : {};
    await exec(cli.config.ffmpeg, planMedia(kind, audio, sound === 'mix', range, input, out, tags), { timeoutMs: 60 * 60_000 });
    await chmod(out, 0o600).catch(() => { /* best effort, as for frames */ });
    const picked = audio.map(i => roles[i] ?? `track ${i + 1}`).join(sound === 'mix' ? ' mixed with ' : ' and ');
    detail = `${kind === 'video' ? 'video' : 'audio only'}, ${audio.length ? picked : 'no sound'}`;
  }
  const bytes = (await stat(out)).size;
  cli.print(cli.json
    ? JSON.stringify({ path: out, bytes, kind, ...(range ?? {}) })
    : `${out}\t${(bytes / 1_048_576).toFixed(1)} MB\t${detail}${range ? `, ${formatClock(range.fromMs)} to ${formatClock(range.toMs)}` : ''}`);
  return out;
}
