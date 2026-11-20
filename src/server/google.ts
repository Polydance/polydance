/**
 * Google accounts as the way an Android XR tester's headset gets its token (private/docs/PLAY.md), as Meta
 * accounts are on Quest (meta.ts). The Play build asks Credential Manager for a Google ID token naming
 * this receiver's web client and a nonce of its own, and posts it; the receiver checks Google's signature
 * against Google's published keys and the token's issuer, audience, expiry, nonce and verified email.
 * Google proves who someone is, not that they may test: admission is the invited list in
 * POLYCAP_GOOGLE_TESTERS, checked again on every request, with a local blocklist and tester limit. This
 * module owns the settings and the token check; google-testers.ts owns what the receiver keeps.
 *
 * Off unless POLYCAP_GOOGLE_CLIENT_ID and POLYCAP_GOOGLE_TESTERS are both set; one without the other is
 * an error at start-up. There is no secret: an ID token is verified with Google's public keys.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { projectKeySchema, USER_ID } from '../threads.js';
import { emailSchema } from './people.js';

/** Google's subject: digits, short enough that `google-<sub>` is a valid grant and person id (USER_ID). */
export const GOOGLE_SUB = /^\d{1,33}$/;
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SKEW_S = 60;

const testersSchema = z.strictObject({
  /** Where testers' recordings go, the first being where a recording that names no thread starts one. */
  projects: z.array(projectKeySchema).min(1),
  /** Who may sign in, by the address Google verified. Admission is this list; Google only says who someone is. */
  invited: z.array(emailSchema).min(1),
  /** People at once; a new one past this is refused. */
  maxTesters: z.number().int().positive().max(2500).default(25),
  /** Each tester's storage allowance; without it POLYCAP_ALLOWANCE_BYTES applies. */
  maxBytes: z.number().int().positive().optional(),
  /** Local denylist, ahead of the invited list. */
  blocked: z.array(emailSchema).default([]),
  /** An invited address that is someone in POLYCAP_USERS: their recordings and threads are that person's. */
  people: z.record(emailSchema, z.string().regex(USER_ID)).default({}),
});
export type GoogleTesterSettings = z.infer<typeof testersSchema>;

export interface GoogleConfig { clientId: string; certsUrl: string; testers: GoogleTesterSettings }
export interface GoogleEnv { POLYCAP_GOOGLE_CLIENT_ID?: string; POLYCAP_GOOGLE_TESTERS?: string; POLYCAP_GOOGLE_CERTS_URL?: string }

export function parseGoogleConfig(env: GoogleEnv): GoogleConfig | undefined {
  const names = ['POLYCAP_GOOGLE_CLIENT_ID', 'POLYCAP_GOOGLE_TESTERS'] as const;
  const set = names.filter(n => env[n]?.trim());
  if (!set.length) return undefined;
  if (set.length < names.length) throw new UserError(`Google sign-in needs ${names.join(' and ')}; ${names.filter(n => !set.includes(n)).join(', ')} missing`);
  const clientId = env.POLYCAP_GOOGLE_CLIENT_ID!.trim();
  if (!/^\d{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new UserError('POLYCAP_GOOGLE_CLIENT_ID is the web OAuth client ID from Google Cloud (Credentials), ending .apps.googleusercontent.com');
  }
  let json: unknown;
  try { json = JSON.parse(env.POLYCAP_GOOGLE_TESTERS!); } catch { throw new UserError('POLYCAP_GOOGLE_TESTERS is not JSON'); }
  const testers = testersSchema.safeParse(json);
  if (!testers.success) throw new UserError(`POLYCAP_GOOGLE_TESTERS: ${testers.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const certsUrl = env.POLYCAP_GOOGLE_CERTS_URL || CERTS_URL;
  // Tests point this at a stand-in on this machine; anything else must be TLS, since its keys decide who signs in.
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(certsUrl)) throw new UserError(`POLYCAP_GOOGLE_CERTS_URL=${certsUrl} must be https, or http on this machine`);
  return { clientId, certsUrl, testers: testers.data };
}

/** What a valid ID token says, and nothing it merely claims. */
export interface GoogleIdentity { sub: string; email: string; name?: string; expiresAt: number }

export class GoogleTokenError extends Error {}

const b64 = (part: string) => Buffer.from(part, 'base64url');
const headerSchema = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(100) });
const claimsSchema = z.object({
  iss: z.string(), aud: z.string(), sub: z.string().regex(GOOGLE_SUB),
  exp: z.number().int(), iat: z.number().int(),
  email: emailSchema, email_verified: z.literal(true),
  nonce: z.string().optional(), name: z.string().max(200).optional(),
});
const jwksSchema = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string(), alg: z.string().optional(), use: z.string().optional() }).passthrough()) });

/**
 * Checks Google ID tokens against Google's keys, fetched once and kept for as long as Google's
 * Cache-Control says (bounded to 5 minutes to 1 day), and fetched again at most once a minute when a token
 * names a key not seen yet, as happens when Google rotates them.
 */
export class GoogleTokens {
  private keys = new Map<string, KeyObject>();
  private until = 0;
  private lastFetch = 0;

  constructor(private readonly config: Pick<GoogleConfig, 'clientId' | 'certsUrl'>, private readonly fetcher: typeof fetch = fetch, private readonly clock = () => Date.now()) {}

  private async refresh(): Promise<void> {
    this.lastFetch = this.clock();
    let response: Response;
    try { response = await this.fetcher(this.config.certsUrl, { signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new Error(`Google's keys could not be fetched: ${(error as Error).name}`); }
    if (!response.ok) throw new Error(`Google's keys could not be fetched: HTTP ${response.status}`);
    const parsed = jwksSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new Error('Google\'s keys were not the expected JSON');
    const keys = new Map<string, KeyObject>();
    for (const jwk of parsed.data.keys) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try { keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0])); } catch { /* A key Node cannot read is one no token can use. */ }
    }
    if (!keys.size) throw new Error('Google published no usable keys');
    const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 3600);
    this.keys = keys;
    this.until = this.clock() + Math.min(Math.max(maxAge, 300), 86_400) * 1000;
  }

  /** Throws GoogleTokenError for a token that is not valid for this receiver and [nonce]; Error when Google could not be reached. */
  async verify(idToken: string, nonce: string): Promise<GoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new GoogleTokenError('not a JWT');
    let header: z.infer<typeof headerSchema>, claims: z.infer<typeof claimsSchema>;
    try {
      header = headerSchema.parse(JSON.parse(b64(parts[0]).toString('utf8')));
      claims = claimsSchema.parse(JSON.parse(b64(parts[1]).toString('utf8')));
    } catch { throw new GoogleTokenError('the token is not a Google ID token with a verified email'); }
    if (this.clock() >= this.until || (!this.keys.has(header.kid) && this.clock() - this.lastFetch > 60_000)) await this.refresh();
    const key = this.keys.get(header.kid);
    if (!key) throw new GoogleTokenError('the token is signed with a key Google does not publish');
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2]))) throw new GoogleTokenError('the signature does not verify');
    const now = Math.floor(this.clock() / 1000);
    if (!ISSUERS.has(claims.iss)) throw new GoogleTokenError('the token was not issued by Google');
    if (claims.aud !== this.config.clientId) throw new GoogleTokenError('the token is for another app');
    if (claims.exp + SKEW_S < now) throw new GoogleTokenError('the token has expired');
    if (claims.iat - SKEW_S > now) throw new GoogleTokenError('the token was issued in the future');
    if (claims.nonce !== nonce) throw new GoogleTokenError('the token was not made for this sign-in');
    return { sub: claims.sub, email: claims.email, ...(claims.name ? { name: claims.name } : {}), expiresAt: claims.exp * 1000 };
  }
}
