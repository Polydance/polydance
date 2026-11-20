# Polydance on Apple Vision Pro

Built by Claude for Robin on 2026-11-12, from his brief that day. It runs on his Vision Pro (visionOS 26.6), where he
recorded a reply that reached its thread. What is built is said only in `private/docs/ROADMAP.md` "Where we are". Platform
claims are in [PLATFORM-NOTES.md](PLATFORM-NOTES.md#vision-pro-2026-11-12) with their sources. Those seen on the headset
are marked so, with their date. How to build, install and pair it is in [visionos/README.md](../visionos/README.md).

## The brief

Robin, 2026-11-12: "a Vision OS port of the Quest app. It doesn't have to be released on the store. We just have to put
it on my Vision Pro headset, and it should act exactly like the Quest version, pretty much exactly the same. It should
follow the same pipeline so that updates to any of the versions get copied across."

## The short answer

1. **It is the Quest's panel, in Swift.** The Quest app is Android (Kotlin), which visionOS cannot run, so the Vision
   Pro has its own SwiftUI app in `visionos/`. It is built from the Swift the Mac and the iPhone already share rather
   than a copy:
   - PolydanceShared, the look and the thread models.
   - PolydancePhoneCore: run folders, the movie writer, the upload protocol, pairing and thread requests.
   - The iPhone app's own files that are not about a camera, used unchanged: the receiver client, the background
     upload, the refresh, reply notices, the Keychain pairing, the provisioning reader and the pop-up.
   - The Quest's own 3D viewer page and logo.
   One window is the Quest's one panel: the deck on the left, the inbox and the open thread beside it.
2. **Recording goes through a ReplayKit broadcast extension.** On visionOS only a broadcast upload extension sees the
   whole view: windows, other apps and immersive content. An app recording itself sees only its own window. The
   extension writes what the Quest's MuxerCapture writes, in the iPhone's run layout: the view, the mic, and the app's
   sound as a second track. The app then uploads it. visionOS asks with its own Start Broadcast sheet before each
   recording. Without Apple's enterprise licence the room is black in the recording.
3. **The same pipeline.** One version number for all three headsets: versionName and versionCode in
   `app/android/app/build.gradle.kts`. `npm run app -- release` builds the Vision Pro beside the two Android flavors,
   from main's tip, and refuses to record a release without it unless `--skip-visionos` says so (Robin, 2026-11-19,
   while this Mac's Xcode lacked the visionOS platform: Quest releases are not held for the Vision Pro). `install --platform visionos` records the delivery,
   and `status` asks the paired Vision Pro which build it has, so a Vision Pro that misses an update shows as behind
   ([RELEASING.md](RELEASING.md)). A change to what the headset app does is made for both codebases in the same piece of
   work, or [the table below](#the-quests-features-on-the-vision-pro) says what is missing (CLAUDE.md).
4. **Nothing new on the receiver.** The Vision Pro uses the headset's routes with an `upload` token. Its takes become
   `_visionpro` bundles through the upload's file name (`net.polydance.capture.visionpro-…`), as the iPhone's became
   `_iphone`, and send `audioTracks: ["mic","app"]`, the build number and `opened`. The receiver's prompts already
   describe a person wearing a headset.

## Robin's decisions, 2026-11-12

| Decision | What it means here |
| --- | --- |
| **Robin's own headset, not a store.** | Built and installed from this Mac over the network with `devicectl` (`npm run visionos`), signed with his Apple Development identity. The certificate ends 2027-03-09, as for the iPhone. |
| **Act like the Quest.** | The Quest's layout, keys, words and behaviour, adjusted only where visionOS forces it (below). |
| **The same pipeline.** | The release, ledger and status rules above. |
| **The visionOS platform downloaded.** | Xcode's visionOS 26.2 platform, about 8 GB, at Robin's yes. The iOS one is still missing on this Mac (see [Open](#open)). |
| **A `visionpro` token.** | Upload, user `robin`, label "Vision Pro", no expiry, added to the live receiver at Robin's go-ahead ([HOSTED.md](HOSTED.md#tokens)). Messages read "Robin · Vision Pro". |
| **The meters' flick switches and Settings on each launch** (after his first test). | MIC and APP each carry the Quest's bat-handle OFF/ON switch. Each launch in a thread has ▾ Settings with Mic and App sound, the same switches. |

## What it does

- **The panel.** One window, opening at 1440 × 900 points like the Quest's 1440 × 900 dp, resizable to 720 wide.
  - The deck, 420 points wide: the top plate with its reels (turning while recording), the tape (the receiver's
    allowance), the list key to Recordings, the bug key and the gear.
  - Under the top plate, the black panel:
    - the MIC and APP needle meters, each with its OFF/ON switch, locked while recording;
    - the UPLOAD and PROCESSING lamps, the counter, REC and READY;
    - the red key (REC, "…", STOP, FULL) with Cancel under STOP;
    - the line saying where the take goes, a hint when something needs doing, and the notice that fades after 8 s.
  - Beside the deck, the threads: full width until one opens, then 400 points beside the open thread, Recordings or
    the New thread draft. Below 820 points the open item takes the list's place, as on the Quest.
- **Recording.** REC is visionOS's own broadcast button, drawn invisibly under the red key, so a press always reaches
  the system's sheet. Reply, New thread, the bug key and Record and open press it from code. On 2026-11-12 visionOS
  accepted the press from code; if it ever refuses, the deck says to press REC.
  - The take is written in the app group by the extension: video.mp4, narration.m4a, run.json, thread.json and
    timeline.jsonl. When it finishes, the app moves it into its own `Runs/`.
  - After the Quest's hold (5 s, or 30 s for a take under 20 s; none for a report) the iPhone's background upload
    sends it: words first, then the video in 8 MB chunks.
  - The 30-minute limit is the Quest's.
- **Threads.** The receiver's inbox, Archived, projects in the drawer, and the Quest's search, where every word must
  match somewhere. The list is read every 10 s and the open thread every 5 s while the window is in front.
  - A thread shows earlier messages folded, the latest in full, reactions (the smiley), picks (★ Pick), Archive and
    Delete with Undo, and Reply.
  - A launch shows its 3D model in the message: the Quest's own `<model-viewer>` page in a web view, the model
    checked against its sha256. Its keys are Record and open, Just open and ▾ Settings.
  - Record and open records, then opens the links in Safari 0.7 s after the first frame. While a take runs, either key
    opens into it. Each opening goes into opened.json and is sent as `opened`.
- **Reports.** The bug key's report goes to the reports project with no hold and leaves the headset once sent.
- **Settings behind the gear:** recording (the two sounds), the receiver (paired as, Unpair), reply notifications,
  diagnostics (device, visionOS, build and commit, when the signing ends, a clock) and the last events.
- **Pairing.** `npm run visionos -- configure --token-file ~/.config/polycap/tokens/visionpro` copies a pairing file into
  the app, which takes it into its Keychain at the next launch. The Quest signs in with Meta. There is no QR code
  here, since a visionOS app may not use the cameras.

## The Quest's features on the Vision Pro

This is the list a change to the headset app is checked against (CLAUDE.md). "Same" means the same behaviour and words,
from the Swift side.

| Quest | Vision Pro |
| --- | --- |
| One panel: deck, inbox, open thread; 420/400 dp columns, 820 dp rule | Same |
| Top plate, reels, tape, list key, bug key, gear | Same (PolydanceShared) |
| MIC and APP meters with OFF/ON switches, locked while recording | Same (since 2026-11-12, after Robin's first test) |
| Lamps, counter, red key (REC, …, STOP, FULL), Cancel, destination line, hint, notice | Same |
| Recording the display with mic and app tracks; narration | Same tracks. The picture is visionOS's whole view at 1920 × 1080; the room is black (Apple) |
| Picture quality Low, Medium, High behind the gear (since 2026-11-18) | Same choice; visionOS chooses the size, so only the bitrate changes: about 4, 9 and 16 Mbit/s at 1920 × 1080 (`RecordingQuality` in `Shared/Broadcast.swift`, sent in next.json). Medium is the bitrate every take had before. Not yet compiled for the headset: this Mac's Xcode lacks the visionOS 26.2 platform (2026-11-18) |
| Hold after Stop (5 s, 30 s under 20 s), reports with none | Same |
| Uploads: narration first, 8 MB chunks, 409 offsets | Same code as the iPhone (background URLSession) |
| An upload's progress (2026-11-15): UPLOADING 42%, the twenty-segment strip, "460 of 1,087 MB · 2.1 MB/s · about 5 min left", and once nothing has moved for 20 s "nothing sent for 40 s · sending again in 25 s" or "· waiting for Wi-Fi", in Recordings and in the thread | Same words (the iPhone's `UploadProgress`, from `UploadProbe.progress`), in Recordings, in the message for this headset's take, and on a card at the thread's foot until the receiver has the message; the card has Send now during the hold, not the Quest's Retry and Delete. Its reasons are the iPhone's: a retry's wait, and a costly network the video waits out |
| PROCESSING lit until the bundle is ready (ServerSync) | Same |
| Inbox, Archived, projects, search, drawer, Recordings | Same |
| Thread: folded messages, reactions, picks, Archive, Delete, Undo, Reply | Same |
| Launches: Record and open, Just open, ▾ Settings (Mic, App sound), describe line | Same; links open in Safari |
| Launch steps that open or require an Android app | Said to be Quest and Android XR only; Record still records |
| Require checks and the Update key | Not built: nothing to check on visionOS, and no store page |
| 3D model in the message, Controls (turn, zoom, spin, reset) | Same page and keys |
| Immersive table (Quest only) | Not built; Android XR has none either |
| Bug key and reports | Same |
| Consent notice (Meta and Google testers) | Not shown: the headset is paired as Robin, as the iPhone is |
| Sign-in with Meta | Pairing with a token from the Mac |
| Player (playback, moments, transcript) | Not built yet |
| Photos in messages | Said in words; not drawn yet |
| Adding photos (the iPhone's camera, then choose, 2026-11-13) | None, as the Quest adds none ([THREADS.md](THREADS.md#photos)); the shared receiver client has the calls |
| Connect your agent (2026-11-20, [THREADS.md](THREADS.md#the-headsets-built-2026-11-20)): the card at the top of the inbox, the card in the Welcome's answer, Agents in the menu with the steps, the code and Disconnect | Same words and rules (`AgentsPage.swift`, `Agents.swift` in PolydancePhoneCore). Type-checked for visionOS, not built as an app or seen on the headset. The card is put away for the headset, not per account: it is paired with one token |
| Share, Add people, People, the account sheet and email | Not built yet |
| New thread's To line (invites) | Not built yet; the project list (with New project, 2026-11-13, as on the Quest) and Record the first message are |
| Delete everywhere, the server's history in Recordings | Not built yet: Delete removes this headset's copy only |
| App-switch log (Usage access) | Not possible on visionOS; nothing records which app was in front |
| Logs in a take (2026-11-16, [LOGS.md](LOGS.md)): the Logs switch, the device's log read at Stop and sent first | Not possible on visionOS: an app reads only its own process's log (`OSLogStore` scope `.currentProcessIdentifier`), never Safari's or another app's, so the Vision Pro has no Logs switch. A message from a headset that sent logs says "with logs", and a take of logs alone "Logs only" (PolydanceShared) |
| Screen off: a take of the mic alone, or of logs alone (2026-11-16) | Not built: the take is ReplayKit's broadcast, which records the screen; logs alone would hold nothing (above) |
| Reply notifications | Same code as the iPhone (background refresh) |

## How it fits

```text
visionos/
  project.yml            XcodeGen: the app and its broadcast extension; the shared sources listed by path
  App/Sources/           the panel (PanelScreen, DeckColumn, ThreadPage, RecordingsPage, SettingsPage), the model
                         (HeadsetModel), the broadcast's app side (BroadcastLink), the 3D viewer (ModelViewer)
  Broadcast/             SampleHandler: the take, written with PolydancePhoneCore's MovieWriter
  Shared/Broadcast.swift what the app and the extension agree on: next.json, live.json, Runs/, Darwin notifications
  build.sh               npm run visionos -- …
```

The app and the extension share an app group, `group.net.polydance.capture.visionpro`, and nothing else.
- The app keeps `next.json` current with where the next take goes and which sounds it records, so a broadcast started
  from anywhere is right.
- The extension writes `live.json` and tells the app with a Darwin notification. It also writes a heartbeat, so a take
  whose extension died is taken in as cut off rather than shown as recording forever.
- STOP and Cancel are Darwin notifications the other way. The extension finishes the files, then ends the broadcast.
- Since 2026-11-20 the iPhone compiles the same three files for its Screen mode (docs/IPHONE.md I4): `SampleHandler`,
  `Shared/Broadcast.swift` and `BroadcastLink`, listed by path in `ios/project.yml`. The names in `BroadcastShared`
  are each platform's own (the iPhone's group is `group.net.polydance.capture.iphone`), and so are the Info.plists
  and entitlements. A change to these files reaches both, so type-check both (Verification below, and IPHONE.md I4).
  The same day the extension began scaling the picture through `MovieWriterSettings.screen`, which leaves the Vision
  Pro's 1920 × 1080 as it is and only makes an odd size even, and naming the screen's turns in the timeline.

## Open

- **This Mac has no iOS platform** (removed on 2026-11-10; only visionOS was downloaded on 2026-11-12). The
  iPhone app cannot be compiled here until it is downloaded. The shared code it uses was changed: the movie writer's
  second track, the identifiers taken from the bundle id, and ErrorWords. These changes are covered by `swift test`
  and the Vision Pro's build, which compiles the same iPhone files, but not by an iPhone build.
- **The not-built rows above,** in the order Robin wants them.
- **A personal team's app group.** Xcode registered `group.net.polydance.capture.visionpro` for the Personal Team on
  2026-11-12 by ticking it in Signing & Capabilities: xcodebuild alone made profiles with an empty group list. See
  [visionos/README.md](../visionos/README.md) if a new Mac or account needs it again.

## Verification

- **2026-11-20, Connect your agent, without the headset.** `xcodebuild` still has no visionOS destination on this
  Mac (see Open), but the SDK is there, and `swiftc` type-checks against it. The whole app was type-checked for
  the visionOS 26.2 simulator, with no errors, in three steps from the repository root, `$B` a scratch folder:

  ```sh
  SDK=$(xcrun --sdk xrsimulator --show-sdk-path); T=arm64-apple-xros26.2-simulator
  xcrun swiftc -emit-module -module-name PolydanceShared -sdk "$SDK" -target "$T" -parse-as-library -emit-module-path "$B/PolydanceShared.swiftmodule" mac/Sources/PolydanceShared/*.swift
  xcrun swiftc -emit-module -swift-version 6 -module-name PolydancePhoneCore -sdk "$SDK" -target "$T" -parse-as-library -enable-bare-slash-regex -I "$B" -emit-module-path "$B/PolydancePhoneCore.swiftmodule" ios/Core/Sources/PolydancePhoneCore/*.swift
  xcrun swiftc -typecheck -module-name Polydance -sdk "$SDK" -target "$T" -parse-as-library -enable-bare-slash-regex -I "$B" visionos/App/Sources/*.swift visionos/Shared/*.swift ios/App/Sources/{ReceiverClient,UploadProbe,RefreshProbe,ReplyNotifier,PairingStore,ProvisioningInfo,PlateDialog,ProjectList}.swift
  ```

  That proves the types and the visionOS APIs used, as `npm run visionos -- check` would; it links nothing, builds
  no app and draws nothing. `swift test` in `ios/Core`: 105 passed, 9 of them `AgentsTests`. **Not exercised:**
  the card, the Welcome's card and the Agents page on the headset or in a simulator, and a code asked for from it.
- **2026-11-12, on Robin's Vision Pro (RealityDevice14,1, visionOS 26.6), from commit `842d874`.**
  - Paired with this Mac by `devicectl manage pair` (the headset's Remote Devices page open).
  - Installed with `npm run visionos -- install` and paired with the receiver by `configure`.
  - Robin opened a thread and pressed Record and open. visionOS's sheet came up from the press in code; the take
    recorded, both launch links opened into it (`opened.json`, at 0.7 s and 17.5 s), STOP finished it, and after the
    5 s hold it uploaded to the live receiver in 24 s: 36.7 MB, narration first, five chunks, `upload.done`.
  - The file: H.264 1920 × 1080 at about 30 fps (968 frames, none dropped), a mono AAC mic track then a stereo AAC app
    track, both 48 kHz, and narration.m4a. A frame shows Safari and the other windows on black.
  - Robin then asked for the meters' switches and Settings on launches. Both were built from `81dacb0` (installed
    from the tree before that commit) and seen working by him.
- **Checks that day:**
  - `swift test` in `ios/Core`: 80 passed.
  - `npm run mac -- test`: 183 run, 7 skipped, 0 failures.
  - `npm run check`: 609 passed, with the release and design tests for the Vision Pro.
  - `npm run visionos -- check` compiled for visionOS and its Simulator; the panel was seen in the Simulator.
- **Not exercised:** a take longer than a minute, the 30-minute limit, Cancel's discard, a report, New thread, a 3D
  model drawing (not confirmed), Just open with no take running, reply notifications, an upload interrupted by
  the network, and the release command end to end (no release was made).
- **2026-11-15, an upload's progress, on branch `claude/headset-upload-progress`, merged into `main` that day; not
  on the headset.** `npm run visionos -- check` compiled for visionOS and its Simulator with Recordings' twenty
  segments and words, the thread message's, and the card at the thread's foot. The words and the meter are the
  iPhone's `UploadProgress`/`UploadMeter`, tested by `swift test` in `ios/Core` (96 passed on `c020acf`, unchanged
  here). Not seen in the Simulator or on the headset, and no upload was made.
