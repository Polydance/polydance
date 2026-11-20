#!/usr/bin/env python3
"""
Names the person behind the receiver's tokens, and with --pointing turns on the pointing pass
(docs/THREADS.md, docs/HOSTED.md). Run on the receiver's host, as root, against the receiver's env file. It:

- adds Robin to POLYCAP_USERS and gives the quest3 and mac tokens user "robin", with labels that name
  only the device, so messages read "Robin · Quest 3" and, from an agent, "Opus 5.5 on Robin's Mac";
- with --pointing, sets POLYCAP_POINTING=claude: each pointing frame (at most 24 a recording; frames
  show the room through passthrough) goes to Anthropic's API, with the line being said, to name what
  was pointed at. Without --pointing that setting is left as it is.

It keeps a dated backup beside the file, keeps the file's owner and mode (0600), and prints only token
ids, scopes, users and labels, never a hash or a key. The receiver reads the file when its container is
created, so the container is recreated afterwards. Replies are announced by the headset itself (Polydance
Capture's notifications), so there is nothing here for that.

  cat deploy/receiver/enable-loop.py | ssh you@receiver-host 'sudo -n python3 - /path/to/receiver.env --pointing'
"""
import json
import os
import shutil
import sys
import time

USERS = [{"id": "robin", "name": "Robin", "colour": "#d93a2b"}]
# Token id -> the person and the device it is.
GRANTS = {"quest3": ("robin", "Quest 3"), "mac": ("robin", "Mac")}

path = sys.argv[1]
pointing = "--pointing" in sys.argv[2:]
status = os.stat(path)
env = open(path).read().split("\n")
keys = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in env if "=" in line and not line.startswith("#")}
if "POLYCAP_SERVER_TOKENS" not in keys:
    sys.exit("no POLYCAP_SERVER_TOKENS in the file; nothing changed")
grants = json.loads(keys["POLYCAP_SERVER_TOKENS"])
missing = [g for g in GRANTS if not any(grant["id"] == g for grant in grants)]
if missing:
    sys.exit(f"no {', '.join(missing)} token in POLYCAP_SERVER_TOKENS; nothing changed")
for grant in grants:
    if grant["id"] in GRANTS:
        grant["user"], grant["label"] = GRANTS[grant["id"]]

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 2
while os.path.exists(backup):
    backup, n = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}", n + 1
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

values = {
    "POLYCAP_SERVER_TOKENS": json.dumps(grants, separators=(",", ":")),
    "POLYCAP_USERS": json.dumps(USERS, separators=(",", ":")),
}
if pointing:
    values["POLYCAP_POINTING"] = "claude"
lines = [line for line in env if line.split("=", 1)[0] not in values]
while lines and lines[-1] == "":
    lines.pop()
lines += [f"{key}={value}" for key, value in values.items()] + [""]

temp = path + ".tmp"
with open(temp, "w") as out:
    out.write("\n".join(lines))
os.chmod(temp, 0o600)
os.chown(temp, status.st_uid, status.st_gid)
os.replace(temp, path)
print("backup:", backup)
print("tokens:", [(g["id"], g["scopes"], g.get("user"), g.get("label")) for g in grants])
print("users:", [u["name"] for u in USERS])
print("pointing:", "claude" if pointing else keys.get("POLYCAP_POINTING", "none (unchanged)"))
