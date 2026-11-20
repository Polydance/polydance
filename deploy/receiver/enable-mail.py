#!/usr/bin/env python3
"""
Turns on email (docs/HOSTED.md, Email; 2026-11-10) in the receiver's env file on the receiver's host: invitations to
addresses the team copies into threads, and links that confirm a person's own address. Run as root against
that file, with the AhaSend API key on standard input, never as an argument; an empty stdin keeps the key
already there. It:

- sets POLYCAP_MAIL: AhaSend (--account, the account or Polydance's sub-account id), the sender (--from, on
  Polydance's own sending domain, and --name), where replies go (--reply-to), the tag on every message
  (polydance), and --sandbox or --live (sandbox: AhaSend checks and accepts each email and delivers none);
- sets POLYCAP_AHASEND_KEY from stdin, which should be a key scoped to messages:send:{the --from domain} only;
- sets POLYCAP_PUBLIC_URL (--public-url, default https://capture.polydance.net), the links' address;
- with --test-person, adds "newcomer-test" ("Test newcomer") to POLYCAP_USERS: a person to stand in for a
  newcomer when trying the flow on yourself; give it a token with
  `polycap token new --id newcomer-test --scope upload --member --user newcomer-test --save newcomer-test`
  and add-token.py.

It keeps a dated backup beside the file, keeps the file's owner and mode (0600), and prints the settings
without the key. The container reads the file when it is created, so recreate it afterwards; nginx needs
`location ^~ /email/` as in nginx-site.conf.example.

  R="ssh you@receiver-host"
  $R "sudo -n python3 -c 'import base64,sys; exec(base64.b64decode(sys.argv.pop(1)))' $(base64 < deploy/receiver/enable-mail.py | tr -d '\\n') /path/to/receiver.env --account ACCOUNT_ID --from invitations@mail.polydance.net --reply-to you@example.net --sandbox --test-person" < ~/.config/polycap/ahasend-key
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
parser.add_argument("--account", required=True)
parser.add_argument("--from", dest="sender", required=True)
parser.add_argument("--name", default="Polydance")
parser.add_argument("--reply-to")
parser.add_argument("--public-url", default="https://capture.polydance.net")
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--sandbox", action="store_true")
mode.add_argument("--live", action="store_true")
parser.add_argument("--test-person", action="store_true")
args = parser.parse_args()

if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", args.account):
    sys.exit("--account is not an AhaSend account id; nothing changed")
for name, value in (("--from", args.sender), ("--reply-to", args.reply_to)):
    if value is not None and not EMAIL.match(value):
        sys.exit(f"{name} is not an email address; nothing changed")
if not re.fullmatch(r"[^<>\"\r\n]{1,80}", args.name):
    sys.exit("--name is a plain name; nothing changed")
if not re.fullmatch(r"https://[^/\s]+", args.public_url.rstrip("/")):
    sys.exit("--public-url is https://host; nothing changed")

path = args.env_file
status = os.stat(path)
lines = open(path).read().split("\n")
values = {}
for line in lines:
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        values[k] = v

key = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
if key and not re.fullmatch(r"aha-sk-[A-Za-z0-9_-]{8,}", key):
    sys.exit("stdin is not an AhaSend API key (aha-sk-…); nothing changed")
if not key and not values.get("POLYCAP_AHASEND_KEY"):
    sys.exit("no AhaSend key on stdin and none in the file; nothing changed")

mail = {"provider": "ahasend", "accountId": args.account, "from": {"email": args.sender.lower(), "name": args.name},
        "tags": ["polydance"], "sandbox": bool(args.sandbox)}
if args.reply_to:
    mail["replyTo"] = {"email": args.reply_to.lower()}
changes = {"POLYCAP_MAIL": json.dumps(mail, separators=(",", ":")), "POLYCAP_PUBLIC_URL": args.public_url.rstrip("/")}
if key:
    changes["POLYCAP_AHASEND_KEY"] = key
report = [f"mail: AhaSend account {args.account}, from {args.name} <{args.sender.lower()}>"
          f"{', replies to ' + args.reply_to.lower() if args.reply_to else ''}, {'sandbox (nothing delivered)' if args.sandbox else 'live'}",
          f"links: {changes['POLYCAP_PUBLIC_URL']}", f"key: {'replaced from stdin' if key else 'kept'}"]
if args.test_person:
    users = json.loads(values.get("POLYCAP_USERS", "[]"))
    if not any(u.get("id") == "newcomer-test" for u in users):
        users.append({"id": "newcomer-test", "name": "Test newcomer"})
        report.append("POLYCAP_USERS: added newcomer-test (Test newcomer)")
    else:
        report.append("POLYCAP_USERS: newcomer-test already there")
    changes["POLYCAP_USERS"] = json.dumps(users, separators=(",", ":"))

backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}"
n = 1
while os.path.exists(backup):
    n += 1
    backup = f"{path}.bak-{time.strftime('%Y-%m-%d-%H%M%S')}-{n}"
shutil.copy2(path, backup)
os.chown(backup, status.st_uid, status.st_gid)

out, written = [], set()
for line in lines:
    name = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
    if name in changes:
        if name not in written:
            out.append(f"{name}={changes[name]}")
            written.add(name)
        continue
    out.append(line)
while out and out[-1] == "":
    out.pop()
for name, value in changes.items():
    if name not in written:
        out.append(f"{name}={value}")
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
