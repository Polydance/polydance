/** Explicit Meta continuity: synthetic credentials/data and local HTTP only; Meta is stubbed. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { exists } from '../src/fsx.js';
import { sessionDir } from '../src/session.js';
import { MetaGraph, parseMetaConfig } from '../src/server/meta.js';
import { CONSENT_VERSION } from '../src/server/privacy.js';
import { MAX_VERIFIED_AGE_MS } from '../src/server/testers.js';
import { newToken, ownsUpload, parseGrants, type Grant } from '../src/server/tokens.js';
import { UploadStore, type UploadRecord } from '../src/server/uploads.js';
import { testCli } from './helpers/cli.js';

const PROJECTS = JSON.stringify([{ key: 'MUS', name: 'Marimba' }, { key: 'CAP', name: 'Capture' }, { key: 'SEC', name: 'Separate' }]);
const USERS = JSON.stringify([{ id: 'robin', name: 'Robin' }, { id: 'bob', name: 'Bob' }]);
const account = { user: 'robin', projects: ['CAP', 'MUS'], legacyGrantIds: ['robin-old', 'robin-extra'] };
const accounts = { '7001': account, '7002': { user: 'bob', projects: ['MUS'], legacyGrantIds: ['bob-old'] } };
const metaEnv = (extra: Record<string, unknown> = {}) => ({
  POLYCAP_META_APP_ID: '123456', POLYCAP_META_APP_SECRET: '0123456789abcdef',
  POLYCAP_META_TESTERS: JSON.stringify({ projects: ['MUS'], maxBytes: 200, ...extra }),
});
const input = (clientId: string, bytes = 10) => ({ clientId, bytes, sha256: 'a'.repeat(64), fileName: 'clip.mp4', consent: CONSENT_VERSION });
const legacyGrants = (): Grant[] => [
  { id: 'robin-old', sha256: newToken().sha256, scopes: ['upload'], user: 'robin', projects: ['CAP', 'MUS'] },
  { id: 'robin-extra', sha256: newToken().sha256, scopes: ['upload'], user: 'robin', projects: ['MUS'] },
  { id: 'robin-unlinked', sha256: newToken().sha256, scopes: ['upload'], user: 'robin', projects: ['CAP'] },
  { id: 'bob-old', sha256: newToken().sha256, scopes: ['upload'], user: 'bob', projects: ['MUS'] },
  { id: 'mac', sha256: newToken().sha256, scopes: ['read', 'post'], user: 'robin' },
];

describe('Meta continuity configuration', () => {
  it('keeps aliases internal and ownership independent of user attribution', () => {
    const grant = legacyGrants()[0];
    for (const field of ['legacyGrantIds', 'quotaOwnerIds', 'quotaMaxBytes']) {
      expect(() => parseGrants(JSON.stringify([{ ...grant, [field]: field === 'quotaMaxBytes' ? 999 : ['bob-old'] }]))).toThrow(field);
    }
    expect(ownsUpload({ ...grant, quotaOwnerIds: ['meta-7001', 'robin-old', 'robin-extra'] }, 'robin-extra')).toBe(false);
    expect(ownsUpload(grant, grant.id)).toBe(true);
    expect(ownsUpload(grant, 'robin-extra')).toBe(false);
    expect(ownsUpload({ ...grant, legacyGrantIds: ['robin-extra'] }, 'robin-extra')).toBe(true);
    expect(ownsUpload({ ...grant, legacyGrantIds: ['robin-extra'] }, 'bob-old')).toBe(false);
    expect(parseMetaConfig(metaEnv())!.testers).toMatchObject({ projects: ['MUS'], people: {}, accounts: {} });
  });

  it.each([
    ['non-Meta key', { 'Robin': account }],
    ['empty projects', { '7001': { ...account, projects: [] } }],
    ['missing aliases', { '7001': { user: 'robin', projects: ['MUS'] } }],
    ['non-array aliases', { '7001': { ...account, legacyGrantIds: 'robin-old' } }],
    ['invalid alias', { '7001': { ...account, legacyGrantIds: ['../old'] } }],
    ['unknown account field', { '7001': { ...account, name: 'Robin' } }],
  ])('rejects malformed accounts: %s', (_label, accounts) => {
    expect(() => parseMetaConfig(metaEnv({ accounts }))).toThrow(/accounts/);
  });

  it.each([
    ['unknown user', { ...account, user: 'nobody' }, {}, /POLYCAP_USERS/],
    ['reserved user', { ...account, user: 'meta-7001' }, {}, /reserved/],
    ['unknown project', { ...account, projects: ['NO'] }, {}, /POLYCAP_PROJECTS/],
    ['conflicting person', account, { people: { '7001': 'bob' } }, /conflicts/],
    ['unknown alias', { ...account, legacyGrantIds: ['missing'] }, {}, /does not exist/],
    ['reserved alias', { ...account, legacyGrantIds: ['meta-7002'] }, {}, /reserved/],
    ['wrong owner', { ...account, legacyGrantIds: ['bob-old'] }, {}, /user must equal/],
    ['read/post alias', { ...account, legacyGrantIds: ['mac'] }, {}, /upload-only/],
    ['project narrowed', { ...account, projects: ['MUS'] }, {}, /missing CAP/],
    ['duplicate alias', { ...account, legacyGrantIds: ['robin-old', 'robin-old'] }, {}, /more than once/],
    ['alias shared across accounts', account, { accounts: { '7002': account } }, /more than once/],
  ] as const)('fails before serving: %s', async (_label, mapping, extra, error) => {
    const cli = await testCli();
    try {
      const settings = { ...extra, accounts: { '7001': mapping, ...('accounts' in extra ? extra.accounts : {}) } };
      await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens: JSON.stringify(legacyGrants()), projects: PROJECTS, users: USERS, meta: metaEnv(settings) })).rejects.toThrow(error);
    } finally { await rm(cli.config.root, { recursive: true, force: true }); }
  });

  it.each([['upload', 'read'], ['upload', 'post'], ['post']] as const)('refuses a legacy grant with scopes %j', async (...scopes) => {
    const cli = await testCli(), grants = legacyGrants();
    grants[0].scopes = [...scopes];
    try {
      await expect(serve(cli, { host: '127.0.0.1', port: 0, tokens: JSON.stringify(grants), projects: PROJECTS, users: USERS, meta: metaEnv({ accounts }) })).rejects.toThrow(/upload-only/);
    } finally { await rm(cli.config.root, { recursive: true, force: true }); }
  });

  it('requires an attributed legacy owner and covers every configured project for unscoped grants', async () => {
    const cli = await testCli(), grants = legacyGrants();
    const options = { host: '127.0.0.1', port: 0, projects: PROJECTS, users: USERS, meta: metaEnv({ accounts }) };
    try {
      delete grants[0].user;
      await expect(serve(cli, { ...options, tokens: JSON.stringify(grants) })).rejects.toThrow(/user must equal/);
      grants[0].user = 'robin'; delete grants[0].projects;
      await expect(serve(cli, { ...options, tokens: JSON.stringify(grants) })).rejects.toThrow(/missing SEC/);
      const running = await serve(cli, { ...options, tokens: JSON.stringify(grants), meta: metaEnv({ accounts: { '7001': { ...account, projects: ['CAP', 'MUS', 'SEC'] } } }) });
      await running.close(); // No persisted testers, hence no Meta request.
    } finally { await rm(cli.config.root, { recursive: true, force: true }); }
  });
});

describe('explicit legacy ownership over HTTP', () => {
  let cli: Awaited<ReturnType<typeof testCli>>, running: Awaited<ReturnType<typeof serve>> | undefined;
  let store: UploadStore, grants: Grant[], old: UploadRecord, extra: UploadRecord, gone: UploadRecord, stranger: UploadRecord, unlinked: UploadRecord;
  let entitled: Set<string>, nonceCheck: ReturnType<typeof vi.spyOn>, entitlementCheck: ReturnType<typeof vi.spyOn>;
  let base: string, legacyTokens: Record<string, string>;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const signIn = (userId = '7001', deviceId = 'aabbccdd', name = 'Forged local name') =>
    call('POST', '/v1/testers/meta', undefined, { userId, nonce: `proof-${userId}`, deviceId, name, label: 'Quest' });
  async function start(settings: Record<string, unknown> = { accounts, people: { '7003': 'robin' } }) {
    if (running) { await running.testers!.check(); await running.close(); }
    running = await serve(cli, { host: '127.0.0.1', port: 0, tokens: JSON.stringify(grants), projects: PROJECTS, users: USERS, meta: metaEnv(settings) });
    base = `http://127.0.0.1:${running.port}`;
    await running.testers!.check();
  }
  beforeEach(async () => {
    cli = await testCli({}, { allowanceBytes: 300 }); grants = legacyGrants(); running = undefined;
    legacyTokens = {};
    for (const grant of grants) {
      const credential = newToken();
      grant.sha256 = credential.sha256; legacyTokens[grant.id] = credential.token;
    }
    entitled = new Set(['7001', '7002', '7003', '7004']);
    nonceCheck = vi.spyOn(MetaGraph.prototype, 'validNonce').mockImplementation(async (id, proof) => proof === `proof-${id}`);
    entitlementCheck = vi.spyOn(MetaGraph.prototype, 'entitled').mockImplementation(async id => entitled.has(id));
    await start();
    store = new UploadStore(cli.config.uploads);
    const seed = async (owner: string, clientId: string, bytes: number, status: UploadRecord['status'] = 'uploading', narration = false) => {
      const { record } = await store.create(owner, { ...input(clientId, bytes), ...(narration ? { audioTracks: ['mic'], narration: { bytes: 20, sha256: 'b'.repeat(64) } } : {}) });
      return store.update(record.id, { status });
    };
    old = await seed('robin-old', 'old-client', 100, 'ready', true);
    extra = await seed('robin-extra', 'extra-client', 50);
    gone = await seed('robin-old', 'gone-client', 99, 'deleted');
    stranger = await seed('bob-old', 'bob-client', 80, 'ready');
    unlinked = await seed('robin-unlinked', 'unlinked-client', 90, 'ready');
    old = await store.update(old.id, { sessionId: 'legacy-session' });
    await mkdir(sessionDir(cli.config, old.sessionId!), { recursive: true });
    await writeFile(join(sessionDir(cli.config, old.sessionId!), 'video.mp4'), 'synthetic');
  });
  afterEach(async () => {
    try { await running?.close(); } finally { vi.restoreAllMocks(); await rm(cli.config.root, { recursive: true, force: true }); }
  });

  it('default testers and attribution-only people cannot read, delete, resume or claim legacy uploads', async () => {
    const snapshot = await readFile(join(store.dir, old.id, 'meta.json'), 'utf8');
    for (const id of ['7004', '7003']) {
      const signed = await signIn(id, 'aabbccdd', 'Robin');
      expect(signed).toMatchObject({ status: 201, json: { projects: ['MUS'], grantId: `meta-${id}` } });
      const token = signed.json.token;
      expect((await call('GET', '/v1/projects', token)).json.projects).toEqual([{ key: 'MUS', name: 'Marimba' }]);
      expect((await call('GET', '/v1/uploads', token)).json.uploads).toEqual([]);
      expect((await call('GET', '/v1/account', token)).json).toMatchObject({ usedBytes: 0, recordings: 0 });
      for (const record of [old, gone, stranger, unlinked]) {
        expect((await call('GET', `/v1/uploads/${record.id}`, token)).status).toBe(404);
        expect((await call('DELETE', `/v1/uploads/${record.id}`, token)).status).toBe(404);
        for (const part of ['content', 'narration']) expect((await call('PUT', `/v1/uploads/${record.id}/${part}`, token)).status).toBe(404);
      }
      expect((await call('POST', '/v1/uploads', token, { ...input('claim'), legacyGrantIds: ['robin-old'] })).status).toBe(400);
      const made = await call('POST', '/v1/uploads', token, input(old.clientId, 100));
      expect(made.status).toBe(201); expect(made.json.id).not.toBe(old.id);
      expect((await store.get(made.json.id))!.grantId).toBe(`meta-${id}`);
      expect((await call('GET', '/v1/uploads', token)).json.uploads.map((r: any) => r.id)).toEqual([made.json.id]);
    }
    expect(await readFile(join(store.dir, old.id, 'meta.json'), 'utf8')).toBe(snapshot);
    expect((await call('POST', '/v1/testers/meta', undefined, { userId: '7001', nonce: 'proof-7004', deviceId: 'aabbccdd', name: 'Robin' })).status).toBe(403);
    expect((await call('POST', '/v1/testers/meta', undefined, { userId: '7004', nonce: 'proof-7004', deviceId: 'aabbccdd', legacyGrantIds: ['robin-old'] })).status).toBe(400);
  });

  it('restores only explicit aliases across installs/restarts, preserves tombstones, and limits projects and permissions', async () => {
    const before = await Promise.all([old, extra, gone, stranger, unlinked].map(r => readFile(join(store.dir, r.id, 'meta.json'), 'utf8')));
    const signed = await signIn();
    expect(signed).toMatchObject({ status: 201, json: { projects: ['CAP', 'MUS'], name: 'Robin' } });
    const token = signed.json.token;
    const history = await call('GET', '/v1/uploads', token);
    expect(history.json.uploads.map((r: any) => r.id).sort()).toEqual([old.id, extra.id, gone.id].sort());
    expect(history.json.uploads.find((r: any) => r.id === gone.id).status).toBe('deleted');
    expect((await call('GET', `/v1/uploads?clientId=${old.clientId}&clientId=${gone.clientId}`, token)).json.uploads).toHaveLength(2);
    expect((await call('GET', `/v1/uploads/${old.id}`, token)).status).toBe(200);
    for (const record of [stranger, unlinked]) {
      expect((await call('GET', `/v1/uploads/${record.id}`, token)).status).toBe(404);
      expect((await call('DELETE', `/v1/uploads/${record.id}`, token)).status).toBe(404);
    }
    for (const part of ['content', 'narration']) expect((await call('PUT', `/v1/uploads/${extra.id}/${part}`, token)).status).toBe(404);
    expect((await call('GET', '/v1/sessions', token)).status).toBe(403);
    expect((await call('GET', '/v1/sessions/legacy-session/files', token)).status).toBe(403);
    expect((await call('POST', '/v1/threads', token, { project: 'CAP', title: 'No', text: 'No' })).status).toBe(403);
    expect((await call('POST', '/v1/uploads', token, { ...input('separate'), thread: { project: 'SEC' } })).status).toBe(404);
    expect((await call('GET', '/v1/projects', token)).json.projects.map((p: any) => p.key).sort()).toEqual(['CAP', 'MUS']);
    const own = await call('POST', '/v1/uploads', token, { ...input(extra.clientId), thread: { project: 'CAP' } });
    expect(own.status).toBe(201); expect(own.json.id).not.toBe(extra.id); expect(own.json.thread).toMatch(/^CAP-/);
    expect((await call('POST', '/v1/uploads', token, input(extra.clientId))).json.id).toBe(own.json.id);
    const partial = await fetch(`${base}/v1/uploads/${own.json.id}/content`, { method: 'PUT', headers: {
      authorization: `Bearer ${token}`, 'content-range': 'bytes 0-0/10', 'content-length': '1',
    }, body: 'x' });
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ received: 1, status: 'uploading' });
    const bob = (await signIn('7002')).json.token;
    expect((await call('GET', '/v1/uploads', bob)).json.uploads.map((r: any) => r.id)).toEqual([stranger.id]);
    expect((await call('DELETE', `/v1/uploads/${own.json.id}`, bob)).status).toBe(404);
    const second = (await signIn('7001', '11223344')).json.token;
    expect((await call('GET', '/v1/uploads', second)).json.uploads).toHaveLength(4);
    const rotated = (await signIn('7001', '11223344')).json.token;
    expect((await call('GET', '/v1/uploads', second)).status).toBe(401);
    await start();
    expect((await call('GET', '/v1/uploads', rotated)).json.uploads).toHaveLength(4);
    expect((await call('GET', '/v1/uploads', token)).status).toBe(200);
    expect(await Promise.all([old, extra, gone, stranger, unlinked].map(r => readFile(join(store.dir, r.id, 'meta.json'), 'utf8')))).toEqual(before);
    expect(await exists(sessionDir(cli.config, old.sessionId!))).toBe(true);
    // Removing continuity is reversible without migrating or changing any upload owner.
    await start({ accounts: { '7001': { user: 'robin', projects: ['CAP', 'MUS'], legacyGrantIds: [] } }, people: { '7001': 'robin' } });
    expect((await call('GET', '/v1/uploads', token)).json.uploads.map((r: any) => r.id)).toEqual([own.json.id]);
    expect((await call('GET', `/v1/uploads/${old.id}`, token)).status).toBe(404);
  });

  it('shares quota with retained legacy bearer tokens before enrollment, without reciprocal record access', async () => {
    grants[0].maxBytes = 1000; grants[1].maxBytes = 2000;
    await start();
    // An old Meta-owned record counts even when no tester has enrolled on this receiver yet.
    const historical = (await store.create('meta-7001', input('historical-meta', 5))).record;
    const oldToken = legacyTokens['robin-old'], extraToken = legacyTokens['robin-extra'];
    for (const [token, grantId, visibleIds] of [
      [oldToken, 'robin-old', [old.id, gone.id]], [extraToken, 'robin-extra', [extra.id]],
    ] as const) {
      expect((await call('GET', '/v1/account', token)).json).toEqual({ grantId, usedBytes: 175, allowanceBytes: 200, recordings: 3 });
      expect((await call('GET', '/v1/uploads', token)).json.uploads.map((r: any) => r.id).sort()).toEqual([...visibleIds].sort());
      for (const record of [old, extra, historical, stranger, unlinked].filter(r => r.grantId !== grantId)) {
        expect((await call('GET', `/v1/uploads/${record.id}`, token)).status).toBe(404);
        expect((await call('DELETE', `/v1/uploads/${record.id}`, token)).status).toBe(404);
      }
      expect((await call('POST', '/v1/uploads', token, input('before-enrollment-too-big', 26))).status).toBe(507);
      expect((await call('POST', '/v1/uploads', token, { ...input('narrated-too-big', 20), audioTracks: ['mic'], narration: { bytes: 6, sha256: 'a'.repeat(64) } })).status).toBe(507);
    }
    const legacyMade = await call('POST', '/v1/uploads', oldToken, input('legacy-new', 5));
    expect(legacyMade.status).toBe(201);
    expect((await store.get(legacyMade.json.id))!.grantId).toBe('robin-old');
    const metaToken = (await signIn()).json.token;
    expect((await call('GET', '/v1/account', metaToken)).json).toMatchObject({ usedBytes: 180, allowanceBytes: 200, recordings: 4 });
    expect((await call('POST', '/v1/uploads', metaToken, input('meta-too-big', 21))).status).toBe(507);
    const metaMade = await call('POST', '/v1/uploads', metaToken, input('meta-new', 10));
    expect(metaMade.status).toBe(201);
    expect((await call('POST', '/v1/uploads', extraToken, input('extra-new', 10))).status).toBe(201);
    for (const token of [oldToken, extraToken, metaToken]) {
      expect((await call('GET', '/v1/account', token)).json).toMatchObject({ usedBytes: 200, allowanceBytes: 200, recordings: 6 });
      expect((await call('POST', '/v1/uploads', token, input('at-shared-limit', 1))).status).toBe(507);
    }
    for (const token of [oldToken, extraToken]) {
      expect((await call('GET', `/v1/uploads/${metaMade.json.id}`, token)).status).toBe(404);
      expect((await call('DELETE', `/v1/uploads/${metaMade.json.id}`, token)).status).toBe(404);
    }
    // Unlinked grants sharing user attribution still have their own independent account.
    expect((await call('GET', '/v1/account', legacyTokens['robin-unlinked'])).json).toMatchObject({ usedBytes: 90, recordings: 1 });
    expect((await call('DELETE', `/v1/uploads/${old.id}`, oldToken)).status).toBe(200);
    for (const token of [oldToken, extraToken, metaToken]) {
      expect((await call('GET', '/v1/account', token)).json).toMatchObject({ usedBytes: 80, recordings: 5 });
    }
  });

  it.each([undefined, 1000, 180])('uses the default canonical allowance and preserves a tighter legacy cap (%s)', async maxBytes => {
    grants[0].maxBytes = maxBytes;
    await start({ accounts, maxBytes: undefined });
    const legacyToken = legacyTokens['robin-old'], allowance = cli.config.allowanceBytes, cap = Math.min(allowance, maxBytes ?? Infinity);
    // No enrollment is required for either canonical usage or the server-default allowance.
    expect((await call('GET', '/v1/account', legacyToken)).json).toMatchObject({ usedBytes: 170, allowanceBytes: cap });
    expect((await call('POST', '/v1/uploads', legacyToken, input('over-legacy-cap', cap - 170 + 1))).status).toBe(507);
    expect((await call('POST', '/v1/uploads', legacyToken, input('within-legacy-cap', cap - 170))).status).toBe(201);
    const token = (await signIn()).json.token;
    expect((await call('GET', '/v1/account', token)).json).toMatchObject({ usedBytes: cap, allowanceBytes: allowance });
    if (cap < allowance) expect((await call('POST', '/v1/uploads', token, input('remaining-meta-allowance', allowance - cap))).status).toBe(201);
    for (const credential of [legacyToken, token]) {
      expect((await call('POST', '/v1/uploads', credential, input('over-shared-cap', 1))).status).toBe(507);
    }
  });

  it('aggregates account quota including narration and unfinished legacy uploads, while deletion frees space without resurrection', async () => {
    const token = (await signIn()).json.token, second = (await signIn('7001', '11223344')).json.token;
    expect((await call('GET', '/v1/account', token)).json).toEqual({ grantId: 'meta-7001', usedBytes: 170, allowanceBytes: 200, recordings: 2 });
    expect((await call('POST', '/v1/uploads', token, input('too-big', 31))).status).toBe(507);
    expect((await call('POST', '/v1/uploads', token, { ...input('narration-too-big', 20), audioTracks: ['mic'], narration: { bytes: 11, sha256: 'a'.repeat(64) } })).status).toBe(507);
    const made = await call('POST', '/v1/uploads', token, input('new', 30));
    expect(made.status).toBe(201);
    expect((await call('GET', '/v1/account', second)).json).toMatchObject({ usedBytes: 200, recordings: 3 });
    expect((await call('POST', '/v1/uploads', second, input('at-limit', 1))).status).toBe(507);
    for (const status of ['received', 'processing'] as const) {
      await store.update(extra.id, { status });
      expect((await call('DELETE', `/v1/uploads/${extra.id}`, token)).status).toBe(409);
    }
    await store.update(extra.id, { status: 'uploading' });
    expect((await call('DELETE', `/v1/uploads/${old.id}`, token)).json.status).toBe('deleted');
    expect(await exists(sessionDir(cli.config, old.sessionId!))).toBe(false);
    expect((await store.get(old.id))!.grantId).toBe('robin-old');
    expect((await call('GET', '/v1/account', second)).json).toMatchObject({ usedBytes: 80, recordings: 2 });
    const tombstone = await readFile(join(store.dir, old.id, 'meta.json'), 'utf8');
    expect((await call('DELETE', `/v1/uploads/${old.id}`, second)).status).toBe(200);
    const fresh = await call('POST', '/v1/uploads', second, input(old.clientId, old.bytes));
    expect(fresh.status).toBe(201); expect(fresh.json.id).not.toBe(old.id);
    expect((await store.get(fresh.json.id))!.grantId).toBe('meta-7001');
    expect(await readFile(join(store.dir, old.id, 'meta.json'), 'utf8')).toBe(tombstone);
    await start();
    expect((await call('GET', `/v1/uploads/${old.id}`, token)).json.status).toBe('deleted');
    expect(await exists(sessionDir(cli.config, old.sessionId!))).toBe(false);
  });

  it('links do not bypass freshness, entitlement revocation, or local blocks', async () => {
    let token = (await signIn()).json.token;
    const metaMade = await call('POST', '/v1/uploads', token, input('meta-before-block', 30));
    expect(metaMade.status).toBe(201);
    const tester = running!.testers!.active.find(t => t.metaUserId === '7001')!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(tester.checkedAt) + MAX_VERIFIED_AGE_MS);
    try {
      for (const path of ['/v1/account', '/v1/uploads', `/v1/uploads/${old.id}`]) expect((await call('GET', path, token)).status).toBe(401);
      expect((await call('DELETE', `/v1/uploads/${old.id}`, token)).status).toBe(401);
    } finally { clock.mockRestore(); }
    entitlementCheck.mockRejectedValueOnce(new Error('Meta unavailable'));
    tester.checkedAt = new Date(Date.now() - MAX_VERIFIED_AGE_MS).toISOString();
    expect(await running!.testers!.check()).toMatchObject({ failed: 1 });
    expect((await call('GET', '/v1/uploads', token)).status).toBe(401);
    await running!.testers!.check();
    expect((await call('GET', `/v1/uploads/${old.id}`, token)).status).toBe(200);
    entitled.delete('7001'); await running!.testers!.check();
    expect((await call('DELETE', `/v1/uploads/${old.id}`, token)).status).toBe(401);
    entitled.add('7001'); token = (await signIn()).json.token;
    await start({ accounts, blockedUsers: ['7001'] });
    const asked = nonceCheck.mock.calls.length;
    expect((await signIn()).status).toBe(403);
    expect(nonceCheck.mock.calls.length).toBe(asked);
    expect((await call('GET', '/v1/uploads', token)).status).toBe(401);
    expect((await call('DELETE', `/v1/uploads/${old.id}`, token)).status).toBe(401);
    expect((await store.get(old.id))!.status).toBe('ready');
    // Local Meta revocation is not legacy credential revocation; remove those env entries separately.
    for (const id of ['robin-old', 'robin-extra']) {
      const legacyToken = legacyTokens[id];
      expect((await call('GET', '/v1/account', legacyToken)).json).toMatchObject({ grantId: id, usedBytes: 200, allowanceBytes: 200 });
      expect((await call('GET', '/v1/uploads', legacyToken)).status).toBe(200);
      expect((await call('GET', `/v1/uploads/${metaMade.json.id}`, legacyToken)).status).toBe(404);
      expect((await call('DELETE', `/v1/uploads/${metaMade.json.id}`, legacyToken)).status).toBe(404);
      expect((await call('POST', '/v1/uploads', legacyToken, input('blocked-but-shared', 1))).status).toBe(507);
    }
    const legacyToken = legacyTokens['robin-old'];
    expect((await call('DELETE', `/v1/uploads/${old.id}`, legacyToken)).status).toBe(200);
    expect((await call('GET', '/v1/account', legacyToken)).json).toMatchObject({ usedBytes: 80, allowanceBytes: 200 });
    expect((await call('POST', '/v1/uploads', legacyToken, input('legacy-still-active', 120))).status).toBe(201);
    expect((await call('POST', '/v1/uploads', legacyToken, input('still-shared-after-block', 1))).status).toBe(507);
  });
});
