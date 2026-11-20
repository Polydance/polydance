/**
 * Testers who signed in with their Meta account (meta.ts): one per Meta user, with a token per headset,
 * kept in testers.json beside the uploads (0600). Each becomes an upload grant `meta-<user id>` limited to
 * the configured (optionally per-account) projects, and, unless POLYCAP_META_TESTERS maps them to someone
 * in POLYCAP_USERS, a person of their own with a cosmetic name, so a message reads "Ana B · Quest 3".
 * Only explicit accounts entries link legacy upload owners; people entries provide attribution, never ownership.
 *
 * The grants and people are added to the receiver's own lists in place (the arrays the routes, the worker
 * and the thread store already hold), so a tester can upload the moment they are enrolled, with no
 * restart. Every hour each tester's entitlement is asked again; one Meta says is no longer entitled
 * loses their tokens. Channel removal alone need not change entitlement: use blockedUsers and restart
 * for reliable local revocation. During Meta outages, grants expire 24 hours after last verification.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import type { User } from '../threads.js';
import { describeRefusal, META_USER_ID, type MetaConfig, type MetaGraph } from './meta.js';
import { HttpError } from './respond.js';
import { newToken, teamPeople, type Grant } from './tokens.js';

const MAX_DEVICES = 5;
/** Hard authorization limit, independent of whether a refresh timer ran on time. */
export const MAX_VERIFIED_AGE_MS = 24 * 60 * 60_000;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** A name as Meta shows it, or a device's model: no control characters, nothing that could pass for markup. */
const plain = (max: number) => z.string().transform(s => s.replace(/[\p{C}<>]/gu, '').trim()).pipe(z.string().min(1).max(max));

const deviceSchema = z.strictObject({ deviceId: z.string().regex(/^[0-9a-f]{8}$/), label: z.string().max(40), sha256: sha, enrolledAt: z.string() });
const testerSchema = z.strictObject({
  metaUserId: z.string().regex(META_USER_ID),
  name: z.string().max(60),
  devices: z.array(deviceSchema).max(MAX_DEVICES),
  enrolledAt: z.string(),
  /** When Meta last said they were entitled. */
  checkedAt: z.string(),
  /** When Meta said they no longer were; their tokens went then. Signing in again with fresh entitlement clears it unless locally blocked. */
  revokedAt: z.string().optional(),
});
const fileSchema = z.strictObject({ version: z.literal(1), testers: z.array(testerSchema) });
type Tester = z.infer<typeof testerSchema>;

/** What the headset sends: who Horizon OS says is signed in, Meta's proof of it, and which install this is. */
export const enrollSchema = z.strictObject({
  userId: z.string().regex(META_USER_ID),
  nonce: z.string().min(1).max(512).regex(/^[A-Za-z0-9._~+/=-]+$/),
  deviceId: z.string().regex(/^[0-9a-f]{8}$/),
  name: plain(60).optional(),
  label: plain(40).optional(),
});
export type Enroll = z.infer<typeof enrollSchema>;

export const testerGrantId = (metaUserId: string) => `meta-${metaUserId}`;
/** Grant ids starting meta- are the receiver's own; POLYCAP_SERVER_TOKENS may not use them. */
export const isTesterGrant = (grant: Pick<Grant, 'id'>) => grant.id.startsWith('meta-');

/** Quota links are symmetric, unlike ownership: legacy tokens never gain access to other owners. */
export function testerQuota(meta: MetaConfig, metaUserId: string): Pick<Grant, 'quotaOwnerIds' | 'quotaMaxBytes'> {
  return {
    quotaOwnerIds: [testerGrantId(metaUserId), ...(meta.testers.accounts[metaUserId]?.legacyGrantIds ?? [])],
    quotaMaxBytes: meta.testers.maxBytes,
  };
}

/** Attempts in a sliding window, overall and per Meta user, so the route cannot be used to hammer Meta. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly limits: { all: number; each: number }) {}
  allow(key: string, now = Date.now()): boolean {
    const fresh = (k: string) => (this.hits.get(k) ?? []).filter(t => now - t < this.windowMs);
    const all = fresh('*'), each = fresh(key);
    if (all.length >= this.limits.all || each.length >= this.limits.each) return false;
    this.hits.set('*', [...all, now]); this.hits.set(key, [...each, now]);
    return true;
  }
}

export class Testers {
  private testers: Tester[] = [];
  private readonly added = { grants: new Set<Grant>(), users: new Set<User>() };
  private queue: Promise<unknown> = Promise.resolve();
  private checking?: Promise<{ checked: number; revoked: string[]; failed: number }>;
  private readonly limiter = new Limiter(10 * 60_000, { all: 30, each: 6 });
  readonly file: string;

  constructor(
    dir: string, readonly meta: MetaConfig, private readonly graph: Pick<MetaGraph, 'validNonce' | 'entitled'>,
    /** The receiver's live lists, changed in place. */
    private readonly grants: Grant[], private readonly users: User[],
    private readonly log: (line: string) => void,
  ) { this.file = join(dir, 'testers.json'); }

  /** One change at a time, so an enrolment and the hourly check never write over each other. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<void> {
    this.testers = await exists(this.file) ? (await readJson(this.file, fileSchema)).testers : [];
    this.apply();
  }

  private blocked(metaUserId: string): boolean { return this.meta.testers.blockedUsers.includes(metaUserId); }

  get active(): Tester[] { return this.testers.filter(t => !t.revokedAt && t.devices.length && !this.blocked(t.metaUserId)); }

  private fresh(tester: Tester, now = Date.now()): boolean {
    const age = now - Date.parse(tester.checkedAt);
    return Number.isFinite(age) && age >= 0 && age < MAX_VERIFIED_AGE_MS;
  }

  /** Checked on every authenticated request, including when the hourly timer is overdue. */
  authorized(grant: Grant, now = Date.now()): boolean {
    return this.active.some(t => testerGrantId(t.metaUserId) === grant.id && this.fresh(t, now)
      && t.devices.some(d => d.sha256 === grant.sha256));
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
    const { projects, maxBytes, people, accounts } = this.meta.testers;
    // A tester sees only threads they are a member of, unless their person holds one of the team's tokens (tokens.ts).
    const team = teamPeople(this.grants);
    for (const tester of this.active.filter(t => this.fresh(t))) {
      const account = accounts[tester.metaUserId];
      const known = account?.user ?? people[tester.metaUserId];
      const user = known ?? testerGrantId(tester.metaUserId);
      if (!known) {
        const person: User = { id: user, name: tester.name || 'Tester' };
        this.users.push(person); this.added.users.add(person);
      }
      // One grant per headset, all with the person's id: their uploads, allowance and threads are one account.
      for (const device of tester.devices) {
        const grant: Grant = {
          id: testerGrantId(tester.metaUserId), sha256: device.sha256, scopes: ['upload'], label: device.label,
          projects: account?.projects ?? projects, user, ...(maxBytes ? { maxBytes } : {}), ...(team.has(user) ? { teamPerson: true as const } : {}),
          ...(account ? { legacyGrantIds: [...account.legacyGrantIds] } : {}),
          ...testerQuota(this.meta, tester.metaUserId),
        };
        this.grants.push(grant); this.added.grants.add(grant);
      }
    }
  }

  /** Signs a headset in: Meta must vouch for the user and their entitlement. Returns the token, shown this once. */
  enroll(input: Enroll): Promise<{ token: string; grantId: string; name: string; projects: string[] }> {
    if (!this.limiter.allow(input.userId)) return Promise.reject(new HttpError(429, 'too many sign-ins; try again in a few minutes'));
    return this.serial(async () => {
      // No Graph call (even nonce validation) may let a locally blocked user back in.
      if (this.blocked(input.userId)) throw new HttpError(403, 'this Meta account is blocked on this receiver', { reason: 'blocked' });
      let valid: boolean, entitled: boolean;
      try {
        valid = await this.graph.validNonce(input.userId, input.nonce);
        entitled = valid && await this.graph.entitled(input.userId);
      } catch (error) {
        // The headset hears only "try again later"; the operator's log says what Meta said.
        this.log(`Meta could not check ${testerGrantId(input.userId)} for sign-in: ${describeRefusal(error)}`);
        throw new HttpError(502, 'could not check the account with Meta; try again later', { reason: 'meta_unavailable' });
      }
      if (!valid) throw new HttpError(403, 'Meta did not confirm this account', { reason: 'unverified' });
      if (!entitled) throw new HttpError(403, 'Meta did not confirm app entitlement for this account', { reason: 'not_invited' });
      const now = new Date().toISOString();
      let tester = this.testers.find(t => t.metaUserId === input.userId);
      const returning = tester && !tester.revokedAt && tester.devices.length;
      if (!returning && this.active.length >= this.meta.testers.maxTesters) {
        throw new HttpError(403, `this receiver already has its ${this.meta.testers.maxTesters} testers`, { reason: 'full' });
      }
      const { token, sha256 } = newToken();
      const device = { deviceId: input.deviceId, label: input.label ?? 'Headset', sha256, enrolledAt: now };
      if (!tester) {
        tester = { metaUserId: input.userId, name: input.name ?? 'Tester', devices: [], enrolledAt: now, checkedAt: now };
        this.testers.push(tester);
      }
      // Signing in again on the same install replaces its token; the oldest headset goes past five.
      tester.devices = [...tester.devices.filter(d => d.deviceId !== input.deviceId), device].slice(-MAX_DEVICES);
      if (input.name) tester.name = input.name;
      tester.checkedAt = now;
      delete tester.revokedAt;
      await this.save();
      const grantId = testerGrantId(input.userId);
      this.log(`tester ${grantId} (${tester.name}) signed in on ${device.label} ${input.deviceId}; ${this.active.length} tester(s)`);
      const account = this.meta.testers.accounts[input.userId];
      const user = account?.user ?? this.meta.testers.people[input.userId];
      // Supplied names are cosmetic, never evidence of identity or continuity.
      const name = this.users.find(u => u.id === user)?.name ?? tester.name;
      return { token, grantId, name, projects: account?.projects ?? this.meta.testers.projects };
    });
  }

  /** Asks Meta about every active tester; anyone no longer entitled loses their tokens. */
  check(): Promise<{ checked: number; revoked: string[]; failed: number }> {
    // Coalesce slow refreshes instead of queuing an unbounded number of hourly checks.
    if (this.checking) return this.checking;
    this.checking = this.serial(async () => {
      const revoked: string[] = [];
      let checked = 0, failed = 0;
      for (const tester of this.active) {
        try {
          const entitled = await this.graph.entitled(tester.metaUserId);
          checked++;
          if (entitled) { tester.checkedAt = new Date().toISOString(); continue; }
          tester.revokedAt = new Date().toISOString();
          tester.devices = [];
          revoked.push(testerGrantId(tester.metaUserId));
          this.log(`tester ${testerGrantId(tester.metaUserId)} (${tester.name}) is no longer entitled; their tokens are revoked`);
        } catch (error) {
          failed++;
          this.log(`tester check for ${testerGrantId(tester.metaUserId)} failed (${describeRefusal(error)}); access expires 24h after last verification`);
        }
      }
      if (checked) await this.save();
      else this.apply(); // Remove expired/blocked grants even when every Meta call failed.
      return { checked, revoked, failed };
    }).finally(() => { this.checking = undefined; });
    return this.checking;
  }
}
