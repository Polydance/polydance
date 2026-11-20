"""Standard-library tests; fake credentials and isolated homes only. Invoked by Vitest."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "app/tools/setup-meta.py"
spec = importlib.util.spec_from_file_location("meta_setup", SCRIPT)
wizard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wizard)
SECRET = "fake" + "a" * 28
TOKEN = "fake-token-" + "b" * 45


class MetaSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polycap-meta-setup-test-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.lines = []
        self.directory = self.home / ".config/polycap"

    def run_setup(self, answers=("y", "y"), secrets=(SECRET, TOKEN)):
        answers, secrets = iter(answers), iter(secrets)
        return wizard.setup(self.home, lambda _: next(answers), lambda _: next(secrets), self.lines.append)

    def assert_no_leak(self):
        self.assertNotIn(SECRET, "\n".join(self.lines))
        self.assertNotIn(TOKEN, "\n".join(self.lines))

    def test_moves_from_the_earlier_app_keeping_its_notes_and_secret_aside(self):
        old_app = wizard.PREVIOUS_APP_IDS[0]
        self.directory.mkdir(parents=True, mode=0o700)
        old_notes = {"version": 1, "appId": old_app, "privacyContact": wizard.CONTACT,
                     "privacyMailboxConfirmed": True, "channel": "ALPHA", "price": "Free"}
        for name, text in (("meta-setup.json", json.dumps(old_notes)), ("meta-app-secret", "old" + "c" * 29 + "\n"), ("meta-upload-token", TOKEN + "\n")):
            (self.directory / name).write_text(text)
            os.chmod(self.directory / name, 0o600)
        # Declining changes nothing.
        self.assertEqual(self.run_setup(answers=("y", "n"), secrets=()), 1)
        self.assertEqual(json.loads((self.directory / "meta-setup.json").read_text())["appId"], old_app)
        self.assertFalse((self.directory / f"meta-app-secret.{old_app}").exists())
        # Agreeing sets the old app's files aside and asks only for the new App Secret.
        self.assertEqual(self.run_setup(answers=("y", "y"), secrets=(SECRET,)), 0)
        self.assertEqual(json.loads((self.directory / "meta-setup.json").read_text()), {**old_notes, "appId": wizard.APP_ID})
        self.assertEqual(json.loads((self.directory / f"meta-setup.{old_app}.json").read_text()), old_notes)
        self.assertEqual((self.directory / f"meta-app-secret.{old_app}").read_text(), "old" + "c" * 29 + "\n")
        self.assertEqual((self.directory / "meta-app-secret").read_text(), SECRET + "\n")
        self.assertEqual((self.directory / "meta-upload-token").read_text(), TOKEN + "\n")
        for path in self.directory.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
        self.assert_no_leak()
        self.assertNotIn("old" + "c" * 29, "\n".join(self.lines))
        # A rerun finds everything in place.
        self.assertEqual(self.run_setup(answers=("y",), secrets=()), 0)

    def test_will_not_replace_an_old_app_secret_already_set_aside(self):
        old_app = wizard.PREVIOUS_APP_IDS[0]
        self.directory.mkdir(parents=True, mode=0o700)
        notes = {"version": 1, "appId": old_app, "privacyContact": wizard.CONTACT,
                 "privacyMailboxConfirmed": False, "channel": "ALPHA", "price": "Free"}
        # Only the secret's set-aside name is taken: the notes must not move either.
        for name, text in (("meta-setup.json", json.dumps(notes)), ("meta-app-secret", SECRET + "\n"), (f"meta-app-secret.{old_app}", "x")):
            (self.directory / name).write_text(text)
            os.chmod(self.directory / name, 0o600)
        with self.assertRaises(wizard.SetupError):
            self.run_setup(answers=("y", "y"), secrets=())
        self.assertEqual(json.loads((self.directory / "meta-setup.json").read_text()), notes)
        self.assertEqual((self.directory / "meta-app-secret").read_text(), SECRET + "\n")

    def test_creates_expected_private_files_and_preserves_existing_config_and_key(self):
        self.directory.mkdir(parents=True)
        (self.directory / "env").write_text("POLYCAP_REMOTE_TOKEN=untouched\n")
        keys = self.directory / "android"
        keys.mkdir()
        (keys / "upload.jks").write_bytes(b"not-a-real-key")
        (keys / "upload.properties").write_text("unchanged")
        self.assertEqual(self.run_setup(), 0)
        for filename, value in [("meta-app-secret", SECRET), ("meta-upload-token", TOKEN)]:
            path = self.directory / filename
            self.assertEqual(path.read_text(), value + "\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        settings = json.loads((self.directory / wizard.SETTINGS_FILE).read_text())
        self.assertEqual(settings, {"version": 1, "appId": wizard.APP_ID, "privacyContact": wizard.CONTACT,
                                   "privacyMailboxConfirmed": True, "channel": "ALPHA", "price": "Free"})
        self.assertEqual((self.directory / "env").read_text(), "POLYCAP_REMOTE_TOKEN=untouched\n")
        self.assertEqual((keys / "upload.jks").read_bytes(), b"not-a-real-key")
        self.assertEqual((keys / "upload.properties").read_text(), "unchanged")
        self.assertFalse(list(self.directory.glob(".meta-setup-*")))
        self.assert_no_leak()

    def test_wrong_app_does_not_create_config(self):
        self.assertEqual(self.run_setup(answers=("n",), secrets=()), 1)
        self.assertFalse(self.directory.exists())

    def test_rerun_preserves_existing_values_and_does_not_prompt_for_secrets(self):
        self.run_setup()
        before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.directory.iterdir()}
        self.assertEqual(self.run_setup(answers=("y",), secrets=()), 0)
        after = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.directory.iterdir()}
        self.assertEqual(before, after)
        self.assert_no_leak()

    def test_skip_missing_secret_then_resume(self):
        self.assertEqual(self.run_setup(secrets=("", TOKEN)), 2)
        self.assertFalse((self.directory / "meta-app-secret").exists())
        self.assertEqual(self.run_setup(answers=("y",), secrets=(SECRET,)), 0)
        self.assert_no_leak()

    def test_cancel_after_first_secret_keeps_completed_files_for_rerun(self):
        answers = iter(("y", "n"))
        def secret(prompt):
            if "App Secret" in prompt:
                return SECRET
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            wizard.setup(self.home, lambda _: next(answers), secret, self.lines.append)
        self.assertEqual((self.directory / "meta-app-secret").read_text().strip(), SECRET)
        self.assertFalse((self.directory / "meta-upload-token").exists())
        self.assertEqual(self.run_setup(answers=("y",), secrets=(TOKEN,)), 0)
        settings = json.loads((self.directory / wizard.SETTINGS_FILE).read_text())
        self.assertFalse(settings["privacyMailboxConfirmed"])
        self.assertIn("mailbox/forwarding still needs confirmation", "\n".join(self.lines))
        self.assert_no_leak()

    def test_invalid_input_is_not_written_or_echoed(self):
        invalid = "Not really a credential!"
        self.assertEqual(self.run_setup(secrets=(invalid, SECRET, "bad", TOKEN)), 0)
        self.assertNotIn(invalid, "\n".join(self.lines))
        self.assert_no_leak()

    def test_refuses_existing_world_readable_secret_without_changing_it(self):
        self.run_setup()
        path = self.directory / "meta-app-secret"
        path.chmod(0o644)
        with self.assertRaises(wizard.SetupError):
            self.run_setup(answers=("y",), secrets=())
        self.assertEqual(path.read_text().strip(), SECRET)
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_refuses_symlinked_config_directory(self):
        other = self.home / "other"
        other.mkdir()
        (self.home / ".config").symlink_to(other, target_is_directory=True)
        with self.assertRaises(wizard.SetupError):
            self.run_setup()
        self.assertFalse(list(other.iterdir()))

    def test_refuses_symlinked_and_hardlinked_secret(self):
        self.run_setup()
        path = self.directory / "meta-app-secret"
        outside = self.home / "outside"
        path.rename(outside)
        for link in (lambda: path.symlink_to(outside), lambda: os.link(outside, path)):
            link()
            with self.assertRaises(wizard.SetupError):
                self.run_setup(answers=("y",), secrets=())
            path.unlink()
        self.assertEqual(outside.read_text().strip(), SECRET)

    def test_mismatched_or_malformed_settings_are_preserved(self):
        self.run_setup()
        path = self.directory / wizard.SETTINGS_FILE
        for contents in ("{", "[]", '{"appId":"other"}'):
            path.write_text(contents)
            with self.assertRaises(wizard.SetupError):
                self.run_setup(answers=("y",), secrets=())
            self.assertEqual(path.read_text(), contents)

    def test_atomic_publish_does_not_overwrite_and_cleans_staging(self):
        self.directory = wizard.prepare_directory(self.home)
        path = self.directory / "meta-app-secret"
        wizard.create_private(path, SECRET)
        with self.assertRaises(wizard.SetupError):
            wizard.create_private(path, TOKEN)
        self.assertEqual(path.read_text(), SECRET)
        with patch.object(wizard.os, "link", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                wizard.create_private(self.directory / "meta-upload-token", TOKEN)
        self.assertFalse((self.directory / "meta-upload-token").exists())
        self.assertFalse(list(self.directory.glob(".meta-setup-*")))

    def test_non_terminal_execution_refused_before_writes(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input="y\ny\n", text=True, capture_output=True,
                                env={**os.environ, "HOME": str(self.home)}, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("real Terminal", result.stderr)
        self.assertFalse(self.directory.exists())

    def test_echo_fallback_is_an_error(self):
        def cannot_hide(_):
            warnings.warn("cannot hide", wizard.getpass.GetPassWarning)
            self.fail("Must not fall through to reading echoed input")
        with patch.object(wizard.getpass, "getpass", side_effect=cannot_hide):
            with self.assertRaises(wizard.getpass.GetPassWarning):
                wizard.hidden("fake prompt")


if __name__ == "__main__":
    unittest.main()
