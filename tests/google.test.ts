/** Android XR testers signing in with their Google account (private/docs/PLAY.md), against a stand-in for Google's published keys. */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { GoogleTokenError, GoogleTokens, parseGoogleConfig } from '../src/server/google.js';
import { CONSENT_VERSION, privacyHtml } from '../src/server/privacy.js';
import { newToken } from '../src/server/tokens.js';
import { testCli } from './helpers/cli.js';

const CLIENT = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const NONCE = 'n0nce-for-this-sign-in-0001';
const PROJECTS = JSON.stringify([{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Polydance Capture' }]);
const USERS = JSON.stringify([{ id: 'robin', name: 'Robin' }]);
const MAC = JSON.stringify([{ id: 'mac', sha256: newToken().sha256, scopes: ['read'] }]);

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const google = pair(), other = pair();
const jwk = (key: KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function idToken(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '110169484474386276334', email: 'ana@example.com', email_verified: true, name: 'Ana B', iat: now(), exp: now() + 3600, nonce: NONCE, ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? google.privateKey).toString('base64url')}`;
}

/** Google's certs endpoint: the published keys, with Cache-Control as Google sends it. */
async function fakeCerts() {
  const state = { keys: [jwk(google.publicKey, 'k1')], fetches: 0, down: false };
  const server: Server = createServer((_req, res) => {
    state.fetches++;
    if (state.down) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=21600' });
    res.end(JSON.stringify({ keys: state.keys }));
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/v3/certs`, close: () => new Promise<void>(done => server.close(() => done())) };
}

describe('Google sign-in settings', () => {
  const testers = JSON.stringify({ projects: ['MUS'], invited: ['Ana@Example.com'] });
  it('is off with nothing set, refuses half a setup, and checks the client id and keys URL', () => {
    expect(parseGoogleConfig({})).toBeUndefined();
    expect(() => parseGoogleConfig({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT })).toThrow(/POLYCAP_GOOGLE_TESTERS missing/);
    expect(() => parseGoogleConfig({ POLYCAP_GOOGLE_CLIENT_ID: 'polydance', POLYCAP_GOOGLE_TESTERS: testers })).toThrow(/web OAuth client ID/);
    expect(() => parseGoogleConfig({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_TESTERS: '{"projects":["MUS"]}' })).toThrow(/invited/);
    expect(() => parseGoogleConfig({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_TESTERS: testers, POLYCAP_GOOGLE_CERTS_URL: 'http://keys.example/certs' })).toThrow(/https/);
    expect(parseGoogleConfig({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_TESTERS: testers }))
      .toMatchObject({ clientId: CLIENT, certsUrl: 'https://www.googleapis.com/oauth2/v3/certs', testers: { projects: ['MUS'], invited: ['ana@example.com'], maxTesters: 25, blocked: [], people: {} } });
  });

  it('keeps google- ids for testers and checks mappings against users and invitations', async () => {
    const cli = await testCli();
    const taken = JSON.stringify([{ id: 'google-1', sha256: newToken().sha256, scopes: ['upload'] }]);
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens: taken })).rejects.toThrow(/belong to testers who sign in with Google/);
    const tokens = JSON.stringify([{ id: 'mac', sha256: newToken().sha256, scopes: ['read'] }]);
    const env = (t: unknown) => ({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_TESTERS: JSON.stringify(t) });
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, google: env({ projects: ['PD'], invited: ['a@b.co'] }) })).rejects.toThrow(/PD, which POLYCAP_PROJECTS/);
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, google: env({ projects: ['MUS'], invited: ['a@b.co'], people: { 'a@b.co': 'nobody' } }) })).rejects.toThrow(/nobody, which POLYCAP_USERS/);
    await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS, users: USERS, google: env({ projects: ['MUS'], invited: ['a@b.co'], people: { 'c@d.co': 'robin' } }) })).rejects.toThrow(/not invited/);
  });
});

describe('the privacy notice on Android XR', () => {
  it('says what Google sign-in gives the receiver and that admission is the invited list', () => {
    const html = privacyHtml('privacy@polydance.net');
    for (const words of ['on Meta Quest and on Android XR', 'Your Google account, on Android XR', 'email address Google has verified', 'admits only the addresses the team has invited', 'not that you may test', 'remove your address from the invited list']) expect(html).toContain(words);
  });
});

describe('Google ID tokens', () => {
  let certs: Awaited<ReturnType<typeof fakeCerts>>;
  beforeAll(async () => { certs = await fakeCerts(); });
  afterAll(async () => { await certs.close(); });
  const tokens = () => new GoogleTokens({ clientId: CLIENT, certsUrl: certs.url });

  it('accepts a token Google signed for this client, nonce and a verified address', async () => {
    await expect(tokens().verify(idToken({ email: 'Ana@Example.com' }), NONCE)).resolves.toMatchObject({ sub: '110169484474386276334', email: 'ana@example.com', name: 'Ana B' });
  });

  it.each([
    ['another app', { aud: '999999999999-zzzzzzzzzzzzzzzz.apps.googleusercontent.com' }, /another app/],
    ['another issuer', { iss: 'https://evil.example' }, /not issued by Google/],
    ['expired', { exp: now() - 600 }, /expired/],
    ['from the future', { iat: now() + 600 }, /future/],
    ['an unverified address', { email_verified: false }, /verified email/],
    ['no address', { email: undefined }, /verified email/],
    ['another sign-in\'s nonce', { nonce: 'someone-elses-nonce-000' }, /not made for this sign-in/],
    ['no nonce', { nonce: undefined }, /not made for this sign-in/],
    ['a non-numeric subject', { sub: 'admin' }, /verified email/],
  ])('refuses a token for %s', async (_what, claims, message) => {
    await expect(tokens().verify(idToken(claims), NONCE)).rejects.toThrow(message);
  });

  it('refuses forged, unsigned and malformed tokens', async () => {
    const t = tokens();
    await expect(t.verify(idToken({}, { key: other.privateKey }), NONCE)).rejects.toThrow(/signature/);
    await expect(t.verify(idToken({}, { alg: 'none' }), NONCE)).rejects.toThrow(GoogleTokenError);
    await expect(t.verify(idToken({}, { alg: 'HS256' }), NONCE)).rejects.toThrow(GoogleTokenError);
    await expect(t.verify('not.a.jwt!', NONCE)).rejects.toThrow(/not a JWT/);
    const [h, p] = idToken().split('.');
    await expect(t.verify(`${h}.${p}.`, NONCE)).rejects.toThrow(/not a JWT/);
  });

  it('caches Google\'s keys, picks up a rotated key, and does not refetch for every unknown kid', async () => {
    const t = tokens();
    const before = certs.state.fetches;
    await t.verify(idToken(), NONCE);
    await t.verify(idToken(), NONCE);
    expect(certs.state.fetches - before).toBe(1);
    // A rotation published after the first fetch: an unknown kid fetches again, once a minute at most.
    certs.state.keys = [jwk(google.publicKey, 'k1'), jwk(other.publicKey, 'k2')];
    const rotated = new GoogleTokens({ clientId: CLIENT, certsUrl: certs.url });
    await rotated.verify(idToken(), NONCE);
    await rotated.verify(idToken({}, { kid: 'k2', key: other.privateKey }), NONCE).catch(() => undefined);
    await expect(rotated.verify(idToken({}, { kid: 'k3' }), NONCE)).rejects.toThrow(/key Google does not publish/);
    expect(certs.state.fetches - before).toBeLessThanOrEqual(2);
  });

  it('says Google could not be reached as an error of its own, not a refusal', async () => {
    certs.state.down = true;
    try {
      const error = await new GoogleTokens({ clientId: CLIENT, certsUrl: certs.url }).verify(idToken(), NONCE).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GoogleTokenError);
    } finally { certs.state.down = false; }
  });
});

describe('Google testers on the receiver', () => {
  let certs: Awaited<ReturnType<typeof fakeCerts>>, base = '', root = '', close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    certs = await fakeCerts();
    const cli = await testCli();
    root = cli.config.root;
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, tokens: JSON.stringify([{ id: 'mac', sha256: newToken().sha256, scopes: ['read', 'post', 'upload'], user: 'robin' }]),
      projects: PROJECTS, users: USERS,
      google: {
        POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_CERTS_URL: certs.url,
        POLYCAP_GOOGLE_TESTERS: JSON.stringify({ projects: ['MUS'], invited: ['ana@example.com', 'robin@example.com', 'blocked@example.com', 'third@example.com'], blocked: ['blocked@example.com'], maxTesters: 2, people: { 'robin@example.com': 'robin' } }),
      },
    });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); await certs.close(); });

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    });
    return { status: response.status, json: await response.json().catch(() => undefined) as Record<string, any> };
  };
  const signIn = (token: string, deviceId = 'a1b2c3d4') => call('POST', '/v1/testers/google', undefined, { idToken: token, nonce: NONCE, deviceId, label: 'Android XR Puck' });

  it('signs an invited account in, with a token that uploads into its projects and a verified address', async () => {
    const signed = await signIn(idToken());
    expect(signed.status, JSON.stringify(signed.json)).toBe(201);
    expect(signed.json).toMatchObject({ grantId: 'google-110169484474386276334', name: 'Ana B', projects: ['MUS'] });
    expect(signed.json.token).toMatch(/^polycap_[0-9a-f]{64}$/);
    const me = await call('GET', '/v1/me', signed.json.token);
    expect(me.json).toMatchObject({ me: 'google-110169484474386276334', person: { name: 'Ana B', email: 'ana@example.com', emailVerified: true } });
    // Like Meta testers, a signed-in tester's upload carries the consent the app asked for.
    const upload = (extra: Record<string, unknown>) => call('POST', '/v1/uploads', signed.json.token, { clientId: 'xr-1', bytes: 1000, sha256: 'a'.repeat(64), fileName: 'video.mp4', audioTracks: ['mic'], ...extra });
    expect((await upload({})).status).toBe(400);
    expect((await upload({ consent: CONSENT_VERSION })).status).toBe(201);
    // A recording made under the earlier notice, before the app updated, still uploads (the app asks again before a new one).
    expect((await upload({ clientId: 'xr-earlier', consent: 'capture-hosted-1' })).status).toBe(201);
    expect((await upload({ clientId: 'xr-unknown', consent: 'capture-hosted-4' })).status).toBe(400);
    const file = JSON.parse(await readFile(join(root, 'google-testers.json'), 'utf8'));
    expect(file.testers[0]).toMatchObject({ sub: '110169484474386276334', email: 'ana@example.com', devices: [{ deviceId: 'a1b2c3d4', label: 'Android XR Puck' }] });
    expect(JSON.stringify(file)).not.toContain(signed.json.token);
  });

  it('uses each Google sign-in once', async () => {
    const token = idToken({ iat: now() - 5 });
    expect((await signIn(token, 'b1b2c3d4')).status).toBe(201);
    const again = await signIn(token, 'c1c2c3d4');
    expect(again.status).toBe(403);
    expect(again.json.reason).toBe('unverified');
  });

  it('maps an invited address to its person, whose threads and name it takes', async () => {
    const signed = await signIn(idToken({ sub: '2002', email: 'robin@example.com', name: 'Robin S' }));
    expect(signed.status).toBe(201);
    expect(signed.json).toMatchObject({ grantId: 'google-2002', name: 'Robin' });
    expect((await call('GET', '/v1/me', signed.json.token)).json.person).toMatchObject({ id: 'robin', email: 'robin@example.com', emailVerified: true });
  });

  it('refuses uninvited, blocked and over-limit accounts, and bad requests', async () => {
    const stranger = await signIn(idToken({ sub: '3003', email: 'stranger@example.com' }));
    expect(stranger.status).toBe(403); expect(stranger.json.reason).toBe('not_invited');
    const blocked = await signIn(idToken({ sub: '4004', email: 'blocked@example.com' }));
    expect(blocked.status).toBe(403); expect(blocked.json.reason).toBe('blocked');
    // Ana and Robin hold both places.
    const full = await signIn(idToken({ sub: '5005', email: 'third@example.com' }));
    expect(full.status).toBe(403); expect(full.json.reason).toBe('full');
    const forged = await signIn(idToken({ sub: '6006' }, { key: other.privateKey }));
    expect(forged.status).toBe(403); expect(forged.json.reason).toBe('unverified');
    expect((await call('POST', '/v1/testers/google', undefined, { idToken: idToken(), deviceId: 'a1b2c3d4' })).status).toBe(400);
    expect((await call('POST', '/v1/testers/meta', undefined, { userId: '1', nonce: 'x', deviceId: 'a1b2c3d4' })).status).toBe(404);
  });

  it('answers 502, not a refusal, when Google\'s keys cannot be fetched', async () => {
    certs.state.down = true;
    try {
      // A fresh receiver has no keys cached yet.
      const cli = await testCli();
      const running = await serve(cli, { host: '127.0.0.1', port: 0, tokens: MAC, projects: PROJECTS, users: USERS, google: { POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_CERTS_URL: certs.url, POLYCAP_GOOGLE_TESTERS: JSON.stringify({ projects: ['MUS'], invited: ['ana@example.com'] }) } });
      try {
        const response = await fetch(`http://127.0.0.1:${running.port}/v1/testers/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: idToken(), nonce: NONCE, deviceId: 'a1b2c3d4' }) });
        expect(response.status).toBe(502);
        expect(((await response.json()) as { reason?: string }).reason).toBe('google_unavailable');
      } finally { await running.close(); }
    } finally { certs.state.down = false; }
  });

  it('drops a tester\'s token when their address is no longer invited, after a restart', async () => {
    const cli = await testCli();
    const google = (invited: string[]) => ({ POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_CERTS_URL: certs.url, POLYCAP_GOOGLE_TESTERS: JSON.stringify({ projects: ['MUS'], invited }) });
    const first = await serve(cli, { host: '127.0.0.1', port: 0, tokens: MAC, projects: PROJECTS, users: USERS, google: google(['ana@example.com']) });
    const enrolled = await (await fetch(`http://127.0.0.1:${first.port}/v1/testers/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: idToken({ iat: now() - 1 }), nonce: NONCE, deviceId: 'd1d2d3d4' }) })).json() as { token: string };
    const me = (port: number) => fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { authorization: `Bearer ${enrolled.token}` } }).then(r => r.status);
    expect(await me(first.port)).toBe(200);
    await first.close();
    const second = await serve(cli, { host: '127.0.0.1', port: 0, tokens: MAC, projects: PROJECTS, users: USERS, google: google(['someone@example.com']) });
    try { expect(await me(second.port)).toBe(401); } finally { await second.close(); }
  });
});

describe('the Welcome after a Google sign-in (2026-11-10)', () => {
  it('has the newcomer\'s Welcome waiting, once', async () => {
    const certs = await fakeCerts();
    const cli = await testCli();
    const projects = JSON.stringify([{ key: 'START', name: 'Getting started', hosts: ['receiver.example'] }]);
    const running = await serve(cli, {
      host: '127.0.0.1', port: 0, tokens: MAC, projects, users: USERS, welcome: JSON.stringify({ project: 'START', url: 'https://receiver.example/start' }),
      google: { POLYCAP_GOOGLE_CLIENT_ID: CLIENT, POLYCAP_GOOGLE_TESTERS: JSON.stringify({ projects: ['START'], invited: ['ana@example.com'] }), POLYCAP_GOOGLE_CERTS_URL: certs.url },
    });
    const base = `http://127.0.0.1:${running.port}`;
    // Google's tokens are used once each, so the second sign-in brings a token of its own.
    const signIn = async (deviceId: string, iat = now()) => (await (await fetch(`${base}/v1/testers/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: idToken({ iat }), nonce: NONCE, deviceId }) })).json()) as { token: string };
    const inbox = async (token: string) => ((await (await fetch(`${base}/v1/threads`, { headers: { authorization: `Bearer ${token}` } })).json()) as { threads: { key: string; title: string; unread: boolean }[] }).threads;
    try {
      expect(await inbox((await signIn('a1b2c3d4')).token)).toMatchObject([{ key: 'START-1', title: 'Welcome to Polydance', unread: true }]);
      expect((await inbox((await signIn('e5f6a7b8', now() - 1)).token)).map(t => t.key)).toEqual(['START-1']);
    } finally { await running.close(); await certs.close(); }
  });
});
