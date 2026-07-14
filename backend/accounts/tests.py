import shutil
import tempfile
from io import BytesIO

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from PIL import Image
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from config.settings import _email_backend

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
        # A configured EMAIL_HOST (production) selects the real SMTP backend.
        self.assertEqual(
            _email_backend("smtp.resend.com"),
            "django.core.mail.backends.smtp.EmailBackend",
        )

    def test_backend_falls_back_to_console_without_a_host(self):
        # No host (local dev, or a prod deploy that hasn't set EMAIL_HOST):
        # mail is printed to the logs, never silently handed to a dead default.
        for host in ("", None):
            self.assertEqual(
                _email_backend(host),
                "django.core.mail.backends.console.EmailBackend",
            )

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

    def _login(self, email):
        return self.client.post(
            LOGIN_URL, {"email": email, "password": PASSWORD}, format="json"
        )

    def test_login_is_rejected_while_inactive(self):
        self._register("pending@example.com")

        resp = self._login("pending@example.com")

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn(AUTH_COOKIE, resp.cookies)

    def test_login_succeeds_once_approved_and_sets_httponly_cookie(self):
        self._register("member@example.com")
        self._activate("member@example.com")

        resp = self._login("member@example.com")

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn(AUTH_COOKIE, resp.cookies)
        # The token cookie must be httpOnly (unreadable by page JavaScript).
        self.assertTrue(resp.cookies[AUTH_COOKIE]["httponly"])

    def test_who_am_i_returns_the_logged_in_user(self):
        self._register("me@example.com")
        self._activate("me@example.com")
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
        self._activate("bye@example.com")

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
