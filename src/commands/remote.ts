/**
 * JSON calls to the hosted receiver with this machine's token (POLYCAP_REMOTE_URL, POLYCAP_REMOTE_TOKEN);
 * a body of bytes (a 3D model) goes as it is, with a JSON answer.
 * Answers are read through a schema, so a surprise from the server is an error with its message, not a
 * guess. A failure says whether the receiver answered (status) or could not be reached (no status), so a
 * watcher can wait out a dropped connection and still stop on a refused token. sync and video stream
 * files and keep their own fetch. Human messages may contain receiver data; durable diagnostics must
 * use describeRemoteFailure instead.
 */
import type { z } from 'zod';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';

export interface RemoteDiagnostic {
  endpoint: string;
  kind: 'network' | 'http' | 'response';
  code?: string;
}

export class RemoteError extends UserError {
  constructor(message: string, readonly status?: number, readonly diagnostic?: RemoteDiagnostic) {
    super(message); this.name = 'RemoteError';
  }
}

// Only these literals may appear in saved diagnostics. Never interpolate a method, ID, or URL.
const routes: ReadonlyArray<readonly [string, RegExp, string]> = [
  ['GET', /^\/v1\/projects$/, 'GET /v1/projects'],
  ['GET', /^\/v1\/events$/, 'GET /v1/events'],
  ['GET', /^\/v1\/threads$/, 'GET /v1/threads'],
  ['POST', /^\/v1\/threads$/, 'POST /v1/threads'],
  ['GET', /^\/v1\/threads\/[^/]+$/, 'GET /v1/threads/:thread'],
  ['PATCH', /^\/v1\/threads\/[^/]+$/, 'PATCH /v1/threads/:thread'],
  ['POST', /^\/v1\/threads\/[^/]+\/messages$/, 'POST /v1/threads/:thread/messages'],
  ['POST', /^\/v1\/threads\/[^/]+\/read$/, 'POST /v1/threads/:thread/read'],
  ['POST', /^\/v1\/threads\/[^/]+\/reactions$/, 'POST /v1/threads/:thread/reactions'],
  ['POST', /^\/v1\/threads\/[^/]+\/members$/, 'POST /v1/threads/:thread/members'],
  ['POST', /^\/v1\/threads\/[^/]+\/state$/, 'POST /v1/threads/:thread/state'],
  ['POST', /^\/v1\/threads\/[^/]+\/title$/, 'POST /v1/threads/:thread/title'],
  ['PUT', /^\/v1\/projects\/[^/]+\/models\/[^/]+$/, 'PUT /v1/projects/:project/models/:model'],
  ['POST', /^\/v1\/projects\/[^/]+\/photos$/, 'POST /v1/projects/:project/photos'],
  ['POST', /^\/v1\/threads\/[^/]+\/photos$/, 'POST /v1/threads/:thread/photos'],
  ['GET', /^\/v1\/threads\/[^/]+\/photos\/[^/]+$/, 'GET /v1/threads/:thread/photos/:photo'],
];
const endpoints = new Set(routes.map(([, , endpoint]) => endpoint));
const networkCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);
const safeNetworkCodes = new Set([...networkCodes, 'timeout', 'aborted']);
const fallback = 'local configuration or receiver error';

function field(value: unknown, key: string): unknown {
  // Error objects can come from libraries or mocks, including objects with throwing accessors.
  try { return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

function networkCode(error: unknown): string | undefined {
  const cause = field(error, 'cause');
  for (const value of [error, cause]) {
    const code = field(value, 'code');
    if (typeof code === 'string' && networkCodes.has(code)) return code;
  }
  for (const value of [error, cause]) {
    const name = field(value, 'name');
    if (name === 'TimeoutError') return 'timeout';
    if (name === 'AbortError') return 'aborted';
  }
  return undefined;
}

function httpStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
}

/** Safe for saved errors/logs: never uses an error message, response body, or raw request data. */
export function describeRemoteFailure(error: unknown): string {
  if (!(error instanceof RemoteError)) return fallback;
  const diagnostic = error.diagnostic;
  if (!diagnostic) return httpStatus(error.status) ? `HTTP ${error.status}` : fallback;
  const endpoint = endpoints.has(diagnostic.endpoint) ? diagnostic.endpoint : 'receiver request';
  switch (diagnostic.kind) {
    case 'network':
      return `${endpoint}: network${typeof diagnostic.code === 'string' && safeNetworkCodes.has(diagnostic.code) ? ` ${diagnostic.code}` : ''}`;
    case 'http':
      return httpStatus(error.status) ? `${endpoint}: HTTP ${error.status}` : fallback;
    case 'response':
      return `${endpoint}: invalid response`;
    default:
      return fallback;
  }
}

export interface Remote {
  url: string;
  /** A JSON answer; a byte body goes as `contentType`, application/octet-stream unless it says otherwise. */
  json<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, timeoutMs?: number, contentType?: string): Promise<T>;
  /** A file's bytes, refused past `maxBytes`: a photo fetched through its thread. */
  bytes(path: string, maxBytes: number, timeoutMs?: number): Promise<Buffer>;
}

export function remote(config: Config): Remote {
  const { remoteUrl, remoteToken } = config;
  if (!remoteUrl || !remoteToken) throw new UserError('Set POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN in ~/.config/polycap/env to use threads');
  return {
    url: remoteUrl,
    async json(method, path, schema, body, timeoutMs = 60_000, contentType) {
      const routePath = path.split(/[?#]/)[0];
      const endpoint = routes.find(([verb, pattern]) => method === verb && pattern.test(routePath))?.[2] ?? 'receiver request';
      const where = `${method} ${path.split('?')[0]}`;
      let response: Response;
      let text: string;
      try {
        response = await fetch(`${remoteUrl}${path}`, {
          method, redirect: 'error', body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${remoteToken}`, ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? contentType ?? 'application/octet-stream' : 'application/json' }) },
        });
        // A dropped response body is still a transport failure, not an HTTP/schema rejection.
        text = await response.text();
      } catch (error) {
        const code = networkCode(error);
        throw new RemoteError(`${where}: could not reach ${remoteUrl} (${error instanceof Error ? error.message : String(error)})`, undefined,
          { endpoint, kind: 'network', ...(code ? { code } : {}) });
      }
      let json: unknown;
      let invalidJson = false;
      try { json = JSON.parse(text); } catch { invalidJson = true; }
      if (!response.ok) {
        const said = typeof json === 'object' && json && 'error' in json ? String((json as { error: unknown }).error) : text.slice(0, 200);
        throw new RemoteError(`${where}: ${response.status} ${said}`, response.status, { endpoint, kind: 'http' });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success || invalidJson) {
        const detail = !parsed.success ? parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : 'invalid JSON';
        throw new RemoteError(`${where} answered in a shape this polycap does not know: ${detail}`, response.status, { endpoint, kind: 'response' });
      }
      return parsed.data;
    },
    async bytes(path, maxBytes, timeoutMs = 120_000) {
      const routePath = path.split(/[?#]/)[0];
      const endpoint = routes.find(([verb, pattern]) => verb === 'GET' && pattern.test(routePath))?.[2] ?? 'receiver request';
      const where = `GET ${routePath}`;
      let response: Response;
      let data: Buffer;
      try {
        response = await fetch(`${remoteUrl}${path}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${remoteToken}` } });
        if (!response.ok) {
          const text = await response.text();
          let said = text.slice(0, 200);
          try { const json = JSON.parse(text) as { error?: unknown }; if (json.error) said = String(json.error); } catch { /* not JSON */ }
          throw new RemoteError(`${where}: ${response.status} ${said}`, response.status, { endpoint, kind: 'http' });
        }
        const declared = Number(response.headers.get('content-length'));
        if (declared > maxBytes) throw new RemoteError(`${where}: ${declared} bytes is more than the ${maxBytes} expected`, response.status, { endpoint, kind: 'response' });
        data = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof RemoteError) throw error;
        const code = networkCode(error);
        throw new RemoteError(`${where}: could not reach ${remoteUrl} (${error instanceof Error ? error.message : String(error)})`, undefined,
          { endpoint, kind: 'network', ...(code ? { code } : {}) });
      }
      if (data.length > maxBytes) throw new RemoteError(`${where}: ${data.length} bytes is more than the ${maxBytes} expected`, response.status, { endpoint, kind: 'response' });
      return data;
    },
  };
}
