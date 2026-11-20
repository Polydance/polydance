/** Store testers signing in with their Meta account (private/docs/STORE.md), against a stand-in for Meta's Graph API, and the privacy notice. */
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { MetaGraph, parseMetaConfig } from '../src/server/meta.js';
import { ACCEPTED_CONSENT_VERSIONS, CONSENT_VERSION, privacyHtml } from '../src/server/privacy.js';
import { MAX_VERIFIED_AGE_MS, Testers } from '../src/server/testers.js';
import { authenticate, isTeam, memberScoped, newToken, type Grant } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';

const APP_ID = '1300818073125870';
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const NONCE = 'synthetic-sensitive-nonce';
const PROJECTS = JSON.stringify([{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Polydance Capture' }]);
const USERS = JSON.stringify([{ id: 'robin', name: 'Robin' }]);

/** Meta's two calls as the docs describe them: form bodies with the app's access token, JSON answers. */
async function fakeMeta() {
  const state = { nonces: new Map<string, string>(), entitled: new Set<string>(), down: false, refusal: undefined as { status: number; json: unknown } | undefined, errorMessage: `upstream echoed OC|${APP_ID}|${SECRET} nonce=${NONCE}`, hold: undefined as Promise<void> | undefined, calls: [] as Record<string, string>[] };
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    state.calls.push({ path: req.url ?? '', ...form });
    const answer = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (state.hold) await state.hold;
    if (state.down) return answer(503, { error: { message: state.errorMessage } });
    if (state.refusal) return answer(state.refusal.status, state.refusal.json);
    if (form.access_token !== `OC|${APP_ID}|${SECRET}`) return answer(400, { error: { message: 'Invalid OAuth access token' } });
    if (req.url === '/user_nonce_validate') return answer(200, { is_valid: state.nonces.get(form.nonce) === form.user_id });
    if (req.url === `/${APP_ID}/verify_entitlement`) return answer(200, state.entitled.has(form.user_id) ? { success: true, grant_time: 1744148687 } : { success: false });
    answer(404, { error: { message: 'Unknown path' } });
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

describe('Meta sign-in settings', () => {
  const testers = JSON.stringify({ projects: ['MUS'] });
  it('is off with nothing set and refuses half a setup', () => {
    expect(parseMetaConfig({})).toBeUndefined();
    expect(() => parseMetaConfig({ POLYCAP_META_APP_ID: APP_ID })).toThrow(/POLYCAP_META_APP_SECRET, POLYCAP_META_TESTERS missing/);
    expect(() => parseMetaConfig({ POLYCAP_META_APP_ID: 'polydance', POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: testers })).toThrow(/app's number/);
    expect(() => parseMetaConfig({ POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: '{"projects":[]}' })).toThrow(/projects/);
    expect(() => parseMetaConfig({ POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: testers, POLYCAP_META_GRAPH_URL: 'http://graph.example' })).toThrow(/https/);
    expect(parseMetaConfig({ POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: testers }))
      .toMatchObject({ appId: APP_ID, graphUrl: 'https://graph.oculus.com', testers: { projects: ['MUS'], maxTesters: 25, people: {}, blockedUsers: [] } });
  });

  it.each([{ blockedUsers: ['abc'] }, { blockedUsers: [123] }, { blockedUsers: ['1'.repeat(21)] }, { blockedUsers: '1001' }, { blockedUsers: null }])('rejects malformed blocklist $blockedUsers', ({ blockedUsers }) => {
    expect(() => parseMetaConfig({ POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], blockedUsers }) })).toThrow(/blockedUsers/);
  });

  it('keeps meta- ids for testers', async () => {
    const cli = await testCli();
    const taken = JSON.stringify([{ id: 'meta-1', sha256: newToken().sha256, scopes: ['upload'] }]);
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens: taken })).rejects.toThrow(/belong to testers/);
    const tokens = JSON.stringify([{ id: 'mac', sha256: newToken().sha256, scopes: ['read'] }]);
    const meta = { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['PD'] }) };
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, meta })).rejects.toThrow(/PD, which POLYCAP_PROJECTS does not have/);
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens, privacyContact: 'not an address' })).rejects.toThrow(/email address/);
  });
});

describe('the privacy notice', () => {
  it('has the same current and earlier notices as the headset app, and says where a recording goes', async () => {
    const kotlin = await readFile(join(import.meta.dirname, '../app/android/app/src/main/java/net/polydance/capture/AccessPolicy.kt'), 'utf8');
    const current = kotlin.match(/const val VERSION = "([^"]+)"/)?.[1];
    const earlier = [...(kotlin.match(/val EARLIER = setOf\(([^)]*)\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(current).toBe(CONSENT_VERSION);
    expect([current, ...earlier]).toEqual(ACCEPTED_CONSENT_VERSIONS);
    // capture-hosted-2: a recording goes into its thread; the full notice says the team that runs the receiver has access.
    const html = privacyHtml(undefined);
    expect(html).toContain('goes into the thread you recorded it in');
    expect(html).toContain('The Polydance team</strong> runs capture.polydance.net, so it has access to every thread');
    expect(html).not.toContain('team you test for');
    const notice = await readFile(join(import.meta.dirname, '../app/android/app/src/main/java/net/polydance/capture/Consent.kt'), 'utf8');
    expect(notice).toContain('capture.polydance.net, into the thread you record it in. Gladia transcribes');
    expect(notice).not.toContain('testing for');
    expect(notice).toContain("Logs, when on, also sends the headset's logs from each take: Polydance's own, and other apps' only if this headset was given access over adb");
    // How long a tester's video is kept, only where the receiver limits it (POLYCAP_MEMBER_VIDEO_DAYS, 2026-11-12).
    expect(privacyHtml(undefined, undefined, 30)).toContain("A tester's video is kept for 30 days</strong> after it is sent");
    expect(html).not.toContain('video is kept for');
    // capture-hosted-3 (2026-11-16): a take can send the headset's logs, other apps' only with adb access and the headset's prompt.
    expect(html).toContain("<strong>The headset's logs</strong>, unless you switch Logs off");
    expect(html).toContain('only when you allow the headset\'s own prompt for them each time');
  });

  it('names what is recorded, where it goes and the contact, escaped', () => {
    const html = privacyHtml('privacy@polydance.net');
    for (const words of ['passthrough', 'Gladia', 'Anthropic', 'Meta user ID', '18 or older', CONSENT_VERSION, 'mailto:privacy@polydance.net']) expect(html).toContain(words);
    expect(privacyHtml(undefined)).toContain('store page (Meta Horizon Store or Google Play)');
    for (const words of ['private-beta-only', 'no separate receiver allowlist', 'release channel alone does not guarantee', '24 hours', 'restart the receiver']) expect(html).toContain(words);
    // Reports from the bug key: who sees them, that the headset copy goes, and how to have one deleted.
    for (const words of ['only to the Polydance team', 'not shown in your inbox', 'deleted from the headset as soon as the receiver has all of it', 'to have one deleted from the receiver, email']) expect(html).toContain(words);
    // Addresses people give, and who plays a thread's recordings (2026-10-12).
    for (const words of ['Email addresses, if you give them', 'shown to the people in that thread and to the team', 'emails it once for that thread', 'never the thread\'s messages or recordings', 'AhaSend', 'can play its recordings and read their transcripts', 'To have an email address removed from the receiver, email']) expect(html).toContain(words);
    expect(privacyHtml('a<b>@x.com')).not.toContain('<b>');
  });
});

describe('testers on the receiver', () => {
  const mac = newToken();
  const tokens = JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' }]);
  let base: string; let close: () => Promise<void>; let testers: Testers; let meta: Awaited<ReturnType<typeof fakeMeta>>;
  let cli: Awaited<ReturnType<typeof testCli>>;

  beforeAll(async () => {
    meta = await fakeMeta();
    cli = await testCli();
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, privacyContact: 'privacy@polydance.net',
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], maxTesters: 2, people: { '1003': 'robin' } }) },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close; testers = running.testers!;
  });
  afterAll(async () => { await close?.(); await meta?.close(); });

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  const signIn = (userId: string, nonce: string, deviceId = 'a1b2c3d4', name = 'Ana B') =>
    call('POST', '/v1/testers/meta', undefined, { userId, nonce, deviceId, name, label: 'Quest 3' });
  const create = (token: string, clientId: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/v1/uploads', token, { clientId, bytes: 1000, sha256: 'a'.repeat(64), fileName: 'video.mp4', audioTracks: ['mic'], ...extra });

  it('serves the privacy notice without a token', async () => {
    const response = await fetch(`${base}/privacy`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toContain('mailto:privacy@polydance.net');
  });

  it('admits an unlisted Meta user with valid proof and app entitlement, with an upload-only token for MUS', async () => {
    meta.state.nonces.set('nonce-ana-1', '1001'); meta.state.entitled.add('1001');
    const signed = await signIn('1001', 'nonce-ana-1');
    expect(signed.status).toBe(201);
    expect(signed.json).toMatchObject({ grantId: 'meta-1001', name: 'Ana B', projects: ['MUS'] });
    const token = signed.json.token as string;
    expect(token).toMatch(/^polycap_[0-9a-f]{64}$/);
    expect(meta.state.calls.map(c => c.path)).toEqual(['/user_nonce_validate', `/${APP_ID}/verify_entitlement`]);
    expect((await call('GET', '/v1/projects', token)).json).toEqual({ capabilities: ['idempotent-replies-v1', 'models-v1', 'photos-v1', 'projects-new-v1', 'projects-edit-v1', 'agents-v1'], me: 'meta-1001', projects: [{ key: 'MUS', name: 'Marimba' }] });
    // The notice first: a tester's recording without it is refused.
    expect((await create(token, 'ana-1')).json.error).toMatch(/consent/);
    for (const consent of ['capture-hosted-0', 'capture-hosted-999', 'garbage', '', null]) {
      expect((await create(token, 'ana-1', { consent })).status).toBe(400);
    }
    expect((await call('GET', '/v1/uploads', token)).json.uploads).toEqual([]);
    const made = await create(token, 'ana-1', { consent: CONSENT_VERSION });
    expect((await create(token, 'ana-1', { consent: 'capture-hosted-0' })).status).toBe(200); // Existing upload may resume.
    expect(made.status).toBe(201);
    const thread = (await call('GET', `/v1/threads/${made.json.thread}`, mac.token)).json;
    expect(thread.messages[0].by).toMatchObject({ id: 'meta-1001', name: 'Quest 3', user: { id: 'meta-1001', name: 'Ana B' }, display: 'Ana B · Quest 3' });
    expect((await call('POST', '/v1/threads', token, { project: 'MUS', title: 'x', text: 'y' })).status).toBe(403);
    expect((await call('POST', `/v1/threads/${made.json.thread}/messages`, token, { text: 'x' })).status).toBe(403);
    expect((await call('GET', '/v1/sessions', token)).status).toBe(403);
    expect((await call('GET', '/v1/sessions/example/files', token)).status).toBe(403);
    const cap = await call('POST', '/v1/threads', mac.token, { project: 'CAP', title: 'Private CAP', text: 'x' });
    expect(cap.status).toBe(201);
    expect((await call('GET', `/v1/threads/${cap.json.key}`, token)).status).toBe(404);
    expect((await call('GET', '/v1/threads?project=CAP', token)).json.threads).toEqual([]);
    expect((await call('GET', '/v1/events?after=0&project=CAP', token)).json.events).toEqual([]);
    expect((await create(token, 'cross-project', { consent: CONSENT_VERSION, thread: { key: cap.json.key } })).status).toBe(404);
    expect((await create(token, 'cross-project', { consent: CONSENT_VERSION, thread: { project: 'CAP' } })).status).toBe(404);
    // Kept with the token's hash only, owner-only.
    const file = await readFile(testers.file, 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain('"metaUserId": "1001"');
    expect((await stat(testers.file)).mode & 0o777).toBe(0o600);
  });

  it('refuses a proof Meta does not vouch for, missing entitlement, and malicious upstream errors without leaks', async () => {
    meta.state.nonces.set('nonce-zed', '1005');
    expect(await signIn('1006', 'nonce-zed', 'd1d2d3d4', 'Not Zed')).toMatchObject({ status: 403, json: { reason: 'unverified' } });
    meta.state.nonces.set('nonce-eve', '1002');
    expect(await signIn('1002', 'nonce-eve', 'e1e2e3e4', 'Eve')).toMatchObject({ status: 403, json: { reason: 'not_invited' } });
    meta.state.down = true;
    const down = await signIn('1002', NONCE, 'e1e2e3e4', 'Eve');
    meta.state.down = false;
    expect(down).toMatchObject({ status: 502, json: { reason: 'meta_unavailable' } });
    expect(down.json.error).toBe('could not check the account with Meta; try again later');
    for (const sensitive of [SECRET, NONCE, meta.state.errorMessage]) {
      expect(JSON.stringify(down)).not.toContain(sensitive);
      expect(cli.lines.join('\n')).not.toContain(sensitive);
    }
    expect(cli.lines.join('\n')).toContain('Meta could not check meta-1002 for sign-in: status 503');
    // The refusal that hid behind a bare 502 for hours (2026-10-13): the log names it, never Meta's words.
    const echoed = `This call accesses In-App Purchases for 1002 with OC|${APP_ID}|${SECRET}`;
    meta.state.refusal = { status: 403, json: { error: { code: 10, error_subcode: 1891537, type: 'OCApiException', message: echoed } } };
    const refused = await signIn('1002', NONCE, 'e1e2e3e4', 'Eve');
    meta.state.refusal = undefined;
    expect(refused).toMatchObject({ status: 502, json: { reason: 'meta_unavailable' } });
    expect(cli.lines.join('\n')).toContain('Meta could not check meta-1002 for sign-in: status 403, code 10, subcode 1891537, OCApiException: a platform feature this call needs is missing from the app\'s Data Use Checkup');
    expect(cli.lines.join('\n')).not.toContain(echoed);
    expect(JSON.stringify(refused)).not.toContain('1891537');
    expect((await signIn('1001', 'x', 'nothex!!')).status).toBe(400);
  });

  it('names a mapped person as POLYCAP_USERS does, and stops at the tester limit', async () => {
    meta.state.nonces.set('nonce-robin', '1003'); meta.state.entitled.add('1003');
    const robin = await signIn('1003', 'nonce-robin', 'b1b2b3b4', 'Robin S');
    expect(robin.status).toBe(201);
    const made = await create(robin.json.token, 'robin-1', { consent: CONSENT_VERSION });
    expect((await call('GET', `/v1/threads/${made.json.thread}`, mac.token)).json.messages[0].by).toMatchObject({ user: { id: 'robin', name: 'Robin' }, display: 'Robin · Quest 3' });
    meta.state.nonces.set('nonce-third', '1004'); meta.state.entitled.add('1004');
    expect(await signIn('1004', 'nonce-third', 'c1c2c3c4', 'Third')).toMatchObject({ status: 403, json: { reason: 'full' } });
  });

  it('gives a new token when the same headset signs in again, and the old one stops working', async () => {
    meta.state.nonces.set('nonce-ana-2', '1001');
    const first = await signIn('1001', 'nonce-ana-2');
    meta.state.nonces.set('nonce-ana-3', '1001');
    const second = await signIn('1001', 'nonce-ana-3');
    expect(second.status).toBe(201);
    expect((await call('GET', '/v1/account', first.json.token)).status).toBe(401);
    expect((await call('GET', '/v1/account', second.json.token)).json).toMatchObject({ grantId: 'meta-1001', recordings: 1 });
    // A second headset of the same person shares their account.
    meta.state.nonces.set('nonce-ana-4', '1001');
    const other = await signIn('1001', 'nonce-ana-4', 'f1f2f3f4');
    expect((await call('GET', '/v1/account', other.json.token)).json).toMatchObject({ grantId: 'meta-1001', recordings: 1 });
    expect((await call('GET', '/v1/account', second.json.token)).status).toBe(200);
  });

  it('revokes after an explicit negative entitlement result, and tolerates an outage only while verification is fresh', async () => {
    meta.state.nonces.set('nonce-ana-5', '1001');
    const ana = await signIn('1001', 'nonce-ana-5');
    meta.state.down = true;
    expect(await testers.check()).toMatchObject({ checked: 0, revoked: [], failed: 2 });
    meta.state.down = false;
    for (const sensitive of [SECRET, NONCE, meta.state.errorMessage]) expect(cli.lines.join('\n')).not.toContain(sensitive);
    expect((await call('GET', '/v1/account', ana.json.token)).status).toBe(200);
    meta.state.entitled.delete('1001');
    expect(await testers.check()).toMatchObject({ checked: 2, revoked: ['meta-1001'] });
    expect((await call('GET', '/v1/account', ana.json.token)).status).toBe(401);
    expect(cli.lines.some(l => l.includes('meta-1001 (Ana B) is no longer entitled'))).toBe(true);
    // Entitled again (not locally blocked), they sign in again; the freed place is theirs or anyone's.
    meta.state.entitled.add('1001'); meta.state.nonces.set('nonce-ana-6', '1001');
    expect((await signIn('1001', 'nonce-ana-6')).status).toBe(201);
    // Six sign-ins for one account in ten minutes; the seventh waits, without asking Meta.
    const asked = meta.state.calls.length;
    expect(await signIn('1001', 'nonce-ana-6')).toMatchObject({ status: 429 });
    expect(meta.state.calls.length).toBe(asked);
  });

  it('remembers testers across a restart', async () => {
    const again = await testCli({ POLYCAP_ROOT: cli.config.root });
    const running = await serve(again, {
      host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS,
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], people: { '1003': 'robin' } }) },
    });
    try {
      await running.testers!.check();
      expect(running.testers!.active.map(t => t.metaUserId).sort()).toEqual(['1001', '1003']);
      expect(again.lines.some(l => l.includes(`Meta sign-in for app ${APP_ID}, 2 tester(s)`))).toBe(true);
    } finally { await running.close(); }
  });

  it('enforces the exact 24h age on requests even if the refresh timer has not run', async () => {
    // Ana used her sign-in limit above; use Robin's credential for the request-time boundary.
    const signed = await signIn('1003', 'nonce-robin', 'b1b2b3b4', 'Robin S');
    const robin = testers.active.find(t => t.metaUserId === '1003')!;
    const checkedAt = Date.parse(robin.checkedAt);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(checkedAt + MAX_VERIFIED_AGE_MS - 1);
      expect((await call('GET', '/v1/account', signed.json.token)).status).toBe(200);
      now.mockReturnValue(checkedAt + MAX_VERIFIED_AGE_MS);
      expect((await call('GET', '/v1/account', signed.json.token)).status).toBe(401);
      expect((await create(signed.json.token, 'stale', { consent: CONSENT_VERSION })).status).toBe(401);
      expect((await call('GET', '/v1/projects', signed.json.token)).status).toBe(401);
      expect((await call('GET', '/v1/account', mac.token)).status).toBe(200);
    } finally { now.mockRestore(); }
  });

  it('loads local blocks without grants and refuses re-enrollment before asking Meta', async () => {
    const again = await testCli({ POLYCAP_ROOT: cli.config.root });
    const asked = meta.state.calls.length;
    const running = await serve(again, {
      host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS,
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url,
        POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], blockedUsers: ['1001', '1003'] }) },
    });
    try {
      expect(running.testers!.active).toEqual([]);
      expect(again.lines.some(l => l.includes('1 token(s)'))).toBe(true); // Only the static Mac grant.
      await expect(running.testers!.enroll({ userId: '1001', nonce: 'nonce-ana-6', deviceId: 'a1b2c3d4' }))
        .rejects.toMatchObject({ status: 403, extra: { reason: 'blocked' } });
      expect(meta.state.calls.length).toBe(asked);
    } finally { await running.close(); }
  });

});

const settings = (extra: Record<string, unknown> = {}, graphUrl = 'https://graph.oculus.com') => parseMetaConfig({
  POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: graphUrl,
  POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], ...extra }),
})!;

/** A persisted credential with deliberately controlled verification age, never real credentials. */
async function storedTester(checkedAt: string) {
  const dir = await mkdtemp(join(tmpdir(), 'polycap-testers-'));
  const credential = newToken();
  await writeFile(join(dir, 'testers.json'), JSON.stringify({ version: 1, testers: [{
    metaUserId: '9001', name: 'Persisted', enrolledAt: checkedAt, checkedAt,
    devices: [{ deviceId: 'aabbccdd', label: 'Quest', sha256: credential.sha256, enrolledAt: checkedAt }],
  }] }));
  return { dir, ...credential };
}

describe('the Welcome on sign-in (2026-11-10)', () => {
  const mac = newToken();
  const tokens = JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Mac', user: 'robin' }]);
  const projects = JSON.stringify([{ key: 'START', name: 'Getting started', hosts: ['receiver.example'] }, { key: 'MUS', name: 'Marimba' }]);
  let base: string; let close: () => Promise<void>; let meta: Awaited<ReturnType<typeof fakeMeta>>; let cli: Awaited<ReturnType<typeof testCli>>;

  beforeAll(async () => {
    meta = await fakeMeta();
    cli = await testCli();
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, tokens, projects, users: USERS, privacyContact: 'privacy@polydance.net',
      welcome: JSON.stringify({ project: 'START', url: 'https://receiver.example/start' }),
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['START'], people: { '1003': 'robin' } }) },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); await meta?.close(); });

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  const signIn = (userId: string, deviceId = 'a1b2c3d4', name = 'Quinn Example') => {
    const nonce = `nonce-${userId}-${deviceId}`;
    meta.state.nonces.set(nonce, userId); meta.state.entitled.add(userId);
    return call('POST', '/v1/testers/meta', undefined, { userId, nonce, deviceId, name, label: 'Quest 3' });
  };
  const welcomed = async () => JSON.parse(await readFile(join(cli.config.root, 'welcome.json'), 'utf8')).threads as { person: string; key: string }[];

  it('has the newcomer\'s Welcome waiting the moment they are signed in, once however often they sign in', async () => {
    const first = await signIn('2001');
    expect(first.status).toBe(201);
    const inbox = (await call('GET', '/v1/threads', first.json.token)).json;
    expect(inbox.threads).toMatchObject([{ key: 'START-1', title: 'Welcome to Polydance', unread: true, waiting: true }]);
    const thread = (await call('GET', '/v1/threads/START-1', first.json.token)).json;
    expect(thread.messages[0].text).toMatch(/^Hi Quinn, welcome to Polydance/);
    expect(thread.messages[0].by).toMatchObject({ id: 'polydance', as: 'Polydance', display: 'Polydance' });
    // Again on the same headset, and on a second one: still the one thread.
    expect((await signIn('2001')).status).toBe(201);
    const second = await signIn('2001', 'e5f6a7b8');
    expect((await call('GET', '/v1/threads', second.json.token)).json.threads.map((t: { key: string }) => t.key)).toEqual(['START-1']);
    expect(await welcomed()).toEqual([expect.objectContaining({ person: 'meta-2001', key: 'START-1' })]);
  });

  it('opens none for someone who is the team\'s, and a Welcome that fails never fails the sign-in', async () => {
    expect((await signIn('1003', 'a1b2c3d4', 'Robin')).status).toBe(201);
    expect((await welcomed()).map(w => w.person)).toEqual(['meta-2001']);
    const file = join(cli.config.root, 'welcome.json');
    const kept = await readFile(file, 'utf8');
    await writeFile(file, 'not json');
    const signed = await signIn('2002', 'a1b2c3d4', 'Tove');
    expect(signed.status).toBe(201);
    expect((await call('GET', '/v1/threads', signed.json.token)).json.threads).toEqual([]);
    expect(cli.lines.some(line => line.startsWith('welcome for meta-2002:'))).toBe(true);
    await writeFile(file, kept);
    // Signing in again once it works opens it.
    const again = await signIn('2002', 'a1b2c3d4', 'Tove');
    expect((await call('GET', '/v1/threads', again.json.token)).json.threads.map((t: { key: string; title: string }) => `${t.key} ${t.title}`)).toEqual(['START-2 Welcome to Polydance']);
  });

  it('serves the getting-started page without a token', async () => {
    const response = await fetch(`${base}/start`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await response.text();
    expect(html).toContain('<title>Getting started with Polydance</title>');
    expect(html).toContain('id="your-agent"');
    // How a newcomer connects their own agent (2026-11-20): the card or the menu's Agents, then one line typed.
    for (const words of ['Connect your agent', '<strong>Agents</strong>', '<strong>polycap connect</strong>', 'https://github.com/Polydance/polydance']) expect(html).toContain(words);
    expect(html).toContain('mailto:privacy@polydance.net');
    expect(html).toContain('href="/privacy"');
  });
});

describe('Meta transport redaction', () => {
  it.each(['fetch rejection', 'body rejection', 'invalid JSON', 'invalid answer'])('uses fixed errors for %s', async mode => {
    const leak = `${SECRET} ${NONCE}`;
    const request = vi.spyOn(globalThis, 'fetch');
    if (mode === 'fetch rejection') request.mockRejectedValue(new Error(leak));
    else if (mode === 'body rejection') request.mockResolvedValue({ ok: true, json: async () => { throw new Error(leak); } } as unknown as Response);
    else request.mockResolvedValue(new Response(mode === 'invalid JSON' ? leak : JSON.stringify({ error: { message: leak } })));
    try {
      const graph = new MetaGraph(settings());
      await expect(graph.validNonce('9001', NONCE)).rejects.toThrow(/^Meta(?: request failed|'s user_nonce_validate answered without is_valid)$/);
      await expect(graph.entitled('9001')).rejects.toThrow(/^Meta(?: request failed|'s verify_entitlement answered without success)$/);
    } finally { request.mockRestore(); }
  });
});

describe('which signed-in testers are thread-scoped (2026-10-21)', () => {
  it('scopes a tester to their threads unless their person holds one of the team\'s tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'testers-'));
    const grants: Grant[] = [
      { id: 'mac', sha256: newToken().sha256, scopes: ['read', 'post'], user: 'robin' },
      // Ana's own agent is thread-scoped, so it does not make her the team's.
      { id: 'ana-agent', sha256: newToken().sha256, scopes: ['read', 'post'], user: 'ana', threads: 'member' },
    ];
    const graph = { validNonce: vi.fn(async () => true), entitled: vi.fn(async () => true) };
    const testers = new Testers(dir, settings({ people: { '9001': 'robin', '9002': 'ana' } }), graph, grants, [], () => {});
    await testers.load();
    for (const userId of ['9001', '9002', '9003']) await testers.enroll({ userId, nonce: NONCE, deviceId: 'aabbccdd' });
    const signedIn = (id: string) => grants.find(g => g.id === id)!;
    expect(['meta-9001', 'meta-9002', 'meta-9003'].map(id => [signedIn(id).user, memberScoped(signedIn(id)), isTeam(signedIn(id))])).toEqual([
      ['robin', false, false], ['ana', true, false], ['meta-9003', true, false],
    ]);
  });
});

describe('persisted tester authorization', () => {
  it.each(['expired', 'invalid', 'future'])('fails closed for %s checkedAt, then restores access only after fresh verification', async age => {
    const checkedAt = age === 'invalid' ? 'not-a-date' : new Date(Date.now() + (age === 'future' ? 60_000 : -MAX_VERIFIED_AGE_MS)).toISOString();
    const stored = await storedTester(checkedAt);
    const grants: Grant[] = [];
    const graph = { validNonce: vi.fn(async () => true), entitled: vi.fn(async () => true) };
    const logs: string[] = [];
    const testers = new Testers(stored.dir, settings(), graph, grants, [], line => logs.push(line));
    await testers.load();
    expect(authenticate(`Bearer ${stored.token}`, grants)).toBeUndefined();
    graph.entitled.mockRejectedValueOnce(new Error(`${SECRET} ${NONCE}`));
    expect(await testers.check()).toMatchObject({ checked: 0, failed: 1 });
    for (const sensitive of [SECRET, NONCE]) expect(logs.join('\n')).not.toContain(sensitive);
    expect(grants).toEqual([]);
    expect(await testers.check()).toMatchObject({ checked: 1, failed: 0 });
    expect(testers.authorized(authenticate(`Bearer ${stored.token}`, grants)!)).toBe(true);
  });

  it('filters blocks during apply as well as load, without Graph calls or re-enrollment', async () => {
    const stored = await storedTester(new Date().toISOString());
    const grants: Grant[] = [];
    const graph = { validNonce: vi.fn(async () => true), entitled: vi.fn(async () => true) };
    const config = settings();
    const testers = new Testers(stored.dir, config, graph, grants, [], () => {});
    await testers.load();
    const grant = grants[0];
    expect(testers.authorized(grant)).toBe(true);
    config.testers.blockedUsers.push('9001');
    expect(testers.authorized(grant)).toBe(false);
    await testers.check(); // apply() runs even with no eligible testers.
    expect(grants).toEqual([]);
    await expect(testers.enroll({ userId: '9001', nonce: NONCE, deviceId: 'aabbccdd' })).rejects.toMatchObject({ status: 403 });
    expect(graph.validNonce).not.toHaveBeenCalled();
    expect(graph.entitled).not.toHaveBeenCalled();
  });

  it('revalidates at startup without blocking listening, coalesces checks, and schedules hourly refresh', async () => {
    const stored = await storedTester(new Date(Date.now() - MAX_VERIFIED_AGE_MS).toISOString());
    const cli = await testCli({ POLYCAP_ROOT: stored.dir });
    const meta = await fakeMeta();
    meta.state.entitled.add('9001');
    let release!: () => void;
    meta.state.hold = new Promise<void>(resolve => { release = resolve; });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const mac = newToken();
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, projects: PROJECTS,
      tokens: JSON.stringify([{ id: 'mac', sha256: mac.sha256, scopes: ['read'] }]),
      meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'] }) },
    });
    const account = () => fetch(`http://127.0.0.1:${running.port}/v1/account`, { headers: { authorization: `Bearer ${stored.token}` } });
    try {
      await vi.waitFor(() => expect(meta.state.calls.length).toBe(1));
      expect((await account()).status).toBe(401);
      const check = running.testers!.check();
      expect(running.testers!.check()).toBe(check);
      release(); meta.state.hold = undefined;
      await check;
      expect((await account()).status).toBe(200);
      expect(meta.state.calls.length).toBe(1);
      const hourly = interval.mock.calls.find(([, ms]) => ms === 3600_000);
      expect(hourly).toBeDefined();
      meta.state.entitled.delete('9001');
      (hourly![0] as () => void)();
      await running.testers!.check();
      expect((await account()).status).toBe(401);
    } finally {
      release(); interval.mockRestore(); await running.testers!.check(); await running.close(); await meta.close();
    }
  });
});

describe('enable-welcome settings helper (temporary files only, 2026-11-10)', () => {
  // As the live env was on 2026-11-10: a legacy headset token with no projects linked to Robin's Meta account.
  const quest = newToken(), mac = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], user: 'robin' },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' },
  ]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Polydance Capture', hosts: ['capture.polydance.net'] }]);
  const linked = { projects: ['MUS'], maxTesters: 25, people: { '1003': 'robin' }, accounts: { '1003': { user: 'robin', projects: ['MUS', 'CAP'], legacyGrantIds: ['quest3'] } }, blockedUsers: [] };
  async function fixture(testers: unknown) {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-enable-welcome-'));
    const path = join(dir, 'receiver.env');
    await writeFile(path, `POLYCAP_SERVER_TOKENS=${tokens}\nPOLYCAP_PROJECTS=${projects}\nPOLYCAP_USERS=${USERS}\nPOLYCAP_META_TESTERS=${JSON.stringify(testers)}\n`, { mode: 0o600 });
    const run = (...args: string[]) => spawnSync('python3', ['deploy/receiver/enable-welcome.py', path, ...args], { encoding: 'utf8' });
    const env = async () => Object.fromEntries((await readFile(path, 'utf8')).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { path, run, env };
  }

  it('turns the Welcome on in a way the receiver then starts with, and says only keys and counts', async () => {
    const { run, env } = await fixture(linked);
    const done = run('--start-only');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("POLYCAP_META_TESTERS projects: ['MUS'] -> ['START']");
    expect(done.stdout).toContain('POLYCAP_META_TESTERS accounts given START: 1');
    expect(done.stdout).not.toMatch(/1003|robin|quest3/);
    const e = await env();
    expect(JSON.parse(e.POLYCAP_WELCOME!)).toEqual({ project: 'START', url: 'https://capture.polydance.net/start' });
    expect(JSON.parse(e.POLYCAP_META_TESTERS!).accounts['1003'].projects).toEqual(['MUS', 'CAP', 'START']);
    // Run twice, it changes nothing more.
    expect(run('--start-only').stdout).not.toContain('accounts given');
    const meta = await fakeMeta();
    try {
      const running = await serve(await testCli(), {
        host: '127.0.0.1', port: 0, tokens: e.POLYCAP_SERVER_TOKENS, projects: e.POLYCAP_PROJECTS, users: e.POLYCAP_USERS, welcome: e.POLYCAP_WELCOME,
        meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: e.POLYCAP_META_TESTERS },
      });
      await running.close();
    } finally { await meta.close(); }
  });

  it('refuses START alone while a mapped tester has no account of their own, changing nothing', async () => {
    const { path, run } = await fixture({ ...linked, accounts: {} });
    const before = await readFile(path, 'utf8');
    const refused = run('--start-only');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('1 mapped tester(s) have no accounts entry');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(run().status).toBe(0);
  });
});

describe('add-project settings helper (temporary files only, 2026-11-13)', () => {
  // As the live env was on 2026-11-13: START after the Welcome, quest3 unscoped and linked to Robin's Meta account;
  // plus a made-up tester whose legacy token is scoped, so needs nothing.
  const quest = newToken(), mac = newToken(), other = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], user: 'robin' },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], user: 'robin' },
    { id: 'tester-headset', sha256: other.sha256, scopes: ['upload'], user: 'ana', projects: ['START'] },
  ]);
  const users = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'ana', name: 'Ana' }]);
  const projects = JSON.stringify([{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Polydance Capture' }, { key: 'START', name: 'Getting started', hosts: ['capture.polydance.net'] }]);
  const testers = {
    projects: ['START'], maxTesters: 25, people: { '1003': 'robin' }, blockedUsers: [],
    accounts: { '1003': { user: 'robin', projects: ['MUS', 'CAP', 'START'], legacyGrantIds: ['quest3'] }, '1004': { user: 'ana', projects: ['START'], legacyGrantIds: ['tester-headset'] } },
  };
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-add-project-'));
    const path = join(dir, 'receiver.env');
    await writeFile(path, `POLYCAP_SERVER_TOKENS=${tokens}\nPOLYCAP_PROJECTS=${projects}\nPOLYCAP_USERS=${users}\nPOLYCAP_META_TESTERS=${JSON.stringify(testers)}\n`, { mode: 0o600 });
    const run = (...args: string[]) => spawnSync('python3', ['deploy/receiver/add-project.py', path, ...args], { encoding: 'utf8' });
    const env = async () => Object.fromEntries((await readFile(path, 'utf8')).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { path, run, env };
  }

  it('adds a project last, in a way the receiver then starts with, and says only keys and counts', async () => {
    const { path, run, env } = await fixture();
    const done = run('NEWP', 'New project', '--package', 'com.example.newp');
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("projects: ['MUS', 'CAP', 'START', 'NEWP']");
    expect(done.stdout).toContain('POLYCAP_META_TESTERS accounts given NEWP: 1');
    expect(done.stdout).not.toMatch(/1003|1004|robin|ana\b|quest3|tester-headset/);
    const e = await env();
    expect(JSON.parse(e.POLYCAP_PROJECTS!).at(-1)).toEqual({ key: 'NEWP', name: 'New project', hosts: [], packages: ['com.example.newp'] });
    const accounts = JSON.parse(e.POLYCAP_META_TESTERS!).accounts;
    // Only the account whose headset token reaches every project; testers' defaults stay START.
    expect(accounts['1003'].projects).toEqual(['MUS', 'CAP', 'START', 'NEWP']);
    expect(accounts['1004'].projects).toEqual(['START']);
    expect(JSON.parse(e.POLYCAP_META_TESTERS!).projects).toEqual(['START']);
    expect(e.POLYCAP_SERVER_TOKENS).toBe(tokens);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const meta = await fakeMeta();
    try {
      const running = await serve(await testCli(), {
        host: '127.0.0.1', port: 0, tokens: e.POLYCAP_SERVER_TOKENS, projects: e.POLYCAP_PROJECTS, users: e.POLYCAP_USERS,
        meta: { POLYCAP_META_APP_ID: APP_ID, POLYCAP_META_APP_SECRET: SECRET, POLYCAP_META_GRAPH_URL: meta.url, POLYCAP_META_TESTERS: e.POLYCAP_META_TESTERS },
      });
      const listing = await fetch(`http://127.0.0.1:${running.port}/v1/projects`, { headers: { authorization: `Bearer ${mac.token}` } });
      expect(((await listing.json()) as { projects: { key: string }[] }).projects.map(p => p.key)).toEqual(['MUS', 'CAP', 'START', 'NEWP']);
      await running.close();
    } finally { await meta.close(); }
  });

  it('refuses a key already there, a key that is not one and a bad host, changing nothing', async () => {
    const { path, run } = await fixture();
    const before = await readFile(path, 'utf8');
    for (const [args, says] of [
      [['CAP', 'Again'], 'already has CAP'],
      [['spot', 'Lower case'], 'is not a project key'],
      [['S', 'Too short'], 'is not a project key'],
      [['SPOT', ' '], 'name is 1 to 60'],
      [['SPOT', 'Spot', '--host', 'https://spot.example'], 'is not a host'],
      [['SPOT'], 'usage'],
    ] as const) {
      const refused = run(...args);
      expect(refused.status, args.join(' ')).not.toBe(0);
      expect(refused.stderr).toContain(says);
    }
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await readdir(join(path, '..'))).filter(n => n.includes('.bak-'))).toEqual([]);
  });
});

describe('enable-meta private-beta settings helper (temporary files only)', () => {
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'polycap-enable-meta-'));
    const path = join(dir, 'receiver.env');
    await writeFile(path, `POLYCAP_PROJECTS=${PROJECTS}\nPOLYCAP_USERS=${USERS}\nPOLYCAP_META_TESTERS={"projects":["MUS"],"maxTesters":3,"blockedUsers":["1001"],"people":{"1003":"robin"},"maxBytes":1234}\n`);
    const run = (...args: string[]) => spawnSync('python3', ['deploy/receiver/enable-meta.py', path, ...args], { input: SECRET, encoding: 'utf8' });
    return { path, run };
  }

  it('appends/deduplicates blocks and preserves them, mappings and limits on rerun', async () => {
    const { path, run } = await fixture();
    expect(run('--block', '1002', '--block', '1001').status).toBe(0);
    expect(run().status).toBe(0);
    const env = await readFile(path, 'utf8');
    const config = JSON.parse(env.split('\n').find(l => l.startsWith('POLYCAP_META_TESTERS='))!.split('=')[1]);
    expect(config).toEqual({ projects: ['MUS'], maxTesters: 3, blockedUsers: ['1001', '1002'], people: { '1003': 'robin' }, maxBytes: 1234 });
    const output = run('--max', '2500');
    expect(output.status).toBe(0);
    expect(output.stdout).not.toContain(SECRET);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    for (const name of await readdir(join(path, '..'))) {
      if (name.includes('.bak-')) expect((await stat(join(path, '..', name))).mode & 0o777).toBe(0o600);
      expect(name).not.toMatch(/^\.receiver-env-/);
    }
  });

  it('moves to a new Meta app only once the old app\'s Meta IDs are deliberately cleared', async () => {
    const { path, run } = await fixture();
    await writeFile(path, `POLYCAP_META_APP_ID=1593561244982561\n${await readFile(path, 'utf8')}`);
    const before = await readFile(path, 'utf8');
    const refused = run();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/Meta IDs from app 1593561244982561 \(people, blockedUsers\)/);
    expect(await readFile(path, 'utf8')).toBe(before);
    const moved = run('--forget-old-ids');
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('moved from app 1593561244982561');
    expect(moved.stdout).toContain('blocks from the old app cleared');
    expect(moved.stdout).not.toContain(SECRET);
    const env = await readFile(path, 'utf8');
    expect(env.match(/^POLYCAP_META_APP_ID=.*$/gm)).toEqual([`POLYCAP_META_APP_ID=${APP_ID}`]);
    const config = JSON.parse(env.split('\n').find(l => l.startsWith('POLYCAP_META_TESTERS='))!.split('=')[1]);
    expect(config).toEqual({ projects: ['MUS'], maxTesters: 3, maxBytes: 1234, people: {}, blockedUsers: [] });
    // Already on the new app: the flag has nothing to do.
    expect(run('--forget-old-ids').status).not.toBe(0);
  });

  it.each([
    ['--block'], ['--block', 'abc'], ['--block', '1'.repeat(21)], ['--unknown', 'value'], ['--ma', '25'],
    ['--max', '0'], ['--max', '2501'], ['--max', '1.5'], ['--max', 'oops'], ['--max'],
  ])('rejects invalid options without changing the env: %j', async (...args) => {
    const { path, run } = await fixture();
    const before = await readFile(path, 'utf8');
    expect(run(...args).status).not.toBe(0);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
