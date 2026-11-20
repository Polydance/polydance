import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { describeRemoteFailure, remote, RemoteError } from '../src/commands/remote.js';

const token = 'polycap_private-token';
const credentials = 'private-user:private-password';
const query = 'private-query-value';
const thread = 'private-thread-id';
const sensitive = `Bearer ${token} https://${credentials}@receiver.invalid/?secret=${query} /private/path ${thread}`;
const config = loadConfig({}, { remoteUrl: `https://${credentials}@receiver.invalid`, remoteToken: token });
const schema = z.object({ ok: z.boolean() });
let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  // Every request, including unexpected ones, is hermetic.
  fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`unexpected fetch ${sensitive}`));
});
afterEach(() => { vi.restoreAllMocks(); });

async function failure(request: Promise<unknown>): Promise<RemoteError> {
  try { await request; } catch (error) {
    expect(error).toBeInstanceOf(RemoteError);
    return error as RemoteError;
  }
  throw new Error('expected receiver failure');
}
function safeDetail(error: RemoteError, expected: string) {
  expect(describeRemoteFailure(error)).toBe(expected);
  // The CLI message deliberately retains context; neither saved detail nor metadata may do so.
  const saved = `${describeRemoteFailure(error)} ${JSON.stringify(error.diagnostic)}`;
  for (const secret of [token, credentials, query, thread, 'receiver.invalid', '/private/path', 'Bearer']) {
    expect(saved).not.toContain(secret);
  }
}

describe('privacy-safe receiver diagnostics', () => {
  it.each([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  ])('retains only allowlisted nested fetch code %s', async code => {
    const cause = Object.assign(new Error(sensitive), { code, hostname: sensitive });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${sensitive}`, { cause }));
    const error = await failure(remote(config).json('GET', '/v1/projects', schema));
    expect(error.status).toBeUndefined();
    expect(error.diagnostic).toEqual({ endpoint: 'GET /v1/projects', kind: 'network', code });
    expect(error.message).toContain(sensitive);
    safeDetail(error, `GET /v1/projects: network ${code}`);
  });

  it.each([
    { code: 'ECONNRESET', name: 'Error', expected: 'ECONNRESET' },
    { code: sensitive, name: 'TimeoutError', expected: 'timeout' },
    { code: 20, name: 'AbortError', expected: 'aborted' },
    { code: sensitive, name: sensitive, expected: undefined },
    { code: 'ENOENT', name: 'Error', expected: undefined },
  ])('sanitizes direct codes and timeout/abort names ($expected)', async ({ code, name, expected }) => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(sensitive), { code, name }));
    const error = await failure(remote(config).json('GET', `/v1/events?after=1&token=${query}`, schema));
    safeDetail(error, `GET /v1/events: network${expected ? ` ${expected}` : ''}`);
    expect(error.diagnostic?.code).toBe(expected);
  });

  it('does not infer a code from sensitive error text or stringify an unknown code', async () => {
    const code = { toString: vi.fn(() => sensitive) };
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`ENOTFOUND ${sensitive}`), { code }));
    const error = await failure(remote(config).json('GET', '/v1/projects', schema));
    safeDetail(error, 'GET /v1/projects: network');
    expect(code.toString).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', `/v1/projects?token=${query}`, 'GET /v1/projects'],
    ['GET', `/v1/events?after=${query}`, 'GET /v1/events'],
    ['GET', `/v1/threads?project=${query}`, 'GET /v1/threads'],
    ['GET', `/v1/threads/${thread}?token=${query}`, 'GET /v1/threads/:thread'],
    ['GET', `/v1/threads/${encodeURIComponent(sensitive)}`, 'GET /v1/threads/:thread'],
    ['PATCH', `/v1/threads/${thread}`, 'PATCH /v1/threads/:thread'],
    ['POST', '/v1/threads', 'POST /v1/threads'],
    ['POST', `/v1/threads/${thread}/messages`, 'POST /v1/threads/:thread/messages'],
    ['POST', `/v1/threads/${thread}/read`, 'POST /v1/threads/:thread/read'],
    ['POST', `/v1/threads/${thread}/reactions`, 'POST /v1/threads/:thread/reactions'],
    ['POST', `/v1/threads/${thread}/state`, 'POST /v1/threads/:thread/state'],
    ['POST', `/v1/threads/${thread}/title`, 'POST /v1/threads/:thread/title'],
    ['GET', `/unknown/${thread}?token=${query}`, 'receiver request'],
    ['GET', `/v1/projects/${thread}`, 'receiver request'],
    ['GET', `https://${credentials}@receiver.invalid/v1/projects?token=${query}`, 'receiver request'],
    [`GET ${sensitive}`, '/v1/projects', 'receiver request'],
    ['DELETE', '/v1/projects', 'receiver request'],
  ])('uses a trusted endpoint template for %s %s', async (method, path, endpoint) => {
    const error = await failure(remote(config).json(method, path, schema));
    expect(error.diagnostic?.endpoint).toBe(endpoint);
    safeDetail(error, `${endpoint}: network`);
  });

  it.each([401, 403, 404, 429, 500, 503])('reports HTTP %s without receiver error/body text', async status => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: sensitive }), { status }));
    const error = await failure(remote(config).json('GET', `/v1/events?token=${query}`, schema));
    expect(error.status).toBe(status);
    expect(error.diagnostic).toEqual({ endpoint: 'GET /v1/events', kind: 'http' });
    expect(error.message).toBe(`GET /v1/events: ${status} ${sensitive}`);
    safeDetail(error, `GET /v1/events: HTTP ${status}`);
  });

  it('does not save non-JSON HTTP body text', async () => {
    fetchMock.mockResolvedValueOnce(new Response(sensitive, { status: 502 }));
    const error = await failure(remote(config).json('GET', '/v1/projects', schema));
    safeDetail(error, 'GET /v1/projects: HTTP 502');
  });

  it('classifies malformed schema responses without saving payload, issues, or thread IDs', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, secret: sensitive })));
    const privateSchema = schema.refine(value => value.ok, { message: sensitive });
    const error = await failure(remote(config).json('GET', `/v1/threads/${thread}`, privateSchema));
    expect(error.status).toBe(200);
    expect(error.diagnostic?.kind).toBe('response');
    expect(error.message).toContain(sensitive);
    safeDetail(error, 'GET /v1/threads/:thread: invalid response');
  });

  it('rejects invalid JSON even for a permissive schema', async () => {
    fetchMock.mockResolvedValueOnce(new Response(sensitive));
    const error = await failure(remote(config).json('GET', '/v1/projects', z.unknown()));
    safeDetail(error, 'GET /v1/projects: invalid response');
  });

  it.each([200, 401, 503])('classifies an interrupted %s body as retryable network failure', async status => {
    const response = new Response('', { status });
    vi.spyOn(response, 'text').mockRejectedValueOnce(new TypeError(sensitive, {
      cause: Object.assign(new Error(sensitive), { code: 'ECONNRESET' }),
    }));
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(new Response('{"ok":true}'));
    const server = remote(config);
    const error = await failure(server.json('GET', `/v1/events?after=${query}`, schema));
    // Existing callers retry no-status RemoteErrors. Receiving headers alone must not change this.
    expect(error.status).toBeUndefined();
    safeDetail(error, 'GET /v1/events: network ECONNRESET');
    expect(await server.json('GET', `/v1/events?after=${query}`, schema)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves successful schema parsing and authenticated request behavior', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true,"extra":"ignored"}'));
    expect(await remote(config).json('POST', '/v1/threads', schema, { text: 'hello' })).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${config.remoteUrl}/v1/threads`, expect.objectContaining({
      method: 'POST', redirect: 'error', body: '{"text":"hello"}',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }));
  });

  it('keeps the legacy constructor and reports only validated legacy HTTP statuses', () => {
    expect(new RemoteError(sensitive).message).toBe(sensitive);
    safeDetail(new RemoteError(sensitive, 401), 'HTTP 401');
    for (const status of [undefined, 0, 99, 600, 401.5, NaN, Infinity, sensitive as unknown as number]) {
      safeDetail(new RemoteError(sensitive, status), 'local configuration or receiver error');
    }
  });

  it('revalidates public metadata rather than trusting a caller-supplied endpoint or code', () => {
    expect(describeRemoteFailure(new RemoteError(sensitive, undefined, { endpoint: sensitive, kind: 'network', code: sensitive }))).toBe('receiver request: network');
  });

  it('never reports arbitrary exception messages, paths, codes, or status properties', () => {
    for (const error of [undefined, null, sensitive, new Error(sensitive), { message: sensitive, status: 401, code: sensitive },
      Object.assign(new Error(sensitive), { code: 'EACCES', path: sensitive })]) {
      expect(describeRemoteFailure(error)).toBe('local configuration or receiver error');
    }
  });
});
