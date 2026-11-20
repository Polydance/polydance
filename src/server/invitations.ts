/**
 * Inviting by email (Robin, 2026-11-10): a second way in. When someone on the team copies an address into a
 * thread, that address gets one email for that thread: who added them, the thread's title, and how to take part.
 * Nothing from the thread's messages or recordings is emailed. A newcomer then enters the address in the
 * headset's account sheet (POST /v1/me); the receiver emails them a link, and confirming it verifies the
 * address, which makes every thread that invited it theirs (isMember, threads.ts).
 *
 * Everything is kept in mail.json beside people.json (0600): the outbox (each email, queued, sent, failed or
 * skipped, with why), the confirmation tokens (stored as sha256, single use, 48 hours), and the addresses that
 * asked to stop (as sha256, so a stopped address is not kept in the clear). A stop link is the address's hash
 * with an HMAC under a secret made here, so every email carries one without a token per email.
 *
 * Sending is one at a time, in the background. Limits count from the outbox, so a restart does not reset them.
 * A failed email is not retried by itself; the team retries it explicitly (resend). On start-up, an email that
 * was queued and never tried is sent.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import { MailError, type Mailer } from './mail.js';
import { emailSchema, PERSON_ID } from './people.js';

const DAY = 24 * 3600_000, HOUR = 3600_000;
/** Emails to one address a day, confirmations for one person a day, and all emails an hour. */
export const LIMITS = { perAddressPerDay: 5, confirmationsPerPersonPerDay: 3, perHour: 100 };
const TOKEN_MS = 48 * HOUR;
/** How long the outbox keeps a finished email: long enough to show a thread what happened, and for the limits. */
const KEEP_MS = 90 * DAY;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));

const entrySchema = z.strictObject({
  id: z.string().regex(/^m_[0-9a-f]{16}$/), kind: z.enum(['invite', 'confirm']), to: emailSchema,
  /** For an invitation: the thread, its title and project as they were, and who added the address. */
  thread: z.string().optional(), title: z.string().optional(), project: z.string().optional(), by: z.string().optional(),
  /** For a confirmation: whose address it is. */
  person: z.string().regex(PERSON_ID).optional(),
  /** The address is already someone's verified one: the invitation says the thread is in their inbox. */
  known: z.boolean().optional(),
  at: z.string(), status: z.enum(['queued', 'sent', 'failed', 'skipped']), reason: z.string().max(300).optional(),
  messageId: z.string().max(200).optional(), sentAt: z.string().optional(),
  /** A confirmation's link token, kept only until its email is sent; the token list keeps its hash alone. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
type Entry = z.infer<typeof entrySchema>;
const tokenSchema = z.strictObject({ sha256: hex(64), person: z.string().regex(PERSON_ID), email: emailSchema, at: z.string(), expiresAt: z.string(), usedAt: z.string().optional() });
const fileSchema = z.strictObject({ version: z.literal(1), secret: hex(64), outbox: z.array(entrySchema), tokens: z.array(tokenSchema), stopped: z.array(hex(64)) });
type MailFile = z.infer<typeof fileSchema>;

/** What a thread shows about one participant's invitation. */
export interface InvitationStatus { emailed: boolean; emailedAt?: string; emailNote?: string }

/** Where the words of an email come from; the receiver's own address makes its links. */
export interface Thread { key: string; title: string; project: string }

export class Invitations {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();
  private sending?: Promise<void>;

  constructor(dir: string, private readonly mailer: Mailer, readonly publicUrl: string, private readonly log: (line: string) => void, private readonly now = () => Date.now()) {
    this.file = join(dir, 'mail.json');
  }

  describe(): string { return this.mailer.describe(); }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Read fresh each time: a damaged file is an error rather than nothing sent and nothing stopped. */
  private async read(): Promise<MailFile> {
    if (await exists(this.file)) return readJson(this.file, fileSchema);
    return { version: 1, secret: randomBytes(32).toString('hex'), outbox: [], tokens: [], stopped: [] };
  }

  private async write(file: MailFile): Promise<void> {
    const now = this.now();
    // Finished emails go after KEEP_MS, spent tokens after a week; a queued one always stays.
    file.outbox = file.outbox.filter(e => e.status === 'queued' || now - Date.parse(e.at) < KEEP_MS);
    file.tokens = file.tokens.filter(t => now - Date.parse(t.expiresAt) < 7 * DAY);
    await writeJsonAtomic(this.file, fileSchema.parse(file));
  }

  private newId = () => `m_${randomBytes(8).toString('hex')}`;
  private stopKey = (secret: string, email: string) => { const hash = sha256(email); return `${hash}.${createHmac('sha256', secret).update(hash).digest('hex').slice(0, 32)}`; };

  /** Why this email may not go now, or nothing: the address stopped them, or a limit is reached. */
  private refusal(file: MailFile, to: string, person?: string): string | undefined {
    if (file.stopped.includes(sha256(to))) return 'this address asked Polydance to stop emailing it';
    const now = this.now();
    const counted = file.outbox.filter(e => e.status === 'sent' || e.status === 'queued');
    if (counted.filter(e => e.to === to && now - Date.parse(e.at) < DAY).length >= LIMITS.perAddressPerDay) return `this address has had ${LIMITS.perAddressPerDay} emails today; try again tomorrow`;
    if (person && counted.filter(e => e.kind === 'confirm' && e.person === person && now - Date.parse(e.at) < DAY).length >= LIMITS.confirmationsPerPersonPerDay) return `${LIMITS.confirmationsPerPersonPerDay} confirmation emails today already; try again tomorrow`;
    if (counted.filter(e => now - Date.parse(e.at) < HOUR).length >= LIMITS.perHour) return 'this receiver has sent all the email it may this hour; try again later';
    return undefined;
  }

  private queue(file: MailFile, entry: Omit<Entry, 'id' | 'at' | 'status'>): Entry {
    const refused = this.refusal(file, entry.to, entry.person);
    const full: Entry = { ...entry, id: this.newId(), at: new Date(this.now()).toISOString(), status: refused ? 'skipped' : 'queued', ...(refused ? { reason: refused } : {}) };
    file.outbox.push(full);
    return full;
  }

  /**
   * The team copied `to` into a thread: one invitation per address per thread, unless `again` (the team's
   * resend). `known` says the address is already someone's verified one, so the thread is in their inbox.
   */
  invite(to: string, thread: Thread, by: string, options: { known?: boolean; again?: boolean } = {}): Promise<Entry | undefined> {
    return this.lock(async () => {
      const file = await this.read();
      const earlier = file.outbox.filter(e => e.kind === 'invite' && e.to === to && e.thread === thread.key);
      if (earlier.length && !options.again) return undefined;
      if (options.again && earlier.some(e => e.status === 'queued')) return undefined;
      const entry = this.queue(file, { kind: 'invite', to, thread: thread.key, title: thread.title, project: thread.project, by, ...(options.known ? { known: true } : {}) });
      await this.write(file);
      this.kick();
      return entry;
    });
  }

  /** A person entered `to` as their own address: a link to confirm it. Earlier links for them stop working. */
  confirmFor(person: string, to: string): Promise<Entry> {
    return this.lock(async () => {
      const file = await this.read();
      const now = this.now();
      for (const t of file.tokens) if (t.person === person && !t.usedAt) t.expiresAt = new Date(Math.min(Date.parse(t.expiresAt), now)).toISOString();
      const entry = this.queue(file, { kind: 'confirm', to, person });
      if (entry.status === 'queued') {
        const token = randomBytes(32).toString('base64url');
        file.tokens.push({ sha256: sha256(token), person, email: to, at: new Date(now).toISOString(), expiresAt: new Date(now + TOKEN_MS).toISOString() });
        entry.token = token;
      }
      await this.write(file);
      this.kick();
      return entry;
    });
  }

  /** A confirmation link's state, for its page: who it is for, or why it does not work. Changes nothing. */
  async lookup(token: string): Promise<{ ok: true; email: string; person: string } | { ok: false; why: 'unknown' | 'used' | 'expired' }> {
    const found = (await this.read()).tokens.find(t => t.sha256 === sha256(token));
    if (!found) return { ok: false, why: 'unknown' };
    if (found.usedAt) return { ok: false, why: 'used' };
    if (Date.parse(found.expiresAt) <= this.now()) return { ok: false, why: 'expired' };
    return { ok: true, email: found.email, person: found.person };
  }

  /** Uses a confirmation link once: the caller verifies the address it names (people.ts). */
  use(token: string): Promise<{ ok: true; email: string; person: string } | { ok: false; why: 'unknown' | 'used' | 'expired' }> {
    return this.lock(async () => {
      const file = await this.read();
      const found = file.tokens.find(t => t.sha256 === sha256(token));
      if (!found) return { ok: false, why: 'unknown' };
      if (found.usedAt) return { ok: false, why: 'used' };
      if (Date.parse(found.expiresAt) <= this.now()) return { ok: false, why: 'expired' };
      found.usedAt = new Date(this.now()).toISOString();
      await this.write(file);
      return { ok: true, email: found.email, person: found.person };
    });
  }

  /** Whether a stop link is genuine; it names no address, only its hash. */
  async stopValid(key: string): Promise<boolean> {
    const match = key.match(/^([0-9a-f]{64})\.([0-9a-f]{32})$/);
    if (!match) return false;
    const secret = (await this.read()).secret;
    const want = createHmac('sha256', secret).update(match[1]).digest('hex').slice(0, 32);
    return timingSafeEqual(Buffer.from(want), Buffer.from(match[2]));
  }

  /** Stops all email to the address a genuine stop link names; queued email to it is skipped. */
  stop(key: string): Promise<boolean> {
    return this.lock(async () => {
      if (!await this.stopValid(key)) return false;
      const file = await this.read();
      const hash = key.slice(0, 64);
      if (!file.stopped.includes(hash)) file.stopped.push(hash);
      for (const e of file.outbox) if (e.status === 'queued' && sha256(e.to) === hash) { e.status = 'skipped'; e.reason = 'this address asked Polydance to stop emailing it'; delete e.token; }
      await this.write(file);
      return true;
    });
  }

  /** A thread's participants' invitations, latest each: what the thread view shows. */
  async statuses(threadKey: string): Promise<Map<string, InvitationStatus>> {
    const statuses = new Map<string, InvitationStatus>();
    for (const e of (await this.read()).outbox) {
      if (e.kind !== 'invite' || e.thread !== threadKey) continue;
      statuses.set(e.to, e.status === 'sent' ? { emailed: true, ...(e.sentAt ? { emailedAt: e.sentAt } : {}) }
        : { emailed: false, emailNote: e.status === 'queued' ? 'sending' : e.reason ?? e.status });
    }
    return statuses;
  }

  /** Sends what is queued, one at a time; at start-up too. */
  kick(): void { this.sending ??= this.drain().finally(() => { this.sending = undefined; }); }

  /** Resolves when nothing is being sent; for tests and a clean shutdown. */
  async idle(): Promise<void> { while (this.sending) await this.sending; }

  private async drain(): Promise<void> {
    for (;;) {
      const next = (await this.read()).outbox.find(e => e.status === 'queued');
      if (!next) return;
      let outcome: Partial<Entry>;
      const token = next.token;
      if (next.kind === 'confirm' && !token) outcome = { status: 'skipped', reason: 'its link was lost; enter the address again' };
      else {
        try {
          const file = await this.read();
          const { id } = await this.mailer.send({ to: next.to, ...this.words(next, token, this.stopKey(file.secret, next.to)), idempotencyKey: next.id });
          outcome = { status: 'sent', sentAt: new Date(this.now()).toISOString(), ...(id ? { messageId: id.slice(0, 200) } : {}) };
        } catch (error) {
          const reason = error instanceof MailError ? error.message : 'could not send it';
          this.log(`mail ${next.id} (${next.kind}) failed: ${reason}`);
          outcome = { status: 'failed', reason: reason.slice(0, 300) };
        }
      }
      await this.lock(async () => {
        const file = await this.read();
        const entry = file.outbox.find(e => e.id === next.id);
        if (entry?.status === 'queued') Object.assign(entry, outcome);
        // Sent or not, the link's token leaves the outbox: only its hash stays, in the token list.
        if (entry) delete entry.token;
        await this.write(file);
      });
    }
  }

  /** An email's words. Plain, short, and the same for any receiver: links are this receiver's own. */
  private words(e: Entry, token: string | undefined, stopKey: string): { subject: string; text: string; html: string; unsubscribe: string } {
    const stop = `${this.publicUrl}/email/stop/${stopKey}`;
    const start = `${this.publicUrl}/start`;
    const foot = 'You are getting this because someone using Polydance entered this address.';
    if (e.kind === 'confirm') {
      const link = `${this.publicUrl}/email/confirm/${token}`;
      const lines = [
        'Confirm your address for Polydance',
        '',
        'You entered this address in Polydance. Open this link and press Confirm, and the threads people have invited this address to will appear in your Polydance inbox:',
        link,
        '',
        'Confirm only if you entered it yourself just now: confirming gives whoever entered it the threads this address is invited to. The link works once, for 48 hours. If you did not enter this address in Polydance, ignore this email.',
      ];
      return { subject: 'Confirm your address for Polydance', unsubscribe: stop, ...render(lines, foot, stop, [link]) };
    }
    const by = e.by ?? 'Someone';
    const thread = `"${e.title}"${e.project ? ` (${e.project})` : ''}`;
    const lines = e.known ? [
      `${by} added you to the thread ${thread} on Polydance.`,
      '',
      'It is in your Polydance inbox now.',
      '',
      `Getting started: ${start}`,
    ] : [
      `${by} added you to the thread ${thread} on Polydance.`,
      '',
      'Polydance is for showing and telling in a headset: people post something to try, and you answer by recording what you see and say.',
      '',
      'To take part:',
      `1. Get Polydance on your Meta Quest. It is in a private test: if your Meta account uses a different address from this one, reply to this email with it, and ${by} can add you.`,
      '2. In Polydance, tap the circle in the corner and enter this address.',
      '3. Polydance emails you a link to confirm it. Once you confirm, this thread is in your inbox.',
      '',
      `How to get set up, step by step: ${start}#invited`,
    ];
    return { subject: `${by} added you to "${e.title}" on Polydance`, unsubscribe: stop, ...render(lines, foot, stop, []) };
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const linkify = (line: string) => escape(line).replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}" style="color:#3A2C20">${url}</a>`);

/** The same words as text and as simple HTML in Polydance's colours (design/tokens.json): the cream plate. */
function render(lines: string[], foot: string, stop: string, buttons: string[]): { text: string; html: string } {
  const text = [...lines, '', '--', foot, `To stop all email from Polydance to this address: ${stop}`].join('\n');
  const paragraphs = lines.join('\n').split('\n\n').map(p => `<p style="margin:0 0 14px">${p.split('\n').map(linkify).join('<br>')}</p>`).join('');
  const button = buttons.map(href => `<p style="margin:0 0 14px"><a href="${escape(href)}" style="display:inline-block;background:#3A2C20;color:#E6DDC5;padding:10px 18px;border-radius:6px;text-decoration:none">Confirm my address</a></p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#E6DDC5;color:#3A2C20;font:16px/1.5 system-ui,sans-serif"><div style="max-width:560px;margin:0 auto;padding:24px 16px">${paragraphs}${button}<p style="margin:24px 0 0;color:#704C2C;font-size:13px">${escape(foot)} <a href="${escape(stop)}" style="color:#704C2C">Stop all email from Polydance to this address</a>.</p></div></body></html>`;
  return { text, html };
}
