# Polydance for Vision Pro

The Quest app's panel on Apple Vision Pro, in Swift ([docs/VISIONOS.md](../docs/VISIONOS.md) says why and what it does).
This file is how to build it, put it on the headset and read what it did.

## Layout

| Path | Owns |
| --- | --- |
| `project.yml` | the XcodeGen spec: the app `net.polydance.capture.visionpro` and its broadcast upload extension `…visionpro.broadcast`, sharing the app group `group.net.polydance.capture.visionpro`. It lists the iPhone app's files it compiles unchanged and the Quest's viewer page. `Polydance.xcodeproj` is generated from it and gitignored |
| `App/Sources/` | `VisionApp` (entry, delegate, `ProbeAppState` for the shared files), `HeadsetModel` (the deck, the inbox, takes, Record and open, models), `BroadcastLink` (the picker under REC, live.json, taking finished takes in), `PanelScreen` (the one panel, the thread list, the drawer, New thread), `DeckColumn`, `ThreadPage`, `ModelViewer`, `RecordingsPage`, `SettingsPage` |
| `Broadcast/SampleHandler.swift` | the take: the view, the mic and the app's sound into the run folder, with PolydancePhoneCore's MovieWriter. The iPhone compiles it too, for its Screen mode (`ios/project.yml`), with no app sound |
| `Shared/Broadcast.swift` | the contract between the two: next.json, live.json, Runs/, Darwin notifications, the meters' levels; its names are each platform's own, since the iPhone compiles it and `App/Sources/BroadcastLink.swift` too |
| `App/Info.plist`, `Broadcast/Info.plist`, `*.entitlements` | written by hand. The icon is the dock icon's two layers, drawn by `design/icons.py` |
| `build.sh` | everything behind `npm run visionos`; output under `visionos/build/` (gitignored) |

On the headset the app keeps its files in its container's `Library/Application Support`, folders 0700 and files 0600, out
of backup. The token is in the Keychain only.

| File | What |
| --- | --- |
| `events.jsonl` | the app's event log, as the iPhone's: `launch`, `pair.*`, `rec.*` (asked, live, arrived, stopAsked), `upload.*`, `launch.open` |
| `Runs/<yyyymmdd-hhmmss>/` | one take: `video.mp4` (video, mic, app), `narration.m4a`, `run.json` (`cut` until it finished), `thread.json`, `timeline.jsonl`, `opened.json` |
| `uploads/`, `models/` | each take's upload state; the verified 3D models, eight at most |

The extension writes into the app group (`Library/Application Support/Broadcast/`): `next.json` (the app's), `live.json`, its
own `events.jsonl` (`broadcast.*`), and each take in `Runs/` until the app moves it.

## Commands

```sh
npm run visionos -- generate              # visionos/Polydance.xcodeproj from project.yml
npm run visionos -- version               # the version the build takes, from app/android/app/build.gradle.kts
npm run visionos -- check                 # compile for visionOS and its Simulator: no signing, no headset
npm run visionos -- build [--release] [--out DIR] [--device ID]   # signed for the headset, commit and version in Info.plist
npm run visionos -- install [--app PATH] [--device ID]            # the last build, or the .app at PATH
npm run visionos -- launch [--device ID] [-- ARGS]
npm run visionos -- installed [--device ID]                       # what the headset has, as JSON (used by npm run app -- status)
npm run visionos -- pull <dir> [--device ID]                      # events.jsonl and Runs/, readable by you only
npm run visionos -- configure (--token-file F [--server URL] | --config-file F) [--device ID]
npm run visionos -- devices
```

The headset is `--device` (its name or the id `devices` prints), else `POLYCAP_VISION_DEVICE`, else the one Vision Pro that
can be reached. The team is `POLYCAP_IOS_TEAM`, else the first in Xcode's accounts (the Personal Team, FT47F62Q84). Builds
run outside an agent's sandbox, which cannot read Xcode's account. `pull` refuses a folder git could pick up, as the
iPhone's does.

Releases go through `npm run app -- release`, which runs `build --release` itself, and `npm run app -- install --platform
visionos --app RELEASE.zip`, which records the delivery ([docs/RELEASING.md](../docs/RELEASING.md)).

## Putting it on a headset the first time

1. **The visionOS platform in Xcode** (Settings, Components, or `xcodebuild -downloadPlatform visionOS`). Without it every
   build fails with "visionOS 26.2 is not installed".
2. **Pair the headset with this Mac.**
   - On the headset, open Settings, General, Remote Devices, and leave that page open: it offers to pair only while it
     shows. It must be on the Mac's network.
   - On the Mac, run `xcrun devicectl manage pair --device "Apple Vision Pro"` (or use Xcode's Devices and Simulators),
     and type the code the headset shows.
   - Developer Mode was already on (Settings, Privacy & Security). Xcode prepares the headset the first time a build
     targets it, and needs it worn and unlocked for that.
3. **The app group,** once per team. `xcodebuild` made profiles with an empty group list, and the signing failed with
   "doesn't match the entitlements file's value for the com.apple.security.application-groups entitlement". Opening
   `visionos/Polydance.xcodeproj` in Xcode, choosing the team, and ticking the group in Signing & Capabilities on both
   targets registered it (2026-11-12). Every build since has signed.
4. `npm run visionos -- build`, `install`, then `launch` once, so the app makes its folders.
5. **Pair it with the receiver:** `npm run visionos -- configure --token-file ~/.config/polycap/tokens/visionpro`, then
   `launch` again. The log's `pair.saved` and `upload.config ok:true` say it took.

## Verified

- 2026-11-12, on Robin's Vision Pro (visionOS 26.6), from `842d874` then the tree of `81dacb0`: paired, installed,
  configured, and a take recorded with Record and open, uploaded to the live receiver into its thread. Details and
  what was not exercised: [docs/VISIONOS.md](../docs/VISIONOS.md#verification).
