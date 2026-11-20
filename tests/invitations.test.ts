/**
 * Inviting by email (2026-11-10, src/server/invitations.ts, mail.ts, email-pages.ts): the team's additions are
 * emailed through a stand-in for AhaSend, a person's own address is confirmed from an emailed link, and an
 * address can stop all email; then the outbox's limits, expiry and restarts on their own.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { Invitations, LIMITS } from '../src/server/invitations.js';
import { parseMail, type Email, type Mailer } from '../src/server/mail.js';
import { newToken } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';

const KEY = `aha-sk-${'k'.repeat(57)}`;

interface Sent { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, any> }

/** AhaSend's send endpoint as its docs describe it: 202 with one message per recipient; or what a test sets. */
async function fakeAhaSend() {
  const state = { sent: [] as Sent[], refuse: undefined as undefined | { status: number; json: unknown } };
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.sent.push({ url: req.url ?? '', headers: req.headers, body });
    const answer = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (state.refuse) { const r = state.refuse; state.refuse = undefined; return answer(r.status, r.json); }
    answer(202, { object: 'list', data: [{ object: 'message', id: `msg-${state.sent.length}`, status: 'queued', recipient: body.recipients[0] }] });
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

describe('POLYCAP_MAIL', () => {
  const settings = (extra: object = {}) => JSON.stringify({ provider: 'ahasend', accountId: 'acc-1', from: { email: 'invitations@mail.example.net', name: 'Polydance' }, ...extra });
  it('is off when unset and refused unless whole', () => {
    expect(parseMail({}, '/tmp')).toBeUndefined();
    const ok = parseMail({ POLYCAP_MAIL: settings(), POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'https://receiver.example/' }, '/tmp');
    expect(ok?.publicUrl).toBe('https://receiver.example');
    expect(ok?.settings).toMatchObject({ tags: ['polydance'], sandbox: false });
    expect(() => parseMail({ POLYCAP_MAIL: '{', POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'https://r.example' }, '/tmp')).toThrow(/not JSON/);
    expect(() => parseMail({ POLYCAP_MAIL: settings({ accountId: undefined }), POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'https://r.example' }, '/tmp')).toThrow(/accountId/);
    expect(() => parseMail({ POLYCAP_MAIL: settings(), POLYCAP_AHASEND_KEY: KEY }, '/tmp')).toThrow(/POLYCAP_PUBLIC_URL/);
    expect(() => parseMail({ POLYCAP_MAIL: settings(), POLYCAP_PUBLIC_URL: 'https://r.example' }, '/tmp')).toThrow(/POLYCAP_AHASEND_KEY/);
    expect(() => parseMail({ POLYCAP_MAIL: settings(), POLYCAP_AHASEND_KEY: 'sk-ant-nope', POLYCAP_PUBLIC_URL: 'https://r.example' }, '/tmp')).toThrow(/not an AhaSend API key/);
    expect(() => parseMail({ POLYCAP_MAIL: settings(), POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'http://r.example' }, '/tmp')).toThrow(/https/);
    expect(() => parseMail({ POLYCAP_MAIL: settings(), POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'https://r.example/path' }, '/tmp')).toThrow(/no path/);
    expect(() => parseMail({ POLYCAP_MAIL: settings({ from: { email: 'x', name: 'P' } }), POLYCAP_AHASEND_KEY: KEY, POLYCAP_PUBLIC_URL: 'https://r.example' }, '/tmp')).toThrow(/from.email/);
    // The folder mailer needs no key, and its links may be this machine's.
    expect(parseMail({ POLYCAP_MAIL: JSON.stringify({ provider: 'folder', from: { email: 'a@b.co' } }), POLYCAP_PUBLIC_URL: 'http://localhost:8791' }, '/tmp')?.mailer.describe()).toMatch(/nothing is sent/);
  });
});

describe('invitations on the receiver', () => {
  const mac = newToken(), robinQuest = newToken(), anaQuest = newToken(), eveQuest = newToken();
  const tokens = JSON.stringify([
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' },
    // Robin's own headset: upload only, so not a team token, but its person holds one.
    { id: 'quest3', sha256: robinQuest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'robin' },
    { id: 'ana-quest', sha256: anaQuest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'ana', projects: ['MUS'], threads: 'member' },
    { id: 'eve-quest', sha256: eveQuest.sha256, scopes: ['upload'], label: 'Quest 3', user: 'eve', projects: ['MUS'], threads: 'member' },
  ]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }, { id: 'eve', name: 'Eve' }]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba' }]);
  let base: string; let close: () => Promise<void>; let aha: Awaited<ReturnType<typeof fakeAhaSend>>;

  beforeAll(async () => {
    aha = await fakeAhaSend();
    const running = await serve(await testCli(), {
      host: '127.0.0.1', port: 0, tokens, projects, users,
      mail: {
        POLYCAP_MAIL: JSON.stringify({ provider: 'ahasend', accountId: 'acc-1', from: { email: 'invitations@mail.example.net', name: 'Polydance' }, replyTo: { email: 'robin@example.net' } }),
        POLYCAP_AHASEND_KEY: KEY, POLYCAP_AHASEND_URL: aha.url, POLYCAP_PUBLIC_URL: 'https://receiver.example',
      },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); await aha?.close(); });

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const page = async (method: string, link: string) => {
    const response = await fetch(link.replace('https://receiver.example', base), { method, ...(method === 'POST' ? { body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) });
    return { status: response.status, html: await response.text(), csp: response.headers.get('content-security-policy') };
  };
  const newThread = async (title: string) => (await call('POST', '/v1/threads', mac.token, { project: 'MUS', title, text: 'Secret plans for the menu' })).json.key as string;
  const invite = (token: string, key: string, change: object) => call('POST', `/v1/threads/${key}/participants`, token, change);
  const sentTo = (email: string) => aha.state.sent.filter(s => s.body.recipients[0].email === email);
  const participant = async (key: string, email: string) => ((await call('GET', `/v1/threads/${key}`, mac.token)).json.participants as { email: string }[]).find(p => p.email === email) as Record<string, any>;
  const link = (sent: Sent, kind: 'confirm' | 'stop') => sent.body.text_content.match(new RegExp(`https://receiver\\.example/email/${kind}/[^\\s]+`))![0] as string;

  it('emails the team\'s new address once per thread, through AhaSend as its docs describe, with no thread content', async () => {
    const key = await newThread('New menu');
    const added = await invite(mac.token, key, { add: ['Quinn@Example.com'] });
    expect(added.status).toBe(200);
    expect(added.json.participants).toEqual([expect.objectContaining({ email: 'quinn@example.com', emailed: false, emailNote: 'sending' })]);
    await expect.poll(() => sentTo('quinn@example.com').length).toBe(1);
    const [sent] = sentTo('quinn@example.com');
    expect(sent.url).toBe('/v2/accounts/acc-1/messages');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers['idempotency-key']).toMatch(/^m_[0-9a-f]{16}$/);
    expect(sent.body).toMatchObject({
      from: { email: 'invitations@mail.example.net', name: 'Polydance' }, recipients: [{ email: 'quinn@example.com' }], reply_to: { email: 'robin@example.net' },
      subject: 'Robin added you to "New menu" on Polydance', tags: ['polydance'], tracking: { open: false, click: false }, sandbox: false,
    });
    expect(sent.body.headers['List-Unsubscribe']).toMatch(/^<https:\/\/receiver\.example\/email\/stop\/[0-9a-f]{64}\.[0-9a-f]{32}>$/);
    expect(sent.body.text_content).toContain('Robin added you to the thread "New menu" (Marimba) on Polydance.');
    expect(sent.body.text_content).toContain('https://receiver.example/start#invited');
    expect(sent.body.text_content).not.toContain('Secret plans');
    expect(sent.body.html_content).not.toContain('Secret plans');
    await expect.poll(async () => (await participant(key, 'quinn@example.com')).emailed).toBe(true);
    expect((await participant(key, 'quinn@example.com')).emailedAt).toBeTruthy();
    // Out and in again: still the one email for this thread. Another thread is another invitation.
    await invite(mac.token, key, { remove: ['quinn@example.com'] });
    await invite(mac.token, key, { add: ['quinn@example.com'] });
    const other = await newThread('Settings');
    await invite(mac.token, other, { add: ['quinn@example.com'] });
    await expect.poll(() => sentTo('quinn@example.com').length).toBe(2);
    expect(sentTo('quinn@example.com')[1]!.body.subject).toBe('Robin added you to "Settings" on Polydance');
  });

  it('counts Robin\'s own headset as the team, and never emails what a tester adds', async () => {
    const key = await newThread('Headset invite');
    expect((await invite(robinQuest.token, key, { add: ['tove@example.com'] })).status).toBe(200);
    await expect.poll(() => sentTo('tove@example.com').length).toBe(1);
    expect((await call('POST', `/v1/threads/${key}/members`, mac.token, { add: ['ana'] })).status).toBe(200);
    const byAna = await invite(anaQuest.token, key, { add: ['stranger@example.com'] });
    expect(byAna.status).toBe(200);
    expect(byAna.json.participants.find((p: { email: string }) => p.email === 'stranger@example.com')).toMatchObject({ emailed: false, emailNote: 'only addresses the team adds are emailed' });
    expect((await invite(anaQuest.token, key, { resend: ['tove@example.com'] })).status).toBe(403);
    await new Promise(done => setTimeout(done, 50));
    expect(sentTo('stranger@example.com')).toHaveLength(0);
  });

  it('records a refusal without retrying it, and sends again only when the team asks', async () => {
    const key = await newThread('Refused');
    aha.state.refuse = { status: 403, json: { message: "this api key is not authorized to send messages from the domain 'mail.example.net'" } };
    await invite(mac.token, key, { add: ['refused@example.com'] });
    await expect.poll(async () => (await participant(key, 'refused@example.com')).emailNote).toMatch(/^AhaSend refused it \(403\): this api key is not authorized/);
    expect(JSON.stringify(await participant(key, 'refused@example.com'))).not.toContain(KEY);
    await new Promise(done => setTimeout(done, 50));
    expect(sentTo('refused@example.com')).toHaveLength(1);
    expect((await invite(mac.token, key, { resend: ['nobody@example.com'] })).status).toBe(400);
    expect((await invite(mac.token, key, { resend: ['refused@example.com'] })).status).toBe(200);
    await expect.poll(async () => (await participant(key, 'refused@example.com')).emailed).toBe(true);
    expect(sentTo('refused@example.com')).toHaveLength(2);
  });

  it('confirms a person\'s own address from the emailed link, only when its button is pressed, and their invited threads follow', async () => {
    const invited = await newThread('Waiting for Ana');
    await invite(mac.token, invited, { add: ['ana@example.com'] });
    expect((await call('GET', '/v1/threads', anaQuest.token)).json.threads.map((t: { key: string }) => t.key)).not.toContain(invited);
    const set = await call('POST', '/v1/me', anaQuest.token, { email: 'ana@example.com' });
    expect(set.json).toMatchObject({ person: { email: 'ana@example.com', emailVerified: false }, confirmation: { status: 'sending' } });
    await expect.poll(() => sentTo('ana@example.com').filter(s => s.body.subject === 'Confirm your address for Polydance').length).toBe(1);
    const confirm = link(sentTo('ana@example.com').find(s => s.body.subject === 'Confirm your address for Polydance')!, 'confirm');
    // Opening the link (as a mail scanner does) shows the button and verifies nothing.
    const shown = await page('GET', confirm);
    expect(shown.status).toBe(200);
    expect(shown.html).toContain('a•••@example.com');
    expect(shown.html).toContain('<form method="post">');
    expect(shown.csp).toContain("form-action 'self'");
    expect((await call('GET', '/v1/me', anaQuest.token)).json.person.emailVerified).toBe(false);
    const pressed = await page('POST', confirm);
    expect(pressed.status).toBe(200);
    expect(pressed.html).toContain('Your address is confirmed');
    expect((await call('GET', '/v1/me', anaQuest.token)).json.person.emailVerified).toBe(true);
    expect((await call('GET', '/v1/threads', anaQuest.token)).json.threads.map((t: { key: string }) => t.key)).toContain(invited);
    expect((await page('POST', confirm)).status).toBe(410);
    expect((await page('GET', 'https://receiver.example/email/confirm/not-a-token')).status).toBe(410);
    // The same address again stays confirmed, and asks for no new link.
    const again = await call('POST', '/v1/me', anaQuest.token, { email: 'ana@example.com' });
    expect(again.json.person.emailVerified).toBe(true);
    expect(again.json.confirmation).toBeUndefined();
    // Invited later, a confirmed address is told the thread is already theirs.
    const later = await newThread('Later');
    await invite(mac.token, later, { add: ['ana@example.com'] });
    await expect.poll(() => sentTo('ana@example.com').some(s => s.body.subject === 'Robin added you to "Later" on Polydance')).toBe(true);
    expect(sentTo('ana@example.com').find(s => s.body.subject.includes('"Later"'))!.body.text_content).toContain('It is in your Polydance inbox now.');
  });

  it('never lets someone else take a confirmed address: no link is sent, and an older link no longer works (auth audit, 2026-11-12)', async () => {
    const key = await newThread('Ana\'s alone');
    await invite(mac.token, key, { add: ['ana@example.com'] });
    // Ana confirmed her address in the test above. Eve enters it: Ana is not asked, and Eve is told no.
    const confirmations = () => sentTo('ana@example.com').filter(s => s.body.subject === 'Confirm your address for Polydance').length;
    const before = confirmations();
    const eve = await call('POST', '/v1/me', eveQuest.token, { email: 'ana@example.com' });
    expect(eve.json.person).toMatchObject({ email: 'ana@example.com', emailVerified: false });
    expect(eve.json.confirmation).toEqual({ status: 'not sent', note: 'Polydance cannot confirm this address for this account; ask whoever invited you' });
    await new Promise(done => setTimeout(done, 50));
    expect(confirmations()).toBe(before);
    expect((await call('GET', `/v1/threads/${key}`, eveQuest.token)).status).toBe(404);
    // A link Eve got for an address nobody had confirmed yet stops working once its owner confirms it.
    await call('POST', '/v1/me', eveQuest.token, { email: 'cara@example.com' });
    await expect.poll(() => sentTo('cara@example.com').length).toBe(1);
    const evesLink = link(sentTo('cara@example.com')[0]!, 'confirm');
    expect(sentTo('cara@example.com')[0]!.body.text_content).toContain('Confirm only if you entered it yourself just now');
    await call('POST', '/v1/me', anaQuest.token, { email: 'cara@example.com' });
    await expect.poll(() => sentTo('cara@example.com').length).toBe(2);
    expect((await page('POST', link(sentTo('cara@example.com')[1]!, 'confirm'))).status).toBe(200);
    const pressed = await page('POST', evesLink);
    expect(pressed.status).toBe(409);
    expect(pressed.html).toContain('already confirmed');
    expect((await call('GET', '/v1/me', eveQuest.token)).json.person.emailVerified).toBe(false);
  });

  it('stops all email to an address from its link, after the button or a one-click POST', async () => {
    const key = await newThread('Stop me');
    await invite(mac.token, key, { add: ['stop@example.com'] });
    await expect.poll(() => sentTo('stop@example.com').length).toBe(1);
    const stop = link(sentTo('stop@example.com')[0]!, 'stop');
    expect((await page('GET', stop)).html).toContain('<form method="post">');
    expect((await page('POST', stop)).html).toContain('will not email this address again');
    const other = await newThread('After stopping');
    const added = await invite(mac.token, other, { add: ['stop@example.com'] });
    expect(added.json.participants[0]).toMatchObject({ emailed: false, emailNote: 'this address asked Polydance to stop emailing it' });
    await new Promise(done => setTimeout(done, 50));
    expect(sentTo('stop@example.com')).toHaveLength(1);
    expect((await page('GET', `${stop.slice(0, -4)}0000`)).status).toBe(404);
  });
});

describe('the outbox on its own', () => {
  const recorder = () => { const sent: Email[] = []; const mailer: Mailer = { describe: () => 'test', send: async email => { sent.push(email); return { id: `id-${sent.length}` }; } }; return { sent, mailer }; };
  const about = (n: number) => ({ key: `MUS-${n}`, title: `Thread ${n}`, project: 'Marimba' });

  it('holds an address to its daily limit, and a person to theirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invitations-'));
    let now = Date.parse('2026-11-10T12:00:00Z');
    const { sent, mailer } = recorder();
    const mail = new Invitations(dir, mailer, 'https://r.example', () => undefined, () => now);
    for (let n = 1; n <= LIMITS.perAddressPerDay + 1; n++) await mail.invite('busy@example.com', about(n), 'Robin');
    await mail.idle();
    expect(sent).toHaveLength(LIMITS.perAddressPerDay);
    expect((await mail.statuses(`MUS-${LIMITS.perAddressPerDay + 1}`)).get('busy@example.com')).toMatchObject({ emailed: false, emailNote: expect.stringMatching(/5 emails today/) });
    for (let n = 0; n <= LIMITS.confirmationsPerPersonPerDay; n++) await mail.confirmFor('ana', `ana${n}@example.com`);
    await mail.idle();
    expect(sent.filter(e => e.subject.startsWith('Confirm'))).toHaveLength(LIMITS.confirmationsPerPersonPerDay);
    now += 25 * 3600_000;
    await mail.invite('busy@example.com', about(99), 'Robin');
    await mail.idle();
    expect(sent.filter(e => e.to === 'busy@example.com')).toHaveLength(LIMITS.perAddressPerDay + 1);
  });

  it('keeps a confirmation link for 48 hours, replaces it with a newer one, and stores only its hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invitations-'));
    let now = Date.parse('2026-11-10T12:00:00Z');
    const { sent, mailer } = recorder();
    const mail = new Invitations(dir, mailer, 'https://r.example', () => undefined, () => now);
    await mail.confirmFor('ana', 'ana@example.com');
    await mail.idle();
    const token = sent[0]!.text.match(/\/email\/confirm\/([A-Za-z0-9_-]{43})/)![1]!;
    expect(await readFile(join(dir, 'mail.json'), 'utf8')).not.toContain(token);
    expect((await stat(join(dir, 'mail.json'))).mode & 0o777).toBe(0o600);
    expect(await mail.lookup(token)).toEqual({ ok: true, email: 'ana@example.com', person: 'ana' });
    now += 49 * 3600_000;
    expect(await mail.lookup(token)).toEqual({ ok: false, why: 'expired' });
    await mail.confirmFor('ana', 'ana@example.com');
    await mail.idle();
    const second = sent[1]!.text.match(/\/email\/confirm\/([A-Za-z0-9_-]{43})/)![1]!;
    await mail.confirmFor('ana', 'ana@example.com');
    await mail.idle();
    expect(await mail.lookup(second)).toEqual({ ok: false, why: 'expired' });
  });

  it('sends what a restart left queued, once, and never retries a failure by itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'invitations-'));
    const stuck: Mailer = { describe: () => 'stuck', send: () => new Promise(() => {}) };
    const first = new Invitations(dir, stuck, 'https://r.example', () => undefined);
    await first.invite('later@example.com', about(1), 'Robin');
    const { sent, mailer } = recorder();
    const restarted = new Invitations(dir, mailer, 'https://r.example', () => undefined);
    restarted.kick();
    await restarted.idle();
    restarted.kick();
    await restarted.idle();
    expect(sent.map(e => e.to)).toEqual(['later@example.com']);
    const failing: Mailer = { describe: () => 'failing', send: async () => { throw new Error('boom'); } };
    const lines: string[] = [];
    const broken = new Invitations(await mkdtemp(join(tmpdir(), 'invitations-')), failing, 'https://r.example', line => lines.push(line));
    await broken.invite('x@example.com', about(2), 'Robin');
    await broken.idle();
    broken.kick();
    await broken.idle();
    expect((await broken.statuses('MUS-2')).get('x@example.com')).toEqual({ emailed: false, emailNote: 'could not send it' });
    expect(lines).toHaveLength(1);
  });

  it('writes to a folder instead with the folder mailer, in Polydance\'s colours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mail-folder-'));
    const parsed = parseMail({ POLYCAP_MAIL: JSON.stringify({ provider: 'folder', from: { email: 'invitations@mail.example.net', name: 'Polydance' } }), POLYCAP_PUBLIC_URL: 'http://localhost:8791' }, root)!;
    const mail = new Invitations(root, parsed.mailer, parsed.publicUrl, () => undefined);
    await mail.invite('quinn@example.com', about(3), 'Robin');
    await mail.idle();
    const files = await readdir(join(root, 'mail-outbox'));
    expect(files.filter(f => f.endsWith('.eml'))).toHaveLength(1);
    const eml = await readFile(join(root, 'mail-outbox', files.find(f => f.endsWith('.eml'))!), 'utf8');
    expect(eml).toContain('Subject: Robin added you to "Thread 3" on Polydance');
    expect(eml).toContain('http://localhost:8791/start#invited');
    for (const f of files) expect((await stat(join(root, 'mail-outbox', f))).mode & 0o777).toBe(0o600);
    const html = await readFile(join(root, 'mail-outbox', files.find(f => f.endsWith('.html'))!), 'utf8');
    const tokens = new Set(Object.values((JSON.parse(await readFile('design/tokens.json', 'utf8')) as { colors: Record<string, string> }).colors));
    const used = [...html.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map(m => m[0].toUpperCase());
    expect(used.length).toBeGreaterThan(2);
    for (const colour of used) expect(tokens.has(colour), `${colour} in an email is not a token`).toBe(true);
  });
});

describe('enable-mail settings helper (temporary files only)', () => {
  it('sets the mail settings and a test person, reads the key from stdin only, and the receiver starts on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-enable-mail-'));
    const path = join(dir, 'receiver.env');
    const mac = newToken();
    await writeFile(path, `POLYCAP_SERVER_TOKENS=${JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' }])}\nPOLYCAP_USERS=[{"id":"robin","name":"Robin"}]\n`, { mode: 0o600 });
    const run = (input: string, ...args: string[]) => spawnSync('python3', ['deploy/receiver/enable-mail.py', path, ...args], { input, encoding: 'utf8' });
    expect(run('', '--account', 'acc-1', '--from', 'invitations@mail.example.net', '--sandbox').status).not.toBe(0);
    expect(run('not-a-key', '--account', 'acc-1', '--from', 'invitations@mail.example.net', '--sandbox').status).not.toBe(0);
    const done = run(KEY, '--account', 'acc-1', '--from', 'Invitations@mail.example.net', '--reply-to', 'robin@example.net', '--sandbox', '--test-person');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).not.toContain(KEY);
    expect(done.stdout).toContain('sandbox (nothing delivered)');
    const env = Object.fromEntries((await readFile(path, 'utf8')).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(JSON.parse(env.POLYCAP_MAIL!)).toEqual({ provider: 'ahasend', accountId: 'acc-1', from: { email: 'invitations@mail.example.net', name: 'Polydance' }, tags: ['polydance'], sandbox: true, replyTo: { email: 'robin@example.net' } });
    expect(env.POLYCAP_AHASEND_KEY).toBe(KEY);
    expect(JSON.parse(env.POLYCAP_USERS!)).toEqual([{ id: 'robin', name: 'Robin' }, { id: 'newcomer-test', name: 'Test newcomer' }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // Live, with the key kept from before.
    const live = run('', '--account', 'acc-1', '--from', 'invitations@mail.example.net', '--live', '--test-person');
    expect(live.status, live.stderr).toBe(0);
    expect(live.stdout).toContain('key: kept');
    const after = Object.fromEntries((await readFile(path, 'utf8')).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(JSON.parse(after.POLYCAP_MAIL!).sandbox).toBe(false);
    const running = await serve(await testCli(), { host: '127.0.0.1', port: 0, tokens: after.POLYCAP_SERVER_TOKENS, users: after.POLYCAP_USERS, mail: { POLYCAP_MAIL: after.POLYCAP_MAIL, POLYCAP_AHASEND_KEY: after.POLYCAP_AHASEND_KEY, POLYCAP_PUBLIC_URL: after.POLYCAP_PUBLIC_URL } });
    await running.close();
  });
});
