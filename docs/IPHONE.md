# Polydance for iPhone: requirements and plan

Drafted by Claude for Robin on 2026-11-06, from Robin's brief and his answers the same day. I0's probe is
built (2026-11-07, [ios/README.md](../ios/README.md)); it ran on the iPhone 16 the same day, and its results
are under I0 below. I1, the shared look, was built and checked on 2026-11-07 (results under I1), and the
same day the app's screen became the deck in that look, with every screen of I2 and I3 drawn on the probe
(under I2 and I3: what each is wired to, and what is left). That evening pairing (P1 to P3) and I3 were
built, and I3's exit test passed on the iPhone 16 against the live receiver (results under I3). What is
built is said only in `private/docs/ROADMAP.md` "Where we are". Platform claims are in
[PLATFORM-NOTES.md](PLATFORM-NOTES.md#iphone-researched-2026-11-06) with their sources; those seen on the
phone are marked so, with their date. Where this document picked a default Robin was not asked about, it says so
in [Defaults to confirm](#defaults-to-confirm).

## The brief

Polydance on the iPhone, with the other platforms' features except call recording, recording video
with the phone's camera and microphone.

## The short answer

1. **It is one more capture app and transport.** The phone records, keeps the recording and uploads it
   to the hosted receiver as the headset does. The receiver builds the bundle and `polycap sync` brings
   it down. Nothing is processed on the phone, and the pipeline knows a phone made the recording only
   from what `session.json` records.
2. **The camera cannot follow a launch.** iOS stops the camera as soon as Polydance leaves the screen
   (`videoDeviceNotAvailableInBackground`), so Record and open cannot record and then open a link in
   Safari as the headset and the Mac do. In the first version a launch has only Just open, and Reply
   records with the camera. Recording the
   phone's own screen, which could follow a launch, is phase I4.
3. **Robin's team is enough for Robin's phone.** Xcode installs the app with the Apple Development
   identity the Mac app already uses. The plan assumed a free team's 7 days. Seen on the phone on
   2026-11-07, though: the app's profile runs a year, and the app stops launching only when the
   certificate ends, on 9 March 2027. Year-long profiles suggest team FT47F62Q84 is, or was, a paid
   membership; to confirm with Robin, since a paid team also allows TestFlight and push. Until then
   there are no push notifications, so replies are found by background refresh, which iOS runs when it
   chooses.
4. **Almost nothing new on the receiver.** The phone uses the headset's routes, an `upload` token for
   user `robin`, and upload fields that already exist (`audioTracks: ["mic"]`). One change is needed:
   the summary and pointing prompts say "a person wearing a VR headset", which would describe a phone
   recording wrongly (see U8).
5. **The look carries over as the Mac's did.** Most of the Mac's SwiftUI parts (wood, plates, lamps,
   counter, keys, meters) should run on iOS once they are shared rather than copied, so
   `tests/design.test.ts` keeps one Swift palette to check.

## Robin's decisions, 2026-11-06

| Decision | What it means here |
| --- | --- |
| **Camera and mic now, the screen later.** | The first version records the camera with the microphone. A launch that opens a link only opens it. Screen recording (ReplayKit) is phase I4. |
| **The free team, Robin's phone only.** | As for the Mac (2026-11-05): no paid Apple Developer Program, so no TestFlight, no push and no App Store. `npm run ios -- install` puts it on the phone over USB from this Mac (Wi-Fi did not connect on 2026-11-07). The app keeps launching until the certificate ends on 2027-03-09, not 7 days (seen 2026-11-07). The phone is the iPhone 16 (Robin, 2026-11-07). On 2026-11-07 `xcrun devicectl list devices` showed two paired iPhones, both named "Hermoso". One is an iPhone 16 (`iPhone17,3`) on iOS 27.2, with no Developer Mode state reported. The other is an iPhone 13 (`iPhone14,5`) on iOS 26.3 with Developer Mode on, last connected on 2026-03-10. Neither could be reached. `npm run ios -- devices` gives each one's id for `--device`. |
| **Just Robin, paired from the Mac.** | No sign-in screen. The phone scans a QR code drawn on the Mac holding the receiver's address and an `upload` token for user `robin`, so messages read "Robin · iPhone" and the phone sees what the team's headsets see. No consent notice, since that is for Meta and Google testers. |
| **Flip front and back during a take.** | One continuous file. No picture-in-picture, zoom, torch or mark key in the first version. |
| **The bug key, and nothing else new in threads.** | Threads, launches (open only), reactions, picks, New thread and Reply as on the headset, plus the bug key. No typed replies, no player, no 3D models in the first version. |
| **The deck on top, the inbox below.** | The headset's deck shrunk to the top of the screen, the threads under it. REC fills the screen with the camera. |
| **Words now, video on Wi-Fi.** | The narration uploads at once on any network, so the title and transcript arrive, and the video waits for an unmetered network unless Send now is pressed. |
| **Orientation set at REC.** | Portrait or landscape is read when a take starts and kept for the whole file. |

## Requirements

Each has an id, so phases and commits can name it.

### Recording

- **R1 Camera and mic into one file.** AVCaptureSession into AVAssetWriter: H.264 at 1920 × 1080 (or 1080
  × 1920) and 30 fps, the microphone as one AAC mono track at 48 kHz. The upload says
  `audioTracks: ["mic"]`. The mic is whatever input iOS has chosen (AirPods when connected), named on the
  MIC meter's strip and in `run.json`.
- **R2 Fragmented, so a crash keeps what was written.** A movie fragment every 10 s, as the Mac writes,
  so a recording the app did not finish still plays up to its last fragment. Its card says CUT OFF, the
  way the headset's does, and offers Send and Delete. The headset's cut-off files cannot be played at all.
- **R3 Narration written alongside.** A second writer takes the same audio buffers into `narration.m4a`,
  so words first needs no copy after Stop.
- **R4 Upright pixels, no rotation flag.** The orientation at REC (R6) sets the capture connection's
  rotation, so the frames are written upright and the file has no rotation in its metadata. Then
  ffprobe's size, ffmpeg's frames, the contact sheet and every player agree. The front camera's preview is
  mirrored, as people expect, and its recording is not, so text reads the right way round.
- **R5 Flip during a take.** A flip key on the recording screen swaps the camera input inside one
  configuration change while the writer keeps going. The frames in between are dropped, not frozen,
  and the gap is measured in I0. Each flip goes into `run.json` with its clock (`cameras: [{ atMs, facing
  }]`). It does not reach the bundle in the first version (see [Defaults](#defaults-to-confirm), D6).
- **R6 Orientation at REC.** The phone's orientation when REC is pressed (portrait, or landscape either
  way) is the file's orientation until Stop. The recording screen's controls turn with the phone, but the
  picture does not.
- **R7 Leaving ends the take.** Leaving Polydance, a phone call, Siri, the lock button or another app
  taking the camera or mic stops the take cleanly and keeps it. Its card says why ("stopped when
  Polydance left the screen"). Nothing resumes into the same file. The screen does not dim or lock
  while recording.
- **R8 Limits before REC.** REC reads FULL when the receiver's allowance is used up, as on the headset,
  and refuses when the phone has under 1 GB free. Thermal state changes go into the run's timeline.

### The screens

- **S1 The deck.** At the top: the cream top plate with the two reels (turning only while recording),
  the tape showing the receiver allowance used, the ballerina, the beetle (bug key) and the gear. Under
  it, the control panel: the MIC needle meter, the UPLOAD and PROCESSING lamps, the rolling counter, REC
  and READY, and the red key (REC, STOP, FULL). A hint line only when something needs doing (pair the
  phone, allow the camera). A line under the key says where the take goes ("→ MUS-12 · New menu", "→ NEW
  THREAD · MARIMBA").
- **S2 The camera.** The camera fills the screen. New thread and Reply open it without recording, on
  Photo, with a Photo · Video switch over the shutter (a sideways swipe changes it too), Library at the
  left, Flip at the right, and Cancel at the top (Robin's pick of four mockups, 2026-11-13, "the camera,
  then choose"). The cream shutter takes a photo, which goes to the photo message screen (S7); on Video the
  shutter is red and starts the take. REC on the deck and the bug key's report go straight to the take.
  While a take runs, at the foot: the counter, the MIC meter, the flip key, STOP and a smaller Cancel (one
  confirmation, nothing uploaded), on the black panel. STOP returns to the deck.
- **S3 The inbox below the deck.** The headset's Gmail layout at phone width: the search bar with the
  drawer (Inbox with its unread count, Archived, the projects to show, Recordings), the line saying what
  shows, the thread rows (avatars, bold while unread with a red dot, the time, the latest words, TO TRY in
  words), and New thread with its red camera. A take on its way to a thread draws its transfer strip and
  "Your recording · 42% · 460 of 1,087 MB · 2.1 MB/s · about 5 min left" under that thread's row; one with
  no row to go under (a new thread, a report, a thread filtered out) is a row of its own at the top, which
  opens Recordings (Robin's pick of four mockups, 2026-11-14: "In its thread"; the words are S5's).
- **S4 A thread** opens over the deck and inbox: back, Archive, Delete (from this inbox), its title with
  the project and key, earlier messages folded to a line each and the latest open in full, sender
  avatars, reactions, launch options with their stars (Pick), a message's photos as tiles that open large
  when pressed, and Reply with the red camera at the foot. Reply opens the camera (S2) aimed at the
  thread, on Photo. The receiver makes a reply's message when its upload starts, so this phone's take on
  its way shows FROM THIS PHONE · 42% with the strip and S5's words on that message; one whose message is
  not shown open yet (being prepared, not read since, or folded) is a card at the foot, as the headset's.
- **S5 Recordings**, from the drawer or the tape's list key: each recording on the phone with its size,
  thread and status (WAITING with its countdown, UPLOADING with a strip of segments, PROCESSING with its
  steps, ON SERVER, FAILED with the reason, CUT OFF), Send now, Retry and Delete, Select and Delete all.
  Since 2026-11-14 (Robin: "no idea how much is left or if it's stuck"), an upload shows the headset's
  twenty-segment transfer strip, its share, megabytes sent of the whole, the rate over the last 30 s and
  the time left at it, moving within each 8 MB chunk (`didSendBodyData`), and once no byte has moved for
  20 s, how long and why when the phone knows: "waiting for Wi-Fi" (U3), "sending again in 25 s"
  (`UploadMeter` in PolydancePhoneCore). The inbox (S3) and the thread (S4) show the same.
- **S6 Behind the gear:** the recording settings (1080p or 720p, the starting camera, the video on mobile
  data switch, off), the receiver (paired as "Robin · iPhone", Unpair), notifications (U7), and
  diagnostics: the phone's model and iOS, the app's version and commit, the days left before the app
  must be installed again (read from its embedded provisioning profile), the clock and the events log.
- **S7 The photo message** (2026-11-13), after a photo or photos from the library: on the wood, the photos
  waiting (1 to 10, each with a key to take it out), Another (back to the camera) and Library, the words
  if any, and Send. In a new thread the words' first line is its title, said under the words; with none
  it is "Photo 13 Nov 19:40", so nothing is made up for it. ✕ throws the photos away after asking; nothing
  was sent. A refusal is said over Send and the photos stay, and Send again is the same message (its
  delivery id is kept while the photos and words are). A sent message opens its thread. While photos wait,
  the camera offers Photo only, so a take cannot leave them aimed nowhere. The draft is
  kept only in memory: leaving the app for long enough that iOS ends it loses the photos.

### Photos (2026-11-13)

- **What leaves the phone.** A camera photo or a library photo (HEIC, JPEG, PNG) is drawn through its
  orientation into upright pixels, scaled to at most 4096 px a side and written as JPEG with ImageIO
  (`PhotoPrep` in PolydancePhoneCore). Nothing of the original's metadata is copied: no location, camera,
  lens or time. ImageIO writes its own small Exif segment (resolution, colour space, size) and keeps the
  colour profile; the receiver strips that segment too. The library is read through the system's photo
  picker, which needs no access to the library, so the app asks for none.
- **How it is sent.** Each photo goes whole to `POST /v1/threads/:key/photos` (a reply) or `POST
  /v1/projects/:key/photos` (a new thread), then one message names them: `POST /v1/threads/:key/messages`
  or `POST /v1/threads` with the title, the words and a `deliveryId`, so a retry is the same message or
  thread. Photos go on any network, as the inbox does; only video waits for Wi-Fi (U3). The phone's
  `upload` token may do this since 2026-11-13 ([THREADS.md](THREADS.md#photos)).
- **What is drawn.** A thread's photos are fetched through the thread, checked against their sha256 and
  kept in memory while the app runs; one this token may not view says so. Nothing is saved to Photos.
- *Checked 2026-11-13, without the phone:* `swift test` in ios/Core proves the preparation (a made-up photo
  tagged as turned and carrying a location leaves upright with none) and the requests; the receiver's tests
  prove the routes; a made-up 4032 × 3024 HEIC prepared by `PhotoPrep` passed the receiver's own check as
  3024 × 4032. The app was type-checked with `swiftc` against the iOS SDK, since this Mac has no iOS
  platform for `xcodebuild`. The camera, the picker, Send and the screens have not run anywhere yet.
### Pairing and the receiver

- **P1 A token for the phone.** `polycap token new --id iphone --scope upload --user robin --label iPhone
  --save iphone` writes it to `~/.config/polycap/tokens/iphone` (0600). Its entry goes into the receiver's
  `POLYCAP_SERVER_TOKENS`, which is the operator's step on the receiver's host, the same as for `quest3`. *Done 2026-11-07:*
  at Robin's go-ahead Claude made it and added it with `deploy/receiver/add-token.py`, then recreated the
  container (`private/docs/OPERATIONS.md`).
- **P2 The QR code.** `npm run ios -- pair` draws a QR code on the Mac's screen from the saved file with
  Core Image's own generator, so there is no new dependency. It holds strict JSON, not a URL: `{"v":1,
  "server":"https://capture.polydance.net","token":"…"}`. The window closes on Done or Esc or after 2
  minutes, and no image is left on disk. (The plan had it close once the phone had used the token, but the
  receiver keeps no record of a token's first use, so the phone says "Paired" instead; built 2026-11-07,
  `ios/tools/Pair`, which also keeps the window out of screenshots and screen recordings.) The phone scans it with its own scanner, not the
  Camera app, so no other app ever sees the token. The phone checks the payload with a strict decoder,
  calls `GET /v1/account` (which also gives the allowance for the tape) and refuses with the reason if
  it fails. If the camera will not scan,
  `npm run ios -- configure --token-file …` writes the same JSON into the app's container with `devicectl`
  over USB, as `npm run app -- configure` does for the headset. The app takes that `pairing.json` (or the I0
  probe's `probe-config.json`) into the Keychain at its next launch and deletes it.
- **P3 The token in the Keychain**, readable after first unlock and this device only, so a background
  upload can use it with the phone locked and a backup never carries it.

### Uploads

- **U1 The headset's protocol.** `POST /v1/uploads` with the client id (`<install id>-<run name>`), bytes,
  sha256, file name, recorded-at, device (`model`, `system`; never the phone's own name), `appBuild`,
  `audioTracks` and `thread`. `PUT …/narration` first, then `PUT …/content` in 8 MB chunks with
  `Content-Range`. A 409 gives the server's offset, so the upload resumes from it.
- **U2 Background URLSession.** Each chunk is written to a file in Caches and sent with an upload task
  of a background session, so uploads continue with the app suspended, and iOS wakes the app to start the
  next chunk. The recording itself is never changed.
- **U3 Words now, video on Wi-Fi.** The narration's task may use any network. The video's tasks are not
  allowed expensive networks (mobile data, a personal hotspot), unless the setting allows it or Send now
  was pressed for that recording.
- **U4 The hold after Stop**, as the headset's: 5 s, or 30 s and SHORT when under 20 s, counting down on
  the card with Send now and Delete.
- **U5 Delete everywhere**, after a confirmation: this phone's copy at once and the server's by a queued
  request, so a delete made offline still reaches it.
- **U6 File names give `_iphone` sessions.** The recording is named
  `net.polydance.capture.iphone-<yyyymmdd>-<hhmmss>.mp4` in the phone's local time, so the receiver's
  `parseRecordingName` and `appSlug` make ids like `2026-01-02T03-04-05_iphone` with no change. A test on
  each side checks the name.
- **U7 Replies by background refresh.** Off until turned on behind the gear, which asks for permission
  to notify. A background refresh task asks the receiver which threads are unread and posts a local
  notification per thread with others' replies, as the headset does; tapping one opens the thread, and
  reading the thread clears it. The app also checks whenever it comes to the front. iOS decides when
  refresh runs (often hours apart, never after the app is swiped away), and the setting says so. Push
  would need the paid programme.
- **U8 A phone recording is described as one (the receiver change).** `pointing.ts` and `summary.ts`
  tell Claude the recording is from a VR headset. The upload gains an optional `view: "camera"` (later
  also `"screen"`), recorded as `source.view` in `session.json`. The summary prompt says a person filmed
  with a phone and narrated it, and the pointing prompt asks what the frame's centre or a finger in it
  shows rather than a controller ray. A missing `view` keeps today's prompts, so headset sessions are
  unchanged. This is the one receiver deploy the first version needs. The skill gains a line: `_iphone`
  sessions are camera recordings with the mic only.

### The bug key

- **B1 Reports from the phone.** The beetle opens the headset's pop-up (a report is for Polydance itself
  and goes to the Polydance team only). Start recording records with the camera, uploads at once with no
  hold, is deleted from the phone once the receiver has verified it, and is never in the inbox or on the
  tape.

### Launches

- **L1 Open only.** A launch's `open` step with an https link opens in the default browser. App, version
  and model steps belong to the headset and are shown as such, the way the Mac shows them. The phone has
  only the second of a launch's two keys, Just open, with a line saying Record and open needs screen
  recording (2026-11-07, [THREADS.md](THREADS.md#record-and-open-just-open)). Replies are recorded with
  REC or Reply, and their recordings name no launch.

### Privacy and storage

- **V1 Private by default.** Recordings live in the app's Application Support, excluded from iCloud
  backup, with file protection until first unlock (so background uploads work when locked). They are
  never saved to Photos, and the app asks for no location. Logs never hold a token, a transcript or a
  thread's words.

### Build, install and release

- **I-1 `npm run ios -- build | test | install | pair | configure | snapshots <dir>`** through
  `ios/build.sh`, as `npm run mac` runs `mac/build.sh`. Install uses `xcodebuild` with the free team's
  automatic signing and `xcrun devicectl device install app`.
- **I-2 Install from main's committed tip.** `install` refuses a dirty tree or a branch other than `main`
  unless `--dev`, which marks the build `-dev`. The app's version and commit (with `-dirty` when built from
  changes) go in its Info.plist and every upload's `appBuild`.
- **I-3 The ledger.** Each install is recorded in `app/releases.json` as platform `iphone` with its commit
  and date, and `npm run app -- status` shows it beside the headsets, with the days until it stops
  launching.
- **I-4 The icon** is the ballerina, drawn by the script that draws the Mac's: since 2026-11-11 `design/icons.py`
  draws the Mac's dock icon as the iPhone's square ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md#one-app-icon)).

## Code layout

```text
mac/Package.swift        has PolydanceShared (macOS 15 and iOS 26, built in I1): Palette, Theme, RetroLook, the
                         drawn parts (Cabinet, Deck, Pieces), ThreadKey, the thread models and MetaTime
ios/
  Core/Package.swift     PolydancePhoneCore (Foundation and AVFoundation, no UIKit: runs on disk, the event
                         log, the movie writer, the receiver's upload protocol; later the upload queue,
                         pairing payload, launch checks) and its tests, run with `swift test` on the Mac
  App/Sources/           the SwiftUI screens and the AVFoundation capture
  App/Info.plist, App/Resources/   the app's keys, written by hand, and its icon
  App/Polydance.entitlements, Broadcast/   the app group, and the screen extension's Info.plist and entitlements
                         (I4); its code is the Vision Pro's (visionos/Broadcast, visionos/Shared), listed by path
  project.yml            the XcodeGen spec; the Xcode project is generated from it and gitignored
  build.sh               behind `npm run ios`
  tools/serve-local.sh   a receiver on this Mac for I0's probe
```

This is the layout I0 built (2026-11-07). The core package lives in `ios/Core` rather than `ios/` itself,
so that SwiftPM's folder and XcodeGen's project do not overlap. A project file generated from
`project.yml`, rather than a committed `.xcodeproj`, keeps every setting in a file that can be read and
reviewed.

The Mac's `PolydanceCore` cannot be shared whole: it starts polycap with `Process`, which iOS lacks.
So only the parts that are only look and thread data move to `PolydanceShared`, and the Mac keeps the
rest. `tests/design.test.ts` then reads the shared `Palette.swift`. A colour only the phone uses would
still go into `design/tokens.json` first. Shared Swift lives in `mac/Package.swift` so the Mac app's build
does not move. A top-level Swift package would be tidier, at the cost of moving files the Mac's build
scripts name; see D7.

## Tests

Tests prove behaviour without hardware, as everywhere else in the repository:

- `swift test` in `ios/` for pure logic: requests built and responses decoded against fixtures captured
  from `polycap serve`; the upload queue (offsets, a 409, the hold, the network rule, Send now, delete
  queued offline); the pairing payload (strict, version 1, refused with the field named); launch checks
  (https only); run names.
- An integration run: `npm run ios -- test` starts `polycap serve` on localhost with a temporary root
  and a test token, runs the client's tests against it, and stops it. No network and no live receiver.
- The writer, without a camera: AVAssetWriter set up as the app's, fed synthetic frames with a flip
  (a gap and a change of source) and synthetic speech, then `polycap import` in a vitest end-to-end test
  with the fake whisper-cli, checking the frames' size and orientation and the transcript's clock. The
  Mac's writer is tested the same way.
- `npm run ios -- snapshots <dir>` draws the deck, the recording screen, the inbox's drawer, a thread,
  Recordings, the settings and the pop-ups from samples (`-lookSamples -lookScreen NAME`) in the Simulator
  (built 2026-11-07; iPhone 17, since this Mac has no iPhone 16 Simulator). The Simulator has no camera.
- `npm run check` for U6 and U8, and `npm run mac -- test` plus a before-and-after `npm run mac --
  snapshots` for the shared parts: the Mac's pictures must not change.

The camera, flipping, interruptions, background uploads and refresh can only be shown on the phone.
I0 and each phase's exit test say what was seen there, with the date.

## Phases, each with an exit test

**I0, spike on the phone (about half a day).** An empty app with the free team installed on Robin's
iPhone from this Mac, recording camera and mic through AVAssetWriter with a flip at 0:30, in portrait;
leaving it mid-take; one background upload of the file over Wi-Fi with the app suspended; a refresh task
logging when iOS ran it over a day. The upload goes to a `polycap serve` on this Mac
(`ios/tools/serve-local.sh`), not the live receiver. It is the same receiver code and routes, but with a
throwaway token, and nothing reaches the live library before I2 decides how the phone is paired. Built
2026-11-07 as a probe app that writes each answer to an event log on the phone
([ios/README.md](../ios/README.md)).
*Exit:* the file goes through `polycap import` into a bundle with upright frames from both cameras and a
transcript on the right clock; the flip's gap, the interruption's behaviour, the background upload and
refresh's timing are in PLATFORM-NOTES as seen on the phone, with the date.

*Results, 2026-11-07, on the iPhone 16* ([PLATFORM-NOTES](PLATFORM-NOTES.md#iphone-seen-on-the-phone-i0-2026-11-07)):
- **Met.**
  - The take goes through `polycap import`, and through the receiver, into an `_iphone` bundle.
  - Its frames are upright from both cameras, and the transcript is on the take's clock to within about
    0.5 s.
  - The flip's gap is one frame, or 284 ms once.
  - Leaving ends the take cleanly before the background, and the hand-off fits in 0.3 s.
  - iOS begins a held background upload with the app suspended, and wakes the app to finish it.
- **Not yet.**
  - Refresh timing over a day: the app was left in the background on 2026-11-07, and the evidence is the
    next `npm run ios -- pull`.
  - A chain of chunks sent from background callbacks.
- **Found, for I2.**
  1. Each flip loses 160 to 200 ms of mic sound, because the capture session reconfigures the app's audio
     session. The take's sound should not depend on the camera, for example by configuring the audio
     session once and turning off `automaticallyConfiguresApplicationAudioSession`; to try in I2.
  2. With the cable out, the phone did not reach the Mac's `.local` receiver, and devicectl did not see
     the phone. The cause, whether the network or the phone's Wi-Fi, is still to find. The live receiver
     over HTTPS avoids the question for uploads, but `npm run ios` over Wi-Fi depends on it.
  3. devicectl writes into the app's container as root, so nothing may be copied there before the app's
     first launch. Pairing by QR code (P2) avoids that path.
  4. The hash runs at `.userInitiated`: at `.utility` the create took 11 s.

**I1, the shared look.** `PolydanceShared` out of the Mac's views.
*Exit:* `npm run mac -- test` passes, the Mac's snapshots are pixel-identical before and after, and
`npm run check` passes with the design test reading the shared palette.

*Results, 2026-11-07* (on this Mac; the iPhone's screens built on it are under I2 and I3 below):
- **Met.**
  - `PolydanceShared` is a target in `mac/Package.swift` for macOS 15 and iOS 26 (D7). It holds `Palette`,
    `Theme`, `Cabinet` (wood, plates, screws, the cream plate), `Deck` (labels, lamps, the record key, the
    counter, the needle meter, tags, keys, pills, avatars), `Pieces` (section labels, chips, cards, the
    thread row, `Clock`), `RetroLook`, the thread models and `MetaTime`. `PolydanceCore` depends on it for
    the thread models; the Mac keeps `ControlPanel` (Mark, Discard and its hot keys), `Logo` (NSImage), the
    thumbnails and everything that uses `Process`.
  - XcodeGen takes it as a local package (`packages: PolydanceCapture: path: ../mac` in `ios/project.yml`)
    with only the `PolydanceShared` product as a dependency, so the Mac's targets are never built for iOS.
    `xcodebuild` compiled the product alone for iOS and the Simulator, and `npm run ios -- check` the app
    with it. A top-level package (the D7 alternative) was not needed.
  - The Mac's five snapshots had 0 differing pixels before and after. They are now drawn at a fixed moment
    (`lookTime`), because the pulsing lamps and the recording key's glow made two runs differ by up to 8,981
    pixels before. `npm run mac -- test`: 151 tests, 5 snapshot tests skipped. `npm run check`: 505 tests,
    the design test reading the shared palette and the iPhone's sources.
  - Two changes to keep the parts building on iOS: a lamp's off colour and a board's tone are worked out with
    `Color.resolve(in:)` rather than `NSColor`, and the needle's angle is computed in steps, since the
    Simulator's type checker gave up on it as one expression.

**I2, record and send.** R1 to R8, S1, S2, S5, S6, P1 to P3, U1 to U6, U8, V1, I-1 to I-4. The receiver
change (U8) is deployed with `recreate.py --image` as on 2026-11-02.
*Exit:* Robin records on the phone, with one flip; the bundle is built on the receiver and `polycap sync`
brings it down; Claude Code reads it with the skill, and its title and summary describe a phone recording.
A second take on mobile data has its title and transcript on the receiver before its video leaves the
phone.

*The look, 2026-11-07* (in the Simulator, not yet on the phone; [ios/README.md](../ios/README.md#the-screens)
says what each screen is wired to): the app's screen is the deck (S1) with the inbox under it, REC fills the
screen (S2), and Recordings (S5) and the settings (S6) are drawn in the shared look on the probe's parts,
which run unchanged. Working now on the probe: REC, FLIP, STOP, Cancel (deletes the take), the counter, the
MIC meter, the UPLOAD lamp, Send now, Retry and Delete (this phone's copy), and the diagnostics. Still to do
for I2: pairing (P1 to P3) and with it the tape's allowance and FULL, the hold after Stop (WAITING), words
first, the receiver's PROCESSING, the recording settings, the controls turning with the phone (R6), the
camera running only on the REC screen, U8 and I-1 to I-4.

**I3, threads.** S3, S4, L1, U7, B1.
*The look, 2026-11-07* (in the Simulator only): the inbox (S3) with its search, drawer, boxes and New thread,
a thread (S4) with folded and full messages, reactions, launches, stars, Just open (L1; OPEN until 2026-11-07) and Reply, and the bug
key's pop-up (B1) are drawn from PolydanceShared's thread models. Until threads are read from the receiver
the inbox is empty and says so; `-lookSamples` fills it for pictures. New thread says it needs pairing, a
report's take stays on the phone, and reacting from the phone is not drawn yet.

*Exit:* an agent posts a message with a link in a CAP thread; the phone shows it unread (and notifies, if
iOS ran the refresh); Just open opens the link; Robin replies with a camera recording from Reply; the agent's
`polycap thread watch` returns with it. A bug report reaches the reports project and leaves the phone.

*Built 2026-11-07* (branch `claude/nifty-shannon-088905`; [ios/README.md](../ios/README.md#the-screens) says
what each screen is wired to):
- **Pairing.** P1 to P3 as above. The pairing is checked by PolydancePhoneCore's `Pairing` (strict, version
  1, refused with the field named) and kept by `PairingStore` in the Keychain.
- **The inbox and threads are the receiver's**, over the headset's routes (`ThreadRequests`, decoded into
  PolydanceShared's models): the list when Polydance comes to the front and every 30 s while it stays, pull
  to refresh, Archived (closed threads), the projects in the drawer. A thread is marked read when opened.
  React, the stars, Archive (the thread closed for everyone) and Delete (hidden for this phone's token) go
  to the receiver, Archive and Delete with Undo.
- **Where a take goes** is written as the run's `thread.json` at REC (`RunThread`, the upload's `thread`):
  Reply answers its thread, REC and New thread open one in the project the inbox shows, or the one chosen
  when there are several, and the bug key makes a report. A take is sent as soon as it finishes, its words
  at once and its video on Wi-Fi only (U3); the hold after Stop (U4) is still I2's. Unpaired, a take stays
  on the phone.
- **B1.** A report leaves the phone once the receiver has it all; each launch sweeps what is left
  (`ReportPolicy`: sent but not removed goes, unsent is sent again once paired, unsent after a week goes).
  The pop-up says when the receiver takes no reports. The tape is the receiver's allowance, and REC reads
  FULL when it is used up.
- **U7.** Replies, behind the gear, asks iOS for permission and posts one notice at once. The background
  refresh asks the receiver which threads are unread and posts a notice per thread for messages by others
  (`ReplyNotices`, what was told kept in `notices.json`); a tap opens the thread, reading it clears it, and
  the badge is the unread count. The inbox on the screen counts as told.

*Results, 2026-11-07, on the iPhone 16* ([PLATFORM-NOTES](PLATFORM-NOTES.md#iphone-seen-on-the-phone-i3-2026-11-07)):
- **Met, on the live receiver.** The phone scanned the code from `npm run ios -- pair` and paired as "Robin
  · iPhone" (22:48 UTC). An agent opened CAP-11 with a link to the receiver's privacy page; the phone showed
  it unread and Just open opened it in Safari. Robin replied from Reply with the camera; the agent's
  `polycap thread watch CAP-11 --once` returned with it (#2, recorded 2026-11-07 22:49). His bug
  report opened CAP-12 in the reports project and was deleted from the phone as the upload finished.
- **Met, first on a local receiver** (`ios/tools/serve-local.sh` with threads on, the pairing copied over USB):
  the same loop in CAP-1, plus a reaction and a star seen in `polycap thread show`, a report (CAP-2), and
  notifications turned on, the first notice shown.
- **Not seen.** A reply's notice from background refresh: iOS ran no refresh task in about 7 hours that day
  (PLATFORM-NOTES), so U7 rests on the check when Polydance comes to the front until refresh is seen to run.
- **Found.** CAP had no link hosts on the live receiver, so no CAP message could carry a link; at Robin's
  choice it now allows `capture.polydance.net`. The new `iphone` token sees every thread as unread at first
  (29 open, 34 unread). The live summary still describes a phone recording as a headset's until U8 is
  deployed.

**I4, the screen.** Planned as: a ReplayKit broadcast upload extension records the whole phone, mic and app
sound as separate tracks (`audioTracks: ["mic", "app"]`, `view: "screen"`), and Record and open records
and then opens the link as on the headset. It writes through a shared container, within the extension's memory
limit. Whether the free team can give an app group to the extension is checked first.

*Built 2026-11-20, the screen and the microphone, on branch `claude/iphone-screen-mic-recording-4c86a8`, merged into `main` the same day; not on the
phone.* Robin asked for "the option of recording the screen and microphone (no camera)". What was built:

- **Where it is.** The camera's switch is Photo · Video · Screen (a sideways swipe moves along it too), wherever the
  camera opens: New thread and Reply. Screen stops the camera, so neither its picture nor its hold on the
  microphone reaches the take. The picture says what will happen, and the red key is iOS's own broadcast button,
  drawn invisibly over a red key, so a press opens the system's Start Broadcast sheet with Polydance chosen. The
  deck's REC still records the camera at once, and the bug key's report has no Screen.
- **The take.** The Vision Pro's broadcast extension, compiled for iOS unchanged (`visionos/Broadcast`,
  `visionos/Shared/Broadcast.swift` and `BroadcastLink`, listed in `ios/project.yml`), with the iPhone's own
  names: the extension `net.polydance.capture.iphone.broadcast` and the app group `group.net.polydance.capture.iphone`.
  It writes the run layout a camera take has: video.mp4 with the screen and the mic as one AAC track
  (`audioTracks: ["mic"]`, no app sound: Robin asked for the screen and the mic), narration.m4a, run.json,
  thread.json from where the line under the key said, and timeline.jsonl. iOS hands over the screen's own pixels
  (1179 × 2556 on an iPhone 16, odd, which H.264 refuses), so `MovieWriterSettings.screen` scales it to 1080 on its
  short side and even sides (1080 × 2340), stretched by under a pixel. The frames are upright for portrait whichever
  way the phone is held, so a take keeps its first frame's size and each turn of the screen goes into the timeline
  (`turned`). The 30-minute limit is the headset's.
- **While it records.** Polydance can go to the background: the extension records whatever is in front. The camera
  screen stays open on the take's own foot (the counter, the MIC meter from the extension's levels, STOP and
  Cancel, no FLIP), and the deck's red key reads STOP. STOP, Cancel (one question, nothing kept) and the system's own
  stop (the red pill, Control Center) all end it. A broadcast started from Control Center goes where the line under
  the key last said (next.json is kept current) and opens the same foot when Polydance comes back. iOS's sheet leaves
  the microphone off unless it is turned on there; a take with no sound from it after 4 s says so over the foot.
- **After it.** The link moves the finished take from the app group into the app's `Runs/` when Polydance is next in
  front (a suspended app hears nothing), and it goes as a camera take does: aimed at a thread, its words at once and
  its video on Wi-Fi (U3), into an `_iphone` bundle. `npm run ios -- pull` also copies the extension's own log,
  `broadcast-events.jsonl`, from the app group.
- *Checked 2026-11-20, without the phone:* `swift test` in ios/Core proves the size rule and writes an odd 1179 × 2556
  picture scaled into a 1080 × 2340 file with no rotation flag. This Mac's Xcode has no iOS 26.2 platform
  (`npm run ios -- check`: "iOS 26.2 is not installed"), so the iPhone app and its extension were type-checked with
  `swiftc` against the iOS Simulator SDK, and the Vision Pro's app and extension against the visionOS one, since the
  shared files changed (the commands are visionOS's, VISIONOS.md Verification 2026-11-20, with
  `visionos/Shared/Broadcast.swift visionos/App/Sources/BroadcastLink.swift` added to the iPhone app's files and the
  extension checked with `-application-extension`). `npm run ios -- generate` made the project with both targets.
  **Not exercised:** anything on a phone or in a simulator: the sheet, a take, the scaling on the phone's encoder,
  the extension's memory, Cancel, Control Center, the take's upload, the screen's picture of the camera screen in
  Screen, and signing with the app group (below).
- **Open.** The free team's profile needs the app group. On the Vision Pro, xcodebuild alone made profiles with an
  empty group list until the group was ticked once in Xcode's Signing & Capabilities on both targets (2026-11-12);
  the iPhone will likely need the same once ([ios/README.md](../ios/README.md#the-screen)). Not built yet: Record
  and open (a launch's first key) for the iPhone, `view: "screen"` (U8 is not built either, so a screen take's
  summary is told it came from a headset), the app's own sound as a second track, and a take that follows the phone
  turning (landscape apps record sideways).

## Not in the first version

Typed replies without a photo, the player, 3D models (and placing them in AR), picture-in-picture, zoom and torch, the mark
key, importing a video from Photos, iPad, testers (Google sign-in, the consent notice, thread-scoped
access), TestFlight, push, the email To line on New thread, and call recording.

## Defaults to confirm

Chosen by Claude on 2026-11-06 where Robin was not asked. **Robin agreed to all eight on 2026-11-07**, so
they are decisions now, changed only by Robin.

| | Default | Why |
| --- | --- | --- |
| D1 | Bundle id `net.polydance.capture.iphone`, display name Polydance | Keeps `capture` in identifiers as the others do; the file names (U6) then give `_iphone` sessions |
| D2 | iOS 26 at least | Xcode 26.3 (iOS 26.2 SDK) is on this Mac. On 2026-11-07 the iPhone 13 ran iOS 26.3 and the iPhone 16 ran iOS 27.2. Whether this Xcode can install on iOS 27.2 is to see when it is connected |
| D3 | H.264, 1080p, 30 fps | The same as the headset and the Mac. HEVC would about halve the size and everything downstream reads it; worth it if mobile data or the 8 GB allowance pinch |
| D4 | Back camera first | Mostly showing things; the gear changes it |
| D5 | Leaving the app ends the take (R7) | iOS stops the camera anyway; resuming into one file would leave a gap the pipeline does not know about |
| D6 | Camera flips stay on the phone | Putting them in the bundle (`source.cameras`, a line in the storyboard) is a second receiver change, best made once real recordings show it matters |
| D7 | Shared Swift in `mac/Package.swift` | The least churn for the Mac app; a top-level package is the tidier alternative |
| D8 | Recordings excluded from iCloud backup | Private by default; the receiver holds the copy that matters once it is uploaded |
