#!/usr/bin/env python3
"""
Turns on reports from the headset's bug key (docs/THREADS.md, Reports) in the receiver's env file on
the receiver's host: sets POLYCAP_REPORTS to the project each report opens its thread in, CAP (Polydance
Capture) unless another key is given. Run as root against that file. It changes that one line and
nothing else, refuses a key POLYCAP_PROJECTS does not list (the receiver would refuse to start), keeps a
dated backup beside the file and the file's owner and mode (0600), and prints only the key. The
container reads the file when it is created, so recreate it afterwards; until then reports are refused.

  R="ssh you@receiver-host"
  $R "sudo -n python3 - /path/to/receiver.env" < deploy/receiver/enable-reports.py
  $R "sudo -n python3 - /path/to/receiver.env PD" < deploy/receiver/enable-reports.py
"""
import json
import os
import re
import shutil
import sys
import time

if len(sys.argv) not in (2, 3):
    sys.exit("usage: enable-reports.py ENV_FILE [PROJECT_KEY]")
path = sys.argv[1]
key = sys.argv[2] if len(sys.argv) == 3 else "CAP"
if not re.fullmatch(r"[A-Z][A-Z0-9]{1,9}", key):
    sys.exit(f"{key} is not a project key; nothing changed")

status = os.stat(path)
lines = open(path).read().split("\n")
projects = []
for line in lines:
    if line.startswith("POLYCAP_PROJECTS="):
        projects = [p["key"] for p in json.loads(line.split("=", 1)[1])]
if key not in projects:
    sys.exit(f"POLYCAP_PROJECTS has {', '.join(projects) or 'no projects'}, not {key}; nothing changed")

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

lines = [line for line in lines if not line.startswith("POLYCAP_REPORTS=")]
while lines and lines[-1] == "":
    lines.pop()
lines += [f"POLYCAP_REPORTS={key}", ""]

temp = path + ".tmp"
with open(temp, "w") as out:
    out.write("\n".join(lines))
os.chmod(temp, 0o600)
os.chown(temp, status.st_uid, status.st_gid)
os.replace(temp, path)
print("backup:", backup)
print("reports:", key, "of", projects)
