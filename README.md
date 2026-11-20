# Polydance

Test what you build in a headset, and let your coding agent see what you saw. You record a walkthrough on the
headset while you talk. Polydance turns it into a bundle an agent can read: a timestamped transcript, keyframes,
the moments you said "bug" or "it would be nice", and what was on screen when you pointed. One folder per
recording, plain files, no tool needed to read them. A Claude Code skill loads it, and threads carry builds to
testers and their recordings back.

It is free, open-source software ([licence](#licence)). What is here:

| Part | Folder | State |
| --- | --- | --- |
| `polycap`, the command: pull recordings over adb, build bundles, sync, threads | `src/`, `bin/` | Used daily since 2026-10 |
| The receiver (`polycap serve`): uploads from headsets, bundles, threads, email invitations | `src/server/`, `deploy/` | Runs capture.polydance.net; [self-hosting](docs/SELF-HOSTING.md) is untested by anyone else |
| The headset app for Meta Quest and Android XR | `app/` | On Meta's store as a private test (Alpha) |
| The headset app for Apple Vision Pro | `visionos/` | Built from source only |
| The Mac menu-bar app: calls and walkthroughs | `mac/` | Built from source only |
| The iPhone app | `ios/` | Built from source only |
| The Claude Code skill | `skill/` | |

## Three ways to use it

1. **On your own machine, no server.** Turn on developer mode on the headset, record with its own recorder or the
   Polydance app, and `polycap pull` copies recordings over adb and builds bundles locally, with whisper.cpp for
   the words. Nothing leaves your machine. Start at [Install](#install).
2. **The hosted service.** The official Quest build uploads to capture.polydance.net, so testers need no developer
   mode and no server. It is invite-only for now: ask at polydance.net.
3. **Your own receiver**, for your own models or to keep data on your own server: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
   The official store build cannot be pointed at it yet; a build you make yourself can.

Recordings show the room through passthrough and carry voices. Treat the library, `~/PolydanceCapture`, as private,
and never commit anything from it.

## Install

On a Mac with Node 22 (22.13 or later; `.nvmrc` names it) and Homebrew. `polycap` itself runs on Linux too; the
Mac app and the speaker reader do not.

```sh
brew install ffmpeg whisper-cpp
brew install --cask android-platform-tools   # adb, if not already installed
npm install
npm link                                     # puts `polycap` on PATH
mkdir -p ~/PolydanceCapture/models
curl -L -o ~/PolydanceCapture/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
npm run mac -- speakers                      # the reader that names who spoke in a Meet call (docs/MAC.md P3a)
polycap doctor
```

Transcription runs locally through whisper.cpp; nothing leaves the machine. Set
`POLYCAP_TRANSCRIBER=none` to skip it. Summaries (a title and one sentence per recording, from Claude)
are off unless `POLYCAP_SUMMARIZER=claude`. In a Meet call, who of the others said each line is read from
the ring Meet draws round the speaking tile, on the Mac (`POLYCAP_SPEAKERS=none` to skip it). Every
setting and its default is in [.env.example](.env.example).

## Use

```sh
polycap devices          # what is connected and which folder will be watched
polycap pull             # pull new recordings, verify them, create sessions
polycap process          # probe, audio, transcribe, frames, pointing, markers, summary, storyboard for every pending session
polycap run              # both of the above
polycap list
polycap list --calls --since yesterday   # find: --walkthroughs, --until DAY, --meeting CODE, --with NAME, --thread KEY, --limit N
polycap search typeface --calls          # where something was said: each line with its clock and speaker
polycap show latest
polycap frames latest --at 1:23 --window 8
polycap import clip.mp4  # any local video, including a Polydance operator download
polycap import call.mp4 --tracks mic,app --meta call.meta.json   # a call: both voices, scene frames (docs/MAC.md)
polycap hooks list       # what runs when a bundle is ready (~/.config/polycap/hooks.json, chmod 600), such as a Claude Code routine
polycap hooks run latest --force   # run them again for one session; `polycap process` runs them once by itself
polycap install-skill    # link skill/ into ~/.claude/skills so Claude Code can load sessions

polycap video latest     # the original recording (fetched from the receiver if it is not here)
polycap export latest video --sound app --from 1:00 --to 1:30   # a clip with the app's sound, no narration
polycap export latest audio --sound mic                         # the narration alone
polycap export latest transcript --format srt --from 1:00 --to 1:30   # subtitles timed to that clip
```

`--sound` is `both` (as recorded), `app`, `mic`, `mix` (one track) or `none`, or a track number for a
recording that does not say which track is which. Exports go to `~/PolydanceCapture/exports/<id>/`
unless `--out`; they are cut from the original video, exactly at the times given.

Then in Claude Code, in whatever repository you are fixing: "load the latest headset session".
Say **“Use Polydance for this project.”** The [skill](skill/SKILL.md) finds the project's thread,
posts the build, waits in the same conversation for the tester's recording and reads the feedback
without opening every frame. `polycap install-skill` links the skill folder into
`~/.claude/skills/polydance-capture`, where local Claude Code and Goose find it; ask a conversation
that loaded an older copy to reload the skill. To set up an agent from the start, on this machine or
someone else's, give it [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md): install, the receiver and its token,
the skill, linking a repository, and how it finds recordings and calls; `polycap doctor` checks the result.

Bundles live in the library, `~/PolydanceCapture`, with owner-only permissions. Recordings can contain other people's
voices and your home; treat the library as private and never commit anything from it.

## Hosted receiver

Recordings made with the headset app upload by themselves to a receiver that builds the bundles, and `polycap
sync` brings them down; the skill runs it first. [docs/HOSTED.md](docs/HOSTED.md) describes it, with what goes
where, and [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) runs your own.

```sh
polycap serve --host 0.0.0.0          # the receiver (POLYCAP_SERVER_TOKENS, POLYCAP_PROJECTS, POLYCAP_TRANSCRIBER=gladia)
polycap token new --id quest3 --team --scope upload   # --team for your own devices, --member --user ID for anyone else; 90 days unless --expires
polycap sync                          # finished bundles into ~/PolydanceCapture/sessions
```

Every recording lives in a thread, and agents post messages whose launches the headset runs on Start;
see [docs/THREADS.md](docs/THREADS.md). Someone new gets a link to the receiver's getting-started page,
`/start`, and finds a Welcome thread waiting when they first sign in ([The Welcome](docs/THREADS.md#the-welcome)).

```sh
polycap link MUS                      # this repository is project MUS (writes .polycap.json; commit it)
polycap thread list                   # open threads in the project, newest activity first
polycap thread reply MUS-12 --text "Is Settings easier to find?" --open https://…
polycap thread reply MUS-12 --text "Does the chair read as oak?" --model chair.glb   # a 3D model, opened in the headset's viewer panel
polycap thread reply MUS-12 --text "Before and after" --photo before.png --photo after.png   # photos, stripped of location before they leave
polycap thread watch MUS-12 --once    # returns when the tester replies
polycap upload walk.mp4 --thread MUS-12 --reply-to 3 --meta walk.meta.json   # a walkthrough from the Mac as a reply (--project KEY opens a thread, --report reports); a call is refused
polycap thread welcome --person robin   # someone's Welcome thread, opened by hand (POLYCAP_WELCOME); signing in opens it by itself
polycap thread invite MUS-12 --email ana@example.com   # copy an address in: the team's are emailed how to join (POLYCAP_MAIL)
polycap me --email ana@example.com      # this token's own address, emailed a link to confirm it
```

The feedback loop is [post, wait in this conversation, and iterate](skill/references/in-conversation-wait.md):
the conversation that posts a build awaits `thread watch` for a bounded interval. It does not wake a
finished chat or provide durable recovery by itself. Sustained stock-Goose waiting and same-thread
iteration remain to be verified live. The local router (`polycap runner`) and the patched Goose
experiment were removed on 2026-10-12.

Settings that hold tokens go in `~/.config/polycap/env` (mode 600); see [.env.example](.env.example).

## Validation

```sh
npm run check            # TypeScript, then vitest
npm run mac -- test      # the Mac app's Swift tests (mac/README.md)
```

The end-to-end tests use a fake adb and a fake whisper-cli with the real ffmpeg, so they prove the
pipeline and the bundle format, not a headset or a model. `npm run check` does not run the Swift tests, whose
fixtures decode session.json, transcript.json, frames.json and hook-runs.json as polycap writes them,
and one of which compares the hooks.json example with docs/MAC.md: run both when those change.

## Documentation

- [CLAUDE.md](CLAUDE.md): how to work in this repository, for people and coding agents; read first.
- [Design](docs/DESIGN.md): receiver and transports, the bundle format, the audiences, the decisions.
- [Platform notes](docs/PLATFORM-NOTES.md): what Horizon OS and Android XR allow, with sources.
- [Hosted receiver](docs/HOSTED.md): upload from the headset, process on a server, sync to the Mac.
- [Self-hosting](docs/SELF-HOSTING.md): your own receiver, and which clients can use it; untested by anyone outside the team.
- [Contributing](CONTRIBUTING.md): how to send a change, run the checks, and what never goes in.
- [Threads](docs/THREADS.md): every recording in a thread; messages, launches, reactions, the event feed.
- [Headset app](app/README.md): the shared Android headset app, Quest hardware results, uploads.
- [Platform builds](app/PLATFORMS.md): shared core, Quest/Android XR adapters and AURA installation/testing.
- [Mac](docs/MAC.md): requirements for Polydance on the Mac, walkthroughs and calls that start by themselves.
- [Design system](docs/DESIGN-SYSTEM.md): one look on every platform, from `design/tokens.json`, checked by `npm run check`.
- [Mac app](mac/README.md): the menu-bar app in `mac/` that records calls and walkthroughs and hands them to `polycap`; the roadmap says what has run.
- [iPhone](docs/IPHONE.md): requirements and plan for Polydance on the iPhone, recording with the camera and uploading into threads; not built.
- [Vision Pro](docs/VISIONOS.md): the Quest app's panel on Apple Vision Pro in Swift, recording the whole view through ReplayKit; on Robin's headset since 2026-11-12 ([visionos/README.md](visionos/README.md)).

## Licence

The receiver, `polycap` and the pipeline are AGPL-3.0-or-later; the headset, Mac and iPhone apps, the skill, the
look and the bundle format are Apache-2.0. [LICENSE](LICENSE) says which folder is which, and the name and the
ballerina are covered by neither ([TRADEMARKS.md](TRADEMARKS.md)). Security problems go privately to the address in
[SECURITY.md](SECURITY.md).

The roadmap, the business model and the runbooks for the hosted service are kept with the team, outside this
repository.
