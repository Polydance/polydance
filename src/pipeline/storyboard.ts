/**
 * storyboard.md: the bundle in reading order. Each transcript line with its clock, its spoken marker,
 * Claude's requests beside the line they were said on, and the frames taken while it was spoken (with
 * the full-resolution copy where there is one). An agent reads one file top to bottom and opens images
 * in context, instead of matching transcript.md, frames.json and the contact sheet by hand, which is
 * what reading the design passes took (2026-10-01). Paths are relative to the session folder. Built
 * by its own step from the other files, so it can be rebuilt without redoing them. A call (2026-11-05,
 * docs/MAC.md P8) opens with what the call was and an outline of where the screen changed, so an
 * agent need not read an hour of lines to find the slide it wants; each line says who said it. The headset's
 * errors from its log (docs/LOGS.md) sit among the lines at their moments, and a take of logs alone lists them.
 */
import { callLengthMs, callTitle, stopReasonText, type SessionCall } from '../call.js';
import type { AppSwitch, SessionManifest, SessionRequest } from '../session.js';
import { buildLabel, logsOnly, openedName, optionAt, screenMissing } from '../session.js';
import { describeLaunch, type SessionThread } from '../threads.js';
import { formatClock } from '../time.js';
import { frameSpanMs, gapsText, markFrameMs, MAX_POINTING, type FrameRecord } from './frames.js';
import { logClock, logsAbout, type LogsFile } from './logs.js';
import { MARK_CUE, type Marker } from './markers.js';
import type { PointingRecord } from './pointing.js';
import { voiceNote, type TranscriptSegment } from './transcribe.js';
import { lineText, nameCounts, speakerCounts, speakerLabel } from './voices.js';

export interface StoryboardInput {
  manifest: SessionManifest;
  segments: readonly TranscriptSegment[];
  frames: readonly FrameRecord[];
  markers: readonly Marker[];
  requests: readonly SessionRequest[];
  /** Requests the summary left out because their quotes were on no single transcript line (requests.json version 2). */
  rejectedRequests?: number;
  /** The session this one follows: the one before it in its thread, else with the same app on the same headset. */
  previous?: Pick<SessionManifest, 'id' | 'title'>;
  /** What each pointing frame shows, named by Claude when POLYCAP_POINTING=claude. */
  pointing?: readonly PointingRecord[];
  /** For a call, how many of Me's lines the transcribe step dropped as bleed. */
  droppedBleed?: number;
  /** What the logs step read from the headset's log (logs.json), when the take sent one. */
  logs?: LogsFile;
}

/** Errors shown among the lines, or listed for a take with no words; logs.json holds the first 300, logs.txt every line. */
const SHOWN_ERRORS = 40;

type LogError = LogsFile['errors'][number];
const errorText = (e: LogError, width = 200) => `${e.level} ${e.tag}${e.app ? ` (${e.app})` : e.uid ? ` (uid ${e.uid})` : ''}: ${e.text.length > width ? `${e.text.slice(0, width)}…` : e.text}`;

/**
 * The Logs section: whose lines they are, how many, and where. With no words to place them among, the errors
 * themselves, in order; with words, they are shown at their moments in the transcript instead.
 */
function logsSection(logs: LogsFile, listErrors: boolean): string[] {
  const out = ['## Logs', '', `${logsAbout(logs)} ${logs.lines} lines, ${logs.errorCount} errors (level E or F): every line on the take's clock in logs.txt, the counts and errors in logs.json.`];
  if (logs.apps.length) out.push(`Most lines from: ${logs.apps.slice(0, 5).map(a => `${a.app} (${a.lines})`).join(', ')}.`);
  out.push('');
  if (!logs.errorCount) return out;
  if (!listErrors) { out.push(`The first ${Math.min(SHOWN_ERRORS, logs.errorCount)} errors are shown among the lines below, at their moments.`, ''); return out; }
  for (const e of logs.errors.slice(0, SHOWN_ERRORS)) out.push(`- [${logClock(e.atMs)}] ${errorText(e)}`);
  if (logs.errorCount > SHOWN_ERRORS) out.push(`- ${logs.errorCount - SHOWN_ERRORS} more in logs.txt`);
  out.push('');
  return out;
}

/** A request with its kind (change, problem, idea, question) when the summary gave one, from 2026-10-12. */
export const requestLabel = (r: SessionRequest) => `${r.kind ? `${r.kind}: ` : ''}${r.text}`;

/** Quest system UI that comes to the front on the way between apps: the shell and its panels (Navigator, the Library). */
const SYSTEM_UI = /^(com\.oculus\.vrshell|com\.oculus\.systemux|com\.oculus\.panelapp\..+)$/;
export const QUEST_BROWSER = 'com.oculus.browser';

/**
 * The switches worth reading: the Quest's own system UI dropped, and any app in front for under 1.5 s
 * (panels flickering as the pointer moves between them, seen at the end of every real recording on
 * 2026-10-02) folded into its neighbours. session.json keeps every event.
 */
export function appTimeline(apps: readonly AppSwitch[], durationMs?: number): AppSwitch[] {
  const real = apps.filter(app => !SYSTEM_UI.test(app.package));
  const lasting = real.filter((app, i) => i === 0 || (real[i + 1]?.atMs ?? durationMs ?? Number.POSITIVE_INFINITY) - app.atMs >= 1500);
  return lasting.filter((app, i) => i === 0 || app.package !== lasting[i - 1].package);
}

/** "Marimba Studio 2.3.1 (231)", or the package when the app's name was not readable. */
export const appName = (app: AppSwitch) => `${app.label ?? app.package}${app.versionName ? ` ${app.versionName}` : ''}${app.versionCode !== undefined ? ` (${app.versionCode})` : ''}`;

const REASON: Record<FrameRecord['reason'], string> = { mark: 'mark', scene: 'scene change', pointing: 'pointing', segment: '', interval: 'interval', edge: '' };

/**
 * One frame's line. With a transcript, interval frames come only from silence, so they say so. A
 * pointing frame the pass named shows its reading; one the pass did not read says why (from
 * 2026-10-16), so it is not mistaken for a frame nobody looked at because pointing is off.
 */
function lineFor(frame: FrameRecord, named: PointingRecord | undefined, context: { silent: boolean; unread?: string; markNote?: string }): string {
  const at = named ? `: ${named.target === 'unclear' ? 'unclear' : `${named.sure ? '' : 'probably '}${named.target}`}` : context.unread ? ` (${context.unread})` : '';
  const notes = [
    frame.reason === 'pointing' && frame.word ? `pointing at "${frame.word}"${at}`
      : frame.reason === 'interval' && context.silent ? 'interval, nothing said'
      : frame.reason === 'mark' && context.markNote ? `mark "${context.markNote}"` : REASON[frame.reason],
    frame.full ? `full size frames/${frame.full}` : '',
  ].filter(Boolean);
  return `- ${formatClock(frame.atMs)} frames/${frame.file}${notes.length ? `, ${notes.join(', ')}` : ''}`;
}

/** Where the recording sits in its thread, and what the team asked it to try. */
export function threadLines(thread: SessionThread): string[] {
  if (thread.report) return [`A report from Polydance's bug key, in thread ${thread.key} in ${thread.project}: a bug or a feature request about Polydance itself. Only the team sees it; it is not in the sender's inbox.`];
  const lines = [thread.opened
    ? `This recording opened thread ${thread.key} in ${thread.project}: there was nothing to answer yet, so it says what the person wants.`
    : `Thread ${thread.key} in ${thread.project}, "${thread.title}".`];
  if (thread.replyTo) {
    lines.push(`It answers the team's message #${thread.replyTo.message}${thread.replyTo.text ? `: ${thread.replyTo.text.replace(/\s+/g, ' ')}` : ''}`);
    if (thread.replyTo.launch) lines.push(`Started with: ${describeLaunch(thread.replyTo.launch)}`);
  }
  return lines;
}

/** Index of the line being spoken at atMs: the last one starting at or before it, or -1 before the first. */
function lineAt(segments: readonly TranscriptSegment[], atMs: number): number {
  let found = -1;
  for (let i = 0; i < segments.length && segments[i].startMs <= atMs; i++) found = i;
  return found;
}

/**
 * The note typed with the mark at atMs, matched on the clock the frame or the marker was held to: a
 * mark's frame no later than the picture's last frame (frameSpanMs) and before any stretch without a
 * picture (markFrameMs), its marker no later than the end.
 */
function markNoteAt(manifest: SessionManifest, atMs: number): string | undefined {
  const durationMs = manifest.media.durationMs ?? Number.MAX_SAFE_INTEGER;
  const lasts = [durationMs, frameSpanMs(durationMs, manifest.media.videoEndMs)].map(span => Math.max(0, span - 1));
  const gaps = manifest.source.call?.videoGaps;
  return manifest.source.marks?.find(m => lasts.some(last => Math.min(m.atMs, last) === atMs || Math.min(markFrameMs(m.atMs, gaps), last) === atMs))?.note;
}

/**
 * An ISO time as UTC, whatever offset it was written with: the Mac app writes Z, but import takes any
 * offset (call.ts), and "11:00:02+01:00" printed as "11:00:02 UTC" was an hour out (review of 2026-11-05).
 */
const utc = (iso: string) => new Date(iso).toISOString();
/** "11:00:02 UTC" from an ISO time, for a call's start and end. */
const utcTime = (iso: string) => `${utc(iso).slice(11, 19)} UTC`;

/** " The picture ends at 12:04, before the sound: no frames after it." when the screen recording stopped more than 2 s before the sound. */
function pictureEnds(manifest: SessionManifest): string {
  const { durationMs, videoEndMs } = manifest.media;
  return durationMs !== undefined && videoEndMs !== undefined && durationMs - frameSpanMs(durationMs, videoEndMs) > 2000
    ? ` The picture ends at ${formatClock(videoEndMs)}, before the sound: no frames after it.` : '';
}

/** What the call was, before anything else: app and meeting, times, who speaks, the screen, marks, and anything missing. */
export function callHeader(manifest: SessionManifest, call: SessionCall, segments: readonly TranscriptSegment[], frames: readonly FrameRecord[], dropped?: number): string[] {
  const out = [`**A recorded call:** ${callTitle(call)}.`, ''];
  const length = callLengthMs(call);
  out.push(`- When: ${utc(call.startedAt).slice(0, 10)}, ${utcTime(call.startedAt)} to ${call.endedAt ? utcTime(call.endedAt) : 'unknown'}${length !== undefined ? ` (${formatClock(length)})` : ''}; stopped: ${call.cut ? 'cut off' : stopReasonText(call.stopReason)}. Recording ${manifest.media.durationMs !== undefined ? formatClock(manifest.media.durationMs) : 'of unknown length'}.`);
  const counts = speakerCounts(segments);
  const describe = (speaker: string) => speaker === 'me' ? 'the microphone, the person who recorded the call' : speaker === 'others' ? "the call's sound, everyone else" : "one voice in the call's sound";
  out.push(counts.length
    ? `- Speakers: ${counts.map(([speaker, n]) => `${speakerLabel(speaker)} (${describe(speaker)}), ${n} ${n === 1 ? 'line' : 'lines'}`).join('; ')}.${dropped ? ` ${dropped} of Me's ${dropped === 1 ? 'lines was' : 'lines were'} dropped as Others heard through the speakers.` : ''}`
    : `- Speakers: none transcribed (transcribe step: ${manifest.steps.transcribe.status}).`);
  // Who of the Others, where Meet's speaking ring showed it (speakers.ts); the rest stay Others.
  const names = nameCounts(segments);
  if (names.length) {
    const others = segments.filter(s => s.speaker !== undefined && s.speaker !== 'me').length, named = names.reduce((sum, [, n]) => sum + n, 0);
    out.push(`- Named from Meet's speaking ring: ${names.map(([name, n]) => `${name}, ${n} ${n === 1 ? 'line' : 'lines'}`).join('; ')}.${others > named ? ` ${others - named} of Others' lines are not named (no ring, or more than one person ringed); speakers.json says how each was decided.` : ''}`);
  }
  const missing = screenMissing(manifest);
  const scenes = frames.filter(f => f.reason === 'scene').length;
  out.push(missing
    ? `- Screen: **not recorded.** ${missing.charAt(0).toUpperCase()}${missing.slice(1)}, so there are no frames; this is the sound alone.`
    : `- Screen: recorded${call.display ? ` (a ${call.display.width}x${call.display.height} display${call.excludedApps?.length ? `, ${call.excludedApps.length} apps left out` : ''})` : ''}; ${scenes} scene ${scenes === 1 ? 'change' : 'changes'}, ${frames.length} frames.${pictureEnds(manifest)}`);
  // Where the screen capture stopped and came back (C14), or started late: black in the file, so no frames and no names from Meet's ring.
  if (call.videoGaps?.length && !missing) out.push(`- **No picture** ${gapsText(call.videoGaps, true)}: the screen was not being captured there and the file is black, so there are no frames and no names from Meet's speaking ring in ${call.videoGaps.length === 1 ? 'that stretch' : 'those stretches'}; the sound goes on.`);
  // With the screen recorded, the recorder's note is about the sound (a source that stopped, sound dropped);
  // without it, screenMissing has already quoted the note.
  if (call.videoNote && !missing) out.push(`- Recorder's notes: ${call.videoNote}.`);
  const marks = manifest.source.marks ?? [];
  if (marks.length) out.push(`- Marks: ${marks.length}, at ${marks.map(m => `${formatClock(m.atMs)}${m.note ? ` "${m.note}"` : ''}`).join(', ')}.`);
  if (call.farEnd === 'silent') out.push("- **The call's sound was silent:** the recorder heard digital silence from the call app, so Others' words are missing.");
  out.push(`- Told the others they were being recorded: ${call.told ?? 'unknown'}.`);
  if (call.short) out.push('- **Short:** under 2 minutes, most likely a lobby preview or a mic test rather than a call.');
  if (call.cut) out.push('- **Cut off:** the recording ended unexpectedly (a crash, sleep or a full disk); everything up to then is here.');
  return out;
}

export function storyboardMarkdown(input: StoryboardInput): string {
  const { manifest, segments, frames, markers, requests, previous } = input;
  const named = new Map((input.pointing ?? []).map(p => [p.file, p]));
  const unread = { done: `not analysed: the pass reads the first ${MAX_POINTING}`, failed: 'not analysed: the pointing step failed' }[manifest.steps.pointing.status as 'done' | 'failed'];
  const frameLine = (frame: FrameRecord) => lineFor(frame, named.get(frame.file), { silent: segments.length > 0, unread, markNote: frame.reason === 'mark' ? markNoteAt(manifest, frame.atMs) : undefined });
  const out = [`# Storyboard: ${manifest.id}`, ''];
  if (manifest.summary) out.push(`**${manifest.summary.title}.** ${manifest.summary.text}`, '');
  const source = manifest.source;
  const call = source.call;
  if (call) out.push(...callHeader(manifest, call, segments, frames, input.droppedBleed), '');
  out.push([
    `Recorded ${manifest.recordedAt}`,
    manifest.media.durationMs !== undefined ? formatClock(manifest.media.durationMs) : '',
    source.deviceModel ?? '',
    source.appPackage ? `${source.appPackage}${source.appBuild ? ` ${buildLabel(source.appBuild)}` : ''}` : '',
  ].filter(Boolean).join(' · '));
  if (source.thread) out.push(...threadLines(source.thread));
  if (previous) out.push(`${source.thread ? 'Previous recording in this thread' : call ? 'Previous call with this meeting code' : 'Previous session with this app on this headset'}: ${previous.id}${previous.title !== previous.id ? `, "${previous.title}"` : ''}`);
  const screenless = manifest.steps.frames.status !== 'pending' && screenMissing(manifest) !== undefined;
  out.push(screenless ? 'Paths are relative to this folder.' : `Paths are relative to this folder; frames/full/ holds full-resolution copies of ${call ? 'scene, mark, pointing' : 'pointing'} and reference frames.`, '');
  // A call's header has already said whose each voice is; its app track is people, not a voice-over.
  const whose = call && manifest.media.voice !== 'unknown' ? undefined : voiceNote(manifest.media.voice);
  if (whose) out.push(whose, '');
  if (manifest.steps.frames.status === 'pending') out.push('**Words only so far.** The video was still uploading when this was written, so there are no frames yet; `polycap sync` again for them.', '');
  else if (logsOnly(manifest)) out.push('**Logs alone.** This take recorded no picture and no sound, only the headset\'s log while it ran.', '');
  else if (!call && screenless) { const missing = screenMissing(manifest)!; out.push(`**Sound only.** ${missing.charAt(0).toUpperCase()}${missing.slice(1)}, so there are no frames.`, ''); }

  const apps = appTimeline(source.apps ?? [], manifest.media.durationMs);
  const opened = source.opened ?? [];
  if (opened.length) {
    out.push('## Opened from the inbox', '', 'What Polydance opened from the thread\'s launches while recording, and when: which build or variant was put on screen.', '');
    for (const o of opened) out.push(`- [${formatClock(o.atMs)}] ${openedName(o) ? `${openedName(o)}: ` : ''}${o.what}`);
    out.push('');
  }
  if (apps.length) {
    out.push('## Apps in front', '', 'From the headset\'s usage log: which app came to the front when, with its version (the Quest\'s own menus and sub-second flickers left out).', '');
    for (const app of apps) out.push(`- [${formatClock(app.atMs)}] ${appName(app)}${app.package === QUEST_BROWSER ? ': the Meta Quest Browser, so a web page; its address is not recorded' : ''}`);
    out.push('');
  }

  if (input.logs) out.push(...logsSection(input.logs, !segments.length));
  if (logsOnly(manifest)) return `${out.join('\n').trimEnd()}\n`;

  // Feedback sorted by option: each request says what was on screen when it was said (2026-10-06).
  const during = (atMs: number) => { const name = optionAt(opened, atMs); return name ? `(${name}) ` : ''; };
  const rejected = input.rejectedRequests ?? 0;
  if (requests.length || rejected) {
    out.push('## Requests', '', `Claude's reading of the transcript (${manifest.summary?.model ?? 'model unknown'}); the transcript below is the record.${optionAt(opened, Number.MAX_SAFE_INTEGER) ? ' In brackets, what was on screen when it was said.' : ''}`, '');
    for (const r of requests) out.push(`- [${formatClock(r.atMs)}] ${during(r.atMs)}${requestLabel(r)}`);
    if (rejected) out.push(`- ${rejected} more left out: ${rejected === 1 ? 'its quote was' : 'their quotes were'} not on one transcript line (rejected in requests.json)`);
    out.push('');
  }

  // The outline of a call: where the screen changed, with the frame and what was being said then.
  const sceneFrames = frames.filter(f => f.reason === 'scene');
  if (call && sceneFrames.length) {
    out.push('## Scenes', '', 'Where the screen changed, with its frame and the line being said at the time; the full transcript follows.', '');
    for (const frame of sceneFrames) {
      const line = lineAt(segments, frame.atMs);
      out.push(`- [${formatClock(frame.atMs)}] frames/${frame.full ?? frame.file}${line >= 0 ? `: ${lineText(segments[line])}` : ''}`);
    }
    out.push('');
  }

  if (!segments.length) {
    const why = `No transcript (transcribe step: ${manifest.steps.transcribe.status})`;
    out.push('## Frames', '', frames.length || !screenMissing(manifest) ? `${why}, so frames are at a fixed interval${sceneFrames.length ? ' and where the screen changed' : ''}.` : `${why}, and no frames: the screen was not recorded.`, '');
    for (const frame of frames) out.push(frameLine(frame));
    return `${out.join('\n')}\n`;
  }

  out.push(call ? (screenless ? '## Lines' : '## Lines and frames') : screenless ? '## Transcript' : '## Transcript and frames', '');
  const framesBy = new Map<number, FrameRecord[]>();
  for (const frame of frames) {
    const line = lineAt(segments, frame.atMs);
    framesBy.set(line, [...framesBy.get(line) ?? [], frame]);
  }
  const requestsBy = new Map<number, SessionRequest[]>();
  for (const request of requests) {
    const line = Math.max(0, lineAt(segments, request.atMs));
    requestsBy.set(line, [...requestsBy.get(line) ?? [], request]);
  }
  const before = framesBy.get(-1) ?? [];
  if (before.length) out.push('Before speech', ...before.map(frameLine), '');
  // App switches, launches opened and marks show just before the first line spoken after them, in
  // order; a mark with a frame of its own is already shown by that frame.
  const markFrames = new Set(frames.filter(f => f.reason === 'mark').map(f => f.atMs));
  const notes = [
    ...apps.filter(a => a.atMs > 0).map(a => ({ atMs: a.atMs, text: `${appName(a)} came to the front` })),
    ...opened.map(o => ({ atMs: o.atMs, text: `opened ${openedName(o) ? `${openedName(o)}: ` : ''}${o.what}` })),
    ...markers.filter(m => m.cue === MARK_CUE && !markFrames.has(m.atMs)).map(m => ({ atMs: m.atMs, text: `marked${markNoteAt(manifest, m.atMs) ? `: ${markNoteAt(manifest, m.atMs)}` : ''}` })),
    ...(input.logs?.errors ?? []).slice(0, SHOWN_ERRORS).map(e => ({ atMs: e.atMs, text: `log ${errorText(e, 160)}` })),
  ].sort((a, b) => a.atMs - b.atMs);
  let nextNote = 0;
  segments.forEach((segment, i) => {
    for (; nextNote < notes.length && notes[nextNote].atMs <= segment.startMs; nextNote++) out.push(`(${formatClock(notes[nextNote].atMs)}: ${notes[nextNote].text})`, '');
    const marker = markers.find(m => m.cue !== MARK_CUE && m.atMs === segment.startMs);
    out.push(`[${formatClock(segment.startMs)}] ${lineText(segment)}${marker ? ` {${marker.kind}}` : ''}`);
    for (const request of requestsBy.get(i) ?? []) out.push(`- ${request.kind ?? 'request'}: ${during(request.atMs)}${request.text}`);
    out.push(...(framesBy.get(i) ?? []).map(frameLine), '');
  });
  // What happened after the last line was said (an error as the take ended is often the one that matters).
  for (; nextNote < notes.length; nextNote++) out.push(`(${formatClock(notes[nextNote].atMs)}: ${notes[nextNote].text})`, '');
  return `${out.join('\n').trimEnd()}\n`;
}
