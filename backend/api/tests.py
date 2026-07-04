import importlib.util
import os
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

# Path to the real settings module, loaded in isolation below so we can
# re-evaluate its boot-time guards under different environments without
# disturbing the already-configured Django test process.
SETTINGS_PATH = Path(settings.BASE_DIR) / "config" / "settings.py"


def load_settings_isolated():
    """Execute config/settings.py as a throwaway module.

    Runs the file top-to-bottom (so the SECRET_KEY/DEBUG guard fires) under a
    fresh name, independent of django.conf.settings.
    """
    spec = importlib.util.spec_from_file_location(
        "config._settings_probe", SETTINGS_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SettingsHardeningTests(SimpleTestCase):
    """Regression test carried over from Phase 0: the app must refuse to boot
    in a production-like config with no secret key, but stay convenient in dev.
    """

    def test_missing_secret_key_with_debug_off_refuses_to_boot(self):
        # DEBUG off (production-like) and no DJANGO_SECRET_KEY → hard failure,
        # so a repo-visible key can never be used to forge signed cookies.
        with mock.patch.dict(os.environ, {"DJANGO_DEBUG": "false"}, clear=True):
            with self.assertRaises(ImproperlyConfigured):
                load_settings_isolated()

    def test_debug_on_falls_back_to_dev_key(self):
        # DEBUG on (development) with no key → falls back to the throwaway key
        # so local dev just works.
        with mock.patch.dict(os.environ, {"DJANGO_DEBUG": "true"}, clear=True):
            module = load_settings_isolated()
        # A non-empty (dev fallback) key was set rather than the app refusing.
        self.assertTrue(module.SECRET_KEY)
        self.assertIn("insecure", module.SECRET_KEY)
