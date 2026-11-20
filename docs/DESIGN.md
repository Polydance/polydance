# Design

Decisions from the discussion between Robin and Claude on 2026-10-01. Nothing here is a status
report; see `private/docs/ROADMAP.md` for what exists.

## Two problems, two products

Polydance solves a tester-throughput problem: many small experiments, fast switching, a durable
record of what was tested and decided. The video-feedback workflow solves a different problem:
getting a narrated walkthrough of a build in front of a model so it can compare, fix and build. The
two connect in one direction only. Fast scrolling produces many short sessions; the pipeline makes
each one useful. The pipeline does not need the scroller, and it is useful today on Android
builds of other apps, which cannot run inside Polydance.

So the pipeline is its own tool. Polydance keeps the tester-facing capture with consent and hosted
upload. This tool owns everything after capture, and Polydance's hosted recordings become one more
source of videos for it through `polycap import`.

## Three layers

| Layer | Who provides it | This tool's position |
| --- | --- | --- |
| Capture | The platform: Quest's recorder, a browser's canvas capture, OBS | Not built here. The platform recorder captures passthrough, hands and system UI, which an app recording its own rendering cannot. MediaProjection, a system capture an app can start, also gets passthrough and system UI (verified on Quest 3 on 2026-10-01; see PLATFORM-NOTES). |
| Ingest | This tool | Given a video: probe, transcribe with timestamps, keyframes, spoken markers, one bundle folder. |
| Consumption | A Claude Code skill over the bundles; later a web view and an API | The skill and CLI are here. |

Capture is deliberately not an SDK. Every platform already has a recorder, and the only thing lost by
not being inside the app is structured markers, which spoken cue words replace well enough.

## Receiver and transports

`polycap import <file>` is the receiver. It creates a session from any local video. Everything that
brings a video to the machine is a transport that ends in the receiver:

| Transport | Audience | Status |
| --- | --- | --- |
| adb pull from a headset in developer mode | Developers | Phase 1 |
| Operator download from Polydance hosted diagnostics | Polydance operators | Works today through `import`; a one-command bridge is later |
| HTTP upload endpoint (`polycap serve`) | Robin's own headset now; testers later | Proof of concept built 2026-10-01 for one user; see [HOSTED.md](HOSTED.md) |
| `polycap sync` from the hosted receiver | Developers, and the skill | Built with the receiver; downloads finished bundles |
| Browser upload from the headset's own browser | Testers, zero install | Phase 4 |
| Companion app on the headset that uploads new recordings | Robin now (Polydance, the headset app, built as the capture probe, uploads on Stop); testers later | The spikes answered yes; the probe app has the upload and a recordings list |
| USB sync over MTP | Anyone with a cable | Not planned unless asked |

Same-network monitoring from a desktop without developer mode is not possible; the headset exposes
nothing on the network. That is why the tester tiers push to a receiver rather than being pulled.

## Two audiences

Developers have adb and want everything local and automatic. Testers will not enable developer mode
and must never be asked to. They record with the headset's own shortcut and either upload from the
headset browser or let a companion app do it. The tester tier brings back consent, retention, quotas
and deletion; Polydance already has that design in `polydance2/docs/RECORDING.md` and it should be
copied as a design, not shared as code.

## The bundle

One folder per session under `sessions/`, named `<local date>T<local time>_<app slug>`, for example
`2026-10-01T14-22-05_marimba`. The folder is the whole interface; nothing needs the tool to read it.

| File | Content | Why |
| --- | --- | --- |
| `session.json` | id, title, recordedAt and its source, device, app package and build (`source.appBuild`: version and commit, when the transport knows it), which app was in front when with its version (`source.apps`, the headset app with Usage access, 2026-10-02), bytes, sha256, media facts, step statuses, counts, Claude's summary, tool version. For a call (2026-11-05), `source.call`: the app, browser and meeting code, start and end, why it stopped, whether the screen (`video`) and the far end (`farEnd`) were captured, `short`, `cut`, whether the others were `told`, the display's size and the apps left out of it; and for any recording `source.marks`, the mark shortcut's clocks and notes. Both come from the recording app's `--meta` file (version 1, strict; [MAC.md](MAC.md) T1, T2), and `recordedAtSource` is then `meta`. `cut` means the recording itself was cut off (a crash, sleep or a full disk). What else happened to the sound (the microphone stopped and started again, the call's sound device went away, seconds dropped, a track with no sound) goes in `videoNote`, which the storyboard and `polycap show` print whenever it is there (2026-11-05). `media.hasVideo` is false for a file of sound alone; `media.videoEndMs` (2026-11-05) is the last video frame's time, from ffprobe's packets, since a Mac recording's picture often ends before its sound (a still screen sends no frames, or the screen capture stopped mid-call) | The manifest. Validated by zod on every read. The build was added 2026-10-02: three design passes were read without knowing which build was on screen. A call's id ends in its app (`_meet`), not the recorder's package, so a list says which sessions are calls. Invitees' names and addresses are not recorded until there is a decision on where personal data lives. |
| `storyboard.md` | title and summary, the previous session with the same app, the requests, then every transcript line with its marker, its requests and the frames taken while it was said. A call's (2026-11-05) opens with the call: app and meeting code, start, end and why it stopped, each speaker with their line count and the bleed dropped, whether the screen was recorded with its scene count, the marks, and anything missing (a silent far end, a short or cut-off recording, a picture that ends before the sound, whether the others were told), its times in UTC whatever offset the metadata used; then a Scenes outline, each scene frame with its clock and the line being said; then the lines, each with its speaker | The bundle in reading order, so the agent reads one file instead of matching transcript, frames.json and the contact sheet by hand (2026-10-02). Built by its own step from the other files. A call runs to an hour, about 9,000 words: the outline lets an agent find the slide it wants without reading them all (MAC.md P8). |
| `video.mp4` | the original capture, hard linked to `raw/` | No second copy of a large file; never edited. |
| `narration.m4a` | the mic track alone, when the recording app sent it ahead of the video | Words first (2026-10-04): the transcript, markers, requests and a storyboard without frames are built from it while the video is still uploading. Once the video is in, everything else comes from the video. Left on the server by `polycap sync`, like the video. |
| `transcript.json` | lines with `startMs`, `endMs`, `text` and, when the engine gives them, `words` with their own times; plus engine and language. In a call (2026-11-05) each line has `speaker`: `me` (the mic, who recorded it), `others` (the call's sound) or `others:N` when a transcriber tells the far end apart; `voice` is `both` and `bleedDropped` counts the mic lines dropped as the far end heard through the speakers; `voice` is `mic` when the call's sound was digital silence (`farEnd: silent`) and only Me was transcribed | Machine form. Word times place the pointing frames and split long stretches of speech into sentence-sized lines (at punctuation, then at the best pause, preferring one before "let's", "so", "um" and never after "and", "the", "let's"; lines of 1.5 to 8 s), so each request has its own clock. One unpunctuated Gladia segment had run 17 s over four requests. |
| `transcript.md` | `[mm:ss] text` per line, `[mm:ss] Me: text` in a call | Clocks are floored so a clock is never later than the words. |
| `requests.json` | `atMs`, text: what the narrator asked for, reported, suggested or asked, each pinned to the line it was said on. Version 2 (2026-10-12) adds each request's `kind` (change, problem, idea, question) and `quote`, the words it rests on, and `rejected`: requests left out, with the reason | Claude's reading (the `summary` step), an index for long sessions and for checking the next pass against this one; the transcript stays the record. The quote, not the model's line number, decides the line: it may run across the short lines a transcript is split into and leave out a word or two (an "um", a repeat) but not add any; one found on no single line is rejected rather than pinned near it, and one bad request no longer fails the step. Describing a reference to copy counts as change requests (2026-10-16, after an evaluation on Robin's port walkthroughs). |
| `markers.json` | `atMs`, `kind` (bug, reference, idea, change, note, praise), cue, text | Spoken cue words in place of in-app buttons. Bug outranks the others when a sentence matches several, then reference. `change` (design directives: "we don't need", "let's hide", "simplify") added 2026-10-01 after a design pass produced no markers; `reference` ("copy this", "kind of like these", "this kind of design") 2026-10-02. Since 2026-11-05 each mark from the shortcut is a `note` with cue `mark`, its text the note typed with it or else the line being said (with its speaker). In a call only Me's deliberate cues count ("action item", "note that", "make a note", "flag this", "to-do"): in conversation "great" and "wrong" are talk, and Others asked for nothing to be marked. |
| `frames/NNNN_MMmSSs.jpg` | keyframes at width 1024; `frames/full/` holds full-resolution copies (the video's width, at most 1920) of pointing frames and frames on a reference line, and since 2026-11-05 of scene and mark frames | One at every pointing word ("this", "these", "that", "here"...) when the transcript has word timings; one per transcript line midpoint; both ends; even interval when there is no transcript, and since 2026-10-16 also inside any silence longer than an interval, so what was done without a word still shows. Collisions within 2 s collapse to the more valuable frame (pointing, segment, interval, edge). Capped at 80: silence frames give way first, then even thinning. The full copies exist because the design passes were judged from 1024 px frames of a reference in the headset browser. Since 2026-11-05 a recording with marks has a frame at each (`mark`), and a call also one where the screen changed (`scene`); see Pipeline policies. A recording of sound alone has none, and its frames step says why. Frames are planned up to the picture's last frame (`media.videoEndMs`), so none is sought after it; a mark after it is shown by the last picture, and the step note says where the picture ends when that is over 2 s before the sound. A frame that cannot be grabbed is left out and counted in the note; only a plan none of whose frames could be grabbed fails the step (until 2026-11-05 one seek past the end failed them all). |
| `frames.json` | timestamp, reason (`mark`, `scene`, `pointing`, `segment`, `interval`, `edge`, highest first), for pointing frames the word, and `full` for a full-size copy | Lets the CLI answer "frames around 1:23". `polycap frames --at T --exact` adds a full-resolution frame at any moment, cached outside the bundle. |
| `pointing.json` | for each pointing frame, what the ray or hand points at in a few words, whether Claude was sure, and the model | Only when `POLYCAP_POINTING=claude` (frames go to Anthropic). Shown on the storyboard's frame lines; added 2026-10-04 after reading CAP-1 took about ten frames opened by hand. The pass reads the first 24 pointing frames; since 2026-10-16 the storyboard marks the rest "not analysed", and every pointing frame when the step failed, so a frame nobody read is not mistaken for one with nothing to say. The frame stays the record. |
| `contact-sheet.jpg` | thumbnail grid, six per row, each captioned with its clock (and pointing word) | One-glance overview that maps to the transcript without counting tiles. Made without captions, and says so in the frames step note, where ffmpeg cannot draw text. |
| `hook-runs.json`, `hooks/` | each routine hook's latest run for this session (2026-11-05, [MAC.md](MAC.md#starting-robins-routine) H1 to H3): `status` (`running`, `done`, `failed`, `timeout`, `skipped`), `startedAt`, `finishedAt`, `exitCode` or `signal`, `pid` while it runs, `agentSessionId` (Claude Code's `session_id`), `note` (why it was skipped or stopped, and the tool calls Claude Code says it denied, which leave the status to the exit code) and `log`; `hooks/<name>.log` holds the hook's stdout and stderr, the first 1 MB, and `hooks/.lock` exists while a polycap runs them | Hooks are consumption: they read a finished bundle and never change it, except to record their own outcome beside it. Version 1, strict, because the Mac app's call page reads it. Once per session per hook, so a recorded run is the reason a hook does not run again. |

Exports (`polycap export`, 2026-10-02) are not part of the bundle. They are cut from the original
video into `<root>/exports/<id>/`: a clip with chosen sound (the app's, the mic's, both, mixed or none),
the narration alone, or the transcript of a range as text or subtitles timed to the clip. Which track
is which comes from `source.audioTracks`, which the headset app sends with each upload (mic, then
app); for its earlier recordings it is read from the tracks themselves (the mic is mono, the app's sound
stereo), and for anything else it is unknown, so `--sound mic` is refused rather than guessed. Since
2026-11-05 a call's video and audio exports carry `comment=polycap-call:<id>` in their tags, so
`polycap upload` refuses them wherever they are put (ffmpeg keeps the tag when it re-encodes, checked
with 8.0); calls never go to the receiver.

Identity: a session's source carries the sha256 of the pulled file, and the ledger key for a device
file is serial, path, size and mtime. A re-recorded file with the same name is new. Nothing is deleted
on the device, so the ledger is what prevents repeats.

Timestamps: a Quest names files `<package>-<yyyymmdd>-<hhmmss>.mp4` in the headset's local time with no
zone. The id uses that local time; `recordedAt` in the manifest is that moment read in this machine's
zone and stored as ISO. When the name has no timestamp the file's mtime is used, and `recordedAtSource`
says which.

## Pipeline policies

- **Pull safety.** A device file is pulled only when size and mtime are unchanged across a wait
  (`POLYCAP_STABLE_MS`) and the mtime is older than `POLYCAP_MIN_AGE_MS`, because the headset writes
  while recording. The pull is verified by byte count and by sha256 computed on the device.
- **Words first.** A session can begin with only `narration.m4a`. Then audio, transcribe, markers,
  summary and storyboard run from it (the narration's length standing in for the recording's), and
  probe, frames and pointing stay pending, not failed, until the video joins the session; then they run
  and the storyboard is rebuilt. The pipeline knows only which files the bundle has, never how they came.
  Whenever frames are redone, pointing and the storyboard are redone with them in the same run.
- **Steps.** probe, audio, transcribe, frames, pointing, markers, summary, storyboard; each records done, failed
  or skipped with a note. A failed transcription leaves frames at an interval and markers skipped, and says so.
- **Audio** for transcription is the microphone track, found from `source.audioTracks` or, for
  the headset app's earlier recordings, the track's shape (mic mono, app stereo); left alone, ffmpeg
  would pick the stereo game track. A recording with no microphone (the mic switched off) is
  transcribed from the app's track and marked `voice: app` in `session.json` and `transcript.json`:
  its words are the app's, so markers, pointing frames and requests are skipped and the summary
  describes what the app showed (2026-10-02, after a music lesson's voice-over was read as the
  user's praise). One unknown track is `voice: unknown`. Every wav is put on the file's clock
  (`aresample=async=1:first_pts=0`): a track that starts after the file does is padded with silence in
  front and a gap inside one is filled, so the transcript's times are the file's, as frames and marks
  are. Without it a Mac mic starting 2 s late gave every Me line 2 s early (2026-11-05). The words-first
  narration is read with `-copyts`, since its start is the mic's offset in the video.
- **Calls** (2026-11-05, [MAC.md](MAC.md) P1, P2, P5, P6, P8), for any session whose `source.call` is set; a headset recording keeps the rules above, since its app track is the game's sound, not a person.
  - *Both voices.* The mic (Me) and the call's sound (Others) are extracted and transcribed apart, by whisper.cpp or Gladia (which then receives the other participants' voices too), each split into lines, then merged by start time, Me first on a tie. `voice` is `both`; a call with only one of the tracks has that one, still labelled, and a call whose far end was digital silence (`farEnd: silent`) has the mic alone, `voice: mic`, the audio note saying why, since an hour of known silence could only give whisper lines to invent.
  - *Quiet stretches.* Each track of a call is silent for much of the hour, where whisper repeats the last sentence or writes lines nobody said. On call tracks only, whisper.cpp runs with `-mc 0 -sns` (no carried-over context, non-speech tokens suppressed), and ffmpeg's `silencedetect` (under -45 dB for 2 s or more) runs on each wav: a line at least 80% inside silence is dropped and counted in the transcribe note. If the check fails the note says so and nothing is dropped. The thresholds are a first guess, not measured on a real call; a real short word whose line whisper stretched across a long pause can go too. Whisper still reads the whole track.
  - *Lines nobody near the microphone said (2026-11-13).* A recording's narration (not a call's tracks) loses lines that never rise above the room's own sound. SPOT-1, an 8 s iPhone take with no narration, only background sound around -45 LUFS, came back from Gladia as "I'm going to show you how to make a simple and easy cake…" and Claude titled the thread "Cake recipe demonstration incomplete". ffmpeg's `ebur128` gives the momentary loudness every 100 ms; the floor is its quietest tenth, and a line whose loudest moment is under 14 dB above the floor (and not over -30 LUFS anyway) is dropped and counted in the transcribe note. With no lines left there is no summary, so the thread keeps the receiver's own dated title. The 14 dB is measured on seven of Robin's recordings, nothing more: real lines rose 16 to 60 dB above their floor (the quietest a Quest's counting "three,"), the iPhone's speech 25 to 33 dB, SPOT-1's lines 12 dB, and whisper's "Thank you." over a Quest's digital silence 5 dB. Run over ten bundles that day it dropped those three lines and kept all the others. The margin is about 2 dB each way, so a soft word across a noisy room can go. If the check fails the note says so and nothing is dropped. Live once the receiver runs this commit.
  - *Bleed.* Without headphones the mic hears the far end. A mic line is dropped when an app line starts within 1.5 s of it and the two share at least 0.8 of their words by token-set Jaccard (shared words over all words, case and punctuation ignored). A mic line of under 3 words must also overlap the app line in time, since both sides say "Okay" or "Bye" within a second and a reply comes after what it answers, while bleed coincides with its source. Jaccard rather than containment, so Me's short "yes" beside Others' long line is kept; a bleed line the transcriber split differently from its source falls under the threshold and is kept, preferring a duplicate to a loss. The transcribe step's note says how many were dropped. Cancelling the echo out of a working copy of the mic (P2 proper) is not built.
  - *Scenes.* ffmpeg's scene filter (`select='gt(scene,T)',showinfo` on a 640 px copy) finds where the picture changed. T is 0.03 (`POLYCAP_SCENE_THRESHOLD`), not film's 0.1 to 0.4: measured on 2026-11-05 on synthetic 1920x1080 frames, two slides on one template with different text scored 0.036 to 0.046, a cut between plain colours 0.4 to 1, ffmpeg's moving test pattern at most 0.025, since the score is a sudden change and steady motion scores little. Not yet measured on a real call. Changes under 2 s apart are one scene (a transition, a drag, a scroll), its frame taken 300 ms after the last. On by default for calls only (`POLYCAP_SCENES`), because a headset's every head turn would count.
  - *Priorities.* Mark frames (in any recording with marks) outrank scene frames, which outrank every other reason; both get full-size copies. They are capped apart from the 80 (`POLYCAP_MAX_SCENES`, 120, thinned evenly), so a talkative hour cannot thin the screen's changes, and any other frame within 2 s of one is dropped as showing the same thing.
  - *Markers and summary.* Spoken cues from Me's lines only (see markers.json). The summary step sends speaker-labelled lines (`[L12] Me: ...`) with a prompt for a recorded call, in which an action or decision is a change request, an issue a problem, a suggestion an idea and an open question a question; the requests schema is the walkthroughs'. A call's answer may run to 32,000 tokens with a 10-minute timeout (a walkthrough's 4,096 and 60 s); one cut off at that limit keeps its title, summary and every complete request, and the summary note says how many were kept. Not yet run against the API with a long call. The pointing pass, which names a headset's ray or hand, is skipped.
  - *Sound only.* A call recorded with `video: none`, or any file without a video stream, is finished without frames: frames and pointing are skipped with the reason, not left pending. Words first (above) is different: there the video is still coming.
  - *Series.* The previous session of a call is the last call with the same meeting code.
- **Transcription** is an interface with two implementations: whisper.cpp locally, and none. Gladia's
  pre-recorded API is the obvious third; `polydance2/server/gladia.ts` has the account's live config.
  Non-speech labels whisper emits, such as `[BLANK_AUDIO]`, are dropped.
- **Naming.** Phase 1 titles are the id. Since 2026-10-01 the `summary` step makes one Claude call over
  the transcript text (Haiku 4.5 by default, off unless `POLYCAP_SUMMARIZER=claude`) for a title of a
  few words and one sentence, so a list of recordings says which is which, and since 2026-10-02 the
  same call lists the requests with clocks. The id and folder name stay as they are, because the
  headset and `sync` key on them; tags are still phase 2. Haiku follows positive examples better than
  prohibitions: its titles still sometimes start with the app's name or run past six words.

## Consumption

A Claude Code skill plus the CLI, not an MCP server. The skill works in every repository, needs no
running process and is debuggable with the same commands a person uses. The CLI returns frame paths and
the agent opens images directly. MCP earns its place when a second host needs the bundles.

## Not in phase 1

Daemon, naming, scene-change detection, speaker labels, any upload, any hosted component, the Android
XR recording folder (unconfirmed), the companion app. (Scene-change detection and speaker labels came
with calls on 2026-11-05; see Pipeline policies.)
