# Following up a recorded call

The worked example of a call routine (docs/MAC.md H5, S2), as polycap's hooks run it from 2026-11-05.
Polydance's part ends when the bundle is ready and the hook has run; the routine itself (notes, a commit,
a Slack draft) lives in a repository of the user's own and changes without Polydance changing. Tested
with a fake hook on 2026-11-05, not yet with `claude` on a real call.

## 1. What runs, and when

`~/.config/polycap/hooks.json` (or the file `POLYCAP_HOOKS` names), a file of your own with mode 600
(polycap refuses one others can read or write):

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

`polycap process` runs it once for each call it finishes (the Mac app runs `polycap process <id>` after
every call), never for a call marked `short` or shorter than `minMinutes`, and never while a pipeline step
is pending. While transcription has failed it is recorded `skipped`, and the `polycap process <id> --step
transcribe --force` that fixes it runs the hook. Nothing passes through a shell: `{dir}`, `{id}` and
`{title}` are replaced inside single arguments. `polycap hooks list` shows the file as polycap reads it
and `polycap doctor` checks it.

The run gets:

- **Its folder:** `cwd`, here `~/Code/calls`, the repository that holds the routine and the notes:
  `~`, `~/…` or an absolute path, never a relative one.
- **Its environment:** polycap's own, less polycap's secrets and anything from a Claude session around
  it (every `ANTHROPIC_*`, `CLAUDE_CODE_*` and `CLAUDE_AGENT_SDK_*` variable, `CLAUDECODE`, `CLAUDE_PID`,
  `CLAUDE_EFFORT`, `GLADIA_API_KEY` and polycap's tokens), plus the hook's `env`, which can set any of
  them again, plus `POLYCAP_SESSION_ID`, `POLYCAP_SESSION_DIR` and `POLYCAP_HOOK`.
- **One line of JSON on stdin**, facts and paths only, never what was said:

  ```json
  {"version":1,"hook":"call-routine","id":"2026-11-05T11-00-02_meet","dir":"/Users/someone/PolydanceCapture/sessions/2026-11-05T11-00-02_meet",
   "title":"Google Meet abc-defg-hij in arc 2026-11-05 11:00","mode":"call","recordedAt":"2026-11-05T11:00:02.120Z","durationMs":3133000,
   "hasVideo":true,"call":{"app":"meet","meetingCode":"abc-defg-hij","stopReason":"left-call","video":"recorded","farEnd":"heard","told":"unknown"},
   "marks":2,"frameCount":64,"markerCount":5,"steps":{"probe":"done","transcribe":"done","frames":"done","storyboard":"done"},
   "files":{"session":".../session.json","storyboard":".../storyboard.md","transcript":".../transcript.md","frames":".../frames.json"}}
  ```

  (shortened here: `call` and `steps` carry every field session.json has). `claude -p` appends piped
  stdin to its prompt, so Claude sees this line after the prompt's own text. That is harmless: it is
  facts and paths, and its `title` is one line. A script hook can parse it.

## 2. The routine, as a skill in that repository

`~/Code/calls/.claude/skills/process-call/SKILL.md`, for example:

```markdown
---
name: process-call
description: Follow up a call that Polydance recorded on this Mac. Use when asked to process a Polydance call.
---

1. The bundle's folder is in the prompt. Read it with the polydance-capture skill: `polycap show <id>`,
   then storyboard.md from the top. The header says who spoke (Me is Robin; Others is everyone else,
   unnamed), whether the screen was recorded, the marks, and what is missing.
2. Use the Scenes outline to find what was shown; open a frame only when its content matters, and the
   full-size copy in frames/full/ to read text on it.
3. Write notes/<date>-<meeting code>.md: one paragraph of what the call was for; decisions, actions
   (with the owner only when someone said who) and open questions, each with its clock and a short
   quote; every mark, with what was being said at it; frames cited by clock and path, never copied.
   If a previous call with this meeting code exists, what it left open and whether this one closed it.
4. git add the note, commit it with the message "Call <date> <meeting code>" and push. Nothing else
   from the bundle goes into the repository: no transcript, no frames.
5. Draft the Slack summary as a message to Robin only, never to the channel: five lines at most, no
   private asides, no frame that shows anything but the call's subject.
6. End with one line of bundle feedback: what the bundle could not tell you.
```

`--allowedTools` lists exactly what those steps need: `Read`, `Glob`, `Grep` and three read-only polycap
commands for steps 1 and 2 (not `Bash(polycap *)`, which would let words from the call drive `thread
reply`, `upload` or `sync`), `Edit(notes/**)` for step 3 (Claude Code's Edit rules cover writing a new
file), and git add, commit and push for step 4. Add the Slack connector's draft tool for step 5 by the
name `/mcp` lists. With `--permission-mode dontAsk` anything not allowed is refused, so a routine that
forgets a tool does nothing rather than everything; polycap writes the refusals Claude Code reports into
the run's note (`claude denied 1 tool call (Write)`). The Slack and GitHub connectors load
only on the claude.ai login: a run the app started must be checked once to have loaded them. polycap
leaves `ANTHROPIC_API_KEY` out of the hook's environment so Claude Code uses that login; set it in the
hook's `env` only if the routine should bill the API key.

## 3. After the run

- `polycap show <id>` lists each hook's run: status, exit code, Claude's session id and the line to
  continue the conversation, `cd ~/Code/calls && claude --resume <session id>`. `--name` ("Call: …")
  makes it easy to find in `/resume` as well.
- `hook-runs.json` in the bundle has the same, and `hooks/call-routine.log` the run's output (Claude's
  JSON result, the first 1 MB). The Mac app's call page reads both.
- A run whose Claude was refused a tool is still `done`, with `claude denied N tool calls (…)` in its
  note: widen `--allowedTools` and run it again.
- A run past `timeoutMinutes` gets SIGTERM with everything it started, then SIGKILL 5 s later, and is
  recorded as `timeout`. When polycap itself is stopped (Ctrl-C, or SIGTERM to its pid) the run is
  stopped the same way, with 3 s of grace, and recorded `failed` with `stopped: polycap got SIGINT`.
  Quitting the Mac app does not stop either: the polycap it started finishes and records the run. A run
  whose polycap was killed outright is marked `interrupted` next time. None is started again by itself.
- To run the routine again, for example after changing its skill: `polycap hooks run <id> --hook
  call-routine --force`. Named this way it runs even for a call its filter skipped.

## Rules for anything posted outward

The routine is the user's, and so is what it posts, but a call holds other people's voices, faces and
screens. Draft first and show the user until they say the recipe may post by itself. Never quote a
private aside, and never post a frame showing something other than the call's subject without the
user's OK: open the frame and look before using it. Calls stay on the Mac: never upload the call or
its files to the hosted receiver or a thread.
