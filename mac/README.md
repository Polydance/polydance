# Polydance for Mac

A menu-bar app, named Polydance (it was "Polydance Capture" until 2026-11-06; the bundle id
`net.polydance.capture.mac` is unchanged, so permissions carry over), that records Google Meet calls in Arc by itself, and walkthroughs by hand, and hands each
recording to `polycap import` and `polycap process`. It captures and transports; it never transcribes,
extracts frames or calls a model ([docs/MAC.md](../docs/MAC.md), "Shape"). Status lives only in
`private/docs/ROADMAP.md`.

## Build

```sh
cd mac
./build.sh test               # swift test (PolydanceCore, and the app's writer on synthetic sound)
./build.sh build              # release build, "build/Polydance.app", signed; and the speaker reader
./build.sh speakers           # build/polydance-speakers alone: polycap's speakers step runs it (docs/MAC.md P3a)
./build.sh probe              # the built app's self-check, launched with `open` so the grants it reads are the app's: prints JSON, touches no permission
./build.sh install            # copy to ~/Applications, replacing an older copy; never launches it
./build.sh snapshots <dir>    # draw the look (parts, control panel, menu, thread rows, window) into PNGs, no hardware
./build.sh tabs [app]         # ask Arc for its tabs once, as the detector does, under the app's grant: tab count, codes, Meet's address form
```

`build` signs with the first "Apple Development" certificate in the keychain, or with
`POLYCAP_MAC_SIGN_IDENTITY`. It must be the same identity every time: macOS ties every permission to the
signature. `--adhoc` signs ad hoc and warns that macOS will ask for every permission again after each
build. The commit is recorded in Info.plist (`PolydanceCommit`, with `-dirty` for uncommitted changes)
and goes into each recording's `appBuild.commit`.

The icons are Polydance's logo, the ballerina (`app/android/app/src/main/res/drawable-nodpi/polydance_mark.png`):
the app icon on a charcoal square, and in the menu bar her silhouette, in the menu bar's colour while
watching, red beside the clock while recording and amber while building. `design/icons.py` draws them
into `App/Resources/`, and every other platform's icon in the app icon's style ([DESIGN-SYSTEM.md](../docs/DESIGN-SYSTEM.md#one-app-icon)), (committed, so a build needs no Python); `build.sh` copies them and the logo
itself, which the menu's header shows, into the app. `install` removes a copy still named
`Polydance Capture.app` in `~/Applications` when its bundle id is this app's.

The look is the headset app's ([docs/DESIGN-SYSTEM.md](../docs/DESIGN-SYSTEM.md)): the menu is the deck (a
cream top plate with the logo, the black control panel with READY, PROCESSING and REC lamps, the rolling
counter, MIC and ARC needle meters while recording and the red REC/STOP key, then calls and threads on a
black panel behind two chips), the window is the headset's one panel on the wooden cabinet, and threads
are listed as the headset lists them. Colours come only from `Sources/PolydanceShared/Palette.swift`, which
must match `design/tokens.json` (`npm run check` says when it does not).

## Layout

| Path | Owns |
| --- | --- |
| `Sources/PolydanceCore/` | Logic tested without hardware: the call detector (`CallDetector`), Meet codes and Arc's tab answer (`MeetLinks`), the import metadata (`RecordingMeta`, `RecordingFacts`), what to do when the screen capture stops mid-call (`ScreenRecovery`, C14) and free disk space (`DiskSpace`, C15), file layout and the only deletion (`RecordingFiles`), the hand-off ledger and queue, settings, polycap's commands and environment (`Polycap`, `PolycapRunner`, and `PolycapCalls` for threads, upload and hooks, with the upload ledger), what the window reads from a session folder (`SessionFiles`, `BundleFiles` for frames.json and transcript.json, `CallCatalog`), the routine (`Routine`: hooks list and run, the resume command, the documented hooks.json), polycap's thread output, a reply's target and the Meet guard (`Threads`) and the System Settings panes (`Permissions`). Swift 6 language mode. |
| `Sources/PolydanceShared/` | What the Mac and the iPhone share, built for macOS 15 and iOS 26 (docs/IPHONE.md I1): the look (`Palette`, `Theme`, `Cabinet`, `Deck`, `Pieces`), the parts of it that are computed (`RetroLook`), the thread models and launches (`Threads`) and how times are written (`MetaTime`). No `Process`, AppKit or UIKit. Swift 6 language mode. `ios/project.yml` depends on this package for this product only. |
| `Sources/PolydanceCapture/` | The app, Swift 5 language mode (Core Audio IO procs, Carbon hot keys and AVFoundation delegates): `CoreAudioProcesses`, `ArcTabReader` (NSAppleScript), `Capture/` (ScreenCaptureKit, AVCapture mic, Core Audio process tap, one AVAssetWriter), `AppModel` (state and actions), `Models/` (the window's calls, threads and permissions, and where the windows are), `Views/` (the menu, the main window, the call and thread pages, the settings; the look is PolydanceShared's, with the Mac's own `ControlPanel` and `Logo`), `Notifier`, `Hotkeys`, `LoginItem`, `Probe`. |
| `Sources/SpeakerTiles/`, `Sources/PolydanceSpeakers/` | The speaker reader, `polydance-speakers` (docs/MAC.md P3a): who Meet showed speaking in a recorded call. `RingFinder` finds Meet's light-blue ring round the speaking tile in a frame's pixels, `TileNames` reads the name on the ringed tile with Vision (on the Mac), `SpeakerReader` decodes the video with AVFoundation a frame every 500 ms and writes the report polycap reads (`src/pipeline/speakers.ts` holds its schema). Not part of the app and needs no permission: polycap runs it from `build/`, as it runs whisper-cli. Swift 5 language mode. `--image <frame>` prints one saved frame's rings and names. |
| `Tests/SpeakerTilesTests/` | XCTest for the reader on synthetic Meet frames (a ring, none, two, a filled button of the same blue, the names Vision reads) and a four-second synthetic video written with AVAssetWriter; never a recorded call. |
| `Tests/PolydanceCoreTests/` | XCTest. The metadata test reads `../tests/fixtures/mac-call-meta.json`, the contract shared with the TypeScript side. `Fixtures/` is what polycap really wrote and printed, captured on 2026-11-05 (below). |
| `Tests/PolydanceSharedTests/` | XCTest for the computed look (`RetroLookTests`): Java's Random and String.hashCode, the wood, row times. |
| `Tests/PolydanceCaptureTests/` | XCTest against the app's own writer (`AssetWriterSink`) with synthetic sound and frames into temporary files: no microphone, screen or tap. The main window laid out for real, the icons as drawn, and `LookSnapshots`, which pictures the look when `POLYDANCE_SNAPSHOTS` names a folder and is skipped otherwise. |
| `App/` | Info.plist and entitlements (hardened runtime: microphone and Apple Events); `Resources/` the icons, drawn by `design/icons.py` from the logo. |

## What it does

- **Detects** a call once a second: Core Audio's process list says whether any `company.thebrowser…`
  process is running input (no permission needed); only then is Arc asked for its tabs (Automation,
  once), and only when Arc is already running. A tab on `https://meet.google.com/abc-defg-hij`, or on
  `https://meet.google.com/meet/abc-defg-hij` where Meet's redirect leaves it, plus the mic starts a recording. It stops when the mic has been released for 20 s, no tab has had the code for 5 s,
  you stop it, or after 4 hours; under 2 minutes is marked `short`.
- **Says when nothing is recording** (`MicWithoutCallWatch`): when Arc has held the microphone for 20 s
  and no tab is a Meet call, or its tabs cannot be read, a notification says so once per stretch of
  microphone use (a stretch ends when Arc has let go for 20 s), and the menu shows a line while it lasts.
  It names a Meet tab's address form (`meet.google.com/meet/<code>`, no code, no query) so a change in
  Meet's addresses shows, and never another site's. Only while automatic recording is on and nothing is
  recording; the notification can be turned off in Settings, Calls. Written after the first real call
  was missed with nothing on screen (2026-11-06).
- **Records** three independent sources into `<library>/mac/recordings/polydance-mac-<yyyymmdd>-<hhmmss>.mp4`:
  the display holding Arc's front window (ScreenCaptureKit, leaving out Messages, Mail, Passwords and this
  app, at most 1920 wide, 5 fps; the filter is rebuilt when one of them launches, unhides or the Space
  changes, and the metadata names only the apps that were really left out), the microphone raw (AAC mono;
  for a call the input Meet in Arc is using, read from Core Audio, else the system default with a note),
  and Arc's sound through a process tap (AAC stereo at 44.1 or 48 kHz whatever the output device runs at;
  the writer resamples). Audio never waits for the screen: without screen permission the recording is
  audio only and says so (`call.video: "none"`). Audio is never dropped because the encoder is busy, and a
  gap in a track (a microphone or output device lost and found again, noted with its time) is filled with
  silence so later sound keeps its time. Fragmented every 10 s, so a crash keeps what was written; the
  metadata beside it says `cut: true` until a clean stop rewrites it, lists only the audio tracks that got
  sound, and says `farEnd` only once it is known.
- **Hands over** each saved recording, one at a time: `node polycap.js import <file> --meta <meta> --json`
  then `process <id> --json`, with an explicit argument array and environment, always with the library the
  app resolved (the setting, `POLYCAP_ROOT`, `POLYCAP_ROOT` in polycap's env file, `~/PolydanceCapture`) as
  `POLYCAP_ROOT`. node and polycap are found once (settings, else `zsh -i -l`) and stored. Outcomes and
  polycap's pid while it runs go to `<library>/mac/handoff.json`, and an import never starts unless that
  file took the `importing` entry; output, whole even when a command fails, to `<library>/mac/logs/`. The
  app waits for `process` as long as the pipeline (4 h) and every configured hook's own `timeoutMinutes`
  allow. Retry and Finish building are decided from the ledger and the library: a recording already
  processed is not imported again, and an import cut off by quitting whose session exists is processed.
  Hand-offs an earlier run did not finish are listed at launch; quitting does not stop a running polycap,
  and one still running at the next launch is shown as such until it ends.
- **Says when its icon is hidden.** A full menu bar (above all beside a MacBook's notch) hides the icon and tells the
  app nothing, and then nothing shows that a call is recording. Every 5 s the window list says whether the icon is
  drawn (no permission needed; an auto-hidden menu bar counts as unknown); two hidden readings in a row post one
  notice a run and show a banner in the window. Opening the app again (Spotlight, Finder, `open`) opens the window,
  and clicking a notice does too; clicking the call-started notification does not, so it never covers the call.
- **Never deletes** anything but a discarded recording's own two files.

## The window, the settings and threads

- **Polydance** (Open Polydance in the menu, or open the app again) lists every session with `source.call`, newest first, read
  from `<library>/sessions/*/session.json` whenever the sessions folder changes and every 3 s while the
  window is open, and the threads from `polycap thread list --json`, a dot on what is new. A call's page
  shows its title (Claude's, else the id), times, Meet code, chips, the scene and mark frames from
  `frames.json`, the transcript with Me and Others, the routine's runs from `hook-runs.json` (Copy resume
  command gives `cd <hook cwd> && claude --resume <id>`; Run again is `polycap hooks run <id> --hook NAME
  --force`) and the bundle's files. Send to thread is shown as Later.
- **Calls and Threads, New thread and Report** (Robin's pick D of four mockups, 2026-11-16): the column's
  calls and threads are two folder tabs rising out of its panel (Threads with the count of what is new), and
  a strip of keys at its foot holds the gear (Settings), Report (the bug key's beetle) and New thread, the
  cream key with the red camera. New thread opens a cream plate over the window: IN is the projects from
  `polycap project list --capabilities --json` as chips (yours marked), and **+ New project** last where the
  receiver makes projects (`projects-new-v1`), which becomes a name field with Make (`polycap project new
  --json -- <name>`) and chooses the project it made. **Record a new thread** records a walkthrough with the
  Mic and Mac sound switches, opening nothing, and sends it with `polycap upload <file> --project KEY`
  when it stops: the thread's title comes from what was said. **Write it instead** posts a title with
  words, photos or both at once (`polycap thread new --project KEY --title=… --text=… --photo=…`, which
  needs the `post` scope for words alone) and opens the new thread. **Report** opens the headset's report
  plate in the Mac's words; Start recording records a walkthrough sent with `polycap upload <file>
  --report`, only to the Polydance team, and is greyed with why when the receiver takes no reports. Until
  they are sent, a new thread or a report being recorded, waiting, sending or refused is at the top of the
  Threads tab (Stop and send, Discard, Send again, Show file); a sent new thread's walkthrough is listed on
  the thread it opened, and a report's recording stays in the recordings folder, as a reply's does. Both
  are in `<library>/mac/uploads.json` from the moment they start, as replies are; a ledger from before
  them reads as replies.
- **Choosing the screen** (Robin, 2026-11-16: his report from the Mac said it started recording with no way to
  tell which screen; he asked for the pattern macOS's own ⇧⌘5 uses). Every walkthrough (Record a reply, Record and
  open, New thread, Report, ⌃⌥R or Record now with no call) first opens a layer over every display
  (`ScreenPicker`): in **Display** mode the display under the pointer is lit with an amber edge and the others
  dim; in **Window** mode the window under it (the frontmost ordinary window, never Polydance's own) is lit and
  everything else dims. A cream card on the display under the pointer names what a click records and what it is
  for; a click, Return, ⌃⌥R or Record starts it after a 3-second count, and Esc or Cancel puts it away. The
  choice is remembered and lit first next time. A display is recorded as before, less the listed apps; a window
  alone (`SCContentFilter(desktopIndependentWindow:)`), so nothing outside it is in the video. While it records,
  a thin red frame with a REC tab and its clock marks what is recorded; it is this app's window, so it is never in
  the video, and it follows a recorded window as it moves. Without the screen permission there is nothing to
  choose and it starts at once, audio only. Calls never ask: they record their own window (below).
- **A call records its window** (Robin, 2026-11-17: "only record the browser window with the call on"; it had
  recorded the whole display Arc was on). As the recording starts, the app asks Arc which of its windows shows
  the call's tab as its active tab, and that window's title (`CallWindow`, one Apple Event on the tab reader's
  queue); the one Arc window macOS lists with that title is recorded alone, as a walkthrough's window is, scaled to
  fill the picture if it is resized. The menu names it ("Meet – …, in Arc at 5 fps"). What the window shows is what
  is recorded: switch to another tab in it and that tab is in the video, not the call; present another window and
  it is not. When the window cannot be told (Arc does not answer, the call's tab is not the one shown, no window
  or two have its title), the call records the display as before, less the listed apps, and the recording's
  `videoNote` and the menu say why. `./build.sh tabs` also reports how many of Arc's windows it can find by title,
  and, for a call in an active tab, whether its window was found.
- **Which microphone, and a silent one** (2026-11-16, after Robin's first report from the Mac was 60 s of
  zeros: the default input was a virtual device, "Sessions Input 2ch"). With Mic on, New thread's and the
  report's plates name the input that will record (the system default, read every 2 s), in red with what to
  do when it is a virtual device or there is none. While anything records with the mic, one that has given
  nothing above −80 dBFS for 10 s since the start (`SilentMicMonitor`: never a pause, since a real
  microphone's room noise is far above that) brings a notification naming the device and a red line in the
  recording's banner; sound heard clears both.
- **A thread** (`polycap thread show KEY --json`, which marks it read) shows earlier messages one line
  each and the latest in full. Each launch has two keys (2026-11-07): Record and open records a
  walkthrough (display, mic, the Mac's sound) and opens the launch's https link in Arc, else the default
  browser; Just open opens the link and records nothing. Beside them, as on the headset (2026-11-11), a
  Settings key unfolds the RECORD panel with the **Mic** and **Mac sound** switches, amber with a dot while
  one is off, and the line under the keys says what will be recorded, naming a sound left out. The switches
  (also in Settings, Walkthroughs) are every walkthrough's: Record and open, Record a reply and the shortcut
  with no call. A sound switched off is never started and has no track; the deck's meter strip reads MIC OFF
  or SOUND OFF. They are locked while recording, and a call always records the mic and Arc's sound. App,
  version and model steps are said to be the headset's. When it stops it is sent with `polycap upload <file> --thread KEY
  --reply-to N --launch L --meta <meta> --json`, one at a time, and stays in the recordings folder. It is
  in `<library>/mac/uploads.json` from the moment it starts, so it is never imported as a local session; a
  failed or cut-off upload shows polycap's own words and Send again (polycap resumes). Text replies are
  `polycap thread reply KEY --text=<words> --json`, one argument, so a reply starting with a dash is not
  read as an option. A reply cannot be started while a Meet call is live, and one that catches a call is
  stopped and kept unsent with why; the upload is refused before polycap starts if the recording's
  metadata is missing or describes a call. Only a thread on screen is read with `thread show` (which
  marks it read); after an upload or reply, a thread nobody is looking at only refreshes the list.
  **Photos** (2026-11-07, docs/THREADS.md "Photos"): a message's photos are drawn from the copies `thread
  show` saved in `<library>/photos/<KEY>/`, and only from there (any other path polycap prints is not
  opened); one opens in Preview when clicked, and a message whose photos this token may not see says so. A
  reply takes up to ten photos: Add photo (a file), images dropped on the page, or ⌘V with an image on the
  clipboard or image files copied in the Finder (copied text still goes in the text field). A pasted image
  is kept as a private PNG in `<library>/mac/pasted/` until it is sent or taken out, and those left by an
  earlier run go at launch. Send runs `polycap thread reply KEY [--text=<words>] --photo=<path> … --json`,
  which converts, scales and strips each photo before it leaves.
- **Settings** has the board's sections: calls, the screen (excluded apps chosen as .app files, frames
  per second), transcription, the library and the routine's hooks (`polycap hooks list --json`; Edit
  hooks.json opens it, or after a yes writes the documented example, 0600, never over an existing file),
  open at login, node's and polycap's paths (Detect again asks the login shell afresh), the permissions
  (read without asking; Request asks; each opens its System Settings pane) and the receiver's status.
- While the window or the settings is open the app has a Dock icon and a menu bar, so ⌘-Tab finds it.

Shortcuts: ⌃⌥R records now or stops (a call when one is live, otherwise a walkthrough), ⌃⌥M marks the
moment.

## Verified, 2026-11-17 (a call records its window)

`CallWindowTests` (7): Arc's answer parsed with the title last; the script never launches Arc and makes its tab
separator outside Arc's `tell`; the window found by title among menus, slivers and another app's window of the same
title; the frontmost of two windows on the call; two windows with one title told apart only when both lists agree;
and every case that falls back to the display, with its words. `npm run mac -- test` 205 tests, 9 skipped, 0
failures. `./build.sh build`, then `./build.sh tabs` on this Mac (Arc 1.171.0, macOS 15.8, the built app launched
by launchd): Arc answered 2 windows, macOS listed 2 of Arc's ordinary windows with readable titles, and both of
Arc's windows matched exactly one by title, so the match a call relies on holds here. Merged into `main` at Robin's
OK and installed from `cbf6137` (built from the main checkout, not dirty), quit from Polydance's own Quit with nothing
recording and reopened through LaunchServices. `./build.sh tabs ~/Applications/Polydance.app`, launched by launchd:
commit `cbf6137`, screen recording allowed, 209 tabs; Arc answered for 1 of the 2 windows macOS lists (the script
passes over a window whose active tab it cannot read) and that one matched by title. **Not seen:** a call recorded
this way (no call was live), a window resized, minimised or closed mid-call, or Arc in full screen.

## Verified, 2026-11-16 (choosing the screen)

`ScreenTargetTests`: the display under the pointer (or the nearest, off every display), the frontmost ordinary
window under it with the menu bar, slivers and Polydance's own windows passed over, the card's names, and the
choice remembered (something unreadable is no choice). `./build.sh snapshots` drew the card in Display mode, in
Window mode and counting down. **Not seen:** the layer on real displays, pointing at windows, the count, a
window recorded alone, or the red frame, in the running app.

## Verified, 2026-11-16 (the microphone's name and a silent one)

`SessionAndQueueTests` prove the silence check flags 10 s of zeros once, clears when sound comes, and never
flags a pause after room noise was heard; and the plate's line for a microphone, a virtual device and none.
`./build.sh snapshots` drew the report plate with "Sessions Input 2ch" in red. **Not seen:** the line or
the notification in the running app.

## Verified, 2026-11-16 (Calls and Threads tabs, New thread, New project, Report)

Robin found all four missing from the Mac on 2026-11-16 with the build of `24da232` installed, which had all of
`main`'s Mac code; he picked D (folder tabs, a key strip, cream plates) of four mockups the same day. `npm run mac
-- test` 189 tests, 8 snapshot tests skipped, 0 failures: the walkthrough target as a reply, a new thread or a
report, checked before recording and read from a ledger written before them; `polycap upload --project` and
`--report`, `project list --capabilities`, `project new -- <name>` and `thread new` as argument arrays through a
fake node, and their output parsed strictly; the window's layout test now allows the folder tabs and still
refuses bare wood above them. `./build.sh snapshots` drew the Threads tab with a refused report at its top, New
thread's plate (recording, naming a project, writing it) and the report's plate, greyed on a receiver with no
reports project. polycap's side ran against the in-process receiver (`tests/upload.test.ts`): a new thread in a
project of your own, and a report the team sees with its bundle marked report. **Not seen:** any of it in the
running app or against capture.polydance.net, a real recording sent as a new thread or a report, New project
made from the app, Write it instead posting, or drop and Add photo on the plate.

## Verified, 2026-11-07 (photos in threads)

`swift test` 154 tests, 6 snapshot tests skipped: `ThreadsTests` read `thread show --json` with two photos from an
iPhone token, captured from polycap that day against `polycap serve` on 127.0.0.1, find each saved copy only at
its own path in the library, and run `thread reply --photo` through a fake node. `./build.sh snapshots` drew
`thread-photos.png`: a portrait and a landscape photo at their own shapes, the note for photos this token may
not see, and two photos waiting with their keys to take them out. **Not seen:** the page in the running app,
Add photo's panel, a drop, ⌘V, and Preview opening a photo; the app was not installed from this branch.

## Verified, 2026-11-07 (the top of the window)

Robin's screenshot of `20c09d6` showed about 47 points of bare wood above both panels and **no traffic lights**,
though the note below for `383054f` says they sat on the wood: that was never seen, and it was wrong.
`.toolbar(.hidden, for: .windowToolbar)` hid the window's buttons with the toolbar, and the content kept clear of
the title bar's strip. `fc8fe58` drops the toolbar modifier, runs the content to the top edge and puts the
column's header in the buttons' row, past them (`WindowChrome` reads where they are from the window; dragging the
header's wood moves the window). The page's panel starts 10 points down; an empty banner inset no longer adds 10.
`swift test` 151 tests, 5 snapshot tests skipped: `MainWindowLayoutTests` host the window as `.hiddenTitleBar`
sets it up and find the buttons shown and the column's panel 36 points down, just under their 28-point row.
The titled window snapshot shows the buttons, the header beside them, the page's panel at 10.5 points and the
column's at 36.5. Installed from `fc8fe58` and reopened; the app's own log
(`/usr/bin/log show --predicate 'subsystem == "net.polydance.capture.mac" AND category == "window"'`) read:
`main window 1240x800: title bar 28.0 pt, buttons shown, ending at 61.0 pt, middle at 14.0 pt (close button
visible), toolbar none, full screen false`. **Not seen:** the window on screen, dragging it by the header,
clicking Refresh in the buttons' row.

## Verified, 2026-11-07 (the column's width)

Robin's screenshot showed thread titles cut after a dozen letters ("Aura 2.0 tes…"): `NavigationSplitView` had
opened the column at its 250-point minimum, not its 300-point ideal, and it ignored both widths when hosted off
screen. `20c09d6` replaces it with a column of its own, 390 points wide (320 to 560), dragged on the wood between
the panels, kept in defaults (`mainWindow.columnWidth`) and put back by a double-click; one wood canvas lies behind
both panels. A title longer than the row takes a second line in the window; keys, pills, chips and tags keep
their print on one line. `swift test` 151 tests, 5 snapshot tests skipped: `MainWindowLayoutTests` find the
column's list inside a real titled window at 380 points (390 less its padding). `./build.sh snapshots` drew the
window and the thread rows at 280 and 350 points (the column's narrowest and usual rows): the 48-letter
"Aura 2.0 test builds: welcome menu, taiko, piano" fits on two lines at the usual width and is cut on its
second line at the narrowest. Installed from `20c09d6`; the window reopened (1240 by 800, on screen). **Not
seen:** the window on screen (this session cannot capture it), dragging the wood, the resize cursor.

## Verified, 2026-11-06 (the headset's look)

Installed from `f111864` and running; the probe, launched by launchd, still read the microphone as authorized and
screen capture as allowed. `swift test` 150 tests: `RetroLookTests` give `java.util.Random(42)`'s published values
and Java's `"hello".hashCode()`, the wood is the same for the same size, the receiver's people decode; the window
still lays out (`MainWindowLayoutTests`). `npm run check` 26 files, 505 tests, `tests/design.test.ts` among them.
`./build.sh snapshots` drew the parts, the control panel watching, recording and building, the menu with the
fixture call, the thread rows from the fixture thread list, and the window on that call; compared by eye with the
headset app 0.19.0's frames from Robin's recordings of 2026-11-05. **Not seen:** the app's own menu and windows on
screen (this session cannot capture them, and the menu-bar icon is still behind the notch), the settings window
(it needs an app bundle, so it has no snapshot), a real recording's meters.

Then, at Robin's word from a screenshot, the main window lost its grey title bar and toolbar (`383054f`: a hidden
title bar, no toolbar, no sidebar toggle, the wood under the traffic lights). `swift test` 150 tests; installed and
the window reopened (1240 by 800, on screen). Not seen from this session, which cannot capture the window.

## Verified, 2026-11-06 (the ballerina, the name, the warning)

The app is Polydance: `~/Applications/Polydance.app`, executable `Polydance`, bundle id unchanged. Installed from
`6560f77`; `build.sh install` removed `Polydance Capture.app` (same bundle id) and refreshed LaunchServices. The
built app's probe, launched by launchd, still read the microphone as authorized, screen capture as allowed and the
login item as on, so the grants carried over (whether the login item opens the renamed app is seen at the next login). Notification Center looked the app up as "Polydance" five seconds
after launch. `LogoTests` draw the committed images: an 18 pt template silhouette at 1x and 2x, red and amber
fills only inside her shape, the 256 px logo, an icon set from 16 to 1024 px. The running app's menu-bar item is
29 pt wide (the 13 pt silhouette plus padding). `MicWithoutCallTests` (11) cover the warning, including the
morning's case: the shape `meet.google.com/meet/<code>` named, and nothing said once MeetLink reads it. `swift
test` 140 tests, `npm run check` 25 files, 500 tests. **Not seen:** the icon itself, since the relaunched item
went to the far left, behind the notch (x 795 on a 1512 pt display, window not on screen); the warning firing
for real (it needs Arc on the microphone for 20 s with no Meet call).

## Verified, 2026-11-06 (the first real call, missed)

Robin's first Meet call in Arc, 10:01 to 11:01, was not recorded. Control Center's log shows Arc holding the mic
for the hour, and the app's first question to Arc went at 10:01:14, a second after Arc took the mic. Arc's
history shows why it found no call: Meet redirected `meet.google.com/<code>` to `meet.google.com/meet/<code>?authuser=0`,
and the detector only read the first form. Fixed in `bf39567`; `MeetLinkTests` now take both forms and agree with
the rule's regular expression. `./build.sh tabs` is new: run on the built app and on the installed one, both
launched by launchd, Arc answered with 255 tabs in 219 and 230 ms under the app's own grant, no prompt (the Meet
tab was on `/home` by then, so no code). `swift test` 125 tests, all passing. **Not exercised:** a recording,
the system-audio prompt, Meet's lobby and mute, leaving a call. The next call is the first that can record.

## Verified, 2026-11-05 (first launch)

Robin's first `open` started the app and showed nothing: macOS had hidden its menu-bar icon for lack of room (the
window list put it at x = 547, off screen). After the fixes, on this Mac: launched with `open`, the icon still hidden,
the app's notice raised the notification prompt; `open` again opened the window, which showed the calls (none), 29
threads from the receiver, Settings and the hidden-icon banner. Before the second fix the same window was laid out
3,795 points tall and looked empty; `MainWindowLayoutTests` (the real window at 1240×800, an empty library in a
temporary folder) failed with those numbers and passes now. `swift test` 124 tests, all passing, no warnings.
**Not exercised:** the menu (hidden), any capture permission, a delivered notification (the first prompt was
declined), a recording.

## Verified, 2026-11-05 (the review's fixes)

On Robin's Mac: `swift build` with no warnings; `swift test` 115 tests, all passing, with no warnings,
once docs/MAC.md had the narrowed routine example (Edit(notes/**), polycap show, transcript and frames,
git add, commit and push, in place of `Bash(polycap *)`) that `testTheHooksExampleIsTheOneInTheDocs`
compares with the app's; `./build.sh build` signed with the Apple Development identity. New:
`PolydanceCaptureTests` runs the app's writer on synthetic PCM and frames. Every tap rate from 16 to 96
kHz is encoded at 44.1 or 48 kHz at 160 kbps and the writer finishes, with the track as long
as the sound sent (the review measured the old settings crashing at 88.2 and 96 kHz and failing at 16 to
24 kHz); settings the encoder refuses are an error, not an exception. Thirty seconds of held sound in
timestamp order are written whole (dropping on a busy encoder, as the old sink did, lost 1684 of 2812
call-sound buffers in the same test); a 3 s gap is filled so the track lasts 7 s (4 s without the fill,
also checked); a dropped stretch becomes silence once; a track that got no sound
is not claimed; a late real frame is written 1 ms after a repeat. In the core: one outcome per
recording, Retry decided from the ledger and the library, no import while the ledger cannot be written,
polycap's pid kept while it runs and recognised from its arguments, a timed-out child killed with its
process group, the library from polycap's env file, and the upload refusing a call's metadata or none.
**Not exercised:** the app was not launched, so nothing here ran on a real call: not the tap at a
Bluetooth headset's or an interface's rate, the tap's stream order with an output device that has
inputs, the clock device unplugged mid-call, Arc's input device read during a call, a microphone
unplugged and restarted, Passwords opened mid-call and left out of the frames, `./build.sh probe` through
`open`, or the app quit with a polycap still running.

## Verified, 2026-11-05 (the window, settings and threads)

On Robin's Mac: `swift build` and `swift build -c release` with no warnings; `swift test` 90 tests
passing (30 of them new: session.json, frames.json, transcript.json speakers, hook-runs.json, hooks list
and run, thread list, show and reply, upload, the upload ledger, the calls catalog, the hooks.json
example against docs/MAC.md, and the runner's thread, upload and hooks commands as argument arrays
through a fake node); `./build.sh build` signed with the Apple Development identity (hardened runtime,
`codesign --verify --strict` passing). The fixtures were captured by running polycap's own code: a 20 s
call built with real ffmpeg, the fake whisper-cli and the fake Messages API, its hooks run, and the
thread commands and an upload against polycap's receiver run in process on 127.0.0.1. `polycap hooks
list --json` was run on this Mac (no hooks.json yet), and Node's strict parser was seen to refuse `--text
-x` and take `--text=-x`. **Not exercised:** the app was not launched, so no window, sheet, permission
prompt, Request button, NSOpenPanel, folder watcher, Arc opening a link, Dock switching or notification has
run; nothing was sent to the hosted receiver.

## Verified, 2026-11-05 (the core)

On Robin's Mac (macOS 15.8, M3 Pro, Swift 6.2.4): `swift build` with no warnings, `swift test` 60 tests
passing, `./build.sh build` signed with the Apple Development identity (hardened runtime), `--probe` run
from the built app, and the Arc tab script compiled with `osacompile` (not run). **Not exercised:** a real
recording, any permission prompt, the tap, ScreenCaptureKit, Apple Events to Arc, notifications, hot keys
and the menu itself. None of those has run yet.
