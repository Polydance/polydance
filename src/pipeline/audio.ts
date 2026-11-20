import { exec } from '../exec.js';
import type { AudioRole, SessionManifest, Voice } from '../session.js';
import type { Speaker } from './voices.js';

/** Polydance's headset app under its current and its first app id, and the Mac app, which records the same way. */
const CAPTURE_APPS = new Set(['net.polydance.capture', 'dev.headsetinbox.captureprobe', 'net.polydance.capture.mac']);

/**
 * What each audio track is: as the transport recorded it (source.audioTracks), or, for Polydance
 * Capture recordings made before the app said (2026-10-02), from the track's shape, since it records
 * the mic in mono and its own sound in stereo. Anything else is unknown.
 */
export function audioRoles(manifest: Pick<SessionManifest, 'source'>, streams: readonly { channels: number }[]): (AudioRole | undefined)[] {
  const told = manifest.source.audioTracks;
  if (told && told.length === streams.length) return [...told];
  if (manifest.source.appPackage && CAPTURE_APPS.has(manifest.source.appPackage)) {
    return streams.map(s => s.channels === 1 ? 'mic' : s.channels === 2 ? 'app' : undefined);
  }
  return streams.map(() => undefined);
}

/**
 * The track to transcribe and whose voice it is: the microphone when there is one; the app's own sound
 * when that is all there is, so its voice-over is never taken for the user's narration (a review of a
 * music lesson recorded with the mic off read the lesson's "you've got a great sense of rhythm" as
 * the user's praise, 2026-10-02); otherwise the first track, voice unknown.
 */
export function narrationTrack(manifest: Pick<SessionManifest, 'source' | 'media'>): { index: number; voice: Voice } {
  const channels = manifest.media.audioChannels ?? manifest.source.audioTracks?.map(() => 1) ?? [];
  const roles = audioRoles(manifest, channels.map(c => ({ channels: c })));
  const mic = roles.indexOf('mic');
  if (mic >= 0) return { index: mic, voice: 'mic' };
  if (roles.length && roles.every(role => role === 'app')) return { index: 0, voice: 'app' };
  return { index: 0, voice: 'unknown' };
}

/** One audio track to transcribe: its index among the audio tracks, a name for its wav, and for a call whose voice it is. */
export interface VoiceTrack { index: number; name: string; speaker?: Speaker }

/**
 * The tracks to transcribe and whose voice the transcript is. A call (source.call) with both a mic and
 * an app track has both transcribed, the mic as Me and the app track as Others (voice `both`); a call
 * with only one of them has that one, still labelled. A call whose recorder heard digital silence from
 * the call app (call.farEnd `silent`) has its mic alone, with `silentApp` naming the track left out: an
 * hour of known silence costs whisper minutes and can only give it lines to invent, which would then be
 * labelled Others under a header saying Others' words are missing. Anything else is one track as
 * narrationTrack picks it, unlabelled: in a headset recording the app track is the game's sound.
 */
export function voiceTracks(manifest: Pick<SessionManifest, 'source' | 'media'>): { voice: Voice; tracks: VoiceTrack[]; silentApp?: number } {
  if (manifest.source.call) {
    const channels = manifest.media.audioChannels ?? manifest.source.audioTracks?.map(() => 1) ?? [];
    const roles = audioRoles(manifest, channels.map(c => ({ channels: c })));
    const mic = roles.indexOf('mic'), app = roles.indexOf('app');
    if (mic >= 0 && app >= 0 && manifest.source.call.farEnd === 'silent') return { voice: 'mic', tracks: [{ index: mic, name: 'mic', speaker: 'me' }], silentApp: app };
    if (mic >= 0 && app >= 0) return { voice: 'both', tracks: [{ index: mic, name: 'mic', speaker: 'me' }, { index: app, name: 'app', speaker: 'others' }] };
    if (mic >= 0) return { voice: 'mic', tracks: [{ index: mic, name: 'mic', speaker: 'me' }] };
    if (app >= 0) return { voice: 'app', tracks: [{ index: app, name: 'app', speaker: 'others' }] };
  }
  const { index, voice } = narrationTrack(manifest);
  return { voice, tracks: [{ index, name: 'audio' }] };
}

/**
 * Each wav on the file's clock: a track that starts after the file does (AVAssetWriter's empty edit,
 * when the Mac's mic starts after the call's sound, or after a permission prompt) is padded with
 * silence in front, and a gap inside a track (a dropped buffer) is filled, so whisper's offsets are
 * the file's offsets, as marks, scenes and frame seeks are. A wav has no timestamps, so without this
 * the lead was lost: a mic starting 2 s late gave a wav 2 s short and every Me line 2 s early
 * (measured with ffmpeg 8.0, 2026-11-05). min_hard_comp is the 0.1 s default, said so that AAC's
 * jitter is never "corrected"; an aligned file comes out the same length as before.
 */
const ON_FILE_CLOCK = 'aresample=async=1:min_hard_comp=0.1:first_pts=0';

/**
 * 16 kHz mono PCM, which is what whisper expects, from the given audio track (0-based). Left to itself
 * ffmpeg would pick the track with the most channels, which is the stereo game audio. `copyts` keeps
 * the input's own timestamps instead of counting from its first one: for a narration cut out of the
 * video with `-c copy` (upload.ts), whose start is the mic track's offset in the video, so that offset
 * is padded too. The video itself is read without it, on the clock `ffmpeg -ss` seeks on.
 */
export async function extractAudio(ffmpeg: string, video: string, wav: string, track = 0, options: { copyts?: boolean } = {}): Promise<void> {
  await exec(ffmpeg, ['-y', '-v', 'error', ...(options.copyts ? ['-copyts'] : []), '-i', video, '-map', `0:a:${track}`, '-vn', '-af', ON_FILE_CLOCK, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 15 * 60_000 });
}
