import importlib.util
import os
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Follow, Post

User = get_user_model()

FEED_URL = "/api/feed/"
POSTS_URL = "/api/posts/"
USERS_URL = "/api/users/"
REQUESTS_URL = "/api/follow-requests/"
PASSWORD = "correct-horse-42-battery"

ACCEPTED = Follow.Status.ACCEPTED
PENDING = Follow.Status.PENDING


def make_user(email, **kwargs):
    # Active by default so the account can log in / be followed in tests;
    # a test can still pass is_active=False to make a pending account.
    kwargs.setdefault("is_active", True)
    return User.objects.create_user(email=email, password=PASSWORD, **kwargs)


def follow_url(user):
    return f"/api/users/{user.pk}/follow/"

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


class DisplayNameTests(APITestCase):
    def test_display_name_uses_full_name_when_set(self):
        user = make_user("named@example.com", first_name="Sam", last_name="Jefford")
        self.assertEqual(user.display_name, "Sam Jefford")

    def test_display_name_falls_back_to_email_local_part(self):
        # No name set → the bit before the @, never the full address (privacy).
        user = make_user("sam.jefford@example.com")
        self.assertEqual(user.display_name, "sam.jefford")


class AuthRequiredTests(APITestCase):
    def test_feed_rejects_anonymous(self):
        resp = self.client.get(FEED_URL)
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_post_create_rejects_anonymous(self):
        resp = self.client.post(POSTS_URL, {"text": "hi"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)


class PostCreateTests(APITestCase):
    def setUp(self):
        self.user = make_user("author@example.com")
        self.client.force_authenticate(self.user)

    def test_create_post_attributes_author_to_request_user(self):
        resp = self.client.post(POSTS_URL, {"text": "Hello world"}, format="json")

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        post = Post.objects.get()
        self.assertEqual(post.author, self.user)
        self.assertEqual(post.text, "Hello world")

    def test_client_cannot_spoof_the_author(self):
        someone_else = make_user("victim@example.com")
        resp = self.client.post(
            POSTS_URL,
            {"text": "not from me", "author": someone_else.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        # author in the body is ignored — the post belongs to the logged-in user.
        self.assertEqual(Post.objects.get().author, self.user)

    def test_blank_post_is_rejected(self):
        resp = self.client.post(POSTS_URL, {"text": "   "}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Post.objects.count(), 0)


class FeedOrderingTests(APITestCase):
    def test_feed_is_strictly_newest_first(self):
        user = make_user("me@example.com")
        self.client.force_authenticate(user)

        # created_at is auto; creating in order gives a known chronology.
        first = Post.objects.create(author=user, text="oldest")
        second = Post.objects.create(author=user, text="middle")
        third = Post.objects.create(author=user, text="newest")

        resp = self.client.get(FEED_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = [p["id"] for p in resp.data["results"]]
        self.assertEqual(ids, [third.id, second.id, first.id])

    def test_pagination_is_stable_when_posts_share_a_timestamp(self):
        # Posts made in the same clock tick tie on created_at; without a unique
        # tiebreaker in the ordering, paging can duplicate or skip a post at the
        # page boundary. Force a shared created_at and page all the way through.
        from django.utils import timezone

        user = make_user("me@example.com")
        self.client.force_authenticate(user)

        total = 25  # > PAGE_SIZE (20), so at least two pages.
        for i in range(total):
            Post.objects.create(author=user, text=f"post {i}")
        # auto_now_add ignores an assigned value, so pin the timestamp after.
        Post.objects.all().update(created_at=timezone.now())

        seen = []
        url = FEED_URL
        while url:
            resp = self.client.get(url)
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            seen.extend(p["id"] for p in resp.data["results"])
            url = resp.data["next"]

        self.assertEqual(len(seen), total)  # no post skipped
        self.assertEqual(len(set(seen)), total)  # and none duplicated


class FeedScopingTests(APITestCase):
    """The core promise: you see your own posts + those of people you follow,
    and nobody else's."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.followed = make_user("followed@example.com")
        self.stranger = make_user("stranger@example.com")

        self.my_post = Post.objects.create(author=self.me, text="mine")
        self.followed_post = Post.objects.create(
            author=self.followed, text="followed"
        )
        self.stranger_post = Post.objects.create(
            author=self.stranger, text="stranger"
        )

        Follow.objects.create(
            follower=self.me, followee=self.followed, status=ACCEPTED
        )
        self.client.force_authenticate(self.me)

    def test_feed_includes_self_and_followed_but_not_strangers(self):
        resp = self.client.get(FEED_URL)

        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(self.my_post.id, ids)
        self.assertIn(self.followed_post.id, ids)
        self.assertNotIn(self.stranger_post.id, ids)

    def test_unfollowing_removes_their_posts_from_the_feed(self):
        self.client.delete(follow_url(self.followed))

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.followed_post.id, ids)
        self.assertIn(self.my_post.id, ids)  # own posts stay

    def test_deactivated_author_drops_out_of_the_feed(self):
        # Deactivating a member (the maintainer's ban lever) must pull their
        # posts from existing followers' feeds too — not just hide their profile.
        self.followed.is_active = False
        self.followed.save(update_fields=["is_active"])

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.followed_post.id, ids)
        self.assertIn(self.my_post.id, ids)  # own posts stay


class FollowRequestTests(APITestCase):
    """Follows are private: POST creates a pending request, and the follower
    sees nothing until the followee approves."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.other = make_user("other@example.com")
        self.other_post = Post.objects.create(author=self.other, text="hi")
        self.client.force_authenticate(self.me)

    def test_follow_creates_a_pending_request_not_an_accepted_follow(self):
        resp = self.client.post(follow_url(self.other))

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["follow_status"], PENDING)
        follow = Follow.objects.get(follower=self.me, followee=self.other)
        self.assertEqual(follow.status, PENDING)

    def test_pending_request_does_not_yet_show_their_posts(self):
        self.client.post(follow_url(self.other))

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.other_post.id, ids)

    def test_requesting_twice_is_a_noop(self):
        self.client.post(follow_url(self.other))
        resp = self.client.post(follow_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            Follow.objects.filter(follower=self.me, followee=self.other).count(), 1
        )

    def test_cannot_follow_yourself(self):
        resp = self.client.post(follow_url(self.me))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Follow.objects.count(), 0)

    def test_deleting_cancels_a_pending_request(self):
        self.client.post(follow_url(self.other))
        resp = self.client.delete(follow_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(
            Follow.objects.filter(follower=self.me, followee=self.other).exists()
        )

    def test_unfollow_removes_an_accepted_follow(self):
        Follow.objects.create(
            follower=self.me, followee=self.other, status=ACCEPTED
        )
        resp = self.client.delete(follow_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(
            Follow.objects.filter(follower=self.me, followee=self.other).exists()
        )

    def test_following_unknown_user_is_404(self):
        resp = self.client.post("/api/users/999999/follow/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class ApproveRejectTests(APITestCase):
    """The requestee approves or rejects an incoming request."""

    def setUp(self):
        self.owner = make_user("owner@example.com")
        self.requester = make_user("requester@example.com")
        self.owner_post = Post.objects.create(author=self.owner, text="private")
        # requester asks to follow owner.
        self.req = Follow.objects.create(
            follower=self.requester, followee=self.owner, status=PENDING
        )

    def _approve(self, pk):
        return self.client.post(f"{REQUESTS_URL}{pk}/approve/")

    def _reject(self, pk):
        return self.client.post(f"{REQUESTS_URL}{pk}/reject/")

    def test_incoming_requests_list_shows_only_your_pending_requests(self):
        # A request addressed to someone else must not appear in owner's inbox.
        third = make_user("third@example.com")
        Follow.objects.create(
            follower=third, followee=self.requester, status=PENDING
        )
        self.client.force_authenticate(self.owner)

        resp = self.client.get(REQUESTS_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rows = resp.data["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], self.req.id)
        self.assertEqual(rows[0]["requester"]["id"], self.requester.id)

    def test_approve_grants_the_follow_and_reveals_posts(self):
        self.client.force_authenticate(self.owner)
        resp = self._approve(self.req.id)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.req.refresh_from_db()
        self.assertEqual(self.req.status, ACCEPTED)

        # The requester can now see the owner's posts in their feed.
        self.client.force_authenticate(self.requester)
        feed = self.client.get(FEED_URL)
        ids = {p["id"] for p in feed.data["results"]}
        self.assertIn(self.owner_post.id, ids)

    def test_reject_deletes_the_request(self):
        self.client.force_authenticate(self.owner)
        resp = self._reject(self.req.id)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(Follow.objects.filter(pk=self.req.id).exists())

    def test_cannot_act_on_a_request_that_isnt_yours(self):
        # The requester (not the followee) can't approve their own request.
        self.client.force_authenticate(self.requester)
        self.assertEqual(
            self._approve(self.req.id).status_code, status.HTTP_404_NOT_FOUND
        )
        self.assertEqual(
            self._reject(self.req.id).status_code, status.HTTP_404_NOT_FOUND
        )
        self.req.refresh_from_db()
        self.assertEqual(self.req.status, PENDING)  # untouched


class UserListTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.other = make_user("other@example.com")
        self.client.force_authenticate(self.me)

    def test_list_excludes_self_and_reports_follow_status(self):
        Follow.objects.create(
            follower=self.me, followee=self.other, status=ACCEPTED
        )

        resp = self.client.get(USERS_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rows = resp.data["results"]
        ids = {r["id"] for r in rows}
        self.assertNotIn(self.me.pk, ids)  # never list yourself
        other_row = next(r for r in rows if r["id"] == self.other.pk)
        self.assertEqual(other_row["follow_status"], ACCEPTED)
        # No email is exposed to other members.
        self.assertNotIn("email", other_row)

    def test_follow_status_reflects_none_pending_accepted(self):
        pending_user = make_user("pending-target@example.com")
        none_user = make_user("stranger@example.com")
        accepted_user = make_user("friend@example.com")
        Follow.objects.create(
            follower=self.me, followee=pending_user, status=PENDING
        )
        Follow.objects.create(
            follower=self.me, followee=accepted_user, status=ACCEPTED
        )

        resp = self.client.get(USERS_URL)
        by_id = {r["id"]: r["follow_status"] for r in resp.data["results"]}

        self.assertEqual(by_id[pending_user.id], PENDING)
        self.assertEqual(by_id[accepted_user.id], ACCEPTED)
        self.assertEqual(by_id[none_user.id], "none")

    def test_inactive_users_are_hidden(self):
        make_user("pending@example.com", is_active=False)
        resp = self.client.get(USERS_URL)
        visible = {r["id"] for r in resp.data["results"]}
        self.assertEqual(visible, {self.other.pk})


class ProfileGatingTests(APITestCase):
    """Profile posts are private-by-default: only you and accepted followers
    can read them."""

    def setUp(self):
        self.owner = make_user("owner@example.com")
        self.p1 = Post.objects.create(author=self.owner, text="one")
        self.p2 = Post.objects.create(author=self.owner, text="two")

    def _get_posts(self, viewer):
        self.client.force_authenticate(viewer)
        return self.client.get(f"/api/users/{self.owner.pk}/posts/")

    def test_owner_sees_their_own_posts_newest_first(self):
        resp = self._get_posts(self.owner)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = [p["id"] for p in resp.data["results"]]
        self.assertEqual(ids, [self.p2.id, self.p1.id])

    def test_accepted_follower_sees_posts(self):
        follower = make_user("follower@example.com")
        Follow.objects.create(
            follower=follower, followee=self.owner, status=ACCEPTED
        )
        resp = self._get_posts(follower)
        self.assertEqual(len(resp.data["results"]), 2)

    def test_non_follower_and_pending_follower_see_nothing(self):
        stranger = make_user("stranger@example.com")
        pending = make_user("pending@example.com")
        Follow.objects.create(
            follower=pending, followee=self.owner, status=PENDING
        )
        self.assertEqual(len(self._get_posts(stranger).data["results"]), 0)
        self.assertEqual(len(self._get_posts(pending).data["results"]), 0)
