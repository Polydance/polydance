/**
 * `polycap upload` against the real receiver in-process over localhost (as receiver.test.ts runs it),
 * with real ffmpeg: a walkthrough from the Mac sent as a reply in a thread, its narration first, its
 * video in chunks; one that opens a new thread in a project, and a report from the bug key; an upload interrupted part way resumed from the bytes the receiver had; the same
 * file twice; and the refusals (a call however it is recognised, no token, a token without the upload
 * scope). The tokens live in a temporary settings folder, never the user's.
 */
import { copyFile, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, type } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportCommand } from '../src/commands/export.js';
import { importRecording } from '../src/commands/import.js';
import { serve } from '../src/commands/serve.js';
import { HOW_TO_TOKEN, upload, uploadClientId, uploadToken } from '../src/commands/upload.js';
import { exec } from '../src/exec.js';
import { sha256File } from '../src/fsx.js';
import { newToken } from '../src/server/tokens.js';
import { loadSession } from '../src/session.js';
import { testCli, type TestCli } from './helpers/cli.js';
import { hasFfmpeg } from './helpers/fake-tools.js';

const ffmpeg = await hasFfmpeg();
const describeWithFfmpeg = ffmpeg ? describe : describe.skip;
if (!ffmpeg) console.warn('ffmpeg not installed: skipping polycap upload tests');

const fixture = JSON.parse(await readFile(new URL('./fixtures/mac-call-meta.json', import.meta.url), 'utf8'));
const { call: _call, ...walkthroughMeta } = fixture;
const menu = 'https://marimba-web-k2m7q9x4t-yourteam.vercel.app/';

/** A walkthrough as the Mac app records one: the screen, then the mic (mono), then the app's sound (stereo). */
async function makeWalkthrough(path: string, seconds: number): Promise<void> {
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x200:rate=10:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds},aformat=channel_layouts=stereo`,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

describeWithFfmpeg('polycap upload: a walkthrough from the Mac as a thread reply', () => {
  const capture = newToken(), team = newToken();
  let base: string; let close: () => Promise<void>; let server: TestCli; let settings: string; let work: string;
  let oldConfig: string | undefined;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  /** The Mac's polycap: the receiver's address, and the upload token by the name it is saved under unless told otherwise. */
  const mac = async (env: Record<string, string> = { POLYCAP_UPLOAD_TOKEN: 'mac-capture' }) => testCli({ POLYCAP_REMOTE_URL: base, ...env });
  const ready = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const { json } = await call('GET', `/v1/uploads/${id}`, capture.token);
      if (json.status === 'ready' || json.status === 'failed') return json;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('the receiver never built the bundle');
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'polycap-upload-'));
    // Saved tokens are looked for beside the settings file: a temporary one here.
    settings = join(work, 'config');
    await mkdir(join(settings, 'tokens'), { recursive: true, mode: 0o700 });
    await writeFile(join(settings, 'tokens', 'mac-capture'), `${capture.token}\n`, { mode: 0o600 });
    oldConfig = process.env.POLYCAP_CONFIG;
    process.env.POLYCAP_CONFIG = join(settings, 'env');
    server = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const tokens = JSON.stringify([
      { id: 'mac-capture', sha256: capture.sha256, scopes: ['upload', 'read'], user: 'robin', label: 'Mac' },
      { id: 'mac', sha256: team.sha256, scopes: ['read', 'post'], user: 'robin' },
    ]);
    const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba', hosts: ['marimba-web-*-yourteam.vercel.app'] }, { key: 'CAP', name: 'Polydance Capture' }]);
    const running = await serve({ ...server, print: () => {} }, { host: '127.0.0.1', port: 0, tokens, projects, reports: 'CAP', users: JSON.stringify([{ id: 'robin', name: 'Robin' }]) });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    // The team asks: two options to try, then a second thread.
    expect((await call('POST', '/v1/threads', team.token, { project: 'MUS', title: 'New menu', text: 'Which is easier?', launches: [{ label: 'Blue', steps: [{ do: 'open', url: menu }] }, { label: 'Red', steps: [{ do: 'open', url: `${menu}red` }] }] })).json.key).toBe('MUS-1');
    expect((await call('POST', '/v1/threads', team.token, { project: 'MUS', title: 'Other', text: 'Something else' })).json.key).toBe('MUS-2');
  });
  afterAll(async () => {
    await close?.();
    if (oldConfig === undefined) delete process.env.POLYCAP_CONFIG; else process.env.POLYCAP_CONFIG = oldConfig;
  });

  it('sends the narration first, then the video in chunks, as a reply to the option tried; the receiver builds the bundle', async () => {
    const file = join(work, 'polydance-mac-20261105-140000.mp4');
    await makeWalkthrough(file, 3);
    const metaFile = join(work, 'walk.meta.json');
    await writeFile(metaFile, JSON.stringify(walkthroughMeta));
    const cli = await mac();
    const lines: string[] = [];
    const result = await upload({ ...cli, json: true, print: line => lines.push(line) }, file, { thread: 'mus-1', replyTo: '1', launch: '1', meta: metaFile, chunkBytes: 16 * 1024 });
    const bytes = (await readFile(file)).length;
    expect(result).toMatchObject({ uploadId: expect.stringMatching(/^up_/), thread: 'MUS-1', bytes, received: bytes, resumedFrom: 0, narration: 'sent' });
    expect(['received', 'processing', 'ready']).toContain(result.status);
    expect(result.clientId).toBe(uploadClientId('polydance-mac-20261105-140000.mp4', await sha256File(file)));
    // One JSON line, the contract's.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(result);
    // Marks are not the receiver's yet: left out, and said.
    expect(cli.warnings).toEqual(['2 marks are left out: the receiver does not take marks yet']);

    const done = await ready(result.uploadId);
    expect(done).toMatchObject({ status: 'ready', thread: 'MUS-1' });
    const manifest = await loadSession(join(server.config.sessions, done.sessionId));
    expect(manifest.source).toMatchObject({
      kind: 'upload', uploadId: result.uploadId, clientId: result.clientId, sha256: await sha256File(file), appPackage: 'net.polydance.capture.mac',
      appBuild: { versionName: '0.1.0', versionCode: 1, commit: '904e7b9' }, audioTracks: ['mic', 'app'], deviceModel: process.platform === 'darwin' ? 'Mac' : type(),
      thread: { key: 'MUS-1', replyTo: { message: 1, launch: { label: 'Red' } } },
    });
    expect(manifest.recordedAt).toBe('2026-11-05T11:00:02.120Z');
    const thread = (await call('GET', '/v1/threads/MUS-1', team.token)).json;
    expect(thread.messages[1]).toMatchObject({ by: { id: 'mac-capture' }, recording: { uploadId: result.uploadId, replyTo: { message: 1, launch: 1 } } });

    // The same file again is the same upload: nothing is sent twice, and it cannot go in another thread.
    const again = await upload({ ...cli, print: () => {} }, file, { thread: 'MUS-1', meta: metaFile, chunkBytes: 16 * 1024 });
    expect(again).toMatchObject({ uploadId: result.uploadId, resumedFrom: bytes, received: bytes });
    await expect(upload({ ...cli, print: () => {} }, file, { thread: 'MUS-2', meta: metaFile })).rejects.toThrow(`this recording was already uploaded as ${result.uploadId}, a reply in MUS-1, not MUS-2`);
  });

  it('resumes an upload that stopped part way from the bytes the receiver has', async () => {
    const file = join(work, 'polydance-mac-20261105-150000.mp4');
    await makeWalkthrough(file, 4);
    const data = await readFile(file);
    const sha256 = await sha256File(file);
    // An earlier run created the upload and got 20 KB across before the connection dropped.
    const clientId = uploadClientId('polydance-mac-20261105-150000.mp4', sha256);
    const created = await call('POST', '/v1/uploads', capture.token, { clientId, bytes: data.length, sha256, fileName: 'polydance-mac-20261105-150000.mp4', thread: { key: 'MUS-2' } });
    expect(created.status).toBe(201);
    const first = data.subarray(0, 20_000);
    const put = await fetch(`${base}/v1/uploads/${created.json.id}/content`, { method: 'PUT', body: first, headers: { authorization: `Bearer ${capture.token}`, 'content-range': `bytes 0-${first.length - 1}/${data.length}` } });
    expect((await put.json() as { received: number }).received).toBe(20_000);

    const cli = await mac();
    const result = await upload({ ...cli, print: () => {} }, file, { thread: 'MUS-2', tracks: 'mic,app', chunkBytes: 32 * 1024 });
    expect(result).toMatchObject({ uploadId: created.json.id, resumedFrom: 20_000, received: data.length });
    // That upload declared no narration, so none is sent now; the video carries the same sound.
    expect(result.narration).toBe('not sent');
    const done = await ready(result.uploadId);
    expect(done.status).toBe('ready');
    expect((await loadSession(join(server.config.sessions, done.sessionId))).source.sha256).toBe(sha256);
  });

  it('runs as the Mac app runs it: node bin/polycap.js upload, one JSON line', async () => {
    const file = join(work, 'polydance-mac-20261105-170000.mp4');
    await makeWalkthrough(file, 2);
    const metaFile = join(work, 'cli.meta.json');
    await writeFile(metaFile, JSON.stringify({ ...walkthroughMeta, marks: [] }));
    const home = await mkdtemp(join(tmpdir(), 'polycap-home-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, POLYCAP_ROOT: join(home, 'PolydanceCapture'), POLYCAP_CONFIG: join(settings, 'env'), POLYCAP_REMOTE_URL: base, POLYCAP_UPLOAD_TOKEN: 'mac-capture' };
    const polycap = (...args: string[]) => exec(process.execPath, [new URL('../bin/polycap.js', import.meta.url).pathname, ...args], { env, cwd: home, allowFailure: true, timeoutMs: 120_000 });
    const sent = await polycap('upload', file, '--thread', 'MUS-1', '--reply-to', '1', '--launch', '0', '--meta', metaFile, '--json');
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(sent.stdout)).toMatchObject({ uploadId: expect.stringMatching(/^up_/), thread: 'MUS-1', narration: 'sent', resumedFrom: 0 });
    const refused = await polycap('upload', file, '--thread', 'MUS-1', '--meta', join(work, 'missing.meta.json'), '--json');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('does not exist or is not readable');
  });

  it('refuses a call without --meta: by the metadata beside it, its sha256 in the library, its session\'s folders, and its export\'s tag', async () => {
    // No receiver address: each refusal comes before anything that would reach one.
    const cli = await testCli({ POLYCAP_TRANSCRIBER: 'none' });
    const file = join(work, 'polydance-mac-20261105-180000.mp4');
    await makeWalkthrough(file, 1);
    // The Mac app's recording with its metadata beside it, as it writes every one.
    await writeFile(join(work, 'polydance-mac-20261105-180000.meta.json'), JSON.stringify(fixture));
    await expect(upload(cli, file, { thread: 'MUS-1' })).rejects.toThrow(/polydance-mac-20261105-180000\.meta\.json, beside the recording, describes a call\. Calls never leave this Mac/);
    // Imported, its session's video and a renamed copy of it are the call by their sha256.
    const metaFile = join(work, 'import-call.meta.json');
    await writeFile(metaFile, JSON.stringify(fixture));
    const session = await importRecording({ ...cli, print: () => {} }, file, { meta: metaFile });
    const copy = join(work, 'design-review.mp4');
    await copyFile(join(session.dir, 'video.mp4'), copy);
    for (const path of [join(session.dir, 'video.mp4'), copy]) await expect(upload(cli, path, { thread: 'MUS-1' })).rejects.toThrow(`is the recording of call session ${session.manifest.id}. Calls never leave this Mac`);
    // An export of it, in its exports folder or put anywhere else.
    const exported = await exportCommand({ ...cli, print: () => {} }, session.manifest.id, 'video', { from: '0:00', to: '0:01' });
    expect(exported).toContain(join('exports', session.manifest.id));
    await expect(upload(cli, exported, { thread: 'MUS-1' })).rejects.toThrow(`belongs to call session ${session.manifest.id}`);
    const elsewhere = await exportCommand({ ...cli, print: () => {} }, session.manifest.id, 'audio', { sound: 'mic', out: join(work, 'clip.m4a') });
    await copyFile(elsewhere, join(work, 'clip.mov'));
    await expect(upload(cli, join(work, 'clip.mov'), { thread: 'MUS-1' })).rejects.toThrow(`is an export of call session ${session.manifest.id}`);
    // Any file in that session's folders, and in a session folder that cannot be read.
    const walk = join(work, 'walk-only.mp4');
    // Longer than the call, so not the same bytes.
    await makeWalkthrough(walk, 2);
    await copyFile(walk, join(cli.config.root, 'exports', session.manifest.id, 'other.mp4'));
    await expect(upload(cli, join(cli.config.root, 'exports', session.manifest.id, 'other.mp4'), { thread: 'MUS-1' })).rejects.toThrow(`belongs to call session ${session.manifest.id}`);
    await mkdir(join(cli.config.sessions, '2026-11-05T19-00-00_meet'), { recursive: true });
    await copyFile(walk, join(cli.config.sessions, '2026-11-05T19-00-00_meet', 'video.mp4'));
    await expect(upload(cli, join(cli.config.sessions, '2026-11-05T19-00-00_meet', 'video.mp4'), { thread: 'MUS-1' })).rejects.toThrow(/session\.json cannot be read, so it cannot be checked for a call; nothing was sent/);
    // Metadata beside the file that cannot be read cannot clear it either.
    const odd = join(work, 'odd.mp4');
    await copyFile(walk, odd);
    await writeFile(join(work, 'odd.meta.json'), '{"version": 1, "call": "maybe"}');
    await expect(upload(cli, odd, { thread: 'MUS-1' })).rejects.toThrow(/odd\.meta\.json, beside the recording, is not valid import metadata/);
    // A walkthrough is not a call: it gets as far as needing the receiver's address.
    await expect(upload(cli, walk, { thread: 'MUS-1' })).rejects.toThrow(/Set POLYCAP_REMOTE_URL/);
  });

  it('uses the metadata beside a walkthrough when none is given, so its narration still goes first', async () => {
    const file = join(work, 'polydance-mac-20261105-190000.mp4');
    await makeWalkthrough(file, 2);
    await writeFile(join(work, 'polydance-mac-20261105-190000.meta.json'), JSON.stringify({ ...walkthroughMeta, marks: [] }));
    const result = await upload({ ...await mac(), print: () => {} }, file, { thread: 'MUS-2' });
    expect(result).toMatchObject({ thread: 'MUS-2', narration: 'sent', resumedFrom: 0 });
    const done = await ready(result.uploadId);
    expect((await loadSession(join(server.config.sessions, done.sessionId))).source).toMatchObject({ audioTracks: ['mic', 'app'], appPackage: 'net.polydance.capture.mac' });
  });

  it('opens a new thread in a project of your own, and sends a report that only the team sees', async () => {
    const cli = await mac();
    // A project of Robin's own, made with his read-and-post token; the Mac's upload token is his too.
    expect((await call('POST', '/v1/projects', team.token, { name: 'Kitchen Timer' })).json.project).toMatchObject({ key: 'KITC', mine: true });
    const file = join(work, 'polydance-mac-20261116-100000.mp4');
    await makeWalkthrough(file, 2);
    const lines: string[] = [];
    const opened = await upload({ ...cli, json: true, print: line => lines.push(line) }, file, { project: 'kitc' });
    expect(opened).toMatchObject({ as: 'thread', thread: 'KITC-1', resumedFrom: 0 });
    expect(JSON.parse(lines[0])).toEqual(opened);
    expect((await call('GET', '/v1/threads/KITC-1', team.token)).json.messages[0]).toMatchObject({ by: { id: 'mac-capture' }, recording: { uploadId: opened.uploadId } });
    // Sent again it is the same upload in the same thread; it cannot open another one elsewhere.
    expect(await upload({ ...cli, print: () => {} }, file, { project: 'KITC' })).toMatchObject({ uploadId: opened.uploadId, thread: 'KITC-1', as: 'thread' });
    await expect(upload({ ...cli, print: () => {} }, file, { project: 'MUS' })).rejects.toThrow(`already uploaded as ${opened.uploadId}, in KITC-1, not a new thread in MUS`);

    const bug = join(work, 'polydance-mac-20261116-110000.mp4');
    await makeWalkthrough(bug, 2);
    const printed: string[] = [];
    const report = await upload({ ...cli, print: line => printed.push(line) }, bug, { report: true });
    expect(report).toMatchObject({ as: 'report', thread: expect.stringMatching(/^CAP-\d+$/) });
    expect(printed[0]).toContain('a report for the Polydance team, which only the team sees');
    expect((await call('GET', `/v1/threads/${report.thread}`, team.token)).json).toMatchObject({ report: true, project: { key: 'CAP' } });
    const done = await ready(report.uploadId);
    expect((await loadSession(join(server.config.sessions, done.sessionId))).source.thread).toMatchObject({ key: report.thread, report: true });
  });

  it('refuses a call, and says how to make a token when there is none or it cannot upload', async () => {
    const file = join(work, 'polydance-mac-20261105-160000.mp4');
    await makeWalkthrough(file, 1);
    const callMeta = join(work, 'call.meta.json');
    await writeFile(callMeta, JSON.stringify(fixture));
    const cli = await mac();
    await expect(upload(cli, file, { thread: 'MUS-1', meta: callMeta })).rejects.toThrow(/describes a call\. Calls never leave this Mac/);
    await expect(upload(cli, file, {})).rejects.toThrow(/say where it goes: --thread KEY for a reply .*--project KEY for a new thread, or --report/);
    await expect(upload(cli, file, { thread: 'MUS-1', report: true })).rejects.toThrow(/--thread, --project and --report each say where a recording goes; give one/);
    await expect(upload(cli, file, { project: 'MUS', replyTo: '1' })).rejects.toThrow(/--reply-to and --launch go with --thread/);
    await expect(upload(cli, file, { project: 'm-1' })).rejects.toThrow(/--project m-1 is not a project key such as MUS/);
    await expect(upload(cli, file, { thread: 'MUS-1', launch: '0' })).rejects.toThrow(/--launch goes with --reply-to/);
    await expect(upload(cli, file, { thread: 'MUS-1', replyTo: '1', launch: '7' })).rejects.toThrow(/--launch 7 is not a launch index/);
    // The receiver checks the reply against the thread.
    await expect(upload({ ...cli, print: () => {} }, file, { thread: 'MUS-1', replyTo: '1', launch: '4' })).rejects.toThrow(/MUS-1 message 1 has no launch 4/);

    const none = await mac({});
    await expect(upload(none, file, { thread: 'MUS-1' })).rejects.toThrow('polycap token new --id mac-capture --team --expires never --scope upload --scope read --user robin --label Mac --save mac-capture');
    await expect(uploadToken(none)).rejects.toThrow(HOW_TO_TOKEN);
    await expect(uploadToken(none, 'nobody')).rejects.toThrow(/--token nobody names token "nobody", but .*tokens\/nobody does not exist/);
    await expect(uploadToken(none, capture.token)).rejects.toThrow(/never the token itself/);
    expect(await uploadToken(none, 'mac-capture')).toBe(capture.token);
    // A read-and-post token, like Robin's POLYCAP_REMOTE_TOKEN, cannot create uploads.
    const readOnly = await mac({ POLYCAP_UPLOAD_TOKEN: team.token });
    await expect(upload(readOnly, file, { thread: 'MUS-1' })).rejects.toThrow(/token lacks scope upload \(403\)\. Uploads need a token with the upload scope\. Make one with/);
    const unknown = await mac({ POLYCAP_UPLOAD_TOKEN: newToken().token });
    await expect(upload(unknown, file, { thread: 'MUS-1' })).rejects.toThrow(/does not know this token \(401\)\. It must be listed in the receiver's POLYCAP_SERVER_TOKENS/);
  });
});
