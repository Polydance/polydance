# Hosted receiver (proof of concept)

One user, one server: Robin records on the Quest, the recording uploads by itself, the server builds
the bundle, and `polycap sync` brings it down for Claude Code. Decided with Robin on 2026-10-01: host
on a server of Robin's, transcribe with Gladia, and give the headset app a recordings list with upload
status. Opening it to other people is later work with its own prerequisites (see the end).

## Google sign-in for Android XR testers — built 2026-10-16, not deployed

The receiver can take Android XR testers who sign in with Google, beside Meta's Quest testers. It is off
unless both of these are set in its environment ([.env.example](../.env.example)):

- `POLYCAP_GOOGLE_CLIENT_ID` is the **web** OAuth client ID from Google Cloud. The app is built with the
  same ID. It is not a secret, and no client secret is used.
- `POLYCAP_GOOGLE_TESTERS` is JSON: `projects`, `invited` (addresses), and optionally `maxTesters`,
  `maxBytes`, `blocked`, and `people` (an invited address mapped to someone in `POLYCAP_USERS`).

`POST /v1/testers/google` takes `{ idToken, nonce, deviceId, label? }`. The receiver checks the token
against Google's published keys: RS256, Google's issuer, this client as audience, expiry, the nonce and
a verified address. It uses each token once, then admits the address only if it is invited and not
blocked, up to `maxTesters`. It answers like the Meta route: 201 with a token, or 403 with `reason`
`unverified`, `not_invited`, `blocked` or `full`, or 502 `google_unavailable` when Google's keys cannot
be fetched. Grants are `google-<sub>`, kept in `google-testers.json` (0600). Admission is checked on
every request, so removing or blocking an address takes effect at the next restart. The tester's
verified address is set on their person, which makes them a participant in threads that invited it
([THREADS.md](THREADS.md)).

Deploying it is Robin's go-ahead, following [Operating it](#operating-it), once the Google Cloud
clients exist (`private/docs/PLAY.md`). Tested only against a stand-in for Google's keys, `tests/google.test.ts`.

## Shape

```
Quest: Polydance app                         the server (container)                    Mac
  Stop -> WorkManager job  --- HTTPS --->    polycap serve                             polycap sync
  8 MB chunks, resumable                       uploads/<id>  verify sha256            (skill runs it)
  recordings list + status <-- status ---      worker: createSession + pipeline  --->  ~/PolydanceCapture/sessions/<id>
                                               transcribe: Gladia (narration only)
```

The structural rule holds. The HTTP upload is a transport; the server's worker calls the same
receiver as `polycap import` (createSession) and the same pipeline as `polycap process`. `polycap sync`
is a transport like `pull`. Nothing in `src/pipeline/` knows a video arrived over HTTP; `session.json`
records it as `source.kind: "upload"` with the upload and client ids.

## The getting-started page

`GET /start`, without a token (2026-11-10): the one link to send someone new, and the page their Welcome
thread's launch opens in the headset ([THREADS.md](THREADS.md#the-welcome)). It says, in the order a tester
meets them: what Polydance is; getting set up on Quest (send the Meta account's address to whoever invited
you, accept Meta's invitation, install from the Library, open the app); the first two minutes in the Welcome;
how threads work; tips for a good recording; their own coding agent (`#your-agent`: since 2026-11-20 the five
steps of [connecting one themselves](THREADS.md#connecting-your-own-agent), not yet deployed, with the sentence
that `polycap` comes with the source code, which is not public); and privacy, linking `/privacy`. It names no host and reads nothing from the request, so any receiver
serves it as it is; its contact is `POLYCAP_PRIVACY_CONTACT`. It has the privacy notice's look, checked against
`design/tokens.json` by `tests/design.test.ts`. nginx needs `location = /start`, as in the
[example](../deploy/receiver/nginx-site.conf.example). The steps for Meta's invitation and the Library are
from `private/docs/STORE.md`, not yet walked by a new tester.

`POLYCAP_WELCOME` turns the Welcome on; [deploy/receiver/enable-welcome.py](../deploy/receiver/enable-welcome.py)
sets it with the START project (the receiver's own host among its hosts, which the Welcome's launch needs) and
puts START first in the testers' default projects, and START in every linked Meta account's projects (a linked
legacy token with no projects reaches every project, so the account must cover START or the receiver will not
start); `--start-only` makes START the testers' only default, and is refused while a tester mapped to a person has
no `accounts` entry of their own. Recreate the container afterwards.

## Email

Off unless `POLYCAP_MAIL` is set (2026-11-10, [THREADS.md](THREADS.md#invited-by-email)). It is JSON:
`{"provider":"ahasend","accountId":"…","from":{"email":"invitations@mail.polydance.net","name":"Polydance"},"replyTo":{"email":"…"},"tags":["polydance"],"sandbox":false}`,
with the key in `POLYCAP_AHASEND_KEY` (secret; `aha-sk-…`) and `POLYCAP_PUBLIC_URL`, the receiver's own address
for the links (`https://capture.polydance.net`). `provider: "folder"` writes each email to `mail-outbox/` instead
and sends nothing, for trying the flow on this Mac (then `POLYCAP_PUBLIC_URL` may be `http://localhost:…`).
Each send has an Idempotency-Key, open and click tracking off and the `polydance` tag; a refusal is recorded
with AhaSend's words, never the key. `sandbox: true` has AhaSend check and accept each email and deliver none.

AhaSend is shared with another project of Robin's, so Polydance's mail is kept apart: a Polydance sub-account
if the plan has them (its own domains, suppressions and reputation), else a sending domain of its own
(`mail.polydance.net`) in the same account; either way a key scoped only to `messages:send:{that domain}`,
which AhaSend refuses for any other domain, and the tag on every message. nginx needs `location ^~ /email/`
(GET and POST), as in the [example](../deploy/receiver/nginx-site.conf.example).

**The sending domain, ready 2026-11-11 (at Robin's go-ahead, by Claude).** Robin's AhaSend account is on the Pro
plan and already sends for two other projects, each from domains of its own with a key that may send only from
them; its dashboard offers no sub-accounts (the API does), so Polydance follows the same pattern. Added
`mail.polydance.net` there as a transactional domain, and in Route 53 (zone `polydance.net`, change
`C00049029DDOSJPX5YVU`): the SPF TXT on `mail.polydance.net` (`v=spf1 include:spf.ahasend.com ~all`), the DKIM
CNAMEs `ahasend._domainkey.mail` and `ahasend2._domainkey.mail` (the second for AhaSend's key rotation), the DMARC
TXT on `_dmarc.mail` (`p=quarantine; sp=none; adkim=r; aspf=r`) and the return path `psrp.mail` → `rp.ahasend.com`.
Not added: AhaSend's tracking, media and subscription-page domains and an MX (tracking is off, and the stop page
is the receiver's own). polydance.net's own MX (Amazon SES inbound) is untouched. AhaSend's first checks saw
SPF and DMARC and waited about two minutes for its own DKIM key to be published behind the CNAME; at 12:40
(AhaSend's clock) it showed **Ready to send**, all five records in place. Still to do: the API key, scoped
to `messages:send:{mail.polydance.net}` only, which Robin makes and saves on his Mac himself.

**The key, 2026-11-11.** Robin made it (`polydance`, Send Messages only from `mail.polydance.net`) and saved it to
`~/.config/polycap/ahasend-key` (0600). Checked from this Mac with two sandbox sends, which deliver nothing: from
`news.promptfrenzy.com` refused with 403 ("not authorized to send messages from the domain"), from
`mail.polydance.net` accepted with 202. Image `polycap-receiver:e8b2ad6` (main's tip) is built on the receiver's host.
Turning email on waits for Robin to run `enable-mail.py` from his own terminal, so the key goes to the server
over SSH without passing through an agent; Claude's attempts were refused by its permission checks.

**Live in sandbox, 2026-11-11 17:44 UTC.** Robin ran `enable-mail.py --sandbox --test-person` from his terminal at
12:55 (backup `receiver.env.bak-2026-11-11-125536`; the key replaced from stdin; `newcomer-test` added to
POLYCAP_USERS). At his request Claude then ran `private/deploy/receiver/nginx-email-pages.py`
(`location ^~ /email/`; `nginx -t` passed, reloaded; backup `polydance-capture.bak-2026-11-11-174335`) and swapped
the container to `polycap-receiver:e8b2ad6` (old one kept as `capture-receiver-pre-mail-20261111`); the settings
were already the container's, since another session's swap that afternoon had read them. Then `add-token.py` added
the Test newcomer's member token (`newcomer-test`, upload, START; the token itself only in Robin's
`~/.config/polycap/tokens/newcomer-test`), and a second swap read it (`capture-receiver-pre-newcomer-20261111`).
Checked: `/v1/health`, `/start` and `/privacy` 200, `/v1/projects` without a token 401, `/email/stop/x` the
receiver's own 404 page; the start-up line says `email AhaSend (sandbox: nothing delivered)`. A sandbox invitation
from a throwaway thread, CAP-14 (closed after), showed `emailed`; the Test newcomer's token answered `polycap me`,
and setting `sandbox-newcomer@example.com` on it queued a confirmation with no failure logged. Nothing delivered.

**Live, 2026-11-11 17:50 UTC.** At Robin's choice replies go to his Gmail: `enable-mail.py --live --reply-to …`
(the key kept; backup `receiver.env.bak-2026-11-11-175010`) and a swap (`capture-receiver-pre-live-mail-20261111`);
the start-up line says `email AhaSend, from invitations@mail.polydance.net`. The first real emails, both to one of
Robin's own `+` addresses: an invitation to CAP-15 ("Email test", which shows it `emailed`), and the confirmation
link, from setting that address on the Test newcomer with `polycap me`; no failure was logged. **Robin confirmed
it from Gmail the same evening:** both emails arrived, he pressed Confirm on the link's page, and the Test
newcomer's address then read `confirmed` and CAP-15 was in its thread list, unread: the whole way in by email,
end to end, on the live receiver. **The stop link, the same evening:** an invitation to CAP-15 for a second `+`
address arrived; Robin's first press of Stop met a 502 from nginx, because another session was swapping the
container at that moment (the request never reached the receiver); pressed again, the page answered (GET 200, POST
200), and asking to invite that address again was refused, `this address asked Polydance to stop emailing it`, with
nothing sent. Not yet tried: a headset's account sheet in place of `polycap me`, and anyone else's inbox. Swaps by
parallel sessions interrupt anyone using the receiver for the few seconds a new container takes to start.

## Asking to join

Off unless `POLYCAP_JOIN` is set (2026-11-11, `src/server/join.ts`): the homepage's form posts to `POST /join`, a
public route like `/start`, which checks it against bots without a third party, keeps it in `join.json` and emails
the team through the same mailer, so it needs `POLYCAP_MAIL`. `private/docs/SITE.md` has the
details: `deploy/receiver/enable-join.py` for the setting and `nginx-join.py` for `location = /join` with its rate
limit. **Live since 2026-11-11** in image `polycap-receiver:c544917`, notifying Robin's Gmail; checked with one
request from the live homepage (kept as emailed, AhaSend's message id recorded; Robin confirmed it reached his Gmail).

With `POLYCAP_JOIN` set, the privacy notice also says how the homepage counts visits with Google Analytics, asked
for first (`private/docs/SITE.md`). **Live since 2026-11-12, 15:04 UTC** in image
`polycap-receiver:0729529`, at Robin's word: built from `main`, the dry run of `recreate.py` found no setting or key
different; the swap waited for a Vision Pro upload to finish (no upload in the last 3 minutes), then replaced
`9affa3e`, kept stopped as `capture-receiver-pre-analytics-20261112`. After: health 200, `/v1/projects` without a
token 401, `/start` 200, `/privacy` with "Counting visits to the website", no errors at start-up.

## Where data goes

| What | Where | For how long |
| --- | --- | --- |
| The recording (video, mic track, app-audio track) | The headset until you delete it in the app; the server's library | No automatic deletion on either yet |
| Narration audio only (16 kHz mono wav of track 1) | Gladia, for transcription | The job and its audio are deleted at Gladia right after the transcript is read; the step note says whether that worked |
| Transcript text only (numbered `[L12] words` lines; `[mm:ss]` before 2026-10-12), when summaries are on | Anthropic's API, for a title, one sentence and the list of requests | Anthropic's API retention for API inputs; nothing else is sent, and nothing is sent while `POLYCAP_SUMMARIZER` is `none` |
| Pointing frames (at most 24 a recording, full size where there is a copy) with the line being said, when `POLYCAP_POINTING` is `claude` | Anthropic's API, to name what the ray or hand points at | Anthropic's API retention for API inputs. Frames show passthrough, so the room can be in them; nothing is sent while `POLYCAP_POINTING` is `none` |
| The bundle (frames, transcript, markers, manifest) | The server; your Mac after `polycap sync` | Until deleted by hand |
| The video on your Mac | Only with `polycap sync --video` | Until deleted by hand |
| Tokens | The headset's app-private preferences; `~/.config/polycap/env` (read token); the server holds only sha256 hashes | Until removed from POLYCAP_SERVER_TOKENS |
| Email addresses (2026-10-12): a person's own, typed on the headset, and those added to threads | The server only: `people.json` in the receiver's root and each thread's file (0600); shown to the thread's members and the team, never logged or put in the event feed; the headset keeps the addresses copied into a new thread beside its recording (`invite.json`) until the upload adds them | Until cleared by the person or taken out of the thread. Since 2026-11-10 the team's additions are emailed an invitation and a person's own is emailed a link to confirm it ([THREADS.md](THREADS.md#invited-by-email)) |
| An email (2026-11-10): an invitation's address, who added it and the thread's title; or a confirmation link | AhaSend, which sends it from Polydance's own sending domain; open and click tracking off | AhaSend's retention for sent mail; the receiver's outbox in `mail.json` keeps each for 90 days |
| A recording played in the headset (2026-10-12) | Streamed from the server by range to a member of its thread; the player keeps no copy | Nothing is stored on the playing headset |
| 3D models pushed with thread messages (2026-10-19) | The server's `thread-models/<PROJECT>/<sha256>.glb`; a headset that opens one keeps a checked copy in the app's private files | The server: until removed by hand (no route deletes them yet). The headset: its eight most recently opened ([THREADS.md](THREADS.md#models)) |

The capture includes passthrough, so recordings show the room. Everything is private by default:
directories 0700, files 0600, no public URLs, every route but `/v1/health` needs a token.

## Who can reach whose recordings (auth audit, 2026-11-12)

Robin asked, before more people join, whether anyone could download someone else's calls or recordings. Checked
by Claude from the code (every receiver route, the thread store's visibility rules, tokens, Meta and Google
sign-in, the email pages, `/join`, the headset app's intents, the Mac and the iPhone), with throwaway probes
against a local receiver, and against the live one from outside **without a token** only. The live settings
were not read (the permission check refused reading the container's environment over SSH), so the token list
below is the [table](#tokens), not a fresh read.

- **Without a token, nothing.** On capture.polydance.net every `/v1` route but `/v1/health` answered 401, a
  made-up token too; port 8790 is not reachable from outside (bound to 127.0.0.1); plain http redirects to https.
- **A tester reaches only their own threads.** Meta and Google testers, and `--member` tokens, are
  thread-scoped: every other thread, recording, photo, model and session is the same 404 as one that does not
  exist. Their tokens are upload only, so `/v1/sessions` is a 403; `/v1/uploads` lists only their own.
- **The whole library** needs a `read` token that is not thread-scoped: `mac` and `mac-capture`, both Robin's.
- **Calls never reach the receiver**: `polycap upload` refuses them, and nothing on the Mac or the iPhone
  listens on the network. The library is 0700 and saved tokens 0600 (checked on this Mac).
- **The headset app**: a store build ignores the adb-only intents, so another app on the headset cannot point
  its uploads at another server or start a recording.
- **Fixed: taking someone's address.** Anyone could enter a member's address, and if its owner pressed the
  emailed link thinking it their own, have every thread it was invited to. Now one confirmed address is one
  person's ([THREADS.md](THREADS.md#invited-by-email)). **Live since 2026-11-12 09:34 UTC** at Robin's go-ahead:
  image `polycap-receiver:e95f6bb` (main's tip) swapped in by `recreate.py --image` (no setting differed, no upload
  in the last three minutes; the `c544917` container kept stopped as `capture-receiver-pre-address-fix-20261112`).
  After it: `/v1/health` 200, `/privacy` and `/start` 200, every other `/v1` route 401 without a token; the
  start-up line had 7 tokens (the 6 in `POLYCAP_SERVER_TOKENS` and the signed-in Meta tester's headset), Meta sign-in with 1 tester, threads MUS, PD, CAP, START, PF, and no errors; the
  `mac-capture` token saw 47 threads, and the Test newcomer's thread-scoped token one (CAP-15) and a 403 from
  `/v1/sessions`. The fix itself was not tried on the live receiver, which would have changed a real address.
- **Compared with other apps** the same day ([SHARING-SECURITY-RESEARCH.md](SHARING-SECURITY-RESEARCH.md)): in line with
  the strictest on files, invitations and hidden things; behind on token expiry, revoking a blocked tester at once, and
  making thread scope the default.
- **Since 2026-11-12, someone added later sees only what came after** ([THREADS.md](THREADS.md#who-sees-a-thread)),
  on every route, sync included. Live since 10:23 UTC that day (image `f3e9de5`). Since 10:31 UTC (image `98fe97e`): the
  team chooses per add, and the choice is kept, so `POLYCAP_NEW_MEMBER_HISTORY` sets only the
  default for people added after it changes.
- **Open, Robin's call: members inviting.** Any member of a thread, a tester included, can add an address, and a
  confirmed one is let in at once, unemailed. A tester in a shared thread can so let another tester see every
  recording in it. Designed this way ([THREADS.md](THREADS.md#people-email-and-participants)), as email works.
- **Tokens made without `--member`, closed 2026-11-12 (Robin chose it from the research).** A token for someone
  outside the team made without `--member` lists every thread in its projects, every project when it names none,
  with titles and snippets, and one reply in a thread makes it a member that plays every recording there. That
  was what `polycap token new` made by default; now it refuses to make a token unless told `--member` or `--team`
  ([Tokens](#tokens)). None of the live tokens is anyone else's: Robin listed them from his terminal on 2026-11-12 (ids and
  scopes only): `quest3`, `aura` and `iphone` upload, `mac` read and post, `mac-capture` upload and read, all user
  `robin`; and `newcomer-test`, upload, thread-scoped, START (the Test newcomer). Since 2026-11-12 also `visionpro`, upload, user `robin`, the Vision Pro's (below).
- **Checked again for the first outside tester, 2026-11-17 (Robin asked).** They are a Meta sign-in mapped to nobody, so their person is
  their `meta-…` id, which no team token can name (the receiver refuses to start with a `meta-` id in
  `POLYCAP_USERS` or `POLYCAP_SERVER_TOKENS`): they are thread-scoped and upload-only by construction. This Mac's
  `polycap` token (the team's), with GETs only, found them in two of the 44 threads it lists: their Welcome (START-2) and MUS-31, added by
  Robin with what came before; neither holds a recording that day. Every route since the audit (photos, own
  projects, logs in a take) was read again and goes through the same visibility check. `tests/outsider.test.ts`
  now signs in a newcomer shaped like them and tries every route that could hand over a recording, its words, a
  frame, a photo or a model in a team thread he is not in, another project and a report: each is the 404 of a
  thread nobody opened, or a 403 for `read`, and no answer holds anything of them; breaking the scoping rule or the
  uploads check fails it. `npm run check` 36 files, 639 passed. Not read: the live token list and the receiver's
  log of what his token asked for (both refused to Claude by the permission check).

## Tokens

`polycap token new --id NAME --member|--team --scope upload|read|post [--project KEY ...]` prints the token once
and the JSON entry for the server. Since 2026-11-12 it must be told who the token is for: `--team` for Robin's own
devices and agents, `--member --user ID` for anyone else (below); with neither, or both, it makes nothing.

**Tokens expire (built 2026-11-12, Robin chose it from [the research](SHARING-SECURITY-RESEARCH.md)).** `polycap token
new` gives a token 90 days unless `--expires` says otherwise: a number of days (`30d`, up to ten years), a date
(`2027-02-10`, to the end of that day UTC), or `never`, for Robin's own devices, whose tokens would otherwise stop
uploading. The entry then carries `expiresAt`. From that moment the receiver answers the token with a 401,
`reason: "expired"`, "this token expired on 2027-02-10; ask whoever gave it to you for a new one", on every route
that needs a token, and logs it once per run by id. `GET /v1/me` says when the token expires (`expiresAt`, null for
never), and `polycap me` prints it. Each start-up lists tokens that have expired and those that will within 14 days.
An entry without `expiresAt` never expires, so every token made before this works as before.
[add-token.py](../deploy/receiver/add-token.py) takes `expiresAt` and refuses one already past. **A receiver older
than this refuses `expiresAt` at start-up** (recreate.py then puts the old container back), so deploy it before
adding a token that expires, and take such tokens out before rolling back past it. Verified 2026-11-12 by
`npm run check` and add-token.py against a scratch env file. **Live since 2026-11-12 11:20 UTC** at Robin's go-ahead
(image `polycap-receiver:40c7304`, main's tip, which also took the receiver's side of the `capture-hosted-2` consent
notice live, at his OK; the `98fe97e` container kept stopped as `capture-receiver-pre-expiry-20261112`). Checked
after: `/v1/me` says `expiresAt: null` for `mac-capture` and `newcomer-test` and `polycap me` prints "never
expires"; no token has an expiry, so the start-up names none; `/privacy` has the new wording; the Test newcomer still
sees only CAP-15 and gets a 403 from `/v1/sessions`. No live token has an expiry yet. The server accepts the tokens listed by hash in `POLYCAP_SERVER_TOKENS`;
removing an entry revokes it on the next request. `projects` limits which projects' threads a token
sees, and the first is where its new recordings' threads go; without it, every project.

| Token | Scope | Lives in |
| --- | --- | --- |
| `quest3` | upload: create uploads, send chunks, read its own uploads' status; read its threads, react, close | the app, sent once with `npm run app -- configure` from `~/.config/polycap/quest3.token` |
| `mac` | read: list sessions, download bundle files, see all uploads, read threads; post: open threads, post messages with launches | `~/.config/polycap/env` as POLYCAP_REMOTE_TOKEN |
| `mac-capture` | upload and read, user `robin`, label Mac, every project: `polycap upload`, the Mac app's walkthroughs sent as thread replies; live since 2026-11-11 18:15 UTC | `~/.config/polycap/tokens/mac-capture`, named by `POLYCAP_UPLOAD_TOKEN=mac-capture` in `~/.config/polycap/env` |
| `iphone` | upload, user `robin`, label iPhone, every project: Polydance for iPhone's recordings, threads, reactions and picks ([IPHONE.md](IPHONE.md) P1); live since 2026-11-07 22:45 UTC | made with `polycap token new --id iphone --scope upload --user robin --label iPhone --save iphone` into `~/.config/polycap/tokens/iphone`; on the phone only in its Keychain, put there by scanning `npm run ios -- pair` |
| `visionpro` | upload, user `robin`, label Vision Pro, every project, no expiry: Polydance for Vision Pro's recordings, threads, reactions and picks ([VISIONOS.md](VISIONOS.md)); live since 2026-11-12 13:26 UTC | made with `polycap token new --id visionpro --team --scope upload --user robin --label "Vision Pro" --expires never --save visionpro` into `~/.config/polycap/tokens/visionpro`; on the headset only in its Keychain, put there by `npm run visionos -- configure` |

`user` names the person a token belongs to (`POLYCAP_USERS`: id, name and an avatar colour); its label
then names only the device or machine ("Quest 3", "Mac"), and messages read "Robin · Quest 3" or, for
an agent that passes `--as`, "Opus 5.5 on Robin's Mac". `polycap token new --save NAME` writes a token to
`~/.config/polycap/tokens/NAME` (0600) instead of printing it; a repository names it in `.polycap.json`
so its agent posts with its own token, limited to its project.

**Tokens for people outside the team (built 2026-10-21, live 2026-11-02 in `3a3b5e9`).** `read` is the whole library and
`read` or `post` makes a token the team's: it sees reports and is a member of every thread in its
projects. That is for Robin's own tokens only. For anyone else, `polycap token new --member --user ID`
adds `"threads": "member"`: the token reaches only the threads its person is a member of
([THREADS.md](THREADS.md#who-sees-a-thread)), whatever its scopes. With `read` it lists and syncs only the
sessions behind recordings in those threads; `GET /v1/sessions`, `…/files`, `…/files/<path>`, `…/frame` and
`GET /v1/uploads` leave out or 404 every other one, and `GET /v1/account` is its own. With `post` it
replies in those threads and may open one in its projects, which then has its person as a member. It never
sees a report. A tester's own agent, on their own machine, is `polycap token new --id ana-agent --user ana
--member --scope read --scope post --project MUS`, with `ana` in `POLYCAP_USERS`; their `polycap sync` and
`polycap thread` then work as Robin's do, on their threads alone. Meta and Google testers are thread-scoped
the same way without a flag, unless their person also holds one of the team's tokens (Robin's own Meta
sign-in, mapped to `robin`), and so is a legacy upload token linked to a tester's Meta account in
`POLYCAP_META_TESTERS.accounts`. Verified by `npm run check` (tests/threads, people, receiver and testers). Before the
2026-11-02 deploy the live receiver had one Meta tester, mapped through `accounts` to `robin`, who holds
a team token, so nobody's view changed; no `--member` token and no Google sign-in were configured.
Thread-scoped behaviour itself has not been exercised on the live receiver.

### Agents people connect themselves

Built 2026-11-20 at Robin's "Yes, build it", on `main` since that day; verified by `npm run check`
alone (`tests/agents.test.ts`); **not deployed**, and no released headset app asks for a code yet: the one that
does is built on the same branch ([THREADS.md](THREADS.md#connecting-your-own-agent) has the design, the headsets'
side and what was and was not exercised).

- **What it is.** Someone with a device token (`upload`: a Meta or Google sign-in, or a headset or phone token
  from the table above) asks `POST /v1/agents/codes` for a one-time code, and `polycap connect CODE` on their
  computer redeems it at `POST /v1/agents`, which takes no token, for a `read` and `post` token of that
  machine's own. No line is added to `POLYCAP_SERVER_TOKENS` and nothing is restarted. The token is their
  person's (`meta-…` for a newcomer), thread-scoped, with no team project, and lasts 90 days.
- **Where.** `agents.json` in the receiver's root beside `testers.json` (0600): each agent's id (`paired-<8
  hex>`), person, the token's sha256, label, when and from which device it was connected, its expiry and the day
  it was last used. It is read at start-up, and one that does not parse stops the receiver. The start-up line
  says how many are connected. Codes are held in memory only.
- **Stopping one.** Its person disconnects it (`DELETE /v1/agents/:id` from a device, `polycap disconnect` from
  the agent's machine). Blocking or removing the person's sign-in stops all of theirs on the next request. To
  remove one agent yourself: stop the receiver, take its entry out of `agents.json`, start it.
- **On only with threads.** Without `POLYCAP_PROJECTS` the routes answer 404 and `agents-v1` is not advertised.
- **Behind nginx.** The limit on tries is per sender, read from `X-Real-IP` when the request comes from this
  machine, as `/join` does; `deploy/receiver/nginx-site.conf.example` sets it for every route. Without it every
  request looks like one sender, and ten tries in ten minutes is the limit for everyone together.
- **Before deploying.** No id in the live `POLYCAP_SERVER_TOKENS` may start `paired-`: the new receiver refuses
  one at start-up (recreate.py then puts the old container back). The same deploy brings `POST
  /v1/projects/:key`, which lets a project's owner change its hosts and packages, and the new words on `/start`
  and in the Welcome's follow-up, which tell a newcomer to press Connect your agent or open Agents. Those are in
  no released app (0.22.0 has neither), so the page says they need a newer Polydance. Deploying the receiver first
  is safe: an older app ignores `agents` on `GET /v1/threads`. Releasing the app first is safe too: it offers
  nothing until the receiver says `agents: true`.
- **Rollback.** An older receiver ignores `agents.json`, so every connected agent's token is unknown to it (401)
  until it is rolled forward; nothing is rewritten, and the file is left as it was. A project whose hosts were
  changed keeps them: `projects.json` has the same shape as before.

Threads are on when `POLYCAP_PROJECTS` lists projects, each with the hosts and packages its launches
may open ([THREADS.md](THREADS.md)); a token naming a project that is not listed stops the server at
start-up. `POLYCAP_REPORTS` names the project reports from the headset's bug key go to (one of those
projects, CAP intended; [THREADS.md](THREADS.md#reports)); unset, the receiver refuses reports. Only
the team's `read` and `post` tokens see a report (never a thread-scoped one); `deploy/receiver/enable-reports.py` sets it; on capture.polydance.net
Robin set it to CAP at 17:33 BST on 2026-10-12; the receiver that reads it went live at 18:07 BST
(`private/docs/STORE.md`).

## API

See the top of [src/server/http.ts](../src/server/http.ts). In short: `POST /v1/uploads` with client
id, bytes, sha256, file name, recorded-at and device; `PUT /v1/uploads/:id/content` with
`Content-Range: bytes a-b/total` where `a` is what the server already has (a 409 says the right
offset); `PUT /v1/uploads/:id/narration` with the narration declared at create, whole, before the
video (words first, see [THREADS.md](THREADS.md#receiver-api)); `PUT /v1/uploads/:id/logs` with the
headset's log declared at create, whole, before anything else, and an upload with no media file at all
for a take of logs alone ([LOGS.md](LOGS.md#upload)); `GET /v1/uploads?clientId=` (each with
`steps { done, total }` of its bundle's pipeline, the title and summary once there are some, and
`narration: expected | received` when one was declared); `GET /v1/sessions` (`ready`, or `words` while
only the narration's steps are done), `/v1/sessions/:id/files`,
`/v1/sessions/:id/files/<path>`. A client id is `<install id>-<run name>`, so retries never make a
second upload. The server keeps one worker; uploads arriving during processing wait their turn.
Threads, messages, reactions and the event feed are at the top of
[src/server/thread-routes.ts](../src/server/thread-routes.ts) and in [THREADS.md](THREADS.md); an upload
names its thread with `thread`, or starts a new one.

## Run it on this Mac (what was tested first)

The Mac stands in for the server, in its own library so it behaves like a remote one. The Quest reaches
it over the home network; debug builds of the app may use plain HTTP to a 192.168/10/172.16 address.

```bash
POLYCAP_ROOT=$HOME/PolydanceCapture-server POLYCAP_TRANSCRIBER=none npm run polycap -- serve --host 0.0.0.0
```

```bash
npm run app -- configure --server http://192.168.1.179:8790 --token-file ~/.config/polycap/quest3.token
```

```bash
polycap sync
```

Port 8787 is taken on this Mac by an unrelated local Python service, so the receiver defaults to 8790.

### Verified 2026-10-01 on the LAN

Quest 3 (Android 14) to this Mac running `polycap serve` (transcriber none), over home Wi-Fi:
`npm run app -- install` and `npm run app -- configure` over Wi-Fi adb, then the 80 s three-track recording
`20261001-161948` queued with the adb UPLOAD action. 82,465,272 bytes in 8 MB chunks in about
6 s, verified by sha256 on the server, bundle built (probe, audio, 17 frames at interval), headset
status went waiting, uploading, uploaded, ready, with the session id. `polycap sync` downloaded 21
files (0.8 MB, no video) into `~/PolydanceCapture/sessions` and `polycap show latest` read it. The token
does not appear anywhere in the headset's logcat. Not exercised: Gladia for real, an interrupted
upload on the device (the receiver tests cover a cut connection), the release build over HTTPS.

### Gladia verified 2026-10-01

The same session reprocessed on the receiver with `POLYCAP_TRANSCRIBER=gladia` and the Polydance
account's key: 5 segments with correct clocks, narration only (none of the app's sound), frames
re-chosen from the transcript (7), and the step note "Gladia job deleted at Gladia". `polycap sync`
then replaced the local bundle and removed the 16 frames the server no longer had.

### Reading improvements, verified on a real session (2026-10-01)

After `33c2186` was deployed, the design-pass recording of 2026-10-01 22:12 was
reprocessed on the receiver (`docker exec capture-receiver node bin/polycap.js process <id> --force`;
Gladia again, job deleted) and synced: markers went from 0 to 10 (nine `change`, one `idea`), 13 of
34 frames are pointing frames at the narrator's "this" / "these" / "that" (two at a conjunction
"that", harmless), and 332 words carry timings. The pointing frames at 0:39.6 and 0:53.2 showed the
ray on the settings and on the instructions, which the first reading had to infer.
`polycap frames <id> --at 53 --exact` came back from the receiver as a 1920 x 1080 JPEG in about
0.6 s, with the panel's small text readable.

## Storage

Decided with Robin on 2026-10-01: a per-headset allowance that blocks recording when full, deletes in
the app that remove the server copy too, and an automatic server-wide clean-up as the disk's safety net.
The code is [src/server/storage.ts](../src/server/storage.ts).

Verified on capture.polydance.net on 2026-10-01 with a 3-second test clip under its own client id:
account before 0.141 GB of 8 GB in 1 recording, upload, processing, a read token refused DELETE
(403), the upload token deleted it (tombstone `deleted / user`, bundle gone from the session list),
account back to 1 recording. Robin's recordings were not touched.

| Rule | Default | Setting |
| --- | --- | --- |
| Each upload token's allowance: a new upload that would pass it is refused (507); the app shows usage and stops recording at 100% | 8 GB (about 2 h at 1080p) | `POLYCAP_ALLOWANCE_BYTES`, or `maxBytes` on one grant in `POLYCAP_SERVER_TOKENS` (how a paid tier would be set) |
| People outside the team (2026-11-12): a thread-scoped token, or a signed-in tester whose person holds no team token, has this allowance instead, a tighter one of its own still winning. Robin's own Meta-signed-in headset is the team's, so it keeps the default | unset: the default allowance; capture.polydance.net: 2 GB (about 30 minutes) | `POLYCAP_MEMBER_ALLOWANCE_BYTES` |
| Their video is kept for this many days after the upload is made, then deleted on its own: the transcript, frames, summary, storyboard and the mic's narration stay, the record says `videoDeletedAt`, playback says the video was deleted, and it stops counting against the allowance and the safety net. The days are stamped on each upload when it arrives (`keepVideoDays`), so changing the setting moves no one's deadline; recordings made before it have none and keep their video. Checked at start-up, after each recording is built and hourly | unset: kept until deleted; capture.polydance.net: 30 days | `POLYCAP_MEMBER_VIDEO_DAYS` |
| Server-wide safety net: past the high mark of recordings in total, the oldest finished ones are deleted until under the low mark. One whose video already went is never taken: it frees nothing | 13 GB high, 11 GB low (for a 16 GiB work disk); capture.polydance.net: 26 and 22 GB on 32 GiB | `POLYCAP_STORAGE_HIGH_BYTES`, `POLYCAP_STORAGE_LOW_BYTES` |
| An upload with no bytes for a day is abandoned and removed | 24 h | fixed |
| Usage counts each recording's file size; an unfinished upload counts at its declared size | | |
| Reports from the bug key count against a reports allowance of their own, the same size, never the tape: the sender cannot see or delete them (2026-10-12, [THREADS.md](THREADS.md#reports)) | as the allowance | as the allowance |
| 3D models (2026-10-19): one is refused (413) above the largest size, and a push that would take all of them past the total is refused (507). They are not recordings, so the allowance and the safety net do not count or delete them | 50 MB each, 2 GB in all | `POLYCAP_MODEL_MAX_BYTES` (at most 60 MiB, under nginx's `client_max_body_size 64m`), `POLYCAP_MODELS_TOTAL_BYTES` |
| Photos (2026-11-07): one is refused (413) above the largest size, and one that would take all of them past the total is refused (507). Like models, the allowance and the safety net do not count or delete them | 20 MB each, 2 GB in all | `POLYCAP_PHOTO_MAX_BYTES` (at most 60 MiB), `POLYCAP_PHOTOS_TOTAL_BYTES` |

### Room for testers (2026-11-12)

Robin chose it when asked what stood between Polydance and more people on Quest. Measured on the live receiver
that day: 33 recordings, all Robin's, 107 minutes at 64 MB a minute, 6.9 GB of video and 230 MB of everything
else; the work volume 16 GiB with 7.3 GB used, so about 95 more minutes before the safety net (13 GB) started
deleting his oldest. The host, a Hetzner Cloud server with 80 GB of disk, had 28 GB free.

- **The volume grows from 16 to 32 GiB** on the same disk, so it costs nothing more; the host keeps 10.8 GB
  free. The safety net moves to 26 GB high and 22 GB low, which leaves the largest upload (4 GiB) and a gigabyte
  above it. About 6.8 hours of video fit at once, from about 3.4.
- **People outside the team get 2 GB each**, about 30 minutes, and their **video is kept 30 days**, the bundle
  after that until deleted: the free tier of `private/docs/BUSINESS.md` with numbers. Robin's own
  recordings keep theirs.
- **The headset's player** says the video was deleted after so many days, from the release after 0.21.0 (28);
  0.21.0 itself would say it is still on its way. The first video can go no sooner than 30 days after a tester's
  first recording.
- Growing the volume and setting the four keys on capture.polydance.net's host was an operator step of its own, on 2026-11-12.

If more is needed later: Hetzner's next server size up (CX43, 160 GB) was listed at €16.49 a month that day, and
its Object Storage at €6.49 a month for 1 TB with 1 TB of traffic, which would need the receiver to keep video
there (prices excluding VAT, from hetzner.com on 2026-11-12).

Deleting keeps a small tombstone (`status: deleted`, `deletedReason: user | server storage limit |
abandoned upload`) so the headset can say what happened. `GET /v1/account` returns used and allowed
bytes; `DELETE /v1/uploads/:id` deletes one recording and its bundle. Neither touches a bundle already
synced to a Mac: `polycap sync` never deletes a whole local session.

## Summaries

Asked for by Robin in the third design pass (2026-10-01): "run the transcript through an LLM, like a
really cheap LLM, and just get a summary ... so we know which one is which". The pipeline's last step,
`summary`, sends the transcript text, nothing else, to Claude and stores a title of a few words and
one sentence in `session.json` (`title` and `summary: { title, text, model }`). The headset's status
poll carries both, so each rack unit shows them; `polycap list`, `show` and `sync` print the title.
Since 2026-10-02 the same call also lists the requests (`requests.json`, shown in `polycap show` and
the storyboard). Since 2026-10-12 each names its transcript line, quotes the words it rests on and
says its kind; a quote found on no single line leaves that request out, recorded with the reason, and
the rest are kept. After changing the prompt, `npx tsx scripts/check-request-grounding.ts` runs it
live on two labelled synthetic transcripts (six Haiku calls). The code is [src/pipeline/summary.ts](../src/pipeline/summary.ts).

| Setting | Default | Notes |
| --- | --- | --- |
| `POLYCAP_SUMMARIZER` | `none` | `claude` turns it on; the step is skipped otherwise, so nothing is sent by default |
| `ANTHROPIC_API_KEY` | | required when on; a key made only for the receiver can be revoked on its own |
| `POLYCAP_SUMMARY_MODEL` | `claude-haiku-4-5` | the cheapest current model, as asked; a recording costs well under a penny |
| `POLYCAP_ANTHROPIC_URL` | `https://api.anthropic.com` | https, or http on localhost for tests |

A failed call is recorded on the step and leaves the rest of the bundle as it was. Bundles made before
the step existed read as `summary: skipped`; label them all at once with:

```bash
$R 'sudo -n /usr/local/sbin/polydance-user-run docker --host unix:///run/user/1001/docker.sock exec capture-receiver node bin/polycap.js process --all --step summary'
```

Live since 2026-10-02. Verified that night: one real call from the Mac on the pass-3 transcript
(Haiku 4.5, structured output, about 4 s) before the server was touched; then image `d295600` with the
key in the env file; `process --all --step summary` labelled the four bundles on the server; the
headset's first rack unit showed its title and sentence (screenshot); `polycap sync` brought the four
`session.json` files down. The first titles were too alike (three began "Polydance capture ... design
feedback"), so the prompt was changed to lead with the specific things asked for, with examples.
Previewed on copies of the four bundles on 2026-10-02: pass 3 became "Reel-to-reel design with
recording switch and summaries" and pass 2 "Retro level meter with tape reels and rack layout"; pass 1
still starts with the app's name, and titles often run past six words. Pass 3's twelve requests
matched the transcript line for line.

After `7469b3e` was deployed the two bundles left on the server were rebuilt with
`process --all --force`, which runs Gladia and Claude again; the rebuilt pass 3 is titled "Reel-to-reel
design with recording switch and summaries" and its ten requests match the transcript.

Not done from the roadmap's fuller "naming and notes" item: tags, and renaming the folder, which would
change the session id the headset and `sync` key on.

## What was pointed at

Reading CAP-1 on 2026-10-04 meant opening about ten frames by hand to learn what each "this" was. The
`pointing` step, after `frames`, sends each pointing frame (the one taken as "this", "these" or "that"
was said, full size when there is a copy) with the line being said to Claude, which names what the
controller ray or hand points at in a few words, or says "unclear". The answers go in `pointing.json`
and on the storyboard's frame lines: `pointing at "this": the TRY label on the CAP-1 row`, or
`probably …` when Claude was not sure. The frame stays the record; the skill tells agents to open it
when the line says probably or unclear, or when the answer decides what they build. The code is
[src/pipeline/pointing.ts](../src/pipeline/pointing.ts).

| Setting | Default | Notes |
| --- | --- | --- |
| `POLYCAP_POINTING` | `none` | `claude` turns it on; frames can show the room, so it is off unless asked for |
| `POLYCAP_POINTING_MODEL` | `claude-haiku-4-5` | the cheapest model that reads images; at most 24 calls a recording |
| `ANTHROPIC_API_KEY`, `POLYCAP_ANTHROPIC_URL` | | shared with summaries |

A failed call is recorded on the step and the storyboard is built without the names. Re-running
`frames` removes `pointing.json`, since new frames make the old names wrong. Bundles made before the
step read as `pointing: skipped`; `process --step pointing` then `--step storyboard` adds the names.
Tested against a stand-in for the API (2026-10-04); not yet run against the real API or a real recording.

## Not in the proof of concept

- **Other users.** Accounts, sign-in, per-user storage, quotas, consent and retention. Polydance's
  `docs/RECORDING.md` has the consent and retention design to copy; the roadmap makes it a
  prerequisite for anyone but Robin.
- **Billing.** Allowances exist per token; charging for more is later.
- **Store release.** Meta allows MediaProjection only for casting, live streaming and screen sharing;
  an app that uploads recordings for review needs that settled with Meta first.
- **Native Quest recordings.** Only the capture app's own recordings upload.
