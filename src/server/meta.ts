/**
 * Meta accounts as the way a tester's headset gets its token (private/docs/STORE.md). The store build of
 * Polydance's headset app asks Horizon OS for the signed-in Meta user and a one-time proof, and posts both to
 * the receiver; the receiver asks Meta whether the proof belongs to that user and whether that user is
 * entitled to the app. Entitlement is NOT proof of current release-channel membership. This is a
 * private-beta-only admission model: keep distribution private and explicitly block removed testers
 * locally, then restart the receiver. Channel removal alone does not guarantee revocation. This module
 * owns the settings and the two server-to-server calls; testers.ts owns what the receiver keeps.
 *
 * Off unless POLYCAP_META_APP_ID, POLYCAP_META_APP_SECRET and POLYCAP_META_TESTERS are all set; some but
 * not all of them is an error at start-up. The secret is only ever sent to Meta, in a POST body.
 */
import { z } from 'zod';
import { UserError } from '../errors.js';
import { projectKeySchema, USER_ID } from '../threads.js';

export const META_USER_ID = /^\d{1,20}$/;

const testersSchema = z.strictObject({
  /** Where testers' recordings go, the first being where a recording that names no thread starts one. */
  projects: z.array(projectKeySchema).min(1),
  /** People at once; a new one past this is refused, so a store page made public by mistake cannot fill the disk. */
  maxTesters: z.number().int().positive().max(2500).default(25),
  /** Each tester's storage allowance; without it POLYCAP_ALLOWANCE_BYTES applies. */
  maxBytes: z.number().int().positive().optional(),
  /** Local denylist, independent of Meta entitlement; takes effect on receiver restart. */
  blockedUsers: z.array(z.string().regex(META_USER_ID)).default([]),
  /** Explicit continuity, keyed only by Meta's verified app-scoped user id, never a display name. */
  accounts: z.record(z.string().regex(META_USER_ID), z.strictObject({
    user: z.string().regex(USER_ID),
    projects: z.array(projectKeySchema).min(1),
    legacyGrantIds: z.array(z.string().regex(USER_ID)),
  })).default({}),
  /** Attribution only: this does not confer ownership of that person's other grants or recordings. */
  people: z.record(z.string().regex(META_USER_ID), z.string().regex(USER_ID)).default({}),
});
export type TesterSettings = z.infer<typeof testersSchema>;

export interface MetaConfig { appId: string; appSecret: string; graphUrl: string; testers: TesterSettings }

export interface MetaEnv {
  POLYCAP_META_APP_ID?: string; POLYCAP_META_APP_SECRET?: string; POLYCAP_META_TESTERS?: string; POLYCAP_META_GRAPH_URL?: string;
}

export function parseMetaConfig(env: MetaEnv): MetaConfig | undefined {
  const names = ['POLYCAP_META_APP_ID', 'POLYCAP_META_APP_SECRET', 'POLYCAP_META_TESTERS'] as const;
  const set = names.filter(n => env[n]?.trim());
  if (!set.length) return undefined;
  if (set.length < names.length) throw new UserError(`Meta sign-in needs ${names.join(', ')}; ${names.filter(n => !set.includes(n)).join(', ')} missing`);
  const appId = env.POLYCAP_META_APP_ID!.trim();
  if (!/^\d{5,20}$/.test(appId)) throw new UserError('POLYCAP_META_APP_ID is the app\'s number from the Developer Dashboard (Development → API)');
  const appSecret = env.POLYCAP_META_APP_SECRET!.trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(appSecret)) throw new UserError('POLYCAP_META_APP_SECRET does not look like an app secret (Development → API, App Secret)');
  let json: unknown;
  try { json = JSON.parse(env.POLYCAP_META_TESTERS!); } catch { throw new UserError('POLYCAP_META_TESTERS is not JSON'); }
  const testers = testersSchema.safeParse(json);
  if (!testers.success) throw new UserError(`POLYCAP_META_TESTERS: ${testers.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const graphUrl = (env.POLYCAP_META_GRAPH_URL || 'https://graph.oculus.com').replace(/\/+$/, '');
  // Tests point this at a stand-in on this machine; anything else must be TLS, since the secret goes with every call.
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(graphUrl)) throw new UserError(`POLYCAP_META_GRAPH_URL=${graphUrl} must be https, or http on this machine`);
  return { appId, appSecret, graphUrl, testers: testers.data };
}

/**
 * What Meta said when it refused, safe to log: the HTTP status, Meta's numbers and its error type, never its
 * message, which can echo IDs. On 2026-10-12 and 13 a bare 502 hid Meta's 403 code 10, subcode 1891537 for
 * hours: verify_entitlement needs the Data Use Checkup's In-app purchases feature (private/docs/STORE.md).
 */
export interface MetaRefusal { status?: number; code?: number; subcode?: number; type?: string }

/** Meta could not be asked, or answered with something other than a yes or no. Never a reason to let someone in. */
export class MetaError extends Error { constructor(message: string, readonly refusal: MetaRefusal = {}) { super(message); } }

/** Plain words for the refusals met so far; anything else is just its numbers. */
const HINTS: Record<number, string> = {
  2: 'Meta service error, said to be transient',
  10: 'a platform feature this call needs is missing from the app\'s Data Use Checkup (verify_entitlement: In-app purchases)',
  100: 'Meta refused a parameter (user id or nonce)',
  190: 'Meta refused the app credentials (POLYCAP_META_APP_ID / POLYCAP_META_APP_SECRET)',
};

/** "status 403, code 10, subcode 1891537, OCApiException: …" for the receiver's log; never Meta's own message. */
export function describeRefusal(error: unknown): string {
  if (!(error instanceof MetaError)) return 'request failed';
  const r = error.refusal;
  const parts = [r.status !== undefined ? `status ${r.status}` : 'no answer', r.code !== undefined ? `code ${r.code}` : '', r.subcode !== undefined ? `subcode ${r.subcode}` : '', r.type ?? ''].filter(Boolean);
  const hint = r.code !== undefined ? HINTS[r.code] : undefined;
  return `${parts.join(', ')}${hint ? `: ${hint}` : ''}`;
}

const refusalSchema = z.object({ error: z.object({
  code: z.number().int().optional(), error_subcode: z.number().int().optional(), type: z.string().regex(/^[A-Za-z]{1,40}$/).optional(),
}) });

/** The two calls the receiver makes, with the app's own credentials (OC|app id|secret). */
export class MetaGraph {
  constructor(private readonly meta: MetaConfig, private readonly timeoutMs = 10_000) {}

  private async post(path: string, form: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams({ access_token: `OC|${this.meta.appId}|${this.meta.appSecret}`, ...form });
    // Never expose upstream bodies, URLs, transport errors or causes: they can echo credentials/nonces. A
    // refusal keeps only its status, numbers and type (MetaRefusal).
    let res: Response;
    try {
      res = await fetch(`${this.meta.graphUrl}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new MetaError('Meta request failed');
    }
    if (!res.ok) {
      const refusal = refusalSchema.safeParse(await res.json().catch(() => undefined));
      const e = refusal.success ? refusal.data.error : {};
      throw new MetaError('Meta request failed', { status: res.status, code: e.code, subcode: e.error_subcode, type: e.type });
    }
    try { return await res.json(); } catch { throw new MetaError('Meta request failed', { status: res.status }); }
  }

  /** Whether the nonce from the headset's getUserProof was made for this user, in this app. */
  async validNonce(userId: string, nonce: string): Promise<boolean> {
    const answer = z.object({ is_valid: z.boolean() }).safeParse(await this.post('/user_nonce_validate', { nonce, user_id: userId }));
    if (!answer.success) throw new MetaError('Meta\'s user_nonce_validate answered without is_valid');
    return answer.data.is_valid;
  }

  /** Whether Meta says this user is entitled to the app; not a current channel-membership check. */
  async entitled(userId: string): Promise<boolean> {
    const answer = z.object({ success: z.boolean() }).safeParse(await this.post(`/${this.meta.appId}/verify_entitlement`, { user_id: userId }));
    if (!answer.success) throw new MetaError('Meta\'s verify_entitlement answered without success');
    return answer.data.success;
  }
}
