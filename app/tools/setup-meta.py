#!/usr/bin/env python3
"""Local-only, standard-library setup wizard for the private Quest beta (private/docs/STORE.md).

Run in a real Terminal with python3. Never takes secrets in argv/environment, echoes them,
reads browser profiles, changes signing keys, overwrites existing credentials, or calls a network.
Files are staged under ~/.config/polycap; nothing is deployed or uploaded by this script.
"""
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import warnings

APP_ID = "1300818073125870"
# App records this setup was made for before; on a rerun their notes and App Secret are set aside under
# names ending in the old ID, never deleted. 1593561244982561 was made under the wrong team (2026-10-12).
PREVIOUS_APP_IDS = ("1593561244982561",)
CONTACT = "privacy@polydance.net"
DASHBOARD = "https://developers.meta.com/horizon/manage/"
SETTINGS_FILE = "meta-setup.json"
CREDENTIALS = (
    ("meta-app-secret", "Meta App Secret", r"[A-Za-z0-9]{16,128}",
     "Select this app -> Development -> API -> App Secret. Reveal/copy the secret."),
    ("meta-upload-token", "Meta Platform Utility token", r"[\x21-\x7e]{20,8192}",
     "Account -> Account settings -> Get Oculus platform utility token -> Generate token.\n"
     "Select macOS if asked. Copy the token; do not revoke a token another tool still uses."),
)


class SetupError(Exception):
    """Safe fixed-message error; never contains credential input or file contents."""


def checked_directory(path):
    """Do not follow symlinks or accept a directory another user can replace files in."""
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise SetupError(f"Unsafe directory: {path}. It must be a real directory you own, not writable by others.")


def prepare_directory(home):
    checked_directory(home / ".config")
    directory = home / ".config" / "polycap"
    checked_directory(directory)
    # This is Polydance's own private directory, not the user's general .config directory.
    os.chmod(directory, 0o700)
    return directory


def read_private(path):
    """Read only a small, owner-only regular file; refuse symlinks and hard-link aliases."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise SetupError(f"Cannot safely open {path}; check it is a regular file, not a link.") from None
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 16384):
            raise SetupError(f"Unsafe file: {path}. Needs a single-link, owner-only regular file (chmod 600).")
        raw = source.read(16385)
    try:
        if len(raw) > 16384:
            raise ValueError()
        return raw.decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        raise SetupError(f"Invalid file format: {path}. Nothing overwritten.") from None


def create_private(path, text):
    """Complete contents become visible atomically; an existing destination is NEVER replaced."""
    fd, temporary = tempfile.mkstemp(prefix=".meta-setup-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            os.fchmod(target.fileno(), 0o600)
            target.write(text)
            target.flush()
            os.fsync(target.fileno())
        try:
            os.link(temporary, path)  # Atomic publish with EEXIST rather than overwrite.
        except FileExistsError:
            raise SetupError(f"{path} appeared during setup. Nothing overwritten; run again.") from None
    finally:
        os.unlink(temporary)


def earlier_app(text):
    """The previous app ID when saved notes are this setup's own, made for an earlier app record; else None."""
    try:
        settings = json.loads(text)
    except ValueError:
        return None
    if (isinstance(settings, dict) and settings.get("version") == 1 and settings.get("appId") in PREVIOUS_APP_IDS
            and settings.get("privacyContact") == CONTACT and settings.get("channel") == "ALPHA"
            and settings.get("price") == "Free" and type(settings.get("privacyMailboxConfirmed")) is bool):
        return settings["appId"]
    return None


def set_aside(directory, previous):
    """Renames the old app's notes and secret to names ending in its ID, refusing to replace anything."""
    moves = [(directory / name, directory / kept) for name, kept in
             ((SETTINGS_FILE, f"meta-setup.{previous}.json"), ("meta-app-secret", f"meta-app-secret.{previous}"))]
    for _, target in moves:
        if os.path.lexists(target):
            raise SetupError(f"{target} already exists. Nothing moved; ask before changing either file.")
    for source, target in moves:
        if read_private(source) is None:
            continue
        try:
            os.link(source, target)
        except FileExistsError:
            raise SetupError(f"{target} already exists. Nothing moved; ask before changing either file.") from None
        os.unlink(source)


def hidden(prompt):
    # getpass otherwise falls back to echoed stdin when it cannot disable terminal echo.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(prompt)


def yes(ask, prompt):
    return ask(prompt + " [y/N]: ").strip().lower() in ("y", "yes")


def setup(home, ask=input, secret=hidden, say=print):
    say("\nPOLYDANCE CAPTURE — PRIVATE META SETUP\n")
    say(f"App: {APP_ID} | Package: net.polydance.capture | Free | Private ALPHA")
    say("Local preparation only. No network calls, uploads, deployment, invitations or uninstall.")
    say("The existing signing key will not be read, changed or regenerated.")
    say("Your signing-key backup and fully uploaded/processed recordings were already confirmed.")
    say("The independent server backup and account-history migration are still pending. Keep the old app installed.\n")
    say(f"1. In your signed-in Chrome, open {DASHBOARD}")
    say("   Select the EXISTING app above. Do not create a new app or publish anything.")
    if not yes(ask, f"Does the selected app show ID {APP_ID}?"):
        say("Stopped before saving anything. Select the correct app and run this command again.")
        return 1

    directory = prepare_directory(home)
    say(f"\n2. Privacy contact: {CONTACT}")
    say("   This will be the public address for privacy/deletion requests, not your Meta login.")
    say("   Selecting it does not create a mailbox. Set up forwarding/mail first if needed.")
    settings_path = directory / SETTINGS_FILE
    current = read_private(settings_path)
    previous = earlier_app(current) if current is not None else None
    if previous is not None:
        say(f"\n   Your saved notes are for app {previous}, the record made under the wrong team.")
        say("   Its App Secret works only for that app. Your platform utility token is yours and carries over.")
        if not yes(ask, f"Set aside the notes and App Secret for {previous} (kept, not deleted) and continue with {APP_ID}?"):
            say("Stopped; nothing changed.")
            return 1
        settings = {**json.loads(current), "appId": APP_ID}
        set_aside(directory, previous)
        create_private(settings_path, json.dumps(settings, indent=2) + "\n")
        say(f"   Set aside as meta-setup.{previous}.json and meta-app-secret.{previous}; notes now name {APP_ID}.")
        current = read_private(settings_path)
    if current is None:
        receives_mail = yes(ask, f"Have you confirmed that {CONTACT} receives mail?")
        settings = {"version": 1, "appId": APP_ID, "privacyContact": CONTACT,
                    "privacyMailboxConfirmed": receives_mail, "channel": "ALPHA", "price": "Free"}
        create_private(settings_path, json.dumps(settings, indent=2) + "\n")
        say(f"   Saved local deployment notes: {settings_path}")
    else:
        try:
            settings = json.loads(current)
            if (not isinstance(settings, dict) or settings.get("version") != 1
                    or settings.get("appId") != APP_ID or settings.get("privacyContact") != CONTACT
                    or settings.get("channel") != "ALPHA" or settings.get("price") != "Free"
                    or type(settings.get("privacyMailboxConfirmed")) is not bool):
                raise ValueError()
        except (ValueError, TypeError):
            raise SetupError(f"{settings_path} differs from this setup. Preserved; ask before changing it.") from None
        receives_mail = settings["privacyMailboxConfirmed"]
        say("   Existing matching setup notes kept unchanged.")

    for step, (name, label, pattern, instruction) in enumerate(CREDENTIALS, 3):
        path = directory / name
        say(f"\n{step}. {label}\n   {instruction}")
        existing = read_private(path)
        if existing is not None:
            if re.fullmatch(pattern, existing.strip()) is None:
                raise SetupError(f"{path} has an unexpected format. Preserved; ask before replacing it.")
            say(f"   Existing private file kept: {path}")
            continue
        say("   Paste ONLY the value below. Input is hidden; paste with Cmd+V, then press Enter.")
        say("   Enter alone skips this item. Ctrl+C stops; completed files remain safe for a rerun.")
        while True:
            value = secret(f"   {label} (hidden; Enter to skip): ").strip()
            if not value:
                say("   Skipped; run this wizard again when ready.")
                break
            if re.fullmatch(pattern, value) is None:
                say("   Unexpected format. Paste the value only, without labels, quotes or line breaks.")
                continue
            create_private(path, value + "\n")
            say(f"   Saved privately: {path}")
            break

    say("\nLOCAL SETUP SUMMARY — safe to share this summary, never the file contents")
    missing = []
    for name, _, _, _ in CREDENTIALS:
        present = read_private(directory / name) is not None
        say(f"  {name}: {'saved' if present else 'MISSING'}")
        if not present:
            missing.append(name)
    say(f"  Contact: {CONTACT} ({'mailbox confirmed by you' if receives_mail else 'mailbox/forwarding still needs confirmation'})")
    say(f"  Local notes: {settings_path} (not applied to the live receiver)")
    say("  Existing ~/.config/polycap/env and signing files: untouched")
    say("  Secrets: mode 0600; Polydance configuration directory: mode 0700")
    say("  Credentials have NOT been tested against Meta.")
    say("\nNext: tell the assistant setup is saved; share only a non-secret dashboard/channel screenshot.")
    say("We still need dashboard/build-history checks, server backup/history migration, privacy deployment,")
    say("Data Use Checkup and private upload. Do not uninstall or publish yet.")
    if not receives_mail:
        say("Once forwarding works, tell the assistant; this wizard preserves the earlier confirmation record.")
    return 2 if missing else 0


def main():
    if len(sys.argv) != 1:
        print("Run with python3 and no extra arguments. Never pass credentials on the command line.", file=sys.stderr)
        return 1
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Run directly in a real Terminal, not through a pipe, redirect, or chat tool.", file=sys.stderr)
        return 1
    try:
        return setup(Path.home())
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. Completed files remain private; rerun to finish. Nothing uploaded or deployed.")
        return 130
    except getpass.GetPassWarning:
        print("\nStopped: terminal could not hide input. No echo fallback is allowed.", file=sys.stderr)
        return 1
    except SetupError as error:
        print(f"\nStopped: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("\nStopped: local file operation failed. Check storage/permissions; existing files were not overwritten.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
