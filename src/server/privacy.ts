/**
 * The privacy notice for Polydance, served at /privacy so the store listing and Meta's Data Use
 * Checkup have a URL to point at, and so the app's consent notice can link to the full text. It says what
 * the app and this receiver actually do (docs/HOSTED.md, "What leaves the headset"); change it with them.
 * The contact comes from POLYCAP_PRIVACY_CONTACT, an email address, and the page says when it has none.
 * Its colours are Polydance's (design/tokens.json): print on the cream plate by day, cream on the casing at
 * night; tests/design.test.ts checks them.
 */
import type { ServerResponse } from 'node:http';

/** The consent the app asks for before a new recording; the app sends it with each upload. */
export const CONSENT_VERSION = 'capture-hosted-3';
/**
 * Every notice an upload may carry: the current one, and earlier ones, so a recording made under an earlier
 * notice still uploads after the app updates, and an app not yet updated keeps working. The app's
 * ConsentEvidence keeps the same list (tests/testers.test.ts holds them together); it asks again before any
 * new recording. capture-hosted-1, until 2026-11-11, said recordings were "for the team you are testing for";
 * capture-hosted-2, until 2026-11-16, did not say a recording can send the headset's logs (docs/LOGS.md).
 */
export const ACCEPTED_CONSENT_VERSIONS: readonly string[] = [CONSENT_VERSION, 'capture-hosted-2', 'capture-hosted-1'];
const UPDATED = '2026-11-16';

export const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The receiver's pages' look (this notice and /start, start.ts): the cream plate by day, the casing at night. */
export const PAGE_STYLE = `:root { --bg: #E6DDC5; --fg: #3A2C20; --muted: #704C2C; --rule: #968A6E; }
@media (prefers-color-scheme: dark) { :root { --bg: #1C1916; --fg: #EFE6D2; --muted: #B8AD97; --rule: #403931; } }
body { background: var(--bg); color: var(--fg); font: 17px/1.55 system-ui, sans-serif; margin: 0; padding: 32px 16px 64px; }
main { max-width: 680px; margin: 0 auto; }
h1 { font-size: 1.7rem; margin: 0 0 4px; } h2 { font-size: 1.15rem; margin: 2em 0 0.4em; padding-top: 0.6em; border-top: 1px solid var(--rule); }
p.meta { color: var(--muted); margin: 0 0 1.5em; } li { margin: 0.3em 0; } a { color: inherit; }`;

/**
 * `joinSite` is where the form asking to join is (POLYCAP_JOIN's site), when this receiver takes requests from it;
 * `videoDays` how long a tester's video is kept (POLYCAP_MEMBER_VIDEO_DAYS), when it is limited.
 */
export function privacyHtml(contact: string | undefined, joinSite?: string, videoDays?: number): string {
  const reach = contact
    ? `email <a href="mailto:${escape(contact)}">${escape(contact)}</a>`
    : 'use the contact on the app\'s store page (Meta Horizon Store or Google Play)';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polydance privacy</title>
<style>
${PAGE_STYLE}
</style></head>
<body><main>
<h1>Polydance privacy</h1>
<p class="meta">Updated ${UPDATED}. Consent version ${CONSENT_VERSION}.</p>
<p>Polydance is an app for testing apps in a headset, on Meta Quest and on Android XR. While you record, it captures what you see and say, and the headset's logs unless you switch them off, and it sends each recording to the Polydance receiver at capture.polydance.net. There, it goes into the thread you recorded it in and becomes a review bundle: a transcript, still frames and a short summary.</p>

<h2>What is recorded</h2>
<ul>
<li><strong>The view in the headset</strong> while a recording runs, unless you switch Screen off: apps, panels and passthrough, which can show the room you are in.</li>
<li><strong>Your microphone</strong>, unless you switch Mic off, and <strong>the sound of apps</strong>, unless you switch App sound off.</li>
<li><strong>The headset's logs</strong>, unless you switch Logs off: what apps wrote to the headset's system log while the recording ran, read when you stop it. Polydance sends its own lines. It sends other apps' lines only if the headset has been given access to them over a developer connection (adb), and only when you allow the headset's own prompt for them each time. Those lines can include details of what the apps were doing, such as the addresses of pages you opened.</li>
<li><strong>Details of the recording:</strong> when it was made and how long it is, the headset model and its software version, the app's version, the thread it answers, and which links or apps you opened from the inbox while recording.</li>
<li><strong>Your Meta account:</strong> your Meta user ID and display name, given by Horizon OS when you sign in. They show the team who sent a recording, and let the receiver check your account proof and app entitlement with Meta. Entitlement does not prove current release-channel membership.</li>
<li><strong>Your Google account, on Android XR:</strong> your Google account ID, your name and the email address Google has verified, given by Google when you sign in with Google. They show the team who sent a recording. The address decides whether you are invited to the test, and puts you in the threads people have added that address to.</li>
<li><strong>Email addresses, if you give them:</strong> your own, and those of people you add to a thread. They are stored on the receiver and shown to the people in that thread and to the team. When you enter your own, Polydance emails you a link to confirm it; once confirmed, threads that invited that address are yours. When someone on the team adds an address to a thread, Polydance emails it once for that thread: who added it, the thread's title and how to join, never the thread's messages or recordings. Addresses added by anyone else are not emailed.</li>
</ul>
<p>Nothing is recorded until you press record. The view is recorded only after you accept the headset's own screen-capture prompt. The app does not collect your location, contacts, advertising identifiers or analytics, and shows no ads.</p>

<h2>Where it goes</h2>
<ul>
<li><strong>The Polydance receiver</strong>, capture.polydance.net, a server Polydance runs. Recordings are sent over HTTPS and stored there in private folders.</li>
<li><strong>Gladia</strong> transcribes the microphone track. The receiver deletes the transcription job at Gladia once it has the text.</li>
<li><strong>Anthropic</strong> (Claude) writes each recording's title and summary from the transcript text. When the team has turned it on, Claude also looks at up to 24 still frames to name what you pointed at.</li>
<li><strong>AhaSend</strong> sends Polydance's emails: for an invitation, the address, the name of who added it and the thread's title; for a confirmation, the link. Open and click tracking are off, and every email has a link that stops all email from Polydance to that address.</li>
<li><strong>The Polydance team</strong> runs capture.polydance.net, so it has access to every thread's recordings, including the threads a newcomer starts in Getting started. When the team works in a thread, its coding agents read that thread's bundles on the team's own computers.</li>
<li><strong>People in a thread</strong>, those the team has added to it and whoever opened it by recording, and the team can play its recordings and read their transcripts in the app. Other testers do not see a thread they are not in.</li>
<li><strong>Reports</strong>, recorded with the bug key on the deck, are about Polydance itself: a bug or a feature you would like. Each goes only to the Polydance team, is processed the same way, and is not shown in your inbox or your recordings.</li>
</ul>
<p>Nothing is sold or used for advertising.</p>

<h2>How long it is kept, and deleting it</h2>
<ul>
<li>A recording waits a few seconds after you stop before it uploads. Press Delete in that time and it never leaves the headset. Cancel while recording throws a recording away.</li>
<li><strong>Delete</strong> removes the headset copy and queues deletion from the receiver. The app reports pending or unconfirmed server deletion; it can wait for connectivity, sign-in or processing to finish. If access has been revoked or deletion stays unconfirmed, contact us to remove the server copy.</li>
<li>A report is deleted from the headset as soon as the receiver has all of it, and one that cannot be sent is removed after a week. It has no Delete once sent; to have one deleted from the receiver, ${reach}.</li>
<li>To have an email address removed from the receiver, ${reach}.</li>
<li>Copies the team already downloaded to their own computers stay there until they remove them. Ask them, or us, if you want those gone.</li>
${videoDays ? `<li><strong>A tester's video is kept for ${videoDays} days</strong> after it is sent, then deleted on its own. The recording's transcript, still frames, summary and microphone track stay, so it can still be read, until it is deleted. This applies to everyone except the team that runs this receiver.</li>
` : ''}<li>Otherwise recordings are kept until deleted. Each tester has a storage allowance. When the receiver's disk fills, it deletes the oldest finished recordings first.</li>
<li>The receiver operator can block your Meta user ID locally and restart the receiver to stop access. Removing you from a Meta release channel alone does not guarantee this. Access also stops when Meta denies app entitlement, or when entitlement has not been verified for 24 hours. To have everything you recorded deleted, ${reach}.</li>
<li>On Android XR, the receiver operator can remove your address from the invited list or block it, and restart the receiver, to stop access.</li>
</ul>

${joinSite ? `<h2>Asking to join, from the website</h2>
<p>The form on ${escape(joinSite.replace(/^https?:\/\//, ''))} sends your email address, the headset you have and your note, if you write one, to this receiver. It keeps them for 180 days so the team can reply, and emails them to the team through AhaSend. The form never emails your address, and does not add it to any list. To limit misuse, your browser solves a small puzzle before the form is sent, and the receiver keeps a code made from your IP address (never the address itself) for the same 180 days. To have a request deleted, ${reach}.</p>

<h2>Counting visits to the website</h2>
<p>${escape(joinSite.replace(/^https?:\/\//, ''))} counts visits with Google Analytics only if you allow it in the bar at the foot of the page. Until you do, nothing is loaded from Google. If you allow it, Google Analytics sets cookies in your browser (<code>_ga</code> and one starting <code>_ga_</code>) and sends Google the pages you view there, the site that sent you, your browser and device, and roughly where you are, worked out from your IP address. Google keeps the visit data for 2 months and what it holds about your browser for 14 months, and may handle it outside the UK. Google signals is off, so none of it is joined to a Google account. The Cookies button at the foot of the page changes your answer; saying no removes the cookies. Your answer is kept in your browser, not in a cookie.</p>

` : ''}<h2>Who may use it</h2>
<p>Polydance uses a private-beta-only admission model for adults invited to test: a valid Meta account proof and app entitlement, subject to a receiver-local blocklist and tester limit. There is no separate receiver allowlist; this model must not be used for public distribution. Meta requires testers in private release channels to be 18 or older.</p>
<p>On Android XR, signing in with Google admits only the addresses the team has invited, subject to a receiver-local blocklist and tester limit. Google confirms who you are, not that you may test.</p>

<h2>Contact</h2>
<p>For questions about this notice or your recordings, ${reach}.</p>
</main></body></html>
`;
}

export function sendPrivacy(res: ServerResponse, contact: string | undefined, joinSite?: string, videoDays?: number): void { sendPage(res, privacyHtml(contact, joinSite, videoDays)); }

/** A public page of the receiver's own: cached for an hour, and allowed nothing but its inline style. */
export function sendPage(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'public, max-age=3600',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}
