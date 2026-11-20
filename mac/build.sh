#!/bin/bash
# Builds, signs, tests and installs Polydance for Mac (docs/MAC.md). Output goes under
# mac/build/ (gitignored). Signing uses one identity that stays the same between builds, because macOS
# ties every permission (microphone, system audio, screen, Automation) to the app's signature: the
# first "Apple Development" certificate in the keychain, or POLYCAP_MAC_SIGN_IDENTITY. Ad hoc signing
# changes the signature with every build, so it is only done when asked for with --adhoc.
#
#   ./build.sh build [--adhoc]   swift build -c release, assemble "Polydance.app" with its icons, sign it;
#                                and build the speaker reader (speakers, below)
#   ./build.sh speakers          build polydance-speakers, which polycap's speakers step runs to read who Meet
#                                showed speaking in a call (docs/MAC.md P3a), into build/polydance-speakers
#   ./build.sh sign [--adhoc]    sign the assembled app again
#   ./build.sh test              swift test
#   ./build.sh snapshots <dir>   draw the look (the deck's parts, the control panel, the menu, thread rows, the
#                                window) into PNGs in <dir>, to compare with the headset app (docs/DESIGN-SYSTEM.md)
#   ./build.sh install           copy the app to ~/Applications, replacing an older copy, also one still named
#                                "Polydance Capture.app" (never launches it)
#   ./build.sh probe             run the built app's --probe self-check through LaunchServices, so the
#                                grants it reads are the app's own, not this terminal's (no permission is touched)
#   ./build.sh tabs [app]        ask Arc for its tabs once, as the detector does, under the app's own Automation
#                                grant: tab count, meeting codes, Meet's address form (no other address). [app]
#                                is the .app to run, by default the built one (the grant follows the signature)
#
# The app is named Polydance (2026-11-06; it was "Polydance Capture"). Its bundle id stays
# net.polydance.capture.mac, so the permissions already given carry over. Its icons are the ballerina:
# App/Resources (drawn by design/icons.py, the style every platform's icon follows) and the logo itself,
# copied from the headset app.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/build"
APP="$OUT/Polydance.app"
# The name the app had until 2026-11-06, replaced where this script finds it.
OLD_NAME="Polydance Capture.app"
EXECUTABLE="Polydance"
LOGO="$HERE/../app/android/app/src/main/res/drawable-nodpi/polydance_mark.png"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
BUNDLE_ID="net.polydance.capture.mac"
PLISTBUDDY=/usr/libexec/PlistBuddy

say() { printf '%s\n' "$*"; }
fail() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

# The commit the app was built from, for appBuild.commit; "-dirty" when a tracked file has changed, or
# an untracked file sits in mac/ (what is built). Untracked files elsewhere, like a backup folder in the
# checkout, do not change the app, so they do not make it dirty.
commit() {
  local c
  c="$(git -C "$HERE" rev-parse --short=7 HEAD 2>/dev/null)" || return 0
  if [ -n "$(git -C "$HERE" status --porcelain --untracked-files=no 2>/dev/null)$(git -C "$HERE" status --porcelain -- . 2>/dev/null)" ]; then c="$c-dirty"; fi
  printf '%s' "$c"
}

# The speaker reader is a command-line tool polycap runs, not part of the app, and needs no permission:
# it reads a video file. polycap looks for it at build/polydance-speakers (src/config.ts speakersBin).
cmd_speakers() {
  say "Building the speaker reader (release)…"
  swift build -c release --package-path "$HERE" --product polydance-speakers
  local bin
  bin="$(swift build -c release --package-path "$HERE" --show-bin-path)"
  [ -x "$bin/polydance-speakers" ] || fail "no polydance-speakers in $bin"
  mkdir -p "$OUT"
  cp "$bin/polydance-speakers" "$OUT/polydance-speakers.new"
  mv -f "$OUT/polydance-speakers.new" "$OUT/polydance-speakers"
  "$OUT/polydance-speakers" --version >/dev/null || fail "the built polydance-speakers does not run"
  say "Built $OUT/polydance-speakers"
}

cmd_build() {
  local adhoc="${1:-}"
  say "Building (release)…"
  swift build -c release --package-path "$HERE" --product PolydanceCapture
  local bin
  bin="$(swift build -c release --package-path "$HERE" --show-bin-path)"
  [ -x "$bin/PolydanceCapture" ] || fail "no PolydanceCapture in $bin"

  # Only this script's own output is replaced.
  case "$APP" in "$HERE/build/"*) ;; *) fail "refusing to replace $APP" ;; esac
  rm -rf "$APP" "$OUT/$OLD_NAME"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$bin/PolydanceCapture" "$APP/Contents/MacOS/$EXECUTABLE"
  cp "$HERE/App/Info.plist" "$APP/Contents/Info.plist"
  [ -f "$LOGO" ] || fail "the logo is not at $LOGO"
  cp "$HERE/App/Resources/AppIcon.icns" "$HERE/App/Resources/MenuBarDancer.png" "$HERE/App/Resources/MenuBarDancer@2x.png" "$APP/Contents/Resources/"
  cp "$LOGO" "$APP/Contents/Resources/PolydanceMark.png"
  printf 'APPL????' > "$APP/Contents/PkgInfo"
  local c
  c="$(commit)"
  if [ -n "$c" ]; then
    "$PLISTBUDDY" -c "Set :PolydanceCommit $c" "$APP/Contents/Info.plist"
  else
    "$PLISTBUDDY" -c "Delete :PolydanceCommit" "$APP/Contents/Info.plist"
  fi
  plutil -lint -s "$APP/Contents/Info.plist" || fail "Info.plist is not valid"
  say "Assembled $APP (commit ${c:-unknown})"
  cmd_sign "$adhoc"
  cmd_speakers
}

# The SHA-1 of the first valid "Apple Development:" identity, so two certificates with the same name
# cannot make codesign ambiguous.
find_identity() {
  security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/"Apple Development: / { split($1, a, " "); print a[2]; exit }'
}

cmd_sign() {
  local adhoc="${1:-}"
  [ -d "$APP" ] || fail "nothing to sign: run ./build.sh build first"
  local identity label
  if [ "$adhoc" = "--adhoc" ]; then
    identity="-"
    label="ad hoc"
    say "WARNING: ad hoc signing. macOS ties permissions to the signature, and an ad hoc signature changes"
    say "with every build, so the microphone, system audio, screen and Automation will be asked for again"
    say "after each build. Use it only to try a build on a Mac without a development certificate."
  elif [ -n "${POLYCAP_MAC_SIGN_IDENTITY:-}" ]; then
    identity="$POLYCAP_MAC_SIGN_IDENTITY"
    label="$identity (POLYCAP_MAC_SIGN_IDENTITY)"
  else
    identity="$(find_identity)"
    [ -n "$identity" ] || fail "no \"Apple Development\" signing identity in the keychain. Get the free one: Xcode, Settings, Accounts,
  add your Apple ID, select its Personal Team, Manage Certificates, + Apple Development. Or make a self-signed
  code-signing certificate in Keychain Access (Certificate Assistant, Create a Certificate, type Code Signing)
  and set POLYCAP_MAC_SIGN_IDENTITY to its name. To sign ad hoc anyway: ./build.sh build --adhoc"
    label="$(security find-identity -v -p codesigning | awk -F'"' -v id="$identity" 'index($0, id) { print $2; exit }') ($identity)"
  fi
  say "Signing with $label…"
  codesign --force --options runtime --timestamp=none --identifier "$BUNDLE_ID" \
    --entitlements "$HERE/App/PolydanceCapture.entitlements" --sign "$identity" "$APP"
  codesign --verify --strict --verbose=1 "$APP"
  say "Signed $APP"
}

cmd_test() {
  swift test --package-path "$HERE"
}

cmd_snapshots() {
  local dir="${1:-}"
  [ -n "$dir" ] || fail "say where the pictures go: ./build.sh snapshots <dir>"
  mkdir -p "$dir"
  POLYDANCE_SNAPSHOTS="$(cd "$dir" && pwd)" swift test --package-path "$HERE" --filter LookSnapshots
  say "Pictures in $dir"
}

cmd_install() {
  [ -d "$APP" ] || fail "nothing to install: run ./build.sh build first"
  local dest="$HOME/Applications/Polydance.app" old="$HOME/Applications/$OLD_NAME"
  if pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1 || pgrep -f "$old/Contents/MacOS/" >/dev/null 2>&1; then
    fail "Polydance is running from ~/Applications; quit it from its menu first"
  fi
  # The copy under the old name is removed only when it is this app (same bundle id), nothing else.
  if [ -d "$old" ]; then
    local id
    id="$("$PLISTBUDDY" -c "Print :CFBundleIdentifier" "$old/Contents/Info.plist" 2>/dev/null || true)"
    [ "$id" = "$BUNDLE_ID" ] || fail "$old is not this app (bundle id ${id:-unknown}); leaving it, and not installing"
    "$LSREGISTER" -u "$old" >/dev/null 2>&1 || true
    rm -rf "$old"
    say "Removed $old (the same app under its old name)"
  fi
  mkdir -p "$HOME/Applications"
  # Replaces exactly the older copy of this app, nothing else.
  if [ -d "$dest" ]; then rm -rf "$dest"; fi
  ditto "$APP" "$dest"
  # So Finder, Spotlight and the permission lists show the new name and icon now, not after a while.
  "$LSREGISTER" -f "$dest" >/dev/null 2>&1 || true
  say "Installed $dest (not launched)"
}

# Run directly from a shell, the executable's grants would be the terminal's (macOS holds the launching
# process responsible), so the probe and the tab check are launched with `open`, which gives the app's
# own. Their output goes to files under build/ (0600) that are printed and removed.
through_launch_services() {
  local app="$1" flag="$2" name="$3"
  local executable
  executable="$("$PLISTBUDDY" -c "Print :CFBundleExecutable" "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$executable" ] && [ -x "$app/Contents/MacOS/$executable" ] || fail "nothing to run at $app: run ./build.sh build first"
  mkdir -p "$OUT"
  local out="$OUT/$name.json" err="$OUT/$name.err" status=0
  ( umask 077; : > "$out"; : > "$err" )
  open -W -n --stdout "$out" --stderr "$err" "$app" --args "$flag" || status=$?
  cat "$out"
  if [ -s "$err" ]; then cat "$err" >&2; fi
  rm -f "$out" "$err"
  return "$status"
}

cmd_probe() { through_launch_services "$APP" --probe probe; }

cmd_tabs() { through_launch_services "${1:-$APP}" --arc-tabs arc-tabs; }

case "${1:-}" in
  build) cmd_build "${2:-}" ;;
  speakers) cmd_speakers ;;
  sign) cmd_sign "${2:-}" ;;
  test) cmd_test ;;
  snapshots) cmd_snapshots "${2:-}" ;;
  install) cmd_install ;;
  probe) cmd_probe ;;
  tabs) cmd_tabs "${2:-}" ;;
  *) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
