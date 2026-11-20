/** Sync is a transport test: real localhost HTTP, synthetic bundles, no media tools or APIs. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cli } from '../src/commands/context.js';
import { sync } from '../src/commands/sync.js';
import { loadSession, sessionSchema, STEP_NAMES } from '../src/session.js';
import { testCli } from './helpers/cli.js';

const id = '2026-10-08_capture';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function manifest() {
  return sessionSchema.parse({
    version: 1, id, title: 'A recording', createdAt: '2026-10-08T12:00:00Z', recordedAt: '2026-10-08T12:00:00Z', recordedAtSource: 'argument',
    source: { kind: 'upload', uploadId: 'up_test', originalName: 'capture.mp4', bytes: 5, sha256: sha256('video') },
    media: { video: 'video.mp4', durationMs: 1000 },
    steps: Object.fromEntries(STEP_NAMES.map(step => [step, { status: step === 'summary' ? 'skipped' : 'done' }])),
    tool: { name: 'polydance-capture', version: '0.1.0' },
  });
}

/** One recording, quietly: the result says what happened to it. */
const syncOne = (cli: Cli, session = id) => sync({ ...cli, print: () => {} }, { session, video: false, dryRun: false });

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function receiver() {
  const m = manifest();
  const bodies = new Map<string, Buffer>([
    ['session.json', Buffer.from(JSON.stringify(m))], ['transcript.md', Buffer.from('hello')],
    ['frames/nested/0001.jpg', Buffer.from('frame')], ['video.mp4', Buffer.from('video')], ['narration.m4a', Buffer.from('audio')],
  ]);
  const remote = {
    sessions: [{ id, ready: true, words: false, recordedAt: m.recordedAt, uploadId: m.source.uploadId, sha256: m.source.sha256 }],
    files: [...bodies].map(([path, body]) => ({ path, bytes: body.length, sha256: sha256(body) })),
    redirect: '',
  };
  const calls: { path: string; auth: string | undefined }[] = [];
  const basePath = `/v1/sessions/${id}/files`;
  const server = createServer((req, res) => {
    const path = req.url!;
    calls.push({ path, auth: req.headers.authorization });
    if (path === remote.redirect) { res.writeHead(302, { location: '/redirect-target' }); res.end(); return; }
    if (path === '/v1/sessions') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sessions: remote.sessions })); return; }
    if (path === basePath) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ files: remote.files })); return; }
    const body = path.startsWith(`${basePath}/`) ? bodies.get(decodeURIComponent(path.slice(basePath.length + 1))) : undefined;
    if (body) { res.end(body); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }));
  const cli = await testCli({ POLYCAP_REMOTE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, POLYCAP_REMOTE_TOKEN: 'read-test' });
  cleanup.push(() => rm(cli.config.root, { recursive: true, force: true }));
  const dir = join(cli.config.sessions, id);
  function setManifest(value: unknown) {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    bodies.set('session.json', body);
    Object.assign(remote.files.find(f => f.path === 'session.json')!, { bytes: body.length, sha256: sha256(body) });
  }
  return { cli, dir, remote, calls, bodies, setManifest, basePath };
}

describe('sync', () => {
  it('syncs only the selected bundle, verifies/repairs local files, prunes, and stays private without downloading media', async () => {
    const { cli, dir, remote, calls } = await receiver();
    remote.sessions.unshift({ ...remote.sessions[0], id: 'unrelated', ready: false, words: true });
    expect(await syncOne(cli)).toMatchObject({ downloaded: [id], skipped: [] });
    expect((await loadSession(dir)).id).toBe(id);
    expect(await readdir(cli.config.sessions)).toEqual([id]);
    expect(await readdir(dir)).not.toContain('video.mp4');
    expect(await readdir(dir)).not.toContain('narration.m4a');
    expect(calls.every(c => c.auth === 'Bearer read-test')).toBe(true);
    expect(calls.some(c => c.path.includes('unrelated'))).toBe(false);
    for (const path of [cli.config.root, cli.config.sessions, cli.config.work, dir, join(dir, 'frames'), join(dir, 'frames/nested')]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of ['session.json', 'transcript.md', 'frames/nested/0001.jpg']) expect((await stat(join(dir, path))).mode & 0o777).toBe(0o600);
    calls.length = 0;
    expect(await syncOne(cli)).toMatchObject({ current: [id], downloaded: [] });
    expect(calls.map(c => c.path)).toEqual(['/v1/sessions', `/v1/sessions/${id}/files`]);
    await writeFile(join(dir, 'transcript.md'), 'HELLO'); // Same bytes, wrong hash.
    await writeFile(join(dir, 'obsolete.txt'), 'old');
    await writeFile(join(dir, 'video.mp4'), 'retained');
    await chmod(join(dir, 'frames/nested'), 0o755);
    await chmod(join(dir, 'frames/nested/0001.jpg'), 0o644);
    expect(await syncOne(cli)).toMatchObject({ downloaded: [id], pruned: [id] });
    expect(await readFile(join(dir, 'transcript.md'), 'utf8')).toBe('hello');
    expect(await readdir(dir)).not.toContain('obsolete.txt');
    expect(await readFile(join(dir, 'video.mp4'), 'utf8')).toBe('retained');
    expect((await stat(join(dir, 'frames/nested'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'frames/nested/0001.jpg'))).mode & 0o777).toBe(0o600);
    expect(await readdir(cli.config.work)).toEqual([]);
    // A pruning-only sync is also a successful bundle, not a skipped download.
    await writeFile(join(dir, 'obsolete.txt'), 'old');
    expect(await syncOne(cli)).toMatchObject({ downloaded: [], pruned: [id], skipped: [] });
  });

  it('keeps what this machine\'s hooks recorded beside the bundle when it prunes (2026-11-05)', async () => {
    const { cli, dir } = await receiver();
    expect(await syncOne(cli)).toMatchObject({ downloaded: [id] });
    const runs = JSON.stringify({ version: 1, runs: { 'call-routine': { status: 'done', startedAt: '2026-11-05T12:00:00.000Z', exitCode: 0, log: 'hooks/call-routine.log' } } });
    await writeFile(join(dir, 'hook-runs.json'), runs, { mode: 0o600 });
    await mkdir(join(dir, 'hooks'), { mode: 0o700 });
    await writeFile(join(dir, 'hooks', 'call-routine.log'), '{}', { mode: 0o600 });
    await writeFile(join(dir, 'obsolete.txt'), 'old');
    expect(await syncOne(cli)).toMatchObject({ pruned: [id] });
    expect(await readdir(dir)).not.toContain('obsolete.txt');
    expect(await readFile(join(dir, 'hook-runs.json'), 'utf8')).toBe(runs);
    expect(await readFile(join(dir, 'hooks', 'call-routine.log'), 'utf8')).toBe('{}');
    expect(await syncOne(cli)).toMatchObject({ current: [id] });
  });

  it('limits sync to one session without changing words-first behavior', async () => {
    const { cli, remote, calls, setManifest } = await receiver();
    remote.sessions[0].ready = false; remote.sessions[0].words = true;
    remote.sessions.push({ ...remote.sessions[0], id: 'other', ready: true });
    const m = manifest(); m.steps.probe.status = 'pending'; m.media.narration = 'narration.m4a'; setManifest(m);
    expect(await sync(cli, { session: id, video: false, dryRun: false })).toMatchObject({ downloaded: [id], wordsOnly: [id] });
    expect(calls.some(c => c.path.includes('/other/'))).toBe(false);
  });

  it('rejects a missing recording, even when an old local copy exists', async () => {
    const { cli, remote } = await receiver();
    await syncOne(cli);
    remote.sessions = [];
    await expect(syncOne(cli)).rejects.toThrow(/missing/);
  });

  it('leaves a recording still processing on the server without fetching its files', async () => {
    const { cli, dir, remote, calls } = await receiver();
    remote.sessions[0].ready = false;
    expect(await syncOne(cli)).toMatchObject({ waiting: [id], downloaded: [] });
    expect(calls.map(c => c.path)).toEqual(['/v1/sessions']);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts older manifests whose optional steps default to skipped', async () => {
    const { cli, setManifest } = await receiver();
    const m = manifest(); const { pointing: _p, summary: _s, storyboard: _b, ...oldSteps } = m.steps;
    setManifest({ ...m, steps: oldSteps });
    expect(await syncOne(cli)).toMatchObject({ downloaded: [id] });
  });

  it.each(['malformed', 'schema', 'wrong-id'])('rejects a correctly hashed but %s session.json before installation', async kind => {
    const { cli, dir, setManifest } = await receiver();
    setManifest(kind === 'malformed' ? '{invalid' : kind === 'schema' ? { id } : { ...manifest(), id: 'someone-else' });
    await expect(syncOne(cli)).rejects.toThrow();
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(cli.config.work)).toEqual([]);
  });

  it('rejects a non-file local session.json before trying to read it', async () => {
    const { cli, dir } = await receiver();
    await mkdir(join(dir, 'session.json'), { recursive: true });
    await expect(syncOne(cli)).rejects.toThrow(/Not a regular bundle file/);
  });

  it('rejects ambiguous duplicate session IDs rather than syncing twice', async () => {
    const { cli, remote, calls } = await receiver();
    remote.sessions.push({ ...remote.sessions[0] });
    await expect(syncOne(cli)).rejects.toThrow(/ambiguous/);
    expect(calls.map(c => c.path)).toEqual(['/v1/sessions']);
  });

  it('requires session.json in the file manifest even when a local copy exists', async () => {
    const { cli, remote } = await receiver();
    await syncOne(cli);
    remote.files = remote.files.filter(f => f.path !== 'session.json');
    await expect(syncOne(cli)).rejects.toThrow(/missing session.json/);
  });

  it.each(['bytes', 'sha256'] as const)('checks downloaded %s and leaves an existing bundle untouched on corruption', async kind => {
    const { cli, dir, remote, bodies } = await receiver();
    await syncOne(cli);
    const file = remote.files.find(f => f.path === 'transcript.md')!;
    bodies.set(file.path, Buffer.from('changed'));
    file.bytes = kind === 'bytes' ? 99 : 7;
    file.sha256 = kind === 'bytes' ? sha256('changed') : sha256('invalid');
    await expect(syncOne(cli)).rejects.toThrow(kind === 'bytes' ? /byte count mismatch/ : /sha256 mismatch/);
    expect(await readFile(join(dir, 'transcript.md'), 'utf8')).toBe('hello');
    expect(await readdir(cli.config.work)).toEqual([]);
  });

  it('never treats a corrupt cached manifest as current', async () => {
    const { cli, dir, remote, bodies } = await receiver();
    await syncOne(cli);
    const bad = Buffer.from('{invalid');
    await writeFile(join(dir, 'session.json'), bad);
    bodies.set('session.json', bad);
    Object.assign(remote.files.find(f => f.path === 'session.json')!, { bytes: bad.length, sha256: sha256(bad) });
    expect(await syncOne(cli)).toMatchObject({ skipped: [id], current: [] });
    expect(await readFile(join(dir, 'session.json'))).toEqual(bad);
  });

  it('skips a different local recording instead of overwriting it', async () => {
    const { cli, dir } = await receiver();
    await syncOne(cli);
    const local = await loadSession(dir); local.source.uploadId = 'up_other'; local.source.sha256 = sha256('other');
    await writeFile(join(dir, 'session.json'), JSON.stringify(local));
    expect(await syncOne(cli)).toMatchObject({ skipped: [id] });
    expect((await loadSession(dir)).source.uploadId).toBe('up_other');
  });

  it('does not equate two absent upload IDs', async () => {
    const { cli, dir, remote, setManifest } = await receiver();
    remote.sessions[0].uploadId = undefined;
    const m = manifest(); delete m.source.uploadId; setManifest(m);
    await syncOne(cli);
    m.source.sha256 = sha256('another recording');
    await writeFile(join(dir, 'session.json'), JSON.stringify(m));
    expect(await syncOne(cli)).toMatchObject({ skipped: [id] });
  });

  it.each(['../escape', 'frames/../escape', 'frames/./escape', './session.json', '/absolute', 'frames//bad', 'frames/%2e%2e/escape', 'frames\\escape'])('rejects unsafe file path %s', async path => {
    const { cli, remote, calls, basePath } = await receiver();
    remote.files.push({ path, bytes: 0, sha256: sha256('') });
    await expect(syncOne(cli)).rejects.toThrow(/unsafe bundle path/);
    expect(calls.map(c => c.path)).toEqual(['/v1/sessions', basePath]);
  });

  it.each(['..', '.', '../other', 'a/../other', 'a%2fb'])('rejects unsafe requested session %s without HTTP', async session => {
    const { cli, calls } = await receiver();
    await expect(syncOne(cli, session)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it.each(['duplicate', 'parent-file'])('rejects %s manifest paths', async kind => {
    const { cli, remote } = await receiver();
    remote.files.push(kind === 'duplicate' ? remote.files[0] : { path: 'frames', bytes: 0, sha256: sha256('') });
    await expect(syncOne(cli)).rejects.toThrow(/duplicate|Conflicting/);
  });

  it.each(['root', 'sessions', 'work', 'session', 'manifest', 'nested', 'dangling', 'extra'])('refuses %s symlinks without changing their targets', async where => {
    const { cli, dir } = await receiver();
    const outside = await testCli();
    cleanup.push(() => rm(outside.config.root, { recursive: true, force: true }));
    const sentinel = join(outside.config.root, 'sentinel'); await writeFile(sentinel, 'untouched', { mode: 0o644 });
    if (['session', 'manifest', 'nested', 'dangling', 'extra'].includes(where)) await mkdir(dir, { recursive: true });
    if (where === 'root') { await rm(cli.config.root, { recursive: true }); await symlink(outside.config.root, cli.config.root); }
    else if (where === 'sessions' || where === 'work') await symlink(outside.config.root, cli.config[where]);
    else if (where === 'session') { await rm(dir, { recursive: true }); await symlink(outside.config.root, dir); }
    else if (where === 'manifest') await symlink(sentinel, join(dir, 'session.json'));
    else if (where === 'nested') await symlink(outside.config.root, join(dir, 'frames'));
    else await symlink(where === 'dangling' ? join(outside.config.root, 'missing') : sentinel, join(dir, 'unexpected'));
    await expect(syncOne(cli)).rejects.toThrow(/symlink/);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched');
    expect((await stat(sentinel)).mode & 0o777).toBe(0o644);
    expect(await readdir(outside.config.root)).toEqual(['sentinel']);
  });

  it.each(['list', 'files', 'download'])('does not follow authenticated redirects from %s', async where => {
    const { cli, remote, calls, basePath } = await receiver();
    remote.redirect = where === 'list' ? '/v1/sessions' : where === 'files' ? basePath : `${basePath}/session.json`;
    await expect(syncOne(cli)).rejects.toThrow();
    expect(calls.some(c => c.path === '/redirect-target')).toBe(false);
  });
});
