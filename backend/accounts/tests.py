import os
import re
import shutil
import tempfile
from datetime import timedelta
from email.utils import parsedate_to_datetime
from io import BytesIO
from unittest import mock

from allauth.account.models import EmailAddress
from dj_rest_auth.app_settings import api_settings as dj_rest_auth_settings
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.utils import datetime_from_epoch

from accounts.models import (
    EmailVerificationCode,
    PasswordResetCode,
    generate_code,
)
from accounts.tokens import MobileRefreshToken
from config.settings import _email_backend, env_int

User = get_user_model()

# A clean, per-process in-memory cache so throttle counters from one test can't
# bleed into the next. (We can't override the throttle *rate* per-test — DRF
# binds THROTTLE_RATES as a class attribute at import, so @override_settings on
# REST_FRAMEWORK doesn't reach it — so the throttle tests exercise the real
# configured rate, read via `configured_throttle_limit` below.)
LOCMEM_CACHE = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
}


def configured_throttle_limit(scope):
    """The allowed request count for a throttle scope, e.g. "10/min" -> 10."""
    rate = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"][scope]
    return int(rate.split("/")[0])

REGISTER_URL = "/api/auth/registration/"
LOGIN_URL = "/api/auth/login/"
LOGOUT_URL = "/api/auth/logout/"
USER_URL = "/api/auth/user/"
CSRF_URL = "/api/auth/csrf/"

AUTH_COOKIE = "timeline-auth"
PASSWORD = "correct-horse-42-battery"


class UserModelTests(APITestCase):
    def test_email_is_the_login_identifier(self):
        self.assertEqual(User.USERNAME_FIELD, "email")

    def test_create_user_hashes_password(self):
        user = User.objects.create_user(email="hash@example.com", password=PASSWORD)
        self.assertNotEqual(user.password, PASSWORD)  # never stored in the clear
        self.assertTrue(user.check_password(PASSWORD))

    def test_create_superuser_is_active_staff_super(self):
        admin = User.objects.create_superuser(
            email="admin@example.com", password=PASSWORD
        )
        self.assertTrue(admin.is_active)
        self.assertTrue(admin.is_staff)
        self.assertTrue(admin.is_superuser)


class EmailConfigTests(APITestCase):
    """Outbound email plumbing (see docs/deploy.md → Outbound email).

    Delivery is the foundation for password recovery (#38): without a working
    EMAIL_BACKEND and a From address, no mail can be sent at all.
    """

    def test_backend_is_smtp_when_a_host_is_configured(self):
        # A configured EMAIL_HOST (production) selects the real SMTP backend —
        # a host always wins, even if the console fallback is disabled.
        self.assertEqual(
            _email_backend("smtp.resend.com", False),
            "django.core.mail.backends.smtp.EmailBackend",
        )

    def test_console_backend_only_when_fallback_is_allowed(self):
        # No host but the fallback is explicitly allowed (the DEBUG default):
        # mail is printed to the logs rather than handed to a dead default.
        for host in ("", None):
            self.assertEqual(
                _email_backend(host, True),
                "django.core.mail.backends.console.EmailBackend",
            )

    def test_no_host_and_no_fallback_refuses_to_boot(self):
        # Production with EMAIL_HOST unset and the fallback off must fail loudly
        # rather than silently log password-reset tokens in plaintext.
        for host in ("", None):
            with self.assertRaises(ImproperlyConfigured):
                _email_backend(host, False)

    def test_email_timeout_is_bounded(self):
        # A send must not be able to block forever on a slow/unreachable SMTP
        # server and tie up the worker — a finite timeout is always configured.
        self.assertIsNotNone(settings.EMAIL_TIMEOUT)
        self.assertGreater(settings.EMAIL_TIMEOUT, 0)

    def test_env_int_falls_back_on_a_non_numeric_value(self):
        # A garbage EMAIL_PORT-style value degrades to the default (with a
        # warning) instead of raising and taking the whole site down at import.
        with mock.patch.dict(os.environ, {"PROBE_INT": "not-a-number"}):
            with self.assertWarns(UserWarning):
                self.assertEqual(env_int("PROBE_INT", 587), 587)
        with mock.patch.dict(os.environ, {"PROBE_INT": "2587"}):
            self.assertEqual(env_int("PROBE_INT", 587), 2587)

    def test_a_default_from_address_is_configured(self):
        # Mail with no explicit sender must still go out with a real From — an
        # unset DEFAULT_FROM_EMAIL makes Django fall back to webmaster@localhost.
        self.assertTrue(settings.DEFAULT_FROM_EMAIL)
        self.assertIn("@", settings.DEFAULT_FROM_EMAIL)

    def test_mail_is_delivered_with_the_default_sender(self):
        # End-to-end plumbing: send with no explicit from_email and confirm it
        # lands, stamped with DEFAULT_FROM_EMAIL. (The test runner swaps in the
        # in-memory backend, so this asserts wiring, not real delivery.)
        mail.send_mail("Subject", "Body", None, ["someone@example.com"])
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].from_email, settings.DEFAULT_FROM_EMAIL)


class RegistrationTests(APITestCase):
    def _register(self, email):
        return self.client.post(
            REGISTER_URL,
            {
                "email": email,
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "Reg",
                "last_name": "Ister",
                "accept_terms": True,
            },
            format="json",
        )

    def test_register_creates_a_pending_inactive_account(self):
        resp = self._register("new@example.com")

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        user = User.objects.get(email="new@example.com")
        # The headline rule of this phase: nobody gets in without approval.
        self.assertFalse(user.is_active)
        # Registration must not log the new (pending) user in.
        self.assertNotIn(AUTH_COOKIE, resp.cookies)

    def test_register_hashes_the_password(self):
        self._register("hashed@example.com")
        user = User.objects.get(email="hashed@example.com")
        self.assertNotEqual(user.password, PASSWORD)
        self.assertTrue(user.check_password(PASSWORD))

    def test_register_persists_the_real_name(self):
        # Names are collected at sign-up (Phase 4) so a member has a display
        # name from day one, not an email local-part.
        self._register("named@example.com")
        user = User.objects.get(email="named@example.com")
        self.assertEqual(user.first_name, "Reg")
        self.assertEqual(user.last_name, "Ister")
        self.assertEqual(user.display_name, "Reg Ister")

    def test_register_requires_a_name(self):
        resp = self.client.post(
            REGISTER_URL,
            {"email": "noname@example.com", "password1": PASSWORD,
             "password2": PASSWORD},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(User.objects.filter(email="noname@example.com").exists())

    def test_registering_a_taken_email_is_not_revealed(self):
        # Account-enumeration hardening: a second sign-up with an already-taken
        # email must look *identical* to a fresh one (same status + body), so an
        # outsider can't probe which emails have accounts on a members-only app.
        first = self._register("dup@example.com")
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        again = self._register("dup@example.com")
        self.assertEqual(again.status_code, status.HTTP_201_CREATED)
        self.assertEqual(again.data, first.data)
        # No auth cookie leaked, and no second account created.
        self.assertNotIn(AUTH_COOKIE, again.cookies)
        self.assertEqual(User.objects.filter(email="dup@example.com").count(), 1)

    def test_re_registering_does_not_touch_the_existing_account(self):
        # The silent-duplicate path must not let someone overwrite an existing
        # account's password (or any field) by "registering" its email again.
        self._register("keep@example.com")
        user = User.objects.get(email="keep@example.com")
        original_hash = user.password

        resp = self.client.post(
            REGISTER_URL,
            {
                "email": "keep@example.com",
                "password1": "a-totally-different-99-pw",
                "password2": "a-totally-different-99-pw",
                "first_name": "Mal", "last_name": "Lory",
                "accept_terms": True,
            },
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        user.refresh_from_db()
        self.assertEqual(user.password, original_hash)
        self.assertEqual(user.first_name, "Reg")  # unchanged

    def test_register_records_when_terms_were_accepted(self):
        # As a data controller we keep a defensible record of consent.
        self._register("consenting@example.com")
        user = User.objects.get(email="consenting@example.com")
        self.assertIsNotNone(user.tos_accepted_at)

    def test_register_requires_accepting_the_terms(self):
        # Omitting the consent field is a 400 and creates no account.
        resp = self.client.post(
            REGISTER_URL,
            {
                "email": "unconsenting@example.com",
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "No", "last_name": "Thanks",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            User.objects.filter(email="unconsenting@example.com").exists()
        )

    def test_register_rejects_an_unticked_consent_box(self):
        # A present-but-false box is a refusal, not consent — also a 400.
        resp = self.client.post(
            REGISTER_URL,
            {
                "email": "refusing@example.com",
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "Not", "last_name": "Agreed",
                "accept_terms": False,
            },
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            User.objects.filter(email="refusing@example.com").exists()
        )


@override_settings(CACHES=LOCMEM_CACHE)
class LoginLogoutTests(APITestCase):
    # Login is throttled (per IP). Pin an isolated, cleared cache so this
    # class's own login calls can't inherit or leave throttle state.
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def _register(self, email):
        return self.client.post(
            REGISTER_URL,
            {
                "email": email,
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "Log",
                "last_name": "Inman",
                "accept_terms": True,
            },
            format="json",
        )

    def _activate(self, email):
        User.objects.filter(email=email).update(is_active=True)

    def _verify(self, email):
        # Mark the sign-up's EmailAddress as verified (as the code flow does).
        # Login now needs BOTH this and approval — see issue #73.
        EmailAddress.objects.filter(user__email=email).update(verified=True)

    def _approve(self, email):
        # The full happy path: approved AND verified.
        self._activate(email)
        self._verify(email)

    def _login(self, email):
        return self.client.post(
            LOGIN_URL, {"email": email, "password": PASSWORD}, format="json"
        )

    def test_login_is_rejected_while_inactive(self):
        # Verified but not yet approved — the approval gate still holds.
        self._register("pending@example.com")
        self._verify("pending@example.com")

        resp = self._login("pending@example.com")

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn(AUTH_COOKIE, resp.cookies)

    def test_login_is_rejected_while_unverified(self):
        # Approved but email not verified — the verification gate holds too, and
        # the message points the person at verifying (issue #73).
        self._register("unverified@example.com")
        self._activate("unverified@example.com")

        resp = self._login("unverified@example.com")

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn(AUTH_COOKIE, resp.cookies)
        self.assertIn("verify your email", str(resp.data).lower())

    def test_login_succeeds_once_approved_and_sets_httponly_cookie(self):
        self._register("member@example.com")
        self._approve("member@example.com")

        resp = self._login("member@example.com")

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn(AUTH_COOKIE, resp.cookies)
        # The token cookie must be httpOnly (unreadable by page JavaScript).
        self.assertTrue(resp.cookies[AUTH_COOKIE]["httponly"])

    def test_who_am_i_returns_the_logged_in_user(self):
        self._register("me@example.com")
        self._approve("me@example.com")
        self._login("me@example.com")  # sets the auth cookie on self.client

        resp = self.client.get(USER_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["email"], "me@example.com")
        # is_staff is exposed (drives the frontend admin link) and defaults False.
        self.assertIn("is_staff", resp.data)
        self.assertFalse(resp.data["is_staff"])

    def test_who_am_i_rejects_anonymous_requests(self):
        resp = self.client.get(USER_URL)
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logout_requires_csrf_then_clears_the_cookie(self):
        self._register("bye@example.com")
        self._approve("bye@example.com")

        # A CSRF-enforcing client, so the manual CSRF check in the cookie-JWT
        # auth actually runs (the default test client suppresses it). This
        # mirrors a real browser.
        client = APIClient(enforce_csrf_checks=True)
        client.get(CSRF_URL)  # primes the csrftoken cookie
        csrf = client.cookies["csrftoken"].value
        # Login needs no CSRF token — there's no auth cookie on the request yet.
        client.post(LOGIN_URL, {"email": "bye@example.com", "password": PASSWORD}, format="json")

        # Now authenticated: an unsafe request without the CSRF token is refused.
        blocked = client.post(LOGOUT_URL)
        self.assertEqual(blocked.status_code, status.HTTP_403_FORBIDDEN)

        # With the CSRF token, logout succeeds and the auth cookie is cleared.
        resp = client.post(LOGOUT_URL, HTTP_X_CSRFTOKEN=csrf)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.cookies[AUTH_COOKIE].value, "")


PASSWORD_CHANGE_URL = "/api/auth/password/change/"
NEW_PASSWORD = "fresh-tuna-71-lantern"


@override_settings(CACHES=LOCMEM_CACHE)
class PasswordChangeTests(APITestCase):
    """Changing your own password while logged in (dj-rest-auth's
    password/change/). The current password is required — see
    OLD_PASSWORD_FIELD_ENABLED in settings."""

    def setUp(self):
        cache.clear()  # password/change/ is throttled per user — isolate it
        self.user = User.objects.create_user(
            email="rotator@example.com", password=PASSWORD, is_active=True
        )
        self.client.force_authenticate(self.user)

    def tearDown(self):
        cache.clear()

    def _change(self, old, new1, new2):
        return self.client.post(
            PASSWORD_CHANGE_URL,
            {"old_password": old, "new_password1": new1, "new_password2": new2},
            format="json",
        )

    def test_changes_the_password_with_the_correct_current_one(self):
        resp = self._change(PASSWORD, NEW_PASSWORD, NEW_PASSWORD)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PASSWORD))
        self.assertFalse(self.user.check_password(PASSWORD))

    def test_wrong_current_password_is_rejected_and_password_unchanged(self):
        resp = self._change("not-my-password", NEW_PASSWORD, NEW_PASSWORD)

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))

    def test_the_current_password_is_required(self):
        resp = self.client.post(
            PASSWORD_CHANGE_URL,
            {"new_password1": NEW_PASSWORD, "new_password2": NEW_PASSWORD},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("old_password", resp.data)

    def test_mismatched_new_passwords_are_rejected(self):
        resp = self._change(PASSWORD, NEW_PASSWORD, NEW_PASSWORD + "-oops")

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))

    def test_a_weak_new_password_is_rejected(self):
        # Django's validators run on the new password (too short / too common).
        resp = self._change(PASSWORD, "123", "123")

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))

    def test_anonymous_requests_are_refused(self):
        self.client.force_authenticate(user=None)

        resp = self._change(PASSWORD, NEW_PASSWORD, NEW_PASSWORD)

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)


@override_settings(CACHES=LOCMEM_CACHE)
class LoginThrottleTests(APITestCase):
    """Login is rate-limited per IP so a burst of password guesses is cut off
    (issue #51). The counter is keyed on the client address, not the submitted
    email, so an attacker can't lock a real member out of their own account."""

    def setUp(self):
        cache.clear()  # start each test with an empty throttle bucket
        self.user = User.objects.create_user(
            email="brute@example.com", password=PASSWORD, is_active=True
        )

    def tearDown(self):
        cache.clear()

    def test_a_burst_of_attempts_is_throttled_with_429(self):
        wrong = {"email": "brute@example.com", "password": "wrong"}
        limit = configured_throttle_limit("login")
        # Attempts up to the configured limit are let through to the login logic,
        # which rejects the bad password with a 400…
        for _ in range(limit):
            resp = self.client.post(LOGIN_URL, wrong, format="json")
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        # …the next one is refused outright, before credentials are even checked.
        resp = self.client.post(LOGIN_URL, wrong, format="json")
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        # A `detail` message the SPA already surfaces to the user.
        self.assertIn("detail", resp.data)

    def test_a_normal_login_within_the_limit_still_succeeds(self):
        resp = self.client.post(
            LOGIN_URL,
            {"email": "brute@example.com", "password": PASSWORD},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn(AUTH_COOKIE, resp.cookies)

    def test_a_spoofed_x_forwarded_for_cannot_dodge_the_throttle(self):
        # In production Caddy appends the real client IP to X-Forwarded-For, so
        # the header Django sees is "<whatever the client sent>, <real ip>".
        # NUM_PROXIES=1 makes DRF trust only the last entry (Caddy's), so an
        # attacker rotating the spoofed prefix can't mint a fresh bucket. We
        # simulate that here: a constant trailing "real" IP with a per-request
        # junk prefix must still share ONE bucket and trip the 429.
        wrong = {"email": "brute@example.com", "password": "wrong"}
        limit = configured_throttle_limit("login")
        for i in range(limit):
            resp = self.client.post(
                LOGIN_URL,
                wrong,
                format="json",
                HTTP_X_FORWARDED_FOR=f"9.9.9.{i}, 203.0.113.7",
            )
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.client.post(
            LOGIN_URL,
            wrong,
            format="json",
            HTTP_X_FORWARDED_FOR="9.9.9.250, 203.0.113.7",
        )
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)


@override_settings(CACHES=LOCMEM_CACHE)
class PasswordChangeThrottleTests(APITestCase):
    """Password change is rate-limited per user: the current-password check is a
    guessing oracle for a hijacked session, so a burst is cut off (issue #51)."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="rotator@example.com", password=PASSWORD, is_active=True
        )
        self.client.force_authenticate(self.user)

    def tearDown(self):
        cache.clear()

    def test_a_burst_of_wrong_current_password_attempts_is_throttled(self):
        wrong = {
            "old_password": "not-my-password",
            "new_password1": NEW_PASSWORD,
            "new_password2": NEW_PASSWORD,
        }
        limit = configured_throttle_limit("password_change")
        for _ in range(limit):
            resp = self.client.post(PASSWORD_CHANGE_URL, wrong, format="json")
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.client.post(PASSWORD_CHANGE_URL, wrong, format="json")
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        # Throttled, so nothing changed — the original password still works.
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))


# --- Phase 4: profile editing (name, bio, avatar) ---------------------------

_AVATAR_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-avatars-")


def make_avatar_upload(name="me.jpg"):
    from django.core.files.uploadedfile import SimpleUploadedFile

    buffer = BytesIO()
    Image.new("RGB", (300, 200), (40, 120, 90)).save(buffer, "JPEG")
    buffer.seek(0)
    return SimpleUploadedFile(name, buffer.read(), content_type="image/jpeg")


@override_settings(MEDIA_ROOT=_AVATAR_MEDIA_ROOT)
class ProfileEditTests(APITestCase):
    """Editing your own profile via dj-rest-auth's user endpoint (PATCH)."""

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_AVATAR_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            email="editor@example.com", password=PASSWORD, is_active=True
        )
        self.client.force_authenticate(self.user)

    def test_can_edit_name_and_bio(self):
        resp = self.client.patch(
            USER_URL,
            {"first_name": "Ada", "last_name": "Lovelace", "bio": "Hello"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual(self.user.display_name, "Ada Lovelace")
        self.assertEqual(self.user.bio, "Hello")

    def test_can_upload_and_then_clear_an_avatar(self):
        # Upload…
        resp = self.client.patch(
            USER_URL, {"avatar": make_avatar_upload()}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNotNone(resp.data["avatar_thumb"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.avatar)
        self.assertTrue(self.user.avatar_thumb)

        # …then clear it.
        resp = self.client.patch(
            USER_URL, {"remove_avatar": "true"}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(resp.data["avatar_thumb"])
        self.user.refresh_from_db()
        self.assertFalse(self.user.avatar)

    def test_an_svg_avatar_is_rejected(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        svg = SimpleUploadedFile(
            "vector.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            content_type="image/svg+xml",
        )
        resp = self.client.patch(
            USER_URL, {"avatar": svg}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertFalse(self.user.avatar)


VERIFY_URL = "/api/auth/verify-email/"
RESEND_URL = "/api/auth/resend-verification/"


class EmailVerificationCodeModelTests(APITestCase):
    """Unit-level behaviour of the code itself (hashing, expiry, attempts)."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="model@example.com", password=PASSWORD
        )

    def test_generate_code_is_six_digits(self):
        for _ in range(20):
            code = generate_code()
            self.assertEqual(len(code), 6)
            self.assertTrue(code.isdigit())

    def test_the_plaintext_code_is_never_stored(self):
        code = EmailVerificationCode.issue(self.user)
        record = EmailVerificationCode.objects.get(user=self.user)
        self.assertNotEqual(record.code_hash, code)
        # It's a real password-hasher hash, and it verifies.
        self.assertTrue(record.verify(code))

    def test_a_wrong_code_burns_an_attempt(self):
        EmailVerificationCode.issue(self.user)
        record = EmailVerificationCode.objects.get(user=self.user)
        self.assertFalse(record.verify("000000-nope"[:6]))
        record.refresh_from_db()
        self.assertEqual(record.attempts, 1)

    def test_too_many_attempts_locks_even_the_right_code(self):
        code = EmailVerificationCode.issue(self.user)
        record = EmailVerificationCode.objects.get(user=self.user)
        wrong = "111111" if code != "111111" else "222222"
        for _ in range(EmailVerificationCode.MAX_ATTEMPTS):
            record.verify(wrong)
        record.refresh_from_db()
        # The correct code no longer works once the budget is spent.
        self.assertFalse(record.verify(code))

    def test_an_expired_code_fails(self):
        code = EmailVerificationCode.issue(self.user)
        record = EmailVerificationCode.objects.get(user=self.user)
        record.created_at = timezone.now() - (EmailVerificationCode.EXPIRY + timedelta(minutes=1))
        record.save(update_fields=["created_at"])
        self.assertTrue(record.is_expired)
        self.assertFalse(record.verify(code))

    def test_issue_replaces_the_previous_code(self):
        first = EmailVerificationCode.issue(self.user)
        second = EmailVerificationCode.issue(self.user)
        self.assertNotEqual(first, second)
        # Only one row per user, and it's the latest.
        self.assertEqual(EmailVerificationCode.objects.filter(user=self.user).count(), 1)
        record = EmailVerificationCode.objects.get(user=self.user)
        self.assertTrue(record.verify(second))
        self.assertFalse(record.verify(first))

    def test_issue_if_due_respects_the_cooldown(self):
        EmailVerificationCode.issue(self.user)
        # A second request straight away is suppressed (returns None, sends
        # nothing) — the anti-inbox-flood guard.
        self.assertIsNone(EmailVerificationCode.issue_if_due(self.user))
        # But once the cooldown has passed it issues a fresh one.
        record = EmailVerificationCode.objects.get(user=self.user)
        record.created_at = timezone.now() - (EmailVerificationCode.RESEND_COOLDOWN + timedelta(seconds=1))
        record.save(update_fields=["created_at"])
        self.assertIsNotNone(EmailVerificationCode.issue_if_due(self.user))


@override_settings(CACHES=LOCMEM_CACHE)
class EmailVerificationFlowTests(APITestCase):
    """The end-to-end sign-up → verify → login story over the API."""

    def setUp(self):
        cache.clear()  # resend is throttled — isolate the bucket

    def tearDown(self):
        cache.clear()

    def _register(self, email):
        return self.client.post(
            REGISTER_URL,
            {
                "email": email,
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "Ver",
                "last_name": "Ify",
                "accept_terms": True,
            },
            format="json",
        )

    def _code_from_last_email(self):
        # The plaintext code only exists in the sent message — pull it out like a
        # recipient would read it. Both the text and HTML parts carry it.
        body = mail.outbox[-1].body
        match = re.search(r"\b(\d{6})\b", body)
        self.assertIsNotNone(match, "no 6-digit code found in the email")
        return match.group(1)

    def test_signup_emails_a_branded_six_digit_code(self):
        resp = self._register("newbie@example.com")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, ["newbie@example.com"])
        self.assertIn("TimeLine", message.subject)
        self.assertRegex(message.body, r"\b\d{6}\b")
        # The branded HTML alternative is attached too.
        self.assertTrue(
            any("text/html" in alt[1] for alt in message.alternatives)
        )
        # The account starts unverified and inactive.
        user = User.objects.get(email="newbie@example.com")
        self.assertFalse(user.is_active)
        self.assertFalse(
            EmailAddress.objects.filter(user=user, verified=True).exists()
        )

    def test_a_duplicate_signup_sends_no_mail_and_looks_identical(self):
        first = self._register("dup@example.com")
        self.assertEqual(len(mail.outbox), 1)
        mail.outbox.clear()

        again = self._register("dup@example.com")
        # Byte-identical body, and crucially NO second email (enumeration guard).
        self.assertEqual(again.status_code, first.status_code)
        self.assertEqual(again.data, first.data)
        self.assertEqual(len(mail.outbox), 0)

    def test_verifying_with_the_right_code_flips_verified(self):
        self._register("flip@example.com")
        code = self._code_from_last_email()

        resp = self.client.post(
            VERIFY_URL, {"email": "flip@example.com", "code": code}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        user = User.objects.get(email="flip@example.com")
        self.assertTrue(
            EmailAddress.objects.filter(user=user, verified=True).exists()
        )
        # The code is consumed — it can't be replayed.
        self.assertFalse(EmailVerificationCode.objects.filter(user=user).exists())

    def test_a_wrong_code_is_refused_and_stays_unverified(self):
        self._register("wrong@example.com")
        code = self._code_from_last_email()
        bad = "000000" if code != "000000" else "999999"

        resp = self.client.post(
            VERIFY_URL, {"email": "wrong@example.com", "code": bad}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        user = User.objects.get(email="wrong@example.com")
        self.assertFalse(
            EmailAddress.objects.filter(user=user, verified=True).exists()
        )

    def test_verify_is_enumeration_safe(self):
        # An unknown email returns the SAME generic error as a wrong code, so it
        # can't be used to probe who's a member.
        unknown = self.client.post(
            VERIFY_URL, {"email": "ghost@example.com", "code": "123456"}, format="json"
        )
        self.assertEqual(unknown.status_code, status.HTTP_400_BAD_REQUEST)

        self._register("real@example.com")
        code = self._code_from_last_email()
        bad = "000000" if code != "000000" else "999999"
        wrong = self.client.post(
            VERIFY_URL, {"email": "real@example.com", "code": bad}, format="json"
        )
        self.assertEqual(unknown.data, wrong.data)

    def test_resend_sends_a_fresh_code_to_an_unverified_account(self):
        self._register("resend@example.com")
        mail.outbox.clear()
        # Move the issued code past the cooldown so resend isn't suppressed.
        EmailVerificationCode.objects.filter(user__email="resend@example.com").update(
            created_at=timezone.now() - (EmailVerificationCode.RESEND_COOLDOWN + timedelta(seconds=1))
        )

        resp = self.client.post(
            RESEND_URL, {"email": "resend@example.com"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)

    def test_resend_is_enumeration_safe_for_unknown_and_verified(self):
        # Unknown address: identical 200, no mail.
        unknown = self.client.post(
            RESEND_URL, {"email": "nobody@example.com"}, format="json"
        )
        self.assertEqual(unknown.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 0)

        # Already-verified address: identical 200, still no mail.
        self._register("done@example.com")
        EmailAddress.objects.filter(user__email="done@example.com").update(verified=True)
        mail.outbox.clear()
        verified = self.client.post(
            RESEND_URL, {"email": "done@example.com"}, format="json"
        )
        self.assertEqual(verified.status_code, status.HTTP_200_OK)
        self.assertEqual(verified.data, unknown.data)
        self.assertEqual(len(mail.outbox), 0)

    def test_resend_is_rate_limited(self):
        limit = configured_throttle_limit("resend_verification")
        for _ in range(limit):
            resp = self.client.post(
                RESEND_URL, {"email": "spam@example.com"}, format="json"
            )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
        blocked = self.client.post(
            RESEND_URL, {"email": "spam@example.com"}, format="json"
        )
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_verify_email_is_rate_limited(self):
        # The per-code attempt budget only guards one known code; a per-IP throttle
        # stops hammering the endpoint across many emails.
        limit = configured_throttle_limit("verify_email")
        payload = {"email": "probe@example.com", "code": "123456"}
        for _ in range(limit):
            resp = self.client.post(VERIFY_URL, payload, format="json")
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        blocked = self.client.post(VERIFY_URL, payload, format="json")
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_signup_still_succeeds_if_the_email_fails_to_send(self):
        # A transient provider failure must not 500 sign-up: the account + code
        # exist, and the person can use resend. (Otherwise a retry would hit the
        # silent-duplicate path and never send a code.)
        with mock.patch(
            "accounts.views.send_verification_code",
            side_effect=Exception("smtp down"),
        ):
            resp = self._register("hiccup@example.com")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(User.objects.filter(email="hiccup@example.com").exists())

    def test_resend_stays_enumeration_safe_when_sending_fails(self):
        # A send error for a real unverified account must not leak (a 500) versus
        # an unknown address (a 200) — both must look identical.
        self._register("failsend@example.com")
        EmailVerificationCode.objects.filter(
            user__email="failsend@example.com"
        ).update(
            created_at=timezone.now()
            - (EmailVerificationCode.RESEND_COOLDOWN + timedelta(seconds=1))
        )
        with mock.patch(
            "accounts.views.send_verification_code",
            side_effect=Exception("smtp down"),
        ):
            real = self.client.post(
                RESEND_URL, {"email": "failsend@example.com"}, format="json"
            )
        unknown = self.client.post(
            RESEND_URL, {"email": "nobody-here@example.com"}, format="json"
        )
        self.assertEqual(real.status_code, status.HTTP_200_OK)
        self.assertEqual(real.data, unknown.data)


RESET_REQUEST_URL = "/api/auth/password-reset/"
RESET_CONFIRM_URL = "/api/auth/password-reset/confirm/"
NEW_PASSWORD = "fresh-horse-99-staple"


@override_settings(CACHES=LOCMEM_CACHE)
class PasswordResetFlowTests(APITestCase):
    """Forgotten-password reset over the API (issue #38): request → confirm."""

    def setUp(self):
        cache.clear()  # both endpoints are throttled — isolate the bucket
        # A real, approved+verified member who has forgotten their password.
        self.user = User.objects.create_user(
            email="forgot@example.com", password=PASSWORD, is_active=True
        )
        EmailAddress.objects.create(
            user=self.user, email=self.user.email, verified=True, primary=True
        )

    def tearDown(self):
        cache.clear()

    def _code_from_last_email(self):
        body = mail.outbox[-1].body
        match = re.search(r"\b(\d{6})\b", body)
        self.assertIsNotNone(match, "no 6-digit code found in the email")
        return match.group(1)

    def _request(self, email):
        return self.client.post(
            RESET_REQUEST_URL, {"email": email}, format="json"
        )

    def _confirm(self, email, code, p1=NEW_PASSWORD, p2=NEW_PASSWORD):
        return self.client.post(
            RESET_CONFIRM_URL,
            {"email": email, "code": code, "new_password1": p1, "new_password2": p2},
            format="json",
        )

    # --- request -------------------------------------------------------------

    def test_request_emails_a_branded_six_digit_code(self):
        resp = self._request("forgot@example.com")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, ["forgot@example.com"])
        self.assertIn("TimeLine", message.subject)
        self.assertRegex(message.body, r"\b\d{6}\b")
        self.assertTrue(
            any("text/html" in alt[1] for alt in message.alternatives)
        )
        self.assertTrue(
            PasswordResetCode.objects.filter(user=self.user).exists()
        )

    def test_request_is_enumeration_safe_for_an_unknown_email(self):
        # Identical 200, and crucially no mail + no code row for a non-member.
        unknown = self._request("ghost@example.com")
        real = self._request("forgot@example.com")
        self.assertEqual(unknown.status_code, status.HTTP_200_OK)
        self.assertEqual(unknown.data, real.data)
        self.assertEqual(
            [m.to for m in mail.outbox], [["forgot@example.com"]]
        )

    def test_request_is_rate_limited(self):
        limit = configured_throttle_limit("password_reset")
        for _ in range(limit):
            self.assertEqual(
                self._request("spam@example.com").status_code,
                status.HTTP_200_OK,
            )
        blocked = self._request("spam@example.com")
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

    def test_request_stays_enumeration_safe_when_sending_fails(self):
        # A send error for a real account must not leak (a 500) versus an unknown
        # address (a 200) — both must look identical.
        with mock.patch(
            "accounts.views.send_password_reset_code",
            side_effect=Exception("smtp down"),
        ):
            real = self._request("forgot@example.com")
        unknown = self._request("nobody@example.com")
        self.assertEqual(real.status_code, status.HTTP_200_OK)
        self.assertEqual(real.data, unknown.data)

    def test_request_spends_one_hash_whether_or_not_the_account_exists(self):
        # Timing-oracle guard: a real, not-in-cooldown account hashes in
        # EmailCode.issue; an unknown address hashes a throwaway in the view. Both
        # must spend exactly ONE PBKDF2 hash, so response latency can't reveal
        # whether an account exists. We count make_password calls in both modules
        # (each imported its own reference, so both need patching).
        from accounts import models as models_mod
        from accounts import views as views_mod

        real_make = models_mod.make_password
        calls = []

        def counting(*args, **kwargs):
            calls.append(1)
            return real_make(*args, **kwargs)

        with mock.patch.object(
            models_mod, "make_password", side_effect=counting
        ), mock.patch.object(views_mod, "make_password", side_effect=counting):
            self._request("forgot@example.com")
            known = len(calls)
            calls.clear()
            self._request("ghost@example.com")
            unknown = len(calls)

        self.assertEqual(known, 1, "real account should hash exactly once")
        self.assertEqual(unknown, 1, "unknown address should hash exactly once")

    # --- confirm -------------------------------------------------------------

    def test_confirm_with_the_right_code_sets_the_new_password(self):
        self._request("forgot@example.com")
        code = self._code_from_last_email()

        resp = self._confirm("forgot@example.com", code)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW_PASSWORD))
        self.assertFalse(self.user.check_password(PASSWORD))
        # The code is consumed — it can't be replayed.
        self.assertFalse(
            PasswordResetCode.objects.filter(user=self.user).exists()
        )
        # And the reset user can now actually log in with the new password.
        login = self.client.post(
            LOGIN_URL,
            {"email": "forgot@example.com", "password": NEW_PASSWORD},
            format="json",
        )
        self.assertEqual(login.status_code, status.HTTP_200_OK)

    def test_confirm_marks_the_address_verified(self):
        # An account that never verified but forgot its password shouldn't be
        # stuck behind the verify gate after resetting — receiving the code proved
        # inbox control.
        EmailAddress.objects.filter(user=self.user).update(verified=False)
        self._request("forgot@example.com")
        code = self._code_from_last_email()

        self._confirm("forgot@example.com", code)
        self.assertTrue(
            EmailAddress.objects.filter(user=self.user, verified=True).exists()
        )

    def test_confirm_with_a_wrong_code_is_refused_and_password_unchanged(self):
        self._request("forgot@example.com")
        code = self._code_from_last_email()
        bad = "000000" if code != "000000" else "999999"

        resp = self._confirm("forgot@example.com", bad)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))

    def test_confirm_is_enumeration_safe(self):
        # Unknown email returns the SAME generic error as a wrong code.
        unknown = self._confirm("ghost@example.com", "123456")
        self.assertEqual(unknown.status_code, status.HTTP_400_BAD_REQUEST)

        self._request("forgot@example.com")
        code = self._code_from_last_email()
        bad = "000000" if code != "000000" else "999999"
        wrong = self._confirm("forgot@example.com", bad)
        self.assertEqual(unknown.data, wrong.data)

    def test_confirm_rejects_mismatched_passwords_without_burning_the_code(self):
        self._request("forgot@example.com")
        code = self._code_from_last_email()

        resp = self._confirm(
            "forgot@example.com", code, p1=NEW_PASSWORD, p2="different-99-staple"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        # The code survives, so the user can retry with matching passwords.
        self.assertTrue(
            PasswordResetCode.objects.filter(user=self.user).exists()
        )
        ok = self._confirm("forgot@example.com", code)
        self.assertEqual(ok.status_code, status.HTTP_200_OK)

    def test_confirm_rejects_a_weak_password_without_burning_the_code(self):
        self._request("forgot@example.com")
        code = self._code_from_last_email()

        resp = self._confirm("forgot@example.com", code, p1="123", p2="123")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(PASSWORD))
        # Still resettable with a strong password + the same code.
        ok = self._confirm("forgot@example.com", code)
        self.assertEqual(ok.status_code, status.HTTP_200_OK)

    def test_confirm_is_rate_limited(self):
        limit = configured_throttle_limit("password_reset_confirm")
        payload = {"email": "probe@example.com", "code": "123456"}
        for _ in range(limit):
            resp = self.client.post(RESET_CONFIRM_URL, payload, format="json")
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        blocked = self.client.post(RESET_CONFIRM_URL, payload, format="json")
        self.assertEqual(blocked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)


MOBILE_LOGIN_URL = "/api/auth/mobile/login/"
MOBILE_REFRESH_URL = "/api/auth/mobile/refresh/"
MOBILE_LOGOUT_URL = "/api/auth/mobile/logout/"


@override_settings(CACHES=LOCMEM_CACHE)
class MobileAuthTests(APITestCase):
    """The Phase 9 native-app auth path: Bearer tokens, no cookies, rotation.

    These pin behaviour the iOS app depends on *and* guard the web app against
    regressing — several of these tests exist specifically because the two
    clients share one backend and it would be easy to "fix" one by breaking the
    other.
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="mobile@example.com",
            password=PASSWORD,
            first_name="Mo",
            last_name="Bile",
        )
        self.user.is_active = True
        self.user.save()
        EmailAddress.objects.create(
            user=self.user, email=self.user.email, verified=True, primary=True
        )

    def tearDown(self):
        cache.clear()

    def _login(self):
        return self.client.post(
            MOBILE_LOGIN_URL,
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )

    # --- login -----------------------------------------------------------

    def test_login_returns_both_tokens_in_the_body(self):
        # The whole reason this endpoint exists: JWT_AUTH_HTTPONLY blanks
        # `refresh` out of the web login response, and the app needs it.
        resp = self._login()

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data["access"])
        self.assertTrue(resp.data["refresh"])
        self.assertEqual(resp.data["user"]["email"], self.user.email)

    def test_login_sets_no_cookies(self):
        # A native client has no cookie jar we want to lean on; a Set-Cookie here
        # would be a confusing no-op.
        resp = self._login()

        self.assertNotIn(AUTH_COOKIE, resp.cookies)
        self.assertNotIn("timeline-refresh", resp.cookies)

    def test_login_still_requires_admin_approval(self):
        # The mobile path must not be a way around the membership gate.
        self.user.is_active = False
        self.user.save()

        resp = self._login()

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_login_still_requires_a_verified_email(self):
        # Guards against anyone rebuilding this view on simplejwt's stock
        # TokenObtainPairView, which would skip CustomLoginSerializer entirely.
        EmailAddress.objects.filter(user=self.user).update(verified=False)

        resp = self._login()

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("verify your email", str(resp.data).lower())

    def test_web_login_still_withholds_the_refresh_token(self):
        # Regression guard the other way: adding the mobile endpoint must not
        # have loosened the browser's cookie-based flow.
        resp = self.client.post(
            LOGIN_URL,
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["refresh"], "")
        self.assertIn(AUTH_COOKIE, resp.cookies)
        self.assertTrue(resp.cookies[AUTH_COOKIE]["httponly"])

    # --- Bearer authentication -------------------------------------------

    def test_bearer_token_authenticates_a_protected_endpoint(self):
        access = self._login().data["access"]
        client = APIClient()

        resp = client.get(USER_URL, HTTP_AUTHORIZATION=f"Bearer {access}")

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["email"], self.user.email)

    def test_bearer_token_needs_no_csrf_on_a_mutating_request(self):
        # JWT_AUTH_COOKIE_USE_CSRF is on, but CSRF is a cookie concern:
        # JWTCookieAuthentication only enforces it on the cookie path, so a
        # header-authenticated write must succeed without a CSRF token.
        access = self._login().data["access"]
        client = APIClient(enforce_csrf_checks=True)

        resp = client.patch(
            USER_URL,
            {"first_name": "Renamed"},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_garbage_bearer_token_is_rejected(self):
        client = APIClient()

        resp = client.get(USER_URL, HTTP_AUTHORIZATION="Bearer not-a-real-token")

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_expired_bearer_token_is_rejected(self):
        token = AccessToken.for_user(self.user)
        token.set_exp(lifetime=timedelta(seconds=-1))
        client = APIClient()

        resp = client.get(USER_URL, HTTP_AUTHORIZATION=f"Bearer {token}")

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_deactivated_user_is_locked_out_despite_a_valid_token(self):
        # Matters because the refresh token now lives for 90 days: if the
        # maintainer deactivates someone, their existing tokens must stop working
        # rather than staying good until expiry.
        access = self._login().data["access"]
        self.user.is_active = False
        self.user.save()
        client = APIClient()

        resp = client.get(USER_URL, HTTP_AUTHORIZATION=f"Bearer {access}")

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    # --- refresh + rotation ----------------------------------------------

    def test_refresh_returns_a_new_working_pair(self):
        refresh = self._login().data["refresh"]

        resp = self.client.post(
            MOBILE_REFRESH_URL, {"refresh": refresh}, format="json"
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data["access"])
        # ROTATE_REFRESH_TOKENS means a *new* refresh token comes back too.
        self.assertTrue(resp.data["refresh"])
        self.assertNotEqual(resp.data["refresh"], refresh)

        client = APIClient()
        whoami = client.get(
            USER_URL, HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}"
        )
        self.assertEqual(whoami.status_code, status.HTTP_200_OK)

    def test_rotated_away_refresh_token_is_rejected(self):
        # The point of BLACKLIST_AFTER_ROTATION: a captured refresh token is
        # useful only until its owner next refreshes, not for the full 90 days.
        original = self._login().data["refresh"]
        self.client.post(MOBILE_REFRESH_URL, {"refresh": original}, format="json")

        resp = self.client.post(
            MOBILE_REFRESH_URL, {"refresh": original}, format="json"
        )

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    # --- logout ----------------------------------------------------------

    def test_mobile_refresh_token_is_long_lived(self):
        # The app must stay logged in; a logged-out app gets no push.
        refresh = self._login().data["refresh"]

        token = MobileRefreshToken(refresh)
        remaining = datetime_from_epoch(token["exp"]) - timezone.now()

        self.assertGreater(remaining, timedelta(days=80))

    def test_web_refresh_cookie_stays_short_lived(self):
        # The web cookie must NOT inherit the app's long lifetime — both clients
        # share SIMPLE_JWT, so this is the regression guard for that.
        resp = self.client.post(
            LOGIN_URL,
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )

        expires = parsedate_to_datetime(resp.cookies["timeline-refresh"]["expires"])

        self.assertLess(expires - timezone.now(), timedelta(days=2))

    def test_web_refresh_token_cannot_be_upgraded_at_the_mobile_endpoint(self):
        # The attack the `client` claim exists to stop: without it, a stolen
        # 1-day browser token could be POSTed here and rotated into a 90-day one.
        web_refresh = str(RefreshToken.for_user(self.user))

        resp = self.client.post(
            MOBILE_REFRESH_URL, {"refresh": web_refresh}, format="json"
        )

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_rotation_preserves_the_long_lifetime_and_the_claim(self):
        # A rotated token must still be a *mobile* token, or the app would
        # silently drop to the web's 1-day lifetime on its first refresh.
        refresh = self._login().data["refresh"]

        rotated = self.client.post(
            MOBILE_REFRESH_URL, {"refresh": refresh}, format="json"
        ).data["refresh"]

        token = MobileRefreshToken(rotated)
        self.assertEqual(token.get("client"), "mobile")
        remaining = datetime_from_epoch(token["exp"]) - timezone.now()
        self.assertGreater(remaining, timedelta(days=80))

    def test_login_survives_enabling_return_expiration(self):
        # With JWT_AUTH_RETURN_EXPIRATION on, get_response_serializer() switches
        # to a serializer that REQUIRES access_expiration/refresh_expiration. We
        # supply them unconditionally so flipping that setting can't 500 mobile
        # login while leaving web login working — a split-client trap.
        # (dj-rest-auth binds REST_AUTH at import, so override_settings can't
        # reach it; patch the settings object itself.)
        with mock.patch.object(
            dj_rest_auth_settings, "JWT_AUTH_RETURN_EXPIRATION", True
        ):
            resp = self._login()

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn("access_expiration", resp.data)
        self.assertIn("refresh_expiration", resp.data)

    def test_logout_blacklists_the_refresh_token(self):
        # Deleting the token from the device isn't enough on its own — a copy
        # lifted from a backup would still mint access tokens.
        refresh = self._login().data["refresh"]

        logout = self.client.post(
            MOBILE_LOGOUT_URL, {"refresh": refresh}, format="json"
        )
        self.assertEqual(logout.status_code, status.HTTP_200_OK)

        resp = self.client.post(
            MOBILE_REFRESH_URL, {"refresh": refresh}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)


class StaleAuthCookieTests(APITestCase):
    """A cookie for a user who no longer exists must not lock login out (#93).

    The browser resends `timeline-auth` on every request, so before the fix a
    validly-signed token pointing at a deleted row 401'd the login POST itself
    — leaving no in-app way to recover. See accounts/authentication.py.
    """

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="survivor@example.com",
            password=PASSWORD,
            first_name="Still",
            last_name="Here",
            is_active=True,
        )
        EmailAddress.objects.create(
            user=self.user, email=self.user.email, verified=True, primary=True
        )

    def tearDown(self):
        cache.clear()

    def _cookie_for_deleted_user(self):
        """A signed access token whose user id has no row behind it."""
        doomed = User.objects.create_user(
            email="deleted@example.com", password=PASSWORD, is_active=True
        )
        token = str(AccessToken.for_user(doomed))
        doomed.delete()
        return token

    def test_login_succeeds_despite_a_cookie_for_a_deleted_user(self):
        # The regression this issue is about.
        self.client.cookies[AUTH_COOKIE] = self._cookie_for_deleted_user()

        resp = self.client.post(
            LOGIN_URL,
            {"email": self.user.email, "password": PASSWORD},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # The fresh cookie replaces the stale one, so the trap doesn't persist.
        self.assertIn(AUTH_COOKIE, resp.cookies)
        self.assertNotEqual(resp.cookies[AUTH_COOKIE].value, "")

    def test_protected_endpoint_still_401s_for_a_deleted_user(self):
        # Anonymous, not authenticated — we relaxed the auth layer, not access.
        self.client.cookies[AUTH_COOKIE] = self._cookie_for_deleted_user()

        resp = self.client.get(USER_URL)

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_bearer_token_for_a_deleted_user_still_401s(self):
        # Mobile sends the header deliberately and re-auths on 401; there's no
        # automatic-resend trap, so the hard failure stays.
        token = self._cookie_for_deleted_user()

        resp = self.client.get(USER_URL, HTTP_AUTHORIZATION=f"Bearer {token}")

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_expired_cookie_still_401s(self):
        token = AccessToken.for_user(self.user)
        token.set_exp(from_time=timezone.now() - timedelta(days=2))
        self.client.cookies[AUTH_COOKIE] = str(token)

        resp = self.client.get(USER_URL)

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_tampered_cookie_still_401s(self):
        self.client.cookies[AUTH_COOKIE] = str(AccessToken.for_user(self.user)) + "x"

        resp = self.client.get(USER_URL)

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_cookie_for_a_deactivated_user_still_401s(self):
        # is_active=False is the admin-approval / ban gate. It must keep
        # failing hard rather than degrading to anonymous.
        token = str(AccessToken.for_user(self.user))
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.client.cookies[AUTH_COOKIE] = token

        resp = self.client.get(USER_URL)

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)
