# Threads

Every recording made with Polydance lives in a thread: one piece of work, oldest first, like an
email conversation or a pull request. The team (agents and people) posts messages; a message can carry
launches, which tell the headset what to open when the tester presses Record and open; the tester replies by
recording. The receiver builds each recording's bundle as before and posts an event, so an agent can
wait for feedback, read it and post the next round. Designed with Robin on 2026-10-03; what is built is
in `private/docs/ROADMAP.md` "Where we are".

## Terms

Locked on 2026-10-03. One word per thing, the same in the app, the CLI, the API and these docs; Inbox
names only the drawer on the headset.

| Term | Means |
| --- | --- |
| **Inbox** | The drawer on the headset: every thread you can see (the team's headsets: every thread in their projects; a tester: the threads they are a member of), latest activity first, with a red count of threads that have something you have not seen. |
| **Thread** | Everything about one piece of work, oldest first. The team opens one with a message; the tester opens one by recording. Keyed by project and number, `MUS-12`. |
| **Message** | One entry in a thread: text, launches, a recording, photos, or text with launches or with photos. |
| **Photo** | A still image in a message, JPEG or PNG, at most ten a message, with or without words (2026-11-07, [Photos](#photos)). |
| **Launch** | What a message tells Polydance to do when the tester presses Record and open (or Just open): a list of steps (check an app and its version, open a link, open an app with parameters). A message can offer several launches, variants, each with its own keys. |
| **Recording** | The tester's reply. It uploads and becomes a session (the bundle) as before; its message in the thread links to it. |
| **Reaction** | One of a fixed set on any message: heart, thumbs-up, thumbs-down, haha, emphasis, question (❤️ 👍 👎 😂 ‼️ ❓). One per person per message. What each means is the team's convention, not Polydance's. |
| **Project** | Marimba, Polydance, Polydance Capture: what a thread is about, with a short key (MUS). A token sees some or all projects. A repository says which project it is in `.polycap.json`. |
| **Team**, **tester** | Whoever builds (people or agents) and whoever wears the headset. One person can be both. |
| **Report** | A recording made with the bug key on the deck: a bug or a feature request about Polydance itself, for the Polydance team. It opens a thread of its own in the reports project that only the team sees; it never appears in an inbox, its sender's included (2026-10-12). |
| **User** | A person on the receiver (`POLYCAP_USERS`: id, name, colour). Each token names its user, and its label names only the device or machine, so a message reads "Robin · Quest 3", or for an agent, which adds its own name with `--as`, "Opus 5.5 on Robin's Mac". The headset shows people as a circle with their initial and agents as a rounded square (2026-10-04). |

Retired or avoided: RFF (threads also start from the tester, and testers would not know the acronym; a
message with a launch is the request for feedback); tapback (Apple's word); channel (Meta release
channels, Android notification channels); round, version, build, run, track, session and request, which
already mean something here. The local folder of bundles, `~/PolydanceCapture`, is **the library**.

## Decisions (Robin, 2026-10-03)

- **Every recording is in a thread.** Recording from the deck with no thread open, or with +, starts a
  new thread in the current project; its title comes from the recording's summary, so nobody types.
  Recording with a thread open replies to it.
- **No templates in the app.** To ask for something new the tester records and describes it with voice
  and pointing, opening whatever helps (passthrough, another app, a starter project). Building happens on
  the agent's side and comes back as a message.
- **Agents write launches**, different for each message. Polydance runs them and checks the installed
  version; on the developer's headset the agent installs native builds over adb itself.
- **Variants:** web builds are branch previews (Vercel); a native app takes a parameter from the launch
  (an intent extra or a data URI) and shows the variant it names, so split testing lives in the app.
- **Reactions stay generic**: a fixed set whose meaning the team agrees. Polydance is not opinionated
  about workflow wherever it can avoid it.
- **Previews are public.** A project's experiments are pushed to its web app with an experiment tag and
  deployed by Vercel; Polydance does not handle logins. An agent that needs one solves it in its launch.
- **The inbox opened as a second panel next to the deck** (Horizon OS's adjacent panels), seen on the
  Quest 3 on 2026-10-03. **Since 2026-10-20 it is in the same panel** (Robin: several panels are hard to
  manage): the deck on the left, then the threads, which take the width until one opens; the open thread
  then has the wider column on the right, its earlier messages folded to a line each and the latest open
  in full, as desktop mail clients show a conversation. The list shows read and unread as Gmail does (0.18.0):
  unread rows bold and bright with a red dot, read rows plain and quieter, the unread count beside INBOX, and
  a waiting launch said in words (TO TRY), never by a colour alone.
- **Recordings live in the inbox** (Robin, 2026-10-04, thread CAP-1): the deck's rack came off, and each
  recording's card in its thread carries its status, progress, Retry and Delete. Recordings in no thread
  yet are listed under the threads as "On this headset".
- **Replies are announced in the headset itself** (Robin, 2026-10-05: a Horizon OS notification when
  there is a reply he has not seen, which the user turns on and off, and no separate notification
  system). The headset app asks the receiver every 15 minutes, the shortest period Android gives
  background work, which threads this headset has not read, and posts one notification per thread for
  messages by others: who sent the latest, and its first line. Tapping it opens the deck with the inbox
  on that thread; reading the thread clears it. It is off until turned on behind the gear, which asks for the
  notification permission when the headset has not given it (the Quest 3 had granted it without asking,
  2026-10-05), and nothing is posted while the app is in front. Nothing can
  wake the headset sooner (no Google push on Horizon OS). Meta documents Android notifications as
  unsupported and points to its own server-sent notifications, which need the app registered with Meta;
  whether the headset shows an app's own notification is untested, so turning them on posts one at once
  to find out ([PLATFORM-NOTES.md](PLATFORM-NOTES.md)). The ntfy pushes to a phone built on 2026-10-04
  were taken out the next day.
- **Recording starts with two taps**, Start and the system's screen-capture prompt, which Android shows
  for every capture. Stopping means coming back to the panel: apps cannot draw over other apps.

## The loop

1. The team posts a message with a launch: `polycap thread reply MUS-12 --text "Is Settings easier to find?" --open https://…`.
2. The tester sees the count on the inbox, opens the thread and presses Record and open. Polydance checks any
   required app and version, asks for capture, starts recording, then runs the open and app steps.
3. The tester comes back and stops. The recording uploads as a reply that names the message and launch
   it answers; the tester can react.
4. The receiver builds the bundle with the thread's context (the summary is told what was asked) and
   posts `recording.ready`. `polycap thread watch MUS-12 --once` returns, and the agent reads the bundle
   with the skill as before.

## Reports

Asked for by Robin on 2026-10-12: a bug key next to the gear on the deck that records a report for the
Polydance team, "the same as a regular thread, except it doesn't appear in the inbox and it just gets sent
to us", for bugs and feature requests alike.

- **On the headset.** The key, a beetle beside the gear, opens a pop-up saying what a report is for
  (Polydance itself: something broken, confusing or slow, or a feature they would like; feedback on an app
  being tested belongs in its thread), that it goes only to the Polydance team, that it is not in the inbox
  and that it leaves the headset once sent, with Start recording and Cancel. Start records exactly as the
  deck's key does (permissions, consent, the capture prompt, Mic and App sound, STOP and Cancel); the line
  under the key reads `→ REPORT · Polydance team` and nothing opens beside the deck. A full tape does not
  stop a report, since reports are not on it. While a report is recording, a thread's launch keys open nothing
  into it.
- **On the Mac** (2026-11-16, Robin's pick D of four mockups). Report, the beetle in the key strip at the foot of
  the window's column, opens a cream plate with the headset's words for a Mac and Start recording; the walkthrough
  goes with `polycap upload <file> --report` when it stops, and is greyed with why when `GET /v1/projects` does
  not list `reports-v1`. Until it is sent it is at the top of the Threads tab, with Send again if refused. Unlike
  the headset's, the Mac's copy is not deleted once sent: it stays in the recordings folder, as a reply's does
  ([mac/README.md](../mac/README.md)).
- **Not in the inbox.** A report's run folder says `{ "report": true }` in `thread.json`. The inbox's
  recordings, cards and server history, and the tape, leave reports out; the deck's UPLOAD lamp still
  flashes while one goes up, and "Thank you. Your report is on its way to the Polydance team." shows on
  Stop.
- **Deleted from the headset once sent.** A report uploads at once, without the hold (there is no card to
  undo it from). When the receiver has every byte and has matched the sha256 (status `received`, or
  beyond), the headset deletes its copy. At each start the app sweeps what is left
  (`ReportPolicy`): a report sent but not yet removed, one cut off before Stop (it can never upload) and
  any report still unsent after a week go; a refused one is sent again until then, and the deck says it
  could not be sent. Nothing is deleted on the receiver from the headset.
- **On the receiver.** The upload names `thread: { "report": true }`. The receiver opens a new thread in
  the project `POLYCAP_REPORTS` names (CAP, Polydance Capture, is the intended one), marked `report`,
  titled `Report 12 Oct 15:40` until the summary names it, whatever projects the sender's token sees: the
  reports project is a drop box. A receiver without `POLYCAP_REPORTS` refuses a report with 409 rather
  than putting it in an ordinary thread, and the app never retries one as a new thread.
- **Only the team sees it.** A report's thread, its events and its upload are visible only to tokens with
  `read` or `post` that see the reports project. Upload-only tokens (every headset, the sender's included,
  and a headset that sees every project) get 404 for the thread and the upload, and nothing in listings or
  the event feed. The sender's own token can still `DELETE` its upload by id, as with any recording it
  owns; the app has no key for it, and the privacy notice says to ask instead.
- **Storage.** Reports count against an allowance of their own, the same size as the sender's, not
  against the tape: the sender cannot see or delete them. Past it a report is refused (507, "reports full")
  and the receiver logs it. The server-wide safety net deletes the oldest finished recordings, reports
  included, as before.
- **The bundle.** It is built as any recording's. `source.thread` carries `report: true`, the storyboard
  says it is a report from the bug key, and the summary reads it against what the key asks
  (`REPORT_ASK` in `src/threads.ts`), as a reply is read against the team's message.
- **Tracking, for now.** `polycap thread list --reports [--all]` lists open reports with the team's token,
  `polycap thread show` marks one as a report, and `polycap thread close` files one away. `GET
  /v1/projects` advertises `reports-v1` and `GET /v1/threads` says `reports: true|false`, which the
  headset uses to say when a receiver has nowhere to send one. A proper tracker (states, assignees,
  deletion by the team, retention) is not built.

## Launches

A launch is JSON, written by the agent to a file or built from CLI flags:

```json
{
  "label": "Variant B",
  "steps": [
    { "do": "require", "package": "com.example.marimba", "versionCode": 231 },
    { "do": "app", "package": "com.example.marimba", "extras": { "variant": "b" } }
  ]
}
```

| Step | Fields | What the app does |
| --- | --- | --- |
| `require` | `package`, optional `versionName`, `versionCode` or `minVersionCode` | Before recording, checks the app is installed at that version; a mismatch is shown and the tester can start anyway. Since 2026-10-12 (CAP-4 #2) the mismatch is also written in red beside the keys before either is pressed ("Polydance needs build 18; this headset has 0.12.0 (12). Update it before starting."), and a launch that opens nothing, a test of what is installed such as Polydance itself, is always checked. Since 2026-11-07 every press is checked, Just open included. |
| `open` | `url` (https) | Opens the link in the Meta Quest Browser after recording has started. |
| `app` | `package`, optional `activity`, `data` (a URI), `extras` (strings, numbers, booleans) | Opens the app, or that activity of it, with the data and extras, after recording has started. |
| `model` | `sha256`, `name` (`chair.glb`), `bytes` | Opens the 3D model, pushed to the project beforehand, in Polydance's own viewer panel after recording has started ([Models](#models)). At most one a launch. |

**Options** (Robin, 2026-10-06, CAP-1 #17 and #18). A message with several launches (at most 6, each at
most 8 steps) offers them as options, and `label` names each. The headset shows them as OPTION 1, 2, 3, each
on its own plate with its name, a star, its keys and what the main key does. The key read START until 2026-10-15, then **Reply** with the camera (CAP-7); since 2026-11-07 each option has the two keys of [Record and open, Just open](#record-and-open-just-open). The tester
records each option on its own, or records one and presses the next one's Just open while recording: the recording
notes what was opened when (`source.opened`, with the message and the option), so the storyboard's
"Opened from the inbox" says "option 2: Red menu", every request is tagged with the option on screen when it
was said, and the recording's card in the thread says "answers option 2" or "tried options 1, 2". The star
is a quick pick: one option per person per message, the same again takes it back, another moves it; the team
hears a `pick` event, the inbox line reads "picked option 2: Red menu in #16", and `polycap thread show`
prints the stars beside each option. Agents send options with `--option NAME` before each one's flags.
A launch with only `require` steps just records: for testing the headset app itself, which is already open.

## Models

Robin, 2026-10-19: users and agents push 3D models that the tester opens, turns and zooms in shared
space, without an immersive mode, while recording as usual. Neither Horizon OS nor Android XR lets an
app put a free-standing 3D object beside other apps' panels (immersive mode and Full Space only,
[PLATFORM-NOTES.md](PLATFORM-NOTES.md#3d-models-in-shared-space-2026-10-19)), and the store's model
viewers are immersive, so the model is drawn inside a panel of Polydance's own: Google's `<model-viewer>`
in a WebView, packaged in the app ([app/PLATFORMS.md](../app/PLATFORMS.md#the-3d-viewer-panel)).

- **One file, binary glTF 2 (`.glb`)**, everything inside it: a model that points at files beside it is
  refused with the command that packs it. Draco meshes and KTX2 textures are read. At most 50 MB
  (`POLYCAP_MODEL_MAX_BYTES`, never above 60 MiB, under nginx's 64 MB a request).
- **Pushed before it is named.** `polycap thread new|reply --model chair.glb` checks the file as the
  receiver will, sends it to `PUT /v1/projects/MUS/models/<sha256>`, then posts the launch
  `{ "do": "model", "sha256", "name", "bytes" }`. Sending the same file again is a no-op; a message naming
  a model nobody pushed is refused. Options take `--model` like `--open`.
- **Reached only through its thread.** The headset fetches `GET /v1/threads/:key/models/:sha256`, which
  answers only a token that may see the thread, for a model one of its launches names; it keeps the copy
  in its own files, checked against the sha256 (the eight most recently opened stay). The receiver keeps
  models in `thread-models/<PROJECT>/` (0700, files 0600) and nothing deletes them yet; all of them together
  are capped at 2 GB (`POLYCAP_MODELS_TOTAL_BYTES`), past which a push is refused (507).
- **On the headset** the model is drawn in its message, above the launch's keys (since 2026-10-20; from
  10-19 it opened in a panel of its own). Record and open records as usual and brings that message into view; Just open only brings it into view. Drag
  turns the model, pinch or the thumbstick zooms, and keys turn, zoom, spin and reset it; since 0.18.0 the keys
  are folded behind Controls, and Spin starts at once (model-viewer waited 3 s after any touch). The
  recording notes when it opened (`open model chair.glb (4.2 MB)` in `source.opened`), and the frames show
  the model as it was turned.
- **Immersive, on Quest (built 2026-10-21, Robin in CAP-10):** a passthrough scene with a table. On it stand the model
  that was opened and the latest model of each thread the inbox follows, up to six, each labelled with its thread.
  Hands or controllers pick them up, two hands scale them, and they stay where they are put down. Polydance's panel
  is shown over the scene, and a key returns to shared space. The recording carries on. Android XR has none yet
  ([IMMERSIVE-VIEWER-RESEARCH.md](IMMERSIVE-VIEWER-RESEARCH.md),
  [app/PLATFORMS.md](../app/PLATFORMS.md#the-immersive-scene-quest-2026-10-21)). Not yet on a headset.

## Photos

Robin, 2026-11-07: "Can we add the ability to add photos to a thread as well as videos". Planned with him
the same day; what is built is in `private/docs/ROADMAP.md` "Where we are". Built the same day for the
receiver, the CLI, the Mac and the headset's view, and verified by tests and a local receiver only: not
deployed, not on a headset, and not yet on the iPhone.

**Decisions (Robin, 2026-11-07)**

- **Who adds them:** agents and people through the CLI (`polycap thread new|reply --photo`), the iPhone
  (its camera and its library) and the Mac (a file chosen, dragged onto the thread or pasted). The
  headset adds none. Every app that shows threads shows them.
- **A photo message** holds 1 to 10 photos and optional words, as a phone's messages app does. Words
  alone and recordings stay as they are; photos never ride on a recording or a launch.
- **Agents** get them from `polycap thread show`, which saves each photo into the library and prints its
  path for the agent to read. A photo message from someone else counts as new work in `thread pending`
  and wakes `thread watch`.
- **JPEG or PNG, at most 4096 px a side, and no metadata.** Senders turn HEIC into JPEG and scale down.
  The receiver strips EXIF, GPS, XMP, comments and every other tag itself, keeping the colour profile,
  and refuses any other format or anything over 20 MB.

**Choices made in planning (Claude, 2026-11-07; Robin to confirm)**

- **Upright pixels, not an orientation tag.** Robin's answer kept the orientation. The plan keeps it by
  making the pixels upright and refusing a JPEG still tagged as turned. Android's decoder, which the headset
  uses, ignores the tag, and so may an agent's image reader, so a tagged photo would reach them on its side.
  The CLI turns the pixels with ffmpeg; the iPhone draws them upright as it encodes, as its video does (R4
  in [IPHONE.md](IPHONE.md)).
- **Upload tokens may post photo messages.** The headset and the iPhone hold `upload` tokens, which
  could not post. An `upload` token may now post a message with photos and optional words in a thread it
  sees: never a launch, and never words alone. For a tester, that means a thread they are a member of.
  Opening a thread with a message stays the team's (`post`); a phone opens one by recording, as the
  headset does. **Changed 2026-11-13** for the iPhone's Photo (Robin: "we shouldn't start video by default
  for new threads, we should get the option of video or photo"): an `upload` token may also open a thread
  with photos and optional words, in a project it sees, never with words alone or a launch. A
  thread-scoped token's thread lists its person as a member, as a recording's does.
- **Seen by the thread's members, as recordings are played.** A photo is fetched by a member of its
  thread or by the token that posted it. Anyone else who sees the thread sees how many photos a message
  has and their sizes, with `canView: false`.
- **Named by the file the receiver keeps.** A photo's id is the sha256 of the stripped file, so the same
  photo sent twice is one file, and a message names its photos by those ids.

**On the receiver**

- `POST /v1/threads/:key/photos` (upload or post, in a thread the token sees) and `POST
  /v1/projects/:key/photos` (upload or post since 2026-11-13, for a thread about to be opened in a project
  the token sees) take the image as the whole body, with
  its Content-Length and `Content-Type: image/jpeg` or `image/png`. The receiver reads it, strips it and
  keeps it in `thread-photos/<PROJECT>/<sha256>.jpg|.png` (0700, files 0600). It answers 201 when kept and
  200 when already there, with `{ sha256, type, width, height, bytes }`. It answers 400 for a file that is
  not a whole JPEG or PNG (HEIC is told how to convert), one tagged as turned, or one over 4096 px; 411
  without a length; 413 over 20 MB (`POLYCAP_PHOTO_MAX_BYTES`); 415 when not sent as `image/jpeg` or
  `image/png`; 507 past the store's total of 2 GB (`POLYCAP_PHOTOS_TOTAL_BYTES`). Nothing deletes photos
  yet, as with models.
- **Messages.** `POST /v1/threads` and `POST /v1/threads/:key/messages` take `photos: [sha256]`, at most
  10, each already in the thread's project. The thread keeps `{ sha256, type, width, height, bytes }` for
  each, read from the file, so an app can lay them out before fetching them. A `deliveryId` retry
  compares the photos too. `POST /v1/threads` takes a `deliveryId` since 2026-11-13: the same token's
  retry gets the thread it already opened, even renamed since, and the same id with another project,
  words, launch or photos is refused (400).
- `GET` and `HEAD /v1/threads/:key/photos/:sha256` serve a photo one of the thread's messages holds, to a
  token that may view it. A photo the thread does not hold is 404; one this token may not view is 403
  `not_member`.
- `GET /v1/projects` advertises `photos-v1`. The `message` event carries `photos: n`, a count. The inbox
  line and snippet read "sent a photo", "sent 3 photos", or the message's words when it has some.
- **Stripping.** A JPEG keeps its frame, tables, scans and its JFIF, ICC profile and Adobe segments. It
  loses every other APP segment (EXIF, XMP, IPTC, MPF and an iPhone's HDR gain map), comments, and
  anything after the image ends (a phone's second images). A PNG keeps `IHDR`, `PLTE`, `IDAT`, `IEND` and
  the colour chunks (`tRNS`, `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `pHYs`), and loses text, time,
  `eXIf` and anything else, an animated PNG's frames included, so it becomes its first still.
- **Rollback.** A thread file with `photos` on a message, or an event with `photos`, is refused by an
  older receiver's strict schemas, as with participants.

**In the apps**

- **CLI.** `polycap thread reply MUS-12 --photo shot.png --photo b.jpg [--text "…"]`, and `thread new
  --photo`. Each file is made upright and scaled to at most 4096 px with ffmpeg when it needs to be
  (HEIC, WebP, TIFF and GIF become JPEG), stripped before it leaves the machine, pushed, then named in the
  message. `thread show` saves each photo it may view to `~/PolydanceCapture/photos/<KEY>/<sha256>.jpg`
  (0700, files 0600), checked against its sha256, and prints the path; `--json` gives each photo its
  `path`. `thread watch` says how many photos a message has.
- **Mac.** The thread page draws a message's photos, from the paths `polycap thread show --json` gives,
  and opens one in Preview when clicked. Beside the reply's words: Add photo (a file), a drop target on the
  page, and paste (⌘V) for a screenshot on the clipboard. The chosen photos wait above the words, each
  with a key to take it out, and Send posts them with `polycap thread reply --photo`.
- **Headset.** A message draws its photos as a row of thumbnails under its words, fetched through the
  thread, checked against their sha256 and kept in the app's own files. One opens large over the panel
  when pressed. A photo this token may not view says so.
- **iPhone** (2026-11-13, Robin's pick of four mockups, "the camera, then choose"). New thread and Reply
  open the camera without recording, on Photo, with Video beside it; the shutter takes a photo, and Library
  adds photos from the library. The photo message screen holds 1 to 10 with optional words; Send draws
  each upright, at most 4096 px, as JPEG with no location, sends it with the phone's `upload` token and
  names them in one message, or opens the thread with them, with a `deliveryId`. A new thread is titled by
  the words' first line, else "Photo 13 Nov 19:40". A thread draws its photos as tiles that open large
  ([IPHONE.md](IPHONE.md#photos-2026-11-13)). The Vision Pro, like the Quest, adds none.

## Receiver API

All on the hosted receiver, beside the upload routes in [HOSTED.md](HOSTED.md). Every route but one needs a token:
`POST /v1/agents` takes a code in its place. For a thread-scoped token every route below reaches only the threads it is a member of; any other thread
is the same 404 as one that does not exist ([Who sees a thread](#who-sees-a-thread)).

| Route | Scope | |
| --- | --- | --- |
| `GET /v1/projects` | any | the projects this token sees: key and name, the team's first, then its person's own with `mine: true`; `capabilities` names `models-v1` where launches may open 3D models, `photos-v1` where messages may hold photos, `projects-new-v1` where `POST /v1/projects` makes one, `projects-edit-v1` where its owner may change its hosts, and `agents-v1` where a device may ask for a code to connect an agent |
| `POST /v1/projects` | any | `{ name, key?, hosts?, packages? }`: a project of this token's person's own ([Projects of your own](#projects-of-your-own)). 201 `{ project: { key, name, mine, hosts, packages }, projects }`; 400 a bad shape or a host too wide; 403 `project_limit` at 20; 409 `key_taken`, or threads off |
| `GET /v1/projects/:key` | any | `{ project: { key, name, mine?, hosts, packages } }` for its owner, or for the team's tokens in a team project; 404 for anyone else (2026-11-20) |
| `POST /v1/projects/:key` | any, the owner | `{ hosts?, packages? }`, each the whole new list, under the rules a new project's keep to; 400 a bad shape, a host too wide or neither list; 404 for anyone else and for a team project ([Connecting your own agent](#connecting-your-own-agent)) |
| `POST /v1/agents/codes` | upload | a one-time code for this device's person: 201 `{ code, expiresAt, agents, limit }`; 403 `agent_limit` at five, 429 past six in ten minutes |
| `POST /v1/agents` | none | `{ code, label? }`: redeems a code for an agent's own token, 201 `{ token, id, label, expiresAt, person: { name } }`; 404 `no_code` for a wrong, used or expired one alike; 429 past the limits |
| `GET /v1/agents` | upload | `{ agents: [{ id, label, connectedAt, connectedFrom, expiresAt, lastUsedOn?, expired? }], limit }`: this device's person's agents |
| `DELETE /v1/agents/:id` | upload, or the agent itself as `self` | disconnects it: 200 `{ id, disconnected: true }`; 404 for anyone else's |
| `PUT /v1/projects/:key/models/:sha256` | post | a `.glb`, whole, with its Content-Length; 201 kept, 200 already here, 400 not a self-contained glTF 2 or not that sha256, 413 too large, 507 the model store is full ([Models](#models)) |
| `POST /v1/projects/:key/photos` | upload or post | a JPEG or PNG, whole, with its Content-Length and type, for a thread about to be opened; stripped and kept. 201 kept, 200 already here, with `{ project, sha256, type, width, height, bytes }`; 400 not a whole JPEG or PNG, tagged as turned, over 4096 px or not the type it was sent as; 411 no length; 413 too large; 415 not sent as `image/jpeg` or `image/png`; 507 the photo store is full ([Photos](#photos)) |
| `GET /v1/me` | any | `{ me, device, person: { id, name, colour?, email?, emailVerified, initial } }`: this token, its label and its person ([People](#people-email-and-participants)) |
| `POST /v1/me` | upload or post | `{ email: string \| null }`: the person's own address, trimmed and lowercased, unverified; null clears it. Answers as `GET /v1/me`. 403 for an agent connected with a code |
| `GET /v1/threads[?project=MUS&state=open]` | any | `reports`, `newProjects` and `agents` (whether this receiver takes reports, makes a project of your own, and gives a device a code to connect an agent); then the threads, newest activity first, each with unread, last activity, whether a launch is waiting for you, `people` (the first 6), `peopleCount`, `snippet` and `lastMessageAt`; threads this token hid are left out, and out of `unread` |
| `GET /v1/threads/:key` | any | the thread: messages with launches, recordings (live upload status, session id, title, summary, `canPlay`, and from 2026-11-16 `content: video | sound | none` and `logs: true`, [LOGS.md](LOGS.md#upload)) and reactions; `member`, `canPlay`, `people`, `participantCount`, `participants` (members only), `members` (`[{ person, name, addedBy, addedAt }]`, for whoever manages the thread: the team, or in a project of their own its owner) and `hidden: true` while this token has it hidden |
| `POST /v1/threads` | post, or upload for photos | open a thread: `{ project, title, text?, launches?, photos?, deliveryId? }`; a token without `post` must name a photo and no launch (403 otherwise); a deliveryId retry returns the thread already opened |
| `POST /v1/threads/:key/messages` | post, or upload for photos | `{ text?, launches?, photos?, as?, deliveryId? }`; deliveryId retries return the same reply, changed payloads are refused. `photos` names up to 10 photos already sent to the thread's project, each once. A token without `post` must name a photo and no launch (403 otherwise) |
| `POST /v1/threads/:key/photos` | upload or post | a photo for a message in this thread, as `POST /v1/projects/:key/photos` answers ([Photos](#photos)) |
| `POST /v1/threads/:key/reactions` | upload or post | `{ message, reaction }`; the same again removes it, another replaces it |
| `POST /v1/threads/:key/picks` | upload or post | `{ message, launch }`: a star on one of the message's options; the same again removes it, another moves it |
| `POST /v1/threads/:key/participants` | upload or post, members | `{ add?: [email], remove?: [email] }`, at most 20 each, at least one address; never in a report. Returns the thread |
| `POST /v1/threads/:key/members` | post, the team; or upload or post, the project's owner | `{ add?: [person], remove?: [person] }`, person ids, at most 20 each; an id added must be someone the receiver knows; never in a report; a project's owner is never removed. 403 `not_team` for anyone else. Returns the thread ([Who sees a thread](#who-sees-a-thread)) |
| `POST /v1/threads/:key/read` | any | `{ seq }`: everything up to there is seen by this token |
| `POST /v1/threads/:key/hide`, `/unhide` | any | off this token's inbox until someone else adds to the thread, or back now; no body. Returns the thread |
| `PATCH /v1/threads/:key` | upload or post | `{ state: open \| closed }`; `{ title }` needs post |
| `POST /v1/threads/:key/state` | upload or post | `{ state: open \| closed }`, the same as PATCH's state, for a proxy that passes only GET, POST, PUT and DELETE |
| `POST /v1/threads/:key/title` | post | `{ title }`, the same as PATCH's title, for the same proxy. `polycap thread rename` uses it since 2026-11-02: the hosted receiver's nginx refused its PATCH with 403 |
| `GET /v1/threads/:key/messages/:id/playback` | any, `canPlay` | a recording's transcript, moments and whether its video is here ([Playback](#playback)); `content` says whether there is a picture, sound alone, or nothing (a take of logs alone) |
| `GET`, `HEAD /v1/threads/:key/messages/:id/video` | any, `canPlay` | the recording's video, whole or one byte range |
| `GET`, `HEAD /v1/threads/:key/models/:sha256` | any | a model this thread's launches open, as `model/gltf-binary`; 404 for any other |
| `GET`, `HEAD /v1/threads/:key/photos/:sha256` | any, `canView` | a photo one of this thread's messages holds, as `image/jpeg` or `image/png`; 403 `not_member` for a token that may not view it, 404 for any other photo |
| `GET /v1/events?after=N[&wait=25&project=&thread=]` | any | events after N, waiting up to `wait` seconds for one; without `after`, just the latest id |

`POST /v1/uploads` takes `thread`: `{ "key": "MUS-12", "replyTo": { "message": 3, "launch": 0 } }` to
reply, `{ "project": "MUS" }` for a new thread, or `{ "report": true }` for a report from the bug key
([Reports](#reports)). An upload without it starts a thread in the token's
first project, so every recording lands in a thread, older app builds included.

**Idempotent replies (2026-10-08):** `/v1/projects` advertises `capabilities: ["idempotent-replies-v1"]`. A message's optional delivery ID is scoped to the token identity and thread, persisted with the message and returned in thread views. The local router used it for its replies; since the router was removed (2026-10-12) the receiver keeps the capability, and `polycap thread reply` sends no delivery ID.

**Events:** `thread.new`, `message` (with `photos: n` when it holds some), `recording` (joined, still uploading), `recording.words` (its words
are ready while the video is still uploading: session id, title and summary; see below),
`recording.ready` (the bundle is built: session id, title and summary), `recording.failed`, `reaction`, `pick`
(the option starred, 0-based, or null when taken back),
`closed`, `reopened`, `renamed`, `people` (participants added or removed: `added` and `removed` counts,
never the addresses). Each has an increasing id, the thread key and project, who did it, and the message it
concerns.

### Record and open, Just open

Robin, 2026-11-07: a launch has two keys on every platform, where it had one. **Record and open**, the main
key, red with the camera, starts a recording that replies to the message and names the launch, then opens
what the launch names. **Just open**, beside it in the plain style, opens it at once with no recording, for
looking again at something without leaving an empty recording to delete. A launch that opens nothing has
**Record** alone. While a recording runs, either key opens the launch into it and the recording notes when.

| Platform | Record and open | Just open |
| --- | --- | --- |
| Headset (Quest, Android XR) | records the screen, then runs the open, app and model steps | runs them, after the same build check |
| Mac | records a walkthrough, then opens the https links in Arc (else the default browser); its Settings key holds Mic and Mac sound, as the headset's does (2026-11-11) | opens the links |
| iPhone | not drawn: iOS stops the camera once Safari is in front, so it waits for screen recording (I4); Reply at the foot records with the camera | opens the https link in the default browser |
| Receiver | draws no thread | |

The keys replaced two switches beside START, Record and Open (Robin, 2026-10-05 and 06, CAP-1 #12 and #20;
under a Settings key since 0.13.0, CAP-1 #24): Record off was Just open, and Open off, recording a reply
that opens nothing, is the thread's own Reply. Settings on the headset keeps Mic and App sound, and the line
under the keys names a sound left out. The Mac has the same since 2026-11-11 (Robin: its "✓ Mic" was a label,
with no way to turn the mic off): a Settings key beside the keys unfolds Mic and Mac sound, and the line under
them says what Record and open records. They apply to every walkthrough, never to a call.

**Words first** (Robin, 2026-10-04: "get words back faster"). A ten-minute recording is about 500 MB,
and nothing could happen until all of it had arrived. The headset app now copies the mic track out of
the finished recording (`narration.m4a`, about 1 MB a minute, not re-encoded), declares it in
`POST /v1/uploads` as `narration: { bytes, sha256 }` and sends it whole with `PUT
/v1/uploads/:id/narration` before the first chunk of video. The receiver makes the session from it at
once and builds the words: transcript, markers, Claude's title, sentence and requests, and a storyboard
that says the frames are still to come. The thread hears `recording.words`, its inbox line reads "words
ready: <title>", and `polycap sync` brings that bundle down so an agent can start on what was said. When
the video arrives it joins the same session; probe, frames and pointing run, the storyboard is rebuilt
with frames, nothing that was heard is transcribed again, and the thread hears `recording.ready`. A
narration that does not match its declared size and sha256 is refused and the app goes on with the
video, which has the same sound; so does an older receiver that does not know the field. Only a
recording with a mic track can send one.

**Storage:** one JSON file per thread and an append-only `events.jsonl` under `<root>/threads/` on the
receiver. Projects come from `POLYCAP_PROJECTS` beside the tokens: key, name, and the link hosts and app
packages launches may open. Without it threads are off and uploads behave as before. Nothing else makes a project yet (a person's own projects are proposed in [Projects of your own](#projects-of-your-own)): every app and the CLI choose among them, and a new one is added on the
receiver with `deploy/receiver/add-project.py` ([HOSTED.md](HOSTED.md), Adding a project).

## People, email and participants

Built on 2026-10-12 for the headset's inbox, redesigned along the lines of Gmail's on a phone. Verified the
same day by `npm run check` only (`tests/people.test.ts`, with no headset, no deployment and no email sent).

- **A person.** A token's person is the user it names (`POLYCAP_USERS`, Meta testers' people included),
  else the token itself; their name is the user's, else the token's label, else its id. `GET /v1/me` says
  who that is, with the avatar's `initial`: the first letter or digit of their address if they gave one,
  else of their name, else `?`.
- **Their own address.** Meta never gives one, so a person types it (`POST /v1/me`). It is trimmed,
  lowercased, at most 254 characters and must look like an address (one @, a dot in the domain, no
  spaces). It is kept in `people.json` beside `testers.json` in the receiver's root (0600), one writer at a
  time, read through its schema; a damaged file is an error, not nobody's address. Setting one always
  leaves `emailVerified: false`. **Google sign-in verifies one** (since 2026-10-16, Android XR): the address
  Google verified for the account is set on the tester's person as verified, replacing what they typed
  (`People.setVerifiedEmail`, `private/docs/PLAY.md`). It is never logged, and a refused one is not echoed.
- **Participants.** A thread's members can name other people by address (`POST
  /v1/threads/:key/participants`), at most 50 a thread, and take them out again. Adding one already there
  or removing one who is not is no change: nothing is written and no event is sent. An address in both
  lists, or a bad one, is a 400 naming its place (`add.1`), not its value. A report has none. Since
  2026-11-10 the team's additions are emailed an invitation ([Invited by email](#invited-by-email)); each
  participant reads `emailed`, with `emailedAt` or `emailNote` saying why not. The thread hears
  a `people` event with counts only, since `events.jsonl` is kept for ever, and the inbox line reads
  "added 2 people", "removed 1 person" or "added 1 person and removed 1 person".
- **Members.** A token is a member of a thread when it is the team's (`read` or `post`, not thread-scoped),
  when its person is in the thread's `members` (added by the team, or the thread-scoped grant that opened
  it; since 2026-10-21), when its person's own address is *verified* and is one of the thread's participants
  (Google sign-in verifies one, and since 2026-11-10 so does pressing Confirm in the emailed link), or, for a token that is not thread-scoped, when it or its person has posted or
  recorded in the thread. Seeing a thread through a project is not membership. A thread's members can
  invite addresses, as anyone on an email thread can copy someone in, so a tester added to a thread can
  bring in a Google tester by their verified address; only the team adds people by id.
- **Who sees addresses.** Only members: they get `participants` (`{ email, addedBy, addedAt, emailed }`)
  and addresses in `people`. Anyone else who can see the thread gets `participantCount` alone, and each
  invited person in `people` as "Invited" with `?` for an initial.
- **People, for the avatars.** `people` lists, in order of first appearance, whoever opened the thread,
  each message's author as their person (an agent posting with someone's token is that someone; `as` does
  not make a new person), then the participants, leaving out one whose address a poster already gave.
  Each is `{ name, initial, colour?, invited?, email? }`. The inbox listing carries the first six and
  `peopleCount`, with `snippet` (the newest message's words, or failing that the newest recording's
  summary, whitespace collapsed and at most 200 characters; else the latest activity in words) and
  `lastMessageAt`.
- **Delete from the inbox, and archive.** `POST /v1/threads/:key/hide` takes a thread off that token's
  inbox (listing and unread count) until someone else does something in it after that moment, as a Gmail
  conversation comes back with a new reply; the token's own reactions and recordings do not bring it back.
  It is per token, sends no event and leaves `seq` alone; the thread is still there by key, marked
  `hidden: true`, and `unhide` brings it back at once. Archiving is closing: `POST
  /v1/threads/:key/state { state: "closed" }`.
- **On the headset (Polydance 0.15.0, [app/README.md](../app/README.md#the-screen)).** The corner circle
  opens the account sheet, where the person types their address once. New thread asks who to copy in
  before recording; since 0.18.0 (2026-10-21, CAP-10) it opens a draft in the right column, with the project,
  the addresses and its own Record key, which is off while another recording runs and says so; the receiver
  still makes the thread from that first recording, since a headset's token may not open one. The addresses wait beside the recording (`invite.json`, never `thread.json`, which the
  receiver checks strictly) and are added once the upload has made the thread. Share (Forward until CAP-7, 2026-10-15) and Add people add
  addresses to an open thread; a non-member is told to reply first. Archive closes the thread, so it leaves
  everyone's inbox until someone adds to it; Delete hides it from this headset alone.
- **The invitation itself** was built on 2026-11-10: see [Invited by email](#invited-by-email). It emails who
  added the address and the thread's title, never its messages or recordings' summaries (Robin's call that
  day), and lets them in once they confirm the address from a link, rather than with a code.
- **Rollback.** A thread file that has gained `participants` or `hiddenFor`, an activity of kind
  `people`, or a `people` line in `events.jsonl` is refused by an older receiver's strict schemas: its
  event feed would stop loading altogether. Empty lists are not written, so threads nobody touched this
  way stay readable, but rolling the receiver back after this is used needs those entries taken out first.

## Invited by email

Built on 2026-11-10 as a second way in (Robin: copy someone's address into a thread, and they get an email
saying what happened and how to take part). Verified the same day by `npm run check` with a stand-in for
AhaSend, and on this Mac with the `folder` mailer; not yet sending from the live receiver.

- **Inviting.** Copying an address into a thread (the headset's Add people or Share, or `polycap thread invite
  MUS-12 --email ana@example.com`) emails it once for that thread when whoever copied it is the team's: a team
  token, or any device of a person who holds one, so Robin's headset and phone count. Anyone else's additions
  are recorded and never emailed, so nobody can use Polydance to email strangers. The email says who added
  them and the thread's title (and project), what Polydance is in a line, and how to take part: get Polydance
  on Quest (replying with their Meta account's address if it differs, so the team can add them to the test),
  enter the address in the account sheet, and confirm it from the email that follows. It links `/start#invited`.
  Nothing from the thread's messages or recordings is emailed. An address that is already someone's confirmed
  one is told the thread is in their inbox. `--resend` sends a failed invitation again; `uninvite` takes one out.
- **Confirming.** When a person enters their own address (`POST /v1/me`, the account sheet, or `polycap me
  --email`), and it is not verified, the receiver emails a link to `/email/confirm/<token>`: a page with a
  Confirm button. Only pressing it (a POST) verifies, so a mail scanner that opens links confirms nothing. It
  works once, for 48 hours, for that person's address as it still is; a newer link replaces older ones.
  Verified, the address makes them a member of every thread that invited it, now and later (isMember).
  Entering the same address again keeps it verified (until 2026-11-10 it undid a Google-verified one).
  **One confirmed address is one person's** (auth audit, 2026-11-12): an address someone else has confirmed is
  sent no link (`confirmation: { status: "not sent" }`, and the receiver logs the token's id, never the address),
  and a link pressed after someone else confirmed the same address is a 409 that changes nothing. Before this,
  anyone could enter a member's address, and if its owner pressed the link thinking it their own, have every
  thread it was invited to. The email now says to confirm only an address you entered yourself just now.
- **Stopping.** Every email has a link to `/email/stop/<key>` (the address's hash with an HMAC, so it names no
  address) and a `List-Unsubscribe` one-click header. Stopped, an address is never emailed again; it is kept
  only as a sha256.
- **Limits.** 5 emails to one address a day, 3 confirmations for one person a day, 100 emails an hour in all,
  counted from the outbox so a restart does not reset them. A refused or failed email says why in the thread.
- **Where.** `mail.json` beside `people.json` (0600): the outbox (kept 90 days), the confirmation tokens as
  sha256, the stopped addresses as sha256, and the stop links' secret. Mail goes through AhaSend
  ([HOSTED.md](HOSTED.md#email)), or with the `folder` mailer to `mail-outbox/` to read, sending nothing.
- **Trying it on yourself first.** Gmail delivers `you+anything@gmail.com` to your own inbox, and the receiver
  treats each as its own address. With a test person's member token (`POLYCAP_REMOTE_TOKEN=… polycap me --email
  you+t1@gmail.com`), invite that address to a thread, read the invitation, enter it with `polycap me`, press
  Confirm in the second email, and `polycap thread list` with that token shows the thread.
- **Not yet.** The headset's own words still say nothing is emailed and that a code will come; they change
  with the next app release. Invitations from testers, and a code typed in the app instead of a link.

## Who sees a thread

Built on 2026-10-21 so two or three people from outside the team can test on Quest's Alpha beside the team, and their
own agents can sync what they recorded; verified the same day by `npm run check` only, not against the live
receiver. Before it every tester read every thread in their projects (an audit that day, from the code).

- **Thread-scoped grants.** Every Meta (`meta-…`) and Google (`google-…`) tester, a token made with
  `polycap token new --member --user ID` (`"threads": "member"`), and a legacy upload token linked to a
  tester's Meta account, see only the threads their person is a member of, as email works. The exception
  is a tester whose person also holds one of the team's tokens (Robin's own Meta sign-in, mapped to
  `robin`): their headset sees as the team's headsets do. Whatever its scopes, a thread-scoped grant is
  never the team's, so it never sees a report and is not a member of every thread.
- **What membership is, for them.** The thread they opened by recording (or, with `post`, by `POST
  /v1/threads` in one of their projects), a thread the team added their person to, and a thread that invited
  their verified address. Their own posts and recordings do not count, so taking them out takes them out.
  Membership alone decides: a thread they are in is theirs whatever their projects, which now say only
  where their new recordings go and where their agent may open threads.
- **From when they were added (2026-11-12, Robin: "similar to how other messaging apps work").** Someone added
  to a thread that was already going sees it from the change that added them: what is posted after, and none of
  what came before (its messages, recordings, photos, the models its launches open, reactions and picks on those
  messages, and their events). Before it, a message is the same 404 as one that does not exist, on every route,
  and replying to one is a 400. Their agent's `read` token syncs only the recordings after. Added more than one
  way (invited by address, then added by id), the earliest counts; taken out and put back, the view starts again.
  A thread they opened, or one the team opened with them in it (the Welcome), is theirs from its first message.
  The thread's title, its current people and who opened it are still shown, as a group's name and members are.
  Where the view starts is read from the thread's own activity, so it applies to people added before this rule,
  and nothing on disk changed. The team, and Robin's own headsets (which see their projects), see all of it.
  Whether they see what came before is chosen when they are added (next item); from 10:23 to 10:31 UTC that day,
  before that was live, `POLYCAP_NEW_MEMBER_HISTORY=visible` would have shown everyone added later everything at once.
  Verified 2026-11-12 by `npm run check` (`tests/threads.test.ts`, `people.test.ts`, `receiver.test.ts`, `photos.test.ts`).
  **Live since 2026-11-12 10:23 UTC** at Robin's go-ahead (image `polycap-receiver:f3e9de5`, main's tip; the `e95f6bb`
  container kept stopped as `capture-receiver-pre-history-20261112`). Checked after: the start-up line reads "new
  members see from when they are added", and in CAP-15 the team's token sees message 1 while the Test newcomer's,
  added after it, sees none and still gets a 403 from `/v1/sessions`.
- **The choice is made when someone is added, and kept (2026-11-12, Robin chose it from
  [the research](SHARING-SECURITY-RESEARCH.md)).** Whoever on the team adds someone may let them see what came
  before: `polycap thread add MUS-12 --person ana --history visible`, `polycap thread invite MUS-12 --email
  ana@example.com --history visible`, or `history: "visible"` with `add` on `POST …/members` or `…/participants`.
  Without it, `POLYCAP_NEW_MEMBER_HISTORY` decides, `hidden` unless set. The choice is kept with that member or
  address, so changing the setting later changes only those added after, and reveals nothing to anyone already in,
  as Matrix does; to change one person's, take them out and add them again. Only the team (a team token, or a
  device of a person who holds one) may choose: a tester's addition with `history` is a 403, and without it takes
  the default. The team sees each choice (`history: "visible"` on `members` and `participants`); nobody else does.
  People added before this was built (no choice kept) see what came after they were added. Verified 2026-11-12 by
  `npm run check`. **Live since 2026-11-12 10:31 UTC** at Robin's go-ahead (image `polycap-receiver:98fe97e`, main's
  tip; the `f3e9de5` container kept stopped as `capture-receiver-pre-history-choice-20261112`). Checked after: the
  start-up line reads "new members see from when they are added unless the team chooses"; CAP-15's two invited
  addresses have no choice kept, and the Test newcomer, in by one of them, still sees none of its one message.
- **What they can do there, and nowhere else.** List it, show it from when they were added, get its events,
  record into it, post (with `post`), react, pick, close or reopen, rename (with `post`), mark read, hide,
  invite addresses, play its recordings and fetch the models its launches open. Every other thread is the
  same 404 as a key nobody has used, on every route, and its events never reach them. Being added is a
  `people` event in that thread, which wakes an agent waiting with `polycap thread watch`.
- **Their agent's bundles.** A thread-scoped `read` token lists and syncs only the sessions behind
  recordings in its person's threads, all of them whoever recorded them; every other session, its files,
  a file in it and a frame of it are a 404 ([HOSTED.md](HOSTED.md#tokens)). Robin's own `read` tokens
  stay library-wide.
- **Adding and removing people.** `polycap thread add MUS-12 --person ana` and `polycap thread remove
  MUS-12 --person ana`, with a team token (`post`, not thread-scoped), over `POST
  /v1/threads/:key/members`. A person id is a `POLYCAP_USERS` id (a tester mapped to one by
  `POLYCAP_META_TESTERS.people` or `accounts`, or `POLYCAP_GOOGLE_TESTERS.people`, is that id), a tester's
  own `meta-<id>` or `google-<sub>` while they are signed in, or a token's own id when it names no
  person. An id the receiver does not know is refused, so map a tester to a user before adding them, or
  wait until they have signed in. Removing someone also takes out an invitation by their verified
  address. The `people` event says how many, never who; `thread show` prints the members for the team.
- **Rollback.** A thread file that has gained `members` is refused by an older receiver's strict schema,
  as with `participants` (below); empty lists are not written, so threads nobody added people to and no
  tester opened stay readable. Rolling back after this is used needs `members` taken out of those thread
  files first. Grants with `"threads": "member"` must also come out of `POLYCAP_SERVER_TOKENS`, which an
  older receiver refuses at start-up; and an older receiver lets testers see their whole projects again.
  Since 2026-11-12, a member or address added with `history: "visible"` is refused in the same way by a receiver
  older than that change (`f3e9de5` and before); it is written only when someone chose it, so threads where nobody
  did read as before.

## Projects of your own

Robin, 2026-11-13: projects belong to a person and are not shared across everyone; the one exception is the
Welcome's project (START), which every newcomer sees. **The rules below are Robin's picks of 2026-11-13** (the owner
and the people in a thread see it, not the team; the owner adds people; anyone makes one, twenty each). **The
receiver and the CLI are built and on `main`** (2026-11-13, `734f986`; `npm run check` 628 passed, `tests/own-projects.test.ts`), **not
deployed**. The apps' New project is the fourth of four mockups, Robin's pick that day: IN is one amber selector
that drops a list of every project, each marked yours or the team's, ending in "+ New project", which becomes a name
field with Make (the Quest and Android XR in `InboxPane.kt`, the iPhone and the Vision Pro in `ProjectList.swift`).
Each app reads `newProjects` on `GET /v1/threads`, as the bug key reads `reports`, so an older receiver keeps today's
choice. Until now a project was only a line in `POLYCAP_PROJECTS`, so nobody could make one
from an app or the CLI ([HOSTED.md](HOSTED.md), Adding a project).

- **Two kinds.** The team's projects stay in `POLYCAP_PROJECTS` (MUS, PD, CAP, START, PF, SPOT) and are seen as
  now: a token without `projects` sees them all, one with `projects` sees those. A person's own projects live in
  `projects.json` beside `people.json` (0600, one writer at a time, checked with zod on every read; a damaged file
  is an error, never no projects), each `{ key, name, owner, createdAt, hosts, packages }`. The owner is a person
  id as `people.ts` has it: the token's user, else the token itself.
- **Who sees one.** Its owner: every token and signed-in headset whose person is the owner. Nobody else sees it
  in `GET /v1/projects`, opens a thread in it or records into it, the team's tokens included: Robin's tokens see
  the team's projects and Robin's own, not a tester's. A thread in someone's project is seen by its owner and by
  the people in that thread (members, and invited addresses once verified), as members see any thread
  ([Who sees a thread](#who-sees-a-thread)); for everyone else it is the same 404 as a key nobody has used. START
  stays the exception because every sign-in's `projects` lists it.
- **Who adds people to a thread in it.** Its owner, from any of their devices (`POST …/members` takes an upload
  token for this), as the team does in the team's projects: add a person, invite an address, choose whether they
  see what came before. Every thread in it has its owner as a member from its first message, and the owner cannot
  be taken out. The team's tokens, even when added to such a thread, manage nobody there. An address the owner
  invites is recorded and lets that person in once they verify it, but is not emailed unless the owner is on the
  team: the receiver still emails only the team's invitations, so nobody can use it to email strangers.
- **Who makes one.** Anyone with a token or a signed-in headset, testers included, up to 20 projects a person
  (403 `project_limit` after).
- **Keys.** One namespace with the team's, since thread files and events are keyed `KEY-n`. A person gives a
  name; the receiver makes the key from its first letters and digits, four at most, and adds a digit when that is
  taken (Spottisphone → SPOT, then SPOT2), or takes the `key` asked for. A key is taken when it is a team
  project's, anyone's own, or already has threads on disk (409 `key_taken`). A team project added to
  `POLYCAP_PROJECTS` later with a key someone holds stops the receiver at start-up, never shadows it. Keys and
  names are not changed and projects not deleted in this version.
- **Launches.** A new project has no hosts and no packages, so its threads carry words, photos and recordings
  but no launch: all an app makes. Its owner may give it hosts and packages from the CLI (`--host`, `--package`)
  when making it, and change them afterwards with `polycap project edit` (since 2026-11-20, [Connecting your own
  agent](#connecting-your-own-agent)), under the team's patterns ([Safety](#safety)), except a whole `*` label on a suffix where anyone names their own
  hosts (`*.vercel.app`, `*.netlify.app`, `*.github.io`, `*.pages.dev`, `*.web.app`, `*.firebaseapp.com`),
  which is refused. A launch still needs `post`, still reaches only the headsets of the people in its thread, and
  still shows its link before either key is pressed.
- **The route.** `POST /v1/projects`, any scope: `{ name, key?, hosts?, packages? }` → 201 `{ key, name, mine:
  true }`; 400 a bad shape, 403 the limit, 409 the key taken or threads off. `GET /v1/projects` marks a person's
  own with `mine: true` and lists `projects-new-v1` in `capabilities`; the apps show New project only then, so an
  older receiver keeps today's picker.
- **Where recordings go.** A token's first project is still where a recording with no project goes; own projects
  come after the team's in the listing, so a tester's default stays START.
- **The CLI.** `polycap project new "Spottisphone" [--key SPOT] [--host H] [--package P]` prints the key;
  `polycap project list` marks your own.
- **The apps.** New thread's project list on the Quest and Android XR, the Vision Pro and the iPhone ends with
  New project, which asks for a name, makes it and chooses it for the thread about to be recorded. The Mac's New
  thread (2026-11-16, Robin's pick D) shows the projects as chips on a cream plate with + New project last, which
  becomes a name field with Make (`polycap project new`); the CLI is still there for hosts and packages.
- **What it does not change.** The library: Robin's `read` tokens are library-wide and still sync every bundle,
  a tester's own project's included, as now; this rule is about threads. Reports and the Welcome stay in team
  projects, and a token's `projects` in `POLYCAP_SERVER_TOKENS` names only team projects.
- **Rollback.** An older receiver ignores `projects.json`; threads in people's own projects then match no project
  it knows and nobody sees them, the team included, until it is rolled forward. Nothing is rewritten.

## The Welcome

Built on 2026-11-10 so the first two people from outside the team open Polydance to something
other than an empty inbox (Robin: show newcomers how it works and lead them to their own use, rather than
push them into an existing project). Verified the same day by `npm run check` only, with tests against a
stand-in for Meta and Google and one end-to-end run through the worker. Live on capture.polydance.net since
2026-11-10 22:19 UTC (`private/docs/OPERATIONS.md`); START-1 is Robin's, opened by hand to try it.

- **Opened when they sign in.** With `POLYCAP_WELCOME` set (`{"project":"START","url":"https://…/start"}`),
  every Meta or Google sign-in by a thread-scoped tester asks for that person's Welcome, before the token is
  returned, since the headset loads its threads at once. It is opened once per person: signing in again, a
  second headset and a restart find the one they have (`welcome.json` beside `people.json`, 0600). A tester
  mapped to a team person gets none, and a Welcome that fails is logged and never fails the sign-in.
- **What it is.** "Welcome to Polydance" in the welcome project, written by Polydance as an agent (`as:
  "Polydance"`, shown as "Polydance", a rounded square on the headset) with the newcomer as its only member,
  so it is theirs and the team's. One message: what a thread is, and a launch, *Getting started*, that opens the
  getting-started page ([HOSTED.md](HOSTED.md#the-getting-started-page)) while it records, so their first
  recording is a look round that page. It reaches them unread and waiting, and the team sees it too: that is
  how Robin learns someone has joined, and `polycap thread show START-n` gives their person id for `thread add`.
- **The follow-up.** When the newcomer's first recording in it is built, Polydance posts once: the title,
  sentence and number of requests the summary found (or, with summaries off, how long it is), that this is
  what an agent reads, and what next: being added to other threads, New thread for their own, reply notices,
  and connecting their own coding agent, which waits for the public code
  (`private/docs/BUSINESS.md`). A failed recording waits for one that builds, and anyone else's
  recording in the thread does not count. The worker calls it after the thread hears `recording.ready`; at
  start-up the receiver also looks at every Welcome, so a follow-up a restart got in the way of still goes.
- **START.** The welcome project, "Getting started", is also where newcomers' own new threads go: their sign-in's
  default projects have START first, or START alone (`deploy/receiver/enable-welcome.py --start-only`, as on the
  live receiver since 2026-11-10), so New thread lands there and not in an existing project. Each person sees only their own threads in it; the team sees them all.
- **By hand.** `polycap thread welcome --person ID` (team, `POST /v1/welcome`) opens one for anyone the receiver
  knows: someone who signed in before it was on, a token's person, or yourself to try it. With one already
  there it says which; `--again` opens another.
- **The consent notice.** Until 2026-11-11 (`capture-hosted-1`) it said recordings were "for the team you are
  testing for", which a newcomer in their own START thread is not. `capture-hosted-2` (0.21.0 (28), not yet
  released) says a recording goes into the thread it is recorded in, and no more (Robin, 2026-11-12: the team does
  not watch other people's recordings; `/privacy` says it has access as the receiver's operator); the receiver accepts both versions, so a recording made before the update still uploads, and
  the app asks again before the next one. The receiver must have it before the headsets do; it has since
  2026-11-12 11:20 UTC (`40c7304`), and `/privacy` has the new wording.
- **Not yet.** A tester whose person id changes later (mapped to a name in
  `POLYCAP_META_TESTERS.people` after signing in) loses the threads they were in under `meta-…`, the Welcome
  included, so newcomers stay unmapped. Their agent no longer needs the mapping: since 2026-11-20 it is connected
  as the same `meta-…` person ([Connecting your own agent](#connecting-your-own-agent), built, not deployed).

## Connecting your own agent

Designed on 2026-11-20 and agreed by Robin the same day ("Yes, build it", with the five recommendations below).
**The receiver, `polycap` and the headsets' side are built**, on `main` since that day (branch
`claude/dazzling-mclean-53ceb1`, merged at Robin's "Yes, merge"). The
receiver and `polycap` are verified by `npm run check` alone (38 files and 658 tests passed; `tests/agents.test.ts`,
over HTTP with a stand-in for Meta). The headsets' Connect your agent is Robin's pick of four mockups that day,
"D, the inbox card", "and then C too" ([The headsets](#the-headsets-built-2026-11-20), below): built for Quest and
Android XR and compiled, and written for the Vision Pro and type-checked, but **seen on no headset**. **The
receiver's side is live on capture.polydance.net since 2026-11-20 12:03 UTC**
([HOSTED.md](HOSTED.md#agents-people-connect-themselves)); **the headsets' side is in no release**, so until one, a
code can be asked for only over HTTP with a device's token (Trying it, below). Nothing here has run on a headset,
and on the live receiver no code has been asked for or redeemed.

Why: an audit on 2026-11-19 found that someone whose headset app works cannot connect their own coding agent
without Robin doing three things by hand. A signed-in headset's token is `upload` only, so it cannot sync a
bundle or post. A `read` and `post` token comes only from `polycap token new`, whose line Robin adds to
`POLYCAP_SERVER_TOKENS` before recreating the container. And a tester's person is `meta-<id>` or `google-<sub>`,
which `serve.ts` refuses for a token or user set by hand, so the agent's token could not be the same person as
the headset; mapping the tester to a named user afterwards changes their person id and loses their threads
(The Welcome, Not yet). With about twenty developers Robin has never met about to be invited, and "your agent
reads it" as the promise, the newcomer has to do this alone.

**The shape: the headset shows a code, and `polycap` redeems it.** The headset is the one place the receiver
already knows who someone is (Meta or Google vouched for them), so it is where consent to a new credential is
given. The other way round (the computer shows a code and the headset takes it) means typing in a headset, and
a link by email needs an address Meta never gives.

- **The code.** `POST /v1/agents/codes`, with a device's own token (`upload`: a signed-in headset, or a headset
  or phone whose token the team made), answers 201 `{ code, expiresAt, agents, limit }`. A code is 8 characters
  from 32 that cannot be mistaken for one another (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, no 0, 1, I or O), shown as
  `K7QF-2MXD`: 40 bits (`src/pairing.ts`). It works once, for 10 minutes, and asking again replaces the person's
  last one, so at most one is live a person. The receiver keeps only its sha256, in memory: a restart voids
  every code, and the person asks again.
- **Redeeming.** `POST /v1/agents`, with no token: `{ code, label? }` answers 201 `{ token, id, label, expiresAt,
  person: { name } }`, the token this once. `polycap connect K7QF-2MXD` sends it (case, spaces and the dash do
  not matter) and never prints the token. A wrong, used, replaced or expired code is the same 404 (`reason:
  "no_code"`), byte for byte, so the route does not say which codes exist; one that is not 8 such characters is a
  400.
- **Guessing.** Redeeming is limited to 10 tries per sender in 10 minutes (nginx's `X-Real-IP`, as `/join` reads
  it) and 60 in all; past either it is a 429 until the window has moved on, for the right code too. At the overall
  limit that is 8,640 guesses a day against 2^40 codes, with one code live per person for 10 minutes at a time:
  for one live code, about one chance in 130 million a day. Asking for codes is limited to 6 per person in 10
  minutes. All of it is counted in memory, so a restart clears the counts.
- **What the token is.** A grant the receiver makes itself (`src/server/agents.ts`), never a line in
  `POLYCAP_SERVER_TOKENS`: id `paired-<8 hex>` (a prefix `serve.ts` refuses for tokens set by hand, as it does
  `meta-` and `google-`), scopes `read` and `post`, never `upload`, thread-scoped (`threads: member`) whoever
  asks, its label the machine ("Mac", from `--label` or the platform), and its `user` the person of the device
  that asked for the code: `meta-<id>` or `google-<sub>` for a newcomer, or the named user a tester is mapped to.
  `personId` is then the same for the headset and the agent, which is the whole of "the agent sees the threads
  the headset is in and the headset sees the threads the agent opens": membership, a project's owner and the view
  of a thread are all asked of the person, never of the token. Nobody's person id changes, so nothing is lost.
  The rule in `serve.ts` stays as it is, since it reads only what is set by hand. A message it posts with `--as`
  reads "Opus 5.5 on Ana's Mac".
- **Where it is kept.** `agents.json` beside `testers.json` (0600, one writer at a time, read through its schema
  at start-up; a damaged file stops the receiver, as `projects.json` does): for each, its id, person, the token's
  sha256, label, when it was connected and from which device, when it expires, and the day it was last used
  (written at most once a day). Its grants are put into the receiver's live list in place, as a tester's are, so
  the token works the moment it is issued and after a restart. The start-up line counts them.
- **Limits.** Five agents a person; a sixth code is refused (403 `agent_limit`), since silently dropping the
  oldest, as a sixth headset does, would stop an agent that is working. Each expires after 90 days, as `polycap
  token new` gives a token; the 401 then says to connect again with `--replace`, and `polycap me` prints the day.
  An expired one stays listed for 30 days, marked expired, so its 401 says why; it does not count towards the five.
- **Only while the person may sign in.** An issued token counts only while its person still has a token of their
  own that counts: a tester Meta no longer entitles, one in `blockedUsers`, a Google address no longer invited, or
  a hand-made token taken out of `POLYCAP_SERVER_TOKENS`, and every agent of theirs is refused from that request
  on. Signing in again brings them back, as it brings the person's threads back.
- **Revoking.** The person: `GET /v1/agents` lists their agents (label, connected, from which device, expiry,
  last used) and `DELETE /v1/agents/:id` disconnects one, both with a device's token; the headset's screen for it
  is still to draw. The agent's own machine: `polycap disconnect` (`DELETE /v1/agents/self`) has the receiver
  forget its token and takes it out of the settings file. Robin: blocking the sign-in stops all of that person's
  agents; one agent alone comes out of `agents.json` with the receiver stopped. There is no route for the team to
  revoke someone else's agent in this version.
- **What an agent may not do.** Ask for a code, list or disconnect other agents (those need a device's token),
  record or upload, or set its person's email address (`POST /v1/me` answers an issued token 403 `reason:
  "agent"`: a copied token must not be able to move the address that lets its person into threads).

**What it reaches.** Only what its person does, less the team's projects.

- **Threads:** those its person is a member of (the Welcome, a thread they opened by recording, one they were
  added or invited to), from when they were added, and every thread in a project its person owns
  ([Who sees a thread](#who-sees-a-thread), [Projects of your own](#projects-of-your-own)). Any other thread is
  the 404 of a key nobody has used.
- **Recordings:** `polycap sync` brings down the sessions behind recordings in those threads, and no others
  (`sessionReader` in `http.ts`, as for any thread-scoped `read` token).
- **Projects:** its person's own, and no team project. A token made with `--member` and no `--project` passes
  `projectsFor` for every team project (`!grant.projects`), so it is offered each in `GET /v1/projects` and may
  open a thread in any of them. An issued token names no team project at all (`projects: []`), not even START: it
  opens threads only in a project its person owns, and replies in a team project's thread only where its person
  is a member. START is the team's, so a developer's builds do not belong there, and its hosts are the team's.
- **Launches:** to the hosts and packages of the thread's project, as now. In a person's own project those are
  theirs to set (below), and a launch there reaches only the headsets of the people in that thread.
- **Never:** a report, the library as a whole, anyone else's project, or the team's view of anything. A person on
  the team who connects an agent this way gets the same thread-scoped token, which makes nobody else thread-scoped;
  the team's own agents are still made with `polycap token new --team`.

**A project's hosts and packages can be changed** (they could not, and a developer's first project will often be
made in the headset, by name alone, before they know where their previews live). `POST /v1/projects/:key`,
`{ hosts?, packages? }`, each the whole new list, for the project's owner with any of their tokens; anyone else,
and any team project, gets 404. The same rules as when making one (`ownHostProblem`, at most 50 of each, each
once). `GET /v1/projects/:key` answers its hosts and packages to its owner, and a team project's to the team's
tokens. `polycap project edit KEY --add-host H --remove-host H --add-package P --remove-package P` reads the
lists, changes them and prints what they are now; alone, it prints them. A launch is checked when it is posted,
so messages already sent keep theirs and a host taken out stops only new ones. This gives a copied agent token
nothing it lacked: it could already make a project with any hosts it liked. Keys and names still do not change.
`GET /v1/projects` lists `projects-edit-v1` in `capabilities`.

**What the person does, in order.**

1. On the computer: install `polycap` ([AGENT-SETUP.md](AGENT-SETUP.md), step 1), from the repository, which is
   public at github.com/Polydance/polydance since 2026-11-20.
2. In the headset: press **Connect your agent** on the card at the top of the inbox, or in the Welcome's answer,
   or open the menu and choose **Agents**. It shows the code, the line to type, and how long the code lasts.
3. On the computer: `polycap connect K7QF-2MXD`. It says who it is connected as and when the token expires, and
   has written `POLYCAP_REMOTE_URL` and `POLYCAP_REMOTE_TOKEN` to `~/.config/polycap/env` (0600). With neither
   `--url` nor a `POLYCAP_REMOTE_URL` it asks `https://capture.polydance.net` and says so. It will not write
   over a token already there without `--replace`, and says so before the code is spent; `--save NAME` keeps it
   in `~/.config/polycap/tokens/NAME` for one repository instead (`polycap link KEY --token NAME`).
4. `polycap install-skill`, then in the project's repository `polycap project new "Marimba" --host
   marimba.example.com` (or `polycap project edit` for one made in the headset) and `polycap link KEY`.
5. Tell the agent to use Polydance. It posts a build (`polycap thread new --title … --open https://…`), the
   thread appears in the headset's inbox, the person presses Record and open, and the agent waits, syncs and reads.

Steps 1, 3 and 4 are ones an agent can do when handed AGENT-SETUP.md; the person's own part is reading out a code.

**Trying it before a headset has the key.** With any device token (Robin's own Quest's, or a test newcomer's),
ask for a code by hand and redeem it on a machine, or in a scratch settings file, that has no token yet:

```sh
curl -s -X POST -H "Authorization: Bearer $(cat ~/.config/polycap/quest3.token)" https://capture.polydance.net/v1/agents/codes
POLYCAP_CONFIG=/tmp/polycap-try/env polycap connect K7QF-2MXD
POLYCAP_CONFIG=/tmp/polycap-try/env polycap project list
```

**The documents.** [AGENT-SETUP.md](AGENT-SETUP.md) step 2 is these steps, with the hand-made token kept for a
receiver you run yourself and for the team's own agents; [HOSTED.md](HOSTED.md#agents-people-connect-themselves)
has the routes, `agents.json`, what to check before deploying and the rollback. The getting-started page's "Your
own coding agent" (`start.ts`) lists the five steps, says the card and the menu's Agents need a Polydance newer than
0.22.0, and says the command-line tool comes with the source code, at github.com/Polydance/polydance since 2026-11-20
(on the live receiver from its next deployment).
The Welcome's follow-up now says to connect one and points at that section; it no longer says to wait.

### The headsets (built 2026-11-20)

Robin's picks of four mockups that day (the account sheet, behind the gear, a page from the menu, a card in the
inbox): **D, the inbox card**, **"and then C too"**, the page. The mockups were pictures of a web page in the look,
not the app; they are not kept in the repository.

- **How the headset knows.** `GET /v1/threads` says `agents: true` when the receiver connects agents, beside
  `reports` and `newProjects`; nothing is offered to an older receiver. The headset then reads `GET /v1/agents`
  once per token, and again every five seconds while the Agents page is open or a code is on show, so the card
  goes and the list fills when `polycap connect` succeeds.
- **The card in the inbox (D).** At the top of the inbox, on a cream label with the reels' orange along its top:
  "Your agent can read these", a line, and **Connect your agent ›**, which opens the Agents page with a code
  already asked for. It shows only while this person has no agent that works, in Inbox with nothing searched.
  **Not now** puts it away for that account on that headset; Agents stays in the menu.
- **The card in the Welcome's answer (D).** The same label under Polydance's follow-up to a newcomer's first
  recording, which the app knows by its sender (`polydance`) and its delivery id (`welcome-next`): an offer and
  **Connect your agent ›**; then the code where it was asked for, with the line to type, its clock and **New
  code**; then, once one is connected, its name and **Agents ›**.
- **The Agents page (C).** In the menu under Archived, opening in the right column as Recordings does: the three
  steps (install `polycap`, type `polycap connect` and the code, ask your agent to use Polydance), then **Show a
  code**, the code in the tape counter's type, the twenty-segment strip running down its ten minutes, "Works once
  · 9:41 left" and the line to type; then Connected: each agent as a rounded square with its machine's name,
  "connected 12 Nov from Quest 3 · last used today · until 10 Feb", and **Disconnect**, which asks first.
- **A code is asked for, never shown unasked,** from the menu's page, and **never while the headset records**:
  asking is refused ("Stop the recording first"), and a code already on show is hidden until the recording stops,
  so it is not in the take. The code is not logged. At five agents the headset says so instead of asking.
- **Where.** Quest and Android XR: `Agents.kt` (the model and the words, `AgentsTest.kt`) and "Your agents" in
  `InboxPane.kt`. The Vision Pro: `Agents.swift` in PolydancePhoneCore (`AgentsTests.swift`), `AgentsPage.swift`
  and `HeadsetModel.swift` in `visionos/`. The iPhone and the Mac have none yet.
- **Verified 2026-11-20, without a headset.** Android: `testQuestDebugUnitTest` and `testAndroidXrDebugUnitTest`
  passed, 118 tests each (6 new), both debug APKs assembled, lint 0 errors. Swift: `swift test` in `ios/Core`
  passed, 105 tests (9 new), and `npm run mac -- test`, which shares the thread models, ran 205 with 9 skipped
  and 0 failures; the Vision Pro's app was type-checked whole against the visionOS 26.2 simulator SDK
  with `swiftc -typecheck` ([VISIONOS.md](VISIONOS.md#verification)), since `xcodebuild` has no visionOS
  destination on this Mac. **Not exercised:** either app on a headset, how any of it looks (nothing was drawn on a
  device or in a simulator), the card's place among real threads, a code asked for and redeemed from a headset,
  and Disconnect from one.

**Not in this version.** An agent that uploads (`polycap upload` of a Mac walkthrough needs `upload`, which an
issued token never has); the team revoking one agent without stopping the receiver; renaming or deleting a
project; and an allowance per person for models and photos, which an agent with `post` can still fill
([Not in this version](#not-in-this-version)).

**What the tests prove** (2026-11-20, `tests/agents.test.ts`, 11 tests, no headset and no deployment). A pretend
newcomer signs in, asks for a code and `polycap connect` redeems it; the token is in a 0600 settings file and in
nothing printed, and `agents.json` holds only its sha256. Her agent is her person, sees no team project, syncs
her bundle with `polycap sync`, makes a project and posts a launch that her headset's token sees waiting; it
lists and plays her answer. It gets 404 for the team's thread, bundle and report, and 403 for what only a device
does. A second newcomer's agent gets 404 on every route for her threads, bundles, uploads and project, nothing of
hers in its feed even as it happens, and none of her words, ids or hosts in anything it was answered. A code works
once; a wrong, used and replaced one answer alike. Her project's hosts change for her and for nobody else. A team
person's agent is thread-scoped. Five agents is the limit; the headset and `polycap disconnect` each stop a token
at once. A token survives a restart, says so when expired, and stops when its person is blocked. Codes and tokens
run out on a clock the test holds, and the limits by sender, in all and by person refuse as written above.

**Robin's answers (2026-11-20, all as recommended):**

1. The shape: a code on the headset, typed into `polycap connect`.
2. The token's life: 90 days, then connect again, as every other token since 2026-11-12.
3. An issued token sees no team project, START included, so an agent works only in its person's own projects and
   in threads they are in.
4. A project's owner may change its hosts and packages afterwards.
5. Robin revokes by blocking the sign-in, or by editing `agents.json` with the receiver stopped; no team route yet.

## Playback

Built on 2026-10-12 so a person can watch a recording in the headset; verified the same day by `npm run
check` only, against bundles written into a test receiver's library, with no headset player.

- **Who.** A recording plays for a member of its thread and for whoever owns its upload (`canPlay`, on the
  thread and on each recording in it); a thread-scoped token must first see the thread, so its own recording
  in a thread it was taken out of no longer plays for it. Others get 403 `{ reason: "not_member" }`; a report stays the
  team's, so every other token gets 404 for its thread, as before. Both routes go through the thread,
  so a headset's upload-only token plays without the `read` scope that syncs whole bundles.
- **What.** `GET …/messages/:id/playback` returns `{ key, message, title?, summary?, recordedAt,
  durationMs?, status, audioTracks?, video: { available, bytes?, contentType? }, transcript: [{ startMs,
  endMs, text }], moments: [{ atMs, kind, text }] }`. Moments are the bundle's requests (`request`), its
  markers by their own kind (`bug`, `reference`, `idea`, `change`, `note`, `praise`) and what the inbox
  opened while recording (`opened`, "Opened option 2: Red menu"), in time order. The files are read
  through their schemas: a missing one is an empty list, a damaged one an error. While only the words
  have arrived (words first), the transcript is there and `video.available` is false.
- **The video.** `GET …/video` streams the file the manifest names, only from inside the session's folder
  and only once it is the size the upload declared, with `Accept-Ranges: bytes`, its type
  (`video/mp4`), `Content-Length` and `Cache-Control: private, no-store`. One `Range` (`bytes=a-b`,
  `bytes=a-` or `bytes=-n`) gets 206 with `Content-Range`; one past the end gets 416 with `Content-Range:
  bytes */size`; a malformed or multiple range gets the whole file. `HEAD` gets the headers alone. A
  player that goes away mid-way is not an error.
- **Not there.** 404 with a `reason`: `no_recording` for a message that is not a recording, `deleted`,
  and `not_yet` while there is no bundle, or (for the video) no whole video in it.

## CLI and the skill

```sh
polycap project list                      # the projects your token sees, the team's and yours
polycap project new "Spottisphone" [--key SPOT] [--host H] [--package P]
                                          # a project of your own: only you see it whole; prints its key
polycap project edit SPOT --add-host spot.example.com [--remove-host H] [--add-package P] [--remove-package P]
                                          # what your own project's launches may open; alone, prints it
polycap connect K7QF-2MXD [--label Mac] [--save NAME] [--replace] [--url URL]
                                          # connect this machine's agent as yourself, with the code Polydance shows
                                          # on your headset; the token is kept in ~/.config/polycap/env, never printed
polycap disconnect [--token NAME]         # give that token up, on the receiver and here
polycap link MUS [--token mus-agent]      # write .polycap.json at the repository root; commit it
polycap token new --id mus-agent --team --user robin --label Mac --scope read --scope post --project MUS --save mus-agent
                                          # a token for one agent, kept in ~/.config/polycap/tokens/, never printed
polycap token new --id ana-agent --user ana --member --scope read --scope post --project MUS
                                          # for someone outside the team: only the threads ana is a member of
polycap thread add MUS-12 --person ana    # the team adds someone to a thread by person id; remove takes them out
                                          # --history visible lets them see what came before
polycap thread list [--all] [--closed]    # this repository's project, newest activity first
polycap thread show MUS-12                # every message; saves its photos to ~/PolydanceCapture/photos/MUS-12/
                                          # and prints their paths; marks it read for your token
polycap thread new --title "New menu" --text "…" --open https://…
polycap thread reply MUS-12 --text "…" --as "Opus 5.5" [--open URL | --app PKG --extra variant=b] [--require PKG@231] [--launch a.json --launch b.json]
polycap thread reply MUS-12 --text "Two menus" --option "Blue menu" --open URL1 --option "Red menu" --open URL2
                                          # options, each with its own keys and a star; flags before the first --option are shared
polycap thread reply MUS-12 --text "Does the chair read as oak?" --model chair.glb
                                          # pushes the .glb, then Record and open on the headset records and brings the model into view
polycap thread reply MUS-12 --text "Before and after" --photo before.png --photo after.png
                                          # up to ten; converted, upright, at most 4096 px and stripped before they leave
polycap thread react MUS-12 3 thumbs-up
polycap thread close | reopen MUS-12
polycap thread rename MUS-12 "Clearer title"
polycap thread watch [MUS-12] [--once] [--kind recording.ready]   # events as they happen; --once returns on the first
                                          # (--kind recording.words wakes as soon as the words are ready)
polycap thread pending [--project MUS]    # threads with recordings (words or bundle ready), picks or photos this token has not read; exit 1 when none
```

A bare number (`12`) means a thread in the repository's project. The skill tells agents to find the
project in `.polycap.json` (or ask and run `polycap link`), to read a thread's recordings with the
existing session commands, to post a message with a launch when work is ready to try, and to
await `watch --once --kind recording.ready` in the conversation that posted the build, for a bounded
time ([the wait playbook](../skill/references/in-conversation-wait.md)). The local router that
checked every bound thread from launchd (`polycap runner`, 2026-10-08) was removed on 2026-10-12.

## Safety

- A launch is a remote "open this" on someone's headset. The receiver accepts an `open` step only for
  https links whose host matches the project's hosts, an `app` step only for the project's packages, and a
  `model` step only for a model pushed to the project; `require` only reads a version. The viewer page is
  the app's own and answers no request but its files and that model, so a model cannot reach the network. The app opens nothing until the tester presses Record and open or Just open, and shows where
  it will go.
- Host patterns allow one `*`, in the first label. Alone it is one whole label (`*.marimba.example`), and
  at either end of a label it takes letters, digits and hyphens: both suit a domain the team owns.
  Between a prefix and a suffix, as in `marimba-demo-*-yourteam.vercel.app`, it takes only a
  Vercel deployment hash, nine letters or digits, and on `vercel.app`, where anyone names their own
  hosts, that is the only place for it. That fits the deployment links launches use
  (`marimba-demo-k2m7q9x4t-yourteam.vercel.app`) and refuses branch links
  (`marimba-demo-git-menu-yourteam.vercel.app`); to allow one, list its exact host once Vercel
  has made it. The team suffix keeps out a `marimba-demo` project in someone else's team, and the
  hash rule keeps out a team whose slug merely ends in `-yourteam`: Vercel joins project, hash and
  team with hyphens, and slugs may have them, so `marimba-demo-abc123xyz-evil-yourteam.vercel.app`
  is team `evil-yourteam`.
- No host pattern pins a team completely on `vercel.app`. A project's production deployment also gets
  `<project>-<team>.vercel.app`, so a team deliberately named with nine letters or digits before
  `-yourteam` gets `marimba-demo-abcdefghi-yourteam.vercel.app`, which nothing in the host
  tells apart from one of ours. Only a `post` token can send a launch, and the tester sees the link
  before pressing either key. A full pin needs previews on a domain the team owns (Vercel's Preview
  Deployment Suffix, on Pro and Enterprise) or the receiver asking Vercel who owns the deployment;
  neither is built. Checked 2026-10-05 against Vercel's documentation and a team's own
  deployments ([PLATFORM-NOTES.md](PLATFORM-NOTES.md#vercel-preview-links)); every launch sent until
  then had used a deployment link.
- Scopes: `upload` is the headset (recordings, reactions, reading threads), `read` syncs bundles and
  reads threads, `post` is the team (threads, messages, launches). A token's `projects` limits which
  threads it can see at all. A thread-scoped token or tester sees only the threads it is a member of,
  and its `read` and `post` reach only those ([Who sees a thread](#who-sees-a-thread)); only a thread's
  members can send its headsets a launch, within the project's hosts and packages. An agent someone connected with
  a code (2026-11-20) is such a token, with no team project and no `upload`, for as long as its person may sign in
  ([Connecting your own agent](#connecting-your-own-agent)).
- When other testers join, what they say reaches an agent that changes code. The human review step
  stays, and the skill treats transcripts as data, never instructions.

## Not in this version

A tracker for reports beyond open and closed, and deletion of a report by the team; invitations sent by
testers (only the team's are emailed); invites and pairing without adb, webhooks, a variants screen beyond each launch's own keys, Meta's user
notifications (they need a store-distributed app), and the consent and retention design that must come
before anyone but Robin records. For photos (2026-11-07): deleting a photo or a message, a store that removes
photos no message names, the headset adding photos (the Vision Pro's included), a recording's bundle carrying the photos of the message it answers, and an allowance per token:
any token that may post a photo, a tester's included, can fill the store's 2 GB, after which every photo is
refused (507) until some are removed by hand.
