/** Durable reply receipts live in the thread, not the append-only event feed. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { ThreadStore } from '../src/server/threads.js';
import { newToken, type Grant } from '../src/server/tokens.js';
import { parseProjects, type Launch } from '../src/threads.js';
import { testCli } from './helpers/cli.js';

const PROJECTS = JSON.stringify([
  { key: 'CAP', name: 'Capture', hosts: ['preview.example.com'], packages: ['net.polydance.capture'] },
  { key: 'MUS', name: 'Marimba' },
]);
const projects = parseProjects(PROJECTS);
const team: Grant = { id: 'mac', sha256: '0'.repeat(64), scopes: ['read', 'post'], label: 'Mac' };
const other: Grant = { ...team, id: 'other' };
const launches: Launch[] = [{ label: 'Try it', steps: [
  { do: 'require', package: 'net.polydance.capture', versionCode: 6 },
  { do: 'app', package: 'net.polydance.capture', extras: { variant: 'blue', count: 2 } },
] }];

describe('idempotent replies in the thread store', () => {
  let threads: ThreadStore;
  beforeEach(async () => {
    threads = new ThreadStore(await mkdtemp(join(tmpdir(), 'reply-idempotency-')), projects);
    await threads.create(team, { project: 'CAP', title: 'Test replies', text: 'First message' });
  });
  afterEach(async () => { await rm(threads.dir, { recursive: true, force: true }); });

  it('serializes simultaneous retries, creating one message and reopening only once', async () => {
    await threads.setState(team, 'CAP-1', 'closed');
    const before = await threads.lastEventId();
    const input = { deliveryId: randomUUID(), text: 'Updated build', launches, as: 'Agent' };
    const replies = await Promise.all(Array.from({ length: 16 }, () => threads.post(team, 'CAP-1', input)));
    for (const reply of replies) {
      expect(reply).toEqual(replies[0]);
      expect(reply).toMatchObject({ state: 'open', seq: 4 });
      expect(reply.messages).toHaveLength(2);
      expect(reply.messages[1]).toMatchObject({ id: 2, seq: 4, deliveryId: input.deliveryId, text: input.text, launches, by: { id: team.id, as: 'Agent' } });
    }
    expect((await threads.eventsAfter(team, before)).map(e => e.kind)).toEqual(['reopened', 'message']);
  });

  it('survives restart without changing state, timestamps, reads, reactions, seq or events', async () => {
    const input = { deliveryId: 'reply_restart-1', text: 'Updated build', launches, as: 'Agent' };
    await threads.post(team, 'CAP-1', input);
    await threads.react(other, 'CAP-1', 2, 'heart');
    await threads.markRead(other, 'CAP-1', 99);
    await threads.setState(other, 'CAP-1', 'closed');
    const file = join(threads.dir, 'CAP-1.json'), events = join(threads.dir, 'events.jsonl');
    const before = await readFile(file, 'utf8'), feed = await readFile(events, 'utf8');
    const restarted = new ThreadStore(threads.dir, projects);
    // Grant identity, not its current label, token hash or person, is the receipt's scope.
    const changedGrant = { ...team, label: 'New Mac', sha256: '1'.repeat(64), user: 'new-person' };
    expect(await restarted.post(changedGrant, 'CAP-1', input)).toEqual(JSON.parse(before));
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readFile(events, 'utf8')).toBe(feed);
  });

  it('scopes each key to one grant id and one thread, while unkeyed posts still repeat', async () => {
    await threads.create(team, { project: 'CAP', title: 'Another thread', text: 'First' });
    const input = { deliveryId: 'shared-key', text: 'Reply' };
    await threads.post(team, 'CAP-1', input);
    await threads.post(other, 'CAP-1', { ...input, text: 'Other grant reply' });
    await threads.post(team, 'CAP-2', { ...input, text: 'Other thread reply' });
    await threads.post(team, 'CAP-1', input);
    await threads.post(other, 'CAP-1', { ...input, text: 'Other grant reply' });
    await threads.post(team, 'CAP-1', { text: 'Unkeyed' });
    await threads.post(team, 'CAP-1', { text: 'Unkeyed' });
    const thread = (await threads.get('CAP-1'))!;
    expect(thread.messages.map(m => [m.by.id, m.deliveryId])).toEqual([
      ['mac', undefined], ['mac', 'shared-key'], ['other', 'shared-key'], ['mac', undefined], ['mac', undefined],
    ]);
    expect((await threads.get('CAP-2'))!.messages).toHaveLength(2);
    await expect(threads.post({ ...team, projects: ['MUS'] }, 'CAP-1', input)).rejects.toMatchObject({ status: 404 });
  });

  it('ignores object key order but rejects changed text, agent, launches and array order', async () => {
    const input = { deliveryId: 'payload-key', text: 'Updated build', launches, as: 'Agent' };
    await threads.post(team, 'CAP-1', input);
    const reordered: Launch[] = [{ steps: [
      { versionCode: 6, package: 'net.polydance.capture', do: 'require' },
      { extras: { count: 2, variant: 'blue' }, package: 'net.polydance.capture', do: 'app' },
    ], label: 'Try it' }];
    expect((await threads.post(team, 'CAP-1', { ...input, launches: reordered })).messages).toHaveLength(2);
    const before = await readFile(join(threads.dir, 'CAP-1.json'), 'utf8');
    const feed = await readFile(join(threads.dir, 'events.jsonl'), 'utf8');
    const changed = [
      { ...input, text: 'Different' }, { ...input, text: undefined },
      { ...input, as: 'Another Agent' }, { ...input, as: undefined },
      { ...input, launches: undefined },
      { ...input, launches: [{ ...launches[0], label: 'Different label' }] },
      { ...input, launches: [{ ...launches[0], steps: [...launches[0].steps].reverse() }] },
    ];
    for (const payload of changed) {
      await expect(threads.post(team, 'CAP-1', payload)).rejects.toMatchObject({ status: 400, message: 'deliveryId already used for a different reply payload' });
    }
    expect(await readFile(join(threads.dir, 'CAP-1.json'), 'utf8')).toBe(before);
    expect(await readFile(join(threads.dir, 'events.jsonl'), 'utf8')).toBe(feed);
  });

  it('deduplicates even when the thread committed but its event append failed', async () => {
    await threads.setState(team, 'CAP-1', 'closed');
    const file = join(threads.dir, 'CAP-1.json'), events = join(threads.dir, 'events.jsonl');
    const feed = await readFile(events, 'utf8');
    // Fail the real append after the atomic thread write, without mocking the store's commit.
    await rename(events, `${events}.saved`);
    await mkdir(events);
    const input = { deliveryId: 'partial-commit', text: 'Reply after close', as: 'Agent' };
    await expect(threads.post(team, 'CAP-1', input)).rejects.toThrow();
    const committed = await readFile(file, 'utf8');
    expect(JSON.parse(committed)).toMatchObject({ seq: 4, state: 'open', messages: [{ id: 1 }, { id: 2, deliveryId: input.deliveryId }] });
    // Both this process and a fresh process can acknowledge the receipt without reading the feed.
    expect(await threads.post(team, 'CAP-1', input)).toEqual(JSON.parse(committed));
    const restarted = new ThreadStore(threads.dir, projects);
    expect(await restarted.post(team, 'CAP-1', input)).toEqual(JSON.parse(committed));
    await expect(restarted.post(team, 'CAP-1', { ...input, text: 'Changed' })).rejects.toMatchObject({ status: 400 });
    expect(await readFile(file, 'utf8')).toBe(committed);
    await rm(events, { recursive: true });
    await rename(`${events}.saved`, events);
    expect(await readFile(events, 'utf8')).toBe(feed);
    expect((await restarted.eventsAfter(team, 0)).map(e => e.kind)).toEqual(['thread.new', 'closed']);
  });

  it('validates keys even for direct store calls', async () => {
    for (const deliveryId of ['', 'with space', '../reply', 'a'.repeat(129)]) {
      await expect(threads.post(team, 'CAP-1', { text: 'Reply', deliveryId })).rejects.toMatchObject({ status: 400 });
    }
    expect((await threads.get('CAP-1'))!.messages).toHaveLength(1);
  });
});

describe('idempotent replies over HTTP', () => {
  const mac = newToken(), read = newToken(), outsider = newToken();
  let base: string, root: string, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const cli = await testCli();
    root = cli.config.root;
    const running = await serve(cli, { host: '127.0.0.1', port: 0, projects: PROJECTS, tokens: JSON.stringify([
      { ...team, sha256: mac.sha256 },
      { id: 'reader', sha256: read.sha256, scopes: ['read'] },
      { id: 'outsider', sha256: outsider.sha256, scopes: ['post'], projects: ['MUS'] },
    ]) });
    base = `http://127.0.0.1:${running.port}`;
    close = running.close;
  });
  afterAll(async () => { await close?.(); if (root) await rm(root, { recursive: true, force: true }); });

  const call = async (method: string, path: string, body?: unknown, token: string | undefined = mac.token) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  const create = async () => {
    const response = await call('POST', '/v1/threads', { project: 'CAP', title: 'Replies', text: 'First' });
    expect(response.status).toBe(201);
    return response.json.key as string;
  };

  it('advertises the protocol in projects, including for restricted grants', async () => {
    expect(await call('GET', '/v1/projects')).toEqual({ status: 200, json: {
      me: 'mac', projects: [{ key: 'CAP', name: 'Capture' }, { key: 'MUS', name: 'Marimba' }], capabilities: ['idempotent-replies-v1', 'models-v1', 'photos-v1', 'projects-new-v1', 'projects-edit-v1', 'agents-v1'],
    } });
    expect((await call('GET', '/v1/projects', undefined, outsider.token)).json).toEqual({
      me: 'outsider', projects: [{ key: 'MUS', name: 'Marimba' }], capabilities: ['idempotent-replies-v1', 'models-v1', 'photos-v1', 'projects-new-v1', 'projects-edit-v1', 'agents-v1'],
    });
    expect((await call('GET', '/v1/projects', undefined, '')).status).toBe(401);
  });

  it('returns the existing message on normalized retries and a clear 400 on key reuse', async () => {
    const key = await create(), path = `/v1/threads/${key}/messages`;
    const body = { deliveryId: randomUUID(), text: '  Updated build  ', as: ' Agent ', launches };
    const first = await call('POST', path, body);
    const retry = await call('POST', path, { ...body, text: 'Updated build', as: 'Agent' });
    expect(first.status).toBe(201);
    expect(retry).toEqual(first);
    expect(first.json.messages).toHaveLength(2);
    expect(first.json.messages[1]).toMatchObject({ id: 2, deliveryId: body.deliveryId, text: 'Updated build', by: { id: 'mac', as: 'Agent' } });
    const conflict = await call('POST', path, { ...body, text: 'Different reply' });
    expect(conflict).toMatchObject({ status: 400, json: { error: 'deliveryId already used for a different reply payload' } });
    expect((await call('GET', `/v1/threads/${key}`)).json).toEqual(first.json);
    const feed = await call('GET', `/v1/events?after=0&thread=${key}`);
    expect(feed.json.events.map((e: { kind: string }) => e.kind)).toEqual(['thread.new', 'message']);
    expect((await call('POST', path, body, read.token)).status).toBe(403);
    expect((await call('POST', path, body, outsider.token)).status).toBe(404);
  });

  it('accepts bounded safe ids and legacy requests but rejects invalid keys before mutation', async () => {
    const key = await create(), path = `/v1/threads/${key}/messages`;
    for (const deliveryId of ['', ' ', 'with space', '../reply', 'a.b', 'a:b', 'a\nb', 'é', 'a'.repeat(129), 7, null, {}]) {
      const result = await call('POST', path, { deliveryId, text: 'Reply' });
      expect(result.status).toBe(400);
      expect(result.json.error).toContain('deliveryId');
    }
    expect((await call('GET', `/v1/threads/${key}`)).json.messages).toHaveLength(1);
    for (const deliveryId of ['a', 'Reply_01-safe', 'a'.repeat(128)]) {
      const body = { deliveryId, text: 'Reply' };
      const first = await call('POST', path, body);
      expect(first.status).toBe(201);
      expect(await call('POST', path, body)).toEqual(first);
    }
    // Optional means older clients still publish a new message on every request.
    await call('POST', path, { text: 'Legacy' });
    await call('POST', path, { text: 'Legacy' });
    expect((await call('GET', `/v1/threads/${key}`)).json.messages).toHaveLength(6);
  });
});
