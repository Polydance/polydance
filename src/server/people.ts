/**
 * People on the hosted receiver: who a token's person is (their POLYCAP_USERS entry, Meta testers'
 * people included, else the token itself), the email address each gave for themselves, and who is in a
 * thread for its avatars. Addresses live in people.json beside testers.json (0600). Meta never gives
 * one, so a Quest tester's is what they typed: unverified until they confirm it from the link the receiver
 * emails them (invitations.ts, 2026-11-10). A Google tester's is the one Google verified at sign-in
 * (google-testers.ts). An address the team copies into a thread is emailed an invitation (docs/THREADS.md, People). Addresses are shown only to a thread's members (isMember), never logged and never put in
 * events. One writer at a time, so a promise chain is the lock.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import type { User } from '../threads.js';
import type { Thread } from './threads.js';
import type { Grant } from './tokens.js';

/** An address as typed, trimmed and lowercased: plausible (one @, a dot in the domain, no spaces), never proven. */
export const emailSchema = z.string().trim().toLowerCase().max(254, 'an email address is at most 254 characters')
  .pipe(z.email('not an email address, which looks like name@example.com'));

const entrySchema = z.strictObject({ email: emailSchema, setAt: z.string(), verified: z.boolean() });
/** A person: a user id, or a grant id for a token with none (a signed-in tester's is meta-… or google-…). */
export const PERSON_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** Keyed by person. */
const fileSchema = z.strictObject({ version: z.literal(1), emails: z.record(z.string().regex(PERSON_ID), entrySchema) });
export type EmailEntry = z.infer<typeof entrySchema>;
export type Emails = Record<string, EmailEntry>;

/** A token's person: the user it names, else the token itself. */
export const personId = (grant: Pick<Grant, 'id' | 'user'>) => grant.user ?? grant.id;

/** The avatar's letter: the first letter or digit of the first source that has one, upper case; else "?". */
export function initialOf(...sources: (string | undefined)[]): string {
  for (const source of sources) {
    const letter = source?.match(/[\p{L}\p{N}]/u)?.[0];
    if (letter) return [...letter.toUpperCase()][0];
  }
  return '?';
}

/** The viewer's own address when it has been verified (by Google sign-in), the only kind that makes them a participant. */
export const verifiedEmail = (emails: Emails, grant: Pick<Grant, 'id' | 'user'>) => {
  const entry = emails[personId(grant)];
  return entry?.verified ? entry.email : undefined;
};

export interface PersonView { name: string; initial: string; colour?: string; invited?: true; email?: string }

export class People {
  readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  /** `users` is the receiver's live list, which Meta sign-in adds testers' people to in place. */
  constructor(dir: string, private readonly users: readonly User[]) { this.file = join(dir, 'people.json'); }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  user(id: string): User | undefined { return this.users.find(u => u.id === id); }

  /** A token's person as they read now: their user's name and colour, else the token's label. */
  person(grant: Grant): { id: string; name: string; colour?: string } {
    const user = grant.user ? this.user(grant.user) : undefined;
    return { id: personId(grant), name: user?.name ?? grant.label ?? grant.id, ...(user?.colour ? { colour: user.colour } : {}) };
  }

  /** Read fresh each time: small, and a damaged file is an error rather than nobody's address. */
  async emails(): Promise<Emails> { return await exists(this.file) ? (await readJson(this.file, fileSchema)).emails : {}; }

  /** Sets or (with null) clears a person's own address; a new one is unverified, the same one again keeps what it was. */
  setEmail(id: string, email: string | null): Promise<void> {
    return this.lock(async () => {
      const emails = await this.emails();
      if (email === null && !emails[id]) return;
      // The same address again keeps what it was: a verified one (Google, or a confirmed link) stays verified.
      if (email !== null && emails[id]?.email === email) return;
      if (email === null) delete emails[id];
      else emails[id] = { email, setAt: new Date().toISOString(), verified: false };
      await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, emails }));
    });
  }

  /**
   * A person's address as Google verified it at sign-in (google-testers.ts), or as they confirmed it from the
   * link the receiver emailed (invitations.ts). It replaces what they typed, and makes them a participant in
   * threads that invited it.
   */
  setVerifiedEmail(id: string, email: string): Promise<void> {
    return this.lock(async () => {
      const emails = await this.emails();
      const address = emailSchema.parse(email);
      if (emails[id]?.email === address && emails[id].verified) return;
      emails[id] = { email: address, setAt: new Date().toISOString(), verified: true };
      await writeJsonAtomic(this.file, fileSchema.parse({ version: 1, emails }));
    });
  }

  /**
   * Whether someone other than `person` has this address verified. One verified address is one person's (auth
   * audit, 2026-11-12): otherwise anyone could enter a member's address, and if its owner pressed the link
   * thinking it their own, have every thread that address is invited to.
   */
  async verifiedByOther(person: string, email: string): Promise<boolean> {
    return Object.entries(await this.emails()).some(([id, e]) => id !== person && e.verified && e.email === email);
  }

  /** GET and POST /v1/me: the token, its device, when it expires (null for never) and its person, with their address if they gave one. */
  async me(grant: Grant): Promise<object> {
    const person = this.person(grant);
    const entry = (await this.emails())[person.id];
    return {
      me: grant.id, device: grant.label ?? null, expiresAt: grant.expiresAt ?? null,
      person: { ...person, ...(entry ? { email: entry.email } : {}), emailVerified: entry?.verified ?? false, initial: initialOf(entry?.email, person.name) },
    };
  }

  /** Whether a person id names someone on this receiver: a user (testers' own people included) or a token's own person. */
  knows(id: string, grants: readonly Grant[]): boolean { return Boolean(this.user(id)) || grants.some(g => personId(g) === id); }

  /**
   * Who is in a thread, for its avatars, in order of first appearance: whoever opened it, each message's
   * author (as their person, so an agent posting with someone's token is that someone), the people the
   * team added (members), then the invited participants. Addresses, and initials taken from them, only for
   * a member; others see "Invited".
   */
  inThread(thread: Thread, emails: Emails, member: boolean): PersonView[] {
    const seen = new Set<string>(), addresses = new Set<string>(), out: PersonView[] = [];
    for (const by of [thread.by, ...thread.messages.map(m => m.by)]) {
      const id = by.user?.id ?? by.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const user = by.user ? this.user(by.user.id) : undefined;
      const name = user?.name ?? by.user?.name ?? by.name, colour = user?.colour ?? by.user?.colour;
      const email = emails[id]?.email;
      if (email) addresses.add(email);
      const shown = member ? email : undefined;
      out.push({ name, initial: initialOf(shown, name), ...(colour ? { colour } : {}), ...(shown ? { email: shown } : {}) });
    }
    for (const { person } of thread.members ?? []) {
      if (seen.has(person)) continue;
      seen.add(person);
      const user = this.user(person), name = user?.name ?? 'Member';
      const email = emails[person]?.email;
      if (email) addresses.add(email);
      const shown = member ? email : undefined;
      out.push({ name, initial: initialOf(shown, name), ...(user?.colour ? { colour: user.colour } : {}), ...(shown ? { email: shown } : {}) });
    }
    // Someone invited who has since posted under that address is already listed.
    for (const p of thread.participants ?? []) {
      if (addresses.has(p.email)) continue;
      out.push(member ? { name: p.email, initial: initialOf(p.email), invited: true, email: p.email } : { name: 'Invited', initial: '?', invited: true });
    }
    return out;
  }
}
