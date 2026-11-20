# Platform notes

What the headsets allow, from documentation and from the devices on hand. Each item says whether it
was verified on hardware. Research date: 2026-10-01.

## Meta Quest (Horizon OS)

| Claim | Status | Source |
| --- | --- | --- |
| Which app is in front, and when, is recorded by the system (`UsageStatsManager` ACTIVITY_RESUMED events), including the Quest Browser and an immersive music app, and other apps' versions are readable; an app could log them with Usage access. The per-app Usage access page (`ACTION_USAGE_ACCESS_SETTINGS` with `package:<app>`) resolves to Android's own `AppUsageAccessSettingsActivity`, so a tester could grant it without adb; the plain intent goes to Horizon's relay activity. | Verified on hardware, Quest 3 (UP1A.231005.007.A1), 2026-10-02: the page opens (`AppUsageAccessSettingsActivity`), Robin granted Usage access in the headset with no adb, and Polydance Capture 0.5.0 then logged the switches of two real recordings (Capture, then the Browser, then back); the lists also carried the system UI (`com.oculus.vrshell`, `com.oculus.panelapp.library`) and sub-second panel flicker, which the readable list leaves out | `dumpsys usagestats`, `cmd package resolve-activity`, `appops get` |
| Native recordings are written to `/sdcard/Oculus/VideoShots/<package>-<yyyymmdd>-<hhmmss>.mp4`. | Documented, not yet verified on a Quest in this project | [ManageXR: screen record on Quest](https://help.managexr.com/en/articles/6706575-screen-record-screenshot-on-meta-quest-devices) |
| A user starts and stops recording from the universal menu Camera app, or by holding the Meta button and the right trigger. | Documented | [Meta help: record video](https://www.meta.com/help/quest/516228089650875/) |
| adb can start and stop the system recorder with `setprop debug.oculus.enableVideoCapture 1|0`, and configure size and bitrate with `debug.oculus.capture.*`. Shell only; an app cannot set these. | Documented | ManageXR, [Meta MQDH media tools](https://developers.meta.com/vr/documentation/unity/ts-mqdh-media/) |
| Developer mode needs a Meta developer organisation, a toggle in the phone app and a prompt in the headset. Testers cannot be expected to do this. | Documented | [Meta: use adb with Quest](https://developers.meta.com/vr/documentation/native/android/ts-adb/) |
| MediaProjection is officially supported: an app can capture the whole headset display from the compositor and system audio, after a consent dialog. | Documented | [Meta: MediaProjection API on Quest](https://developers.meta.com/horizon/documentation/native/native-media-projection/) |
| Policy: "Apps may only use the MediaProjection API to enable casting, live streaming, or screen sharing in accordance with our policies and guidelines and for no other purpose." Recording to a file is not named. | Documented, verbatim | Same page |
| MediaProjection needs Horizon OS v68+, a foreground service of type `mediaProjection`, and the Spatial Data app permission; stopping the projection discards the token so each start needs consent again. | Reported by a plugin author, not verified here | [QuestMediaProjection README](https://github.com/t-34400/QuestMediaProjection/blob/main/README.md) |
| A MediaProjection capture started by a 2D app keeps running while the user is in a different immersive app, and after they come back: no frame gap, 30 fps throughout, the other app's content in the frames. | Verified on hardware 2026-10-01, one run: Quest 3, Android 14, an immersive music app for 40 s | [Capture probe results](../app/README.md#results); Meta docs are silent |
| The microphone in that capture (MediaRecorder MIC, service typed `microphone`) stays live while an immersive app is in front. Whether it survives an app that holds the mic itself is not tested. | Verified on hardware 2026-10-01, same run | Same |
| MediaProjection on Quest captures passthrough and the Home panels, not only app content: what the user sees. The projection reports the captured content as 4128 × 2208. | Verified on hardware 2026-10-01, same run | Same |
| An on-device app can offer a real record button only by pairing wireless adb to itself, which needs developer mode. | Documented by that app | [The Ocular Migraine MCP](https://github.com/petermg/TheOcularMigraineMCP) |
| Third-party apps cannot extend the universal menu or overlay other apps; hybrid apps overlay only their own panels. | Documented | [Meta: hybrid apps overview](https://developers.meta.com/vr/documentation/spatial-sdk/hybrid-apps-overview/) |
| An Android app can open a second activity in a panel of its own beside the first, started with `FLAG_ACTIVITY_LAUNCH_ADJACENT`, `FLAG_ACTIVITY_NEW_TASK` and `FLAG_ACTIVITY_MULTIPLE_TASK`. The docs do not say where the new panel lands, or whether the app can place or size it beyond the manifest's `<layout>` defaults; the user can move and resize panels. | Verified on hardware 2026-10-03, Quest 3: Polydance Capture 0.6.0's inbox (`InboxActivity`, its own `taskAffinity` and `<layout>` of 560 x 960 dp), started from the deck with those three flags, opened as a separate panel to the right of the deck, a little apart and angled towards the user; both activities were resumed at once (each its own task in `dumpsys activity`). Screenshot checked. Where it lands when the deck has been moved is not tested | [Meta: AOSP features on Horizon OS](https://developers.meta.com/horizon/documentation/android-apps/features-overview/), [Meta: panel sizing](https://developers.meta.com/horizon/essentials/horizon-os-panel-sizing/) |
| Android notifications and Firebase Cloud Messaging are not supported (no Google Mobile Services). Meta's replacement is the Platform SDK's user notifications: sent to people entitled to the app, shown in the headset and the phone app, available to 2D apps, and reviewed before they go out; event-based ones are sent by the developer's server through `graph.oculus.com` with credentials from the developer dashboard. The pages do not say whether a notification an app posts itself with `NotificationManager` (no Google services involved) is shown; the unsupported-dependencies table lists "Android Notifications" as a Google dependency. Polydance Capture 0.9.0 posts one when its notifications are turned on, to find out. | Documented (read 2026-10-03 and 2026-10-05), not verified here |
| `POST_NOTIFICATIONS` is granted to a sideloaded app without the user deciding: Polydance Capture, which had asked for it at each record start, held it with no `USER_SET` flag, while the mic permission it asked for at the same time carried `USER_SET`. So turning on an app's notifications brings no system prompt here; the app's own switch is the opt-in. | Verified on hardware 2026-10-05, Quest 3 (UP1A.231005.007.A1), `dumpsys package net.polydance.capture` | This project | [Meta: port an existing app](https://developers.meta.com/horizon/documentation/android-apps/port-an-existing-app/), [Meta: user notifications](https://developers.meta.com/vr/documentation/unity/ps-user-notifications/) |
| A WebXR page enters VR only from a user action ("requestSession() requires a user activation"); the exception is an installed WebXR PWA, where clicking its icon counts as that action, so it can launch straight into VR. | Documented (read 2026-10-03) | [Meta: WebXR PWAs](https://developers.meta.com/vr/documentation/web/pwa-webxr/) |
| An app can open a link as a Web Task, a modal browser window with a Done button (like Chrome Custom Tabs), with `ovrweb://webtask?uri=<encoded url>`. Whether a Web Task can run an immersive WebXR session is not documented. A plain `ACTION_VIEW` of an https link has not been tried from Polydance Capture. | Documented (read 2026-10-03), not verified here | [Meta: Web Tasks](https://developers.meta.com/horizon/documentation/web/web-tasks/) |
| A link in the Quest Browser (custom scheme or `intent:`) does not open a native app, by developer reports over several years with no answer from Meta. | Community reports (read 2026-10-03), not verified here | [Meta forum: deep link from the browser](https://communityforums.atmeta.com/t5/Quest-Development/Open-application-from-Quest-web-browser-through-a-quot-android/td-p/1049168) |
| Invite-only release channels distribute builds to testers by email; all uploads must meet packaging requirements. | Documented | [Meta: release channels](https://developers.meta.com/horizon/resources/publish-release-channels/) |
| The Platform SDK's signed-in user (`Users.getLoggedInUser`) has an app-scoped ID, a display name, the Meta alias (`oculusID`), a profile picture URL and presence, and needs the Data Use Checkup's User ID and User Profile. It has **no email address**: only a Meta Managed Account (enterprise) carries more, in `managedInfo`, with consent at install and admin approval. So an app that ties people to email addresses must ask for the address itself. Polydance does, in the inbox's account sheet (2026-10-12); the receiver keeps it unverified. | Documented (read 2026-10-12), not verified here | [Meta: Users (Android)](https://developers.meta.com/horizon/reference/platform-android/v77/classcom_meta_horizon_platform_ovr_requests_users/), [Meta: User model](https://developers.meta.com/vr/reference/platform-android/v77/classcom_meta_horizon_platform_ovr_models_user) |
| On Horizon OS the `VirtualDisplay` returned by `createVirtualDisplay` does not draw into the app's `Surface`; the compositor fills it and scales into whatever size the app asked for. | Documented | Meta MediaProjection page above |
| When another app obtains a MediaProjection token, any existing session ends and the first app's callback fires. | Documented | Same page |
| adb over Wi-Fi on Quest: connect by USB once, `adb tcpip 5555`, `adb connect <ip>:5555`, unplug. TCP mode lasts until the headset reboots (standard adbd behaviour). | Verified on hardware 2026-10-01 with `npm run app -- wifi` (see below) | [Meta: adb for Quest](https://developers.meta.com/vr/documentation/spatial-sdk/ts-adb/) |
| Switching adbd to TCP drops the session's debugging authorisation: both the USB and the new Wi-Fi transport show `unauthorized`, `adb connect` blocks, and the headset shows the allow prompt again. | Verified on hardware 2026-10-01 | This project's Quest 3 |
| MQDH's "ADB over Wi-Fi" toggle uses the same port 5555 and coexists with a manual `adb tcpip`; with TCP on, the headset advertises `_adb._tcp` over mDNS (`adb mdns services`). | Verified on hardware 2026-10-01 | Same |
| Wi-Fi adb after unplugging the cable: polled every 10 s for 2 minutes, it went `offline` once about 30 s after unplugging, came back by itself within about 20 s, and then held. Commands that hit the blip fail; `probe pull` is safe to re-run. | Verified on hardware 2026-10-01, one 2-minute observation with MQDH's toggle on | This project's Quest 3 |
| When the headset sleeps, Wi-Fi adb goes `offline`, the headset stops answering `adb connect` (it times out) and stops advertising over mDNS. After waking, `adb connect <ip>:5555` works again without USB: TCP mode survived the sleep. | Verified on hardware 2026-10-01, once (`probe install --connect` after the sleep) | This project's Quest 3 |
| Wi-Fi adb dropping after about a minute on recent builds. | Community report; not what happened in the 2-minute observation above | [Meta forum: ADB over Wi-Fi is broken](https://communityforums.atmeta.com/discussions/dev-quest/adb-over-wi-fi-is-broken/1293637) |
| In-app audio is capturable with AudioPlaybackCapture on the projection token when the playing app uses `USAGE_MEDIA`, `USAGE_GAME` or `USAGE_UNKNOWN` and allows capture; apps targeting API 29+ allow it unless they opt out. Needs RECORD_AUDIO. Meta names AudioPlaybackCapture as the way to get "the device audio" on Quest. | Documented | [Android: capture audio playback](https://developer.android.com/media/platform/av-capture), Meta MediaProjection page above |
| An immersive music app (version 1.8.3) on this Quest targets SDK 34 and has the `ALLOW_AUDIO_PLAYBACK_CAPTURE` flag. | Verified on hardware 2026-10-01 with `dumpsys package` | This project's Quest 3 |
| The mic and in-app audio can be captured at the same time, as two AudioRecords (MIC and AudioPlaybackCapture), while an immersive app is in front. | Verified on hardware 2026-10-01, one 80 s run with an immersive music app | [Probe results](../app/README.md#results); Android docs are silent |
| Surface frames from the Quest compositor carry `System.nanoTime` timestamps (36 ms from the time they were drained), so video and AudioRecord audio share one clock. | Verified on hardware 2026-10-01, same run | Same |
| MP4 files written by MediaMuxer mark every track default, so ffmpeg's automatic audio pick takes the stereo app track; tools must map the mic track explicitly. | Verified on hardware 2026-10-01 with ffprobe on the run's file | Same |
| With the encoder capped at 30 fps the capture runs 30 fps at Home and 24 fps inside the music app, consistent with the compositor at 90 Hz and 72 Hz. | Measured 2026-10-01; the refresh rates are inferred | Same |
| Asked for 1920 × 1080 at 8 Mbit/s, the Quest 3's H.264 encoder (High profile) wrote 9.3 to 9.9 Mbit/s at 29.9 to 30.0 fps. | Measured 2026-11-18 with ffprobe on five takes of Polydance 0.21.0 from 2026-11-17 and 18 | This project's library |
| Meta's own recorder, for comparison: the headset's Camera app is recommended at 1920 × 1080 (or 1080 × 1920), 36 fps variable, 20 Mbit/s; Developer Hub records from 1024 × 1024 at 36 fps and 5 Mbit/s (its default) up to 2160p at 60 fps and 40 Mbit/s, three minutes at most; adb's `debug.oculus.capture.*` defaults are 1024 × 1024 and 5 Mbit/s, at half the refresh rate unless `debug.oculus.fullRateCapture` is 1. None of it applies to an app's own MediaProjection capture, which records what the app asks its encoder for. | Documented (read 2026-11-18) | [Meta: capture for publishing](https://developers.meta.com/horizon/resources/video-capture-mr-vr/) (2025-06-27), [Meta: Developer Hub media](https://developers.meta.com/horizon/documentation/unity/ts-odh-media/) (2026-11-05), [Meta: system properties](https://developers.meta.com/horizon/documentation/native/android/ts-systemproperties/) |
| MediaMuxer writes several audio tracks into one MP4 from Android 8 (API 26). | Documented | [Android: MediaRecorder overview](https://developer.android.com/media/platform/mediarecorder) |
| Plugged in by USB, a Quest offers its files over MTP after one accept prompt, without developer mode. macOS needs a helper. | Common knowledge, not verified here | Meta help |

### Hardware spikes before any companion app is promised

Spikes 1 and 2 have a probe app for Quest 3 in [app](../app/README.md).
Three runs on 2026-10-01: spike 1 **yes** each time; spike 2 partly (the mic stayed live with the music app
in front, but it was not holding the mic); and in-app audio records on its own track alongside
the mic. Details and what is still open are in that README's results.

1. Does a `mediaProjection` foreground service keep capturing after launching an immersive app?
2. Does the microphone stay live in that capture while the app under test uses voice? Android can
   silence a background capturer when the foreground app holds the mic.
3. Do native recordings appear through the media store, and does a content-trigger job fire on a new one?
4. Can the Camera app be opened by intent from another app?

## This project's Meta Quest 3 (observed 2026-10-01)

Verified over adb, USB and Wi-Fi:

- `ro.product.manufacturer` Oculus, `ro.product.model` Quest 3, adb model `Quest_3`, product `eureka`.
- Android 14, SDK 34, `ro.build.display.id` UP1A.231005.007.A1, `ro.build.version.incremental`
  52433670048800520. The Horizon OS version number is not in an obvious property; read it from
  Settings → General → About when it matters.
- `debug.oculus.command_line_media_capture` is `true`.
- The capture probe installed over Wi-Fi in about 5 s with `npm run app -- install`.

- Uploading from the capture app over home Wi-Fi to this Mac: 82.5 MB in about 6 s (8 MB chunks,
  one request each). `uiautomator dump` fails on the probe's screen ("could not get idle state")
  because its clock redraws every 100 ms.

## Google Android XR Puck (observed 2026-10-01)

Verified over adb on the device at `192.168.1.104:41735`:

- `ro.product.manufacturer` Google, `ro.product.model` Android XR Puck, Android 14, SDK 34.
- The app under test installed from its own release APK.
- No `.mp4`, `.webm` or `.mkv` anywhere under `/sdcard`; `/sdcard/Movies`, `DCIM`, `Pictures`,
  `Recordings` and `Download` are empty apart from thumbnail folders. The recording folder is therefore
  unknown and the profile in `src/devices.ts` is a guess.
- `screenrecord` exists but captures no audio, so it cannot replace a native recorder with narration.
- The device advertises `_adb-tls-connect._tcp` over mDNS and is reachable wirelessly without a cable.
- Toybox `stat -c '%s %Y %n'`, `find`, `md5sum` and `sha256sum` are all present, which is what the
  pull step relies on.

To confirm the folder: make one screen recording with whatever the puck offers, then
`adb shell find /sdcard -name '*.mp4' -mmin -60`, and set `POLYCAP_DEVICE_FOLDERS`.

## Android XR / XREAL AURA port (2026-10-09)

The new `androidXr` flavor is a **2D compatible Android app** with the shared recorder/UI/uploads,
not an immersive app or an NRSDK/Beam Pro port. [Architecture and test plan](../app/PLATFORMS.md).
The earlier Google puck observation does not identify every AURA firmware. Installation and launch were verified on Robin’s AURA at 23:57 on 2026-10-09 (details below);
the following capture/interaction claims remain unverified on AURA.

| Claim | Status | Source |
| --- | --- | --- |
| Existing Android mobile/large-screen apps run as 2D panels on Android XR headsets and wired glasses; an unchanged 2D app needs no OpenXR/spatial feature declaration or hand-tracking permission for basic interaction. | Official documentation read 2026-10-09; this build uses ordinary Android views, resizable activities and optional touchscreen, with no XR SDK or speculative permissions. Not tested on AURA. | [2D app readiness](https://developer.android.com/develop/xr/check-mobile-app-readiness), [XR permissions](https://developer.android.com/develop/xr/permissions) |
| Android XR's enterprise guide explicitly supports MediaProjection screen casting and recommends capture resolution no higher than 2880×2880. | Documented; casting guidance is not proof of companion-app recording behavior on this development device. Existing presets (largest 1920×1080) stay below it. | [Android Enterprise for XR](https://developers.google.com/android/work/xr-management) |
| On Android 14+, default-display configuration requests display rather than single-app capture. Fresh consent, a typed foreground service, a registered stop callback and one VirtualDisplay per token remain required. | Documented; shared implementation retained. Whole default display is not a documented guarantee of all XR compositor layers, both eyes or other immersive apps. | [MediaProjection](https://developer.android.com/media/grow/media-projection), [foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types) |
| AURA is optical see-through glasses with a compute puck; what the wearer sees through the lenses is not necessarily framebuffer/camera content available to projection. | Device design documented; physical-world inclusion is not promised or tested. Quest passthrough recordings do not establish this capability on AURA. | [XREAL Project Aura](https://www.xreal.com/us/blog/aura-25-tas-release-en) |
| Playback capture needs source-app policy, permitted usage and the same user profile; background microphone input can be silenced by a competing ordinary app. | Android rules documented; simultaneous video + mic + playback tracks remain untested on AURA. A foreground service does not bypass these restrictions. | [Playback capture](https://developer.android.com/media/platform/av-capture), [microphone sharing](https://developer.android.com/media/platform/sharing-audio-input) |
| Standard wireless debugging uses TLS pairing and distinct, dynamically assigned pairing/connection ports. | Documented and consistent with the earlier puck's `_adb-tls-connect._tcp` observation; no AURA reconnection exercised today. CLI requires an explicit Android XR connect port and never runs Quest's `tcpip` flow for it. | [ADB](https://developer.android.com/tools/adb), [AOSP Wi-Fi architecture](https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/docs/dev/adb_wifi.md) |
| Android free-form window layouts and adjacent launch flags exist; AURA-specific panel placement/task behavior is not established. | Documented Android API, not AURA hardware evidence. Quest keeps adjacent tasks; Android XR begins with same-task inbox navigation and explicit thread reply. Current panel layout dimensions are requests, not output-video sizes. | [Multi-window](https://developer.android.com/develop/ui/compose/layouts/adaptive/support-multi-window-mode), [manifest layout](https://developer.android.com/guide/topics/manifest/layout-element) |

**Validation distinction:** compileSdk 35 / targetSdk 34 / minSdk 30 are unchanged, so the observed
API-34 development puck remains eligible for installation. This says nothing about the current Play
submission track or production AURA firmware. The generated Android XR manifest must contain no
Oculus permission/browser package; `python3 app/tools/verify-manifests.py` checks both merged flavors,
service typing, navigation affinity, version/output identity and source-boundary leakage.

**Local verification 2026-10-09:** both debug/release flavors built and passed lint (0 errors,
8 existing warnings each); 14 JVM tests per flavor, 509 TypeScript tests, source/merged-manifest checks
and all APK signatures passed. Android XR APK badging is `0.14.0-androidxr` (14), min SDK 30,
target SDK 34. `adb devices -l` and mDNS list no device; install attempt stopped with exit 2 before
any device change. No AURA capture, Quest regression run or real receiver upload exercised.

**Device follow-up 2026-10-09 23:57 BST:** wireless ADB connection and guarded Android XR install/launch
succeeded on Robin’s AURA, which identifies as `Google Android XR Puck`, Android 14/API 34, firmware
`axros-userdebug 14 UXP4.260907.001.A4 16315093 test-keys`. Installed `0.14.0-androidxr` (14), APK source
commit `213fd15`; package metadata, running process and resumed/focused MainActivity verified, crash
buffer empty. This clears the earlier connection blocker only. No agent-initiated recording, visual
UI acceptance, cross-app/audio capture, receiver configuration or upload was performed.

## 3D models in shared space (2026-10-19)

Robin asked for 3D models that open, turn and scale in shared space without an immersive mode, on Quest
first and every headset later. Read 2026-10-19; none of it is verified on hardware yet.

| Claim | Status | Source |
| --- | --- | --- |
| No Meta page describes a way for a third-party app to show a 3D model in Home beside other apps' panels. The route to 3D is Meta Spatial SDK, whose immersive activities are OpenXR activities; an immersive app can show its own panels ("both panel and immersive activities for the same app can be simultaneously visible"), and Home is where the user lands on "exiting an immersive app". | Documented (hybrid apps page updated 2026-09-22); that Home and other apps' panels are hidden during an immersive app is inference | [Meta: hybrid apps](https://developers.meta.com/horizon/documentation/spatial-sdk/hybrid-apps-overview/), [Spatial SDK release notes](https://developers.meta.com/horizon/release-notes/spatial-sdk/) |
| Spatial SDK 0.13.0's Canvas Panel API (`StereoCanvasPanelRegistration`, `drawStereo(depthOffsetMeters)`) draws flat or depth-offset stereo layers into a Spatial SDK panel; it does not render a mesh, and nothing says it works outside an immersive activity. | Documented (0.13.0 notes, 2026-05-14); the second half is inference | [Spatial SDK 0.13.0](https://developers.meta.com/vr/downloads/package/meta-spatial-sdk/0.13.0?view=full_width) |
| Android XR shows 3D models only in Full Space: Home Space "does not support spatial panels, 3D models, or an app's spatial environments", and in Full Space "All other apps are hidden." Scene Viewer, Google's model viewer, "runs in Full Space Mode" and "your app will no longer be visible". | Documented (pages updated 2026-01-16 to 2026-10-05) | [Android XR foundations](https://developer.android.com/design/ui/xr/guides/foundations), [Add 3D models](https://developer.android.com/develop/xr/jetpack-xr-sdk/add-3d-models), [Home Space and Full Space](https://developer.android.com/develop/xr/jetpack-xr-sdk/transition-home-space-to-full-space) |
| The Quest store's model viewers are immersive: Glimpse GLB switches "between a dedicated Virtual Reality environment and Mixed Reality (Passthrough)" and loads models from the headset's storage. Modelspace VR and Model Viewer (SideQuest) are described in search results as room-scale or passthrough viewers reading from the Download folder; their listings did not render for reading. None says another app can hand it a file, and "the Horizon OS share sheet cannot be launched by third-party apps". | Documented for Glimpse GLB and the share sheet; the SideQuest two from search summaries only | [Glimpse GLB](https://www.meta.com/experiences/glimpse-glb/25467602739525995/), [Meta: AOSP features](https://developers.meta.com/horizon/documentation/android-apps/features-overview/) |
| Meta's pages for 2D apps (AOSP features, porting, Look and Pinch) do not mention Android WebView or WebGL in a panel. A 2D app's WebView does render WebGL on Quest: Polydance 0.16.0 (23)'s viewer drew `<model-viewer>`'s cube in its own panel, turned and zoomed, and the recording captured it. | Not documented; **verified on hardware 2026-10-20**, Quest 3, one 45 s recording (CAP-10 #3, recorded 2026-10-20 14:59) | Same pages, read 2026-10-19 |
| Google's `<model-viewer>` draws a glTF model on an ordinary page with no WebXR ("only needed if you wish to use webxr in ar-modes"), with drag to orbit, zoom, animations, Draco and KTX2; Apache 2.0, v4.4.0 released 2026-10-09. | Documented; 4.3.1 checked in desktop Chromium on 2026-10-19 (loads, turns, zooms, resets, refuses a broken file) | [modelviewer.dev](https://modelviewer.dev/), [releases](https://github.com/google/model-viewer/releases) |

So a model opens in a panel of Polydance's own, drawn by model-viewer in a WebView: flat, in shared space,
beside the deck and the inbox, and captured by the recording like any panel. A model you can walk around
needs an immersive activity (Quest) or Full Space (Android XR), which hides other apps' panels.

## Panel sizing (2026-10-20)

For the one-panel layout (deck, threads and the open thread side by side). Read 2026-10-20; not checked on
hardware.

| Claim | Status | Source |
| --- | --- | --- |
| Panels open at 1024 × 640 dp by default, at least 384 × 500 dp and at most 1440 × 1000 dp; Meta asks for testing at all three. Users resize panels ("your layout should adapt without breaking"). | Documented (Layouts and Panels pages, updated 2026-04-19 and 2026-03-02) | [Meta: layouts](https://developers.meta.com/horizon/design/styles_layouts/), [Meta: panels](https://developers.meta.com/horizon/design/panels/), [Meta: panel sizing](https://developers.meta.com/horizon/essentials/horizon-os-panel-sizing/) |
| The `<layout>` element's defaultWidth and defaultHeight set the launch size; minWidth and minHeight are described as an optional floor (example 360 × 225 dp), with nothing on whether they are enforced. Nothing says whether a resize recreates the activity. | Documented (porting guide updated 2026-09-14); enforcement not documented | [Meta: port an existing app](https://developers.meta.com/horizon/resources/migrate-2d-app/) |
| Hit targets at least 48 × 48 dp, primary controls 60 × 60 dp; text at least 14 px, 18 px or more for comfortable reading. Nothing on multi-column or list-detail layouts in one panel. | Documented (updated 2026-04-19) | [Meta: hit targets](https://developers.meta.com/horizon/design/styles_inputs_hit_targets/), [Meta: typography](https://developers.meta.com/horizon/design/styles_typography/) |

## The immersive scene (2026-10-20 and 21)

The research for Robin's immersive scene (CAP-10) has its own note, with sources and status for each claim:
[IMMERSIVE-VIEWER-RESEARCH.md](IMMERSIVE-VIEWER-RESEARCH.md).
- **Quest:** Meta Spatial SDK, and Meta's cooperative mode for keeping Polydance's panel over the scene.
- **Android XR:** SceneCore in Full Space later, after a compileSdk 36 move.
- **Ruled out:** WebXR in WebView and Scene Viewer.

None of it has been tried on a headset.

## "Insecure HostnameVerifier" in the Quest APK (2026-11-19)

Robin passed on a scanner's warning on 0.22.0 (29), Meta build 1380571095150567: "Insecure HostnameVerifier in
your app. The application code defines a custom HostnameVerifier or 'X509HostnameVerifier' that may not sufficiently
validate the hostnames." It is a false positive for Polydance's own connections, and not ours to change.

| Claim | Status | Source |
| --- | --- | --- |
| Polydance's own source defines no HostnameVerifier, TrustManager or OkHttp client; its uploads and the receiver API don't use OkHttp | Checked in the source, 2026-11-19 | `grep` over `app/android/app/src`; no `okhttp3` import |
| The Quest APK carries OkHttp 4.9.1 because Meta Spatial SDK 0.14.0 brings it, for `com.meta.spatial.okhttp3.OkHttpAssetFetcher`. The Android XR APK has no Spatial SDK | Checked in the APK, 2026-11-19 | `dexdump` of `polydance-quest-release-0.22.0-29.apk`: 330 `okhttp3` classes, the version string `okhttp/4.9.1`, and the only caller outside OkHttp is in `com.meta.spatial` |
| The two classes a scanner sees are `okhttp3.internal.tls.OkHostnameVerifier`, OkHttp's real check, and `ConscryptPlatform$DisabledHostnameVerifier`, whose `verify` returns true | Checked in the APK, 2026-11-19 | `dexdump -d`: both `verify` methods are `const/4 v0, 1; return v0` |
| The always-true verifier is given only to Conscrypt (`Conscrypt.setHostnameVerifier`), so Conscrypt skips its own check during the handshake; OkHttp's `RealConnection.connectTls` then calls the client's `HostnameVerifier.verify` itself | Checked in the APK, 2026-11-19 | `dexdump -d`: `ConscryptPlatform.newSslSocketFactory` passes `DisabledHostnameVerifier.INSTANCE` to `Conscrypt.setHostnameVerifier`; `connectTls` invokes `HostnameVerifier.verify` |

What can be done, if Meta's review ever refuses on it: explain the above. Shrinking with R8 (`isMinifyEnabled` is false)
would not remove it, because OkHttp's platform detection reaches `ConscryptPlatform` directly. Excluding OkHttp from
the Spatial SDK would break its asset fetcher at run time and would need the immersive scene tried on a Quest. Whether
the warning blocks anything was not known on 2026-11-19.

## This Mac (observed 2026-10-01)

- **Wi-Fi adb fails with "No route to host" when the adb server was started from the agent's shell**
  (macOS 15.8, 2026-10-04). With the Quest awake on the same subnet (192.168.1.196, this Mac
  192.168.1.179) and its adbd listening on 5555 (`/proc/net/tcp6`), `ping` and Apple's `/usr/bin/nc`
  reached it, but `adb connect` and a Node socket got EHOSTUNREACH, although the Claude app has Local
  Network access in Privacy & Security (Robin's screenshot). The adb server had been restarted from the
  agent's shell that morning. After `adb kill-server`, another app started a new server within 5 s
  (most likely Meta Quest Developer Hub, which was running and polls for devices), and `adb connect
  192.168.1.196:5555` then worked. So do not restart the adb server from an agent session; if Wi-Fi adb
  says "No route to host", kill the server and let Meta Quest Developer Hub or Terminal start it.
  `npm run app` now says so. Wi-Fi adb on 2026-10-01 and 02 went through a server MQDH had started.
- ffmpeg 8.0's automatic audio pick prefers a track marked default, then the most channels. In a file
  where every audio track is default it takes the stereo track over a mono narration track, so polycap
  maps `0:a:0` explicitly (reproduced in `tests/pipeline.test.ts`).

- Node 22.22.0, npm 10.9.4. npm's peer resolver crashed on this dependency set, so `.npmrc` pins
  `legacy-peer-deps=true` and vite is an explicit dev dependency for vitest.
- ffmpeg 8.0 with `scale`, `select`, `showinfo`, `tile` and `drawtext` filters; libx264 and aac encoders.
- adb at `/opt/homebrew/bin/adb`.
- whisper.cpp not installed; Homebrew has `whisper-cpp` 1.9.4. Models are downloaded separately. Installed since, with
  `ggml-large-v3-turbo.bin` in `~/PolydanceCapture/models` (seen 2026-11-05).

## Vercel preview links

What a launch's `open` link looks like when it is a Vercel preview, and what the receiver's host
patterns can know from it ([THREADS.md](THREADS.md#safety)). Read and checked 2026-10-05.

| Claim | Status | Source |
| --- | --- | --- |
| A deployment's own link is `<project-name>-<unique-hash>-<scope-slug>.vercel.app`, the hash "9 randomly generated numbers and letters"; a branch link is `<project-name>-git-<branch-name>-<scope-slug>.vercel.app`; a project also has `<project-name>-<scope-slug>.vercel.app` (production, once deployed there) and, in a team, `<project-name>-<author-name>-<scope-slug>.vercel.app`. A label over 63 characters is cut short. | Documented, and seen on the yourteam team through the Vercel API on 2026-10-05: marimba-demo's five newest deployments all had nine lowercase letters and digits as their hash; the production one also had `marimba-demo-yourteam.vercel.app` and `marimba-demo.vercel.app`; its previews, built by CI from merge commits (ref `HEAD`), had no other link, so a launch can only use the deployment link | [Vercel: generated URLs](https://vercel.com/docs/deployments/generated-urls) |
| Team and account slugs may contain hyphens, so a host does not say where the project name ends and the team begins: `marimba-demo-abcdefghi-yourteam` is a yourteam deployment or the production link of a team named `abcdefghi-yourteam`. | Documented (the REST API's own example renames a team from `my-team-url-slug` to `my-team`); the account that creates yourteam' deployments is `robin-blocks` | [Vercel: update a team](https://vercel.com/docs/rest-api/sdk/teams/update-a-team) |
| A Preview Deployment Suffix puts preview links on a domain the team owns in place of `vercel.app`; the domain must be active in the team and use Vercel's nameservers or delegate certificate validation to Vercel. Pro (an add-on) and Enterprise only. | Documented (read 2026-10-05), not tried | [Vercel: Preview Deployment Suffix](https://vercel.com/docs/deployments/preview-deployment-suffix) |


## Private Quest store candidate (2026-10-08; off-device only)

The native panel recorder is being prepared for app `1300818073125870` (since 2026-10-12; first prepared
for `1593561244982561`, made under the wrong team and since removed), with eventual Free pricing
and a private channel first. The verified SDK 77.0.1 APIs cover entitlement, logged-in user and proof.
Meta's current [manifest guidance](https://developers.meta.com/horizon/resources/publish-mobile-manifest/)
allows 2D apps to omit the VR headtracking feature and recommends targetSdk 34. This candidate uses
minSdk 30, targetSdk 34, arm64-v8a and Quest 3/3S metadata. `PACKAGE_USAGE_STATS` is debug-only, not
in the release APK. Its launch icon is the existing Polydance mark.

[Entitlement](https://developers.meta.com/horizon/documentation/native/ps-entitlement-check/)
is app ownership, not proof of current channel membership. Channel removal is documented to stop
updates, so receiver revocation uses a local blocklist as well. See `private/docs/STORE.md` for sources,
DUC User ID/Profile prerequisites and no-ADB acceptance steps.

Android lint reports the SDK's `libovrplatformloader.so` lacks 16-KB alignment (two report locations).
This has not been suppressed or represented as resolved. Meta upload validation and actual supported
headset compatibility must still be checked; these local guards do not certify every store rule.
The original v2 signature was valid: build-tools 37's changed signer output caused the false failure.
Neither the original candidate nor the recovered source has been installed through Meta channels.

## The launcher icon (2026-11-11)

Since 2026-11-11 the headsets' launcher icon is an adaptive icon drawn by `design/icons.py` in the Mac dock icon's
style ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md#one-app-icon)); until then it was the bare mark, a bitmap.

| Claim | Status | Source |
| --- | --- | --- |
| An adaptive icon is a background and a foreground layer of 108 × 108 dp, and optionally a monochrome one. The device's mask decides the shape (a circle on one, a squircle on another) and never clips the inner 66 × 66 dp; the outer 18 dp each side are for the mask and effects such as parallax. The logo should be 48 to 66 dp. From Android 13, launchers that theme icons tint the monochrome layer. | Documented (read 2026-11-11). Not seen on a headset: how Horizon OS's library and Android XR's launcher draw it is unchecked until a build with it is installed | [Android: Adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive) |

The same guide asks for layers without shadows around the icon's outline. The foreground keeps the Mac icon's faint
glow of the dancer's own orange, because that glow is part of the style Robin asked for on every platform.

## macOS screen, audio and call detection (researched 2026-11-05)

For [MAC.md](MAC.md). Researched on 2026-11-05. "This Mac" means a probe run that day on Robin's Mac
(macOS 15.8, 24H16, Chrome 156) by an unsigned command-line tool, not a shipped app; nothing was tried
during a live call. The current macOS is 27 ("Golden Gate", 27.2 on 2026-10-26); 26 and 15 still get
patches ([Apple security releases](https://support.apple.com/en-us/100100)).

| Claim | Status | Source |
| --- | --- | --- |
| Sequoia 15.0 asks an app that records the screen to re-approve about monthly ("Allow For One Month"); early betas asked weekly. 15.1 promised "fewer dialogs" for apps used regularly, with the rule unpublished, and added the MDM key `forceBypassScreenCaptureAlert` for managed Macs. No change found in 26 or 27 notes. | Documented in part (15.1 notes); cadence reported by third parties; 26 and 27 unverified | [9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/), [15.1 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15_1-release-notes) |
| The re-approval holds a stream's start for as long as the prompt is open. 2026-11-13, 15:47:31 at a Meet call's start: replayd's `SCAlertStatsManager` logged `requireAlertWithCanonicalBundleID` and set the app's last-alerted date, logged nothing for 5.4 s, then started the stream (5.9 s after the request). That call was audio only until the Mac app kept a late start (MAC.md C11). The same build had started in time that morning. | Seen on this Mac (`/usr/bin/log`, 2026-11-13); that a dialog was on screen is inferred, not in the log | `/usr/bin/log show` for replayd, 2026-11-13 15:47:30 to 15:47:37 |
| The prompt comes with ScreenCaptureKit's programmatic capture (`SCShareableContent` with `SCContentFilter`), not only the deprecated APIs. The ways out are the persistent-content-capture entitlement ("specifically intended for screen sharing products", granted on request, documented for VNC apps) or `SCContentSharingPicker`. | Apple engineer on the forums; entitlement documented | [Forum thread 765103](https://developer.apple.com/forums/thread/765103), [entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture) |
| `SCContentSharingPicker` reportedly needs no Screen Recording permission, but has no API to save or restore a choice: one user action per recording. | Third party (permission); persistence from Apple's forum answer and WWDC23 10136 | [Nonstrict](https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma/), [WWDC23 10136](https://developer.apple.com/videos/play/wwdc2023/10136/) |
| Core Audio process taps (`AudioHardwareCreateProcessTap`, macOS 14.2 in the SDK header) need `NSAudioCaptureUsageDescription`; the prompt appears when an aggregate device holding a tap first starts. The Settings pane is "Screen & System Audio Recording", where an app can be allowed "just your audio". | Documented | [Capturing system audio with taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps), [Mac help](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac) |
| There is no public way to check the audio-capture grant; a refused tap delivers silence with `noErr`. | Third party, consistent reports | [AudioCap](https://github.com/insidegui/AudioCap), [forum thread 771864](https://developer.apple.com/forums/thread/771864) |
| Whether an audio-only tap is ever re-asked like the screen prompt. | Not verified | — |
| A tap targets processes by Core Audio object id (`kAudioHardwarePropertyTranslatePIDToProcessObject`); macOS 26 adds `bundleIDs` and re-attaching when the process restarts. | Documented | [CATapDescription.bundleIDs](https://developer.apple.com/documentation/coreaudio/catapdescription/bundleids) |
| Chrome's sound is in its audio-service helper ("Google Chrome Helper (Aperitif)", `--utility-sub-type=audio.mojom.AudioService`), not the main process, and serves every tab; Safari's is `com.apple.WebKit.GPU`. A tap on the helper hears all of Chrome's tabs. | Seen on this Mac (process list only; no tap during a call) | probe, 2026-11-05 |
| ScreenCaptureKit can capture the microphone itself on macOS 15+ (`captureMicrophone`, `SCStreamOutputTypeMicrophone`), with the ordinary Microphone permission. macOS 27's recording output mixes mic and system sound into one track unless `mixesAudioWithMicrophone` is NO; before 27 the app writes the tracks itself. | Documented (SDK headers; 27 from a mirror of Apple's headers) | `SCStream.h`; [dotnet/macios diff](https://github.com/dotnet/macios/wiki/ScreenCaptureKit-macOS-xcode27.0-b1) |
| Recording the mic does not conflict with Meet or Zoom using it; only hog mode is exclusive. Voice processing on macOS 14+ lowers other apps' sound by default, so a recorder should not turn it on. | Documented (header, WWDC23 10235) | [WWDC23 10235](https://developer.apple.com/videos/play/wwdc2023/10235/) |
| Without headphones the raw mic holds the far end; Meet and Zoom cancel echo only in what they send. Granola keeps mic as "Me" and system sound as "Them"; RecordKit runs WebRTC AEC3 with the system sound as reference. | Third party | [Granola](https://granola.ai/blog/how-to-use-granola-with-zoom), [RecordKit](https://nonstrict.eu/recordkit/guides/echo-cancellation.html) |
| Which processes use the microphone, by pid and bundle id, can be read from `kAudioHardwarePropertyProcessObjectList` with `kAudioProcessPropertyIsRunningInput`, with no permission and no prompt. | Documented (`AudioHardware.h`); **seen on this Mac**: an unsigned tool read all 44 process objects without a prompt | probe, 2026-11-05; [forum thread 798884](https://developer.apple.com/forums/thread/798884) |
| `kAudioDevicePropertyDeviceIsRunningSomewhere` is per device, and is reported as always inactive for Bluetooth microphones. There is no public per-process camera API. | Forum reports; header | [Forum thread 741026](https://developer.apple.com/forums/thread/741026), [OverSight](https://objective-see.org/products/oversight.html) |
| Which process shows microphone input while a Meet call is live in Chrome, and whether the per-process property holds for Bluetooth microphones. | Not verified; spike MA | — |
| Browser tab URLs through Apple Events need `NSAppleEventsUsageDescription`, one consent per browser and the hardened-runtime entitlement `com.apple.security.automation.apple-events`; Chrome, Arc, Brave, Edge and Safari are scriptable, Firefox is not. A sandboxed app needs a temporary exception App Review "rarely approves". | Documented; Firefox from third parties | [Forum thread 823455](https://developer.apple.com/forums/thread/823455) |
| Chromium exposes the active tab's URL as the window's `AXDocument` since January 2025, through Accessibility permission (unsupported in the sandbox). | Chromium source; not tried | [Chromium commit](https://chromium.googlesource.com/chromium/src/+/ea32bec275a1e3df6fca29caa29353529be1f8bc) |
| Without Screen Recording permission, other apps' window titles are hidden: 0 of 36 windows had a title, owner names were present. Which fields are gated is undocumented and changed in a 27 beta. | **Seen on this Mac**; Apple forum | probe, 2026-11-05; [forum thread 839069](https://developer.apple.com/forums/thread/839069) |
| A browser extension with a native-messaging host knows the exact URL and page state with no macOS permission, but installs per browser, and Safari needs its own Safari Web Extension. | Documented (Google) | [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) |
| `SMAppService` (13+) registers a login item or agent; no Apple document says capture needs the app in front. Every capture shows in the menu bar's Video item and as a purple dot, with no supported way to hide either. | Documented (indicators); frontmost unverified | [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice), [Control Center help](https://support.apple.com/guide/mac-help/control-center-mchl50f94f8f/mac) |
| The App Store requires the sandbox, consent before launching at login (2.4.5), and "explicit user consent and… a clear visual and/or audible indication when recording" (2.5.14). With Apple Events to browsers and Accessibility effectively closed to sandboxed apps, Developer ID with notarisation is the route. | Documented (guidelines of 2026-10-16); the route is a conclusion | [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) |
| Arc 1.171.0 is scriptable: `Arc.sdef` has windows and spaces, each holding tabs with `title` and `URL`. Its sound runs in `Browser Helper --utility-sub-type=audio.mojom.AudioService`, bundle id `company.thebrowser.browser.helper`, beside the main `company.thebrowser.Browser`. | **Seen on this Mac** (the dictionary file and Core Audio's process list, 2026-11-05; the script's first answer from Arc, 2026-11-06, in the rows below) | `/Applications/Arc.app/Contents/Resources/Arc.sdef`, probe, 2026-11-05 |
| whisper.cpp with `ggml-large-v3-turbo.bin` transcribed 115 s of synthetic speech (macOS `say`, 16 kHz mono) in 16.0 s wall, 1.5 s user CPU, on this M3 Pro (18 GB): about 7× real time, on the GPU. Real call audio is harder than synthetic speech. | **Measured on this Mac**, 2026-11-05 | `whisper-cli -l en -t 4`, scratchpad |
| Granola can post a chat message automatically when it starts and watermark the user's own video; Krisp's bot plays a notice, its bot-free recording reportedly tells no one. | Vendor and third party | [Granola](https://www.granola.ai/blog/why-granola-doesnt-use-a-bot), [Krisp](https://krisp.launchnotes.io/announcements/ann_CUiEGnbhwQ5YU) |
| AVAssetWriter closes up a gap in an audio track's timestamps: 3 s missing between buffers gave a track of 4 s for 7 s of clock. The app fills such gaps with silence. | **Seen on this Mac**, synthetic PCM in XCTest, no tap or mic | `WriterTests`, 2026-11-05 |
| AAC through AVAssetWriter at the tap's own rate crashed (an uncaught exception) at 88.2 and 96 kHz and failed at 16 to 24 kHz; 44.1 or 48 kHz at 160 kbps, the writer resampling, encoded every rate from 16 to 96 kHz. | **Seen on this Mac**, synthetic PCM | `WriterTests`, review of 2026-11-05 |
| A tap's IO buffer list holds the aggregate's clock-device input buffers first and the tap's last. Apple does not document the order. To check: an output device with inputs (the Scarlett) as system output, a tone in Arc, and see which buffer carries it. | Not verified; the app assumes it and checks only the counts and channels | `ProcessTapSource.swift` |
| `kAudioProcessPropertyDevices` (input scope), a device's stream configuration and `kAudioDevicePropertyDeviceIsAlive` are readable with no prompt. | **Seen on this Mac** by a read-only probe, with no process running input, so Arc's device during a call was not read | probe, 2026-11-05 |
| An app bundle whose binary is started from a terminal has its grants attributed to the terminal, so `./build.sh probe` launches the app through LaunchServices (`open`). | Seen by the review on this Mac; not rechecked | review of 2026-11-05 |
| A Foundation `Process` child leads its own process group (pgid equals its pid), and `terminate()` reached a grandchild that `kill(pid, SIGTERM)` did not. | **Seen on this Mac**, a scratch program; not documented | 2026-11-05 |
| When the menu bar has no room right of the notch, macOS hides the menu-bar items that do not fit, newest first, and tells the app nothing. The item's window stays in the window list at level 25 with `kCGWindowIsOnscreen` false, readable with no permission (bounds and owner, not names); other apps' drawn items are on screen. Five apps' items were hidden on this MacBook Pro, Polydance Capture's among them. | **Seen on this Mac** (macOS 15.8, 1512-point display, notch from 663 to 848) | window list, 2026-11-05 |
| `open` on an app that is already running sends it a reopen event (`applicationShouldHandleReopen`), also for an `LSUIElement` app; SwiftUI's `openWindow` taken from a `MenuBarExtra` label works while the item is hidden. | **Seen on this Mac** (the app and a scratch app) | 2026-11-05 |
| In a `NavigationSplitView`, text with `.fixedSize(horizontal: false, vertical: true)` outside a scroll view sets the window content's minimum height from its height at the split view's narrowest: a two-line banner made the content 3,795 points tall in an 800-point window. | **Seen on this Mac**, reproduced in XCTest | `MainWindowLayoutTests`, 2026-11-05 |
| Google Meet answers `https://meet.google.com/<code>` with a server redirect to `https://meet.google.com/meet/<code>?authuser=0`, and the tab stays on that address for the whole call. The short form alone missed the first real call. | **Seen on this Mac** (Arc's history, Profile 1: visit 1145 typed `meet.google.com/<code>?authuser=0`, visit 1146 a server redirect to `/meet/<code>?authuser=0`, both 10:01:10; the same form on three visits on 2026-11-04) | Arc `History` read with `immutable=1`, 2026-11-06 |
| During a real Arc Meet call of 44 minutes, the app's capture wrote the microphone and Arc's sound as two separate tracks in one mp4 (mic mean -29.8 dB, Arc's -21.3 dB), the tap heard the far end rather than silence, and Arc letting go of the microphone after the call stopped the recording about 20 s after leaving (the frames show Meet's goodbye page from 43:48, the recording ends at 44:09). | **Seen on this Mac**, 2026-11-11, from the recording and its bundle (not from the app's own logs) | a call recorded 2026-11-11 13:03, `ffmpeg volumedetect` per track |
| Meet shows who is talking in the recorded picture: the speaking tile has a light ring and a sound badge in its top corner, and every tile carries its person's name at the bottom left, which macOS Vision (`VNRecognizeTextRequest`, accurate, on the Mac) read correctly for all three tiles of a 1920x1080 frame in which the call's window was about 1,100 px wide. During a screen share the tiles move to a side strip, longer names are cut short with an ellipsis and the badge still shows; the presenter's own tile says "(You, presenting)". Seen for one call's layouts only; Meet's look can change. Over the whole 44-minute call, read by `polydance-speakers` every 500 ms: a ring in 4,058 of 5,297 frames; while only Me spoke the ring was on Me's tile in 92% of frames, and while only Others spoke it was on another tile in 98%, with no gain from shifting the lines by -0.5 to +1.5 s; the reader took 35 s. With two people in the call Meet fills the stage with the other one and draws no ring at all. A shared window's tile is ringed too and labelled with the window's title. | **Seen on this Mac**, 2026-11-11, frames of the call recorded 2026-11-11 13:03, a scratch Swift probe, then the reader on the whole call against its transcript | frames `0014_02m50s.jpg`, `0082_29m22s.jpg`; `speakers.json` |
| Meet has more than one way of showing who speaks. With two people in the call the other fills the stage and Meet draws the blue speaking badge (bars on a #A8C7FA disc) in its top corner, with no ring; on the second call (four people, a different meeting) while Robin presented, the speaker's tile had no ring but a green pill behind its name, and the top bar showed the same name in a green pill beside "Stop presenting", while the first call's presentation used rings. Read by `polydance-speakers` from the same day: over the second call's 18 recorded minutes the lone badge was seen in 146 frames of Others' own lines against 6 of Robin's, and the pill in 54 against 0; Robin's own presenting tile has a paler outline (about (160, 180, 215)) whether or not he speaks, which is not taken for a ring. Meet's background round the tiles is not one colour: (18, 18, 18) on the second call, about (55, 60, 68) on the first; AVAssetReader gives the former as (20, 20, 20), and a PNG of it drawn into a device-RGB bitmap read (6, 6, 6). | **Seen on this Mac**, 2026-11-11, frames of the call recorded 2026-11-11 15:32 at 03:05, 10:03 and 11:04 and of the first call at 14:26, then the reader on both calls against their transcripts | `polydance-speakers --image` and the full reads |
| A screen capture stopped by macOS with low disk space: at 15:51:17 on 2026-11-11, 18:31 into the second call, `deleted` began its most urgent purge round on the data volume (urgency 4, a goal of 3.1 GB), asked `replayd` (which serves ScreenCaptureKit) to free space, and `replayd` handled it as a warning for the active session; the app recorded "screen capture stopped at 18:31: Stream was stopped by the system" and kept recording sound to the call's end. The volume was 95% full afterwards (22 GB free of 460). **Read further the same day:** the purge was not set off by a level of free space but by Software Update: `suhelperd` asked `deleted` at 15:50:57 for 13,809,075,631 bytes at urgency 4 with 22,223,126,528 bytes (22.2 GB) free. Its rounds asked one service after another; `replayd` was asked in the last (15:51:17.53, for 783 MB), logged `purge:urgency: cacheDeleteUrgencyHigh`, found no "current active session" of its own and called `stopAllStreamsWithError:`, which stopped our stream 50 ms later; it freed 64 bytes and was then "disqualified from purging at urgency 4", and the purge ended at 15:52:21. An urgency-1 purge at 15:41:44 (the file provider, 20.8 GB free) also asked `replayd`, which stopped nothing. The error is `SCStreamErrorSystemStoppedStream` (-3821, macOS 15+). What free-space level makes Software Update or anything else ask at urgency 4 is not known; the app's warning under 30 GB (MAC.md C15) is a guess above the 22.2 GB seen. | **Seen on this Mac**, 2026-11-11 (`/usr/bin/log show` for `deleted` and `replayd` from 15:30 to 17:00, the call's meta.json); that the purge caused the stop is read from the order of the lines and replayd's own method names, not documented | `deleted`, `replayd` log lines; `polydance-mac-20261111-153246.meta.json`; SCError.h |
| A gap in a fragmented mp4's video track (the Mac app's settings: H.264, a fragment every 10 s) is not empty when read: the last frame before it is given the whole gap as its duration (40 s in the probe), so ffmpeg seeking anywhere in it returns that last picture, as if the screen were still live. With a black frame written at the stop and repeated each second, a seek there returns black. | **Seen on this Mac**, 2026-11-11, a scratch AVAssetWriter program writing both files and ffprobe and ffmpeg 8.0 reading them; the app's writer is tested the same way in `WriterTests` | MAC.md C14 |
| Arc's scripting dictionary has `execute` (javascript) on a tab, as Chrome's does, so an app with the Automation grant could read Meet's page (names, who is speaking, presenting, the meeting's title). Whether Arc runs it without a setting like Chrome's "Allow JavaScript from Apple Events" (off by default), and whether Meet's markup is stable enough to read, are not checked; no such key was found in Arc's preference files. | Arc 1.171.0's `Arc.sdef`; running it not tried | `/Applications/Arc.app/Contents/Resources/Arc.sdef`, 2026-11-11 |
| Arc 1.171.0 answers the detector's tab script (every tab of every window and of each window's spaces) through Apple Events under the app's Automation grant: 255 tabs in 219 to 230 ms, well inside the script's 3 s timeout, with no prompt. During the first call Arc's microphone showed in Control Center from 10:01:13 to 11:01:08 (a gap of under a second at 10:09:56), and the app's first question to Arc went at 10:01:14. | **Seen on this Mac** (`./build.sh tabs`, the built and the installed app, launched by launchd; Control Center's sensor-indicator log; tccd's log of Arc checking the app's Apple Event) | `--arc-tabs`, `/usr/bin/log show`, 2026-11-06 |
| Arc's scripting dictionary gives a window an id of its own, a `name` (its title), a front-to-back `index` and an `active tab`, but no bounds and no window number, so the window list is matched by title. Arc's `name` for each window is the title macOS lists for it once screen recording is allowed: on this Mac both of Arc's two windows matched exactly one of its ordinary windows by title. | **Seen on this Mac** (`./build.sh tabs`, the built app launched by launchd; Arc 1.171.0, macOS 15.8) | `sdef /Applications/Arc.app`, `--arc-tabs`, 2026-11-17 |

## Starting Claude from a hook (researched 2026-11-05)

For the agent hand-off in [MAC.md](MAC.md#running-the-agent). Read from Anthropic's documentation on
2026-11-05; nothing below has been run from `polycap` yet.

| Claim | Status | Source |
| --- | --- | --- |
| `claude -p` runs one prompt without a person; `--output-format json` returns `session_id` and `total_cost_usd`; `--allowedTools`, `--permission-mode` and `--mcp-config` bound what it may do. | Documented, not tried here | [Headless](https://code.claude.com/docs/en/headless) |
| Since Claude Code 2.1.302 a `-p` run starts in manual mode, so a tool call that needs approval is denied unless allowed. | Documented, not tried here | [Headless](https://code.claude.com/docs/en/headless) |
| claude.ai connectors (Slack, GitHub) load only when the credential is the claude.ai subscription login: not with `ANTHROPIC_API_KEY`, not with a `claude setup-token` token ("can only make model requests"), not with `--bare`. The docs say `--bare` "will become the default for -p". | Documented, not tried here | [MCP: servers from claude.ai](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai) |
| Whether a `-p` run started by a background process can read the login from the keychain without a person present. | Not verified | — |
| "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." | Documented | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| A scheduled task (formerly a routine) can be fired by `POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire` with its own bearer token and beta header `experimental-cc-routine-2026-04-01`, optional `text` up to 65,536 characters; each run starts from a fresh clone with no local files, the fired text arrives marked untrusted, connected connectors act as the user; 30 fires an hour per task. Research preview. | Documented, not tried here | [Routines](https://code.claude.com/docs/en/routines), [fire API](https://platform.claude.com/docs/en/api/claude-code/routines-fire) |
| `anthropics/claude-code-action@v1` with a `prompt` runs on any GitHub event, so `repository_dispatch` makes it callable from a webhook; it does not inherit claude.ai connectors. | Documented (dispatch is GitHub's behaviour) | [GitHub Actions](https://code.claude.com/docs/en/github-actions) |
| Managed Agents (beta, API key) start sessions by API call, take files through the Files API or a self-hosted sandbox worker, keep MCP credentials in vaults, cost tokens plus $0.08 a session-hour, and are not eligible for zero data retention. | Documented, not tried here | [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) |
| Claude Code's own hooks run inside a session and cannot start one. | Documented | [Hooks](https://code.claude.com/docs/en/hooks) |
| `claude -p` with stdin not a terminal reads it (up to 10 MB) and appends it to the prompt after a newline, so a hook's JSON line reaches Claude. | Read from the 2.1.317 binary's strings, not run | installed binary, review of 2026-11-05 |

## iPhone (researched 2026-11-06)

For [IPHONE.md](IPHONE.md). Nothing below has been tried on a phone; spike I0 is where each "to check"
is seen or corrected. "From memory" means Claude's knowledge of Apple's documentation, not a page read
that day.

| Claim | Status | Source |
| --- | --- | --- |
| An AVCaptureSession is interrupted with `videoDeviceNotAvailableInBackground` when the app leaves the foreground, and a movie-file recording in progress stops; AVAssetWriter users report error -11847 on return. So the camera cannot keep recording while a launch opens Safari. | Documented, not tried here | [Apple: videoDeviceNotAvailableInBackground](https://developer.apple.com/documentation/avfoundation/avcapturesession/interruptionreason/videodevicenotavailableinbackground), [Apple forums 61406](https://developer.apple.com/forums/thread/61406) |
| A free personal team's provisioning profile lasts 7 days from creation; the app then stops launching until it is installed again, which refreshes it. | Reported by developers, not tried here | [zudo-tauri: iOS signing with a free team](https://takazudo-zudo-tauri.pages.dev/pj/zudo-tauri/docs/mobile/ios-signing-free-team), [mybyways](https://mybyways.com/blog/new-limitations-imposed-on-free-apple-developer-account) |
| A free personal team cannot use push notifications. | Apple's supported-capabilities table as quoted in a forum thread; the table itself not read | [Apple forums 768748](https://developer.apple.com/forums/thread/768748) |
| Whether a free personal team can use App Groups, which a ReplayKit broadcast extension needs to hand its file to the app (I4). | Sources disagree; to check before I4 | [mybyways](https://mybyways.com/blog/new-limitations-imposed-on-free-apple-developer-account), [Apple forums 834802](https://developer.apple.com/forums/thread/834802) |
| A background URLSession uploads only from a file, and relaunches the app in the background when its tasks finish. | From memory; to check in I0 | Apple's URLSession documentation |
| A background refresh task runs when iOS chooses, often hours apart, and not after the user swipes the app away. | From memory; to measure in I0 | Apple's BackgroundTasks documentation |
| A development-signed app runs only with Developer Mode on (iOS 16 and later). | From memory | Apple's documentation on Developer Mode |
| The iOS simulator has no camera, so capture is tried only on the phone. | From memory | — |
| A broadcast upload extension has a memory limit of about 50 MB. | From memory; to check before I4 | Apple's ReplayKit documentation |
| `xcrun devicectl list devices` on this Mac lists two iPhones named Hermoso, an iPhone 16 (`iPhone17,3`) and an iPhone 13 (`iPhone14,5`), an iPad Air (5th generation) and an Apple Watch, all unavailable (not connected). | **Seen on this Mac** | `xcrun devicectl list devices`, 2026-11-06 |
| Both Hermosos are paired. The iPhone 16 reports iOS 27.2 and no Developer Mode state. The iPhone 13 reports iOS 26.3, Developer Mode enabled, last connected 2026-03-10. This Mac has Xcode 26.3 (17C529) with the iOS 26.2 SDK, so whether it installs and launches on iOS 27.2 is still to see. | **Seen on this Mac** (devicectl's cached state; neither phone reachable) | `xcrun devicectl list devices --json-output`, 2026-11-07 |
| Every iOS provisioning profile Xcode has made on this Mac for team FT47F62Q84 (8, for other apps, created March to May 2026) runs exactly 365 days and provisions 3 or 4 devices. All share one Apple Development certificate, which ends 2027-03-09 11:07:41 GMT. A free personal team's profiles are reported to last 7 days (the row above), so a year-long profile suggests the team has, or had, a paid membership. To confirm with Robin and with the probe's `profile` event, which reads the installed app's own profile and certificate. | **Seen on this Mac** | `security cms -D` on each `.mobileprovision`, `openssl x509 -enddate` on its `DeveloperCertificates`, 2026-11-07 |
| In the iOS Simulator (iOS 26.3.1), creating a background URLSession logs a CFNetwork error connecting to `com.apple.nsurlsessiond` (NSCocoaErrorDomain 4097), so the Simulator cannot stand in for the phone for background uploads. | **Seen in the Simulator** | the I0 probe on an iPhone 17 Simulator, 2026-11-07 |
| In a scene-based app, `UIApplication.applicationState` is `background` during `didFinishLaunching` even for a launch onto the screen. The scene connects 69 to 111 ms later and becomes active with the app state `inactive`. | **Seen in the Simulator and on the phone** (iPhone 16: scene connected 19 to 78 ms after launch) | the I0 probe's `launch`, `scene.connect` and `scene` events, 2026-11-07 |

## iPhone, seen on the phone (I0, 2026-11-07)

Phase I0's probe ([ios/README.md](../ios/README.md)) on the iPhone 16 (`iPhone17,3`, iOS 27.2 24B119), built with
Xcode 26.3 and installed over USB, with a `polycap serve` on this Mac as the receiver. Three takes on
2026-11-07: take 1 at 14:57 UTC (60 s, flips), take 2 at 16:13 (127 s), and take 3 at 16:21 (left after
28 s, with its video held on the background session). The evidence is the probe's `events.jsonl` and each
run's `run.json`, pulled to `.local/iphone-probe/` (gitignored, never committed). These are one phone's
results on one afternoon, not a guarantee.

| What | Status | Evidence |
| --- | --- | --- |
| Xcode 26.3, with the iOS 26.2 SDK, builds, signs, installs and launches an app with an iOS 26.0 minimum on iOS 27.2 over USB. Developer Mode was already on. The first signed build failed with "No Accounts" until Robin signed in to Xcode again (its token was missing from the keychain). | **Seen on the phone** | `npm run ios -- build`, `install` and `launch`, 2026-11-07 |
| The app's own profile, made by Xcode for team FT47F62Q84, runs 365 days (2026-11-07 to 2027-11-07). Its developer certificate ends on 2027-03-09 11:07:41 UTC, so the app stops launching then (121 days on 2026-11-07). There is no 7-day reinstall for this team. | **Seen on the phone** | the probe's `profile` event, read from the installed app's `embedded.mobileprovision` |
| `devicectl device copy to` into a folder the app has not made yet creates it as root, mode 0755 (uid 0, gid 501). The app (uid 501) then cannot create anything in it or chmod it, and fails with a permission error. `copy from` of a folder needs the destination folder to exist already, and then lands its contents as `<dest>/<run>`. | **Seen on the phone** | `devicectl device info files --json-output` (ownerUid 0, permissions 493); `ios/build.sh configure` and `pull` were fixed for both |
| Camera and mic through AVAssetWriter at 1080 x 1920, 30 fps, H.264 and AAC mono 48 kHz, with no dropped frames in three takes (1829, 3814 and 835 frames). With the angle set on the video data output's connection, the pixels are upright for both cameras and the file has no rotation metadata. The front camera's connection reported `isVideoMirrored` false; the picture itself was not checked for mirroring. | **Seen on the phone** | `run.json`, `rec.start` (`rotationApplied` true, `mirrored` false), `ffprobe`, frames extracted around each flip |
| Flipping by swapping the session's camera input: the new camera's first frame came one frame after the old camera's last (33 ms) in three of four flips, and 284 ms after in one, 11 to 268 ms after FLIP was pressed. Each new camera's first frames are dark, and its exposure settles in about half a second. | **Seen on the phone** | `rec.flip.begin` and `rec.flip.firstFrame` (`gapMs`), `flipGapsMs` in run.json, frames at 29.80 to 31.30 s of take 1 |
| Each flip loses about 160 to 200 ms of microphone sound (four flips: 4 gaps, 828 ms filled with silence). Each also brings four AVAudioSession route changes with reason `categoryChange`: reconfiguring the capture session reconfigures the app's audio session. | **Seen on the phone** | `rec.finished` (`audioGaps`, `filledAudioMs`), `rec.route` |
| `video.mp4` and `narration.m4a` from the same take are on one clock: their silences line up to within 13 ms. | **Seen on the phone** | `silencedetect` on both files of take 1 |
| Leaving for another app (Settings opened from the Mac) gives `sceneWillDeactivate` first. The take was stopped and finished in 114 ms while the app was still inactive: `cut` false, the reason in run.json, all frames kept. On reaching the background, the capture session is interrupted with `videoDeviceNotAvailableInBackground`, and coming back ends the interruption. | **Seen on the phone** | take 3's `rec.stop`, `rec.finished` and `rec.interrupted`, then `rec.interruptionEnded` |
| The hand-off after leaving fits in the app's own time. The sha256, the create, the narration's upload and the start of the first video task on the background session all finished within 0.3 s, before `scene` background. | **Seen on the phone** | take 3's `upload.create` (`hashMs` 6), `upload.task.start` (appState inactive) |
| Hashing at `.utility` priority: the create after take 1 took 11.3 s, where the same sha256 takes 0.07 s on the Mac. At `.userInitiated` the hash of a 100 MB take took 49 ms. | **Seen on the phone** | `upload.create` `ms`, then `hashMs` after the change |
| A background URLSession upload task held with `earliestBeginDate` (120 s) was begun by iOS 2 s after its date, with the app suspended. Its request then waited 27 minutes and started about 20 s after the USB cable was plugged back in, taking 95 ms. iOS then woke the app in the background with `handleEventsForBackgroundURLSession` to deliver the completion, and the app finished the upload from there. A chain of several chunks started from background callbacks was not exercised: take 3's video was one chunk. | **Seen on the phone** | take 3's `upload.task.metrics` (`fetchStart` 16:24:11, `requestStart` 16:51:15), `bg.urlsession.events`, `upload.done` (appState background) |
| With the cable in, the phone reached the receiver at `http://MacBook-Pro-6.local:8790`, 8 MB chunks taking 0.24 to 0.5 s. With the cable out it did not: `upload.reach` timed out (-1001) after 15 s, and take 3's held request waited until the cable was back. `devicectl` did not see the phone over Wi-Fi either, and the phone's `_remotepairing._tcp` did not appear in a Bonjour browse. Whether the phone was on the Mac's Wi-Fi (192.168.1.x) at the time is not known, so this is not yet a claim about Wi-Fi itself. | **Seen on the phone**; the cause is to find | `upload.reach`, `upload.task.metrics`, `devicectl list devices`, `dns-sd -B` |
| The first request after install failed with NSURLErrorDomain -1009 ("offline") until the local-network permission was granted. After that, `upload.reach` was ok in 37 to 50 ms. | **Seen on the phone** | `upload.reach`, 14:44 and 14:56 |
| The CoreDevice connection over USB dropped once (14:44 to 14:56) with the cable in, then came back without being touched. | **Seen on this Mac** | `devicectl list devices` (`tunnelState` unavailable, then connected) |
| A BGAppRefreshTask is submitted each time the app reaches the background (earliest 15 minutes on). None had run 35 minutes later. A day's timing is still to read. | **Seen on the phone**; timing still to measure | `refresh.submit`; no `refresh.run` by 16:51 |
| The receiver turns the phone's upload into a bundle with no change on its side: a session id ending `_iphone`, `appBuild` with the version and commit, `audioTracks` mic, and the narration transcribed before the video arrived. `polycap import` of the phone's own file, under its upload name, gives the same id and the run's time. The transcript's segments start within about 0.5 s of the speech (whisper's 1 s segments). | **Seen on this Mac**, from the phone's files | `.local/iphone-probe/receiver/sessions/*_iphone`, `.local/iphone-probe/import-root` |

## iPhone, seen on the phone (I3, 2026-11-07)

Threads, pairing and reports ([IPHONE.md](IPHONE.md) I3) on the same iPhone 16 (iOS 27.2) that evening,
over USB: builds `cfe17f9` and `8e1e234` against a local `polycap serve` with threads on
(`ios/tools/serve-local.sh`), then `723d502` against the live receiver at https://capture.polydance.net.
Robin pressed the keys; the evidence is the phone's `events.jsonl` (pulled to `.local/iphone-probe/pull-i3-*`
in that worktree, never committed), the receivers' threads and the agent's `polycap thread watch`. One
phone, one evening.

| What | Status | Evidence |
| --- | --- | --- |
| **Background refresh did not run in about 7 hours.** BGAppRefreshTask was submitted each time Polydance went to the background (earliest 15 minutes on), from 15:00 UTC; the app stayed in the background from 18:28 to 21:54 with Background App Refresh available and Low Power off. iOS ran no task: 0 `refresh.run` in 459 events, and none by 22:56 either. So on this phone, for a newly installed app opened a few times, refresh is not a way to hear about replies within hours; checking when the app comes to the front is. | **Seen on the phone** | `refresh.submit` (10 by 21:54), no `refresh.run`; pulled 22:01 to `pull-before-threads` in the `ios-polydance-planning-228a2b` worktree, and again at 22:56 |
| The app's own QR scanner (an AVCaptureSession with AVCaptureMetadataOutput for `.qr`, the deck's camera stopped meanwhile) read the code `npm run ios -- pair` drew on the Mac's screen, and the pairing was kept only after GET /v1/me and /v1/account answered. | **Seen on the phone** | `pair.saved` (`how` qr, https), 22:48:40 UTC; Robin saw "Paired" |
| A pairing kept in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is read back at each later launch. Reading it with the phone locked after a restart (before the first unlock) was not tried. | **Seen on the phone** (the unlocked case only) | `upload.config` ok at each launch after `pair.saved` |
| A pairing file copied into Application Support by `devicectl device copy to` after the app's first launch is owned by the app: Polydance read it, put it in the Keychain and deleted it. The I0 probe-config.json already on the phone was taken in the same way. | **Seen on the phone** | `pair.saved` (`how` probe-config.json at 22:36:40, pairing.json at 22:37:02) |
| The thread routes answer the phone's upload token over plain http to the Mac's `.local` name (USB) and over https to the live receiver: the inbox, a thread, marking it read, a reaction, a star, and an upload with `thread` that joined CAP-1 as #4 (local) and CAP-11 as #2 (live), whose `polycap thread watch --once` returned each time. | **Seen on the phone and the receivers** | the receivers' request logs and `thread show`; the agent's watch output |
| A report (`thread: {report: true}`) opened its own thread in the reports project: CAP-2 locally, CAP-12 on the live receiver, which the phone's token cannot see. The phone deleted its copy as soon as the upload was done (`report.removed` 5 ms after `upload.done`). | **Seen on the phone and the receivers** | `report.removed` (deleted true), `polycap thread list --reports` |
| `UIApplication.open` of an https launch link opened it in Safari (example.com locally, the receiver's privacy page live). | **Seen on the phone** (Robin) | — |
| Notification permission was asked when Replies was turned on behind the gear and granted, and the notice posted at once showed with Polydance in front. A reply's notice from a refresh was not seen, since no refresh ran. | **Seen on the phone** (Robin), the reply notice not | `replies.on` (granted), 22:42:01 |

## Vision Pro (2026-11-12)

For [VISIONOS.md](VISIONOS.md). Researched and seen on Robin's Vision Pro (RealityDevice14,1, visionOS 26.6) on 2026-11-12,
with Xcode 26.3 and the visionOS 26.2 SDK. One headset, one afternoon.

| Claim | Status | Source |
| --- | --- | --- |
| `RPScreenRecorder.startCapture` in an app sees only that app's own view; the whole view (windows, other apps, immersive content) reaches only a broadcast upload extension, started with `RPSystemBroadcastPickerView`. Without the enterprise "passthrough in screen capture" licence the background is black. | Forum reports with an Apple engineer's replies; **seen on the headset** (black behind the windows) | [Apple forums 757738](https://developer.apple.com/forums/thread/757738), [771026](https://developer.apple.com/forums/thread/771026), [the entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.screen-capture.include-passthrough) |
| `RPBroadcastSampleHandler` is available on visionOS 1.0 and later. | Documented | [Apple: RPBroadcastSampleHandler](https://developer.apple.com/documentation/replaykit/rpbroadcastsamplehandler) |
| Pressing the picker's own button from code (`sendActions(for: .touchUpInside)`) brings up visionOS's Start Broadcast sheet, as a direct press does. | **Seen on the headset** | `rec.asked` (`how` code, ok) then `rec.live` starting 10 s later, 2026-11-12 |
| The broadcast's frames are 1920 × 1080, about 30 fps; the mic comes as mono and the app's sound as stereo, both written at 48 kHz AAC by AVAssetWriter. | **Seen on the headset** | one 32.6 s take: 968 frames, none dropped; ffprobe |
| A finished take moved from the app group into the app's own container with `FileManager.moveItem` keeps its files, and the iPhone's background upload sends it from there. | **Seen on the headset** | `rec.arrived`, then `upload.create` 201 to `upload.done` in 24 s for 36.7 MB |
| A link opened with `UIApplication.open` during a broadcast opens in Safari and the broadcast goes on recording it. | **Seen on the headset** | `launch.open` (recording true) twice; Safari in the frames |
| The headset offers to pair only while Settings, General, Remote Devices is open; it then advertises `_remotepairing-manual-pairing._tcp` as "Apple Vision Pro", and `xcrun devicectl manage pair --device "Apple Vision Pro"` pairs it with the 6-digit code it shows, without Xcode's window. | **Seen on this Mac** | `dns-sd -B`, devicectl, 2026-11-12 |
| A paired Vision Pro shows in `devicectl` as `RealityDevice14,1`, transport `localNetwork`; Xcode needs it worn and unlocked to prepare it ("may need to be unlocked to recover from previously reported preparation errors" otherwise). Developer Mode was already enabled. | **Seen on this Mac** | `devicectl device info details`, xcodebuild, 2026-11-12 |
| For the Personal Team, `xcodebuild -allowProvisioningUpdates` makes profiles whose app-group list is empty, so signing fails; ticking the group in Xcode's Signing & Capabilities registers it, and profiles made after carry it. The team's profiles last a year and cover iOS and visionOS. | **Seen on this Mac** | the profiles' entitlements before and after, 2026-11-12 |
| Building for any destination needs the platform's component (Xcode, Settings, Components): with none installed, even a device build fails with "visionOS 26.2 is not installed". `xcodebuild -downloadPlatform visionOS` fetched the arm64 Simulator and platform, about 10 GB of disk. | **Seen on this Mac** | xcodebuild, df, 2026-11-12 |
| `devicectl device info apps` gives an app's version and build number but no key of the app's own (so not PolydanceCommit). | **Seen on this Mac** | `npm run visionos -- installed` |
| A broadcast upload extension has a memory limit of about 50 MB. | From memory, not checked; the extension holds at most two seconds of sound and no frames | Apple's ReplayKit documentation |

## Device logs (researched 2026-11-16)

For [LOGS.md](LOGS.md). Read from sources on 2026-11-16; no headset was connected, so nothing here is seen on one.

| Claim | Status | Source |
| --- | --- | --- |
| An app reads only its own lines of the Android log unless it holds `READ_LOGS`, a development permission an app cannot ask for: only `adb shell pm grant` gives it. | Documented | AOSP permission `READ_LOGS` (`signature\|privileged\|development`); [Google: manage your device logs](https://support.google.com/android/answer/12986432) |
| From Android 13, an app holding `READ_LOGS` that reads the log makes the system ask "Allow … to access all device logs?" It asks only while the app is on top (`PROCESS_STATE_TOP`), declines at once for an app in the background, gives up after 400 s unanswered on a user build, and the answer holds for 60 s (`STATUS_EXPIRATION_TIMEOUT_MILLIS = 60 * 1000`). Declined, the app still reads its own lines. | Read in the AOSP source (android14-release); not seen on Horizon OS or Android XR | [LogcatManagerService.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/core/java/com/android/server/logcat/LogcatManagerService.java) |
| Meta's store prohibits `READ_LOGS` (and `PACKAGE_USAGE_STATS`): its upload check fails a build whose manifest declares it. | Documented | [Meta: prohibited permissions](https://developers.meta.com/horizon/resources/permissions-prohibited/) |
| Meta documents a web page's console through Chrome DevTools over adb (`chrome://inspect`), not logcat. Whether the Meta Quest Browser writes a page's `console.log` to the Android log at all is not documented. | Documented / unknown | [Meta: debug browser content](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/) |
| A Unity or native Quest app writes its own log to logcat. | Documented | [Meta: collect logs with logcat](https://developer.oculus.com/documentation/unity/ts-logcat) |
| On visionOS, as on iOS, an app reads only its own process's log: `OSLogStore` there takes scope `.currentProcessIdentifier` alone; `.system` is macOS only. | Documented (the `.system` case lists macOS 12 alone) and said by Apple on its forums | [Apple: OSLogStore.Scope.system](https://developer.apple.com/documentation/oslog/oslogstore/scope/system), [Apple forums: OSLogStore on iOS](https://developer.apple.com/forums/thread/658229) |
