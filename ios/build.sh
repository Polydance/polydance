#!/bin/bash
# Builds, installs and drives Polydance for iPhone (docs/IPHONE.md), phase I0's probe (ios/README.md).
# The Xcode project is generated from ios/project.yml by XcodeGen, and every build goes under ios/build/;
# both are gitignored. Signing is automatic with the free team: POLYCAP_IOS_TEAM, or else the first team
# in Xcode's own accounts. The phone is --device <name or id>, or else POLYCAP_IOS_DEVICE, or else the one
# iPhone that is connected now.
#
#   ./build.sh generate                       write ios/Polydance.xcodeproj from ios/project.yml
#   ./build.sh build [--device ID]            build for the phone (Debug, signed), with the commit in Info.plist
#   ./build.sh sim                            build for the iOS Simulator, unsigned
#   ./build.sh check                          compile for iOS and the simulator, no signing and no phone
#   ./build.sh test                           swift test in ios/Core
#   ./build.sh snapshots <dir>                pictures of every screen in the Simulator, from samples
#                                             (-lookSamples -lookScreen NAME), into <dir> as PNGs
#   ./build.sh install [--device ID]          install the built app on the phone
#   ./build.sh launch [--device ID] [-- ARGS] launch it (ending a running copy) with the app's arguments, such
#                                             as -autoRecordSeconds 60 -autoFlipAtSeconds 30 -autoUpload
#   ./build.sh leave [--device ID]            open Settings on the phone, sending Polydance to the background
#   ./build.sh pull <dir> [--device ID]       copy events.jsonl and Runs/ from the app's container into <dir>
#   ./build.sh pair [--token-file F] [--server URL] | [--config-file F]
#                                             draw the pairing QR code on this Mac for the phone to scan: the
#                                             token in F (default ~/.config/polycap/tokens/iphone) for URL
#                                             (default https://capture.polydance.net), or a whole pairing file
#   ./build.sh configure (--config-file F | --token-file F [--server URL]) [--device ID]
#                                             the same pairing over USB: copied into the app's container as
#                                             pairing.json, which the app takes into its Keychain at launch
#   ./build.sh devices                        list the paired iPhones and whether each can be reached
#
# It runs only from inside its own checkout (the repository holding this ios/ folder), so one worktree
# never builds or installs another's app. Temporary files go in a private mktemp folder removed on exit.
set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || fail "$HERE is not inside a git checkout"
[ "$HERE" = "$ROOT/ios" ] || fail "this script belongs in <repository>/ios, not $HERE"
CALLER_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ "$CALLER_ROOT" = "$ROOT" ] || fail "run it from inside $ROOT (the checkout it builds), not from $PWD"

PROJECT="$HERE/Polydance.xcodeproj"
SCHEME="Polydance"
CONFIGURATION="Debug"
BUNDLE_ID="net.polydance.capture.iphone"
DERIVED="$HERE/build/DerivedData"
CHECK_DERIVED="$HERE/build/Check"
APP_DEVICE="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/Polydance.app"
APP_SIM="$DERIVED/Build/Products/$CONFIGURATION-iphonesimulator/Polydance.app"
# The app's files in its data container, as devicectl names them (relative to the container).
CONTAINER_DIR="Library/Application Support"
# A stock app to open when Polydance must leave the screen.
LEAVE_TO="com.apple.Preferences"
PLISTBUDDY=/usr/libexec/PlistBuddy

TMP="$(mktemp -d "${TMPDIR:-/tmp}/polydance-ios.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi

# Options, by command. Empty arrays are expanded with ${a[@]+"${a[@]}"} because macOS's bash 3.2 calls an
# empty "${a[@]}" unbound under set -u.
DEVICE_ARG=""
CONFIG_FILE=""
TOKEN_FILE=""
SERVER_ARG=""
POSITIONAL=()
APP_ARGS=()

# parse_options "<allowed>" args...: allowed is a space-separated subset of device, config, positional, app-args.
parse_options() {
  local allowed=" $1 "
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --device)
        case "$allowed" in *" device "*) ;; *) fail "$COMMAND takes no --device" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--device needs a phone's name or id (npm run ios -- devices)"
        DEVICE_ARG="$2"
        shift 2 ;;
      --config-file)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --config-file" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--config-file needs a file"
        CONFIG_FILE="$2"
        shift 2 ;;
      --token-file)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --token-file" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--token-file needs a file"
        TOKEN_FILE="$2"
        shift 2 ;;
      --server)
        case "$allowed" in *" config "*) ;; *) fail "$COMMAND takes no --server" ;; esac
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--server needs a URL such as https://capture.polydance.net"
        SERVER_ARG="$2"
        shift 2 ;;
      --)
        case "$allowed" in *" app-args "*) ;; *) fail "$COMMAND takes no app arguments" ;; esac
        shift
        APP_ARGS=("$@")
        break ;;
      -*) fail "$COMMAND has no option $1" ;;
      *)
        case "$allowed" in *" positional "*) ;; *) fail "$COMMAND takes no argument $1" ;; esac
        POSITIONAL+=("$1")
        shift ;;
    esac
  done
}

# The commit the app is built from, for PolydanceCommit; "-dirty" when anything under ios/ differs from it
# (tracked or not; ios/build and the generated project are gitignored).
commit() {
  local c
  c="$(git -C "$ROOT" rev-parse --short=7 HEAD 2>/dev/null)" || { printf 'unknown'; return 0; }
  if [ -n "$(git -C "$ROOT" status --porcelain -- ios 2>/dev/null)" ]; then c="$c-dirty"; fi
  printf '%s' "$c"
}

# The signing team, into TEAM_ID: POLYCAP_IOS_TEAM, or the first team in Xcode's accounts (Settings,
# Accounts), read from a private temporary copy of its preferences. Python's output goes through a file, not
# $(...), because bash 3.2 misreads a here-document inside a command substitution.
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
    rm -f "$TMP/xcode.plist"
    TEAM_ID="$(cat "$TMP/team.txt")"
    [ -n "$TEAM_ID" ] || fail "no team in Xcode's accounts: add your Apple ID in Xcode, Settings, Accounts, or set POLYCAP_IOS_TEAM"
  fi
  [[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "the team id \"$TEAM_ID\" is not ten capital letters and digits"
}

# devicectl's view of the paired iPhones, as JSON in the temporary folder.
list_devices() {
  xcrun devicectl list devices --quiet --json-output "$TMP/devices.json" >/dev/null 2>&1 \
    || fail "devicectl could not list devices (is Xcode installed and its first launch done?)"
}

# Sets DEVICE_UDID, DEVICE_NAME, DEVICE_MODEL and DEVICE_OS. The phone asked for (--device, else
# POLYCAP_IOS_DEVICE) must be paired and reachable; with none asked for, exactly one iPhone must be
# reachable. "optional" makes the no-phone case return 1 instead of failing (build falls back to a generic one).
DEVICE_UDID=""
DEVICE_NAME=""
DEVICE_MODEL=""
DEVICE_OS=""
choose_device() {
  local mode="${1:-required}" wanted="${DEVICE_ARG:-${POLYCAP_IOS_DEVICE:-}}" status=0
  list_devices
  python3 -I - "$TMP/devices.json" "$wanted" "$mode" >"$TMP/device.tsv" <<'PY' || status=$?
import json, sys
path, wanted, mode = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
phones = []
for d in data.get('result', {}).get('devices', []):
    hw, dp, cp = d.get('hardwareProperties', {}), d.get('deviceProperties', {}), d.get('connectionProperties', {})
    # `reality` is missing for a phone paired but never connected through CoreDevice (the iPhone 16 on
    # 2026-11-07). devicectl lists no simulators, so only a reality other than physical is refused.
    if hw.get('deviceType') != 'iPhone' or hw.get('reality') not in ('physical', None) or cp.get('pairingState') != 'paired':
        continue
    phones.append({'udid': hw.get('udid') or '', 'id': d.get('identifier') or '', 'name': dp.get('name') or '?',
                   'model': hw.get('productType') or '?', 'os': dp.get('osVersionNumber') or '?',
                   # devicectl's tunnel states: connected, connecting, disconnected (reachable, no tunnel yet), unavailable.
                   'reachable': cp.get('tunnelState') in ('connected', 'connecting', 'disconnected')})

def label(p):
    return f"{p['name']} ({p['model']}, iOS {p['os']}, {'reachable' if p['reachable'] else 'not reachable'})"

def paired():
    return '; '.join(label(p) for p in phones) or 'none'

def stop(message, code=2):
    print(message, file=sys.stderr)
    sys.exit(code)

if wanted:
    match = [p for p in phones if wanted in (p['name'], p['udid'], p['id']) or wanted.lower() in (p['udid'].lower(), p['id'].lower())]
    if not match:
        stop(f"no paired iPhone is called {wanted}. Paired: {paired()}")
    if len(match) > 1:
        stop(f"more than one paired iPhone matches {wanted}; give its id (npm run ios -- devices)")
    phone = match[0]
    if not phone['reachable']:
        stop(f"{label(phone)}: connect it with a cable or put it on this Mac's Wi-Fi, unlocked")
else:
    reachable = [p for p in phones if p['reachable']]
    if not reachable:
        if mode == 'optional':
            sys.exit(3)
        stop(f"no iPhone is reachable now. Paired: {paired()}")
    if len(reachable) > 1:
        stop(f"more than one iPhone is reachable; say which with --device or POLYCAP_IOS_DEVICE: {'; '.join(label(p) for p in reachable)}")
    phone = reachable[0]
if not phone['udid']:
    stop(f"devicectl gave no UDID for {label(phone)}")
print('\t'.join((phone['udid'], phone['name'], phone['model'], phone['os'])))
PY
  if [ "$status" -eq 3 ]; then return 1; fi
  [ "$status" -eq 0 ] || exit 1
  IFS=$'\t' read -r DEVICE_UDID DEVICE_NAME DEVICE_MODEL DEVICE_OS <"$TMP/device.tsv"
  say "Phone: $DEVICE_NAME ($DEVICE_MODEL, iOS $DEVICE_OS)"
}

cmd_generate() {
  parse_options "" "$@"
  command -v xcodegen >/dev/null 2>&1 || fail "XcodeGen is not installed: brew install xcodegen"
  # --no-env: nothing in the environment changes the project.
  xcodegen generate --spec "$HERE/project.yml" --no-env --quiet
  say "Generated $PROJECT"
}

cmd_build() {
  parse_options "device" "$@"
  cmd_generate
  local c destination register=()
  team
  c="$(commit)"
  if [ -n "${DEVICE_ARG:-${POLYCAP_IOS_DEVICE:-}}" ]; then
    choose_device required
  elif ! choose_device optional; then
    say "No iPhone connected: building for any iPhone (installing needs one; npm run ios -- devices)"
  fi
  if [ -n "$DEVICE_UDID" ]; then
    destination="platform=iOS,id=$DEVICE_UDID"
    register=(-allowProvisioningDeviceRegistration)
  else
    destination="generic/platform=iOS"
  fi
  say "Building Polydance ($CONFIGURATION, commit $c, team $TEAM_ID)…"
  xcodebuild -quiet -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination "$destination" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates ${register[@]+"${register[@]}"} \
    DEVELOPMENT_TEAM="$TEAM_ID" POLYDANCE_COMMIT="$c" build
  [ -d "$APP_DEVICE" ] || fail "xcodebuild finished but $APP_DEVICE is missing"
  say "Built $APP_DEVICE"
}

cmd_sim() {
  parse_options "" "$@"
  cmd_generate
  local c
  c="$(commit)"
  say "Building Polydance for the iOS Simulator (unsigned, commit $c)…"
  xcodebuild -quiet -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination "generic/platform=iOS Simulator" -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO POLYDANCE_COMMIT="$c" build
  say "Built $APP_SIM"
}

# The compile check: both platforms, nothing signed, into a folder of its own so a signed build is untouched.
cmd_check() {
  parse_options "" "$@"
  cmd_generate
  local platform
  for platform in "iOS" "iOS Simulator"; do
    say "Compiling for $platform (unsigned)…"
    xcodebuild -quiet -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
      -destination "generic/platform=$platform" -derivedDataPath "$CHECK_DERIVED" \
      CODE_SIGNING_ALLOWED=NO build
  done
  say "Compiled for iOS and the iOS Simulator"
}

cmd_test() {
  parse_options "" "$@"
  swift test --package-path "$HERE/Core"
}

# Pictures of the look (docs/DESIGN-SYSTEM.md), as `npm run mac -- snapshots` makes the Mac's: builds for the
# Simulator, starts one (POLYCAP_IOS_SIMULATOR, a name or UDID, else "iPhone 17"), installs the app, launches
# it once per screen with -lookSamples -lookScreen NAME and saves the screen as <dir>/<NAME>.png, then once
# with no arguments as deck-as-is.png. The status bar reads 9:41 while it runs. A Simulator this started is
# shut down again. The Simulator has no camera, so the REC screen shows where the picture would be.
SNAPSHOT_SCREENS="deck rec camera screen photo thread recordings settings report drawer newThread"
# simctl says what it wrote on stderr; only a failure is shown.
shot() { xcrun simctl io "$1" screenshot "$2" >/dev/null 2>"$TMP/shot.err" || { cat "$TMP/shot.err" >&2; fail "no screenshot of $2"; }; }
cmd_snapshots() {
  parse_options "positional" "$@"
  [ ${#POSITIONAL[@]} -eq 1 ] || fail "say where the pictures go: npm run ios -- snapshots <dir>"
  local dir="${POSITIONAL[0]}" wanted="${POLYCAP_IOS_SIMULATOR:-iPhone 17}" udid state started=0 screen
  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd)"
  cmd_sim
  xcrun simctl list devices available -j >"$TMP/sims.json" || fail "simctl could not list the Simulators"
  python3 -I - "$TMP/sims.json" "$wanted" >"$TMP/sim.tsv" <<'PY' || exit 1
import json, sys
path, wanted = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    runtimes = json.load(f).get('devices', {})
found = [d for runtime, devices in runtimes.items() if 'iOS' in runtime for d in devices
         if d.get('isAvailable') and wanted in (d.get('name'), d.get('udid'))]
if not found:
    print(f"no available iOS Simulator is called {wanted}; set POLYCAP_IOS_SIMULATOR (xcrun simctl list devices)", file=sys.stderr)
    sys.exit(1)
found.sort(key=lambda d: d.get('state') != 'Booted')
print(f"{found[0]['udid']}\t{found[0].get('state', '?')}")
PY
  IFS=$'\t' read -r udid state <"$TMP/sim.tsv"
  if [ "$state" != "Booted" ]; then
    say "Starting the Simulator $wanted ($udid)…"
    xcrun simctl boot "$udid"
    started=1
  fi
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time "9:41" --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
  xcrun simctl install "$udid" "$APP_SIM"
  for screen in $SNAPSHOT_SCREENS; do
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" -lookSamples -lookScreen "$screen" >/dev/null
    sleep 3
    shot "$udid" "$dir/$screen.png"
    say "  $screen.png"
  done
  xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" >/dev/null
  sleep 3
  shot "$udid" "$dir/deck-as-is.png"
  say "  deck-as-is.png"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl status_bar "$udid" clear
  if [ "$started" -eq 1 ]; then xcrun simctl shutdown "$udid"; fi
  say "Pictures in $dir"
}

cmd_install() {
  parse_options "device" "$@"
  [ -d "$APP_DEVICE" ] || fail "nothing to install: npm run ios -- build first"
  local id c
  id="$("$PLISTBUDDY" -c "Print :CFBundleIdentifier" "$APP_DEVICE/Info.plist" 2>/dev/null || true)"
  [ "$id" = "$BUNDLE_ID" ] || fail "$APP_DEVICE is not Polydance (bundle id ${id:-unknown})"
  codesign --verify --strict "$APP_DEVICE" 2>/dev/null || fail "$APP_DEVICE is not signed: npm run ios -- build"
  c="$("$PLISTBUDDY" -c "Print :PolydanceCommit" "$APP_DEVICE/Info.plist" 2>/dev/null || true)"
  choose_device
  xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_DEVICE"
  say "Installed Polydance (commit ${c:-unknown}) on $DEVICE_NAME"
}

cmd_launch() {
  parse_options "device app-args" "$@"
  choose_device
  # "--" ends devicectl's own options, so app arguments that start with "-" reach the app.
  xcrun devicectl device process launch --device "$DEVICE_UDID" --terminate-existing \
    -- "$BUNDLE_ID" ${APP_ARGS[@]+"${APP_ARGS[@]}"}
  say "Launched Polydance on $DEVICE_NAME"
}

cmd_leave() {
  parse_options "device" "$@"
  choose_device
  xcrun devicectl device process launch --device "$DEVICE_UDID" -- "$LEAVE_TO"
  say "Opened Settings on $DEVICE_NAME; Polydance is in the background"
}

cmd_pull() {
  parse_options "device positional" "$@"
  [ "${#POSITIONAL[@]}" -eq 1 ] || fail "say where to put it: npm run ios -- pull <dir>"
  local dir parent probe top
  dir="$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${POSITIONAL[0]}")"
  # A new folder, or an empty one: pull changes the modes of what it copied and nothing else.
  if [ -e "$dir" ]; then
    [ -d "$dir" ] || fail "$dir exists and is not a folder"
    [ -z "$(ls -A "$dir")" ] || fail "$dir is not empty; pull into a new folder"
  fi
  # Recordings and the log never go where git could pick them up: inside any checkout (this one, or one
  # that holds it, as the main checkout holds its worktrees), only where that checkout ignores them.
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
  # devicectl's `copy from` of a folder needs the destination folder to exist already; given a new
  # path it fails with "No such file or directory" (seen on the iPhone 16, 2026-11-07).
  ( umask 077; mkdir -p "$dir/Runs" )
  xcrun devicectl device copy from --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$CONTAINER_DIR/events.jsonl" --destination "$dir/events.jsonl"
  xcrun devicectl device copy from --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$CONTAINER_DIR/Runs" --destination "$dir/Runs"
  chmod 600 "$dir/events.jsonl"
  if [ -e "$dir/Runs" ]; then chmod -R go-rwx "$dir/Runs"; fi
  # The screen's extension keeps its own log in the app group (docs/IPHONE.md I4); there is none until it has run once.
  if ( umask 077; xcrun devicectl device copy from --device "$DEVICE_UDID" --domain-type appGroupDataContainer \
      --domain-identifier "group.$BUNDLE_ID" --source "Library/Application Support/Broadcast/events.jsonl" \
      --destination "$dir/broadcast-events.jsonl" >/dev/null 2>&1 ); then
    chmod 600 "$dir/broadcast-events.jsonl"
    say "Pulled the screen extension's broadcast-events.jsonl too"
  else
    say "No screen extension log to pull (none until a screen take has run)"
  fi
  say "Pulled events.jsonl and Runs/ from $DEVICE_NAME into $dir (readable by you only)"
}

# The pairing (docs/IPHONE.md P2), from --config-file F (a whole {v, server, token} file) or from
# --token-file F and --server URL, checked with the app's own rules (Pairing.checkServer and checkToken in
# ios/Core/.../Pairing.swift), mirrored so a pairing the phone would refuse is refused here first: exactly v,
# server and token; v the number 1; server scheme://host[:port] with no user, path, query or fragment, a
# port of 1 to 65535 and plain http only to a .local name, localhost or 127.0.0.1; the token 1 to 512
# visible ASCII characters (it goes into a header). A file holding a token must be readable by you only.
# The JSON goes to the new file $1 (0600), or to standard output when $1 is "-", which must then not be a
# terminal: the token itself is never printed. $2 is the token file to use when none was given.
pairing_json() {
  local out="$1" default_token="${2:-}"
  if [ -n "$CONFIG_FILE" ]; then
    [ -z "$TOKEN_FILE$SERVER_ARG" ] || fail "give --config-file, or --token-file with --server, not both"
  else
    [ -n "$TOKEN_FILE" ] || TOKEN_FILE="$default_token"
    [ -n "$TOKEN_FILE" ] || fail "say which pairing: --config-file <file>, or --token-file <file> [--server URL]"
  fi
  local file="${CONFIG_FILE:-$TOKEN_FILE}" kind=token mode
  [ -z "$CONFIG_FILE" ] || kind=config
  [ -f "$file" ] || fail "no file at $file"
  mode="$(stat -f '%Lp' "$file")"
  [ $(( 8#$mode & 8#077 )) -eq 0 ] || fail "$file holds a token but others can read it (mode $mode): chmod 600 it first"
  if [ "$out" = "-" ] && [ -t 1 ]; then fail "the pairing holds a token and is never printed to a terminal"; fi
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
if not isinstance(config, dict):
    stop("not a JSON object")
if set(config) != {'v', 'server', 'token'}:
    stop(f"must have exactly v, server and token; has {', '.join(sorted(config)) or 'nothing'}")
v = config['v']
if isinstance(v, bool) or not isinstance(v, int) or v != 1:
    stop("v must be the number 1")
token = config['token']
if not isinstance(token, str) or not 1 <= len(token) <= 512 or not all(0x21 <= ord(c) <= 0x7E for c in token):
    stop("token must be 1 to 512 visible ASCII characters, with no space or newline")
server = config['server']
if not isinstance(server, str):
    stop("server must be a string")
if '?' in server or '#' in server:
    stop("server must have no query or fragment")
url = urlsplit(server)
scheme = url.scheme.lower()
host = (url.hostname or '').lower()
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
text = json.dumps({'v': 1, 'server': server, 'token': token}, separators=(',', ':'), sort_keys=True)
if out == '-':
    sys.stdout.write(text)
else:
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text + '\n')
PY
}

# P2: the QR code on this Mac's screen, from ios/tools/Pair (built into ios/build/pair), which reads the
# pairing on standard input and keeps it in memory only. It closes on Done, Esc, or after two minutes.
cmd_pair() {
  parse_options "config" "$@"
  local bin="$HERE/build/pair/release/PolydancePair"
  say "Building the pairing window…"
  swift build --package-path "$HERE/tools/Pair" --scratch-path "$HERE/build/pair" -c release --quiet
  [ -x "$bin" ] || fail "swift build finished but $bin is missing"
  say "Showing the code (Done or Esc closes it; it closes itself after 2 minutes)."
  pairing_json - "$HOME/.config/polycap/tokens/iphone" | "$bin"
}

cmd_configure() {
  parse_options "device config" "$@"
  pairing_json "$TMP/pairing.json"
  choose_device
  # devicectl's copy runs as root on the phone: a folder it has to make is owned by root (0755), and the
  # app, running as mobile, can then neither make Runs/ in it nor chmod it (seen on the iPhone 16,
  # 2026-11-07). So the app must have made Library/Application Support itself, at its first launch.
  xcrun devicectl device info files --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --quiet --json-output "$TMP/files.json" >/dev/null 2>&1 \
    || fail "devicectl could not list Polydance's files on $DEVICE_NAME: is it installed? (npm run ios -- install)"
  python3 -I - "$TMP/files.json" "$CONTAINER_DIR" "$DEVICE_UDID" "$BUNDLE_ID" <<'PY' || exit 1
import json, sys
path, folder, udid, bundle = sys.argv[1:5]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
found = [x for x in data.get('result', {}).get('files', []) if x.get('relativePath') == folder]
if not found:
    print(f"build.sh: Polydance has not made {folder} yet: launch it once first (npm run ios -- launch), "
          "then configure. A folder devicectl makes is owned by root and the app cannot write in it.", file=sys.stderr)
    sys.exit(1)
uid = found[0].get('metadata', {}).get('ownerUid')
if uid != 501:
    print(f"build.sh: {folder} on the phone is owned by uid {uid}, not the app (501): devicectl made it before "
          "Polydance's first launch, and the app cannot write in it. Uninstall (this deletes the app's takes on the phone):\n"
          f"  xcrun devicectl device uninstall app --device {udid} {bundle}\n"
          "then npm run ios -- install, launch it once, and configure again.", file=sys.stderr)
    sys.exit(1)
PY
  xcrun devicectl device copy to --device "$DEVICE_UDID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source "$TMP/pairing.json" --destination "$CONTAINER_DIR/pairing.json"
  say "Copied the pairing to $DEVICE_NAME as $CONTAINER_DIR/pairing.json; launch Polydance again so it takes it into its Keychain"
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
    # `reality` is missing for a phone paired but never connected through CoreDevice (the iPhone 16 on
    # 2026-11-07). devicectl lists no simulators, so only a reality other than physical is refused.
    if hw.get('deviceType') != 'iPhone' or hw.get('reality') not in ('physical', None) or cp.get('pairingState') != 'paired':
        continue
    reachable = cp.get('tunnelState') in ('connected', 'connecting', 'disconnected')
    rows.append(f"{dp.get('name') or '?'}  {hw.get('productType') or '?'}  iOS {dp.get('osVersionNumber') or '?'}  "
                f"{'reachable' if reachable else 'not reachable'}  (--device {d.get('identifier') or '?'})")
print('\n'.join(rows) if rows else 'No paired iPhone. Pair one in Xcode, Window, Devices and Simulators.')
PY
}

case "$COMMAND" in
  generate) cmd_generate "$@" ;;
  build) cmd_build "$@" ;;
  sim) cmd_sim "$@" ;;
  check) cmd_check "$@" ;;
  test) cmd_test "$@" ;;
  snapshots) cmd_snapshots "$@" ;;
  install) cmd_install "$@" ;;
  launch) cmd_launch "$@" ;;
  leave) cmd_leave "$@" ;;
  pull) cmd_pull "$@" ;;
  pair) cmd_pair "$@" ;;
  configure) cmd_configure "$@" ;;
  devices) cmd_devices "$@" ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac
