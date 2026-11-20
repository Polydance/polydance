/**
 * Asking to join (2026-11-11, src/server/join.ts): the homepage's form posts to /join, which checks the hidden field,
 * the time since the page loaded, the proof of work and the limits, keeps the request and emails only the team,
 * through a stand-in for AhaSend. Off unless POLYCAP_JOIN is set.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { Join, JOIN_LIMITS, parseJoin, workDigest, zeroBits } from '../src/server/join.js';
import type { Email, Mailer } from '../src/server/mail.js';
import { newToken } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';

const KEY = `aha-sk-${'k'.repeat(57)}`;
const NOTIFY = 'team@example.net';
const BITS = 8;

/** A nonce for the address at this stamp, as the homepage's join.js finds one. */
function work(stamp: number, email: string, bits = BITS): string {
  for (let n = 0; ; n++) if (zeroBits(workDigest(stamp, email, n.toString(36))) >= bits) return n.toString(36);
}

/** A form as the homepage sends it: loaded five seconds ago, the work done just now. */
function form(email: string, extra: Record<string, string> = {}): string {
  const stamp = Date.now();
  return new URLSearchParams({ email, headset: 'quest', note: 'Testing our WebXR app', company: '', started: String(Date.now() - 5000), stamp: String(stamp), nonce: work(stamp, email), ...extra }).toString();
}

async function fakeAhaSend() {
  const state = { sent: [] as Array<{ body: Record<string, any> }> };
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.sent.push({ body });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ object: 'message', id: `msg-${state.sent.length}`, status: 'queued' }] }));
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

describe('POLYCAP_JOIN', () => {
  it('is off when unset and refused unless whole', () => {
    expect(parseJoin(undefined)).toBeUndefined();
    expect(parseJoin(JSON.stringify({ notify: NOTIFY, site: 'https://polydance.net' }))).toEqual({ notify: NOTIFY, site: 'https://polydance.net', bits: 18 });
    expect(() => parseJoin('{')).toThrow(/not JSON/);
    expect(() => parseJoin(JSON.stringify({ site: 'https://polydance.net' }))).toThrow(/notify/);
    expect(() => parseJoin(JSON.stringify({ notify: NOTIFY, site: 'https://polydance.net/home' }))).toThrow(/site/);
    expect(() => parseJoin(JSON.stringify({ notify: NOTIFY, site: 'http://polydance.net' }))).toThrow(/site/);
    expect(() => parseJoin(JSON.stringify({ notify: NOTIFY, site: 'https://polydance.net', bits: 40 }))).toThrow(/bits/);
  });

  it('needs POLYCAP_MAIL, since every request is emailed', async () => {
    const t = newToken();
    await expect(serve(await testCli(), {
      host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'mac', sha256: t.sha256, scopes: ['read'] }]),
      join: JSON.stringify({ notify: NOTIFY, site: 'https://polydance.net' }),
    })).rejects.toThrow(/POLYCAP_JOIN needs POLYCAP_MAIL/);
  });
});

describe('/join on the receiver', () => {
  let base: string; let off: string; let root: string;
  let close: () => Promise<void>; let closeOff: () => Promise<void>; let aha: Awaited<ReturnType<typeof fakeAhaSend>>;
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/join`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, redirect: 'manual' });

  beforeAll(async () => {
    aha = await fakeAhaSend();
    const t = newToken();
    const cli = await testCli();
    root = cli.config.root;
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'mac', sha256: t.sha256, scopes: ['read'] }]),
      mail: { POLYCAP_MAIL: JSON.stringify({ provider: 'ahasend', accountId: 'acc-1', from: { email: 'hello@mail.example.net', name: 'Polydance' }, replyTo: { email: 'team@example.net' } }), POLYCAP_AHASEND_KEY: KEY, POLYCAP_AHASEND_URL: aha.url, POLYCAP_PUBLIC_URL: 'https://receiver.example' },
      join: JSON.stringify({ notify: NOTIFY, site: 'https://polydance.net', bits: BITS }),
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
    const plain = await serve(await testCli(), { host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'mac', sha256: newToken().sha256, scopes: ['read'] }]) });
    off = `http://127.0.0.1:${plain.port}`; closeOff = plain.close;
  });
  afterAll(async () => { await close?.(); await closeOff?.(); await aha?.close(); });

  it('answers 404 on a receiver without POLYCAP_JOIN, whose privacy notice says nothing of it', async () => {
    expect((await fetch(`${off}/join`, { method: 'POST', body: form('a@example.com'), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(404);
    const without = await (await fetch(`${off}/privacy`)).text();
    expect(without).not.toContain('Asking to join');
    expect(without, 'another receiver\'s notice would claim the website\'s analytics').not.toContain('Google Analytics');
    const notice = await (await fetch(`${base}/privacy`)).text();
    expect(notice).toContain('Asking to join, from the website');
    // The homepage's Google Analytics, asked for first (site/analytics.js), with the property's retention and signals.
    for (const words of ['Counting visits to the website', 'only if you allow it', '2 months', '14 months', 'Google signals is off', 'saying no removes the cookies']) expect(notice).toContain(words);
  });

  it('keeps a request and emails the team, with a reply going to the person asking', async () => {
    const res = await post(form('Ana@Example.com '));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Thanks, we have it');
    expect(aha.state.sent).toHaveLength(1);
    const [{ body }] = aha.state.sent;
    expect(body.recipients).toEqual([{ email: NOTIFY }]);
    expect(body.reply_to).toEqual({ email: 'ana@example.com' });
    expect(body.subject).toBe('Polydance: ana@example.com asked to join (Meta Quest)');
    expect(body.text_content).toContain('Note: Testing our WebXR app');
    const file = join(root, 'join.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.requests).toHaveLength(1);
    expect(saved.requests[0]).toMatchObject({ email: 'ana@example.com', headset: 'quest', status: 'emailed', messageId: 'msg-1' });
    expect(saved.requests[0].sender).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(saved)).not.toContain('127.0.0.1');
  });

  it('takes one request per address a day', async () => {
    const res = await post(form('ana@example.com'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('We have it already');
    expect(aha.state.sent).toHaveLength(1);
  });

  it('thanks whatever fills in the hidden field, and keeps and sends nothing', async () => {
    const res = await post(form('bot@example.com', { company: 'Acme' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Thanks, we have it');
    expect(aha.state.sent).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, 'join.json'), 'utf8')).requests).toHaveLength(1);
  });

  it('refuses work not done, a form sent too quickly, and an old stamp', async () => {
    const stamp = Date.now();
    const lazy = new URLSearchParams({ email: 'lazy@example.com', headset: 'quest', started: String(stamp - 5000), stamp: String(stamp), nonce: 'zz' });
    // A nonce that happens to do the work would pass; find one that does not.
    for (let n = 0; zeroBits(workDigest(stamp, 'lazy@example.com', lazy.get('nonce')!)) >= BITS; n++) lazy.set('nonce', `x${n}`);
    expect((await post(lazy.toString())).status).toBe(400);
    expect((await post(form('quick@example.com', { started: String(Date.now() - 500) }))).status).toBe(400);
    const old = Date.now() - JOIN_LIMITS.stampAgeMs - 60_000;
    const stale = new URLSearchParams({ email: 'old@example.com', headset: 'quest', started: String(old - 5000), stamp: String(old), nonce: work(old, 'old@example.com') });
    const res = await post(stale.toString());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too quickly, or after too long');
    // Work done for one address does not carry over to another.
    const at = Date.now();
    let n = 0;
    // A nonce done for first@, which by chance would not also do for second@.
    while (zeroBits(workDigest(at, 'first@example.com', n.toString(36))) < BITS || zeroBits(workDigest(at, 'second@example.com', n.toString(36))) >= BITS) n++;
    const borrowed = new URLSearchParams({ email: 'second@example.com', headset: 'quest', started: String(at - 5000), stamp: String(at), nonce: n.toString(36) });
    expect((await post(borrowed.toString())).status).toBe(400);
    expect(aha.state.sent).toHaveLength(1);
  });

  it('limits each sender to a few requests an hour, telling them apart by nginx\'s X-Real-IP', async () => {
    const from = { 'x-real-ip': '203.0.113.7' };
    for (let i = 0; i < JOIN_LIMITS.perSenderPerHour; i++) expect((await post(form(`person${i}@example.com`), from)).status).toBe(200);
    const res = await post(form('one-more@example.com'), from);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Too many requests');
    // Another sender is unaffected.
    expect((await post(form('elsewhere@example.com'), { 'x-real-ip': '198.51.100.4' })).status).toBe(200);
    expect(aha.state.sent.map(s => s.body.recipients[0].email)).toEqual(Array(aha.state.sent.length).fill(NOTIFY));
  });

  it('sends anything else back to the form: a GET, the wrong type, too much', async () => {
    const get = await fetch(`${base}/join`, { redirect: 'manual' });
    expect(get.status).toBe(303);
    expect(get.headers.get('location')).toBe('https://polydance.net/#join');
    expect((await fetch(`${base}/join`, { method: 'POST', body: JSON.stringify({ email: 'a@b.co' }), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await post(form('big@example.com', { note: 'x'.repeat(5000) }))).status).toBe(413);
  });
});

describe('Join on its own', () => {
  it('keeps requests past the hourly email limit without emailing them', async () => {
    const sent: Email[] = [];
    const mailer: Mailer = { describe: () => 'stand-in', send: async email => { sent.push(email); return { id: `m${sent.length}` }; } };
    const logs: string[] = [];
    const root = await mkdtemp(join(tmpdir(), 'polycap-join-'));
    const joining = new Join(root, { notify: NOTIFY, site: 'https://polydance.net', bits: 4 }, mailer, line => logs.push(line));
    const take = (i: number) => {
      const stamp = Date.now();
      const email = `p${i}@example.com`;
      const body = new URLSearchParams({ email, headset: 'none', started: String(stamp - 5000), stamp: String(stamp), nonce: work(stamp, email, 4) }).toString();
      return joining.take(body, `192.0.2.${i}`);
    };
    for (let i = 0; i < JOIN_LIMITS.emailsPerHour + 2; i++) expect(await take(i)).toBe('thanks');
    expect(sent).toHaveLength(JOIN_LIMITS.emailsPerHour);
    const saved = JSON.parse(await readFile(join(root, 'join.json'), 'utf8'));
    expect(saved.requests).toHaveLength(JOIN_LIMITS.emailsPerHour + 2);
    expect(saved.requests.filter((r: { status: string }) => r.status === 'kept')).toHaveLength(2);
    expect(logs.some(l => /kept, not emailed/.test(l))).toBe(true);
  });
});

describe('deploy/receiver/enable-join.py', () => {
  it('sets POLYCAP_JOIN only where email is on, in a way the receiver then starts with', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-enable-join-'));
    const path = join(dir, 'receiver.env');
    const run = (...args: string[]) => spawnSync('python3', ['deploy/receiver/enable-join.py', path, ...args], { encoding: 'utf8' });
    const mail = JSON.stringify({ provider: 'folder', from: { email: 'hello@mail.example.net' } });
    await writeFile(path, 'POLYCAP_SERVER_TOKENS=[]\n', { mode: 0o600 });
    const refused = run('--notify', NOTIFY);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('POLYCAP_MAIL is not set');
    await writeFile(path, `POLYCAP_SERVER_TOKENS=[]\nPOLYCAP_MAIL=${mail}\nPOLYCAP_PUBLIC_URL=http://localhost:8790\n`, { mode: 0o600 });
    expect(run('--notify', 'not-an-address').status).not.toBe(0);
    const done = run('--notify', 'Team@Example.net');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain('requests emailed to team@example.net, from the form on https://polydance.net, 18-bit work');
    // Run again with another address: one setting, replaced, and a backup of each run beside the file.
    expect(run('--notify', NOTIFY, '--bits', '16').status).toBe(0);
    const text = await readFile(path, 'utf8');
    expect(text.match(/^POLYCAP_JOIN=/gm)).toHaveLength(1);
    const value = text.split('\n').find(l => l.startsWith('POLYCAP_JOIN='))!.slice('POLYCAP_JOIN='.length);
    expect(parseJoin(value)).toEqual({ notify: NOTIFY, site: 'https://polydance.net', bits: 16 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter(f => f.includes('.bak-'))).toHaveLength(2);
  });
});

