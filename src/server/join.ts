/**
 * Asking to join (Robin, 2026-11-11): the form on polydance.net posts here, and the team is emailed each request so
 * they can add the person to the test. Off unless POLYCAP_JOIN is set, so a receiver someone else runs takes none.
 *
 * It is public, like /start, so it guards itself without a third party: a field people never see and bots fill in
 * (dropped, with the same thanks a person gets); a minimum time since the page loaded; a proof of work the
 * visitor's browser solves, bound to the address, so each request costs its sender about a second
 * (`polydance-join:v1:<stamp>:<email>:<nonce>` must hash to `bits` leading zero bits, `<stamp>` within the last
 * half hour); one request per address a day; and limits per sender and per hour. Only the team is emailed, never
 * the address that asks, so the form cannot be used to send mail to anyone else.
 *
 * Requests are kept in join.json (0600) for 180 days: the address, headset and note, and the sender as an HMAC of
 * their IP address under a secret made here (for the limits, never the address itself). nginx in front adds a
 * rate limit of its own (private/deploy/receiver/nginx-join.py).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { exists, readJson, writeJsonAtomic } from '../fsx.js';
import { MailError, type Mailer } from './mail.js';
import { emailSchema } from './people.js';
import { escape, PAGE_STYLE } from './privacy.js';

const HOUR = 3600_000, DAY = 24 * HOUR;
/** A form body is a few hundred bytes; anything near this is not one. */
const MAX_BODY = 4096;
export const JOIN_LIMITS = { perSenderPerHour: 5, emailsPerHour: 30, minFillMs: 3000, stampAgeMs: 30 * 60_000, stampAheadMs: 2 * 60_000 };
const KEEP_MS = 180 * DAY;

export const HEADSETS = { quest: 'Meta Quest', 'android-xr': 'Android XR', other: 'Something else', none: 'No headset yet' } as const;

export const joinSettingsSchema = z.strictObject({
  /** Who is emailed each request: the team's own address. */
  notify: emailSchema,
  /** The site the form is on: the result page links back to it. */
  site: z.string().regex(/^https:\/\/[^/\s]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'https://host with no path'),
  /** Leading zero bits the proof of work needs: 18 is about a second on a laptop and a few on a phone (measured
   * 2026-11-11: some 300,000 hashes a second in Chrome on an M-series Mac). */
  bits: z.number().int().min(4).max(24).default(18),
});
export type JoinSettings = z.infer<typeof joinSettingsSchema>;

/** Unset means no form; anything else must be whole, or the receiver does not start. */
export function parseJoin(value: string | undefined): JoinSettings | undefined {
  if (!value?.trim()) return undefined;
  let json: unknown;
  try { json = JSON.parse(value); } catch { throw new Error('POLYCAP_JOIN is not JSON'); }
  const parsed = joinSettingsSchema.safeParse(json);
  if (!parsed.success) throw new Error(`POLYCAP_JOIN: ${parsed.error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** The form's fields, as the homepage's join.js sends them. */
export const joinFormSchema = z.strictObject({
  email: emailSchema,
  headset: z.enum(['quest', 'android-xr', 'other', 'none']),
  note: z.string().max(500).optional().transform(s => s?.trim() || undefined),
  /** The field people never see. */
  company: z.string().max(200).optional(),
  started: z.coerce.number().int().positive(),
  stamp: z.coerce.number().int().positive(),
  nonce: z.string().regex(/^[0-9a-z]{1,16}$/),
});

/** How many leading zero bits a sha256 hex digest has. */
export function zeroBits(hex: string): number {
  let bits = 0;
  for (const c of hex) {
    const v = parseInt(c, 16);
    if (v === 0) { bits += 4; continue; }
    return bits + Math.clz32(v) - 28;
  }
  return bits;
}

/** The proof of work's digest: the stamp, the address as typed but trimmed and lower-cased, and the nonce. */
export const workDigest = (stamp: number, email: string, nonce: string) => createHash('sha256').update(`polydance-join:v1:${stamp}:${email.trim().toLowerCase()}:${nonce}`).digest('hex');

const requestSchema = z.strictObject({
  id: z.string().regex(/^j_[0-9a-f]{16}$/), at: z.string(), email: emailSchema, headset: joinFormSchema.shape.headset, note: z.string().max(500).optional(),
  sender: z.string().regex(/^[0-9a-f]{32}$/), work: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['emailed', 'kept', 'failed']), reason: z.string().max(300).optional(), messageId: z.string().max(200).optional(),
});
type JoinRequest = z.infer<typeof requestSchema>;
const fileSchema = z.strictObject({ version: z.literal(1), secret: z.string().regex(/^[0-9a-f]{64}$/), requests: z.array(requestSchema) });
type JoinFile = z.infer<typeof fileSchema>;

/** What became of one request, for the page the sender sees. */
type Outcome = 'thanks' | 'again' | 'busy' | 'bad' | 'slow';

export class Join {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string, readonly settings: JoinSettings, private readonly mailer: Mailer, private readonly log: (line: string) => void, private readonly now = () => Date.now()) {
    this.file = join(root, 'join.json');
  }

  describe(): string { return `to ${this.settings.notify}, ${this.settings.bits}-bit work`; }

  /** One at a time, so two requests never read and write join.json at once. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<JoinFile> {
    if (!await exists(this.file)) return { version: 1, secret: randomBytes(32).toString('hex'), requests: [] };
    return readJson(this.file, fileSchema);
  }

  /** Checks one form, keeps it and emails the team; what the sender is told. Never throws for a bad form. */
  async take(body: string, address: string): Promise<Outcome> {
    const form = joinFormSchema.safeParse(Object.fromEntries(new URLSearchParams(body)));
    if (!form.success) return 'bad';
    const f = form.data;
    // Filled in by something that reads the page's source, not by a person: thanked, and dropped.
    if (f.company?.trim()) { this.log('join: dropped (the hidden field was filled in)'); return 'thanks'; }
    const now = this.now();
    if (now - f.started < JOIN_LIMITS.minFillMs || now - f.started > DAY) return 'slow';
    if (now - f.stamp > JOIN_LIMITS.stampAgeMs || f.stamp - now > JOIN_LIMITS.stampAheadMs) return 'slow';
    const work = workDigest(f.stamp, f.email, f.nonce);
    if (zeroBits(work) < this.settings.bits) return 'bad';
    const email = f.email.trim().toLowerCase();
    return this.serial(async () => {
      const file = await this.load();
      file.requests = file.requests.filter(r => now - Date.parse(r.at) < KEEP_MS);
      const sender = createHmac('sha256', file.secret).update(address).digest('hex').slice(0, 32);
      if (file.requests.some(r => r.work === work)) return 'again';
      if (file.requests.some(r => r.email === email && now - Date.parse(r.at) < DAY)) return 'again';
      if (file.requests.filter(r => r.sender === sender && now - Date.parse(r.at) < HOUR).length >= JOIN_LIMITS.perSenderPerHour) return 'busy';
      const request: JoinRequest = { id: `j_${randomBytes(8).toString('hex')}`, at: new Date(now).toISOString(), email, headset: f.headset, ...(f.note ? { note: f.note } : {}), sender, work, status: 'kept' };
      const emailedThisHour = file.requests.filter(r => r.status === 'emailed' && now - Date.parse(r.at) < HOUR).length;
      file.requests.push(request);
      await writeJsonAtomic(this.file, file);
      if (emailedThisHour >= JOIN_LIMITS.emailsPerHour) {
        request.reason = `kept, not emailed: ${JOIN_LIMITS.emailsPerHour} requests were emailed in the last hour`;
        this.log(`join: ${request.id} ${request.reason}`);
      } else {
        try {
          const sent = await this.mailer.send(this.email(request));
          request.status = 'emailed';
          if (sent.id) request.messageId = sent.id;
        } catch (error) {
          request.status = 'failed';
          request.reason = error instanceof MailError ? error.message : 'the email could not be sent';
          this.log(`join: ${request.id} not emailed: ${request.reason}`);
        }
      }
      await writeJsonAtomic(this.file, file);
      return 'thanks';
    });
  }

  /** The team's email: who asked, with what headset and note; a reply goes to them. */
  private email(r: JoinRequest) {
    const headset = HEADSETS[r.headset];
    const lines = [`${r.email} asked to join the Polydance trial.`, '', `Headset: ${headset}`, `Note: ${r.note ?? '(none)'}`, '', `Reply to this email to answer them. Request ${r.id}, ${r.at}.`];
    const html = `<p><strong>${escape(r.email)}</strong> asked to join the Polydance trial.</p><p>Headset: ${escape(headset)}<br>Note: ${r.note ? escape(r.note) : '(none)'}</p><p>Reply to this email to answer them. Request ${r.id}, ${r.at}.</p>`;
    return { to: this.settings.notify, replyTo: r.email, subject: `Polydance: ${r.email} asked to join (${headset})`, text: lines.join('\n'), html, idempotencyKey: r.id };
  }
}

const PAGES: Record<Outcome, { status: number; title: string; body: string }> = {
  thanks: { status: 200, title: 'Thanks, we have it', body: 'We will email you about joining the trial. For Meta Quest, we add the address you gave to Polydance\'s test channel, so it should be the one on your Meta account.' },
  again: { status: 200, title: 'We have it already', body: 'A request from this address is with us. We will email you about joining the trial.' },
  busy: { status: 429, title: 'Too many requests', body: 'This form has been sent from here several times in the last hour. Please try again later.' },
  bad: { status: 400, title: 'That did not go through', body: 'Please go back, check your email address, and send the form again from the page.' },
  slow: { status: 400, title: 'That did not go through', body: 'The form was sent too quickly, or after too long. Please go back, reload the page, and send it again.' },
};

function page(res: ServerResponse, outcome: Outcome, site: string): void {
  const p = PAGES[outcome];
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(p.title)} · Polydance</title>
<style>
${PAGE_STYLE}
</style></head>
<body><main>
<h1>${escape(p.title)}</h1>
<p>${escape(p.body)}</p>
<p><a href="${escape(site)}/">Back to Polydance</a></p>
</main></body></html>
`;
  res.writeHead(p.status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

/** The sender's address: nginx's X-Real-IP when the request comes through it on this machine, else the socket's. */
export function senderAddress(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? '';
  const loopback = socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1';
  const real = req.headers['x-real-ip'];
  return loopback && typeof real === 'string' && isIP(real.trim()) ? real.trim() : socket;
}

/** Handles POST /join; false when the path is not /join. */
export async function joinRoute(req: IncomingMessage, res: ServerResponse, path: string, joining: Join | undefined): Promise<boolean> {
  if (path !== '/join') return false;
  if (!joining) { req.resume(); res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return true; }
  if (req.method !== 'POST') { req.resume(); res.writeHead(303, { location: `${joining.settings.site}/#join` }); res.end(); return true; }
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') { req.resume(); page(res, 'bad', joining.settings.site); return true; }
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) { res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }); res.end('too large'); return true; }
    chunks.push(chunk as Buffer);
  }
  page(res, await joining.take(Buffer.concat(chunks).toString('utf8'), senderAddress(req)), joining.settings.site);
  return true;
}
