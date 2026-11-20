/**
 * The two pages an email's links open (2026-11-10, invitations.ts): confirming your own address, and stopping
 * all email from Polydance to an address. Each link opens a page with one button, and only pressing it (a POST)
 * changes anything, so a mail program or scanner that opens links on its own confirms and stops nothing. The
 * stop link also takes the one-click POST that mail programs send for a List-Unsubscribe-Post header.
 * Served before any token, like /privacy, in its look (privacy.ts); never cached; nothing from the request is
 * echoed but the address a valid link names, shown partly hidden.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Invitations } from './invitations.js';
import type { People } from './people.js';
import { escape, PAGE_STYLE } from './privacy.js';

function page(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
${PAGE_STYLE}
button { font: inherit; background: var(--fg); color: var(--bg); border: 0; border-radius: 6px; padding: 10px 18px; cursor: pointer; }
</style></head>
<body><main>
<h1>${escape(title)}</h1>
${body}
</main></body></html>
`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(html);
}

/** "r•••@example.com": enough to recognise your own address, not enough to read someone else's off a shared link. */
const masked = (email: string) => { const [local, domain] = email.split('@'); return `${local[0]}•••@${domain}`; };

const WHY = { unknown: 'This link is not one Polydance sent, or it has been replaced by a newer one.', used: 'This link has been used already.', expired: 'This link has expired.' } as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Handles /email/confirm/<token> and /email/stop/<key>; false when the path is neither. */
export async function emailPages(req: IncomingMessage, res: ServerResponse, path: string, invitations: Invitations | undefined, people: People): Promise<boolean> {
  const match = path.match(/^\/email\/(confirm|stop)\/([^/]+)$/);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return true; }
  // A form's body, or a mail program's one-click "List-Unsubscribe=One-Click": read and set aside, never used.
  req.resume();
  if (!invitations) { page(res, 404, 'Not here', '<p>This receiver does not send email.</p>'); return true; }
  const [, kind, key] = match;
  const post = req.method === 'POST';
  if (kind === 'confirm') {
    const found = TOKEN.test(key) ? await (post ? invitations.use(key) : invitations.lookup(key)) : { ok: false as const, why: 'unknown' as const };
    if (!found.ok) {
      page(res, 410, 'This link does not work', `<p>${WHY[found.why]}</p><p>To get a new one, enter your address again in Polydance: tap the circle in the corner.</p>`);
      return true;
    }
    if (!post) {
      page(res, 200, 'Confirm your address', `<p>Confirm that <strong>${escape(masked(found.email))}</strong> is your address in Polydance. Threads people have invited it to will then be in your inbox.</p><form method="post"><button type="submit">Confirm</button></form>`);
      return true;
    }
    // Only the address they still have: one they changed since the link was sent is not confirmed by it.
    const now = (await people.emails())[found.person];
    if (now?.email !== found.email) {
      page(res, 409, 'This link does not work', '<p>The address in Polydance has changed since this link was sent. Enter it again to get a new link.</p>');
      return true;
    }
    // A link sent before someone else confirmed the same address does not take it from them (people.ts verifiedByOther).
    if (await people.verifiedByOther(found.person, found.email)) {
      page(res, 409, 'This link does not work', '<p>This address is already confirmed in Polydance. If you did not enter it again just now, someone else did: ignore this link.</p>');
      return true;
    }
    await people.setVerifiedEmail(found.person, found.email);
    page(res, 200, 'Your address is confirmed', '<p>Threads people have invited this address to are in your Polydance inbox now, and so will any they invite it to later.</p>');
    return true;
  }
  if (!await invitations.stopValid(key)) { page(res, 404, 'This link does not work', '<p>This is not a link Polydance sent.</p>'); return true; }
  if (!post) {
    page(res, 200, 'Stop email from Polydance', '<p>Press Stop and Polydance will not email this address again: no invitations, and no confirmation links.</p><form method="post"><button type="submit">Stop</button></form>');
    return true;
  }
  await invitations.stop(key);
  page(res, 200, 'Done', '<p>Polydance will not email this address again.</p>');
  return true;
}
