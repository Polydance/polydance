# Contributing to Polydance

Bug reports, fixes and ideas are welcome. For anything bigger than a fix, open an issue first and say what you want
to change, so the work is not wasted on something that will not fit.

## How a change gets in

This repository is published from the team's own, which also holds notes and runbooks that stay private. A pull
request is reviewed here as usual. Once it is accepted it is applied there, with you as its author, and comes back
in the next published commit. So a pull request is closed when it is applied, not merged on GitHub.

## Licences

Each folder keeps the licence [LICENSE](LICENSE) gives it: AGPL-3.0-or-later for the receiver, `polycap` and the
pipeline, Apache-2.0 for the apps, the skill and the look. A change is contributed under the licence of the folder it
touches. There is no contributor licence agreement. Sending a change says that you wrote it, or have the right to
send it, under that licence. The name and the ballerina are not covered by either licence ([TRADEMARKS.md](TRADEMARKS.md)).

## Running the checks

```sh
npm install
```

```sh
npm run check
```

That is the TypeScript check and every Node test: unit tests, and end-to-end tests with a fake adb and a fake
whisper-cli against the real ffmpeg, so it needs ffmpeg on your PATH. It touches no headset, no network and none of
your recordings.

The other platforms, when your change touches them:

| Change | Check | Needs |
| --- | --- | --- |
| The headset app for Quest or Android XR (`app/android`) | `cd app/android && ./gradlew testQuestDebugUnitTest testAndroidXrDebugUnitTest lintQuestRelease lintAndroidXrRelease` | JDK 17, the Android SDK |
| The Mac app, or Swift the iPhone shares (`mac/`) | `npm run mac -- test` | Xcode |
| The iPhone app's core (`ios/Core`) | `npm run ios -- test` | Xcode |
| The Vision Pro app (`visionos/`) | `npm run visionos -- check` | Xcode with the visionOS platform |

CI runs the Node checks and both Android flavors on every pull request (`.github/workflows/validate.yml`). Tests prove
behaviour without hardware; say in the pull request what you tried on a real headset, if anything, and what you did not.

## What the code expects

[CLAUDE.md](CLAUDE.md) is the full set, written for people and coding agents alike. The ones a first change most
often meets:

- **One receiver.** `polycap import` is the receiver and everything else is a transport into it: adb pull, an upload,
  an export. A transport never processes, and the pipeline never knows where a video came from beyond what
  `session.json` records.
- **The headset app is two codebases kept as one.** Quest and Android XR run `app/android` (Kotlin); the Vision Pro runs
  the same app in Swift (`visionos/`). A change to what the headset app does goes in both, or the pull request says
  which side waits.
- **Fail closed.** Every input that crosses a boundary (manifests, tool output, settings, HTTP bodies) is checked with
  zod, and an unexpected shape is an error with a clear message.
- **No shell.** External tools run through `execFile` with argument arrays; the only shell is the one on the device,
  and every value sent to it goes through `shellQuote`.
- **Private by default.** Folders the tool makes are 0700 and files 0600. Never commit a recording, a bundle, a token or
  an `.env` file. Tests and examples use made-up names, codes and words, never ones from a real recording.
- **One look.** Colours, type and wood come from [design/tokens.json](design/tokens.json), and `tests/design.test.ts`
  fails when a platform drifts from it ([docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)).
- **Small modules with a comment at the top** saying what each owns and why. Strict TypeScript, ESM with `.js` import
  suffixes.

## Security

Please do not open a public issue for a way to reach someone else's recordings, threads or tokens. Write to the
address in [SECURITY.md](SECURITY.md).
