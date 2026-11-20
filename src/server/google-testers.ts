/**
 * Testers who signed in with their Google account (google.ts), Android XR's counterpart of testers.ts:
 * one per Google account, with a token per headset, kept in google-testers.json beside the uploads
 * (0600). Each becomes an upload grant `google-<sub>` limited to the configured projects and, unless
 * POLYCAP_GOOGLE_TESTERS maps their address to someone in POLYCAP_USERS, a person of their own. Their
 * address is the one Google verified, so it is set on their person as verified (People), which is what
 * makes them a participant in threads that invited that address (docs/THREADS.md).
 *
 * There is no entitlement to ask again: admission is the invited list, checked on every request, so
 * removing or blocking an address and restarting stops access. Grants are added to the receiver's own
 * lists in place, so a tester can upload the moment they are enrolled.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import type { User } from '../threads.js';
import { GOOGLE_SUB, GoogleTokenError, type GoogleConfig, type GoogleTokens } from './google.js';
import { emailSchema, type People } from './people.js';
import { HttpError } from './respond.js';
import { newToken, teamPeople, type Grant } from './tokens.js';

const MAX_DEVICES = 5;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** A name as Google shows it, or a device's model: no control characters, nothing that could pass for markup. */
const plain = (max: number) => z.string().transform(s => s.replace(/[\p{C}<>]/gu, '').trim()).pipe(z.string().min(1).max(max));

const deviceSchema = z.strictObject({ deviceId: z.string().regex(/^[0-9a-f]{8}$/), label: z.string().max(40), sha256: sha, enrolledAt: z.string() });
const testerSchema = z.strictObject({
  sub: z.string().regex(GOOGLE_SUB),
  email: emailSchema,
  name: z.string().max(60),
  devices: z.array(deviceSchema).max(MAX_DEVICES),
  enrolledAt: z.string(),
  signedInAt: z.string(),
});
const fileSchema = z.strictObject({ version: z.literal(1), testers: z.array(testerSchema) });
type Tester = z.infer<typeof testerSchema>;

/** What the headset sends: Google's ID token, the nonce it asked Google to put in it, and which install this is. */
export const googleEnrollSchema = z.strictObject({
  idToken: z.string().min(20).max(4096),
  nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  deviceId: z.string().regex(/^[0-9a-f]{8}$/),
  label: plain(40).optional(),
});
export type GoogleEnroll = z.infer<typeof googleEnrollSchema>;

export const googleGrantId = (sub: string) => `google-${sub}`;
/** Grant ids starting google- are the receiver's own; POLYCAP_SERVER_TOKENS may not use them. */
export const isGoogleGrant = (grant: Pick<Grant, 'id'>) => grant.id.startsWith('google-');

/** Sign-ins per account and in all, per window; a token is single use however many are allowed. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly max: { all: number; each: number }) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (k: string) => (this.hits.get(k) ?? []).filter(t => now - t < this.windowMs);
    const all = recent('*'), each = recent(key);
    if (all.length >= this.max.all || each.length >= this.max.each) return false;
    this.hits.set('*', [...all, now]); this.hits.set(key, [...each, now]);
    return true;
  }
}

export class GoogleTesters {
  private testers: Tester[] = [];
  private readonly added = { grants: new Set<Grant>(), users: new Set<User>() };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly limiter = new Limiter(10 * 60_000, { all: 30, each: 6 });
  /** Hashes of ID tokens already used, until they would have expired anyway. */
  private readonly used = new Map<string, number>();
  readonly file: string;

  constructor(
    dir: string, readonly google: GoogleConfig, private readonly tokens: Pick<GoogleTokens, 'verify'>,
    /** The receiver's live lists, changed in place. */
    private readonly grants: Grant[], private readonly users: User[],
    private readonly people: Pick<People, 'setVerifiedEmail'>,
    private readonly log: (line: string) => void,
  ) { this.file = join(dir, 'google-testers.json'); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<void> {
    this.testers = await exists(this.file) ? (await readJson(this.file, fileSchema)).testers : [];
    this.apply();
  }

  /** Invited and not blocked, as the settings say now: the whole of admission. */
  private admitted(email: string): boolean {
    return this.google.testers.invited.includes(email) && !this.google.testers.blocked.includes(email);
  }

  get active(): Tester[] { return this.testers.filter(t => t.devices.length && this.admitted(t.email)); }

  /** Checked on every authenticated request. */
  authorized(grant: Grant): boolean {
    return this.active.some(t => googleGrantId(t.sub) === grant.id && t.devices.some(d => d.sha256 === grant.sha256));
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, testers: this.testers });
    this.apply();
  }

  /** Puts every active tester's grants and people in the receiver's lists, replacing what was there before. */
  private apply(): void {
    for (let i = this.grants.length - 1; i >= 0; i--) if (this.added.grants.has(this.grants[i])) this.grants.splice(i, 1);
    for (let i = this.users.length - 1; i >= 0; i--) if (this.added.users.has(this.users[i])) this.users.splice(i, 1);
    this.added.grants.clear(); this.added.users.clear();
    const { projects, maxBytes, people } = this.google.testers;
    // A tester sees only threads they are a member of, unless their person holds one of the team's tokens (tokens.ts).
    const team = teamPeople(this.grants);
    for (const tester of this.active) {
      const known = people[tester.email];
      const user = known ?? googleGrantId(tester.sub);
      if (!known) {
        const person: User = { id: user, name: tester.name || 'Tester' };
        this.users.push(person); this.added.users.add(person);
      }
      for (const device of tester.devices) {
        const grant: Grant = {
          id: googleGrantId(tester.sub), sha256: device.sha256, scopes: ['upload'], label: device.label,
          projects, user, ...(maxBytes ? { maxBytes } : {}), ...(team.has(user) ? { teamPerson: true as const } : {}),
        };
        this.grants.push(grant); this.added.grants.add(grant);
      }
    }
  }

  /** Signs a headset in: Google must vouch for the account, and the settings must invite its address. Returns the token, shown this once. */
  enroll(input: GoogleEnroll, now = Date.now()): Promise<{ token: string; grantId: string; name: string; projects: string[] }> {
    const tokenHash = createHash('sha256').update(input.idToken).digest('hex');
    if (!this.limiter.allow(input.deviceId, now)) return Promise.reject(new HttpError(429, 'too many sign-ins; try again in a few minutes'));
    return this.serial(async () => {
      for (const [hash, until] of this.used) if (until < now) this.used.delete(hash);
      if (this.used.has(tokenHash)) throw new HttpError(403, 'this Google sign-in was already used; sign in again', { reason: 'unverified' });
      let identity;
      try { identity = await this.tokens.verify(input.idToken, input.nonce); }
      catch (error) {
        if (error instanceof GoogleTokenError) throw new HttpError(403, `Google did not confirm this account: ${error.message}`, { reason: 'unverified' });
        this.log(`Google sign-in check failed: ${(error as Error).message}`);
        throw new HttpError(502, 'could not check the account with Google; try again later', { reason: 'google_unavailable' });
      }
      this.used.set(tokenHash, identity.expiresAt + 60_000);
      const grantId = googleGrantId(identity.sub);
      if (this.google.testers.blocked.includes(identity.email)) throw new HttpError(403, 'this Google account is blocked on this receiver', { reason: 'blocked' });
      if (!this.google.testers.invited.includes(identity.email)) {
        // The operator's log names the account so it can be invited; the headset hears only that it is not.
        this.log(`Google sign-in refused for ${grantId}: not in POLYCAP_GOOGLE_TESTERS.invited`);
        throw new HttpError(403, 'this Google account is not invited to the test', { reason: 'not_invited' });
      }
      const stamp = new Date(now).toISOString();
      let tester = this.testers.find(t => t.sub === identity.sub);
      if (!(tester && this.active.includes(tester)) && this.active.length >= this.google.testers.maxTesters) {
        throw new HttpError(403, `this receiver already has its ${this.google.testers.maxTesters} Google testers`, { reason: 'full' });
      }
      const { token, sha256 } = newToken();
      const device = { deviceId: input.deviceId, label: input.label ?? 'Headset', sha256, enrolledAt: stamp };
      if (!tester) {
        tester = { sub: identity.sub, email: identity.email, name: '', devices: [], enrolledAt: stamp, signedInAt: stamp };
        this.testers.push(tester);
      }
      // Google's address for this account can change; the newest verified one is theirs.
      tester.email = identity.email;
      if (identity.name) tester.name = identity.name.replace(/[\p{C}<>]/gu, '').trim().slice(0, 60);
      tester.devices = [...tester.devices.filter(d => d.deviceId !== input.deviceId), device].slice(-MAX_DEVICES);
      tester.signedInAt = stamp;
      await this.save();
      const user = this.google.testers.people[identity.email] ?? grantId;
      await this.people.setVerifiedEmail(user, identity.email);
      this.log(`Google tester ${grantId} signed in on ${device.label} ${input.deviceId}; ${this.active.length} Google tester(s)`);
      const name = this.users.find(u => u.id === user)?.name ?? (tester.name || 'Tester');
      return { token, grantId, name, projects: this.google.testers.projects };
    });
  }
}
