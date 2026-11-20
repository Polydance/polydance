import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importRecording } from '../src/commands/import.js';
import { frames, latest, list, show, transcript } from '../src/commands/inspect.js';
import { processCommand } from '../src/commands/process.js';
import { pull } from '../src/commands/pull.js';
import { doctor } from '../src/commands/doctor.js';
import { installSkill } from '../src/commands/install-skill.js';
import { exists, readJson } from '../src/fsx.js';
import { Ledger } from '../src/ledger.js';
import { extractAudio } from '../src/pipeline/audio.js';
import { framesFileSchema } from '../src/pipeline/frames.js';
import { exec } from '../src/exec.js';
import { loadSession, listSessions, requestsFileSchema } from '../src/session.js';
import { testCli } from './helpers/cli.js';
import { claudeMessage, fakeClaude } from './helpers/fake-claude.js';
import { fakeTools, hasDrawtext, hasFfmpeg, makeSilentVideo, makeVideo } from './helpers/fake-tools.js';
import { extractFrames } from '../src/pipeline/frames.js';
import { exportCommand } from '../src/commands/export.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ffmpeg = await hasFfmpeg();
const describeWithFfmpeg = ffmpeg ? describe : describe.skip;
if (!ffmpeg) console.warn('ffmpeg not installed: skipping end-to-end pipeline tests');

describeWithFfmpeg('pull and process end to end', () => {
  let tools: Awaited<ReturnType<typeof fakeTools>>;
  let remote: string;
  const name = 'com.oculus.vrshell-20261001-142205.mp4';
  beforeAll(async () => {
    tools = await fakeTools();
    remote = await mkdtemp(join(tmpdir(), 'polycap-remote-'));
    await makeVideo(join(remote, name));
    const old = new Date(Date.now() - 60_000);
    await utimes(join(remote, name), old, old);
    process.env.FAKE_REMOTE_DIR = remote;
    process.env.FAKE_WHISPER_JSON = new URL('./fixtures/whisper-output.json', import.meta.url).pathname;
  });
  afterAll(() => { delete process.env.FAKE_REMOTE_DIR; delete process.env.FAKE_WHISPER_JSON; });

  it('pulls a new recording once, verifies it, and builds the whole bundle', async () => {
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '6' });
    const first = await pull(cli, { wait: true, dryRun: false });
    expect(first.created).toEqual(['2026-10-01T14-22-05_vrshell']);
    const ledger = await Ledger.open(cli.config.ledgerFile);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const rawFile = ledger.entries()[0].localPath;
    expect((await stat(rawFile)).size).toBe(ledger.entries()[0].bytes);
    expect((await stat(join(cli.config.sessions, first.created[0]))).mode & 0o777).toBe(0o700);

    const again = await pull(cli, { wait: true, dryRun: false });
    expect(again.created).toEqual([]);
    expect(again.known).toBe(1);

    const [manifest] = await processCommand(cli, { refs: [], force: false });
    expect(manifest.steps).toMatchObject({ probe: { status: 'done' }, audio: { status: 'done' }, transcribe: { status: 'done' }, frames: { status: 'done' }, markers: { status: 'done' } });
    expect(manifest.media).toMatchObject({ width: 320, height: 240, hasAudio: true });
    expect(manifest.media.durationMs).toBeGreaterThan(5500);
    expect(manifest.frameCount).toBeLessThanOrEqual(6);
    expect(manifest.markerCount).toBe(2);
    expect(manifest.transcriber?.kind).toBe('whisper-cpp');
    const dir = join(cli.config.sessions, manifest.id);
    for (const file of ['transcript.json', 'transcript.md', 'markers.json', 'frames.json', 'contact-sheet.jpg', 'storyboard.md', 'video.mp4']) expect(await exists(join(dir, file)), file).toBe(true);
    // Thumbnails carry their clocks wherever ffmpeg can draw text.
    if (await hasDrawtext()) expect(manifest.steps.frames.note).not.toMatch(/without clocks/);
    const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain("[00:01] There's a bug here, the stick goes through the drum. {bug}");
    expect(storyboard).toMatch(/\n- 00:0\d frames\/\d{4}_00m0\ds\.jpg/);
    expect(storyboard).not.toContain('## Requests');
    const framesFile = await readJson(join(dir, 'frames.json'), framesFileSchema);
    expect(framesFile.frames.length).toBe(manifest.frameCount);
    for (const frame of framesFile.frames) expect((await stat(join(dir, 'frames', frame.file))).size).toBeGreaterThan(500);
    expect(await exists(join(cli.config.work, manifest.id))).toBe(false);
    expect(await readFile(join(dir, 'transcript.md'), 'utf8')).toContain("[00:01] There's a bug here");

    const second = await processCommand(cli, { refs: [], force: false });
    expect(second).toEqual([]);
    expect(cli.lines.at(-1)).toMatch(/Nothing pending/);

    cli.lines.length = 0;
    await list(cli);
    expect(cli.lines.join('\n')).toContain('2026-10-01T14-22-05_vrshell');
    expect(cli.lines.join('\n')).toContain('com.oculus.vrshell');
    cli.lines.length = 0;
    await latest(cli);
    expect(cli.lines[0]).toMatch(/^2026-10-01T14-22-05_vrshell\t/);
    cli.lines.length = 0;
    await show(cli, 'vrshell');
    expect(cli.lines.join('\n')).toMatch(/\[00:01\] bug\s+There's a bug here/);
    cli.lines.length = 0;
    await transcript(cli, 'latest', { from: '0:01', to: '0:02' });
    // Range means "overlaps", so the first segment (ends at 1.5 s) is included alongside the bug.
    expect(cli.lines).toEqual(['[00:00] Okay, this is the drum circle.', "[00:01] There's a bug here, the stick goes through the drum."]);
    cli.lines.length = 0;
    await transcript(cli, 'latest', { from: '0:02', to: '0:03' });
    expect(cli.lines).toEqual(["[00:01] There's a bug here, the stick goes through the drum."]);
    cli.lines.length = 0;
    await frames(cli, 'latest', { at: '0:02', window: '1' });
    expect(cli.lines.length).toBeGreaterThan(0);
    expect(cli.lines[0]).toMatch(/frames\/\d{4}_\d{2}m\d{2}s\.jpg\t\[00:0\d\]\t(segment|edge)/);
    cli.lines.length = 0;
    await frames(cli, 'latest', {});
    expect(cli.lines.at(-1)).toMatch(/contact-sheet\.jpg\t\[overview\]/);
  });

  it('records a failed transcription and still extracts interval frames', async () => {
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: join(tools.dir, 'missing-model.bin') });
    const video = join(tools.dir, 'import-me.mp4');
    await makeVideo(video, 12);
    await importRecording(cli, video, { app: 'marimba.marimba', recordedAt: '2026-10-01T10:00:00Z' });
    const [manifest] = await processCommand(cli, { refs: ['marimba'], force: false });
    expect(manifest.id).toMatch(/_marimba$/);
    expect(manifest.recordedAtSource).toBe('argument');
    expect(manifest.steps.transcribe).toMatchObject({ status: 'failed' });
    expect(manifest.steps.transcribe.error).toMatch(/Whisper model not found/);
    expect(manifest.steps.frames).toMatchObject({ status: 'done' });
    expect(manifest.steps.frames.note).toContain('at interval');
    expect(manifest.steps.markers).toMatchObject({ status: 'skipped' });
    const forced = await processCommand(cli, { refs: ['marimba'], force: false, step: 'transcribe' });
    expect(forced[0].steps.transcribe.status).toBe('failed');
  });

  it('labels a transcribed session with Claude, records a failed call, and redoes only that step', async () => {
    let refuse = true;
    const claude = await fakeClaude(() => refuse
      ? { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'model: not found' } } }
      : { status: 200, body: claudeMessage(JSON.stringify({ title: 'Drum stick clipping', summary: 'The drumstick passes through the drum in the drum circle.', requests: [{ line: 2, quote: 'the stick goes through the drum', kind: 'problem', request: 'Stop the stick passing through the drum' }] })) });
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '4', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const video = join(tools.dir, 'label-me.mp4');
    await makeVideo(video, 6);
    const session = await importRecording(cli, video, { app: 'marimba.marimba', recordedAt: '2026-10-01T11:00:00Z' });
    const [failed] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(failed.steps).toMatchObject({ transcribe: { status: 'done' }, frames: { status: 'done' }, markers: { status: 'done' }, summary: { status: 'failed' } });
    expect(failed.steps.summary.error).toMatch(/Anthropic returned 400/);
    expect(failed.title).toBe(failed.id);
    // Only the transcript's words went out.
    expect(JSON.stringify(claude.calls[0].body.messages)).toContain('[L2] There\'s a bug here, the stick goes through the drum.');

    refuse = false;
    const [labelled] = await processCommand(cli, { refs: [session.manifest.id], force: false, step: 'summary' });
    expect(labelled.steps.summary).toMatchObject({ status: 'done', note: 'claude-haiku-4-5; 1 requests' });
    const dir = join(cli.config.sessions, labelled.id);
    expect(await readJson(join(dir, 'requests.json'), requestsFileSchema)).toEqual({ version: 2, model: 'claude-haiku-4-5', rejected: [],
      requests: [{ atMs: 1500, text: 'Stop the stick passing through the drum', kind: 'problem', quote: 'the stick goes through the drum' }] });
    // The storyboard is rebuilt from the new summary only when its own step runs.
    const [rebuilt] = await processCommand(cli, { refs: [labelled.id], force: false, step: 'storyboard' });
    expect(rebuilt.steps.storyboard).toMatchObject({ status: 'done', note: `3 lines, ${rebuilt.frameCount} frames, 1 requests` });
    const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('**Drum stick clipping.** The drumstick passes through the drum in the drum circle.');
    expect(storyboard).toContain("[00:01] There's a bug here, the stick goes through the drum. {bug}\n- problem: Stop the stick passing through the drum\n");
    expect(storyboard).toContain('## Requests');
    expect(labelled).toMatchObject({ title: 'Drum stick clipping', summary: { title: 'Drum stick clipping', text: 'The drumstick passes through the drum in the drum circle.', model: 'claude-haiku-4-5' } });
    expect(labelled.steps.frames.at).toBe(failed.steps.frames.at);
    cli.lines.length = 0;
    await list(cli);
    expect(cli.lines.join('\n')).toContain('Drum stick clipping');
    cli.lines.length = 0;
    await show(cli, 'drum stick');
    expect(cli.lines.slice(0, 2)).toEqual([`${labelled.id}  (Drum stick clipping)`, 'summary The drumstick passes through the drum in the drum circle.  (claude-haiku-4-5)']);
    expect(cli.lines).toContain('  [00:01] problem: Stop the stick passing through the drum');
    // --all reaches bundles that are not pending.
    const all = await processCommand(cli, { refs: [], all: true, force: false, step: 'summary' });
    expect(all.map(m => m.id)).toEqual([labelled.id]);
    expect(claude.calls).toHaveLength(3);
    expect(all[0].steps.storyboard.status).toBe('done');
    claude.close();
  });

  it('treats an app-only recording as the app\'s voice: no markers, no pointing, a summary without requests', async () => {
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Drum circle lesson', summary: 'Shows a drum circle lesson.', requests: [{ line: 2, quote: "There's a bug here", kind: 'problem', request: 'Fix the bug' }] })) }));
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_MAX_FRAMES: '4', POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const video = join(tools.dir, 'app-only.mp4');
    // As Polydance records with the mic off: video and the app's sound in stereo, nothing else.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6,aformat=channel_layouts=stereo',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    const session = await importRecording(cli, video, { app: 'net.polydance.capture', recordedAt: '2026-10-02T19:29:08Z' });
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(manifest.media).toMatchObject({ audioChannels: [2], voice: 'app' });
    expect(manifest.steps.audio.note).toMatch(/track 1, the app's own sound: no microphone was recorded/);
    // The fixture says "There's a bug here": from the app's voice-over that is no marker.
    expect(manifest.steps.markers).toMatchObject({ status: 'skipped', note: "the transcript is the app's own sound, not the user" });
    expect(manifest.markerCount).toBe(0);
    const dir = join(cli.config.sessions, manifest.id);
    expect(JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8')).voice).toBe('app');
    expect(await readFile(join(dir, 'transcript.md'), 'utf8')).toContain("**Voice: the app's own sound.**");
    expect(await readFile(join(dir, 'storyboard.md'), 'utf8')).toContain("**Voice: the app's own sound.**");
    expect(String(claude.calls[0].body.system)).toContain('with the microphone off');
    expect((await readJson(join(dir, 'requests.json'), requestsFileSchema)).requests).toEqual([]);
    claude.close();
  });

  it('skips audio and transcription for a silent video and keeps the original file untouched', async () => {
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_TRANSCRIBER: 'none' });
    const video = join(tools.dir, 'silent.mp4');
    await makeSilentVideo(video);
    const before = await stat(video);
    const session = await importRecording(cli, video);
    expect(session.manifest.recordedAtSource).toBe('mtime');
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(manifest.steps.audio).toMatchObject({ status: 'skipped', note: 'no audio track' });
    expect(manifest.steps.transcribe.status).toBe('skipped');
    expect(manifest.steps.frames.status).toBe('done');
    expect((await stat(video)).size).toBe(before.size);
    expect((await listSessions(cli.config)).map(s => s.manifest.id)).toEqual([manifest.id]);
    expect((await loadSession(session.dir)).frameCount).toBeGreaterThan(0);
  });

  it('drops lines nobody near the microphone said: only a quiet room, so no words and no summary (2026-11-13)', async () => {
    // Claude would title it from the invented words; it must not be asked at all.
    const claude = await fakeClaude(() => ({ status: 200, body: claudeMessage(JSON.stringify({ title: 'Cake recipe demonstration incomplete', summary: 'Begins explaining how to make a cake.', requests: [] })) }));
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model, POLYCAP_SUMMARIZER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test', POLYCAP_ANTHROPIC_URL: claude.url });
    const video = join(tools.dir, 'room.mp4');
    // As SPOT-1: the room's own sound around -45 dB, no narrator; the fake whisper still "hears" its four lines.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.01:sample_rate=16000',
      '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    const session = await importRecording(cli, video);
    const [manifest] = await processCommand(cli, { refs: [session.manifest.id], force: false });
    expect(manifest.steps.transcribe).toMatchObject({ status: 'done', note: expect.stringContaining("3 lines dropped as the room's sound, not the narrator") });
    expect(JSON.parse(await readFile(join(session.dir, 'transcript.json'), 'utf8')).segments).toEqual([]);
    expect(manifest.steps.summary).toMatchObject({ status: 'skipped', note: 'no transcript' });
    expect(manifest.title).toBe(manifest.id);
    expect(manifest.summary).toBeUndefined();
    expect(claude.calls).toHaveLength(0);
    await claude.close();
  });

  it('doctor reports the fake tools and the connected fake device', async () => {
    const cli = await testCli({ POLYCAP_ADB: tools.adb, POLYCAP_WHISPER_BIN: tools.whisper, POLYCAP_WHISPER_MODEL: tools.model });
    expect(await doctor(cli)).toBe(true);
    expect(cli.lines.join('\n')).toContain('FAKE123 (Quest_3)');
    const broken = await testCli({ POLYCAP_ADB: join(tools.dir, 'no-such-adb') });
    expect(await doctor(broken)).toBe(false);
    expect(broken.lines.join('\n')).toMatch(/MISSING\s+adb/);
  });
});

describe('install-skill', () => {
  it('links the repository skill folder and refuses to clobber without --force', async () => {
    const cli = await testCli();
    const skillsDir = await mkdtemp(join(tmpdir(), 'polycap-skills-'));
    const target = await installSkill(cli, { force: false, skillsDir });
    expect(target).toBe(join(skillsDir, 'polydance-capture'));
    expect(await exists(join(target, 'SKILL.md'))).toBe(true);
    await installSkill(cli, { force: false, skillsDir });
    expect(cli.lines.at(-1)).toMatch(/already installed/);
    await writeFile(join(skillsDir, 'other'), 'x');
    const other = await testCli();
    await expect(installSkill(other, { force: false, skillsDir: join(skillsDir, 'other-dir') })).resolves.toBeTruthy();
  });

  it('replaces the link under the skill\'s old name, and leaves anything else under it alone', async () => {
    const cli = await testCli();
    const skillsDir = await mkdtemp(join(tmpdir(), 'polycap-skills-'));
    const source = join(new URL('..', import.meta.url).pathname, 'skill');
    await symlink(source, join(skillsDir, 'headset-session'), 'dir');
    await installSkill(cli, { force: false, skillsDir });
    expect(await readdir(skillsDir)).toEqual(['polydance-capture']);
    const kept = await mkdtemp(join(tmpdir(), 'polycap-skills-'));
    await mkdir(join(kept, 'headset-session'));
    await installSkill(cli, { force: false, skillsDir: kept });
    expect((await readdir(kept)).sort()).toEqual(['headset-session', 'polydance-capture']);
  });
});

describeWithFfmpeg('audio extraction with several tracks', () => {
  it('transcribes the first track (narration), not the louder stereo one ffmpeg would pick', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-tracks-'));
    const video = join(dir, 'two-tracks.mp4'), wav = join(dir, 'out.wav');
    // Track 1: quiet mono "narration". Track 2: loud stereo "game audio". Both marked default, as in
    // files where every track is enabled; ffmpeg's own pick then goes to the one with more channels.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2,volume=0.01',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2,volume=0.9,aformat=channel_layouts=stereo',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-disposition:a:0', 'default', '-disposition:a:1', 'default', video]);
    await extractAudio('ffmpeg', video, wav);
    const { stderr } = await exec('ffmpeg', ['-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-']);
    const max = Number(stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
    expect(max).toBeLessThan(-30);
  });
});

describeWithFfmpeg('full-resolution frames', () => {
  it('grabs a second, full-size copy of the frames that want one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-full-'));
    const video = join(dir, 'clip.mp4');
    await makeVideo(video, 3);
    const { frames, failures } = await extractFrames('ffmpeg', video, join(dir, 'frames'), [{ atMs: 500, reason: 'edge' }, { atMs: 1500, reason: 'pointing', word: 'this' }], 160, { width: 320, wants: e => e.reason === 'pointing' });
    expect(frames.map(f => f.full)).toEqual([undefined, 'full/0002_00m01s.jpg']);
    expect(failures).toEqual([]);
    const width = async (file: string) => (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', file])).stdout.trim();
    expect(await width(join(dir, 'frames', '0002_00m01s.jpg'))).toBe('160');
    expect(await width(join(dir, 'frames', 'full', '0002_00m01s.jpg'))).toBe('320');
  });
});

describeWithFfmpeg('export', () => {
  it('cuts a clip with only the app\'s sound, the narration alone, and subtitles for a range', async () => {
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const dir = await mkdtemp(join(tmpdir(), 'polycap-export-'));
    const file = join(dir, 'two-tracks.mp4');
    // As Polydance records: video, the mic in mono, the app's sound in stereo.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3,aformat=channel_layouts=stereo',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    const session = await importRecording(cli, file, { app: 'net.polydance.capture', recordedAt: '2026-10-02T12:00:00Z' });
    await processCommand(cli, { refs: [session.manifest.id], force: false, step: 'probe' });
    const streams = async (path: string) => JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,channels:format=duration', '-of', 'json', path])).stdout) as { streams: { codec_type: string; channels?: number }[]; format: { duration: string } };

    const promo = await exportCommand(cli, session.manifest.id, 'video', { sound: 'app' });
    expect(promo).toContain(join(cli.config.root, 'exports', session.manifest.id));
    expect((await streams(promo)).streams).toEqual([{ codec_type: 'video' }, { codec_type: 'audio', channels: 2 }]);
    expect((await stat(promo)).mode & 0o777).toBe(0o600);

    const narration = await exportCommand(cli, session.manifest.id, 'audio', { sound: 'mic', from: '0:01', to: '0:02', out: join(dir, 'narration.m4a') });
    const n = await streams(narration);
    expect(n.streams).toEqual([{ codec_type: 'audio', channels: 1 }]);
    expect(Number(n.format.duration)).toBeGreaterThan(0.9);
    expect(Number(n.format.duration)).toBeLessThan(1.2);

    await writeFile(join(session.dir, 'transcript.json'), JSON.stringify({ version: 1, engine: 'test', segments: [{ startMs: 1200, endMs: 1800, text: 'Keep the dials.' }] }));
    const subtitles = await exportCommand(cli, session.manifest.id, 'transcript', { format: 'srt', from: '0:01', to: '0:02', out: dir });
    expect(subtitles).toBe(join(dir, `${session.manifest.id}_00m01s-00m02s_transcript.srt`));
    expect(await readFile(subtitles, 'utf8')).toBe('1\n00:00:00,200 --> 00:00:00,800\nKeep the dials.\n');

    // A recording from another app does not say which track is which, so a name is refused and a number works.
    const other = await importRecording(cli, file, { app: 'com.example.game', recordedAt: '2026-10-02T12:05:00Z' });
    await expect(exportCommand(cli, other.manifest.id, 'audio', { sound: 'mic' })).rejects.toThrow(/pick one by number/);
    expect((await streams(await exportCommand(cli, other.manifest.id, 'audio', { sound: '1' }))).streams).toEqual([{ codec_type: 'audio', channels: 1 }]);
  });
});
