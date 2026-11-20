# Polydance for iPhone

Since 2026-11-07 the app's screen is the deck in the look every platform shares (the headset's tape
recorder on a wooden cabinet, drawn by PolydanceShared, [docs/IPHONE.md](../docs/IPHONE.md) I1): the deck
on top, the inbox below, REC full screen with the camera ([The screens](#the-screens)). Since that evening
(I3) the phone pairs with a receiver by a QR code from the Mac (`npm run ios -- pair`), and its inbox,
threads, replies and reports are the receiver's ([Pairing and threads](#pairing-and-threads)). Under it the I0
probe still runs unchanged: the recorder, the background upload and the refresh, all writing their
evidence to the event log. The probe's own plain screen is a debug view behind the gear (Settings, "The I0
probe's screen").

Phase I0 of [docs/IPHONE.md](../docs/IPHONE.md), "spike on the phone", records the evidence I0 asks for in
an event log on the phone, so the answers can be pulled to the Mac, read and written into
[docs/PLATFORM-NOTES.md](../docs/PLATFORM-NOTES.md) with their date. It finds out:

1. Camera and mic into one mp4 through AVAssetWriter, with a flip front/back mid-take, and how long the
   flip's gap is (`rec.flip.begin`, `rec.flip.firstFrame` with `gapMs`, `flipGapsMs` in run.json). One
   flip at a time: FLIP is refused (`rec.flip.refused`) until the new camera's first frame is written, or
   for 5 s.
2. Upright pixels: the orientation read at REC sets the capture connection's rotation, so the file has
   no rotation in its metadata, and the front camera is recorded unmirrored.
3. What happens when Polydance leaves the screen mid-take: the take stops cleanly, is kept, and says why
   (`rec.interrupted`, `rec.stop`, `stoppedBecause` in run.json).
4. A background URLSession upload of a take to a receiver on the Mac (`polycap serve` on the local
   network), carrying on with the app suspended: the `upload.*` and `bg.urlsession.events` events are
   written by the delegate callbacks, with the app's state at that moment.
5. When iOS runs a BGAppRefreshTask over a day (`refresh.submit`, `refresh.run`, `refresh.expired`).
6. The provisioning profile's real expiry (`profile`), since the profiles Xcode made for this team on this
   Mac last a year, against the free team's assumed 7 days. Their developer certificate ends sooner (9 March
   2027 on 2026-11-06), so the event gives both and `stopsLaunching`, the earlier.

## Layout

| Path | Owns |
| --- | --- |
| `Core/` | the SwiftPM package PolydancePhoneCore (iOS 26, macOS 15; Swift 6 strict): run names, the run folder and run.json, the event log, private files, the movie writer, the upload protocol, and since I3 the pairing and its Keychain attributes (`Pairing`), where a take goes (`RunThread`), the thread requests and replies (`ThreadRequests`), reply notices (`ReplyNotices`) and the report policy. It depends on `../../mac` for PolydanceShared's thread models. Tested on the Mac with `swift test`, against replies a local receiver gave (`Tests/…/Fixtures/`). |
| `App/Sources/` | the app (Swift 5 mode). The screens: `DeckScreen` (the deck and inbox, the pages, the REC screen), `DeckModel` (what the screens show and do, the panel's readout), `PhonePanel` (S1's control panel), `RecordingScreen` (S2), `InboxView` (S3 and the drawer), `ThreadScreen` (S4), `RecordingsScreen` (S5), `SettingsScreen` (S6), `PlateDialog` (pop-ups, B1's report), `LookPlan` and `Samples` (pictures of the look). The probe: `PolydanceApp` (entry, app delegate), `ProbeModel` (paths, parts, auto mode, Cancel and Delete), `ProbeView` (its own screen, now a debug view), `CaptureRecorder` and `CameraPreview` (the camera), `UploadProbe` (the background upload), `RefreshProbe` (background refresh), `ProvisioningInfo` (the profile). I3: `PairScreen` (the QR scanner), `PairingStore` (the Keychain), `ReceiverClient` (the thread routes), `ReplyNotifier` (U7) |
| `App/Polydance.entitlements`, `Broadcast/` | since I4, the app group `group.net.polydance.capture.iphone`, and the screen extension's Info.plist and entitlements. Its code is the Vision Pro's (`../visionos/Broadcast/SampleHandler.swift`, `../visionos/Shared/Broadcast.swift`, and `BroadcastLink` in the app), listed by path in `project.yml` ([The screen](#the-screen)) |
| `App/Info.plist`, `App/Resources/` | the app's keys (written by hand) and its icon, the Mac's dock icon as an opaque square that iOS rounds, drawn by `design/icons.py` (until 2026-11-11 a cream square made by hand). The logo the top plate prints is the headset app's own `polydance_mark.png`, taken in by `project.yml` |
| `project.yml` | the XcodeGen spec; `Polydance.xcodeproj` is generated from it and gitignored. It depends on `../mac` for the `PolydanceShared` product only (the look and the thread models) |
| `build.sh` | everything behind `npm run ios`; output under `ios/build/` (gitignored) |
| `tools/serve-local.sh` | a receiver on this Mac for the phone, under `.local/iphone-probe/`: threads on (CAP and MUS), reports to CAP, and an agent token in `agent.env` for posting to it |
| `tools/Pair/` | the pairing window `npm run ios -- pair` shows (a SwiftPM executable on PolydanceShared, built into `ios/build/pair`) |

The app's files on the phone are in its container's `Library/Application Support`, folders 0700 and files
0600, protected until first unlock and kept out of iCloud backup. The token is not among them: it is in the
Keychain (after first unlock, this device only):

| File | What |
| --- | --- |
| `events.jsonl` | the event log: one JSON line per event with `t` (ISO 8601, the phone's offset), `up` (seconds since boot) and `event` |
| `Runs/<yyyymmdd-hhmmss>/` | one take: `video.mp4` (video and mic), `narration.m4a` (the mic alone), `run.json` (`cut` until it finished cleanly) |
| `Runs/<run>/thread.json` | where the take goes: `{"key":"MUS-12"}`, `{"project":"MUS"}` or `{"report":true}`, written at REC when the phone is paired |
| `pairing.json` | `{"v":1,"server":…,"token":"…"}`, put there by `configure`; taken into the Keychain at the next launch and deleted (the I0 `probe-config.json` likewise); never logged |
| `notices.json` | `{"v":1,"told":{"MUS-12":14}}`: the seq up to which each thread's replies were told (U7) |
| `uploads/` | each run's upload state, one file per run |

The screen's extension (I4) writes into the app group's `Library/Application Support/Broadcast/`: `next.json` (the
app's: where the next screen take goes), `live.json` (the take under way), its own `events.jsonl` (`broadcast.*`),
and each take in `Runs/` until the app moves it into its own `Runs/` above. Folders 0700, files 0600.

## Commands

```sh
npm run ios -- generate                    # ios/Polydance.xcodeproj from ios/project.yml
npm run ios -- check                       # compile for iOS and the simulator: no signing, no phone
npm run ios -- test                        # swift test in ios/Core
npm run ios -- sim                         # build for the iOS Simulator, unsigned
npm run ios -- build [--device ID]         # build for the phone, signed with the free team, commit in Info.plist
npm run ios -- install [--device ID]       # install the built app
npm run ios -- launch [--device ID] [-- ARGS]   # launch it (ending a running copy) with app arguments
npm run ios -- leave [--device ID]         # open Settings on the phone, so Polydance goes to the background
npm run ios -- pull <dir> [--device ID]    # copy events.jsonl and Runs/ into <dir>, readable by you only, and the
                                           # screen extension's log as broadcast-events.jsonl once it has run
npm run ios -- pair [--token-file F] [--server URL]     # the QR code the phone scans to pair (P2): default
                                           # ~/.config/polycap/tokens/iphone and https://capture.polydance.net
npm run ios -- pair --config-file F         # the same from a whole pairing file, such as serve-local's
npm run ios -- configure (--config-file F | --token-file F [--server URL]) [--device ID]
                                           # the same pairing over USB, as pairing.json
npm run ios -- devices                     # the paired iPhones and whether each can be reached
npm run ios -- snapshots <dir>             # every screen in the Simulator from samples, as PNGs (no camera there)
```

The phone is `--device` (its name, such as Hermoso, or the id `devices` prints), else
`POLYCAP_IOS_DEVICE`, else the one iPhone that can be reached now. The team is `POLYCAP_IOS_TEAM`, else
the first team in Xcode's accounts (FT47F62Q84, the personal team, on Robin's Mac). `build` without a
reachable phone builds for any iPhone; install, launch, leave, pull and configure need one. `pull` wants a
new or empty folder, and refuses one inside any git checkout (this one, or the main checkout that holds a
worktree) unless that checkout ignores it, as it does `.local/`. `pair` and `configure` refuse a file others
can read, or a pairing the app would refuse: exactly `v` (1), `server` and `token`, with Pairing's rules
(scheme://host[:port] with no user, path, query or fragment, plain http only to a `.local` name,
localhost or 127.0.0.1, and a token of 1 to 512 visible ASCII characters). `pair` never prints the token:
it refuses to write the pairing to a terminal and hands it to the window on a pipe.

The auto mode runs a take from the Mac without touching the phone:

| Argument | Does |
| --- | --- |
| `-autoRecordSeconds N` | start recording 2 s after the camera is running, stop after N s (1 to 3600) |
| `-autoFlipAtSeconds M` | flip M s after the take started (less than N) |
| `-autoUpload` | upload each take as soon as it finishes, also one stopped by leaving (the hash and the create hold background time of their own until the first task is on the background session) |
| `-autoHoldVideoSeconds H` | with `-autoUpload`: the video's first chunk waits H s on the background session (`earliestBeginDate`, `heldSeconds` on its `upload.task.start`), so iOS starts it and the chunks after it with Polydance suspended. On the phone's Wi-Fi a 100 MB take otherwise uploads in under 4 s, before iOS ever suspends the app (2026-11-07) |

A wrong or unknown `-auto…` argument refuses the whole plan; the screen and the `launch` event say why.
Leaving cannot be done from inside the app, so `leave` does it from the Mac. The `launch` event logs the
arguments' names, never their values.

## Running I0

Two paired iPhones are both named Hermoso (2026-11-07). One is an iPhone 13 (iPhone14,5) on iOS 26.3 with
Developer Mode on. The other is an iPhone 16 (iPhone17,3) on iOS 27.2, newer than this Xcode's iOS 26.2
SDK, so whether Xcode 26.3 can install on it is part of what I0 finds out. Connect the phone with a
cable (later Wi-Fi works too), unlocked, and check it can be reached:

```sh
npm run ios -- devices
```

`--device Hermoso` matches both, so give the id `devices` prints (or set `POLYCAP_IOS_DEVICE` to it in
your shell). If only one is connected, it is picked without `--device`. A phone that has never run a
development build asks for Developer Mode the first time (Settings, Privacy & Security, Developer Mode,
then a restart).

1. Check the code on the Mac: `npm run ios -- test` and `npm run ios -- check`.
2. Build and install with the free team: `npm run ios -- build`, then `npm run ios -- install`. The first
   time, the phone may need Settings, General, VPN & Device Management, to trust the developer. On
   2026-11-07, `build` failed with "No Accounts" and "No profiles for 'net.polydance.capture.iphone'".
   xcodebuild logged that the Apple ID's credentials in the keychain were "missing Xcode-Token", so the
   Xcode sign-in had lapsed. The fix is to sign in again in Xcode, Settings, Accounts. An agent's
   sandboxed shell cannot read that keychain item at all, so an agent runs `build` outside its sandbox.
3. Launch it once by hand, or with `npm run ios -- launch`, and allow the camera and the microphone on the
   phone. The screen's profile line gives the expiry (question 6).
4. In a second terminal, start the receiver: `ios/tools/serve-local.sh`. It serves on port 8790 and writes
   `.local/iphone-probe/probe-config.json`.
5. Give the phone its config, only after step 3's first launch, then launch again so it reads it. On
   2026-11-07, a `configure` run before the first launch let devicectl, which runs as root on the phone,
   create `Library/Application Support` owned by root (0755). The app then failed to set up with a
   permission error. `configure` now refuses until the app has made the folder itself:
   `npm run ios -- configure --config-file .local/iphone-probe/probe-config.json`, then
   `npm run ios -- launch`, with the phone unlocked in front of you. The screen's upload line should read
   "configured". On its first time on the screen each launch the app asks the receiver's `/v1/health`
   (`upload.reach`), so iOS asks about the local network then: allow it, and check that `upload.reach`
   says `"ok":true` before step 6. A refusal shows as `ok:false` with a `path` such as "Local network
   prohibited".
6. A take with a flip, phone upright on a stand, talking (questions 1 and 2):
   `npm run ios -- launch -- -autoRecordSeconds 60 -autoFlipAtSeconds 30 -autoUpload`.
7. Leaving mid-take and the background upload (questions 3 and 4):
   `npm run ios -- launch -- -autoRecordSeconds 120 -autoUpload`, and after about 40 s
   `npm run ios -- leave`. Then lock the phone and leave it a few minutes while the upload goes on. The
   log should show `rec.stop`, `rec.finished`, `upload.create` and the first `upload.task.start` before
   the app is suspended, the later ones with `appState` background; if `upload.failed` says "background
   time", iOS suspended it first.
8. A landscape take by hand: hold the phone sideways, press REC on the deck, FLIP after a while, STOP, then
   Send now on the take in Recordings (the tape's list key), or Upload on the probe's screen (question 2
   the other way round).
9. Refresh over a day (question 5): leave Polydance in the background, not swiped away, for a day of
   ordinary use.
10. Pull the evidence: `npm run ios -- pull .local/iphone-probe/pull-<date>`, then read `events.jsonl`
    and each run's `run.json`. The receiver's bundles are under `.local/iphone-probe/receiver`.

The exit test is in docs/IPHONE.md: the take goes through `polycap import` (or the receiver) into a bundle
with upright frames from both cameras and a transcript on the right clock, and the flip's gap, the
interruption's behaviour, the background upload and refresh's timing go into PLATFORM-NOTES as seen on
the phone, with the date.

## The screens

Built 2026-11-07 on the probe, in the look PolydanceShared draws for the Mac too. What each does today:

| Screen (docs/IPHONE.md) | Shows | Wired to (built; seen in the Simulator, and on the iPhone 16 on 2026-11-07, where Robin said the deck looks right) |
| --- | --- | --- |
| S1, the deck | the cream top plate with the reels (turning while recording), the tape's readout and list key, the ballerina, the bug key and the gear; the black panel with UPLOAD, PROCESSING, the counter, REC and READY, the MIC needle meter, the red key, where the take goes, a hint when something needs doing | REC, the counter and the MIC meter (AVCaptureAudioChannel's average power); UPLOAD lights while a take uploads. Paired (I3), the tape is the token's allowance (GET /v1/account) and the key reads FULL when it is used up; the line under the key says where the take goes. PROCESSING stays off (nothing asks for the bundle's steps yet) |
| S2, REC | the camera full screen, the counter, the MIC meter, FLIP, STOP and Cancel on the black panel; since 2026-11-20 Photo · Video · Screen over the shutter | all of it: STOP returns to the deck, Cancel asks once and deletes the take (`rec.cancel`, `rec.discard`), leaving ends the take as before. The controls do not turn with the phone yet (R6). Screen records the screen and the microphone instead ([The screen](#the-screen)); type-checked only |
| S3, the inbox | the search bar and drawer (Inbox, Archived, projects, Recordings), the line saying what shows, thread rows, New thread with the red camera | the receiver's open threads (Archived: its closed ones), read on coming to the front, every 30 s and on pull; a failed read is said over the list. New thread records into a new thread, asking which project when there are several; unpaired, it says how to pair |
| S4, a thread | back, Archive, Delete, the title, earlier messages folded, the latest in full with reactions, launches with stars and Just open, Reply | the receiver's thread, marked read when opened; React, the stars, Archive (closes it) and Delete (hides it for this token) go to the receiver, with Undo for the last two; Just open opens an https link in Safari; Reply goes back to the deck aimed at the thread and the take uploads as soon as it stops |
| S5, Recordings | each take with its time, size, state (RECORDING, UPLOADING with eight segments, ON SERVER, FAILED, CUT OFF, ON THIS PHONE), Send now, Retry, Delete | all of it, on the probe's runs and uploads; Delete removes this phone's copy only and is refused while a take uploads. WAITING (the hold after Stop) and PROCESSING come with I2 |
| S6, behind the gear | recording settings, the receiver, notifications, diagnostics | Receiver: paired as "Robin · iPhone" with its host, Pair with the Mac (the QR scanner), Pair again, Unpair. Notifications: Replies (U7) with the last check. The diagnostics (phone, app, signing, refresh, clock, events) and the probe's screen; the recording settings show LATER tags |
| B1, the bug key | the headset's pop-up | Start recording records a report; it uploads as it stops and leaves the phone once the receiver has it. Unpaired it waits on the phone; a receiver with no reports project is said in the pop-up, which then has no Start |

Two launch arguments set the screens up for pictures, strictly as the auto mode's are read:
`-lookSamples` fills the inbox, a thread and the readouts with sample values (the inbox's line says
SAMPLES), and `-lookScreen deck|rec|camera|screen|photo|thread|recordings|settings|report|drawer|newThread` opens one screen (camera: the camera before a take, on Photo; screen: the camera switched to Screen; photo: the photo message screen with two made-up photos).
`npm run ios -- snapshots <dir>` takes each in the Simulator (`POLYCAP_IOS_SIMULATOR`, else iPhone 17),
and the deck once without samples, as `deck-as-is.png`.

While Polydance is on the screen the capture session runs, as the probe's did, so iOS shows the camera in
use on the deck too; running the camera only on the REC screen is for I2.

## The screen

Built 2026-11-20 for I4 ([docs/IPHONE.md](../docs/IPHONE.md), I4), at Robin's ask for "the option of recording the
screen and microphone (no camera)"; type-checked on this Mac, not yet built as an app or run on the phone.

- **Recording.** New thread or Reply, then Screen on the camera's switch. The camera stops; press the red key, turn
  Microphone on in iOS's Start Broadcast sheet (it starts off), then Start Broadcast. After iOS's countdown, go to
  whatever should be shown. STOP or Cancel on Polydance's camera screen, the deck's red key, the red pill at the top
  of the screen or Control Center ends the take.
- **What it is.** The Vision Pro's broadcast extension, the same file compiled for iOS: video.mp4 with the screen
  scaled to 1080 on its short side (an iPhone 16's 1179 × 2556 becomes 1080 × 2340) and the mic, narration.m4a,
  run.json, thread.json and timeline.jsonl. When Polydance is next in front it takes the take into `Runs/` and sends
  it where the line under the key said, as a camera take.
- **The log.** The extension's events are its own (`broadcast.start`, `broadcast.writer` with the source's size and
  the file's, `broadcast.finished`, `broadcast.failed` with its step); the app's are `rec.asked`, `rec.live`,
  `rec.arrived`, `rec.stopAsked` and `rec.cancelAsked`. `npm run ios -- pull` brings both.
- **The app group, once per team.** The app and the extension share `group.net.polydance.capture.iphone`. On the
  Vision Pro, `xcodebuild` made profiles with an empty group list and the signing failed with "doesn't match the
  entitlements file's value for the com.apple.security.application-groups entitlement", until the group was ticked
  once in Xcode (2026-11-12). If `npm run ios -- build` fails that way: `npm run ios -- generate`, open
  `ios/Polydance.xcodeproj` in Xcode, choose the team on both targets (Polydance and PolydanceBroadcast), and tick the
  group in Signing & Capabilities on each. A free team may register only so many app ids a week; the extension is a
  new one.

## Pairing and threads

Built 2026-11-07 for I3 ([docs/IPHONE.md](../docs/IPHONE.md) P1 to P3, I3). To pair with the live receiver:
the phone's token is `~/.config/polycap/tokens/iphone` on the Mac (its entry is in the receiver's
`POLYCAP_SERVER_TOKENS`, [docs/HOSTED.md](../docs/HOSTED.md)). Run `npm run ios -- pair`; on the phone, the
gear, then Pair with the Mac, and point it at the code. The phone asks the receiver who the token is before
it keeps it. To try threads without the live receiver, run `ios/tools/serve-local.sh`, then
`npm run ios -- pair --config-file .local/iphone-probe/probe-config.json` (or `configure` with that file over
USB), and post as an agent with `POLYCAP_CONFIG=.local/iphone-probe/agent.env npm run polycap -- thread new
--project CAP --title … --text … --open https://example.com/`.

The log's I3 events carry no thread's words and no key: `pair.saved` (how: qr, pairing.json or
probe-config.json; whether the receiver is local), `pair.adopt`, `pair.forget`, `upload.create`'s `thread`
(reply, new, report or none), `report.removed`, `replies.on`, `replies.check` (counts and times) and
`replies.opened`.

## Reading the log

- **Launches.** In a scene-based app `UIApplication.applicationState` is background during
  didFinishLaunching for every launch, so `launch` records it as `appStateInDidFinishLaunching`, never as
  the kind of launch. A launch onto the screen is followed by `scene.connect` (with `msFromLaunch`); a
  launch in the background by `refresh.run` or `bg.urlsession.events` with no `scene.connect`. The
  `upload.config` line written at launch reads background for the same reason.
- **Stops.** `rec.stop` and run.json's `stoppedBecause` name the trigger: "Polydance stopped being active
  (willResignActive)" also happens with Polydance still on the screen (Control Center, an alert), "left
  the screen (didEnterBackground)" when it went. Both stop the take. `stoppedBecause` is written as the
  stop begins, so a take whose finish never completed still says why. A stop that comes while the take is
  still starting (leaving, an interruption) is logged at once with `"pending":true` and carried out when it
  starts; background time is held from then.
- **Flips.** `gapMs` is from the last frame written (from either camera) to the new camera's first written
  frame. The sound lost under a flip is the heartbeats' `filledAudioMs` after it minus `rec.flip.begin`'s.
- **Uploads.** `upload.task.done`'s `deliveredMs` runs from resume() until the callback reached the app:
  iOS's wait before the task, the transfer, and the wait to wake the app. `upload.task.metrics` has the
  clock times that tell them apart (`fetchStart`, `requestStart` to `responseEnd`), to read against
  `upload.task.start`'s and `upload.task.done`'s `t`. A task started while the app is in the background
  (`upload.task.start` with `appState` background, which is every chunk after the first once Polydance is
  suspended) is started when iOS chooses, whatever `isDiscretionary` says (Apple's
  URLSessionConfiguration.isDiscretionary documentation; not in the SDK headers), so its wait is iOS's
  scheduling, not the transfer. A task that ends with no reply is sent again after 30 s, doubling to 10
  minutes, five times in a row at most (`note` on `upload.task.done`, `delaySeconds` and `retry` on the
  next `upload.task.start`).
- **Refresh.** `launch`, `refresh.submit` and `refresh.run` carry `backgroundRefresh` (the setting) and
  `lowPower`; `power` and `refresh.status` record each change. A swipe away from the app switcher, which
  also stops refresh, leaves nothing the app can log.

## What only the phone can show

Nothing below is proved by `check` or `test`: the Mac compiles the app and tests the core with synthetic
buffers, but the camera, the flip's gap, orientation and mirroring, interruptions, background uploads,
the local network prompt, refresh timing and the profile's and certificate's dates exist only on the phone. Some of the
probe's own plumbing was first exercised on 2026-11-07. `install`, `launch`, `leave`, `pull` and
`configure` all work over USB. `copy to` takes a file path as its destination. `copy from` of a folder
needs the destination to exist, and lands as `<dir>/Runs/<run>`.

## Verified

- **2026-11-07 evening, I3 on the iPhone 16 (iOS 27.2), over USB.** Builds `cfe17f9` and `8e1e234` with a
  local receiver, then `723d502` (with main's two launch keys) with the live one. The phone took a pairing
  copied over USB, then scanned the Mac's QR code for the live receiver. On both, Robin saw the agent's
  message unread, opened its link with Just open, replied from Reply, which the agent's `thread watch`
  heard, and sent a report that reached the reports project and left the phone; locally he also reacted,
  starred an option and turned notifications on. Background refresh never ran that day, so a reply's notice
  was not seen. Details in [docs/PLATFORM-NOTES.md](../docs/PLATFORM-NOTES.md) "iPhone, seen on the phone
  (I3)". Checks that day: `swift test` in `Core` 73 passed, `npm run ios -- check` compiled for iOS and the
  Simulator, `npm run check` 520 passed, `npm run mac -- test` 154 executed (6 skipped, 0 failures).

- **2026-11-07, the screens, in the Simulator only (iPhone 17, iOS 26.3.1), not the phone.**
  `npm run ios -- snapshots` drew all nine pictures: the deck with samples and as it is (REC grey, "No
  camera here"), REC, a thread, Recordings, Settings, the report pop-up, the drawer and the New thread
  note. In the Simulator a reaction's emoji drew as a missing-glyph box, in the condensed face and in the
  system font alike, though the file's bytes are right; whether the phone draws it is to see. The camera,
  the meter's needle, Cancel's delete and the reels turning were not exercised: the Simulator has no camera.

I0's results, each with its date. The full table, with the evidence for each, is in
[docs/PLATFORM-NOTES.md](../docs/PLATFORM-NOTES.md) "iPhone, seen on the phone".

- **2026-11-07, on the iPhone 16 (iOS 27.2) over USB, with three takes.**
  - **Recording works.** Build, install, launch, configure and pull work. There were no dropped frames
    in three takes, and both cameras' frames are upright at 1080 x 1920.
  - **Flips.** The gaps were 33, 284, 33 and 33 ms, but each flip loses 160 to 200 ms of mic sound.
  - **Leaving** stops the take and finishes it cleanly, in 114 ms, before the background.
  - **The hand-off** (hash, create, narration, first video task) fits in 0.3 s.
  - **iOS carries a held upload while the app is suspended.** It woke the app in the background to
    finish it, but the request waited 27 minutes, until the cable was back. The phone did not reach
    the Mac over Wi-Fi, and why is still to find.
  - **The profile** lasts a year, and the certificate ends on 2027-03-09.
  - **Imports.** `polycap import` (and the receiver) make `_iphone` bundles with the transcript on the
    take's clock.
  - **Still to see:** refresh over a day, and a chain of chunks sent from the background over Wi-Fi.

- 2026-11-07, the iOS Simulator only (iPhone 17, iOS 26.3.1), not the phone: a foreground `simctl launch`
  logged `launch` with `appStateInDidFinishLaunching` background, then `scene.connect` (appState
  background, 69 to 111 ms after launch), then `scene` active with appState inactive. A probe-config.json
  copied in as 0644 was made 0600 at launch (`upload.config` `narrowedFromMode` 644), and with no receiver
  running `upload.reach` logged `ok:false`, NSURLErrorDomain -1004.
