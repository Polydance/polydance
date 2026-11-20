/**
 * Calls from the Mac (docs/MAC.md T1, T2, P1, P2, P5, P6, P8): the pure parts, with no ffmpeg, model
 * or network, and the session refs the Mac app passes.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callLines } from '../src/commands/inspect.js';
import { importRecording } from '../src/commands/import.js';
import { transcriptExport } from '../src/commands/export.js';
import { loadConfig } from '../src/config.js';
import { importMetaSchema, importSource, parseImportMeta, parseTracks } from '../src/import-meta.js';
import { inVideoGap } from '../src/call.js';
import { addPriorityFrames, frameLabel, frameSpanMs, gapsText, markFrameMs, planFrames, silences } from '../src/pipeline/frames.js';
import { parseVideoEnd } from '../src/pipeline/probe.js';
import { dropFaintLines, dropSilentLines, linePeak, loudnessFloor, parseMomentary, parseSilences, silentShare } from '../src/pipeline/silence.js';
import { CALL_CUES, findMarkers, markMarkers } from '../src/pipeline/markers.js';
import { collapseScenes, parseShowinfo } from '../src/pipeline/scenes.js';
import { callHeader, storyboardMarkdown } from '../src/pipeline/storyboard.js';
import { groundRequests, transcriptForSummary } from '../src/pipeline/summary.js';
import { transcriptFileSchema, transcriptMarkdown, voiceNote, type TranscriptSegment } from '../src/pipeline/transcribe.js';
import { voiceTracks } from '../src/pipeline/audio.js';
import { dropBleed, lineText, mergeVoices, similarity, speakerCounts, speakerLabel, speakerSchema } from '../src/pipeline/voices.js';
import { createSession, listSessions, previousSession, resolveSession, screenMissing, sessionSchema, type SessionManifest } from '../src/session.js';
import { testCli } from './helpers/cli.js';

const fixturePath = new URL('./fixtures/mac-call-meta.json', import.meta.url).pathname;
const fixtureText = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const withCall = (call: Record<string, unknown>) => JSON.stringify({ ...fixture, call: { ...fixture.call, ...call } });

describe('import metadata', () => {
  it('parses the contract fixture exactly as written', () => {
    expect(parseImportMeta(fixtureText)).toEqual(fixture);
    expect(importMetaSchema.parse({ version: 1 })).toEqual({ version: 1 });
    // A walkthrough has no call, and may still carry marks.
    expect(parseImportMeta(JSON.stringify({ version: 1, marks: [{ atMs: 0, note: '' }] })).marks).toEqual([{ atMs: 0, note: '' }]);
  });

  it('refuses anything else with the field named', () => {
    const bad: [string, RegExp][] = [
      ['{ "version": 2 }', /version/],
      ['not json', /is not JSON/],
      [JSON.stringify({ ...fixture, colour: 'red' }), /\(top level\): Unrecognized key: "colour"/],
      [withCall({ attendees: ['ana@example.com'] }), /call: Unrecognized key: "attendees"/],
      [withCall({ meetingCode: 'ABC-defg-hij' }), /call\.meetingCode: must look like abc-defg-hij/],
      [withCall({ meetingCode: 'abc-defg-hijk' }), /call\.meetingCode/],
      [withCall({ stopReason: 'hung-up' }), /call\.stopReason/],
      [withCall({ video: 'maybe' }), /call\.video/],
      [withCall({ farEnd: 'quiet' }), /call\.farEnd/],
      [withCall({ told: 'sort of' }), /call\.told/],
      [withCall({ app: 'webex' }), /call\.app/],
      [withCall({ startedAt: '5 November' }), /call\.startedAt: must be an ISO 8601 time/],
      [withCall({ endedAt: '2026-11-05T10:00:00Z' }), /call\.endedAt: endedAt is before startedAt/],
      [JSON.stringify({ ...fixture, call: { ...fixture.call, app: undefined } }), /call\.app/],
      [JSON.stringify({ ...fixture, marks: [{ atMs: -1 }] }), /marks\.0\.atMs/],
      [JSON.stringify({ ...fixture, marks: [{ atMs: 1.5 }] }), /marks\.0\.atMs/],
      [JSON.stringify({ ...fixture, marks: [{ atMs: 1, note: 'x'.repeat(201) }] }), /marks\.0\.note/],
      [JSON.stringify({ ...fixture, audioTracks: ['mic', 'mic'] }), /audioTracks: names a track role twice/],
      [JSON.stringify({ ...fixture, audioTracks: ['mic', 'game'] }), /audioTracks\.1/],
      [JSON.stringify({ ...fixture, appBuild: { versionName: '0.1.0', commit: 'main' } }), /appBuild\.commit/],
      [withCall({ videoGaps: [{ fromMs: 10_000, toMs: 9000, reason: 'x' }] }), /call\.videoGaps\.0\.toMs: toMs is before fromMs/],
      [withCall({ videoGaps: [{ fromMs: -1, reason: 'x' }] }), /call\.videoGaps\.0\.fromMs/],
      [withCall({ videoGaps: [{ fromMs: 1.5, reason: 'x' }] }), /call\.videoGaps\.0\.fromMs/],
      [withCall({ videoGaps: [{ fromMs: 1, reason: '' }] }), /call\.videoGaps\.0\.reason/],
      [withCall({ videoGaps: [{ fromMs: 1, reason: 'y'.repeat(121) }] }), /call\.videoGaps\.0\.reason/],
      [withCall({ videoGaps: [{ fromMs: 1, reason: 'x', cause: 'purge' }] }), /call\.videoGaps\.0: Unrecognized key: "cause"/],
      [withCall({ videoGaps: Array.from({ length: 21 }, (_, i) => ({ fromMs: i, reason: 'x' })) }), /call\.videoGaps/],
    ];
    for (const [text, message] of bad) expect(() => parseImportMeta(text, 'test.meta.json'), text).toThrow(message);
    expect(() => parseImportMeta('{ "version": 2 }', 'x.meta.json')).toThrow(/^x\.meta\.json is not valid import metadata/);
  });

  it('reads --tracks as roles in file order and refuses anything that is not one', () => {
    expect(parseTracks('mic,app')).toEqual(['mic', 'app']);
    expect(parseTracks(' app ')).toEqual(['app']);
    expect(() => parseTracks('mic,game')).toThrow(/each track is mic or app/);
    expect(() => parseTracks('')).toThrow(/each track is mic or app/);
    expect(() => parseTracks('mic,mic')).toThrow(/twice/);
  });

  it('takes the app, the time and the tracks from either side, and refuses the two disagreeing', () => {
    const meta = parseImportMeta(fixtureText);
    const source = importSource({}, meta);
    expect(source).toEqual({
      appPackage: 'net.polydance.capture.mac', recordedAt: new Date('2026-11-05T11:00:02.120Z'), recordedAtSource: 'meta',
      appBuild: fixture.appBuild, audioTracks: ['mic', 'app'], call: fixture.call, marks: [{ atMs: 252000 }, { atMs: 595500, note: 'flag this' }],
    });
    expect(importSource({ tracks: 'mic,app', app: 'net.polydance.capture.mac', recordedAt: '2026-11-05T11:00:02.120Z' }, meta).recordedAtSource).toBe('argument');
    expect(() => importSource({ tracks: 'app,mic' }, meta)).toThrow(/--tracks app,mic conflicts with audioTracks mic,app in --meta/);
    expect(() => importSource({ app: 'com.obsproject.obs' }, meta)).toThrow(/--app com\.obsproject\.obs conflicts/);
    expect(() => importSource({ recordedAt: '2026-11-05T12:00:00Z' }, meta)).toThrow(/--recorded-at .* conflicts/);
    expect(() => importSource({ recordedAt: 'yesterday' })).toThrow(/is not a date/);
    expect(importSource({ tracks: 'mic,app' })).toEqual({ audioTracks: ['mic', 'app'] });
    // Marks are put in clock order, and an empty note is no note.
    expect(importSource({}, parseImportMeta(JSON.stringify({ version: 1, marks: [{ atMs: 9 }, { atMs: 3, note: '  ' }, { atMs: 5, note: ' a  b ' }] }))).marks)
      .toEqual([{ atMs: 3 }, { atMs: 5, note: 'a b' }, { atMs: 9 }]);
  });

  it('imports a call named for its app, with its call and marks, and leaves nothing behind when refused', async () => {
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const dir = await mkdtemp(join(tmpdir(), 'polycap-meta-'));
    const file = join(dir, 'polydance-mac-20261105-110002.mp4');
    await writeFile(file, 'not really a video');
    await expect(importRecording(cli, file, { meta: fixturePath, tracks: 'app,mic' })).rejects.toThrow(/conflicts/);
    await expect(importRecording(cli, file, { meta: join(dir, 'missing.meta.json') })).rejects.toThrow(/does not exist/);
    expect(await listSessions(cli.config)).toEqual([]);
    const session = await importRecording(cli, file, { meta: fixturePath, tracks: 'mic,app' });
    expect(session.manifest.id).toMatch(/^2026-11-05T\d\d-00-02_meet$/);
    expect(session.manifest).toMatchObject({ recordedAt: '2026-11-05T11:00:02.120Z', recordedAtSource: 'meta' });
    expect(session.manifest.source).toMatchObject({ kind: 'import', appPackage: 'net.polydance.capture.mac', appBuild: fixture.appBuild, audioTracks: ['mic', 'app'], call: fixture.call, marks: [{ atMs: 252000 }, { atMs: 595500, note: 'flag this' }] });
    // A walkthrough from the same app is named for the app, as before.
    const walk = await importRecording(cli, file, { meta: (await writeMeta(dir, { version: 1, appPackage: 'net.polydance.capture.mac' })) });
    expect(walk.manifest.id).toMatch(/_mac$/);
    expect(walk.manifest.recordedAtSource).toBe('filename');
  });
});

async function writeMeta(dir: string, meta: object): Promise<string> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.meta.json`);
  await writeFile(path, JSON.stringify(meta));
  return path;
}

const callManifest = (extra: Partial<SessionManifest['source']> = {}, media: Partial<SessionManifest['media']> = {}): SessionManifest => sessionSchema.parse({
  version: 1, id: '2026-11-05T11-00-02_meet', title: '2026-11-05T11-00-02_meet', createdAt: '2026-11-05T12:00:00Z', recordedAt: '2026-11-05T11:00:02.120Z', recordedAtSource: 'meta',
  source: { kind: 'import', originalName: 'polydance-mac-20261105-110002.mp4', bytes: 1, sha256: 'a'.repeat(64), appPackage: 'net.polydance.capture.mac', audioTracks: ['mic', 'app'], call: fixture.call, marks: [{ atMs: 7800 }, { atMs: 12_800, note: 'flag this' }], ...extra },
  media: { video: 'video.mp4', durationMs: 20_000, width: 1920, height: 1243, hasVideo: true, audioChannels: [1, 2], voice: 'both', ...media }, tool: { name: 'polydance-capture', version: '0.1.0' },
  steps: { probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' }, frames: { status: 'done' }, pointing: { status: 'skipped' }, markers: { status: 'done' }, summary: { status: 'skipped' }, storyboard: { status: 'pending' } },
});

describe('session.json for calls', () => {
  it('accepts a call and marks, still reads a bundle from before them, and refuses a bad call', () => {
    const manifest = callManifest();
    expect(manifest.source.call).toEqual(fixture.call);
    const old = { ...manifest, recordedAtSource: 'argument', source: { kind: 'import', originalName: 'a.mp4', bytes: 1, sha256: 'a'.repeat(64) }, media: { video: 'video.mp4', voice: 'mic' } };
    expect(sessionSchema.parse(old).source.call).toBeUndefined();
    expect(() => callManifest({ call: { ...fixture.call, video: 'maybe' } })).toThrow();
    expect(() => callManifest({ marks: [{ atMs: 1, colour: 'red' } as never] })).toThrow();
  });

  it('says why a finished recording has no picture, and nothing for one that has', () => {
    expect(screenMissing(callManifest())).toBeUndefined();
    expect(screenMissing(callManifest({ call: { ...fixture.call, video: 'none', videoNote: 'screen recording was not allowed' } }))).toBe('the screen was not recorded (screen recording was not allowed)');
    expect(screenMissing(callManifest({}, { hasVideo: false }))).toBe('the file has no video stream, though the recording app said the screen was recorded');
    expect(screenMissing(callManifest({ call: undefined }, { hasVideo: false }))).toBe('the file has no video stream: the screen was not recorded');
    // Bundles from before 2026-11-05 do not say, and had video.
    expect(screenMissing(callManifest({ call: undefined }, { hasVideo: undefined }))).toBeUndefined();
  });

  it('transcribes both tracks of a call apart, and one track of anything else', () => {
    expect(voiceTracks(callManifest())).toEqual({ voice: 'both', tracks: [{ index: 0, name: 'mic', speaker: 'me' }, { index: 1, name: 'app', speaker: 'others' }] });
    expect(voiceTracks(callManifest({ audioTracks: ['app', 'mic'] }))).toEqual({ voice: 'both', tracks: [{ index: 1, name: 'mic', speaker: 'me' }, { index: 0, name: 'app', speaker: 'others' }] });
    expect(voiceTracks(callManifest({ audioTracks: ['mic'] }, { audioChannels: [1] }))).toEqual({ voice: 'mic', tracks: [{ index: 0, name: 'mic', speaker: 'me' }] });
    expect(voiceTracks(callManifest({ audioTracks: ['app'] }, { audioChannels: [2] }))).toEqual({ voice: 'app', tracks: [{ index: 0, name: 'app', speaker: 'others' }] });
    // The Mac app's own shapes are known without being told: mic mono, the call's sound stereo.
    expect(voiceTracks(callManifest({ audioTracks: undefined }))).toMatchObject({ voice: 'both' });
    // A headset recording keeps one track: its app track is the game's sound, not a person.
    expect(voiceTracks(callManifest({ call: undefined }))).toEqual({ voice: 'mic', tracks: [{ index: 0, name: 'audio' }] });
    // A far end the recorder heard as digital silence is not transcribed: whisper could only invent Others' lines there.
    expect(voiceTracks(callManifest({ call: { ...fixture.call, farEnd: 'silent' } }))).toEqual({ voice: 'mic', tracks: [{ index: 0, name: 'mic', speaker: 'me' }], silentApp: 1 });
    expect(voiceTracks(callManifest({ call: { ...fixture.call, farEnd: 'silent' }, audioTracks: ['app'] }, { audioChannels: [2] }))).toEqual({ voice: 'app', tracks: [{ index: 0, name: 'app', speaker: 'others' }] });
  });

  it('follows the last call with the same meeting code, and never a call from a walkthrough', () => {
    const at = (id: string, recordedAt: string, extra: Partial<SessionManifest['source']> = {}) => ({ dir: id, manifest: { ...callManifest(extra), id, title: id, recordedAt } });
    const now = at('now', '2026-11-12T11:00:00Z');
    const refs = [now, at('last-week', '2026-11-05T11:00:00Z'), at('other-code', '2026-11-11T11:00:00Z', { call: { ...fixture.call, meetingCode: 'zzz-zzzz-zzz' } }), at('a-month-ago', '2026-10-01T11:00:00Z')];
    expect(previousSession(refs, now.manifest)?.manifest.id).toBe('last-week');
    expect(previousSession(refs, at('no-code', '2026-11-12T12:00:00Z', { call: { ...fixture.call, meetingCode: undefined } }).manifest)).toBeUndefined();
    const walkthrough = at('walk', '2026-11-12T13:00:00Z', { call: undefined, marks: undefined });
    expect(previousSession(refs, walkthrough.manifest)).toBeUndefined();
  });
});

const seg = (startMs: number, endMs: number, text: string, speaker?: TranscriptSegment['speaker']): TranscriptSegment => ({ startMs, endMs, text, ...(speaker ? { speaker } : {}) });

describe('both voices', () => {
  it('labels speakers and reads only me, others and others:N', () => {
    expect(['me', 'others', 'others:2'].map(s => speakerSchema.parse(s))).toEqual(['me', 'others', 'others:2']);
    for (const bad of ['you', 'others:0', 'others:x', 'Me']) expect(speakerSchema.safeParse(bad).success, bad).toBe(false);
    expect([speakerLabel('me'), speakerLabel('others'), speakerLabel('others:3')]).toEqual(['Me', 'Others', 'Others 3']);
    expect(lineText(seg(0, 1, 'hello', 'me'))).toBe('Me: hello');
    expect(lineText(seg(0, 1, 'hello'))).toBe('hello');
    expect(transcriptFileSchema.safeParse({ version: 1, engine: 'x', voice: 'both', bleedDropped: 1, segments: [seg(0, 1, 'a', 'others:2')] }).success).toBe(true);
  });

  it('measures how alike two lines are by their words, ignoring case and punctuation', () => {
    expect(similarity('Yes, I can see it now.', 'yes i can see it now')).toBe(1);
    expect(similarity("Can't wait", 'cant wait!')).toBe(1);
    expect(similarity('Thanks, talk soon.', 'Yes, thanks.')).toBe(0.25);
    expect(similarity('', 'anything')).toBe(0);
  });

  it('drops a mic line that repeats an app line said at the same moment, and keeps everything else Me said', () => {
    const others = [seg(2500, 3700, 'Yes, I can see it now.'), seg(10_000, 14_000, 'Yes and we should also move the launch to March then')];
    const me = [
      seg(2600, 3800, 'yes I can see it now'), // the far end through the speakers: dropped
      seg(5000, 6000, 'Yes, I can see it now.'), // the same words 2.5 s later: Me agreeing, kept
      seg(10_200, 10_600, 'Yes.'), // a short yes beside a long line: kept
      seg(13_000, 14_000, 'Something else entirely.'),
    ];
    expect(dropBleed(me, others)).toEqual({ kept: me.slice(1), dropped: 1 });
    // At the edge of the window and of the threshold.
    expect(dropBleed([seg(4000, 5000, 'Yes I can see it now')], others).dropped).toBe(1);
    expect(dropBleed([seg(4001, 5000, 'Yes I can see it now')], others).dropped).toBe(0);
    expect(dropBleed([seg(2500, 3000, 'yes I can see it')], others).dropped).toBe(1); // 5 of 6 words: 0.83
    expect(dropBleed([seg(2500, 3000, 'yes I can see')], others).dropped).toBe(0); // 4 of 6 words: 0.67
  });

  it('keeps Me\'s short reply to the same word, and drops a short line only when it coincides with its source', () => {
    const others = [seg(200_000, 200_300, 'Okay?', 'others'), seg(300_000, 302_000, 'Yes, I can see it now.', 'others')];
    // A reply comes after what it answers; with headphones on there was no bleed to drop.
    expect(dropBleed([seg(200_900, 201_300, 'Okay.')], others)).toEqual({ kept: [seg(200_900, 201_300, 'Okay.')], dropped: 0 });
    expect(dropBleed([seg(100_800, 101_200, 'Yeah.'), seg(3_600_900, 3_601_200, 'Bye!')], [seg(100_000, 100_400, 'Yeah.'), seg(3_600_000, 3_600_400, 'Bye.')])).toMatchObject({ dropped: 0 });
    // Bleed coincides with what the speakers played.
    expect(dropBleed([seg(200_050, 200_350, 'Okay.')], others)).toEqual({ kept: [], dropped: 1 });
    // Three words or more keep the rule as it was: start within 1.5 s and the same words.
    expect(dropBleed([seg(301_200, 303_000, 'Yes, I can see it now.')], others)).toEqual({ kept: [], dropped: 1 });
  });

  it('merges by start time, labelling each line, Me first on a tie', () => {
    const { segments, dropped } = mergeVoices(
      [seg(0, 2000, 'Can everyone see my screen?'), seg(2600, 3800, 'Yes, I can see it now.'), seg(5000, 6000, 'Great.')],
      [seg(2500, 3700, 'Yes, I can see it now.'), seg(5000, 5500, 'Okay.'), seg(7000, 8000, 'Next slide.', 'others:2')],
    );
    expect(dropped).toBe(1);
    expect(segments.map(lineText)).toEqual(['Me: Can everyone see my screen?', 'Others: Yes, I can see it now.', 'Me: Great.', 'Others: Okay.', 'Others 2: Next slide.']);
    expect(speakerCounts(segments)).toEqual([['me', 2], ['others', 2], ['others:2', 1]]);
  });

  it('writes each line with its speaker, and says whose each voice is', () => {
    const md = transcriptMarkdown('call', { engine: 'whisper-cpp', segments: [seg(0, 1000, 'Hello?', 'me'), seg(1500, 2000, 'Hi.', 'others')] }, 2000, 'both');
    expect(md).toContain('[00:00] Me: Hello?\n[00:01] Others: Hi.\n');
    expect(md).toContain(voiceNote('both')!);
    expect(transcriptExport('call', [seg(0, 1000, 'Hello?', 'me')], 'srt')).toBe('1\n00:00:00,000 --> 00:00:01,000\nMe: Hello?\n');
    expect(JSON.parse(transcriptExport('call', [seg(0, 1000, 'Hello?', 'me')], 'json')).segments[0].speaker).toBe('me');
  });
});

describe('scene changes', () => {
  const stderr = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'call.mp4':
[Parsed_showinfo_2 @ 0x115009150] config in time_base: 1/10240, frame_rate: 5/1
[Parsed_showinfo_2 @ 0x115009150] config out time_base: 0/0, frame_rate: 0/0
[Parsed_showinfo_2 @ 0x115009150] n:   0 pts:  30720 pts_time:3       duration:   2048 duration_time:0.2     fmt:yuv420p cl:unspecified sar:1/1 s:320x200 i:P iskey:1 type:I checksum:46BA8453 mean:[41 240 110] stdev:[0.0 0.0 0.0]
[Parsed_showinfo_2 @ 0x115009150] color_range:unknown color_space:unknown color_primaries:unknown color_trc:unknown
[Parsed_showinfo_2 @ 0x115009150] n:   1 pts:  63147 pts_time:6.16699 duration:   2048 duration_time:0.2     fmt:yuv420p
[Parsed_showinfo_2 @ 0x115009150] n:   2 pts:  92160 pts_time:9       duration:   2048 duration_time:0.2     fmt:yuv420p
[Parsed_showinfo_2 @ 0x115009150] n:   3 pts:  92160 pts_time:9       duration:   2048 duration_time:0.2     fmt:yuv420p
[out#0/null @ 0x6000] video:0KiB audio:0KiB`;

  it('reads the clock of every frame showinfo printed, rounded up so the seek lands on the new picture', () => {
    expect(parseShowinfo(stderr)).toEqual([3000, 6167, 9000]);
    expect(parseShowinfo('nothing selected')).toEqual([]);
  });

  it('takes one frame per burst of changes, once it has settled, within the recording', () => {
    expect(collapseScenes([3000, 6167, 9000], { durationMs: 12_000 })).toEqual([3300, 6467, 9300]);
    // A transition and a scroll: changes under 2 s apart are one scene, its frame after the last of them.
    expect(collapseScenes([10_000, 10_400, 10_800, 20_000, 21_500, 23_000, 24_900], { durationMs: 60_000 })).toEqual([11_100, 25_200]);
    expect(collapseScenes([11_900, 50_000], { durationMs: 12_000 })).toEqual([11_999]);
  });
});

describe('frames for calls', () => {
  const lines = [seg(0, 2000, 'a', 'me'), seg(2500, 3700, 'b', 'others'), seg(6000, 8500, 'c', 'me'), seg(11_000, 13_000, 'd', 'others'), seg(16_000, 18_000, 'e', 'me')];

  it('puts marks above scenes and scenes above every other frame, dropping what they cover', () => {
    const base = planFrames(20_000, lines, { maxFrames: 80, intervalMs: 5000 });
    expect(base.map(f => `${f.atMs}${f.reason[0]}`)).toEqual(['1000s', '3100s', '7250s', '12000s', '17000s', '19500e']);
    const plan = addPriorityFrames(base, { durationMs: 20_000, scenes: [5300, 10_300, 15_300], marks: [7800, 12_800], maxScenes: 120 });
    expect(plan.map(f => `${f.atMs}${f.reason[0]}`)).toEqual(['1000s', '3100s', '5300s', '7800m', '10300s', '12800m', '15300s', '19500e']);
    expect(plan.filter(f => f.reason === 'scene').map(f => f.atMs)).toEqual([5300, 10_300, 15_300]);
    // A scene within 2 s of a mark gives way to it; marks within 2 s of each other keep the first; clocks past the end are held to it.
    expect(addPriorityFrames([], { durationMs: 20_000, scenes: [7000, 9000], marks: [8000, 9500, 25_000], maxScenes: 120 })).toEqual([
      { atMs: 8000, reason: 'mark' }, { atMs: 19_999, reason: 'mark' },
    ]);
  });

  it('caps scenes apart from the other frames, so a talkative hour does not thin them', () => {
    const talk = Array.from({ length: 600 }, (_, i) => seg(i * 6000, i * 6000 + 4000, 'x', 'me'));
    const scenes = Array.from({ length: 200 }, (_, i) => 1000 + i * 18_000);
    const base = planFrames(3_600_000, talk, { maxFrames: 80, intervalMs: 5000 });
    expect(base).toHaveLength(80);
    const plan = addPriorityFrames(base, { durationMs: 3_600_000, scenes: scenes.slice(0, 100), maxScenes: 120 });
    expect(plan.filter(f => f.reason === 'scene')).toHaveLength(100);
    const capped = addPriorityFrames(base, { durationMs: 3_600_000, scenes, maxScenes: 120 });
    const kept = capped.filter(f => f.reason === 'scene').map(f => f.atMs);
    expect(kept).toHaveLength(120);
    // Thinned evenly, keeping the first and the last.
    expect([kept[0], kept.at(-1)]).toEqual([scenes[0], scenes.at(-1)]);
    expect(capped.length).toBeGreaterThan(120);
  });

  it('measures silence from the union of both voices, so no "nothing said" frame lands inside a line someone talks over', () => {
    const { segments } = mergeVoices([seg(12_000, 14_000, 'Mm-hm.')], [seg(10_000, 30_000, 'Let me explain the whole plan.'), seg(40_000, 42_000, 'Questions?')]);
    expect(silences(segments, 59_500)).toEqual([{ from: 0, to: 10_000 }, { from: 30_000, to: 40_000 }, { from: 42_000, to: 59_500 }]);
    const intervals = planFrames(60_000, segments, { maxFrames: 80, intervalMs: 5000 }).filter(f => f.reason === 'interval').map(f => f.atMs);
    expect(intervals.filter(t => t > 10_000 && t < 30_000)).toEqual([]);
    expect(intervals).toEqual([5000, 35_000, 47_000, 52_000, 57_000]);
  });

  it('plans no frame where the screen capture stopped, one each side, and shows a mark there by the picture before', () => {
    const gaps = [{ fromMs: 5000, toMs: 12_000 }];
    expect([4999, 5000, 11_999, 12_000].map(t => inVideoGap(t, gaps))).toEqual([false, true, true, false]);
    expect(inVideoGap(90_000, [{ fromMs: 15_000 }])).toBe(true);
    expect(inVideoGap(90_000, undefined)).toBe(false);
    expect([markFrameMs(7800, gaps), markFrameMs(4000, gaps), markFrameMs(12_000, gaps), markFrameMs(20, [{ fromMs: 0 }])]).toEqual([4999, 4000, 12_000, 0]);

    // The segment at 7.25 s is inside; the last picture before (4.5 s) gives way to the line at 3.1 s, the first after to the line at 12 s.
    const base = planFrames(20_000, lines, { maxFrames: 80, intervalMs: 5000, gaps });
    expect(base.map(f => `${f.atMs}${f.reason[0]}`)).toEqual(['1000s', '3100s', '12000s', '17000s', '19500e']);
    // A scene inside is the black going in; the one where the picture comes back stays. The mark at 7.8 s is shown by the picture before.
    const plan = addPriorityFrames(base, { durationMs: 20_000, scenes: [5000, 10_300, 12_000], marks: [7800], maxScenes: 120, gaps });
    expect(plan.map(f => `${f.atMs} ${f.reason}`)).toEqual(['1000 segment', '4999 mark', '12000 scene', '17000 segment', '19500 edge']);
    for (const frame of plan) expect(inVideoGap(frame.atMs, gaps), `${frame.atMs}`).toBe(false);

    // A gap that never ended: nothing after it, but its last picture before.
    expect(planFrames(20_000, lines, { maxFrames: 80, intervalMs: 5000, gaps: [{ fromMs: 15_000 }] }).map(f => `${f.atMs}${f.reason[0]}`))
      .toEqual(['1000s', '3100s', '7250s', '12000s', '14500e']);
    // A gap past the end of the recording adds nothing.
    expect(planFrames(20_000, lines, { maxFrames: 80, intervalMs: 5000, gaps: [{ fromMs: 1_111_000, toMs: 1_114_500 }] })).toEqual(planFrames(20_000, lines, { maxFrames: 80, intervalMs: 5000 }));

    const said = [{ fromMs: 1_111_000, toMs: 1_114_500, reason: 'Stream was stopped by the system' }, { fromMs: 2_401_000, reason: 'Stream was stopped by the system' }];
    expect(gapsText(said)).toBe('from 18:31 to 18:34, from 40:01 to the end');
    expect(gapsText(said, true)).toBe('from 18:31 to 18:34 (Stream was stopped by the system); from 40:01 to the end (Stream was stopped by the system)');
  });

  it('plans frames over the picture, which can end before the sound', () => {
    expect(frameSpanMs(20_000)).toBe(20_000);
    expect(frameSpanMs(20_000, 9900)).toBe(9901);
    expect(frameSpanMs(20_000, 25_000)).toBe(20_000);
    const plan = addPriorityFrames(planFrames(frameSpanMs(20_000, 9900), [seg(16_000, 18_000, 'After the screen stopped.', 'me')], { maxFrames: 80, intervalMs: 5000 }), { durationMs: frameSpanMs(20_000, 9900), marks: [15_000], maxScenes: 10 });
    expect(Math.max(...plan.map(p => p.atMs))).toBe(9900);
    expect(plan.at(-1)).toEqual({ atMs: 9900, reason: 'mark' });
    // From ffprobe's packets, which come in decode order, on the clock -ss seeks on.
    expect(parseVideoEnd('pts_time=0.000000\npts_time=4.000000\npts_time=2.000000\npts_time=N/A\nstart_time=0.000000\n')).toBe(4000);
    expect(parseVideoEnd('pts_time=10.5\npts_time=12.3\nstart_time=0.5\n')).toBe(11_800);
    expect(parseVideoEnd('start_time=0.000000\n')).toBeUndefined();
  });

  it('captions scene and mark thumbnails with their reason', () => {
    expect(frameLabel({ atMs: 65_000, reason: 'scene' })).toBe('01:05 scene');
    expect(frameLabel({ atMs: 65_000, reason: 'mark' })).toBe('01:05 mark');
  });
});

describe('markers for calls', () => {
  it('finds only deliberate cues in a call', () => {
    const found = findMarkers([seg(0, 1, 'Action item for me: send the deck.'), seg(2, 3, "That's great, and that's wrong."), seg(4, 5, 'Flag this for later.'), seg(6, 7, 'Make a note that it moved.')], CALL_CUES);
    expect(found.map(m => [m.kind, m.cue])).toEqual([['note', 'action item'], ['note', 'flag this'], ['note', 'make a note']]);
  });

  it('turns marks into note markers with their note, or the line being said and who said it', () => {
    const lines = [seg(1000, 3000, 'Shall we start?', 'me'), seg(2500, 4000, 'Yes, go ahead.', 'others')];
    expect(markMarkers([{ atMs: 2800 }, { atMs: 9000, note: 'flag this' }, { atMs: 30_000 }, { atMs: 99_000 }], lines, 40_000)).toEqual([
      { atMs: 2800, endMs: 2800, kind: 'note', cue: 'mark', text: 'Others: Yes, go ahead.' },
      { atMs: 9000, endMs: 9000, kind: 'note', cue: 'mark', text: 'flag this' },
      { atMs: 30_000, endMs: 30_000, kind: 'note', cue: 'mark', text: 'marked; nothing was being said' },
      { atMs: 39_999, endMs: 39_999, kind: 'note', cue: 'mark', text: 'marked; nothing was being said' },
    ]);
    expect(markMarkers([{ atMs: 6000 }], lines)[0].text).toBe('Others: Yes, go ahead.');
  });
});

describe('storyboard for calls', () => {
  const segments = [seg(0, 2000, 'Can everyone see my screen?', 'me'), seg(2500, 3700, 'Yes, I can see it now.', 'others'), seg(6000, 8500, 'Action item for me: send the deck.', 'me')];
  const frames = [
    { file: '0001_00m01s.jpg', atMs: 1000, reason: 'segment' as const },
    { file: '0002_00m05s.jpg', atMs: 5300, reason: 'scene' as const, full: 'full/0002_00m05s.jpg' },
    { file: '0003_00m07s.jpg', atMs: 7800, reason: 'mark' as const, full: 'full/0003_00m07s.jpg' },
    { file: '0004_00m12s.jpg', atMs: 12_800, reason: 'mark' as const, full: 'full/0004_00m12s.jpg' },
  ];
  const markers = [
    { atMs: 6000, endMs: 8500, kind: 'note' as const, cue: 'action item', text: 'Action item for me: send the deck.' },
    { atMs: 7800, endMs: 7800, kind: 'note' as const, cue: 'mark', text: 'Me: Action item for me: send the deck.' },
    { atMs: 12_800, endMs: 12_800, kind: 'note' as const, cue: 'mark', text: 'flag this' },
  ];

  it('says what the call was, outlines its scenes, and labels every line', () => {
    const manifest = callManifest();
    const md = storyboardMarkdown({ manifest, segments, frames, markers, requests: [], droppedBleed: 1 });
    expect(md).toContain('**A recorded call:** Google Meet abc-defg-hij in arc.');
    expect(md).toContain('- When: 2026-11-05, 11:00:02 UTC to 11:52:15 UTC (52:13); stopped: left the call. Recording 00:20.');
    expect(md).toContain("- Speakers: Me (the microphone, the person who recorded the call), 2 lines; Others (the call's sound, everyone else), 1 line. 1 of Me's lines was dropped as Others heard through the speakers.");
    expect(md).toContain('- Screen: recorded (a 1920x1243 display, 3 apps left out); 1 scene change, 4 frames.');
    expect(md).toContain('- Marks: 2, at 00:07, 00:12 "flag this".');
    expect(md).toContain('- Told the others they were being recorded: unknown.');
    expect(md).toContain('## Scenes\n\nWhere the screen changed, with its frame and the line being said at the time; the full transcript follows.\n\n- [00:05] frames/full/0002_00m05s.jpg: Others: Yes, I can see it now.\n');
    expect(md).toContain('## Lines and frames');
    expect(md).toContain('[00:00] Me: Can everyone see my screen?\n- 00:01 frames/0001_00m01s.jpg\n');
    expect(md).toContain('[00:02] Others: Yes, I can see it now.\n- 00:05 frames/0002_00m05s.jpg, scene change, full size frames/full/0002_00m05s.jpg\n');
    expect(md).toContain('[00:06] Me: Action item for me: send the deck. {note}\n- 00:07 frames/0003_00m07s.jpg, mark, full size frames/full/0003_00m07s.jpg\n- 00:12 frames/0004_00m12s.jpg, mark "flag this", full size frames/full/0004_00m12s.jpg');
    // A spoken cue is shown on its line; a mark is never taken for one.
    expect(md).not.toContain('Others: Yes, I can see it now. {note}');
    expect(md).not.toContain(voiceNote('both'));
  });

  it('notes marks between lines, and says plainly when the screen or the far end is missing', () => {
    const manifest = callManifest({ call: { ...fixture.call, video: 'none', videoNote: 'screen recording was not allowed', farEnd: 'silent', short: true, cut: true, endedAt: undefined, stopReason: undefined } }, { hasVideo: false, width: undefined, height: undefined });
    const md = storyboardMarkdown({ manifest, segments: [...segments, seg(14_000, 15_000, 'Bye.', 'me')], frames: [], markers, requests: [] });
    expect(md).toContain('- When: 2026-11-05, 11:00:02 UTC to unknown; stopped: cut off.');
    expect(md).toContain('- Screen: **not recorded.** The screen was not recorded (screen recording was not allowed), so there are no frames; this is the sound alone.');
    expect(md).toContain("- **The call's sound was silent:**");
    expect(md).toContain('- **Short:**');
    expect(md).toContain('- **Cut off:**');
    expect(md).toContain('(00:12: marked: flag this)\n\n[00:14] Me: Bye.');
    expect(md).not.toContain('## Scenes');
    expect(callHeader(manifest, manifest.source.call!, [], [])).toContain('- Speakers: none transcribed (transcribe step: done).');
    // A recording of sound alone that is not a call says so too.
    const plain = storyboardMarkdown({ manifest: callManifest({ call: undefined, marks: undefined }, { hasVideo: false, voice: 'mic' }), segments: [seg(0, 1000, 'hello')], frames: [], markers: [], requests: [] });
    expect(plain).toContain('**Sound only.** The file has no video stream: the screen was not recorded, so there are no frames.');
  });

  it('shows the recorder\'s notes on a call that was recorded, without calling it cut off', () => {
    const note = 'the microphone stopped: the device went away at 12:04; the microphone started again on MacBook Pro Microphone at 12:06';
    const manifest = callManifest({ call: { ...fixture.call, videoNote: note } });
    const md = storyboardMarkdown({ manifest, segments, frames: [], markers: [], requests: [] });
    expect(md).toContain(`- Recorder's notes: ${note}.`);
    expect(md).toContain('stopped: left the call.');
    expect(md).not.toContain('Cut off');
    expect(callLines(manifest, manifest.source.call!)).toContain(`call notes ${note}`);
    // Without the screen, the note is already in the Screen line and is not repeated.
    const screenless = callManifest({ call: { ...fixture.call, video: 'none', videoNote: 'screen recording was not allowed' } }, { hasVideo: false });
    expect(storyboardMarkdown({ manifest: screenless, segments, frames: [], markers: [], requests: [] })).not.toContain("Recorder's notes");
  });

  it('says a call\'s times in UTC whatever offset its metadata was written with', () => {
    const manifest = callManifest({ call: { ...fixture.call, startedAt: '2026-11-05T00:30:02+01:00', endedAt: '2026-11-05T01:10:02+01:00' } });
    expect(callHeader(manifest, manifest.source.call!, [], []).join('\n')).toContain('- When: 2026-11-04, 23:30:02 UTC to 00:10:02 UTC (40:00);');
  });

  it('says where the screen capture stopped and came back, and nothing when it never stopped', () => {
    const manifest = callManifest();
    const header = callHeader(manifest, manifest.source.call!, [], []);
    expect(header).toContain("- **No picture** from 18:31 to 18:34 (Stream was stopped by the system): the screen was not being captured there and the file is black, so there are no frames and no names from Meet's speaking ring in that stretch; the sound goes on.");
    const steady = callManifest({ call: { ...fixture.call, videoGaps: undefined } });
    expect(callHeader(steady, steady.source.call!, [], []).join('\n')).not.toContain('No picture');
    expect(callLines(steady, steady.source.call!).join('\n')).not.toContain('no picture');
    // Without the screen there is nothing to say about gaps in it.
    const screenless = callManifest({ call: { ...fixture.call, video: 'none' } }, { hasVideo: false });
    expect(callHeader(screenless, screenless.source.call!, [], []).join('\n')).not.toContain('No picture');
  });

  it('shows the call on polycap show', () => {
    const manifest = callManifest();
    expect(callLines(manifest, manifest.source.call!, { segments, bleedDropped: 1 })).toEqual([
      'call Google Meet abc-defg-hij in arc  2026-11-05T11:00:02.120Z to 2026-11-05T11:52:15.480Z (52:13)  stopped: left the call',
      'call screen recorded (1920x1243) · far end heard · told unknown',
      'call no picture from 18:31 to 18:34 (Stream was stopped by the system)',
      'marks [00:07], [00:12] flag this',
      "speakers Me 2 lines, Others 1 line (1 of Me's dropped as bleed)",
    ]);
  });
});

describe('summary for calls', () => {
  const segments = [seg(0, 2000, 'Can everyone see my screen?', 'me'), seg(2500, 3700, 'Yes. Send the deck by Friday.', 'others')];
  it('sends each line with its speaker, and grounds a quote that kept the speaker\'s name', () => {
    expect(transcriptForSummary(segments)).toBe('[L1] Me: Can everyone see my screen?\n[L2] Others: Yes. Send the deck by Friday.');
    const grounded = groundRequests([
      { line: 2, quote: 'Others: Send the deck by Friday', kind: 'change', request: 'Me to send the deck by Friday' },
      { line: 1, quote: '[L1] Me: can everyone see my screen', kind: 'question', request: 'Me asks whether the screen is visible' },
    ], segments);
    expect(grounded.rejected).toEqual([]);
    expect(grounded.requests.map(r => [r.atMs, r.quote])).toEqual([[0, 'can everyone see my screen'], [2500, 'Send the deck by Friday']]);
  });
});

describe('lines said over silence', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: -0.0213', '[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 3.52',
    'size=N/A time=00:00:20.00', '[silencedetect @ 0x2] silence_start: 10', '[silencedetect @ 0x2] silence_end: 16.000021 | silence_duration: 6.000021',
    '[silencedetect @ 0x2] silence_start: 18.25',
  ].join('\n');

  it('reads silencedetect\'s stretches, one still open at the end running to the end', () => {
    expect(parseSilences(stderr)).toEqual([{ startMs: 0, endMs: 3500 }, { startMs: 10_000, endMs: 16_000 }, { startMs: 18_250, endMs: Number.POSITIVE_INFINITY }]);
    expect(parseSilences('nothing here')).toEqual([]);
  });

  it('drops a line at least 80% inside silence, and keeps one that is mostly speech', () => {
    const quiet = parseSilences(stderr);
    expect(silentShare(seg(11_000, 15_000, 'Thank you.'), quiet)).toBe(1);
    expect(silentShare(seg(15_000, 17_000, 'Right, so.'), quiet)).toBe(0.5);
    expect(silentShare(seg(12_000, 12_000, 'you'), quiet)).toBe(1);
    expect(silentShare(seg(17_000, 17_000, 'you'), quiet)).toBe(0);
    const lines = [seg(1000, 2000, 'Thanks for watching!'), seg(3000, 5000, 'Shall we start?'), seg(11_000, 15_000, 'Thank you.'), seg(15_000, 17_000, 'Right, so.'), seg(19_000, 25_000, 'Thank you.')];
    expect(dropSilentLines(lines, quiet)).toEqual({ kept: [seg(3000, 5000, 'Shall we start?'), seg(15_000, 17_000, 'Right, so.')], dropped: 3 });
    expect(dropSilentLines(lines, [])).toEqual({ kept: lines, dropped: 0 });
  });
});

describe('lines that never rise above the room (2026-11-13)', () => {
  // ebur128 every 100 ms; its first readings, before the 400 ms window fills, are -120.7 and left out.
  const reading = (s: number, m: number) => `[Parsed_ebur128_0 @ 0x1] t: ${s}  TARGET:-23 LUFS    M: ${m} S: ${m}     I: -40.0 LUFS       LRA:   0.0 LU`;
  const room = (from: number, to: number, lufs: number) => Array.from({ length: Math.round((to - from) * 10) }, (_, i) => reading(Number((from + i / 10 + 0.1).toFixed(1)), lufs));

  it('reads momentary loudness and finds the background as its quietest tenth', () => {
    const readings = parseMomentary([reading(0.1, -120.7), reading(0.3, -120.7), reading(0.4, -48), 'size=N/A time=00:00:01', reading(0.5, -36.2), '[Parsed_ebur128_0 @ 0x1] Summary:', '    I:  -42.2 LUFS'].join('\n'));
    expect(readings).toEqual([{ atMs: 400, lufs: -48 }, { atMs: 500, lufs: -36.2 }]);
    expect(loudnessFloor(readings)).toBe(-48);
    expect(loudnessFloor([])).toBeUndefined();
    // A reading at t covers t-400 to t, so a line from 0 to 100 ms is in the reading at 400 ms alone.
    expect(linePeak(seg(0, 100, 'a'), readings)).toBe(-48);
    expect(linePeak(seg(0, 450, 'a'), readings)).toBe(-36.2);
    expect(linePeak(seg(450, 460, 'b'), readings)).toBe(-36.2);
    expect(linePeak(seg(1000, 2000, 'c'), readings)).toBeUndefined();
  });

  it('drops a line under 14 dB over the background, keeps speech, and keeps anything louder than -30 LUFS', () => {
    // SPOT-1: room tone at -48 with a television's -36; then the narrator at -27; then a loud room where speech is -25.
    const quiet = parseMomentary([...room(0, 8, -48), ...room(8, 9, -36), ...room(9, 11, -27)].join('\n'));
    const cake = seg(8000, 8600, 'I am going to show you how to make a cake.'), mine = seg(9200, 10_500, 'Testing one two three.');
    expect(dropFaintLines([cake, mine], quiet)).toEqual({ kept: [mine], dropped: 1 });
    const loud = parseMomentary([...room(0, 8, -32), ...room(8, 10, -25)].join('\n'));
    expect(dropFaintLines([seg(8200, 9500, 'Over the fan.')], loud).dropped).toBe(0);
    expect(dropFaintLines([cake], [])).toEqual({ kept: [cake], dropped: 0 });
  });
});

describe('session refs from the Mac app', () => {
  it('takes a whole session id as exactly that session, never another one it is the start of', async () => {
    const cli = await testCli();
    const file = join(cli.config.root, 'polydance-mac-20261105-110002.mp4');
    await writeFile(file, 'not really a video');
    const made = async () => (await createSession(cli.config, { localFile: file, originalName: 'polydance-mac-20261105-110002.mp4', bytes: 18, recordedAt: new Date(2026, 10, 5, 11, 0, 2), source: { kind: 'import', call: fixture.call } })).manifest.id;
    const [first, second] = [await made(), await made()];
    expect(second).toBe(`${first}-2`);
    expect((await resolveSession(cli.config, first)).manifest.id).toBe(first);
    // The first one gone, its exact id does not fall through to the "-2" beside it.
    const { rm } = await import('node:fs/promises');
    await rm(join(cli.config.sessions, first), { recursive: true });
    await expect(resolveSession(cli.config, first)).rejects.toThrow(`No session ${first}. Run \`polycap list\`.`);
    // Short refs people type still match.
    expect((await resolveSession(cli.config, '_meet')).manifest.id).toBe(second);
    expect((await resolveSession(cli.config, '2026-11-05T11')).manifest.id).toBe(second);
  });
});

describe('scene settings', () => {
  it('are for calls by default, with a threshold for screens, and refuse nonsense', () => {
    const config = loadConfig({ POLYCAP_ROOT: '/tmp/x' });
    expect([config.scenes, config.sceneThreshold, config.maxScenes]).toEqual(['calls', 0.03, 120]);
    expect(loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SCENES: 'all', POLYCAP_SCENE_THRESHOLD: '0.12', POLYCAP_MAX_SCENES: '40' })).toMatchObject({ scenes: 'all', sceneThreshold: 0.12, maxScenes: 40 });
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SCENES: 'some' })).toThrow(/POLYCAP_SCENES=some/);
    for (const bad of ['0', '1', '1.5', '-0.1', 'abc', '1e-2']) expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_SCENE_THRESHOLD: bad }), bad).toThrow(/POLYCAP_SCENE_THRESHOLD/);
    expect(() => loadConfig({ POLYCAP_ROOT: '/tmp/x', POLYCAP_MAX_SCENES: '0' })).toThrow(/POLYCAP_MAX_SCENES/);
  });
});

describe('a call with one voice', () => {
  it('is never described as an app\'s voice-over', () => {
    const lines = [seg(0, 1000, 'Can you hear me?', 'others')];
    expect(transcriptMarkdown('call', { engine: 'whisper-cpp', segments: lines }, 2000, 'app')).not.toContain("the app's own sound");
    expect(transcriptMarkdown('walk', { engine: 'whisper-cpp', segments: [seg(0, 1000, 'Welcome to the lesson.')] }, 2000, 'app')).toContain("the app's own sound");
    const manifest = callManifest({ audioTracks: ['app'] }, { audioChannels: [2], voice: 'app' });
    const md = storyboardMarkdown({ manifest, segments: lines, frames: [], markers: [], requests: [] });
    expect(md).not.toContain("the app's own sound");
    expect(md).toContain("- Speakers: Others (the call's sound, everyone else), 1 line.");
  });
});
