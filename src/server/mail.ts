/**
 * Email from the receiver (Robin, 2026-11-10): the invitation someone gets when the team copies their address
 * into a thread, and the link that confirms a person's own address (invitations.ts). Off unless POLYCAP_MAIL
 * is set. Two ways to send:
 *
 * - `ahasend`, AhaSend's API v2, through a key that should be scoped to Polydance's own sending domain
 *   (`messages:send:{domain}`), so it cannot send as anything else on the same account. Every message is
 *   tagged, open and click tracking are off (no pixels, and no confirmation link rewritten through a tracker),
 *   and each send carries an Idempotency-Key, so a retry never sends twice.
 * - `folder`, for trying it all without sending anything: each email is written to `<root>/mail-outbox/` as a
 *   `.eml` and a `.html` to read (0600), and its links work against a receiver on this machine.
 *
 * POLYCAP_PUBLIC_URL is the receiver's own address, for the links in an email; https, or http on this machine.
 * The key is never logged and never part of an error.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDir } from '../fsx.js';
import { emailSchema } from './people.js';

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const urlSetting = (name: string, value: string): string => {
  const url = value.replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/.test(url) && !LOCAL.test(url)) throw new Error(`${name}=${url} must be https://host, or http on this machine, with no path`);
  return url;
};

const address = z.strictObject({ email: emailSchema, name: z.string().trim().min(1).max(80).regex(/^[^<>"\r\n]+$/, 'a name without < > " or line breaks').optional() });
export const mailSettingsSchema = z.strictObject({
  provider: z.enum(['ahasend', 'folder']),
  /** AhaSend's account id (a sub-account's id when Polydance has one of its own). */
  accountId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'an AhaSend account id').optional(),
  from: address,
  /** Where a reply goes: the person who invites, so a newcomer can answer with their Meta account's address. */
  replyTo: address.optional(),
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/, 'a tag is lowercase letters, digits and dashes')).min(1).max(5).default(['polydance']),
  /** AhaSend's sandbox: accepted and checked, never delivered. */
  sandbox: z.boolean().default(false),
}).refine(s => s.provider !== 'ahasend' || s.accountId, { message: 'ahasend needs accountId', path: ['accountId'] });
export type MailSettings = z.infer<typeof mailSettingsSchema>;

export interface MailEnv { POLYCAP_MAIL?: string; POLYCAP_AHASEND_KEY?: string; POLYCAP_AHASEND_URL?: string; POLYCAP_PUBLIC_URL?: string }

/** One email: plain text and HTML, and the headers that let a mail program offer "unsubscribe". A replyTo of its own
 * (a request to join, join.ts: the person asking) is used in place of the settings' one. */
export interface Email { to: string; subject: string; text: string; html: string; idempotencyKey: string; unsubscribe?: string; replyTo?: string }

/** A refusal or failure from the mail service, in words safe to keep and show: never the key. */
export class MailError extends Error {}

export interface Mailer { describe(): string; send(email: Email): Promise<{ id?: string }> }

/** Unset means no email; anything else must be whole, or the receiver does not start. */
export function parseMail(env: MailEnv, root: string): { mailer: Mailer; settings: MailSettings; publicUrl: string } | undefined {
  if (!env.POLYCAP_MAIL?.trim()) return undefined;
  let json: unknown;
  try { json = JSON.parse(env.POLYCAP_MAIL); } catch { throw new Error('POLYCAP_MAIL is not JSON'); }
  const parsed = mailSettingsSchema.safeParse(json);
  if (!parsed.success) throw new Error(`POLYCAP_MAIL: ${parsed.error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
  if (!env.POLYCAP_PUBLIC_URL) throw new Error('POLYCAP_MAIL needs POLYCAP_PUBLIC_URL, the receiver\'s own address for the links in an email');
  const publicUrl = urlSetting('POLYCAP_PUBLIC_URL', env.POLYCAP_PUBLIC_URL);
  const settings = parsed.data;
  if (settings.provider === 'folder') return { mailer: new FolderMailer(join(root, 'mail-outbox'), settings), settings, publicUrl };
  const key = env.POLYCAP_AHASEND_KEY?.trim();
  if (!key) throw new Error('POLYCAP_MAIL with ahasend needs POLYCAP_AHASEND_KEY');
  if (!/^aha-sk-[A-Za-z0-9_-]{8,}$/.test(key)) throw new Error('POLYCAP_AHASEND_KEY is not an AhaSend API key (aha-sk-…)');
  const url = urlSetting('POLYCAP_AHASEND_URL', env.POLYCAP_AHASEND_URL || 'https://api.ahasend.com');
  return { mailer: new AhaSendMailer(url, key, settings), settings, publicUrl };
}

const responseSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string().nullable().optional(), status: z.string().optional(), error: z.string().nullable().optional() })).min(1) });

class AhaSendMailer implements Mailer {
  constructor(private readonly url: string, private readonly key: string, private readonly settings: MailSettings) {}

  describe() { return `AhaSend${this.settings.sandbox ? ' (sandbox: nothing delivered)' : ''}, from ${this.settings.from.email}`; }

  async send(email: Email): Promise<{ id?: string }> {
    const s = this.settings;
    const body = {
      from: s.from, recipients: [{ email: email.to }], subject: email.subject, text_content: email.text, html_content: email.html,
      ...(email.replyTo ? { reply_to: { email: email.replyTo } } : s.replyTo ? { reply_to: s.replyTo } : {}), tags: s.tags, tracking: { open: false, click: false }, sandbox: s.sandbox,
      ...(email.unsubscribe ? { headers: { 'List-Unsubscribe': `<${email.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    };
    let response: Response;
    try {
      response = await fetch(`${this.url}/v2/accounts/${encodeURIComponent(s.accountId!)}/messages`, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', 'idempotency-key': email.idempotencyKey },
      });
    } catch (error) { throw new MailError(`could not reach AhaSend: ${(error as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`); }
    const json: unknown = await response.json().catch(() => undefined);
    if (response.status !== 202 && response.status !== 200) {
      const said = typeof (json as { message?: unknown })?.message === 'string' ? (json as { message: string }).message : '';
      throw new MailError(`AhaSend refused it (${response.status})${said ? `: ${said.replaceAll(this.key, '…').slice(0, 200)}` : ''}`);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new MailError('AhaSend answered in an unexpected shape');
    const [first] = parsed.data.data;
    if (first.status === 'error' || !first.id) throw new MailError(`AhaSend did not queue it${first.error ? `: ${first.error.slice(0, 200)}` : ''}`);
    return { id: first.id };
  }
}

/** Writes each email to a folder to read, with nothing sent: for trying the flow on this machine. */
class FolderMailer implements Mailer {
  constructor(private readonly dir: string, private readonly settings: MailSettings) {}

  describe() { return `to the folder ${this.dir} (nothing is sent)`; }

  async send(email: Email): Promise<{ id?: string }> {
    await privateDir(this.dir);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomBytes(3).toString('hex')}`;
    const from = this.settings.from.name ? `${this.settings.from.name} <${this.settings.from.email}>` : this.settings.from.email;
    const headers = [
      `From: ${from}`, `To: ${email.to}`, ...(email.replyTo ?? this.settings.replyTo?.email ? [`Reply-To: ${email.replyTo ?? this.settings.replyTo!.email}`] : []), `Subject: ${email.subject}`,
      ...(email.unsubscribe ? [`List-Unsubscribe: <${email.unsubscribe}>`] : []), `X-Tags: ${this.settings.tags.join(', ')}`, 'Content-Type: text/plain; charset=utf-8',
    ];
    await writeFile(join(this.dir, `${id}.eml`), `${headers.join('\n')}\n\n${email.text}`, { mode: 0o600 });
    await writeFile(join(this.dir, `${id}.html`), email.html, { mode: 0o600 });
    return { id };
  }
}
