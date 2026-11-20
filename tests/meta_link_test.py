"""Operator-link security regressions: temporary fake secrets/registry only, no networking."""
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy/receiver/link-meta-account.py"
ENABLE = ROOT / "deploy/receiver/enable-meta.py"
spec = importlib.util.spec_from_file_location("meta_link", SCRIPT)
linker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linker)
SECRET = "fake" + "a" * 28
TOKEN = "fake-token-" + "b" * 45
HASH = "f" * 64
META = "987654321012345678"
OTHER_META = "876543210123456789"
BLOCKED_META = "765432101234567890"
NOW = 1800000000.0


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class MetaLinkTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="polycap-meta-link-test-")
        self.addCleanup(temporary.cleanup)
        # macOS's /var and /tmp aliases are symlinks. Use their real path, as an operator should.
        self.home = Path(temporary.name).resolve()
        self.env = self.home / "receiver.env"
        self.registry = self.home / "testers.json"
        self.recording = self.home / "recording-fake.json"
        self.recording.write_text('{"owner":"quest3","status":"deleted"}\n')
        self.settings = {
            "projects": ["MUS"], "maxTesters": 23, "maxBytes": 123456,
            "people": {OTHER_META: "bob", META: "robin"}, "blockedUsers": [BLOCKED_META],
            "accounts": {OTHER_META: {"user": "bob", "projects": ["PD"], "legacyGrantIds": ["bobs-quest"]}},
        }
        self.grants = [
            {"id": "quest3", "user": "robin", "scopes": ["upload"], "sha256": HASH,
             "label": "Quest 3", "maxBytes": 654321},
            {"id": "quest-extra", "user": "robin", "scopes": ["upload"], "sha256": "e" * 64, "projects": ["CAP"]},
            {"id": "bobs-quest", "user": "bob", "scopes": ["upload"], "sha256": "d" * 64, "projects": ["PD"]},
            {"id": "mac", "user": "robin", "scopes": ["read", "post"], "sha256": "c" * 64},
        ]
        self.keys = {
            # The app enable-meta.py sets, so its reruns here are reruns for the same app, not a move to another.
            "POLYCAP_META_APP_ID": "1300818073125870", "POLYCAP_META_APP_SECRET": SECRET,
            "POLYCAP_PROJECTS": json.dumps([{"key": key, "name": key} for key in ["MUS", "PD", "CAP"]]),
            "POLYCAP_USERS": json.dumps([{"id": "robin", "name": "Robin"}, {"id": "bob", "name": "Bob"}]),
            "POLYCAP_REMOTE_TOKEN": TOKEN, "POLYCAP_ALLOWANCE_BYTES": "123456",
        }
        self.tester = {"metaUserId": META, "name": "NOT Robin; names are never identity evidence",
                       "enrolledAt": iso(NOW - 200), "checkedAt": iso(NOW - 60),
                       "devices": [{"deviceId": "aabbccdd", "label": "Quest", "sha256": HASH, "enrolledAt": iso(NOW - 200)}]}
        self.registry_data = {"version": 1, "testers": [self.tester]}
        self.save()

    def save(self):
        self.keys["POLYCAP_META_TESTERS"] = json.dumps(self.settings)
        self.keys["POLYCAP_SERVER_TOKENS"] = json.dumps(self.grants)
        self.env.write_text("# fake private receiver env\n\n" + "\n".join(f"{k}={v}" for k, v in self.keys.items()) + "\n")
        self.registry.write_text(json.dumps(self.registry_data))
        for path in (self.env, self.registry):
            path.chmod(0o600)

    def arguments(self, **options):
        args = {"--meta-user": META, "--user": "robin", "--legacy-grant": ["quest3"], "--projects": "MUS,PD,CAP"}
        args.update(options)
        result = [str(self.env), str(self.registry)]
        for key, value in args.items():
            if value is None:
                continue
            for item in value if isinstance(value, list) else [value]:
                result += [key, item]
        return result + ["--confirm-identity"]

    def run_link(self, argv=None, **options):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(linker.time, "time", return_value=NOW), redirect_stdout(output), redirect_stderr(errors):
            status = linker.main(self.arguments(**options) if argv is None else argv)
        text = output.getvalue() + errors.getvalue()
        for private in (SECRET, TOKEN, HASH, META, OTHER_META, BLOCKED_META, self.tester["name"]):
            self.assertNotIn(private, text)
        return status, text

    def snapshot(self):
        return {p.name: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns, stat.S_IMODE(p.stat().st_mode))
                for p in self.home.iterdir() if p.is_file()}

    def refused(self, argv=None, **options):
        before = self.snapshot()
        status, text = self.run_link(argv, **options)
        self.assertEqual(status, 1, text)
        self.assertEqual(before, self.snapshot())
        return text

    def linked_settings(self):
        lines = self.env.read_text().splitlines()
        return json.loads(next(line.split("=", 1)[1] for line in lines if line.startswith("POLYCAP_META_TESTERS=")))

    def expected(self):
        return {"user": "robin", "projects": ["MUS", "PD", "CAP"], "legacyGrantIds": ["quest3"]}

    def test_explicit_link_preserves_everything_else_and_creates_private_backup(self):
        before = self.snapshot()
        self.assertEqual(self.run_link()[0], 0)
        expected = copy.deepcopy(self.settings)
        expected["accounts"][META] = self.expected()
        self.assertEqual(self.linked_settings(), expected)
        before_other = [l for l in before[self.env.name][0].splitlines(keepends=True) if not l.startswith(b"POLYCAP_META_TESTERS=")]
        after_other = [l for l in self.env.read_bytes().splitlines(keepends=True) if not l.startswith(b"POLYCAP_META_TESTERS=")]
        self.assertEqual(before_other, after_other)
        for path in (self.registry, self.recording):
            self.assertEqual(self.snapshot()[path.name], before[path.name])
        backups = list(self.home.glob("receiver.env.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before[self.env.name][0])
        for path in [self.env, backups[0]]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (self.registry.stat().st_uid, self.registry.stat().st_gid))
        self.assertFalse(list(self.home.glob(".meta-link-*")))

    def test_exact_rerun_is_no_mutation_even_inode_mtime_or_backup(self):
        self.assertEqual(self.run_link()[0], 0)
        before = self.snapshot()
        status, text = self.run_link()
        self.assertEqual(status, 0)
        self.assertIn("already exists", text)
        self.assertEqual(self.snapshot(), before)

    def test_conflicting_existing_mapping_is_never_overwritten(self):
        for changed in ({"user": "bob"}, {"projects": ["PD", "MUS", "CAP"]},
                        {"legacyGrantIds": ["quest-extra"]}, {"legacyGrantIds": []}):
            with self.subTest(changed=changed):
                self.settings["accounts"][META] = {**self.expected(), **changed}
                self.save()
                self.assertIn("conflicts", self.refused())

    def test_multiple_explicit_aliases_and_unique_backups(self):
        self.assertEqual(self.run_link(**{"--legacy-grant": ["quest3", "quest-extra"]})[0], 0)
        self.assertEqual(self.linked_settings()["accounts"][META]["legacyGrantIds"], ["quest3", "quest-extra"])
        first = next(self.home.glob("receiver.env.bak-*"))
        contents = first.read_bytes()
        self.save()  # A separate fake operator scenario in the same second.
        self.assertEqual(self.run_link()[0], 0)
        self.assertEqual(len(list(self.home.glob("receiver.env.bak-*"))), 2)
        self.assertEqual(first.read_bytes(), contents)

    def test_requires_all_explicit_arguments_and_literal_confirmation(self):
        for flag in ("--meta-user", "--user", "--legacy-grant", "--projects"):
            with self.subTest(flag=flag):
                self.refused(**{flag: None})
        self.refused(self.arguments()[:-1])
        for value in ("--confirm", "--confirm-identity=true", "--confirm-identity=yes", "--confirm-identity=false"):
            self.refused(self.arguments()[:-1] + [value])
        self.refused(self.arguments() + [META, SECRET, TOKEN])

    def test_help_explains_human_confirmation_not_names_or_emails(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        for phrase in ("Recordings page", "personally confirmed", "proof", "entitlement", "name/email", "--confirm-identity"):
            self.assertIn(phrase, result.stdout)

    def test_enrollment_required_never_match_first_tester_or_cosmetic_name(self):
        self.registry_data["testers"] = []
        self.save()
        self.assertIn("not enrolled", self.refused())
        self.registry_data["testers"] = [{**self.tester, "metaUserId": OTHER_META, "name": "Robin"}]
        self.save()
        self.assertIn("not enrolled", self.refused())

    def test_block_revocation_and_empty_devices_refuse_even_exact_existing_links(self):
        for existing in (False, True):
            for reason in ("blocked", "revoked", "no-devices"):
                with self.subTest(existing=existing, reason=reason):
                    self.setUp()
                    if existing:
                        self.settings["accounts"][META] = self.expected()
                    if reason == "blocked":
                        self.settings["blockedUsers"].append(META)
                    elif reason == "revoked":
                        self.tester["revokedAt"] = iso(NOW - 1)
                    else:
                        self.tester["devices"] = []
                    self.save()
                    self.refused()

    def test_freshness_exact_boundaries_and_invalid_or_future_dates(self):
        for checked in (iso(NOW - 86400), iso(NOW - 86401), iso(NOW + 0.001),
                        "not a timestamp", "", None, NOW, "2026-02-30T12:00:00Z",
                        "2026-01-01", "2026-01-01T12:00:00", "2026-01-01T12:00:00+99:99"):
            with self.subTest(checked=checked):
                self.tester["checkedAt"] = checked
                self.save()
                self.refused()
        for age in (0, 86399.999):
            with self.subTest(age=age):
                self.tester["checkedAt"] = iso(NOW - age)
                self.save()
                self.assertEqual(self.run_link()[0], 0)

    def test_malformed_enrollment_and_existing_limits_fail_closed(self):
        original = copy.deepcopy(self.registry_data)
        for update in ({"version": True}, {"version": 2}, {"testers": None}, {"testers": [None]}):
            self.registry_data = {**original, **update}
            self.save()
            self.refused()
        self.registry_data = original
        self.tester = original["testers"][0]
        for devices in ([{}], [{"deviceId": "aabbccdd", "sha256": HASH}], "not-an-array"):
            previous = self.tester["devices"]
            self.tester["devices"] = devices
            self.save()
            self.refused()
            self.tester["devices"] = previous
        # datetime.fromisoformat normalizes offset minute 99; it is not a valid timestamp.
        self.tester["checkedAt"] = iso(NOW - 1).replace("Z", "+00:99")
        self.save()
        self.refused()
        self.tester["checkedAt"] = iso(NOW - 1)
        for key, value in (("maxTesters", True), ("maxTesters", 0), ("maxBytes", -1), ("projects", [])):
            previous = self.settings[key]
            self.settings[key] = value
            self.save()
            self.refused()
            self.settings[key] = previous

    def test_unknown_or_reserved_user_project_and_alias_refused(self):
        for flag, values in {"--meta-user": ["", "Robin", "1" * 21, "١٢٣"],
                             "--user": ["missing", "meta-123", "Robin"],
                             "--projects": ["MUS", "MUS,PD", "MUS,PD,CAP,NO", "MUS,MUS,PD,CAP", "mus,PD,CAP", ""],
                             "--legacy-grant": ["unknown", "meta-123", "mac", "bobs-quest", "../quest3"]}.items():
            for value in values:
                with self.subTest(flag=flag, value=value):
                    self.refused(**{flag: value})
        self.refused(**{"--legacy-grant": ["quest3", "quest3"]})

    def test_upload_only_same_user_and_complete_legacy_scope_required(self):
        original = copy.deepcopy(self.grants[0])
        for changes in ({"scopes": ["upload", "read"]}, {"scopes": ["upload", "post"]},
                        {"scopes": ["read"]}, {"scopes": []}, {"scopes": ["upload", "upload"]},
                        {"user": "bob"}, {"user": None}, {"projects": []}, {"projects": ["NO"]}):
            with self.subTest(changes=changes):
                self.grants[0] = {**original, **changes}
                self.save()
                self.refused()
        self.grants[0] = {k: v for k, v in original.items() if k != "user"}
        self.save()
        self.refused()
        self.grants[0] = {**original, "projects": ["MUS"]}
        self.save()
        self.assertEqual(self.run_link(**{"--projects": "MUS"})[0], 0)

    def test_alias_claim_and_people_conflicts_refused(self):
        self.settings["accounts"][OTHER_META] = self.expected()
        self.settings["people"][OTHER_META] = "robin"
        self.save()
        self.assertIn("already claimed", self.refused())
        self.settings["accounts"] = {}
        self.settings["people"][META] = "bob"
        self.save()
        self.assertIn("attribution conflicts", self.refused())

    def test_absent_people_and_accounts_are_not_automatically_inferred(self):
        self.settings.pop("people")
        self.settings.pop("accounts")
        self.save()
        self.assertEqual(self.run_link()[0], 0)
        settings = self.linked_settings()
        self.assertNotIn("people", settings)
        self.assertEqual(settings["accounts"], {META: self.expected()})

    def test_ambiguous_env_json_registry_and_unknown_future_settings(self):
        for suffix in (f"POLYCAP_META_TESTERS={json.dumps(self.settings)}\n", "export POLYCAP_USERS=[]\n"):
            self.save()
            self.env.write_bytes(self.env.read_bytes() + suffix.encode())
            self.refused()
        for key in ("POLYCAP_USERS", "POLYCAP_PROJECTS", "POLYCAP_SERVER_TOKENS", "POLYCAP_META_TESTERS"):
            for raw in ("{", "null", '{"duplicate":1,"duplicate":2}', "NaN"):
                self.save()
                lines = self.env.read_text().splitlines()
                self.env.write_text("\n".join(f"{key}={raw}" if line.startswith(key + "=") else line for line in lines))
                self.refused()
        self.registry_data["testers"].append(copy.deepcopy(self.tester))
        self.save()
        self.refused()
        self.registry_data["testers"].pop()
        self.settings["futureSetting"] = {"preserve": True}
        self.save()
        self.assertEqual(self.run_link()[0], 0)
        self.assertEqual(self.linked_settings()["futureSetting"], {"preserve": True})

    def test_file_modes_symlinks_and_hardlinks_are_refused(self):
        for path in (self.env, self.registry):
            for mode in (0o644, 0o640, 0o660, 0o666, 0o400, 0o1600):
                path.chmod(mode)
                self.refused()
                path.chmod(0o600)
            outside = self.home / "outside-private"
            path.rename(outside)
            for create in (lambda: path.symlink_to(outside), lambda: os.link(outside, path)):
                create()
                self.refused()
                path.unlink()
            outside.rename(path)

    def test_parent_symlink_unsafe_directory_and_special_files_refused(self):
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        args = self.arguments()
        args[0] = str(alias / self.env.name)
        self.refused(args)
        self.home.chmod(0o777)
        self.refused()
        self.home.chmod(0o700)
        self.registry.unlink()
        self.registry.mkdir(mode=0o600)
        status, _ = self.run_link()
        self.assertEqual(status, 1)
        self.registry.rmdir()
        os.mkfifo(self.registry, 0o600)
        status, _ = self.run_link()
        self.assertEqual(status, 1)
        self.registry.unlink()

    def test_wrong_file_owner_refused_without_root(self):
        with patch.object(linker.os, "geteuid", return_value=self.env.stat().st_uid + 100):
            self.refused()

    def test_restrictive_creation_under_permissive_umask(self):
        mask = os.umask(0)
        try:
            self.assertEqual(self.run_link()[0], 0)
        finally:
            os.umask(mask)
        for path in self.home.glob("receiver.env*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_staging_failures_keep_original_and_cleanup_without_leaking(self):
        for operation in ("fchown", "fsync", "link", "replace"):
            with self.subTest(operation=operation):
                self.save()
                before = self.env.read_bytes()
                with patch.object(linker.os, operation, side_effect=OSError(SECRET + META + HASH)):
                    self.assertEqual(self.run_link()[0], 1)
                self.assertEqual(self.env.read_bytes(), before)
                self.assertFalse(list(self.home.glob(".meta-link-*")))
                self.assertEqual(self.registry.read_text(), json.dumps(self.registry_data))

    def test_input_changes_before_publish_fail_closed(self):
        for which in ("env", "registry"):
            with self.subTest(which=which):
                self.save()
                original = linker.plan
                def change_after_validation(*args):
                    result = original(*args)
                    path = getattr(self, which)
                    path.write_bytes(path.read_bytes() + b"\n")
                    return result
                with patch.object(linker, "plan", side_effect=change_after_validation):
                    self.assertEqual(self.run_link()[0], 1)
                self.assertFalse(list(self.home.glob("receiver.env.bak-*")))
                self.assertFalse(list(self.home.glob(".meta-link-*")))

    def test_existing_backup_symlink_is_never_followed_or_overwritten(self):
        class Fixed:
            hex = "fake-unique-name"
        backup = self.home / (self.env.name + ".bak-fixed-fake-unique-name")
        backup.symlink_to(self.recording)
        before = self.env.read_bytes(), self.recording.read_bytes()
        with patch.object(linker.uuid, "uuid4", return_value=Fixed()), patch.object(linker.time, "strftime", return_value="fixed"):
            self.assertEqual(self.run_link()[0], 1)
        self.assertEqual((self.env.read_bytes(), self.recording.read_bytes()), before)
        self.assertTrue(backup.is_symlink())
        self.assertFalse(list(self.home.glob(".meta-link-*")))

    def test_enable_meta_rerun_preserves_accounts_and_unknown_settings(self):
        self.settings["accounts"][META] = self.expected()
        self.settings["futureSetting"] = {"preserve": True}
        self.save()
        before = self.env.read_bytes()
        result = subprocess.run([sys.executable, "-B", str(ENABLE), str(self.env)],
                                input=SECRET, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.linked_settings(), self.settings)
        for private in (SECRET, TOKEN, HASH, META, OTHER_META, BLOCKED_META):
            self.assertNotIn(private, result.stdout + result.stderr)
        self.assertEqual(next(self.home.glob("receiver.env.bak-*")).read_bytes(), before)
        for key, value in self.keys.items():
            if key not in ("POLYCAP_META_APP_ID", "POLYCAP_META_TESTERS"):
                self.assertIn(f"{key}={value}\n", self.env.read_text())

    def test_enable_meta_cannot_replace_people_conflicting_with_accounts(self):
        self.settings["accounts"][META] = self.expected()
        self.save()
        before = self.snapshot()
        result = subprocess.run([sys.executable, "-B", str(ENABLE), str(self.env), "--person", META + "=bob"],
                                input=SECRET, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn(META, result.stdout + result.stderr)

    def test_cli_success_and_invalid_argument_errors_do_not_echo_private_values(self):
        self.tester["checkedAt"] = iso(datetime.now(timezone.utc).timestamp() - 1)
        self.save()
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), *self.arguments()], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), *self.arguments(), "--unknown", SECRET, META], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        for private in (SECRET, TOKEN, HASH, META):
            self.assertNotIn(private, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
