# Working in this repository

Polydance turns headset screen recordings into bundles a coding agent can read: timestamped
transcript, keyframes, spoken markers, one folder per session. Read [README.md](README.md) for use,
[docs/DESIGN.md](docs/DESIGN.md) for why it is shaped this way, and
`private/docs/ROADMAP.md` for what is next. The roadmap's "Where we are" is the only
statement of status; nothing is done unless it says so.

The one structural rule: `polycap import` is the receiver and everything else is a transport into it.
adb pull is the first transport. An HTTP upload, a browser upload from the headset, a companion app
and a Polydance export are later transports. Never make a transport do processing, and never make the
pipeline know where a video came from beyond what `session.json` records.

## Name, logo and look

The product is **Polydance**, never "Polydance Capture" (Robin, 2026-11-06), in everything a person
reads: app names, windows, notifications, docs. Identifiers keep `capture` because changing them would
lose data or permissions: `net.polydance.capture` and `net.polydance.capture.mac`, `~/PolydanceCapture`,
`_capture` session ids, the `polydance-capture` skill, the Swift targets, the upload key's certificate. The
receiver's CAP project stays "Polydance Capture", since PD is "Polydance" (Robin, 2026-11-06).
Dated records keep the name they had. The logo is the ballerina,
`app/android/app/src/main/res/drawable-nodpi/polydance_mark.png`: use it, or a shape drawn from it, wherever
an icon or mark is needed. Every platform's app icon is the Mac's dock icon, the dancer on the charcoal tile, in each
platform's shape (Robin, 2026-11-11), all drawn by `design/icons.py`. It is the deck's orange, the `logo`
token, since 2026-11-11 (Robin: it had been pink); `python3 -I design/logo.py` recolours it from the token and redraws
every icon and the store art from it.

One look on every platform (Robin, 2026-11-06): the headset app's tape recorder on a wooden cabinet.
[`design/tokens.json`](design/tokens.json) holds every colour; a new one goes there first, then into each
platform, and `tests/design.test.ts` fails when the headset's `Retro.kt`, the one Swift `Palette.swift` the
Mac and the iPhone share (`mac/Sources/PolydanceShared/`), their views, the receiver's pages or the homepage (`site/`) drift from it. [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) says what each
part is and where each platform draws it; `npm run mac -- snapshots <dir>` pictures the Mac's.

## Conventions carried over from Polydance

These were learned the hard way in `polydance2` and in the agent memory for that project. Claude Code
memory is keyed by project folder, so they live here as text.

- **Verify before claiming.** Run `npm run check` before saying anything passes, and quote the real
  count. Synthetic tests do not certify a headset, a model, or a network; say exactly what was and
  was not exercised. Source changes alone are not evidence of behaviour.
- **Record verification with a date** in the doc that describes the feature, the way
  `private/docs/ROADMAP.md` does, so the next reader knows what was true when.
- **Fail closed.** Validate every input that crosses a boundary with zod: manifests, ledger, tool
  output, environment. An unexpected shape is an error with a clear message, never a guess.
- **Private by default.** Directories the tool creates are 0700 and files 0600. Nothing in the
  library is committed, pasted into chat, or logged in full. No credentials in docs, logs or commits;
  `.env.local` is gitignored and `.env.example` documents every key with its safe default.
- **Never destructive toward the source.** No deletion on the headset. Imported files are hard
  linked or copied, never moved or edited. A verified pull is one whose size and sha256 match the
  device's own report.
- **Idempotent steps with recorded outcomes.** Each pipeline step writes its status to
  `session.json` as it finishes. A failure is recorded and the next steps still run where they can;
  nothing retries silently. `--force` and `--step` redo work explicitly.
- **No shell interpolation.** External tools run through `execFile` with argument arrays. The only
  shell is the one on the device, and every value sent to it goes through `shellQuote`.
- **Small, dense, commented modules.** Strict TypeScript, ESM with `.js` import suffixes, node
  built-ins before dependencies (`parseArgs`, `crypto`). A short comment at the top of each module
  says what it owns and why; comments explain intent, not syntax.
- **Tests prove behaviour without hardware.** Unit tests for pure logic; end-to-end tests with the
  fake adb and whisper-cli shims in `tests/helpers/fake-tools.ts` and real ffmpeg. Tests never
  touch a real device, the real library, or the network. CI installs ffmpeg so the end-to-end suite runs.
- **Docs are ground truth and dated.** Update "Where we are" in the roadmap when state changes.
  Platform claims go in `docs/PLATFORM-NOTES.md` with a source, marked verified on hardware or not.
- **One release, every headset.** Store builds and receiver deployments come from `main`'s committed
  tip, never a branch. `npm run app -- release` builds Quest, Android XR and the Vision Pro together and refuses
  anything else, except that `--skip-visionos` leaves the Vision Pro out by name (Robin, 2026-11-19: Quest
  releases are not held for it while this Mac's Xcode lacks the visionOS platform; its being behind is a note); a release is done when `npm run app -- status` shows every platform has it. A branch
  that outlives a session merges `main` in daily and before any release. On 2026-10-13 the AURA was
  six builds behind Quest because store builds had shipped from a branch for five days
  ([docs/RELEASING.md](docs/RELEASING.md)).
- **Git is the agent's job.** Commit with clear messages as work lands; do not hand commit or push
  steps to Robin. There is no remote yet; creating one is Robin's call.
- **The headset app is two codebases, kept as one (Robin, 2026-11-12).** Quest and Android XR run `app/android`;
  the Vision Pro runs the same app in Swift, `visionos/` ([docs/VISIONOS.md](docs/VISIONOS.md)). A change to what the
  headset app does (the deck, the inbox, threads, launches, recording, uploads, words a person reads) is made in
  both in the same piece of work. Swift the iPhone and the Mac share (PolydanceShared, PolydancePhoneCore, the
  iPhone files `visionos/project.yml` lists, and the Vision Pro's broadcast files `ios/project.yml` lists for the iPhone's Screen mode) is changed once, there. If one side has to wait, VISIONOS.md's table
  of the Quest's features says so. Check it with `npm run visionos -- check` and the Vision Pro itself.
- **Handover is numbered.** At the end of a session, what is left for Robin goes at the end of the
  message as numbered steps, one command per code block, after a verification sweep: tests, git
  state, docs versus what was built, and anything external. `/tidy` (`.claude/skills/tidy/SKILL.md`) runs that
  sweep and closes the session down.
- **Scope stays honest.** Finish the whole task or say what was left out and why. Flag a concern in
  a sentence and keep building unless the action is destructive.

## Quick reference

```sh
npm run check                     # typecheck + tests
npm run polycap -- <command>       # run the CLI without linking
npm run app -- build | wifi | install | configure | pull | analyze   # --platform quest|android-xr, see app/PLATFORMS.md
npm run app -- release | status | upload --platform quest           # one release for every headset, docs/RELEASING.md
npm run public -- check [--lines] | snapshot --out DIR              # what would leak into the public repository, private/docs/BUSINESS.md
polycap serve | sync | token new   # hosted receiver, see docs/HOSTED.md
polycap link | project list | thread list | show | new | reply | react | close | add | remove | invite | uninvite | watch | welcome   # threads, docs/THREADS.md
polycap me [--email A]             # a token's own address, confirmed by an emailed link (docs/THREADS.md, Invited by email)
polycap connect CODE | disconnect | project edit KEY --add-host H   # your own agent, by a code from the headset (docs/THREADS.md, Connecting your own agent)
polycap doctor | devices | pull | import <file> | process | run | list | latest | show | transcript | frames | install-skill
polycap hooks list | hooks run <id> | upload <file> --thread KEY | --project KEY | --report   # routine hooks and walkthrough uploads, docs/MAC.md
python3 -m http.server 4380 --bind 127.0.0.1 --directory site   # preview polydance.net's homepage, private/docs/SITE.md
npm run mac -- build | speakers | test | snapshots <dir>   # the Mac menu-bar app, and the speaker reader polycap runs, mac/README.md
npm run ios -- test | check | build | install | launch | pull | pair | configure | devices | snapshots <dir>   # the iPhone app, ios/README.md
npm run visionos -- check | build | install | launch | installed | pull | configure | devices   # the Vision Pro's app, visionos/README.md
npm run app -- install --platform visionos [--app RELEASE.zip]   # a release on the Vision Pro, recorded in app/releases.json
```

## Where things are

| Path | Owns |
| --- | --- |
| `src/cli.ts` | argument parsing and exit codes only |
| `src/commands/` | one file per user-facing command; they print through `Cli` so tests can capture output |
| `src/adb.ts`, `src/devices.ts` | the adb wrapper and the per-headset folder profiles |
| `src/ledger.ts` | which device files were already pulled, keyed on path, size and mtime |
| `src/session.ts` | the bundle manifest schema, creation, listing and lookup |
| `src/pipeline/` | probe, logs (a headset take's log on its clock, [docs/LOGS.md](docs/LOGS.md)), audio, transcribe (whisper.cpp, Gladia), speakers (who of the Others spoke a Meet call's lines, from Meet's speaking ring), frames, markers, summary (Claude), storyboard, and `run.ts` that sequences them |
| `src/threads.ts` | thread terms shared by the receiver and the CLI: project and thread keys, the launch format, reactions, host patterns |
| `src/photo.ts` | photos in threads: the JPEG and PNG check and strip that the CLI runs before sending and the receiver runs again on arrival; `src/server/photos.ts` keeps them |
| `src/server/` | the hosted receiver: tokens, upload store, HTTP routes, the thread store and its routes, the worker that builds bundles, a newcomer's Welcome thread (`welcome.ts`), the getting-started page (`start.ts`), email: invitations and confirmations (`invitations.ts`, `mail.ts`, `email-pages.ts`), the homepage's form asking to join (`join.ts`, `POST /join`), and the agents people connect themselves with a code from their headset (`agents.ts`, `agents.json`; `src/pairing.ts` is the code's format, shared with `polycap connect` in `src/commands/connect.ts`) |
| `deploy/receiver/` | the receiver's Dockerfile, nginx site example and the env-file helpers any operator can run (`enable-*.py`, `add-*.py`, `link-meta-account.py`); their usage shows a placeholder host. The live host's own scripts and values are in `private/deploy/receiver/` and `private/docs/OPERATIONS.md` |
| `src/call.ts`, `src/import-meta.ts` | a call's description and the `--meta` contract with the Mac app; `tests/fixtures/mac-call-meta.json` is shared with its Swift tests |
| `src/hooks.ts`, `src/hook-run.ts` | hooks.json, and running a routine (`claude -p`) when a bundle is ready, recorded in `hook-runs.json` |
| `src/commands/upload.ts` | sending a Mac walkthrough to a thread; calls are refused |
| `mac/` | the Mac menu-bar app (Swift): call detection, capture, hand-off to polycap, Calls/Threads/Settings windows. `Sources/SpeakerTiles` and the `polydance-speakers` command read a recorded Meet call for who was ringed as speaking; polycap's speakers step runs it from `mac/build/`. `Sources/PolydanceShared` is the look and thread models the iPhone shares (built for iOS too), so a change there is checked with `npm run mac -- test`, the Mac's snapshots and `npm run ios -- check`. Its tests decode session.json, transcript.json, frames.json and hook-runs.json and compare MAC.md's hooks example, so run `npm run mac -- test` when those change. See `mac/README.md`. |
| `LICENSE`, `LICENSES/`, `TRADEMARKS.md`, `SECURITY.md` | which folder is AGPL-3.0-or-later and which Apache-2.0, the licence texts, the name and mark kept out of both, and where security reports go. A new top-level folder gets a line in `LICENSE` (`private/docs/BUSINESS.md`) |
| `private/`, `scripts/publish.ts` | what never goes public, and the one checked step that builds the public snapshot: every tracked file outside `private/`, refused while any names something in `private/publish-deny.json` or looks like a secret. Something private goes in `private/` or into the deny-list (`private/docs/BUSINESS.md`, items 6 to 8) |
| `design/tokens.json` | the look's colours, type and wood for every platform, checked by `tests/design.test.ts` ([docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)) |
| `skill/SKILL.md` | what Claude Code reads when loading a session; `polycap install-skill` symlinks it |
| `tests/` | `units.test.ts` for pure logic, `pipeline.test.ts` end to end with the fakes, `receiver.test.ts` and `threads.test.ts` over HTTP |
| `docs/` | the public docs: design, platform notes, hosting, threads, the Mac, iPhone and Vision Pro, releasing. Private ones are in `private/docs/` (since 2026-11-20): `ROADMAP.md`, `HANDOVER.md`, `STORE.md` (Meta), `PLAY.md` (Google), `BUSINESS.md` (the business model and licences), `SITE.md` (polydance.net) and `OPERATIONS.md` (running capture.polydance.net). A public file names a private one in plain text, never as a link (the publish check refuses links into `private/` and `.claude/`) |
| `app/releases.json` | the release ledger: each release's commit, artifacts' hashes and where it went; written by `npm run app -- release`, `upload` and `install` |
| `ios/` | Polydance for iPhone ([docs/IPHONE.md](docs/IPHONE.md)). The screen is the deck in the shared look (PolydanceShared from `mac/`), on I0's probe: `Core/` is the Swift package PolydancePhoneCore, tested with `swift test` on the Mac; `App/` is the app, generated into an Xcode project by `project.yml`; `build.sh` runs behind `npm run ios`. Camera, uploads and refresh are proved only on the phone. Screen (I4) records the screen and the mic with the Vision Pro's broadcast extension, compiled for iOS (`Broadcast/` holds its plist and entitlements). See `ios/README.md`. |
| `site/` | polydance.net's homepage: one static page in the look, no build step, nothing fetched from elsewhere but Google Analytics, and that only once a visitor allows it (Robin, 2026-11-12). `private/docs/SITE.md` lists each claim's source and how to preview and deploy it (from `main`, as Vercel project `polydance-site`); `tests/site.test.ts` and the design test check it. Live since 2026-11-11. |
| `visionos/` | Polydance for Apple Vision Pro ([docs/VISIONOS.md](docs/VISIONOS.md)): the Quest's panel in SwiftUI, built from PolydanceShared, PolydancePhoneCore and the iPhone's non-camera files (listed in `project.yml`), with a ReplayKit broadcast extension (`Broadcast/`) that writes each take into an app group the app takes it from (`Shared/Broadcast.swift`). Its version is the headsets' (`build.gradle.kts`); `npm run app -- release` builds it and `status` checks it. Recording, uploads and pairing are proved only on the headset. See `visionos/README.md`. |
| `app/` | Shared Android app and Mac tools. `src/main` owns capture/UI/uploads; `src/quest` and `src/androidXr` own vendor policy/manifests. See `app/PLATFORMS.md`; changes to shared code must build/test/lint both flavors. Not part of `polycap`. |
