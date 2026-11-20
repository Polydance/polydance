/**
 * The getting-started page, served at /start (Robin, 2026-11-10): the one link to send someone new, and the page
 * their Welcome thread's launch opens in the headset (welcome.ts), so their first recording is a look round it.
 * It says what a tester does, in the order they do it, and is the same on any receiver: it names no host and
 * reads nothing from the request, only the contact POLYCAP_PRIVACY_CONTACT gives. It has the privacy notice's
 * look (privacy.ts), which tests/design.test.ts holds to design/tokens.json. Change it when the app or the
 * Welcome changes what a newcomer sees.
 */
import type { ServerResponse } from 'node:http';
import { escape, PAGE_STYLE, sendPage } from './privacy.js';

const UPDATED = '2026-11-20';

export function startHtml(contact: string | undefined): string {
  const ask = contact
    ? `the person who invited you, or email <a href="mailto:${escape(contact)}">${escape(contact)}</a>`
    : 'the person who invited you';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Getting started with Polydance</title>
<style>
${PAGE_STYLE}
ol > li { margin: 0.5em 0; }
</style></head>
<body><main>
<h1>Getting started with Polydance</h1>
<p class="meta">For testers on Meta Quest. Updated ${UPDATED}.</p>
<p>Polydance is for showing and telling. You wear the headset, say what you think of what you see and point at it, and Polydance turns the recording into something a coding agent can read: your words with their times, and the frames at the moments you pointed. People and their agents ask for your view in threads, and you answer by recording.</p>

<h2>Get set up</h2>
<ol>
<li>Send the email address of your <strong>Meta account</strong> to the person who invited you. They add you to Polydance's test channel.</li>
<li>Accept the invitation Meta emails you, signed in to that same account. Meta's test channels are for people aged 18 or over.</li>
<li>In the headset, open your <strong>Library</strong>. Polydance appears there once the invitation is accepted, which can take a few minutes. Install it.</li>
<li>Open Polydance. It signs you in with your Meta account; there is nothing to type.</li>
</ol>

<h2>Your first two minutes</h2>
<p>Your inbox has a thread called <strong>Welcome to Polydance</strong>. Open it and press <strong>Record and open</strong>.</p>
<ol>
<li>The first time, Polydance shows what it records and asks you to agree, then asks for the microphone. The headset then asks whether to capture the screen: say yes.</li>
<li>Polydance opens this page in the browser. Look round it and say what is unclear or missing. Point at things and say "this".</li>
<li>Come back to Polydance and press <strong>Stop</strong>. A minute or two later, Polydance answers in the thread with what it made of your recording and what to do next.</li>
</ol>

<h2 id="invited">Invited by email?</h2>
<p>If someone added your email address to one of their threads, Polydance emailed you about it. To take part:</p>
<ol>
<li>Get set up as above. If your Meta account uses a different address from the one the invitation came to, reply to the invitation with it, so they can add you to the test.</li>
<li>In Polydance, tap the circle in the corner and enter the address the invitation came to.</li>
<li>Polydance emails you a link to confirm it. Open it and press <strong>Confirm</strong>: the threads people invited that address to appear in your inbox, and so will any they invite it to later.</li>
</ol>

<h2>How threads work</h2>
<ul>
<li>A <strong>thread</strong> is one piece of work, oldest message first, like an email conversation. People show as a circle, coding agents as a square.</li>
<li>A message can come with something to try. <strong>Record and open</strong> starts recording and opens it; <strong>Just open</strong> opens it without recording. When a message offers options, star the one you prefer.</li>
<li>React to any message with ❤️ 👍 👎 😂 ‼️ or ❓.</li>
<li><strong>New thread</strong> starts one of your own: record yourself describing what you want. Until you have a project of your own it goes in <em>Getting started</em>, where only you and the team that runs this server see it.</li>
<li>When someone adds you to one of their threads, it appears in your inbox. Add your email address (the circle in the corner) and confirm it, and people can invite you by address too.</li>
<li><strong>Archive</strong> closes a thread for everyone in it until someone adds to it; <strong>Delete</strong> takes it off your inbox.</li>
<li>The <strong>bug key</strong> on the deck records a bug or an idea about Polydance itself and sends it to the Polydance team.</li>
<li><strong>Reply notices</strong> are off until you turn them on behind the gear. While Polydance is closed, the headset checks for replies every 15 minutes.</li>
</ul>

<h2>Tips for a good recording</h2>
<ul>
<li>Talk as you go: what you are doing, what you expected, what surprised you.</li>
<li>Point with the controller or your hand and say "this" or "that": Polydance keeps the frame from that moment.</li>
<li>Some words mark the moment for whoever reads it: "bug", "it would be nice", "we don't need", "copy this".</li>
<li>Short is fine. One thing per recording is the easiest to act on.</li>
</ul>

<h2 id="your-agent">Your own coding agent</h2>
<p>Polydance is at its best with a coding agent of your own, such as Claude Code, working on your own projects: the agent posts a build to a thread, waits for your recording, reads it and answers with the next version. You connect it yourself.</p>
<ol>
<li>On your computer, install <strong>polycap</strong>, Polydance's command-line tool. It comes with Polydance's source code, at <a href="https://github.com/Polydance/polydance">github.com/Polydance/polydance</a>; its <strong>docs/AGENT-SETUP.md</strong> says how, or ask ${ask}.</li>
<li>In the headset, press <strong>Connect your agent</strong> on the card at the top of your inbox, or open the menu (the three lines) and choose <strong>Agents</strong>. Polydance shows a code that works once, for ten minutes. If you see neither, update Polydance: this needs a version newer than 0.22.0.</li>
<li>On your computer, type <strong>polycap connect</strong> followed by the code. Your agent can now read your threads and recordings and post in them, as you, and nobody else's.</li>
<li>Type <strong>polycap install-skill</strong>, then make a project for your own work and link your code to it: <strong>polycap project new "My project" --host my-preview.example.com</strong>, then <strong>polycap link</strong> with the key it prints. The host is where your builds are served; a link to anywhere else is refused.</li>
<li>Ask your agent to use Polydance. It posts a build to a thread, which appears in your inbox with <strong>Record and open</strong>.</li>
</ol>
<p><strong>Agents</strong>, in the menu, lists the computers you have connected and disconnects one. You can connect five, and each connection lasts 90 days.</p>

<h2>Your recordings and your privacy</h2>
<ul>
<li>A recording shows what you see in the headset, which can include the room you are in, and what you say. The people in its thread see it, and so does the team that runs this server.</li>
<li><strong>Delete</strong> on a recording removes it from the headset and from the server.</li>
<li>You have a storage allowance. When it is full, Polydance stops recording until you delete older recordings.</li>
<li>The <a href="/privacy">privacy notice</a> says what is recorded, where it goes and how long it is kept.</li>
</ul>

<h2>Help</h2>
<p>If anything here does not match what you see, or you are stuck, ask ${ask}. Saying so in a recording works too: that is what Polydance is for.</p>
</main></body></html>
`;
}

export function sendStart(res: ServerResponse, contact: string | undefined): void { sendPage(res, startHtml(contact)); }
