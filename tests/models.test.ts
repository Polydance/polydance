/** 3D models in threads: the .glb check, the model step, the receiver's store and routes, and `--model` (docs/THREADS.md, Models). */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '../src/commands/serve.js';
import { launchesFrom, modelFiles, modelStep, threadNew, threadReply, threadShow } from '../src/commands/thread.js';
import { launchArgs } from '../src/cli.js';
import { inspectGlb } from '../src/glb.js';
import { newToken } from '../src/server/tokens.js';
import { describeLaunch, launchSchema, megabytes, type ModelStep } from '../src/threads.js';
import { testCli } from './helpers/cli.js';
import { makeGlb } from './helpers/glb.js';

const PROJECTS = JSON.stringify([
  { key: 'MUS', name: 'Marimba', packages: ['com.example.marimba'] },
  { key: 'CAP', name: 'Polydance Capture', packages: ['net.polydance.capture'] },
]);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('3D models: the .glb check and the model step', () => {
  it('takes a binary glTF 2 with its own buffers, and says what is wrong with anything else', () => {
    expect(inspectGlb(makeGlb())).toEqual({ problems: [], info: { meshes: 1, animations: 0, extensionsRequired: [] } });
    const glb = makeGlb();
    expect(inspectGlb(Buffer.from('{"asset":{"version":"2.0"}}'), 'chair.gltf').problems[0]).toMatch(/^chair\.gltf: not a binary glTF \(\.glb\) file; a \.gltf with separate files must be packed/);
    expect(inspectGlb(glb.subarray(0, glb.length - 4)).problems[0]).toMatch(/cut short or damaged/);
    const v1 = Buffer.from(glb); v1.writeUInt32LE(1, 4);
    expect(inspectGlb(v1).problems[0]).toMatch(/container version 1/);
    const mesh = { meshes: [{ primitives: [] }] };
    expect(inspectGlb(makeGlb({ asset: { version: '2.0' }, ...mesh, images: [{ uri: 'textures/oak.png' }], buffers: [{ uri: 'chair.bin', byteLength: 4 }] })).problems[0])
      .toMatch(/refers to files outside it \(chair\.bin, textures\/oak\.png\); pack them into one \.glb/);
    expect(inspectGlb(makeGlb({ asset: { version: '2.0' }, ...mesh, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }] })).problems).toEqual([]);
    expect(inspectGlb(makeGlb({ asset: { version: '2.0' }, ...mesh, buffers: [{ byteLength: 12 }] })).problems[0]).toMatch(/binary chunk is missing/);
    expect(inspectGlb(makeGlb({ asset: { version: '2.0' } })).problems[0]).toMatch(/has no meshes/);
    expect(inspectGlb(makeGlb({ asset: { version: '1.0' }, ...mesh })).problems[0]).toMatch(/only glTF 2/);
    expect(inspectGlb(makeGlb({ asset: {} })).problems[0]).toMatch(/glTF JSON is not valid: asset\.version/);
  });

  it('accepts one model per launch, named by its sha256, and says it in words', () => {
    const model: ModelStep = { do: 'model', sha256: 'a'.repeat(64), name: 'Oak chair.glb', bytes: 4_200_000 };
    const ok = (launch: unknown) => launchSchema.safeParse(launch).success;
    expect(ok({ label: 'Oak', steps: [model] })).toBe(true);
    expect(ok({ steps: [{ do: 'require', package: 'net.polydance.capture', minVersionCode: 23 }, model] })).toBe(true);
    expect(ok({ steps: [model, { ...model, sha256: 'b'.repeat(64) }] })).toBe(false);
    expect(ok({ steps: [{ ...model, sha256: 'A'.repeat(64) }] })).toBe(false);
    expect(ok({ steps: [{ ...model, name: '../chair.glb' }] })).toBe(false);
    expect(ok({ steps: [{ ...model, name: 'chair.gltf' }] })).toBe(false);
    expect(ok({ steps: [{ ...model, bytes: 0 }] })).toBe(false);
    expect(ok({ steps: [{ ...model, url: 'https://example.com/chair.glb' }] })).toBe(false);
    expect(describeLaunch({ label: 'Oak', steps: [model] })).toBe('Oak: open model Oak chair.glb (4.2 MB)');
    expect(megabytes(640_000)).toBe('640 kB');
    expect(megabytes(12)).toBe('1 kB');
  });

  it('builds model launches from --model, shared or per option, from the steps pushed', async () => {
    const oak: ModelStep = { do: 'model', sha256: 'a'.repeat(64), name: 'oak.glb', bytes: 10 };
    const walnut: ModelStep = { do: 'model', sha256: 'b'.repeat(64), name: 'walnut.glb', bytes: 10 };
    const pushed = new Map([['oak.glb', oak], ['m/walnut.glb', walnut]]);
    const options = launchArgs(['MUS-1', '--option', 'Oak', '--model', 'oak.glb', '--option', 'Walnut', '--model', 'm/walnut.glb']);
    expect(modelFiles({ ...options.values, optionGroups: options.optionGroups })).toEqual(['oak.glb', 'm/walnut.glb']);
    expect(await launchesFrom({ ...options.values, optionGroups: options.optionGroups }, pushed)).toEqual([{ label: 'Oak', steps: [oak] }, { label: 'Walnut', steps: [walnut] }]);
    expect(await launchesFrom({ model: 'oak.glb', label: 'Chair' }, pushed)).toEqual([{ label: 'Chair', steps: [oak] }]);
    await expect(launchesFrom({ model: 'other.glb' }, pushed)).rejects.toThrow(/was not pushed/);

    const dir = await mkdtemp(join(tmpdir(), 'model-'));
    const glb = makeGlb();
    await writeFile(join(dir, 'chair.glb'), glb);
    expect((await modelStep(join(dir, 'chair.glb'))).step).toEqual({ do: 'model', sha256: sha(glb), name: 'chair.glb', bytes: glb.length });
    await writeFile(join(dir, 'chair.gltf'), '{}');
    await expect(modelStep(join(dir, 'chair.gltf'))).rejects.toThrow(/named like chair\.glb/);
    await writeFile(join(dir, 'fake.glb'), 'not a model');
    await expect(modelStep(join(dir, 'fake.glb'))).rejects.toThrow(/fake\.glb: not a binary glTF/);
    await expect(modelStep(join(dir, 'missing.glb'))).rejects.toThrow(/no such file/);
  });
});

describe('3D models on the receiver', () => {
  const quest = newToken(), mac = newToken(), outsider = newToken(), reader = newToken();
  const tokens = JSON.stringify([
    { id: 'quest3', sha256: quest.sha256, scopes: ['upload'], label: "Robin's Quest 3" },
    { id: 'mac', sha256: mac.sha256, scopes: ['read', 'post'], label: 'Marimba agent' },
    { id: 'other', sha256: outsider.sha256, scopes: ['upload'], projects: ['CAP'] },
    { id: 'cap-agent', sha256: reader.sha256, scopes: ['post'], projects: ['CAP'] },
  ]);
  const glb = makeGlb();
  const model = { do: 'model', sha256: sha(glb), name: 'triangle.glb', bytes: glb.length };
  let base: string; let close: () => Promise<void>; let root: string;

  beforeAll(async () => {
    const server = await testCli({ POLYCAP_MODEL_MAX_BYTES: '4096', POLYCAP_MODELS_TOTAL_BYTES: String(glb.length * 2 + 10) });
    root = server.config.root;
    const running = await serve(server, { host: '127.0.0.1', port: 0, tokens, projects: PROJECTS });
    base = `http://127.0.0.1:${running.port}`; close = running.close;
  });
  afterAll(async () => { await close?.(); });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}) },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: Record<string, any> | undefined;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { json = undefined; }
    return { status: response.status, json, bytes, type: response.headers.get('content-type') };
  };

  it('keeps a pushed .glb once, privately, only from a team token that sees the project', async () => {
    const put = (token: string, data: Buffer, project = 'MUS', hash = sha(data)) => call('PUT', `/v1/projects/${project}/models/${hash}`, token, data);
    expect((await put(quest.token, glb)).status).toBe(403);
    expect((await put(reader.token, glb)).status).toBe(404);
    expect((await put(mac.token, glb, 'MUS', 'abc')).status).toBe(400);
    const wrong = await put(mac.token, glb, 'MUS', 'f'.repeat(64));
    expect(wrong).toMatchObject({ status: 400, json: { error: 'the model does not match the sha256 it was sent under' } });
    const fake = Buffer.from('not a model at all, just text');
    expect((await put(mac.token, fake)).json?.error).toMatch(/not a binary glTF/);
    expect((await put(mac.token, Buffer.alloc(5000))).status).toBe(413);

    expect(await put(mac.token, glb)).toMatchObject({ status: 201, json: { project: 'MUS', sha256: sha(glb), bytes: glb.length } });
    expect(await put(mac.token, glb)).toMatchObject({ status: 200, json: { sha256: sha(glb) } });
    const dir = join(root, 'thread-models', 'MUS');
    expect(await readdir(dir)).toEqual([`${sha(glb)}.glb`]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${sha(glb)}.glb`))).mode & 0o777).toBe(0o600);
    // The cap on all models together: a second, different model would pass it.
    const other = makeGlb({ asset: { version: '2.0' }, meshes: [{ primitives: [] }], extras: { pad: 'x'.repeat(glb.length) } });
    expect((await put(mac.token, other)).status).toBe(507);
  });

  it('refuses a launch with a model nobody pushed, and lets the thread\'s viewers fetch the one it names', async () => {
    const missing = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Chair', launches: [{ steps: [{ ...model, sha256: 'e'.repeat(64) }] }] });
    expect(missing.status).toBe(400);
    expect(missing.json?.error).toMatch(/triangle\.glb \(eeeeeeeeeeee…\) has not been pushed to MUS/);
    // Pushed to MUS, so not there for CAP.
    expect((await call('POST', '/v1/threads', reader.token, { project: 'CAP', title: 'Chair', launches: [{ steps: [model] }] })).status).toBe(400);

    const opened = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'Chair', text: 'Does the chair read as oak?', launches: [{ label: 'Oak', steps: [model] }] });
    expect(opened.status).toBe(201);
    const key = opened.json!.key as string;
    expect(opened.json!.messages[0].launches).toEqual([{ label: 'Oak', steps: [model] }]);

    const fetched = await call('GET', `/v1/threads/${key}/models/${sha(glb)}`, quest.token);
    expect(fetched.status).toBe(200);
    expect(fetched.type).toBe('model/gltf-binary');
    expect(fetched.bytes.equals(glb)).toBe(true);
    expect((await fetch(`${base}/v1/threads/${key}/models/${sha(glb)}`, { method: 'HEAD', headers: { authorization: `Bearer ${quest.token}` } })).headers.get('content-length')).toBe(String(glb.length));
    // Not through a thread this token cannot see, nor one that does not name the model.
    expect((await call('GET', `/v1/threads/${key}/models/${sha(glb)}`, outsider.token)).status).toBe(404);
    const plain = await call('POST', '/v1/threads', mac.token, { project: 'MUS', title: 'No model', text: 'hello' });
    expect((await call('GET', `/v1/threads/${plain.json!.key}/models/${sha(glb)}`, quest.token)).status).toBe(404);
    expect((await call('GET', `/v1/threads/${key}/models/../../tokens`, quest.token)).status).toBe(404);
  });

  it('pushes --model from the CLI before the message names it, and shows it in the thread', async () => {
    const agent = await testCli({ POLYCAP_REMOTE_URL: base, POLYCAP_REMOTE_TOKEN: mac.token });
    const dir = await mkdtemp(join(tmpdir(), 'cli-model-'));
    await writeFile(join(dir, 'triangle.glb'), glb);
    const key = await threadNew(agent, 'Triangle', { project: 'MUS', text: 'Rotate it.', model: join(dir, 'triangle.glb'), cwd: dir });
    expect(agent.lines).toContain(`triangle.glb (1 kB) is on the receiver for MUS`);
    expect(await threadReply(agent, key, { text: 'Again, as an option.', optionGroups: { shared: {}, options: [{ label: 'Same', model: join(dir, 'triangle.glb') }] }, cwd: dir })).toBe(2);
    agent.lines.length = 0;
    await threadShow(agent, key, { cwd: dir });
    expect(agent.lines.join('\n')).toContain('open model triangle.glb (1 kB)');
    await writeFile(join(dir, 'broken.glb'), 'nope');
    await expect(threadReply(agent, key, { model: join(dir, 'broken.glb'), cwd: dir })).rejects.toThrow(/broken\.glb: not a binary glTF/);
  });
});
