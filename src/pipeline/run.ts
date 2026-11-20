/**
 * The pipeline: probe, logs, audio, transcribe, speakers, frames, pointing, markers, summary, storyboard, in
 * order, each outcome written to session.json as it finishes. It knows only what the bundle holds: whether
 * the video is here yet (words first), whether the file has a picture, whether the take sent its logs or was
 * its logs alone (docs/LOGS.md), and whether session.json says it is a call, never which transport brought it.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inVideoGap } from '../call.js';
import type { Config } from '../config.js';
import { exec } from '../exec.js';
import { exists, privateDir, readJson, writeJsonAtomic } from '../fsx.js';
import { listSessions, loadSession, logsOnly, previousSession, requestsFileSchema, saveSession, screenMissing, sessionPaths, STEP_NAMES, type SessionManifest, type StepName } from '../session.js';
import { formatClock } from '../time.js';
import { extractAudio, voiceTracks, type VoiceTrack } from './audio.js';
import { addPriorityFrames, contactSheet, extractFrames, frameSpanMs, framesFileSchema, gapsText, grabFailureNote, planFrames } from './frames.js';
import { logsFileSchema, logsNote, writeLogs } from './logs.js';
import { CALL_CUES, findMarkers, markersFileSchema, markMarkers, REFERENCE_CUE } from './markers.js';
import { probe, probeVideoEnd } from './probe.js';
import { collapseScenes, detectScenes } from './scenes.js';
import { storyboardMarkdown } from './storyboard.js';
import { pointingFileSchema } from './pointing.js';
import { createTranscriber, splitLongSegments, transcriptFileSchema, transcriptMarkdown, type Transcriber, type TranscriptSegment } from './transcribe.js';
import { detectSilences, dropFaintLines, dropSilentLines, FAINT, measureLoudness, SILENCE } from './silence.js';
import { nameSpeakers, speakersFileSchema, toolReportSchema } from './speakers.js';
import { mergeVoices } from './voices.js';

export interface ProcessOptions { force?: boolean; only?: StepName; log?: (line: string) => void }

const now = () => new Date().toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What the audio step says it took from each track. */
function audioNote(tracks: readonly VoiceTrack[], voice: SessionManifest['media']['voice'], early: boolean, call: boolean, silentApp?: number): string {
  const n = (t: VoiceTrack) => `track ${t.index + 1}`;
  if (voice === 'both') return `${n(tracks[0])}, the microphone (Me), and ${n(tracks[1])}, the call's sound (Others), each transcribed`;
  if (call && silentApp !== undefined) return `${n(tracks[0])}, the microphone (Me); track ${silentApp + 1}, the call's sound, was digital silence (farEnd silent), so Others are not transcribed`;
  if (call && voice === 'mic') return `${n(tracks[0])}, the microphone (Me); no track of the call's sound, so Others are not transcribed`;
  if (call && voice === 'app') return `${n(tracks[0])}, the call's sound (Others); no microphone track, so Me is not transcribed`;
  const whose = { mic: 'the microphone', app: "the app's own sound: no microphone was recorded, so the transcript is not the user's words", unknown: 'whose voice is not known (one mixed track)', both: '' }[voice ?? 'unknown'];
  return early ? `${whose}, sent ahead of the video` : `${n(tracks[0])}, ${whose}`;
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * Each track transcribed on its own and split into sentence-sized lines; a call's lines carry their
 * speaker, and with both voices the mic's bleed is dropped as they are merged (voices.ts). A call's
 * tracks are each quiet for long stretches, so whisper runs with its call flags and any line said over
 * silence on its own wav is dropped (silence.ts); a silence check that fails is said, and keeps them. A
 * recording's narration loses lines that never rise above the room's own sound (FAINT), the same way.
 */
async function transcribeTracks(transcriber: Transcriber, ffmpeg: string, tracks: readonly { track: VoiceTrack; wav: string; prefix: string }[]) {
  const done = [];
  for (const { track, wav, prefix } of tracks) {
    const call = track.speaker !== undefined;
    const transcript = await transcriber.transcribe(wav, prefix, { call });
    let lines = splitLongSegments(transcript.segments).map(s => track.speaker ? { ...s, speaker: track.speaker } : s);
    let silent = 0, silenceError: string | undefined;
    if (call && lines.length) {
      try { ({ kept: lines, dropped: silent } = dropSilentLines(lines, await detectSilences(ffmpeg, wav))); }
      catch (error) { silenceError = message(error).split('\n')[0].slice(0, 160); }
    }
    // A recording's narration: lines that never rise above the room's own sound are not the narrator's (silence.ts, FAINT).
    let faint = 0, faintError: string | undefined;
    if (!call && lines.length) {
      try { ({ kept: lines, dropped: faint } = dropFaintLines(lines, await measureLoudness(ffmpeg, wav))); }
      catch (error) { faintError = message(error).split('\n')[0].slice(0, 160); }
    }
    done.push({ track, transcript, lines, silent, silenceError, faint, faintError });
  }
  const silenceNote = done.flatMap(d => [
    d.silent ? `${count(d.silent, `${d.track.name === 'app' ? "call's sound" : 'microphone'} line`)} dropped as said over silence (under ${SILENCE.noiseDb} dB for ${SILENCE.minMs / 1000} s or more)` : '',
    d.silenceError ? `${d.track.name}: the silence check failed, so no line was dropped as said over silence (${d.silenceError})` : '',
    d.faint ? `${count(d.faint, 'line')} dropped as the room's sound, not the narrator (under ${FAINT.aboveFloorDb} dB over the recording's background)` : '',
    d.faintError ? `the loudness check failed, so no line was dropped as the room's sound (${d.faintError})` : '',
  ]).filter(Boolean).map(text => `; ${text}`).join('');
  const [first, second] = done;
  if (!second) {
    const split = first.lines.length !== first.transcript.segments.length ? ` as ${first.lines.length} lines` : '';
    return { transcript: first.transcript, segments: first.lines, bleedDropped: undefined, note: `${first.transcript.segments.length} segments${split}${silenceNote}${first.transcript.note ? `; ${first.transcript.note}` : ''}` };
  }
  const { segments, dropped } = mergeVoices(first.lines, second.lines);
  const engine = [first, second].filter(d => d.transcript.note).map(d => `${d.track.name}: ${d.transcript.note}`).join('; ');
  const note = `${count(first.transcript.segments.length, 'segment')} from the microphone and ${second.transcript.segments.length} from the call's sound, as ${count(segments.length, 'line')}; `
    + `${dropped} microphone ${dropped === 1 ? 'line' : 'lines'} dropped as the far end heard through the speakers${silenceNote}${engine ? `; ${engine}` : ''}`;
  return { transcript: { ...first.transcript, language: first.transcript.language ?? second.transcript.language }, segments, bleedDropped: dropped, note };
}

/**
 * Runs every pending step in order and records each outcome in the manifest as it goes.
 * A failed transcription is recorded and frames fall back to an even interval; nothing is retried silently.
 */
export async function processSession(config: Config, dir: string, options: ProcessOptions = {}): Promise<SessionManifest> {
  const log = options.log ?? (() => {});
  const paths = sessionPaths(dir);
  let manifest = await loadSession(dir);
  // A take of logs alone has no media file: nothing to probe, hear or see; every use of `video` below is
  // behind a step it skips (docs/LOGS.md).
  const alone = logsOnly(manifest);
  const video = alone ? '' : join(dir, manifest.media.video!);
  const call = manifest.source.call;
  // Words first: when the recording app sent its narration ahead of the video and the video has not
  // arrived, the narration is transcribed, marked and summarised and a storyboard written without
  // frames, while probe, frames and pointing wait, pending, for the video. Once the video is here
  // everything comes from it, as for any other recording.
  const narrationFile = manifest.media.narration ? join(dir, manifest.media.narration) : undefined;
  const early = narrationFile !== undefined && !alone && !await exists(video) && await exists(narrationFile);
  const work = join(config.work, manifest.id);
  await privateDir(work);
  // Steps an earlier step redid in this run, and so redone too: new frames need new names and a new storyboard.
  const redo = new Set<StepName>();
  const shouldRun = (name: StepName) => redo.has(name) || (options.only ? options.only === name : (options.force || manifest.steps[name].status === 'pending'));
  const record = async (name: StepName, status: SessionManifest['steps'][StepName]['status'], extra: { note?: string; error?: string } = {}) => {
    manifest = { ...manifest, steps: { ...manifest.steps, [name]: { status, at: now(), ...extra } } };
    await saveSession(dir, manifest);
    log(`${manifest.id} ${name}: ${status}${extra.note ? ` (${extra.note})` : ''}${extra.error ? ` ${extra.error}` : ''}`);
  };

  if (early) {
    // The narration's length stands in for the recording's until the video is probed.
    if (manifest.media.durationMs === undefined) {
      try {
        const info = await probe(config.ffprobe, narrationFile);
        manifest = { ...manifest, media: { ...manifest.media, durationMs: info.durationMs } };
        await saveSession(dir, manifest);
      } catch (error) { log(`${manifest.id}: the narration could not be read (${message(error)}); the words wait for the video`); return manifest; }
    }
  } else if (alone) {
    if (shouldRun('probe')) await record('probe', 'skipped', { note: 'logs alone: no picture or sound to probe; the take\'s length is the one the headset sent' });
  } else if (shouldRun('probe')) {
    try {
      const info = await probe(config.ffprobe, video);
      // Where the picture ends, which in a Mac recording is often before the sound does.
      const videoEndMs = info.hasVideo ? await probeVideoEnd(config.ffprobe, video) : undefined;
      const { videoEndMs: _stale, ...media } = manifest.media;
      manifest = { ...manifest, media: { ...media, durationMs: info.durationMs, width: info.width, height: info.height, hasAudio: info.hasAudio, hasVideo: info.hasVideo, container: info.container, audioChannels: info.audioChannels, ...(videoEndMs !== undefined ? { videoEndMs } : {}) } };
      // A description that does not fit the file is said, not trusted: the tracks are then read as unknown.
      const told = manifest.source.audioTracks;
      const mismatch = told && told.length !== info.audioChannels.length ? `source.audioTracks names ${told.length} tracks but the file has ${info.audioChannels.length} audio tracks, so which is which is not known` : undefined;
      await record('probe', 'done', mismatch ? { note: mismatch } : {});
    } catch (error) { await record('probe', 'failed', { error: message(error) }); return manifest; }
  }
  const durationMs = manifest.media.durationMs;
  if (!durationMs || (!early && !alone && manifest.steps.probe.status !== 'done')) { log(`${manifest.id}: probe has not succeeded; nothing else can run`); return manifest; }

  // The headset's log on the take's clock. With words first it waits for the video, whose length is the take's.
  if (shouldRun('logs') && !early) {
    if (!manifest.media.logs || !manifest.source.logs) await record('logs', 'skipped', { note: 'no logs were sent with this take' });
    else {
      try {
        const file = await writeLogs(paths, manifest.id, manifest.source.logs, durationMs);
        await record('logs', 'done', { note: logsNote(file) });
        redo.add('storyboard');
      } catch (error) { await record('logs', 'failed', { error: message(error) }); }
    }
  }

  // Whose voice the transcript will be, from which track: the mic when there is one, never the app's
  // voice-over taken for narration; for a call, the mic and the call's sound apart. The narration sent
  // ahead of the video is the mic alone.
  const plan: { file: string; voice: NonNullable<SessionManifest['media']['voice']>; tracks: VoiceTrack[]; silentApp?: number } = early ? { file: narrationFile, voice: 'mic', tracks: [{ index: 0, name: 'audio' }] } : { file: video, ...voiceTracks(manifest) };
  // The narration was cut out of the video with -c copy, keeping the mic's offset in it as its start (audio.ts).
  const extract = (track: VoiceTrack, wav: string) => extractAudio(config.ffmpeg, plan.file, wav, track.index, { copyts: early });
  const wavs = plan.tracks.map(track => ({ track, wav: join(work, `${track.name}.wav`), prefix: join(work, track.name === 'audio' ? 'whisper' : `whisper-${track.name}`) }));
  if (shouldRun('audio')) {
    if (alone) await record('audio', 'skipped', { note: 'logs alone: no sound' });
    else if (!early && !manifest.media.hasAudio) await record('audio', 'skipped', { note: 'no audio track' });
    else {
      try {
        for (const { track, wav } of wavs) await extract(track, wav);
        manifest = { ...manifest, media: { ...manifest.media, voice: plan.voice } };
        await record('audio', 'done', { note: audioNote(plan.tracks, plan.voice, early, call !== undefined, plan.silentApp) });
      } catch (error) { await record('audio', 'failed', { error: message(error) }); }
    }
  }
  const voice = manifest.media.voice;

  let segments: TranscriptSegment[] = [], droppedBleed: number | undefined;
  if (shouldRun('transcribe')) {
    const transcriber = createTranscriber(config);
    if (transcriber.kind === 'none') await record('transcribe', 'skipped', { note: 'transcriber is none' });
    else if (manifest.steps.audio.status !== 'done') await record('transcribe', 'skipped', { note: `audio step is ${manifest.steps.audio.status}` });
    else {
      try {
        // The wavs are removed once a session is complete, so redoing only this step makes them again.
        for (const { track, wav } of wavs) if (!await exists(wav)) await extract(track, wav);
        const { transcript, segments: lines, bleedDropped, note } = await transcribeTracks(transcriber, config.ffmpeg, wavs);
        // Sentence-sized lines, so every request has its own clock; frames and markers follow the lines.
        segments = lines; droppedBleed = bleedDropped;
        await writeJsonAtomic(paths.transcriptJson, transcriptFileSchema.parse({ version: 1, engine: transcript.engine, model: transcript.model, language: transcript.language, voice, bleedDropped, segments }));
        await writeFile(paths.transcriptMd, transcriptMarkdown(manifest.id, { ...transcript, segments }, durationMs, voice), { mode: 0o600 });
        manifest = { ...manifest, transcriber: { kind: transcript.engine, model: transcript.model, language: transcript.language } };
        await record('transcribe', 'done', { note });
        // A new transcript has no names: who of the Others said each line is decided again.
        redo.add('speakers');
        for (const { wav } of wavs) await rm(wav, { force: true });
      } catch (error) { await record('transcribe', 'failed', { error: message(error) }); }
    }
  } else if (manifest.steps.transcribe.status === 'done') {
    ({ segments, bleedDropped: droppedBleed } = await readJson(paths.transcriptJson, transcriptFileSchema));
  }

  // A recording of sound alone (a call whose screen was not recorded) is finished without frames; it
  // is not waiting for a video the way words first is.
  const screenless = early ? undefined : screenMissing(manifest);

  if (shouldRun('speakers') && !early) {
    // Who of the Others said each line, from Meet's speaking ring, read on this Mac (speakers.ts).
    const theirs = segments.filter(s => s.speaker !== undefined && s.speaker !== 'me');
    const reason = !call ? 'not a call'
      : call.app !== 'meet' ? `the speaking ring is read for Meet calls, not ${call.app}`
        : screenless ? `no picture: ${screenless}`
          : config.speakers === 'none' ? 'POLYCAP_SPEAKERS is none'
            : manifest.steps.transcribe.status !== 'done' ? `transcribe step is ${manifest.steps.transcribe.status}`
              : !theirs.length ? 'no lines of Others to name'
                : !await exists(config.speakersBin) ? `the speaker reader is not built at ${config.speakersBin}: npm run mac -- speakers`
                  : undefined;
    const before = JSON.stringify(segments.map(s => s.name ?? null));
    // The transcript's files, rewritten with these lines' names (or without any).
    const rewrite = async (lines: TranscriptSegment[]) => {
      const file = await readJson(paths.transcriptJson, transcriptFileSchema);
      await writeJsonAtomic(paths.transcriptJson, transcriptFileSchema.parse({ ...file, segments: lines }));
      await writeFile(paths.transcriptMd, transcriptMarkdown(manifest.id, { engine: file.engine, language: file.language, segments: lines }, durationMs, voice), { mode: 0o600 });
      segments = lines;
    };
    const unnamed = () => segments.map(({ name: _name, ...line }) => line);
    try {
      if (reason) {
        if (segments.some(s => s.name)) await rewrite(unnamed());
        await rm(paths.speakers, { force: true });
        await record('speakers', 'skipped', { note: reason });
      } else {
        const out = join(work, 'speakers-reader.json');
        // An hour's call took about 50 s on this Mac (35 s for 44 min, 2026-11-11); the timeout is generous.
        await exec(config.speakersBin, [video, '--out', out], { timeoutMs: 30 * 60_000 });
        const named = nameSpeakers(segments, await readJson(out, toolReportSchema));
        await rm(out, { force: true });
        await writeJsonAtomic(paths.speakers, speakersFileSchema.parse(named.file));
        await rewrite(named.segments);
        await record('speakers', named.trusted ? 'done' : 'failed', named.trusted ? { note: named.note } : { error: named.note });
      }
    } catch (error) {
      if (segments.some(s => s.name)) await rewrite(unnamed()).catch(() => {});
      await record('speakers', 'failed', { error: message(error) });
    }
    // New names make a new summary and storyboard.
    if (JSON.stringify(segments.map(s => s.name ?? null)) !== before) { redo.add('summary'); redo.add('storyboard'); }
  }

  const marks = manifest.source.marks ?? [];
  if (shouldRun('frames') && !early) {
    // New frames need what was pointed at named again, and a storyboard that shows them.
    redo.add('pointing'); redo.add('storyboard');
    try {
      await rm(paths.frames, { recursive: true, force: true });
      await rm(paths.framesJson, { force: true });
      await rm(paths.pointing, { force: true });
      if (screenless) {
        await rm(paths.contactSheet, { force: true });
        manifest = { ...manifest, frameCount: 0 };
        await record('frames', 'skipped', { note: `${screenless}, so there are no frames` });
      } else {
        // Frames are planned over the picture, which can end before the sound (probe.ts): a bundle
        // probed before 2026-11-05 has its picture's end read now.
        if (manifest.media.videoEndMs === undefined) {
          const videoEndMs = await probeVideoEnd(config.ffprobe, video);
          if (videoEndMs !== undefined) manifest = { ...manifest, media: { ...manifest.media, videoEndMs } };
        }
        const videoEndMs = manifest.media.videoEndMs;
        const span = frameSpanMs(durationMs, videoEndMs);
        // Where the screen changed: for calls by default (POLYCAP_SCENES), as a failure does not cost the other frames.
        let scenes: number[] = [], sceneNote = '';
        if (config.scenes === 'all' || (config.scenes === 'calls' && call)) {
          try { scenes = collapseScenes(await detectScenes(config.ffmpeg, video, config.sceneThreshold), { durationMs: span }); }
          catch (error) { sceneNote = `; scene detection failed: ${message(error).split('\n')[0].slice(0, 160)}`; }
        }
        // "This" in the app's voice-over is not the user pointing at anything; in a call either voice can point.
        const pointing = call !== undefined || voice !== 'app';
        // Where the screen capture stopped mid-call (C14) the file is black: frames go either side of it.
        const gaps = call?.videoGaps ?? [];
        const base = planFrames(span, segments, { maxFrames: config.maxFrames, intervalMs: config.intervalMs, pointing, gaps });
        const planned = addPriorityFrames(base, { durationMs: span, scenes, marks: marks.map(m => m.atMs), maxScenes: config.maxScenes, gaps });
        // Full-resolution copies where something is marked, the screen changed, or the narrator points or shows something to copy.
        const references = pointing ? segments.filter(s => REFERENCE_CUE.test(s.text)) : [];
        const fullReasons = new Set(['pointing', 'scene', 'mark']);
        const full = { width: Math.min(1920, manifest.media.width ?? 1920), wants: (entry: { atMs: number; reason: string }) => fullReasons.has(entry.reason) || references.some(s => entry.atMs >= s.startMs && entry.atMs <= s.endMs) };
        const { frames, failures } = await extractFrames(config.ffmpeg, video, paths.frames, planned, config.frameWidth, full);
        await writeJsonAtomic(paths.framesJson, { version: 1, width: config.frameWidth, frames });
        const sheet = await contactSheet(config.ffmpeg, paths.frames, paths.contactSheet, frames);
        manifest = { ...manifest, frameCount: frames.length };
        const reasons = (reason: string) => frames.filter(f => f.reason === reason).length;
        const fullCount = frames.filter(f => f.full).length, silent = reasons('interval');
        const priority = [reasons('scene') ? `${reasons('scene')} at scene changes` : '', reasons('mark') ? `${reasons('mark')} at marks` : ''].filter(Boolean).join(', ');
        // The picture ending well before the sound (the screen capture stopped mid-call) is said, as are
        // the marks it cannot show; under 2 s is a still screen's last repeated frame, not worth a word.
        const ended = videoEndMs !== undefined && durationMs - span > 2000;
        const lateMarks = ended ? marks.filter(m => m.atMs > videoEndMs).length : 0;
        const gapMarks = marks.filter(m => inVideoGap(m.atMs, gaps) && !(ended && m.atMs > videoEndMs)).length;
        const picture = [
          ended ? `the picture ends at ${formatClock(videoEndMs)}; no frames after it` : '',
          lateMarks ? `${count(lateMarks, 'mark')} after the screen stopped, shown by the last picture` : '',
          gaps.length ? `no picture ${gapsText(gaps)}; no frames there` : '',
          gapMarks ? `${count(gapMarks, 'mark')} while there was no picture, shown by the picture before` : '',
          grabFailureNote(failures) ?? '',
        ].filter(Boolean).map(text => `; ${text}`).join('');
        await record('frames', 'done', { note: `${frames.length} frames${fullCount ? ` (${fullCount} also full size)` : ''}, ${segments.length ? `from transcript${silent ? `, ${silent} in silence` : ''}` : 'at interval'}${priority ? `, ${priority}` : ''}${picture}${sceneNote}${sheet.note ? `; ${sheet.note}` : ''}` });
      }
    } catch (error) { await record('frames', 'failed', { error: message(error) }); }
  }

  if (shouldRun('pointing') && !early) {
    const framesNow = await exists(paths.framesJson) ? (await readJson(paths.framesJson, framesFileSchema)).frames : [];
    const pointingFrames = framesNow.filter(f => f.reason === 'pointing');
    if (screenless) await record('pointing', 'skipped', { note: `no frames: ${screenless}` });
    else if (config.pointing === 'none') await record('pointing', 'skipped', { note: 'POLYCAP_POINTING is none' });
    // The pass names what a headset's controller ray or hand points at; a call's screen has neither.
    else if (call) await record('pointing', 'skipped', { note: 'a call has no headset ray or hand to name; its pointing frames are kept' });
    else if (!pointingFrames.length) await record('pointing', 'skipped', { note: 'no pointing frames' });
    else {
      try {
        const { resolvePointing } = await import('./pointing.js');
        const named = await resolvePointing(config, dir, pointingFrames, segments);
        await writeJsonAtomic(paths.pointing, { version: 1, model: named.model, frames: named.frames });
        await record('pointing', 'done', { note: `${named.model}; ${named.frames.length} of ${pointingFrames.length} pointing frames named` });
      } catch (error) { await record('pointing', 'failed', { error: message(error) }); }
    }
  }

  if (shouldRun('markers')) {
    // Markers are the user's spoken cues; the app's own voice-over has none to give, and in a call only
    // Me's deliberate cues count. Marks pressed with the shortcut are markers whoever was speaking.
    const spoken = call ? findMarkers(segments.filter(s => !s.speaker || s.speaker === 'me'), CALL_CUES) : voice === 'app' ? [] : findMarkers(segments);
    const marked = markMarkers(marks, segments, durationMs);
    const markers = [...spoken, ...marked].sort((a, b) => a.atMs - b.atMs);
    await writeJsonAtomic(paths.markers, { version: 1, markers });
    manifest = { ...manifest, markerCount: markers.length };
    const fromMarks = marked.length ? ` (${marked.length} from marks)` : '';
    if (!call && voice === 'app' && !marked.length) await record('markers', 'skipped', { note: "the transcript is the app's own sound, not the user" });
    else if (!segments.length && !marked.length) await record('markers', 'skipped', { note: 'no transcript' });
    else await record('markers', 'done', { note: `${markers.length} markers${fromMarks}${call ? "; spoken cues from Me's lines only" : ''}` });
  }

  if (shouldRun('summary')) {
    if (config.summarizer === 'none') await record('summary', 'skipped', { note: 'summarizer is none' });
    else if (!segments.length) await record('summary', 'skipped', { note: 'no transcript' });
    else {
      try {
        // Loaded only when used: the SDK adds about 0.1 s to every command otherwise.
        const { summarize } = await import('./summary.js');
        const { summary, requests, rejected, moved, cutOff } = await summarize(config, segments, voice, manifest.source.thread, call ? { call, durationMs } : undefined);
        await writeJsonAtomic(paths.requests, requestsFileSchema.parse({ version: 2, model: summary.model, requests, rejected }));
        manifest = { ...manifest, title: summary.title, summary };
        const checked = `${moved ? `, ${moved} moved to the line their quote is on` : ''}${rejected.length ? `, ${rejected.length} left out (see rejected in requests.json)` : ''}`;
        const cut = cutOff ? `; ${cutOff}` : '';
        await record('summary', 'done', { note: `${summary.model}; ${requests.length} requests${checked}${cut}` });
      } catch (error) { await record('summary', 'failed', { error: message(error) }); }
    }
  }

  if (shouldRun('storyboard')) {
    try {
      const frames = await exists(paths.framesJson) ? (await readJson(paths.framesJson, framesFileSchema)).frames : [];
      const markers = await exists(paths.markers) ? (await readJson(paths.markers, markersFileSchema)).markers : [];
      const requestsFile = await exists(paths.requests) ? await readJson(paths.requests, requestsFileSchema) : undefined;
      const requests = requestsFile?.requests ?? [], rejectedRequests = requestsFile?.version === 2 ? requestsFile.rejected.length : 0;
      const pointing = await exists(paths.pointing) ? (await readJson(paths.pointing, pointingFileSchema)).frames : [];
      const previous = previousSession(await listSessions(config), manifest)?.manifest;
      const logs = manifest.steps.logs.status === 'done' && await exists(paths.logsJson) ? await readJson(paths.logsJson, logsFileSchema) : undefined;
      await writeFile(paths.storyboard, storyboardMarkdown({ manifest, segments, frames, markers, requests, rejectedRequests, previous, pointing, droppedBleed, logs }), { mode: 0o600 });
      await record('storyboard', 'done', { note: `${segments.length} lines, ${frames.length} frames, ${requests.length} requests` });
    } catch (error) { await record('storyboard', 'failed', { error: message(error) }); }
  }

  if (STEP_NAMES.every(name => manifest.steps[name].status !== 'pending')) await rm(work, { recursive: true, force: true });
  return manifest;
}
