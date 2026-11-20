# Immersive viewer: research

Research date: 20 October 2026, extended 21 October. Robin put the immersive viewer on hold on the 20th, until the
one panel layout (0.17.0) had settled. On the 21st he restarted it with a fuller spec (below). The Quest scene is
built on branch `claude/pensive-hypatia-ce56e7` ([app/PLATFORMS.md](../app/PLATFORMS.md#the-immersive-scene-quest-2026-10-21));
see "Where we are" in the roadmap for its state.

Robin's ask, CAP-10 #3 (the recording of 2026-10-20 14:59, 00:20 to 00:31): "an immersive button that would just
open it in a blank scene so I could manipulate it in 3D space rather than in this 2D panel". Sources: Meta's and
Google's developer pages, Maven, Meta's samples repository, and the published libraries themselves (bytecode and AAR
metadata). **Nothing here has been tried on a headset.**

Robin's spec, CAP-10 (the recording of 2026-10-21 11:38, 00:37 to 01:30):

> an immersive button … which goes to mixed reality or VR, and just a simple scene where … this is still the main
> window, but there's a table, and any objects that relate to threads that the user is following are on the table …
> they're able to pick them up and scale them and look at them and put them down and still interact with this
> interface. And then they can exit the immersive mode, back to shared space.

## Findings

| Claim | Status | Source |
| --- | --- | --- |
| **WebXR from the viewer's WebView is not an option.** Android WebView has no `navigator.xr` (`webview_android`: `version_added: false`, crbug 40652382), so `<model-viewer ar-modes="webxr">` cannot enter an immersive session from inside an app. Quest Browser has WebXR, but would need the model at a URL off the headset. | Documented (MDN compatibility data); no Meta page says it either way; not tried | [MDN browser-compat-data, Navigator](https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json) |
| Meta Spatial SDK 0.14.0 (2026-09-11) is current: `meta-spatial-sdk`, `-toolkit` and `-vr` are enough, and `-vr` brings `-isdk`. "Interaction SDK is enabled automatically when you register `VRFeature`", with "Hands and controllers through a unified API", and an entity with `Grabbable` and a mesh or collider becomes grabbable. | Documented (ISDK overview updated 2026-04-02); versions from Maven metadata | [Release](https://developers.meta.com/horizon/downloads/package/meta-spatial-sdk/0.14.0/), [ISDK overview](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-isdk-overview), [Maven](https://repo1.maven.org/maven2/com/meta/spatial/meta-spatial-sdk/maven-metadata.xml) |
| `Mesh(Uri)` takes `file://`, "a glTF/glb file from the given absolute file path", so the verified copy in the app's files can be drawn as it is. | Documented (3D objects page updated 2025-10-01); MeshManager 0.14.0 has the `file` branch; not tried | [Spatial SDK: 3D objects](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-3dobjects) |
| Scaling with two hands: "you will need to enable two-handed transform mode", and the page names no API. `IsdkGrabConstraints` has `scaleMinMax` and `maxGrabbers`, whose default is 1 (read from the 0.14.0 bytecode). The trial build sets `maxGrabbers = 2` with nothing locked. | Documented in part (grabbable page updated 2025-06-25); that two grabbers scale is **inference** until tried | [Grabbable](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-isdk-grabbable/), [IsdkGrabConstraints 0.14.0](https://developers.meta.com/vr/reference/spatial-sdk/v0.14.0/com_meta_spatial_isdk_isdkgrabconstraints/) |
| Passthrough is `scene.enablePassthrough(true)`, and "Passthrough won't work if your skybox is visible". Meta's mixed reality sample turns it on, so it is taken as off by default. | Documented (updated 2025-10-06); off by default is inference | [Spatial SDK: passthrough](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-passthrough) |
| Leaving: a hybrid app's immersive activity sends a `CATEGORY_HOME` intent with `extra_launch_in_home_pending_intent` wrapping the panel's intent, then `finish()`: "your panel activity will be launched once the Home environment is opened." Nothing says other panels come back with it; Polydance has one panel since 0.17.0, and that is the one it relaunches. | Documented (hybrid apps page updated 2026-09-22; Meta's HybridSample does the same); the other panels are not known | [Hybrid apps](https://developers.meta.com/horizon/documentation/spatial-sdk/hybrid-apps-overview), [HybridSample](https://github.com/meta-quest/Meta-Spatial-SDK-Samples/tree/main/HybridSample) |
| "Immersive (VR) apps require 6DoF head tracking hardware", so `android.hardware.vr.headtracking` is required for them; panel apps may leave it out or set it false. Meta says nothing about a hybrid app's class. The trial build declares it `required="false"`, to stay a panel app with one VR activity. | Documented (manifest page updated 2026-10-15); that Meta's upload check and Horizon OS accept this is **not verified** | [Mobile manifest](https://developers.meta.com/horizon/resources/publish-mobile-manifest/) |
| Spatial SDK 0.14.0's Kotlin is 2.2 (`Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.2.0, expected version is 2.0.0`), so using it means moving this project from Kotlin 2.0.21 to 2.2.21 (both flavors). Its libraries declare minSdk 21 and no compile SDK floor, and need no Spatial SDK Gradle plugin when no Spatial Editor scenes or custom components are used. | Verified by building, 2026-10-20 | The trial build (`claude/immersive-viewer-impl`) |
| Size: 56 MB of arm64 native libraries (`libMetaSpatialSDK.so` 47.8 MB, ISDK 3.8 MB, the rest 4.9 MB). The Quest debug APK went from about 14 MB to 71.3 MB in the trial build; the Android XR one stayed 13.4 MB with no native code. | Measured, 2026-10-20 | The trial build |
| Recording: Meta says an immersive app can block capture "through OpenXR APIs, or by turning off Video Recording" in its dashboard. A capture started by the deck kept running through another immersive app on 2026-10-01 (the first table above). Whether it runs through Polydance's own immersive activity, and whether Polydance's panel comes back as it was, is **not verified**. | Documented, plus the 2026-10-01 run | [Meta: AOSP features](https://developers.meta.com/horizon/documentation/android-apps/features-overview) |
| **Android XR, SceneCore:** `GltfModelEntity` shows a `.glb` in Full Space only, where "All other apps are hidden". `MovableComponent.createSystemMovable` moves an entity, but `ResizableComponent` "is currently unsupported on GltfModelEntity", there is no rotate component, and a glTF entity reports its size as zero. `scenecore` 1.0.0-rc02 (2026-10-07) declares `minCompileSdk=36` (this app compiles against 35) and brings about 7.8 MB of native code (`impress`, ARCore, OpenXR) and media3. Passthrough is a preference (`preferredPassthroughOpacity`); the AURA is optical see-through. | Documented (pages updated 2026-09-22 to 2026-10-07); the AAR metadata read 2026-10-20 | [SceneCore releases](https://developer.android.com/jetpack/androidx/releases/xr-scenecore), [GltfModelEntity](https://developer.android.com/reference/kotlin/androidx/xr/scenecore/GltfModelEntity), [MovableComponent](https://developer.android.com/reference/kotlin/androidx/xr/scenecore/MovableComponent), [ResizableComponent](https://developer.android.com/reference/kotlin/androidx/xr/scenecore/ResizableComponent) |
| **Android XR, Scene Viewer:** "runs in Full Space Mode", with "built-in UI for … moving, rotating, scaling", and a close button back to the app. It takes the model as an https `file=` link; nothing says it takes `content://`, and whether the AURA has it is not stated. | Documented; not tried | [Add 3D models](https://developer.android.com/develop/xr/jetpack-xr-sdk/add-3d-models), [Scene Viewer](https://developers.google.com/ar/develop/scene-viewer) |

### Added 21 October: keeping Polydance's panel in the scene

| Claim | Status | Source |
| --- | --- | --- |
| "Cooperative mode": "both panel and immersive activities for the same app can be simultaneously visible and interactable". The way in is to "launch a panel activity as an overlay while within an immersive activity": an intent to the panel activity with `FLAG_ACTIVITY_NEW_TASK`, started from the immersive activity. Meta warns not to call `finishAndRemoveTask()` from it, since that "will close the immersive activity". | Documented (hybrid apps page, updated 2026-09-22); not tried | [Hybrid apps](https://developers.meta.com/horizon/documentation/spatial-sdk/hybrid-apps-overview) |
| Hybrid apps "must target Meta Horizon OS v69 or later". Panel activities carry `com.oculus.intent.category.2D` and immersive ones `com.oculus.intent.category.VR`. Meta's page writes the SDK element as `metavr:uses-metavr-sdk`; its HybridSample (0.14.0) uses `horizonos:uses-horizonos-sdk` with 69 and 69, which is what Polydance declares. MediaProjection already needed v68. | Documented; which element Horizon OS reads is not verified | Same page; [HybridSample manifest](https://github.com/meta-quest/Meta-Spatial-SDK-Samples/blob/main/HybridSample/app/src/main/AndroidManifest.xml) |
| Not stated: whether a panel the tester already had open in Home carries over into the scene; what "Embedded" panels are; the system menu's Quit for a hybrid app. Meta's panel-registration pages returned 404 when read on 2026-10-21. | Not found | |

"Threads the user is following" has no meaning of its own in Polydance yet. The scene takes it as the inbox: the open
threads it lists, in the projects its filter shows, newest first (`Immersive.followed`).

## Recommendation

- **Quest: Meta Spatial SDK.** Use one immersive activity in the Quest flavor (`src/quest`), opened by an
  Immersive key beside the model in its message (`ModelView`).
  - Grabbing with hands and controllers is built in, and passthrough is one call.
  - It reads the verified `.glb` straight from the app's files, so nothing new crosses the network.
  - The costs to accept first: Kotlin 2.2 for both flavors, about 56 MB of native libraries in the Quest APK, the
    `HAND_TRACKING` permission (likely a Data Use Checkup line), and a decision on `android.hardware.vr.headtracking`.
- **Android XR: nothing yet.**
  - Scene Viewer would hand a private model to Google by https URL.
  - SceneCore is the route: `GltfModelEntity` in Full Space. It is a release candidate, needs compileSdk 36 for
    both flavors first (a shared change of its own), and rotate and scale would have to be written on
    `InteractableComponent`.
- **To learn on the first headset run:**
  - Whether Meta's upload check accepts a VR activity without required head tracking.
  - Whether two hands scale the model as set.
  - Whether the deck's recording keeps capturing the immersive scene.
  - Where Polydance's panel comes back after leaving.
  - Whether Draco and KTX2 models draw.

## The first trial build (20 October)

Before the hold, a single-model version was built against the old viewer panel (`ModelActivity`). It is kept on
branch `claude/immersive-viewer-impl` (`a0eabae`). The 21 October scene reuses its pieces: the Kotlin move, the Spatial
SDK dependencies, the grab and scale set-up, the way back to Home, and the manifest checks. It replaces the rest, so
that branch is for reference only.
