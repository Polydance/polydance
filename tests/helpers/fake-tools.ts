/** Fake adb, whisper-cli and polydance-speakers shell scripts. Nothing here touches a real device, model or recording. */
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../../src/exec.js';

const FAKE_ADB = `#!/bin/sh
# Fake adb: the "device" folder /sdcard/Oculus/VideoShots maps to $FAKE_REMOTE_DIR.
set -e
if [ "$1" = "-s" ]; then shift 2; fi
# Size and mtime as the headset's toybox stat reports them; GNU stat (Linux, CI) and BSD stat (macOS) differ.
size() { wc -c < "$1" | tr -d ' '; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
cmd="$1"; shift
case "$cmd" in
  version) echo "Android Debug Bridge version 0.0.0-fake" ;;
  devices) printf 'List of devices attached\\nFAKE123 device product:quest model:Quest_3 device:eureka transport_id:9\\n' ;;
  shell)
    line="$*"
    case "$line" in
      "getprop ro.product.manufacturer") echo Oculus ;;
      "getprop ro.product.brand") echo oculus ;;
      "getprop ro.product.model") echo "Quest 3" ;;
      "getprop ro.build.version.release") echo 14 ;;
      stat*)
        for f in "$FAKE_REMOTE_DIR"/*.mp4; do
          [ -e "$f" ] || continue
          printf '%s %s /sdcard/Oculus/VideoShots/%s\\n' "$(size "$f")" "$(mtime "$f")" "$(basename "$f")"
        done ;;
      sha256sum*)
        p="\${line#sha256sum }"; p="\${p#\\'}"; p="\${p%\\'}"
        f="$FAKE_REMOTE_DIR/$(basename "$p")"
        printf '%s  %s\\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$p" ;;
      *) echo "fake adb: unsupported shell command: $line" >&2; exit 1 ;;
    esac ;;
  pull)
    [ "$1" = "-a" ] && shift
    cp "$FAKE_REMOTE_DIR/$(basename "$1")" "$2" ;;
  *) echo "fake adb: unsupported: $cmd" >&2; exit 1 ;;
esac
`;

const FAKE_WHISPER = `#!/bin/sh
# Fake whisper-cli: writes a fixture to the -of prefix, like the real -oj flag does. With
# $FAKE_WHISPER_DIR set, a file there named after the input wav (mic.wav -> mic.json) wins, so a
# call's two tracks can say different things; otherwise every input gets $FAKE_WHISPER_JSON. With
# $FAKE_WHISPER_ARGS set, each run appends its arguments there, one line per run.
[ -n "$FAKE_WHISPER_ARGS" ] && echo "$*" >> "$FAKE_WHISPER_ARGS"
prefix=""; wav=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of) prefix="$2"; shift 2 ;;
    -f) wav="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$prefix" ] || { echo "fake whisper-cli: no -of" >&2; exit 1; }
[ -s "$wav" ] || { echo "fake whisper-cli: no audio at $wav" >&2; exit 1; }
fixture="$FAKE_WHISPER_JSON"
if [ -n "$FAKE_WHISPER_DIR" ] && [ -f "$FAKE_WHISPER_DIR/$(basename "$wav" .wav).json" ]; then fixture="$FAKE_WHISPER_DIR/$(basename "$wav" .wav).json"; fi
cp "$fixture" "$prefix.json"
`;

const FAKE_SPEAKERS = `#!/bin/sh
# Fake polydance-speakers: copies $FAKE_SPEAKERS_JSON to --out, as the real one writes its report there.
# With $FAKE_SPEAKERS_ARGS set, each run appends its arguments there.
[ -n "$FAKE_SPEAKERS_ARGS" ] && echo "$*" >> "$FAKE_SPEAKERS_ARGS"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || { echo "fake polydance-speakers: no --out" >&2; exit 2; }
[ -n "$FAKE_SPEAKERS_FAIL" ] && { echo "fake polydance-speakers: $FAKE_SPEAKERS_FAIL" >&2; exit 1; }
cp "$FAKE_SPEAKERS_JSON" "$out"
`;

export async function fakeTools(): Promise<{ dir: string; adb: string; whisper: string; model: string; speakers: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'polycap-tools-'));
  const adb = join(dir, 'adb'), whisper = join(dir, 'whisper-cli'), model = join(dir, 'fake-model.bin'), speakers = join(dir, 'polydance-speakers');
  await writeFile(adb, FAKE_ADB); await chmod(adb, 0o755);
  await writeFile(whisper, FAKE_WHISPER); await chmod(whisper, 0o755);
  await writeFile(speakers, FAKE_SPEAKERS); await chmod(speakers, 0o755);
  await writeFile(model, 'not a real model');
  return { dir, adb, whisper, model, speakers };
}

export async function hasFfmpeg(): Promise<boolean> {
  try { await exec('ffmpeg', ['-version'], { allowFailure: true }); await exec('ffprobe', ['-version'], { allowFailure: true }); return true; }
  catch { return false; }
}

/** Whether this ffmpeg can draw text (freetype and a font), which the contact sheet's captions need. */
export async function hasDrawtext(): Promise<boolean> {
  try { return (await exec('ffmpeg', ['-hide_banner', '-filters'], { allowFailure: true })).stdout.includes(' drawtext '); }
  catch { return false; }
}

/** Six seconds of a test pattern with a tone, encoded like a headset capture (H.264 + AAC in MP4). */
export async function makeVideo(path: string, seconds = 6): Promise<void> {
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000`, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

export async function makeSilentVideo(path: string, seconds = 3): Promise<void> {
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
}
