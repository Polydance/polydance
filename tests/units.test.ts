import { describe, expect, it } from 'vitest';
import { parseDevices, parseStatLines, shellQuote } from '../src/adb.js';
import { legacySetup, loadConfig } from '../src/config.js';
import { audioRoles, pickAudio, planMedia, rangeOf, transcriptExport } from '../src/commands/export.js';
import { profileFor } from '../src/devices.js';
import { appSlug, parseRecordingName } from '../src/filename.js';
import { ledgerKey } from '../src/ledger.js';
import { planFrames, frameFileName } from '../src/pipeline/frames.js';
import { findMarkers } from '../src/pipeline/markers.js';
import { cleanSummary } from '../src/pipeline/summary.js';
import { appTimeline, storyboardMarkdown } from '../src/pipeline/storyboard.js';
import { parseWhisperJson, splitLongSegments, transcriptMarkdown, voiceNote, type TranscriptWord } from '../src/pipeline/transcribe.js';
import { narrationTrack } from '../src/pipeline/audio.js';
import { contactSheetFilter } from '../src/pipeline/frames.js';
import { isPending, previousSession, sessionSchema, type SessionManifest } from '../src/session.js';
import { formatClock, frameStamp, localStamp, parseClock } from '../src/time.js';
import { allowanceFor } from '../src/server/storage.js';
import type { Grant } from '../src/server/tokens.js';
import { readFileSync } from 'node:fs';

describe('recording file names', () => {
  it('reads the Quest package and local timestamp', () => {
    const parsed = parseRecordingName('com.oculus.vrshell-20261001-142205.mp4');
    expect(parsed.appPackage).toBe('com.oculus.vrshell');
    expect(parsed.recordedAt).toEqual(new Date(2026, 9, 1, 14, 22, 5));
  });
  it('reads a stock Android recorder name without a package', () => {
    const parsed = parseRecordingName('Screen recording 20261001-142205.mp4');
    expect(parsed.appPackage).toBeUndefined();
    expect(parsed.recordedAt).toEqual(new Date(2026, 9, 1, 14, 22, 5));
  });
  it('rejects impossible dates and unparseable names', () => {
    expect(parseRecordingName('x-20261399-990000.mp4').recordedAt).toBeUndefined();
    expect(parseRecordingName('clip.mp4')).toEqual({});
  });
  it('slugs the last package segment', () => {
    expect(appSlug('marimba.marimba')).toBe('marimba');
    expect(appSlug('com.oculus.vrshell')).toBe('vrshell');
    expect(appSlug(undefined)).toBe('recording');
  });
});

describe('time', () => {
  it('formats and parses clocks both ways', () => {
    expect(formatClock(83_000)).toBe('01:23');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(frameStamp(83_400)).toBe('01m23s');
    expect(parseClock('1:23')).toBe(83_000);
    expect(parseClock('1:02:03')).toBe(3_723_000);
    expect(parseClock('83')).toBe(83_000);
    expect(parseClock('1m23s')).toBe(83_000);
    expect(parseClock('0:05.250')).toBe(5_250);
    expect(() => parseClock('later')).toThrow(/Cannot read time/);
    expect(localStamp(new Date(2026, 9, 1, 14, 22, 5))).toBe('2026-10-01T14-22-05');
  });
});

describe('adb parsing', () => {
  it('parses devices -l', () => {
    const out = 'List of devices attached\n192.168.1.104:41735    device product:axros model:Android_XR_Puck device:axrpuck transport_id:1\nABC123\toffline\n\n';
    expect(parseDevices(out)).toEqual([
      { serial: '192.168.1.104:41735', state: 'device', model: 'Android_XR_Puck', product: 'axros', device: 'axrpuck' },
      { serial: 'ABC123', state: 'offline', model: undefined, product: undefined, device: undefined },
    ]);
  });
  it('parses stat lines including paths with spaces and ignores noise', () => {
    const out = "12345 1789085460 /sdcard/Oculus/VideoShots/com.oculus.vrshell-20261001-142205.mp4\r\n99 1789085466 /sdcard/DCIM/Screen recordings/clip one.mp4\nstat: cannot stat '/x/*.webm': No such file or directory\n";
    expect(parseStatLines(out)).toEqual([
      { bytes: 12345, mtimeMs: 1789085460000, path: '/sdcard/Oculus/VideoShots/com.oculus.vrshell-20261001-142205.mp4', name: 'com.oculus.vrshell-20261001-142205.mp4' },
      { bytes: 99, mtimeMs: 1789085466000, path: '/sdcard/DCIM/Screen recordings/clip one.mp4', name: 'clip one.mp4' },
    ]);
  });
  it('quotes for the device shell', () => {
    expect(shellQuote('/sdcard/DCIM/Screen recordings')).toBe("'/sdcard/DCIM/Screen recordings'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it('keys the ledger on identity as observed', () => {
    expect(ledgerKey('S', '/p/a.mp4', 1, 2)).toBe('S|/p/a.mp4|1|2');
  });
});

describe('device profiles', () => {
  it('recognises a Quest and the Android XR puck', () => {
    expect(profileFor({ 'ro.product.manufacturer': 'Oculus', 'ro.product.model': 'Quest 3' })).toMatchObject({ id: 'quest', confirmed: true, folders: ['/sdcard/Oculus/VideoShots'] });
    expect(profileFor({ 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Android XR Puck' })).toMatchObject({ id: 'android-xr', confirmed: false });
    expect(profileFor({})).toMatchObject({ id: 'android', confirmed: false });
    for (const model of ['Android_XR_Puck', 'XREAL_AURA', 'XREAL AURA', 'aura']) {
      expect(profileFor({ 'ro.product.manufacturer': 'XREAL', 'ro.product.model': model })).toMatchObject({ id: 'android-xr', confirmed: false });
    }
    expect(profileFor({ 'ro.product.manufacturer': 'XREAL', 'ro.product.model': 'Air 2' }).id).toBe('android');
    expect(profileFor({ 'ro.product.model': 'aura' }).id).toBe('android');
  });
});

describe('config', () => {
  it('defaults everything and validates integers', () => {
    const config = loadConfig({ POLYCAP_ROOT: '/tmp/x' });
    expect(config.sessions).toBe('/tmp/x/sessions');
    expect(config.transcriber).toBe('whisper-cpp');
    expect(config.maxFrames).toBe(80);
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_DEVICE_FOLDERS: '/a, /b/c' }).deviceFolders).toEqual(['/a', '/b/c']);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_MAX_FRAMES: '1' })).toThrow(/POLYCAP_MAX_FRAMES/);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_TRANSCRIBER: 'cloud' })).toThrow(/POLYCAP_TRANSCRIBER/);
  });

  it('keeps summaries off unless asked, and then needs a key, a Claude model and a safe URL', () => {
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x', ANTHROPIC_API_KEY: 'sk-ant-x' }).summarizer).toBe('none');
    const on = loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(on).toMatchObject({ summarizer: 'claude', summaryModel: 'claude-haiku-4-5', anthropicUrl: 'https://api.anthropic.com' });
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SUMMARIZER: 'claude' })).toThrow(/needs ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SUMMARIZER: 'gpt' })).toThrow(/POLYCAP_SUMMARIZER/);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SUMMARY_MODEL: 'haiku; rm -rf' })).toThrow(/POLYCAP_SUMMARY_MODEL/);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_ANTHROPIC_URL: 'http://api.example.com' })).toThrow(/POLYCAP_ANTHROPIC_URL/);
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_ANTHROPIC_URL: 'http://127.0.0.1:4010/' }).anthropicUrl).toBe('http://127.0.0.1:4010');
  });
});

describe('whose voice the transcript is', () => {
  const m = (source: object, media: object = {}) => ({ source: { kind: 'upload' as const, originalName: 'a.mp4', bytes: 1, sha256: 'a'.repeat(64), ...source }, media: { video: 'video.mp4', ...media } });
  it('transcribes the mic when there is one, and calls an app-only track the app\'s voice', () => {
    expect(narrationTrack(m({ audioTracks: ['mic', 'app'] }, { audioChannels: [1, 2] }))).toEqual({ index: 0, voice: 'mic' });
    expect(narrationTrack(m({ audioTracks: ['app', 'mic'] }, { audioChannels: [2, 1] }))).toEqual({ index: 1, voice: 'mic' });
    expect(narrationTrack(m({ audioTracks: ['app'] }))).toEqual({ index: 0, voice: 'app' });
    expect(narrationTrack(m({ appPackage: 'net.polydance.capture' }, { audioChannels: [2] }))).toEqual({ index: 0, voice: 'app' });
    expect(narrationTrack(m({ appPackage: 'com.oculus.vrshell' }, { audioChannels: [2] }))).toEqual({ index: 0, voice: 'unknown' });
  });
  it('warns in the transcript when the words are not the narrator\'s', () => {
    expect(transcriptMarkdown('s', { engine: 'gladia', segments: [{ startMs: 0, endMs: 1000, text: 'Great sense of rhythm!' }] }, 1000, 'app')).toContain("**Voice: the app's own sound.** No microphone was recorded");
    expect(voiceNote('mic')).toBeUndefined();
  });
});

describe('export', () => {
  const capture = { source: { kind: 'upload' as const, originalName: 'a.mp4', bytes: 1, sha256: 'a'.repeat(64), appPackage: 'net.polydance.capture' } };
  it('knows which track is the mic and which the app, as told, or from Polydance\'s mono and stereo', () => {
    expect(audioRoles({ source: { ...capture.source, audioTracks: ['app'] } }, [{ channels: 2 }])).toEqual(['app']);
    expect(audioRoles(capture, [{ channels: 1 }, { channels: 2 }])).toEqual(['mic', 'app']);
    expect(audioRoles({ source: { ...capture.source, appPackage: 'dev.headsetinbox.captureprobe' } }, [{ channels: 2 }])).toEqual(['app']);
    expect(audioRoles({ source: { ...capture.source, appPackage: 'com.oculus.vrshell' } }, [{ channels: 2 }])).toEqual([undefined]);
  });

  it('picks tracks by name or number, and says why it cannot', () => {
    expect(pickAudio('app', ['mic', 'app'])).toEqual([1]);
    expect(pickAudio('both', ['mic', 'app'])).toEqual([0, 1]);
    expect(pickAudio('2', [undefined, undefined])).toEqual([1]);
    expect(pickAudio('none', ['mic'])).toEqual([]);
    expect(() => pickAudio('app', ['mic'])).toThrow(/no app track \(it has mic\)/);
    expect(() => pickAudio('mic', [undefined, undefined])).toThrow(/does not say which of its 2 audio track\(s\) is the mic; pick one by number with --sound 1 to 2/);
    expect(() => pickAudio('3', ['mic', 'app'])).toThrow(/has 2 audio track/);
    expect(() => pickAudio('music', ['mic'])).toThrow(/--sound must be/);
  });

  it('copies without a range and re-encodes for an exact cut, mixing into one track when asked', () => {
    expect(planMedia('video', [1], false, undefined, 'in.mp4', 'out.mp4')).toEqual(['-y', '-v', 'error', '-i', 'in.mp4', '-map', '0:v:0', '-map', '0:a:1', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', 'out.mp4']);
    const cut = planMedia('audio', [0], false, { fromMs: 60_000, toMs: 90_500 }, 'in.mp4', 'out.m4a');
    expect(cut.slice(0, 9)).toEqual(['-y', '-v', 'error', '-ss', '60.000', '-i', 'in.mp4', '-t', '30.500']);
    expect(cut).toContain('-vn');
    expect(cut.join(' ')).toContain('-c:a aac');
    const mixed = planMedia('video', [0, 1], true, undefined, 'in.mp4', 'out.mp4').join(' ');
    expect(mixed).toContain('[0:a:0]aformat=channel_layouts=stereo[a0];[0:a:1]aformat=channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:normalize=0[mixed]');
    expect(mixed).toContain('-c:v copy');
    expect(() => planMedia('audio', [], false, undefined, 'in.mp4', 'out.m4a')).toThrow(/needs sound/);
  });

  it('writes subtitles timed from the start of the range, and keeps the recording\'s clocks elsewhere', () => {
    const segments = [{ startMs: 5_000, endMs: 8_000, text: 'Before.' }, { startMs: 61_500, endMs: 64_250, text: 'Keep the dials.' }, { startMs: 95_000, endMs: 99_000, text: 'After.' }];
    const range = { fromMs: 60_000, toMs: 90_000 };
    expect(transcriptExport('s', segments, 'srt', range)).toBe('1\n00:00:01,500 --> 00:00:04,250\nKeep the dials.\n');
    expect(transcriptExport('s', segments, 'vtt', range)).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:04.250\nKeep the dials.\n');
    expect(transcriptExport('s', segments, 'md', range)).toBe('# Transcript: s (01:00 to 01:30)\n\n[01:01] Keep the dials.\n');
    expect(transcriptExport('s', segments, 'txt')).toBe('Before.\nKeep the dials.\nAfter.\n');
  });

  it('reads a range, clamps it to the recording and refuses one that is backwards or past the end', () => {
    expect(rangeOf({}, 10_000)).toBeUndefined();
    expect(rangeOf({ from: '0:02', to: '9:00' }, 10_000)).toEqual({ fromMs: 2000, toMs: 10_000 });
    expect(() => rangeOf({ from: '0:05', to: '0:04' }, 10_000)).toThrow(/after --from/);
    expect(() => rangeOf({ from: '0:20' }, 10_000)).toThrow(/past the end/);
    expect(() => rangeOf({ from: 'soon' }, 10_000)).toThrow(/--from/);
  });
});

describe('pointing setting', () => {
  it('is off unless asked for, and needs a key when it is on', () => {
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x' }).pointing).toBe('none');
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_POINTING: 'claude' })).toThrow(/needs ANTHROPIC_API_KEY/);
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_POINTING: 'claude', ANTHROPIC_API_KEY: 'k' })).toMatchObject({ pointing: 'claude', pointingModel: 'claude-haiku-4-5' });
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_POINTING: 'yes' })).toThrow(/not claude or none/);
  });
});

describe('a setup from before the rename', () => {
  const files = (...present: string[]) => (path: string) => present.includes(path);
  it('names old settings, the old settings file and the old library, and is quiet once moved', () => {
    expect(legacySetup({ HINBOX_REMOTE_URL: 'x' }, '/h', files())).toMatch(/HINBOX_REMOTE_URL: settings were renamed from HINBOX_\* to POLYCAP_\*/);
    expect(legacySetup({}, '/h', files('/h/.config/hinbox/env'))).toMatch(/mv ~\/.config\/hinbox ~\/.config\/polycap/);
    expect(legacySetup({}, '/h', files('/h/HeadsetInbox'))).toMatch(/mv ~\/HeadsetInbox ~\/PolydanceCapture/);
    expect(legacySetup({}, '/h', files('/h/HeadsetInbox', '/h/PolydanceCapture', '/h/.config/polycap/env', '/h/.config/hinbox/env'))).toBeUndefined();
    expect(legacySetup({ POLYCAP_ROOT: '/h/HeadsetInbox' }, '/h', files('/h/HeadsetInbox'))).toBeUndefined();
  });
});

describe('summary', () => {
  it('tidies a title and refuses an answer that is not a label', () => {
    expect(cleanSummary({ title: ' “Deck  redesign.” ', summary: 'One  sentence.' }, 'm')).toEqual({ title: 'Deck redesign', text: 'One sentence.', model: 'm' });
    expect(() => cleanSummary({ title: '', summary: 'x' }, 'm')).toThrow(/empty/);
    expect(() => cleanSummary({ title: 'x'.repeat(101), summary: 'x' }, 'm')).toThrow(/101 characters/);
    expect(() => cleanSummary({ title: 'x', summary: 'y'.repeat(401) }, 'm')).toThrow(/one sentence/);
  });

  it('reads a bundle made before the rename to Polydance Capture', () => {
    const manifest = sessionSchema.parse({ ...manifestFor('old', '2026-10-01T10:00:00Z'), tool: { name: 'headset-inbox', version: '0.1.0' } });
    expect(manifest.tool.name).toBe('headset-inbox');
    expect(() => sessionSchema.parse({ ...manifestFor('odd', '2026-10-01T10:00:00Z'), tool: { name: 'something-else', version: '1' } })).toThrow();
  });

  it('reads a bundle made before summaries as complete, not pending', () => {
    const old = { version: 1, id: 's', title: 's', createdAt: 'x', recordedAt: 'x', recordedAtSource: 'mtime', source: { kind: 'import', originalName: 'a.mp4', bytes: 1, sha256: 'a'.repeat(64) }, media: { video: 'video.mp4' }, tool: { name: 'polydance-capture', version: '0.1.0' },
      steps: { probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' }, frames: { status: 'done' }, markers: { status: 'done' } } };
    const manifest = sessionSchema.parse(old);
    expect(manifest.steps.summary).toEqual({ status: 'skipped', note: 'made before summaries existed' });
    expect(manifest.steps.storyboard).toEqual({ status: 'skipped', note: 'made before storyboards existed' });
    expect(isPending(manifest)).toBe(false);
  });
});

/** Words at 0.3 s each with 0.1 s between them, except the pauses (in ms) given before particular words. */
function words(text: string, pauses: Record<number, number> = {}, startMs = 0): TranscriptWord[] {
  let t = startMs;
  return text.split(' ').map((word, i) => { t += pauses[i] ?? (i ? 100 : 0); const w = { text: word, startMs: t, endMs: t + 300 }; t += 300; return w; });
}
const segmentOf = (ws: TranscriptWord[], text = ws.map(w => w.text).join(' ')) => ({ startMs: ws[0].startMs, endMs: ws.at(-1)!.endMs, text, words: ws });

describe('transcript lines', () => {
  it('splits a long unpunctuated stretch at the pause before an opener, not mid-phrase', () => {
    // 26 words, about 11 s: a long pause after "and" (hesitation) and a short one before "let's".
    const ws = words('this kind of design with the two reels and these colours and buttons and interface design let\'s try and copy this as closely as possible', { 12: 900, 16: 200 });
    const lines = splitLongSegments([segmentOf(ws)]);
    expect(lines.map(l => l.text)).toEqual(['this kind of design with the two reels and these colours and buttons and interface design', 'let\'s try and copy this as closely as possible']);
    expect(lines[1].startMs).toBe(ws[16].startMs);
    expect(lines[1].words?.[0].text).toBe('let\'s');
  });

  it('breaks at sentence punctuation, keeps short and wordless segments whole, and never leaves a scrap', () => {
    const punctuated = words('Keep the dials. Remove the box around them.');
    expect(splitLongSegments([segmentOf(punctuated)]).map(l => l.text)).toEqual(['Keep the dials.', 'Remove the box around them.']);
    const short = segmentOf(words('keep the counter'), 'Keep the counter.');
    expect(splitLongSegments([short])).toEqual([short]);
    const whisper = { startMs: 0, endMs: 20_000, text: 'a long line from whisper without word timings' };
    expect(splitLongSegments([whisper])).toEqual([whisper]);
    // A long run whose only real pause would leave two words alone stays one line.
    const scrap = words('um let\'s keep the dials like this this is good and the counter too and the reels as they are', { 2: 2500 });
    expect(splitLongSegments([segmentOf(scrap)]).every(l => (l.words?.length ?? 3) >= 3)).toBe(true);
  });

  it('joins an engine segment that ends mid-phrase to the next before splitting', () => {
    const a = segmentOf(words('let\'s try and copy this as closely as possible um let\'s'));
    const b = segmentOf(words('keep the uh decibel dials like this', {}, a.endMs + 600));
    const lines = splitLongSegments([a, b]);
    expect(lines.map(l => l.text).join(' | ')).not.toMatch(/let's \|/);
    expect(lines.map(l => l.text).join(' ')).toBe(`${a.text} ${b.text}`);
  });
});

describe('contact sheet captions', () => {
  it('draws each clock on its own thumbnail only', () => {
    const filter = contactSheetFilter([{ atMs: 500, reason: 'edge' }, { atMs: 83_000, reason: 'pointing', word: 'this' }], 2, 1);
    expect(filter).toBe("scale=320:-2,drawtext=text='00\\:00':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=5:enable='eq(n,0)',drawtext=text='01\\:23 this':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=5:enable='eq(n,1)',tile=2x1");
  });
});

const manifestFor = (id: string, recordedAt: string, extra: Partial<SessionManifest['source']> = {}): SessionManifest => sessionSchema.parse({
  version: 1, id, title: id, createdAt: recordedAt, recordedAt, recordedAtSource: 'argument',
  source: { kind: 'upload', originalName: 'a.mp4', bytes: 1, sha256: 'a'.repeat(64), appPackage: 'net.polydance.capture', deviceModel: 'Quest 3', ...extra },
  media: { video: 'video.mp4', durationMs: 20_000 }, tool: { name: 'polydance-capture', version: '0.1.0' },
  steps: { probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' }, frames: { status: 'done' }, markers: { status: 'done' } },
});

describe('previous session', () => {
  it('is the nearest earlier session with the same app on the same headset, within a week', () => {
    const now = manifestFor('pass3', '2026-10-01T22:29:57Z');
    const refs = [
      manifestFor('pass2', '2026-10-01T22:03:11Z'), manifestFor('pass1', '2026-10-01T21:12:15Z'),
      manifestFor('other-app', '2026-10-01T22:20:00Z', { appPackage: 'com.example.marimba' }), manifestFor('later', '2026-10-01T23:00:00Z'),
      manifestFor('old', '2026-09-20T10:00:00Z'), now,
    ].map(manifest => ({ dir: manifest.id, manifest }));
    expect(previousSession(refs, now)?.manifest.id).toBe('pass2');
    expect(previousSession(refs, manifestFor('first', '2026-10-01T20:00:00Z'))).toBeUndefined();
  });

  it('is the recording before it in its thread, when it is in one, however long ago', () => {
    const inThread = (id: string, at: string, key: string) => manifestFor(id, at, { thread: { key, project: key.split('-')[0], title: 't', opened: false } });
    const now = inThread('inbox-3', '2026-10-04T14:18:09Z', 'CAP-1');
    const refs = [
      inThread('marimba', '2026-10-04T13:56:09Z', 'MUS-1'), inThread('inbox-1', '2026-10-03T15:35:56Z', 'CAP-1'),
      inThread('inbox-2', '2026-10-04T14:17:23Z', 'CAP-1'), manifestFor('no-thread', '2026-10-04T14:00:00Z'), now,
    ].map(manifest => ({ dir: manifest.id, manifest }));
    expect(previousSession(refs, now)?.manifest.id).toBe('inbox-2');
    expect(previousSession(refs, refs[1].manifest)).toBeUndefined();
    // A session outside threads never follows one in a thread.
    expect(previousSession(refs, manifestFor('after', '2026-10-04T15:00:00Z'))?.manifest.id).toBe('no-thread');
  });
});

describe('storyboard', () => {
  it('leaves out the Quest\'s own menus and sub-second flickers, as in a real recording', () => {
    const a = (s: number, pkg: string) => ({ atMs: Math.round(s * 1000), package: pkg });
    // Recording 2026-10-02T19-29-08: start in the app, Marimba in the browser, the menu and panel flicker to stop.
    const raw = [a(0, 'net.polydance.capture'), a(3.9, 'com.oculus.browser'), a(191.7, 'com.oculus.panelapp.library'), a(191.7, 'com.oculus.vrshell'),
      a(191.8, 'com.oculus.panelapp.library'), a(195.2, 'com.oculus.vrshell'), a(195.5, 'com.oculus.browser'), a(196.6, 'net.polydance.capture'),
      a(198.8, 'com.oculus.browser'), a(199.1, 'net.polydance.capture'), a(199.2, 'com.oculus.browser')];
    expect(appTimeline(raw, 201_800).map(x => `${x.atMs} ${x.package}`)).toEqual(['0 net.polydance.capture', '3900 com.oculus.browser', '196600 net.polydance.capture', '199200 com.oculus.browser']);
  });

  it('lists the apps that came to the front and notes each switch before the next line spoken', () => {
    const manifest = manifestFor('pass5', '2026-10-02T15:40:02Z', { apps: [
      { atMs: 0, package: 'net.polydance.capture', label: 'Polydance Capture', versionName: '0.4.0', versionCode: 4 },
      { atMs: 4_000, package: 'com.example.marimba', label: 'Marimba Studio', versionName: '2.3.1', versionCode: 231 },
      { atMs: 15_000, package: 'com.oculus.browser' },
    ] });
    const md = storyboardMarkdown({ manifest, segments: [{ startMs: 3000, endMs: 6000, text: 'Here is the app.' }, { startMs: 9000, endMs: 12_000, text: 'And the marimba.' }], frames: [], markers: [], requests: [] });
    expect(md).toContain("## Apps in front\n\nFrom the headset's usage log: which app came to the front when, with its version (the Quest's own menus and sub-second flickers left out).\n\n- [00:00] Polydance Capture 0.4.0 (4)\n- [00:04] Marimba Studio 2.3.1 (231)\n- [00:15] com.oculus.browser: the Meta Quest Browser, so a web page; its address is not recorded\n");
    expect(md).toContain('[00:03] Here is the app.\n\n(00:04: Marimba Studio 2.3.1 (231) came to the front)\n\n[00:09] And the marimba.');
  });

  it('says what a pointing frame shows when the pointing pass named it', () => {
    const manifest = manifestFor('named', '2026-10-04T22:05:37Z');
    const md = storyboardMarkdown({
      manifest, segments: [{ startMs: 1000, endMs: 3000, text: 'This try button.' }], markers: [], requests: [],
      frames: [{ file: '0001_00m02s.jpg', atMs: 2000, reason: 'pointing', word: 'this', full: 'full/0001_00m02s.jpg' }, { file: '0002_00m02s.jpg', atMs: 2500, reason: 'pointing', word: 'that' }],
      pointing: [{ file: '0001_00m02s.jpg', atMs: 2000, word: 'this', target: 'the TRY label on the CAP-1 row', sure: true }, { file: '0002_00m02s.jpg', atMs: 2500, word: 'that', target: 'the reaction bar', sure: false }],
    });
    expect(md).toContain('- 00:02 frames/0001_00m02s.jpg, pointing at "this": the TRY label on the CAP-1 row, full size frames/full/0001_00m02s.jpg');
    expect(md).toContain('- 00:02 frames/0002_00m02s.jpg, pointing at "that": probably the reaction bar');
  });

  it('lists what the app opened from launches and notes each in order with the app switches', () => {
    const manifest = manifestFor('variants', '2026-10-04T22:00:00Z', {
      apps: [{ atMs: 0, package: 'net.polydance.capture', label: 'Polydance Capture' }, { atMs: 2_000, package: 'com.oculus.browser' }],
      opened: [{ atMs: 1_500, what: 'open https://preview-a.example/', label: 'Variant A' }, { atMs: 8_000, what: 'open https://preview-b.example/', label: 'Variant B' }],
    });
    const md = storyboardMarkdown({ manifest, segments: [{ startMs: 3000, endMs: 6000, text: 'This is A.' }, { startMs: 9000, endMs: 12_000, text: 'And this is B.' }], frames: [], markers: [], requests: [] });
    expect(md).toContain("## Opened from the inbox\n\nWhat Polydance opened from the thread's launches while recording, and when: which build or variant was put on screen.\n\n- [00:01] Variant A: open https://preview-a.example/\n- [00:08] Variant B: open https://preview-b.example/\n");
    expect(md).toContain('(00:01: opened Variant A: open https://preview-a.example/)\n\n(00:02: com.oculus.browser came to the front)\n\n[00:03] This is A.\n\n(00:08: opened Variant B: open https://preview-b.example/)\n\n[00:09] And this is B.');
  });

  it('says which option was on screen beside each request', () => {
    const manifest = { ...manifestFor('options', '2026-10-06T00:30:00Z', { opened: [
      { atMs: 1_000, what: 'open https://a.example/', label: 'Blue', message: 16, launch: 0 }, { atMs: 8_000, what: 'open https://b.example/', label: 'Red', message: 16, launch: 1 },
    ] }), summary: { title: 'Menus', text: 'Compares two menus.', model: 'claude-haiku-4-5' } };
    const md = storyboardMarkdown({
      manifest, frames: [], markers: [],
      segments: [{ startMs: 500, endMs: 900, text: 'Starting.' }, { startMs: 3000, endMs: 6000, text: 'Blue is too dark.' }, { startMs: 9000, endMs: 12_000, text: 'Red is better.' }],
      requests: [{ atMs: 500, text: 'Say hello' }, { atMs: 3000, text: 'Make blue lighter' }, { atMs: 9000, text: 'Keep red' }],
    });
    expect(md).toContain('In brackets, what was on screen when it was said.\n\n- [00:00] Say hello\n- [00:03] (option 1: Blue) Make blue lighter\n- [00:09] (option 2: Red) Keep red\n');
    expect(md).toContain('[00:03] Blue is too dark.\n- request: (option 1: Blue) Make blue lighter');
    expect(md).toContain('- [00:01] option 1: Blue: open https://a.example/');
    // A take that opened only one option says so once, at the top, not on every request.
    const one = { ...manifest, source: { ...manifest.source, opened: manifest.source.opened!.slice(1) } };
    const single = storyboardMarkdown({ manifest: one, frames: [], markers: [], segments: [{ startMs: 9000, endMs: 12_000, text: 'Red is better.' }], requests: [{ atMs: 9000, text: 'Keep red' }] });
    expect(single).toContain('- [00:09] Keep red');
    expect(single).not.toContain('In brackets');
  });

  it('puts requests, markers and frames under the line they belong to', () => {
    const manifest = { ...manifestFor('pass3', '2026-10-01T22:29:57Z', { appBuild: { versionName: '0.3.0', versionCode: 3, commit: 'e4d58b2' } }), summary: { title: 'Vintage deck keys', text: 'Asks for keys.', model: 'claude-haiku-4-5' } };
    const md = storyboardMarkdown({
      manifest, previous: { id: 'pass2', title: 'Reel-to-reel deck' },
      segments: [{ startMs: 3000, endMs: 6000, text: 'Remove this bar.' }, { startMs: 9000, endMs: 12_000, text: 'Copy this design.' }],
      frames: [
        { file: '0001_00m00s.jpg', atMs: 500, reason: 'edge' },
        { file: '0002_00m04s.jpg', atMs: 4200, reason: 'pointing', word: 'this', full: 'full/0002_00m04s.jpg' },
        { file: '0003_00m07s.jpg', atMs: 7000, reason: 'segment' },
        { file: '0004_00m10s.jpg', atMs: 10_500, reason: 'segment', full: 'full/0004_00m10s.jpg' },
      ],
      markers: [{ atMs: 9000, endMs: 12_000, kind: 'reference', cue: 'copy this', text: 'Copy this design.' }],
      requests: [{ atMs: 3000, text: 'Remove the bar at the top' }],
    });
    expect(md).toBe([
      '# Storyboard: pass3', '',
      '**Vintage deck keys.** Asks for keys.', '',
      'Recorded 2026-10-01T22:29:57Z · 00:20 · Quest 3 · net.polydance.capture 0.3.0 (3) e4d58b2',
      'Previous session with this app on this headset: pass2, "Reel-to-reel deck"',
      'Paths are relative to this folder; frames/full/ holds full-resolution copies of pointing and reference frames.', '',
      '## Requests', '', "Claude's reading of the transcript (claude-haiku-4-5); the transcript below is the record.", '',
      '- [00:03] Remove the bar at the top', '',
      '## Transcript and frames', '',
      'Before speech', '- 00:00 frames/0001_00m00s.jpg', '',
      '[00:03] Remove this bar.', '- request: Remove the bar at the top',
      '- 00:04 frames/0002_00m04s.jpg, pointing at "this", full size frames/full/0002_00m04s.jpg',
      '- 00:07 frames/0003_00m07s.jpg', '',
      '[00:09] Copy this design. {reference}', '- 00:10 frames/0004_00m10s.jpg, full size frames/full/0004_00m10s.jpg',
    ].join('\n') + '\n');
  });

  it('says a frame was taken in silence, and why a pointing frame has no reading', () => {
    const base = manifestFor('frames', '2026-10-16T10:00:00Z');
    const frames = [
      { file: '0001_00m05s.jpg', atMs: 5000, reason: 'interval' as const },
      { file: '0002_00m11s.jpg', atMs: 11_000, reason: 'pointing' as const, word: 'this' },
      { file: '0003_00m12s.jpg', atMs: 12_000, reason: 'pointing' as const, word: 'that' },
    ];
    const pointing = [{ file: '0002_00m11s.jpg', atMs: 11_000, word: 'this', target: 'unclear', sure: false }];
    const board = (status: 'done' | 'failed' | 'skipped') => storyboardMarkdown({ manifest: { ...base, steps: { ...base.steps, pointing: { status } } },
      segments: [{ startMs: 10_000, endMs: 13_000, text: 'Move this to that.' }], frames, markers: [], requests: [], pointing });
    expect(board('done')).toContain('- 00:05 frames/0001_00m05s.jpg, interval, nothing said\n');
    expect(board('done')).toContain('- 00:11 frames/0002_00m11s.jpg, pointing at "this": unclear\n- 00:12 frames/0003_00m12s.jpg, pointing at "that" (not analysed: the pass reads the first 24)\n');
    expect(board('failed')).toContain('pointing at "that" (not analysed: the pointing step failed)');
    expect(board('skipped')).toContain('- 00:12 frames/0003_00m12s.jpg, pointing at "that"\n');
  });

  it('names each request\'s kind and says how many the summary left out', () => {
    const manifest = manifestFor('kinds', '2026-10-12T10:00:00Z');
    const md = storyboardMarkdown({ manifest, frames: [], markers: [], rejectedRequests: 2,
      segments: [{ startMs: 3000, endMs: 6000, text: 'Maybe hide the title.' }],
      requests: [{ atMs: 3000, text: 'Maybe hide the title', kind: 'idea', quote: 'Maybe hide the title' }] });
    expect(md).toContain('- [00:03] idea: Maybe hide the title\n- 2 more left out: their quotes were not on one transcript line (rejected in requests.json)\n');
    expect(md).toContain('[00:03] Maybe hide the title.\n- idea: Maybe hide the title\n');
  });
});

describe('whisper output', () => {
  const raw = readFileSync(new URL('./fixtures/whisper-output.json', import.meta.url), 'utf8');
  it('keeps speech segments with millisecond offsets and drops non-speech labels', () => {
    const parsed = parseWhisperJson(raw);
    expect(parsed.language).toBe('en');
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[1]).toEqual({ startMs: 1500, endMs: 3200, text: "There's a bug here, the stick goes through the drum." });
  });
  it('renders a clocked markdown transcript', () => {
    const md = transcriptMarkdown('s1', { engine: 'whisper-cpp', ...parseWhisperJson(raw) }, 6000);
    expect(md).toContain('# Transcript: s1');
    expect(md).toContain('Duration: 00:06');
    expect(md).toContain("[00:01] There's a bug here");
    expect(md).toContain('[00:03] It would be nice');
  });
});

describe('markers', () => {
  it('classifies spoken cues with bug taking priority', () => {
    const markers = findMarkers(parseWhisperJson(readFileSync(new URL('./fixtures/whisper-output.json', import.meta.url), 'utf8')).segments);
    expect(markers.map(m => [m.kind, m.cue])).toEqual([['bug', 'bug'], ['idea', 'it would be nice']]);
    expect(markers[0].atMs).toBe(1500);
  });

  it('catches "would be nice" without "it" and design directives as changes', () => {
    const at = (text: string) => ({ startMs: 0, endMs: 1000, text });
    const kinds = findMarkers([
      at('Maybe something slightly retro would be nice.'),
      at("And then we don't need this."),
      at("Let's center it."),
      at('I think we can simplify this design.'),
      at("Let's hide this, it's broken anyway."),
      at('We walk over to the menu here.'),
    ]).map(m => [m.kind, m.cue]);
    expect(kinds).toEqual([['idea', 'would be nice'], ['change', "we don't need"], ['change', "let's center"], ['change', 'simplify'], ['bug', 'broken']]);
  });
});

describe('frame planning', () => {
  it('puts a frame on each pointing word, which wins over a nearby segment midpoint', () => {
    const words = [
      { text: 'we', startMs: 1000, endMs: 1200 }, { text: "don't", startMs: 1200, endMs: 1500 }, { text: 'need', startMs: 1500, endMs: 1800 },
      { text: 'this,', startMs: 1800, endMs: 2200 },
    ];
    const later = [{ text: 'and', startMs: 6000, endMs: 6200 }, { text: 'These', startMs: 6200, endMs: 6600 }, { text: 'too', startMs: 6600, endMs: 7000 }];
    const plan = planFrames(10_000, [{ startMs: 1000, endMs: 2200, text: "we don't need this,", words }, { startMs: 6000, endMs: 7000, text: 'and These too', words: later }], { maxFrames: 80, intervalMs: 5000 });
    // The opening edge frame (0.5 s) and both segment midpoints are within 2 s of a pointing frame and give way to it.
    expect(plan).toEqual([
      { atMs: 2000, reason: 'pointing', word: 'this' }, { atMs: 6400, reason: 'pointing', word: 'these' }, { atMs: 9500, reason: 'edge' },
    ]);
  });

  it('uses segment midpoints plus both ends, and a segment wins over a nearby edge', () => {
    const plan = planFrames(10_000, [{ startMs: 1000, endMs: 3000, text: 'a' }, { startMs: 6000, endMs: 8000, text: 'b' }], { maxFrames: 80, intervalMs: 5000 });
    expect(plan).toEqual([{ atMs: 2000, reason: 'segment' }, { atMs: 7000, reason: 'segment' }, { atMs: 9500, reason: 'edge' }]);
    const spaced = planFrames(10_000, [{ startMs: 4000, endMs: 6000, text: 'a' }], { maxFrames: 80, intervalMs: 5000 });
    expect(spaced).toEqual([{ atMs: 500, reason: 'edge' }, { atMs: 5000, reason: 'segment' }, { atMs: 9500, reason: 'edge' }]);
  });
  it('falls back to an interval without a transcript and merges close candidates', () => {
    const plan = planFrames(12_000, [], { maxFrames: 80, intervalMs: 5000 });
    expect(plan.map(p => p.atMs)).toEqual([500, 5000, 10000]);
    expect(planFrames(800, [], { maxFrames: 80, intervalMs: 5000 })).toEqual([{ atMs: 500, reason: 'edge' }]);
  });
  it('adds frames at the interval in a silence longer than an interval, short of the next line and the end', () => {
    const lines = [{ startMs: 10_000, endMs: 12_000, text: 'a' }, { startMs: 30_000, endMs: 32_000, text: 'b' }];
    const plan = planFrames(60_000, lines, { maxFrames: 80, intervalMs: 5000 });
    expect(plan.map(p => [p.atMs, p.reason[0]].join(''))).toEqual([
      '500e', '5000i', '11000s', '17000i', '22000i', '27000i', '31000s', '37000i', '42000i', '47000i', '52000i', '57000i', '59500e',
    ]);
    // Over the cap, silence gives way first: every line and both ends stay.
    const thin = planFrames(60_000, lines, { maxFrames: 6, intervalMs: 5000 });
    expect(thin).toHaveLength(6);
    expect(thin.filter(p => p.reason !== 'interval').map(p => p.atMs)).toEqual([500, 11_000, 31_000, 59_500]);
  });
  it('thins to the cap keeping first and last', () => {
    const segments = Array.from({ length: 200 }, (_, i) => ({ startMs: i * 3000, endMs: i * 3000 + 2000, text: 'x' }));
    const plan = planFrames(600_000, segments, { maxFrames: 20, intervalMs: 5000 });
    expect(plan).toHaveLength(20);
    // The opening edge at 0.5 s collapses into the first segment midpoint, which outranks it.
    expect(plan[0].atMs).toBe(1000);
    // The closing edge at 599.5 s collapses into the last segment midpoint, which outranks it.
    expect(plan.at(-1)?.atMs).toBe(598_000);
    expect(frameFileName(7, 83_000)).toBe('0007_01m23s.jpg');
  });
});

describe('storage for people outside the team (2026-11-12)', () => {
  it('caps a thread-scoped token and a signed-in tester, never one whose person holds a team token', () => {
    const config = loadConfig({ POLYCAP_MEMBER_ALLOWANCE_BYTES: '2000000000' });
    const tester: Grant = { id: 'meta-1001', sha256: 'a'.repeat(64), scopes: ['upload'] };
    expect(allowanceFor(config, tester)).toBe(2_000_000_000);
    expect(allowanceFor(config, { ...tester, teamPerson: true })).toBe(8_000_000_000);
    expect(allowanceFor(config, { ...tester, id: 'ana-quest', user: 'ana', threads: 'member' })).toBe(2_000_000_000);
    expect(allowanceFor(config, { ...tester, id: 'quest3' })).toBe(8_000_000_000);
    // A tighter allowance of its own still wins.
    expect(allowanceFor(config, { ...tester, quotaOwnerIds: ['meta-1001'], quotaMaxBytes: 1_000_000_000 })).toBe(1_000_000_000);
    // Unset, as on a receiver that never chose one: everyone has the default.
    expect(allowanceFor(loadConfig({}), tester)).toBe(8_000_000_000);
    expect(() => loadConfig({ POLYCAP_MEMBER_VIDEO_DAYS: '0' })).toThrow(/POLYCAP_MEMBER_VIDEO_DAYS/);
    expect(loadConfig({ POLYCAP_MEMBER_VIDEO_DAYS: '30' }).memberVideoDays).toBe(30);
  });
});
