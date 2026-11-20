import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callLengthMs, callTitle, stopReasonText, type SessionCall } from '../call.js';
import { UserError } from '../errors.js';
import { exec } from '../exec.js';
import { exists, privateDir, readJson } from '../fsx.js';
import { hookRunLine, loadHooks, readHookRuns, type Hook, type HookRuns } from '../hooks.js';
import { framesFileSchema, gapsText } from '../pipeline/frames.js';
import { appName, appTimeline, requestLabel } from '../pipeline/storyboard.js';
import { markersFileSchema } from '../pipeline/markers.js';
import { transcriptFileSchema, type TranscriptFile } from '../pipeline/transcribe.js';
import { lineText, nameCounts, speakerCounts, speakerLabel } from '../pipeline/voices.js';
import { buildLabel, listSessions, logsOnly, previousSession, requestsFileSchema, resolveSession, screenMissing, sessionPaths, STEP_NAMES, type SessionManifest, type SessionRef, type StepName, wordsOnly, openedName, optionAt } from '../session.js';
import { formatClock, frameStamp, parseClock } from '../time.js';
import type { Cli } from './context.js';
import { table } from './context.js';
import { callsTable, findSessions, foundJson, type FindOptions } from './find.js';

const stepGlyph = { done: 'ok', failed: 'FAIL', skipped: '-', pending: '..' } as const;
const stepLetter: Record<StepName, string> = { probe: 'p', logs: 'l', audio: 'a', transcribe: 't', speakers: 'w', frames: 'f', pointing: 'n', markers: 'm', summary: 's', storyboard: 'b' };
const stepsSummary = (ref: SessionRef) => STEP_NAMES.map(n => `${stepLetter[n]}:${stepGlyph[ref.manifest.steps[n].status]}`).join(' ');

/** Every session, newest first, or those the filters pass (find.ts); `--calls` prints who was on each call. */
export async function list(cli: Cli, options: FindOptions = {}): Promise<SessionRef[]> {
  const sessions = await findSessions(cli, options);
  if (cli.json) { cli.print(JSON.stringify(sessions.map(foundJson), null, 2)); return sessions; }
  const filtered = Object.entries(options).some(([key, value]) => key !== 'now' && value !== undefined && value !== false);
  if (!sessions.length) { cli.print(filtered ? 'No sessions match. Run `polycap sync` first for hosted recordings; calls are only on the Mac that recorded them.' : 'No sessions yet. Run `polycap pull` or `polycap import <video>`.'); return sessions; }
  if (options.calls) { cli.print(callsTable(sessions)); return sessions; }
  cli.print(table(sessions.map(s => [s.manifest.id, s.manifest.summary?.title ?? '', s.manifest.media.durationMs ? formatClock(s.manifest.media.durationMs) : '?', s.manifest.source.appPackage ?? '', String(s.manifest.frameCount ?? ''), String(s.manifest.markerCount ?? ''), stepsSummary(s)]), ['id', 'title', 'length', 'app', 'frames', 'markers', `steps (${STEP_NAMES.map(n => `${stepLetter[n]} ${n}`).join(', ')})`]));
  return sessions;
}

export async function latest(cli: Cli): Promise<SessionRef> {
  const session = await resolveSession(cli.config, 'latest');
  cli.print(cli.json ? JSON.stringify({ id: session.manifest.id, dir: session.dir }) : `${session.manifest.id}\t${session.dir}`);
  return session;
}

/** Whose voice the transcript is, when it is not plainly the narrator's microphone. */
const VOICE_TEXT: Partial<Record<NonNullable<SessionManifest['media']['voice']>, string>> = {
  app: "the app's own sound: no microphone was recorded, so the transcript is not the user's words",
  unknown: 'one mixed track',
  both: "both: Me is the microphone, Others the call's sound",
};

/** A call's facts for `polycap show`: what and when, how it stopped, the screen, the far end, marks and speakers. */
export function callLines(manifest: SessionManifest, call: SessionCall, transcript?: Pick<TranscriptFile, 'segments' | 'bleedDropped'>): string[] {
  const length = callLengthMs(call);
  const lines = [`call ${callTitle(call)}  ${call.startedAt} to ${call.endedAt ?? '?'}${length !== undefined ? ` (${formatClock(length)})` : ''}  stopped: ${call.cut ? 'cut off' : stopReasonText(call.stopReason)}`];
  const missing = screenMissing(manifest);
  lines.push(`call screen ${missing ?? `recorded${call.display ? ` (${call.display.width}x${call.display.height})` : ''}`} · far end ${call.farEnd ?? '?'} · told ${call.told ?? 'unknown'}${call.short ? ' · short' : ''}${call.cut ? ' · cut' : ''}`);
  if (call.videoGaps?.length && !missing) lines.push(`call no picture ${gapsText(call.videoGaps, true)}`);
  if (call.videoNote && !missing) lines.push(`call notes ${call.videoNote}`);
  const marks = manifest.source.marks ?? [];
  if (marks.length) lines.push(`marks ${marks.map(m => `[${formatClock(m.atMs)}]${m.note ? ` ${m.note}` : ''}`).join(', ')}`);
  const counts = speakerCounts(transcript?.segments ?? []);
  if (counts.length) lines.push(`speakers ${counts.map(([speaker, n]) => `${speakerLabel(speaker)} ${n} ${n === 1 ? 'line' : 'lines'}`).join(', ')}${transcript?.bleedDropped ? ` (${transcript.bleedDropped} of Me's dropped as bleed)` : ''}`);
  // Who of the Others, where Meet's speaking ring showed it (speakers.ts).
  const names = nameCounts(transcript?.segments ?? []);
  if (names.length) lines.push(`named ${names.map(([name, n]) => `${name} ${n} ${n === 1 ? 'line' : 'lines'}`).join(', ')}`);
  return lines;
}

export async function show(cli: Cli, ref: string): Promise<void> {
  const session = await resolveSession(cli.config, ref);
  const { manifest, dir } = session;
  const paths = sessionPaths(dir);
  const markers = await exists(paths.markers) ? (await readJson(paths.markers, markersFileSchema)).markers : [];
  const frames = await exists(paths.framesJson) ? (await readJson(paths.framesJson, framesFileSchema)).frames : [];
  const requestsFile = await exists(paths.requests) ? await readJson(paths.requests, requestsFileSchema) : undefined;
  const requests = requestsFile?.requests ?? [], rejected = requestsFile?.version === 2 ? requestsFile.rejected : [];
  const previous = previousSession(await listSessions(cli.config), manifest);
  // What the routine hooks did: reported, not fatal, when the record is unreadable, so the rest still shows.
  let hookRuns: HookRuns['runs'] = {}, hookRunsError: string | undefined;
  try { hookRuns = (await readHookRuns(dir)).runs; } catch (error) { hookRunsError = error instanceof Error ? error.message : String(error); }
  if (cli.json) { cli.print(JSON.stringify({ dir, manifest, previous: previous?.manifest.id, markers, requests, rejectedRequests: rejected, frames: frames.map(f => ({ ...f, path: join(paths.frames, f.file), ...(f.full ? { fullPath: join(paths.frames, f.full) } : {}) })), hookRuns, ...(hookRunsError ? { hookRunsError } : {}) }, null, 2)); return; }
  cli.print(`${manifest.id}  (${manifest.title === manifest.id ? 'untitled' : manifest.title})`);
  if (manifest.summary) cli.print(`summary ${manifest.summary.text}  (${manifest.summary.model})`);
  const thread = manifest.source.thread;
  if (thread) cli.print(`thread ${thread.key}${thread.opened ? ' (opened by this recording)' : `  (${thread.title})`}${thread.replyTo ? `  answers #${thread.replyTo.message}${thread.replyTo.text ? `: ${thread.replyTo.text.replace(/\s+/g, ' ').slice(0, 120)}` : ''}` : ''}`);
  if (previous) cli.print(`previous ${previous.manifest.id}${previous.manifest.title !== previous.manifest.id ? `  (${previous.manifest.title})` : ''}${thread ? `  in ${thread.key}` : ''}`);
  if (wordsOnly(manifest)) cli.print('words only: the video was still uploading to the receiver, so probe, frames and pointing are pending there, not failed; `polycap sync` again for the frames');
  const call = manifest.source.call;
  if (call) for (const line of callLines(manifest, call, await exists(paths.transcriptJson) ? await readJson(paths.transcriptJson, transcriptFileSchema) : undefined)) cli.print(line);
  else if (manifest.source.marks?.length) cli.print(`marks ${manifest.source.marks.map(m => `[${formatClock(m.atMs)}]${m.note ? ` ${m.note}` : ''}`).join(', ')}`);
  const voiceText = call && manifest.media.voice === 'app' ? "the call's sound only: no microphone track, so Me is not transcribed"
    : call && manifest.media.voice === 'mic' ? "the microphone only: no track of the call's sound, so Others are not transcribed"
    : manifest.media.voice && VOICE_TEXT[manifest.media.voice];
  if (voiceText) cli.print(`voice ${voiceText}`);
  const apps = appTimeline(manifest.source.apps ?? [], manifest.media.durationMs);
  if (apps.length) cli.print(`apps ${apps.map(app => `[${formatClock(app.atMs)}] ${appName(app)}`).join(', ')}`);
  const opened = manifest.source.opened ?? [];
  if (opened.length) cli.print(`opened ${opened.map(o => `[${formatClock(o.atMs)}] ${openedName(o) ? `${openedName(o)}: ` : ''}${o.what}`).join(', ')}`);
  cli.print(`recorded ${manifest.recordedAt} (${manifest.recordedAtSource})  length ${manifest.media.durationMs ? formatClock(manifest.media.durationMs) : '?'}  ${logsOnly(manifest) ? 'logs alone: no video, no audio' : `${manifest.media.hasVideo === false ? 'no video' : `${manifest.media.width ?? '?'}x${manifest.media.height ?? '?'}`}  audio ${manifest.media.hasAudio === undefined ? '?' : manifest.media.hasAudio ? 'yes' : 'no'}`}`);
  cli.print(`source ${manifest.source.kind}${manifest.source.deviceModel ? ` · ${manifest.source.deviceModel}` : ''}${manifest.source.appPackage ? ` · app ${manifest.source.appPackage}${manifest.source.appBuild ? ` ${buildLabel(manifest.source.appBuild)}` : ''}` : ''} · ${manifest.source.originalName}`);
  cli.print(`dir ${dir}`);
  cli.print('');
  cli.print(table(STEP_NAMES.map(n => { const s = manifest.steps[n]; return [n, s.status, s.note ?? s.error ?? '']; }), ['step', 'status', 'detail']));
  cli.print('');
  if (hookRunsError) { cli.print(`hooks: ${hookRunsError}`); cli.print(''); }
  else if (Object.keys(hookRuns).length) {
    // The hook's folder, for the resume command, comes from the hooks file as it is now.
    const configured: Hook[] = await loadHooks(cli.config.hooksFile).then(h => h.hooks, () => []);
    cli.print('hooks:');
    for (const [name, run] of Object.entries(hookRuns)) cli.print(`  ${hookRunLine(name, run, configured.find(h => h.name === name)).replace(/\n/g, '\n  ')}`);
    cli.print('');
  }
  const full = frames.filter(f => f.full).length;
  cli.print(`files: ${[await exists(paths.storyboard) ? 'storyboard.md' : '', await exists(paths.transcriptMd) ? 'transcript.md' : '', await exists(paths.contactSheet) ? 'contact-sheet.jpg' : '', frames.length ? `frames/ (${frames.length}${full ? `, ${full} also in frames/full/` : ''})` : '', markers.length ? 'markers.json' : '', requestsFile ? 'requests.json' : '', await exists(paths.logsTxt) ? 'logs.txt' : ''].filter(Boolean).join(', ') || 'video only'}`);
  if (requests.length || rejected.length) {
    cli.print(''); cli.print(`requests (${requests.length}, Claude's reading${optionAt(opened, Number.MAX_SAFE_INTEGER) ? '; in brackets, what was on screen' : ''}):`);
    for (const r of requests) { const name = optionAt(opened, r.atMs); cli.print(`  [${formatClock(r.atMs)}] ${name ? `(${name}) ` : ''}${requestLabel(r)}`); }
    if (rejected.length) cli.print(`  ${rejected.length} more left out: quote not on one transcript line (rejected in requests.json)`);
  }
  if (markers.length) { cli.print(''); cli.print(`markers (${markers.length}):`); for (const m of markers.slice(0, 30)) cli.print(`  [${formatClock(m.atMs)}] ${m.kind.padEnd(6)} ${m.text}`); if (markers.length > 30) cli.print(`  ... ${markers.length - 30} more in markers.json`); }
}

export interface RangeOptions { from?: string; to?: string }
const range = (options: RangeOptions) => ({ fromMs: options.from ? parseClock(options.from) : 0, toMs: options.to ? parseClock(options.to) : Number.POSITIVE_INFINITY });

export async function transcript(cli: Cli, ref: string, options: RangeOptions): Promise<void> {
  const session = await resolveSession(cli.config, ref);
  const paths = sessionPaths(session.dir);
  if (!await exists(paths.transcriptJson)) throw new UserError(`${session.manifest.id} has no transcript (transcribe step: ${session.manifest.steps.transcribe.status}${session.manifest.steps.transcribe.error ? `, ${session.manifest.steps.transcribe.error}` : ''})`);
  const { fromMs, toMs } = range(options);
  const file = await readJson(paths.transcriptJson, transcriptFileSchema);
  const segments = file.segments.filter(s => s.endMs >= fromMs && s.startMs <= toMs);
  if (cli.json) { cli.print(JSON.stringify(segments)); return; }
  if (!options.from && !options.to) { cli.print((await readFile(paths.transcriptMd, 'utf8')).trimEnd()); return; }
  for (const s of segments) cli.print(`[${formatClock(s.startMs)}] ${lineText(s)}`);
}

export interface FramesOptions extends RangeOptions { at?: string; window?: string; exact?: boolean; width?: string }

/** Prints frame paths, nearest-first around --at, or within --from/--to, or all. Paths are what an agent opens. */
export async function frames(cli: Cli, ref: string, options: FramesOptions): Promise<void> {
  const session = await resolveSession(cli.config, ref);
  if (options.exact) { await exactFrame(cli, session, options); return; }
  const paths = sessionPaths(session.dir);
  const missing = screenMissing(session.manifest);
  if (!await exists(paths.framesJson)) throw new UserError(missing ? `${session.manifest.id} has no frames: ${missing}` : `${session.manifest.id} has no frames yet (frames step: ${session.manifest.steps.frames.status})`);
  const all = (await readJson(paths.framesJson, framesFileSchema)).frames.map(f => ({ ...f, path: join(paths.frames, f.file) }));
  let picked = all;
  if (options.at) {
    const at = parseClock(options.at), window = (options.window ? Number(options.window) : 8) * 1000;
    if (!Number.isFinite(window) || window < 0) throw new UserError('--window must be seconds');
    picked = all.filter(f => Math.abs(f.atMs - at) <= window).sort((a, b) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at));
    if (!picked.length) picked = [...all].sort((a, b) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at)).slice(0, 2);
  } else if (options.from || options.to) { const { fromMs, toMs } = range(options); picked = all.filter(f => f.atMs >= fromMs && f.atMs <= toMs); }
  if (cli.json) { cli.print(JSON.stringify(picked)); return; }
  for (const f of picked) cli.print(`${f.path}\t[${formatClock(f.atMs)}]\t${f.reason}${f.word ? ` "${f.word}"` : ''}${f.full ? `\tfull ${join(paths.frames, f.full)}` : ''}`);
  if (!options.at && !options.from && !options.to && await exists(paths.contactSheet)) cli.print(`${paths.contactSheet}\t[overview]\tcontact-sheet`);
}

/**
 * One frame at exactly --at, at full resolution (1920 px unless --width), for small UI text or a moment
 * between the bundle's frames. From the local video when there is one, otherwise rendered by the hosted
 * receiver, which keeps the video. Saved under <root>/cache/frames/<id>/, outside the bundle, so sync's
 * mirroring never removes it.
 */
async function exactFrame(cli: Cli, session: SessionRef, options: FramesOptions): Promise<void> {
  if (!options.at) throw new UserError('--exact needs --at, for example --at 0:58');
  const missing = screenMissing(session.manifest);
  if (missing) throw new UserError(`${session.manifest.id} has no picture to take a frame from: ${missing}`);
  const atMs = parseClock(options.at);
  const width = options.width ? Number(options.width) : 1920;
  if (!Number.isInteger(width) || width < 160 || width > 3840) throw new UserError('--width must be a whole number of pixels from 160 to 3840');
  const { manifest } = session;
  if (manifest.media.durationMs !== undefined && atMs > manifest.media.durationMs) throw new UserError(`--at is past the end (${formatClock(manifest.media.durationMs)})`);
  const dir = join(cli.config.root, 'cache', 'frames', manifest.id);
  await privateDir(dir);
  const out = join(dir, `${frameStamp(atMs)}_${String(atMs % 1000).padStart(3, '0')}ms_w${width}.jpg`);
  // screenMissing above has refused a take of logs alone, the one with no media file.
  const video = join(session.dir, manifest.media.video ?? '');
  if (!await exists(out)) {
    if (await exists(video)) {
      await exec(cli.config.ffmpeg, ['-y', '-v', 'error', '-ss', (atMs / 1000).toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '2', out], { timeoutMs: 120_000 });
    } else if (manifest.source.kind === 'upload' && cli.config.remoteUrl && cli.config.remoteToken) {
      const url = `${cli.config.remoteUrl}/v1/sessions/${encodeURIComponent(manifest.id)}/frame?at=${(atMs / 1000).toFixed(3)}&width=${width}`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${cli.config.remoteToken}` }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok || response.headers.get('content-type') !== 'image/jpeg') {
        throw new UserError(`the receiver could not render that frame (${response.status}): ${(await response.text()).slice(0, 200)}`);
      }
      await writeFile(out, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    } else {
      throw new UserError(`${manifest.id} has no video here; run \`polycap sync --video\`, or set POLYCAP_REMOTE_URL for a session that came from the receiver`);
    }
    await chmod(out, 0o600).catch(() => undefined);
  }
  if (cli.json) { cli.print(JSON.stringify({ path: out, atMs, width })); return; }
  cli.print(`${out}\t[${formatClock(atMs)}]\texact ${width}px`);
}
