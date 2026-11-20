#!/usr/bin/env python3
"""Operator-only legacy continuity; run ON the receiver, never against downloaded live secrets.

After the app has completed real Meta proof + entitlement enrollment, Robin must read the
app-scoped Meta user ID on the app's Recordings page and confirm it belongs to the intended
person. Names, email addresses, and the first registry entry are NOT identity evidence.

  sudo python3 link-meta-account.py ENV_FILE REGISTRY_FILE \
    --meta-user APP_DISPLAYED_ID --user robin --legacy-grant quest3 \
    --projects MUS,PD,CAP --confirm-identity

--legacy-grant may be repeated. --confirm-identity is a literal human attestation, not an
automatic identity check. This command performs no network requests and cannot enroll anyone.
It only adds POLYCAP_META_TESTERS.accounts to the env file, with a private unique backup.
It never changes the registry, grants, tokens, or recordings. Recreate the receiver afterwards.
Use trusted, owner-only (0600), regular files and serialize other operator env-file edits.
"""
import argparse
from contextlib import ExitStack
from datetime import datetime
import fcntl
import json
import os
import re
import stat
import sys
import time
import uuid

MAX_AGE_SECONDS = 24 * 60 * 60
META_ID = r"[0-9]{1,20}"
USER_ID = r"[a-z0-9][a-z0-9-]{0,40}"
PROJECT = r"[A-Z][A-Z0-9]{1,9}"


class LinkError(Exception):
    """Safe, static operator-facing errors; never include input or exception details."""


def require(condition, message):
    if not condition:
        raise LinkError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def json_value(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON keys; refusing ambiguous configuration.")
            result[key] = value
        return result

    def invalid(_):
        raise LinkError("Invalid JSON constant; nothing changed.")

    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
    except (ValueError, TypeError):
        raise LinkError("Invalid JSON; nothing changed.") from None


def signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class PrivateFile:
    """Pinned directory/file descriptors; never follow symlinks, including parent components."""
    def __init__(self, path):
        self.dirfd = self.fd = None
        try:
            parts = os.path.abspath(path).split(os.sep)
            self.name = parts[-1]
            self.dirfd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            for component in parts[1:-1]:
                nextfd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=self.dirfd)
                os.close(self.dirfd)
                self.dirfd = nextfd
                info = os.fstat(self.dirfd)
                # Root-owned sticky /tmp is safe for an owner-only child directory.
                require(not info.st_mode & 0o022 or
                        (info.st_uid == 0 and info.st_mode & stat.S_ISVTX),
                        "Unsafe writable parent directory; nothing changed.")
            info = os.stat(self.name, dir_fd=self.dirfd, follow_symlinks=False)
            self.validate(info)
            self.fd = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=self.dirfd)
            self.status = os.fstat(self.fd)
            self.validate(self.status)
            require(signature(info) == signature(self.status), "File changed while opening; retry safely.")
            self.data = self.read()
            self.unchanged()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def validate(info):
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                "Inputs must be regular files without symlinks or hardlinks; nothing changed.")
        require(stat.S_IMODE(info.st_mode) == 0o600, "Inputs must be owner-only mode 0600; nothing changed.")
        require(os.geteuid() == 0 or info.st_uid == os.geteuid(),
                "Run as the file owner or root; nothing changed.")

    def read(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        chunks = []
        while True:
            chunk = os.read(self.fd, 65536)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)

    def unchanged(self):
        current = os.stat(self.name, dir_fd=self.dirfd, follow_symlinks=False)
        require(signature(current) == signature(self.status) and self.read() == self.data
                and signature(os.fstat(self.fd)) == signature(self.status),
                "Input changed during operation; retry after serializing edits.")

    def close(self):
        for fd in (self.fd, self.dirfd):
            if fd is not None:
                os.close(fd)
        self.fd = self.dirfd = None


def string_list(value, pattern, message, nonempty=True):
    require(isinstance(value, list) and (bool(value) or not nonempty)
            and all(matches(pattern, item) for item in value), message)
    require(len(value) == len(set(value)), message)
    return value


def known_entries(value, field, pattern):
    require(isinstance(value, list) and value, "Missing or malformed configured users/projects/grants.")
    result = {}
    for entry in value:
        require(isinstance(entry, dict) and matches(pattern, entry.get(field)),
                "Malformed configured users/projects/grants.")
        key = entry[field]
        require(key not in result, "Duplicate configured users/projects/grants.")
        result[key] = entry
    return result


def fresh_enrollment(registry, meta_user, now):
    require(isinstance(registry, dict) and type(registry.get("version")) is int and registry["version"] == 1
            and isinstance(registry.get("testers"), list), "Malformed enrollment registry.")
    testers = registry["testers"]
    require(all(isinstance(t, dict) and matches(META_ID, t.get("metaUserId")) for t in testers),
            "Malformed enrollment registry.")
    require(len({t["metaUserId"] for t in testers}) == len(testers), "Ambiguous enrollment registry.")
    enrolled = [t for t in testers if t["metaUserId"] == meta_user]
    require(len(enrolled) == 1, "Account is not enrolled; complete real app proof and entitlement sign-in first.")
    tester = enrolled[0]
    require("revokedAt" not in tester, "Account has been revoked; nothing changed.")
    devices = tester.get("devices")
    require(isinstance(devices, list) and 1 <= len(devices) <= 5,
            "Account has no valid enrolled devices; nothing changed.")
    require(all(isinstance(d, dict) and matches(r"[0-9a-f]{8}", d.get("deviceId"))
                and matches(r"[0-9a-f]{64}", d.get("sha256"))
                and isinstance(d.get("label"), str) and len(d["label"]) <= 40
                and isinstance(d.get("enrolledAt"), str) for d in devices),
            "Malformed enrolled device; nothing changed.")
    checked = tester.get("checkedAt")
    require(matches(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])", checked),
            "Invalid entitlement checkedAt; sign in again first.")
    try:
        checked_at = datetime.fromisoformat(checked.replace("Z", "+00:00"))
        age = now - checked_at.timestamp()
    except (ValueError, OverflowError, OSError):
        raise LinkError("Invalid entitlement checkedAt; sign in again first.") from None
    require(0 <= age < MAX_AGE_SECONDS, "Entitlement check must be fresh (age from zero to under 24 hours); sign in again first.")


def plan(env_bytes, registry_bytes, args, now):
    # Preserve every unrelated byte/line, including secrets and existing legacy grants.
    text = env_bytes.decode("utf-8")
    lines = text.splitlines(keepends=True)
    keys = {}
    index = None
    for i, line in enumerate(lines):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.rstrip("\r\n").partition("=")
        require(separator and re.fullmatch(r"[A-Z_][A-Z0-9_]*", key),
                "Unsupported env syntax; use plain unquoted KEY=value lines.")
        require(key not in keys, "Duplicate env keys; refusing ambiguous configuration.")
        keys[key] = value
        if key == "POLYCAP_META_TESTERS":
            index = i
    require(index is not None and matches(r"[0-9]{5,20}", keys.get("POLYCAP_META_APP_ID"))
            and matches(r"[A-Za-z0-9]{16,128}", keys.get("POLYCAP_META_APP_SECRET")),
            "Meta sign-in must already be configured; nothing changed.")
    users = known_entries(json_value(keys.get("POLYCAP_USERS", "null")), "id", USER_ID)
    projects = known_entries(json_value(keys.get("POLYCAP_PROJECTS", "null")), "key", PROJECT)
    grants = known_entries(json_value(keys.get("POLYCAP_SERVER_TOKENS", "null")), "id", USER_ID)
    require(args.user in users and not args.user.startswith("meta-"), "Requested user must be a known non-reserved POLYCAP_USERS entry.")
    requested_projects = string_list(args.projects.split(","), PROJECT, "Invalid or duplicate requested projects.")
    require(set(requested_projects) <= projects.keys(), "Requested projects must exist in POLYCAP_PROJECTS.")
    aliases = string_list(args.legacy_grant, USER_ID, "Invalid or duplicate requested legacy grants.")
    settings = json_value(keys["POLYCAP_META_TESTERS"])
    require(isinstance(settings, dict), "Malformed Meta tester configuration.")
    default_projects = string_list(settings.get("projects"), PROJECT, "Malformed default tester projects.")
    require(set(default_projects) <= projects.keys(), "Default tester projects must exist in POLYCAP_PROJECTS.")
    maximum = settings.get("maxTesters", 25)
    require(type(maximum) is int and 1 <= maximum <= 2500, "Invalid existing tester limit.")
    require("maxBytes" not in settings or (type(settings["maxBytes"]) is int and settings["maxBytes"] > 0),
            "Invalid existing byte allowance.")
    blocked = string_list(settings.get("blockedUsers", []), META_ID, "Malformed local denylist.", nonempty=False)
    require(args.meta_user not in blocked, "Account is locally blocked; nothing changed.")
    fresh_enrollment(json_value(registry_bytes), args.meta_user, now)
    people, accounts = settings.get("people", {}), settings.get("accounts", {})
    require(isinstance(people, dict) and isinstance(accounts, dict), "Malformed people/accounts configuration.")
    require(all(matches(META_ID, k) and isinstance(v, str) and v in users for k, v in people.items()),
            "Malformed people attribution configuration.")
    require(args.meta_user not in people or people[args.meta_user] == args.user,
            "Existing people attribution conflicts; nothing changed.")
    mapping = {"user": args.user, "projects": requested_projects, "legacyGrantIds": aliases}
    require(args.meta_user not in accounts or accounts[args.meta_user] == mapping,
            "Existing account mapping conflicts; refusing to overwrite it.")
    proposed = {**accounts, args.meta_user: mapping}
    claimed = set()
    for meta_id, account in proposed.items():
        require(matches(META_ID, meta_id) and isinstance(account, dict)
                and set(account) == {"user", "projects", "legacyGrantIds"}, "Malformed existing account mapping.")
        user = account["user"]
        require(isinstance(user, str) and user in users and not user.startswith("meta-"),
                "Linked account user must exist in POLYCAP_USERS and not be reserved.")
        scope = string_list(account["projects"], PROJECT, "Malformed account projects.")
        require(set(scope) <= projects.keys(), "Account projects must exist in POLYCAP_PROJECTS.")
        require(meta_id not in people or people[meta_id] == user, "Existing people attribution conflicts; nothing changed.")
        for alias in string_list(account["legacyGrantIds"], USER_ID, "Malformed or duplicate account aliases.", nonempty=False):
            require(alias not in claimed, "Legacy grant alias is already claimed by another account.")
            claimed.add(alias)
            require(not alias.startswith("meta-") and alias in grants, "Legacy grant must exist and must not be reserved.")
            grant = grants[alias]
            require(matches(r"[0-9a-f]{64}", grant.get("sha256")), "Malformed legacy grant credential; nothing changed.")
            require(grant.get("scopes") == ["upload"], "Legacy grant must be upload-only; read/post/mixed grants are forbidden.")
            require(grant.get("user") == user, "Legacy grant must belong to the same explicit user.")
            legacy_scope = string_list(grant.get("projects", list(projects)), PROJECT, "Malformed legacy grant projects.")
            require(set(legacy_scope) <= set(scope), "Account projects must cover every legacy grant project (unscoped means all configured projects).")
    if args.meta_user in accounts:
        return None
    settings["accounts"] = proposed
    old_line = lines[index]
    ending = "\r\n" if old_line.endswith("\r\n") else "\n" if old_line.endswith("\n") else ""
    lines[index] = "POLYCAP_META_TESTERS=" + json.dumps(settings, separators=(",", ":")) + ending
    return "".join(lines).encode("utf-8")


def stage(env, content):
    name = ".meta-link-" + uuid.uuid4().hex
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=env.dirfd)
    try:
        with os.fdopen(fd, "wb") as out:
            os.fchown(out.fileno(), env.status.st_uid, env.status.st_gid)
            os.fchmod(out.fileno(), 0o600)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        return name
    except BaseException:
        os.unlink(name, dir_fd=env.dirfd)
        raise


def publish(env, registry, content):
    env.unchanged()
    registry.unchanged()
    backup_stage = stage(env, env.data)
    try:
        backup = env.name + ".bak-" + time.strftime("%Y-%m-%d-%H%M%S") + "-" + uuid.uuid4().hex
        # Exclusive publication: a pre-existing backup (even a dangling symlink) cannot be overwritten.
        os.link(backup_stage, backup, src_dir_fd=env.dirfd, dst_dir_fd=env.dirfd, follow_symlinks=False)
    finally:
        os.unlink(backup_stage, dir_fd=env.dirfd)
    os.fsync(env.dirfd)
    new_stage = stage(env, content)
    try:
        env.unchanged()
        registry.unchanged()
        os.replace(new_stage, env.name, src_dir_fd=env.dirfd, dst_dir_fd=env.dirfd)
        new_stage = None
        os.fsync(env.dirfd)
    finally:
        if new_stage is not None:
            os.unlink(new_stage, dir_fd=env.dirfd)


class PrivateParser(argparse.ArgumentParser):
    def error(self, _message):
        # argparse's normal error echoes unknown arguments, potentially including credentials/IDs.
        raise LinkError("Invalid arguments: use --help and the literal --confirm-identity flag; nothing changed.")


def main(argv=None):
    try:
        parser = PrivateParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
        parser.add_argument("env_file")
        parser.add_argument("registry_file")
        parser.add_argument("--meta-user", required=True, help="Meta app-scoped ID read from the app's Recordings page")
        parser.add_argument("--user", required=True)
        parser.add_argument("--legacy-grant", required=True, action="append")
        parser.add_argument("--projects", required=True, help="Comma-separated projects, first is the default")
        parser.add_argument("--confirm-identity", required=True, action="store_true",
                            help="I personally confirmed the app-displayed ID belongs to the intended person; not a name/email match")
        args = parser.parse_args(argv)
        require(matches(META_ID, args.meta_user), "Invalid Meta user ID; nothing changed.")
        with ExitStack() as stack:
            env = PrivateFile(args.env_file)
            stack.callback(env.close)
            # Directory lock survives atomic env replacement, unlike a lock on its old inode.
            fcntl.flock(env.dirfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            registry = PrivateFile(args.registry_file)
            stack.callback(registry.close)
            require((env.status.st_dev, env.status.st_ino) != (registry.status.st_dev, registry.status.st_ino),
                    "Env and registry must be distinct files.")
            content = plan(env.data, registry.data, args, time.time())
            if content is None:
                print("Exact account link already exists; nothing changed.")
                return 0
            publish(env, registry, content)
        print("Account link saved with a unique private backup beside the env file. Recreate the receiver to apply.")
        print("Registry, recordings, legacy grants and secrets were not changed. Entitlement is not channel membership.")
        return 0
    except LinkError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("Secure file operation failed; inspect permissions and serialize edits. No IDs or secrets are shown. "
              "If a backup exists, check it before retrying.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
