# Polydance for Mac: requirements

Drafted by Claude for Robin on 2026-11-05, from Robin's brief of the same day. What is built is said
only in `private/docs/ROADMAP.md` "Where we are", the one statement of status; the MVP (steps 1 to 4 of
[The MVP](#the-mvp)) was built the same day and has not run on a real call, and the bundle format it
writes is in [DESIGN.md](DESIGN.md#the-bundle). Platform claims are in
[PLATFORM-NOTES.md](PLATFORM-NOTES.md#macos-screen-audio-and-call-detection-researched-2026-11-05) with
their sources; two were seen on this Mac by a probe on 2026-11-05, and nothing has been tried during a
call. Decisions marked **open** are Robin's; each has the default this document assumes until he decides.

## The brief

Robin wants Polydance on the Mac: record any app or website with narration as the headset
does, and, first of all, record video calls. Every call recorder he has tried falls short somewhere. The
best is Gemini in Google Meet, because being inside Meet gives it the shared screen, and the
screenshots in its notes are what make them worth reading. That is what Polydance already does:
screen, app sound and microphone in, a bundle an agent can read out.

Two things are new. A call recording has to start and stop by itself, because a recorder you have to
remember is a recorder that misses the call that mattered. And at the end the bundle goes to an agent
that Robin programs (today: summarise the transcript, log it in a GitHub repository, post a summary to
the team's Slack), not to summaries or integrations built into Polydance.

## The short answer

1. **The idea fits Polydance and its one structural rule.** A Mac app is one more capture app and
   transport; `polycap import` stays the receiver. Nothing about calls belongs in a transport, and
   nothing in the pipeline needs to know a Mac made the recording beyond what `session.json` says.
2. **The biggest unknown is not auto-start; it is whether the bundle beats Gemini's notes for a real
   call.** The pipeline was built for two-to-ten-minute walkthroughs with one narrator. A call is 30 to
   90 minutes, has several speakers on two equally important tracks, and its valuable frames are where
   the shared screen changes, not where someone says "this". That can be tested this week with no new
   app: record three real calls with OBS, `polycap import` them, and read what comes out (phase M0).
3. **Auto-start is the biggest risk, and it is two problems, one easier than expected and one
   harder.** Knowing that a call has started is cheap: which processes hold the microphone can be read
   with no permission at all (seen on this Mac on 2026-11-05), and the browser's tabs say whether one is a
   Meet call. Recording the screen automatically is the hard part: since Sequoia, macOS asks again about
   once a month whether an app may keep recording the screen, the only exemption is an entitlement Apple
   grants to screen-sharing products, and the alternative picker needs a click every time. So audio must
   never wait for the screen, and the app should get the monthly question asked outside calls. Spike MA
   measures both before the app is built.
4. **Recording other people automatically meets consent law** as soon as anyone but Robin uses this.
   Designing for "the user is always told, and can tell the others" from the start is cheaper than
   adding it later.
5. **The agent hand-off is the cheapest part and the one with the most leverage:** run a command when a
   bundle is ready, record what happened, and get out of the way. Polydance owns the event and the hook;
   the recipes (Slack, GitHub, summaries) stay in Robin's own repository.
6. **Screenshots in the notes are no longer the gap.** Gemini in Meet has put screenshots of presented
   content in its notes since 3 August 2026, Teams' Copilot recap shows on-screen moments, and Granola on
   the Mac already saves snapshots of a screen someone else shares and hands them to agents through its
   MCP server. What nobody does: give a finished folder, with frames on the transcript's clock, to an agent
   the user programs, on the user's own machine, the moment the call ends. That, and the same bundle for
   narrated walkthroughs, is the product.
7. **For a wider audience, do not sell a meeting-notes app.** Notes are crowded and included in Meet,
   Zoom and Teams. Sell "calls and walkthroughs become context for your coding agent": design reviews,
   demos, user interviews, bug reproductions, the same bundle the headset makes. That is also where the
   screen matters most. See [Who else could use it](#who-else-could-use-it).

## Robin's decisions, 2026-11-05

Answered the same day, after the first draft. Where they differ from a default further down, they win.

| Decision | What it means here |
| --- | --- |
| **No paid Apple Developer Program for now.** | The app is built and run on this Mac only, signed with an identity that costs nothing and stays the same between builds. That is either the free "Apple Development" certificate Xcode makes for a personal team when you sign in with an Apple ID, or a self-signed code-signing certificate from Keychain Access. It has to stay the same because macOS ties every permission (microphone, screen, system audio, Automation) to the app's signature. Ad hoc signing (`codesign -s -`) changes it with every build, and macOS would ask for everything again each time. There is no notarisation, so the app cannot be given to anyone else; that waits for the paid programme. Xcode 26.3 and Swift 6.2 are on this Mac. |
| **Build the MVP on the Mac now, without OBS.** | M0's question (is the bundle better than Gemini's notes?) is answered by the MVP's first real calls instead of OBS recordings. The pipeline is built first inside the MVP, so it is ready for the first recording the app makes. |
| **Arc first.** | Arc's scripting dictionary has windows and spaces holding tabs, each with a `URL` (read from `Arc.sdef`, Arc 1.171.0). Its sound runs in a Chromium-style audio-service helper (`company.thebrowser.browser.helper`, seen in Core Audio's process list on 2026-11-05). So detection works as it would for Chrome. |
| **Every Google Meet call records automatically.** | No rules and no asking (D6 is not in the MVP). The start notification stays, with Stop and Discard; macOS shows its own indicator anyway. |
| **Process calls on the Mac, unless that needs a new model or hurts performance.** | It needs neither. whisper.cpp and `ggml-large-v3-turbo.bin` are already installed here. On this M3 Pro (18 GB) they transcribed 115 s of synthetic speech in 16 s, about 7× real time, almost all of it on the GPU (1.5 s of CPU). An hour's call has two tracks, so expect roughly 15 to 20 minutes of background work after the call; skipping silence before transcribing would cut that, but is not built (since 2026-11-05 whisper reads each whole track, and lines said over silence are only dropped afterwards). Calls are transcribed locally. Gladia stays one setting away (`POLYCAP_TRANSCRIBER=gladia`; its key is already in `~/.config/polycap/env`) for when telling the other speakers apart matters more than keeping their audio on the Mac. Synthetic speech is not a real call, so the MVP measures the real figure. |
| **Threads in the Mac app; calls stay local.** | The Mac app gets the headset's inbox: threads, messages, launches that open on the Mac, and walkthrough recordings that upload to the hosted receiver as replies, as the headset's do. Calls are never uploaded: `polycap upload` refuses a file whose metadata (given with `--meta`, or the `.meta.json` beside it) describes a call, whose sha256 a call in the library has, that lies in a call's session or exports folder, or that carries the tag `polycap export` writes on a call's video and audio (`comment=polycap-call:<id>`), and the Mac app refuses a recording with no metadata or a call's before polycap starts. A copy another tool re-encoded and renamed carries none of these. Their bundles are written to the library on the Mac and appear in the app under Calls, not in any thread. |
| **Bundles are saved locally, and Robin sets up the automation.** | Polydance's part ends when the bundle is ready and the hook has run. |
| **A Claude Code routine runs after every call.** | See [Starting Robin's routine](#starting-robins-routine). |
| **Context from calls goes into threads, later.** | See [Calls into threads](#calls-into-threads). |

## Starting Robin's routine

Claude Code's routines (now "scheduled tasks") do have an endpoint, `POST
/v1/claude_code/routines/<id>/fire`. But a routine runs in Anthropic's cloud from a fresh clone of a
repository and cannot see `~/PolydanceCapture`. Reaching it would mean uploading the call, which Robin
chose not to do. The desktop app's local scheduled tasks can see local files, but they run on a timer,
not on an event.

The local equivalent is a headless Claude Code run, started by a command. Polydance runs that command
when a call's bundle is ready (H1; built on 2026-11-05 as `polycap` hooks, tested with a fake hook and
not yet with `claude` itself):

1. Robin keeps the routine as a skill in a folder of his own, for example
   `~/Code/calls/.claude/skills/process-call/SKILL.md`. The skill reads the bundle with the Polydance
   skill (its [call follow-up](../skill/references/call-follow-up.md) reference is the worked example),
   writes the notes, commits and pushes them and drafts the Slack summary. Changing the routine means editing that
   file; Polydance itself never needs to change.
2. `~/.config/polycap/hooks.json` (or the file `POLYCAP_HOOKS` names) says what to run. Version 1,
   strict: an unknown field or a wrong value is refused with the file and the field named, and no file
   means no hooks. It starts programs as Robin and a hook's `env` can hold secrets, so, like the env
   file, it must be a regular file of his own that nobody else can read or write (`chmod 600`; a
   symlink to one is followed); polycap refuses it otherwise. `polycap hooks list` shows them and
   `polycap doctor` checks the file, each hook's folder and whether its program is on the PATH.

   ```json
   {
     "version": 1,
     "hooks": [{
       "name": "call-routine",
       "when": { "mode": "call", "minMinutes": 2 },
       "cwd": "~/Code/calls",
       "run": ["claude", "-p", "Process the Polydance call in {dir} with the process-call skill.",
               "--name", "Call: {title}", "--output-format", "json",
               "--permission-mode", "dontAsk",
               "--allowedTools", "Read Glob Grep Edit(notes/**) Bash(polycap show *) Bash(polycap transcript *) Bash(polycap frames *) Bash(git add *) Bash(git commit *) Bash(git push *)"],
       "env": {},
       "timeoutMinutes": 30
     }]
   }
   ```

   - `name` is lowercase letters, digits and dashes (at most 40). `when.mode` is `call` (session.json
     has `source.call`), `walkthrough` (anything else) or `any`, the default; `minMinutes` is checked
     against the recording's probed length. There is no `app` filter yet (H1): only Meet calls are
     detected, so it would always match. `cwd` is `~`, `~/…` or an absolute path (a relative one is
     refused, since the Mac app starts polycap in `/`) and defaults to the home directory; `env` is
     added to the environment below; `timeoutMinutes` defaults to 30 and may be a fraction.
   - `{dir}`, `{id}` and `{title}` are replaced inside single arguments, and nothing passes through a
     shell. `{title}` is Claude's few words when `POLYCAP_SUMMARIZER=claude` gave some, else the call's
     app, meeting code and local start ("Google Meet abc-defg-hij in arc 2026-11-05 11:00"); it is one
     line and never starts with a dash, so it cannot be read as an option. `~` at the start of `cwd` and
     of `run[0]` is the home directory.
   - The command also gets `POLYCAP_SESSION_ID`, `POLYCAP_SESSION_DIR` and `POLYCAP_HOOK` in its
     environment, and one line of JSON on stdin: the session's id, folder, title, mode, length, the
     `call` block, step statuses, counts and the paths of its files. Paths and facts, never the
     transcript or anything else that was said (PV5). `claude -p` appends piped stdin to its prompt, so
     Claude sees that line after the prompt's own text; a script can parse it.
   - The example allows exactly what the routine below does: reading the bundle (`Read`, `Glob`,
     `Grep` and three read-only polycap commands, not `Bash(polycap *)`, which would let words from the
     call drive `thread reply`, `upload` or `sync`), writing `notes/` (`Edit` rules cover writing too),
     and git add, commit and push. Robin adds the Slack connector's draft tool by the name `/mcp` lists.
   - A hook inherits the environment polycap was started with, less polycap's secrets and a
     surrounding Claude session's markers: every `ANTHROPIC_*`, `CLAUDE_CODE_*` and
     `CLAUDE_AGENT_SDK_*` variable, `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `GLADIA_API_KEY`,
     `POLYCAP_UPLOAD_TOKEN`, `POLYCAP_REMOTE_TOKEN`, `POLYCAP_SERVER_TOKENS` and
     `POLYCAP_META_APP_SECRET`. So an `ANTHROPIC_API_KEY` exported in a terminal no longer makes
     Claude Code bill the key and lose the claude.ai login his connectors need. Settings such as
     `ANTHROPIC_MODEL` or `CLAUDE_CODE_USE_BEDROCK` go too; a hook that wants one sets it in its own
     `env`, which wins. Settings in `~/.config/polycap/env` are never passed on. The Mac app starts
     polycap with an environment of its own that has none of these either.
3. **When it runs.** `polycap process` runs the hooks for each session whose pipeline it finished, and
   for a session it was given by id (which is how the Mac app hands over a call: `polycap import … --json`,
   then `polycap process <id> --json`). It never runs them while a step is still pending, never for a
   call marked `short`, and never on bundles that `process --all` merely redid. While the transcribe
   step has failed, every hook is recorded `skipped` with the command that redoes it (`polycap process
   <id> --step transcribe --force`); a skip is decided afresh, so the process that fixes the
   transcript runs them. Each hook runs once per
   session: a recorded run is not repeated, and nothing is retried by itself. `polycap hooks run <id>
   --force` runs a session's hooks again, `--hook NAME` just one (named, it runs whatever its filter
   says), and `polycap process --no-hooks` runs the pipeline alone. A lock file in the session's
   `hooks/` folder keeps two polycap processes from running one session's hooks at once.
4. **What it records.** `hook-runs.json` in the bundle holds each hook's latest run: `status` (`running`,
   `done`, `failed`, `timeout`, or `skipped` with the reason in `note`), `startedAt`, `finishedAt`,
   `exitCode` or `signal`, the `pid` while it runs, `agentSessionId` (Claude's `session_id`, read from
   the JSON `--output-format json` prints) and `log`, the hook's stdout and stderr in
   `hooks/<name>.log` (the first 1 MB). When Claude Code's JSON lists `permission_denials`, the note
   says so (`claude denied 2 tool calls (Write, Bash)`); the status still follows the exit code, so a
   routine that could not write its notes shows as `done` with that note.
   Past its timeout the hook's whole process group gets SIGTERM, then SIGKILL 5 s later even if the
   hook itself has exited (what it started may ignore SIGTERM); the run is recorded `timeout` once the
   group is empty or killed. A process the hook moved into a session of its own (`setsid`) is not
   reached. When polycap itself gets SIGINT, SIGTERM or SIGHUP (Ctrl-C, a `kill` of its pid, or the Mac
   app stopping a `process` past its time limit), the hook's group gets SIGTERM, then SIGKILL 3 s later
   (inside the 5 s the app gives polycap), and a second signal kills it at once; the run is `failed`
   with the note `stopped: polycap got SIGINT` (or the signal it got), and polycap exits 130, 143 or
   129. Quitting the Mac app does not stop them: a polycap it started keeps running, finishes the
   pipeline and the routine and records them in hook-runs.json, and the app's next launch shows it as
   still running until it ends, then records the call processed. To stop a routine, send SIGTERM to
   that polycap (its pid is in `<library>/mac/handoff.json` while it runs). A run left `running` by a
   polycap that was killed outright is marked `failed` with the note `interrupted` the next time, and
   not started again unless forced. `polycap show` prints each run, and when Claude's session is known, the line to
   continue it: `cd ~/Code/calls && claude --resume <session_id>`; `--name` makes it easy to find in
   `/resume` too. The app's call page reads the same file.

Claude Code 2.1.317 is on this Mac. Three things to check on the first real run: that the Slack and
GitHub connectors load in a run the app started rather than a terminal (they load only on the
claude.ai login), whether `/process-call` can be invoked directly with `-p` (the prompt above names
the skill instead, which works either way), and that `--output-format json` still prints `session_id`
and `permission_denials`.

## Calls into threads

Calls stay on the Mac, but part of a call is often exactly the context a thread needs: the four minutes
of a design review spent on MUS-12's menu, with the build on screen. Three ways were weighed:

| Way | Verdict |
| --- | --- |
| Upload the whole call into a thread | No. It breaks the decision to keep calls local, and an hour of unrelated talk drowns the four minutes that matter. |
| Have the routine post a text message to the thread | Easy, but it loses the frames and the voices, and the thread's agent cannot check the words against the recording. |
| **Turn an excerpt into a recording in the thread** | Yes. A time range is cut from the call (`polycap export` already cuts clips at exact times) and uploaded as a reply through the path every recording uses. It is built into a bundle like any other, with `source.call` and `excerptOf: { session, fromMs, toMs }`, and the thread's agent reads it with the skill it already knows. |

An excerpt can be chosen three ways:

- **The routine suggests, Robin sends.** The routine can read `polycap thread list`, notice that part of
  the call is about an open thread, and write a suggestion (the thread, the range, one line on why)
  into the bundle. The app shows it on the call with a single Send button. Nothing leaves the Mac without
  that click.
- **By hand**, from the call's page: Send to thread, pick the thread, drag the range across the frames.
- **During the call**, the mark shortcut (C7) can name a thread ("flag for MUS-12"), so the suggestion
  is ready when the call ends.

On the command line the same thing is `polycap thread reply MUS-12 --call <session> --from 12:30 --to
16:10`. None of this is in the MVP, but the MVP's bundle format leaves room for it (`source.call`, and
marks with clocks).

## The MVP

Mockups of the MVP's screens, for Robin to approve before anything is built (2026-11-05, private to
Robin): [Polydance for Mac: call mockups](https://claude.ai/artifact/LWnGjHJHojk4EqxtB9XnhB). They show the
menu-bar states (watching, recording, building), the call's page with the routine's outcome, threads on
the Mac, settings and permissions, and the later excerpt-to-thread sheet. Their layout and wording hold;
their look was replaced on 2026-11-06 by the headset app's, at Robin's word, so every platform looks the
same ([DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)).

What gets built first, in this order. Each step is usable on its own.

1. **The pipeline for calls:** P1 (both voices), P2 (echo from the speakers), P5 (scene frames), P8 (the
   storyboard's outline), and T1 and T2 (import metadata). Tested end to end with the fakes and real
   ffmpeg, as today.
2. **Hooks:** H1 to H3 and H7, and the routine example above.
3. **The Mac app, Calls:** a Swift menu-bar app in `mac/`, signed with Robin's free certificate.
   - Detects a Meet call in Arc (D2 to D5, D7).
   - Records the display, leaving out the apps Robin chooses (C1 to C5, C8, C10 to C12).
   - Hands the file to `polycap import` and `process` (T3), then shows progress and the routine's outcome.
   - Includes manual start and stop and the mark shortcut (C6, C7).
4. **The Mac app, Threads:** the inbox, opening launches, and walkthrough recordings uploaded as replies
   (T4, for walkthroughs only).

*Exit:* a working week of Robin's Meet calls in Arc is recorded without touching the Mac, each with a
bundle in the library and his routine run on it. The M0 question is answered on the first call with a
shared screen.

Not in the MVP:
- rules (D6) and calendar (D8);
- call apps other than Meet in Arc;
- excerpts into threads;
- renewing the screen approval early (C13); the MVP records how often macOS asks instead (a start held
  past 5 s leaves a gap from 00:00 whose reason says so, since 2026-11-13);
- a consent design for other users (PV3).

Left out of the MVP as built (2026-11-05), though the steps above name the requirement:
- H1's `app` filter: hooks.json's `when` has only `mode` and `minMinutes`, and an `app` key is
  refused. Only Meet is detected, so it would always match.
- T2 and D3's detection clock: `startedAt` is when the recording started, which D3 puts within 5 s of
  detection; the moment of detection itself is not recorded.
- T2's presenting intervals.
- T2 and C3's window or display changes: only the size in points at the start of what was captured is
  recorded (`call.display`: the call's window since 2026-11-17, else the display).
- P5's "near-identical frames dropped": only a frame within 2 s of a scene or mark frame gives way.
  Segment and interval frames are still taken up to the 80 whatever the picture, so an hour of gallery
  view gives up to 80 frames that look alike.
- P2's echo cancellation proper (the bleed backstop is built) and D5's check for no speech on the app
  track.

## Assumptions, challenged

| Robin's assumption | The challenge | Proposal |
| --- | --- | --- |
| Record the screen. | The whole display holds Slack DMs, notifications, email and every other tab, and any of them can end up in a frame an agent posts to the team. Capture the display, but leave out the apps Robin lists (ScreenCaptureKit can exclude applications). Arc keeps a call in a tab and switches tabs under it, so the call's own window often shows something else; the display shows what Robin saw, including what he presents (decided 2026-11-05, C3). Changed 2026-11-17 at Robin's ask ("only record the browser window with the call on"): a call records only the Arc window showing it, so nothing of other windows or apps is in it; the trade is that a tab he switches to in that window is recorded instead of the call, and what he presents from elsewhere is not (C3). |
| Detect Google Meet in the browser and start recording. | Meet's lobby most likely holds the microphone for its level meter before you join (to check in spike MA); the call may be in a background tab or another browser; muting may or may not release the mic; a Meet link opened to look at it is not a call. One signal alone will start and stop at the wrong times. | Start on two signals together: a browser process holding the microphone and a tab on a Meet meeting code. Stop when either goes. Calendar adds names, never permission to start. [Call detection](#call-detection). |
| Start Polydance in the background at login. | Right as a menu-bar login item. But an app that records the screen gets macOS's "allow for one month" prompt about once a month, and it appears when capture starts, which for an automatic recorder means at the start of a call. | The detector needs no screen-recording permission: the microphone's owner needs none, the browser's tabs need a one-time Automation consent. Audio starts at once from its own permission; video joins when the screen permission allows. The app renews the screen approval at a quiet moment before it lapses, if spike MA shows that works. |
| Recording the system sound and the mic is something we already do. | The headset pipeline transcribes one narrator track and deliberately treats the app's sound as not the user's words. In a call the app's track is the other people, and their words matter as much as Robin's. | Transcribe both tracks; every line says whose track it came from; remove the far end's voice when the mic picks it up from the speakers. [Pipeline](#pipeline-changes-for-calls). |
| The screenshots come for free. | Frames are picked at pointing words and line midpoints and capped at 80. An hour of talking is about a thousand lines, so the cap thins evenly through talking heads and can miss the slide that mattered. Scene-change frames are a phase 2 item that was never built. | Scene-change frames on the call's video as their own reason, near-duplicates dropped, so frames follow what was shown. |
| Screenshots of the shared screen set us apart. | True of most bot-free recorders a year ago; not now. Gemini in Meet (since 3 Aug 2026), Teams recap, Krisp and Granola capture visuals. All of them keep them in their own cloud, and an agent gets them by asking. Granola captures only a screen someone else shares, not your own. | Compete on what they cannot do: local files, frames on the transcript's clock, your own screen as well as theirs, pushed to an agent you program when the call ends, and walkthroughs as well as calls. |
| Build detection and capture ourselves. | Recall.ai sells a desktop SDK that detects Zoom, Meet, Teams and Slack calls and records audio, video and the screen share, for $0.50 a recording hour. But it uploads to Recall's cloud and processes there, which breaks local-first and puts processing in the transport. | Build it: detection rests on public Core Audio properties an unsigned tool read on this Mac with no prompt, and capture on ScreenCaptureKit and Core Audio taps. Read anarlog's MIT-licensed source (formerly Hyprnote) for how it captures device audio before writing ours. |
| Keep summaries out of Polydance. | Agreed for prose summaries and every integration. But some facts only the recorder can know and every recipe needs: who spoke, when the screen changed, which call this was, what was flagged during it, whether people were told. | Polydance records facts and a grounded index (as `requests.json` does today); agents make judgements and post them. |
| Automatically spin up a Claude Code session. | A headless run is not a conversation Robin can see unless he resumes it; a cloud session cannot read the library on this Mac; and a summary posted to the team's Slack unreviewed is how a private aside or a wrong attribution reaches everyone. | The hook runs Claude Code headless in a repository Robin owns, the bundle records its session id so `claude --resume` continues it, and Slack gets a draft until the recipe has earned trust. [Agent hand-off](#agent-hand-off). |
| It is the Polydance app, on the Mac. | The headset app is threads, launches and a recorder; a call recorder has no launches and a different reader. | One Mac app, two modes sharing one capture engine: **Walkthrough** (as the headset: start, narrate, stop; in a thread once it uploads to the receiver, T4) and **Call** (starts by itself). |

## Who it is for

**Robin, first.** Many Google Meet calls; already sends transcripts to an AI that summarises them, logs
them in a GitHub repository and posts to Slack; builds web and Mac apps and wants headset-style narrated
feedback on them.

**Later, developers and small product teams who already run coding agents** (Claude Code, Goose) and
whose calls decide what gets built: design reviews over a shared Figma or build, user interviews, bug
reproductions, customer demos. Not sales teams wanting CRM sync and not compliance recording; both are
served well already and need things Polydance should never carry.

| Job | Phase |
| --- | --- |
| J1. Never miss a recording of a call, without remembering to press anything. | M3 |
| J2. After a call, the agent does my follow-up routine without me. | M1 |
| J3. Whatever the agent writes about a call, it can see what was on screen. | M0 |
| J4. Narrate over a Mac app or website and the agent builds from it, as with the headset. | M2 |
| J5. A call knows the previous one in its series: what was decided last week. | M0 (name it), later (use it) |

## Shape

```
Mac: Polydance (Swift, menu bar)              polycap on the Mac (this repo)            Robin's agent
  detector: mic owner + Meet tab (+ calendar)   import --meta call.json  (the receiver)   hook: claude -p in his
  capture: call window or display, few fps,     pipeline: probe, audio (both tracks),       follow-up repository,
    the call's sound, the mic: three tracks       transcribe, frames (scene), summary,       reads the bundle with
  segmented, so a crash keeps what was said       storyboard                                the skill, writes notes,
  transport: hand the finished file to        →   ready → hooks (argv, outcome recorded) →   drafts Slack
    polycap import (later: upload, as the
    headset does, to the hosted receiver)
```

- **The Mac app captures and transports.** It never transcribes, extracts frames or calls a model.
  Handing a file to `polycap import` is what every transport does; adb pull ends the same way.
- **The pipeline knows a call only through `session.json`**: `source.kind` as today (`import`, or
  `upload` later), `source.audioTracks: ["mic", "app"]` as the headset sends, and a new `source.call`
  block (below).
- **Hooks are consumption.** They read a finished bundle and never change it, except to record their
  own outcome beside it.

## Requirements

Each line has an id and the phase that needs it. "Verify" means a number or behaviour to measure, not
assume.

### Capture (the Mac app)

| Id | Requirement | Phase |
| --- | --- | --- |
| C1 | Three streams in one file: video, the microphone (Robin) and the call's sound (everyone else), as separate audio tracks, mic first then app, as the headset records them, and declared so (`audioTracks`). On macOS 27 ScreenCaptureKit mixes the mic into the system track unless told not to, so the app sets separate tracks explicitly. | M2 |
| C2 | Video at a low frame rate suited to screens (default 5 fps, configurable), hardware encoded, at most 1920 wide. Verify the size: the target is under 1 GB an hour. | M2 |
| C3 | Capture only the Arc window showing the call (Robin, 2026-11-17; the display until then). As the recording starts, Arc says over Apple Events which of its windows has the call's tab as its active tab, and that window's title; the one Arc window macOS lists with that title is recorded alone (`CallWindow`, `SCContentFilter(desktopIndependentWindow:)`), even where other windows cover it, and scaled to fill the picture if it is resized. Nothing outside it is in the video, so the apps to leave out do not apply. It records what the window shows: a tab Robin switches to in that window is recorded and the call is not while he does; another window or display he presents, and any small window Arc floats the call in, are not recorded. When the window cannot be told (Arc does not answer, no window shows the call's tab, no Arc window or more than one has its title), the display that holds Arc's front window is recorded as before, leaving out the apps the user lists (default: Messages, Mail and the password manager) and Polydance's own windows, and `videoNote` says why. The size of what was captured at the start is recorded (`call.display`); changes of window or display are not. A walkthrough asks instead (2026-11-16, Robin): the person points at a display or one window before it starts, as macOS's ⇧⌘5 does ([mac/README.md](../mac/README.md), Choosing the screen). | M2 |
| C4 | Crash, sleep and full-disk safety: the recording is written in segments (or a fragmented file), so a crash, lid close or full disk keeps everything up to that moment; a recording cut off is still handed over and marked `cut: true`. | M2 |
| C5 | Visible state at all times: the menu-bar icon shows recording, beside macOS's own indicator; one click stops; "Stop and discard" removes what this recording wrote. A full menu bar hides the icon without telling the app (seen on Robin's MacBook Pro, 2026-11-05), so the app reads whether it is drawn, says so once a run in a notice and in the window, and opening the app again opens the window. The icon is Polydance's ballerina (2026-11-06): in the menu bar's colour while watching, red beside the clock while recording, amber while building. Not recording is also said: when the browser has held the microphone for 20 s and no tab is a call (or the tabs cannot be read), one notification per stretch of microphone use and a line in the menu, naming a Meet tab's address form so a change in Meet's addresses shows (the first real call was missed with nothing on screen, 2026-11-06). | M2 |
| C6 | Manual start and stop for any window or display, from the menu and a global shortcut (Walkthrough mode, and Call mode before detection exists). | M2 |
| C7 | A global "mark this" shortcut during any recording: a marker at that clock (`source.marks`, kind `note`) and a full-resolution frame. The Mac has a keyboard; the headset had to rely on cue words. | M2 |
| C8 | Recordings live in the library, directories 0700 and files 0600. The app deletes a recording only when the user discards it. No retention policy yet (as on the headset). | M2 |
| C9 | Idle cost: the detector is event-driven where macOS allows and polls at most once a second otherwise. Verify CPU during capture on Apple silicon at 5 fps. | M3 |
| C10 | The call's sound comes from a Core Audio tap on the call app's audio process (for Chrome, its audio-service helper, which serves every tab, so a video playing in another tab is heard too), not from the whole system: music and notifications stay out. The mic is recorded raw: no voice processing, which on macOS 14+ lowers other apps' sound. | M2 |
| C11 | Audio never waits for video. The tap and the mic start at once; video joins when the screen permission allows. If it is refused or the prompt is left unanswered, the recording is audio only and says so (`source.call.video: "none"`), and the pipeline treats it as finished without frames rather than waiting for a video that will not come. A screen that is allowed but has not started after 5 s (macOS's monthly prompt holding the start) gets its track anyway: black from the recording's start, in a `videoGaps` gap from 00:00 that its first frame ends, so the sound is not held and the picture is not lost (since 2026-11-13; before, it was dropped and the call was audio only). A screen capture that stops mid-call is C14. | M2 |
| C12 | A refused audio grant gives silence with no error. When the call app is playing sound and the tap delivers digital silence for 30 s, the app notifies the user and records `farEnd: "silent"`; it never hands over a call whose other side is silent without saying so. | M2 |
| C13 | Before the monthly screen approval lapses, the app asks for it at a quiet moment (at login, or outside a call), so the question is not asked at the start of one. Whether macOS allows renewing early is to be found in spike MA; if not, the start notification says that video needs the approval. | M3 |
| C14 | The picture survives macOS stopping the screen capture mid-call. On 2026-11-11 an urgent purge of a nearly full disk made replayd stop every ScreenCaptureKit stream 18:31 into an 80-minute call, and the rest was sound alone ([PLATFORM-NOTES](PLATFORM-NOTES.md#macos-screen-audio-and-call-detection-researched-2026-11-05)). Now, from the moment the stream stops, the file shows **black**, repeated each second as a still screen's last picture is, so sound and picture stay on one clock and nothing reads the last picture as live (Meet's speaking ring, P3a, would name whoever was speaking at the stop for the whole gap: a gap with no frames shows the last picture throughout). When macOS stopped it (SCStreamError -3821) or the connection to replayd broke (-3804, -3805, -3811), the app starts capture again on the same display at the same size, into the same track, after 3, 10, 30, 60 and 120 s, and lets go after those five tries or a seventh stop in one recording (`ScreenRecovery`). A stop by the user (-3817), a withdrawn permission, a display that is gone or any other error is not tried again. Every stop is recorded in `call.videoGaps` (T2): when the picture stopped, macOS's words for why, and when the first frame came back, or no end. The menu's Screen line says it while it happens, and one notification says when the picture is let go. polycap plans no frame inside a gap and one each side of it, shows a mark pressed there by the picture before, and says the gaps in the storyboard's header, in the frames step's note and in `polycap show`. **Built 2026-11-11; not tried in a live call:** no stop by the system has been produced on purpose, so the restart itself (a new stream after -3821, its first frame, the gap ending) is unseen; the decisions are tested with ScreenCaptureKit's error codes, and the writer with synthetic frames (black from the stop, the restarted frames on the same clock, the sound beside them). | M2 |
| C15 | Free disk space while recording. At a call's start and every 30 s, the free space of the library's volume (what df shows) is read; under 30 GB the user is told once a recording, by a notification and a line in the menu, that macOS may clear space and stop the picture. 30 GB is a guess: the 2026-11-11 purge was asked for by Software Update (13.8 GB at urgency 4) with 22.2 GB free, and what level of free space makes macOS purge urgently is not documented or measured. **Built 2026-11-11; not tried in a live call** (tested on the decision and on reading this Mac's free space). | M2 |

### Call detection

| Id | Requirement | Phase |
| --- | --- | --- |
| D1 | First target: Google Meet in Arc (Robin, 2026-11-05). Later, in order of Robin's use: Meet as an installed web app, Zoom's app, Slack huddles, Teams, FaceTime. | M3 |
| D2 | Start when both hold: a browser process is using the microphone (Core Audio's process list, which says "Chrome", never which tab), and one of that browser's tabs is on a Meet meeting code (`meet.google.com/abc-defg-hij`, or `meet.google.com/meet/abc-defg-hij`, where Meet's redirect leaves the tab; seen 2026-11-06), read through Apple Events with one Automation consent per browser. Neither alone starts a recording. Chrome, Arc, Brave, Edge and Safari can be asked for their tabs; Firefox cannot, and would need a browser extension. | M3 |
| D3 | Start within 5 s of joining. The first seconds may be missed and that is accepted; the clock at which the call was detected is recorded. | M3 |
| D4 | Stop when the browser has released the microphone for 20 s, the tab has left the meeting code (or closed), Robin stops it, or a hard cap (4 h) is reached. Each stop records why. | M3 |
| D5 | False starts (the lobby's preview, a mic test, a link opened and closed) are kept. The app marks a recording under 2 minutes `short`; the pipeline marks one whose app track has no transcribed speech; neither is handed to hooks. | M3 |
| D6 | Rules decide per call: record, ask, or never, by app and later by calendar (for example "ask when anyone outside my domain is invited"). Not in the MVP: Robin records every Meet call (2026-11-05), with a notification at start that offers Stop and discard. | M4 |
| D7 | Detection needs no screen-recording permission, so the detector can run all day; capture asks for it only when a call starts. The process list was read on this Mac with no prompt (2026-11-05). Still to verify in spike MA: which process holds the mic during a live Meet call, and whether the property holds for a Bluetooth microphone (the per-device equivalent is reported always off for Bluetooth). | MA |
| D8 | Calendar (macOS Calendar, which holds Robin's Google calendars if added there) enriches a call: title, series, invitee count and domains. Calendar never starts a recording by itself. | M4 |

### Consent and privacy

| Id | Requirement | Phase |
| --- | --- | --- |
| PV1 | The user always knows: the indicator (C5), and a notification at every automatic start. | M3 |
| PV2 | The others: v1 does not write into the call. The start notification reminds the user to say so; `source.call.told` records `yes`, `no` or `unknown` (the default), and the user can set it. Granola can post a chat message when it starts and watermark the user's own video; either is a later option for Polydance, not v1. | M3 |
| PV3 | Before anyone but Robin uses automatic recording: a consent design (what is said, to whom, when; default "ask" for calls with outside invitees) and a legal read for the UK and the US two-party-consent states. As with the tester tier, this is a prerequisite, not polish. | M4 |
| PV4 | Calls are processed on the Mac by default: whisper.cpp, nothing leaves. Gladia (better with several speakers) and the hosted receiver are opt-in by rule, and the hosted receiver's [privacy table](HOSTED.md#where-data-goes) gains rows for calls before either is used for them. Calls hold other people's voices, faces and whatever they share. | M0 |
| PV5 | Nothing from the library is logged; hooks are given paths and ids, never content. | M1 |
| PV6 | Anything an agent posts outward is the recipe's responsibility, but the skill says: draft first, never quote a private aside or a frame showing something other than the call's subject without the user's OK. | M1 |

### Hand-off to the receiver

| Id | Requirement | Phase |
| --- | --- | --- |
| T1 | `polycap import <file> --tracks mic,app --meta <call.json>`: the tracks and a `source.call` block, validated with zod, strict, refused with a clear message when wrong. Usable by hand with an OBS recording (M0) and by the Mac app (M2). | M0 |
| T2 | `source.call`: app (`meet`, later `zoom`...), meeting code, detection and stop clocks with reasons, presenting intervals, window or display changes, `told`, `short`, `cut`, `video` (`none` when the screen was not recorded), `videoGaps` (where the picture stopped mid-call and when it came back, on the recording's clock, C14; since 2026-11-11), `farEnd` (`silent` when the tap heard nothing), and calendar title, series id and invitee count when known. Names and addresses of invitees stay out of `session.json` until a decision on where personal data lives. | M0 |
| T3 | The Mac app runs `polycap import` and then `polycap process` through `execFile` with argument arrays, as every external tool here is run. | M2 |
| T4 | Later, the hosted path: the Mac app speaks the headset's upload protocol (`POST /v1/uploads`, narration first, resumable chunks) to the existing receiver. No new route. | M4 |

### Pipeline changes for calls

| Id | Requirement | Phase |
| --- | --- | --- |
| P1 | Both voices: transcribe the mic and app tracks separately and merge them by time. Each line says `speaker: "me"` (the mic) or `"others"` (the app track), or a diarised label (`others:1`, `others:2`) when the transcriber gives one. `transcript.json` gets a version with the field; `voice` gains `both`. | M0 |
| P2 | Bleed: without headphones the mic hears the far end, because Meet and Zoom cancel echo only in what they send. The pipeline cancels it before transcribing the mic, with the app track as the reference (as RecordKit does with WebRTC's AEC3), on a working copy; the recorded tracks are never changed. As a backstop, mic lines that repeat an app line within about 1.5 s are dropped, and the step note says how many. | M0 |
| P3 | Diarisation of the far end when the transcriber can (Gladia has an option the pipeline does not use today). whisper.cpp gives none and its lines say `others`. | M0 |
| P3a | Names from Meet's speaking ring (Robin, 2026-11-11: "Meet actually highlights who is talking"). Meet draws a light-blue ring (about #A8C7FA) round the tile of whoever is talking and writes their name on it. The `speakers` step runs `polydance-speakers` (`mac/Sources/SpeakerTiles`, built by `npm run mac -- speakers`) on the recording, on the Mac: AVFoundation decodes a frame every 500 ms, a ring is two straight runs of that blue with the same extent and unbroken sides and nothing across the middle, and Vision (on the Mac, language correction off) reads the name at the ringed tile's bottom left, enlarged first, reused on the same tile for 3 s. polycap (`src/pipeline/speakers.ts`) folds the names as read into people (cut short beside a shared screen, misread by a letter, or a window's title, which is no one), takes Me's tile as the one most ringed while only Me speaks, and checks it: Me's tile ringed in at least 60% of Me's own lines and at most 30% of Others' own, or no line is named and the step fails. An Others line takes the name of the person ringed through at least 60% of it (from 250 ms after it starts to 250 ms after it ends); otherwise it stays Others. Names go in `transcript.json` (`name` on the line), `speakers.json` (people, timeline, the check), the markdown and the summary's transcript, never in `session.json` (T2). Two more of Meet's styles are read the same day (`Indicators.swift`): the badge with no ring, which is all Meet shows with two people in a call (the tile found by walking from the badge to Meet's background, whose colour is taken beside the badge since it differs between calls, stopping at any ring found), and the green pill Meet put behind the speaker's name while Robin presented on the second call (its text is the name). Each indicator is reported with its kind and counted in `speakers.json`; a label of three words or more, mostly lower case, is not a person (another app's list item read beside a badge). Not done: a line two people share is the majority's, not split at the change; other call apps. | M0 |
| P4 | Names: invitees from the calendar are offered as hints in the storyboard header, never written into transcript lines as if known. Names Meet itself showed as speaking (P3a) are written, with how each was decided. | M4 |
| P5 | Frames for calls: scene-change frames (ffmpeg's scene filter) with reason `scene`; near-identical frames dropped (not built in the MVP, see [The MVP](#the-mvp)); pointing words from both tracks; full-resolution copies of scene frames (slides and code are text). The cap follows the number of distinct scenes, not the length. | M0 |
| P6 | Marks from the shortcut (C7), and spoken cues on the mic track only ("action item", "note that", "flag this") as markers. | M0 cues, M2 marks |
| P7 | The call's reading (the `summary` step, off unless `POLYCAP_SUMMARIZER=claude`): title, one sentence, and an index of decisions, actions (with the owner when said), questions and problems, each grounded in a quote as requests v2 are. An index for the agent, not the summary Robin posts. | M0 |
| P8 | The storyboard for a long call: the scene list first (when the screen changed, with its frame), then the lines. An hour is about 9,000 words, which fits an agent's context; the outline is so it does not have to read it all. | M0 |
| P9 | The previous session in the same series is named, as the previous session with the same app is now. | M0 by meeting code, M4 by calendar series |
| P10 | Verify: an hour's call, both tracks, processed locally on Robin's Mac in under 15 minutes. | M0 |

### Agent hand-off

| Id | Requirement | Phase |
| --- | --- | --- |
| H1 | When a session's pipeline has finished, `polycap` runs the hooks configured in `~/.config/polycap/hooks.json` (zod-validated) whose filter matches: mode (`call`, `walkthrough`, any), app, minimum length, never `short`. A hook is an argument array, a working directory and a timeout; the session's id and folder are given as environment variables and JSON on stdin, never interpolated into a command. | M1 |
| H2 | Each run's outcome is recorded beside the bundle (`hook-runs.json` in the session folder): started, finished, exit code, and the agent's own session id when it prints one, so `polycap show` can say "agent done, continue with `claude --resume <id>`". | M1 |
| H3 | Once per session per hook. Nothing retries silently; `polycap hooks run <id> [--hook NAME] --force` redoes one. | M1 |
| H4 | Hooks run wherever the pipeline finishes on the Mac: `polycap process` for local recordings, `polycap sync` for bundles built on the receiver. A launchd `polycap watch` is phase 3 of the roadmap and not needed for M1. | M1 |
| H5 | A worked example in the docs, not code: Claude Code headless in Robin's follow-up repository, its CLAUDE.md holding the routine, its tools limited to what the routine needs, Slack as a draft to Robin first. [Running the agent](#running-the-agent) has what the example has to get right. | M1 |
| H6 | Later, with no Mac awake: the hosted receiver calls a configured webhook on `recording.ready` (the event exists; webhooks do not) so a cloud agent can start, and reads the bundle with a thread-scoped read token. The bundle is never committed to a repository to reach a cloud agent: nothing from the library is committed. | M4 |
| H7 | Polydance never holds an agent login. A hook is the user's own command, so the same mechanism runs Claude Code, Goose or a script, and a product shipped to others never offers a Claude login of its own (Anthropic does not allow that without approval). | M1 |

### Running the agent

What the research of 2026-11-05 found about starting Claude without a person typing (sources in
[PLATFORM-NOTES.md](PLATFORM-NOTES.md#starting-claude-from-a-hook-researched-2026-11-05); none tried yet):

- **`claude -p` from the hook is the M1 path.** It reads local files, `--output-format json` returns
  the `session_id` H2 records, and `--allowedTools` with an explicit `--permission-mode` bound what it can
  do. Since Claude Code 2.1.302 a `-p` run starts in manual mode and denies anything that needs approval,
  so a recipe that forgets its allowed tools does nothing rather than everything.
- **Robin's Slack and GitHub connectors load only on his claude.ai login,** not with an API key, a
  `setup-token` token, or `--bare`, which the docs say will become the default for `-p`. The example
  states its flags rather than relying on defaults, and M1's exit includes checking that the Slack
  connector actually loaded in a run started by `polycap`, not from a terminal.
- **Cloud, later:** a scheduled task (formerly a routine) can be fired by `POST
  /v1/claude_code/routines/<id>/fire` with up to 64 KB of text, but each run starts from a fresh clone
  with no local files. So the fired text names the session, and the task fetches the bundle from the
  hosted receiver with a scoped token (H6). GitHub Actions through `repository_dispatch` is the same
  shape. Managed Agents (API key, beta) suit a product shipped to others, which needs its own keys.
- **Claude Code's own hooks cannot start a session,** and anything that keeps a session open waiting
  for files is more fragile than one `-p` run per bundle.

### The skill

| Id | Requirement | Phase |
| --- | --- | --- |
| S1 | The skill reads call bundles: speakers, the scene outline, the call index, frames by scene, the series' previous call; and the outward-posting rules in PV6. | M1 |
| S2 | `skill/references/call-follow-up.md`: how a follow-up recipe uses a call bundle, with H5's example. | M1 |

### The app itself

| Id | Requirement | Phase |
| --- | --- | --- |
| A1 | A Swift menu-bar app in `mac/` in this repository: ScreenCaptureKit and Core Audio are Swift and Objective-C APIs, and Electron would need native modules for both. Login item through `SMAppService`. | M2 |
| A2 | Onboarding asks for each permission when it is first needed and says why: microphone, system audio, screen recording, automation of the browser (to read its tabs), notifications, later calendar. The app's own status view, and `polycap doctor`, show each grant. | M2 |
| A3 | Developer ID signed, hardened runtime, notarised, outside the App Store: reading browser tabs by Apple Events needs a sandbox exception App Review rarely grants. The App Store's own rule (2.5.14: consent and a clear indication while recording) is met anyway by C5 and macOS's indicators, which cannot be hidden. Development builds need a stable signing identity, or macOS asks for every permission again after each build. | M2 |
| A4 | Releases: the "one release, every headset" rule is about headsets. The Mac app has its own version and its own entry in `app/releases.json` once it ships to anyone but Robin (**open**). | M4 |

## Phases, each with an exit test

Robin chose on 2026-11-05 to build [the MVP](#the-mvp) directly, so these phases are now the longer
plan the MVP is cut from. The roadmap's rule still holds inside the MVP: the pipeline comes first.

**M0, prove the call bundle (no Mac app).** T1, T2, P1 to P3, P5 to P10, behind `import --tracks
mic,app --meta`. Robin records three real Meet calls with OBS (microphone and desktop audio as separate
tracks), at least one with a shared screen, and imports them.
*Exit:* for the call with a shared screen, Robin's existing follow-up prompt run over the bundle is at
least as good as Gemini's notes for the same call, and cites at least one frame Gemini's notes lack. If it
is not, stop here and fix the bundle; everything after this is plumbing.

**Spike MA, detection and permission (beside M0, about two days).** A Swift command-line tool that logs,
for a week of Robin's real calls: which processes hold the microphone and when, which browser tabs are
on Meet codes, what Meet's window shows while he presents, and every time macOS asks about screen
recording. *Exit:* the log matches his calendar for the week, with misses and false starts counted, and
the permission behaviour written into PLATFORM-NOTES as verified on this Mac.

**M1, hooks.** H1 to H5, S1, S2. *Exit:* importing an M0 call runs Robin's recipe headless; the notes
land in his GitHub repository and the Slack summary arrives as a draft to him; `polycap show` names the
agent's session and `claude --resume` continues it.

**M2, the Mac app, by hand.** C1 to C8, T3, A1 to A3. *Exit:* Robin presses the shortcut at the start of
a Meet call and again at the end, and the bundle and the hook follow with no other action. A narrated
walkthrough of a website works the same way.

**M3, calls start by themselves.** D1 to D7, C9, PV1, PV2. *Exit:* a working week of Robin's Meet calls
recorded without touching the Mac: none missed, false starts marked `short`, and no permission prompt
during a call.

**M4, beyond Robin.** Other call apps, calendar, rules, consent (PV3), the hosted path (T4, H6), signed
releases (A4), and someone else's install. *Exit:* a second person installs it and a week of their calls
reaches their own agent.

## Platform facts

The ones the requirements rest on, from [PLATFORM-NOTES.md](PLATFORM-NOTES.md#macos-screen-audio-and-call-detection-researched-2026-11-05),
where each has its source and status. The current macOS is 27; Robin's Mac runs 15.8.

| Fact | Status | What it decides |
| --- | --- | --- |
| Which processes hold the microphone is readable with no permission or prompt. | Seen on this Mac | D2, D7: the detector can run all day for nothing |
| Chrome's sound and microphone go through one audio-service helper for every tab. | Seen on this Mac (process list) | D2 needs the tab check; C10 hears all of Chrome |
| Browser tabs are readable by Apple Events, one consent per browser; not Firefox; not from the sandbox. | Documented | D2; A3 (outside the App Store) |
| Other apps' window titles are hidden without screen-recording permission. | Seen on this Mac | Titles cannot be the detector's signal |
| Screen capture is re-approved about monthly since Sequoia; the exemption is for screen-sharing products; the picker needs a click each time. | Documented in part; cadence reported | C11, C13, the first risk below |
| System sound by process tap has its own "audio only" grant, which cannot be checked and fails as silence. | Documented; silence reported | C10, C12 |
| ScreenCaptureKit records the mic on 15+; macOS 27 mixes it into the system track unless told not to. | Documented | C1: separate tracks set explicitly |
| Voice processing lowers other apps' sound; Meet cancels echo only in what it sends. | Documented; reported | C10 raw mic, P2 echo cancelled in the pipeline |
| Capture always shows in the menu bar and as a purple dot. | Documented | PV1 is guaranteed by the OS as well as by the app |
| An urgent purge of the disk (urgency 4, asked for by Software Update with 22.2 GB free) makes replayd stop every ScreenCaptureKit stream with -3821; a low-urgency purge does not. | Seen on this Mac (the log, 2026-11-11) | C14 restarts the capture; C15 warns of little free space |
| macOS's screen-recording prompt holds the stream's start: on 2026-11-13 replayd decided at a call's start that an alert was required, then went quiet for 5.4 s, and the stream started 5.9 s in, past the recorder's 5 s deadline. | Seen on this Mac (the log, 2026-11-13); the dialog itself is not in the log | C11's late start keeps the picture; C13 would move the prompt out of calls |

## Who else could use it

Researched on 2026-11-05 from vendors' own pages; prices and plans move monthly, so read this as the shape
of the market, not a price list.

| Product | Captures how | Visuals of the shared screen | Where it processes | Agent surface |
| --- | --- | --- | --- | --- |
| [Gemini in Meet](https://workspaceupdates.googleblog.com/2026/08/visual-screenshots-now-included-in-Google-Meet-meeting-notes.html) | Inside Meet | Yes, since 3 Aug 2026, in the notes Doc | Google | Docs; no meeting MCP found |
| Teams Copilot recap | Inside Teams | Yes, "key on-screen moments", recorded meetings | Microsoft | Graph API after the meeting |
| Zoom AI | Inside Zoom | Reported OCR of shared text | Zoom | MCP connector (April 2026) |
| [Granola](https://docs.granola.ai/help-center/taking-notes/capture-shared-screens) | Mac app, no bot | Yes: snapshots of a screen someone else shares, in Zoom, Meet in Chrome, Teams | Granola's cloud | MCP; screenshots through it |
| Krisp | Desktop, no bot | Screen recording of a chosen window | Cloud | MCP, webhooks |
| Fathom | Bot, plus a desktop app | Bot-free video in limited beta | Cloud | API, webhooks, MCP; a CLI with local export announced |
| Otter, Fireflies, tl;dv, Read, Jamie, Notion | Bot and/or desktop | Audio only, or not documented | Cloud | MCP or API on paid plans |
| [anarlog](https://github.com/fastrepl/anarlog) (was Hyprnote) | Desktop audio | No | Local | CLI, MCP and an agent skill; MIT |
| Meetily | Desktop audio | No | Local | MCP, webhooks on its paid tier |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | Everything, all day | Everything on screen, not just calls | Local | MCP, CLI; now source-available, not open source |
| [Recall.ai desktop SDK](https://www.recall.ai/product/desktop-recording-sdk) | A component for your own app | Yes, the share directly | Recall's cloud | Webhooks; $0.50 a recording hour |

Rewind and Limitless stopped recording after Meta bought them in December 2025.

**What that leaves open:**

1. **Push, not pull.** Every MCP above waits for an agent to ask the vendor's cloud. None hands a
   finished folder to an agent the user programs, on the user's machine, when the call ends.
2. **Frames as files on the transcript's clock.** Visuals exist as cloud attachments (Granola) or as
   video (Krisp, Fathom). None makes keyframes aligned to the transcript plus a storyboard an agent reads
   in one pass.
3. **Local and visual together.** The local, open options (anarlog, Meetily) are audio only.
4. **Walkthroughs and calls as one thing.** Nobody treats "narrate over a build" and "a design review on
   a call" as the same input to an agent, with a headset as one more source.

**The nearest threats** are anarlog, which already has a CLI, MCP and a skill and is one screen-capture
feature from this, and Fathom's announced local export. Both say the window is open but not for long,
and both say the differentiator cannot be "agent-native" alone: everyone has MCP now. It has to be the
bundle (frames, speakers, scenes, grounded index) and the push to the user's own agent.

**Who to build for after Robin:** developers and small teams already running coding agents, whose calls
are about what to build. They are few next to sales and recruiting teams, but they are the people for
whom a frame of the shared screen turns into a pull request, and they install a CLI without help. A
general meeting-notes audience would want a notes UI, a team workspace and an admin console, which is
the bloat Robin wants to avoid.

## Open decisions

| Decision | Owner | Default if undecided |
| --- | --- | --- |
| Which browser to support first | Robin | **Arc** (decided 2026-11-05) |
| Where calls are processed | Robin | **On the Mac** with whisper.cpp, already installed (decided 2026-11-05); Gladia by setting |
| Automatic recording for Robin's own calls | Robin | **Every Meet call** (decided 2026-11-05) |
| Whether calls go in threads | Robin | **No; calls stay local**, threads in the Mac app are for walkthroughs (decided 2026-11-05). Excerpts into threads later ([Calls into threads](#calls-into-threads)) |
| Apple Developer Program | Robin | **Not now** (decided 2026-11-05): a free stable signing identity on this Mac only |
| Where the Mac app's code lives | Robin | `mac/` in this repository, sharing the docs and the bundle format |
| Which apps the display capture leaves out | Robin | Messages, Mail and the password manager |
| Whether notification banners (`com.apple.notificationcenterui`) are left out too (raised by the review of 2026-11-05) | Robin | Not left out; whether excluding it hides banners is untried. The answer goes in C3 |
| Whether C12's 30 s of silence should count only while the microphone hears Robin (raised by the review of 2026-11-05: waiting alone in a call can set it off) | Robin | No, as built: it counts while Arc plays sound and the tap is silent, and the warning clears once the others are heard |
| Headphones | Robin | Not assumed; echo removal (P2) is in the MVP |
| Whether the call's reading (P7) belongs in Polydance at all | Robin | Yes, as an index grounded in quotes; prose summaries stay with the agent. Not in the MVP |

## Risks

- **The bundle is not better than Gemini's notes.** M0 tests exactly this, before any app exists.
- **macOS's screen prompt makes automatic video unpleasant.** About once a month, at the start of
  capture. C11 keeps the words whatever happens; C13 tries to move the question out of calls; spike MA
  measures it. The fallback is automatic audio with video started by one click in Apple's picker, which
  reportedly needs no screen permission at all.
- **Meet changes its URLs or how it holds the microphone.** Detection is two signals and records why it
  started and stopped, so a change shows up as `short` or missed recordings rather than silence.
- **Other people's data.** Voices, faces and shared screens of people who did not install anything.
  Local processing by default, PV2 to PV6, and the consent design before a second user.
- **Storage.** An hour a day at the C2 target is up to 20 GB a month of video. Retention is not designed;
  until it is, the video is the user's to delete.
- **New Apple APIs.** Core Audio process taps are recent and gained options in 26; window-title rules
  changed in a 27 beta; ScreenCaptureKit's track mixing changed in 27. Robin's Mac runs 15.8, two major
  versions behind current, so spike MA's results hold for 15 and must be repeated on 27.
