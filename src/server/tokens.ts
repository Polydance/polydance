/**
 * Bearer tokens for the hosted receiver. A token is shown once when made; the server only ever holds
 * its sha256, in POLYCAP_SERVER_TOKENS, so removing an entry revokes it on the next request. Scopes:
 * `upload` (a headset: recordings, their status, reactions, reading its threads), `read` (polycap sync
 * listing and downloading bundles, reading threads) and `post` (the team: opening threads and posting
 * messages with launches). `projects` limits which projects' threads a token sees at all. Copied in
 * shape from Polydance's agent grants.
 *
 * Thread-scoped grants (2026-10-21) see only the threads their person is a member of, as email works: a
 * token made with `"threads": "member"` (a tester's own agent, or a headset token handed to someone outside
 * the team), and every Meta or Google tester whose person holds none of the team's tokens. Whatever its
 * scopes, such a grant is never the team's: no reports, no library-wide `read`, no membership of every thread.
 *
 * A token may expire (2026-11-12, `expiresAt`): from then on it is refused with a 401 that says so, as GitHub and
 * GitLab tokens are. `polycap token new` gives one 90 days unless told otherwise; a grant without it never expires.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../errors.js';
import { projectKeySchema, USER_ID } from '../threads.js';

export const SCOPES = ['upload', 'read', 'post'] as const;
export type Scope = typeof SCOPES[number];

const grantSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(z.enum(SCOPES)).min(1),
  label: z.string().max(80).optional(),
  /** Storage allowance for this grant's recordings; without it the server default applies. */
  maxBytes: z.number().int().positive().optional(),
  /** The projects whose threads this token sees, the first being where its new recordings go; without it, all. */
  projects: z.array(projectKeySchema).min(1).optional(),
  /** The person this token belongs to (POLYCAP_USERS); its label then names only the device or agent's machine, "Quest 3". */
  user: z.string().regex(USER_ID).optional(),
  /** Thread-scoped: sees, records into and syncs only threads its person is a member of; needs `user`. */
  threads: z.literal('member').optional(),
  /** When the token stops working (2026-11-12); without it, never. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).refine(grant => !grant.threads || grant.user, { message: 'a thread-scoped token ("threads": "member") names its person in user', path: ['threads'] });
export type Grant = z.infer<typeof grantSchema> & {
  /** Internal only: a signed-in tester whose person holds one of the team's tokens, so their headset is not thread-scoped. */
  teamPerson?: true;
  /** Internal only: validated Meta account links, never accepted in POLYCAP_SERVER_TOKENS. */
  legacyGrantIds?: readonly string[];
  /** Internal only: canonical quota owners, NOT read/delete aliases; never accepted from env. */
  quotaOwnerIds?: readonly string[];
  /** Canonical allowance for quotaOwnerIds; absent means the server default, not a legacy maxBytes. */
  quotaMaxBytes?: number;
  /**
   * Internal only: issued by the receiver to an agent its person connected from one of their devices (agents.ts,
   * 2026-11-20). Always thread-scoped, with no team project, and it counts only while that person has a token of
   * their own that counts. Never accepted in POLYCAP_SERVER_TOKENS.
   */
  issued?: true;
};

/** Ids the receiver gives the agent tokens it issues (agents.ts); POLYCAP_SERVER_TOKENS may not use them. */
export const ISSUED_ID = /^paired-[0-9a-f]{8}$/;
export const isIssuedId = (id: string) => id.startsWith('paired-');

/** Ownership is grant identity, not user attribution; only explicit account links add aliases. */
export const ownsUpload = (grant: Grant, ownerId: string): boolean =>
  grant.id === ownerId || (grant.legacyGrantIds?.includes(ownerId) ?? false);

/** Whether a token has passed its expiry: refused from that moment, never a moment later. */
export const expired = (grant: Pick<Grant, 'expiresAt'>, now = Date.now()): boolean =>
  grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now;

/** Testers who sign in (testers.ts, google-testers.ts) get grant ids with these prefixes, which POLYCAP_SERVER_TOKENS may not use. */
const SIGNED_IN = /^(meta|google)-/;

/** Sees only the threads its person is a member of (2026-10-21): fails closed for a signed-in tester unless their person is the team's. */
export const memberScoped = (grant: Pick<Grant, 'id' | 'threads' | 'teamPerson'>): boolean =>
  grant.threads === 'member' || (SIGNED_IN.test(grant.id) && !grant.teamPerson);

/**
 * The team (2026-10-12): a token that reads bundles or posts, and is not thread-scoped. It sees reports, every
 * thread in its projects as a member, and with `read` the whole library. A headset's upload-only token is not.
 */
export const isTeam = (grant: Pick<Grant, 'id' | 'scopes' | 'threads' | 'teamPerson'>): boolean =>
  (grant.scopes.includes('read') || grant.scopes.includes('post')) && !memberScoped(grant);

/** The people who hold one of the team's tokens: their signed-in headsets see as the team's own headsets do. */
export const teamPeople = (grants: readonly Grant[]): Set<string> => new Set(grants.flatMap(g => g.user && isTeam(g) ? [g.user] : []));

/** New tokens start polycap_; tokens made before the rename to Polydance Capture (2026-10-02) start hib_ and keep working. */
export const TOKEN_PATTERN = /^(polycap|hib)_[0-9a-f]{64}$/;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Fails closed: a malformed list is an error at start-up, never an empty list that lets nobody in silently. */
export function parseGrants(raw: string | undefined): Grant[] {
  if (!raw?.trim()) throw new UserError('POLYCAP_SERVER_TOKENS is empty; make a token with `polycap token new` and add its line');
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new UserError('POLYCAP_SERVER_TOKENS is not JSON'); }
  const parsed = z.array(grantSchema).min(1).safeParse(json);
  if (!parsed.success) throw new UserError(`POLYCAP_SERVER_TOKENS: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const grants = parsed.data;
  const ids = new Set(grants.map(g => g.id));
  if (ids.size !== grants.length) throw new UserError('POLYCAP_SERVER_TOKENS has duplicate ids');
  return grants;
}

export function newToken(): { token: string; sha256: string } {
  const token = `polycap_${randomBytes(32).toString('hex')}`;
  return { token, sha256: hashToken(token) };
}

/** Compares against every grant without an early exit, so timing does not reveal which entry nearly matched. */
export function authenticate(header: string | undefined, grants: Grant[]): Grant | undefined {
  const match = header?.match(/^Bearer (\S+)$/);
  if (!match || !TOKEN_PATTERN.test(match[1])) return undefined;
  const presented = Buffer.from(hashToken(match[1]), 'hex');
  let found: Grant | undefined;
  for (const grant of grants) {
    if (timingSafeEqual(presented, Buffer.from(grant.sha256, 'hex')) && !found) found = grant;
  }
  return found;
}
