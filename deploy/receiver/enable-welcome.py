#!/usr/bin/env python3
"""
Turns on the Welcome (docs/THREADS.md, The Welcome; 2026-11-10) in the receiver's env file on the receiver's host:
the START project ("Getting started") with the receiver's own host, so the Welcome's launch may open
/start; POLYCAP_WELCOME naming that project and page; and START as where newcomers' own recordings go.

Signed-in testers' default projects (POLYCAP_META_TESTERS and, when set, POLYCAP_GOOGLE_TESTERS) get START
first, keeping the others, and every linked Meta account (`accounts`) gets START among its own projects. With --start-only they become START alone, so a newcomer cannot open a thread in
an existing project; that is refused while any tester is mapped to a person (`people`) without an
`accounts` entry of their own, since a mapped team person's headset sees threads through those projects
and would lose the rest. It prints a count, never who.

Run as root against that file. It keeps a dated backup beside the file and the file's owner and mode
(0600), and prints only project keys, hosts and the page. The container reads the file when it is created,
so recreate it afterwards (private/deploy/receiver/recreate.py). nginx needs `location = /start` as in
nginx-site.conf.example, or the page and the Welcome's launch are a 404 from outside.

  R="ssh you@receiver-host"
  $R "sudo -n python3 - /path/to/receiver.env" < deploy/receiver/enable-welcome.py
  $R "sudo -n python3 - /path/to/receiver.env --start-only" < deploy/receiver/enable-welcome.py
"""
import json
import os
import re
import shutil
import sys
import time

args = sys.argv[1:]
start_only = "--start-only" in args
args = [a for a in args if a != "--start-only"]
host = "capture.polydance.net"
if "--host" in args:
    i = args.index("--host")
    if i + 1 >= len(args):
        sys.exit("--host needs a host name; nothing changed")
    host = args[i + 1]
    del args[i:i + 2]
if len(args) != 1:
    sys.exit("usage: enable-welcome.py ENV_FILE [--host HOST] [--start-only]")
if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", host):
    sys.exit(f"{host} is not a host name; nothing changed")
path = args[0]
KEY = "START"

status = os.stat(path)
lines = open(path).read().split("\n")
values = {}
for line in lines:
    if "=" in line and not line.startswith("#"):
        name, value = line.split("=", 1)
        values[name] = value


def read(name):
    raw = values.get(name)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        sys.exit(f"{name} is not JSON; nothing changed")


projects = read("POLYCAP_PROJECTS")
if not isinstance(projects, list):
    sys.exit("POLYCAP_PROJECTS is not set: threads are off, so there is nowhere for a Welcome; nothing changed")
start = next((p for p in projects if p.get("key") == KEY), None)
before_hosts = list(start.get("hosts", [])) if start else None
if start is None:
    start = {"key": KEY, "name": "Getting started", "hosts": [host]}
    projects.append(start)
elif host not in start.setdefault("hosts", []):
    start["hosts"].append(host)

changes = {
    "POLYCAP_PROJECTS": projects,
    "POLYCAP_WELCOME": {"project": KEY, "url": f"https://{host}/start"},
}
report = [f"{KEY} hosts: {before_hosts if before_hosts is not None else '(new project)'} -> {start['hosts']}",
          f"welcome: {KEY}, https://{host}/start"]

for name in ("POLYCAP_META_TESTERS", "POLYCAP_GOOGLE_TESTERS"):
    testers = read(name)
    if testers is None:
        continue
    before = list(testers.get("projects", []))
    if start_only:
        accounts = testers.get("accounts", {}) if name == "POLYCAP_META_TESTERS" else {}
        unlinked = [k for k in testers.get("people", {}) if k not in accounts]
        if unlinked:
            sys.exit(f"{name}: {len(unlinked)} mapped tester(s) have no accounts entry, so START alone would leave "
                     "their headset seeing only START; give them accounts entries first, or run without --start-only. Nothing changed")
        after = [KEY]
    else:
        after = [KEY] + [p for p in before if p != KEY]
    testers["projects"] = after
    report.append(f"{name} projects: {before} -> {after}")
    # A linked account's projects must cover its legacy headset token's, and a token with no projects reaches
    # every one, START now included, or the receiver refuses to start (serve.ts; found on 2026-11-10's deploy).
    # START in every linked account is that, and lets the team's own headsets see newcomers' threads.
    linked = [a for a in testers.get("accounts", {}).values() if KEY not in a.get("projects", [])]
    for account in linked:
        account.setdefault("projects", []).append(KEY)
    if linked:
        report.append(f"{name} accounts given {KEY}: {len(linked)}")
    changes[name] = testers

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 1
while os.path.exists(backup):  # two runs in one second must not overwrite the first backup
    n += 1
    backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}"
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

out = []
written = set()
for line in lines:
    name = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
    if name in changes:
        if name not in written:
            out.append(f"{name}={json.dumps(changes[name], separators=(',', ':'))}")
            written.add(name)
        continue
    out.append(line)
while out and out[-1] == "":
    out.pop()
for name, value in changes.items():
    if name not in written:
        out.append(f"{name}={json.dumps(value, separators=(',', ':'))}")
out.append("")

temp = path + ".tmp"
with open(temp, "w") as f:
    f.write("\n".join(out))
os.chmod(temp, 0o600)
os.chown(temp, status.st_uid, status.st_gid)
os.replace(temp, path)
print("backup:", backup)
for line in report:
    print(line)
