#!/usr/bin/env python3
"""
Turns on Meta sign-in for store testers (private/docs/STORE.md) in the receiver's env file on the receiver's host. Run
as root against that file, with the app secret on standard input, never as an argument. It:

- sets POLYCAP_META_APP_ID (Polydance's app in the Meta Horizon Developer Dashboard) and
  POLYCAP_META_APP_SECRET (Development -> API -> App Secret, read from stdin);
- sets POLYCAP_META_TESTERS: which projects testers' recordings go to (--projects, default MUS; the
  first is where a recording that names no thread starts one), how many testers at most (--max, default
  25), and people already in POLYCAP_USERS by their Meta user id (--person META_ID=robin, repeatable;
  confirm this app-scoped ID on the app's Recordings page). People already mapped are kept. This is
  attribution only: use link-meta-account.py after verified enrollment for explicit legacy continuity;
- appends --block META_ID (repeatable) to the local denylist, retaining earlier blocks on rerun.
  Restart/recreate the receiver to enforce it; release-channel removal alone is not reliable revocation;
- with --contact, sets POLYCAP_PRIVACY_CONTACT, the email address the privacy notice at /privacy gives.

Moving to another Meta app (2026-10-12: 1593561244982561, made under the wrong team, to 1300818073125870)
needs that app's secret. Meta user IDs are scoped to an app, so people, accounts and blocks recorded under
the old app would name nobody, or someone else, under the new one: the script stops while there are any,
unless --forget-old-ids clears them (the dated backup keeps them). Testers who signed in under the old app
fail the receiver's next hourly entitlement check and must sign in again with the new build.

It keeps a dated backup beside the file, keeps the file's owner and mode (0600), and prints the settings
without the secret. The container reads the file when it is created, so recreate it afterwards.

  R="ssh you@receiver-host"
  $R "sudo -n python3 -c 'import base64,sys; exec(base64.b64decode(sys.argv.pop(1)))' $(base64 < deploy/receiver/enable-meta.py | tr -d '\\n') /path/to/receiver.env --contact you@example.com" < ~/.config/polycap/meta-app-secret
"""
import argparse
import json
import os
import re
import shutil
import sys
import time
import tempfile

# Polydance on the right team since 2026-10-12; 1593561244982561 was made under the wrong one and is gone.
# Rerunning with this file replaces an older POLYCAP_META_APP_ID; the secret on stdin must be this app's.
APP_ID = "1300818073125870"

parser = argparse.ArgumentParser(description="Enable private-beta Meta sign-in; secret on stdin", allow_abbrev=False)
parser.add_argument("env_file")
for flag in ("--projects", "--max", "--person", "--contact", "--block"):
    parser.add_argument(flag, action="append")
parser.add_argument("--forget-old-ids", action="store_true", help="when moving to a new Meta app, clear Meta IDs recorded under the old one")
args = parser.parse_args()
path = args.env_file

def option(name):
    return getattr(args, name[2:].replace("-", "_")) or []

secret = sys.stdin.read().strip()
if not re.fullmatch(r"[A-Za-z0-9]{16,128}", secret):
    sys.exit("standard input does not hold an app secret (Development -> API -> App Secret); nothing changed")

status = os.stat(path)
env = open(path).read().split("\n")
keys = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in env if "=" in line and not line.startswith("#")}
projects_known = [p["key"] for p in json.loads(keys.get("POLYCAP_PROJECTS", "[]"))]
users_known = [u["id"] for u in json.loads(keys.get("POLYCAP_USERS", "[]"))]

testers = json.loads(keys.get("POLYCAP_META_TESTERS", "{}") or "{}")
previous_app = keys.get("POLYCAP_META_APP_ID") or None
switching = previous_app is not None and previous_app != APP_ID
if switching:
    scoped = [name for name in ("people", "accounts", "blockedUsers") if testers.get(name)]
    if scoped and not args.forget_old_ids:
        sys.exit(f"the env holds Meta IDs from app {previous_app} ({', '.join(scoped)}); they do not carry over to app {APP_ID}. "
                 "Check them, then rerun with --forget-old-ids to clear them. Nothing changed")
    testers = {key: value for key, value in testers.items() if key not in ("people", "accounts", "blockedUsers")}
elif args.forget_old_ids:
    sys.exit(f"--forget-old-ids is only for moving to a new app; the env is already for {APP_ID}. Nothing changed")
projects = (option("--projects") or [",".join(testers.get("projects", ["MUS"]))])[-1].upper().split(",")
missing = [p for p in projects if p not in projects_known]
if missing:
    sys.exit(f"POLYCAP_PROJECTS has no {', '.join(missing)}; run enable-threads.py first. Nothing changed")
people = dict(testers.get("people", {}))
for pair in option("--person"):
    meta_id, _, user = pair.partition("=")
    if not re.fullmatch(r"[0-9]{1,20}", meta_id) or user not in users_known:
        sys.exit("--person needs META_ID=USER with USER in POLYCAP_USERS. Nothing changed")
    account = testers.get("accounts", {}).get(meta_id)
    if (meta_id in people and people[meta_id] != user) or (account is not None and account.get("user") != user):
        sys.exit("--person conflicts with existing attribution/account mapping. Nothing changed")
    people[meta_id] = user
maximum_values = option("--max") or [str(testers.get("maxTesters", 25))]
if any(not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= 2500 for value in maximum_values):
    sys.exit("--max must be a whole number from 1 to 2500. Nothing changed")
maximum = int(maximum_values[-1])
blocked = testers.get("blockedUsers", [])
if not isinstance(blocked, list) or any(not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value) for value in blocked):
    sys.exit("existing blockedUsers must be an array of Meta IDs. Nothing changed")
for meta_id in option("--block"):
    if not re.fullmatch(r"[0-9]{1,20}", meta_id):
        sys.exit("--block needs a Meta user ID (1 to 20 digits). Nothing changed")
    if meta_id not in blocked:
        blocked.append(meta_id)
# Preserve explicit continuity accounts and every unrelated/future setting on rerun.
# Rebuilding a whitelist here used to silently discard accounts and their legacy ownership links.
testers = {**testers, "projects": projects, "maxTesters": maximum, "people": people, "blockedUsers": blocked}

values = {
    "POLYCAP_META_APP_ID": APP_ID,
    "POLYCAP_META_APP_SECRET": secret,
    "POLYCAP_META_TESTERS": json.dumps(testers, separators=(",", ":")),
}
contact = option("--contact")
if contact:
    if not re.fullmatch(r"[^\s@<>\"]+@[^\s@<>\"]+\.[A-Za-z]{2,}", contact[-1]):
        sys.exit(f"--contact {contact[-1]} is not an email address. Nothing changed")
    values["POLYCAP_PRIVACY_CONTACT"] = contact[-1]

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 2
while os.path.exists(backup):
    backup, n = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}", n + 1
# Secrets are never briefly world-readable, even when the operator has a permissive umask.
with open(path, "rb") as source, open(backup, "xb", opener=lambda name, flags: os.open(name, flags, 0o600)) as out:
    shutil.copyfileobj(source, out)
os.chown(backup, status.st_uid, status.st_gid)

lines = [line for line in env if line.split("=", 1)[0] not in values]
while lines and lines[-1] == "":
    lines.pop()
lines += [f"{key}={value}" for key, value in values.items()] + [""]

fd, temp = tempfile.mkstemp(prefix=".receiver-env-", dir=os.path.dirname(os.path.abspath(path)))
try:
    with os.fdopen(fd, "w") as out:
        out.write("\n".join(lines))
        out.flush()
        os.fsync(out.fileno())
    os.chown(temp, status.st_uid, status.st_gid)
    os.replace(temp, path)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print("backup:", backup)
print("app:", APP_ID, "secret: set (not shown)" + (f"; moved from app {previous_app}, whose Meta IDs were not carried over" if switching else ""))
print("testers: projects and limits configured; " + ("people, accounts and blocks from the old app cleared" if switching else "existing people, accounts and local blocks retained") + " (identities not shown)")
print("Private beta only; app entitlement is not channel membership. Restart/recreate the receiver to apply local blocks.")
print("privacy contact:", values.get("POLYCAP_PRIVACY_CONTACT", keys.get("POLYCAP_PRIVACY_CONTACT", "none")))
