#!/bin/bash
# Builds, installs and drives Polydance on Apple Vision Pro (docs/VISIONOS.md, visionos/README.md). The Xcode project
# is generated from visionos/project.yml by XcodeGen, and every build goes under visionos/build/; both are gitignored.
# The version is the headsets' own: versionName and versionCode from app/android/app/build.gradle.kts, so one release
# number names the same build on Quest, Android XR and the Vision Pro. Signing is automatic with POLYCAP_IOS_TEAM, or
# else the first team in Xcode's accounts (the iPhone's team). The headset is --device <name or id>, or else
# POLYCAP_VISION_DEVICE, or else the one Vision Pro that can be reached now (paired in Xcode, on this Mac's network).
#
#   ./build.sh generate                       write visionos/Polydance.xcodeproj from visionos/project.yml
#   ./build.sh version                        print the version the build takes: versionName versionCode
#   ./build.sh check                          compile for visionOS and its Simulator: no signing, no headset
#   ./build.sh build [--device ID] [--release] [--out DIR]
#                                             build for the headset (Debug, or Release), signed, with the commit and
#                                             the headsets' version in Info.plist; --out also copies the .app there
#   ./build.sh install [--device ID] [--app PATH]
#                                             install the built app (or the .app at PATH) on the headset
#   ./build.sh launch [--device ID] [-- ARGS] launch it, ending a running copy
#   ./build.sh installed [--device ID]        print the installed build as JSON: device, version and build
#   ./build.sh pull <dir> [--device ID]       copy events.jsonl and Runs/ from the app's container into <dir>
#   ./build.sh configure (--config-file F | --token-file F [--server URL]) [--device ID]
#                                             pair it: the pairing copied into the app's container as pairing.json,
#                                             which the app takes into its Keychain at its next launch
#   ./build.sh devices                        list the paired Vision Pros and whether each can be reached
#
# It runs only from inside its own checkout, so one worktree never builds or installs another's app. Temporary
# files go in a private mktemp folder removed on exit. The iPhone's ios/build.sh is the model for all of it.
set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || fail "$HERE is not inside a git checkout"
[ "$HERE" = "$ROOT/visionos" ] || fail "this script belongs in <repository>/visionos, not $HERE"
CALLER_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ "$CALLER_ROOT" = "$ROOT" ] || fail "run it from inside $ROOT (the checkout it builds), not from $PWD"

PROJECT="$HERE/Polydance.xcodeproj"
SCHEME="Polydance"
BUNDLE_ID="net.polydance.capture.visionpro"
DERIVED="$HERE/build/DerivedData"
CHECK_DERIVED="$HERE/build/Check"
GRADLE="$ROOT/app/android/app/build.gradle.kts"
CONTAINER_DIR="Library/Application Support"
PLISTBUDDY=/usr/libexec/PlistBuddy

TMP="$(mktemp -d "${TMPDIR:-/tmp}/polydance-visionos.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi

DEVICE_ARG=""
CONFIG_FILE=""
TOKEN_FILE=""
SERVER_ARG=""
APP_ARG=""
OUT_ARG=""
RELEASE=0
POSITIONAL=()
APP_ARGS=()

# parse_options "<allowed>" args...: allowed is a subset of device, config, positional, app-args, app, out, release.
parse_options() {
  local allowed=" $1 "
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --device)
        case "$allowed" in *" device "*) ;; *) fail "$COMMAND takes no --device" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--device needs a headset's name or id (npm run visionos -- devices)"
        DEVICE_ARG="$2"; shift 2 ;;
      --config-file)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --config-file" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--config-file needs a file"
        CONFIG_FILE="$2"; shift 2 ;;
      --token-file)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --token-file" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--token-file needs a file"
        TOKEN_FILE="$2"; shift 2 ;;
      --server)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --server" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--server needs a URL such as https://capture.polydance.net"
        SERVER_ARG="$2"; shift 2 ;;
      --app)
        case "$allowed" in *" app "*) ;; *) fail "$COMMAND takes no --app" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--app needs the path of a Polydance.app"
        APP_ARG="$2"; shift 2 ;;
      --out)
        case "$allowed" in *" out "*) ;; *) fail "$COMMAND takes no --out" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--out needs a folder"
        OUT_ARG="$2"; shift 2 ;;
      --release)
        case "$allowed" in *" release "*) ;; *) fail "$COMMAND takes no --release" ;; esac
        RELEASE=1; shift ;;
      --)
        case "$allowed" in *" app-args "*) ;; *) fail "$COMMAND takes no app arguments" ;; esac
        shift
        APP_ARGS=("$@")
        break ;;
      -*) fail "$COMMAND has no option $1" ;;
      *)
        case "$allowed" in *" positional "*) ;; *) fail "$COMMAND takes no argument $1" ;; esac
        POSITIONAL+=("$1"); shift ;;
    esac
  done
}

configuration() { if [ "$RELEASE" -eq 1 ]; then printf 'Release'; else printf 'Debug'; fi; }
app_path() { printf '%s/Build/Products/%s-xros/Polydance.app' "$DERIVED" "$(configuration)"; }

# The commit the app is built from; "-dirty" when anything it is built from differs from it: visionos/, the iPhone's
# shared sources and core, the Mac's shared look, and the headset's logo and viewer page.
commit() {
  local c
  c="$(git -C "$ROOT" rev-parse --short=7 HEAD 2>/dev/null)" || { printf 'unknown'; return 0; }
  if [ -n "$(git -C "$ROOT" status --porcelain -- visionos ios/App/Sources ios/Core mac/Package.swift mac/Sources/PolydanceShared \
      app/android/app/src/main/assets/viewer app/android/app/src/main/res/drawable-nodpi app/android/app/build.gradle.kts 2>/dev/null)" ]; then
    c="$c-dirty"
  fi
  printf '%s' "$c"
}

# VERSION_NAME and VERSION_CODE from the headsets' Gradle file: one `versionName = "x.y.z"` and one
# `versionCode = N` in defaultConfig, or the build stops (the Android XR suffix is that flavor's, not ours).
VERSION_NAME=""
VERSION_CODE=""
read_version() {
  python3 -I - "$GRADLE" >"$TMP/version.tsv" <<'PY' || fail "could not read the version from $GRADLE"
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
names = re.findall(r'^\s*versionName\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$', text, re.M)
codes = re.findall(r'^\s*versionCode\s*=\s*([0-9]+)\s*$', text, re.M)
if len(names) != 1 or len(codes) != 1:
    print(f"expected one versionName and one versionCode, found {len(names)} and {len(codes)}", file=sys.stderr)
    sys.exit(1)
print(f"{names[0]}\t{codes[0]}")
PY
  IFS=$'\t' read -r VERSION_NAME VERSION_CODE <"$TMP/version.tsv"
}

TEAM_ID=""
team() {
  if [ -n "${POLYCAP_IOS_TEAM:-}" ]; then
    TEAM_ID="$POLYCAP_IOS_TEAM"
  else
    defaults export com.apple.dt.Xcode "$TMP/xcode.plist" 2>/dev/null || fail "cannot read Xcode's preferences; set POLYCAP_IOS_TEAM to your team id"
    python3 -I - "$TMP/xcode.plist" >"$TMP/team.txt" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    prefs = plistlib.load(f)
teams = prefs.get('IDEProvisioningTeamByIdentifier')
if isinstance(teams, dict):
    for account in teams.values():
        for team in account if isinstance(account, list) else []:
            if isinstance(team, dict) and isinstance(team.get('teamID'), str):
                print(team['teamID'])
                sys.exit(0)
PY
    TEAM_ID="$(cat "$TMP/team.txt")"
    [ -n "$TEAM_ID" ] || fail "no team in Xcode's accounts: add your Apple ID in Xcode, Settings, Accounts, or set POLYCAP_IOS_TEAM"
  fi
  [[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "the team id \"$TEAM_ID\" is not ten capital letters and digits"
}

list_devices() {
  xcrun devicectl list devices --quiet --json-output "$TMP/devices.json" >/dev/null 2>&1 \
    || fail "devicectl could not list devices (is Xcode installed and its first launch done?)"
}

# Sets DEVICE_UDID, DEVICE_NAME, DEVICE_MODEL and DEVICE_OS: the Vision Pro asked for (--device, else
# POLYCAP_VISION_DEVICE) must be paired and reachable; with none asked for, exactly one must be reachable.
# "optional" makes the no-headset case return 1 instead of failing (build then builds for any Vision Pro).
DEVICE_UDID=""
DEVICE_NAME=""
DEVICE_MODEL=""
DEVICE_OS=""
choose_device() {
  local mode="${1:-required}" wanted="${DEVICE_ARG:-${POLYCAP_VISION_DEVICE:-}}" status=0
  list_devices
  python3 -I - "$TMP/devices.json" "$wanted" "$mode" >"$TMP/device.tsv" <<'PY' || status=$?
import json, sys
path, wanted, mode = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
found = []
for d in data.get('result', {}).get('devices', []):
    hw, dp, cp = d.get('hardwareProperties', {}), d.get('deviceProperties', {}), d.get('connectionProperties', {})
    vision = hw.get('platform') in ('xrOS', 'visionOS') or str(hw.get('productType') or '').startswith('RealityDevice') \
        or hw.get('deviceType') in ('appleVision', 'realityDevice')
    if not vision or hw.get('reality') not in ('physical', None) or cp.get('pairingState') != 'paired':
        continue
    found.append({'udid': hw.get('udid') or '', 'id': d.get('identifier') or '', 'name': dp.get('name') or '?',
                  'model': hw.get('productType') or '?', 'os': dp.get('osVersionNumber') or '?',
                  'reachable': cp.get('tunnelState') in ('connected', 'connecting', 'disconnected')})

def label(p):
    return f"{p['name']} ({p['model']}, visionOS {p['os']}, {'reachable' if p['reachable'] else 'not reachable'})"

def stop(message, code=2):
    print(message, file=sys.stderr)
    sys.exit(code)

paired = '; '.join(label(p) for p in found) or 'none (pair it in Xcode: Window, Devices and Simulators, with the headset on Settings, General, Remote Devices)'
if wanted:
    match = [p for p in found if wanted in (p['name'], p['udid'], p['id']) or wanted.lower() in (p['udid'].lower(), p['id'].lower())]
    if not match:
        stop(f"no paired Vision Pro is called {wanted}. Paired: {paired}")
    if len(match) > 1:
        stop(f"more than one paired Vision Pro matches {wanted}; give its id (npm run visionos -- devices)")
    device = match[0]
    if not device['reachable']:
        stop(f"{label(device)}: put it on, unlocked, on this Mac's network")
else:
    reachable = [p for p in found if p['reachable']]
    if not reachable:
        if mode == 'optional':
            sys.exit(3)
        stop(f"no Vision Pro is reachable now. Paired: {paired}")
    if len(reachable) > 1:
        stop(f"more than one Vision Pro is reachable; say which with --device or POLYCAP_VISION_DEVICE: {'; '.join(label(p) for p in reachable)}")
    device = reachable[0]
if not device['udid']:
    stop(f"devicectl gave no UDID for {label(device)}")
print('\t'.join((device['udid'], device['name'], device['model'], device['os'])))
PY
  if [ "$status" -eq 3 ]; then return 1; fi
  [ "$status" -eq 0 ] || exit 1
  IFS=$'\t' read -r DEVICE_UDID DEVICE_NAME DEVICE_MODEL DEVICE_OS <"$TMP/device.tsv"
  say "Vision Pro: $DEVICE_NAME ($DEVICE_MODEL, visionOS $DEVICE_OS)" >&2
}

cmd_generate() {
  parse_options "" "$@"
  command -v xcodegen >/dev/null 2>&1 || fail "XcodeGen is not installed: brew install xcodegen"
  xcodegen generate --spec "$HERE/project.yml" --no-env --quiet
  say "Generated $PROJECT"
}

cmd_version() {
  parse_options "" "$@"
  read_version
  say "$VERSION_NAME $VERSION_CODE"
}

cmd_check() {
  parse_options "" "$@"
  cmd_generate
  read_version
  local platform
  for platform in "visionOS" "visionOS Simulator"; do
    say "Compiling for $platform (unsigned)…"
    xcodebuild -quiet -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
      -destination "generic/platform=$platform" -derivedDataPath "$CHECK_DERIVED" \
      CODE_SIGNING_ALLOWED=NO MARKETING_VERSION="$VERSION_NAME" CURRENT_PROJECT_VERSION="$VERSION_CODE" build
  done
  say "Compiled for visionOS and the visionOS Simulator"
}

cmd_build() {
  parse_options "device release out" "$@"
  cmd_generate
  team
  read_version
  local c destination register=() app
  c="$(commit)"
  if [ -n "${DEVICE_ARG:-${POLYCAP_VISION_DEVICE:-}}" ]; then
    choose_device required
  elif ! choose_device optional; then
    say "No Vision Pro reachable: building for any Vision Pro (installing needs one; npm run visionos -- devices)"
  fi
  if [ -n "$DEVICE_UDID" ]; then
    destination="platform=visionOS,id=$DEVICE_UDID"
    register=(-allowProvisioningDeviceRegistration)
  else
    destination="generic/platform=visionOS"
  fi
  say "Building Polydance for Vision Pro $VERSION_NAME ($VERSION_CODE), $(configuration), commit $c, team $TEAM_ID…"
  xcodebuild -quiet -project "$PROJECT" -scheme "$SCHEME" -configuration "$(configuration)" \
    -destination "$destination" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates ${register[@]+"${register[@]}"} \
    DEVELOPMENT_TEAM="$TEAM_ID" POLYDANCE_COMMIT="$c" MARKETING_VERSION="$VERSION_NAME" CURRENT_PROJECT_VERSION="$VERSION_CODE" build
  app="$(app_path)"
  [ -d "$app" ] || fail "xcodebuild finished but $app is missing"
  if [ -n "$OUT_ARG" ]; then
    ( umask 077; mkdir -p "$OUT_ARG" )
    rm -rf "$OUT_ARG/Polydance.app"
    ditto "$app" "$OUT_ARG/Polydance.app"
    say "Built $app and copied it to $OUT_ARG/Polydance.app"
  else
    say "Built $app"
  fi
}

cmd_install() {
  parse_options "device app release" "$@"
  local app="${APP_ARG:-$(app_path)}" id c v b
  [ -d "$app" ] || fail "nothing to install at $app: npm run visionos -- build first"
  id="$("$PLISTBUDDY" -c "Print :CFBundleIdentifier" "$app/Info.plist" 2>/dev/null || true)"
  [ "$id" = "$BUNDLE_ID" ] || fail "$app is not Polydance for Vision Pro (bundle id ${id:-unknown})"
  codesign --verify --strict --deep "$app" 2>/dev/null || fail "$app is not signed: npm run visionos -- build"
  c="$("$PLISTBUDDY" -c "Print :PolydanceCommit" "$app/Info.plist" 2>/dev/null || true)"
  v="$("$PLISTBUDDY" -c "Print :CFBundleShortVersionString" "$app/Info.plist" 2>/dev/null || true)"
  b="$("$PLISTBUDDY" -c "Print :CFBundleVersion" "$app/Info.plist" 2>/dev/null || true)"
  choose_device
  xcrun devicectl device install app --device "$DEVICE_UDID" "$app"
  say "Installed Polydance $v ($b), commit ${c:-unknown}, on $DEVICE_NAME"
}

cmd_launch() {
  parse_options "device app-args" "$@"
  choose_device
  xcrun devicectl device process launch --device "$DEVICE_UDID" --terminate-existing \
    -- "$BUNDLE_ID" ${APP_ARGS[@]+"${APP_ARGS[@]}"}
  say "Launched Polydance on $DEVICE_NAME"
}

# The installed build, as JSON on standard output, for `npm run app -- status`:
# {"device": name, "model", "os", "installed": bool, "version", "build"}. devicectl gives no Info.plist key of
# Polydance's own, so the commit is not here: the build number (the release's versionCode) names the release.
cmd_installed() {
  parse_options "device" "$@"
  choose_device
  xcrun devicectl device info apps --device "$DEVICE_UDID" --bundle-id "$BUNDLE_ID" --quiet --json-output "$TMP/apps.json" >/dev/null 2>&1 \
    || fail "devicectl could not list the apps on $DEVICE_NAME"
  python3 -I - "$TMP/apps.json" "$DEVICE_NAME" "$DEVICE_MODEL" "$DEVICE_OS" "$BUNDLE_ID" <<'PY'
import json, sys
path, name, model, os_version, bundle = sys.argv[1:6]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
apps = [a for a in data.get('result', {}).get('apps', []) if a.get('bundleIdentifier') == bundle]
out = {'device': name, 'model': model, 'os': os_version, 'installed': bool(apps)}
if apps:
    a = apps[0]
    out.update({'version': a.get('version'), 'build': a.get('bundleVersion')})
print(json.dumps(out, sort_keys=True))
PY
}

cmd_pull() {
  parse_options "device positional" "$@"
  [ "${#POSITIONAL[@]}" -eq 1 ] || fail "say where to put it: npm run visionos -- pull <dir>"
  local dir parent probe top
  dir="$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${POSITIONAL[0]}")"
  if [ -e "$dir" ]; then
    [ -d "$dir" ] || fail "$dir exists and is not a folder"
    [ -z "$(ls -A "$dir")" ] || fail "$dir is not empty; pull into a new folder"
  fi
  # Recordings and the log never go where git could pick them up: inside any checkout only where it ignores them.
  parent="$dir"
  while [ ! -e "$parent" ]; do parent="$(dirname "$parent")"; done
  probe="$parent"
  while top="$(git -C "$probe" rev-parse --show-toplevel 2>/dev/null)"; do
    git -C "$top" check-ignore -q --no-index "$dir/" \
      || fail "$dir is inside the git checkout $top and not ignored there; pull under its .local/ (gitignored) or outside it"
    [ "$top" != "/" ] || break
    probe="$(dirname "$top")"
  done
  choose_device
  ( umask 077; mkdir -p "$dir/Runs" )
  xcrun devicectl device copy from --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$CONTAINER_DIR/events.jsonl" --destination "$dir/events.jsonl"
  xcrun devicectl device copy from --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$CONTAINER_DIR/Runs" --destination "$dir/Runs"
  chmod 600 "$dir/events.jsonl"
  if [ -e "$dir/Runs" ]; then chmod -R go-rwx "$dir/Runs"; fi
  say "Pulled events.jsonl and Runs/ from $DEVICE_NAME into $dir (readable by you only)"
}

# The pairing, from --config-file F (a whole {v, server, token} file) or --token-file F and --server URL, checked
# with the app's own rules (PolydancePhoneCore's Pairing), as ios/build.sh checks it: exactly v, server and token; v
# the number 1; server scheme://host[:port] with no user, path, query or fragment, plain http only to a .local name,
# localhost or 127.0.0.1; the token 1 to 512 visible ASCII characters. A file holding a token must be readable by
# you only, and the token is never printed.
pairing_json() {
  local out="$1"
  if [ -n "$CONFIG_FILE" ]; then
    [ -z "$TOKEN_FILE$SERVER_ARG" ] || fail "give --config-file, or --token-file with --server, not both"
  else
    [ -n "$TOKEN_FILE" ] || fail "say which pairing: --config-file <file>, or --token-file <file> [--server URL]"
  fi
  local file="${CONFIG_FILE:-$TOKEN_FILE}" kind=token mode
  [ -z "$CONFIG_FILE" ] || kind=config
  [ -f "$file" ] || fail "no file at $file"
  mode="$(stat -f '%Lp' "$file")"
  [ $(( 8#$mode & 8#077 )) -eq 0 ] || fail "$file holds a token but others can read it (mode $mode): chmod 600 it first"
  python3 -I - "$out" "$kind" "$file" "${SERVER_ARG:-https://capture.polydance.net}" <<'PY' || exit 1
import json, os, re, sys
from urllib.parse import urlsplit
out, kind, path, server_arg = sys.argv[1:5]
def stop(message):
    print(f"build.sh: {path}: {message}", file=sys.stderr)
    sys.exit(1)
if kind == 'config':
    try:
        with open(path, encoding='utf-8') as f:
            config = json.load(f)
    except (OSError, ValueError) as e:
        stop(f"not JSON ({type(e).__name__})")
else:
    with open(path, encoding='utf-8') as f:
        lines = f.read().splitlines()
    if len(lines) != 1:
        stop("a token file holds the token alone, on one line")
    config = {'v': 1, 'server': server_arg, 'token': lines[0].strip()}
if not isinstance(config, dict) or set(config) != {'v', 'server', 'token'}:
    stop("must be a JSON object with exactly v, server and token")
v = config['v']
if isinstance(v, bool) or not isinstance(v, int) or v != 1:
    stop("v must be the number 1")
token = config['token']
if not isinstance(token, str) or not 1 <= len(token) <= 512 or not all(0x21 <= ord(c) <= 0x7E for c in token):
    stop("token must be 1 to 512 visible ASCII characters, with no space or newline")
server = config['server']
if not isinstance(server, str) or '?' in server or '#' in server:
    stop("server must be a string with no query or fragment")
url = urlsplit(server)
scheme, host = url.scheme.lower(), (url.hostname or '').lower()
try:
    port = url.port
except ValueError:
    stop("server's port must be 1 to 65535")
if scheme not in ('http', 'https') or not host:
    stop(f"server must be http(s)://host[:port], not {server!r}")
if url.username is not None or url.password is not None:
    stop("server must not carry a user or password")
if url.path not in ('', '/'):
    stop("server must have no path beyond /")
if host != '127.0.0.1' and not re.fullmatch(r'[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*', host):
    stop("server's host must be a name such as mac.local, or 127.0.0.1")
if port is not None and not 1 <= port <= 65535:
    stop("server's port must be 1 to 65535")
if scheme == 'http' and not (host.endswith('.local') or host in ('localhost', '127.0.0.1')):
    stop(f"plain http is allowed only to a .local name, localhost or 127.0.0.1, not {host}")
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'v': 1, 'server': server, 'token': token}, separators=(',', ':'), sort_keys=True) + '\n')
PY
}

cmd_configure() {
  parse_options "device config" "$@"
  pairing_json "$TMP/pairing.json"
  choose_device
  # devicectl's copy runs as root on the device: a folder it has to make is root's (seen on the iPhone, 2026-11-07),
  # so the app must have made Library/Application Support itself, at its first launch.
  xcrun devicectl device info files --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --quiet --json-output "$TMP/files.json" >/dev/null 2>&1 \
    || fail "devicectl could not list Polydance's files on $DEVICE_NAME: is it installed? (npm run visionos -- install)"
  python3 -I - "$TMP/files.json" "$CONTAINER_DIR" <<'PY' || exit 1
import json, sys
path, folder = sys.argv[1:3]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
found = [x for x in data.get('result', {}).get('files', []) if x.get('relativePath') == folder]
if not found:
    print(f"build.sh: Polydance has not made {folder} yet: launch it once first (npm run visionos -- launch), then configure.", file=sys.stderr)
    sys.exit(1)
uid = found[0].get('metadata', {}).get('ownerUid')
if uid not in (None, 501):
    print(f"build.sh: {folder} is owned by uid {uid}, not the app (501): devicectl made it before the first launch.", file=sys.stderr)
    sys.exit(1)
PY
  xcrun devicectl device copy to --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$TMP/pairing.json" --destination "$CONTAINER_DIR/pairing.json"
  say "Copied the pairing to $DEVICE_NAME; launch Polydance again (npm run visionos -- launch) so it takes it into its Keychain"
}

cmd_devices() {
  parse_options "" "$@"
  list_devices
  python3 -I - "$TMP/devices.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    data = json.load(f)
rows = []
for d in data.get('result', {}).get('devices', []):
    hw, dp, cp = d.get('hardwareProperties', {}), d.get('deviceProperties', {}), d.get('connectionProperties', {})
    vision = hw.get('platform') in ('xrOS', 'visionOS') or str(hw.get('productType') or '').startswith('RealityDevice') \
        or hw.get('deviceType') in ('appleVision', 'realityDevice')
    if not vision or cp.get('pairingState') != 'paired':
        continue
    reachable = cp.get('tunnelState') in ('connected', 'connecting', 'disconnected')
    rows.append(f"{dp.get('name') or '?'}  {hw.get('productType') or '?'}  visionOS {dp.get('osVersionNumber') or '?'}  "
                f"{'reachable' if reachable else 'not reachable'}  (--device {d.get('identifier') or '?'})")
print('\n'.join(rows) if rows else 'No paired Vision Pro. With Xcode open on this Mac, put the headset on, open Settings, General, Remote Devices, '
      'and pair it from Xcode, Window, Devices and Simulators.')
PY
}

case "$COMMAND" in
  generate) cmd_generate "$@" ;;
  version) cmd_version "$@" ;;
  check) cmd_check "$@" ;;
  build) cmd_build "$@" ;;
  install) cmd_install "$@" ;;
  launch) cmd_launch "$@" ;;
  installed) cmd_installed "$@" ;;
  pull) cmd_pull "$@" ;;
  configure) cmd_configure "$@" ;;
  devices) cmd_devices "$@" ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac
