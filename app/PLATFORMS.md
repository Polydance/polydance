# Platform architecture and AURA test build

Polydance remains **one Android 2D panel app**, with Gradle flavors for Meta Quest and
Android XR (initial target: XREAL AURA). No OpenXR, Unity, XREAL/NRSDK or Jetpack XR dependency is
needed for the existing deck, inbox and recording workflow. This is a sideloaded test port, not a
claim of store approval or working XR-wide capture. See [platform evidence](../docs/PLATFORM-NOTES.md#android-xr--xreal-aura-port-2026-10-09).

## Where a change belongs

```text
android/app/src/
  main/                         Shared manifest, resources and Kotlin app
    java/net/polydance/capture/
      platform/HeadsetPlatform.kt   Small policy interface and Android intent helpers
      MainActivity.kt (the one panel), InboxPane.kt, ModelView.kt, Threads.kt, …
      Capture.kt, MuxerCapture.kt, RecorderService.kt, …
  quest/                        Quest-only manifest and PlatformProvider.kt
  androidXr/                    Android XR-only manifest and PlatformProvider.kt
  test/                         JVM tests run against each actual flavor provider
```

| Shared, change once | Platform-owned |
| --- | --- |
| Deck/inbox UI, thread protocol, launch validation and app launches | Optional vendor permission and its settings control |
| The `HeadsetSignIn` interface and every call to it (`signIn` in `SignIn.kt`) | Its provider: Quest's `MetaSignIn` (Meta's Platform SDK, a `questImplementation` dependency, and the Meta app id resource); Android XR's `GoogleSignIn` (Credential Manager and Google ID, `androidXrImplementation` dependencies, and the web client id resource) |
| First-recording notice (`Consent`), bug key and reports, player | Meta store manifest rules: `com.oculus.supportedDevices`, `excludeFromRecents` (Quest overlay) |
| The immersive scene's data: which threads' models go on the table (`Immersive`, JVM-tested) and the `immersiveViewer` hook | The scene itself: Quest's `ImmersiveTableActivity` (Meta Spatial SDK, `questImplementation`, its VR activity, the deck's 2D category, Horizon OS v69, hand tracking and passthrough declarations); Android XR has none yet |
| The inbox's Update key beside a launch's build warning | `storePage`: Quest opens its Horizon Store page through Meta's shell deep link; Android XR has none until Play |
| MediaProjection consent and typed service lifecycle | Preferred URL-handler package (or the system default) |
| Both recording engines, mic/app track ordering, storage | |
| One panel: the deck, the inbox's list and the open thread side by side (2026-10-20) | |
| Receiver client, uploads, narration, notifications, app-switch log | Vendor manifest declarations and platform diagnostic label |
| SDK/tool versions, app version, dependencies, signing | Android XR version suffix identifying test recordings |
| Mac build/install/configure/pull machinery | Mac task/APK/model/wireless descriptors in `tools/platform.ts` |

`src/main` must not identify vendors by `Build.MANUFACTURER` or name their permissions/packages.

Permissions Meta's store prohibits live in `src/debug`, for both flavors: `PACKAGE_USAGE_STATS` (app switches) and,
since 2026-11-16, `READ_LOGS` (logs in a take, [docs/LOGS.md](../docs/LOGS.md); granted over adb by
`npm run app -- logs`). `tools/verify-manifests.py` checks that debug builds declare both and release builds neither.
A release build's takes keep Polydance's own log lines only. A take without the picture is the recorder service as a
`microphone` foreground service alone, already declared; a take of logs alone has no service (`LogsTake`).
Each flavor supplies exactly one `createHeadsetPlatform()` and one `createSignIn()`. Add policy there only for an actual
platform difference; keep normal Android API support/version checks shared. Kotlin JVM tests verify
permissions, browser fallback and inbox flags. `tools/verify-manifests.py` checks **merged**, not just
source, manifests. CI builds debug/release and tests/lints both flavors, so a shared edit is checked against both.

### The Vision Pro is the third headset (2026-11-12)

Apple Vision Pro cannot run this Android app, so it has the same headset app in Swift, in `visionos/`
([docs/VISIONOS.md](../docs/VISIONOS.md)). It is not a flavor here, but it follows the same rules:
- It takes the version from this app's `build.gradle.kts`.
- `npm run app -- release` builds it with the flavors, from the same commit.
- `npm run app -- status` says when it is behind.

A change to what the headset app does (the deck, the inbox, a thread, launches, recording, uploads) is made in
`visionos/` in the same piece of work. Otherwise VISIONOS.md's table of the Quest's features says it is missing there.
Where the shared Swift already has the piece (PolydanceShared, PolydancePhoneCore, the iPhone's files that project.yml
lists), the change is made once there.

No receiver, upload schema, bundle format or processing pipeline fork is introduced. Flavor identity
is recorded in local `run.json`; Android XR's `-androidxr` version suffix also travels through the
existing `source.appBuild.versionName` field without needing a receiver deployment.

Both flavors use **`net.polydance.capture`** and the same signing configuration. On a given headset,
installing one replaces the other; this is not side-by-side installation. Settings, device identity and
recordings remain in the same location. Do not uninstall to update. Since the Quest store work (merged
2026-10-13) both build types of both flavors are signed with the **upload key** when
`~/.config/polycap/android/upload.properties` exists (`private/docs/STORE.md`), and a release build
stops without it. A headset still holding a debug-key build (the AURA's 0.14.0) refuses the update with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`: pull its recordings, then uninstall once. Release forbids cleartext
HTTP and ignores adb's START/STOP/CONFIGURE/UPLOAD; debug allows both.

### Sign-in differs per platform

Quest signs in with Meta (`MetaSignIn`): Horizon OS entitlement gates recording, and the account proof
buys a receiver token, with no screen of its own. Android XR signs in with Google (`GoogleSignIn`, since
2026-10-16). Credential Manager returns a Google ID token naming the receiver's web client
(`google_server_client_id`) and a nonce made for this sign-in. `POST /v1/testers/google` checks it
against Google's keys and admits invited addresses only (`src/server/google.ts`, `private/docs/PLAY.md`).
The deck tries a returning account quietly on resume; while there is no token, its sign-in line opens
the account chooser. Android XR records without a store gate (the system's capture consent still guards
every recording); recordings wait on the headset until a token arrives.

**Until the web client id is set in `build.gradle.kts`, Android XR cannot sign in**: a debug build still
takes a token over adb (`configure --platform android-xr`), and a release build, which ignores
`CONFIGURE`, records locally only. The first-recording notice names "your Meta name" on Quest and "your
Google account name" on Android XR, under the same consent version, which the receiver requires from
Meta and Google testers alike.

## Deliberate first-build differences

- **Quest:** optional spatial-data permission and its switch, preferred Quest Browser when it handles
  the URL. Existing capture presets are unchanged.
- **Android XR:** no Oculus permission, no spatial-data switch (even with a stale preference or
  `spatial=true` ADB extra), system URL handler.
- **One panel on both since 2026-10-20** (Robin: several panels are hard to manage on Horizon OS). Until
  then Quest opened the inbox, and from 2026-10-19 the 3D viewer, as adjacent panels with their own task
  affinities, and Android XR stacked the inbox in the deck's task; `InboxMode`, `inboxIntent` and
  `viewerIntent` went with them. Now `MainActivity` holds the deck (420 dp) and `InboxPane`'s two columns:
  the threads, full width until one opens, then 400 dp beside the open thread. Below 820 dp of inbox the open
  thread takes the list's place. The `<layout>` asks for 1440 × 900 dp, 16:10 like Meta's 1024 × 640 dp
  default at the widest Meta allows ([PLATFORM-NOTES.md](../docs/PLATFORM-NOTES.md#panel-sizing-2026-10-20));
  the user can resize it, and the columns follow. The values request a panel size; they are not
  screen-capture pixel sizes or guaranteed placement. The player still opens over the panel.

### Recording policy and limits

Both platforms record at a fixed output canvas chosen behind the gear as **picture quality** (since
2026-11-18, at Robin's ask; it replaced the choice of 1920×1080, 1280×720 or 1024×1024): **Low**
1280×720 at 4 Mbit/s, **Medium** 1920×1080 at 8 Mbit/s (the default, and what every take had before),
**High** 1920×1080 at 16 Mbit/s, all capped at 30 fps (`RecordingQuality.kt`). A saved 1280×720 becomes
Low, the other two sizes Medium. Medium's takes on Quest 3 (0.21.0, five takes of 2026-11-17 and 18)
measure 9.3 to 9.9 Mbit/s, so the encoder runs about a fifth over what it is asked; High and Low are not
yet recorded on a headset. High at 30 fps gives each frame about the bits of Meta's own recorder at its
recommended 20 Mbit/s and 36 fps, and stays 1080p because frames for an agent are at most 1920 wide.
The fixed canvas This preserves Quest behavior, bounds encoder load and avoids guessing a native
AURA eye/compositor resolution. Android scales/letterboxes standard projection output into the canvas;
actual XR compositor behavior must be inspected in recorded frames. Resize callbacks log the source
and output dimensions; they **do not** reconfigure the encoder or create a second VirtualDisplay with
the same consent token. Adaptive capture geometry/codec negotiation is not part of this first port.

Every recording still requires OS consent. Android 14+ requests the default display, not a single app.
That request is not a guarantee of all XR layers, both eyes, other immersive apps or the real world:
AURA is optical see-through. Protected content and playback-capture/microphone policies remain under
OS/source-app control; this app does not bypass them.

## The 3D viewer

`ModelView` shows a model a thread's launch opens ([THREADS.md](../docs/THREADS.md#models)) inside its
message, above the launch's Reply key (2026-10-20; from 10-19 it was `ModelActivity`, a panel of its own): a
WebView with Google's `<model-viewer>`, 440 dp tall, in shared space, never an immersive or Full Space
activity ([why](../docs/PLATFORM-NOTES.md#3d-models-in-shared-space-2026-10-19)). The inbox keeps one per
message while the thread is open, so a redraw does not reset a turned model, and destroys them when the
thread closes. A drag that starts on the model turns it rather than scrolling the thread. When a launch runs,
the deck asks the inbox (`Threads.showModel`) to open that message and scroll to it.

- **Files:** `src/main/assets/viewer/`: our `index.html`, `config.js` and `viewer.js`, and unmodified
  `@google/model-viewer` 4.3.1 (`model-viewer.min.js`, npm integrity
  `sha512-GP+inXhAtY31E8rILVmByA6z8CZZjdlNajddppyI1/j1eIaSQiZcMRaUqTFe7+jv4mzRzwKIOiKBud0apiv+WQ==`) with the Draco glTF
  decoder and Basis Universal transcoder from `three` 0.183.2 (npm integrity
  `sha512-di3BsL2FEQ1PA7Hcvn4fyJOlxRRgFYBpMTcyOgkwJIaDOdJMebEFPA+t98EvjuljDx4hNulAGwF6KIjtwI5jgQ==`). Licences in
  `LICENSES.txt`. About 1.8 MB of the APK; no native libraries.
- **No network from the page.** The WebView loads `https://appassets.androidplatform.net/viewer/index.html`
  and `ModelView` answers every request itself: files in that folder, and the one model it fetched and
  checked (`Models`), else a 404. The page also carries a content security policy, file and content access are
  off, and navigation away is refused. Debug builds allow `chrome://inspect`.
- **Talking to the page:** the page title says `progress 0.42`, `loaded 1 animation` or `error loadfailure`;
  the keys call `window.polydance.turn/zoom/spin/reset` with `evaluateJavascript`. No JavaScript interface is
  added.
- **Verified on Quest 3, 2026-10-20** for the panel version (0.16.0 (23) from Meta's Alpha, CAP-10 #3): the
  WebView draws the model in its own panel, it turns and zooms with the controller, the key row shows, and the recording captures it.
  The panel opened in the middle, between the inbox on the left and the store page on the right, where the
  deck had been. The viewer in a message (0.17.0) is not yet seen on a headset; nor are hand input, a large
  or animated model, or anything on Android XR.

### The immersive scene (Quest, 2026-10-21)

Robin's spec (CAP-10, 2026-10-21) asks for:
- an Immersive key that goes to mixed reality or VR;
- a simple scene where Polydance's window stays the main window;
- a table with objects for the threads the tester follows, which they pick up, scale, look at and put down;
- the interface still in use, and a way back to shared space.

Choice and sources: [IMMERSIVE-VIEWER-RESEARCH.md](../docs/IMMERSIVE-VIEWER-RESEARCH.md).

- **What it is:** `ImmersiveTableActivity` (`src/quest`), a Meta Spatial SDK 0.14.0 `AppSystemActivity` with
  `VRFeature`. It runs in a task of its own (affinity `net.polydance.capture.immersive`, not exported,
  `com.oculus.intent.category.VR`). It opens with passthrough; **◐ VR** turns the room off and **◑ Room** brings it
  back.
- **The table:** 1 m × 60 cm, its top at 74 cm, 75 cm in front of the tester, built from boxes. On it stand up to six
  pieces, three across and two deep (`Immersive.table`):
  - the model whose Immersive key was pressed, 22 cm, front middle;
  - then the latest model of each followed thread, 15 cm each.

  "Followed" is the inbox: its open threads in the filter's projects, newest first, looking into at most 12
  (`Immersive.followed`). Each piece has a label in front of it with its thread's key and title.
- **Handling:** one hand or controller picks a piece up, moves and turns it; two hands scale it, from 0.1 to 30 times
  its table size (`IsdkGrabConstraints`, `maxGrabbers = 2`). A piece stays where it is put down. **⟲ Reset table**
  stands every piece back in its place.
- **Polydance's panel:** started over the scene as the scene opens (Meta's cooperative mode: the deck's
  `MainActivity` carries `com.oculus.intent.category.2D` in the Quest flavor, and the app declares Horizon OS v69).
  **▣ Polydance** opens it again if it was closed. **↩ Shared space** goes Home and reopens it there.
- **Models:** fetched through their threads as `ModelView` fetches them, kept by `Models`, and checked against each
  message's sha256 before they are drawn (`Mesh(file://…)`). A model that has not drawn after 30 s is reported.
- **Timeline events,** under `immersive`: `open`, `table`, `piece_shown`, `piece_failed`, `fetch_failed`, `reset`,
  `passthrough`, `exit` and `close`.
- **The key:** **⬚ Immersive** in a model's title row in its message, beside **Controls**, so it shows whether or not
  the keys are open (`ModelView`, since 2026-10-21, merged with 0.18.0). It works once the model's copy is verified,
  and it hands the scene the thread, its title and the model (`headsetPlatform.immersiveIntent`, `Immersive.EXTRA_*`).
  It shows only where the platform names an immersive activity, so on Quest only.
- **What it costs:**
  - 56 MB of arm64 native libraries in the Quest APK (debug 71.3 MB, was about 14 MB).
  - Kotlin 2.2.21 for both flavors, which the Spatial SDK's metadata needs.
  - The `HAND_TRACKING` permission.
  - Horizon OS v69 as the floor.
  - Head tracking is declared not required, so Polydance stays a panel app.
  - The Android XR APK is unchanged: 13.4 MB, no native code.
- **Not verified:** all of it on a headset, including:
  - whether Meta's upload check takes the VR activity and the v69 declaration;
  - whether the deck really shows over the scene and stays usable;
  - whether two hands scale;
  - whether the recording keeps capturing the scene;
  - where the panel comes back after Shared space;
  - Draco and KTX2 models.

## Build

From the repository root, with Node 22, the project's npm dependencies, a full JDK 17, Android SDK
platform 35 and build-tools 35.0.0 installed. On this Mac:

```bash
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
npm run app -- build --platform android-xr
```

For Quest, use `--platform quest` (the default). Add `--release` for the release variant. The CLI uses
the checked-in Gradle wrapper directly, without a host shell or installation of dependencies.

| Platform | Debug task | APK relative to `app/android/` |
| --- | --- | --- |
| `quest` | `assembleQuestDebug` | `app/build/outputs/apk/quest/debug/app-quest-debug.apk` |
| `android-xr` | `assembleAndroidXrDebug` | `app/build/outputs/apk/androidXr/debug/app-androidXr-debug.apk` |

Release substitutes `Release`/`release`/`-release.apk`. `assembleDebug` now builds **both** flavors;
the old unflavored `outputs/apk/debug/app-debug.apk` is obsolete and may be a stale artifact.

**Builds that leave this Mac come from `npm run app -- release` on `main`**, which builds every flavor
from one commit and records it in `app/releases.json`. `npm run app -- status` shows which platform or
connected headset is behind. See [RELEASING.md](../docs/RELEASING.md), which also covers how the AURA
fell behind Quest by six builds.

```bash
npm run check
cd app/android
./gradlew testQuestDebugUnitTest testAndroidXrDebugUnitTest assembleQuestDebug assembleAndroidXrDebug lintQuestDebug lintAndroidXrDebug
cd ../..
python3 app/tools/verify-manifests.py
```

## Connect and install AURA

USB: enable debugging on the device, connect a data-capable cable and accept the authorization prompt.

```bash
adb devices -l
npm run app -- install --platform android-xr --device SERIAL --launch
```

Wireless: use the device's **Wireless debugging → Pair using pairing code** flow. Pairing and connection
ports are different; neither is assumed to be 5555. Enter the code at adb's prompt, not in a saved script.

```bash
adb pair IP:PAIRING_PORT
adb mdns services
adb connect IP:CONNECT_PORT
npm run app -- install --platform android-xr --device IP:CONNECT_PORT --launch
```

`install --connect IP:CONNECT_PORT` also works for an already-paired device. `wifi --platform android-xr`
prints the pairing instructions; it deliberately never changes adbd to Quest's legacy TCP mode.

All device commands default to Quest for compatibility. Pass **`--platform android-xr`** for AURA,
including configure and pull. Selection refuses the wrong platform, unknown/ambiguous devices and
unauthorized transports; matching USB/Wi-Fi transports coalesce only with the same nonempty hardware
serial. Supported identities include `Android XR Puck`, `XREAL AURA`, and `AURA` from XREAL, not every
XREAL product. An unknown engineering build can be installed explicitly with `--device SERIAL
--any-device`; report its model to add a narrowly scoped identity rather than weakening defaults.
`--force` only overrides the active-recording guard, never platform identity. Normally **stop recording
before installing**: replacing a running recorder can leave an unplayable MP4.

## Receiver setup and first recording

A fresh AURA install has no receiver credentials. For the local capture smoke test it can stay
unconfigured: recordings remain on the device and can be pulled without uploading. For the full loop,
use a private token file (mode 0600) provisioned for this tester/device; do not copy the Quest's app data
or device identity onto AURA. Existing configuration instructions are in [README](README.md).

```bash
npm run app -- configure --platform android-xr --device SERIAL --server https://capture.polydance.net --token-file /private/path/to/aura-token
```

1. Open the deck/settings and confirm the Android XR build label and absence of Quest spatial-data UI.
   Exercise inbox/back/reopen and panel resizing before recording.
2. Start a 60–90 second recording with mic and app audio enabled. Accept consent yourself; choose the
   whole display if the picker offers a choice. Speak while showing the deck for about five seconds.
3. Open Chrome/a permitted test app, then the immersive app under test. Speak distinctive markers,
   play sound and interact for at least 30 seconds. Return to the deck for five seconds and stop.
4. Pull locally, using a platform-specific folder to avoid mixing timestamp-named runs from headsets:

   ```bash
   npm run app -- pull --platform android-xr --device SERIAL --out .local/aura-runs
   npm run app -- analyze latest --out .local/aura-runs
   ```

5. Inspect actual frames and listen to **both audio tracks independently**. Verify content, aspect ratio,
   continuity, narration, app sound and synchronization—not just file growth. The analyzer's YES needs
   a hidden-deck interval; multi-window use with no such interval can legitimately be **inconclusive**.
   Lifecycle/app-switch events are observations, not proof of which XR content was visible/captured.
6. Test revocation, another app taking the microphone, sleep, and restart/second recording. If configured,
   verify an uploaded recording reaches its thread and the existing pipeline builds the bundle.

Record findings with firmware/model/build/date in `docs/PLATFORM-NOTES.md` and `private/docs/ROADMAP.md`.
Build/test success does not certify any of these hardware behaviors.


## Verification — 2026-10-09

- `npm run check`: **509 tests in 19 files**, TypeScript passed.
- Clean debug **and** release builds for both flavors; all four lint tasks: **0 errors, 8 warnings**
  each (existing SDK/dependency versions, backup rule/icon and custom-view constructor warnings).
- **14 JVM tests per flavor, 28 total**: platform policies and recording-request state/snapshot tests.
  These are not instrumented activity or hardware tests.
- Both build types passed merged-manifest/source-boundary/APK-metadata checks; all four signatures
  verified. CLI Android XR debug build and wireless-help paths exercised locally.
- Initially blocked by no connected device; **installed and launched at 23:57 BST** after Robin supplied
  wireless ADB access. Device identifies as Google Android XR Puck, Android 14/API 34. Package version
  `0.14.0-androidxr` (14), running process and resumed/focused MainActivity verified; crash buffer empty.
  APK source commit `213fd15`. **Capture, audio, visual/interaction acceptance and upload remain unverified.**
  No recording was started or credentials configured by the agent.

Full dated record: roadmap (`private/docs/ROADMAP.md`). The CI configuration is added but has not run remotely.

## Verification — 2026-10-13 (merge of the Quest beta line)

- `npm run check`: **370 tests in 19 files**, TypeScript clean.
- Gradle (JDK 17, SDK 35): `testQuestDebugUnitTest` and `testAndroidXrDebugUnitTest` passed, **57 JVM tests
  per flavor** with 0 failures. Both debug APKs assembled. `verify-manifests.py debug` passed. It now also
  rejects Meta/Oculus imports in shared or Android XR Kotlin, and pins the Quest-only store attributes.
- The Android XR debug APK has **no native libraries and no `com/meta/horizon` classes**. The Quest one has
  Meta's SDK (2 native libraries, 266 class references).
- Not exercised: any headset (none was connected), sign-in on either platform, a recording or upload from
  the merged build. Release builds, lint and the first `release` run are recorded in the
  roadmap (`private/docs/ROADMAP.md`).
