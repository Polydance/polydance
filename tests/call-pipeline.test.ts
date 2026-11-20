/**
 * A call from the Mac end to end (docs/MAC.md T1 to P8), with real ffmpeg, the fake whisper-cli keyed
 * on each track's wav and the fake Messages API: a synthetic recording whose screen changes colour,
 * a mono mic track and a stereo call track, imported with its metadata and processed. Also a call
 * whose screen was not recorded, calls whose picture ends before their sound, a mic track that starts
 * late, a far end that was silent, a line said over silence, and the CLI as the Mac app runs it.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importRecording } from '../src/commands/import.js';
import { frames, show, transcript } from '../src/commands/inspect.js';
import { exportCommand } from '../src/commands/export.js';
import { processCommand } from '../src/commands/process.js';
import { exec } from '../src/exec.js';
import { exists, readJson } from '../src/fsx.js';
import { extractAudio } from '../src/pipeline/audio.js';
import { extractFrames, framesFileSchema } from '../src/pipeline/frames.js';
import { probeVideoEnd } from '../src/pipeline/probe.js';
import { markersFileSchema } from '../src/pipeline/markers.js';
import { speakersFileSchema } from '../src/pipeline/speakers.js';
import { transcriptFileSchema } from '../src/pipeline/transcribe.js';
import { isPending, loadSession, requestsFileSchema } from '../src/session.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { fakeTools, hasFfmpeg } from './helpers/fake-tools.js';

const ffmpeg = await hasFfmpeg();
const describeWithFfmpeg = ffmpeg ? describe : describe.skip;
if (!ffmpeg) console.warn('ffmpeg not installed: skipping end-to-end call tests');

const fixture = JSON.parse(await readFile(new URL('./fixtures/mac-call-meta.json', import.meta.url), 'utf8'));
const whisper = (lines: [number, number, string][]) => JSON.stringify({ result: { language: 'en' }, transcription: lines.map(([from, to, text]) => ({ offsets: { from, to }, text: ` ${text}` })) });

/**
 * 20 s as the Mac app records a call: the screen (red, blue, green, white for 5 s each, so three
 * scene changes), then the mic in mono, then the call's sound in stereo; or, without the screen, the
 * two audio tracks alone.
 */
async function makeCall(path: string, screen: boolean): Promise<void> {
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=20,aformat=channel_layouts=stereo'];
  if (!screen) { await exec('ffmpeg', ['-y', '-v', 'error', ...audio, '-map', '0:a', '-map', '1:a', '-c:a', 'aac', path]); return; }
  const colours = ['red', 'blue', 'green', 'white'].flatMap(c => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x200:r=5:d=5`]);
  await exec('ffmpeg', ['-y', '-v', 'error', ...colours, ...audio, '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
    '-map', '[v]', '-map', '4:a', '-map', '5:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

describeWithFfmpeg('a call from the Mac, end to end', () => {
  let tools: Awaited<ReturnType<typeof fakeTools>>;
  let work: string;
  const meta = (call: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
    ...fixture, marks: [{ atMs: 7800 }, { atMs: 12_800, note: 'flag this' }],
    // The fixture's gap is 18 minutes in, past these 20 s recordings: left out unless a test gives one.
    call: { ...fixture.call, startedAt: '2026-11-05T11:00:02.120Z', endedAt: '2026-11-05T11:00:22.120Z', videoGaps: undefined, ...call }, ...rest,
  });
  beforeAll(async () => {
    tools = await fakeTools();
    work = await mkdtemp(join(tmpdir(), 'polycap-call-'));
    const voices = join(work, 'whisper');
    await mkdir(voices);
    // Me, then the far end heard through the speakers at 2.6 s, which is dropped as bleed.
    await writeFile(join(voices, 'mic.json'), whisper([[0, 2000, 'Okay, can everyone see my screen?'], [2600, 3800, 'Yes, I can see it now.'], [6000, 8500, 'Action item for me: send the deck by Friday.'], [16_000, 18_000, 'Thanks, talk soon.']]));
    // Others: their "flag this" is not a marker, since only Me's cues count.
    await writeFile(join(voices, 'app.json'), whisper([[2500, 3700, 'Yes, I can see it now.'], [11_000, 13_000, "Let's flag this for the board."], [16_100, 17_500, 'Yes, thanks.']]));
    process.env.FAKE_WHISPER_DIR = voices;
    process.env.FAKE_WHISPER_JSON = new URL('./fixtures/whisper-output.json', import.meta.url).pathname;
  });
  afterAll(() => { delete process.env.FAKE_WHISPER_DIR; delete process.env.FAKE_WHISPER_JSON; });

  it('transcribes both voices, takes frames where the screen changed and where it was marked, and writes the call\'s storyboard', async () => {
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Deck by Friday', summary: 'Agrees the deck goes out by Friday.', requests: [{ line: 3, quote: 'Me: send the deck by Friday', kind: 'change', request: 'Me to send the deck by Friday' }] })) }));
    const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_FRAME_WIDTH: '160', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const file = join(work, 'polydance-mac-20261105-110002.mp4');
    await makeCall(file, true);
    const metaFile = join(work, 'call.meta.json');
    await writeFile(metaFile, JSON.stringify(meta()));
    const session = await importRecording(cli, file, { meta: metaFile, tracks: 'mic,app' });
    expect(session.manifest.id).toMatch(/_meet$/);
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    const dir = session.dir;

    expect(manifest.steps).toMatchObject({ probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' }, frames: { status: 'done' }, markers: { status: 'done' }, summary: { status: 'done' }, storyboard: { status: 'done' } });
    expect(manifest.steps.pointing).toMatchObject({ status: 'skipped', note: 'POLYCAP_POINTING is none' });
    // No reader built (testCli points at none): Others stay Others, and the step says how to build it.
    expect(manifest.steps.speakers.status).toBe('skipped');
    expect(manifest.steps.speakers.note).toMatch(/^the speaker reader is not built at .*no-speaker-reader: npm run mac -- speakers$/);
    expect(manifest.media).toMatchObject({ hasVideo: true, width: 320, audioChannels: [1, 2], voice: 'both' });
    expect(manifest.source.call).toEqual(meta().call);
    expect(manifest.steps.audio.note).toBe("track 1, the microphone (Me), and track 2, the call's sound (Others), each transcribed");
    expect(manifest.steps.transcribe.note).toBe("4 segments from the microphone and 3 from the call's sound, as 6 lines; 1 microphone line dropped as the far end heard through the speakers");

    const lines = await readJson(join(dir, 'transcript.json'), transcriptFileSchema);
    expect(lines).toMatchObject({ voice: 'both', bleedDropped: 1 });
    expect(lines.segments.map(s => [s.startMs, s.speaker, s.text])).toEqual([
      [0, 'me', 'Okay, can everyone see my screen?'], [2500, 'others', 'Yes, I can see it now.'], [6000, 'me', 'Action item for me: send the deck by Friday.'],
      [11_000, 'others', "Let's flag this for the board."], [16_000, 'me', 'Thanks, talk soon.'], [16_100, 'others', 'Yes, thanks.'],
    ]);
    expect(await readFile(join(dir, 'transcript.md'), 'utf8')).toContain('[00:00] Me: Okay, can everyone see my screen?\n[00:02] Others: Yes, I can see it now.\n');

    // Scenes 300 ms after each colour change, marks where pressed, and only line frames they do not
    // cover; the closing edge half a second before the last frame (5 fps, so at 19.8 s), not the sound's end.
    expect(manifest.media.videoEndMs).toBe(19_800);
    const framesFile = await readJson(join(dir, 'frames.json'), framesFileSchema);
    expect(framesFile.frames.map(f => [f.atMs, f.reason, Boolean(f.full)])).toEqual([
      [1000, 'segment', false], [3100, 'segment', false], [5300, 'scene', true], [7800, 'mark', true], [10_300, 'scene', true], [12_800, 'mark', true], [15_300, 'scene', true], [19_301, 'edge', false],
    ]);
    expect(manifest.steps.frames.note).toMatch(/^8 frames \(5 also full size\), from transcript, 3 at scene changes, 2 at marks/);
    const pixel = async (jpg: string) => (await exec('ffmpeg', ['-v', 'error', '-i', join(dir, 'frames', jpg), '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 })).stdout;
    const [blue, white] = [framesFile.frames[2], framesFile.frames[6]];
    expect([...Buffer.from(await pixel(blue.full!), 'latin1')].map(v => v > 128)).toEqual([false, false, true]);
    expect([...Buffer.from(await pixel(white.file), 'latin1')].map(v => v > 128)).toEqual([true, true, true]);
    const width = async (jpg: string) => (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', join(dir, 'frames', jpg)])).stdout.trim();
    expect([await width(blue.file), await width(blue.full!)]).toEqual(['160', '320']);

    // Me's spoken cue and both marks; Others' "flag this" is not one.
    const markers = (await readJson(join(dir, 'markers.json'), markersFileSchema)).markers;
    expect(markers.map(m => [m.atMs, m.cue, m.text])).toEqual([
      [6000, 'action item', 'Action item for me: send the deck by Friday.'], [7800, 'mark', 'Me: Action item for me: send the deck by Friday.'], [12_800, 'mark', 'flag this'],
    ]);
    expect(manifest.steps.markers.note).toBe("3 markers (2 from marks); spoken cues from Me's lines only");

    // The model is told it is a call and reads whose each line is.
    const body = claude.calls[0].body;
    expect(String(body.system)).toContain('You index recorded video calls');
    expect(JSON.stringify(body.messages)).toContain('<call>A Google Meet call of under a minute, recorded by Me.</call>');
    expect(JSON.stringify(body.messages)).toContain('[L1] Me: Okay, can everyone see my screen?\\n[L2] Others: Yes, I can see it now.');
    expect((await readJson(join(dir, 'requests.json'), requestsFileSchema)).requests).toEqual([{ atMs: 6000, text: 'Me to send the deck by Friday', kind: 'change', quote: 'send the deck by Friday' }]);
    expect(manifest.title).toBe('Deck by Friday');

    const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('**Deck by Friday.** Agrees the deck goes out by Friday.\n\n**A recorded call:** Google Meet abc-defg-hij in arc.\n');
    expect(storyboard).toContain('- Screen: recorded (a 1920x1243 display, 3 apps left out); 3 scene changes, 8 frames.');
    expect(storyboard).toContain("1 of Me's lines was dropped as Others heard through the speakers.");
    expect(storyboard).toContain('## Scenes\n\nWhere the screen changed, with its frame and the line being said at the time; the full transcript follows.\n\n'
      + '- [00:05] frames/full/0003_00m05s.jpg: Others: Yes, I can see it now.\n- [00:10] frames/full/0005_00m10s.jpg: Me: Action item for me: send the deck by Friday.\n- [00:15] frames/full/0007_00m15s.jpg: Others: Let\'s flag this for the board.\n');
    expect(storyboard).toContain('[00:06] Me: Action item for me: send the deck by Friday. {note}\n- change: Me to send the deck by Friday\n- 00:07 frames/0004_00m07s.jpg, mark, full size frames/full/0004_00m07s.jpg\n- 00:10 frames/0005_00m10s.jpg, scene change, full size frames/full/0005_00m10s.jpg\n');
    // Each mark is shown once, by its frame.
    expect(storyboard).toContain('[00:11] Others: Let\'s flag this for the board.\n- 00:12 frames/0006_00m12s.jpg, mark "flag this", full size frames/full/0006_00m12s.jpg\n');
    expect(storyboard).not.toContain(': marked');

    cli.lines.length = 0;
    await show(cli, session.manifest.id);
    expect(cli.lines).toContain('call Google Meet abc-defg-hij in arc  2026-11-05T11:00:02.120Z to 2026-11-05T11:00:22.120Z (00:20)  stopped: left the call');
    expect(cli.lines).toContain('marks [00:07], [00:12] flag this');
    expect(cli.lines).toContain("speakers Me 3 lines, Others 3 lines (1 of Me's dropped as bleed)");
    expect(cli.lines).toContain("voice both: Me is the microphone, Others the call's sound");
    cli.lines.length = 0;
    await transcript(cli, session.manifest.id, { from: '0:11', to: '0:12' });
    expect(cli.lines).toEqual(["[00:11] Others: Let's flag this for the board."]);

    // Redoing the frames alone gives the same frames, and the storyboard follows.
    const [again] = await processCommand(cli, { refs: [session.manifest.id], force: false, step: 'frames' });
    expect((await readJson(join(dir, 'frames.json'), framesFileSchema)).frames.map(f => f.atMs)).toEqual(framesFile.frames.map(f => f.atMs));
    expect(again.steps.storyboard.at! >= again.steps.frames.at!).toBe(true);
    expect(isPending(again)).toBe(false);
    claude.close();
  });

  it('names Others\' lines from Meet\'s speaking ring, keeps the names out of session.json, and takes them away again', async () => {
    // What the reader saw: Me's own tile (Ada) while Me speaks, Grace for her two lines, Alan for his.
    // Beside a shared screen her name is cut short: the reader says so and leaves the ellipsis off.
    const ringed = (from: number, to: number, name: string, truncated?: true) => Array.from({ length: (to - from) / 500 + 1 }, (_, i) => ({ atMs: from + i * 500, rings: [{ box: { x: 10, y: 10, width: 100, height: 80 }, name, ...(truncated ? { truncated } : {}), fresh: i === 0 }] }));
    const samples = [...ringed(0, 2000, 'Ada Lovelace'), ...ringed(2500, 4000, 'Grace Hopper'), ...ringed(6000, 8500, 'Ada Lovelace'), ...ringed(11_000, 13_500, 'Alan Turing'), ...ringed(16_000, 17_500, 'Grace Ho', true)];
    const reportFile = join(work, 'speakers-report.json'), argsFile = join(work, 'speakers-args.txt');
    await writeFile(reportFile, JSON.stringify({ version: 1, tool: 'polydance-speakers', width: 320, height: 200, everyMs: 500, sampled: 41, withRing: samples.length, namesRead: 5, elapsedMs: 900, samples }));
    process.env.FAKE_SPEAKERS_JSON = reportFile; process.env.FAKE_SPEAKERS_ARGS = argsFile;
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Seeing the screen', summary: 'Checks the screen is shared.', requests: [{ line: 6, quote: 'Grace Hopper: Yes, thanks', kind: 'change', request: 'Grace Hopper thanks everyone' }] })) }));
    const env = { POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_FRAME_WIDTH: '160', POLYCAP_SPEAKERS_BIN: tools.speakers, POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url };
    try {
      const cli = await testCli(env);
      const file = join(work, 'polydance-mac-20261105-120002.mp4');
      await makeCall(file, true);
      const metaFile = join(work, 'named.meta.json');
      await writeFile(metaFile, JSON.stringify(meta()));
      const session = await importRecording(cli, file, { meta: metaFile, tracks: 'mic,app' });
      const dir = session.dir;
      const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });

      expect(manifest.steps.speakers.status, manifest.steps.speakers.error).toBe('done');
      expect(manifest.steps.speakers.note).toBe("3 of 3 Others lines named from Meet's speaking ring, 2 people; 0 with more than one person ringed and 0 with no ring left as Others; unchecked: only 2 of Me's own lines had a ring; 25 of 41 frames showed someone speaking (ring), read in 1 s");
      expect((await readFile(argsFile, 'utf8')).trim()).toBe(`${join(dir, 'video.mp4')} --out ${join(cli.config.work, session.manifest.id, 'speakers-reader.json')}`);
      const lines = await readJson(join(dir, 'transcript.json'), transcriptFileSchema);
      expect(lines.segments.map(s => [s.startMs, s.speaker, s.name])).toEqual([
        [0, 'me', undefined], [2500, 'others', 'Grace Hopper'], [6000, 'me', undefined], [11_000, 'others', 'Alan Turing'], [16_000, 'me', undefined], [16_100, 'others', 'Grace Hopper'],
      ]);
      const md = await readFile(join(dir, 'transcript.md'), 'utf8');
      expect(md).toContain('[00:00] Me: Okay, can everyone see my screen?\n[00:02] Grace Hopper: Yes, I can see it now.\n');
      expect(md).toContain('Names: an Others line is given the name on the tile Meet ringed');
      const speakers = await readJson(join(dir, 'speakers.json'), speakersFileSchema);
      expect(speakers.me).toMatchObject({ name: 'Ada Lovelace', check: 'unchecked' });
      expect(speakers.people.map(p => [p.name, p.lines, p.readAs])).toEqual([['Ada Lovelace', 0, ['Ada Lovelace']], ['Grace Hopper', 2, ['Grace Ho', 'Grace Hopper']], ['Alan Turing', 1, ['Alan Turing']]]);
      // The others' names are in the bundle's own files, never in session.json (T2).
      expect(await readFile(join(dir, 'session.json'), 'utf8')).not.toMatch(/Grace|Alan|Ada/);

      // The summary reads the names, and a quote that starts with one is still grounded.
      expect(JSON.stringify(claude.calls[0].body.messages)).toContain('[L2] Grace Hopper: Yes, I can see it now.');
      expect((await readJson(join(dir, 'requests.json'), requestsFileSchema)).requests).toEqual([{ atMs: 16_100, text: 'Grace Hopper thanks everyone', kind: 'change', quote: 'Yes, thanks' }]);
      const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
      expect(storyboard).toContain("- Named from Meet's speaking ring: Grace Hopper, 2 lines; Alan Turing, 1 line.\n");
      expect(storyboard).toContain("[00:11] Alan Turing: Let's flag this for the board.");
      cli.lines.length = 0;
      await show(cli, session.manifest.id);
      expect(cli.lines).toContain('named Grace Hopper 2 lines, Alan Turing 1 line');

      // Turned off, the names go, and the summary and storyboard are made again without them.
      const off = await testCli({ ...env, POLYCAP_SPEAKERS: 'none', POLYCAP_ROOT: cli.config.root });
      const [unnamed] = await processCommand(off, { refs: [session.manifest.id], force: false, step: 'speakers' });
      expect(unnamed.steps.speakers).toMatchObject({ status: 'skipped', note: 'POLYCAP_SPEAKERS is none' });
      expect((await readJson(join(dir, 'transcript.json'), transcriptFileSchema)).segments.some(s => s.name)).toBe(false);
      expect(await exists(join(dir, 'speakers.json'))).toBe(false);
      expect(await readFile(join(dir, 'storyboard.md'), 'utf8')).not.toContain('Named from');
      expect(claude.calls).toHaveLength(2);
      expect(JSON.stringify(claude.calls[1].body.messages)).toContain('[L2] Others: Yes, I can see it now.');

      // A reader that fails is said, and no line is named.
      process.env.FAKE_SPEAKERS_FAIL = 'the video could not be read';
      const [failed] = await processCommand(cli, { refs: [session.manifest.id], force: false, step: 'speakers' });
      expect(failed.steps.speakers.status).toBe('failed');
      expect(failed.steps.speakers.error).toContain('the video could not be read');
      expect((await readJson(join(dir, 'transcript.json'), transcriptFileSchema)).segments.some(s => s.name)).toBe(false);
      expect(isPending(failed)).toBe(false);
    } finally {
      delete process.env.FAKE_SPEAKERS_JSON; delete process.env.FAKE_SPEAKERS_ARGS; delete process.env.FAKE_SPEAKERS_FAIL;
      claude.close();
    }
  });

  describe('a picture that ends before the sound', () => {
    const audio = (seconds: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds},aformat=channel_layouts=stereo`];
    const encode = ['-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
    /** Imports and processes a call file with the fake voices (lines to 18 s), and checks every frame is a picture there is. */
    const run = async (name: string, picture: string[], seconds: number, lastFrameMs: number, rest: Record<string, unknown> = {}, env: Record<string, string> = {}, call: Record<string, unknown> = {}) => {
      const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_FRAME_WIDTH: '160', ...env });
      const file = join(work, `${name}.mp4`);
      // No -shortest: the sound runs on after the picture, as the Mac's does.
      await exec('ffmpeg', ['-y', '-v', 'error', ...picture, ...audio(seconds), ...encode, file]);
      const metaFile = join(work, `${name}.meta.json`);
      await writeFile(metaFile, JSON.stringify(meta(call, rest)));
      const session = await importRecording(cli, file, { meta: metaFile });
      const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
      expect(manifest.steps.frames.status, manifest.steps.frames.error).toBe('done');
      expect(manifest.steps.frames.note).not.toMatch(/could not be grabbed/);
      expect(manifest.media.videoEndMs).toBe(lastFrameMs);
      // The closing frame used to be half a second before the file's end: after the picture's last frame.
      expect(manifest.media.durationMs! - 500).toBeGreaterThan(lastFrameMs);
      const { frames } = await readJson(join(session.dir, 'frames.json'), framesFileSchema);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame.atMs, frame.file).toBeLessThanOrEqual(lastFrameMs);
      expect(manifest.frameCount).toBe(frames.length);
      return { manifest, frames, dir: session.dir };
    };

    it('takes its frames up to the last one when the video is a second shorter than the sound', async () => {
      const { frames, manifest } = await run('endgap', ['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=10:duration=19'], 20, 18_900, { recordedAt: '2026-11-05T15:00:00.000Z' }, { POLYCAP_TRANSCRIBER: 'none' });
      expect(frames.at(-1)).toMatchObject({ atMs: 18_401, reason: 'edge' });
      // Under 2 s short is a still screen's last repeat, not worth a note.
      expect(manifest.steps.frames.note).not.toMatch(/picture ends/);
    });

    it('takes no frame after the screen stopped mid-call, and shows a later mark by the last picture', async () => {
      const { frames, manifest, dir } = await run('screen-stopped', ['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=10:duration=10'], 20, 9900, { recordedAt: '2026-11-05T15:10:00.000Z', marks: [{ atMs: 15_000, note: 'after the screen stopped' }] });
      expect(frames.at(-1)).toMatchObject({ atMs: 9900, reason: 'mark' });
      expect(manifest.steps.frames.note).toContain('; the picture ends at 00:09; no frames after it; 1 mark after the screen stopped, shown by the last picture');
      // The mark's note is still found for its frame, and the header says where the picture ends.
      const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
      expect(storyboard).toMatch(/- 00:09 frames\/\d{4}_00m09s\.jpg, mark "after the screen stopped"/);
      expect(storyboard).toMatch(/- Screen: recorded \(.*\); \d+ scene changes?, \d+ frames\. The picture ends at 00:09, before the sound: no frames after it\.\n/);
    });

    it('takes no frame where the screen capture stopped and came back, and shows a mark there by the picture before', async () => {
      // The Mac app writes black there (C14); polycap goes by the gap in the metadata whatever the file shows.
      const gap = { fromMs: 5000, toMs: 12_000, reason: 'Stream was stopped by the system' };
      const { frames, manifest, dir } = await run('screen-gap', ['-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=10:duration=19'], 20, 18_900,
        { recordedAt: '2026-11-05T15:30:00.000Z', marks: [{ atMs: 8000, note: 'while it was black' }] }, {}, { videoGaps: [gap] });
      expect(manifest.source.call?.videoGaps).toEqual([gap]);
      for (const frame of frames) expect(frame.atMs >= 5000 && frame.atMs < 12_000, `${frame.file} is inside the gap`).toBe(false);
      expect(frames.find(f => f.reason === 'mark')).toMatchObject({ atMs: 4999 });
      expect(manifest.steps.frames.note).toContain('; no picture from 00:05 to 00:12; no frames there; 1 mark while there was no picture, shown by the picture before');
      const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
      expect(storyboard).toContain("- **No picture** from 00:05 to 00:12 (Stream was stopped by the system): the screen was not being captured there and the file is black");
      expect(storyboard).toMatch(/- 00:04 frames\/\d{4}_00m04s\.jpg, mark "while it was black"/);
    });

    it('takes the closing frame on a still screen, whose last frame came a second before the format says it ends', async () => {
      // 1 fps, frames at 0 to 19 s, each a second long, so the file runs to 20 s while the picture's last frame is at 19.
      const { frames, manifest } = await run('still', ['-f', 'lavfi', '-i', 'color=c=red:s=320x200:r=1:d=20'], 19.5, 19_000, { recordedAt: '2026-11-05T15:20:00.000Z' });
      expect(manifest.media.durationMs).toBe(20_000);
      // Its lines run to 18 s, so the closing frame gives way to the last line's; all of them are pictures there are.
      expect(frames.at(-1)).toMatchObject({ atMs: 16_800, reason: 'segment' });
    });

    it('reads the picture\'s end from the packets, and a grab that fails costs that frame only', async () => {
      const file = join(work, 'grab.mp4');
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x100:r=1:d=4', ...audio(6), ...encode, file]);
      expect(await probeVideoEnd('ffprobe', file)).toBe(3000);
      const dir = join(work, 'grab-frames');
      // 3.5 s is inside the last frame's second but after its timestamp: ffmpeg writes nothing there.
      const { frames, failures } = await extractFrames('ffmpeg', file, dir, [{ atMs: 500, reason: 'edge' }, { atMs: 3500, reason: 'segment' }, { atMs: 3000, reason: 'edge' }], 160);
      expect(frames.map(f => [f.file, f.atMs])).toEqual([['0001_00m00s.jpg', 500], ['0002_00m03s.jpg', 3000]]);
      expect(failures).toEqual([{ atMs: 3500, full: false, error: expect.stringContaining('failed (exit') }]);
      await expect(extractFrames('ffmpeg', file, join(work, 'grab-none'), [{ atMs: 5000, reason: 'edge' }], 160)).rejects.toThrow(/none of the 1 planned frames could be grabbed/);
    });
  });

  it('puts a mic track that starts late on the file\'s clock, padded with silence in front, and a narration cut out of it too', async () => {
    const file = join(work, 'late-mic.mp4');
    // The mic starts 2 s into the file, as when it starts after the call's sound or after a permission prompt.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x100:rate=10:duration=6', '-itsoffset', '2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6,aformat=channel_layouts=stereo', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    const seconds = async (path: string) => Number((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])).stdout.trim());
    const meanDb = async (wav: string) => Number((await exec('ffmpeg', ['-hide_banner', '-t', '1.5', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'])).stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    const wav = join(work, 'late-mic.wav');
    await extractAudio('ffmpeg', file, wav, 0);
    expect(Math.abs(await seconds(wav) - await seconds(file))).toBeLessThan(0.05);
    expect(await meanDb(wav)).toBeLessThan(-80);
    // The narration as upload.ts cuts it, with -c copy, starts at the mic's offset; read with its own timestamps, it is padded too.
    const narration = join(work, 'late-narration.m4a');
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-vn', narration]);
    const narrated = join(work, 'late-narration.wav');
    await extractAudio('ffmpeg', narration, narrated, 0, { copyts: true });
    expect(Math.abs(await seconds(narrated) - await seconds(file))).toBeLessThan(0.05);
    expect(await meanDb(narrated)).toBeLessThan(-80);
    // A track that starts with the file is as long as before.
    await extractAudio('ffmpeg', file, wav, 1);
    expect(Math.abs(await seconds(wav) - 6)).toBeLessThan(0.05);
  });

  it('transcribes only Me when the far end was digital silence, and runs whisper with its call flags', async () => {
    const args = join(work, 'whisper-args.txt');
    process.env.FAKE_WHISPER_ARGS = args;
    try {
      const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model });
      const file = join(work, 'polydance-mac-20261105-160000.mp4');
      await makeCall(file, false);
      const metaFile = join(work, 'silent.meta.json');
      await writeFile(metaFile, JSON.stringify(meta({ video: 'none', farEnd: 'silent' }, { recordedAt: '2026-11-05T16:00:00.000Z', marks: [] })));
      const session = await importRecording(cli, file, { meta: metaFile });
      const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
      expect(manifest.media.voice).toBe('mic');
      expect(manifest.steps.audio.note).toBe("track 1, the microphone (Me); track 2, the call's sound, was digital silence (farEnd silent), so Others are not transcribed");
      expect(manifest.steps.transcribe).toMatchObject({ status: 'done', note: '4 segments' });
      const lines = (await readJson(join(session.dir, 'transcript.json'), transcriptFileSchema)).segments;
      expect(lines.map(l => l.speaker)).toEqual(['me', 'me', 'me', 'me']);
      // Whisper ran once, on the mic, with no carried-over context and non-speech suppressed.
      const runs = (await readFile(args, 'utf8')).trim().split('\n');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/-f \S*\/mic\.wav .* -mc 0 -sns$/);
      // A recording that is not a call is transcribed as before.
      const plain = join(work, 'clip.mp4');
      await makeCall(plain, true);
      const walk = await importRecording(cli, plain, { tracks: 'mic,app' });
      await processCommand(cli, { refs: [walk.manifest.id], force: false });
      const second = (await readFile(args, 'utf8')).trim().split('\n')[1];
      expect(second).toMatch(/\/audio\.wav /);
      expect(second).not.toContain('-mc');
    } finally { delete process.env.FAKE_WHISPER_ARGS; }
  });

  it('drops a line whisper wrote over a stretch of silence on its track, and says so', async () => {
    const voices = join(work, 'whisper-silence');
    await mkdir(voices, { recursive: true });
    // The mic is silent from 4 s to 16 s; whisper "heard" a thank-you in the middle of it.
    await writeFile(join(voices, 'mic.json'), whisper([[0, 2000, 'Okay, can everyone see my screen?'], [7000, 9000, 'Thank you.'], [16_500, 18_000, 'Thanks, talk soon.']]));
    await writeFile(join(voices, 'app.json'), whisper([[2500, 3700, 'Yes, I can.']]));
    const before = process.env.FAKE_WHISPER_DIR;
    process.env.FAKE_WHISPER_DIR = voices;
    try {
      const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model });
      const file = join(work, 'polydance-mac-20261105-170000.mp4');
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,4\\,16)\\,0\\,0.5*sin(2*PI*440*t)):s=48000:d=20',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=20,aformat=channel_layouts=stereo', '-map', '0:a', '-map', '1:a', '-c:a', 'aac', file]);
      const metaFile = join(work, 'quiet.meta.json');
      await writeFile(metaFile, JSON.stringify(meta({ video: 'none' }, { recordedAt: '2026-11-05T17:00:00.000Z', marks: [] })));
      const session = await importRecording(cli, file, { meta: metaFile });
      const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
      expect(manifest.steps.transcribe.note).toBe("3 segments from the microphone and 1 from the call's sound, as 3 lines; 0 microphone lines dropped as the far end heard through the speakers; 1 microphone line dropped as said over silence (under -45 dB for 2 s or more)");
      const lines = (await readJson(join(session.dir, 'transcript.json'), transcriptFileSchema)).segments;
      expect(lines.map(l => l.text)).toEqual(['Okay, can everyone see my screen?', 'Yes, I can.', 'Thanks, talk soon.']);
    } finally { process.env.FAKE_WHISPER_DIR = before; }
  });

  it('finishes a call whose screen was not recorded, without frames and without waiting for them', async () => {
    const cli = await testCli({ POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_POINTING: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: 'http://127.0.0.1:9' });
    const file = join(work, 'polydance-mac-20261105-120000.mp4');
    await makeCall(file, false);
    const metaFile = join(work, 'sound-only.meta.json');
    await writeFile(metaFile, JSON.stringify(meta({ video: 'none', videoNote: 'screen recording was not allowed' }, { recordedAt: '2026-11-05T12:00:00.000Z' })));
    const session = await importRecording(cli, file, { meta: metaFile });
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(manifest.media).toMatchObject({ hasVideo: false, audioChannels: [1, 2], voice: 'both' });
    expect(manifest.media.width).toBeUndefined();
    expect(manifest.steps).toMatchObject({
      probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' },
      frames: { status: 'skipped', note: 'the screen was not recorded (screen recording was not allowed), so there are no frames' },
      pointing: { status: 'skipped', note: 'no frames: the screen was not recorded (screen recording was not allowed)' },
      markers: { status: 'done' }, storyboard: { status: 'done' },
    });
    expect(isPending(manifest)).toBe(false);
    expect(manifest.frameCount).toBe(0);
    for (const missing of ['frames.json', 'frames', 'contact-sheet.jpg']) expect(await exists(join(session.dir, missing)), missing).toBe(false);
    expect(await exists(join(cli.config.work, manifest.id))).toBe(false);
    // The marks still mark the words, and their frames are simply not there.
    expect((await readJson(join(session.dir, 'markers.json'), markersFileSchema)).markers.filter(m => m.cue === 'mark')).toHaveLength(2);
    const storyboard = await readFile(join(session.dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('- Screen: **not recorded.** The screen was not recorded (screen recording was not allowed), so there are no frames; this is the sound alone.');
    expect(storyboard).toContain('[00:00] Me: Okay, can everyone see my screen?');
    expect(storyboard).not.toContain('frames/');
    expect(storyboard).toContain('(00:07: marked)\n\n[00:11] Others:');
    expect(storyboard).toContain('(00:12: marked: flag this)\n\n[00:16] Me: Thanks, talk soon.');
    expect(storyboard).toContain('Paths are relative to this folder.\n\n## Lines\n\n[00:00] Me:');
    await expect(frames(cli, manifest.id, {})).rejects.toThrow(/has no frames: the screen was not recorded/);
    await expect(frames(cli, manifest.id, { at: '0:05', exact: true })).rejects.toThrow(/no picture to take a frame from/);
    await expect(exportCommand(cli, manifest.id, 'video', {})).rejects.toThrow(/has no picture/);
    expect(await exportCommand(cli, manifest.id, 'audio', { sound: 'app' })).toMatch(/audio-app\.m4a$/);
    // Running it again finds nothing pending: it is finished, not waiting for a video.
    expect(await processCommand(cli, { refs: [], force: false })).toEqual([]);
  });

  it('transcribes both voices with Gladia too, one job per track, each deleted', async () => {
    // A stand-in for Gladia on localhost: the first job is the mic's, the second the call's sound.
    const calls: string[] = [];
    const utterances = [
      [{ start: 0.5, end: 2, text: 'Shall we start?', words: [{ word: ' Shall', start: 0.5, end: 0.9 }, { word: ' we', start: 0.9, end: 1.2 }, { word: ' start?', start: 1.2, end: 2 }] }],
      [{ start: 2.2, end: 3.5, text: 'Yes, go ahead.' }],
    ];
    let jobs = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      calls.push(`${req.method} ${req.url}`);
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/v2/upload') return json(200, { audio_url: 'https://api.gladia.io/file/abc' });
      if (req.url === '/v2/pre-recorded' && req.method === 'POST') return json(201, { id: `job${++jobs}` });
      const id = req.url?.match(/^\/v2\/pre-recorded\/(job\d)$/)?.[1];
      if (id && req.method === 'GET') return json(200, { id, status: 'done', result: { transcription: { languages: ['en'], utterances: utterances[Number(id.slice(3)) - 1] } } });
      if (id && req.method === 'DELETE') { res.writeHead(202); return res.end(); }
      json(404, { message: 'no' });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'gladia', GLADIA_API_KEY: 'k-test', POLYCAP_GLADIA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const file = join(work, 'polydance-mac-20261105-140000.mp4');
    await makeCall(file, false);
    const metaFile = join(work, 'gladia.meta.json');
    await writeFile(metaFile, JSON.stringify(meta({ video: 'none' }, { recordedAt: '2026-11-05T14:00:00.000Z', marks: [] })));
    const session = await importRecording(cli, file, { meta: metaFile });
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    server.close();
    expect(manifest.steps.transcribe).toMatchObject({ status: 'done', note: "1 segment from the microphone and 1 from the call's sound, as 2 lines; 0 microphone lines dropped as the far end heard through the speakers; mic: Gladia job deleted at Gladia; app: Gladia job deleted at Gladia" });
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual(['DELETE /v2/pre-recorded/job1', 'DELETE /v2/pre-recorded/job2']);
    const lines = (await readJson(join(session.dir, 'transcript.json'), transcriptFileSchema)).segments;
    expect(lines.map(s => [s.startMs, s.speaker, s.text, s.words?.length])).toEqual([[500, 'me', 'Shall we start?', 3], [2200, 'others', 'Yes, go ahead.', undefined]]);
  });

  it('skips frames for any file without a video stream, and says so', async () => {
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const file = join(work, 'voice-memo.m4a');
    await makeCall(file, false);
    const session = await importRecording(cli, file, { tracks: 'mic,app' });
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(manifest.steps.frames).toMatchObject({ status: 'skipped', note: 'the file has no video stream: the screen was not recorded, so there are no frames' });
    expect(manifest.media.voice).toBe('mic');
    expect(await readFile(join(session.dir, 'storyboard.md'), 'utf8')).toContain('**Sound only.** The file has no video stream: the screen was not recorded, so there are no frames.');
    expect((await loadSession(session.dir)).steps.probe).toEqual(expect.objectContaining({ status: 'done' }));
  });

  it('says when the tracks it was told about do not match the file', async () => {
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const file = join(work, 'polydance-mac-20261105-130000.mp4');
    await makeCall(file, false);
    const session = await importRecording(cli, file, { tracks: 'mic' });
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false, step: 'probe' });
    expect(manifest.steps.probe.note).toBe('source.audioTracks names 1 tracks but the file has 2 audio tracks, so which is which is not known');
  });

  it('runs as the Mac app runs it: node bin/polycap.js, argument arrays, one JSON line back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polycap-home-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, POLYCAP_ROOT: join(home, 'PolydanceCapture'), POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, FAKE_WHISPER_DIR: process.env.FAKE_WHISPER_DIR!, FAKE_WHISPER_JSON: process.env.FAKE_WHISPER_JSON! };
    const polycap = (...args: string[]) => exec(process.execPath, [new URL('../bin/polycap.js', import.meta.url).pathname, ...args], { env, cwd: home, allowFailure: true, timeoutMs: 120_000 });
    const file = join(work, 'polydance-mac-20261105-110002.mp4');
    const metaFile = join(work, 'cli.meta.json');
    await writeFile(metaFile, JSON.stringify(meta()));
    const imported = await polycap('import', file, '--meta', metaFile, '--json');
    expect(imported.code, imported.stderr).toBe(0);
    expect(imported.stdout.trim().split('\n')).toHaveLength(1);
    const { id, dir } = JSON.parse(imported.stdout) as { id: string; dir: string };
    expect(id).toMatch(/_meet$/);
    expect(dir).toBe(join(home, 'PolydanceCapture', 'sessions', id));
    const processed = await polycap('process', id, '--json');
    expect(processed.code, processed.stderr).toBe(0);
    expect(JSON.parse(processed.stdout)[0]).toMatchObject({ id, steps: { frames: { status: 'done' }, transcribe: { status: 'done' } } });
    const refused = await polycap('import', file, '--meta', metaFile, '--tracks', 'app,mic', '--json');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--tracks app,mic conflicts with audioTracks mic,app in --meta');
  });
});
