# Releasing: one commit, every platform

Polydance ships one Android app in two flavors, Quest and Android XR ([PLATFORMS.md](../app/PLATFORMS.md)),
the Vision Pro's app, which is the same headset app in Swift ([VISIONOS.md](VISIONOS.md)), the Mac app, the iPhone
app, the `polycap` CLI and the hosted receiver. A release is one commit on `main`
built for each platform it changes. It is not finished until every platform has it.

## Every platform (Robin, 2026-11-07)

Robin asked that a change made across the platforms be pushed out to all of them, and that the process be
written down. Every build comes from `main`'s committed tip. What differs is how the build reaches its
device, and whether that can be done from this Mac with nobody at the device.

| Platform | How a build reaches it | From this Mac | Needs | Checked by |
| --- | --- | --- | --- | --- |
| Quest | Meta's Alpha channel. Headsets update from the store, or through the Update key a launch shows. | `npm run app -- release`, then `upload --platform quest` ([the flow](#the-flow)) | Meta's tool; Robin's standing yes to push test builds (2026-10-20) | `npm run app -- status`: `meta:ALPHA` |
| Android XR (the AURA) | Google Play's internal testing track (Robin, 2026-11-07), which updates it as Meta's channel updates Quest. Until Play is set up, an adb install of the release's debug APK. | The release's `.aab` to internal testing: in Play Console, until `upload --platform android-xr` exists (`private/docs/PLAY.md`). Meanwhile, `npm run app -- install --platform android-xr …` | For Play: the app record, the internal track, and the AURA signed in to Play. For adb: the AURA on adb, by USB or by Wi-Fi after one USB connection (`npm run app -- wifi`) | `status`: `play:internal`, or `adb:…` |
| Vision Pro (since 2026-11-12) | Built here by the release and installed over the network with devicectl. Robin's headset only, no store | `npm run app -- install --platform visionos --app .local/store/VERSION-CODE/polydance-visionos-release-VERSION-CODE.zip` | The headset paired with this Mac, worn and unlocked, on its network; the certificate ends 2027-03-09 | `status`: `devicectl:RealityDevice14,1`, and the build number the headset reports |
| Mac | Built here and copied into `~/Applications` | `npm run mac -- build`; quit Polydance from its menu; `npm run mac -- install`; `open ~/Applications/Polydance.app` | The same Apple Development identity every time. Never quit it during a call: check the menu shows no recording | `PolydanceCommit` in the installed app's Info.plist |
| iPhone | Built here and installed over the USB cable (Wi-Fi did not connect, 2026-11-07) | `npm run ios -- pull <dir>` first, to keep the log; then `build`, `install`, `launch` ([ios/README.md](../ios/README.md)) | The iPhone 16 on the cable and unlocked; the certificate ends 2027-03-09 | The app's commit in its launch event |
| `polycap` on this Mac | `npm link`ed to the main checkout, and runs its source through tsx | Nothing: moving `main` is the update (`npm install` there when the lockfile changes) | | `polycap doctor` |
| Receiver | An image of the commit built on the receiver's host, swapped in by `private/deploy/receiver/recreate.py` | `private/docs/OPERATIONS.md`, Operating it | Only when the receiver's own code changed since the live image, which HOSTED.md names. Not while an upload is arriving | `docker logs` and one upload |

The order, for a change that touches several platforms:

1. Land the work on `main`, with every platform's checks: `npm run check`, both flavors' tests and lint,
   `npm run mac -- test`, `npm run ios -- check` (or `test`) and `npm run visionos -- check`.
2. The headsets: raise the version, then follow [the flow](#the-flow) to release, upload to Quest,
   send the AURA's bundle to Play (or, until Play is set up, install it over adb), and install it on the Vision Pro.
3. The Mac, then the iPhone, each built from the same commit.
4. The receiver, only when its code changed.
5. Run `npm run app -- status`. In the roadmap, record which build reached which device and when. Name any
   device that could not be reached, and why.

A device that is not connected cannot be updated from here: the AURA off adb, or the iPhone off its cable.
That delivery becomes a numbered step at the end of the session, for Robin. The ledger and `status`
cover only the headsets. The Mac and the iPhone are checked by the commit each one reports.

## What went wrong (found 2026-10-13)

Robin opened Polydance on the AURA and got an old build: 0.14.0, without the Gmail-style inbox, the
player, the bug key or the inbox fixes. By then Quest testers had 0.15.2.

| When | `main` | Quest beta branch |
| --- | --- | --- |
| 2026-10-08 | `665a324` | Branched off for the private Meta beta (`b76b459`). |
| 2026-10-09 23:50 | Flavor split: Quest and Android XR (`213fd15`), 0.14.0. AURA installed from here. | Never merged `main` back, so it had no Android XR flavor. |
| 2026-10-09 to 13 | Router removal, request grounding. No app changes. | Builds 16 to 20 (0.14.2 to 0.15.2) went to Meta's Alpha from this branch. Further branches were made from it. |

Causes:

1. **Shipping from a branch.** Store builds left the Mac from a branch that never came back to `main`.
2. **The branch never took `main`.** The flavor split landed after the fork, so every Quest build was
   built from code with no Android XR flavor to build.
3. **The release command built Quest only.** Nothing produced the Android XR build of the same commit.
4. **Nothing compared the platforms.** Quest gets updates from Meta's channel automatically. Android XR
   only gets one when someone installs by hand, and nothing said that it was behind.

The fix was merging the beta line onto `main` with the flavors intact (`3833572`). The guards below
stop it happening again.

## The rule

- **Store builds come from `main`'s committed tip.** Work lands on `main` before a build leaves this
  Mac. `release` refuses anything else.
- **A release builds every flavor from one commit**, with one versionCode, one versionName (Android XR
  adds `-androidxr`) and one signing key, and the Vision Pro's app from the same commit with the same
  versionName and versionCode as its build number (since 2026-11-12). A release missing it is refused unless
  `--skip-visionos` asks for that by name (Robin, 2026-11-19: "let's not worry about the visionOS platform build
  for now", when this Mac's Xcode lacked the visionOS platform and every release was blocked on it). Such a release
  has no Vision Pro artifact, `status` shows the Vision Pro as behind, and that is a note, not a blocker, as the AURA
  is; the next release built with the platform installed brings it level.
- **A release is done when every platform has it.** Quest gets it through a Meta channel. Android XR gets
  it through an adb install on the AURA, and later through Play (`private/docs/PLAY.md`). Run
  `npm run app -- status` to check.
- **Branches that live longer than a session merge `main` in at least daily**, and before any release.
  Structural changes like the flavor split must reach them.
- **The receiver is deployed from `main` too.** Its deployments in this period also came from the beta
  branch.

## The flow

1. Merge the work to `main`. Raise `versionCode` and `versionName` in `app/android/app/build.gradle.kts`.
   Both flavors share them.
2. Check everything, from the repository root:

   ```sh
   npm run check
   ```

   ```sh
   cd app/android && ./gradlew testQuestDebugUnitTest testAndroidXrDebugUnitTest lintQuestRelease lintAndroidXrRelease && cd ../.. && python3 app/tools/verify-manifests.py
   ```

3. Build the release. It needs `main`'s tip and a clean tree, and its versionCode must be above every
   recorded release:

   ```sh
   npm run app -- release
   ```

   This builds the four artifacts below from one clean Gradle run. It checks the Quest APK against Meta's
   rules and the Android XR APK against its own rules, then checks the two against each other. It keeps
   0600 copies in `.local/store/VERSION-CODE/`. Only when everything passes does it record the release in
   `app/releases.json` and print the delivery commands.
4. Deliver it to every platform. Each command records the delivery in `app/releases.json`:

   ```sh
   npm run app -- upload --platform quest --apk .local/store/VERSION-CODE/polydance-quest-release-VERSION-CODE.apk --channel alpha
   ```

   ```sh
   npm run app -- install --platform android-xr --device SERIAL --apk .local/store/VERSION-CODE/polydance-android-xr-debug-VERSION-CODE.apk
   ```

   ```sh
   npm run app -- install --platform visionos --app .local/store/VERSION-CODE/polydance-visionos-release-VERSION-CODE.zip
   ```

   `upload` publishes to the channel at once (Robin, 2026-10-20: the agent pushes a test build itself,
   without asking each time), with no age declaration; `--draft` leaves it unpublished, to publish in the
   dashboard. Meta's tool comes with Meta Quest Developer Hub: set
   `POLYCAP_OVR_PLATFORM_UTIL="$HOME/Library/Application Support/odh/ovr-platform-util"`. Meta then runs
   compatibility tests for a few minutes before headsets are offered the build.

5. Tell the testers in the thread the build is for, with a launch that requires it:

   ```sh
   polycap thread reply CAP-10 --as "Opus 5.5" --text "0.16.0 (23) is on Alpha: press Update, then Reply above." --require net.polydance.capture@23 --label "Update Polydance"
   ```

   A headset on an older build shows why in red with an **Update** key that opens Polydance's store page
   (Meta's `systemux://store` link), where one click updates it. From 23, a launch with a step the build
   cannot read (a newer feature) shows the same key.

6. Check, then commit the ledger:

   ```sh
   npm run app -- status
   ```

`status` exits 3 when anything is behind. That covers four cases: a platform with no delivery of the
newest release, a newest release with no Vision Pro build (those before 2026-11-12), a connected headset (or
the reachable Vision Pro) on an older build or on the other platform's flavor, and a checkout older than
the newest release.

| Artifact | For |
| --- | --- |
| `polydance-quest-release-…apk` | Meta's store channels. Checked against Meta's packaging rules. |
| `polydance-android-xr-release-…apk` | Checked against Android XR's rules: same key and version, nothing of Meta's. It is the same build as the bundle. |
| `polydance-android-xr-release-…aab` | Google Play, once the Play app exists (`private/docs/PLAY.md`). |
| `polydance-visionos-release-…zip` | The Vision Pro, over devicectl: the Release build of `visionos/`, signed for development, zipped with ditto. `release` checks its Info.plist names the release's version, build number and clean commit. |
| `polydance-android-xr-debug-…apk` | The AURA over adb. A release build ignores adb's `CONFIGURE`, so until Google sign-in is set up (`private/docs/PLAY.md`) the debug build of the same commit is the one that can upload to the receiver. |

## The ledger

`app/releases.json` is checked in so every worktree and session sees the same history. Each release
records its versionCode, versionName, commit, build time, each artifact's file name and sha256, and its
deliveries (`meta:ALPHA`, `play:internal`, `adb:MODEL`, each with a time). It is validated with zod on
every read, and an unexpected shape stops the command. It holds no credentials.

Limits:

- It records only what these commands did. A build uploaded in Meta's dashboard, or installed with
  plain `adb install`, is not in it.
- `install` records a delivery only when the file's hash matches a release artifact. Development builds
  are not deliveries.
- These are local guards. Meta's validation, Play's review and testing on the headset still decide
  whether a build is good.

## Verification — 2026-11-07

The first release through the table above was 0.20.0 (27) from `9ad11cd`, with the two launch keys.
`release` passed; Quest went to Alpha (Meta build 1356717157535961); the Mac was installed at `058540e`.
The AURA was off adb, so it still lacks the build. On the iPhone, this session installed `7875f0a`, and
another session installed its own branch build over it within a minute. Two sessions had installed on
one phone at the same moment, and nothing stops that yet. Until something does, a session that installs on a device says so
in its thread or handover, and a branch build on the phone is replaced by `main` once that branch lands.

## Verification — 2026-10-13

- `npm run check`: **370 tests in 19 files** passed, TypeScript clean. New tests: `tests/releases.test.ts`
  (10: source and version rules, ledger shape, deliveries, and a replay of the 2026-10-13 drift), 3
  Android XR and parity rules in `tests/store.test.ts`, and 3 CLI tests through the fake adb (`status`
  exits 3 for a behind AURA, `install` records only a release file, `upload` refuses an unrecorded APK).
- The first real `release` run is recorded in the roadmap (`private/docs/ROADMAP.md`).
