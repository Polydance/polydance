/** Photos in threads: the check and strip, the receiver's store and routes, and `--photo` and `thread show` (docs/THREADS.md, Photos). */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from '../src/exec.js';
import { serve } from '../src/commands/serve.js';
import { preparePhoto } from '../src/commands/thread-photos.js';
import { threadNew, threadPending, threadReply, threadShow } from '../src/commands/thread.js';
import { cleanPhoto, sniff, tiffOrientation } from '../src/photo.js';
import { newToken } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';
import {
  BASELINE_JPEG, chunk, exifBody, exifChunk, JFIF_WITH_THUMBNAIL, leaks, makePng, phoneJpeg, PROGRESSIVE_JPEG, segment, withSegments,
} from './helpers/photos.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ok = (data: Buffer) => {
  const cleaned = cleanPhoto(data);
  if (!cleaned.ok) throw new Error(cleaned.problem);
  return cleaned;
};
/** What ffprobe says the file is, so a stripped photo is seen to still decode. */
async function probe(data: Buffer, ext: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'photo-probe-'));
  await writeFile(join(dir, `p.${ext}`), data);
  return (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, `p.${ext}`)])).stdout.trim();
}

describe('Photos: the check and the strip', () => {
  it('knows JPEG, PNG and the formats it sends back to be converted', () => {
    expect(sniff(BASELINE_JPEG)).toBe('jpeg');
    expect(sniff(makePng(2, 2))).toBe('png');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]);
    expect(sniff(heic)).toBe('heic');
    expect(cleanPhoto(heic, 'IMG_1.heic')).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/^IMG_1\.heic: is HEIC, which the headset and agents cannot read; send it as JPEG/) });
    expect(cleanPhoto(Buffer.from('GIF89a......', 'latin1'))).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/is GIF; photos are JPEG or PNG/) });
    expect(cleanPhoto(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toMatchObject({ ok: false, convert: true });
    expect(cleanPhoto(Buffer.from('hello, not a photo'))).toMatchObject({ ok: false, convert: false, problem: 'the photo: is not a JPEG or PNG image' });
  });

  it('keeps a JPEG\'s picture and colour profile and drops EXIF, GPS, XMP, IPTC, MPF, comments, the thumbnail and what follows the end', async () => {
    const phone = phoneJpeg(1, withSegments(BASELINE_JPEG, [JFIF_WITH_THUMBNAIL]));
    expect(leaks(phone)).toEqual(['SecretCam', 'GPS-51', 'XMP-SECRET', 'MPF-SECRET', 'IPTC-SECRET', 'COMMENT-SECRET', 'GAINMAP-SECRET', 'THUMB!']);
    const cleaned = ok(phone);
    expect(leaks(cleaned.photo)).toEqual([]);
    expect(cleaned.facts).toEqual({ type: 'image/jpeg', width: 24, height: 16 });
    expect(cleaned.photo.includes(Buffer.from('ICC_PROFILE\0', 'latin1'))).toBe(true);
    expect(cleaned.photo.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // Stripping what is already stripped changes nothing, so the id of a photo is stable.
    expect(ok(cleaned.photo).photo.equals(cleaned.photo)).toBe(true);
    // The base JPEG has nothing to drop but its picture's own segments are all kept: same bytes.
    expect(ok(BASELINE_JPEG).photo.equals(BASELINE_JPEG)).toBe(true);
    expect(await probe(cleaned.photo, 'jpg')).toBe('24,16');
  });

  it('reads a progressive JPEG\'s ten scans and keeps them all', async () => {
    const cleaned = ok(phoneJpeg(1, PROGRESSIVE_JPEG));
    expect(leaks(cleaned.photo)).toEqual([]);
    expect(ok(PROGRESSIVE_JPEG).photo.equals(PROGRESSIVE_JPEG)).toBe(true);
    expect(await probe(cleaned.photo, 'jpg')).toBe('24,16');
  });

  it('refuses a JPEG tagged as turned, too large, cut short or of a kind few decoders read', () => {
    expect(tiffOrientation(exifBody(6).subarray(6))).toBe(6);
    expect(tiffOrientation(exifBody(8, 'MM').subarray(6))).toBe(8);
    expect(tiffOrientation(Buffer.from('nonsense'))).toBe(1);
    expect(cleanPhoto(phoneJpeg(6), 'IMG_2.jpg')).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/^IMG_2\.jpg: is tagged as turned \(EXIF orientation\)/) });
    expect(ok(phoneJpeg(1)).facts.width).toBe(24);
    const huge = Buffer.from(BASELINE_JPEG);
    const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
    huge.writeUInt16BE(5000, sof + 7);
    expect(cleanPhoto(huge)).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/is 5000×16; photos are at most 4096 px a side/) });
    expect(cleanPhoto(BASELINE_JPEG.subarray(0, 400))).toMatchObject({ ok: false, convert: false, problem: expect.stringMatching(/cut short/) });
    expect(cleanPhoto(BASELINE_JPEG.subarray(0, BASELINE_JPEG.length - 2))).toMatchObject({ ok: false, problem: expect.stringMatching(/cut short/) });
    const lossless = Buffer.from(BASELINE_JPEG); lossless[sof + 1] = 0xc3;
    expect(cleanPhoto(lossless)).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/unusual kind of JPEG/) });
    const twelve = Buffer.from(BASELINE_JPEG); twelve[sof + 4] = 12;
    expect(cleanPhoto(twelve)).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/12-bit samples/) });
    expect(cleanPhoto(withSegments(BASELINE_JPEG, [segment(0xf7, 'x')]))).toMatchObject({ ok: false, convert: false, problem: expect.stringMatching(/marker this receiver does not know \(0xFFF7\)/) });
  });

  it('keeps a PNG\'s picture and colour chunks and drops text, time, EXIF and animation', async () => {
    const png = makePng(30, 20, [chunk('iCCP', 'profile\0\0fake'), chunk('tEXt', 'Comment\0TEXT-SECRET'), chunk('tIME', '\x07\xea\x0b\x07\x0e\x14\x00'), exifChunk(1), chunk('acTL', '\0\0\0\x01\0\0\0\0'), chunk('zzZz', 'unknown')]);
    expect(leaks(png)).toEqual(['SecretCam', 'GPS-51', 'TEXT-SECRET']);
    const cleaned = ok(png);
    expect(cleaned.facts).toEqual({ type: 'image/png', width: 30, height: 20 });
    expect(leaks(cleaned.photo)).toEqual([]);
    for (const name of ['tEXt', 'tIME', 'eXIf', 'acTL', 'zzZz']) expect(cleaned.photo.includes(Buffer.from(name, 'latin1'))).toBe(false);
    expect(cleaned.photo.includes(Buffer.from('iCCP', 'latin1'))).toBe(true);
    expect(ok(cleaned.photo).photo.equals(cleaned.photo)).toBe(true);
    expect(await probe(cleaned.photo, 'png')).toBe('30,20');
    expect(cleanPhoto(makePng(4, 4, [exifChunk(6)]))).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/tagged as turned/) });
    const broken = Buffer.from(makePng(4, 4)); broken[broken.length - 20] ^= 0xff;
    expect(cleanPhoto(broken)).toMatchObject({ ok: false, problem: expect.stringMatching(/does not match its checksum/) });
    expect(cleanPhoto(makePng(4, 4).subarray(0, 40))).toMatchObject({ ok: false, problem: expect.stringMatching(/cut short/) });
    expect(cleanPhoto(makePng(5000, 1))).toMatchObject({ ok: false, convert: true, problem: expect.stringMatching(/5000×1/) });
  });
});

const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba' },
  { key: 'CAP', name: 'Polydance Capture' },
]);

describe('Photos on the receiver', () => {
  const phone = newToken(), mac = newToken(), headset = newToken(), outsider = newToken(), reader = newToken(), ana = newToken();
  const tokens = JSON.stringify([
    { id: 'iphone', sha256: phone.sha256, scopes: ['upload'], label: 'iPhone', user: 'robin' },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'quest-2', sha256: headset.sha256, scopes: ['upload'], label: 'Spare Quest' },
    { id: 'cap-headset', sha256: outsider.sha256, scopes: ['upload'], projects: ['CAP'] },
    { id: 'reader', sha256: reader.sha256, scopes: ['read'] },
    { id: 'ana-quest', sha256: ana.sha256, scopes: ['upload'], user: 'ana', threads: 'member' },
  ]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }]);
  const jpeg = phoneJpeg(1), clean = ok(jpeg).photo;
  const png = ok(makePng(30, 20, [chunk('tEXt', 'Comment\0TEXT-SECRET')])).photo;
  let base: string; let close: () => Promise<void>; let root: string;

  beforeAll(async () => {
    const server = await testCli({ POLYCAP_PHOTO_MAX_BYTES: '4096', POLYCAP_PHOTOS_TOTAL_BYTES: String(clean.length + png.length + 100) });
    root = server.config.root;
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown, type?: string) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': type ?? (Buffer.isBuffer(body) ? 'image/jpeg' : 'application/json') } : {}) },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: Record<string, any> | undefined;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { json = undefined; }
    return { status: response.status, json, bytes, headers: response.headers };
  };

  let key = '';

  it('advertises photos-v1', async () => {
    expect((await call('GET', '/v1/projects', phone.token)).json?.capabilities).toContain('photos-v1');
  });

  it('keeps a photo sent to a thread once, stripped, privately, named by the stripped file', async () => {
    key = (await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Desk', text: 'Show me the desk.' })).json!.key;
    const sent = await call('POST', `/v1/threads/${key}/photos`, phone.token, jpeg);
    expect(sent).toMatchObject({ status: 201, json: { project: 'MUS', sha256: sha(clean), type: 'image/jpeg', width: 24, height: 16, bytes: clean.length } });
    expect((await call('POST', `/v1/threads/${key}/photos`, phone.token, clean)).status).toBe(200);
    const dir = join(root, 'thread-photos', 'MUS');
    expect(await readdir(dir)).toEqual([`${sha(clean)}.jpg`]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${sha(clean)}.jpg`))).mode & 0o777).toBe(0o600);
    expect(leaks(await readFile(join(dir, `${sha(clean)}.jpg`)))).toEqual([]);
  });

  it('refuses what is not a photo it keeps, and photos from tokens that may not send them there', async () => {
    const post = (body: Buffer, type?: string, token = phone.token, path = `/v1/threads/${key}/photos`) => call('POST', path, token, body, type);
    expect(await post(phoneJpeg(6))).toMatchObject({ status: 400, json: { error: expect.stringMatching(/tagged as turned/) } });
    expect(await post(clean, 'image/png')).toMatchObject({ status: 400, json: { error: 'the photo is image/jpeg but was sent as image/png' } });
    expect((await post(clean, 'application/octet-stream')).status).toBe(415);
    expect((await post(Buffer.alloc(5000, 1))).status).toBe(413);
    expect((await post(Buffer.from('not a photo'))).json?.error).toMatch(/not a JPEG or PNG/);
    // A thread it cannot see, a reader, and the project route without post.
    expect((await post(clean, undefined, outsider.token)).status).toBe(404);
    expect((await post(clean, undefined, reader.token)).status).toBe(403);
    // The project route takes an upload token's photo since 2026-11-13 (the iPhone opens a thread with it), not a reader's.
    expect((await post(clean, undefined, phone.token, '/v1/projects/MUS/photos')).status).toBe(200);
    expect((await post(clean, undefined, reader.token, '/v1/projects/MUS/photos')).status).toBe(403);
    expect((await post(clean, undefined, outsider.token, '/v1/projects/MUS/photos')).status).toBe(404);
    expect((await post(png, 'image/png', mac.token, '/v1/projects/CAPX/photos')).status).toBe(404);
    // Past the store's total: this one would take all of them over it.
    const big = ok(makePng(40, 30)).photo;
    expect((await post(big, 'image/png', mac.token, '/v1/projects/MUS/photos')).status).toBe(507);
  });

  it('lets an upload token post photos with words, never words alone or a launch, and says it in the inbox', async () => {
    const posted = await call('POST', `/v1/threads/${key}/messages`, phone.token, { text: 'Here it is.', photos: [sha(clean)], deliveryId: 'photo-1' });
    expect(posted.status).toBe(201);
    const message = posted.json!.messages.at(-1);
    expect(message).toMatchObject({ id: 2, text: 'Here it is.', by: { display: 'Robin · iPhone' }, photos: [{ sha256: sha(clean), type: 'image/jpeg', width: 24, height: 16, bytes: clean.length }], canView: true });
    // A retry with the same delivery is the same message; the same id with other photos is refused.
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { text: 'Here it is.', photos: [sha(clean)], deliveryId: 'photo-1' })).json!.messages).toHaveLength(2);
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { text: 'Here it is.', deliveryId: 'photo-1' })).status).toBe(403);
    await call('POST', '/v1/projects/MUS/photos', mac.token, png, 'image/png');
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { text: 'Here it is.', photos: [sha(png)], deliveryId: 'photo-1' })).json?.error).toMatch(/different reply payload/);

    expect(await call('POST', `/v1/threads/${key}/messages`, phone.token, { text: 'Just words' })).toMatchObject({ status: 403, json: { error: expect.stringMatching(/posting words needs scope post/) } });
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: [sha(clean)], launches: [{ steps: [{ do: 'open', url: 'https://example.com' }] }] })).json?.error).toBe('sending a launch needs scope post');
    expect((await call('POST', `/v1/threads/${key}/messages`, reader.token, { photos: [sha(clean)] })).status).toBe(403);
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: [sha(clean), sha(clean)] })).json?.error).toMatch(/names each photo once/);
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: Array.from({ length: 11 }, (_, i) => String(i).repeat(64).slice(0, 64)) })).status).toBe(400);
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: ['e'.repeat(64)] })).json?.error).toMatch(/photos\.0: eeeeeeeeeeee… has not been sent to MUS: send it first with POST \/v1\/threads\/MUS-\d+\/photos/);

    // The team's two photos alone: the inbox says so, and the event counts them.
    const after = (await call('GET', '/v1/events', mac.token)).json!.last;
    expect((await call('POST', `/v1/threads/${key}/messages`, mac.token, { photos: [sha(png), sha(clean)] })).status).toBe(201);
    const events = (await call('GET', `/v1/events?after=${after}`, mac.token)).json!.events;
    expect(events).toEqual([expect.objectContaining({ kind: 'message', thread: key, message: 3, photos: 2 })]);
    const listed = (await call('GET', '/v1/threads', phone.token)).json!.threads.find((t: { key: string }) => t.key === key);
    expect(listed.last.text).toBe('sent 2 photos');
    expect(listed.snippet).toBe('sent 2 photos');
  });

  it('counts a photo message from someone else as new work for the team', async () => {
    const thread = (await call('GET', `/v1/threads/${key}`, mac.token)).json!;
    await call('POST', `/v1/threads/${key}/read`, mac.token, { seq: thread.seq });
    expect((await call('GET', '/v1/threads', mac.token)).json!.threads.find((t: { key: string }) => t.key === key).fresh).toBe(0);
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: [sha(png)] })).status).toBe(201);
    // The iPhone is Robin's, like the Mac, but a different token: its photo is news to the Mac's agent.
    expect((await call('GET', '/v1/threads', mac.token)).json!.threads.find((t: { key: string }) => t.key === key).fresh).toBe(1);
  });

  it('serves a photo only through a thread that holds it, to its members and its sender', async () => {
    const got = await call('GET', `/v1/threads/${key}/photos/${sha(clean)}`, phone.token);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(got.bytes.equals(clean)).toBe(true);
    const head = await fetch(`${base}/v1/threads/${key}/photos/${sha(png)}`, { method: 'HEAD', headers: { authorization: `Bearer ${mac.token}` } });
    expect([head.status, head.headers.get('content-type'), head.headers.get('content-length')]).toEqual([200, 'image/png', String(png.length)]);
    // The spare headset sees the project's threads but is not a member of this one.
    const seen = (await call('GET', `/v1/threads/${key}`, headset.token)).json!;
    expect(seen.messages[1]).toMatchObject({ photos: [{ sha256: sha(clean) }], canView: false });
    expect(await call('GET', `/v1/threads/${key}/photos/${sha(clean)}`, headset.token)).toMatchObject({ status: 403, json: { reason: 'not_member' } });
    expect((await call('GET', `/v1/threads/${key}/photos/${sha(clean)}`, outsider.token)).status).toBe(404);
    const other = (await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Other', text: 'no photos here' })).json!.key;
    expect((await call('GET', `/v1/threads/${other}/photos/${sha(clean)}`, mac.token)).status).toBe(404);
    expect((await call('GET', `/v1/threads/${key}/photos/..%2F..%2Ftokens`, mac.token)).status).toBe(404);
  });

  it('shows someone added later only the photos sent after they were added (2026-11-12)', async () => {
    expect((await call('POST', `/v1/threads/${key}/members`, mac.token, { add: ['ana'] })).status).toBe(200);
    expect((await call('GET', `/v1/threads/${key}`, ana.token)).json!.messages).toEqual([]);
    for (const photo of [clean, png]) expect((await call('GET', `/v1/threads/${key}/photos/${sha(photo)}`, ana.token)).status).toBe(404);
    // The same photo sent again after: that message, and so the photo, is hers to see.
    expect((await call('POST', `/v1/threads/${key}/messages`, phone.token, { photos: [sha(png)], text: 'again, for Ana' })).status).toBe(201);
    expect((await call('GET', `/v1/threads/${key}/photos/${sha(png)}`, ana.token)).status).toBe(200);
    expect((await call('GET', `/v1/threads/${key}/photos/${sha(clean)}`, ana.token)).status).toBe(404);
    expect((await call('POST', `/v1/threads/${key}/members`, mac.token, { remove: ['ana'] })).status).toBe(200);
  });

  it('opens a thread with photos sent to its project first', async () => {
    const opened = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Screens', photos: [sha(png)] });
    expect(opened).toMatchObject({ status: 201, json: { messages: [{ id: 1, photos: [{ sha256: sha(png), type: 'image/png' }] }] } });
    expect((await call('POST', '/v1/threads', mac.token, { project: 'CAP', title: 'Screens', photos: [sha(png)] })).json?.error).toMatch(/has not been sent to CAP: send it first with POST \/v1\/projects\/CAP\/photos/);
  });

  it('lets an upload token open a thread with photos, never with words alone or a launch, once per delivery (2026-11-13)', async () => {
    const open = (token: string, body: Record<string, unknown>) => call('POST', '/v1/threads', token, body);
    const first = { project: 'MUS', title: 'The shelf', text: 'The shelf\nleft side', photos: [sha(png)], deliveryId: 'phone-new-1' };
    const opened = await open(phone.token, first);
    expect(opened).toMatchObject({ status: 201, json: { project: { key: 'MUS' }, title: 'The shelf', messages: [{ id: 1, text: 'The shelf\nleft side', by: { display: 'Robin · iPhone' }, photos: [{ sha256: sha(png) }], canView: true }] } });
    const key = opened.json!.key;
    // The phone's retry is the same thread, even once renamed; the same id with other photos or another project is refused.
    expect((await call('PATCH', `/v1/threads/${key}`, mac.token, { title: 'Shelf, renamed' })).status).toBe(200);
    expect(await open(phone.token, first)).toMatchObject({ status: 201, json: { key, title: 'Shelf, renamed', messages: [{ id: 1 }] } });
    expect((await open(phone.token, { ...first, photos: [sha(clean)] })).json?.error).toBe('deliveryId already used for a different thread');
    expect((await open(phone.token, { ...first, project: 'CAP' })).status).toBe(400);
    expect((await open(phone.token, { ...first, deliveryId: 'bad id!' })).status).toBe(400);
    // Words alone, a launch, a reader and a project it cannot see are refused.
    expect(await open(phone.token, { project: 'MUS', title: 'Words', text: 'only words' })).toMatchObject({ status: 403, json: { error: expect.stringMatching(/opening a thread with words needs scope post/) } });
    expect((await open(phone.token, { project: 'MUS', title: 'Link', photos: [sha(png)], launches: [{ steps: [{ do: 'open', url: 'https://example.com' }] }] })).json?.error).toBe('sending a launch needs scope post');
    expect((await open(reader.token, { project: 'MUS', title: 'No', photos: [sha(png)] })).status).toBe(403);
    expect((await open(outsider.token, { project: 'MUS', title: 'No', photos: [sha(png)] })).status).toBe(404);
    // A thread-scoped tester's thread lists them as its member, so it is theirs and the team's.
    const tester = await open(ana.token, { project: 'MUS', title: 'From Ana', photos: [sha(png)] });
    expect(tester.status).toBe(201);
    expect((await call('GET', `/v1/threads/${tester.json!.key}/photos/${sha(png)}`, ana.token)).status).toBe(200);
    expect((await call('GET', `/v1/threads/${tester.json!.key}`, headset.token)).json!.messages[0]).toMatchObject({ canView: false });
  });
});

describe('Photos from the CLI', () => {
  const agent = newToken(), phone = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: agent.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    { id: 'iphone', sha256: phone.sha256, scopes: ['upload'], label: 'iPhone' },
  ]);
  let base: string; let close: () => Promise<void>; let dir: string;

  beforeAll(async () => {
    const server = await testCli();
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: JSON.stringify([{ id: 'robin', name: 'Robin' }]) });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    dir = await mkdtemp(join(tmpdir(), 'cli-photo-'));
  });
  afterAll(async () => { await close?.(); });

  it('sends a photo as it is when it needs nothing but stripping', async () => {
    await writeFile(join(dir, 'shot.png'), makePng(30, 20, [chunk('tEXt', 'Comment\0TEXT-SECRET')]));
    const prepared = await preparePhoto('ffmpeg', join(dir, 'shot.png'));
    expect(prepared).toMatchObject({ name: 'shot.png', facts: { type: 'image/png', width: 30, height: 20 } });
    expect(prepared.note).toBeUndefined();
    expect(leaks(prepared.data)).toEqual([]);
  });

  it('turns a tagged JPEG upright and scales a wide PNG with ffmpeg, stripping what ffmpeg adds', async () => {
    await writeFile(join(dir, 'turned.jpg'), phoneJpeg(6));
    const turned = await preparePhoto('ffmpeg', join(dir, 'turned.jpg'));
    expect(turned.facts).toEqual({ type: 'image/jpeg', width: 16, height: 24 });
    expect(turned.note).toBe('turned.jpg: 24×16 JPEG sent as 16×24 JPEG');
    expect(leaks(turned.data)).toEqual([]);
    await writeFile(join(dir, 'wide.png'), makePng(5000, 10));
    const wide = await preparePhoto('ffmpeg', join(dir, 'wide.png'));
    expect(wide.facts).toEqual({ type: 'image/png', width: 4096, height: 8 });
    expect(wide.note).toBe('wide.png: 5000×10 PNG sent as 4096×8 PNG');
    await writeFile(join(dir, 'fake.heic'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]));
    await expect(preparePhoto('ffmpeg', join(dir, 'fake.heic'))).rejects.toThrow(/ffmpeg could not convert it .*; convert it to JPEG with sips -s format jpeg/);
    await writeFile(join(dir, 'notes.txt'), 'hello');
    await expect(preparePhoto('ffmpeg', join(dir, 'notes.txt'))).rejects.toThrow(/notes\.txt: is not a JPEG or PNG image/);
    await expect(preparePhoto('ffmpeg', join(dir, 'missing.jpg'))).rejects.toThrow(/no such file/);
  });

  it('posts --photo, then thread show saves each photo for the agent and prints its path', async () => {
    const cli = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: agent.token });
    await writeFile(join(dir, 'desk.jpg'), phoneJpeg(1));
    const key = await threadNew(cli, 'Desk', { project: 'MUS', text: 'Before and after.', photo: [join(dir, 'shot.png'), join(dir, 'desk.jpg')], cwd: dir });
    expect(cli.lines).toContain('shot.png (30×20, 1 kB) is on the receiver');
    await expect(threadReply(cli, key, { photo: Array.from({ length: 11 }, () => join(dir, 'desk.jpg')), cwd: dir })).rejects.toThrow(/at most 10 photos/);
    await expect(threadReply(cli, key, { cwd: dir })).rejects.toThrow(/needs --text, a --photo or a launch/);

    // The phone replies with a photo; the agent sees it as new work, then reads the thread.
    const phoneCli = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: phone.token });
    expect(await threadReply(phoneCli, key, { photo: [join(dir, 'turned.jpg')], cwd: dir })).toBe(2);
    expect((await threadPending(cli, { project: 'MUS', cwd: dir })).map(t => t.fresh)).toEqual([1]);
    cli.lines.length = 0;
    await threadShow(cli, key, { cwd: dir });
    const shown = cli.lines.join('\n');
    const saved = join(cli.config.photos, key);
    const files = (await readdir(saved)).sort();
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(shown).toContain(join(saved, file));
      const data = await readFile(join(saved, file));
      expect(sha(data)).toBe(file.split('.')[0]);
      expect((await stat(join(saved, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(saved)).mode & 0o777).toBe(0o700);
    expect(shown).toMatch(/photo 1 of 2: 30×20 PNG, 1 kB → /);
    expect(shown).toMatch(/photo 1: 16×24 JPEG, 1 kB → /);

    // --json gives each photo its path, for the Mac app; a second show fetches nothing again.
    const json = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: agent.token, POLYCAP_ROOT: cli.config.root });
    json.json = true;
    await threadShow(json, key, { cwd: dir });
    const thread = JSON.parse(json.lines.join('\n'));
    expect(thread.messages[0].photos.map((p: { path: string }) => p.path)).toEqual(thread.messages[0].photos.map((p: { sha256: string; type: string }) => join(saved, `${p.sha256}.${p.type === 'image/png' ? 'png' : 'jpg'}`)));
  });
});
