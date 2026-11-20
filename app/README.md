# Polydance, the headset app

**Polydance** is the shared Android headset app, with **Quest** and **Android XR / XREAL AURA**
build flavors. The Quest version records the headset view with your narration and the
app's own sound, lists the recordings, and uploads them to the hosted receiver. It began as the
*capture probe*, a one-screen app for **Meta Quest 3** that answers one question with evidence:

> Can a recording started inside an app keep running while the user switches to another app, and
> still be running when they come back?

That is hardware spikes 1 and 2 in [PLATFORM-NOTES.md](../docs/PLATFORM-NOTES.md). The answer
decides whether a companion app (roadmap phase 5) could own recording instead of the Quest's own
recorder. The original spike evolved into the hosted recorder; it is separate from the `polycap` CLI.
Version 0.14.0 is being prepared for **private Meta Quest testing**, with a free public download intended
later. It is **not uploaded or published yet**. See `private/docs/STORE.md` for the no-ADB tester
flow, signing, Meta dashboard/server prerequisites and verification limits. The ADB commands below are
historical developer tooling, not the tester installation or configuration path.

The Android XR port is a test build; capture behavior on AURA is not yet verified. See
[platform architecture, build/install commands and AURA test checklist](PLATFORMS.md). The historical
UI and hardware results below describe Quest unless explicitly marked otherwise.

## How it records

An app cannot start the Quest's system recorder; only `adb shell setprop` can. The one way an app can
record the whole headset view, including other apps, is Android's MediaProjection, which Meta supports
from Horizon OS v68 ([Meta docs](https://developers.meta.com/horizon/documentation/native/native-media-projection/)).
The probe uses it the way a shipped app would:

1. The screen asks for the mic, notifications and Quest spatial data, then shows the system capture
   consent dialog. On Android 14+ it asks for the whole display, never a single app.
2. A foreground service of type `mediaProjection|microphone` takes the token, creates one virtual
   display and records it to `video.mp4`. On Horizon OS the compositor fills that surface directly and
   scales into the requested size. There are two recording engines:
   - **muxer** (when "Record in-app audio" is on, the default): H.264 video capped at 30 fps (it keeps
     every third compositor frame, so 24 fps inside a 72 Hz app), the mic and in-app audio
     as **separate AAC tracks**, in that order (track 1 mic, mono; track 2 app, stereo), written with
     MediaCodec and MediaMuxer. In-app audio is Android's
     [AudioPlaybackCapture](https://developer.android.com/media/platform/av-capture): it hears apps that
     play as media, game or unknown usage and allow capture (anything targeting Android 10+ unless it
     opts out; most music apps allow it). It never hears system sounds. Silence fills the app track
     while nothing plays, so both tracks stay continuous and in sync on one clock.
   - **mediarecorder** (in-app audio off): MediaRecorder with the mic only. The first Quest runs used
     this; it stays for comparison.
3. Every second the service writes a heartbeat: interval since the last one, file size, mic and
   in-app audio peak level, video frames encoded (muxer engine), whether the screen is on, process
   importance and the probe screen's lifecycle state.
4. Every lifecycle callback of the screen, every projection, display and recorder callback, screen
   on/off, task removal and memory trim go to the same `timeline.jsonl`.
5. Under the gear, Diagnostics shows one line after you come back, for example
   `Away 42.1 s · recording ALIVE · file +38.2 MB (930 KB/s) · 42 heartbeats · longest gap 1.01 s · mic peak 8123 · app audio peak 20311`.
   File growth of several hundred KB/s while away means video kept being encoded; about 16 KB/s is the
   mic alone. The ticking clock there lets you match video to wall time by eye.

### Screen, Mic, App sound and Logs (2026-11-16)

Robin: a reply's recording settings should include Logs, so that when someone tries a WebXR page in the browser,
or any app, the take keeps the headset's logs and sends them in the bundle, and a reply can be recorded with the
microphone and the picture off and still send its logs. The contract is [docs/LOGS.md](../docs/LOGS.md).

- **Four switches**, the `settings` preferences `screen`, `mic`, `appAudio` and `logs`, all on by default: a reply's
  Settings (RECORD: Screen, Mic, App sound, Logs, with a dot on Settings when any is off) and the deck's own, behind
  the gear ("Record the screen", "Record microphone", "Record in-app audio", "Keep the headset's logs") and on the
  MIC and APP meters, kept in step both ways. App sound needs Screen (playback capture rides on the screen-capture
  token): with Screen off it shows off, will not turn on, and says why there and on the deck; its own setting is
  kept for when Screen comes back. The line under a launch's keys says what the take leaves out ("records logs only,
  then opens …", "records the mic and the logs, without the picture"). With everything off the key records nothing
  and says so. The bug key's reports stay as they were: the picture, and no logs. `Takes.kt` holds the rules.
- **Which take** (`TakeKind`): Screen on is the video, as before. Screen off skips the capture prompt: Mic on records
  the mic alone to `audio.m4a` (MediaRecorder, AAC, 48 kHz mono, 128 kbps) in the recorder service as a microphone
  foreground service, started from the deck while it is in front (Android 14); Mic off is a **take of logs alone**:
  nothing records while it runs.
- **A take of logs alone has no service** (`LogsTake.kt`): there is no honest foreground-service type for nothing
  running, and the person may be in the browser for many minutes while Android kills Polydance's process. The take
  is its run folder: `run.json` (startedAt, zeroAt, the boot count) and `thread.json` when it begins, no
  `summary.json` until it stops. At every process start `CaptureApplication` restores the newest such folder into
  `CaptureState`, so the deck shows it recording and its key stops it. An ongoing notification says it is running
  and opens the deck; there is no time limit, since nothing runs to enforce one.
- **The logs** (`DeviceLogs.kt`): when a take with Logs on stops, `logcat -d -b main,system,crash -v threadtime -v
  epoch -v uid -v printable -T <zeroAt>` runs once through `ProcessBuilder` (an argument list, no shell), off the main
  thread, at most 32 MiB cut at a whole line, stopped after 7 minutes; `logcat.txt` and `logs.json` (bytes, sha256,
  zeroAt, readAt, scope, truncated, note, packages) go in the run. The upload is queued only after them
  (`RunFolder.handOff`), the recorder service staying in the foreground meanwhile; the deck says it is reading them.
  A take whose stop never got to them (the process died) reads them when it next uploads.
- **Whose lines.** `READ_LOGS` is declared in debug builds only (`src/debug`): Meta's store prohibits it
  (`tools/store.ts`), and only adb can grant it: `npm run app -- logs [--platform quest|android-xr]` grants it and
  reads back that it is granted; Android restarts Polydance to apply it. Even then Android 13+ asks "Allow Polydance
  to access all device logs?" each time, only while Polydance is on top, so a take reads its logs at Stop **from the
  deck**. Stopped from the notification, or without the grant, a take keeps Polydance's own lines, and `logs.json`'s
  note says why in words (with the adb command when it is the grant). `scope` is `device` when a line came from
  another uid than Polydance's.
- **Upload.** The create carries `logs` and `durationMs`; a take of logs alone has no `bytes`, `sha256` or
  `fileName`, and sound alone sends `audio.m4a` with `audioTracks: ["mic"]` and no narration. When the receiver says
  `logs: "expected"`, `PUT /v1/uploads/:id/logs` goes first; a refusal fails the upload with the receiver's words.
  Logs alone are uploaded once the receiver reports them received. The meter says "sending the logs · 0.4 of 2.0 MB".
- **In the inbox**, a recording whose `content` is `none` has no play key and says LOGS ONLY; `sound` plays and says
  SOUND ONLY where the picture would be; anything else is a video, as before. This headset's own cards and the
  Recordings page say "Sound only" or "Logs only" beside the length.
- **Not verified on a headset** (built 2026-11-16, JVM-tested and linted only): whether Horizon OS shows Android's
  prompt at all, whether the Quest Browser writes a page's console to logcat, how much the log buffer holds, the
  microphone service with no projection, and a take of logs alone surviving a killed process.

## The screen

Five design passes by Robin on 2026-10-01 and 02 shaped it, each recorded in the headset and read
back through the skill. The first (the recording of 2026-10-01 22:12) asked for a recorder: one
big button, the state at a glance, the recordings in view, settings and diagnostics behind a gear. The
second (23:03) pointed at the "Technics RS-1700" illustration by
chiporchuk on Dribbble: a reel-to-reel deck in outline, storage as tape, recordings as rack units.
The third (23:29) moved it towards a 1960s portable deck he showed on
Envato (cream top plate, clear reels with orange labels, a black control panel, piano keys) and asked
to copy it as closely as a flat panel allows. The fourth and fifth (`2026-10-02T00-31-08` and
`2026-10-02T00-33-28`, recorded with build 0.3.0 at `7469b3e`) took away duplication and pointed at a
Google image of the Pulsar Modular P252 MDN Diode compressor plugin: a dark faceplate screwed into a
wooden frame, bat-handle toggles and amber LED bars.

- **No title bar.** The bar reading "Polydance Capture" at the top was Android's own action bar, not
  Quest chrome as first reported; the `Theme.DeviceDefault.NoActionBar` theme removes it.
- **The top plate:** cream metal with corner screws and brushed lines, two clear reels with orange
  labels that turn only while recording, spinning up from still over 1.6 s and running down over 1.2 s
  like a transport (seventh pass; until the sixth they also turned backwards while uploading), growing
  to fill the height the rack left, the right one without a hub so the logo shows whole, "POLYDANCE CAPTURE" printed
  around the left reel and the Polydance ballerina (`res/drawable-nodpi/polydance_mark.png`, from
  polydance2's `public/polydance-mark.png`) on the right reel's label.
- **Storage is tape:** the brown tape on the take-up reel grows and the supply reel shrinks as the
  allowance is used, red when full, with "0.5 / 8 GB" under it and, beside that, a small list key that
  opens the inbox on the recordings stored on this headset (seventh pass).
- **A light wooden cabinet** behind everything (generated grain and board seams), with every plate
  screwed to it at the corners and the lettering on the wood (RECORDINGS) burnt in, dark brown.
- **The control panel** (black, white lettering): MIC and APP needle meters for the two audio tracks,
  each with its track's **OFF/ON switch** on the meter's housing strip, a bat-handle toggle that only a
  press on the switch moves and that is locked while recording; then the **UPLOAD** and **PROCESSING**
  lamps left of a rolling-drum counter and **REC** and **READY** right of it (eighth pass, 2026-10-05);
  and the red **RECORDING** key that reads REC, STOP or FULL.
  Nothing else: the RECORDING lettering above the key and the state word under it went in pass 4,
  since the REC lamp says it. A hint line appears only when something needs doing (accept the
  permissions, delete recordings when the tape is full, no server set).
- **UPLOAD and PROCESSING lamps** (eighth pass, 2026-10-05, CAP-1 #14): UPLOAD flashes amber while any
  recording is going up and PROCESSING cyan while the receiver builds one (polled every 3 s while one
  is). The transfer unit that had a line of LED segments per recording, from the fifth pass, came off the
  deck, and the reels took its space; how far each recording has got is on its card in the inbox, by
  bytes sent and then the receiver's pipeline steps (`steps { done, total }`).
- **No rack of recordings on the deck** since the sixth pass (2026-10-04, thread CAP-1): recordings live
  in the inbox, on their cards in their threads. `ServerSync` keeps asking the receiver how they are.
- **App switches (behind the gear):** a button opens Android's Usage access page for the app; with it on,
  each recording notes which app came to the front when, and its version, from the system's usage log
  read once at Stop (`AppSwitches`, `apps.json` in the run, `apps` on the upload). No adb is needed. The
  browser's page address is not available to another app.
- **Notifications (behind the gear, 0.9.0):** off until you press Turn on, which asks for the
  notification permission when the headset has not given it (on the Quest 3 it had already granted it
  without asking, 2026-10-05, so the switch is the opt-in). Then every 15 minutes the app asks the receiver which threads this headset has
  not read and posts one notification per thread for replies by others ("MUS-4 · New menu", "Opus 5.5
  on Robin's Mac: Moved Settings to the top"); tapping it opens the deck with the inbox on that thread,
  and reading the thread clears it. Nothing is posted while the app is in front. Turning it on posts
  "Notifications are on" at once, which is how to tell whether Horizon OS shows them at all: Meta
  documents Android notifications as unsupported (PLATFORM-NOTES). Turn off stops the checks and clears
  what is shown. Not yet tried on the headset.
- **Behind the gear:** recording settings (remembered across launches), the server, and diagnostics:
  device and build, the app's own version and commit, the clock, live stats, the away line and the
  events log.
- **The bug key (2026-10-12, [docs/THREADS.md](../docs/THREADS.md#reports)):** a beetle printed left of
  the gear. It opens a pop-up that says a report is for Polydance itself (a bug, or a feature you would
  like), that it goes only to the Polydance team, not to the inbox, and leaves the headset once sent,
  with Start recording and Cancel. A report records like any recording, under `→ REPORT · Polydance
  team`; it uploads at once with no hold, is deleted from the headset when the receiver has verified it,
  and is swept at each start if sent, cut off or a week old (`Reports`, `ReportPolicy`). It is never in
  the inbox or on the tape. Not yet seen on a headset.
- **One panel (0.17.0, 2026-10-20):** the deck, the threads and the open thread side by side, like a desktop
  mail client; the inbox tab and the separate inbox and viewer panels described below are gone.
- **Photos in messages (built 2026-11-07, [docs/THREADS.md](../docs/THREADS.md#photos)):** a message's photos
  are a row of tiles under its words, each as wide as its shape at 150 dp (`PhotoStrip`). Each is fetched
  through the thread, checked against its sha256 and kept in the app's files, the 48 most recently drawn
  (`Photos`), and drawn shrunk by a power of two to its tile. Pressing one shows it large over the panel with
  its size and Close. A headset not in the thread reads "2 photos only people in this thread can see."; a
  folded message carries PHOTO or 3 PHOTOS. The headset adds no photos. Not yet on a headset.
- **Two keys on a launch (Robin, 2026-11-07, every platform).** **Record and open**, red with the camera,
  records and then opens what the launch names; **Just open** beside it opens it with no recording. A
  launch that opens nothing has **Record** alone. They replace the one Reply key and the Record and Open
  switches; Settings keeps Mic and App sound. Every press checks the builds the launch asks for, since
  no switch can turn opening off any more. While recording, either key opens the launch into that
  recording. Compiled, linted and unit-tested for both flavours; not yet seen on a headset.
- **Connect your agent (built 2026-11-20, in no release; [docs/THREADS.md](../docs/THREADS.md#the-headsets-built-2026-11-20)).**
  Robin's picks of four mockups, D and then C too. While this person has no agent connected, a cream label at
  the top of the inbox, with the reels' orange along its top, offers **Connect your agent ›**; **Not now** puts
  it away for that account. The same label sits in the Welcome's answer. **Agents**, in the menu under Archived,
  is a page in the right column: the three steps, **Show a code**, the code in the counter's type with the
  twenty-segment strip running down its ten minutes and the line to type on the computer (`polycap connect
  K7QF-2MXD`), then the connected agents, each with **Disconnect**. Shown only when the receiver says `agents`
  on `GET /v1/threads`. A code is never asked for or shown while the headset records, and never logged.
  `Agents.kt` holds the model and the words (`AgentsTest.kt`); the views are "Your agents" in `InboxPane.kt`.
  **Not seen on a headset:** compiled, JVM-tested (118 per flavour) and linted only.
- **The inbox (0.6.0, [docs/THREADS.md](../docs/THREADS.md)), as it was until 0.17.0:** a dark tab lettered INBOX stuck out
  of the deck's right edge, with a red badge counting threads that hold something unseen (9+ past nine).
  It opened the inbox as a second panel beside the deck (`InboxActivity`, launched with
  `FLAG_ACTIVITY_LAUNCH_ADJACENT | NEW_TASK | MULTIPLE_TASK`), on the same wooden cabinet: a header plate
  with INBOX, the project new threads go to, and **+ New**; then the threads as rack units, newest
  activity first, lit red (NEW) when something is unseen and amber (TRY) when a launch is waiting. A
  thread opens oldest first, the team's messages on the left and this headset's recordings on the
  right; each launch has a red **START** key, always in that word, with what it does beside it ("records,
  then opens marimba-demo-…vercel.app in the Browser"; a launch's label names a variant), and each
  message the reactions given and a smiley that opens the six in a pop-up with Close. Opening a thread
  marks it read. Since the sixth pass each recording's card carries its status in the deck's
  colours (UPLOADING amber, PROCESSING cyan with its steps, ON SERVER green, problems red), a strip of
  segments while it moves, the reason when something went wrong, and Retry and Delete for this
  headset's own; one still on its way shows at the bottom of its thread. Since the seventh pass
  (2026-10-04) the header plate and a page's back key and title stay fixed while the page scrolls; a
  funnel key beside INBOX filters the threads to some projects or all (+ New asks which project when
  more than one shows); rows no longer say TRY (the lamp still goes amber while a launch waits); and
  everything stored on this headset is on a **Recordings** page of its own, with size, thread, Retry and
  Delete, opened from the deck's list key or from a notice above the threads when one has not gone up.
- **The Gmail layout (0.15.0, 2026-10-12, Robin's screenshots of the Gmail mobile inbox).** The INBOX
  header plate, funnel and + New gave way to a search bar: three lines open a drawer down the left
  (Inbox with its unread count, Archived, the projects to show, the headset's Recordings), the field
  narrows the threads to those matching every word typed (title, key, project, latest words, people), and
  a circle in the corner holds the first letter of this headset's person's email (of their name until they
  give one, with an amber ring meanwhile); pressing it opens the account sheet, where the email is typed
  once (Horizon OS gives the app no email) and saved to the receiver, which emails a link to confirm it;
  once confirmed, threads that invited that address appear in the inbox. Under the bar a line says
  what shows ("INBOX · ALL PROJECTS"). Each thread is a row on one dark plate: who is in it on the left (one
  circle for a thread of one person, overlapping circles for several, +N past three, an outline for an
  address invited but not yet joined), the title (bold while something is unseen) with the time of its last
  message, and its latest words under it, a message's text or a recording's summary, after its key. No
  star: a lamp in the star's place is red for something unseen and amber while a launch waits. **New
  thread** floats bottom right, a light key with a red camera, and opens a compose sheet: the project
  (when more than one shows), a To line for email addresses (Add, Done or a comma; each with ✕), and
  Record. The addresses go with the recording (`invite.json` in the run) and are added to the thread once
  the receiver has made it. When the person adding them is on the team, the receiver emails each an
  invitation (who added them, the thread's title, how to join; no recordings or messages); a tester's
  additions are kept but not emailed, and People in this thread says, per address, whether it was emailed
  and the receiver's note when not. (This wording is from 2026-11-10 and ships in the next app release;
  until then the headset says nothing is emailed.) **A thread** has Gmail's bar: back on the left;
  Archive (closes the thread, so it leaves everyone's inbox until someone adds to it), Delete (from this
  inbox only; it comes back when someone else adds to it) and ⋮ (Add people, People in this thread,
  Archive, Delete, Recordings) on the right. Its title is large with the project and key as labels and
  who is in it under them. Messages are full width, each headed by the sender's circle, name, number and
  time and a smiley to react; a reaction given is a chip that gives or takes back the same one. A
  recording shows a tile with a play triangle and its length beside its title, summary and status; the
  tile opens **the player**. Fixed at the foot: **Reply** with a red camera (it records a reply, as the
  deck's key does), **Share** (adds people by email; called Forward until CAP-7, 2026-10-15) and a smiley that reacts to the latest message.
- **The player (0.15.0, `PlayerActivity`).** Opens over the inbox in its panel. The video plays from
  this headset's own copy when it has one, otherwise it streams from the receiver by range, so it seeks.
  Under it, a timeline with the key moments as ticks in their kinds' colours (asked for amber, bug red,
  idea and praise green, change blue, reference cyan, opened cream), play and pause, ten seconds back
  and ahead, the clock, and Voice or App sound when the recording has both tracks (the platform player
  plays one audio track at a time; switching reopens it at the same place). Then the recording's title
  and summary and two lists, Key moments and Transcript; pressing a moment goes to two seconds before
  it and plays, pressing a line goes to it, and while playing the line being spoken is lit amber and
  kept in view unless the list was just moved by hand. Without the receiver's playback route (older
  receiver, offline, or not in the thread) this headset's own copy still plays, without transcript.
  Built 2026-10-12 and compiled, linted and unit-tested; not yet seen on a headset or an emulator.
- **A box beside START** (eighth pass, 2026-10-05, CAP-1 #12) on any launch that opens something,
  ticked by default: untick it and START records the reply without opening the link or app, and the line
  beside START says so ("records only; leaves … closed"). The recording still answers the message, but
  names no launch, so its bundle does not say it started with one. The choice lasts while the inbox is
  open. **The project filter works** (CAP-1 #13): the pop-up had been dropping the choice when it closed;
  with a filter on, a line under the header says what is showing ("SHOWING MARIMBA") with Show all.
- **Tenth pass (0.13.0, CAP-1 #24).** START's settings fold away behind a Settings key: unfolded,
  Record with Mic and App sound under it, and Open on its own row. Mic and App sound are the deck's meter
  switches, kept in step both ways, so changing one place changes the other; the line under START names a
  sound left out ("records without the mic, then opens …"), and Settings shows a dot when anything is not
  at its default. While recording, a smaller Cancel key beside STOP ends the recording and deletes it,
  after one confirmation; nothing is uploaded. Since CAP-5 (2026-10-13) it sits right next to STOP, which stays
  centred, rather than at the panel's edge; New thread in the inbox is greyed out while recording, and the
  account, New thread and Forward sheets have a fixed width, after the account sheet collapsed to a sliver.
  From CAP-7 and CAP-8 (2026-10-15, build 21): a message's key that records reads **Reply** with the camera; once
  a thread's big title scrolls off, a slim strip under the top bar keeps its title and key in view, and a press
  opens it out to the labels and people; Forward is **Share**; and when a message asks for a newer Polydance,
  an **Update** key beside START's warning opens Polydance's store page (CAP-6 #3).
- **Ninth pass (0.12.0, CAP-1 #20 and #21).** Two switches beside START, Record and Open, as filter
  chips with a tick, replace 0.10.0's box: Record off turns the key into OPEN, which opens the link or app
  with no recording. The star and reactions change the moment they are pressed and go back, with an
  error, only if the receiver refuses. After Stop a recording waits before it uploads, 5 s, or 30 s and
  marked SHORT when under 20 s, counting down on its card with Send now and Delete, so a mistaken one can
  go before it reaches the server. On the Recordings page there is no + New, each recording has a Select
  chip, and Delete in the header removes all selected everywhere after one confirmation.
- **Options (0.11.0, CAP-1 #17).** A message with several launches shows them as OPTION 1, 2, 3, each on
  a plate of its own with its name, START and what it does, under a line saying they can be recorded one
  by one or in one take (start one, then press the next START while recording). Each option has a star:
  ☆ Pick, ★ Picked in amber, one per message, pressed again to take it back; other people's stars show by
  name. The launch log notes which message and option each opening was, and a recording's card says
  "answers option 2 (Red menu)" or "tried options 1 (Blue menu), 2 (Red menu)".
- **Every recording is in a thread.** Start checks the versions the launch requires (a mismatch can be
  started anyway), hands the launch to the deck, which asks for capture, records and then opens the
  link in the Quest Browser or the app with its extras. The deck's key replies to the thread open in the
  inbox, or starts a new thread in the chosen project, and with the inbox closed it opens it on that
  thread once recording begins (sixth pass); a line under the key says which
  ("→ MUS-12 · New menu", "→ NEW THREAD · MARIMBA"). The run keeps `thread.json` and the upload sends
  it as `thread`. Back on the deck mid-recording, a line says one press finishes and sends it.
- **Who sent it, and what was opened (0.9.0).** Each message card names its sender the way the receiver
  does ("Robin · Quest 3", "Opus 5.5 on Robin's Mac") beside an avatar: a circle with the person's
  initial, or a rounded square for an agent, in the person's colour. A START pressed while already
  recording opens its launch straight away instead of being refused, and every launch opened during a
  recording is written to `opened.json` in the run with its clock and label, which the upload sends as
  `opened`, so the bundle says which build or variant was on screen when.

Each recording notes the app's version and the commit it was built from in `run.json` when recording
starts (the commit with `-dirty` when the Android project had uncommitted changes), and
the upload sends it, so the bundle's `source.appBuild` says which build was on screen in a design pass.
The upload also says which audio track is which (`audioTracks`, mic then app), so `polycap export` can
cut a clip with the app's sound and no narration.
Recordings made before 0.3.0 carry the version only. Since 0.10.0 the version code comes from the
installed package and the commit from a resource (`R.string.git_commit`), both read at run time: as
`BuildConfig` constants they were copied into each class at compile time, and the recorder's class, not
rebuilt, made the 0.9.0 recordings of 2026-10-05 say `0.9.0 (8) 0f2e3dd-dirty` when the build on the
headset was `0.9.0 (9) f7d642f`. Release builds are also made with `clean` now.

Not done from pass 3: reels outside the panel or in 3D. A 2D Android panel cannot draw past its own
rectangle; that would need a Meta Spatial SDK app with the reels as 3D objects beside the panel.

The app asks Horizon OS for a 640 x 960 dp portrait panel; without the `<layout>` element it got 400 x
640. Screenshots from the headset (`adb exec-out screencap -p`, both eye buffers at 4128 x 2208)
checked each version up to pass 3; the animations (reels, counter, lamps, meters) were checked in
recorded frames. Passes 4 and 5 were seen in the headset on 2026-10-02 (build `200083c`, the top two
thirds of a screenshot; the transfer was cut off when the Quest slept): the switches on both meters,
REC and READY either side of the counter, the plain REC key, the transfer unit idle, screws on every
plate and wood between them. Not yet seen: the burnt RECORDINGS heading and the transfer bar moving.

## Build

Needs a full JDK 17 (the macOS Temurin JRE has no `javac`) and the Android SDK.

```bash
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
npm run app -- build --platform quest
```

From the repo root, the Quest APK is
`app/android/app/build/outputs/apk/quest/debug/app-quest-debug.apk`. Use `--platform android-xr` for
`app/android/app/build/outputs/apk/androidXr/debug/app-androidXr-debug.apk`. Add `--release` for release.
Both share an application ID; installing one replaces the other on a given device. The old unflavored
APK path is obsolete. [Full build/verification reference](PLATFORMS.md#build).

## Install on the Quest 3 over Wi-Fi

Meta documents one route ([Meta: adb](https://developers.meta.com/vr/documentation/spatial-sdk/ts-adb/)):
plug in by USB once, switch adb to TCP, connect by IP, unplug. `npm run app -- wifi` does exactly that. It lasts
until the headset reboots.

```bash
npm run app -- wifi
```

```bash
npm run app -- install --launch
```

Switching adb to Wi-Fi makes the headset ask again to allow debugging from this Mac; `wifi` waits
for you to accept it. Tick "Always allow from this computer" so later connections do not ask. MQDH's
"ADB over Wi-Fi" toggle does the same thing on the same port and works alongside. After a reboot,
plug in and run `wifi` again. If the headset is still in TCP mode and you know its
address, `npm run app -- install --connect 192.168.1.50` connects and installs without the cable.
`install` checks the selected platform against device model properties and refuses a mismatch.
Device commands default to Quest; use `--platform android-xr` for AURA on install, configure and pull.
Ambiguous devices require `--device SERIAL`; unknown engineering-device installs additionally require
`--any-device`. Android XR wireless debugging uses pairing and an explicit connection port, not this
Quest TCP workflow. [AURA connection instructions](PLATFORMS.md#connect-and-install-aura).

## Run the test in the headset

1. Library → Unknown sources → **Polydance**.
2. Press the red **RECORDING** key. Allow each permission prompt, then accept the capture dialog (pick the
   entire view if it offers a choice). The defaults (1920 x 1080, microphone, in-app audio, spatial
   data) are under the gear.
3. Talk for ten seconds; the meter's needle should move with your voice.
4. Open any immersive app from the library. Use it for 30–60 seconds and keep talking.
5. Come back to Polydance from the universal menu. The state should still read RECORDING with
   the counter running; the away line under the gear says **ALIVE** or **ENDED**.
6. Wait ten seconds, then press the RECORDING key again (it reads STOP).

Worth repeating as separate runs, one change each:

- a 2D app (Browser) instead of an immersive one;
- close the probe's panel with its X while away (the service is not tied to the task);
- take the headset off for 30 seconds while away (sleep);
- an app that uses the microphone itself (spike 2: does our mic go silent?);
- a square picture, in case the compositor letterboxes 16:9 (the 1024 × 1024 preset was dropped on
  2026-11-18 for Low, Medium and High picture quality; it would come back as a fourth choice).

adb can drive the start and stop when you want to script it. The consent dialog still has to be
accepted in the headset:

```bash
adb shell am start -n net.polydance.capture/.MainActivity -a net.polydance.capture.START --es quality low --ez mic true
```

`--ez screen false` records without the picture (no capture dialog), `--ez logs false` keeps no logs, and both with
`--ez mic false` make a take of logs alone. These extras set the deck's switches, as the others do.

```bash
adb shell am start -n net.polydance.capture/.MainActivity -a net.polydance.capture.STOP
```

`adb logcat -s PolydanceCapture` shows every timeline line live.

## Recordings list and uploads

Below the deck the app lists every recording on the headset, newest first, as rack units: its title
(the receiver's few words once it has them, else when it was made), when, length and size, the
receiver's one-sentence summary, and where it is on the way to the hosted receiver
([docs/HOSTED.md](../docs/HOSTED.md)) in a word: NOT UPLOADED, WAITING, UPLOADING 42%, PROCESSING,
ON SERVER, FAILED (with the reason), REMOVED, or CUT OFF. Each unit has **Upload** (or **Retry**) and
**Delete**.

- **Cut off recordings.** A recording only becomes a playable file when Stop writes its index. If the
  app is killed mid-recording (an update installed over it, a force stop, a crash) the file cannot be
  played, and the card says so and offers only Delete. `npm run app -- install` refuses to install
  while a recording is in progress for exactly this reason (2026-10-01: an install cut off a 1:37
  recording; `--force` overrides).

- **Uploads start by themselves** when you press Stop, as WorkManager jobs: they keep going with the
  app closed, wait for a network, back off after errors, and resume from the byte the server has. The
  recording on the headset is never changed by an upload.
- **How it is going** (2026-11-15, as the iPhone since 2026-11-14; Robin: "no idea how much is left or if it's
  stuck"). On the Recordings page and on the thread's card for a reply on its way, UPLOADING 42% sits over the
  twenty-segment strip and a line: "460 of 1,087 MB · 2.1 MB/s · about 5 min left", the rate over the last 30 s.
  Before the video it reads "getting the take ready to send", then "sending the words first · 3.1 of 14 MB".
  Once no byte has moved for 20 s, the strip dims, the words turn amber and say for how long and why when the
  headset knows: "nothing sent for 40 s · sending again in 25 s" (WorkManager's backoff after a failed attempt)
  or "· waiting for Wi-Fi" (no network). It moves within each 8 MB chunk: `ReceiverClient` counts the bytes it
  writes, `UploadWorker` passes them to `UploadLive`, and the inbox redraws only those lines each second. The
  numbers and words are `UploadMeter.kt`, a port of the iPhone's `UploadMeter.swift` with its tests. Memory only:
  after the app starts again the stall clock starts again.
- **Words first** (0.9.0). Before the video, the upload sends the mic track alone (`narration.m4a` in
  the run, copied out of the recording without re-encoding, about 1 MB a minute), so the receiver
  transcribes and titles the recording while the video is still going up. The card in the thread shows
  the title and sentence as soon as they exist. A receiver that refuses the narration, or a recording
  without a mic, just sends the video as before. Not yet tried on the headset.
- **Delete** removes a recording everywhere, after a confirmation: this headset's copy at once, and
  the server's copy by a queued job, so a delete made offline still reaches the server. A bundle already
  synced to a Mac stays there. Robin chose "always everywhere" on 2026-10-01. polycap's own tools still
  never delete on the headset.
- **Storage.** Each headset has an allowance on the server (8 GB, about two hours at 1080p). The list
  shows it, for example "Server storage: 3.4 of 8.0 GB used (+0.1 GB waiting to upload)": recordings
  not yet uploaded count too. When it is full, Start reads "Storage full" and does nothing until
  recordings are deleted; offline, the last known figures apply. A recording the server had to remove
  says so in its row.
- **Set the server once** from the Mac. The token comes from a private file, never the command line:

```bash
npm run app -- configure --server http://192.168.1.179:8790 --token-file ~/.config/polycap/quest3.token
```

Debug builds may use plain HTTP to a local-network address; release builds need HTTPS. To queue one
recording from the Mac (the same as its Upload button):

```bash
adb shell am start -n net.polydance.capture/.MainActivity -a net.polydance.capture.UPLOAD --es run 20261001-161948
```

## Pull and analyse on the Mac

```bash
npm run app -- pull
```

```bash
npm run app -- analyze latest
```

`pull` copies every finished run from `/sdcard/Android/data/net.polydance.capture/files/runs/`
to `.local/runs/<run>/` (gitignored, owner-only), verifying size and sha256 against the
device. It skips a run that is still being written and never deletes anything on the headset.

`analyze` answers **YES**, **NO** or **INCONCLUSIVE** (exit 0, 3, 4) and gives reasons. YES requires all of:

- the run ended because you pressed Stop (or the 30-minute limit), not because the system ended it;
- the screen was hidden for at least 5 s at least once (otherwise INCONCLUSIVE);
- in every such period, no stretch over 2 s without a frame, and no more than half the time black;
- frames again in the 3 s after coming back;
- the video is at least 90% as long as the recording ran.

Frozen picture, heartbeats more than 3 s apart, and a mic or in-app audio track that read zero while
away are reported as warnings: a still scene freezes too, a quiet room reads zero, and an app may play
nothing. Each audio track is listed by name with its mean and peak level. It saves `analysis.json` and
`away-N.jpg`, a frame from the middle of each away period. Open it: it should show the other app,
not black and not the probe. For every frame, `polycap import <run>/video.mp4` builds a normal bundle.

## Run folder

| File | Written by | Content |
| --- | --- | --- |
| `run.json` | app, at start | device (manufacturer, model, Android, SDK, build), app version, capture settings (`kind`, `screen`, `logs` since 2026-11-16), `engine`, `audioTracks` in file order (MP4 tracks written by MediaMuxer have no names), `zeroAt` (the take's 0:00 on the wall clock) and `boot` |
| `timeline.jsonl` | app, line by line | every event: `t` wall ms, `up` elapsedRealtime, `rel` ms since the recorder started, `src`, `ev`, fields |
| `video.mp4` | app | the recording; unplayable if the app was killed before Stop |
| `audio.m4a` | app | instead of `video.mp4` when Screen was off and Mic on: the mic alone |
| `logcat.txt`, `logs.json` | app, at stop, when Logs was on | the headset's log from the take's 0:00, and what it holds and why (docs/LOGS.md) |
| `summary.json` | app, at stop | end reason, duration, bytes, heartbeats; missing if the process died, and while a take of logs alone runs |
| `analysis.json`, `away-N.jpg` | `npm run app -- analyze` | the verdict and its evidence |

## What this does not test

- **Every app's audio.** Apps that opt out of capture, or play with another usage (voice calls,
  notifications, the system's own sounds), are not in the app track. Check a new target app with
  `adb shell dumpsys package <pkg> | grep ALLOW_AUDIO_PLAYBACK_CAPTURE`.
- **Policy.** Meta allows MediaProjection "to enable casting, live streaming, or screen sharing" and
  for no other purpose; recording to a file is not named. A technical YES does not make a store
  release acceptable. Sideloading for our own testing is a different case.
- **Other headsets.** Built for Quest 3. The Android XR puck runs it (the app reached the permission
  prompt there on 2026-10-01) but its display was off, so nothing was captured.

## Names

The app is **Polydance** (its label since 0.14.1; from 2026-10-02 it was Polydance Capture), app id
`net.polydance.capture` since 2026-10-02 (Robin's call; it was
`dev.headsetinbox.captureprobe`, from when it was the capture probe). Its Mac tools are
`npm run app -- ...` in `app/tools/`, its log tag is `PolydanceCapture`, and its session ids end
`_capture`; earlier ones end `_captureprobe`. Only the timeline's event names still say `probe`,
because the analyser reads runs from both eras. A new app id is a separate app to Android, so
`npm run app -- migrate` copied the old app's recordings, upload state and settings into the new one
over adb; the old app stays installed until it is uninstalled by hand.

## Results

One row per run, dated, with the build from `run.json`. Runs are in `.local/runs/<run>/`.

| Date | Headset, build | Scenario | Answer | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-01 | Quest 3, Android 14 (SDK 34), UP1A.231005.007.A1; run `20261001-143151` | 1920 × 1080, mic on, spatial data granted. Probe for 15.5 s, an immersive music app for 39.6 s, back to the probe for 7 s, Stop. Headset worn throughout. | **YES** | 62.1 s of video for 62.5 s of recording, 1851 frames, no gap over 0.5 s anywhere; 30.0 fps while away. Frames while away show the music app (title, then the desert scene); its own loading fades account for the 18% black. 39 heartbeats while away, at most 1.1 s apart; two `trim_memory` level 5 while away, process stayed alive. Mic stayed live: peaks up to 5189 while away, audio −37.8 dB mean while away against −62 dB before. Projection reported content 4128 × 2208, scaled into 16:9. Passthrough and Home panels are in the capture. |
| 2026-10-01 | Quest 3, same build; run `20261001-144015` | Meant as the Browser (2D) case. 1920 × 1080, mic on, MediaRecorder engine. Probe 8.3 s, away 20.8 s, back 3.6 s. | **YES**, but not the 2D case | No gap, 30.0 fps away, nothing black or frozen, mic peak 3873. The away frames show a desert scene with drumsticks, not the Browser; the next run shows that scene is the music app's drum lesson. The 2D case is still untested. |
| 2026-10-01 | Quest 3, same build; run `20261001-161948` | In-app audio on: **muxer engine**, tracks video, mic (mono), app (stereo). 1920 × 1080. Probe 5.2 s, the music app with sound 69.7 s (Unity splash, title, Piano menu, Drum Basics lesson), back 5.6 s. | **YES**, and both audio tracks recorded | 80.2 s of video, 2045 frames, largest gap 69 ms. **Mic and in-app audio were captured at the same time**: mic mean −39.8 dB, peak −8.7 dB; app mean −17.6 dB, peak 0.0 dB (0.006% of samples at full scale). 25.5 fps average: 30 at Home, 24 in the music app; the 30 fps cap keeps every third compositor frame, which suggests Home at 90 Hz and the music app at 72 Hz. Video starts 0.7 s after the audio (the compositor's first frame). Surface timestamps were on the same clock as the audio (offset 36 ms, no rebase). The mic barely correlates with the app track (0.01–0.04), so their relative sync could not be measured that way; the Quest probably cancels its own speaker output from the mic (not verified). One `trim_memory` level 10 while away; process stayed alive. All three MP4 tracks are marked default. polycap's audio step extracts the mic track from this file (−39.8 dB), where ffmpeg's own pick is the app track (−17.6 dB). |

Still open after these runs: a 2D app instead of an immersive one, closing the probe's panel, sleep
when the headset comes off, an app that holds the microphone itself (spike 2 proper), longer runs,
whether 4128 × 2208 squeezed into 16:9 distorts the picture (1024 × 1024 and a 1.87:1 preset would
show), and how well the app audio lines up with the picture (needs a scene with a sharp, visible sound).
