/**
 * Logs in a take (docs/LOGS.md): the logs step reading logcat onto the take's clock, and the receiver taking a
 * take's logs with its video, or a take of logs alone, over real HTTP with real ffmpeg. The log lines are made up.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { threadShow } from '../src/commands/thread.js';
import { logClock, logsAbout, logsNote, parseLine, readLogs } from '../src/pipeline/logs.js';
import { storyboardMarkdown } from '../src/pipeline/storyboard.js';
import { loadSession, STEP_NAMES, type SessionManifest } from '../src/session.js';
import { newToken } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';
import { hasFfmpeg, makeVideo } from './helpers/fake-tools.js';

const zeroAt = 1_763_290_000_000;
/** A logcat epoch stamp for this many ms into the take, as AOSP's logprint.cpp prints it: seconds right-aligned in 19. */
const at = (ms: number) => { const t = zeroAt + ms; return `${String(Math.floor(t / 1000)).padStart(19)}.${String(t % 1000).padStart(3, '0')}`; };
const packages = { 10123: 'com.oculus.browser', 10200: 'com.example.game' };
const LOGCAT = [
  '--------- beginning of main',
  `${at(-500)} 10123:  4321  4400 I chromium: before the take`,
  `${at(1200)} 10123:  4321  4400 I chromium: [INFO:CONSOLE(12)] "scene loaded", source: https://example.test/xr/app.js (12)`,
  `${at(2600)}  1000:   900   950 W ActivityManager: Slow operation`,
  `${at(2500)} 10123:14321 14401 E chromium: [ERROR:CONSOLE(40)] "Uncaught TypeError: x is undefined", source: https://example.test/xr/app.js (40)`,
  '--------- beginning of system',
  `${at(2700)}  root:     1     1 I init      : started a service`,
  `${at(3000)}   4321  4400 D NoUid   : a line printed without a uid`,
  `${at(3100)} 10200:  5000  5001 F libc    : Fatal signal 11 (SIGSEGV)`,
  `${at(3200)} 10200:  5000  5001 I Unity   :`,
  'not a log line at all',
  `${at(9000)} 10123:  4321  4400 E chromium: after the end`,
].join('\n');

describe('the logs step reads logcat onto the take\'s clock', () => {
  it('reads a line with a uid as a number or a name, without one, and with no text; and nothing else', () => {
    expect(parseLine(`${at(2500)} 10123:  4321  4401 E chromium: [ERROR:CONSOLE(40)] "bad", source: x (40)`, zeroAt, packages))
      .toEqual({ atMs: 2500, level: 'E', tag: 'chromium', pid: 4321, uid: '10123', app: 'com.oculus.browser', text: '[ERROR:CONSOLE(40)] "bad", source: x (40)' });
    expect(parseLine(`${at(2700)}  root:     1     1 I init      : started`, zeroAt)).toMatchObject({ atMs: 2700, uid: 'root', tag: 'init', text: 'started' });
    // logprint.cpp's "%5d:%5d": a five-digit pid follows the uid's colon with no space.
    expect(parseLine(`${at(10)} 10123:14321 14401 I tag: x`, zeroAt)).toMatchObject({ atMs: 10, uid: '10123', pid: 14321 });
    expect(parseLine(`${at(3000)}  4321  4400 D NoUid   : plain`, zeroAt)).toEqual({ atMs: 3000, level: 'D', tag: 'NoUid', pid: 4321, text: 'plain' });
    expect(parseLine(`${at(3200)} 10200:  5000  5001 I Unity   :`, zeroAt, packages)).toMatchObject({ tag: 'Unity', app: 'com.example.game', text: '' });
    // Microseconds (logcat -v usec) are read to the millisecond.
    expect(parseLine(`${Math.floor((zeroAt + 1234) / 1000)}.234567  1000:   1   2 I tag: x`, zeroAt)?.atMs).toBe(1234);
    for (const raw of ['--------- beginning of main', 'not a log line at all', '10-01 16:19:48.123  1000  1000 I tag: threadtime without epoch', '']) expect(parseLine(raw, zeroAt)).toBeUndefined();
  });

  it('keeps the lines from 0:00 to the end in order, and counts what it left out, who wrote them and the errors', () => {
    const { lines, file } = readLogs(LOGCAT, { zeroAt, scope: 'device', packages }, 4000);
    expect(lines.map(l => l.atMs)).toEqual([1200, 2500, 2600, 2700, 3000, 3100, 3200]);
    expect(file).toMatchObject({
      version: 1, scope: 'device', lines: 7, levels: { V: 0, D: 1, I: 3, W: 1, E: 1, F: 1 }, firstAtMs: 1200, lastAtMs: 3200, before: 1, after: 1, unread: 3,
      apps: [{ app: 'com.example.game', lines: 2 }, { app: 'com.oculus.browser', lines: 2 }, { app: 'uid 1000', lines: 1 }, { app: 'uid root', lines: 1 }],
      errorCount: 2,
    });
    expect(file.errors).toEqual([
      { atMs: 2500, level: 'E', tag: 'chromium', app: 'com.oculus.browser', text: '[ERROR:CONSOLE(40)] "Uncaught TypeError: x is undefined", source: https://example.test/xr/app.js (40)' },
      { atMs: 3100, level: 'F', tag: 'libc', app: 'com.example.game', text: 'Fatal signal 11 (SIGSEGV)' },
    ]);
    expect(logsNote(file)).toBe("7 lines from 4 apps, 2 errors; whole device; left out: 1 before 0:00, 1 after the end, 3 not in logcat's shape");
  });

  it('says whose lines they are, and when the start of the take or its end may be missing', () => {
    const own = readLogs(`${at(15_000)} 10050:  10  11 I PolydanceCapture: x`, { zeroAt, scope: 'app', note: 'Device logs need a one-time grant over adb.', truncated: true }, 60_000).file;
    expect(logsAbout(own)).toBe("Polydance's own lines only, not the other apps' (Device logs need a one-time grant over adb). Nothing before 00:15.000: the headset's log buffer may have dropped the start of the take. The headset stopped reading at its limit, so the end of the take may be missing.");
    expect(logsNote(own)).toBe("1 line from 1 app, 0 errors; Polydance's own; cut at the headset's limit");
    expect(logClock(62_345)).toBe('01:02.345');
    expect(logClock(3_723_004)).toBe('1:02:03.004');
  });

  it('puts the errors among the transcript\'s lines at their moments, and one after the last line too', () => {
    const { file } = readLogs(LOGCAT, { zeroAt, scope: 'device', packages }, 4000);
    const manifest = {
      version: 1, id: 'take', title: 'take', createdAt: '2026-11-16T10:00:00Z', recordedAt: '2026-11-16T10:00:00Z', recordedAtSource: 'meta',
      source: { kind: 'upload', originalName: 'take.mp4', bytes: 1, sha256: 'a'.repeat(64) }, media: { video: 'video.mp4', durationMs: 4000, voice: 'mic' },
      steps: Object.fromEntries(STEP_NAMES.map(n => [n, { status: 'done' }])), tool: { name: 'polycap', version: '0' },
    } as unknown as SessionManifest;
    const md = storyboardMarkdown({ manifest, segments: [{ startMs: 0, endMs: 2000, text: 'Opening the page.' }, { startMs: 3000, endMs: 3050, text: 'It froze.' }], frames: [], markers: [], requests: [], logs: file });
    expect(md).toContain('## Logs');
    expect(md).toContain('The first 2 errors are shown among the lines below, at their moments.');
    const order = ['[00:00] Opening the page.', '(00:02: log E chromium (com.oculus.browser): [ERROR:CONSOLE(40)]', '[00:03] It froze.', '(00:03: log F libc (com.example.game): Fatal signal 11 (SIGSEGV))'];
    expect(order.map(text => md.indexOf(text))).toEqual([...order.map(text => md.indexOf(text))].sort((a, b) => a - b));
    for (const text of order) expect(md).toContain(text);
  });
});

const ffmpeg = await hasFfmpeg();
(ffmpeg ? describe : describe.skip)('the receiver takes a take\'s logs, and a take of logs alone', () => {
  const quest = newToken(), mac = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], user: 'ana', projects: ['MUS'] },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' },
  ]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba' }]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }]);
  let base: string; let close: () => Promise<void>; let server: Awaited<ReturnType<typeof testCli>>;
  let video: Buffer; let logs: Buffer;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  beforeAll(async () => {
    process.env.TZ = 'Europe/London';
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none', POLYCAP_MAX_FRAMES: '4' });
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects, users });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    const file = join(await mkdtemp(join(tmpdir(), 'logs-video-')), 'take.mp4');
    await makeVideo(file, 4);
    video = await readFile(file);
    logs = Buffer.from(`${LOGCAT}\n`);
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}) },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  const logsField = (b = logs) => ({ bytes: b.length, sha256: sha(b), zeroAt, scope: 'device', packages });
  const ready = async (id: string) => {
    let status: Record<string, any> = {};
    for (let i = 0; i < 300; i++) {
      status = (await call('GET', `/v1/uploads/${id}`, quest.token)).json;
      if (status.status === 'ready' || status.status === 'failed') return status;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`upload ${id} never finished: ${JSON.stringify(status)}`);
  };

  it('refuses a take whose media file is half described, or that has neither media nor logs and a length', async () => {
    const body = { clientId: 'refused', recordedAt: '2026-11-16T10:00:00+00:00' };
    const refused = async (extra: object, words: RegExp) => {
      const answer = await call('POST', '/v1/uploads', quest.token, { ...body, ...extra });
      expect([answer.status, answer.json.error]).toEqual([400, expect.stringMatching(words)]);
    };
    await refused({ bytes: 10, sha256: 'a'.repeat(64) }, /send all three, or none/);
    await refused({ durationMs: 4000 }, /must send its logs/);
    await refused({ logs: logsField() }, /must say how long it was/);
    await refused({ logs: logsField(), durationMs: 4000, narration: { bytes: 10, sha256: 'a'.repeat(64) } }, /has none/);
    await refused({ logs: { ...logsField(), bytes: 32 * 1024 * 1024 + 1 }, durationMs: 4000 }, /logs.bytes/);
    await refused({ logs: { ...logsField(), packages: { 'not-a-uid': 'x' } }, durationMs: 4000 }, /logs.packages/);
    await refused({ logs: { ...logsField(), scope: 'everything' }, durationMs: 4000 }, /logs.scope/);
    // Sound alone is a media file like any other.
    const sound = await call('POST', '/v1/uploads', quest.token, { ...body, clientId: 'sound-alone', bytes: 10, sha256: 'b'.repeat(64), fileName: 'audio.m4a', audioTracks: ['mic'] });
    expect(sound.json).toMatchObject({ status: 'uploading', content: 'sound' });
  });

  it('takes the logs before the video, verified, and builds a bundle with them on the take\'s clock', async () => {
    const created = await call('POST', '/v1/uploads', quest.token, { clientId: 'with-logs', bytes: video.length, sha256: sha(video), fileName: 'take.mp4', recordedAt: '2026-11-16T10:00:00+00:00', logs: logsField() });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'uploading', content: 'video', logs: 'expected' });
    const id = created.json.id as string;
    const content = () => fetch(`${base}/v1/uploads/${id}/content`, { method: 'PUT', body: video, headers: { authorization: `Bearer ${quest.token}`, 'content-range': `bytes 0-${video.length - 1}/${video.length}` } });
    // The logs go first; then they must be the declared bytes, whole and unchanged.
    expect(await (await content()).json()).toMatchObject({ error: 'send the declared logs first' });
    expect((await call('PUT', `/v1/uploads/${id}/logs`, quest.token, logs.subarray(1))).status).toBe(400);
    const corrupt = Buffer.from(logs); corrupt[0] ^= 0xff;
    expect(await call('PUT', `/v1/uploads/${id}/logs`, quest.token, corrupt)).toMatchObject({ status: 409, json: { error: expect.stringMatching(/sha256/) } });
    expect((await call('PUT', `/v1/uploads/${id}/logs`, quest.token, logs)).json).toMatchObject({ status: 'uploading', logs: 'received' });
    // Sent again after a lost answer, they are already here.
    expect((await call('PUT', `/v1/uploads/${id}/logs`, quest.token, logs)).json).toMatchObject({ logs: 'received' });
    expect((await content()).status).toBe(200);
    const done = await ready(id);
    expect(done).toMatchObject({ status: 'ready', content: 'video', logs: 'received' });
    expect(done.error).toBeUndefined();

    const dir = join(server.config.sessions, done.sessionId);
    const manifest = await loadSession(dir);
    expect(manifest.media).toMatchObject({ video: 'video.mp4', logs: 'logcat.txt' });
    expect(manifest.source.logs).toEqual({ zeroAt, scope: 'device', packages });
    expect(manifest.steps.logs).toMatchObject({ status: 'done', note: expect.stringMatching(/^7 lines from 4 apps, 2 errors; whole device; left out: 1 before 0:00, 1 after the end/) });
    expect(await readFile(join(dir, 'logcat.txt'))).toEqual(logs);
    const text = await readFile(join(dir, 'logs.txt'), 'utf8');
    expect(text).toContain('[00:02.500] E chromium (com.oculus.browser): [ERROR:CONSOLE(40)] "Uncaught TypeError: x is undefined"');
    expect(text).not.toContain('after the end');
    expect(JSON.parse(await readFile(join(dir, 'logs.json'), 'utf8'))).toMatchObject({ errorCount: 2, lines: 7 });
    // No transcript here, so the storyboard lists the errors itself.
    const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain("## Logs\n\nThe headset's log: every app's lines. 7 lines, 2 errors");
    expect(storyboard).toContain('- [00:03.100] F libc (com.example.game): Fatal signal 11 (SIGSEGV)');
    // The upload's own copies are gone; the bundle holds them.
    expect(await readdir(join(server.config.uploads, id))).toEqual(['meta.json']);
    // The thread says what there is to play, and that the take has logs.
    const thread = (await call('GET', `/v1/threads/${done.thread}`, mac.token)).json;
    expect(thread.messages.find((m: any) => m.recording?.uploadId === id).recording).toMatchObject({ content: 'video', logs: true, status: 'ready' });
    const local = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    await threadShow(local, done.thread);
    expect(local.lines.join('\n')).toContain('  recording with logs');
  });

  it('builds a take of logs alone from its logs and its length: no probe, no sound, no frames, no picture to play', async () => {
    const created = await call('POST', '/v1/uploads', quest.token, { clientId: 'logs-alone', recordedAt: '2026-11-16T10:05:00+00:00', durationMs: 4000, logs: logsField() });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'uploading', bytes: 0, received: 0, content: 'none', logs: 'expected' });
    const id = created.json.id as string;
    const media = await fetch(`${base}/v1/uploads/${id}/content`, { method: 'PUT', body: Buffer.from('x'), headers: { authorization: `Bearer ${quest.token}`, 'content-range': 'bytes 0-0/1' } });
    expect(media.status).not.toBe(200);
    // The logs complete it.
    expect((await call('PUT', `/v1/uploads/${id}/logs`, quest.token, logs)).json).toMatchObject({ logs: 'received' });
    const done = await ready(id);
    expect(done).toMatchObject({ status: 'ready', content: 'none', durationMs: 4000 });
    expect(done.error).toBeUndefined();

    const dir = join(server.config.sessions, done.sessionId);
    const manifest = await loadSession(dir);
    expect(manifest.media).toEqual({ durationMs: 4000, logs: 'logcat.txt' });
    expect(manifest.source).toMatchObject({ originalName: 'logcat.txt', bytes: logs.length, sha256: sha(logs), logs: { zeroAt, scope: 'device' } });
    expect(manifest.steps).toMatchObject({
      probe: { status: 'skipped', note: expect.stringMatching(/^logs alone/) }, logs: { status: 'done' }, audio: { status: 'skipped', note: 'logs alone: no sound' },
      frames: { status: 'skipped', note: 'the take recorded logs alone, so there are no frames' }, storyboard: { status: 'done' },
    });
    const storyboard = await readFile(join(dir, 'storyboard.md'), 'utf8');
    expect(storyboard).toContain('**Logs alone.** This take recorded no picture and no sound');
    expect(storyboard).toContain('- [00:02.500] E chromium (com.oculus.browser)');
    expect(storyboard).not.toContain('## Frames');
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['logcat.txt', 'logs.txt', 'logs.json', 'storyboard.md', 'session.json']));
    // Nothing to take a frame from or to play.
    expect((await call('GET', `/v1/sessions/${done.sessionId}/frame?at=1`, mac.token)).json.error).toMatch(/logs alone/);
    const message = (await call('GET', `/v1/threads/${done.thread}`, mac.token)).json.messages.find((m: any) => m.recording?.uploadId === id);
    expect(message.recording).toMatchObject({ content: 'none', logs: true, status: 'ready' });
    const played = await call('GET', `/v1/threads/${done.thread}/messages/${message.id}/playback`, mac.token);
    expect(played.json).toMatchObject({ content: 'none', logs: true, video: { available: false } });
    // `polycap thread show` says what it is too.
    const local = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    await threadShow(local, done.thread);
    expect(local.lines.join('\n')).toMatch(new RegExp(`#${message.id} .* logs only\\n`));
    // Its size against the allowance is its logs'.
    expect((await call('GET', '/v1/account', quest.token)).json.usedBytes).toBeGreaterThanOrEqual(logs.length);
  });
});
