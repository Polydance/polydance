/**
 * What the receiver's routes share: errors that carry a status, JSON in and out, scope checks, and the
 * view of an upload with its bundle's progress and label. Apart from the routes so the upload routes
 * (http.ts) and the thread routes (thread-routes.ts) both use them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Config } from '../config.js';
import { loadSession, sessionDir, STEP_NAMES, type SessionManifest } from '../session.js';
import type { Agents } from './agents.js';
import type { GoogleTesters } from './google-testers.js';
import type { Invitations } from './invitations.js';
import type { Join } from './join.js';
import type { People } from './people.js';
import type { Testers } from './testers.js';
import type { ThreadStore } from './threads.js';
import type { Grant, Scope } from './tokens.js';
import type { UploadRecord, UploadStore } from './uploads.js';
import type { Welcome } from './welcome.js';
import type { Worker } from './worker.js';

const MAX_JSON = 64 * 1024;

export class HttpError extends Error { constructor(readonly status: number, message: string, readonly extra: object = {}) { super(message); } }

export interface ServerDeps {
  config: Config; grants: Grant[]; store: UploadStore; worker: Worker; threads: ThreadStore; log: (line: string) => void;
  /** Who each token's person is, and the address they gave (people.ts). */
  people: People;
  /** Meta sign-in for store testers, when it is set up (testers.ts). */
  testers?: Testers;
  /** Google sign-in for Android XR testers, when it is set up (google-testers.ts). */
  googleTesters?: GoogleTesters;
  /** Agents people connected themselves with a code from their headset (agents.ts); off when threads are. */
  agents?: Agents;
  /** The email address the privacy notice gives (POLYCAP_PRIVACY_CONTACT). */
  privacyContact?: string;
  /** Opens a newcomer's Welcome thread when they sign in (welcome.ts, POLYCAP_WELCOME); off when unset. */
  welcome?: Welcome;
  /** Emails invitations and address confirmations (invitations.ts, POLYCAP_MAIL); off when unset. */
  invitations?: Invitations;
  /** Takes requests to join from the homepage's form and emails the team (join.ts, POLYCAP_JOIN); off when unset. */
  join?: Join;
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'body is not JSON'); }
}

/** A request body through its schema: a 400 naming each bad field, never echoing its value. */
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

export function need(grant: Grant | undefined, ...scopes: Scope[]): Grant {
  if (!grant) throw new HttpError(401, 'missing or unknown token');
  if (!scopes.some(s => grant.scopes.includes(s))) throw new HttpError(403, `token lacks scope ${scopes.join(' or ')}`);
  return grant;
}

/**
 * An upload's view plus how far its bundle's pipeline has got (steps done of total, for the headset's
 * transfer bar), its length, and the bundle's title and summary once there are some, so recordings can
 * be told apart.
 */
export async function describeUpload(deps: Pick<ServerDeps, 'config' | 'store'>, record: UploadRecord): Promise<Record<string, unknown>> {
  const view = { ...await deps.store.view(record), ...(record.recordedAt ? { recordedAt: record.recordedAt } : {}) };
  const total = STEP_NAMES.length;
  if (record.status === 'received' && !record.sessionId) return { ...view, steps: { done: 0, total } };
  const manifest = await bundleOf(deps, record);
  if (!manifest) return { ...view };
  const done = STEP_NAMES.filter(name => manifest.steps[name].status !== 'pending').length;
  return {
    ...view, steps: { done, total },
    ...(manifest.media.durationMs !== undefined ? { durationMs: manifest.media.durationMs } : {}),
    ...(manifest.summary ? { title: manifest.summary.title, summary: manifest.summary.text } : {}),
  };
}

/** A live upload's bundle manifest, for showing its label and progress; none while there is no readable one. */
export async function bundleOf(deps: Pick<ServerDeps, 'config'>, record: UploadRecord): Promise<SessionManifest | undefined> {
  if (!record.sessionId || record.status === 'deleted') return undefined;
  return loadSession(sessionDir(deps.config, record.sessionId)).catch(() => undefined);
}
