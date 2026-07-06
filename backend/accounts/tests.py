import shutil
import tempfile
from io import BytesIO

from django.contrib.auth import get_user_model
from django.test import override_settings
from PIL import Image
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

User = get_user_model()

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


class LoginLogoutTests(APITestCase):
    def _register(self, email):
        return self.client.post(
            REGISTER_URL,
            {
                "email": email,
                "password1": PASSWORD,
                "password2": PASSWORD,
                "first_name": "Log",
                "last_name": "Inman",
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
