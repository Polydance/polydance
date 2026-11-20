#!/usr/bin/env python3
"""
Turns on the homepage's form asking to join (src/server/join.ts, private/docs/SITE.md; 2026-11-11) in the receiver's env
file on the receiver's host: POLYCAP_JOIN with who is emailed each request (--notify), the site the form is on (--site,
default https://polydance.net) and the proof of work's difficulty (--bits, default 18, which must match the form's
data-bits). It needs email on already (POLYCAP_MAIL, enable-mail.py), or the receiver refuses to start.

Run as root against that file. It keeps a dated backup beside the file and the file's owner and mode (0600), and
prints the setting. The container reads the file when it is created, so recreate it afterwards
(private/deploy/receiver/recreate.py); nginx needs `location = /join` (nginx-join.py).

  R="ssh you@receiver-host"
  $R "sudo -n python3 - /path/to/receiver.env --notify you@example.net" < deploy/receiver/enable-join.py
"""
import argparse
import json
import os
import re
import shutil
import sys
import time

EMAIL = re.compile(r"^[^\s@<>\"]+@[^\s@<>\"]+\.[a-z]{2,}$", re.I)
parser = argparse.ArgumentParser(allow_abbrev=False)
parser.add_argument("env_file")
parser.add_argument("--notify", required=True)
parser.add_argument("--site", default="https://polydance.net")
parser.add_argument("--bits", type=int, default=18)
args = parser.parse_args()

if not EMAIL.match(args.notify):
    sys.exit("--notify is not an email address; nothing changed")
if not re.fullmatch(r"https://[^/\s]+", args.site.rstrip("/")):
    sys.exit("--site is https://host; nothing changed")
if not 4 <= args.bits <= 24:
    sys.exit("--bits is 4 to 24; nothing changed")

path = args.env_file
status = os.stat(path)
lines = open(path).read().split("\n")
values = {}
for line in lines:
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        values[k] = v
if not values.get("POLYCAP_MAIL"):
    sys.exit("POLYCAP_MAIL is not set: turn email on first (enable-mail.py); nothing changed")

setting = json.dumps({"notify": args.notify.lower(), "site": args.site.rstrip("/"), "bits": args.bits}, separators=(",", ":"))
backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 1
while os.path.exists(backup):
    n += 1
    backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}"
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

out, written = [], False
for line in lines:
    if line.startswith("POLYCAP_JOIN="):
        if not written:
            out.append(f"POLYCAP_JOIN={setting}")
            written = True
        continue
    out.append(line)
while out and out[-1] == "":
    out.pop()
if not written:
    out.append(f"POLYCAP_JOIN={setting}")
out.append("")

temp = path + ".tmp"
with open(temp, "w") as f:
    f.write("\n".join(out))
os.chmod(temp, 0o600)
os.chown(temp, status.st_uid, status.st_gid)
os.replace(temp, path)
print("backup:", backup)
print(f"POLYCAP_JOIN: requests emailed to {args.notify.lower()}, from the form on {args.site.rstrip('/')}, {args.bits}-bit work")
