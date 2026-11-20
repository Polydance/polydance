#!/usr/bin/env python3
"""
Adds one token's entry to the receiver's POLYCAP_SERVER_TOKENS (docs/HOSTED.md "Tokens"), such as the
iPhone's (docs/IPHONE.md P1). Run on the receiver's host, as root, against the receiver's env file, with the entry
`polycap token new --json` printed as `grant`: its id, the token's sha256, scopes, user and label, never
the token itself. It:

- refuses an entry whose id is already there (take the old one out by hand first), whose sha256 is not
  64 lowercase hex digits, whose scopes are not upload, read and post, whose keys are not a grant's, whose
  user is not in POLYCAP_USERS, whose projects are not in POLYCAP_PROJECTS, or whose expiresAt is not a
  time with its zone or is already past (2026-11-12; a receiver older than that refuses expiresAt at start-up,
  and recreate.py then puts the old container back, so deploy a newer receiver first);
- keeps a dated backup beside the file, keeps the file's owner and mode (0600), and prints only token ids,
  scopes, users, labels and projects, never a hash or a key.

The receiver reads the file when its container is created, so the container is recreated afterwards with
recreate.py (a dry run, then --swap).

  cat deploy/receiver/add-token.py | ssh you@receiver-host \\
    "sudo -n python3 - /path/to/receiver.env '<grant JSON>'"
"""
import json
import os
import re
import shutil
import sys
import time

KEYS = {"id", "sha256", "scopes", "projects", "user", "label", "threads", "expiresAt"}
ISO = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})"

path, raw = sys.argv[1], sys.argv[2]
grant = json.loads(raw)
if not isinstance(grant, dict) or not set(grant) <= KEYS or not {"id", "sha256", "scopes"} <= set(grant):
    sys.exit(f"the entry must be a grant with id, sha256 and scopes (and only {', '.join(sorted(KEYS))}); nothing changed")
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", grant["id"]):
    sys.exit("the entry's id is not a token id (lowercase letters, digits and dashes); nothing changed")
if not re.fullmatch(r"[0-9a-f]{64}", grant["sha256"]):
    sys.exit("the entry's sha256 is not 64 lowercase hex digits; nothing changed")
if not grant["scopes"] or not set(grant["scopes"]) <= {"upload", "read", "post"}:
    sys.exit("the entry's scopes must be some of upload, read and post; nothing changed")
if "expiresAt" in grant:
    if not isinstance(grant["expiresAt"], str) or not re.fullmatch(ISO, grant["expiresAt"]):
        sys.exit("the entry's expiresAt must be a time with its zone, as polycap token new writes it; nothing changed")
    from datetime import datetime, timezone
    if datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        sys.exit(f"the entry expired at {grant['expiresAt']}; make a new token; nothing changed")

status = os.stat(path)
env = open(path).read().split("\n")
keys = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in env if "=" in line and not line.startswith("#")}
if "POLYCAP_SERVER_TOKENS" not in keys:
    sys.exit("no POLYCAP_SERVER_TOKENS in the file; nothing changed")
grants = json.loads(keys["POLYCAP_SERVER_TOKENS"])
if any(g["id"] == grant["id"] for g in grants):
    sys.exit(f"POLYCAP_SERVER_TOKENS already has {grant['id']}; nothing changed")
if any(g.get("sha256") == grant["sha256"] for g in grants):
    sys.exit("POLYCAP_SERVER_TOKENS already has a token with that sha256; nothing changed")
users = json.loads(keys.get("POLYCAP_USERS", "[]"))
if "user" in grant and not any(u["id"] == grant["user"] for u in users):
    sys.exit(f"POLYCAP_USERS has no {grant['user']}; nothing changed")
projects = [p["key"] for p in json.loads(keys.get("POLYCAP_PROJECTS", "[]"))]
unknown = [p for p in grant.get("projects", []) if p not in projects]
if unknown:
    sys.exit(f"POLYCAP_PROJECTS has no {', '.join(unknown)}; nothing changed")

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 2
while os.path.exists(backup):
    backup, n = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}", n + 1
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

grants.append(grant)
value = json.dumps(grants, separators=(",", ":"))
lines = [line if line.split("=", 1)[0] != "POLYCAP_SERVER_TOKENS" else f"POLYCAP_SERVER_TOKENS={value}" for line in env]

temp = path + ".tmp"
with open(temp, "w") as out:
    out.write("\n".join(lines))
os.chmod(temp, 0o600)
os.chown(temp, status.st_uid, status.st_gid)
os.replace(temp, path)
print("backup:", backup)
print("added:", (grant["id"], grant["scopes"], grant.get("user"), grant.get("label"), grant.get("projects", "every project"), grant.get("expiresAt", "never expires")))
print("tokens:", [(g["id"], g["scopes"], g.get("user"), g.get("label"), g.get("expiresAt", "never")) for g in grants])
