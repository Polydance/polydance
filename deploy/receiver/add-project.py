#!/usr/bin/env python3
"""
Adds one project to the receiver's POLYCAP_PROJECTS (docs/THREADS.md, Projects; 2026-11-13, for Robin's
Spottisphone). Projects exist only here: no app and no polycap command makes one, they choose among what
GET /v1/projects lists. enable-threads.py replaces the whole list and refuses to drop START, so a project
added after the Welcome goes in this way.

It appends the project, so the first project, where a token without projects of its own puts new
recordings' threads, stays first. Every token without `projects` (all of Robin's devices) sees it at once.
A linked Meta account (POLYCAP_META_TESTERS.accounts) must cover the projects of its legacy headset token,
and a token with no projects reaches every project, the new one included, or the receiver refuses to
start (serve.ts; found on 2026-11-10's deploy). Each such account is given the project; no other account,
and no tester's default projects, change. It prints a count, never who.

It refuses a key that is not 2 to 10 capital letters or digits starting with a letter, a key already
listed, a name that is empty or over 60 characters, and hosts or packages the receiver would refuse. Run as
root against that file: it keeps a dated backup beside it and the file's owner and mode (0600), and prints
only the project's key, name, hosts and packages. The container reads the file when it is created, so
recreate it afterwards (private/deploy/receiver/recreate.py, a dry run first, then --swap).

  R="ssh you@receiver-host"
  $R "sudo -n python3 - /path/to/receiver.env SPOT Spottisphone" < deploy/receiver/add-project.py
  $R "sudo -n python3 - ENV KEY 'Name' --host app.example.com --package com.example.app" < deploy/receiver/add-project.py
"""
import json
import os
import re
import shutil
import sys
import time

USAGE = "usage: add-project.py ENV_FILE KEY NAME [--host HOST ...] [--package PACKAGE ...]"
# As src/threads.ts: PROJECT_KEY, HOST_PATTERN and PACKAGE, so the receiver starts with what this writes.
KEY_PATTERN = r"[A-Z][A-Z0-9]{1,9}"
HOST_PATTERN = r"[a-z0-9-]*\*?[a-z0-9-]*(\.[a-z0-9-]+)+"
PACKAGE_PATTERN = r"[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+"

args, hosts, packages = sys.argv[1:], [], []
for flag, into in (("--host", hosts), ("--package", packages)):
    while flag in args:
        i = args.index(flag)
        if i + 1 >= len(args):
            sys.exit(f"{flag} needs a value; nothing changed")
        into.append(args[i + 1])
        del args[i:i + 2]
if len(args) != 3 or any(a.startswith("--") for a in args):
    sys.exit(USAGE)
path, key, name = args[0], args[1], args[2].strip()
if not re.fullmatch(KEY_PATTERN, key):
    sys.exit(f"{key} is not a project key (2 to 10 capital letters or digits, starting with a letter); nothing changed")
if not 1 <= len(name) <= 60:
    sys.exit("a project's name is 1 to 60 characters; nothing changed")
for host in hosts:
    if not re.fullmatch(HOST_PATTERN, host):
        sys.exit(f"{host} is not a host (with * allowed once in the first label); nothing changed")
for package in packages:
    if len(package) > 200 or not re.fullmatch(PACKAGE_PATTERN, package):
        sys.exit(f"{package} is not an Android package name; nothing changed")
if len(hosts) > 50 or len(packages) > 50:
    sys.exit("a project has at most 50 hosts and 50 packages; nothing changed")

status = os.stat(path)
lines = open(path).read().split("\n")
values = {}
for line in lines:
    if "=" in line and not line.startswith("#"):
        k, value = line.split("=", 1)
        values[k] = value


def read(k):
    raw = values.get(k)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        sys.exit(f"{k} is not JSON; nothing changed")


projects = read("POLYCAP_PROJECTS")
if not isinstance(projects, list):
    sys.exit("POLYCAP_PROJECTS is not set: threads are off, so a project would do nothing; nothing changed")
if any(p.get("key") == key for p in projects):
    sys.exit(f"POLYCAP_PROJECTS already has {key}; nothing changed")
projects.append({"key": key, "name": name, "hosts": hosts, "packages": packages})
changes = {"POLYCAP_PROJECTS": projects}
report = [f"projects: {[p['key'] for p in projects]}", f"{key}: {name}, hosts {hosts}, packages {packages}"]

grants = read("POLYCAP_SERVER_TOKENS") or []
unscoped = {g["id"] for g in grants if not g.get("projects")}
meta = read("POLYCAP_META_TESTERS")
if isinstance(meta, dict):
    linked = [a for a in meta.get("accounts", {}).values()
              if set(a.get("legacyGrantIds", [])) & unscoped and key not in a.get("projects", [])]
    for account in linked:
        account.setdefault("projects", []).append(key)
    if linked:
        report.append(f"POLYCAP_META_TESTERS accounts given {key}: {len(linked)}")
        changes["POLYCAP_META_TESTERS"] = meta

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 1
while os.path.exists(backup):  # two runs in one second must not overwrite the first backup
    n += 1
    backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}"
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

out = []
for line in lines:
    k = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
    out.append(f"{k}={json.dumps(changes[k], separators=(',', ':'))}" if k in changes else line)
while out and out[-1] == "":
    out.pop()
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
