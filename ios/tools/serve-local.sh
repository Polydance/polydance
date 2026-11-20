#!/usr/bin/env bash
# A receiver on this Mac for the iPhone to upload to and read threads from (docs/IPHONE.md I0 and I3):
# `polycap serve` on port 8790 of every interface, so the phone reaches it as http://<this Mac>.local:8790
# (over the USB cable; on Wi-Fi it did not, 2026-11-07).
# Everything it writes lives under <repo>/.local/iphone-probe (gitignored, 0700), never the real library,
# from which it only reads the whisper model (~/PolydanceCapture/models/ggml-large-v3-turbo.bin):
#
#   receiver/          POLYCAP_ROOT: the uploads and the bundles they become
#   token              the phone's upload token (0600), made once, never printed
#   agent.env          an agent's read and post token for this receiver (0600), as POLYCAP_REMOTE_URL and
#                      POLYCAP_REMOTE_TOKEN, so `POLYCAP_CONFIG=<it> npm run polycap -- thread …` posts here
#   tokens.json        both entries for POLYCAP_SERVER_TOKENS (the tokens' sha256 only)
#   users.json         POLYCAP_USERS: robin, so the probe's messages read "Robin · iPhone probe"
#   polycap.env        an empty settings file, so ~/.config/polycap/env (keys, the real library) is never read
#   probe-config.json  {"v":1,"server":"http://<mac>.local:8790","token":…} (0600): the pairing, for
#                      `ios/build.sh pair --config-file` (a QR code) or `configure --config-file` (USB)
#
# The server runs with a clean environment: no Anthropic or Gladia key reaches it, and the summary and
# pointing steps are off. Threads are on (since I3, 2026-11-07) with two test projects, CAP "Polydance
# Capture" and MUS "Marimba", whose launches may open https://example.com only, and reports from the bug
# key go to CAP, as on the live receiver. The transcriber is whisper.cpp when whisper-cli and that model
# are on this Mac (the model is read, never written), else none.
# Delete .local/iphone-probe to start again with new tokens (the phone then needs pairing again).
#
#   ios/tools/serve-local.sh               set up (once) and serve in the foreground; Ctrl-C stops it
#   ios/tools/serve-local.sh --setup-only  set up and print where things are, without serving
set -euo pipefail

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

setup_only=false
for arg in "$@"; do
  case "$arg" in
    --setup-only) setup_only=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "serve-local: unknown option $arg (--setup-only, --help)" >&2; exit 2 ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state="$repo/.local/iphone-probe"
root="$state/receiver"
port=8790
token_id=iphone-probe
agent_id=agent
model="$HOME/PolydanceCapture/models/ggml-large-v3-turbo.bin"
tsx="$repo/node_modules/.bin/tsx"
cli="$repo/src/cli.ts"

node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || { echo "serve-local: node is not on PATH" >&2; exit 1; }
[[ -x "$tsx" ]] || { echo "serve-local: $tsx is missing; run npm ci in $repo" >&2; exit 1; }

umask 077
mkdir -p "$state" "$root"
chmod 700 "$state" "$root"
[[ -e "$state/polycap.env" ]] || printf '# Empty on purpose: serve-local.sh keeps polycap away from ~/.config/polycap/env.\n' > "$state/polycap.env"
chmod 600 "$state/polycap.env"

# polycap with only what this script gives it: PATH and HOME, and the probe's own settings file and root.
polycap() {
  env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    POLYCAP_CONFIG="$state/polycap.env" POLYCAP_ROOT="$root" \
    "$@"
}

# Fails unless the file is ours and 0600: these files hold a token or say which tokens the server takes.
check_private() {
  local file="$1" mode
  mode="$(stat -f '%Lp' "$file")"
  [[ "$mode" == 600 ]] || { echo "serve-local: $file is mode $mode, not 600; fix it or delete $state" >&2; exit 1; }
}

# 1. The token, made once with the repository's own CLI. Its JSON reply goes straight into node, which
#    writes the two files; the token never passes through this shell or the terminal.
if [[ -e "$state/token" && -e "$state/tokens.json" ]]; then
  check_private "$state/token"
  check_private "$state/tokens.json"
  echo "Token: kept from before ($state/token, not shown)"
elif [[ -e "$state/token" || -e "$state/tokens.json" ]]; then
  echo "serve-local: only one of $state/token and tokens.json exists; delete both to make a new token" >&2
  exit 1
else
  write_token_js="$(cat <<'JS'
const fs = require("node:fs");
const [tokenFile, grantsFile, id] = process.argv.slice(1);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => {
  // Never echo the input: it holds the token.
  let reply;
  try { reply = JSON.parse(input); } catch { console.error("serve-local: polycap token new did not reply with JSON"); process.exit(1); }
  if (!reply || typeof reply !== "object") { console.error("serve-local: polycap token new did not reply with an object"); process.exit(1); }
  const grant = reply.grant;
  if (typeof reply.token !== "string" || !/^polycap_[0-9a-f]{64}$/.test(reply.token)) { console.error("serve-local: the reply has no polycap token"); process.exit(1); }
  if (!grant || grant.id !== id || !/^[0-9a-f]{64}$/.test(grant.sha256) || JSON.stringify(grant.scopes) !== JSON.stringify(["upload"]) || grant.user !== "robin") {
    console.error("serve-local: the reply's grant is not the upload token asked for"); process.exit(1);
  }
  fs.writeFileSync(tokenFile, reply.token + "\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(grantsFile, JSON.stringify([grant]) + "\n", { mode: 0o600, flag: "wx" });
});
JS
)"
  polycap "$tsx" "$cli" token new --id "$token_id" --team --scope upload --user robin --label "iPhone probe" --json \
    | "$node_bin" -e "$write_token_js" "$state/token" "$state/tokens.json" "$token_id"
  check_private "$state/token"
  check_private "$state/tokens.json"
  echo "Token: made $token_id (upload, user robin) in $state/token (not shown)"
fi

# 1b. The agent's token (read and post, user robin, label Mac), made once and added to tokens.json, so an
#     agent on this Mac can open threads and post messages for the phone to read. Like the phone's, it
#     goes from polycap's JSON reply straight into node, which writes agent.env and the grant.
if [[ -e "$state/agent.env" ]]; then
  check_private "$state/agent.env"
  echo "Agent token: kept from before ($state/agent.env, not shown)"
else
  write_agent_js="$(cat <<'JS'
const fs = require("node:fs");
const [envFile, grantsFile, id, url] = process.argv.slice(1);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => {
  let reply;
  try { reply = JSON.parse(input); } catch { console.error("serve-local: polycap token new did not reply with JSON"); process.exit(1); }
  const grant = reply && reply.grant;
  if (typeof reply.token !== "string" || !/^polycap_[0-9a-f]{64}$/.test(reply.token)) { console.error("serve-local: the reply has no polycap token"); process.exit(1); }
  if (!grant || grant.id !== id || JSON.stringify(grant.scopes) !== JSON.stringify(["read", "post"]) || grant.user !== "robin") {
    console.error("serve-local: the reply's grant is not the agent token asked for"); process.exit(1);
  }
  const grants = JSON.parse(fs.readFileSync(grantsFile, "utf8"));
  if (!Array.isArray(grants) || grants.some(g => g.id === id)) { console.error("serve-local: tokens.json already has " + id + "; delete " + grantsFile + " and token to start again"); process.exit(1); }
  fs.writeFileSync(envFile, "POLYCAP_REMOTE_URL=" + url + "\nPOLYCAP_REMOTE_TOKEN=" + reply.token + "\n", { mode: 0o600, flag: "wx" });
  const tmp = grantsFile + ".tmp";
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify([...grants, grant]) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, grantsFile);
});
JS
)"
  polycap "$tsx" "$cli" token new --id "$agent_id" --team --scope read --scope post --user robin --label Mac --json \
    | "$node_bin" -e "$write_agent_js" "$state/agent.env" "$state/tokens.json" "$agent_id" "http://127.0.0.1:$port"
  check_private "$state/agent.env"
  check_private "$state/tokens.json"
  echo "Agent token: made $agent_id (read and post, user robin) in $state/agent.env (not shown)"
fi

# 2. POLYCAP_USERS, so the token's person exists on this receiver.
users_js='require("node:fs").writeFileSync(process.argv[1], JSON.stringify([{ id: process.argv[2], name: process.argv[3] }]) + "\n", { mode: 0o600 })'
"$node_bin" -e "$users_js" "$state/users.json" robin Robin
chmod 600 "$state/users.json"

# 3. The phone's config, rewritten each time in case this Mac's name changed.
host="$(scutil --get LocalHostName 2>/dev/null || true)"
[[ "$host" =~ ^[A-Za-z0-9-]{1,63}$ ]] || { echo "serve-local: this Mac has no usable LocalHostName (scutil --get LocalHostName)" >&2; exit 1; }
server="http://$host.local:$port"
config_js="$(cat <<'JS'
const fs = require("node:fs");
const [file, server, tokenFile] = process.argv.slice(1);
const token = fs.readFileSync(tokenFile, "utf8").trim();
if (!/^polycap_[0-9a-f]{64}$/.test(token)) { console.error("serve-local: " + tokenFile + " does not hold a polycap token"); process.exit(1); }
const tmp = file + ".tmp";
fs.rmSync(tmp, { force: true });
fs.writeFileSync(tmp, JSON.stringify({ v: 1, server, token }) + "\n", { mode: 0o600, flag: "wx" });
fs.renameSync(tmp, file);
JS
)"
"$node_bin" -e "$config_js" "$state/probe-config.json" "$server" "$state/token"
check_private "$state/probe-config.json"
echo "Phone config: $state/probe-config.json (server $server); ios/build.sh configure copies it to the phone"

# 4. The transcriber: whisper.cpp only when both the binary and the model are here.
whisper="$(command -v whisper-cli || true)"
if [[ -n "$whisper" && -f "$model" ]]; then
  transcriber=whisper-cpp
  echo "Transcriber: whisper-cpp ($whisper, $model)"
else
  transcriber=none
  echo "Transcriber: none (whisper-cli ${whisper:-not on PATH}; model ${model} $([[ -f "$model" ]] && echo found || echo missing))"
fi

if $setup_only; then
  echo "Receiver root: $root"
  echo "Set up; not serving (--setup-only)."
  exit 0
fi

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "serve-local: $tool is not on PATH; the receiver needs it to build bundles" >&2; exit 1; }
done

tokens="$(cat "$state/tokens.json")"
users="$(cat "$state/users.json")"
projects='[{"key":"CAP","name":"Polydance Capture","hosts":["example.com"]},{"key":"MUS","name":"Marimba","hosts":["example.com"]}]'
echo "Threads: CAP and MUS (links to example.com), reports to CAP; post as the agent with"
echo "  POLYCAP_CONFIG=$state/agent.env npm run polycap -- thread new --project CAP --title … --text … --open https://example.com/"
echo "Serving on $server (and http://127.0.0.1:$port); Ctrl-C stops it."
cd "$repo"
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  POLYCAP_CONFIG="$state/polycap.env" POLYCAP_ROOT="$root" \
  POLYCAP_SERVER_TOKENS="$tokens" POLYCAP_USERS="$users" POLYCAP_PROJECTS="$projects" POLYCAP_REPORTS=CAP \
  POLYCAP_TRANSCRIBER="$transcriber" POLYCAP_WHISPER_BIN="${whisper:-whisper-cli}" POLYCAP_WHISPER_MODEL="$model" \
  POLYCAP_SUMMARIZER=none POLYCAP_POINTING=none \
  "$tsx" "$cli" serve --host 0.0.0.0 --port "$port"
