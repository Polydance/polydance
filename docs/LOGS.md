# Logs in a take

Robin, 2026-11-16: recording a reply should be able to keep the headset's logs, as one of the reply's
switches, so that when someone tries a WebXR page in the browser, or a native build, the bundle holds what the
device logged while they did. It must be possible to record a reply with the microphones and the picture off
that still sends its logs.

Before this, a take sent no logs at all. The headset kept Polydance's own event timeline (`timeline.jsonl`)
in the run folder and never sent it; the upload carried only which app was in front (`apps`, from Usage
access) and what Polydance opened.

## What each headset can read

| Headset | What "Logs" can hold | Why |
| --- | --- | --- |
| Quest (Horizon OS, Android 14) and Android XR, a development build | Every app's log for the take (the browser, a Unity or OpenXR app, the system), once the headset has granted Polydance `READ_LOGS` over adb (`npm run app -- logs`), and each time the person allows Android's own prompt. Without the grant, only Polydance's own lines. | `READ_LOGS` is a development permission: an app cannot ask for it, only `adb shell pm grant` gives it. From Android 13, an app holding it that reads the log makes the system ask "Allow Polydance to access all device logs?"; it asks only while the app is on top, declines on its own for an app in the background, and the answer holds for 60 s (AOSP `LogcatManagerService`: `PROCESS_STATE_TOP`, `STATUS_EXPIRATION_TIMEOUT_MILLIS = 60 * 1000`). Declined, an app still reads its own lines. |
| Quest and Android XR, a store build | Polydance's own lines only, always. | Meta prohibits `READ_LOGS` in store apps and its upload check rejects a build that declares it, so only debug builds declare it (`src/debug`); a build that does not declare it cannot be granted it. |
| Apple Vision Pro | Nothing worth sending, so the Vision Pro has no Logs switch. | visionOS gives an app its own process's log only (`OSLogStore` scope `.currentProcessIdentifier`); Safari's console and other apps' logs are out of reach. Safari's Web Inspector from a Mac is the way to see a page's console. |

Not known yet, and only the headset can say: whether the Meta Quest Browser writes a page's `console.log` to
the Android log at all (Meta documents Chrome DevTools over adb for a page's console, not logcat), whether
Horizon OS shows Android's prompt, and how much the log buffer holds (`adb logcat -g`).

So on Quest a take reads the log when it stops, from the deck: that is when Polydance is on top for Android's
prompt. A take stopped from the notification, or by its time limit, reads Polydance's own lines only, and its
logs say why.

## The switches

A reply's Settings, and the deck's own switches, are Screen, Mic, App sound and Logs, kept in the `settings`
preferences as `screen`, `mic`, `appAudio` and `logs`, all on by default. App sound needs Screen: playback
capture rides on the screen-capture token, so with Screen off App sound is off and its switch cannot be turned
on.

| Screen | Mic | Logs | The take |
| --- | --- | --- | --- |
| on | any | any | `video.mp4`, as before, with `logcat.txt` when Logs is on |
| off | on | any | `audio.m4a`, the microphone alone (AAC, 48 kHz mono, 128 kbps), with `logcat.txt` when Logs is on |
| off | off | on | logs alone: `logcat.txt` and nothing else; no screen-capture prompt, no microphone |
| off | off | off | nothing to record: the Record key says so and records nothing |

## The logs file

When a take with Logs on stops, the headset runs, once:

```
logcat -d -b main,system,crash -v threadtime -v epoch -v uid -v printable -T <zeroAt as seconds.millis>
```

and keeps what it prints, up to 32 MiB, as `logcat.txt` in the run folder, beside `logs.json`:

```json
{
  "version": 1,
  "bytes": 123456, "sha256": "…",
  "zeroAt": 1763290000123,
  "readAt": 1763290160456,
  "scope": "device",
  "truncated": false,
  "note": "…",
  "packages": { "10123": "com.oculus.browser" }
}
```

- `zeroAt`: the take's 0:00 on the headset's wall clock, in ms: when the recorder started (the video's first
  frame), or when a logs-only take began.
- `scope`: `device` when the file holds lines from another uid than Polydance's, else `app`.
- `note`: why the scope is `app` when it is, in words a person reads: no grant (with the adb command), the take
  stopped while Polydance was not on top, or the prompt declined or unanswered.
- `packages`: the package for each uid in the file (PackageManager), at most 300.
- `truncated`: the 32 MiB limit was reached; the file is the first 32 MiB.

The headset does no other processing: the receiver's pipeline reads the lines. logcat prints the uid as `%5d:`
(or a short name, `root:`) straight against the pid's `%5d`, so a five-digit pid follows the colon with no space
(AOSP `liblog/logprint.cpp`, android14-release); both readers, the headset's (`DeviceLogs.uidOf`) and the
pipeline's (`src/pipeline/logs.ts`), are tested on that layout.

## On the headset (Quest and Android XR)

- **The switches.** The deck has "Record the screen" and "Keep the headset's logs" beside the mic and app sound,
  and a reply's Settings shows Screen, Mic, App sound and Logs; they are the same preferences. With Screen off the
  APP meter's switch and App sound's chip are locked off and say why. The line under a launch's keys says what Record
  will record ("records logs only, then opens …"). The bug key's reports are as before: the picture, never logs.
- **Sound alone** is the recorder service as a microphone foreground service, started from the deck, writing
  `audio.m4a` with MediaRecorder; there is no screen-capture prompt.
- **Logs alone** (`LogsTake.kt`) has no service: nothing records while it runs, and no foreground-service type
  describes that. The take is its run folder (`run.json` with `zeroAt`, no `summary.json` until it stops); at every
  process start the newest unstopped one is put back on the deck, so Polydance being killed in the browser does not
  lose it. Its notification opens the deck and has no Stop, which would read the log from the background. It has no
  time limit.
- **At Stop**, `RunFolder.handOff` reads the log off the main thread (the recorder service stays in the foreground
  meanwhile; the deck says it is reading the headset's logs) and only then queues the upload with the usual hold. A
  take whose process ended before its log was read reads it when its upload next runs.
- **Granting** (development builds): `npm run app -- logs [--platform quest|android-xr]` runs the `pm grant` and reads
  back `dumpsys package`; it refuses a build without the permission, and refuses while recording (the grant
  restarts the app) unless `--force`.
- **The notice** is `capture-hosted-3`: it says what Logs sends. The receiver still takes uploads under
  `capture-hosted-2` and `-1`, and the app asks again before a new recording.

## Upload

`POST /v1/uploads` gains:

- `logs`: `{ bytes (1 to 32 MiB), sha256, zeroAt, scope, truncated?, note?, packages? }`, as in `logs.json`.
- `durationMs`: the take's length, needed when there is no media file.
- `bytes`, `sha256` and `fileName` describe the media file and are now optional together: a take of logs alone
  has none of them and must declare `logs` and `durationMs`. `fileName` may end in `.m4a` (sound alone).

`PUT /v1/uploads/:id/logs` sends the declared file whole (`Content-Length` = `logs.bytes`), checked against its
sha256, while the upload is `uploading`. The client sends it first, before the narration and the media. For a
take of logs alone its arrival completes the upload (`received`). A view of an upload says `logs: expected |
received` when it declared some, and `content: video | sound | none`.

In a thread, a recording message's view also says `content`, and `logs: true` when it has logs; a client shows
a take with no picture without a player for the picture.

## The bundle

The pipeline's `logs` step, after `probe`:

- `logcat.txt`: the file as the headset sent it.
- `logs.txt`: each line on the take's clock, `[01:02.345] E chromium (com.oculus.browser): …`, from 0:00 to the
  end of the take; lines read after it ended are left out and counted.
- `logs.json`: the scope, the note, counts by level and by app, the first and last clock, what was left out
  (before 0:00, after the end, not in logcat's shape), and the first 300 errors (E and F) with their clocks. A
  first line more than 10 s after 0:00 is said in `logs.txt`'s head and the storyboard: the buffer may have
  dropped the start of a long take.

`storyboard.md` gains a Logs section saying whose lines they are and how many, and shows the first 40 errors
among the transcript's lines at their moments (or lists them, when there are no words). The summary is still
written from the words alone. A take of logs alone is probed from nothing: its length is the `durationMs` it
was sent with; probe, audio, transcribe, frames, pointing and markers are skipped, and its storyboard says
"Logs alone". `polycap show` lists `logs.txt`, and `polycap sync` brings the three files down with the rest.

The Mac, the iPhone and the Vision Pro show a thread's recordings as a line, not a player: theirs say "Logs
only" or "Sound only" for a take with no picture, and "with logs" for one that sent its log (PolydanceShared).

## Status

Built 2026-11-16 on branch `claude/reply-recording-logs-f90856` and merged into `main` the same day at Robin's OK; the
receiver's side live since 16:10 UTC that day (`7fb799e`, `private/docs/OPERATIONS.md`); on no headset. Checked
off the headset on 2026-11-16 (the roadmap's row has the counts): `npm run check`, both Android flavors' unit tests,
lint and builds, `verify-manifests.py` (READ_LOGS in debug builds only), and `npm run mac -- test`. The iPhone and
Vision Pro apps were not compiled: Xcode's iOS 26.2 and visionOS 26.2 platforms are not installed on this Mac.

Only a headset can say:

- whether Horizon OS and Android XR show Android's "access all device logs" prompt, and whether a read from the
  deck counts as on top (the headset uses `IMPORTANCE_FOREGROUND`);
- that `pm grant … READ_LOGS` takes effect (it restarts the app) and reads then hold other uids;
- that `-b crash` and `-T <epoch.millis>` work there, and the line layout read from AOSP;
- whether the Quest Browser writes a page's `console.log` to the log, and how much the buffer holds;
- that a microphone-only foreground service records on in the background, and `audio.m4a` plays in the player;
- that a take of logs alone comes back after its process is killed, and after a reboot (its note says the log
  before the reboot is gone).

Not built: a time limit for a take of logs alone; `npm run app -- pull` and `analyze` still expect `video.mp4`;
`packages` names only the apps Polydance can see (Android's package visibility); the Vision Pro has no Screen
switch (its take is ReplayKit's broadcast); `polycap import` takes no logs (Polydance's takes bring them by upload).

Rollout: the receiver first, done on 2026-11-16. A receiver older than `7fb799e` refuses a tester's upload made
under `capture-hosted-3`, and a take with no media file; a take with media drops its logs and length and still goes.
