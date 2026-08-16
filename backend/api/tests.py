import importlib.util
import json
import os
import shutil
import signal
import tempfile
from datetime import UTC, time, timedelta
from io import BytesIO, StringIO
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Q
from django.db.utils import OperationalError
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.test import APITestCase

from api import imaging, notifications
from api.emoji import (
    MAX_REACTIONS_PER_USER_PER_TARGET,
    InvalidEmoji,
    normalise_emoji,
)
from api.imaging import MAX_PHOTOS_PER_EVENT, MAX_PHOTOS_PER_UPLOAD
from api.serializers import (
    CONVERSATION_TITLE_MAX_LENGTH,
    MESSAGE_ATTACHMENT_MAX_BYTES,
    MESSAGE_ATTACHMENTS_MAX,
    MESSAGE_MAX_LENGTH,
    MESSAGE_THUMBNAIL_MAX_BYTES,
    PARENT_UNAVAILABLE,
    NotificationSerializer,
)
from api.views import (
    BODY_IDS_MAX,
    EVENT_PHOTO_PREVIEW_COUNT,
    MESSAGE_EDIT_WINDOW,
    MESSAGE_IDS_MAX,
    _int_id,
    activate,
    active_participant_ids,
    badge_count_for,
    deactivate,
    must_connect_with,
    promote_participants,
    visible_messages_for,
)

from .models import (
    Block,
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    DevicePushToken,
    Event,
    EventPhoto,
    EventRSVP,
    Group,
    GroupMembership,
    Message,
    MessageAttachment,
    MessageMention,
    Notification,
    NotificationPreference,
    Participant,
    ParticipantInterval,
    Poll,
    PollOption,
    PollVote,
    Post,
    PostCommentRead,
    PostImage,
    PushOutbox,
    PushReceipt,
    Reaction,
    Report,
)

User = get_user_model()

FEED_URL = "/api/feed/"
POSTS_URL = "/api/posts/"
USERS_URL = "/api/users/"
REQUESTS_URL = "/api/connection-requests/"
CONVERSATIONS_URL = "/api/conversations/"
UNREAD_COUNT_URL = "/api/messages/unread-count/"
MEDIA_AUTH_URL = "/api/media-auth/"
PASSWORD = "correct-horse-42-battery"

ACCEPTED = Connection.Status.ACCEPTED
PENDING = Connection.Status.PENDING


def make_user(email, **kwargs):
    # Active by default so the account can log in / be connected in tests;
    # a test can still pass is_active=False to make a pending account.
    kwargs.setdefault("is_active", True)
    return User.objects.create_user(email=email, password=PASSWORD, **kwargs)


def connect_url(user):
    return f"/api/users/{user.pk}/connect/"


def make_connection(requester, requestee, status=ACCEPTED):
    return Connection.objects.create(
        requester=requester, requestee=requestee, status=status
    )


def comments_url(post):
    return f"/api/posts/{post.pk}/comments/"


def block_url(user):
    return f"/api/users/{user.pk}/block/"


def messages_url(convo):
    return f"/api/conversations/{convo.pk}/messages/"


def read_url(convo):
    return f"/api/conversations/{convo.pk}/read/"


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

    # A real secret key, so these email-guard tests get *past* the key guard
    # above and reach the email-backend selection.
    _PROD_ENV = {"DJANGO_DEBUG": "false", "DJANGO_SECRET_KEY": "k" * 50}

    def test_missing_email_host_with_debug_off_refuses_to_boot(self):
        # Production with no EMAIL_HOST and no explicit opt-in must fail loudly,
        # so a misconfigured deploy can't silently log password-reset tokens to
        # the container logs in plaintext (the console backend prints them).
        with mock.patch.dict(os.environ, self._PROD_ENV, clear=True):
            with self.assertRaisesRegex(ImproperlyConfigured, "EMAIL_HOST"):
                load_settings_isolated()

    def test_console_fallback_can_be_opted_into_for_a_lan_test(self):
        # A deliberate LAN test (DEBUG off, no provider yet) opts back in.
        env = {**self._PROD_ENV, "EMAIL_CONSOLE_FALLBACK": "true"}
        with mock.patch.dict(os.environ, env, clear=True):
            module = load_settings_isolated()
        self.assertEqual(
            module.EMAIL_BACKEND, "django.core.mail.backends.console.EmailBackend"
        )

    def test_email_host_selects_smtp_with_debug_off(self):
        env = {**self._PROD_ENV, "EMAIL_HOST": "smtp.resend.com"}
        with mock.patch.dict(os.environ, env, clear=True):
            module = load_settings_isolated()
        self.assertEqual(
            module.EMAIL_BACKEND, "django.core.mail.backends.smtp.EmailBackend"
        )


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
    """The core promise: you see your own posts + those of people you're
    connected with, and nobody else's — and a connection is mutual."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")

        self.my_post = Post.objects.create(author=self.me, text="mine")
        self.friend_post = Post.objects.create(author=self.friend, text="friend")
        self.stranger_post = Post.objects.create(
            author=self.stranger, text="stranger"
        )

        # A single accepted connection, requested by me. It is symmetric.
        make_connection(self.me, self.friend, ACCEPTED)
        self.client.force_authenticate(self.me)

    def test_feed_includes_self_and_connections_but_not_strangers(self):
        resp = self.client.get(FEED_URL)

        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(self.my_post.id, ids)
        self.assertIn(self.friend_post.id, ids)
        self.assertNotIn(self.stranger_post.id, ids)

    def test_connection_is_bidirectional(self):
        # The friend didn't request anyone, yet because the connection is
        # symmetric they see *my* posts too — the whole point of issue #11.
        self.client.force_authenticate(self.friend)
        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(self.my_post.id, ids)
        self.assertIn(self.friend_post.id, ids)

    def test_disconnecting_removes_their_posts_from_both_feeds(self):
        self.client.delete(connect_url(self.friend))

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.friend_post.id, ids)
        self.assertIn(self.my_post.id, ids)  # own posts stay

        # And the other direction is gone too.
        self.client.force_authenticate(self.friend)
        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.my_post.id, ids)

    def test_deactivated_author_drops_out_of_the_feed(self):
        # Deactivating a member (the maintainer's ban lever) must pull their
        # posts from connections' feeds too — not just hide their profile.
        self.friend.is_active = False
        self.friend.save(update_fields=["is_active"])

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.friend_post.id, ids)
        self.assertIn(self.my_post.id, ids)  # own posts stay


class ConnectRequestTests(APITestCase):
    """Connections are private: POST creates a pending request, and neither side
    sees the other until it's approved."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.other = make_user("other@example.com")
        self.other_post = Post.objects.create(author=self.other, text="hi")
        self.client.force_authenticate(self.me)

    def test_connect_creates_a_pending_request_not_an_accepted_connection(self):
        resp = self.client.post(connect_url(self.other))

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["connection_status"], "requested")
        conn = Connection.objects.get(requester=self.me, requestee=self.other)
        self.assertEqual(conn.status, PENDING)

    def test_pending_request_does_not_yet_show_their_posts(self):
        self.client.post(connect_url(self.other))

        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertNotIn(self.other_post.id, ids)

    def test_requesting_twice_is_a_noop(self):
        self.client.post(connect_url(self.other))
        resp = self.client.post(connect_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["connection_status"], "requested")
        self.assertEqual(
            Connection.objects.filter(
                requester=self.me, requestee=self.other
            ).count(),
            1,
        )

    def test_requesting_someone_who_requested_you_auto_accepts(self):
        # They asked first (pending). When I then hit Connect, the mutual intent
        # is clear — it accepts the existing request rather than making a rival
        # row (which the one-row-per-pair constraint would reject anyway).
        make_connection(self.other, self.me, PENDING)

        resp = self.client.post(connect_url(self.other))

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["connection_status"], "connected")
        self.assertEqual(Connection.objects.count(), 1)
        conn = Connection.objects.get()
        self.assertEqual(conn.status, ACCEPTED)
        # And now I can see their posts.
        feed = self.client.get(FEED_URL)
        ids = {p["id"] for p in feed.data["results"]}
        self.assertIn(self.other_post.id, ids)

    def test_cannot_connect_with_yourself(self):
        resp = self.client.post(connect_url(self.me))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Connection.objects.count(), 0)

    def test_deleting_cancels_a_pending_request(self):
        self.client.post(connect_url(self.other))
        resp = self.client.delete(connect_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(
            Connection.objects.filter(
                requester=self.me, requestee=self.other
            ).exists()
        )

    def test_disconnect_removes_an_accepted_connection_from_either_side(self):
        # Row was requested by the *other* person; I can still disconnect it.
        make_connection(self.other, self.me, ACCEPTED)
        resp = self.client.delete(connect_url(self.other))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(Connection.objects.count(), 0)

    def test_connecting_with_unknown_user_is_404(self):
        resp = self.client.post("/api/users/999999/connect/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class ApproveRejectTests(APITestCase):
    """The requestee approves or rejects an incoming request; approving connects
    both directions."""

    def setUp(self):
        self.owner = make_user("owner@example.com")
        self.requester = make_user("requester@example.com")
        self.owner_post = Post.objects.create(author=self.owner, text="private")
        self.requester_post = Post.objects.create(
            author=self.requester, text="theirs"
        )
        # requester asks to connect with owner.
        self.req = make_connection(self.requester, self.owner, PENDING)

    def _approve(self, pk):
        return self.client.post(f"{REQUESTS_URL}{pk}/approve/")

    def _reject(self, pk):
        return self.client.post(f"{REQUESTS_URL}{pk}/reject/")

    def test_incoming_requests_list_shows_only_your_pending_requests(self):
        # A request addressed to someone else must not appear in owner's inbox.
        third = make_user("third@example.com")
        make_connection(third, self.requester, PENDING)
        self.client.force_authenticate(self.owner)

        resp = self.client.get(REQUESTS_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rows = resp.data["results"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], self.req.id)
        self.assertEqual(rows[0]["requester"]["id"], self.requester.id)

    def test_approve_connects_both_directions(self):
        self.client.force_authenticate(self.owner)
        resp = self._approve(self.req.id)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.req.refresh_from_db()
        self.assertEqual(self.req.status, ACCEPTED)

        # The requester can now see the owner's posts...
        self.client.force_authenticate(self.requester)
        feed = self.client.get(FEED_URL)
        self.assertIn(
            self.owner_post.id, {p["id"] for p in feed.data["results"]}
        )
        # ...and the owner can see the requester's, without any second request.
        self.client.force_authenticate(self.owner)
        feed = self.client.get(FEED_URL)
        self.assertIn(
            self.requester_post.id, {p["id"] for p in feed.data["results"]}
        )

    def test_reject_deletes_the_request(self):
        self.client.force_authenticate(self.owner)
        resp = self._reject(self.req.id)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(Connection.objects.filter(pk=self.req.id).exists())

    def test_cannot_act_on_a_request_that_isnt_yours(self):
        # The requester (not the requestee) can't approve their own request.
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

    def test_list_excludes_self_and_reports_connection_status(self):
        make_connection(self.me, self.other, ACCEPTED)

        resp = self.client.get(USERS_URL)

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        rows = resp.data["results"]
        ids = {r["id"] for r in rows}
        self.assertNotIn(self.me.pk, ids)  # never list yourself
        other_row = next(r for r in rows if r["id"] == self.other.pk)
        self.assertEqual(other_row["connection_status"], "connected")
        # No email is exposed to other members.
        self.assertNotIn("email", other_row)

    def test_connection_status_reflects_all_four_states(self):
        none_user = make_user("stranger@example.com")
        requested_user = make_user("requested-target@example.com")
        incoming_user = make_user("asked-me@example.com")
        connected_user = make_user("friend@example.com")
        # I requested this one (outgoing).
        make_connection(self.me, requested_user, PENDING)
        # This one requested me (incoming).
        make_connection(incoming_user, self.me, PENDING)
        # And this one is mutual.
        make_connection(self.me, connected_user, ACCEPTED)

        resp = self.client.get(USERS_URL)
        by_id = {r["id"]: r["connection_status"] for r in resp.data["results"]}

        self.assertEqual(by_id[none_user.id], "none")
        self.assertEqual(by_id[requested_user.id], "requested")
        self.assertEqual(by_id[incoming_user.id], "incoming")
        self.assertEqual(by_id[connected_user.id], "connected")

    def test_inactive_users_are_hidden(self):
        make_user("pending@example.com", is_active=False)
        resp = self.client.get(USERS_URL)
        visible = {r["id"] for r in resp.data["results"]}
        self.assertEqual(visible, {self.other.pk})

    def test_filter_connected_returns_only_accepted_connections(self):
        # A mix of relationships: only the accepted one should come back.
        connected = make_user("friend@example.com")
        make_connection(self.me, connected, ACCEPTED)
        pending = make_user("asked@example.com")
        make_connection(self.me, pending, PENDING)
        make_user("stranger@example.com")  # no relationship at all

        resp = self.client.get(USERS_URL, {"filter": "connected"})

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {r["id"] for r in resp.data["results"]}
        self.assertEqual(ids, {connected.pk})
        # `self.other` (from setUp) has no connection, so it's excluded too.
        self.assertNotIn(self.other.pk, ids)

    def test_filter_discover_excludes_existing_connections(self):
        # Discover is for finding *new* people, so accepted connections drop off
        # — but pending/incoming requests stay, to act on there.
        connected = make_user("friend@example.com")
        make_connection(self.me, connected, ACCEPTED)
        pending = make_user("asked@example.com")
        make_connection(self.me, pending, PENDING)

        resp = self.client.get(USERS_URL, {"filter": "discover"})

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = {r["id"] for r in resp.data["results"]}
        self.assertNotIn(connected.pk, ids)  # already connected → hidden
        self.assertIn(pending.pk, ids)  # request in flight → still shown
        self.assertIn(self.other.pk, ids)  # a stranger → shown


class ProfileGatingTests(APITestCase):
    """Profile posts are private-by-default: only you and your connections can
    read them."""

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

    def test_connection_sees_posts(self):
        friend = make_user("friend@example.com")
        make_connection(friend, self.owner, ACCEPTED)
        resp = self._get_posts(friend)
        self.assertEqual(len(resp.data["results"]), 2)

    def test_stranger_and_pending_requester_see_nothing(self):
        stranger = make_user("stranger@example.com")
        pending = make_user("pending@example.com")
        make_connection(pending, self.owner, PENDING)
        self.assertEqual(len(self._get_posts(stranger).data["results"]), 0)
        self.assertEqual(len(self._get_posts(pending).data["results"]), 0)


class CommentTests(APITestCase):
    """Threaded comments, gated on the same connection boundary as the feed:
    you only see comments/replies from people you're connected with, and a
    hidden comment takes its whole subtree with it (issue #12)."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, ACCEPTED)

        # A post I can see (I wrote it). Comments below are created directly so
        # we can include a stranger's comment (which the API wouldn't let a
        # stranger post on my post) to exercise read-side pruning.
        self.post = Post.objects.create(author=self.me, text="a post")
        self.client.force_authenticate(self.me)

    def _tree(self):
        resp = self.client.get(comments_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        return resp.data

    def test_can_comment_on_a_visible_post(self):
        resp = self.client.post(
            comments_url(self.post), {"text": "hello"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        comment = Comment.objects.get()
        self.assertEqual(comment.author, self.me)
        self.assertEqual(comment.post, self.post)
        self.assertIsNone(comment.parent_id)

    def test_cannot_comment_on_a_post_you_cannot_see(self):
        # stranger isn't connected with me, so they can't even see my post.
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(
            comments_url(self.post), {"text": "sneaky"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Comment.objects.count(), 0)

    def test_reply_parent_must_belong_to_the_same_post(self):
        other_post = Post.objects.create(author=self.me, text="other")
        elsewhere = Comment.objects.create(
            post=other_post, author=self.me, text="elsewhere"
        )
        resp = self.client.post(
            comments_url(self.post),
            {"text": "reply", "parent": elsewhere.id},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_tree_shows_only_connected_or_self_authors(self):
        mine = Comment.objects.create(
            post=self.post, author=self.me, text="mine"
        )
        friends = Comment.objects.create(
            post=self.post, author=self.friend, text="friend's"
        )
        Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger's"
        )

        tree = self._tree()
        top_ids = {c["id"] for c in tree}
        self.assertEqual(top_ids, {mine.id, friends.id})

    def test_hidden_comment_hides_its_whole_subtree(self):
        # A stranger's top-level comment...
        stranger_c = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        # ...with a reply from my *friend* beneath it. Even though I'm connected
        # with the friend, the reply is hidden because its parent is hidden —
        # the whole branch is pruned (issue #12).
        Comment.objects.create(
            post=self.post,
            author=self.friend,
            parent=stranger_c,
            text="friend reply under stranger",
        )
        # And a visible top-level comment with a visible reply, as a control.
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="friend top"
        )
        my_reply = Comment.objects.create(
            post=self.post, author=self.me, parent=top, text="my reply"
        )

        tree = self._tree()

        # Only the friend's visible top-level comment survives.
        self.assertEqual([c["id"] for c in tree], [top.id])
        # Its visible reply is present...
        self.assertEqual([r["id"] for r in tree[0]["replies"]], [my_reply.id])
        # ...and the stranger's branch (and the friend-reply under it) is gone.
        all_ids = _flatten_ids(tree)
        self.assertNotIn(stranger_c.id, all_ids)

    def test_deactivated_author_comment_and_its_subtree_are_hidden(self):
        # Banning a member must pull their comments too, not just their posts —
        # and, like any hidden comment, take the whole branch under it.
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="friend top"
        )
        my_reply = Comment.objects.create(
            post=self.post, author=self.me, parent=top, text="my reply"
        )
        self.friend.is_active = False
        self.friend.save(update_fields=["is_active"])

        ids = _flatten_ids(self._tree())
        self.assertNotIn(top.id, ids)  # the banned author's comment is gone
        self.assertNotIn(my_reply.id, ids)  # and my reply beneath it goes too

    def test_replies_are_nested_under_their_parent(self):
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="top"
        )
        reply = Comment.objects.create(
            post=self.post, author=self.me, parent=top, text="reply"
        )

        tree = self._tree()
        self.assertEqual(len(tree), 1)
        self.assertEqual(tree[0]["id"], top.id)
        self.assertEqual(len(tree[0]["replies"]), 1)
        self.assertEqual(tree[0]["replies"][0]["id"], reply.id)


def _flatten_ids(tree):
    ids = set()
    for node in tree:
        ids.add(node["id"])
        ids |= _flatten_ids(node.get("replies", []))
    return ids


class ReplyVisibilityTests(APITestCase):
    """The **write** side of the connection boundary (issue #211).

    Reading was pruned from the start; replying wasn't, so a ``parent`` id you
    could never have seen was still accepted — putting your reply in front of
    someone invisible to you, in a conversation you were never part of. A reply
    is now allowed only where your own pruned tree would have shown you the
    parent, which is a *subtree* rule: a connected friend's reply sitting under
    a stranger is as unreachable as the stranger's own comment.
    """

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.pal = make_user("pal@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, ACCEPTED)
        make_connection(self.me, self.pal, ACCEPTED)

        # My own post, so it stays visible to me however the thread's authors
        # are later pruned or deactivated. Comments are created directly (as in
        # CommentTests) so a stranger can be in the thread at all.
        self.post = Post.objects.create(author=self.me, text="a post")
        self.client.force_authenticate(self.me)

    def _reply_to(self, parent_id, text="reply"):
        return self.client.post(
            comments_url(self.post),
            {"text": text, "parent": parent_id},
            format="json",
        )

    def _visible_ids(self):
        resp = self.client.get(comments_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        return _flatten_ids(resp.data)

    def test_can_reply_to_a_comment_you_can_see(self):
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="friend top"
        )
        nested = Comment.objects.create(
            post=self.post, author=self.pal, parent=top, text="pal reply"
        )

        # Both depths work — the gate is "visible", not "top-level".
        for parent in (top, nested):
            resp = self._reply_to(parent.id)
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            self.assertEqual(
                Comment.objects.get(pk=resp.data["id"]).parent_id, parent.id
            )

    def test_cannot_reply_to_a_not_connected_authors_comment(self):
        hidden = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        self.assertNotIn(hidden.id, self._visible_ids())

        resp = self._reply_to(hidden.id)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Comment.objects.filter(parent=hidden).exists())

    def test_cannot_reply_under_a_hidden_parent_even_to_a_connected_author(self):
        # The case a per-comment author check misses: the reply's *own* author
        # is someone I'm connected with, so only walking the chain above it
        # shows that the whole branch is pruned out of my tree.
        stranger_top = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        friend_reply = Comment.objects.create(
            post=self.post,
            author=self.friend,
            parent=stranger_top,
            text="friend reply under stranger",
        )
        self.assertNotIn(friend_reply.id, self._visible_ids())

        resp = self._reply_to(friend_reply.id)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Comment.objects.filter(parent=friend_reply).exists())

    def test_cannot_reply_under_a_deactivated_authors_comment(self):
        # A ban pulls the author's comments *and* the branch beneath them, so
        # the reply left dangling underneath is unreachable too.
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="friend top"
        )
        pal_reply = Comment.objects.create(
            post=self.post, author=self.pal, parent=top, text="pal reply"
        )
        self.friend.is_active = False
        self.friend.save(update_fields=["is_active"])
        self.assertNotIn(pal_reply.id, self._visible_ids())

        resp = self._reply_to(pal_reply.id)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Comment.objects.filter(parent=pal_reply).exists())

    def test_unknown_wrong_post_and_hidden_parents_are_indistinguishable(self):
        # Three different rejections would let an outsider probe which comment
        # ids exist, and confirm the existence of the very comment being hidden.
        hidden = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        other_post = Post.objects.create(author=self.me, text="other")
        elsewhere = Comment.objects.create(
            post=other_post, author=self.me, text="elsewhere"
        )
        unknown = Comment.objects.order_by("-id").first().id + 1000

        bodies = []
        for parent_id in (hidden.id, elsewhere.id, unknown):
            resp = self._reply_to(parent_id)
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
            # Compared unnormalised: the *shape* has to match as well as the
            # wording, or a bare string against a list tells them apart anyway.
            bodies.append([str(m) for m in resp.data["parent"]])

        self.assertEqual(bodies[0], [PARENT_UNAVAILABLE])
        self.assertEqual(bodies[1], bodies[0])
        self.assertEqual(bodies[2], bodies[0])

    def test_an_emptied_tombstone_answers_like_any_invisible_parent(self):
        # A soft delete leaves a tombstone; hard-deleting its last reply out
        # from under it leaves one holding nothing up, which the tree builder
        # drops. Saying "that was deleted" then confirms a comment stood at an
        # id my own thread no longer shows me.
        top = Comment.objects.create(
            post=self.post, author=self.friend, text="friend top"
        )
        reply = Comment.objects.create(
            post=self.post, author=self.pal, parent=top, text="pal reply"
        )
        top.text = ""
        top.deleted_at = timezone.now()
        top.save(update_fields=["text", "deleted_at"])
        # While the reply holds it up, the tombstone renders and says so.
        self.assertIn(top.id, self._visible_ids())
        resp = self._reply_to(top.id)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotEqual([str(m) for m in resp.data["parent"]], [PARENT_UNAVAILABLE])

        reply.delete()

        # Now it holds nothing up, so it's gone from the tree — and the reply
        # path has to agree, in wording *and* shape.
        self.assertNotIn(top.id, self._visible_ids())
        resp = self._reply_to(top.id)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual([str(m) for m in resp.data["parent"]], [PARENT_UNAVAILABLE])

    def test_cannot_report_a_comment_hidden_by_its_parent(self):
        # The doc claims the shared helper closed reports along with replies;
        # this pins it. The existing report test only covers a stranger's own
        # comment, which the per-comment check already caught.
        stranger_top = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        friend_reply = Comment.objects.create(
            post=self.post,
            author=self.friend,
            parent=stranger_top,
            text="friend reply under stranger",
        )

        resp = self.client.post(
            REPORTS_URL,
            {"comment": friend_reply.pk, "reason": "spam"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Report.objects.exists())

    def test_cannot_react_to_a_comment_hidden_by_its_parent(self):
        # can_view_comment gates comment reactions and reports too, so the same
        # subtree rule now closes those alongside the reply path.
        stranger_top = Comment.objects.create(
            post=self.post, author=self.stranger, text="stranger top"
        )
        friend_reply = Comment.objects.create(
            post=self.post,
            author=self.friend,
            parent=stranger_top,
            text="friend reply under stranger",
        )

        resp = self.client.post(
            react_comment_url(friend_reply), {"emoji": "👍"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Reaction.objects.exists())

    def test_visibility_check_does_not_scale_with_nesting_depth(self):
        # The chain walk loads the post's comments once and climbs in Python;
        # a per-ancestor query would make a deep thread quietly expensive. Both
        # parents share an author so the notification work is identical and the
        # only variable left is the depth.
        chain = []
        parent = None
        for i in range(12):
            parent = Comment.objects.create(
                post=self.post, author=self.friend, parent=parent, text=f"c{i}"
            )
            chain.append(parent)

        with CaptureQueriesContext(connection) as ctx:
            resp = self._reply_to(chain[1].id)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        shallow = len(ctx)

        with CaptureQueriesContext(connection) as ctx:
            resp = self._reply_to(chain[-1].id)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(len(ctx), shallow)


class CommentCountTests(APITestCase):
    """The total + new comment counts the feed carries next to "Comments"
    (issue #63). Counts must honour the same connection/active pruning as the
    thread itself, and "new" clears once the viewer opens the thread."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, ACCEPTED)
        # My own post — it's in my feed, and I'm connected with friend, so I see
        # my own + friend's comments but never the stranger's.
        self.post = Post.objects.create(author=self.me, text="a post")
        self.client.force_authenticate(self.me)

    def _feed_row(self, post=None):
        """The feed payload row for a post — proving the counts ride the feed
        with no extra per-post request."""
        post = post or self.post
        resp = self.client.get(FEED_URL)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        for row in resp.data["results"]:
            if row["id"] == post.id:
                return row
        self.fail("post not found in feed")

    def _comment(self, author, text="c", parent=None):
        return Comment.objects.create(
            post=self.post, author=author, text=text, parent=parent
        )

    def test_total_count_prunes_to_visible_authors(self):
        # mine + friend's are visible; the stranger's is not.
        self._comment(self.me)
        self._comment(self.friend)
        self._comment(self.stranger)
        self.assertEqual(self._feed_row()["comment_count"], 2)

    def test_total_count_includes_replies(self):
        top = self._comment(self.friend, "top")
        self._comment(self.me, "reply", parent=top)
        # One top-level + one reply = 2 (replies count toward the total).
        self.assertEqual(self._feed_row()["comment_count"], 2)

    def test_hidden_subtree_excluded_from_total(self):
        # A stranger's comment with a friend's reply under it: the whole branch
        # is pruned, so neither counts — matching the pruned tree (issue #12).
        stranger_top = self._comment(self.stranger, "stranger")
        self._comment(self.friend, "reply under stranger", parent=stranger_top)
        self._comment(self.friend, "visible top")
        row = self._feed_row()
        self.assertEqual(row["comment_count"], 1)  # only the visible top-level

    def test_deactivated_author_excluded_from_total(self):
        self._comment(self.friend, "will vanish")
        self.friend.is_active = False
        self.friend.save(update_fields=["is_active"])
        self.assertEqual(self._feed_row()["comment_count"], 0)

    def test_new_count_before_opening_counts_others_comments(self):
        self._comment(self.friend)
        row = self._feed_row()
        self.assertEqual(row["comment_count"], 1)
        self.assertEqual(row["new_comment_count"], 1)  # never opened ⇒ all new

    def test_new_count_excludes_your_own_comments(self):
        # You've self-evidently seen your own comment, so it's never "new".
        self._comment(self.me)
        row = self._feed_row()
        self.assertEqual(row["comment_count"], 1)
        self.assertEqual(row["new_comment_count"], 0)

    def test_opening_the_thread_clears_the_new_count(self):
        self._comment(self.friend)
        self.assertEqual(self._feed_row()["new_comment_count"], 1)
        # Opening the thread (GET) stamps the last-seen marker...
        self.assertEqual(
            self.client.get(comments_url(self.post)).status_code,
            status.HTTP_200_OK,
        )
        self.assertTrue(
            PostCommentRead.objects.filter(post=self.post, user=self.me).exists()
        )
        # ...so the count clears, while the total stays.
        row = self._feed_row()
        self.assertEqual(row["new_comment_count"], 0)
        self.assertEqual(row["comment_count"], 1)

    def test_only_comments_after_last_seen_are_new(self):
        self._comment(self.friend, "before")
        # Mark seen now, then a fresh comment lands after the marker.
        self.client.get(comments_url(self.post))
        self._comment(self.friend, "after")
        row = self._feed_row()
        self.assertEqual(row["comment_count"], 2)
        self.assertEqual(row["new_comment_count"], 1)  # only the later one

    def test_permalink_carries_counts(self):
        self._comment(self.friend)
        resp = self.client.get(f"/api/posts/{self.post.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["comment_count"], 1)
        self.assertEqual(resp.data["new_comment_count"], 1)

    def test_mark_seen_survives_a_concurrent_insert_race(self):
        # A row already exists (a parallel open won the INSERT). If our
        # update_or_create loses the race and raises IntegrityError, the view
        # must fall back to a plain UPDATE — not 500.
        old = timezone.now() - timedelta(hours=1)
        PostCommentRead.objects.create(
            post=self.post, user=self.me, last_seen_at=old
        )
        with mock.patch(
            "api.views.PostCommentRead.objects.update_or_create",
            side_effect=IntegrityError("duplicate key"),
        ):
            resp = self.client.get(comments_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        row = PostCommentRead.objects.get(post=self.post, user=self.me)
        self.assertGreater(row.last_seen_at, old)  # the fallback UPDATE landed


# --- Phase 4: photos on posts -----------------------------------------------

# One temp media root for the whole photo suite; wiped in tearDownClass so
# uploaded test files never touch the real media folder or linger on disk.
_PHOTO_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-media-")


def make_image_upload(name="photo.jpg", fmt="JPEG", size=(120, 90),
                      color=(200, 60, 60), exif=None):
    """An in-memory uploaded image file for multipart post/avatar tests."""
    buffer = BytesIO()
    image = Image.new("RGB", size, color)
    save_kwargs = {}
    if exif is not None:
        save_kwargs["exif"] = exif
    image.save(buffer, fmt, **save_kwargs)
    buffer.seek(0)
    content_type = f"image/{ 'jpeg' if fmt == 'JPEG' else fmt.lower() }"
    return SimpleUploadedFile(name, buffer.read(), content_type=content_type)


def make_mpo_upload(name="phone.jpeg"):
    """A Multi-Picture Object (.jpeg) like a phone/camera produces — two frames,
    which Pillow reports as format "MPO" rather than "JPEG"."""
    buffer = BytesIO()
    primary = Image.new("RGB", (400, 300), (120, 90, 60))
    secondary = Image.new("RGB", (400, 300), (60, 90, 120))
    primary.save(buffer, "MPO", save_all=True, append_images=[secondary])
    buffer.seek(0)
    return SimpleUploadedFile(name, buffer.read(), content_type="image/jpeg")


def make_heic_upload(name="IMG_4686.heic", size=(400, 300), exif=None):
    """A HEIC photo, as a stock iPhone produces (issue #41).

    Built with the same pillow-heif that decodes it in production, so this test
    also proves the opener is actually registered — without
    ``register_heif_opener()`` this file can't even be *written*, let alone read.
    """
    buffer = BytesIO()
    save_kwargs = {"exif": exif} if exif is not None else {}
    Image.new("RGB", size, (30, 110, 90)).save(buffer, "HEIF", **save_kwargs)
    buffer.seek(0)
    return SimpleUploadedFile(name, buffer.read(), content_type="image/heic")


def make_large_photo_upload(name="big.jpg", edge=3000):
    """A large, high-detail JPEG like a real phone camera produces. Random pixel
    noise (not a flat colour) so it doesn't compress to nothing — the point is a
    genuinely heavy original that our downscale/re-encode step has to shrink."""
    buffer = BytesIO()
    noise = Image.frombytes("RGB", (edge, edge), os.urandom(edge * edge * 3))
    noise.save(buffer, "JPEG", quality=95)
    buffer.seek(0)
    return SimpleUploadedFile(name, buffer.read(), content_type="image/jpeg")


@override_settings(MEDIA_ROOT=_PHOTO_MEDIA_ROOT)
class PhotoPostTests(APITestCase):
    """Posts can carry photos, uploaded as multipart and processed server-side."""

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_PHOTO_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def setUp(self):
        self.user = make_user("shutterbug@example.com")
        self.client.force_authenticate(self.user)

    def test_create_post_with_several_photos(self):
        resp = self.client.post(
            POSTS_URL,
            {
                "text": "Beach day",
                "images": [make_image_upload("a.jpg"), make_image_upload("b.jpg")],
            },
            format="multipart",
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        post = Post.objects.get()
        self.assertEqual(post.images.count(), 2)
        # The response carries the images with absolute URLs + dimensions.
        self.assertEqual(len(resp.data["images"]), 2)
        first = resp.data["images"][0]
        self.assertTrue(first["image"].startswith("http"))
        self.assertTrue(first["thumbnail"].startswith("http"))
        self.assertEqual(first["width"], 120)
        self.assertEqual(first["height"], 90)
        # Both original and thumbnail files were actually written.
        image = post.images.first()
        self.assertTrue(image.image.storage.exists(image.image.name))
        self.assertTrue(image.thumbnail.storage.exists(image.thumbnail.name))

    def test_a_phone_mpo_jpeg_is_accepted(self):
        # Phones/cameras save "JPEGs" as Multi-Picture Objects (format "MPO").
        # These are normal photos and must not be rejected as an unsupported type.
        resp = self.client.post(
            POSTS_URL,
            {"text": "my dog", "images": [make_mpo_upload()]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Post.objects.get().images.count(), 1)

    def test_an_iphone_heic_is_accepted_and_stored_as_jpeg(self):
        # HEIC is the *default* iPhone photo format, so rejecting it turned real
        # photos away from the app's actual audience (issue #41). It must be
        # accepted — and, like every other upload, re-encoded: what we store is
        # an ordinary JPEG, not the HEIC bytes, so browsers that can't display
        # HEIC (most of them) still render it.
        resp = self.client.post(
            POSTS_URL,
            {"text": "from my phone", "images": [make_heic_upload()]},
            format="multipart",
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        image = Post.objects.get().images.get()
        self.assertTrue(image.image.name.endswith(".jpg"))
        self.assertTrue(image.thumbnail.name.endswith(".jpg"))
        # Dimensions come back, so the feed can reserve layout space as usual.
        self.assertEqual((image.width, image.height), (400, 300))
        # And the bytes really are a JPEG, not HEIC under a .jpg name.
        with image.image.open("rb") as fh:
            self.assertEqual(Image.open(fh).format, "JPEG")

    def test_heic_avatar_is_accepted(self):
        # Same reasoning as post photos: an iPhone user setting their profile
        # picture picks a HEIC from the camera roll (issue #41).
        processed = imaging.process_avatar(make_heic_upload("me.heic"))
        self.assertEqual(processed["ext"], ".jpg")

    def test_unsupported_format_error_names_the_format(self):
        # "Unsupported image type" alone doesn't tell someone which photo to
        # convert or to what — so the message names the format we detected and
        # the ones we take (issue #41). BMP is a real image Pillow decodes
        # happily, it's just not in the allow-list, which is exactly this path.
        buffer = BytesIO()
        Image.new("RGB", (40, 40), (5, 5, 5)).save(buffer, "BMP")
        buffer.seek(0)
        bmp = SimpleUploadedFile("old.bmp", buffer.read(), content_type="image/bmp")

        resp = self.client.post(
            POSTS_URL, {"text": "hi", "images": [bmp]}, format="multipart"
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        message = str(resp.data["images"])
        self.assertIn("BMP", message)
        self.assertIn("HEIC", message)
        self.assertIn("old.bmp", message)

    def test_photo_only_post_needs_no_text(self):
        resp = self.client.post(
            POSTS_URL,
            {"images": [make_image_upload()]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Post.objects.get().text, "")

    def test_post_with_no_text_and_no_photo_is_rejected(self):
        resp = self.client.post(POSTS_URL, {}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Post.objects.count(), 0)

    def test_a_non_image_file_is_rejected(self):
        bad = SimpleUploadedFile(
            "notreally.jpg", b"this is not an image", content_type="image/jpeg"
        )
        resp = self.client.post(
            POSTS_URL, {"text": "hi", "images": [bad]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        # Nothing is created when a file is bad — no orphaned text post.
        self.assertEqual(Post.objects.count(), 0)

    def test_an_svg_is_rejected(self):
        # SVGs can carry script → stored XSS, so they're not in the allow-list.
        svg = SimpleUploadedFile(
            "vector.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            content_type="image/svg+xml",
        )
        resp = self.client.post(
            POSTS_URL, {"text": "hi", "images": [svg]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Post.objects.count(), 0)

    def test_too_many_photos_is_rejected(self):
        images = [make_image_upload(f"{i}.jpg") for i in range(11)]
        resp = self.client.post(
            POSTS_URL, {"text": "lots", "images": images}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Post.objects.count(), 0)

    def test_full_batch_of_ten_photos_succeeds(self):
        # The intended flow: post a whole camera-roll batch at once (issue #40).
        images = [make_image_upload(f"{i}.jpg") for i in range(10)]
        resp = self.client.post(
            POSTS_URL, {"text": "holiday", "images": images}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Post.objects.get().images.count(), 10)

    def test_upload_cap_is_phone_realistic(self):
        # Regression guard for issue #40: the per-file cap is a DoS guard, not a
        # storage limit, so it must sit above real phone-photo sizes (12–25 MB)
        # or ordinary camera-roll uploads get wrongly rejected before compression.
        self.assertGreaterEqual(imaging.MAX_UPLOAD_BYTES, 25 * 1024 * 1024)

    def test_large_phone_photo_is_accepted_and_stored_compressed(self):
        # A heavy original passes the (raised) cap and is stored much smaller,
        # because process_image downscales + re-encodes it — the whole reason we
        # can afford a generous input cap.
        upload = make_large_photo_upload("camera.jpg")
        uploaded_bytes = upload.size
        resp = self.client.post(
            POSTS_URL, {"images": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        stored = Post.objects.get().images.first().image
        self.assertLess(stored.size, uploaded_bytes)

    def test_oversized_photo_error_names_the_offending_file(self):
        # In a batch, an opaque "too large" leaves the user guessing which photo
        # to drop, so the error must name the file that failed. Patch the cap low
        # so we don't have to build a real >30 MB upload just to trip it.
        with mock.patch.object(imaging, "MAX_UPLOAD_BYTES", 100):
            resp = self.client.post(
                POSTS_URL,
                {"text": "trip", "images": [make_image_upload("toobig.jpg")]},
                format="multipart",
            )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("toobig.jpg", str(resp.data["images"]))
        self.assertIn("too large", str(resp.data["images"]))
        self.assertEqual(Post.objects.count(), 0)

    def test_exif_metadata_is_stripped_from_stored_images(self):
        # GPS coordinates live in EXIF; a phone photo can leak a home address.
        # We embed an EXIF tag, upload, and assert the stored file has none.
        exif = Image.Exif()
        exif[0x0110] = "SecretCameraModel"  # the Model tag
        upload = make_image_upload("located.jpg", exif=exif)
        # Sanity: the upload really does carry EXIF before processing.
        self.assertTrue(len(Image.open(upload).getexif()) > 0)
        upload.seek(0)

        resp = self.client.post(
            POSTS_URL, {"images": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        stored = Post.objects.get().images.first()
        with Image.open(stored.image.path) as saved:
            self.assertEqual(len(saved.getexif()), 0)

    def test_exif_metadata_is_stripped_from_heic_too(self):
        # HEIC is a *separate decode path* (pillow-heif, issue #41), and iPhone
        # HEICs are exactly the photos most likely to carry GPS. Stripping is the
        # app's strongest privacy claim, so it gets its own test here rather than
        # being assumed to come along for free with the JPEG one.
        exif = Image.Exif()
        exif[0x0110] = "iPhone"  # the Model tag
        upload = make_heic_upload("located.heic", exif=exif)
        # Sanity: the upload really does carry EXIF before processing, or this
        # test would pass just as well against a no-op.
        self.assertTrue(len(Image.open(upload).getexif()) > 0)
        upload.seek(0)

        resp = self.client.post(
            POSTS_URL, {"images": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        stored = Post.objects.get().images.first()
        with Image.open(stored.image.path) as saved:
            self.assertEqual(len(saved.getexif()), 0)

    def test_jpeg_orientation_is_applied_before_stripping(self):
        # A JPEG records rotation as an EXIF flag and stores the sensor's pixels
        # un-rotated. Since we drop EXIF, the flag has to be baked into the pixels
        # first — otherwise a portrait photo is stored (and shown) on its side, for
        # good. Landscape in, portrait out proves the flag was honoured.
        exif = Image.Exif()
        exif[0x0112] = 6  # Orientation: rotate 90° CW
        upload = make_image_upload("sideways.jpg", size=(400, 300), exif=exif)

        resp = self.client.post(
            POSTS_URL, {"images": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        image = Post.objects.get().images.get()
        self.assertEqual((image.width, image.height), (300, 400))

    def test_heic_orientation_is_not_applied_twice(self):
        # The opposite hazard to the JPEG case, and the one that actually shipped
        # (issue #41). A real iPhone HEIC is decoded *upright* — pillow-heif/libheif
        # bake the camera's rotation into the pixels on open and reset the EXIF
        # orientation to 1 — yet pillow-heif still reports the original flag in
        # info["original_orientation"]. Re-applying that flag rotates the
        # already-upright pixels a second time, storing every portrait iPhone photo
        # sideways.
        #
        # The fixture mirrors that decoded state: an already-portrait image still
        # carrying a non-1 orientation. It must come out with its dimensions
        # unchanged — NOT rotated to (400, 300).
        #
        # (This is why the earlier test was misleading: it built a *landscape* HEIC
        # via pillow-heif's own encoder, which — unlike a real iPhone — leaves the
        # pixels un-rotated, so the buggy double-apply happened to look correct.)
        exif = Image.Exif()
        exif[0x0112] = 6  # a non-1 orientation still present in metadata
        upload = make_heic_upload("upright.heic", size=(300, 400), exif=exif)

        resp = self.client.post(
            POSTS_URL, {"images": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        image = Post.objects.get().images.get()
        self.assertEqual((image.width, image.height), (300, 400))

    def test_images_appear_in_the_feed(self):
        self.client.post(
            POSTS_URL,
            {"text": "with pic", "images": [make_image_upload()]},
            format="multipart",
        )
        feed = self.client.get(FEED_URL)
        self.assertEqual(feed.status_code, status.HTTP_200_OK)
        self.assertEqual(len(feed.data["results"][0]["images"]), 1)


# --- Phase 5: direct messaging -------------------------------------------------


class MessagingBase(APITestCase):
    """Two mutually-connected users, ``me`` and ``friend``, plus an unrelated
    ``stranger`` (not connected). ``me`` is authenticated by default."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, status=ACCEPTED)
        self.client.force_authenticate(self.me)

    def open_with(self, other):
        return self.client.post(
            CONVERSATIONS_URL, {"user_id": other.pk}, format="json"
        )


class ConversationStartTests(MessagingBase):
    def test_open_conversation_with_a_connection(self):
        resp = self.open_with(self.friend)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["other"]["id"], self.friend.pk)
        self.assertEqual(Conversation.objects.count(), 1)

    def test_open_is_idempotent_get_or_create(self):
        first = self.open_with(self.friend)
        second = self.open_with(self.friend)
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(Conversation.objects.count(), 1)

    def test_reopening_from_the_other_side_finds_the_same_thread(self):
        first = self.open_with(self.friend)
        self.client.force_authenticate(self.friend)
        second = self.client.post(
            CONVERSATIONS_URL, {"user_id": self.me.pk}, format="json"
        )
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(Conversation.objects.count(), 1)

    def test_cannot_open_with_a_non_connection(self):
        resp = self.open_with(self.stranger)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Conversation.objects.count(), 0)

    def test_cannot_open_with_yourself(self):
        resp = self.open_with(self.me)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_open_with_unknown_user(self):
        resp = self.client.post(
            CONVERSATIONS_URL, {"user_id": 999999}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_reopening_a_participant_less_thread_preserves_history(self):
        """Finding 1 regression: a 1:1 that predates Participant rows (built
        directly off the model, as ``MessageSendTests`` etc. still do — mimics
        a pre-Task-5 thread) must not have its history clipped when it's
        re-opened through the API (the profile "Message" button re-POSTs to
        ``/api/conversations/``). ``_ensure_direct_participants`` must open
        each participant's interval at ``convo.created_at``, not "now", or
        every message sent before the re-open silently vanishes from both
        sides' view."""
        convo = Conversation.objects.create(user_a=self.me, user_b=self.friend)
        old_message = Message.objects.create(
            conversation=convo, sender=self.friend, text="hello from before"
        )

        resp = self.open_with(self.friend)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["id"], convo.id)

        for user in (self.me, self.friend):
            self.client.force_authenticate(user)
            msgs = self.client.get(messages_url(convo))
            self.assertEqual(msgs.status_code, status.HTTP_200_OK)
            texts = [m["text"] for m in msgs.data["results"]]
            self.assertIn(old_message.text, texts)


class MessageSendTests(MessagingBase):
    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )

    def test_send_and_read_thread_oldest_first(self):
        self.client.post(messages_url(self.convo), {"text": "first"})
        self.client.post(messages_url(self.convo), {"text": "second"})
        resp = self.client.get(messages_url(self.convo))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        texts = [m["text"] for m in resp.data["results"]]
        self.assertEqual(texts, ["first", "second"])
        self.assertEqual(resp.data["results"][0]["sender"]["id"], self.me.pk)

    def test_sender_is_the_session_user_not_the_body(self):
        # An attempt to spoof the sender via the body is ignored.
        self.client.post(
            messages_url(self.convo),
            {"text": "hi", "sender": self.friend.pk},
        )
        self.assertEqual(Message.objects.get().sender, self.me)

    def test_sending_bumps_conversation_activity(self):
        before = Conversation.objects.get(pk=self.convo.pk).updated_at
        self.client.post(messages_url(self.convo), {"text": "ping"})
        after = Conversation.objects.get(pk=self.convo.pk).updated_at
        self.assertGreater(after, before)

    def test_empty_message_rejected(self):
        resp = self.client.post(messages_url(self.convo), {"text": "   "})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_participant_cannot_read_or_send(self):
        self.client.force_authenticate(self.stranger)
        self.assertEqual(
            self.client.get(messages_url(self.convo)).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.post(
                messages_url(self.convo), {"text": "intrude"}
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_history_visible_after_disconnect_but_no_new_messages(self):
        self.client.post(messages_url(self.convo), {"text": "hello"})
        # Disconnect: history stays readable, but sending is now barred.
        self.client.delete(connect_url(self.friend))
        self.assertEqual(
            self.client.get(messages_url(self.convo)).status_code,
            status.HTTP_200_OK,
        )
        resp = self.client.post(messages_url(self.convo), {"text": "again"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_disconnect_does_not_lock_you_out_of_an_api_opened_1to1(self):
        """Regression: a 1:1 opened through the API has active ``Participant``
        rows (unlike the sibling test's model-built ``self.convo``). A disconnect
        must not sweep that direct thread into the group-chat sever machinery —
        doing so dropped the initiator to ``pending`` in their own DM, which
        made their history read 403 and rendered the group "connect to join"
        lock panel on a 1:1, regressing the Phase 5 guarantee that history stays
        readable after a disconnect."""
        opened = self.open_with(self.friend)
        convo = Conversation.objects.get(pk=opened.data["id"])
        self.client.post(messages_url(convo), {"text": "hello"})

        self.client.delete(connect_url(self.friend))

        # History still readable, and the message is still there.
        resp = self.client.get(messages_url(convo))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIn("hello", [m["text"] for m in resp.data["results"]])

        # The detail view stays "active" (not a pending group lock), but the
        # composer is closed.
        detail = self.client.get(f"{CONVERSATIONS_URL}{convo.pk}/")
        self.assertEqual(detail.data["my_status"], "active")
        self.assertFalse(detail.data["can_send"])

        # Sending is barred (disconnected), same as the legacy path.
        again = self.client.post(messages_url(convo), {"text": "again"})
        self.assertEqual(again.status_code, status.HTTP_403_FORBIDDEN)


class MessageDeleteTests(MessagingBase):
    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )
        self.mine = Message.objects.create(
            conversation=self.convo, sender=self.me, text="mine"
        )

    def _delete(self, message):
        return self.client.delete(
            f"/api/conversations/{self.convo.pk}/messages/{message.pk}/"
        )

    def test_sender_can_soft_delete_own_message(self):
        resp = self._delete(self.mine)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.mine.refresh_from_db()
        self.assertTrue(self.mine.is_deleted)
        self.assertEqual(self.mine.text, "")
        # The tombstone still shows in the thread, flagged deleted.
        thread = self.client.get(messages_url(self.convo))
        row = thread.data["results"][0]
        self.assertTrue(row["is_deleted"])
        self.assertEqual(row["text"], "")

    def test_cannot_delete_someone_elses_message(self):
        theirs = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="theirs"
        )
        resp = self._delete(theirs)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        theirs.refresh_from_db()
        self.assertFalse(theirs.is_deleted)


class MessageEditTests(MessagingBase):
    """Editing your own message (Phase 9b M1).

    The feature exists because a real beta tester had no way to fix a typo. The
    tests below are mostly about the *limits*, because those are what keep a
    thread a trustworthy shared record rather than something either side can
    quietly rewrite.
    """

    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )
        self.mine = Message.objects.create(
            conversation=self.convo, sender=self.me, text="teh quick fox"
        )

    def _edit(self, message, text, convo=None):
        return self.client.patch(
            f"/api/conversations/{(convo or self.convo).pk}/messages/{message.pk}/",
            {"text": text},
            format="json",
        )

    def test_sender_can_edit_own_message(self):
        resp = self._edit(self.mine, "the quick fox")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["text"], "the quick fox")
        self.assertTrue(resp.data["is_edited"])
        self.assertIsNotNone(resp.data["edited_at"])
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.text, "the quick fox")

    def test_unedited_message_reports_is_edited_false(self):
        # The marker must mean something: a message nobody touched never claims
        # to have been edited.
        thread = self.client.get(messages_url(self.convo))
        row = thread.data["results"][0]
        self.assertFalse(row["is_edited"])
        self.assertIsNone(row["edited_at"])

    def test_cannot_edit_someone_elses_message(self):
        theirs = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="theirs"
        )
        resp = self._edit(theirs, "words in their mouth")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        theirs.refresh_from_db()
        self.assertEqual(theirs.text, "theirs")

    def test_cannot_edit_a_deleted_message(self):
        self.client.delete(
            f"/api/conversations/{self.convo.pk}/messages/{self.mine.pk}/"
        )
        resp = self._edit(self.mine, "back from the dead")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.text, "")
        self.assertTrue(self.mine.is_deleted)

    def test_cannot_edit_after_the_window_closes(self):
        # Sent just over the window ago — the point of the window is that you
        # can't rewrite what someone read and replied to yesterday.
        Message.objects.filter(pk=self.mine.pk).update(
            created_at=timezone.now() - MESSAGE_EDIT_WINDOW - timedelta(seconds=1)
        )
        resp = self._edit(self.mine, "rewriting history")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.text, "teh quick fox")
        self.assertFalse(self.mine.is_edited)

    def test_edit_just_inside_the_window_is_allowed(self):
        Message.objects.filter(pk=self.mine.pk).update(
            created_at=timezone.now() - MESSAGE_EDIT_WINDOW + timedelta(seconds=30)
        )
        resp = self._edit(self.mine, "still in time")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_blank_and_oversized_edits_rejected(self):
        blank = self._edit(self.mine, "   ")
        self.assertEqual(blank.status_code, status.HTTP_400_BAD_REQUEST)
        oversized = self._edit(self.mine, "x" * (MESSAGE_MAX_LENGTH + 1))
        self.assertEqual(oversized.status_code, status.HTTP_400_BAD_REQUEST)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.text, "teh quick fox")

    def test_edit_does_not_bump_conversation_activity(self):
        """Fixing a typo must not jump the thread to the top of everyone's
        conversation list — an edit isn't new activity. This regresses quietly
        (any stray ``save()`` on the conversation would do it), so it's asserted
        rather than assumed."""
        before = Conversation.objects.get(pk=self.convo.pk).updated_at
        self.assertEqual(
            self._edit(self.mine, "fixed").status_code, status.HTTP_200_OK
        )
        after = Conversation.objects.get(pk=self.convo.pk).updated_at
        self.assertEqual(before, after)

    def test_list_preview_shows_the_edited_text(self):
        # The preview is a DISTINCT ON over the latest message, so it picks up
        # the new text with no bump needed — the pair of properties this and the
        # test above assert together.
        self._edit(self.mine, "corrected preview")
        listing = self.client.get(CONVERSATIONS_URL)
        self.assertEqual(
            listing.data["results"][0]["last_message"]["text"],
            "corrected preview",
        )

    def test_cannot_edit_in_a_thread_you_can_no_longer_send_to(self):
        """A disconnect closes the composer, so it must close the edit window
        too — otherwise the 15 minutes after a severed connection are a back door
        for putting fresh words into a thread you've lost access to."""
        self.client.delete(connect_url(self.friend))
        resp = self._edit(self.mine, "sneaking one in")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.text, "teh quick fox")

    def test_non_participant_gets_404_not_403(self):
        # Probing a message id from outside must reveal nothing about the
        # thread — the conversation gate answers first.
        self.client.force_authenticate(self.stranger)
        resp = self._edit(self.mine, "intrude")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_probe_a_message_from_inside_your_gap(self):
        """The interval-clipping case, mirroring
        ``test_cannot_report_a_message_from_inside_your_gap``.

        A member who was out of a group chat when a message was sent can't see
        it, so the edit route must not answer questions about it either. The
        403/404 split is the leak: without clipping the lookup, "not yours" (403)
        and "no such message" (404) tell a gap member exactly which ids landed in
        the thread while they were away. Text never leaks — but existence is
        still theirs to not know, and the report gate already holds this line.
        """
        a = make_user("ea@example.com")
        gapper = make_user("egapper@example.com")
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=a
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=2)
        p_a = Participant.objects.create(
            conversation=convo, user=a, status="active"
        )
        ParticipantInterval.objects.create(participant=p_a, started_at=t0)
        gap_p = Participant.objects.create(
            conversation=convo, user=gapper, status="active"
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=t0, ended_at=t1
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=timezone.now()
        )
        in_gap = Message.objects.create(
            conversation=convo, sender=a, text="said while they were out"
        )
        Message.objects.filter(pk=in_gap.pk).update(
            created_at=t1 + timedelta(minutes=10)
        )

        self.client.force_authenticate(gapper)
        resp = self.client.patch(
            f"/api/conversations/{convo.pk}/messages/{in_gap.pk}/",
            {"text": "rewriting what I never saw"},
            format="json",
        )
        # 404, not 403: indistinguishable from an id that doesn't exist.
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        in_gap.refresh_from_db()
        self.assertEqual(in_gap.text, "said while they were out")

        missing = self.client.patch(
            f"/api/conversations/{convo.pk}/messages/{in_gap.pk + 9999}/",
            {"text": "nope"},
            format="json",
        )
        self.assertEqual(missing.status_code, resp.status_code)

    def test_editing_sends_no_push(self):
        """Editing is not news. The push rules are unchanged by M1, and a
        correction buzzing everyone's phone again is exactly the behaviour that
        makes people turn notifications off."""
        PushOutbox.objects.all().delete()
        self._edit(self.mine, "fixed")
        self.assertFalse(PushOutbox.objects.exists())


# Its own media root, wiped after the class. Separate from ``_PHOTO_MEDIA_ROOT``
# on purpose: that one belongs to the post-photo suite, which processes uploads
# server-side, and these tests exist precisely to prove message photos *don't*
# take that path — sharing a directory would invite someone to share a helper.
_MESSAGE_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-msg-media-")


@override_settings(MEDIA_ROOT=_MESSAGE_MEDIA_ROOT)
class MessagePhotoTests(MessagingBase):
    """Photos in a chat (Phase 9b M7).

    🔒 **The thing under test is mostly what the server *doesn't* do.** A message
    attachment is resized, EXIF-stripped and re-encoded on the phone so that the
    same pipeline works when the server is handed ciphertext under E2E (phase
    9c), which means nothing here decodes the upload. The size cap, the count
    cap and the forced ``.jpg`` filename are therefore not incidental hardening —
    they are the whole of the server's defence, so each one gets a test that
    fails loudly if it's ever relaxed.
    """

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_MESSAGE_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )

    def _send(self, text="", photo=None, thumbnail=None, width=120, height=90,
              **extra):
        """Send a photo message the way the app does — multipart parallel lists."""
        body = {"text": text, **extra}
        if photo is not None:
            body["attachments"] = photo
            body["attachment_thumbnails"] = (
                thumbnail if thumbnail is not None else make_image_upload("t.jpg")
            )
            body["attachment_widths"] = width
            body["attachment_heights"] = height
        return self.client.post(messages_url(self.convo), body, format="multipart")

    def test_send_a_photo_with_no_caption(self):
        resp = self._send(photo=make_image_upload("holiday.jpg"), width=1200,
                          height=900)

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["text"], "")
        attachment = resp.data["attachments"][0]
        self.assertEqual(attachment["kind"], "image")
        self.assertEqual((attachment["width"], attachment["height"]), (1200, 900))
        self.assertTrue(attachment["url"])
        self.assertTrue(attachment["thumbnail"])
        self.assertEqual(MessageAttachment.objects.count(), 1)

    def test_send_a_photo_with_a_caption(self):
        resp = self._send(text="look at this", photo=make_image_upload())
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["text"], "look at this")
        self.assertEqual(len(resp.data["attachments"]), 1)

    def test_a_message_must_be_text_or_a_photo_but_not_neither(self):
        """The rule posts have enforced since Phase 4. Making ``text`` optional
        for photos is exactly the change that could let a blank message through
        if the cross-field check were ever dropped."""
        self.assertEqual(
            self._send(text="   ").status_code, status.HTTP_400_BAD_REQUEST
        )
        self.assertFalse(Message.objects.exists())

    def test_the_thread_and_the_gallery_both_carry_the_photo(self):
        self._send(photo=make_image_upload())
        self._send(text="just words")

        thread = self.client.get(messages_url(self.convo))
        rows = thread.data["results"]
        self.assertEqual(len(rows[0]["attachments"]), 1)
        self.assertEqual(rows[1]["attachments"], [])

        gallery = self.client.get(f"{messages_url(self.convo)}?media=1&order=desc")
        self.assertEqual(len(gallery.data["results"]), 1)
        self.assertEqual(len(gallery.data["results"][0]["attachments"]), 1)

    def test_the_gallery_is_interval_clipped_like_the_transcript(self):
        """🔒 The gallery is a filter on the same clipped queryset, not a second
        endpoint — this is the test that says so. A member with a gap in their
        membership must not be able to see through it by asking for photos."""
        convo = Conversation.objects.create(kind=Conversation.Kind.GROUP)
        third = make_user("third@example.com")
        make_connection(self.friend, third, status=ACCEPTED)
        make_connection(self.me, third, status=ACCEPTED)
        for user in (self.me, self.friend, third):
            participant = Participant.objects.create(
                conversation=convo, user=user, status=Participant.Status.ACTIVE
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=timezone.now()
            )
        # The friend's interval closes, so anything sent now is inside their gap.
        friend_participant = Participant.objects.get(
            conversation=convo, user=self.friend
        )
        friend_participant.intervals.update(ended_at=timezone.now())

        self.client.post(
            messages_url(convo),
            {
                "text": "",
                "attachments": make_image_upload(),
                "attachment_thumbnails": make_image_upload("t.jpg"),
                "attachment_widths": 100,
                "attachment_heights": 100,
            },
            format="multipart",
        )

        self.client.force_authenticate(self.friend)
        gallery = self.client.get(f"{messages_url(convo)}?media=1")
        self.assertEqual(gallery.data["results"], [])

    def test_a_photo_over_the_byte_cap_is_refused(self):
        """🔒 One of only two limits that still mean something on bytes we never
        open. It's per file, not per request total — see ``_check_sizes``."""
        oversized = SimpleUploadedFile(
            "huge.jpg",
            b"x" * (MESSAGE_ATTACHMENT_MAX_BYTES + 1),
            content_type="image/jpeg",
        )
        resp = self._send(photo=oversized)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Message.objects.exists())

    def test_a_thumbnail_over_its_own_much_smaller_cap_is_refused(self):
        """The thumbnail is capped separately and far lower, so a client can't
        sidestep the point of having one by sending the full image twice."""
        fat_thumb = SimpleUploadedFile(
            "t.jpg",
            b"x" * (MESSAGE_THUMBNAIL_MAX_BYTES + 1),
            content_type="image/jpeg",
        )
        resp = self._send(photo=make_image_upload(), thumbnail=fat_thumb)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        # And it says a size a person can act on. A cap under 1 MB formatted as
        # megabytes rounds to "under 0 MB", which is an error about nothing.
        self.assertIn("512 KB", str(resp.data))

    def test_more_attachments_than_the_count_cap_are_refused(self):
        """🔒 The other of the two limits. Without it, an unbounded count is the
        way around the byte cap."""
        extra = MESSAGE_ATTACHMENTS_MAX + 1
        resp = self.client.post(
            messages_url(self.convo),
            {
                "text": "",
                "attachments": [make_image_upload() for _ in range(extra)],
                "attachment_thumbnails": [
                    make_image_upload("t.jpg") for _ in range(extra)
                ],
                "attachment_widths": [100] * extra,
                "attachment_heights": [100] * extra,
            },
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(MessageAttachment.objects.exists())

    def test_parallel_lists_must_line_up(self):
        """A photo with no dimensions would be stored with a guessed aspect
        ratio. Refusing beats guessing."""
        resp = self.client.post(
            messages_url(self.convo),
            {
                "text": "",
                "attachments": make_image_upload(),
                "attachment_thumbnails": make_image_upload("t.jpg"),
                "attachment_widths": 100,
                # no height
            },
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_nonsense_dimensions_are_refused(self):
        """Client-declared, so bounded. They're layout hints and nothing
        security-sensitive keys off them — but a zero or a mile-high value makes
        an unrenderable bubble, and the client can't be the one to catch it."""
        self.assertEqual(
            self._send(photo=make_image_upload(), width=0).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self._send(photo=make_image_upload(), height=10_000_000).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_the_stored_file_keeps_a_jpg_name_whatever_was_uploaded(self):
        """🔒 The stored-XSS mitigation, and the one that most needs a test,
        because nothing about it is visible in normal use.

        The server no longer decodes an attachment, so it cannot know this isn't
        an image. Caddy serves ``/media/*`` off disk and picks the Content-Type
        from the *extension*, so a file kept as ``.html`` would be served as
        markup from our own origin. Forcing ``.jpg`` means a browser is always
        told "JPEG", whatever the bytes are.
        """
        markup = SimpleUploadedFile(
            "payload.html",
            b"<script>alert(document.cookie)</script>",
            content_type="text/html",
        )
        resp = self._send(photo=markup)

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        attachment = MessageAttachment.objects.get()
        self.assertTrue(attachment.file.name.endswith(".jpg"))
        self.assertNotIn(".html", attachment.file.name)

    def test_the_bytes_are_stored_exactly_as_sent(self):
        """The other half of "the server doesn't decode": what comes back is
        byte-identical to what went up. A future session tempted to route this
        through ``api.imaging`` for "safety" will fail here, and should read
        ``MessageAttachment`` before deciding the test is wrong — re-encoding
        server-side is what stops working under E2E.
        """
        upload = make_image_upload("original.jpg")
        original = upload.read()
        upload.seek(0)

        self._send(photo=upload)

        attachment = MessageAttachment.objects.get()
        with attachment.file.open("rb") as stored:
            self.assertEqual(stored.read(), original)

    def test_deleting_a_photo_message_really_deletes_the_photo(self):
        """🔒 Soft delete for the message, **hard** delete for the file.

        A media URL is fetchable by any signed-in member who holds it (media is
        gated at the door, not per-author), so a tombstone that left the file on
        disk would mean "delete" removed the caption and left the picture up.
        """
        resp = self._send(photo=make_image_upload())
        message_id = resp.data["id"]
        attachment = MessageAttachment.objects.get()
        path = Path(attachment.file.path)
        thumb_path = Path(attachment.thumbnail.path)
        self.assertTrue(path.exists())

        # The file sweep runs on commit (so a rolled-back delete can't destroy
        # files whose rows survive), so run the callbacks to observe it.
        with self.captureOnCommitCallbacks(execute=True):
            delete = self.client.delete(
                f"{messages_url(self.convo)}{message_id}/"
            )

        self.assertEqual(delete.status_code, status.HTTP_200_OK)
        self.assertFalse(MessageAttachment.objects.exists())
        self.assertFalse(path.exists())
        self.assertFalse(thumb_path.exists())
        # And the tombstone reports no attachments, so nothing can render one.
        thread = self.client.get(messages_url(self.convo))
        row = thread.data["results"][0]
        self.assertTrue(row["is_deleted"])
        self.assertEqual(row["attachments"], [])

    def test_a_photo_message_can_be_edited_down_to_no_caption(self):
        """A caption is optional on a photo, so removing one must be allowed —
        while a text message still can't be edited into nothing."""
        photo = self._send(text="wrng caption", photo=make_image_upload())
        text_only = self.client.post(messages_url(self.convo), {"text": "words"})

        cleared = self.client.patch(
            f"{messages_url(self.convo)}{photo.data['id']}/",
            {"text": ""},
            format="json",
        )
        self.assertEqual(cleared.status_code, status.HTTP_200_OK)
        self.assertEqual(cleared.data["text"], "")
        self.assertEqual(len(cleared.data["attachments"]), 1)

        emptied = self.client.patch(
            f"{messages_url(self.convo)}{text_only.data['id']}/",
            {"text": ""},
            format="json",
        )
        self.assertEqual(emptied.status_code, status.HTTP_400_BAD_REQUEST)

    def test_an_edit_that_omits_the_text_is_refused_not_treated_as_blank(self):
        """Making ``text`` optional for photos gave it a ``""`` default, and a
        default silently turns "the client forgot the field" into "make it
        empty". On a photo message that would wipe the caption on a PATCH that
        never mentioned it — so an edit has to *say* what the text now is."""
        photo = self._send(text="keep me", photo=make_image_upload())

        resp = self.client.patch(
            f"{messages_url(self.convo)}{photo.data['id']}/", {}, format="json"
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        photo_message = Message.objects.get(pk=photo.data["id"])
        self.assertEqual(photo_message.text, "keep me")
        # And nothing was stamped "Edited" for an edit that didn't happen.
        self.assertIsNone(photo_message.edited_at)

    def test_an_edit_cannot_swap_the_photo(self):
        """Attachments aren't editable. The "Edited" marker is what makes editing
        safe, and it can't honestly disclose that the *picture* changed under a
        message someone already looked at."""
        sent = self._send(text="mine", photo=make_image_upload("first.jpg"))
        before = MessageAttachment.objects.get().file.name

        self.client.patch(
            f"{messages_url(self.convo)}{sent.data['id']}/",
            {
                "text": "mine",
                "attachments": make_image_upload("second.jpg"),
                "attachment_thumbnails": make_image_upload("t.jpg"),
                "attachment_widths": 10,
                "attachment_heights": 10,
            },
            format="multipart",
        )

        self.assertEqual(MessageAttachment.objects.count(), 1)
        self.assertEqual(MessageAttachment.objects.get().file.name, before)

    def test_the_conversation_list_preview_counts_the_photo(self):
        """The row renders "📷 Photo" from this. A count, not a rendered string:
        the phrasing is the client's business, and a count is the one fact about
        an attachment that survives the server not being able to see it."""
        self._send(photo=make_image_upload())
        listing = self.client.get(CONVERSATIONS_URL)
        preview = listing.data["results"][0]["last_message"]
        self.assertEqual(preview["attachment_count"], 1)
        self.assertEqual(preview["text"], "")

    def test_the_push_says_a_photo_was_sent(self):
        """Names the sender and the medium, quotes nothing — the same rule every
        other push body here follows. Knowing a picture is waiting is often the
        whole reason to open the app."""
        from api.management.commands.send_pushes import Command

        # Opened through the API, not built off the model: a thread with no
        # ``Participant`` rows is a legacy shape that deliberately enqueues
        # nothing (see ``enqueue_message_pushes``), so ``self.convo`` would test
        # silence rather than the phrasing.
        opened = self.open_with(self.friend)
        self.convo = Conversation.objects.get(pk=opened.data["id"])
        self._send(photo=make_image_upload())
        row = PushOutbox.objects.get(recipient=self.friend)

        payload = Command()._payload(row)
        self.assertEqual(payload["text"], f"{self.me.display_name} sent a photo")

    def test_a_reported_photo_is_visible_to_the_maintainer(self):
        """🔒 M0's rule is that a report is the *only* window onto a private
        message. M7 made a message able to be nothing but a photo, so without
        this the queue would show an empty snapshot and photo abuse would be the
        one thing moderation couldn't act on.

        **The bytes are inlined, not linked**, and this test says so on purpose.
        M7 first rendered ``<img src="{thumbnail.url}">``, which 401s in
        production: ``/media/*`` is ``forward_auth``ed to ``/api/media-auth/``,
        which takes the JWT cookie and not the admin's Django session, so the
        queue would have shown broken images — the one thing this field exists
        to prevent. Asserting a ``data:`` URI is what keeps someone from
        "tidying" it back into a link that only works on their machine.
        """
        import base64

        from django.contrib.admin.sites import AdminSite

        from .admin import ReportAdmin

        upload = make_image_upload()
        thumb_bytes = upload.read()
        upload.seek(0)
        sent = self._send(photo=make_image_upload(), thumbnail=upload)
        message = Message.objects.get(pk=sent.data["id"])
        self.client.force_authenticate(self.friend)
        self.client.post(
            "/api/reports/", {"message": message.pk}, format="json"
        )
        report = Report.objects.get()

        rendered = ReportAdmin(Report, AdminSite()).message_photos(report)
        expected = base64.b64encode(thumb_bytes).decode("ascii")
        self.assertIn(f"data:image/jpeg;base64,{expected}", rendered)
        # Nothing that would send the browser back to the gated media route.
        self.assertNotIn("/media/", rendered)
        self.assertNotIn(MessageAttachment.objects.get().thumbnail.url, rendered)

        # And it goes empty once the sender deletes the message, because the
        # photo is then genuinely gone — see the field's docstring.
        self.client.force_authenticate(self.me)
        self.client.delete(f"{messages_url(self.convo)}{message.pk}/")
        report.refresh_from_db()
        self.assertEqual(
            ReportAdmin(Report, AdminSite()).message_photos(report), ""
        )


class MessageReactionTests(MessagingBase):
    """Reacting to a message (Phase 9b M2).

    The toggle mechanics are the post/comment ones — same model, same validator,
    same endpoint shape — so these tests are almost entirely about the places
    messaging *differs*: the gate is the messaging gate (interval-clipped, and
    it consults ``can_send``), the aggregate isn't pruned per viewer, and none of
    it touches the bell or the push queue.
    """

    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )
        self.theirs = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="dinner at 7?"
        )

    def _react(self, message, emoji="👍"):
        return self.client.post(
            f"/api/messages/{message.pk}/react/", {"emoji": emoji}, format="json"
        )

    def test_reacting_adds_then_toggles_off(self):
        added = self._react(self.theirs)
        self.assertEqual(added.status_code, status.HTTP_200_OK)
        self.assertEqual(
            added.data["reactions"],
            [{"emoji": "👍", "count": 1, "reacted": True}],
        )

        removed = self._react(self.theirs)
        self.assertEqual(removed.status_code, status.HTTP_200_OK)
        self.assertEqual(removed.data["reactions"], [])
        self.assertFalse(Reaction.objects.filter(message=self.theirs).exists())

    def test_reactions_ride_on_the_thread_payload(self):
        # The bubble renders its pills from the message row, so the summary has
        # to be on the thread listing and not only on the toggle response.
        self._react(self.theirs, "🎉")
        thread = self.client.get(messages_url(self.convo))
        row = thread.data["results"][0]
        self.assertEqual(
            row["reactions"], [{"emoji": "🎉", "count": 1, "reacted": True}]
        )

    def test_a_fresh_message_has_an_empty_reaction_list(self):
        thread = self.client.get(messages_url(self.convo))
        self.assertEqual(thread.data["results"][0]["reactions"], [])

    def test_you_can_react_to_your_own_message(self):
        mine = Message.objects.create(
            conversation=self.convo, sender=self.me, text="8 works"
        )
        self.assertEqual(self._react(mine, "❤️").status_code, status.HTTP_200_OK)

    def test_reactors_endpoint_lists_who_reacted(self):
        self._react(self.theirs, "😂")
        self.client.force_authenticate(self.friend)
        self._react(self.theirs, "😂")

        resp = self.client.get(f"/api/messages/{self.theirs.pk}/reactions/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["emoji"], "😂")
        self.assertEqual(resp.data[0]["count"], 2)
        self.assertEqual(
            {u["id"] for u in resp.data[0]["users"]}, {self.me.pk, self.friend.pk}
        )

    def test_message_reactions_are_not_pruned_by_connection(self):
        """The deliberate difference from post/comment reactions.

        A post prunes reactors to people the viewer may see, because a reactor
        might be a stranger. A chat can't have one: the active participants are a
        clique by construction, so anyone who can see the message can already see
        everyone who reacted. Pruning here would hide reactions for no privacy
        gain and leave two people in the same thread disagreeing about it.

        The chat below is built straight off the models with *no* ``Connection``
        rows, which is exactly what a connection-pruned aggregate would filter
        out — so this fails the moment someone "fixes" message reactions to
        prune like posts do.
        """
        a = make_user("ra@example.com")
        b = make_user("rb@example.com")
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=a
        )
        started = timezone.now() - timedelta(hours=1)
        for user in (a, b):
            participant = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=started
            )
        message = Message.objects.create(
            conversation=convo, sender=a, text="who's in?"
        )

        self.client.force_authenticate(a)
        self.assertEqual(self._react(message, "🎉").status_code, status.HTTP_200_OK)

        self.client.force_authenticate(b)
        resp = self.client.get(f"/api/messages/{message.pk}/reactions/")
        self.assertEqual(resp.data[0]["count"], 1)
        self.assertEqual(resp.data[0]["users"][0]["id"], a.pk)

    def test_non_participant_gets_404(self):
        # Probing a message id from outside the thread reveals nothing — the
        # same answer the edit route gives.
        self.client.force_authenticate(self.stranger)
        resp = self._react(self.theirs)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Reaction.objects.exists())

    def test_cannot_react_to_a_message_from_inside_your_gap(self):
        """The interval-clipping case, mirroring the edit and report gates.

        A member who was out of a group chat when a message was sent can't see
        it, so the reaction route must not answer questions about it either —
        otherwise 200-vs-404 tells a gap member exactly which ids landed while
        they were away.
        """
        a = make_user("ga@example.com")
        gapper = make_user("ggapper@example.com")
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=a
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=2)
        p_a = Participant.objects.create(
            conversation=convo, user=a, status="active"
        )
        ParticipantInterval.objects.create(participant=p_a, started_at=t0)
        gap_p = Participant.objects.create(
            conversation=convo, user=gapper, status="active"
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=t0, ended_at=t1
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=timezone.now()
        )
        in_gap = Message.objects.create(
            conversation=convo, sender=a, text="said while they were out"
        )
        Message.objects.filter(pk=in_gap.pk).update(
            created_at=t1 + timedelta(minutes=10)
        )

        self.client.force_authenticate(gapper)
        resp = self._react(in_gap)
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        # Indistinguishable from an id that was never in this thread at all.
        missing = self.client.post(
            f"/api/messages/{in_gap.pk + 9999}/react/",
            {"emoji": "👍"},
            format="json",
        )
        self.assertEqual(missing.status_code, resp.status_code)
        # Reading the reactor list is clipped the same way.
        listing = self.client.get(f"/api/messages/{in_gap.pk}/reactions/")
        self.assertEqual(listing.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_react_in_a_thread_you_can_no_longer_send_to(self):
        """A reaction is content everyone else in the thread sees, so the send
        gate applies to it exactly as it applies to an edit. Without this, a
        disconnect closes the composer but leaves a back door open for putting
        emoji into a thread you've been cut out of."""
        self.client.delete(connect_url(self.friend))
        resp = self._react(self.theirs)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(Reaction.objects.exists())

    def test_history_stays_readable_after_a_disconnect(self):
        """The other half of the rule above: losing the ability to *write* must
        not lose the ability to *read*. Reactions someone already left stay
        visible in the history, the same way the messages do."""
        self._react(self.theirs, "👍")
        self.client.delete(connect_url(self.friend))
        resp = self.client.get(f"/api/messages/{self.theirs.pk}/reactions/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data[0]["count"], 1)

    def _friend_deletes(self, message):
        self.client.force_authenticate(self.friend)
        self.client.delete(
            f"/api/conversations/{self.convo.pk}/messages/{message.pk}/"
        )
        self.client.force_authenticate(self.me)

    def test_cannot_add_a_reaction_to_a_deleted_message(self):
        self._friend_deletes(self.theirs)
        resp = self._react(self.theirs)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Reaction.objects.exists())

    def test_can_still_remove_a_reaction_from_a_deleted_message(self):
        """The other half of the rule above, and the reason it isn't a blanket
        refusal.

        A tombstone still shows the reactions left before the delete, and it has
        no long-press menu — so the who-reacted sheet is the *only* way to take
        one off. Refusing a removal too would strand someone with a 😂 on a
        message that no longer exists and no way to retract it. Removing isn't
        adding, so the "nothing left to react to" reasoning doesn't apply to it.
        """
        self.assertEqual(self._react(self.theirs).status_code, status.HTTP_200_OK)
        self._friend_deletes(self.theirs)

        resp = self._react(self.theirs)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["reactions"], [])
        self.assertFalse(Reaction.objects.exists())

    def test_removing_from_a_deleted_message_cannot_re_add(self):
        # The toggle must not become a back door: once it's off, it stays off.
        self.assertEqual(self._react(self.theirs).status_code, status.HTTP_200_OK)
        self._friend_deletes(self.theirs)
        self._react(self.theirs)

        again = self._react(self.theirs)
        self.assertEqual(again.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Reaction.objects.exists())

    def test_invalid_emoji_is_rejected(self):
        resp = self._react(self.theirs, "not an emoji")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Reaction.objects.exists())

    def test_reacting_creates_no_notification_and_no_push(self):
        """Messaging sits outside the bell (messaging.md), and buzzing a phone
        for a 👍 is how people end up turning notifications off. Both halves are
        asserted because they're separately easy to reintroduce — the shared
        toggle helper writes a ``Notification`` for every other target."""
        PushOutbox.objects.all().delete()
        Notification.objects.all().delete()
        self.assertEqual(self._react(self.theirs).status_code, status.HTTP_200_OK)
        self.assertFalse(Notification.objects.exists())
        self.assertFalse(PushOutbox.objects.exists())

    def test_reacting_does_not_bump_conversation_activity(self):
        # Same reasoning as an edit: a reaction isn't new activity, so it must
        # not jump the thread to the top of everyone's list.
        before = Conversation.objects.get(pk=self.convo.pk).updated_at
        self._react(self.theirs)
        after = Conversation.objects.get(pk=self.convo.pk).updated_at
        self.assertEqual(before, after)

    def test_per_target_emoji_cap_applies(self):
        for i in range(MAX_REACTIONS_PER_USER_PER_TARGET):
            emoji = chr(ord("😀") + i)
            self.assertEqual(
                self._react(self.theirs, emoji).status_code, status.HTTP_200_OK
            )
        over = self._react(self.theirs, "🎉")
        self.assertEqual(over.status_code, status.HTTP_400_BAD_REQUEST)


class MessageReactionConstraintTests(APITestCase):
    """The database guards behind message reactions — the same belt-and-braces
    the post/comment targets get, extended to the third target."""

    def setUp(self):
        self.me = make_user("me@example.com")
        friend = make_user("friend@example.com")
        convo = Conversation.objects.create(user_a=self.me, user_b=friend)
        self.message = Message.objects.create(
            conversation=convo, sender=friend, text="hi"
        )
        self.post = Post.objects.create(author=self.me, text="hi")

    def test_a_reaction_cannot_target_both_message_and_post(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(
                    user=self.me, post=self.post, message=self.message, emoji="👍"
                )

    def test_same_emoji_twice_on_a_message_is_rejected(self):
        Reaction.objects.create(user=self.me, message=self.message, emoji="👍")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(
                    user=self.me, message=self.message, emoji="👍"
                )

    def test_deleting_a_message_takes_its_reactions_with_it(self):
        # Soft-delete leaves a tombstone and keeps the row, so this is about a
        # *hard* delete (a conversation cascade, or an account deletion).
        Reaction.objects.create(user=self.me, message=self.message, emoji="👍")
        self.message.delete()
        self.assertFalse(Reaction.objects.exists())


class MessageReplyTests(MessagingBase):
    """Reply threads (Phase 9b M3).

    Three things are worth testing here and the rest is plumbing: replies flatten
    to one level (``thread_root``), ``reply_to`` can only name a message the
    sender can actually see, and — the one that matters — a quote is a
    *reference*, so it can't become a window into history the viewer was clipped
    out of. ``MessageReplyGapTests`` below owns that last one.
    """

    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )
        self.root = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="dinner at 7?"
        )

    def _reply(self, to, text="yes", convo=None):
        return self.client.post(
            messages_url(convo or self.convo),
            {"text": text, "reply_to_id": to.pk},
            format="json",
        )

    def test_replying_sets_reply_to_and_thread_root(self):
        resp = self._reply(self.root)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        reply = Message.objects.get(pk=resp.data["id"])
        self.assertEqual(reply.reply_to_id, self.root.pk)
        # A reply to a root belongs to that root's thread.
        self.assertEqual(reply.thread_root_id, self.root.pk)

    def test_a_reply_to_a_reply_joins_the_same_thread(self):
        """Depth 1, always. Replying to a reply must not start a nested thread —
        it joins the one that reply is already in, which is what keeps the
        focused thread view a flat scrollable list rather than a tree."""
        first = Message.objects.get(pk=self._reply(self.root, "yes").data["id"])
        second = Message.objects.get(pk=self._reply(first, "8 is better").data["id"])
        # ``reply_to`` still records exactly who was answered…
        self.assertEqual(second.reply_to_id, first.pk)
        # …while the thread stays anchored on the original root.
        self.assertEqual(second.thread_root_id, self.root.pk)
        self.assertIsNone(self.root.thread_root_id)

    def test_reply_to_is_a_bare_id_and_carries_nothing_else(self):
        """The load-bearing privacy shape. If the quoted body were embedded in
        the reply's payload it would reach whoever can see the *reply*, which
        walks straight around interval clipping — see ``MessageReplyGapTests``.

        Not the author either: a message you can't see tells you nothing, not
        even who wrote it. The client renders the name from the message it
        resolved, and if it resolved nothing there's no name to render."""
        self._reply(self.root)
        thread = self.client.get(messages_url(self.convo))
        reply = thread.data["results"][-1]
        self.assertEqual(reply["reply_to"], {"id": self.root.pk})

    def test_reply_count_appears_on_the_root_only(self):
        self._reply(self.root, "yes")
        self._reply(self.root, "or 8?")
        thread = self.client.get(messages_url(self.convo))
        by_id = {m["id"]: m for m in thread.data["results"]}
        self.assertEqual(by_id[self.root.pk]["reply_count"], 2)
        # A reply is not a root: it carries no count of its own, even though it
        # sits in a thread with two messages in it.
        replies = [m for m in thread.data["results"] if m["id"] != self.root.pk]
        self.assertEqual([m["reply_count"] for m in replies], [0, 0])

    def test_thread_root_filter_returns_the_root_and_its_replies(self):
        self._reply(self.root, "yes")
        self._reply(self.root, "or 8?")
        self.client.post(messages_url(self.convo), {"text": "unrelated"})

        resp = self.client.get(
            f"{messages_url(self.convo)}?thread_root={self.root.pk}"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        texts = [m["text"] for m in resp.data["results"]]
        # Root first (it's the oldest), then its replies; the unrelated message
        # sent afterwards is not part of the thread.
        self.assertEqual(texts, ["dinner at 7?", "yes", "or 8?"])

    def test_thread_root_filter_rejects_a_non_numeric_id(self):
        resp = self.client.get(f"{messages_url(self.convo)}?thread_root=abc")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_thread_root_filter_rejects_an_id_too_big_for_the_column(self):
        """Python ints are unbounded, the column is a bigint. Without a range
        check a long enough number parses fine and then blows up in the database
        — a 500 where the honest answer is the same 400 as any other id that
        can't name a message."""
        resp = self.client.get(f"{messages_url(self.convo)}?thread_root={2**64}")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_reply_to_a_message_in_another_conversation(self):
        """``reply_to_id`` comes from the body, so it's the one field a client
        could point anywhere. It's resolved against the sender's own visible
        messages *in this thread*, so a cross-thread id is simply not there."""
        other_friend = make_user("other@example.com")
        make_connection(self.me, other_friend, status=ACCEPTED)
        elsewhere = Conversation.objects.create(
            user_a=self.me, user_b=other_friend
        )
        foreign = Message.objects.create(
            conversation=elsewhere, sender=other_friend, text="different chat"
        )

        resp = self._reply(foreign)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Message.objects.filter(reply_to=foreign).count(), 0)

    def test_replying_to_an_unknown_id_is_rejected(self):
        resp = self.client.post(
            messages_url(self.convo),
            {"text": "to nowhere", "reply_to_id": self.root.pk + 9999},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_sending_without_reply_to_still_works(self):
        # The field is optional, and every client that predates M3 omits it.
        resp = self.client.post(messages_url(self.convo), {"text": "plain"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(resp.data["reply_to"])
        self.assertIsNone(resp.data["thread_root_id"])

    def test_deleting_a_root_keeps_its_replies(self):
        """Soft-delete leaves the row, so the thread survives a deleted root
        with a tombstone at its head — the focused view still opens. The
        ``SET_NULL`` on the FK covers the hard-delete case (an account or
        conversation cascade) by orphaning replies rather than taking them."""
        reply = Message.objects.get(pk=self._reply(self.root).data["id"])
        self.client.force_authenticate(self.friend)
        self.client.delete(
            f"{messages_url(self.convo)}{self.root.pk}/"
        )
        reply.refresh_from_db()
        self.assertEqual(reply.thread_root_id, self.root.pk)
        self.assertTrue(Message.objects.get(pk=self.root.pk).is_deleted)

    def test_a_reply_sends_a_push_like_any_other_message(self):
        """A reply is still a message. M3 changes nothing about who gets buzzed
        — the point is that nobody thought to make it an exception."""
        PushOutbox.objects.all().delete()
        DevicePushToken.objects.create(
            user=self.friend,
            expo_token="ExponentPushToken[reply]",
            platform="ios",
        )
        Participant.objects.filter(conversation=self.convo).delete()
        for user in (self.me, self.friend):
            participant = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant,
                started_at=timezone.now() - timedelta(hours=1),
            )
        self._reply(self.root, "on my way")
        self.assertTrue(PushOutbox.objects.exists())


class MessageMentionTests(APITestCase):
    """@mentions in a group chat (Phase 9b M8).

    Three questions, and only the third is really about mentions:

    1. **Are they stored as a relation?** A name matched out of the text would
       stop working the day someone changes theirs, and can't work at all once
       the text is ciphertext.
    2. **Can you only name people in the room?** A mention is the one thing in
       messaging that beats mute, so an unchecked id here would be a way to buzz
       a stranger's phone — exactly what the clique invariant forbids. The same
       reasoning makes mentions **group-only**: in a 1:1 the one person you might
       mute would otherwise be able to defeat that mute on every message.
    3. **Does the mute override behave as advertised?** The setting governs
       *only* whether a mention beats mute, and getting that wrong silences
       mentions someone wanted (or punches through a quiet they asked for).
    """

    def setUp(self):
        self.ada = make_user("mention-ada@example.com", first_name="Ada")
        self.bea = make_user("mention-bea@example.com", first_name="Bea")
        self.cal = make_user("mention-cal@example.com", first_name="Cal")
        for a, b in [
            (self.ada, self.bea),
            (self.ada, self.cal),
            (self.bea, self.cal),
        ]:
            make_connection(a, b)
        self.convo = Conversation.objects.create(
            kind="group", created_by=self.ada, title="Book club"
        )
        for user in (self.ada, self.bea, self.cal):
            participant = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=timezone.now()
            )
        self.client.force_authenticate(self.ada)

    def _send(self, mention_ids, text="@Bea can you bring the book?"):
        return self.client.post(
            messages_url(self.convo),
            {"text": text, "mention_ids": mention_ids},
            format="json",
        )

    def _mute(self, user):
        Participant.objects.filter(conversation=self.convo, user=user).update(
            muted_at=timezone.now()
        )

    def _queued_for(self, user):
        return PushOutbox.objects.filter(recipient=user, sent_at__isnull=True)

    def test_a_mention_is_stored_as_a_row_and_returned_as_a_bare_id(self):
        resp = self._send([self.bea.pk])

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        message = Message.objects.get(pk=resp.data["id"])
        self.assertEqual(
            list(message.mentions.values_list("user_id", flat=True)), [self.bea.pk]
        )
        # Ids and nothing else — no name, no avatar. The client resolves the id
        # against the participants payload it already holds, which is also the
        # only thing that can work once the words are ciphertext.
        self.assertEqual(resp.data["mentions"], [self.bea.pk])

    def test_mentions_come_back_on_the_thread(self):
        self._send([self.bea.pk, self.cal.pk])

        thread = self.client.get(messages_url(self.convo))

        self.assertEqual(
            thread.data["results"][-1]["mentions"], [self.bea.pk, self.cal.pk]
        )

    def test_a_message_without_mentions_reports_an_empty_list(self):
        self.client.post(messages_url(self.convo), {"text": "hello"})

        thread = self.client.get(messages_url(self.convo))

        self.assertEqual(thread.data["results"][-1]["mentions"], [])

    def test_cannot_mention_someone_outside_the_conversation(self):
        """🔒 The load-bearing check. A mention beats mute, so an unchecked id
        would make this endpoint a way to buzz someone you have no thread with."""
        outsider = make_user("mention-outsider@example.com")

        resp = self._send([outsider.pk])

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Message.objects.filter(text__contains="book").exists())
        self.assertEqual(MessageMention.objects.count(), 0)

    def test_cannot_mention_anyone_in_a_direct_chat(self):
        """🔒 Mentions are group-only, enforced here rather than only by a client
        that declines to offer a picker.

        A mention beats mute. In a 1:1 the person you'd mute is the only person
        who can send you anything, so accepting an id here would let them defeat
        that mute on every message — muting a *person* would stop meaning
        anything. Neither client offers it, and what the server accepts has to be
        no wider than that.
        """
        direct = Conversation.objects.create(
            kind="direct", user_a=self.ada, user_b=self.bea, created_by=self.ada
        )
        for user in (self.ada, self.bea):
            participant = Participant.objects.create(
                conversation=direct, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=direct.created_at
            )
        Participant.objects.filter(conversation=direct, user=self.bea).update(
            muted_at=timezone.now()
        )

        resp = self.client.post(
            messages_url(direct),
            {"text": "@Bea are you there?", "mention_ids": [self.bea.pk]},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(MessageMention.objects.count(), 0)
        # And the mute it would have beaten still holds.
        self.assertFalse(self._queued_for(self.bea).exists())

    def test_a_direct_chat_still_takes_an_ordinary_message(self):
        """The rejection is of the *field*, not of sending — a 1:1 is otherwise
        untouched by M8."""
        direct = Conversation.objects.create(
            kind="direct", user_a=self.ada, user_b=self.bea, created_by=self.ada
        )
        for user in (self.ada, self.bea):
            participant = Participant.objects.create(
                conversation=direct, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=direct.created_at
            )

        resp = self.client.post(messages_url(direct), {"text": "hello"})

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["mentions"], [])

    def test_mention_ids_survive_a_multipart_send(self):
        """The photo path builds its body as a form, one part per id — a
        different branch of the client's send and a different parse on the way
        in, so the JSON tests above don't cover it.

        A single ``mention_ids`` part holding "1,2" would arrive as one
        unparseable value; this is what pins the repeated-part shape.
        """
        resp = self.client.post(
            messages_url(self.convo),
            {
                "text": "@Bea @Cal look at this",
                "mention_ids": [str(self.bea.pk), str(self.cal.pk)],
            },
            format="multipart",
        )

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["mentions"], [self.bea.pk, self.cal.pk])

    def test_cannot_mention_a_pending_member(self):
        # They can't read a line of the thread yet, so naming them would
        # announce something the app would immediately refuse to show.
        dee = make_user("mention-dee@example.com")
        make_connection(self.ada, dee)
        Participant.objects.create(
            conversation=self.convo, user=dee, status="pending"
        )

        resp = self._send([dee.pk])

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_naming_someone_twice_is_one_mention(self):
        resp = self._send([self.bea.pk, self.bea.pk])

        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MessageMention.objects.count(), 1)

    def test_a_tombstone_carries_no_mentions(self):
        message_id = self._send([self.bea.pk]).data["id"]
        self.client.delete(f"{messages_url(self.convo)}{message_id}/")

        thread = self.client.get(messages_url(self.convo))

        tombstone = thread.data["results"][-1]
        self.assertTrue(tombstone["is_deleted"])
        self.assertEqual(tombstone["mentions"], [])

    def test_a_mention_notifies_through_a_muted_thread(self):
        """The whole point of naming someone, and the one justified exception to
        ``Participant.muted_at``."""
        self._mute(self.bea)
        self._mute(self.cal)

        self._send([self.bea.pk])

        self.assertTrue(self._queued_for(self.bea).exists())
        # And only for the person named: muting still holds for everyone else,
        # or one mention would un-mute the thread for the whole group.
        self.assertFalse(self._queued_for(self.cal).exists())

    def test_the_override_can_be_turned_off(self):
        NotificationPreference.objects.create(
            user=self.bea, kind=Notification.Kind.MENTION, enabled=False
        )
        self._mute(self.bea)

        self._send([self.bea.pk])

        self.assertFalse(self._queued_for(self.bea).exists())

    def test_turning_the_override_off_does_not_silence_mentions_generally(self):
        """The precise reading of the setting: it governs *only* whether a
        mention beats mute. In an unmuted thread a mention notifies either way —
        via the ordinary message push — and someone who turned the override off
        has not asked to stop hearing their own name."""
        NotificationPreference.objects.create(
            user=self.bea, kind=Notification.Kind.MENTION, enabled=False
        )

        self._send([self.bea.pk])

        self.assertTrue(self._queued_for(self.bea).exists())

    def test_a_mention_cannot_beat_interval_clipping(self):
        """Mute is the *only* rule a mention overrides. A member whose access
        interval is closed can't read the message, so naming them must not
        announce it — the push and the thread have to agree."""
        participant = Participant.objects.get(
            conversation=self.convo, user=self.bea
        )
        deactivate(participant, timezone.now())

        self._send([self.bea.pk])

        self.assertFalse(self._queued_for(self.bea).exists())

    def test_the_push_body_says_who_named_you_and_nothing_else(self):
        """A silenced chat that suddenly buzzes owes you an explanation — and
        the explanation still quotes no part of the message."""
        self._mute(self.bea)
        DevicePushToken.objects.create(
            user=self.bea, expo_token="ExponentPushToken[mention]", platform="ios"
        )
        self._send([self.bea.pk], text="@Bea what did you think of chapter 4?")

        from .management.commands.send_pushes import Command as SendPushes

        row = self._queued_for(self.bea).get()
        body = SendPushes()._payload(row)["text"]

        self.assertEqual(body, "Ada mentioned you in Book club")
        self.assertNotIn("chapter 4", body)


class MessageIdsFilterTests(MessagingBase):
    """``?ids=`` on the messages endpoint (Phase 9b M5).

    The app needs it because the transcript pages lazily now: a reply carries a
    bare ``{id}``, so the collapsed quote's words and author have to be fetched,
    and this is the front door. It's a filter on the same interval-clipped
    queryset as the transcript, which is the whole design — ``MessageReplyGapTests``
    owns the proof that a clipped id stays clipped here.
    """

    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(user_a=self.me, user_b=self.friend)
        self.first = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="dinner at 7?"
        )
        self.second = Message.objects.create(
            conversation=self.convo, sender=self.me, text="works for me"
        )
        self.third = Message.objects.create(
            conversation=self.convo, sender=self.friend, text="see you then"
        )

    def test_returns_only_the_ids_asked_for(self):
        resp = self.client.get(
            f"{messages_url(self.convo)}?ids={self.first.pk},{self.third.pk}"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [m["text"] for m in resp.data["results"]],
            ["dinner at 7?", "see you then"],
        )

    def test_an_id_from_another_conversation_is_simply_absent(self):
        """Not a 400 and not a 404 — the filter runs over *this* thread's visible
        messages, so a foreign id matches nothing. One code path, and no way to
        use the response to learn that the id exists somewhere else."""
        other_friend = make_user("elsewhere@example.com")
        make_connection(self.me, other_friend, status=ACCEPTED)
        elsewhere = Conversation.objects.create(user_a=self.me, user_b=other_friend)
        foreign = Message.objects.create(
            conversation=elsewhere, sender=other_friend, text="different chat"
        )

        resp = self.client.get(
            f"{messages_url(self.convo)}?ids={self.first.pk},{foreign.pk}"
        )
        self.assertEqual([m["id"] for m in resp.data["results"]], [self.first.pk])
        self.assertNotIn("different chat", json.dumps(resp.data, default=str))

    def test_an_empty_ids_parameter_returns_nothing(self):
        """The one genuinely wrong answer available here would be to treat an
        empty list as "no filter" and hand back the whole thread."""
        resp = self.client.get(f"{messages_url(self.convo)}?ids=")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["results"], [])

    def test_rejects_a_non_numeric_id(self):
        resp = self.client.get(f"{messages_url(self.convo)}?ids={self.first.pk},abc")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_rejects_an_id_too_big_for_the_column(self):
        # Same range check as ``?thread_root=``, shared so the two can't drift:
        # unbounded Python ints reach a bigint column as a 500 otherwise.
        resp = self.client.get(f"{messages_url(self.convo)}?ids={2**64}")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_rejects_more_ids_than_the_cap(self):
        """A guard rail, not a budget: the caller is a screenful of quotes. An
        unbounded ``IN`` clause built from a query string is worth refusing."""
        ids = ",".join(str(n) for n in range(MESSAGE_IDS_MAX + 1))
        resp = self.client.get(f"{messages_url(self.convo)}?ids={ids}")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_order_desc_returns_the_newest_first(self):
        """What lets the app open a thread on one page. Oldest-first paging puts
        the newest messages on the *last* page, so "show me this chat" meant
        loading every page — the eager full-history load M5 exists to delete."""
        resp = self.client.get(f"{messages_url(self.convo)}?order=desc")
        self.assertEqual(
            [m["text"] for m in resp.data["results"]],
            ["see you then", "works for me", "dinner at 7?"],
        )

    def test_the_default_order_is_unchanged(self):
        """🔒 The compatibility rule: additive only, and an old client must not
        meet a reordered payload. The web drawer still reads oldest-first."""
        resp = self.client.get(messages_url(self.convo))
        self.assertEqual(
            [m["text"] for m in resp.data["results"]],
            ["dinner at 7?", "works for me", "see you then"],
        )

    def test_an_unrecognised_order_falls_back_to_the_default(self):
        # Only the one documented value flips it; anything else is the default
        # rather than a 400, because the parameter is an opt-in shortcut and a
        # client that misspells it should get a usable thread, not an error.
        resp = self.client.get(f"{messages_url(self.convo)}?order=sideways")
        self.assertEqual(
            [m["text"] for m in resp.data["results"]],
            ["dinner at 7?", "works for me", "see you then"],
        )

    def test_a_pending_member_gets_403_not_a_filtered_list(self):
        """The filter sits *inside* the endpoint, so it inherits the gate rather
        than bypassing it — a pending member is locked out of the thread and
        ``?ids=`` is still the thread."""
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=self.friend
        )
        Participant.objects.create(
            conversation=convo, user=self.friend, status="active"
        )
        Participant.objects.create(conversation=convo, user=self.me, status="pending")
        resp = self.client.get(f"{messages_url(convo)}?ids={self.first.pk}")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class MessageReplyGapTests(APITestCase):
    """🔒 The gap scenario for replies (Phase 9b M3).

    A member who was ``pending`` across a range, then returned, must not be able
    to read a message from inside that gap — and a reply *quoting* it is the
    newest way to try. This is the test the milestone was written around, and it
    asserts at the **API level** that the text is absent from the payload: a UI
    test showing a bubble didn't render would prove nothing about what crossed
    the wire.

    What they *should* see is the reply itself (sent while they were back) with a
    quote reference they can't resolve, and a focused thread with its head
    missing. Mirrors ``test_cannot_probe_a_message_from_inside_your_gap``.
    """

    def setUp(self):
        self.author = make_user("gapauthor@example.com")
        self.gapper = make_user("gapper@example.com")
        self.convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=self.author
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=2)
        t2 = timezone.now() - timedelta(minutes=30)

        author_p = Participant.objects.create(
            conversation=self.convo, user=self.author, status="active"
        )
        ParticipantInterval.objects.create(participant=author_p, started_at=t0)
        gap_p = Participant.objects.create(
            conversation=self.convo, user=self.gapper, status="active"
        )
        # Out between t1 and t2 — the gap.
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=t0, ended_at=t1
        )
        ParticipantInterval.objects.create(participant=gap_p, started_at=t2)

        # The root lands inside the gap; the reply to it lands after they're back.
        self.root = Message.objects.create(
            conversation=self.convo, sender=self.author, text="the secret plan"
        )
        Message.objects.filter(pk=self.root.pk).update(
            created_at=t1 + timedelta(minutes=10)
        )
        self.root.refresh_from_db()
        self.reply = Message.objects.create(
            conversation=self.convo,
            sender=self.author,
            text="still on for that",
            reply_to=self.root,
        )

    def test_a_reply_never_reveals_a_quoted_message_from_the_gap(self):
        self.client.force_authenticate(self.gapper)
        resp = self.client.get(messages_url(self.convo))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        texts = [m["text"] for m in resp.data["results"]]
        self.assertIn("still on for that", texts)
        self.assertNotIn("the secret plan", texts)
        # The clipped-out text must not appear *anywhere* in the payload — not
        # in a field, not nested in the quote. Checking the serialised body is
        # the point: a field-by-field assertion would pass if a future change
        # embedded the quote somewhere new.
        self.assertNotIn("the secret plan", json.dumps(resp.data, default=str))

        # All the reply says is *that* it answers something, by an id they can't
        # fetch. Not the words, and not the author — see the next test.
        reply = next(m for m in resp.data["results"] if m["id"] == self.reply.pk)
        self.assertEqual(reply["reply_to"], {"id": self.root.pk})

    def test_a_quote_never_names_the_author_of_a_message_from_the_gap(self):
        """🔒 The narrower half of the same leak, and the one an earlier cut of
        M3 shipped: a quote used to carry ``sender``.

        Somebody can join a group, post, and leave again entirely inside your
        gap, and ``participants`` lists only current members — so the quote was
        the one place their name and avatar reached a person who was never in a
        chat with them. Here the quoted author is a stranger by construction:
        the gapper shares no connection with them and can't see the message.
        """
        stranger = make_user(
            "stranger@example.com", first_name="Mallory", last_name="Quinn"
        )
        stranger_p = Participant.objects.create(
            conversation=self.convo, user=stranger, status="active"
        )
        # In and out entirely inside the gapper's gap.
        ParticipantInterval.objects.create(
            participant=stranger_p,
            started_at=timezone.now() - timedelta(hours=2),
            ended_at=timezone.now() - timedelta(minutes=45),
        )
        hidden = Message.objects.create(
            conversation=self.convo, sender=stranger, text="passing through"
        )
        Message.objects.filter(pk=hidden.pk).update(
            created_at=timezone.now() - timedelta(minutes=50)
        )
        visible_reply = Message.objects.create(
            conversation=self.convo,
            sender=self.author,
            text="agreed",
            reply_to=hidden,
        )

        self.client.force_authenticate(self.gapper)
        resp = self.client.get(messages_url(self.convo))
        body = json.dumps(resp.data, default=str)

        quoter = next(
            m for m in resp.data["results"] if m["id"] == visible_reply.pk
        )
        self.assertEqual(quoter["reply_to"], {"id": hidden.pk})
        # Neither the words nor the person who wrote them.
        self.assertNotIn("passing through", body)
        self.assertNotIn(stranger.display_name, body)

    def test_ids_cannot_fetch_a_message_from_inside_your_gap(self):
        """🔒 ``?ids=`` is the M5 route to a quote's words, so it is also the
        newest way to try to read history you were clipped out of.

        It's one more filter on the same clipped queryset, so the answer is
        silence rather than a refusal: the id simply isn't in the response, and
        the gapper can't tell it from an id that never existed. That
        indistinguishability is the point — a 403 here would confirm the message
        is real, which is the existence oracle the edit route closed too."""
        self.client.force_authenticate(self.gapper)
        resp = self.client.get(
            f"{messages_url(self.convo)}?ids={self.root.pk},{self.reply.pk}"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual([m["id"] for m in resp.data["results"]], [self.reply.pk])
        self.assertNotIn("the secret plan", json.dumps(resp.data, default=str))

    def test_the_focused_thread_opens_with_its_head_missing(self):
        """Asking for the thread by root id is the obvious second way in, so it
        goes through the same clipped queryset. The gap member gets their own
        visible replies and no root — which is exactly what the app renders as
        "Original message unavailable"."""
        self.client.force_authenticate(self.gapper)
        resp = self.client.get(
            f"{messages_url(self.convo)}?thread_root={self.root.pk}"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = [m["id"] for m in resp.data["results"]]
        self.assertEqual(ids, [self.reply.pk])
        self.assertNotIn("the secret plan", json.dumps(resp.data, default=str))

    def test_the_author_sees_the_whole_thread(self):
        # The control: nothing above is achieved by the thread being broken.
        self.client.force_authenticate(self.author)
        resp = self.client.get(
            f"{messages_url(self.convo)}?thread_root={self.root.pk}"
        )
        texts = [m["text"] for m in resp.data["results"]]
        self.assertEqual(texts, ["the secret plan", "still on for that"])

    def test_reply_count_is_clipped_to_what_the_viewer_can_see(self):
        """A count is small, but it's still existence. Told "3 replies" on a
        message they can't see, a gap member learns how much happened while they
        were out — the same thing the 404-not-403 rules elsewhere refuse to
        answer. So the count is over *their* visible set, not everyone's."""
        # A second reply, this one inside the gap.
        hidden = Message.objects.create(
            conversation=self.convo,
            sender=self.author,
            text="and another thing",
            reply_to=self.root,
        )
        Message.objects.filter(pk=hidden.pk).update(
            created_at=self.root.created_at + timedelta(minutes=1)
        )

        self.client.force_authenticate(self.author)
        mine = self.client.get(messages_url(self.convo))
        root_row = next(
            m for m in mine.data["results"] if m["id"] == self.root.pk
        )
        self.assertEqual(root_row["reply_count"], 2)

        # The gap member can't see the root at all here, so the count they'd get
        # is on the thread endpoint — where only their one visible reply counts.
        self.client.force_authenticate(self.gapper)
        theirs = self.client.get(
            f"{messages_url(self.convo)}?thread_root={self.root.pk}"
        )
        self.assertEqual(
            [m["id"] for m in theirs.data["results"]], [self.reply.pk]
        )


class MessageReadReceiptTests(APITestCase):
    """Read receipts on the conversation detail (Phase 9b M4).

    The ticks themselves are drawn client-side by comparing each participant's
    ``last_read_at`` against a message's ``created_at``, so everything worth
    testing is about **what crosses the wire**: the marker is there when both
    people share receipts, and *absent* — not merely nulled — when either has
    turned them off. Asserting at this level is the point of the milestone's
    privacy half; a UI test showing a tick didn't render would prove nothing
    about what the server handed over.
    """

    def setUp(self):
        self.me = make_user("receipts-me@example.com")
        self.friend = make_user("receipts-friend@example.com")
        make_connection(self.me, self.friend, status=ACCEPTED)
        self.client.force_authenticate(self.me)
        # Through the API, so the thread gets real Participant + interval rows
        # rather than the legacy Phase 5 shape.
        self.convo = Conversation.objects.get(
            pk=self.client.post(
                CONVERSATIONS_URL, {"user_id": self.friend.pk}, format="json"
            ).data["id"]
        )

    def detail(self, as_user=None):
        if as_user is not None:
            self.client.force_authenticate(as_user)
        return self.client.get(f"{CONVERSATIONS_URL}{self.convo.pk}/")

    def participant(self, resp, user):
        return next(p for p in resp.data["participants"] if p["id"] == user.pk)

    def test_default_is_on(self):
        # A feature nobody discovers is a feature nobody has — the expectation
        # people arrive with is that receipts are on.
        self.assertTrue(self.me.send_read_receipts)

    def test_a_participants_read_marker_rides_on_the_detail_payload(self):
        self.client.post(messages_url(self.convo), {"text": "hello"})
        self.client.force_authenticate(self.friend)
        self.client.post(read_url(self.convo))

        resp = self.detail(as_user=self.me)
        row = self.participant(resp, self.friend)
        self.assertIsNotNone(row["last_read_at"])
        # The audience half: when they joined, so the client can tell a message
        # they were never shown from one they've simply not got to.
        self.assertIsNotNone(row["active_since"])

    def test_never_opened_is_null_not_absent(self):
        """The distinction the serializer exists to preserve. ``null`` means
        "they've not read this thread", which is real information the setting
        permits; a *missing* key means "we're not telling you". Collapsing the
        two would let a client read an opt-out as someone who never opened the
        chat."""
        resp = self.detail()
        row = self.participant(resp, self.friend)
        self.assertIn("last_read_at", row)
        self.assertIsNone(row["last_read_at"])

    def test_turning_it_off_removes_your_marker_from_their_payload(self):
        self.client.post(messages_url(self.convo), {"text": "hi"})
        self.client.force_authenticate(self.friend)
        self.client.post(read_url(self.convo))
        User.objects.filter(pk=self.friend.pk).update(send_read_receipts=False)

        resp = self.detail(as_user=self.me)
        row = self.participant(resp, self.friend)
        self.assertNotIn("last_read_at", row)
        self.assertNotIn("active_since", row)

    def test_turning_it_off_also_stops_you_seeing_theirs(self):
        """🔒 Symmetric, and enforced server-side. Turning receipts off is one
        switch: you stop reporting *and* you stop being told. Anything else is a
        one-way mirror, which is exactly the shape a privacy setting must not
        have."""
        self.client.force_authenticate(self.friend)
        self.client.post(read_url(self.convo))
        User.objects.filter(pk=self.me.pk).update(send_read_receipts=False)

        resp = self.detail(as_user=User.objects.get(pk=self.me.pk))
        for row in resp.data["participants"]:
            self.assertNotIn("last_read_at", row)
            self.assertNotIn("active_since", row)

    def test_the_conversation_list_never_carries_receipts(self):
        """A row shows an unread count, not who's read what. Keeping receipts to
        the detail is what makes the feature cost one field on a payload the
        thread already loads, instead of extra queries per row."""
        self.client.force_authenticate(self.friend)
        self.client.post(read_url(self.convo))
        resp = self.detail(as_user=self.me)
        self.assertIn("last_read_at", self.participant(resp, self.friend))

        listing = self.client.get(CONVERSATIONS_URL)
        for convo in listing.data["results"]:
            for row in convo["participants"]:
                self.assertNotIn("last_read_at", row)

    def test_the_setting_round_trips_through_the_user_endpoint(self):
        resp = self.client.patch(
            "/api/auth/user/", {"send_read_receipts": False}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(resp.data["send_read_receipts"])
        self.me.refresh_from_db()
        self.assertFalse(self.me.send_read_receipts)


class GroupReadReceiptTests(APITestCase):
    """Receipts in a group chat, where "read" means *everyone else who was
    there*. The rules that matter are about who counts, so the fixture is a
    three-person chat with one member added late.

    Groups are **not** carved out of the setting. "You can't turn this off in
    groups" is precisely the exception that makes a privacy toggle
    untrustworthy, so the same symmetric rule applies here.
    """

    def setUp(self):
        self.a = make_user("g-a@example.com")
        self.b = make_user("g-b@example.com")
        self.c = make_user("g-c@example.com")
        for pair in ((self.a, self.b), (self.a, self.c), (self.b, self.c)):
            make_connection(*pair, status=ACCEPTED)
        self.convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=self.a
        )
        joined = timezone.now() - timedelta(hours=2)
        for user in (self.a, self.b):
            row = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(participant=row, started_at=joined)
        # C arrives an hour later — the case that decides whether a tick can
        # ever complete on a message sent before they were added.
        self.c_row = Participant.objects.create(
            conversation=self.convo, user=self.c, status="active"
        )
        self.c_joined = timezone.now() - timedelta(hours=1)
        ParticipantInterval.objects.create(
            participant=self.c_row, started_at=self.c_joined
        )
        self.client.force_authenticate(self.a)

    def detail(self):
        return self.client.get(f"{CONVERSATIONS_URL}{self.convo.pk}/")

    def test_every_member_reports_their_own_join_time(self):
        """``active_since`` is what stops a late arrival stalling the tick on
        every message sent before them — without it the client either waits on
        someone who was never shown the message, or credits them with reading
        it."""
        rows = {p["id"]: p for p in self.detail().data["participants"]}
        self.assertEqual(
            rows[self.c.pk]["active_since"].replace(microsecond=0),
            self.c_joined.replace(microsecond=0),
        )
        self.assertLess(
            rows[self.b.pk]["active_since"], rows[self.c.pk]["active_since"]
        )

    def test_one_member_opting_out_hides_only_their_own_marker(self):
        """The rest of the group keeps working. A single opt-out silently
        disabling ticks for everyone would make the setting antisocial to use —
        so a member who doesn't report is simply not counted, and the tick means
        "everyone who shares read state has read it"."""
        User.objects.filter(pk=self.c.pk).update(send_read_receipts=False)
        rows = {p["id"]: p for p in self.detail().data["participants"]}
        self.assertIn("last_read_at", rows[self.b.pk])
        self.assertNotIn("last_read_at", rows[self.c.pk])

    def test_a_pending_viewer_gets_no_read_state_at_all(self):
        """They're in the waiting room and can't read a single message here. It
        isn't message content, but "who's been active in this thread and when"
        is still activity in a conversation they haven't been let into — and the
        locked panel has nothing to render it with anyway."""
        newcomer = make_user("g-d@example.com")
        make_connection(self.a, newcomer, status=ACCEPTED)
        Participant.objects.create(
            conversation=self.convo, user=newcomer, status="pending"
        )

        self.client.force_authenticate(newcomer)
        resp = self.detail()
        self.assertEqual(resp.data["my_status"], "pending")
        for row in resp.data["participants"]:
            self.assertNotIn("last_read_at", row)
            self.assertNotIn("active_since", row)

    def test_a_pending_member_is_reported_to_nobody(self):
        """🔒 The other side of the rule above. A member still in the waiting
        room can't read a message here, so their read state isn't ours to hand
        out — and it can be a *real* timestamp, because someone who drops back
        to pending keeps the marker from their last active spell. The clients
        skip pending rows when computing ticks anyway; this asserts the half
        that doesn't depend on them doing so."""
        self.client.force_authenticate(self.c)
        self.client.post(read_url(self.convo))
        self.assertTrue(
            ConversationRead.objects.filter(
                conversation=self.convo, user=self.c
            ).exists()
        )
        Participant.objects.filter(pk=self.c_row.pk).update(status="pending")
        ParticipantInterval.objects.filter(participant=self.c_row).update(
            ended_at=timezone.now()
        )

        self.client.force_authenticate(self.a)
        rows = {p["id"]: p for p in self.detail().data["participants"]}
        self.assertEqual(rows[self.c.pk]["status"], "pending")
        self.assertNotIn("last_read_at", rows[self.c.pk])
        self.assertNotIn("active_since", rows[self.c.pk])
        # The rest of the group is unaffected — one person's state going quiet
        # isn't a reason to stop reporting everyone else's.
        self.assertIn("last_read_at", rows[self.b.pk])

    def test_an_active_member_between_intervals_reports_no_join_time(self):
        """An active member whose interval has been closed has no
        ``active_since`` to give — so the client leaves them out of the audience
        rather than waiting on someone who currently can't read. (Contrast the
        test above: dropping to *pending* withholds the whole receipt, not just
        the join time.)"""
        ParticipantInterval.objects.filter(participant=self.c_row).update(
            ended_at=timezone.now()
        )
        rows = {p["id"]: p for p in self.detail().data["participants"]}
        self.assertIsNone(rows[self.c.pk]["active_since"])


class UnreadAndListTests(MessagingBase):
    def setUp(self):
        super().setUp()
        self.convo = Conversation.objects.create(
            user_a=self.me, user_b=self.friend
        )

    def _friend_sends(self, text):
        self.client.force_authenticate(self.friend)
        self.client.post(messages_url(self.convo), {"text": text})
        self.client.force_authenticate(self.me)

    def test_unread_count_and_mark_read(self):
        self._friend_sends("hey")
        self._friend_sends("you there?")
        listing = self.client.get(CONVERSATIONS_URL)
        self.assertEqual(listing.data["results"][0]["unread_count"], 2)
        self.assertEqual(self.client.get(UNREAD_COUNT_URL).data["count"], 2)
        # Marking read clears it.
        self.assertEqual(
            self.client.post(read_url(self.convo)).status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(self.client.get(UNREAD_COUNT_URL).data["count"], 0)
        self.assertTrue(
            ConversationRead.objects.filter(
                conversation=self.convo, user=self.me
            ).exists()
        )

    def test_your_own_messages_are_not_unread(self):
        self.client.post(messages_url(self.convo), {"text": "mine"})
        self.assertEqual(self.client.get(UNREAD_COUNT_URL).data["count"], 0)

    def test_deleted_messages_do_not_count_as_unread(self):
        self._friend_sends("boo")
        msg = Message.objects.get()
        msg.text = ""
        msg.deleted_at = timezone.now()
        msg.save(update_fields=["text", "deleted_at"])
        self.assertEqual(self.client.get(UNREAD_COUNT_URL).data["count"], 0)

    def test_list_shows_preview_and_orders_by_activity(self):
        other_friend = make_user("other@example.com")
        make_connection(self.me, other_friend, status=ACCEPTED)
        convo2 = Conversation.objects.create(
            user_a=self.me, user_b=other_friend
        )
        # Send in convo (older) then convo2 (newer) — convo2 should lead.
        self.client.post(messages_url(self.convo), {"text": "older"})
        self.client.post(messages_url(convo2), {"text": "newer"})
        results = self.client.get(CONVERSATIONS_URL).data["results"]
        self.assertEqual(results[0]["id"], convo2.pk)
        self.assertEqual(results[0]["last_message"]["text"], "newer")


class BlockTests(MessagingBase):
    def test_block_prevents_messaging_both_ways(self):
        convo = Conversation.objects.create(user_a=self.me, user_b=self.friend)
        self.client.post(block_url(self.friend))
        # I can't send…
        self.assertEqual(
            self.client.post(messages_url(convo), {"text": "x"}).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        # …and the blocked user can't either (thread hidden from them too).
        self.client.force_authenticate(self.friend)
        self.assertEqual(
            self.client.post(messages_url(convo), {"text": "y"}).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_block_hides_conversation_from_the_list(self):
        Conversation.objects.create(user_a=self.me, user_b=self.friend)
        self.client.post(block_url(self.friend))
        self.assertEqual(self.client.get(CONVERSATIONS_URL).data["count"], 0)

    def test_block_severs_connection_and_bars_reconnecting(self):
        self.client.post(block_url(self.friend))
        self.assertFalse(
            Connection.objects.filter(
                Q(requester=self.me, requestee=self.friend)
                | Q(requester=self.friend, requestee=self.me)
            ).exists()
        )
        # Trying to reconnect while blocked is forbidden.
        resp = self.client.post(connect_url(self.friend))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_open_conversation_with_a_blocked_user(self):
        self.client.post(block_url(self.friend))
        resp = self.open_with(self.friend)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_unblock_lifts_only_your_own_block(self):
        # friend blocks me; my unblock must not clear their block.
        self.client.force_authenticate(self.friend)
        self.client.post(block_url(self.me))
        self.client.force_authenticate(self.me)
        self.client.delete(block_url(self.friend))
        self.assertTrue(
            Block.objects.filter(blocker=self.friend, blocked=self.me).exists()
        )

    def test_cannot_block_yourself(self):
        resp = self.client.post(block_url(self.me))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


class BlockedThreadWriteTests(MessagingBase):
    """🔒 A block takes the thread away from **both** sides — for writes as well
    as reads.

    The read routes had this from Phase 5; the read-marker, mute and leave
    routes resolved the thread with a membership-only lookup and so kept
    answering on a thread the block had already hidden. Blocking is the safety
    feature, so it can't be the one gate a write path skips: these assert the
    per-thread routes agree, from the blocked party's side (the side that
    matters — they're the one the block is protecting against).
    """

    def setUp(self):
        super().setUp()
        # friend and I have a real thread with a message from them, then they
        # block me. Everything below runs as *me*, the blocked party.
        resp = self.open_with(self.friend)
        self.convo = Conversation.objects.get(pk=resp.data["id"])
        Message.objects.create(
            conversation=self.convo, sender=self.friend, text="hi"
        )
        self.client.force_authenticate(self.friend)
        self.client.post(block_url(self.me))
        self.client.force_authenticate(self.me)

    def mute_url(self):
        return f"/api/conversations/{self.convo.pk}/mute/"

    def test_the_reads_hide_it(self):
        # The Phase 5 behaviour these writes have to match.
        self.assertEqual(self.client.get(CONVERSATIONS_URL).data["count"], 0)
        self.assertEqual(
            self.client.get(f"/api/conversations/{self.convo.pk}/").status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.get(messages_url(self.convo)).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_marking_read_cannot_move_a_receipt_on_a_blocked_thread(self):
        # POST /read/ writes ConversationRead, which *is* the read receipt the
        # other side sees — so this let a blocked party move a tick that
        # surfaces to the blocker the moment the block is lifted.
        resp = self.client.post(read_url(self.convo))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(
            ConversationRead.objects.filter(
                conversation=self.convo, user=self.me
            ).exists()
        )

    def test_marking_unread_cannot_probe_a_blocked_thread(self):
        # The 200-with-a-count vs 400 split was a yes/no oracle for "does the
        # person who blocked me still have an undeleted message waiting for
        # me" — answered off a thread that 404s everywhere else.
        resp = self.client.delete(read_url(self.convo))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn("unread_count", resp.data)

    def test_muting_a_blocked_thread_is_gone_too(self):
        for method in (self.client.post, self.client.delete):
            resp = method(self.mute_url())
            self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(
            Participant.objects.filter(
                conversation=self.convo, user=self.me, muted_at__isnull=False
            ).exists()
        )

    def test_leaving_a_blocked_thread_cannot_mutate_participant_state(self):
        # Leave resolved a raw Participant row, which a block never touches on
        # a direct thread — so it closed the access interval and tombstoned the
        # row on a thread 404'd everywhere else. Whether leaving a 1:1 should
        # exist at all is #210; this is only that it can't happen here.
        resp = self.client.post(f"/api/conversations/{self.convo.pk}/leave/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(
            Participant.objects.filter(
                conversation=self.convo, user=self.me, left_at__isnull=False
            ).exists()
        )

    def test_a_deactivated_other_party_hides_the_thread_the_same_way(self):
        # The list has always dropped a direct thread whose other party went
        # inactive; the per-thread routes didn't, so the transcript stayed
        # readable to anyone holding the id. One rule, one place, now.
        self.client.force_authenticate(self.friend)
        self.client.delete(block_url(self.me))  # lift the block…
        User.objects.filter(pk=self.friend.pk).update(is_active=False)
        self.client.force_authenticate(self.me)

        self.assertEqual(self.client.get(CONVERSATIONS_URL).data["count"], 0)
        self.assertEqual(
            self.client.get(messages_url(self.convo)).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.post(read_url(self.convo)).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_a_group_chat_is_untouched_by_any_of_this(self):
        # The rule is direct-only: a group chat has no "other party", and a
        # block between two of its members must not take the whole chat away
        # from everyone. Guards against over-tightening the shared helper.
        third = make_user("third@example.com")
        for pair in ((self.me, third), (self.friend, third)):
            make_connection(*pair, status=ACCEPTED)
        convo = Conversation.objects.create(kind=Conversation.Kind.GROUP)
        for user in (self.me, self.friend, third):
            Participant.objects.create(
                conversation=convo, user=user, status=Participant.Status.ACTIVE
            )
        Message.objects.create(conversation=convo, sender=third, text="hello all")

        self.assertEqual(
            self.client.get(messages_url(convo)).status_code, status.HTTP_200_OK
        )
        self.assertEqual(
            self.client.post(read_url(convo)).status_code, status.HTTP_200_OK
        )
        self.assertEqual(
            self.client.post(f"/api/conversations/{convo.pk}/mute/").status_code,
            status.HTTP_200_OK,
        )


class MessagingAuthRequiredTests(APITestCase):
    def test_conversations_require_login(self):
        self.assertEqual(
            self.client.get(CONVERSATIONS_URL).status_code,
            status.HTTP_401_UNAUTHORIZED,
        )


# --- Groups (Phase 6) --------------------------------------------------------

GROUPS_URL = "/api/groups/"
GROUP_INVITES_URL = "/api/group-invites/"

ADMIN_ROLE = GroupMembership.Role.ADMIN
MEMBER_ROLE = GroupMembership.Role.MEMBER
ACTIVE_STATUS = GroupMembership.Status.ACTIVE
INVITED_STATUS = GroupMembership.Status.INVITED


def group_url(g):
    return f"/api/groups/{g.pk}/"


def group_posts_url(g):
    return f"/api/groups/{g.pk}/posts/"


def group_members_url(g):
    return f"/api/groups/{g.pk}/members/"


def group_member_url(g, u):
    return f"/api/groups/{g.pk}/members/{u.pk}/"


def group_role_url(g, u):
    return f"/api/groups/{g.pk}/members/{u.pk}/role/"


def invite_accept_url(m):
    return f"/api/group-invites/{m.pk}/accept/"


def invite_reject_url(m):
    return f"/api/group-invites/{m.pk}/reject/"


def make_group(creator, name="Family", **kwargs):
    """A group with its creator as the first active admin (as the API does)."""
    group = Group.objects.create(creator=creator, name=name, **kwargs)
    GroupMembership.objects.create(
        group=group, user=creator, role=ADMIN_ROLE, status=ACTIVE_STATUS
    )
    return group


def add_member(group, user, role=MEMBER_ROLE, status=ACTIVE_STATUS, invited_by=None):
    return GroupMembership.objects.create(
        group=group, user=user, role=role, status=status, invited_by=invited_by
    )


class GroupCreateListTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.client.force_authenticate(self.me)

    def test_create_makes_creator_an_active_admin(self):
        resp = self.client.post(GROUPS_URL, {"name": "  Book Club "})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "Book Club")  # trimmed
        self.assertEqual(resp.data["your_role"], ADMIN_ROLE)
        self.assertEqual(resp.data["member_count"], 1)
        membership = GroupMembership.objects.get(
            group_id=resp.data["id"], user=self.me
        )
        self.assertEqual(membership.role, ADMIN_ROLE)
        self.assertEqual(membership.status, ACTIVE_STATUS)

    def test_create_requires_a_name(self):
        resp = self.client.post(GROUPS_URL, {"name": "   "})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_list_shows_only_groups_i_am_an_active_member_of(self):
        mine = make_group(self.me, name="Mine")
        other_owner = make_user("owner@example.com")
        theirs = make_group(other_owner, name="Theirs")
        # A group I'm only *invited* to shouldn't count as membership.
        invited_to = make_group(other_owner, name="Invited")
        add_member(invited_to, self.me, status=INVITED_STATUS)

        resp = self.client.get(GROUPS_URL)
        ids = {g["id"] for g in resp.data["results"]}
        self.assertEqual(ids, {mine.id})
        self.assertNotIn(theirs.id, ids)
        self.assertNotIn(invited_to.id, ids)

    def test_member_count_counts_active_members_only(self):
        group = make_group(self.me)
        friend = make_user("friend@example.com")
        add_member(group, friend, status=ACTIVE_STATUS)
        add_member(group, make_user("pending@example.com"), status=INVITED_STATUS)
        resp = self.client.get(GROUPS_URL)
        row = next(g for g in resp.data["results"] if g["id"] == group.id)
        self.assertEqual(row["member_count"], 2)


class GroupDetailPermissionTests(APITestCase):
    def setUp(self):
        self.admin = make_user("admin@example.com")
        self.member = make_user("member@example.com")
        self.stranger = make_user("stranger@example.com")
        self.group = make_group(self.admin, name="Secret")
        add_member(self.group, self.member)

    def test_non_member_gets_404_on_detail(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.get(group_url(self.group))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_member_sees_detail_with_their_role(self):
        self.client.force_authenticate(self.member)
        resp = self.client.get(group_url(self.group))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["your_role"], MEMBER_ROLE)
        self.assertEqual(resp.data["member_count"], 2)

    def test_only_admin_can_edit(self):
        self.client.force_authenticate(self.member)
        resp = self.client.patch(group_url(self.group), {"name": "Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

        self.client.force_authenticate(self.admin)
        resp = self.client.patch(group_url(self.group), {"name": "Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "Renamed")

    def test_only_admin_can_delete(self):
        self.client.force_authenticate(self.member)
        self.assertEqual(
            self.client.delete(group_url(self.group)).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.client.force_authenticate(self.admin)
        self.assertEqual(
            self.client.delete(group_url(self.group)).status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(Group.objects.filter(pk=self.group.pk).exists())

    def test_deleting_a_group_removes_its_posts(self):
        post = Post.objects.create(
            author=self.admin, text="in group", group=self.group
        )
        self.client.force_authenticate(self.admin)
        self.client.delete(group_url(self.group))
        self.assertFalse(Post.objects.filter(pk=post.pk).exists())


class GroupTimelineTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, ACCEPTED)
        self.group = make_group(self.me, name="Trip")
        add_member(self.group, self.friend)
        self.client.force_authenticate(self.me)

    def test_member_can_post_into_group(self):
        resp = self.client.post(
            POSTS_URL, {"text": "hello group", "group": self.group.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["group"]["id"], self.group.id)
        self.assertEqual(resp.data["group"]["name"], self.group.name)
        self.assertTrue(
            Post.objects.filter(group=self.group, text="hello group").exists()
        )

    def test_non_member_cannot_post_into_group(self):
        # 404 (not 403) so posting can't probe which private groups exist — a
        # non-member gets the same answer whether or not the group is real.
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(
            POSTS_URL, {"text": "sneaking in", "group": self.group.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Post.objects.filter(text="sneaking in").exists())

    def test_group_timeline_lists_group_posts_for_members(self):
        Post.objects.create(author=self.me, text="mine", group=self.group)
        Post.objects.create(author=self.friend, text="theirs", group=self.group)
        resp = self.client.get(group_posts_url(self.group))
        texts = {p["text"] for p in resp.data["results"]}
        self.assertEqual(texts, {"mine", "theirs"})

    def test_group_timeline_hides_a_non_connected_members_posts(self):
        # A co-member I'm not connected with: their group posts are gated out,
        # same as everywhere else — a group is not a way around the connection
        # rule (Phase 6 decision).
        acquaintance = make_user("acq@example.com")
        add_member(self.group, acquaintance)
        Post.objects.create(author=self.me, text="mine", group=self.group)
        Post.objects.create(
            author=acquaintance, text="from an acquaintance", group=self.group
        )
        resp = self.client.get(group_posts_url(self.group))
        texts = {p["text"] for p in resp.data["results"]}
        self.assertEqual(texts, {"mine"})

    def test_include_groups_hides_a_non_connected_members_posts(self):
        # The same gate holds when the group posts are merged into the home feed.
        acquaintance = make_user("acq@example.com")
        add_member(self.group, acquaintance)
        mine = Post.objects.create(author=self.me, text="mine", group=self.group)
        theirs = Post.objects.create(
            author=acquaintance, text="theirs", group=self.group
        )
        resp = self.client.get(FEED_URL + "?include_groups=1")
        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(mine.id, ids)
        self.assertNotIn(theirs.id, ids)

    def test_group_timeline_404_for_non_member(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.get(group_posts_url(self.group))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_group_posts_stay_out_of_the_home_feed(self):
        # The load-bearing decision: a group post must NOT appear in a member's
        # home feed, even though the poster is a connection.
        group_post = Post.objects.create(
            author=self.friend, text="group only", group=self.group
        )
        personal_post = Post.objects.create(author=self.friend, text="personal")
        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(personal_post.id, ids)
        self.assertNotIn(group_post.id, ids)

    def test_group_posts_stay_off_the_profile(self):
        group_post = Post.objects.create(
            author=self.friend, text="group only", group=self.group
        )
        personal_post = Post.objects.create(author=self.friend, text="personal")
        resp = self.client.get(f"/api/users/{self.friend.pk}/posts/")
        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(personal_post.id, ids)
        self.assertNotIn(group_post.id, ids)

    def test_include_groups_merges_group_posts_chronologically(self):
        # Opt-in: ?include_groups=1 merges posts from groups I'm in into the
        # feed, still time-ordered — but only for groups I actually belong to.
        my_group_post = Post.objects.create(
            author=self.friend, text="in my group", group=self.group
        )
        # A group I'm NOT a member of must never leak in, even via the toggle.
        outsider = make_user("outsider@example.com")
        other_group = make_group(outsider, name="Not mine")
        hidden_post = Post.objects.create(
            author=outsider, text="secret", group=other_group
        )
        personal = Post.objects.create(author=self.me, text="personal")

        # Default feed: no group posts.
        resp = self.client.get(FEED_URL)
        ids = {p["id"] for p in resp.data["results"]}
        self.assertEqual(ids, {personal.id})

        # Opted in: my group's post appears, the outsider group's never does.
        resp = self.client.get(FEED_URL + "?include_groups=1")
        ids = {p["id"] for p in resp.data["results"]}
        self.assertIn(my_group_post.id, ids)
        self.assertIn(personal.id, ids)
        self.assertNotIn(hidden_post.id, ids)


class GroupInviteTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.me, self.friend, ACCEPTED)
        self.group = make_group(self.me, name="Crew")
        self.client.force_authenticate(self.me)

    def test_invite_a_connection_creates_pending_membership(self):
        resp = self.client.post(
            group_members_url(self.group), {"user_id": self.friend.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        m = GroupMembership.objects.get(group=self.group, user=self.friend)
        self.assertEqual(m.status, INVITED_STATUS)
        self.assertEqual(m.invited_by, self.me)

    def test_cannot_invite_a_non_connection(self):
        resp = self.client.post(
            group_members_url(self.group), {"user_id": self.stranger.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(
            GroupMembership.objects.filter(
                group=self.group, user=self.stranger
            ).exists()
        )

    def test_cannot_invite_a_blocked_connection(self):
        self.client.post(block_url(self.friend))  # blocking severs the connection
        resp = self.client.post(
            group_members_url(self.group), {"user_id": self.friend.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_any_member_can_invite_their_own_connection(self):
        # friend (a plain member) invites their own connection — allowed.
        friend2 = make_user("friend2@example.com")
        make_connection(self.friend, friend2, ACCEPTED)
        add_member(self.group, self.friend)
        self.client.force_authenticate(self.friend)
        resp = self.client.post(
            group_members_url(self.group), {"user_id": friend2.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_duplicate_invite_rejected(self):
        add_member(self.group, self.friend, status=INVITED_STATUS)
        resp = self.client.post(
            group_members_url(self.group), {"user_id": self.friend.id}
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_invite_inbox_lists_pending_and_accept_joins(self):
        invite = add_member(
            self.group, self.friend, status=INVITED_STATUS, invited_by=self.me
        )
        self.client.force_authenticate(self.friend)
        resp = self.client.get(GROUP_INVITES_URL)
        ids = {i["id"] for i in resp.data["results"]}
        self.assertIn(invite.id, ids)

        resp = self.client.post(invite_accept_url(invite))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        invite.refresh_from_db()
        self.assertEqual(invite.status, ACTIVE_STATUS)

    def test_reject_invite_deletes_it(self):
        invite = add_member(self.group, self.friend, status=INVITED_STATUS)
        self.client.force_authenticate(self.friend)
        resp = self.client.post(invite_reject_url(invite))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(GroupMembership.objects.filter(pk=invite.pk).exists())

    def test_cannot_act_on_someone_elses_invite(self):
        invite = add_member(self.group, self.friend, status=INVITED_STATUS)
        # stranger tries to accept the friend's invite
        self.client.force_authenticate(self.stranger)
        resp = self.client.post(invite_accept_url(invite))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class GroupMembershipManagementTests(APITestCase):
    def setUp(self):
        self.admin = make_user("admin@example.com")
        self.member = make_user("member@example.com")
        self.group = make_group(self.admin, name="Team")
        add_member(self.group, self.member)

    def test_member_can_leave(self):
        self.client.force_authenticate(self.member)
        resp = self.client.delete(group_member_url(self.group, self.member))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(
            GroupMembership.objects.filter(
                group=self.group, user=self.member
            ).exists()
        )

    def test_members_list_excludes_deactivated_users(self):
        # A member who is later deactivated/banned drops out of the roster, the
        # same as they vanish from feeds and comments.
        self.member.is_active = False
        self.member.save(update_fields=["is_active"])
        self.client.force_authenticate(self.admin)
        resp = self.client.get(group_members_url(self.group))
        ids = {m["user"]["id"] for m in resp.data}
        self.assertIn(self.admin.id, ids)
        self.assertNotIn(self.member.id, ids)

    def test_admin_can_remove_a_member(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.delete(group_member_url(self.group, self.member))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_member_cannot_remove_someone_else(self):
        other = make_user("other@example.com")
        add_member(self.group, other)
        self.client.force_authenticate(self.member)
        resp = self.client.delete(group_member_url(self.group, other))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_last_admin_cannot_leave(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.delete(group_member_url(self.group, self.admin))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(
            GroupMembership.objects.filter(
                group=self.group, user=self.admin
            ).exists()
        )

    def test_admin_can_leave_after_promoting_another(self):
        self.client.force_authenticate(self.admin)
        self.client.post(
            group_role_url(self.group, self.member), {"role": ADMIN_ROLE}
        )
        resp = self.client.delete(group_member_url(self.group, self.admin))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_admin_can_promote_and_demote(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.post(
            group_role_url(self.group, self.member), {"role": ADMIN_ROLE}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(is_admin(self.group, self.member))
        # Demote back down (still one other admin remains).
        resp = self.client.post(
            group_role_url(self.group, self.member), {"role": MEMBER_ROLE}
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(is_admin(self.group, self.member))

    def test_cannot_demote_the_last_admin(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.post(
            group_role_url(self.group, self.admin), {"role": MEMBER_ROLE}
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_member_cannot_change_roles(self):
        self.client.force_authenticate(self.member)
        resp = self.client.post(
            group_role_url(self.group, self.admin), {"role": MEMBER_ROLE}
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class GroupCommentVisibilityTests(APITestCase):
    """Inside a group, comments prune to the viewer's connections — you see
    comments (and can comment) only on posts by members you're connected with,
    matching the connection-gated timeline (Phase 6 decision)."""

    def setUp(self):
        # a owns the group. b is a connected member; c is a member but NOT
        # connected to a. The post is a's.
        self.a = make_user("a@example.com")
        self.b = make_user("b@example.com")
        self.c = make_user("c@example.com")
        self.stranger = make_user("stranger@example.com")
        make_connection(self.a, self.b, ACCEPTED)
        self.group = make_group(self.a, name="Shared")
        add_member(self.group, self.b)
        add_member(self.group, self.c)
        self.post = Post.objects.create(
            author=self.a, text="group post", group=self.group
        )

    def test_sees_comment_from_a_connected_member(self):
        Comment.objects.create(author=self.b, post=self.post, text="hi from b")
        self.client.force_authenticate(self.a)
        resp = self.client.get(comments_url(self.post))
        texts = {c["text"] for c in resp.data}
        self.assertIn("hi from b", texts)

    def test_hides_comment_from_a_non_connected_member(self):
        # b comments on a's post; c (a member, but not connected to a) can't see
        # a's post at all, so c is served nothing here.
        Comment.objects.create(author=self.b, post=self.post, text="hi from b")
        self.client.force_authenticate(self.c)
        resp = self.client.get(comments_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_connected_member_can_comment_on_a_visible_post(self):
        self.client.force_authenticate(self.b)
        resp = self.client.post(comments_url(self.post), {"text": "nice"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_member_cannot_comment_on_a_post_they_cannot_see(self):
        # c is a member but not connected to the author, so a's post isn't
        # visible to them — they can't comment on it (404, same as reading).
        self.client.force_authenticate(self.c)
        resp = self.client.post(comments_url(self.post), {"text": "hi"})
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_non_member_cannot_read_or_comment(self):
        self.client.force_authenticate(self.stranger)
        self.assertEqual(
            self.client.get(comments_url(self.post)).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.post(
                comments_url(self.post), {"text": "hi"}
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )


class GroupAuthRequiredTests(APITestCase):
    def test_groups_require_login(self):
        self.assertEqual(
            self.client.get(GROUPS_URL).status_code,
            status.HTTP_401_UNAUTHORIZED,
        )
        self.assertEqual(
            self.client.get(GROUP_INVITES_URL).status_code,
            status.HTTP_401_UNAUTHORIZED,
        )


class GroupChatModelTests(APITestCase):
    def test_conversation_defaults_to_direct_kind(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        convo = Conversation.objects.create(user_a=a, user_b=b)
        self.assertEqual(convo.kind, "direct")
        self.assertIsNone(convo.group)

    def test_participant_and_interval_round_trip(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        convo = Conversation.objects.create(kind="group", created_by=a)
        p = Participant.objects.create(conversation=convo, user=a, status="active")
        ParticipantInterval.objects.create(participant=p, started_at=timezone.now())
        self.assertEqual(convo.participants.count(), 1)
        self.assertEqual(p.intervals.count(), 1)
        self.assertIsNone(p.intervals.first().ended_at)


def is_admin(group, user):
    return GroupMembership.objects.filter(
        group=group, user=user, role=ADMIN_ROLE, status=ACTIVE_STATUS
    ).exists()


class BackfillParticipantsMigrationTests(APITestCase):
    def test_existing_conversation_gets_two_active_participants(self):
        # A conversation created "before" the backfill (rows already exist).
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        convo = Conversation.objects.create(user_a=a, user_b=b)
        Participant.objects.filter(conversation=convo).delete()  # simulate pre-migration

        # Re-run the data migration's forward function directly.
        from api.migrations._backfill import _backfill

        _backfill(Conversation, Participant, ParticipantInterval)

        parts = Participant.objects.filter(conversation=convo)
        self.assertEqual(parts.count(), 2)
        self.assertTrue(all(p.status == "active" for p in parts))
        for p in parts:
            iv = p.intervals.get()
            self.assertEqual(iv.started_at, convo.created_at)
            self.assertIsNone(iv.ended_at)


class MembershipHelperTests(APITestCase):
    def _connect(self, u1, u2):
        Connection.objects.create(requester=u1, requestee=u2, status="accepted")

    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD)

    def test_promote_requires_connection_to_all_actives(self):
        # a connected to b and c; b and c NOT connected to each other.
        self._connect(self.a, self.b)
        self._connect(self.a, self.c)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        pa = Participant.objects.create(conversation=convo, user=self.a, status="active")
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        Participant.objects.create(conversation=convo, user=self.b, status="pending")
        Participant.objects.create(conversation=convo, user=self.c, status="pending")

        promote_participants(convo, timezone.now())

        # First pending connected to all actives {a} → promotes (now active {a,b}).
        # Second pending must connect to {a,b}; not connected to b → stays pending.
        actives = active_participant_ids(convo)
        self.assertEqual(len(actives), 2)
        self.assertIn(self.a.id, actives)

    def test_must_connect_with_lists_unconnected_actives(self):
        self._connect(self.a, self.b)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        for u, st in [(self.a, "active"), (self.b, "active"), (self.c, "pending")]:
            p = Participant.objects.create(conversation=convo, user=u, status=st)
            if st == "active":
                ParticipantInterval.objects.create(participant=p, started_at=timezone.now())
        # c is connected to nobody active → must connect with a and b.
        ids = {u.id for u in must_connect_with(convo, self.c)}
        self.assertEqual(ids, {self.a.id, self.b.id})

    def test_visible_messages_clipped_to_intervals(self):
        self._connect(self.a, self.b)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        pa = Participant.objects.create(conversation=convo, user=self.a, status="active")
        pb = Participant.objects.create(conversation=convo, user=self.b, status="active")
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        t0 = timezone.now()
        ParticipantInterval.objects.create(participant=pb, started_at=t0)
        m1 = Message.objects.create(conversation=convo, sender=self.a, text="in")
        # Close b's interval, send a gap message, reopen.
        deactivate(pb, timezone.now())
        m_gap = Message.objects.create(conversation=convo, sender=self.a, text="gap")
        activate(pb, timezone.now())
        m2 = Message.objects.create(conversation=convo, sender=self.a, text="back")

        visible_ids = set(visible_messages_for(convo, self.b).values_list("id", flat=True))
        self.assertIn(m1.id, visible_ids)
        self.assertNotIn(m_gap.id, visible_ids)
        self.assertIn(m2.id, visible_ids)


class CreateGroupChatTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD, first_name="A", last_name="A")
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD, first_name="B", last_name="B")
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD, first_name="C", last_name="C")
        for u in (self.b, self.c):
            Connection.objects.create(requester=self.a, requestee=u, status="accepted")
        self.client.force_authenticate(self.a)

    def test_create_group_chat_creator_active_invitees_promoted_per_clique(self):
        # b and c are NOT connected to each other.
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id], "title": "Trip"}, format="json")
        self.assertEqual(res.status_code, 201)
        convo = Conversation.objects.get(id=res.data["id"])
        self.assertEqual(convo.kind, "group")
        self.assertEqual(convo.title, "Trip")
        actives = set(convo.participants.filter(status="active").values_list("user_id", flat=True))
        # a (creator) + exactly one of b/c can be active; the other stays pending.
        self.assertIn(self.a.id, actives)
        self.assertEqual(len(actives), 2)
        self.assertEqual(convo.participants.filter(status="pending").count(), 1)

    def test_cannot_add_a_non_connection(self):
        stranger = User.objects.create_user(email="s@x.com", password=PASSWORD)
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [stranger.id]}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_group_scoped_requires_group_membership(self):
        group = Group.objects.create(name="Fam", creator=self.a)
        GroupMembership.objects.create(group=group, user=self.a, role="admin", status="active")
        # b is a connection but not a group member.
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id], "group_id": group.id}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_all_invitees_filtered_out_is_rejected_not_a_group_of_one(self):
        """Finding: if every id resolves to nothing real (unknown/inactive/
        yourself), the create must 400 rather than silently making a lone-
        creator 'group chat of one'."""
        res = self.client.post(
            CONVERSATIONS_URL,
            {"participant_ids": [999999, self.a.id]},
            format="json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(Conversation.objects.count(), 0)


class GroupChatViewTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD, first_name="A", last_name="A")
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD, first_name="B", last_name="B")
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD, first_name="C", last_name="C")
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        Connection.objects.create(requester=self.a, requestee=self.c, status="accepted")
        self.client.force_authenticate(self.a)
        self.convo_id = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id], "title": "T"}, format="json"
        ).data["id"]

    def test_list_includes_group_chat_with_my_status_active(self):
        res = self.client.get(CONVERSATIONS_URL)
        row = [c for c in res.data["results"] if c["id"] == self.convo_id][0]
        self.assertEqual(row["kind"], "group")
        self.assertEqual(row["my_status"], "active")

    def test_pending_member_sees_locked_chat_and_cannot_read_messages(self):
        # c is pending (not connected to b). Send a message as a.
        self.client.post(f"/api/conversations/{self.convo_id}/messages/", {"text": "hi"}, format="json")
        self.client.force_authenticate(self.c)
        detail = self.client.get(f"/api/conversations/{self.convo_id}/")
        self.assertEqual(detail.data["my_status"], "pending")
        self.assertEqual({u["id"] for u in detail.data["must_connect_with"]}, {self.b.id})
        msgs = self.client.get(f"/api/conversations/{self.convo_id}/messages/")
        self.assertEqual(msgs.status_code, 403)

    def test_a_promotion_tie_is_broken_by_invite_order(self):
        # b and c are each connected to a but not to each other, so exactly one
        # can be promoted — admitting either keeps the clique intact, and the
        # rule alone doesn't say which. Left unordered, Postgres decided, and
        # this suite failed intermittently. First invited wins.
        detail = self.client.get(f"/api/conversations/{self.convo_id}/")
        by_user = {p["id"]: p["status"] for p in detail.data["participants"]}
        first, second = sorted([self.b.id, self.c.id])

        self.assertEqual(by_user[first], "active")
        self.assertEqual(by_user[second], "pending")

    def test_pending_member_does_not_get_last_message_text_leaked(self):
        """Finding: the ``last_message`` preview must be interval-clipped to
        what the viewer may see. A pending member is blocked from every message,
        so their list/detail payload must not carry the text of a message they
        can't read."""
        self.client.post(
            f"/api/conversations/{self.convo_id}/messages/",
            {"text": "secret plans"},
            format="json",
        )
        self.client.force_authenticate(self.c)  # pending
        detail = self.client.get(f"/api/conversations/{self.convo_id}/")
        self.assertEqual(detail.data["my_status"], "pending")
        self.assertIsNone(detail.data["last_message"])
        row = [
            c
            for c in self.client.get(CONVERSATIONS_URL).data["results"]
            if c["id"] == self.convo_id
        ][0]
        self.assertIsNone(row["last_message"])

    def test_active_member_reads_only_their_interval(self):
        self.client.post(f"/api/conversations/{self.convo_id}/messages/", {"text": "one"}, format="json")
        res = self.client.get(f"/api/conversations/{self.convo_id}/messages/")
        self.assertEqual(len(res.data["results"]), 1)

    def test_active_member_can_mark_group_chat_read(self):
        """Finding 2 regression: ConversationReadView used to resolve the
        conversation via the legacy user_a/user_b pair only, which always
        404s for a group chat (null user_a/user_b) — a passive member who
        only reads, never sends, could never clear their unread badge."""
        # Use a dedicated chat where b is the *sole* invitee, so b is
        # deterministically promoted to active. setUp's convo invites both b
        # and c, who aren't connected to each other, so exactly one of them
        # promotes — and which one is non-deterministic (the promotion sweep
        # has no ordered tie-break). Reusing it made this test flaky: when c
        # won the race, b stayed pending and saw an unread count of 0.
        convo_id = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": [self.b.id], "title": "T2"}, format="json"
        ).data["id"]
        self.client.post(f"/api/conversations/{convo_id}/messages/", {"text": "hi"}, format="json")
        self.client.force_authenticate(self.b)
        unread_before = self.client.get(UNREAD_COUNT_URL)
        self.assertGreaterEqual(unread_before.data["count"], 1)

        res = self.client.post(f"/api/conversations/{convo_id}/read/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        unread_after = self.client.get(UNREAD_COUNT_URL)
        self.assertEqual(unread_after.data["count"], 0)


class AddParticipantsTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.d = User.objects.create_user(email="d@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        Connection.objects.create(requester=self.a, requestee=self.d, status="accepted")
        Connection.objects.create(requester=self.b, requestee=self.d, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id]}, format="json").data["id"]

    def test_active_member_adds_a_mutual_connection(self):
        res = self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [self.d.id]}, format="json")
        self.assertEqual(res.status_code, 200)
        convo = Conversation.objects.get(id=self.cid)
        # d connected to a and b → promotes straight to active.
        self.assertIn(self.d.id, set(convo.participants.filter(status="active").values_list("user_id", flat=True)))

    def test_non_member_cannot_add(self):
        self.client.force_authenticate(self.d)
        res = self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [self.b.id]}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_re_add_after_leave_resets_left_at(self):
        # b leaves, then a (still active) re-adds them — must not silently
        # no-op via get_or_create finding the tombstoned row.
        self.client.force_authenticate(self.b)
        self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.client.force_authenticate(self.a)
        res = self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [self.b.id]}, format="json")
        self.assertEqual(res.status_code, 200)
        p = Participant.objects.get(conversation_id=self.cid, user=self.b)
        self.assertIsNone(p.left_at)
        self.assertIn(p.status, ("active", "pending"))


class DirectChatParticipantsTests(APITestCase):
    """🔒 A 1:1 is closed. Nobody can be added to someone else's private thread.

    ``ConversationParticipantsView`` checked only that the caller was an active
    participant — never that the chat was a *group*. Every direct thread has two
    active Participant rows, so one half of a 1:1 could POST a third user's id
    at their own conversation and put a stranger in it. The other party got no
    say and no signal: a direct thread's UI shows no sender attribution and
    names nobody in its header, so the newcomer was visible only to someone who
    thought to open the info panel — while seeing every message sent from that
    moment on.

    Both clients have always hidden "Add people" on a 1:1, so the server was
    strictly more permissive than anything the product promised.
    """

    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        # c is connected to both, so the clique rule would happily promote them
        # straight to active — the guard, not a lack of connections, is what has
        # to stop this.
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        Connection.objects.create(requester=self.a, requestee=self.c, status="accepted")
        Connection.objects.create(requester=self.b, requestee=self.c, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(
            CONVERSATIONS_URL, {"user_id": self.b.id}, format="json"
        ).data["id"]

    def test_a_third_person_cannot_be_added_to_a_1to1(self):
        resp = self.client.post(
            f"/api/conversations/{self.cid}/participants/",
            {"user_ids": [self.c.id]},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(
            Participant.objects.filter(conversation_id=self.cid, user=self.c).exists()
        )

    def test_the_would_be_addition_cannot_read_the_thread(self):
        # The consequence the guard exists to prevent, asserted end to end.
        self.client.post(
            f"/api/conversations/{self.cid}/messages/",
            {"text": "just between us"},
            format="json",
        )
        self.client.post(
            f"/api/conversations/{self.cid}/participants/",
            {"user_ids": [self.c.id]},
            format="json",
        )

        self.client.force_authenticate(self.c)
        resp = self.client.get(f"/api/conversations/{self.cid}/messages/")
        self.assertIn(
            resp.status_code,
            (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND),
        )

    def test_a_group_chat_is_still_addable(self):
        # The guard must not have broken the feature it narrows.
        gid = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": [self.b.id]}, format="json"
        ).data["id"]

        resp = self.client.post(
            f"/api/conversations/{gid}/participants/",
            {"user_ids": [self.c.id]},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(
            Participant.objects.filter(conversation_id=gid, user=self.c).exists()
        )


class LeaveChatTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id]}, format="json").data["id"]

    def test_leave_closes_interval_and_drops_you(self):
        res = self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.assertEqual(res.status_code, 200)
        p = Participant.objects.get(conversation_id=self.cid, user=self.a)
        self.assertIsNotNone(p.left_at)
        self.assertFalse(p.intervals.filter(ended_at__isnull=True).exists())

    def test_pending_invitee_can_decline(self):
        # c pending (never connected to b).
        c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=c, status="accepted")
        self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [c.id]}, format="json")
        self.client.force_authenticate(c)
        res = self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.assertEqual(res.status_code, 200)
        self.assertIsNotNone(Participant.objects.get(conversation_id=self.cid, user=c).left_at)

    def test_non_participant_gets_404(self):
        stranger = User.objects.create_user(email="stranger@x.com", password=PASSWORD)
        self.client.force_authenticate(stranger)
        res = self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.assertEqual(res.status_code, 404)


class PromoteOnConnectTests(APITestCase):
    def test_pending_member_auto_joins_when_last_connection_accepted(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        Connection.objects.create(requester=a, requestee=b, status="accepted")
        Connection.objects.create(requester=a, requestee=c, status="accepted")
        self.client.force_authenticate(a)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [b.id, c.id]}, format="json").data["id"]
        convo = Conversation.objects.get(id=cid)
        pending = convo.participants.get(status="pending")  # b or c
        other_active = convo.participants.exclude(user=a).get(status="active")
        # The pending one requests the active one; accept it.
        req = Connection.objects.create(requester=pending.user, requestee=other_active.user, status="pending")
        self.client.force_authenticate(other_active.user)
        res = self.client.post(f"/api/connection-requests/{req.id}/approve/")
        self.assertEqual(res.status_code, 200)
        convo.refresh_from_db()
        self.assertEqual(convo.participants.filter(status="active").count(), 3)


class SeverTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        for x, y in [(self.a, self.b), (self.a, self.c), (self.b, self.c)]:
            Connection.objects.create(requester=x, requestee=y, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id]}, format="json").data["id"]

    def test_disconnect_impact_lists_shared_chat(self):
        res = self.client.get(f"/api/users/{self.b.id}/disconnect-impact/")
        self.assertEqual([c["id"] for c in res.data["chats"]], [self.cid])

    def test_disconnect_drops_initiator_to_pending_other_stays(self):
        self.client.delete(f"/api/users/{self.b.id}/connect/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "pending")
        self.assertEqual(convo.participants.get(user=self.b).status, "active")

    def test_block_pulls_blocker_out_of_shared_chat(self):
        self.client.post(f"/api/users/{self.b.id}/block/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "pending")

    def test_initiator_auto_returns_on_reconnect(self):
        self.client.delete(f"/api/users/{self.b.id}/connect/")
        # a re-requests b; b accepts.
        self.client.post(f"/api/users/{self.b.id}/connect/")
        req = Connection.objects.get(requester=self.a, requestee=self.b)
        self.client.force_authenticate(self.b)
        self.client.post(f"/api/connection-requests/{req.id}/approve/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "active")


class GroupChatLifecycleTests(APITestCase):
    def test_leaving_group_removes_you_from_its_chats(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        Connection.objects.create(requester=a, requestee=b, status="accepted")
        group = Group.objects.create(name="Fam", creator=a)
        GroupMembership.objects.create(group=group, user=a, role="admin", status="active")
        GroupMembership.objects.create(group=group, user=b, role="member", status="active")
        self.client.force_authenticate(a)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [b.id], "group_id": group.id}, format="json").data["id"]
        # b leaves the group.
        self.client.force_authenticate(b)
        self.client.delete(f"/api/groups/{group.id}/members/{b.id}/")
        p = Participant.objects.get(conversation_id=cid, user=b)
        self.assertIsNotNone(p.left_at)

    def test_admin_removing_another_member_drops_them_from_chats(self):
        admin = User.objects.create_user(email="admin@x.com", password=PASSWORD)
        member = User.objects.create_user(email="member@x.com", password=PASSWORD)
        Connection.objects.create(requester=admin, requestee=member, status="accepted")
        group = Group.objects.create(name="Fam", creator=admin)
        GroupMembership.objects.create(group=group, user=admin, role="admin", status="active")
        GroupMembership.objects.create(group=group, user=member, role="member", status="active")
        self.client.force_authenticate(admin)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [member.id], "group_id": group.id}, format="json").data["id"]
        member_participant = Participant.objects.get(conversation_id=cid, user=member)
        self.assertIsNone(member_participant.left_at)
        # Admin removes the member (not a self-leave) — actor stays admin.
        self.client.delete(f"/api/groups/{group.id}/members/{member.id}/")
        member_participant.refresh_from_db()
        self.assertIsNotNone(member_participant.left_at)
        admin_participant = Participant.objects.get(conversation_id=cid, user=admin)
        self.assertIsNone(admin_participant.left_at)

    def test_deleting_group_cascades_to_its_chats(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        Connection.objects.create(requester=a, requestee=b, status="accepted")
        group = Group.objects.create(name="Fam", creator=a)
        GroupMembership.objects.create(group=group, user=a, role="admin", status="active")
        GroupMembership.objects.create(group=group, user=b, role="member", status="active")
        self.client.force_authenticate(a)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [b.id], "group_id": group.id}, format="json").data["id"]
        group.delete()
        self.assertFalse(Conversation.objects.filter(id=cid).exists())


class SeedDemoCommandTests(APITestCase):
    """The seed_demo management command that rebuilds the full demo world."""

    def test_seed_creates_the_full_demo_world(self):
        from django.core.management import call_command

        call_command("seed_demo", verbosity=0)

        # Six active accounts.
        self.assertEqual(User.objects.count(), 6)
        self.assertTrue(all(u.is_active for u in User.objects.all()))
        # Connections: 5 accepted + 2 pending requests.
        self.assertEqual(Connection.objects.filter(status="accepted").count(), 5)
        self.assertEqual(Connection.objects.filter(status="pending").count(), 2)
        # Posts (personal + group) and a threaded comment (a reply with a parent).
        self.assertTrue(Post.objects.filter(group__isnull=True).exists())
        self.assertTrue(Post.objects.filter(group__isnull=False).exists())
        self.assertTrue(Comment.objects.filter(parent__isnull=False).exists())
        # Two groups, one with a pending invite.
        self.assertEqual(Group.objects.count(), 2)
        self.assertTrue(GroupMembership.objects.filter(status="invited").exists())
        # Direct + group conversations exist.
        self.assertEqual(Conversation.objects.filter(kind="direct").count(), 2)
        self.assertEqual(Conversation.objects.filter(kind="group").count(), 2)

    def test_seed_group_chat_has_a_pending_participant(self):
        from django.core.management import call_command

        call_command("seed_demo", verbosity=0)
        # The "Mystery trip" chat: dave can't connect to bob, so he's pending.
        trip = Conversation.objects.get(title="Mystery trip")
        self.assertTrue(
            trip.participants.filter(user__email="dave@example.com", status="pending").exists()
        )
        self.assertEqual(trip.participants.filter(status="active").count(), 2)

    def test_seed_is_idempotent(self):
        from django.core.management import call_command

        call_command("seed_demo", verbosity=0)
        call_command("seed_demo", verbosity=0)

        # Rebuild, not pile-up: counts are stable across a second run.
        self.assertEqual(User.objects.filter(email__endswith="@example.com").count(), 6)
        self.assertEqual(Connection.objects.filter(status="accepted").count(), 5)
        self.assertEqual(Group.objects.count(), 2)
        self.assertEqual(Conversation.objects.count(), 4)
        self.assertEqual(
            Post.objects.filter(author__email="alice@example.com", group__isnull=True).count(),
            2,
        )

    def test_seeded_account_can_log_in_with_the_password(self):
        from django.core.management import call_command

        call_command("seed_demo", password="s3cret-demo-pw", verbosity=0)
        alice = User.objects.get(email="alice@example.com")
        self.assertTrue(alice.check_password("s3cret-demo-pw"))


class SeedDemoAliceViewpointTests(APITestCase):
    """What the demo world looks like *through Alice's eyes*.

    Not product behaviour — the fixture itself. A broken demo world is silently
    misleading: you log in, find an empty thread or a missing badge, and start
    debugging the app instead of the seed. These pin the properties the demo
    exists to give you.

    The load-bearing one is her badges. The nav row is a tight fit inside the
    640px column, and a count badge once widened its item enough to shove the
    avatar out of the frame — so Alice deliberately carries at least one unread
    item behind *every* badge, putting that layout case on screen at every login
    rather than only when someone happens to have mail.
    """

    @classmethod
    def setUpTestData(cls):
        from django.core.management import call_command

        call_command("seed_demo", verbosity=0)
        cls.alice = User.objects.get(email="alice@example.com")

    def setUp(self):
        self.client.force_authenticate(self.alice)

    def test_alice_has_an_unread_item_behind_every_nav_badge(self):
        messages = self.client.get("/api/messages/unread-count/")
        activity = self.client.get("/api/notifications/unread-count/")

        self.assertGreater(messages.data["count"], 0, "no unread-messages badge")
        self.assertGreater(activity.data["count"], 0, "no activity-centre badge")

    def test_alice_sees_every_event_lifecycle_state_from_both_viewpoints(self):
        visible = Event.objects.filter(
            group__memberships__user=self.alice,
            group__memberships__status="active",
        ).distinct()

        self.assertEqual(
            set(visible.values_list("status", flat=True)),
            {"scheduled", "planning", "cancelled"},
        )
        organisers = set(visible.values_list("organiser__email", flat=True))
        # Both sides of the feature: events she runs (organiser controls) and
        # events someone else runs (vote / RSVP as a member).
        self.assertIn("alice@example.com", organisers)
        self.assertTrue(organisers - {"alice@example.com"})
        # A past event, so the "falls into the group timeline as a memory" path
        # has something to show.
        self.assertTrue(visible.filter(event_date__lt=timezone.localdate()).exists())

    def test_seeds_open_and_closed_polls_with_votes_and_rsvps(self):
        self.assertTrue(Poll.objects.filter(status="open").exists(), "no open poll")
        self.assertTrue(Poll.objects.filter(status="closed").exists(), "no closed poll")
        self.assertTrue(PollVote.objects.exists(), "no votes to tally")
        self.assertTrue(EventRSVP.objects.exists(), "no RSVPs")

    def test_alice_activity_centre_covers_all_three_states(self):
        rows = Notification.objects.filter(recipient=self.alice)

        self.assertTrue(rows.filter(seen_at__isnull=True).exists(), "no unread row")
        self.assertTrue(
            rows.filter(seen_at__isnull=False, addressed_at__isnull=True).exists(),
            "no seen-but-unaddressed row",
        )
        self.assertTrue(
            rows.filter(addressed_at__isnull=False).exists(), "no addressed row"
        )

    def test_no_notification_predates_the_thing_it_announces(self):
        """A notification reports something that already happened, so a row
        dated before its own target renders as visible nonsense: "Carol reacted
        to your post" sitting days *above* the post it links to. The seed dates
        rows from their target for exactly this reason.
        """
        rows = Notification.objects.filter(recipient=self.alice).select_related(
            "post", "comment", "group", "connection", "event"
        )

        self.assertTrue(rows.exists(), "alice has no notifications at all")
        for n in rows:
            target = n.post or n.comment or n.connection or n.group or n.event
            created = getattr(target, "created_at", None)
            if created is None:
                continue
            self.assertGreaterEqual(
                n.created_at, created,
                f"{n.kind} notification predates the {type(target).__name__} "
                f"it announces",
            )

    def test_a_still_pending_request_is_not_shown_as_addressed(self):
        """``addressed`` means acted on, or resolved elsewhere (see the
        Notification model). Frank's request is still pending in Alice's requests
        inbox, so dulling its activity row would show her a state the app itself
        can never produce — dealt with and awaiting her at the same time.
        """
        rows = Notification.objects.filter(
            recipient=self.alice,
            kind=Notification.Kind.CONNECTION_REQUEST,
            connection__status=Connection.Status.PENDING,
        )

        self.assertTrue(rows.exists(), "no pending connection request seeded")
        for n in rows:
            self.assertIsNone(
                n.addressed_at,
                "a connection request still awaiting an answer is marked addressed",
            )

    def test_back_dated_messages_stay_visible_to_their_participants(self):
        """A guard with teeth. Participation is stored as **intervals**, so
        back-dating a message without also back-dating its conversation clips it
        out of every participant's visible set and the thread renders empty —
        which is exactly what happened the first time the seed was back-dated.
        """
        convos = self.client.get("/api/conversations/").data
        convos = convos.get("results", convos)

        self.assertTrue(convos, "alice has no conversations at all")
        for convo in convos:
            body = self.client.get(f"/api/conversations/{convo['id']}/messages/").data
            self.assertTrue(
                body.get("results", body), f"conversation {convo['id']} renders empty"
            )

    def test_her_feed_is_back_dated_not_all_at_once(self):
        """Distinct timestamps are what make the reverse-chronological line
        legible at a glance — six posts at the same instant prove nothing."""
        posts = self.client.get("/api/feed/").data
        posts = posts.get("results", posts)

        stamps = {p["created_at"] for p in posts}
        self.assertGreater(len(posts), 1)
        self.assertEqual(len(stamps), len(posts))

    def test_a_thread_is_longer_than_one_page_and_spans_several_days(self):
        """The transcript pages history in as you scroll up (Phase 9b M5), and a
        thread that fits on one page can't show that — nor the day separators
        between bunches. Both are properties of the *fixture*, so they're pinned
        here rather than left to whoever next opens the app."""
        bob = User.objects.get(email="bob@example.com")
        convo = Conversation.objects.filter(
            kind="direct", participants__user=bob
        ).get(participants__user=self.alice)

        page = self.client.get(f"/api/conversations/{convo.id}/messages/").data
        self.assertGreater(page["count"], 40, "not enough history to page through")

        days = {m.created_at.date() for m in convo.messages.all()}
        self.assertGreaterEqual(len(days), 4, "no day separators to render")

    def test_the_seeded_formatting_covers_the_marks_and_the_near_misses(self):
        """The bubble parses `*bold*` and friends at draw time (Phase 9b M8), and
        the cases that actually break a parser are the ones that must come out
        *unchanged*. Both have to be on screen to be looked at."""
        bodies = " ".join(Message.objects.values_list("text", flat=True))

        for mark in ("*", "_", "~", "`"):
            self.assertIn(mark, bodies, f"nothing seeded using {mark!r}")
        # The near-misses: a word character before the delimiter opens nothing.
        self.assertIn("2*3*4", bodies)
        self.assertIn("packing_list_final_v2.txt", bodies)
        self.assertIn("pitch_14_map", bodies)

    def test_alice_is_mentioned_including_inside_the_muted_chat(self):
        """A mention is stored as a row, not parsed out of the text, and its one
        job is to notify through a *muted* thread (Phase 9b M8). Seeding one
        inside the muted chat is what makes that rule something you can look at
        instead of read about."""
        mentions = MessageMention.objects.filter(user=self.alice)
        self.assertTrue(mentions.exists(), "alice is never mentioned")

        muted = Participant.objects.filter(user=self.alice, muted_at__isnull=False)
        self.assertTrue(muted.exists(), "no muted chat in the demo world")
        self.assertTrue(
            mentions.filter(
                message__conversation__in=muted.values("conversation")
            ).exists(),
            "no mention inside a muted chat — the one case M8 exists for",
        )

        # Every seeded mention names someone actually in the room, which is what
        # the send endpoint enforces; a fixture that broke it would demo a state
        # the app refuses to create.
        for mention in MessageMention.objects.select_related("message", "user"):
            self.assertTrue(
                Participant.objects.filter(
                    conversation=mention.message.conversation,
                    user=mention.user,
                    status="active",
                ).exists(),
                f"{mention} names someone who isn't an active participant",
            )


class MediaAuthTests(APITestCase):
    """The forward_auth gate Caddy calls before serving any /media/ file in
    production (Phase 7 hardening). Uploaded photos aren't world-readable: Caddy
    serves the file only when this returns 2xx — i.e. only for a logged-in,
    active member."""

    def test_anonymous_is_denied(self):
        # No auth cookie → not 2xx, so Caddy refuses to serve the file. A media
        # URL that leaks off the site is useless to a logged-out stranger.
        resp = self.client.get(MEDIA_AUTH_URL)
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logged_in_member_is_allowed(self):
        self.client.force_authenticate(make_user("mediaviewer@example.com"))
        resp = self.client.get(MEDIA_AUTH_URL)
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)


# --- Phase 7: uptime health probe --------------------------------------------

HEALTHZ_URL = "/api/healthz/"


class HealthzTests(APITestCase):
    """The public liveness probe the on-box uptime monitor polls (Phase 7)."""

    def test_healthz_is_public_and_ok(self):
        # No auth: the monitor is anonymous, and a 200 confirms Caddy + gunicorn
        # + the database are all alive (the view runs a SELECT 1).
        resp = self.client.get(HEALTHZ_URL)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["status"], "ok")

    def test_healthz_reports_503_when_db_is_down(self):
        # If the DB is unreachable the probe must fail (503), not falsely report
        # healthy — that's the whole point of touching the database here.
        with mock.patch(
            "django.db.connection.cursor", side_effect=OperationalError("db down")
        ):
            resp = self.client.get(HEALTHZ_URL)
        self.assertEqual(resp.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_healthz_does_not_leak_the_running_version(self):
        # The probe is anonymous, so it deliberately reports nothing but liveness
        # — the running release is answerable only through the staff-only
        # /api/version/ below (issue #104).
        resp = self.client.get(HEALTHZ_URL)
        self.assertEqual(list(resp.data.keys()), ["status"])


# --- Issue #104: which release is actually running ----------------------------

VERSION_URL = "/api/version/"


class VersionTests(APITestCase):
    """The staff-only "what is this box actually running?" endpoint.

    It exists because the box once served six-day-old code for days while
    ``healthz`` returned 200 and autodeploy logged success — with no way to see
    the running version short of SSH.
    """

    def test_reports_the_version_baked_into_the_image(self):
        staff = make_user("maintainer@example.com", is_staff=True)
        self.client.force_authenticate(staff)
        with self.settings(TIMELINE_VERSION="v0.15.0"):
            resp = self.client.get(VERSION_URL)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["version"], "v0.15.0")

    def test_defaults_to_dev_when_no_release_tag_was_baked_in(self):
        # A local `docker compose up` builds from a working tree with no release
        # tag; reporting "dev" is honest, and stops a dev box being mistaken for
        # a release.
        staff = make_user("devbox@example.com", is_staff=True)
        self.client.force_authenticate(staff)
        resp = self.client.get(VERSION_URL)
        self.assertEqual(resp.data["version"], "dev")

    def test_non_staff_member_is_denied(self):
        # An ordinary member has no business knowing the deployment's version,
        # and the repo is public — the tag maps straight to known-fixed bugs.
        self.client.force_authenticate(make_user("member@example.com"))
        resp = self.client.get(VERSION_URL)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_is_denied(self):
        resp = self.client.get(VERSION_URL)
        self.assertIn(
            resp.status_code,
            (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN),
        )


# --- Phase 7: content reports (takedown path) ---------------------------------

REPORTS_URL = "/api/reports/"


class ReportTests(APITestCase):
    """Flagging a post or comment for the maintainer to review."""

    def setUp(self):
        self.reporter = make_user("reporter@example.com")
        self.author = make_user("author@example.com")
        # You can only report content you can *see*, so the reporter is connected
        # with the author (their post + comment are then visible to the reporter).
        make_connection(self.reporter, self.author)
        self.post = Post.objects.create(author=self.author, text="something")
        self.comment = Comment.objects.create(
            post=self.post, author=self.author, text="a comment"
        )
        self.client.force_authenticate(self.reporter)

    def test_report_a_post(self):
        resp = self.client.post(
            REPORTS_URL,
            {"post": self.post.pk, "reason": "not theirs to post"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        report = Report.objects.get()
        self.assertEqual(report.reporter, self.reporter)
        self.assertEqual(report.post_id, self.post.pk)
        self.assertIsNone(report.comment_id)
        self.assertEqual(report.status, Report.Status.OPEN)

    def test_report_a_comment(self):
        resp = self.client.post(
            REPORTS_URL, {"comment": self.comment.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Report.objects.get().comment_id, self.comment.pk)

    def test_report_needs_exactly_one_target(self):
        # Neither…
        none = self.client.post(REPORTS_URL, {"reason": "x"}, format="json")
        self.assertEqual(none.status_code, status.HTTP_400_BAD_REQUEST)
        # …nor both.
        both = self.client.post(
            REPORTS_URL,
            {"post": self.post.pk, "comment": self.comment.pk},
            format="json",
        )
        self.assertEqual(both.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Report.objects.count(), 0)

    def test_reporter_is_the_session_user_not_the_body(self):
        # A spoofed "reporter" in the body is ignored — it's taken from the session.
        resp = self.client.post(
            REPORTS_URL,
            {"post": self.post.pk, "reporter": self.author.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Report.objects.get().reporter, self.reporter)

    def test_anonymous_cannot_report(self):
        self.client.force_authenticate(None)
        resp = self.client.post(
            REPORTS_URL, {"post": self.post.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_cannot_report_content_you_cannot_see(self):
        # A stranger's post the reporter has no connection to: reporting it must
        # 404 (same as everywhere else) rather than confirm the id exists.
        stranger = make_user("stranger@example.com")
        hidden = Post.objects.create(author=stranger, text="not for you")
        hidden_comment = Comment.objects.create(
            post=hidden, author=stranger, text="also hidden"
        )

        post_resp = self.client.post(
            REPORTS_URL, {"post": hidden.pk}, format="json"
        )
        comment_resp = self.client.post(
            REPORTS_URL, {"comment": hidden_comment.pk}, format="json"
        )

        self.assertEqual(post_resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(comment_resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Report.objects.count(), 0)

    def test_reporting_the_same_item_twice_is_idempotent(self):
        first = self.client.post(
            REPORTS_URL, {"post": self.post.pk}, format="json"
        )
        second = self.client.post(
            REPORTS_URL, {"post": self.post.pk, "reason": "again"}, format="json"
        )

        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        # The repeat returns the existing report (200), not a duplicate row.
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.data["id"], first.data["id"])
        self.assertEqual(Report.objects.count(), 1)


# --- Phase 9b M0: reporting a message (the only path to message text) ----------


class MessageReportTests(APITestCase):
    """Flagging a *message*, which after M0 is the only way message text ever
    reaches the maintainer (the admin can't render a thread any more).

    The gate is the messaging safety gate, not the feed's: interval-clipped, so
    reporting can't become a back door into history you were clipped out of.
    """

    def setUp(self):
        self.reporter = make_user("reporter@example.com", first_name="Rep")
        self.sender = make_user("sender@example.com", first_name="Sen")
        make_connection(self.reporter, self.sender)
        self.convo = Conversation.objects.create(
            kind=Conversation.Kind.DIRECT,
            user_a=self.reporter,
            user_b=self.sender,
            created_by=self.reporter,
        )
        for user in (self.reporter, self.sender):
            participant = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant,
                started_at=timezone.now() - timedelta(days=1),
            )
        self.message = Message.objects.create(
            conversation=self.convo, sender=self.sender, text="something awful"
        )
        self.client.force_authenticate(self.reporter)

    def test_reporting_a_message_stores_a_text_snapshot(self):
        resp = self.client.post(
            REPORTS_URL,
            {"message": self.message.pk, "reason": "abusive"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        report = Report.objects.get()
        self.assertEqual(report.message_id, self.message.pk)
        self.assertIsNone(report.post_id)
        self.assertIsNone(report.comment_id)
        self.assertEqual(report.message_text, "something awful")
        # The snapshot is for the maintainer, not the API: it must not come back
        # in the response either.
        self.assertNotIn("message_text", resp.data)

    def test_the_snapshot_survives_the_sender_deleting_the_message(self):
        """The whole reason the snapshot exists: deletion is *soft* (it blanks
        the text), so without a copy a sender could empty the evidence a second
        after being reported."""
        self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        self.client.force_authenticate(self.sender)
        resp = self.client.delete(
            f"/api/conversations/{self.convo.pk}/messages/{self.message.pk}/"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        self.message.refresh_from_db()
        self.assertEqual(self.message.text, "")
        self.assertEqual(Report.objects.get().message_text, "something awful")

    def test_the_snapshot_cannot_be_forged_by_the_reporter(self):
        # A body-supplied snapshot is ignored — it's written from the row.
        resp = self.client.post(
            REPORTS_URL,
            {"message": self.message.pk, "message_text": "words I made up"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Report.objects.get().message_text, "something awful")

    def test_cannot_report_a_message_in_a_thread_you_are_not_in(self):
        outsider = make_user("outsider@example.com")
        self.client.force_authenticate(outsider)
        resp = self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Report.objects.count(), 0)

    def test_cannot_report_a_message_from_inside_your_gap(self):
        """The interval-clipping case. A member who was out of a group chat when
        a message was sent can't see it — and must not be able to launder it into
        the admin by reporting it."""
        a = make_user("ga@example.com")
        b = make_user("gb@example.com")
        gapper = make_user("gapper@example.com")
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=a
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=2)
        for user in (a, b):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(participant=p, started_at=t0)
        # gapper was active [t0, t1) and is active again from now — the hour in
        # between is their gap.
        gap_p = Participant.objects.create(
            conversation=convo, user=gapper, status="active"
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=t0, ended_at=t1
        )
        ParticipantInterval.objects.create(
            participant=gap_p, started_at=timezone.now()
        )
        in_gap = Message.objects.create(
            conversation=convo, sender=a, text="said while they were out"
        )
        Message.objects.filter(pk=in_gap.pk).update(
            created_at=t1 + timedelta(minutes=10)
        )

        self.client.force_authenticate(gapper)
        resp = self.client.post(
            REPORTS_URL, {"message": in_gap.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Report.objects.count(), 0)

    def test_a_demoted_member_can_still_report_what_they_read(self):
        """The other half of the interval rule, and deliberate: someone who has
        since dropped to ``pending`` can still report a message from one of their
        *past* intervals — something they genuinely read at the time. Being
        demoted shouldn't disarm you; the abuse is often why the chat fell apart.

        Pinned because it's a design decision, not a side effect — the thread
        endpoint 403s a pending member, so it would be easy to "tidy" this into an
        active-only check and silently remove the ability to report.
        """
        a = make_user("da@example.com")
        demoted = make_user("demoted@example.com")
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=a
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=1)
        p_a = Participant.objects.create(
            conversation=convo, user=a, status="active"
        )
        ParticipantInterval.objects.create(participant=p_a, started_at=t0)
        p_demoted = Participant.objects.create(
            conversation=convo, user=demoted, status="pending"
        )
        ParticipantInterval.objects.create(
            participant=p_demoted, started_at=t0, ended_at=t1
        )
        seen = Message.objects.create(
            conversation=convo, sender=a, text="abuse they received"
        )
        Message.objects.filter(pk=seen.pk).update(
            created_at=t0 + timedelta(minutes=5)
        )

        self.client.force_authenticate(demoted)
        resp = self.client.post(REPORTS_URL, {"message": seen.pk}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Report.objects.get().message_text, "abuse they received")

    def test_a_blocked_pair_cannot_report_each_others_messages(self):
        Block.objects.create(blocker=self.sender, blocked=self.reporter)
        resp = self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_report_an_already_deleted_message(self):
        self.message.deleted_at = timezone.now()
        self.message.text = ""
        self.message.save(update_fields=["deleted_at", "text"])
        resp = self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Report.objects.count(), 0)

    def test_reporting_the_same_message_twice_is_idempotent(self):
        first = self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        second = self.client.post(
            REPORTS_URL, {"message": self.message.pk}, format="json"
        )
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(Report.objects.count(), 1)

    def test_report_needs_exactly_one_target_of_three(self):
        post = Post.objects.create(author=self.sender, text="a post")
        both = self.client.post(
            REPORTS_URL,
            {"post": post.pk, "message": self.message.pk},
            format="json",
        )
        self.assertEqual(both.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Report.objects.count(), 0)

    def test_a_post_report_still_works_and_snapshots_nothing(self):
        # The widened target must not disturb the Phase 7 path.
        post = Post.objects.create(author=self.sender, text="a post")
        resp = self.client.post(REPORTS_URL, {"post": post.pk}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Report.objects.get().message_text, "")


class AdminMessagePrivacyTests(APITestCase):
    """M0's real guarantee: **no admin page renders message text**, except a
    report's snapshot.

    Written as a functional test against the actual admin pages rather than an
    inspection of ``admin.site._registry``, because the thing we care about is
    what a maintainer can *see* — an inline, a raw_id popup or a search result
    would each defeat a structural check while still putting the text on screen.
    """

    SECRET = "zebra-pinecone-confession"
    # A message in a thread nobody reported. Every admin page must be silent
    # about it — including the pages that legitimately show a *reported*
    # message. See ``test_no_report_page_leaks_an_unreported_message``.
    UNRELATED = "quince-lamplight-grievance"

    def setUp(self):
        self.staff = User.objects.create_superuser(
            email="admin@example.com", password=PASSWORD
        )
        self.a = make_user("aa@example.com", first_name="Aa")
        self.b = make_user("bb@example.com", first_name="Bb")
        make_connection(self.a, self.b)
        self.convo = Conversation.objects.create(
            kind=Conversation.Kind.DIRECT,
            user_a=self.a,
            user_b=self.b,
            created_by=self.a,
        )
        for user in (self.a, self.b):
            p = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=timezone.now() - timedelta(days=1)
            )
        self.message = Message.objects.create(
            conversation=self.convo, sender=self.a, text=self.SECRET
        )

        c = make_user("cc@example.com", first_name="Cc")
        d = make_user("dd@example.com", first_name="Dd")
        other_convo = Conversation.objects.create(
            kind=Conversation.Kind.DIRECT, user_a=c, user_b=d, created_by=c
        )
        self.unrelated_message = Message.objects.create(
            conversation=other_convo, sender=c, text=self.UNRELATED
        )
        self.client.force_login(self.staff)

    def test_message_is_not_registered_in_the_admin(self):
        from django.contrib import admin as django_admin

        self.assertNotIn(Message, django_admin.site._registry)
        # …and no Conversation inline sneaks it back in.
        convo_admin = django_admin.site._registry[Conversation]
        self.assertNotIn(
            Message, [inline.model for inline in convo_admin.inlines]
        )

    def test_no_message_admin_route_exists(self):
        for url in (
            "/admin/api/message/",
            f"/admin/api/message/{self.message.pk}/change/",
        ):
            resp = self.client.get(url)
            self.assertEqual(resp.status_code, 404, url)

    def test_conversation_admin_shows_metadata_but_no_message_text(self):
        changelist = self.client.get("/admin/api/conversation/")
        change = self.client.get(
            f"/admin/api/conversation/{self.convo.pk}/change/"
        )
        self.assertEqual(changelist.status_code, 200)
        self.assertEqual(change.status_code, 200)
        for resp in (changelist, change):
            self.assertNotIn(self.SECRET, resp.content.decode())
        # The metadata support actually needs is still there.
        self.assertIn("aa@example.com", changelist.content.decode())
        self.assertIn("active", change.content.decode())

    def _report(self):
        return Report.objects.create(
            reporter=self.b,
            message=self.message,
            message_text=self.message.text,
            reason="please look at this",
        )

    def test_a_reported_message_is_readable_by_the_maintainer(self):
        report = self._report()
        resp = self.client.get(f"/admin/api/report/{report.pk}/change/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(self.SECRET, resp.content.decode())
        # …but the triage queue itself doesn't put it on screen.
        queue = self.client.get("/admin/api/report/")
        self.assertEqual(queue.status_code, 200)
        self.assertNotIn(self.SECRET, queue.content.decode())
        self.assertIn(f"message #{self.message.pk}", queue.content.decode())

    def test_no_report_page_leaks_an_unreported_message(self):
        """The regression that nearly shipped: ``Report.message`` is a FK, so an
        editable form field renders a ``<select>`` of **every** message in the
        database, each labelled by ``Message.__str__`` — a 40-char text preview.

        Asserting only that a *reported* message is visible (the test above) can't
        catch that, because the leak hides inside a page that's *supposed* to show
        message text. So this asserts the negative, on every report page, using a
        message nobody reported.
        """
        report = self._report()
        for url in (
            "/admin/api/report/",
            f"/admin/api/report/{report.pk}/change/",
            "/admin/api/report/add/",
        ):
            resp = self.client.get(url)
            self.assertNotIn(self.UNRELATED, resp.content.decode(), url)

    def test_reports_cannot_be_hand_written_in_the_admin(self):
        # Members raise reports through the API; the admin only triages them.
        # (This is also what keeps the add form's FK widgets off the page.)
        resp = self.client.get("/admin/api/report/add/")
        self.assertEqual(resp.status_code, 403)

    def test_triage_can_still_resolve_a_report(self):
        # Locking the form down must not break the one thing it's for.
        report = self._report()
        resp = self.client.post(
            f"/admin/api/report/{report.pk}/change/",
            {"status": Report.Status.RESOLVED, "_save": "Save"},
        )
        self.assertEqual(resp.status_code, 302)
        report.refresh_from_db()
        self.assertEqual(report.status, Report.Status.RESOLVED)
        # The reporter's words and the snapshot are not editable by the
        # maintainer — the evidence stays as it was submitted.
        self.assertEqual(report.message_text, self.SECRET)
        self.assertEqual(report.reason, "please look at this")


# --- Phase 7: account deletion (delete-my-data path) --------------------------

DELETE_ACCOUNT_URL = "/api/account/delete/"
_DELETE_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-delete-")
_ORPHAN_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-orphan-")


@override_settings(MEDIA_ROOT=_ORPHAN_MEDIA_ROOT)
class DeletedContentLeavesNoFilesTests(APITestCase):
    """🔒 Deleting a post or a group must take its photos off disk, not just
    their rows.

    Django deliberately doesn't delete files when a row goes (a rolled-back
    transaction would otherwise leave a live row pointing at nothing), so every
    delete path has to sweep up. Account deletion always did; the ordinary post
    and group delete paths didn't. Because `media_auth` authorises media on
    "are you signed in" rather than "is this yours", an orphaned file stays
    fetchable by anyone who kept the URL — so "delete the post I regret" left
    the photo of it retrievable indefinitely.
    """

    def setUp(self):
        self.me = make_user("owner@example.com")
        self.client.force_authenticate(self.me)

    def tearDown(self):
        shutil.rmtree(_ORPHAN_MEDIA_ROOT, ignore_errors=True)

    def _post_with_photo(self):
        self.client.post(
            POSTS_URL,
            {"text": "with a photo", "images": [make_image_upload()]},
            format="multipart",
        )
        post = Post.objects.get(author=self.me)
        image = post.images.get()
        return post, image.image.storage, image.image.name, image.thumbnail.name

    def test_deleting_a_post_removes_its_photos(self):
        post, storage, name, thumb = self._post_with_photo()
        self.assertTrue(storage.exists(name))

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(f"{POSTS_URL}{post.pk}/")

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(storage.exists(name))
        self.assertFalse(storage.exists(thumb))

    def test_a_failed_post_delete_leaves_the_photos_alone(self):
        # The other half of doing this on_commit: someone else's delete is
        # refused, and nothing is swept. A file deleted for a delete that never
        # happened would be unrecoverable.
        post, storage, name, thumb = self._post_with_photo()
        intruder = make_user("intruder@example.com")
        self.client.force_authenticate(intruder)

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(f"{POSTS_URL}{post.pk}/")

        self.assertIn(
            resp.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)
        )
        self.assertTrue(storage.exists(name))
        self.assertTrue(storage.exists(thumb))

    def test_deleting_a_group_removes_its_avatar_posts_and_chat_photos(self):
        group = make_group(self.me)
        group.avatar = make_image_upload("group.jpg")
        group.avatar_thumb = make_image_upload("group-t.jpg")
        group.save(update_fields=["avatar", "avatar_thumb"])

        self.client.post(
            POSTS_URL,
            {
                "text": "in the group",
                "group": group.pk,
                "images": [make_image_upload()],
            },
            format="multipart",
        )
        # A group-scoped chat with a photo in it. Its conversation cascades away
        # with the group, so its attachments are orphaned the same way.
        mate = make_user("mate@example.com")
        make_connection(self.me, mate)
        add_member(group, mate)
        cid = self.client.post(
            CONVERSATIONS_URL,
            {"participant_ids": [mate.pk], "group_id": group.pk},
            format="json",
        ).data["id"]
        self.client.post(
            f"/api/conversations/{cid}/messages/",
            {
                "text": "",
                "attachments": make_image_upload("chat.jpg"),
                "attachment_thumbnails": make_image_upload("t.jpg"),
                "attachment_widths": 120,
                "attachment_heights": 90,
            },
            format="multipart",
        )

        image = Post.objects.get(group=group).images.get()
        storage = image.image.storage
        expected_gone = [
            image.image.name,
            image.thumbnail.name,
            group.avatar.name,
            group.avatar_thumb.name,
        ]
        attachments = MessageAttachment.objects.filter(
            message__conversation__group=group
        )
        self.assertEqual(attachments.count(), 1)  # the chat photo really landed
        for att in attachments:
            expected_gone += [att.file.name, att.thumbnail.name]
        for name in expected_gone:
            self.assertTrue(storage.exists(name), f"{name} missing before delete")

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(f"/api/groups/{group.pk}/")

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        for name in expected_gone:
            self.assertFalse(storage.exists(name), f"{name} survived the delete")


class MediaFileFieldRegistryTests(SimpleTestCase):
    """The set of models the sweep covers is derived, not listed — this pins it.

    A derived set can't be *forgotten* the way a hand-written registry can, which
    is the whole point (issue #222). What it can do is quietly change shape, so
    this asserts the current one. A new file field failing here means "confirm
    the sweep is what you want for it", not "go and add it to a list".
    """

    def test_every_file_field_we_own_is_covered(self):
        from django.apps import apps as app_registry

        from api.media_cleanup import media_file_fields

        derived = {
            model._meta.label: fields
            for model, fields in media_file_fields(app_registry).items()
        }
        self.assertEqual(
            derived,
            {
                "accounts.User": ("avatar", "avatar_thumb"),
                "api.Group": ("avatar", "avatar_thumb"),
                "api.PostImage": ("image", "thumbnail"),
                "api.EventPhoto": ("image", "thumbnail"),
                "api.MessageAttachment": ("file", "thumbnail"),
            },
        )

    def test_no_file_field_is_editable_in_the_admin(self):
        """🔒 An editable file field in the admin is a hole in the sweep *and* in
        the upload pipeline.

        Django's file widget carries a "Clear" checkbox that blanks the column
        without deleting a row, so no ``post_delete`` fires and the file stays on
        disk — fetchable by anyone holding its URL. And an upload through the
        admin skips ``imaging.process_image``, storing a client's file with its
        EXIF (including GPS) intact. Both are silent.
        """
        from django.apps import apps as app_registry
        from django.contrib import admin as django_admin

        from api.media_cleanup import media_file_fields

        covered = media_file_fields(app_registry)
        checked = 0
        for model, model_admin in django_admin.site._registry.items():
            for name in covered.get(model, ()):
                checked += 1
                self.assertIn(
                    name,
                    model_admin.get_readonly_fields(None),
                    f"{model._meta.label}.{name} is editable in the admin",
                )
        self.assertGreater(checked, 0)  # the loop really found something


_ADMIN_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-admin-media-")
_AVATAR_SWAP_MEDIA_ROOT = tempfile.mkdtemp(prefix="timeline-test-avatar-swap-")


@override_settings(MEDIA_ROOT=_ADMIN_MEDIA_ROOT)
class DeletesOutsideTheApiSweepMediaTests(APITestCase):
    """🔒 Every delete takes its files, not just the ones that go through a view
    (issue #222).

    The sweep used to be a call-site convention — each view gathered the files by
    hand — so anything that deleted rows another way silently left the JPEGs on
    disk, and an orphaned file stays *fetchable* by anyone holding its URL
    (``media_auth`` gates on being signed in, not on owning the file). The two
    paths that skipped it are the two that matter most:

    - **The Django admin**, which is the documented moderation/takedown path. A
      member reports an abusive photo, the maintainer deletes the post here, and
      the exact URL the reporter flagged went on serving the picture.
    - **Management commands** (``seed_demo``, ``create_review_account``), which
      bulk-``delete()`` whole querysets of users and groups.

    Both are covered now because the sweep hangs off ``post_delete`` instead —
    which also means the cascade and the bulk action are covered, not just the
    single delete somebody remembered to write code for.
    """

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_ADMIN_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def setUp(self):
        self.me = make_user("member@example.com")
        self.staff = User.objects.create_superuser(
            email="root@example.com", password=PASSWORD
        )

    def _post_with_photo(self, author=None):
        self.client.force_authenticate(author or self.me)
        self.client.post(
            POSTS_URL,
            {"text": "with a photo", "images": [make_image_upload()]},
            format="multipart",
        )
        image = Post.objects.get(author=author or self.me).images.get()
        return image.post, image.image.storage, [image.image.name, image.thumbnail.name]

    def _avatar_on(self, user):
        user.avatar = make_image_upload("me.jpg")
        user.avatar_thumb = make_image_upload("me-t.jpg")
        user.save(update_fields=["avatar", "avatar_thumb"])
        return [user.avatar.name, user.avatar_thumb.name]

    def assertSwept(self, storage, names):
        for name in names:
            self.assertFalse(storage.exists(name), f"{name} survived the delete")

    def test_deleting_a_post_in_the_admin_takes_its_photos(self):
        post, storage, names = self._post_with_photo()
        for name in names:
            self.assertTrue(storage.exists(name), f"{name} missing before delete")

        self.client.force_login(self.staff)
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/admin/api/post/{post.pk}/delete/", {"post": "yes"}
            )

        self.assertEqual(resp.status_code, 302)
        self.assertFalse(Post.objects.filter(pk=post.pk).exists())
        self.assertSwept(storage, names)

    def test_the_admins_bulk_delete_action_takes_them_too(self):
        """"Delete selected" is a different code path from the single delete
        (``delete_queryset``, not ``delete_model``) — and the one a maintainer
        clearing a backlog of reports actually reaches for."""
        post, storage, names = self._post_with_photo()

        self.client.force_login(self.staff)
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                "/admin/api/post/",
                {
                    "action": "delete_selected",
                    "_selected_action": [str(post.pk)],
                    "post": "yes",
                    "index": "0",
                },
            )

        self.assertEqual(resp.status_code, 302)
        self.assertFalse(Post.objects.filter(pk=post.pk).exists())
        self.assertSwept(storage, names)

    def test_removing_one_photo_from_a_post_takes_its_file(self):
        """``PostImageInline`` exists so the maintainer can take down a single
        image without the post — the deliberately narrowest takedown there is,
        and the one whose file was most obviously left behind."""
        post, storage, names = self._post_with_photo()

        with self.captureOnCommitCallbacks(execute=True):
            PostImage.objects.filter(post=post).delete()

        self.assertTrue(Post.objects.filter(pk=post.pk).exists())
        self.assertSwept(storage, names)

    def test_a_bulk_user_delete_takes_avatars_and_photos(self):
        """The shape ``seed_demo`` and ``create_review_account`` use to reset:
        ``User.objects.filter(...).delete()``. Nothing gathers files there, and
        nothing ever will — the receiver has to."""
        post, storage, names = self._post_with_photo()
        names += self._avatar_on(self.me)

        with self.captureOnCommitCallbacks(execute=True):
            User.objects.filter(email="member@example.com").delete()

        self.assertSwept(storage, names)

    def test_deleting_a_member_in_the_admin_runs_the_real_account_deletion(self):
        """🔒 Deleting a member here has to mean what "delete my account" means
        in the app. A bare cascade left three things undone: the files on disk,
        a group with no admin left in it, and a memberless group sitting there
        as dead space."""
        post, storage, names = self._post_with_photo()
        names += self._avatar_on(self.me)

        # A group they run with someone else in it, and one they're alone in.
        shared = make_group(self.me)
        heir = make_user("heir@example.com")
        add_member(shared, heir)
        alone = make_group(self.me, name="Just me")

        self.client.force_login(self.staff)
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/admin/accounts/user/{self.me.pk}/delete/", {"post": "yes"}
            )

        self.assertEqual(resp.status_code, 302)
        self.assertFalse(User.objects.filter(pk=self.me.pk).exists())
        self.assertSwept(storage, names)
        # The shared group survives and stays governable…
        self.assertEqual(
            GroupMembership.objects.get(group=shared, user=heir).role, ADMIN_ROLE
        )
        # …and the one nobody is left in is gone rather than orphaned.
        self.assertFalse(Group.objects.filter(pk=alone.pk).exists())

    def test_the_bulk_member_delete_handles_each_one_in_turn(self):
        """Two members of the same group removed in one "Delete selected". The
        handover has to be reconsidered *after* each goes, not decided once
        against the original roster — otherwise the second delete can hand the
        group to somebody who is being deleted in the same action."""
        second = make_user("second@example.com")
        third = make_user("third@example.com")
        group = make_group(self.me)
        add_member(group, second)
        add_member(group, third)

        self.client.force_login(self.staff)
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                "/admin/accounts/user/",
                {
                    "action": "delete_selected",
                    "_selected_action": [str(self.me.pk), str(second.pk)],
                    "post": "yes",
                    "index": "0",
                },
            )

        self.assertEqual(resp.status_code, 302)
        self.assertFalse(User.objects.filter(pk=second.pk).exists())
        # `third` is the only one left, and the group is still theirs to run.
        self.assertEqual(
            GroupMembership.objects.get(group=group, user=third).role, ADMIN_ROLE
        )


@override_settings(MEDIA_ROOT=_AVATAR_SWAP_MEDIA_ROOT)
class GroupAvatarReplacementTests(APITestCase):
    """🔒 Replacing a group avatar destroys the *old* files, and that has to wait
    for the commit like every other file destruction (issue #224).

    ``save_avatar``/``clear_avatar`` dropped them inline, before the row was
    saved. If anything failed afterwards — a validation error further down the
    handler, a DB error on the follow-up ``save()``, ``ATOMIC_REQUESTS`` if it's
    ever switched on — the row rolled back still pointing at ``avatar/<old>.jpg``
    and that file was gone. Every member then saw a broken avatar, permanently:
    the old image no longer exists and the row won't accept a repair without a
    re-upload. Unlike an orphaned file, that one is visible and unrecoverable.
    """

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(_AVATAR_SWAP_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def setUp(self):
        self.me = make_user("admin@example.com")
        self.client.force_authenticate(self.me)
        self.group = make_group(self.me)

    def _set_avatar(self, name="one.jpg"):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/groups/{self.group.pk}/",
                {"avatar": make_image_upload(name)},
                format="multipart",
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        return self.group.avatar.storage, [
            self.group.avatar.name,
            self.group.avatar_thumb.name,
        ]

    def test_replacing_an_avatar_sweeps_the_old_files_and_keeps_the_new(self):
        storage, old = self._set_avatar("one.jpg")
        storage, new = self._set_avatar("two.jpg")

        self.assertNotEqual(old, new)
        for name in old:
            self.assertFalse(storage.exists(name), f"{name} survived the replace")
        for name in new:
            self.assertTrue(storage.exists(name), f"{name} was swept by mistake")

    def test_removing_an_avatar_sweeps_its_files(self):
        storage, old = self._set_avatar()

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/groups/{self.group.pk}/",
                {"remove_avatar": "true"},
                format="multipart",
            )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertFalse(self.group.avatar)
        for name in old:
            self.assertFalse(storage.exists(name), f"{name} survived the removal")

    def test_a_save_that_fails_leaves_the_old_avatar_whole(self):
        """The half that ``test_replacing_…`` can't see. ``ATOMIC_REQUESTS`` is
        off, so in production there's no transaction here unless the handler
        opens one, and an ``on_commit`` callback without one runs *inline* —
        which is just an immediate delete wearing a deferral's clothes. This
        asserts on the callbacks themselves, so it fails if the atomic goes."""
        storage, old = self._set_avatar()

        real_save = Group.save

        def fail_on_avatar_save(instance, *args, **kwargs):
            if "avatar" in (kwargs.get("update_fields") or ()):
                raise DatabaseError("save failed")
            return real_save(instance, *args, **kwargs)

        with mock.patch.object(Group, "save", fail_on_avatar_save):
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                with self.assertRaises(DatabaseError):
                    self.client.patch(
                        f"/api/groups/{self.group.pk}/",
                        {"avatar": make_image_upload("two.jpg")},
                        format="multipart",
                    )

        self.assertEqual(callbacks, [])
        self.group.refresh_from_db()
        self.assertEqual(self.group.avatar.name, old[0])
        for name in old:
            self.assertTrue(storage.exists(name), f"{name} destroyed by a failed save")


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class DeleteAccountTests(APITestCase):
    def setUp(self):
        cache.clear()  # /account/delete/ is throttled per user — isolate it
        # The media root is shared by the two file tests below, so clear it
        # via addCleanup: doing it at the end of a test body leaks a directory
        # of real JPEGs whenever an assertion above it fails.
        self.addCleanup(shutil.rmtree, _DELETE_MEDIA_ROOT, ignore_errors=True)
        self.me = make_user("leaver@example.com")
        self.client.force_authenticate(self.me)

    def tearDown(self):
        cache.clear()

    def test_wrong_password_is_rejected_and_account_survives(self):
        resp = self.client.post(
            DELETE_ACCOUNT_URL, {"password": "not-my-password"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(User.objects.filter(pk=self.me.pk).exists())

    def test_deletes_account_and_its_content(self):
        friend = make_user("friend@example.com")
        make_connection(self.me, friend)
        post = Post.objects.create(author=self.me, text="mine")
        Comment.objects.create(post=post, author=self.me, text="my comment")

        resp = self.client.post(
            DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
        )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(User.objects.filter(pk=self.me.pk).exists())
        # Their content is gone; the friend's account is untouched.
        self.assertEqual(Post.objects.filter(author_id=self.me.pk).count(), 0)
        self.assertEqual(Connection.objects.count(), 0)
        self.assertTrue(User.objects.filter(pk=friend.pk).exists())

    @override_settings(MEDIA_ROOT=_DELETE_MEDIA_ROOT)
    def test_deletes_uploaded_media_files_from_storage(self):
        # A real uploaded photo, then delete the account — the files must go too,
        # not just their DB rows (the cascade wouldn't touch disk).
        self.client.post(
            POSTS_URL,
            {"text": "with a photo", "images": [make_image_upload()]},
            format="multipart",
        )
        image = Post.objects.get(author=self.me).images.get()
        storage, name, thumb = image.image.storage, image.image.name, image.thumbnail.name
        self.assertTrue(storage.exists(name))

        # The files are removed on commit (so a rolled-back delete can't orphan
        # the rows from their files), so run the on_commit callbacks to see it.
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
            )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(storage.exists(name))
        self.assertFalse(storage.exists(thumb))

    @override_settings(MEDIA_ROOT=_DELETE_MEDIA_ROOT)
    def test_deletes_chat_photos_from_storage(self):
        """🔒 "Delete my data" has to mean the photos too.

        Only avatars and post images were gathered, so every photo the leaver
        had ever sent in a chat stayed on disk — and stayed *fetchable* at its
        /media/messages/<uuid>.jpg URL by any member who still had the link,
        because `media_auth` gates on being signed in, not on owning the file.
        For a GDPR erasure path that is the whole promise unkept.
        """
        friend = make_user("chatpal@example.com")
        make_connection(self.me, friend)
        cid = self.client.post(
            CONVERSATIONS_URL, {"user_id": friend.id}, format="json"
        ).data["id"]

        def send_photo(name):
            return self.client.post(
                f"/api/conversations/{cid}/messages/",
                {
                    "text": "",
                    "attachments": make_image_upload(name),
                    "attachment_thumbnails": make_image_upload("t.jpg"),
                    "attachment_widths": 120,
                    "attachment_heights": 90,
                },
                format="multipart",
            )

        send_photo("mine.jpg")
        # The other party's photo in the same 1:1 matters too: deleting the user
        # cascades the *conversation* away (user_a/user_b), which takes their
        # messages with it — so those files are orphaned just as surely.
        self.client.force_authenticate(friend)
        send_photo("theirs.jpg")
        self.client.force_authenticate(self.me)

        self.assertEqual(MessageAttachment.objects.count(), 2)
        files = [
            (a.file.storage, a.file.name, a.thumbnail.name)
            for a in MessageAttachment.objects.all()
        ]
        for storage, name, thumb in files:
            self.assertTrue(storage.exists(name))
            self.assertTrue(storage.exists(thumb))

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
            )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        for storage, name, thumb in files:
            self.assertFalse(storage.exists(name), f"{name} survived the delete")
            self.assertFalse(storage.exists(thumb), f"{thumb} survived the delete")

    @override_settings(MEDIA_ROOT=_DELETE_MEDIA_ROOT)
    def test_deleting_an_emptied_group_takes_a_departed_members_photos(self):
        """🔒 A group that dies with its last member takes content that was
        never the leaver's.

        The teardown used to gather only the group's avatar, on the reasoning
        that its posts were "all by the departed sole member" and therefore
        already covered. They aren't: leaving a group drops the membership row
        and nothing else, so posts and chat photos from people who left are
        still in the group when it's deleted — and were orphaned on disk.
        """
        group = make_group(self.me)
        ex_member = make_user("exmember@example.com")
        add_member(group, ex_member)

        self.client.force_authenticate(ex_member)
        self.client.post(
            POSTS_URL,
            {
                "text": "before I left",
                "group": group.pk,
                "images": [make_image_upload()],
            },
            format="multipart",
        )
        image = Post.objects.get(author=ex_member).images.get()
        storage, name, thumb = (
            image.image.storage,
            image.image.name,
            image.thumbnail.name,
        )
        self.assertTrue(storage.exists(name))

        # They leave, so `me` is the group's only active member and the group
        # dies with the account — but their post stays in it until then.
        GroupMembership.objects.filter(group=group, user=ex_member).delete()
        self.client.force_authenticate(self.me)

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
            )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Group.objects.filter(pk=group.pk).exists())
        self.assertFalse(storage.exists(name), f"{name} survived the delete")
        self.assertFalse(storage.exists(thumb), f"{thumb} survived the delete")

    def test_sole_admin_hands_the_group_to_the_longest_standing_member(self):
        group = make_group(self.me)  # me = the only admin
        # Two other members; the earlier-joined one should inherit admin.
        first = make_user("first@example.com")
        second = make_user("second@example.com")
        add_member(group, first)
        add_member(group, second)

        resp = self.client.post(
            DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

        # The group survives and is still governable — `first` is now its admin.
        self.assertTrue(Group.objects.filter(pk=group.pk).exists())
        self.assertEqual(
            GroupMembership.objects.get(group=group, user=first).role,
            GroupMembership.Role.ADMIN,
        )

    def test_group_the_user_was_the_only_member_of_is_deleted(self):
        group = make_group(self.me)  # me is the sole member

        resp = self.client.post(
            DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Group.objects.filter(pk=group.pk).exists())


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class DeleteAccountThrottleTests(APITestCase):
    """Account delete is rate-limited per user: the password re-check is the same
    guessing oracle as password change, so a burst is cut off (issue #51).

    (We test the real configured rate rather than a per-test override: DRF binds
    the throttle rate as a class attribute at import, so @override_settings on
    REST_FRAMEWORK wouldn't reach it.)"""

    def setUp(self):
        cache.clear()
        self.me = make_user("leaver@example.com")
        self.client.force_authenticate(self.me)

    def tearDown(self):
        cache.clear()

    def test_a_burst_of_wrong_password_attempts_is_throttled(self):
        rate = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["account_delete"]
        limit = int(rate.split("/")[0])
        wrong = {"password": "not-my-password"}
        for _ in range(limit):
            resp = self.client.post(DELETE_ACCOUNT_URL, wrong, format="json")
            self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        resp = self.client.post(DELETE_ACCOUNT_URL, wrong, format="json")
        self.assertEqual(resp.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        # Throttled before the delete logic ran — the account survives.
        self.assertTrue(User.objects.filter(pk=self.me.pk).exists())


# --- Reactions (Phase 7b) ------------------------------------------------------


def react_post_url(post):
    return f"/api/posts/{post.pk}/react/"


def post_reactions_url(post):
    return f"/api/posts/{post.pk}/reactions/"


def react_comment_url(comment):
    return f"/api/comments/{comment.pk}/react/"


def comment_reactions_url(comment):
    return f"/api/comments/{comment.pk}/reactions/"


def summary_for(reactions, emoji):
    """Pull one emoji's entry out of an embedded ``reactions`` list, or None."""
    return next((r for r in reactions if r["emoji"] == emoji), None)


class EmojiValidationTests(SimpleTestCase):
    """The server-side emoji normaliser — the API never trusts the client, so a
    posted string is validated here before a row is written."""

    def test_accepts_a_plain_emoji(self):
        self.assertEqual(normalise_emoji("👍"), "👍")

    def test_accepts_multi_codepoint_sequences(self):
        # A skin-toned profession (ZWJ + modifier) and a flag (two regional
        # indicators) are single emoji made of several code points — allowed.
        for emoji in ("🧑🏽‍🚀", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣"):
            self.assertEqual(normalise_emoji(emoji), emoji)

    def test_normalises_to_nfc(self):
        # Same visible emoji, different encoding → one canonical string, so it
        # can't be double-counted.
        import unicodedata

        raw = unicodedata.normalize("NFD", "©️")
        self.assertEqual(normalise_emoji(raw), unicodedata.normalize("NFC", raw))

    def test_rejects_plain_text(self):
        for bad in ("hello", "a", "👍 lol", "<script>", "123"):
            with self.assertRaises(InvalidEmoji):
                normalise_emoji(bad)

    def test_rejects_empty_or_whitespace(self):
        for bad in ("", "   ", "\n"):
            with self.assertRaises(InvalidEmoji):
                normalise_emoji(bad)

    def test_rejects_only_joiners_or_modifiers(self):
        # A skin-tone modifier or ZWJ on its own is not an emoji.
        for bad in ("\U0001f3fb", "‍", "️"):
            with self.assertRaises(InvalidEmoji):
                normalise_emoji(bad)

    def test_rejects_oversized_sequences(self):
        with self.assertRaises(InvalidEmoji):
            normalise_emoji("👍" * 20)


class ReactionConstraintTests(APITestCase):
    """The database guards behind the toggle logic — belt-and-braces, so a bug
    (or a raw insert) can't create a nonsense or duplicate reaction."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.post = Post.objects.create(author=self.me, text="hi")
        self.comment = Comment.objects.create(
            post=self.post, author=self.me, text="c"
        )

    def test_a_reaction_must_target_exactly_one_thing(self):
        # Neither target set → violates the XOR check constraint.
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(user=self.me, emoji="👍")

    def test_a_reaction_cannot_target_both_post_and_comment(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(
                    user=self.me, post=self.post, comment=self.comment, emoji="👍"
                )

    def test_same_emoji_twice_on_a_post_is_rejected(self):
        Reaction.objects.create(user=self.me, post=self.post, emoji="👍")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(user=self.me, post=self.post, emoji="👍")

    def test_same_emoji_twice_on_a_comment_is_rejected(self):
        Reaction.objects.create(user=self.me, comment=self.comment, emoji="🎉")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Reaction.objects.create(
                    user=self.me, comment=self.comment, emoji="🎉"
                )


class PostReactionToggleTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.post = Post.objects.create(author=self.me, text="hello")
        self.client.force_authenticate(self.me)

    def test_reacting_adds_then_toggles_off(self):
        resp = self.client.post(react_post_url(self.post), {"emoji": "👍"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        entry = summary_for(resp.data["reactions"], "👍")
        self.assertEqual(entry["count"], 1)
        self.assertTrue(entry["reacted"])
        self.assertEqual(
            Reaction.objects.filter(post=self.post, user=self.me).count(), 1
        )

        # Same emoji again removes it.
        resp = self.client.post(react_post_url(self.post), {"emoji": "👍"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(summary_for(resp.data["reactions"], "👍"))
        self.assertFalse(
            Reaction.objects.filter(post=self.post, user=self.me).exists()
        )

    def test_concurrent_duplicate_add_does_not_500(self):
        # A double-click race: the pre-existence read misses (mocked to None)
        # but the (user, post, emoji) row already exists, so create() hits the
        # unique constraint. The endpoint should swallow the duplicate — both
        # clicks wanted it added — and return 200 with the reaction present,
        # not a 500 from an unhandled IntegrityError.
        Reaction.objects.create(post=self.post, user=self.me, emoji="👍")
        with mock.patch(
            "django.db.models.query.QuerySet.first", return_value=None
        ):
            resp = self.client.post(
                react_post_url(self.post), {"emoji": "👍"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        entry = summary_for(resp.data["reactions"], "👍")
        self.assertEqual(entry["count"], 1)
        self.assertEqual(
            Reaction.objects.filter(
                post=self.post, user=self.me, emoji="👍"
            ).count(),
            1,
        )

    def test_reaction_appears_embedded_in_the_feed(self):
        self.client.post(react_post_url(self.post), {"emoji": "🎉"}, format="json")
        resp = self.client.get(FEED_URL)
        post_data = next(p for p in resp.data["results"] if p["id"] == self.post.id)
        entry = summary_for(post_data["reactions"], "🎉")
        self.assertEqual(entry["count"], 1)
        self.assertTrue(entry["reacted"])

    def test_rejects_a_non_emoji(self):
        resp = self.client.post(
            react_post_url(self.post), {"emoji": "not-an-emoji"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Reaction.objects.filter(post=self.post).exists())

    def test_distinct_emoji_cap_is_enforced(self):
        emojis = [chr(0x1F600 + i) for i in range(MAX_REACTIONS_PER_USER_PER_TARGET)]
        for emoji in emojis:
            resp = self.client.post(
                react_post_url(self.post), {"emoji": emoji}, format="json"
            )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # One more distinct emoji is over the cap.
        resp = self.client.post(
            react_post_url(self.post), {"emoji": chr(0x1F680)}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            Reaction.objects.filter(post=self.post, user=self.me).count(),
            MAX_REACTIONS_PER_USER_PER_TARGET,
        )


class ReactionVisibilityTests(APITestCase):
    """Reactions ride the same visibility wall as the thing reacted to, and the
    aggregate is pruned to who the viewer may see — a not-connected reactor never
    leaks (issue #48)."""

    def test_cannot_react_to_a_post_you_cannot_see(self):
        author = make_user("author@example.com")
        stranger = make_user("stranger@example.com")  # not connected
        post = Post.objects.create(author=author, text="private")
        self.client.force_authenticate(stranger)

        resp = self.client.post(react_post_url(post), {"emoji": "👍"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Reaction.objects.exists())

        # And the who-reacted list is equally invisible.
        resp = self.client.get(post_reactions_url(post))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_not_connected_reactor_is_pruned_from_the_aggregate(self):
        # me—A connected, A—B connected, me—B NOT. A posts; both me and B can see
        # it (each connected to A). B's reaction must be invisible to me.
        me = make_user("me@example.com")
        a = make_user("a@example.com")
        b = make_user("b@example.com")
        make_connection(me, a)
        make_connection(a, b)
        post = Post.objects.create(author=a, text="A's post")

        self.client.force_authenticate(b)
        self.client.post(react_post_url(post), {"emoji": "👍"}, format="json")
        self.client.force_authenticate(me)
        self.client.post(react_post_url(post), {"emoji": "🎉"}, format="json")

        # me sees their own 🎉 but not B's 👍.
        resp = self.client.get(FEED_URL)
        post_data = next(p for p in resp.data["results"] if p["id"] == post.id)
        self.assertIsNone(summary_for(post_data["reactions"], "👍"))
        self.assertEqual(summary_for(post_data["reactions"], "🎉")["count"], 1)

        # The who-reacted list prunes B out too.
        resp = self.client.get(post_reactions_url(post))
        all_emoji = {group["emoji"] for group in resp.data}
        self.assertNotIn("👍", all_emoji)

    def test_group_membership_does_not_widen_the_reactor_set(self):
        # All three are members of a group, but me is only connected to A (not B).
        # A co-member you don't know is still pruned — membership gates access to
        # the post, it doesn't widen who you see within it.
        me = make_user("me@example.com")
        a = make_user("a@example.com")
        b = make_user("b@example.com")
        make_connection(me, a)
        group = make_group(a, name="Fam")
        add_member(group, me)
        add_member(group, b)
        post = Post.objects.create(author=a, text="group post", group=group)

        self.client.force_authenticate(b)
        self.client.post(react_post_url(post), {"emoji": "👍"}, format="json")
        self.client.force_authenticate(me)

        resp = self.client.get(group_posts_url(group))
        post_data = next(p for p in resp.data["results"] if p["id"] == post.id)
        # B is a co-member but not connected to me → their reaction is pruned.
        self.assertIsNone(summary_for(post_data["reactions"], "👍"))


class CommentReactionTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        self.post = Post.objects.create(author=self.me, text="p")
        self.comment = Comment.objects.create(
            post=self.post, author=self.friend, text="nice"
        )

    def test_react_to_a_comment_and_see_it_in_the_tree(self):
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            react_comment_url(self.comment), {"emoji": "❤️"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

        resp = self.client.get(comments_url(self.post))
        node = next(c for c in resp.data if c["id"] == self.comment.id)
        entry = summary_for(node["reactions"], "❤️")
        self.assertEqual(entry["count"], 1)
        self.assertTrue(entry["reacted"])

    def test_cannot_react_to_a_comment_you_cannot_see(self):
        stranger = make_user("stranger@example.com")
        self.client.force_authenticate(stranger)
        resp = self.client.post(
            react_comment_url(self.comment), {"emoji": "👍"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Reaction.objects.exists())


# --- Notifications / activity centre (Phase 8) --------------------------------

NOTIFICATIONS_URL = "/api/notifications/"
NOTIF_UNREAD_URL = "/api/notifications/unread-count/"
NOTIF_SEEN_URL = "/api/notifications/seen/"
NOTIF_PREFS_URL = "/api/notification-preferences/"

KIND = Notification.Kind


def notif_addressed_url(n):
    return f"/api/notifications/{n.pk}/addressed/"


def approve_url(pk):
    return f"{REQUESTS_URL}{pk}/approve/"


def reject_url(pk):
    return f"{REQUESTS_URL}{pk}/reject/"


class NotificationEventGenerationTests(APITestCase):
    """Each notifiable action creates the right notification for the right
    person — and never for your own action."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        self.post = Post.objects.create(author=self.me, text="my post")

    def test_top_level_comment_notifies_post_author(self):
        self.client.force_authenticate(self.friend)
        self.client.post(comments_url(self.post), {"text": "nice"}, format="json")
        n = Notification.objects.get(recipient=self.me)
        self.assertEqual(n.kind, KIND.POST_REPLY)
        self.assertEqual(n.actor, self.friend)
        self.assertEqual(n.post_id, self.post.id)
        self.assertIsNone(n.seen_at)

    def test_reply_notifies_parent_comment_author_not_post_author(self):
        # me comments; friend replies to that comment → me is notified once, as a
        # comment_reply (not a post_reply, and the post author isn't double-hit).
        parent = Comment.objects.create(
            post=self.post, author=self.me, text="top"
        )
        self.client.force_authenticate(self.friend)
        self.client.post(
            comments_url(self.post),
            {"text": "re", "parent": parent.id},
            format="json",
        )
        notes = Notification.objects.filter(recipient=self.me)
        self.assertEqual(notes.count(), 1)
        self.assertEqual(notes.first().kind, KIND.COMMENT_REPLY)

    def test_reaction_notifies_target_author(self):
        self.client.force_authenticate(self.friend)
        self.client.post(
            react_post_url(self.post), {"emoji": "👍"}, format="json"
        )
        n = Notification.objects.get(recipient=self.me)
        self.assertEqual(n.kind, KIND.REACTION)
        self.assertEqual(n.post_id, self.post.id)

    def test_no_self_notification(self):
        # Commenting on and reacting to your own post notifies nobody.
        self.client.force_authenticate(self.me)
        self.client.post(comments_url(self.post), {"text": "self"}, format="json")
        self.client.post(
            react_post_url(self.post), {"emoji": "🎉"}, format="json"
        )
        self.assertFalse(Notification.objects.exists())

    def test_reaction_removal_creates_no_notification(self):
        self.client.force_authenticate(self.friend)
        # add then remove (toggle) the same emoji.
        self.client.post(react_post_url(self.post), {"emoji": "👍"}, format="json")
        self.client.post(react_post_url(self.post), {"emoji": "👍"}, format="json")
        # One notification from the add; the remove added nothing.
        self.assertEqual(Notification.objects.filter(recipient=self.me).count(), 1)

    def test_reaction_dedupes_while_unread(self):
        self.client.force_authenticate(self.friend)
        # react, un-react, re-react, then a second emoji — all while the first
        # notification is still unread → one bumped row, not four lines.
        for emoji in ["👍", "👍", "👍", "❤️"]:
            self.client.post(
                react_post_url(self.post), {"emoji": emoji}, format="json"
            )
        self.assertEqual(Notification.objects.filter(recipient=self.me).count(), 1)


class NotificationGatingTests(APITestCase):
    """create_notification enforces the visibility gate and mute directly."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.other = make_user("other@example.com")
        self.post = Post.objects.create(author=self.me, text="p")

    def test_content_kind_gated_on_connection(self):
        # Not connected: a reply/reaction from `other` must not notify `me`
        # (mirrors the pruned comment tree — a stranger never surfaces).
        n = notifications.create_notification(
            recipient=self.me, actor=self.other,
            kind=KIND.REACTION, post=self.post,
        )
        self.assertIsNone(n)
        self.assertFalse(Notification.objects.exists())
        # Once connected, the same call goes through.
        make_connection(self.me, self.other)
        n = notifications.create_notification(
            recipient=self.me, actor=self.other,
            kind=KIND.REACTION, post=self.post,
        )
        self.assertIsNotNone(n)

    def test_muted_kind_creates_no_row(self):
        make_connection(self.me, self.other)
        NotificationPreference.objects.create(
            user=self.me, kind=KIND.REACTION, enabled=False
        )
        n = notifications.create_notification(
            recipient=self.me, actor=self.other,
            kind=KIND.REACTION, post=self.post,
        )
        self.assertIsNone(n)

    def test_request_kind_not_connection_gated(self):
        # A connection request necessarily comes from a non-connection — it must
        # still notify, or the whole feature is dead.
        n = notifications.create_notification(
            recipient=self.me, actor=self.other,
            kind=KIND.CONNECTION_REQUEST,
        )
        self.assertIsNotNone(n)


class NotificationConnectionFlowTests(APITestCase):
    """Connection request → accept generates and *addresses* the right rows."""

    def setUp(self):
        self.requester = make_user("req@example.com")
        self.owner = make_user("owner@example.com")

    def test_request_notifies_and_approve_addresses_and_thanks(self):
        self.client.force_authenticate(self.requester)
        self.client.post(connect_url(self.owner))
        req_note = Notification.objects.get(recipient=self.owner)
        self.assertEqual(req_note.kind, KIND.CONNECTION_REQUEST)
        self.assertIsNone(req_note.addressed_at)

        # Owner approves → their request notification is addressed, and the
        # requester gets a connection_accepted.
        connection = Connection.objects.get()
        self.client.force_authenticate(self.owner)
        self.client.post(approve_url(connection.id))
        req_note.refresh_from_db()
        self.assertIsNotNone(req_note.addressed_at)
        acc = Notification.objects.get(recipient=self.requester)
        self.assertEqual(acc.kind, KIND.CONNECTION_ACCEPTED)

    def test_reject_cascades_the_request_notification_away(self):
        self.client.force_authenticate(self.requester)
        self.client.post(connect_url(self.owner))
        connection = Connection.objects.get()
        self.client.force_authenticate(self.owner)
        self.client.post(reject_url(connection.id))
        # The Connection is gone and its notification cascaded with it.
        self.assertFalse(Notification.objects.filter(recipient=self.owner).exists())


class NotificationGroupInviteFlowTests(APITestCase):
    def setUp(self):
        self.owner = make_user("owner@example.com")
        self.invitee = make_user("invitee@example.com")
        make_connection(self.owner, self.invitee)
        self.group = make_group(self.owner, name="Cousins")

    def _invite(self):
        self.client.force_authenticate(self.owner)
        self.client.post(
            group_members_url(self.group),
            {"user_id": self.invitee.id},
            format="json",
        )
        return GroupMembership.objects.get(
            group=self.group, user=self.invitee, status=INVITED_STATUS
        )

    def test_invite_notifies_and_accept_addresses(self):
        membership = self._invite()
        note = Notification.objects.get(recipient=self.invitee)
        self.assertEqual(note.kind, KIND.GROUP_INVITE)
        self.assertEqual(note.group_id, self.group.id)
        self.assertIsNone(note.addressed_at)

        self.client.force_authenticate(self.invitee)
        self.client.post(invite_accept_url(membership))
        note.refresh_from_db()
        self.assertIsNotNone(note.addressed_at)

    def test_reject_addresses_but_keeps_the_notification(self):
        # Reject deletes the membership row, but the notification targets the
        # Group (which lives on), so it must be addressed explicitly, not lost.
        membership = self._invite()
        self.client.force_authenticate(self.invitee)
        self.client.post(invite_reject_url(membership))
        note = Notification.objects.get(recipient=self.invitee)
        self.assertIsNotNone(note.addressed_at)


class NotificationEndpointTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        # Two unread notifications for `me`, made by `friend`.
        self.post = Post.objects.create(author=self.me, text="p")
        self.n1 = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.POST_REPLY, post=self.post,
        )
        self.n2 = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.REACTION, post=self.post,
        )

    def test_list_is_scoped_and_newest_first(self):
        self.client.force_authenticate(self.me)
        resp = self.client.get(NOTIFICATIONS_URL)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        ids = [row["id"] for row in resp.data["results"]]
        self.assertEqual(ids, [self.n2.id, self.n1.id])
        # Payload is push-ready: text + url + target present.
        row = resp.data["results"][0]
        self.assertIn("text", row)
        self.assertTrue(row["url"])
        self.assertEqual(row["target"], {"type": "post", "id": self.post.id})
        self.assertFalse(row["seen"])

    def test_list_excludes_other_peoples_notifications(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.get(NOTIFICATIONS_URL)
        self.assertEqual(resp.data["results"], [])

    def test_unread_count_and_seen_clears_it(self):
        self.client.force_authenticate(self.me)
        self.assertEqual(self.client.get(NOTIF_UNREAD_URL).data["count"], 2)
        resp = self.client.post(NOTIF_SEEN_URL)
        self.assertEqual(resp.data["updated"], 2)
        self.assertEqual(self.client.get(NOTIF_UNREAD_URL).data["count"], 0)
        # Seen, not deleted — still listed, now flagged seen.
        rows = self.client.get(NOTIFICATIONS_URL).data["results"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["seen"] for r in rows))

    def test_addressed_implies_seen_and_dulls_one(self):
        self.client.force_authenticate(self.me)
        resp = self.client.post(notif_addressed_url(self.n1))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.n1.refresh_from_db()
        self.assertIsNotNone(self.n1.addressed_at)
        self.assertIsNotNone(self.n1.seen_at)  # addressing implies seen
        # The other is still unread.
        self.assertEqual(self.client.get(NOTIF_UNREAD_URL).data["count"], 1)

    def test_cannot_address_someone_elses_notification(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.post(notif_addressed_url(self.n1))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)


class NotificationSeenOnViewTests(APITestCase):
    """Viewing the content marks its notifications seen — the content half of
    resolve-elsewhere (issue #192's cousin). Opening a post's permalink or its
    comment thread clears the badge for the replies/reactions pointing at it,
    without the bell or the push ever being touched."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        self.post = Post.objects.create(author=self.me, text="mine")
        self.other_post = Post.objects.create(author=self.me, text="other")
        # A reply comment by friend on `post` — the comment-FK target shape.
        self.reply = Comment.objects.create(
            post=self.post, author=self.friend, text="re"
        )
        self.n_post_reply = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.POST_REPLY, post=self.post,
        )
        self.n_comment_reply = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.COMMENT_REPLY, comment=self.reply,
        )
        self.n_other_post = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.REACTION, post=self.other_post,
        )

    def _my_unread_count(self):
        self.client.force_authenticate(self.me)
        return self.client.get(NOTIF_UNREAD_URL).data["count"]

    def test_post_detail_marks_post_and_comment_notifications_seen(self):
        self.client.force_authenticate(self.me)
        self.assertEqual(self._my_unread_count(), 3)
        resp = self.client.get(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.n_post_reply.refresh_from_db()
        self.n_comment_reply.refresh_from_db()
        self.n_other_post.refresh_from_db()
        # Both notifications pointing at this post (post FK and comment FK) are
        # seen; the other post's is untouched.
        self.assertIsNotNone(self.n_post_reply.seen_at)
        self.assertIsNotNone(self.n_comment_reply.seen_at)
        self.assertIsNone(self.n_other_post.seen_at)
        self.assertEqual(self._my_unread_count(), 1)

    def test_comment_thread_fetch_marks_seen_too(self):
        self.client.force_authenticate(self.me)
        resp = self.client.get(comments_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.n_post_reply.refresh_from_db()
        self.n_comment_reply.refresh_from_db()
        self.assertIsNotNone(self.n_post_reply.seen_at)
        self.assertIsNotNone(self.n_comment_reply.seen_at)

    def test_viewing_marks_seen_not_addressed(self):
        # Seen clears the badge; addressed is reserved for acting on the row.
        # The activity centre must still show these with their undulled weight.
        self.client.force_authenticate(self.me)
        self.client.get(post_detail_url(self.post))
        self.n_post_reply.refresh_from_db()
        self.assertIsNone(self.n_post_reply.addressed_at)

    def test_another_viewer_does_not_touch_my_notifications(self):
        # friend can view the post too (connected) — their GET must not mark
        # *my* notifications seen.
        self.client.force_authenticate(self.friend)
        resp = self.client.get(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.n_post_reply.refresh_from_db()
        self.assertIsNone(self.n_post_reply.seen_at)

    def test_mutations_do_not_mark_seen(self):
        # Only reading is seeing: the author PATCHing their own post goes
        # through the ownership gate, not the viewing path.
        self.client.force_authenticate(self.me)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "edited"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.n_post_reply.refresh_from_db()
        self.assertIsNone(self.n_post_reply.seen_at)


class NotificationPreferenceTests(APITestCase):
    def setUp(self):
        self.me = make_user("me@example.com")
        self.client.force_authenticate(self.me)

    def test_defaults_all_mutable_kinds_enabled(self):
        resp = self.client.get(NOTIF_PREFS_URL)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # Only the mutable (reply/reaction) kinds appear, all enabled by default.
        self.assertEqual(
            set(resp.data), set(Notification.MUTABLE_KINDS)
        )
        self.assertTrue(all(resp.data.values()))

    def test_patch_mutes_a_kind(self):
        resp = self.client.patch(
            NOTIF_PREFS_URL, {KIND.REACTION: False}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertFalse(resp.data[KIND.REACTION])
        self.assertTrue(
            NotificationPreference.objects.filter(
                user=self.me, kind=KIND.REACTION, enabled=False
            ).exists()
        )

    def test_cannot_mute_an_always_on_kind(self):
        resp = self.client.patch(
            NOTIF_PREFS_URL, {KIND.CONNECTION_REQUEST: False}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


# --- Post permalink endpoint + deep-link URLs ---------------------------------


def post_detail_url(post):
    return f"/api/posts/{post.pk}/"


class PostDetailViewTests(APITestCase):
    """The single-post permalink endpoint applies the same private-by-default
    gate as every other post surface."""

    def setUp(self):
        self.author = make_user("author@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.author, self.friend)
        self.stranger = make_user("stranger@example.com")
        self.post = Post.objects.create(author=self.author, text="hello")

    def test_connected_user_can_fetch_a_post(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.get(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["id"], self.post.id)
        self.assertEqual(resp.data["text"], "hello")

    def test_author_can_fetch_their_own_post(self):
        self.client.force_authenticate(self.author)
        self.assertEqual(
            self.client.get(post_detail_url(self.post)).status_code,
            status.HTTP_200_OK,
        )

    def test_stranger_gets_404_not_existence_leak(self):
        self.client.force_authenticate(self.stranger)
        self.assertEqual(
            self.client.get(post_detail_url(self.post)).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_unknown_post_404(self):
        self.client.force_authenticate(self.friend)
        self.assertEqual(
            self.client.get("/api/posts/999999/").status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_group_post_requires_membership(self):
        group = make_group(self.author, name="Fam")
        gpost = Post.objects.create(
            author=self.author, group=group, text="in group"
        )
        # A connection who isn't a member can't see the group post.
        self.client.force_authenticate(self.friend)
        self.assertEqual(
            self.client.get(post_detail_url(gpost)).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        # Once a member (and connected with the author), they can.
        add_member(group, self.friend)
        self.assertEqual(
            self.client.get(post_detail_url(gpost)).status_code,
            status.HTTP_200_OK,
        )


class EditDeletePostTests(APITestCase):
    """Owner-only edit (PATCH) and delete (DELETE) of a post on the same
    permalink route (issue #62)."""

    def setUp(self):
        self.author = make_user("author@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.author, self.friend)
        self.stranger = make_user("stranger@example.com")
        self.post = Post.objects.create(author=self.author, text="hello")

    # --- Edit -----------------------------------------------------------------

    def test_owner_can_edit_text_and_edit_is_stamped(self):
        self.client.force_authenticate(self.author)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "hello, fixed"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["text"], "hello, fixed")
        # The response carries a non-null edit time so the client can mark it.
        self.assertIsNotNone(resp.data["edited_at"])
        self.post.refresh_from_db()
        self.assertEqual(self.post.text, "hello, fixed")
        self.assertIsNotNone(self.post.edited_at)

    def test_unedited_post_has_null_edited_at(self):
        # No marker on a post that was never edited.
        self.client.force_authenticate(self.friend)
        resp = self.client.get(post_detail_url(self.post))
        self.assertIsNone(resp.data["edited_at"])

    def test_edit_strips_whitespace(self):
        self.client.force_authenticate(self.author)
        self.client.patch(
            post_detail_url(self.post), {"text": "  spaced  "}, format="json"
        )
        self.post.refresh_from_db()
        self.assertEqual(self.post.text, "spaced")

    def test_no_op_edit_does_not_mark_the_post_edited(self):
        # Saving identical text (or an empty body) must not stamp edited_at — the
        # "· edited" marker means the content really changed.
        self.client.force_authenticate(self.author)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "hello"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(resp.data["edited_at"])
        self.post.refresh_from_db()
        self.assertIsNone(self.post.edited_at)

    def test_connected_non_owner_cannot_edit(self):
        # Visible to them, but not theirs — 403 (not 404: existence isn't hidden
        # from a connection, so the owner check is the honest signal).
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "not mine"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.post.refresh_from_db()
        self.assertEqual(self.post.text, "hello")

    def test_stranger_editing_gets_404_not_existence_leak(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "nope"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_empty_a_text_only_post(self):
        self.client.force_authenticate(self.author)
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "   "}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.post.refresh_from_db()
        self.assertEqual(self.post.text, "hello")

    def test_put_is_not_allowed(self):
        self.client.force_authenticate(self.author)
        resp = self.client.put(
            post_detail_url(self.post), {"text": "whole"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_anonymous_cannot_edit(self):
        resp = self.client.patch(
            post_detail_url(self.post), {"text": "x"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    # --- Delete ---------------------------------------------------------------

    def test_owner_can_delete(self):
        self.client.force_authenticate(self.author)
        resp = self.client.delete(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Post.objects.filter(pk=self.post.pk).exists())

    def test_delete_cascades_to_comments_and_reactions(self):
        comment = Comment.objects.create(
            post=self.post, author=self.friend, text="nice"
        )
        reaction = Reaction.objects.create(
            user=self.friend, post=self.post, emoji="👍"
        )
        self.client.force_authenticate(self.author)
        self.client.delete(post_detail_url(self.post))
        self.assertFalse(Comment.objects.filter(pk=comment.pk).exists())
        self.assertFalse(Reaction.objects.filter(pk=reaction.pk).exists())

    def test_connected_non_owner_cannot_delete(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.delete(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Post.objects.filter(pk=self.post.pk).exists())

    def test_stranger_deleting_gets_404(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.delete(post_detail_url(self.post))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(Post.objects.filter(pk=self.post.pk).exists())

    def test_author_can_edit_and_delete_own_group_post_after_leaving(self):
        # Your content stays yours to remove: gating mutations on can_view_post
        # would 404 an author out of their own group post once they've left the
        # group. The owner path must bypass the membership gate.
        group = make_group(self.author, name="Fam")
        gpost = Post.objects.create(
            author=self.author, group=group, text="in group"
        )
        # The author leaves the group (their membership row is gone).
        GroupMembership.objects.filter(group=group, user=self.author).delete()

        self.client.force_authenticate(self.author)
        edit = self.client.patch(
            post_detail_url(gpost), {"text": "in group, fixed"}, format="json"
        )
        self.assertEqual(edit.status_code, status.HTTP_200_OK)
        resp = self.client.delete(post_detail_url(gpost))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Post.objects.filter(pk=gpost.pk).exists())


def comment_detail_url(comment):
    return f"/api/comments/{comment.pk}/"


class EditDeleteCommentTests(APITestCase):
    """Owner-only edit (PATCH) and delete (DELETE) of a comment at
    ``/comments/<pk>/`` (issue #128) — the same contract posts have, plus the
    reply-preserving delete a tree needs and a flat post doesn't."""

    def setUp(self):
        self.author = make_user("author@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.author, self.friend)
        self.stranger = make_user("stranger@example.com")
        self.post = Post.objects.create(author=self.author, text="hello")
        self.comment = Comment.objects.create(
            post=self.post, author=self.friend, text="nice one"
        )

    # --- Edit -----------------------------------------------------------------

    def test_owner_can_edit_text_and_edit_is_stamped(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "nice two"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["text"], "nice two")
        self.assertIsNotNone(resp.data["edited_at"])
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "nice two")
        self.assertIsNotNone(self.comment.edited_at)

    def test_unedited_comment_has_null_edited_at(self):
        self.client.force_authenticate(self.author)
        resp = self.client.get(comments_url(self.post))
        self.assertIsNone(resp.data[0]["edited_at"])
        self.assertIsNone(resp.data[0]["deleted_at"])

    def test_edit_strips_whitespace(self):
        self.client.force_authenticate(self.friend)
        self.client.patch(
            comment_detail_url(self.comment), {"text": "  spaced  "}, format="json"
        )
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "spaced")

    def test_no_op_edit_does_not_mark_the_comment_edited(self):
        # Same rule as posts: the "· edited" marker means the content really
        # changed, so saving identical text must not stamp it.
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "nice one"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertIsNone(resp.data["edited_at"])
        self.comment.refresh_from_db()
        self.assertIsNone(self.comment.edited_at)

    def test_edit_cannot_reparent_the_comment(self):
        # CommentEditSerializer has no ``parent`` field precisely so a body
        # can't move what someone said under a reply they never answered.
        other = Comment.objects.create(
            post=self.post, author=self.author, text="elsewhere"
        )
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment),
            {"text": "moved?", "parent": other.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.comment.refresh_from_db()
        self.assertIsNone(self.comment.parent_id)

    def test_edit_response_keeps_the_visible_replies(self):
        # The response is a whole comment node, so it has to carry the pruned
        # subtree — a client that trusted an empty ``replies`` would drop the
        # replies from its cache.
        reply = Comment.objects.create(
            post=self.post,
            author=self.author,
            parent=self.comment,
            text="thanks",
        )
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "edited"}, format="json"
        )
        self.assertEqual([r["id"] for r in resp.data["replies"]], [reply.id])

    def test_author_can_edit_a_comment_they_can_no_longer_see(self):
        # You lose sight of your own reply by disconnecting from the author of
        # the comment above it — but your words stay yours to fix. The owner
        # check runs before the visibility gate.
        mine = Comment.objects.create(
            post=self.post,
            author=self.friend,
            parent=Comment.objects.create(
                post=self.post, author=self.author, text="theirs"
            ),
            text="mine",
        )
        Connection.objects.filter(
            Q(requester=self.author, requestee=self.friend)
            | Q(requester=self.friend, requestee=self.author)
        ).delete()
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(mine), {"text": "mine, fixed"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        mine.refresh_from_db()
        self.assertEqual(mine.text, "mine, fixed")

    def test_connected_non_owner_cannot_edit(self):
        self.client.force_authenticate(self.author)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "not mine"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "nice one")

    def test_stranger_editing_gets_404_not_existence_leak(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "nope"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_empty_a_comment(self):
        # A comment has no photo to fall back on, so emptying one is a delete —
        # and delete has its own reply-preserving semantics.
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "   "}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "nice one")

    def test_edit_without_text_is_rejected(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.patch(
            comment_detail_url(self.comment), {}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_put_is_not_allowed(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.put(
            comment_detail_url(self.comment), {"text": "whole"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_anonymous_cannot_edit(self):
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "x"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_cannot_edit_a_deleted_comment(self):
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="reply"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        resp = self.client.patch(
            comment_detail_url(self.comment), {"text": "back?"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "")

    # --- Delete: hard when it can be ------------------------------------------

    def test_owner_deleting_a_childless_comment_removes_the_row(self):
        self.client.force_authenticate(self.friend)
        resp = self.client.delete(comment_detail_url(self.comment))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Comment.objects.filter(pk=self.comment.pk).exists())

    def test_connected_non_owner_cannot_delete(self):
        self.client.force_authenticate(self.author)
        resp = self.client.delete(comment_detail_url(self.comment))
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Comment.objects.filter(pk=self.comment.pk).exists())

    def test_stranger_deleting_gets_404(self):
        self.client.force_authenticate(self.stranger)
        resp = self.client.delete(comment_detail_url(self.comment))
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(Comment.objects.filter(pk=self.comment.pk).exists())

    # --- Delete: soft when it must be -----------------------------------------

    def test_deleting_a_comment_with_replies_keeps_the_replies(self):
        # The whole reason delete isn't always a row delete: the parent CASCADE
        # would take someone else's reply down with it.
        reply = Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        resp = self.client.delete(comment_detail_url(self.comment))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.comment.refresh_from_db()
        self.assertEqual(self.comment.text, "")
        self.assertIsNotNone(self.comment.deleted_at)
        # Not mislabelled as edited by the soft-delete write.
        self.assertIsNone(self.comment.edited_at)
        self.assertTrue(Comment.objects.filter(pk=reply.pk).exists())

    def test_tombstone_clears_reactions_and_notifications_but_keeps_reports(self):
        # A tombstone can't carry reactions and mustn't be deep-linked to. Its
        # **reports** are the exception, and the important one: clearing them
        # would let a reported author empty the maintainer's queue on demand —
        # reply to your own comment, delete it, flag gone before anyone read it.
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        reaction = Reaction.objects.create(
            user=self.author, comment=self.comment, emoji="👍"
        )
        note = Notification.objects.create(
            recipient=self.author,
            actor=self.friend,
            kind=Notification.Kind.COMMENT_REPLY,
            comment=self.comment,
        )
        report = Report.objects.create(
            reporter=self.author, comment=self.comment, reason="rude"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        self.assertFalse(Reaction.objects.filter(pk=reaction.pk).exists())
        self.assertFalse(Notification.objects.filter(pk=note.pk).exists())
        self.assertTrue(Report.objects.filter(pk=report.pk).exists())

    def test_a_reported_author_cannot_clear_the_report_by_deleting(self):
        # The evasion the rule above exists to block, spelled out: the author
        # arranges a reply so the delete goes soft, deletes, and the flag
        # against them must still be sitting in the maintainer's queue.
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        report = Report.objects.create(
            reporter=self.author, comment=self.comment, reason="rude"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        report.refresh_from_db()
        self.assertEqual(report.status, Report.Status.OPEN)
        self.assertEqual(report.comment_id, self.comment.pk)

    def test_second_delete_is_a_no_op(self):
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        resp = self.client.delete(comment_detail_url(self.comment))
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_the_tombstone_renders_in_the_thread(self):
        reply = Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))

        # The author sees the placeholder holding their own reply up, with no
        # text on it.
        self.client.force_authenticate(self.author)
        tree = self.client.get(comments_url(self.post)).data
        self.assertEqual(len(tree), 1)
        self.assertEqual(tree[0]["id"], self.comment.id)
        self.assertEqual(tree[0]["text"], "")
        self.assertIsNotNone(tree[0]["deleted_at"])
        self.assertEqual([r["id"] for r in tree[0]["replies"]], [reply.id])

    def test_a_tombstone_with_no_visible_replies_is_hidden(self):
        # Same delete, different viewer: someone who can't see the reply under
        # the tombstone gets no empty placeholder, because it's holding nothing
        # up for them.
        onlooker = make_user("onlooker@example.com")
        make_connection(self.author, onlooker)
        make_connection(self.friend, onlooker)
        hidden_replier = make_user("hidden@example.com")
        make_connection(self.author, hidden_replier)
        Comment.objects.create(
            post=self.post,
            author=hidden_replier,
            parent=self.comment,
            text="not for you",
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))

        self.client.force_authenticate(onlooker)
        self.assertEqual(self.client.get(comments_url(self.post)).data, [])

    def test_tombstone_stops_rendering_once_its_last_reply_goes(self):
        reply = Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        self.client.force_authenticate(self.author)
        self.client.delete(comment_detail_url(reply))
        # The tombstone row survives, but nothing renders it — which is why the
        # delete path needs no ancestor sweep.
        self.assertTrue(Comment.objects.filter(pk=self.comment.pk).exists())
        self.assertEqual(self.client.get(comments_url(self.post)).data, [])

    # --- What you can't do to a tombstone -------------------------------------

    def test_cannot_reply_to_a_deleted_comment(self):
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        self.client.force_authenticate(self.author)
        resp = self.client.post(
            comments_url(self.post),
            {"text": "late", "parent": self.comment.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_react_to_a_deleted_comment(self):
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        self.client.force_authenticate(self.author)
        resp = self.client.post(
            react_comment_url(self.comment), {"emoji": "👍"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_report_a_deleted_comment(self):
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))
        self.client.force_authenticate(self.author)
        resp = self.client.post(
            REPORTS_URL, {"comment": self.comment.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    # --- Counts ---------------------------------------------------------------

    def test_a_tombstone_counts_toward_the_total_but_never_as_new(self):
        # It occupies a row in the thread, so it counts; it holds nothing to
        # read, so badging it "new" would send you to an empty slot.
        Comment.objects.create(
            post=self.post, author=self.author, parent=self.comment, text="ta"
        )
        self.client.force_authenticate(self.friend)
        self.client.delete(comment_detail_url(self.comment))

        self.client.force_authenticate(self.author)
        resp = self.client.get(post_detail_url(self.post))
        self.assertEqual(resp.data["comment_count"], 2)
        # The author wrote the surviving reply, so the only candidate for "new"
        # is the tombstone — and it isn't one.
        self.assertEqual(resp.data["new_comment_count"], 0)


class NotificationPermalinkUrlTests(APITestCase):
    """Notifications deep-link to the post permalink, with ?comment for a
    specific comment so the thread opens right at it."""

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        self.post = Post.objects.create(author=self.me, text="p")

    def _url_of(self, notification):
        self.client.force_authenticate(self.me)
        rows = self.client.get(NOTIFICATIONS_URL).data["results"]
        return next(r["url"] for r in rows if r["id"] == notification.id)

    def test_post_reply_links_to_bare_permalink(self):
        n = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.POST_REPLY, post=self.post,
        )
        self.assertEqual(self._url_of(n), f"/p/{self.post.id}")

    def test_comment_reply_links_to_permalink_at_the_comment(self):
        comment = Comment.objects.create(
            post=self.post, author=self.me, text="top"
        )
        reply = Comment.objects.create(
            post=self.post, author=self.friend, parent=comment, text="re"
        )
        n = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.COMMENT_REPLY, comment=reply,
        )
        self.assertEqual(
            self._url_of(n), f"/p/{self.post.id}?comment={reply.id}"
        )

    def test_reaction_on_comment_links_at_the_comment(self):
        comment = Comment.objects.create(
            post=self.post, author=self.me, text="top"
        )
        n = Notification.objects.create(
            recipient=self.me, actor=self.friend,
            kind=KIND.REACTION, comment=comment,
        )
        self.assertEqual(
            self._url_of(n), f"/p/{self.post.id}?comment={comment.id}"
        )


# ===========================================================================
# Phase 8b — group events, polls, RSVPs, calendars
# ===========================================================================

def group_events_url(g):
    return f"/api/groups/{g.pk}/events/"


def group_calendar_url(g):
    return f"/api/groups/{g.pk}/calendar/"


def event_url(e):
    return f"/api/events/{e.pk}/"


def event_cancel_url(e):
    return f"/api/events/{e.pk}/cancel/"


def event_rsvp_url(e):
    return f"/api/events/{e.pk}/rsvp/"


def event_rsvps_url(e):
    return f"/api/events/{e.pk}/rsvps/"


def event_polls_url(e):
    return f"/api/events/{e.pk}/polls/"


def event_finalise_url(e):
    return f"/api/events/{e.pk}/finalise/"


def poll_url(p):
    return f"/api/polls/{p.pk}/"


def poll_vote_url(p):
    return f"/api/polls/{p.pk}/vote/"


def poll_close_url(p):
    return f"/api/polls/{p.pk}/close/"


PERSONAL_CALENDAR_URL = "/api/calendar/"


class EventsBase(APITestCase):
    """A group with an organiser and an audience wired for the two-gate visibility
    tests:

    - ``admin`` — group creator/admin (for cancel/delete-by-admin), connected to org
    - ``org``   — the organiser (a plain member), connected to admin/me/ana/outside_pal
    - ``me``    — the viewer: a member connected to org, **not** to ana
    - ``ana``   — a member connected to org, **not** to me (the co-participant whose
      name must stay hidden from me but who still counts)
    - ``outsider`` — a member **not** connected to org (can't see org's events)
    - ``nonmember`` — connected to org but **not** in the group
    """

    def setUp(self):
        self.admin = make_user("admin@x.com", first_name="Ad", last_name="Min")
        self.org = make_user("org@x.com", first_name="Or", last_name="Ganiser")
        self.me = make_user("me@x.com", first_name="Me", last_name="Viewer")
        self.ana = make_user("ana@x.com", first_name="An", last_name="A")
        self.outsider = make_user("out@x.com", first_name="Out", last_name="Sider")
        self.nonmember = make_user("non@x.com", first_name="Non", last_name="Member")

        self.group = make_group(self.admin, name="Planners")
        add_member(self.group, self.org)
        add_member(self.group, self.me)
        add_member(self.group, self.ana)
        add_member(self.group, self.outsider)

        # Everyone in the audience is connected to the organiser (the anchor),
        # except the outsider. me and ana are deliberately NOT connected.
        make_connection(self.org, self.admin)
        make_connection(self.org, self.me)
        make_connection(self.org, self.ana)
        make_connection(self.org, self.nonmember)

    def make_event(self, organiser=None, title="Picnic", **kwargs):
        return Event.objects.create(
            group=self.group,
            organiser=organiser or self.org,
            title=title,
            **kwargs,
        )

    def future(self, days=7):
        return timezone.localdate() + timedelta(days=days)


class EventVisibilityTests(EventsBase):
    def test_nonmember_404s_every_endpoint(self):
        event = self.make_event()
        self.client.force_authenticate(self.nonmember)
        self.assertEqual(
            self.client.get(group_events_url(self.group)).status_code, 404
        )
        self.assertEqual(self.client.get(event_url(event)).status_code, 404)
        self.assertEqual(self.client.get(event_rsvps_url(event)).status_code, 404)
        self.assertEqual(
            self.client.get(group_calendar_url(self.group)).status_code, 404
        )

    def test_member_not_connected_to_organiser_cannot_see_event(self):
        event = self.make_event()
        self.client.force_authenticate(self.outsider)
        # Not listed…
        listing = self.client.get(group_events_url(self.group))
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json(), [])
        # …and a 404 on detail (the event doesn't exist for them).
        self.assertEqual(self.client.get(event_url(event)).status_code, 404)

    def test_connected_member_sees_event(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        listing = self.client.get(group_events_url(self.group)).json()
        self.assertEqual([e["id"] for e in listing], [event.id])
        self.assertEqual(self.client.get(event_url(event)).status_code, 200)

    def test_events_list_includes_poll_tallies(self):
        # A list/summary payload must carry poll tallies so the dimension chips
        # can show a "polling" count (regression: polls were detail-only).
        event = self.make_event(event_date=self.future(), status="scheduled")
        poll = Poll.objects.create(
            event=event, dimension="location", question="Where?",
            allow_multiple=False, created_by=self.org,
        )
        opt = PollOption.objects.create(poll=poll, label="Park", text_value="Park")
        PollVote.objects.create(option=opt, voter=self.me)

        self.client.force_authenticate(self.me)
        data = self.client.get(
            f"{group_events_url(self.group)}?window=upcoming"
        ).json()
        ev = next(e for e in data if e["id"] == event.id)
        loc_poll = next(p for p in ev["polls"] if p["dimension"] == "location")
        self.assertEqual(loc_poll["options"][0]["count"], 1)

    def test_rsvp_count_complete_but_names_gated(self):
        event = self.make_event()
        # me and ana both RSVP going. me is not connected to ana.
        EventRSVP.objects.create(event=event, user=self.me, response="going")
        EventRSVP.objects.create(event=event, user=self.ana, response="going")

        self.client.force_authenticate(self.me)
        summary = self.client.get(event_rsvps_url(event)).json()
        self.assertEqual(summary["counts"]["going"], 2)  # complete
        names = {a["id"] for a in summary["going_list"]}
        self.assertEqual(names, {self.me.id})  # ana counted but hidden

        # The organiser is connected to everyone in the audience → sees all names.
        self.client.force_authenticate(self.org)
        summary = self.client.get(event_rsvps_url(event)).json()
        self.assertEqual(summary["counts"]["going"], 2)
        names = {a["id"] for a in summary["going_list"]}
        self.assertEqual(names, {self.me.id, self.ana.id})

    def test_poll_count_complete_but_voter_names_gated(self):
        event = self.make_event()
        poll = Poll.objects.create(
            event=event, dimension="custom", question="Cake?",
            allow_multiple=False, created_by=self.org,
        )
        opt = PollOption.objects.create(poll=poll, label="Yes", text_value="Yes")
        PollVote.objects.create(option=opt, voter=self.me)
        PollVote.objects.create(option=opt, voter=self.ana)

        self.client.force_authenticate(self.me)
        data = self.client.get(poll_url(poll)).json()
        opt_data = data["options"][0]
        self.assertEqual(opt_data["count"], 2)  # complete
        self.assertEqual({v["id"] for v in opt_data["voters"]}, {self.me.id})


class PollLifecycleTests(EventsBase):
    def setUp(self):
        super().setUp()
        self.event = self.make_event()
        self.client.force_authenticate(self.org)

    def _open_date_poll(self):
        d1, d2 = self.future(5), self.future(6)
        resp = self.client.post(
            event_polls_url(self.event),
            {
                "dimension": "date",
                "options": [
                    {"date_value": d1.isoformat()},
                    {"date_value": d2.isoformat()},
                ],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.json(), d1, d2

    def test_open_vote_close_finalise_sets_field(self):
        poll, d1, d2 = self._open_date_poll()
        opt1 = poll["options"][0]["id"]

        # A member who can see the event votes.
        self.client.force_authenticate(self.me)
        v = self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt1]}, format="json"
        )
        self.assertEqual(v.status_code, 200, v.content)

        # Organiser closes, then finalises the date (advisory → decision).
        self.client.force_authenticate(self.org)
        self.client.post(poll_close_url_by_id(poll["id"]))
        fin = self.client.post(
            event_finalise_url(self.event),
            {"dimension": "date", "value": d1.isoformat()},
            format="json",
        )
        self.assertEqual(fin.status_code, 200, fin.content)
        self.event.refresh_from_db()
        self.assertEqual(self.event.event_date, d1)
        self.assertEqual(self.event.status, "scheduled")

    def test_finalise_with_value_no_one_voted_for(self):
        poll, d1, d2 = self._open_date_poll()
        friday = self.future(9)  # not an option
        fin = self.client.post(
            event_finalise_url(self.event),
            {"dimension": "date", "value": friday.isoformat()},
            format="json",
        )
        self.assertEqual(fin.status_code, 200, fin.content)
        self.event.refresh_from_db()
        self.assertEqual(self.event.event_date, friday)

    def test_second_open_date_poll_rejected(self):
        self._open_date_poll()
        resp = self.client.post(
            event_polls_url(self.event),
            {
                "dimension": "date",
                "options": [
                    {"date_value": self.future(1).isoformat()},
                    {"date_value": self.future(2).isoformat()},
                ],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_single_choice_replaces_multi_accumulates(self):
        # Single-choice location poll: a second vote replaces the first.
        loc = self.client.post(
            event_polls_url(self.event),
            {
                "dimension": "location",
                "options": [{"text_value": "Park"}, {"text_value": "Cafe"}],
            },
            format="json",
        ).json()
        o1, o2 = loc["options"][0]["id"], loc["options"][1]["id"]
        self.client.force_authenticate(self.me)
        self.client.put(poll_vote_url_by_id(loc["id"]), {"option_ids": [o1]}, format="json")
        self.client.put(poll_vote_url_by_id(loc["id"]), {"option_ids": [o2]}, format="json")
        self.assertEqual(
            PollVote.objects.filter(option__poll_id=loc["id"], voter=self.me).count(), 1
        )

        # Multi-choice date poll: two options accumulate.
        self.client.force_authenticate(self.org)
        poll, d1, d2 = self._open_date_poll()
        o1, o2 = poll["options"][0]["id"], poll["options"][1]["id"]
        self.client.force_authenticate(self.me)
        self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [o1, o2]}, format="json"
        )
        self.assertEqual(
            PollVote.objects.filter(option__poll_id=poll["id"], voter=self.me).count(), 2
        )

    def test_vote_in_closed_poll_403(self):
        poll, d1, d2 = self._open_date_poll()
        self.client.post(poll_close_url_by_id(poll["id"]))
        self.client.force_authenticate(self.me)
        v = self.client.put(
            poll_vote_url_by_id(poll["id"]),
            {"option_ids": [poll["options"][0]["id"]]},
            format="json",
        )
        self.assertEqual(v.status_code, 403)

    def test_duplicate_option_ids_are_deduped_not_500(self):
        poll, d1, d2 = self._open_date_poll()  # multi-choice date poll
        o1 = poll["options"][0]["id"]
        self.client.force_authenticate(self.me)
        resp = self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [o1, o1]}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            PollVote.objects.filter(option_id=o1, voter=self.me).count(), 1
        )

    def test_vote_rejects_option_ids_that_arent_numbers(self):
        """#205, the poll's version of it. A *string* of letters was already
        refused — it simply isn't in the set of this poll's option ids — but the
        membership test assumed the id was **hashable**, and hashing `["x"]` to
        look it up raised ``TypeError``: an unhandled 500 for a malformed body.
        A string in place of the whole list was a 400 already; it's pinned here
        so the coercion can't quietly drop that."""
        poll, _d1, _d2 = self._open_date_poll()
        self.client.force_authenticate(self.me)
        for bad in (["abc"], [["nested"]], "not-a-list"):
            with self.subTest(option_ids=bad):
                resp = self.client.put(
                    poll_vote_url_by_id(poll["id"]),
                    {"option_ids": bad},
                    format="json",
                )
                self.assertEqual(resp.status_code, 400, resp.content)
        self.assertFalse(PollVote.objects.filter(voter=self.me).exists())

    def test_a_null_option_ids_does_not_clear_your_vote(self):
        """An absent `option_ids` means "no selection", which clears your vote —
        deliberate. An explicit `null` is a client whose field came back empty,
        and answering that by deleting the vote they cast is data loss reported
        as success."""
        poll, _d1, _d2 = self._open_date_poll()
        opt = poll["options"][0]["id"]
        self.client.force_authenticate(self.me)
        self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt]}, format="json"
        )
        self.assertEqual(PollVote.objects.filter(voter=self.me).count(), 1)

        resp = self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": None}, format="json"
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(PollVote.objects.filter(voter=self.me).count(), 1)

    def test_an_omitted_option_ids_still_clears_your_vote(self):
        """The other side of the line above: omitting the field is how you take
        your vote back, and that still works."""
        poll, _d1, _d2 = self._open_date_poll()
        opt = poll["options"][0]["id"]
        self.client.force_authenticate(self.me)
        self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt]}, format="json"
        )
        resp = self.client.put(poll_vote_url_by_id(poll["id"]), {}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(PollVote.objects.filter(voter=self.me).exists())

    def test_custom_finalise_pins_option(self):
        poll = self.client.post(
            event_polls_url(self.event),
            {
                "dimension": "custom",
                "question": "What to bring?",
                "options": [{"text_value": "Cake"}, {"text_value": "Drinks"}],
            },
            format="json",
        ).json()
        opt = poll["options"][0]["id"]
        fin = self.client.post(
            event_finalise_url(self.event),
            {"dimension": "custom", "option_id": opt},
            format="json",
        )
        self.assertEqual(fin.status_code, 200, fin.content)
        self.assertEqual(Poll.objects.get(pk=poll["id"]).decided_option_id, opt)


def poll_vote_url_by_id(pk):
    return f"/api/polls/{pk}/vote/"


def poll_close_url_by_id(pk):
    return f"/api/polls/{pk}/close/"


def poll_detail_url_by_id(pk):
    return f"/api/polls/{pk}/"


def poll_reopen_url_by_id(pk):
    return f"/api/polls/{pk}/reopen/"


class PollEditReopenTests(EventsBase):
    """Issue #87: the organiser can fix a poll's wording — but only before any
    vote — and can re-open a poll they closed early."""

    def setUp(self):
        super().setUp()
        self.event = self.make_event()

    def _open_custom_poll(self):
        self.client.force_authenticate(self.org)
        resp = self.client.post(
            event_polls_url(self.event),
            {
                "dimension": "custom",
                "question": "What to bring?",
                "options": [{"text_value": "Cak"}, {"text_value": "Drinks"}],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.json()

    def test_organiser_edits_question_and_labels_while_unvoted(self):
        poll = self._open_custom_poll()
        opt0, opt1 = poll["options"][0]["id"], poll["options"][1]["id"]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {
                "question": "What should you bring?",
                "options": [
                    {"id": opt0, "text_value": "Cake"},
                    {"id": opt1, "text_value": "Drinks"},
                ],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["question"], "What should you bring?")
        labels = {o["id"]: o["label"] for o in body["options"]}
        self.assertEqual(labels[opt0], "Cake")

    def test_organiser_edits_a_date_option_value(self):
        # A fat-fingered date poll: the organiser corrects an option's date, and
        # its label re-derives from the new value (same as on create).
        self.client.force_authenticate(self.org)
        wrong, right = self.future(5), self.future(12)
        poll = self.client.post(
            event_polls_url(self.event),
            {"dimension": "date",
             "options": [{"date_value": wrong.isoformat()},
                         {"date_value": self.future(6).isoformat()}]},
            format="json",
        ).json()
        opt0, opt1 = poll["options"][0]["id"], poll["options"][1]["id"]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": [
                {"id": opt0, "date_value": right.isoformat()},
                {"id": opt1, "date_value": self.future(6).isoformat()},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        opt = PollOption.objects.get(pk=opt0)
        self.assertEqual(opt.date_value, right)
        self.assertEqual(opt.label, right.isoformat())

    def test_organiser_edits_allow_multiple(self):
        # A custom poll opens single-choice by default; the organiser flips it to
        # pick-any while it's still unvoted.
        poll = self._open_custom_poll()
        self.assertFalse(Poll.objects.get(pk=poll["id"]).allow_multiple)
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"allow_multiple": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["allow_multiple"])
        self.assertTrue(Poll.objects.get(pk=poll["id"]).allow_multiple)

    def test_edit_can_add_a_new_option(self):
        # The edit body is the full desired set: two existing (by id) plus a new
        # id-less one → the poll grows to three options.
        poll = self._open_custom_poll()
        keep = [{"id": o["id"], "text_value": o["label"]} for o in poll["options"]]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": keep + [{"text_value": "Fruit"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        labels = sorted(o["label"] for o in resp.json()["options"])
        self.assertEqual(labels, ["Cak", "Drinks", "Fruit"])

    def test_edit_can_drop_an_option(self):
        # Open a three-option poll, then submit only two → the third is removed.
        self.client.force_authenticate(self.org)
        poll = self.client.post(
            event_polls_url(self.event),
            {"dimension": "custom", "question": "Bring?",
             "options": [{"text_value": "A"}, {"text_value": "B"},
                         {"text_value": "C"}]},
            format="json",
        ).json()
        keep = poll["options"][:2]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": [{"id": o["id"], "text_value": o["label"]} for o in keep]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(PollOption.objects.filter(poll_id=poll["id"]).count(), 2)

    def test_edit_rejects_the_same_option_listed_twice(self):
        # Two entries for one id would pass the length check yet collapse to a
        # single row (dropping the other option) — must be refused.
        poll = self._open_custom_poll()
        opt0 = poll["options"][0]["id"]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": [
                {"id": opt0, "text_value": "Cake"},
                {"id": opt0, "text_value": "Cake again"},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(PollOption.objects.filter(poll_id=poll["id"]).count(), 2)

    def test_edit_rejects_fewer_than_two_options(self):
        poll = self._open_custom_poll()
        opt0 = poll["options"][0]
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": [{"id": opt0["id"], "text_value": opt0["label"]}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(PollOption.objects.filter(poll_id=poll["id"]).count(), 2)

    def test_edit_refused_once_a_vote_exists(self):
        poll = self._open_custom_poll()
        opt0 = poll["options"][0]["id"]
        # A member votes, freezing the wording.
        self.client.force_authenticate(self.me)
        self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt0]}, format="json"
        )
        self.client.force_authenticate(self.org)
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"question": "Sneaky rename"},
            format="json",
        )
        self.assertEqual(resp.status_code, 409, resp.content)
        # Wording is untouched.
        self.assertEqual(Poll.objects.get(pk=poll["id"]).question, "What to bring?")

    def test_non_organiser_cannot_edit(self):
        poll = self._open_custom_poll()
        self.client.force_authenticate(self.me)  # a member, not the organiser
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"question": "Hijack"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403, resp.content)

    def test_edit_rejects_option_from_another_poll(self):
        poll = self._open_custom_poll()
        other = self._open_custom_poll()
        stray = other["options"][0]["id"]
        # A valid option plus one belonging to a different poll — the stray id is
        # refused (not silently created or ignored).
        resp = self.client.patch(
            poll_detail_url_by_id(poll["id"]),
            {"options": [
                {"id": poll["options"][0]["id"], "text_value": "Cake"},
                {"id": stray, "text_value": "nope"},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.content)

    def test_reopen_closed_poll_allows_voting_again(self):
        poll = self._open_custom_poll()
        self.client.post(poll_close_url_by_id(poll["id"]))
        self.assertEqual(Poll.objects.get(pk=poll["id"]).status, "closed")
        resp = self.client.post(poll_reopen_url_by_id(poll["id"]))
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["status"], "open")
        # A member can now vote.
        opt0 = poll["options"][0]["id"]
        self.client.force_authenticate(self.me)
        v = self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt0]}, format="json"
        )
        self.assertEqual(v.status_code, 200, v.content)

    def test_reopen_clears_an_elapsed_closes_at_so_voting_resumes(self):
        # A poll with a soft deadline that has passed, then manually closed.
        poll = self._open_custom_poll()
        Poll.objects.filter(pk=poll["id"]).update(
            closes_at=timezone.now() - timedelta(hours=1)
        )
        self.client.post(poll_close_url_by_id(poll["id"]))
        # Re-open: the stale deadline must be cleared, or votes would still 403.
        resp = self.client.post(poll_reopen_url_by_id(poll["id"]))
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNone(Poll.objects.get(pk=poll["id"]).closes_at)
        # A member can actually vote now.
        opt0 = poll["options"][0]["id"]
        self.client.force_authenticate(self.me)
        v = self.client.put(
            poll_vote_url_by_id(poll["id"]), {"option_ids": [opt0]}, format="json"
        )
        self.assertEqual(v.status_code, 200, v.content)

    def test_reopen_keeps_a_future_closes_at(self):
        # A still-valid deadline is left intact — re-open only clears stale ones.
        poll = self._open_custom_poll()
        future = timezone.now() + timedelta(days=2)
        Poll.objects.filter(pk=poll["id"]).update(closes_at=future)
        self.client.post(poll_close_url_by_id(poll["id"]))
        self.client.post(poll_reopen_url_by_id(poll["id"]))
        self.assertIsNotNone(Poll.objects.get(pk=poll["id"]).closes_at)

    def test_reopen_blocked_when_another_open_poll_for_dimension(self):
        # Open, then close, a date poll; open a second date poll; re-opening the
        # first must fail — you can't have two live date polls (the create rule).
        self.client.force_authenticate(self.org)
        d1, d2 = self.future(5), self.future(6)
        first = self.client.post(
            event_polls_url(self.event),
            {"dimension": "date",
             "options": [{"date_value": d1.isoformat()},
                         {"date_value": d2.isoformat()}]},
            format="json",
        ).json()
        self.client.post(poll_close_url_by_id(first["id"]))
        self.client.post(
            event_polls_url(self.event),
            {"dimension": "date",
             "options": [{"date_value": self.future(8).isoformat()},
                         {"date_value": self.future(9).isoformat()}]},
            format="json",
        )
        resp = self.client.post(poll_reopen_url_by_id(first["id"]))
        self.assertEqual(resp.status_code, 400, resp.content)

    def test_non_organiser_cannot_reopen(self):
        poll = self._open_custom_poll()
        self.client.post(poll_close_url_by_id(poll["id"]))
        self.client.force_authenticate(self.me)
        resp = self.client.post(poll_reopen_url_by_id(poll["id"]))
        self.assertEqual(resp.status_code, 403, resp.content)


class EventPermissionTests(EventsBase):
    def test_any_member_can_create(self):
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            group_events_url(self.group), {"title": "Movie night"}, format="json"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["organiser"]["id"], self.me.id)

    def test_plain_member_cannot_finalise_or_cancel_or_poll(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)  # a member, not the organiser
        self.assertEqual(
            self.client.post(
                event_finalise_url(event),
                {"dimension": "date", "value": self.future().isoformat()},
                format="json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                event_polls_url(event),
                {"dimension": "location",
                 "options": [{"text_value": "A"}, {"text_value": "B"}]},
                format="json",
            ).status_code,
            403,
        )
        self.assertEqual(self.client.post(event_cancel_url(event)).status_code, 403)

    def test_admin_can_cancel_others_event(self):
        event = self.make_event()
        self.client.force_authenticate(self.admin)  # admin, not the organiser
        resp = self.client.post(event_cancel_url(event))
        self.assertEqual(resp.status_code, 200, resp.content)
        event.refresh_from_db()
        self.assertEqual(event.status, "cancelled")

    def test_member_who_can_see_can_rsvp(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.put(
            event_rsvp_url(event), {"response": "going", "guests": 2}, format="json"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["rsvp"]["your_response"]["response"], "going")

    def test_outsider_cannot_rsvp(self):
        event = self.make_event()
        self.client.force_authenticate(self.outsider)
        resp = self.client.put(
            event_rsvp_url(event), {"response": "going"}, format="json"
        )
        self.assertEqual(resp.status_code, 404)


class OrganiserDepartureTests(EventsBase):
    def test_deleting_organiser_account_removes_event(self):
        event = self.make_event()
        self.org.delete()
        self.assertFalse(Event.objects.filter(pk=event.pk).exists())

    def test_leaving_group_cancels_event_and_notifies(self):
        event = self.make_event(event_date=self.future(), status="scheduled")
        EventRSVP.objects.create(event=event, user=self.me, response="going")
        # The organiser leaves the group (self-removal).
        self.client.force_authenticate(self.org)
        resp = self.client.delete(
            f"/api/groups/{self.group.pk}/members/{self.org.pk}/"
        )
        self.assertEqual(resp.status_code, 204, resp.content)
        event.refresh_from_db()
        self.assertEqual(event.status, "cancelled")
        self.assertTrue(
            Notification.objects.filter(
                recipient=self.me, kind="event_cancelled", event=event
            ).exists()
        )


class SchedulingTests(EventsBase):
    def setUp(self):
        super().setUp()
        self.event = self.make_event()
        self.client.force_authenticate(self.org)

    def test_date_only_is_scheduled_all_day(self):
        d = self.future()
        self.client.post(
            event_finalise_url(self.event),
            {"dimension": "date", "value": d.isoformat()},
            format="json",
        )
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, "scheduled")
        self.assertIsNone(self.event.start_time)

    def test_date_and_time_is_timed(self):
        d = self.future()
        self.client.post(
            event_finalise_url(self.event),
            {"dimension": "date", "value": d.isoformat()},
            format="json",
        )
        self.client.post(
            event_finalise_url(self.event),
            {"dimension": "time", "value": "19:30"},
            format="json",
        )
        self.event.refresh_from_db()
        self.assertEqual(self.event.start_time, time(19, 30))

    def test_cancel_tombstones_and_notifies_going(self):
        self.event.event_date = self.future()
        self.event.status = "scheduled"
        self.event.save()
        EventRSVP.objects.create(event=self.event, user=self.me, response="going")
        EventRSVP.objects.create(event=self.event, user=self.ana, response="declined")
        self.client.post(event_cancel_url(self.event))
        self.event.refresh_from_db()
        self.assertEqual(self.event.status, "cancelled")
        # going/maybe RSVPs notified; a declined RSVP is not.
        self.assertTrue(
            Notification.objects.filter(recipient=self.me, kind="event_cancelled").exists()
        )
        self.assertFalse(
            Notification.objects.filter(recipient=self.ana, kind="event_cancelled").exists()
        )


class PastBoundaryTests(EventsBase):
    """An event moves to "past" the moment it's over — a *timed* event when its
    time passes, an *all-day* event when its day ends — not at the next midnight."""

    def _ids(self, window):
        return [
            e["id"]
            for e in self.client.get(
                f"{group_events_url(self.group)}?window={window}"
            ).json()
        ]

    def test_all_day_today_is_current_yesterday_is_past(self):
        today = timezone.localdate()
        today_ev = self.make_event(event_date=today, status="scheduled")
        yest_ev = self.make_event(
            event_date=today - timedelta(days=1), status="scheduled"
        )
        # All-day today is still current (its day hasn't ended); yesterday is over.
        self.assertFalse(today_ev.is_past)
        self.assertTrue(yest_ev.is_past)

        self.client.force_authenticate(self.me)
        upcoming, past = self._ids("upcoming"), self._ids("past")
        self.assertIn(today_ev.id, upcoming)
        self.assertNotIn(today_ev.id, past)
        self.assertIn(yest_ev.id, past)
        self.assertNotIn(yest_ev.id, upcoming)

    @mock.patch("django.utils.timezone.now")
    def test_timed_event_earlier_today_moves_to_past(self, now_mock):
        from datetime import datetime

        now_mock.return_value = datetime(2026, 7, 17, 14, 0, tzinfo=UTC)
        day = now_mock.return_value.date()
        over = self.make_event(
            title="Lunch", event_date=day, start_time=time(12, 0),
            status="scheduled", timezone="UTC",
        )
        soon = self.make_event(
            title="Dinner", event_date=day, start_time=time(16, 0),
            status="scheduled", timezone="UTC",
        )
        self.assertTrue(over.is_past)   # 12:00 already gone at 14:00
        self.assertFalse(soon.is_past)  # 16:00 still ahead

        self.client.force_authenticate(self.me)
        upcoming, past = self._ids("upcoming"), self._ids("past")
        self.assertIn(soon.id, upcoming)
        self.assertNotIn(over.id, upcoming)
        self.assertIn(over.id, past)
        self.assertNotIn(soon.id, past)


class RSVPUpsertTests(EventsBase):
    def test_upsert_changes_response(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        self.client.put(event_rsvp_url(event), {"response": "going"}, format="json")
        self.client.put(event_rsvp_url(event), {"response": "maybe"}, format="json")
        self.assertEqual(EventRSVP.objects.filter(event=event, user=self.me).count(), 1)
        self.assertEqual(
            EventRSVP.objects.get(event=event, user=self.me).response, "maybe"
        )


class CalendarTests(EventsBase):
    def test_group_calendar_window(self):
        near = self.make_event(title="Near", event_date=self.future(3), status="scheduled")
        far = self.make_event(title="Far", event_date=self.future(60), status="scheduled")
        undated = self.make_event(title="Undated")  # no date → not on the calendar
        self.client.force_authenticate(self.me)
        frm = self.future(1).isoformat()
        to = self.future(30).isoformat()
        data = self.client.get(
            f"{group_calendar_url(self.group)}?from={frm}&to={to}"
        ).json()
        ids = [e["id"] for e in data]
        self.assertIn(near.id, ids)
        self.assertNotIn(far.id, ids)
        self.assertNotIn(undated.id, ids)

    def test_personal_calendar_unions_and_excludes_left_groups(self):
        # A second group me is in, with a connected organiser there.
        other = make_group(self.me, name="Other")
        add_member(other, self.org)
        e1 = Event.objects.create(
            group=self.group, organiser=self.org, title="G1",
            event_date=self.future(4), status="scheduled",
        )
        e2 = Event.objects.create(
            group=other, organiser=self.org, title="G2",
            event_date=self.future(5), status="scheduled",
        )
        self.client.force_authenticate(self.me)
        ids = {e["id"] for e in self.client.get(PERSONAL_CALENDAR_URL).json()}
        self.assertEqual(ids, {e1.id, e2.id})

        # Leaving the second group drops its events from the personal union.
        GroupMembership.objects.filter(group=other, user=self.me).delete()
        ids = {e["id"] for e in self.client.get(PERSONAL_CALENDAR_URL).json()}
        self.assertEqual(ids, {e1.id})


class EventNotificationTests(EventsBase):
    def test_event_created_notifies_connected_members_only(self):
        self.client.force_authenticate(self.org)
        self.client.post(
            group_events_url(self.group), {"title": "Reunion"}, format="json"
        )
        # Connected members get a row…
        self.assertTrue(
            Notification.objects.filter(recipient=self.me, kind="event_created").exists()
        )
        self.assertTrue(
            Notification.objects.filter(recipient=self.admin, kind="event_created").exists()
        )
        # …the outsider (member, not connected to org) does not (connection gate)…
        self.assertFalse(
            Notification.objects.filter(recipient=self.outsider, kind="event_created").exists()
        )
        # …and the organiser never notifies themselves.
        self.assertFalse(
            Notification.objects.filter(recipient=self.org, kind="event_created").exists()
        )

    def test_poll_opened_and_event_scheduled_generated(self):
        event = self.make_event()
        self.client.force_authenticate(self.org)
        self.client.post(
            event_polls_url(event),
            {"dimension": "date",
             "options": [{"date_value": self.future(1).isoformat()},
                         {"date_value": self.future(2).isoformat()}]},
            format="json",
        )
        self.assertTrue(
            Notification.objects.filter(recipient=self.me, kind="poll_opened").exists()
        )
        self.client.post(
            event_finalise_url(event),
            {"dimension": "date", "value": self.future(1).isoformat()},
            format="json",
        )
        self.assertTrue(
            Notification.objects.filter(recipient=self.me, kind="event_scheduled").exists()
        )

    def test_muting_event_kind_suppresses_row(self):
        NotificationPreference.objects.create(
            user=self.me, kind="event_created", enabled=False
        )
        self.client.force_authenticate(self.org)
        self.client.post(
            group_events_url(self.group), {"title": "Muted"}, format="json"
        )
        self.assertFalse(
            Notification.objects.filter(recipient=self.me, kind="event_created").exists()
        )
        # A non-muter still gets it.
        self.assertTrue(
            Notification.objects.filter(recipient=self.admin, kind="event_created").exists()
        )


PUSH_TOKENS_URL = "/api/push-tokens/"


class DevicePushTokenTests(APITestCase):
    """Registering a device for push (Phase 9, Milestone A).

    No sending happens yet — Milestone D adds that. These pin the registration
    contract the app builds against, and the ownership rules that stop one
    person's phone receiving another's notifications.
    """

    def setUp(self):
        # Registration is throttled (per user), so clear the shared counter —
        # otherwise these tests inherit or leave state for each other.
        cache.clear()
        self.me = make_user("device-owner@example.com")
        self.other = make_user("someone-else@example.com")
        self.client.force_authenticate(self.me)

    def tearDown(self):
        cache.clear()

    def test_register_creates_a_token_for_the_caller(self):
        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[abc123]", "platform": "ios"},
            format="json",
        )

        # 200 with the preview credential (Phase 10b), not the original 204:
        # the plaintext exists here and nowhere else afterwards.
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        token = DevicePushToken.objects.get()
        self.assertEqual(token.user, self.me)
        self.assertEqual(token.platform, "ios")

    def test_re_registering_the_same_device_updates_rather_than_duplicates(self):
        # The app re-registers on every launch; that must not pile up rows.
        for _ in range(3):
            self.client.post(
                PUSH_TOKENS_URL,
                {"expo_token": "ExponentPushToken[abc123]", "platform": "ios"},
                format="json",
            )

        self.assertEqual(DevicePushToken.objects.count(), 1)

    def test_registering_a_device_moves_it_to_the_new_user(self):
        # A handed-on or shared phone must stop notifying its previous owner.
        DevicePushToken.objects.create(
            user=self.other,
            expo_token="ExponentPushToken[shared]",
            platform="ios",
        )

        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[shared]", "platform": "ios"},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(DevicePushToken.objects.count(), 1)
        self.assertEqual(DevicePushToken.objects.get().user, self.me)

    # --- The preview credential and its toggle (Phase 10b) --------------------

    def test_registering_issues_a_preview_credential(self):
        # The notification service extension can't use the account's tokens, so
        # registration is where it gets one of its own. Returned in plaintext
        # exactly once; stored hashed, so a database dump yields nothing usable.
        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[abc123]", "platform": "ios"},
            format="json",
        )

        raw = resp.data["preview_token"]
        self.assertTrue(raw)
        device = DevicePushToken.objects.get()
        self.assertNotIn(raw, device.preview_token_hash)
        self.assertEqual(
            device.preview_token_hash, DevicePushToken.hash_preview_token(raw)
        )

    def test_re_registering_replaces_the_preview_credential(self):
        # Rotating on every launch is what makes a lost credential self-repairing
        # — there is no separate recovery path to build. Safe only because
        # nothing but the app ever mints or writes it.
        first = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[abc123]", "platform": "ios"},
            format="json",
        ).data["preview_token"]

        second = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[abc123]", "platform": "ios"},
            format="json",
        ).data["preview_token"]

        self.assertNotEqual(first, second)
        self.assertEqual(
            DevicePushToken.objects.get().preview_token_hash,
            DevicePushToken.hash_preview_token(second),
        )

    def test_a_device_changing_hands_loses_its_preview_setting(self):
        # The row deliberately moves to the new user — but a preference about a
        # lock screen must not be inherited with it. Ada enables previews, logs
        # out, her partner logs in on the same tablet: a stranger's private
        # messages must not start rendering there.
        DevicePushToken.objects.create(
            user=self.other,
            expo_token="ExponentPushToken[shared]",
            platform="ios",
            show_previews=False,
        )

        self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[shared]", "platform": "ios"},
            format="json",
        )

        device = DevicePushToken.objects.get()
        self.assertEqual(device.user, self.me)
        # Reset to the *default*, not to off: the next owner starts where a
        # fresh install starts. Seeded off above so this can only pass by
        # resetting, not by inheriting.
        self.assertTrue(device.show_previews)

    def test_re_registering_your_own_device_keeps_your_preview_setting(self):
        # The other half: the app POSTs on *every* launch, so a reset that
        # didn't check ownership would undo the user's choice every cold start.
        # Seeded *off* — the opposite of the default — so this can only pass by
        # preserving what was there.
        DevicePushToken.objects.create(
            user=self.me,
            expo_token="ExponentPushToken[mine]",
            platform="ios",
            show_previews=False,
        )

        self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[mine]", "platform": "ios"},
            format="json",
        )

        self.assertFalse(DevicePushToken.objects.get().show_previews)

    def test_registration_answers_where_the_preview_setting_stands(self):
        # There is nowhere else to learn it, and the settings toggle has to
        # render the switch in the position it is actually in. Both values that
        # this endpoint can leave it in are worth pinning, because the
        # interesting one is the reset below.
        DevicePushToken.objects.create(
            user=self.me,
            expo_token="ExponentPushToken[mine]",
            platform="ios",
            show_previews=True,
        )

        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[mine]", "platform": "ios"},
            format="json",
        )

        self.assertTrue(resp.data["show_previews"])

    def test_a_device_changing_hands_says_so_in_the_response(self):
        # The reset is silent otherwise: the new owner's app would go on
        # showing the switch in the position the *previous* owner left it,
        # while the server has already turned it off. Someone would toggle it
        # off-then-on to fix a setting that was never on.
        DevicePushToken.objects.create(
            user=self.other,
            expo_token="ExponentPushToken[shared]",
            platform="ios",
            show_previews=False,
        )

        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[shared]", "platform": "ios"},
            format="json",
        )

        self.assertTrue(resp.data["show_previews"])

    def test_the_toggle_turns_previews_on_for_one_device(self):
        DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[mine]", platform="ios"
        )

        resp = self.client.patch(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[mine]", "show_previews": True},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertTrue(resp.data["show_previews"])
        self.assertTrue(DevicePushToken.objects.get().show_previews)

    def test_cannot_toggle_previews_on_someone_elses_device(self):
        # Same rule as unregister: a leaked token value must not let anyone turn
        # previews *on* for a phone they don't hold.
        DevicePushToken.objects.create(
            user=self.other,
            expo_token="ExponentPushToken[theirs]",
            platform="ios",
            # Seeded against the default, so "unchanged" and "the default" can't
            # be confused for one another — the assertion below has to fail if
            # the PATCH lands.
            show_previews=False,
        )

        resp = self.client.patch(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[theirs]", "show_previews": True},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(DevicePushToken.objects.get().show_previews)

    def test_unregister_deletes_the_token(self):
        DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[mine]", platform="ios"
        )

        resp = self.client.delete(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[mine]"},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(DevicePushToken.objects.exists())

    def test_cannot_unregister_someone_elses_device(self):
        # A leaked token value must not let anyone silence another user's phone.
        DevicePushToken.objects.create(
            user=self.other,
            expo_token="ExponentPushToken[theirs]",
            platform="ios",
        )

        resp = self.client.delete(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[theirs]"},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertTrue(DevicePushToken.objects.filter(user=self.other).exists())

    def test_registration_requires_authentication(self):
        self.client.force_authenticate(None)

        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[anon]", "platform": "ios"},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_platform_must_be_a_known_value(self):
        resp = self.client.post(
            PUSH_TOKENS_URL,
            {"expo_token": "ExponentPushToken[x]", "platform": "blackberry"},
            format="json",
        )

        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)


class ConversationPushPreviewTests(APITestCase):
    """🔒 The preview endpoint (Phase 10b).

    This is the one route that lets a message's *text* off the box in response
    to something other than a session, so its visibility rule is the security-
    critical part of the milestone. It reaches the same gate every other
    per-thread route starts from (``_thread_for_viewer``) rather than
    re-implementing one, which is why "who may see this" can't drift from the
    thread endpoint itself.

    Two shapes of refusal, and the distinction is deliberate:

    - **404** where the thread is *unreachable* — not a member, left, blocked.
      Never 403: this endpoint is reachable with a credential that has no other
      power, so a 403 would let anyone holding one walk conversation ids and map
      the install. (The phase plan called for 404 on a ``pending`` member too;
      that turned out to mean special-casing a state the shared gate lets
      through everywhere else, so those get the 204 below instead. Both are
      silent about content, and there is one gate rather than two.)
    - **204** where the thread is reachable but there is nothing this person may
      be shown. The extension treats it exactly like a timeout: keep the body
      the server already composed.
    """

    def setUp(self):
        cache.clear()
        self.ada = make_user("preview-ada@example.com", first_name="Ada")
        self.bea = make_user("preview-bea@example.com", first_name="Bea")
        self.stranger = make_user("preview-nobody@example.com")
        make_connection(self.ada, self.bea)
        self.device = DevicePushToken.objects.create(
            user=self.bea, expo_token="ExponentPushToken[bea]", platform="ios"
        )
        self.raw, self.device.preview_token_hash = (
            DevicePushToken.new_preview_token()
        )
        self.device.show_previews = True
        self.device.save()

    def tearDown(self):
        cache.clear()

    def _url(self, convo):
        return f"/api/conversations/{convo.id}/push-preview/"

    def _as_device(self, raw=None):
        # `is None`, not falsy: the empty-credential case below passes "" on
        # purpose, and `raw or self.raw` would hand it the real one instead.
        credential = self.raw if raw is None else raw
        self.client.credentials(HTTP_AUTHORIZATION=f"Preview {credential}")

    def _direct(self, *users):
        a, b = users or (self.ada, self.bea)
        convo = Conversation.objects.create(kind="direct", user_a=a, user_b=b)
        for user in (a, b):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=convo.created_at
            )
        return convo

    def _group(self, title="", members=None):
        convo = Conversation.objects.create(
            kind="group", title=title, created_by=self.ada
        )
        for user in members or (self.ada, self.bea):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=convo.created_at
            )
        return convo

    def _say(self, convo, sender, text="hello", **kwargs):
        return Message.objects.create(
            conversation=convo, sender=sender, text=text, **kwargs
        )

    # --- What it says ---------------------------------------------------------

    def test_it_returns_the_latest_message_text(self):
        convo = self._direct()
        self._say(convo, self.ada, "older")
        self._say(convo, self.ada, "the newest one")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["body"], "Ada: the newest one")

    def test_a_one_to_one_never_renders_a_trailing_in(self):
        # An unguarded concatenation of sender + conversation title puts "Ada in
        # " on every 1:1, because Conversation.title is blank by default.
        convo = self._direct()
        self._say(convo, self.ada, "no title here")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertNotIn(" in :", resp.data["body"])
        self.assertNotIn(" in ", resp.data["body"])

    def test_a_named_group_says_which_one(self):
        convo = self._group(title="Sunday Lunch")
        self._say(convo, self.ada, "who's bringing pudding")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(
            resp.data["body"], "Ada in Sunday Lunch: who's bringing pudding"
        )

    def test_an_untitled_group_falls_back_rather_than_inventing_a_name(self):
        convo = self._group()
        self._say(convo, self.ada, "hello all")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada: hello all")

    def test_a_mention_says_so_first(self):
        convo = self._group(title="Plans")
        message = self._say(convo, self.ada, "@Bea can you make it")
        MessageMention.objects.create(message=message, user=self.bea)
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(
            resp.data["body"], "Ada mentioned you in Plans: @Bea can you make it"
        )

    def test_an_uncaptioned_photo_still_says_a_photo_was_sent(self):
        # The case that decides the endpoint returns a finished body rather than
        # its ingredients: `text` is empty here, so a client assembling fields
        # would put a title over a blank line — strictly worse than today.
        convo = self._direct()
        message = self._say(convo, self.ada, text="")
        MessageAttachment.objects.create(
            message=message,
            file="m/a.jpg",
            thumbnail="m/a-t.jpg",
            width=10,
            height=10,
        )
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada sent a photo")

    def test_a_captioned_photo_shows_the_caption(self):
        convo = self._direct()
        message = self._say(convo, self.ada, text="look at this")
        MessageAttachment.objects.create(
            message=message,
            file="m/a.jpg",
            thumbnail="m/a-t.jpg",
            width=10,
            height=10,
        )
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada sent a photo: look at this")

    def test_newlines_are_collapsed_so_the_body_stays_one_line(self):
        # A multi-line body is the one way a preview would look visibly unlike
        # the contentless notification it replaces.
        convo = self._direct()
        self._say(convo, self.ada, "line one\n\nline   two\ttabbed")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada: line one line two tabbed")

    def test_a_long_message_is_truncated_server_side(self):
        # One number, on the side that can be tested — and shortening it later
        # doesn't need an app release.
        convo = self._direct()
        self._say(convo, self.ada, "x" * 400)
        self._as_device()

        resp = self.client.get(self._url(convo))

        body = resp.data["body"]
        self.assertTrue(body.endswith("…"))
        self.assertEqual(len(body), len("Ada: ") + notifications.PREVIEW_TEXT_LIMIT + 1)

    def test_it_reports_the_unread_count(self):
        convo = self._direct()
        self._say(convo, self.ada, "one")
        self._say(convo, self.ada, "two")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["unread_count"], 2)

    # --- Who may see it -------------------------------------------------------

    def test_a_non_participant_gets_404(self):
        # 404, never 403: ids are sequential, so a 403 would say how many
        # private threads the install has and roughly when each was created.
        convo = self._direct(self.ada, self.stranger)
        self._say(convo, self.ada, "not for Bea")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_participant_who_left_gets_404(self):
        convo = self._group(title="Old Chat")
        self._say(convo, self.ada, "still talking")
        Participant.objects.filter(conversation=convo, user=self.bea).update(
            left_at=timezone.now()
        )
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_pending_participant_is_told_nothing(self):
        # They can't read a line of the thread yet, so there is nothing to
        # preview — 204, and the extension keeps the contentless body.
        convo = Conversation.objects.create(
            kind="group", title="Not yet", created_by=self.ada
        )
        ada = Participant.objects.create(
            conversation=convo, user=self.ada, status="active"
        )
        ParticipantInterval.objects.create(
            participant=ada, started_at=convo.created_at
        )
        Participant.objects.create(
            conversation=convo, user=self.bea, status="pending"
        )
        self._say(convo, self.ada, "members only")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_a_message_sent_during_an_interval_gap_is_not_previewed(self):
        # The interval rule, which is what stops a re-promoted member seeing
        # what was said while they were out. The preview falls back to the
        # newest message they *may* read rather than refusing outright: they can
        # open the thread and see that one, so there is nothing to withhold.
        convo = self._group(title="Gap")
        self._say(convo, self.ada, "before")
        bea = Participant.objects.get(conversation=convo, user=self.bea)
        deactivate(bea, timezone.now())
        self._say(convo, self.ada, "said while Bea was out")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada in Gap: before")
        self.assertNotIn("while Bea was out", resp.data["body"])

    def test_your_own_messages_are_skipped(self):
        # Reply from the web between a push being queued and delivered, and
        # without this the lock screen shows "New message from Ada" over your
        # own words.
        convo = self._direct()
        self._say(convo, self.ada, "theirs")
        self._say(convo, self.bea, "mine, sent from the laptop")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada: theirs")

    def test_a_thread_of_only_your_own_messages_gives_204(self):
        convo = self._direct()
        self._say(convo, self.bea, "just me talking")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_a_deleted_message_is_skipped(self):
        convo = self._direct()
        self._say(convo, self.ada, "still here")
        self._say(convo, self.ada, text="", deleted_at=timezone.now())
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada: still here")

    def test_a_muted_participant_still_gets_a_preview(self):
        # Mute is a *delivery* policy, not a permission one. By the time this is
        # called a push has already been delivered, so the mute question was
        # answered upstream at enqueue — including the @mention carve-out that
        # beats it. Second-guessing it here would blank the previews for exactly
        # the mentions that were allowed through to be read.
        convo = self._group(title="Busy")
        Participant.objects.filter(conversation=convo, user=self.bea).update(
            muted_at=timezone.now()
        )
        self._say(convo, self.ada, "quietly")
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.data["body"], "Ada in Busy: quietly")

    # --- The credential -------------------------------------------------------

    def test_a_device_with_previews_off_is_told_nothing(self):
        # It shouldn't be asking — its pushes carry no mutableContent, so its
        # extension is never woken — but the flag is the user's decision and
        # this is the side that enforces it.
        convo = self._direct()
        self._say(convo, self.ada, "private")
        self.device.show_previews = False
        self.device.save(update_fields=["show_previews"])
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    def test_no_credential_is_401(self):
        convo = self._direct()
        self._say(convo, self.ada, "private")

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_a_wrong_credential_is_401(self):
        convo = self._direct()
        self._say(convo, self.ada, "private")
        self._as_device(raw="not-a-real-credential")

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_an_empty_credential_is_refused_without_a_lookup(self):
        # Devices registered before Phase 10b carry an empty `preview_token_hash`.
        # They are not reachable by sending an empty credential — `sha256("")` is
        # a 64-character digest and can never equal `""` — but the empty case is
        # rejected up front anyway, which is the only version of this check that
        # can actually fire, and it saves the query.
        DevicePushToken.objects.create(
            user=self.ada, expo_token="ExponentPushToken[old]", platform="ios"
        )
        convo = self._direct()
        self._say(convo, self.ada, "private")
        self._as_device(raw="")

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_the_accounts_own_bearer_token_cannot_use_this_endpoint(self):
        # The other half of "this credential's only power is one GET": the
        # endpoint accepts the preview credential and nothing else, so the two
        # can't be quietly substituted for one another in either direction.
        # A real Bearer token rather than force_authenticate, which bypasses the
        # authentication classes entirely and so would pass whatever they said.
        from rest_framework_simplejwt.tokens import AccessToken

        convo = self._direct()
        self._say(convo, self.ada, "private")
        self.client.credentials(
            HTTP_AUTHORIZATION=f"Bearer {AccessToken.for_user(self.bea)}"
        )

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_a_deactivated_owner_stops_getting_previews(self):
        # The admin-approval / ban gate, honoured here as everywhere else: the
        # device row can outlive the session that created it.
        convo = self._direct()
        self._say(convo, self.ada, "private")
        self.bea.is_active = False
        self.bea.save(update_fields=["is_active"])
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logging_out_kills_the_credential(self):
        # Why the credential lives on the device row rather than being a JWT:
        # revoking it is the row delete logout already does, with no blacklist
        # and no second lifecycle to keep in sync.
        convo = self._direct()
        self._say(convo, self.ada, "private")
        self.device.delete()
        self._as_device()

        resp = self.client.get(self._url(convo))

        self.assertEqual(resp.status_code, status.HTTP_401_UNAUTHORIZED)


class _FakeExpoResponse:
    """Stand-in for urlopen's context-managed HTTP response."""

    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _ok_tickets(n):
    return {"data": [{"status": "ok", "id": f"ticket-{i}"} for i in range(n)]}


class PushOutboxEnqueueTests(APITestCase):
    """Queueing a push alongside a notification (Phase 9, Milestone D).

    The enqueue lives in ``create_notification`` precisely so it inherits that
    function's existing gates — these pin that it really does.
    """

    def setUp(self):
        self.me = make_user("push-recipient@example.com")
        self.actor = make_user("push-actor@example.com")
        make_connection(self.me, self.actor)
        self.post = Post.objects.create(author=self.me, text="hello")

    def test_creating_a_notification_queues_a_push(self):
        n = notifications.create_notification(
            self.me, self.actor, Notification.Kind.POST_REPLY, post=self.post
        )

        self.assertIsNotNone(n)
        self.assertEqual(PushOutbox.objects.count(), 1)
        self.assertEqual(PushOutbox.objects.get().notification, n)

    def test_a_muted_kind_queues_nothing(self):
        # The mute check is *only* in create_notification; if push ever grew its
        # own copy this test would still pass while the real gate rotted, so it
        # asserts the notification is absent too.
        NotificationPreference.objects.create(
            user=self.me, kind=Notification.Kind.POST_REPLY, enabled=False
        )

        n = notifications.create_notification(
            self.me, self.actor, Notification.Kind.POST_REPLY, post=self.post
        )

        self.assertIsNone(n)
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(PushOutbox.objects.count(), 0)

    def test_notifying_yourself_queues_nothing(self):
        notifications.create_notification(
            self.me, self.me, Notification.Kind.POST_REPLY, post=self.post
        )

        self.assertEqual(PushOutbox.objects.count(), 0)

    def test_a_deduped_reaction_does_not_queue_a_second_push(self):
        # React / un-react / re-react refreshes one unread row rather than
        # stacking. The phone was already buzzed for it, so it must not buzz
        # again for the same still-unread thing.
        for _ in range(3):
            notifications.create_notification(
                self.me, self.actor, Notification.Kind.REACTION, post=self.post
            )

        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(PushOutbox.objects.count(), 1)

    def test_deleting_the_target_removes_the_queued_push(self):
        # Cascade chain: Post → Notification → PushOutbox. This is what makes a
        # push for since-deleted content impossible rather than merely unlikely.
        notifications.create_notification(
            self.me, self.actor, Notification.Kind.POST_REPLY, post=self.post
        )
        self.post.delete()

        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(PushOutbox.objects.count(), 0)


class MessagePushEnqueueTests(APITestCase):
    """Queueing a push for a new **message** (issue #118).

    Messages don't create ``Notification`` rows — messaging keeps its own unread
    badge and is deliberately outside the activity centre — so these gates live
    in ``enqueue_message_pushes`` rather than being inherited from
    ``create_notification``. That makes them worth pinning individually.
    """

    def setUp(self):
        self.ada = make_user("msg-push-ada@example.com", first_name="Ada")
        self.bea = make_user("msg-push-bea@example.com", first_name="Bea")
        make_connection(self.ada, self.bea)

    def _direct(self):
        """A direct thread with the Participant rows + open intervals a real one
        gets (via ``_ensure_direct_participants``), since visibility is decided
        off the intervals."""
        convo = Conversation.objects.create(
            kind="direct", user_a=self.ada, user_b=self.bea
        )
        for user in (self.ada, self.bea):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=convo.created_at
            )
        return convo

    def _send(self, convo, sender, text="hi"):
        message = Message.objects.create(
            conversation=convo, sender=sender, text=text
        )
        notifications.enqueue_message_pushes(message)
        return message

    def _queued_for(self, user):
        return PushOutbox.objects.filter(recipient=user, sent_at__isnull=True)

    def test_a_message_queues_a_push_for_the_other_person(self):
        convo = self._direct()
        message = self._send(convo, self.ada)

        row = self._queued_for(self.bea).get()
        self.assertEqual(row.message, message)
        # The message target is used, *not* a notification — the whole point of
        # issue #118 is that this never shows up in the activity centre.
        self.assertIsNone(row.notification)
        self.assertEqual(Notification.objects.count(), 0)

    def test_the_sender_is_never_queued(self):
        convo = self._direct()
        self._send(convo, self.ada)

        self.assertFalse(self._queued_for(self.ada).exists())

    def test_a_muted_thread_queues_nothing(self):
        convo = self._direct()
        Participant.objects.filter(conversation=convo, user=self.bea).update(
            muted_at=timezone.now()
        )

        self._send(convo, self.ada)

        self.assertFalse(self._queued_for(self.bea).exists())

    def test_muting_is_per_person_not_per_thread(self):
        # Bea muting must not silence the same conversation for Cal.
        cal = make_user("msg-push-cal@example.com", first_name="Cal")
        make_connection(self.ada, cal)
        make_connection(self.bea, cal)
        convo = Conversation.objects.create(kind="group", created_by=self.ada)
        for user in (self.ada, self.bea, cal):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=timezone.now()
            )
        Participant.objects.filter(conversation=convo, user=self.bea).update(
            muted_at=timezone.now()
        )

        self._send(convo, self.ada)

        self.assertFalse(self._queued_for(self.bea).exists())
        self.assertTrue(self._queued_for(cal).exists())

    def test_a_pending_member_is_not_queued(self):
        # Pending = invited but not yet connected to everyone. They can't read
        # the thread at all, so buzzing them would announce something the app
        # would then refuse to show.
        cal = make_user("msg-push-pending@example.com")
        make_connection(self.ada, cal)
        convo = Conversation.objects.create(kind="group", created_by=self.ada)
        for user, st in [(self.ada, "active"), (self.bea, "active"), (cal, "pending")]:
            p = Participant.objects.create(
                conversation=convo, user=user, status=st
            )
            if st == "active":
                ParticipantInterval.objects.create(
                    participant=p, started_at=timezone.now()
                )

        self._send(convo, self.ada)

        self.assertFalse(self._queued_for(cal).exists())
        self.assertTrue(self._queued_for(self.bea).exists())

    def test_a_member_in_an_interval_gap_is_not_queued(self):
        # The subtle case: an *active* member whose access interval is closed at
        # the moment the message lands. `visible_messages_for` clips it out of
        # their thread, so the push must be clipped too — the two rules have to
        # agree or the app shows an empty thread for a message it just announced.
        convo = Conversation.objects.create(kind="group", created_by=self.ada)
        pa = Participant.objects.create(
            conversation=convo, user=self.ada, status="active"
        )
        pb = Participant.objects.create(
            conversation=convo, user=self.bea, status="active"
        )
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        ParticipantInterval.objects.create(participant=pb, started_at=timezone.now())
        deactivate(pb, timezone.now())

        gap_message = self._send(convo, self.ada, text="during the gap")

        self.assertFalse(self._queued_for(self.bea).exists())
        self.assertNotIn(
            gap_message.id,
            set(visible_messages_for(convo, self.bea).values_list("id", flat=True)),
        )

    def test_a_returning_member_is_queued_again(self):
        # The other half of the gap rule: reopening an interval must restore the
        # buzz, or a rejoined member goes permanently silent.
        convo = Conversation.objects.create(kind="group", created_by=self.ada)
        pa = Participant.objects.create(
            conversation=convo, user=self.ada, status="active"
        )
        pb = Participant.objects.create(
            conversation=convo, user=self.bea, status="active"
        )
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        ParticipantInterval.objects.create(participant=pb, started_at=timezone.now())
        deactivate(pb, timezone.now())
        self._send(convo, self.ada, text="during the gap")
        activate(pb, timezone.now())

        self._send(convo, self.ada, text="welcome back")

        self.assertEqual(self._queued_for(self.bea).count(), 1)

    def test_a_burst_of_messages_queues_one_push(self):
        # Ten messages must not mean ten buzzes; the unread badge carries the
        # count. Without coalescing the outbox would faithfully deliver all ten.
        convo = self._direct()
        for i in range(10):
            self._send(convo, self.ada, text=f"message {i}")

        self.assertEqual(self._queued_for(self.bea).count(), 1)

    def test_a_new_push_is_queued_once_the_previous_one_is_sent(self):
        # Coalescing keys off *unsent* rows only, so a later message still buzzes
        # rather than the thread going quiet forever after the first push.
        convo = self._direct()
        self._send(convo, self.ada, text="first")
        self._queued_for(self.bea).update(sent_at=timezone.now())

        self._send(convo, self.ada, text="second")

        self.assertEqual(self._queued_for(self.bea).count(), 1)

    def test_deleting_the_conversation_removes_the_queued_push(self):
        # Cascade chain: Conversation → Message → PushOutbox, matching the
        # notification path's Post → Notification → PushOutbox guarantee.
        convo = self._direct()
        self._send(convo, self.ada)
        convo.delete()

        self.assertEqual(PushOutbox.objects.count(), 0)

    def test_sending_via_the_api_queues_a_push(self):
        # The unit tests above call the helper directly; this pins that the view
        # actually calls it, which is the wiring that would silently rot.
        convo = self._direct()
        self.client.force_authenticate(self.ada)

        response = self.client.post(
            f"/api/conversations/{convo.id}/messages/", {"text": "hello"}
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(self._queued_for(self.bea).count(), 1)


class ConversationMuteTests(APITestCase):
    """Muting a thread's pushes (issue #118)."""

    def setUp(self):
        self.ada = make_user("mute-ada@example.com")
        self.bea = make_user("mute-bea@example.com")
        make_connection(self.ada, self.bea)
        self.convo = Conversation.objects.create(
            kind="direct", user_a=self.ada, user_b=self.bea
        )
        for user in (self.ada, self.bea):
            p = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=self.convo.created_at
            )
        self.url = f"/api/conversations/{self.convo.id}/mute/"

    def test_mute_then_unmute(self):
        self.client.force_authenticate(self.ada)

        muted = self.client.post(self.url)
        self.assertEqual(muted.status_code, 200)
        self.assertTrue(muted.data["muted"])
        self.assertIsNotNone(
            Participant.objects.get(
                conversation=self.convo, user=self.ada
            ).muted_at
        )

        unmuted = self.client.delete(self.url)
        self.assertEqual(unmuted.status_code, 200)
        self.assertFalse(unmuted.data["muted"])
        self.assertIsNone(
            Participant.objects.get(
                conversation=self.convo, user=self.ada
            ).muted_at
        )

    def test_the_serializer_reports_your_own_mute_state(self):
        self.client.force_authenticate(self.ada)
        self.client.post(self.url)

        mine = self.client.get(f"/api/conversations/{self.convo.id}/")
        self.assertTrue(mine.data["muted"])

        # Bea sees the same thread as unmuted — mute is per-participant.
        self.client.force_authenticate(self.bea)
        theirs = self.client.get(f"/api/conversations/{self.convo.id}/")
        self.assertFalse(theirs.data["muted"])

    def test_muting_does_not_hide_the_thread_or_its_unread_count(self):
        # Mute means "don't buzz me", not "hide this" — someone must never lose
        # a conversation by silencing it.
        self.client.force_authenticate(self.bea)
        self.client.post(self.url)
        Message.objects.create(
            conversation=self.convo, sender=self.ada, text="still here"
        )

        listed = self.client.get("/api/conversations/")
        row = [c for c in listed.data["results"] if c["id"] == self.convo.id]
        self.assertEqual(len(row), 1)
        self.assertEqual(row[0]["unread_count"], 1)

    def test_a_non_member_gets_404(self):
        outsider = make_user("mute-outsider@example.com")
        self.client.force_authenticate(outsider)

        self.assertEqual(self.client.post(self.url).status_code, 404)


class ConversationRenameTests(APITestCase):
    """Renaming a group chat (Phase 9b M6).

    A title used to be settable only at creation, so "Weekend plans" outlived
    the weekend. The rules are the interesting part: who may, what may be
    renamed, and — the one that regresses quietly — that it doesn't reorder
    anyone's conversation list.
    """

    def setUp(self):
        self.ada = make_user("rename-ada@example.com")
        self.bea = make_user("rename-bea@example.com")
        self.cal = make_user("rename-cal@example.com")
        make_connection(self.ada, self.bea)
        make_connection(self.ada, self.cal)
        self.client.force_authenticate(self.ada)
        self.convo_id = self.client.post(
            CONVERSATIONS_URL,
            {"participant_ids": [self.bea.id, self.cal.id], "title": "Weekend plans"},
            format="json",
        ).data["id"]
        self.url = f"/api/conversations/{self.convo_id}/"

    def _rename(self, title):
        return self.client.patch(self.url, {"title": title}, format="json")

    def test_an_active_member_renames_the_chat(self):
        resp = self._rename("Sunday lunch")
        self.assertEqual(resp.status_code, 200)
        # The response is the same payload a GET returns, so the header the
        # caller just changed needs no second round trip to refresh.
        self.assertEqual(resp.data["title"], "Sunday lunch")
        self.assertEqual(
            Conversation.objects.get(pk=self.convo_id).title, "Sunday lunch"
        )

    def test_any_active_member_may_rename_not_only_the_creator(self):
        # Chats have no admin role at all, and inventing one for a text field
        # would be the wrong place to start.
        self.client.force_authenticate(self.bea)
        self.assertEqual(self._rename("Bea's idea").status_code, 200)

    def test_a_pending_member_cannot_rename(self):
        # Cal is pending (not connected to Bea) — the waiting room can't write
        # to the thread, and a title is writing to the thread.
        self.client.force_authenticate(self.cal)
        resp = self._rename("Let me in")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(
            Conversation.objects.get(pk=self.convo_id).title, "Weekend plans"
        )

    def test_a_non_member_gets_404(self):
        outsider = make_user("rename-outsider@example.com")
        self.client.force_authenticate(outsider)
        self.assertEqual(self._rename("mine now").status_code, 404)

    def test_a_direct_chat_cannot_be_renamed(self):
        """A 1:1's name *is* the other person, resolved per-viewer — there's no
        shared title, and letting one side rename the other would be a small
        act of vandalism."""
        direct = self.client.post(
            CONVERSATIONS_URL, {"user_id": self.bea.id}, format="json"
        ).data["id"]
        resp = self.client.patch(
            f"/api/conversations/{direct}/", {"title": "Nope"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Conversation.objects.get(pk=direct).title, "")

    def test_a_blank_title_clears_it(self):
        # Clearing is a real thing to want: both clients then fall back to the
        # members' names, which beats a stale title.
        self.assertEqual(self._rename("").status_code, 200)
        self.assertEqual(Conversation.objects.get(pk=self.convo_id).title, "")

    def test_whitespace_only_is_stored_as_blank(self):
        # Otherwise a "name" of spaces renders as an untitled chat with the
        # members-names fallback suppressed — blank-looking, and unfixable
        # without noticing why.
        self.assertEqual(self._rename("   ").status_code, 200)
        self.assertEqual(Conversation.objects.get(pk=self.convo_id).title, "")

    def test_an_oversized_title_is_rejected(self):
        resp = self._rename("x" * (CONVERSATION_TITLE_MAX_LENGTH + 1))
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            Conversation.objects.get(pk=self.convo_id).title, "Weekend plans"
        )

    def test_renaming_does_not_bump_the_thread_up_the_list(self):
        """The pairing that regresses quietly, like the edit route's.

        A rename isn't activity, so it must not jump the thread to the top of
        everyone's conversation list — while the *name* has to update
        everywhere, which it does because the list re-reads it per request.
        """
        convo = Conversation.objects.get(pk=self.convo_id)
        before = convo.updated_at

        self._rename("Sunday lunch")

        convo.refresh_from_db()
        self.assertEqual(convo.updated_at, before)
        row = [
            c
            for c in self.client.get(CONVERSATIONS_URL).data["results"]
            if c["id"] == self.convo_id
        ][0]
        self.assertEqual(row["title"], "Sunday lunch")


class EventSeenOnViewTests(EventsBase):
    """Opening an event marks its notifications seen — the same
    viewing-is-seeing rule as the post permalink, for the five event kinds."""

    def test_event_detail_marks_its_notifications_seen(self):
        event = self.make_event()
        other = self.make_event(title="Other")
        mine = Notification.objects.create(
            recipient=self.me, actor=self.org,
            kind=Notification.Kind.EVENT_CREATED, event=event,
        )
        mine_other = Notification.objects.create(
            recipient=self.me, actor=self.org,
            kind=Notification.Kind.EVENT_CREATED, event=other,
        )
        anas = Notification.objects.create(
            recipient=self.ana, actor=self.org,
            kind=Notification.Kind.EVENT_CREATED, event=event,
        )
        self.client.force_authenticate(self.me)
        resp = self.client.get(event_url(event))
        self.assertEqual(resp.status_code, 200)
        mine.refresh_from_db()
        mine_other.refresh_from_db()
        anas.refresh_from_db()
        self.assertIsNotNone(mine.seen_at)
        self.assertIsNone(mine.addressed_at)  # seen, not acted on
        self.assertIsNone(mine_other.seen_at)  # a different event's news
        self.assertIsNone(anas.seen_at)  # another recipient's row


# --- Comments and reactions on an event ------------------------------------


def event_comments_url(e):
    return f"/api/events/{e.pk}/comments/"


def react_event_url(e):
    return f"/api/events/{e.pk}/react/"


def event_reactions_url(e):
    return f"/api/events/{e.pk}/reactions/"


class EventCommentTests(EventsBase):
    """An event's comment thread — the same feature as a post's, on a target
    reached through a different gate.

    ``EventsBase`` is exactly the fixture this needs: ``me`` and ``ana`` are
    both connected to the organiser (so both can see the event) and **not** to
    each other, which is the case where the two gates come apart.
    """

    def test_connected_member_can_read_and_write_the_thread(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_comments_url(event), {"text": "Bringing a cake"}, format="json"
        )
        self.assertEqual(resp.status_code, 201)
        thread = self.client.get(event_comments_url(event))
        self.assertEqual(thread.status_code, 200)
        self.assertEqual([c["text"] for c in thread.json()], ["Bringing a cake"])
        # It really did land on the event, not on some post.
        comment = Comment.objects.get(pk=resp.json()["id"])
        self.assertEqual(comment.event_id, event.id)
        self.assertIsNone(comment.post_id)

    def test_member_not_connected_to_organiser_404s_the_thread(self):
        # The event doesn't exist for the outsider, so neither does its
        # conversation — and a 404 rather than a 403, so the thread can't
        # confirm an event they're not allowed to know about.
        event = self.make_event()
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.client.get(event_comments_url(event)).status_code, 404)
        self.assertEqual(
            self.client.post(
                event_comments_url(event), {"text": "hi"}, format="json"
            ).status_code,
            404,
        )

    def test_nonmember_404s_the_thread(self):
        event = self.make_event()
        self.client.force_authenticate(self.nonmember)
        self.assertEqual(self.client.get(event_comments_url(event)).status_code, 404)

    def test_thread_prunes_to_the_viewers_connections(self):
        """The two gates compose. ``me`` and ``ana`` can both see the event
        (both connected to the organiser) but not each other — so each sees the
        organiser's comment and their own, never the other's."""
        event = self.make_event()
        Comment.objects.create(event=event, author=self.org, text="from the organiser")
        Comment.objects.create(event=event, author=self.ana, text="from ana")
        Comment.objects.create(event=event, author=self.me, text="from me")

        self.client.force_authenticate(self.me)
        texts = [c["text"] for c in self.client.get(event_comments_url(event)).json()]
        self.assertEqual(sorted(texts), ["from me", "from the organiser"])

    def test_a_hidden_comment_takes_its_replies_with_it(self):
        """Subtree pruning, the same rule as a post's thread: a reply from
        someone you *can* see is still hidden under a parent you can't."""
        event = self.make_event()
        anas = Comment.objects.create(event=event, author=self.ana, text="ana asks")
        Comment.objects.create(
            event=event, author=self.org, parent=anas, text="organiser answers"
        )

        self.client.force_authenticate(self.me)
        self.assertEqual(self.client.get(event_comments_url(event)).json(), [])

    def test_reply_must_be_on_the_same_event(self):
        """A parent from another thread is refused, and refused with the same
        sentence an unknown id gets — the ids share one space, so comparing the
        wrong field would let another event's comment through by coincidence of
        numbering."""
        event = self.make_event()
        other = self.make_event(title="Other")
        elsewhere = Comment.objects.create(
            event=other, author=self.org, text="different event"
        )
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_comments_url(event),
            {"text": "reply", "parent": elsewhere.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["parent"], [PARENT_UNAVAILABLE])

    def test_reply_from_a_post_thread_is_refused(self):
        """The other direction of the same confusion: a *post's* comment named
        as the parent of an event comment."""
        # me is already connected to org (EventsBase), so this post and its
        # comment are genuinely visible — the refusal below is about the
        # *thread*, not about visibility.
        post = Post.objects.create(author=self.org, text="a post")
        on_post = Comment.objects.create(post=post, author=self.org, text="on a post")
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_comments_url(event),
            {"text": "reply", "parent": on_post.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["parent"], [PARENT_UNAVAILABLE])

    def test_a_cancelled_event_keeps_its_thread(self):
        """The tombstone is kept so RSVP'd members can see what happened, and
        "sorry, can't do the new date" is exactly the conversation a
        cancellation starts. Closing the thread at the moment it becomes most
        useful would be the wrong reading of what the tombstone is for."""
        event = self.make_event(status="cancelled")
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_comments_url(event), {"text": "shame!"}, format="json"
        )
        self.assertEqual(resp.status_code, 201)

    def test_deleting_the_event_takes_the_thread_with_it(self):
        event = self.make_event()
        Comment.objects.create(event=event, author=self.me, text="doomed")
        event.delete()
        self.assertFalse(Comment.objects.filter(text="doomed").exists())

    def test_event_comment_can_be_edited_and_deleted_by_its_author(self):
        """Through the existing ``/comments/<pk>/`` route, which never needed to
        know what the comment hangs off."""
        event = self.make_event()
        self.client.force_authenticate(self.me)
        cid = self.client.post(
            event_comments_url(event), {"text": "typo"}, format="json"
        ).json()["id"]

        edit = self.client.patch(
            f"/api/comments/{cid}/", {"text": "fixed"}, format="json"
        )
        self.assertEqual(edit.status_code, 200)
        self.assertEqual(edit.json()["text"], "fixed")
        self.assertIsNotNone(edit.json()["edited_at"])

        self.assertEqual(
            self.client.delete(f"/api/comments/{cid}/").status_code, 204
        )
        self.assertFalse(Comment.objects.filter(pk=cid).exists())

    def test_someone_who_cannot_see_the_event_cannot_touch_its_comments(self):
        """``can_view_comment`` routes an event comment through
        ``can_view_event``, so the outsider gets the same 404 on the comment
        that they get on the event."""
        event = self.make_event()
        comment = Comment.objects.create(
            event=event, author=self.org, text="members only"
        )
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.post(
                react_comment_url(comment), {"emoji": "👍"}, format="json"
            ).status_code,
            404,
        )

    def test_counts_ride_on_the_event_payload(self):
        event = self.make_event()
        Comment.objects.create(event=event, author=self.org, text="one")
        Comment.objects.create(event=event, author=self.ana, text="hidden from me")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        # Counts honour the same prune the thread does — ana's is not counted.
        self.assertEqual(detail["comment_count"], 1)
        self.assertEqual(detail["new_comment_count"], 1)

        # Opening the thread clears "new" without changing the total.
        self.client.get(event_comments_url(event))
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(detail["comment_count"], 1)
        self.assertEqual(detail["new_comment_count"], 0)

    def test_list_and_calendar_payloads_carry_the_counts(self):
        """Every surface that renders an event pays for its counts. A list that
        skipped them would report 0, which is indistinguishable from an event
        nobody has commented on."""
        event = self.make_event(event_date=self.future(), status="scheduled")
        Comment.objects.create(event=event, author=self.org, text="one")

        self.client.force_authenticate(self.me)
        for url in (
            f"{group_events_url(self.group)}?window=upcoming",
            group_calendar_url(self.group),
            PERSONAL_CALENDAR_URL,
        ):
            with self.subTest(url=url):
                row = next(
                    e for e in self.client.get(url).json() if e["id"] == event.id
                )
                self.assertEqual(row["comment_count"], 1)


class EventReactionTests(EventsBase):
    """Reactions on an event itself.

    **Pruned per viewer, like a post's** — deliberately unlike the poll and RSVP
    tallies on the same page, which are complete. A tally is a shared
    coordination number; a reaction is a personal signal.
    """

    def test_toggle_adds_then_removes(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            react_event_url(event), {"emoji": "🎉"}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(summary_for(resp.json()["reactions"], "🎉")["count"], 1)
        self.assertTrue(summary_for(resp.json()["reactions"], "🎉")["reacted"])

        again = self.client.post(
            react_event_url(event), {"emoji": "🎉"}, format="json"
        )
        self.assertIsNone(summary_for(again.json()["reactions"], "🎉"))

    def test_count_is_pruned_to_who_the_viewer_may_see(self):
        """The inversion of the poll rule, and the point of this test: ana can
        see the event and react to it, but ``me`` isn't connected to ana, so
        ana's reaction neither counts nor names her."""
        event = self.make_event()
        Reaction.objects.create(user=self.ana, event=event, emoji="🎉")
        Reaction.objects.create(user=self.org, event=event, emoji="🎉")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(summary_for(detail["reactions"], "🎉")["count"], 1)

        listed = self.client.get(event_reactions_url(event)).json()
        names = [u["display_name"] for r in listed for u in r["users"]]
        self.assertEqual(names, [self.org.display_name])

    def test_rsvp_counts_stay_complete_on_the_same_event(self):
        """Both rules on one page, which is the decision worth pinning: the
        reaction above is pruned, the RSVP below is not."""
        event = self.make_event()
        EventRSVP.objects.create(event=event, user=self.ana, response="going")
        Reaction.objects.create(user=self.ana, event=event, emoji="🎉")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(detail["rsvp"]["counts"]["going"], 1)  # complete
        self.assertIsNone(summary_for(detail["reactions"], "🎉"))  # pruned

    def test_invisible_event_404s_both_routes(self):
        event = self.make_event()
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.post(
                react_event_url(event), {"emoji": "🎉"}, format="json"
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(event_reactions_url(event)).status_code, 404
        )


class EventCommentNotificationTests(EventsBase):
    """Who gets told, and where the link goes."""

    def test_top_level_comment_notifies_the_organiser(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        self.client.post(
            event_comments_url(event), {"text": "can I bring a friend?"},
            format="json",
        )
        note = Notification.objects.get(
            recipient=self.org, kind=Notification.Kind.EVENT_COMMENT
        )
        self.assertEqual(note.event_id, event.id)
        self.assertEqual(note.actor_id, self.me.id)

    def test_organisers_own_comment_notifies_nobody(self):
        event = self.make_event()
        self.client.force_authenticate(self.org)
        self.client.post(event_comments_url(event), {"text": "hi all"}, format="json")
        self.assertFalse(
            Notification.objects.filter(
                kind=Notification.Kind.EVENT_COMMENT
            ).exists()
        )

    def test_reply_notifies_the_parents_author_and_deep_links_to_the_event(self):
        event = self.make_event()
        mine = Comment.objects.create(event=event, author=self.me, text="question")
        self.client.force_authenticate(self.org)
        self.client.post(
            event_comments_url(event),
            {"text": "yes of course", "parent": mine.pk},
            format="json",
        )
        note = Notification.objects.get(
            recipient=self.me, kind=Notification.Kind.COMMENT_REPLY
        )
        self.client.force_authenticate(self.me)
        row = next(
            n for n in self.client.get("/api/notifications/").json()["results"]
            if n["id"] == note.id
        )
        # Not `/p/None?comment=…`, which is what reading `post_id` unguarded
        # produces for an event comment: a link that looks real and 404s.
        self.assertEqual(
            row["url"],
            f"/g/{self.group.id}/events/{event.id}?comment={note.comment_id}",
        )

    def test_opening_the_event_sees_its_comment_notifications(self):
        """Reading the reply is why the badge should stop counting it — the
        ``comment__event`` half of ``see_event_notifications``."""
        event = self.make_event()
        mine = Comment.objects.create(event=event, author=self.me, text="q")
        reply = Comment.objects.create(
            event=event, author=self.org, parent=mine, text="a"
        )
        note = Notification.objects.create(
            recipient=self.me, actor=self.org,
            kind=Notification.Kind.COMMENT_REPLY, comment=reply,
        )
        self.client.force_authenticate(self.me)
        self.client.get(event_url(event))
        note.refresh_from_db()
        self.assertIsNotNone(note.seen_at)

    def test_reacting_to_an_event_notifies_its_organiser(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        self.client.post(react_event_url(event), {"emoji": "🎉"}, format="json")
        note = Notification.objects.get(
            recipient=self.org, kind=Notification.Kind.REACTION
        )
        self.assertEqual(note.event_id, event.id)
        self.client.force_authenticate(self.org)
        row = next(
            n for n in self.client.get("/api/notifications/").json()["results"]
            if n["id"] == note.id
        )
        self.assertIn("reacted to your event", row["text"])
        self.assertEqual(
            row["url"], f"/g/{self.group.id}/events/{event.id}"
        )


def event_photos_url(e):
    return f"/api/events/{e.pk}/photos/"


def event_photo_url(p):
    return f"/api/event-photos/{p.pk}/"


@override_settings(MEDIA_ROOT=_PHOTO_MEDIA_ROOT)
class EventPhotoBase(EventsBase):
    """Shared helper for the album tests — every one of them uploads files, so
    they all need the throwaway ``MEDIA_ROOT`` the post-photo tests use."""

    @classmethod
    def tearDownClass(cls):
        # Our own sweep, not a borrowed one. ``PhotoPostTests`` wipes the same
        # root, but only ever gets to on a *full* run where it happens to sort
        # last; running one album class on its own would otherwise leave its
        # JPEGs in the temp dir for good. Removing the root more than once in a
        # run is harmless — file storage recreates the directories it needs.
        shutil.rmtree(_PHOTO_MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def add_photo(self, event, uploader, name="p.jpg"):
        """Add one photo through the **API**, not the ORM.

        Deliberately: the view is where the pipeline, the caps and the
        notification live, and a fixture built with ``EventPhoto.objects.create``
        would test a row shape rather than the feature.
        """
        self.client.force_authenticate(uploader)
        resp = self.client.post(
            event_photos_url(event),
            {"photos": [make_image_upload(name)]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return EventPhoto.objects.get(pk=resp.json()[0]["id"])


class EventPhotoVisibilityTests(EventPhotoBase):
    """The album prunes per viewer on the **uploader** — the authored-content
    rule the event's comments and reactions follow, *not* the complete-count
    rule its polls and RSVP follow.

    ``me`` and ``ana`` are both connected to the organiser and neither is
    connected to the other, which is the whole shape this feature has to get
    right: two people at the same event who can't see each other's posts.
    """

    def test_album_hides_a_photo_from_someone_you_are_not_connected_to(self):
        event = self.make_event()
        self.add_photo(event, self.org, "org.jpg")
        self.add_photo(event, self.ana, "ana.jpg")
        mine = self.add_photo(event, self.me, "me.jpg")

        self.client.force_authenticate(self.me)
        listed = self.client.get(event_photos_url(event)).json()
        uploaders = {p["uploader"]["id"] for p in listed["results"]}
        self.assertEqual(uploaders, {self.org.id, self.me.id})
        self.assertEqual(listed["count"], 2)
        self.assertIn(mine.id, {p["id"] for p in listed["results"]})

    def test_photo_count_on_the_event_is_pruned_too(self):
        """The count has to prune with the list, or the "+N more" overlay
        promises photos the lightbox will never show."""
        event = self.make_event()
        self.add_photo(event, self.org, "org.jpg")
        self.add_photo(event, self.ana, "ana.jpg")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(detail["photo_count"], 1)
        self.assertEqual(
            [p["uploader"]["id"] for p in detail["photos"]], [self.org.id]
        )

    def test_the_organiser_sees_every_photo(self):
        """No carve-out needed: the audience *is* the organiser's connections,
        so the one gate already puts everyone in front of them."""
        event = self.make_event()
        self.add_photo(event, self.me, "me.jpg")
        self.add_photo(event, self.ana, "ana.jpg")

        self.client.force_authenticate(self.org)
        self.assertEqual(self.client.get(event_url(event)).json()["photo_count"], 2)

    def test_rsvp_count_stays_complete_beside_a_pruned_album(self):
        """Both rules on one page, pinned side by side exactly as
        ``EventReactionTests`` pins the reaction/RSVP pair. The split follows
        the thing being counted: an RSVP is a shared coordination number, a
        photo is authored content."""
        event = self.make_event()
        EventRSVP.objects.create(event=event, user=self.ana, response="going")
        self.add_photo(event, self.ana, "ana.jpg")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(detail["rsvp"]["counts"]["going"], 1)  # complete
        self.assertEqual(detail["photo_count"], 0)  # pruned

    def test_a_deactivated_members_photos_leave_the_album(self):
        """🔒 Deactivating an account is the maintainer's takedown lever, and it
        has to reach everything that account authored.

        The organiser has to be somebody *else*: deactivating the organiser
        404s the whole event out from under the viewer (``can_view_event``
        needs a living organiser), which would pass this test for the wrong
        reason. So `admin` organises — and `me` needs a connection to them to
        see it at all, which the base fixture doesn't give — while `org`, whose
        photos `me` genuinely can see, is the one banned.
        """
        make_connection(self.me, self.admin)
        event = self.make_event(organiser=self.admin)
        self.add_photo(event, self.org, "org.jpg")
        self.add_photo(event, self.me, "me.jpg")

        self.client.force_authenticate(self.me)
        self.assertEqual(self.client.get(event_url(event)).json()["photo_count"], 2)

        self.org.is_active = False
        self.org.save(update_fields=["is_active"])

        detail = self.client.get(event_url(event)).json()
        self.assertEqual(detail["photo_count"], 1)
        self.assertEqual(
            [p["uploader"]["id"] for p in detail["photos"]], [self.me.id]
        )
        listed = self.client.get(event_photos_url(event)).json()
        self.assertEqual(listed["count"], 1)

    def test_invisible_event_404s_both_verbs(self):
        event = self.make_event()
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.get(event_photos_url(event)).status_code, 404
        )
        self.assertEqual(
            self.client.post(
                event_photos_url(event),
                {"photos": [make_image_upload()]},
                format="multipart",
            ).status_code,
            404,
        )

    def test_nonmember_404s(self):
        event = self.make_event()
        self.client.force_authenticate(self.nonmember)
        self.assertEqual(
            self.client.get(event_photos_url(event)).status_code, 404
        )


class EventPhotoUploadTests(EventPhotoBase):
    """Adding to the album: who may, what's rejected, and what the pipeline
    does to the file on its way in."""

    def test_any_member_who_can_see_the_event_can_add(self):
        """The deliberate asymmetry with the rest of events: polls and
        finalising are the organiser's, the photos are whoever took them."""
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.assertEqual(photo.uploader_id, self.me.id)

    def test_uploader_is_taken_from_the_session_not_the_body(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_photos_url(event),
            {"photos": [make_image_upload()], "uploader": self.org.id},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            EventPhoto.objects.get(pk=resp.json()[0]["id"]).uploader_id, self.me.id
        )

    def test_several_photos_in_one_request(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_photos_url(event),
            {"photos": [make_image_upload("a.jpg"), make_image_upload("b.jpg")]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(resp.json()), 2)
        self.assertEqual(EventPhoto.objects.filter(event=event).count(), 2)

    def test_empty_upload_is_rejected(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(event_photos_url(event), {}, format="multipart")
        self.assertEqual(resp.status_code, 400)

    def test_too_many_in_one_request_is_rejected(self):
        event = self.make_event()
        self.client.force_authenticate(self.me)
        files = [
            make_image_upload(f"{i}.jpg")
            for i in range(MAX_PHOTOS_PER_UPLOAD + 1)
        ]
        resp = self.client.post(
            event_photos_url(event), {"photos": files}, format="multipart"
        )
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(EventPhoto.objects.filter(event=event).exists())

    def test_album_cap_counts_every_photo_not_just_the_visible_ones(self):
        """The cap is a storage bound, not a visibility rule. Counting only the
        uploader's own slice of a pruned album would let the true total drift
        past the cap one connection-group at a time."""
        event = self.make_event()
        EventPhoto.objects.bulk_create(
            EventPhoto(
                event=event, uploader=self.ana, image="x.jpg",
                thumbnail="t.jpg", width=1, height=1,
            )
            for _ in range(MAX_PHOTOS_PER_EVENT)
        )
        self.client.force_authenticate(self.me)  # sees none of ana's
        resp = self.client.post(
            event_photos_url(event),
            {"photos": [make_image_upload()]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("full", str(resp.json()["photos"]).lower())

    def test_one_bad_file_rejects_the_whole_batch(self):
        """Processed up front, as a post's photos are — a half-uploaded batch
        is worse than a failed one, and the message names the offender."""
        event = self.make_event()
        bad = SimpleUploadedFile("notes.txt", b"not an image", content_type="image/jpeg")
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_photos_url(event),
            {"photos": [make_image_upload("good.jpg"), bad]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("notes.txt", str(resp.json()["photos"]))
        self.assertFalse(EventPhoto.objects.filter(event=event).exists())

    def test_exif_gps_is_stripped(self):
        """Routed through the same ``process_image`` a post photo is, so the
        privacy guarantee is inherited rather than re-implemented. This test
        exists to prove the *routing*, not to re-test the pipeline."""
        exif = Image.Exif()
        exif[0x0110] = "SecretCameraModel"  # the Model tag, as PhotoPostTests uses
        upload = make_image_upload("located.jpg", exif=exif)
        self.assertTrue(len(Image.open(upload).getexif()) > 0)  # sanity
        upload.seek(0)

        event = self.make_event()
        self.client.force_authenticate(self.me)
        resp = self.client.post(
            event_photos_url(event), {"photos": [upload]}, format="multipart"
        )
        self.assertEqual(resp.status_code, 201)
        photo = EventPhoto.objects.get(pk=resp.json()[0]["id"])
        with Image.open(photo.image.path) as stored:
            self.assertEqual(len(stored.getexif()), 0)

    def test_allowed_on_a_cancelled_event(self):
        """A cancellation that turned into a pub instead is still a day people
        photographed — the same reading of the tombstone the comment thread
        takes."""
        event = self.make_event(status=Event.Status.CANCELLED)
        self.add_photo(event, self.me)

    def test_allowed_on_a_past_event(self):
        """The after-the-fact half of the feature, and the common case."""
        event = self.make_event(
            event_date=timezone.localdate() - timedelta(days=3),
            status=Event.Status.SCHEDULED,
        )
        self.add_photo(event, self.me)


class EventPhotoDeleteTests(EventPhotoBase):
    """Three people may remove a photo, and everyone else gets the same
    404/403 split ``CommentDetailView`` uses — owner first, then a 404 for
    anything the album's prune hides from you."""

    def test_uploader_can_remove_their_own(self):
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.client.force_authenticate(self.me)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 204
        )
        self.assertFalse(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_organiser_can_remove_anyones(self):
        """"Anyone's" within the album *they* see — which for the organiser is
        the whole album, with no carve-out: the audience is their connections,
        so every uploader is one of them by construction."""
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.client.force_authenticate(self.org)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 204
        )

    def test_group_admin_can_remove_a_photo_they_can_see(self):
        event = self.make_event()
        make_connection(self.admin, self.me)
        photo = self.add_photo(event, self.me)
        self.client.force_authenticate(self.admin)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 204
        )

    def test_group_admin_cannot_reach_a_photo_the_prune_hides_from_them(self):
        """Deliberate, and the one place the moderation pair stops short.

        The album's per-viewer prune is **not** widened for group admins:
        widening it would make an album the first place in TimeLine that shows
        you content from someone you never connected with, on the app's most
        sensitive content type. So a group admin moderates what they can see and
        no more, and the lever behind them is ``EventPhotoAdmin`` (see
        ``EventPhotoAdminTests``), not a query with an admin branch in it.

        It's a 404 rather than a 403 for the same reason it is for anyone else:
        the id is sequential and global.
        """
        event = self.make_event()
        photo = self.add_photo(event, self.me)  # admin is not connected to me
        self.client.force_authenticate(self.admin)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 404
        )
        self.assertTrue(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_a_photo_the_album_hides_from_you_is_a_404_not_a_403(self):
        """🔒 The id is the leak. ``ana`` can see the event but not ``me``'s
        photos, and ``EventPhoto.id`` is a global sequential key — so a 403 here
        would answer "does row N exist, and is it on an event I'm in?" for
        content uploaded by people she has never connected with, walkable id by
        id. That's an existence-and-count oracle over the most sensitive content
        type in the app, so a photo she can't see has to be as absent as one
        that was never there.

        A 403 is still the right answer for a photo she *can* see but may not
        remove — that's the case below, and the two together are exactly the
        split ``can_view_comment`` draws.
        """
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.client.force_authenticate(self.ana)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 404
        )
        # Indistinguishable from an id that was never issued.
        self.assertEqual(
            self.client.delete(f"/api/event-photos/{photo.pk + 9999}/").status_code,
            404,
        )
        self.assertTrue(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_a_visible_photo_you_do_not_own_is_a_403(self):
        """The other half of the split: ``ana`` and ``me`` can both see the
        organiser's photos, and neither may tidy up his album."""
        event = self.make_event()
        photo = self.add_photo(event, self.org)
        self.client.force_authenticate(self.ana)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 403
        )
        self.assertTrue(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_a_deactivated_uploaders_photo_is_a_404_to_a_plain_member(self):
        """Deactivation drops the photo out of ``ana``'s album, so it has to
        drop out of the id space too — otherwise the takedown lever leaves an
        oracle behind."""
        make_connection(self.ana, self.me)
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.me.is_active = False
        self.me.save(update_fields=["is_active"])

        self.client.force_authenticate(self.ana)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 404
        )

    def test_someone_who_cannot_see_the_event_gets_404(self):
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        self.client.force_authenticate(self.outsider)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 404
        )

    def test_uploader_can_still_remove_a_photo_after_leaving_the_group(self):
        """Your photo stays yours to take down. Leaving the group closes the
        event to you, and there is no other self-service route to the album —
        so gating the owner on visibility would strand a photo you regret
        somewhere you can no longer reach it. Same rule, same order, as
        ``CommentDetailView``: the owner check runs *before* the gate.
        """
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        GroupMembership.objects.filter(group=self.group, user=self.me).delete()

        self.client.force_authenticate(self.me)
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 204
        )
        self.assertFalse(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_uploader_can_still_remove_a_photo_after_disconnecting_from_the_organiser(self):
        """The other way you lose sight of your own photo: the event's gate is
        keyed on the organiser, so disconnecting from them 404s the whole event
        out from under you while your photo is still sitting in it."""
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        Connection.objects.filter(
            Q(requester=self.org, requestee=self.me)
            | Q(requester=self.me, requestee=self.org)
        ).delete()

        self.client.force_authenticate(self.me)
        # The event really is gone for them…
        self.assertEqual(self.client.get(event_url(event)).status_code, 404)
        # …and the photo is still theirs to remove.
        self.assertEqual(
            self.client.delete(event_photo_url(photo)).status_code, 204
        )
        self.assertFalse(EventPhoto.objects.filter(pk=photo.pk).exists())

    def test_can_delete_flag_matches_the_three_limbs(self):
        event = self.make_event()
        self.add_photo(event, self.org, "org.jpg")
        mine = self.add_photo(event, self.me, "me.jpg")

        self.client.force_authenticate(self.me)
        by_id = {
            p["id"]: p
            for p in self.client.get(event_photos_url(event)).json()["results"]
        }
        self.assertTrue(by_id[mine.id]["can_delete"])
        self.assertFalse(
            next(p for p in by_id.values() if p["id"] != mine.id)["can_delete"]
        )

        self.client.force_authenticate(self.admin)
        listed = self.client.get(event_photos_url(event)).json()["results"]
        self.assertTrue(all(p["can_delete"] for p in listed))

    def test_delete_sweeps_the_files(self):
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        image_path, thumb_path = photo.image.path, photo.thumbnail.path
        self.assertTrue(os.path.exists(image_path))

        self.client.force_authenticate(self.me)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(event_photo_url(photo))
        self.assertFalse(os.path.exists(image_path))
        self.assertFalse(os.path.exists(thumb_path))

    def test_a_delete_that_fails_does_not_take_the_files_with_it(self):
        """The sweep has to be registered **after** the row goes, inside the
        transaction that removes it.

        ``ATOMIC_REQUESTS`` is off, so in production there is no open
        transaction here and Django runs an ``on_commit`` callback *inline*.
        Registering the sweep first therefore unlinked both JPEGs immediately
        and only then tried the delete — and a delete that failed left a live
        row pointing at two files that no longer existed. ``test_delete_sweeps
        _the_files`` above can't catch that: ``captureOnCommitCallbacks`` opens
        an atomic block production doesn't have, which defers the callback and
        makes the wrong order look like the right one. This one asserts on the
        callback itself, so it sees the difference.
        """
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        image_path, thumb_path = photo.image.path, photo.thumbnail.path

        self.client.force_authenticate(self.me)
        with mock.patch.object(
            EventPhoto, "delete", side_effect=DatabaseError("delete failed")
        ):
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                with self.assertRaises(DatabaseError):
                    self.client.delete(event_photo_url(photo))

        self.assertEqual(callbacks, [])
        self.assertTrue(os.path.exists(image_path))
        self.assertTrue(os.path.exists(thumb_path))
        self.assertTrue(EventPhoto.objects.filter(pk=photo.pk).exists())


class EventPhotoFileSweepTests(EventPhotoBase):
    """A database cascade takes the rows; it never touches storage. Every path
    that can destroy an album has to gather its files first."""

    def test_deleting_the_event_sweeps_everyones_photos(self):
        event = self.make_event()
        mine = self.add_photo(event, self.me, "me.jpg")
        theirs = self.add_photo(event, self.ana, "ana.jpg")
        paths = [mine.image.path, theirs.image.path]

        self.client.force_authenticate(self.org)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(event_url(event)).status_code, 204
            )
        for path in paths:
            self.assertFalse(os.path.exists(path), path)

    def test_deleting_the_group_sweeps_its_events_photos(self):
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        path = photo.image.path

        self.client.force_authenticate(self.admin)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"/api/groups/{self.group.pk}/")
        self.assertFalse(os.path.exists(path))

    def test_deleting_an_account_sweeps_photos_it_uploaded(self):
        event = self.make_event()
        photo = self.add_photo(event, self.me)
        path = photo.image.path

        self.client.force_authenticate(self.me)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
            )
        self.assertFalse(os.path.exists(path))

    def test_deleting_an_organiser_sweeps_other_peoples_photos_on_their_events(self):
        """The trap: ``Event.organiser`` is CASCADE, so deleting the organiser
        destroys albums full of *other members'* files. Gathering only the
        departing user's own photos leaves those orphaned on disk."""
        event = self.make_event()
        photo = self.add_photo(event, self.me)  # me's photo, org's event
        path = photo.image.path

        self.client.force_authenticate(self.org)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                DELETE_ACCOUNT_URL, {"password": PASSWORD}, format="json"
            )
        self.assertFalse(os.path.exists(path))


class EventPhotoPayloadTests(EventPhotoBase):
    """``photos``/``photo_count`` ride every surface that renders an event.

    A list endpoint that doesn't pay for them says ``0``, which is
    indistinguishable from an empty album — the same rule (and the same failure
    mode) as the comment counts.
    """

    def test_every_event_list_carries_the_album(self):
        event = self.make_event(
            event_date=self.future(), status=Event.Status.SCHEDULED
        )
        self.add_photo(event, self.org)

        self.client.force_authenticate(self.me)
        for label, url in (
            ("group events", group_events_url(self.group)),
            ("group calendar", group_calendar_url(self.group)),
            ("personal calendar", "/api/calendar/"),
        ):
            with self.subTest(surface=label):
                rows = self.client.get(url).json()
                row = next(r for r in rows if r["id"] == event.id)
                self.assertEqual(row["photo_count"], 1, label)
                self.assertEqual(len(row["photos"]), 1, label)

    def test_previews_are_capped_but_the_count_is_not(self):
        """The "+N more" overlay depends on these being two different numbers."""
        event = self.make_event()
        for i in range(EVENT_PHOTO_PREVIEW_COUNT + 3):
            self.add_photo(event, self.org, f"{i}.jpg")

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(len(detail["photos"]), EVENT_PHOTO_PREVIEW_COUNT)
        self.assertEqual(detail["photo_count"], EVENT_PHOTO_PREVIEW_COUNT + 3)

    def test_previews_are_the_albums_first_photos_in_album_order(self):
        """The window's ordering has to match the model's, or the four tiles on
        a card are a different four from the first page of the album."""
        event = self.make_event()
        ids = [
            self.add_photo(event, self.org, f"{i}.jpg").id
            for i in range(EVENT_PHOTO_PREVIEW_COUNT + 2)
        ]

        self.client.force_authenticate(self.me)
        detail = self.client.get(event_url(event)).json()
        self.assertEqual(
            [p["id"] for p in detail["photos"]],
            ids[:EVENT_PHOTO_PREVIEW_COUNT],
        )

    def test_previews_are_the_albums_own_first_page_in_the_same_order(self):
        """Stronger than the test above, and the one that matters to a tap.

        The card renders the previews as tiles and hands the lightbox the index
        of the tile you touched; the lightbox then reads the *album* endpoint.
        So the two queries don't merely have to be sorted — they have to be
        sorted the **same way**, or tapping the third tile opens somebody else's
        fourth photo. Compared endpoint-against-endpoint rather than against a
        list this test built, because a locally-remembered order can agree with
        both of them while they disagree with each other.
        """
        event = self.make_event()
        for i in range(EVENT_PHOTO_PREVIEW_COUNT + 3):
            self.add_photo(event, self.org, f"{i}.jpg")

        self.client.force_authenticate(self.me)
        previews = self.client.get(event_url(event)).json()["photos"]
        album = self.client.get(event_photos_url(event)).json()["results"]
        self.assertEqual(
            [p["id"] for p in previews],
            [p["id"] for p in album[:EVENT_PHOTO_PREVIEW_COUNT]],
        )

    def test_the_preview_query_orders_its_outer_select(self):
        """The guarantee behind the two tests above, pinned where it can fail.

        ``event_photo_previews`` annotates a window function and then filters on
        it, which Django compiles into a wrapping ``qualify`` subquery — so the
        ordering the tiles depend on has to sit on the **outer** select. Calling
        ``.order_by()`` with no arguments clears ``Meta.ordering`` and leaves
        that outer select with none, at which point the row order is whatever
        the plan happens to hand back and a tile's index stops meaning anything.

        This is asserted against the SQL rather than the response because
        Postgres computes a window function over sorted input and today emits
        the rows in that order anyway — so the endpoint comparisons above stay
        green either way. They pin what the clients need; this pins the thing
        that actually promises it.
        """
        event = self.make_event()
        self.add_photo(event, self.org)

        self.client.force_authenticate(self.me)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(event_url(event))
        windowed = [
            q["sql"] for q in ctx.captured_queries if "ROW_NUMBER()" in q["sql"]
        ]
        self.assertEqual(len(windowed), 1, windowed)
        sql = windowed[0]
        # The last WHERE is the subquery-wrapper's ``rank <= N``; an ORDER BY
        # after it is on the outer select. Without one the only ORDER BY left is
        # the window's own, inside ``OVER (…)``, which orders nothing that comes
        # back.
        self.assertGreater(sql.rfind("ORDER BY"), sql.rfind("WHERE"), sql)

    def test_a_photo_carries_what_a_grid_and_a_lightbox_need(self):
        event = self.make_event()
        self.add_photo(event, self.me)
        self.client.force_authenticate(self.me)
        photo = self.client.get(event_url(event)).json()["photos"][0]
        for field in ("id", "image", "thumbnail", "width", "height",
                      "uploader", "created_at", "can_delete"):
            self.assertIn(field, photo)
        self.assertTrue(photo["image"].startswith("http"))

    def test_previews_cost_the_same_however_big_the_album_gets(self):
        """The reason ``event_photo_previews`` is a window function and not a
        prefetch. Asserted as *no growth* rather than an absolute number: the
        exact count is incidental and would make this test a tripwire for every
        unrelated query change, whereas growth is the actual failure — one query
        per event, or a prefetch that drags every row of every album back to
        render four tiles."""
        self.client.force_authenticate(self.me)

        small = self.make_event(title="Small")
        self.add_photo(small, self.org, "s.jpg")
        self.client.force_authenticate(self.me)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(group_events_url(self.group))
        baseline = len(ctx)

        # Four more events, and a fat album on the first one.
        for i in range(4):
            event = self.make_event(title=f"E{i}")
            self.add_photo(event, self.org, f"{i}.jpg")
        for i in range(12):
            self.add_photo(small, self.org, f"extra{i}.jpg")

        self.client.force_authenticate(self.me)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(group_events_url(self.group))
        self.assertEqual(len(ctx), baseline)


class EventPhotoAdminTests(EventPhotoBase):
    """🔒 The maintainer's takedown lever has to reach an event album.

    The album prunes per viewer on the uploader and that prune is deliberately
    **not** widened for a group's admins — so a photo can sit in an album with
    no in-app route to removal at all, if its uploader is connected to nobody
    with moderation powers. That's an acceptable shape only because the
    maintainer's route reaches everything; before ``EventPhotoAdmin`` existed it
    stopped short of here.
    """

    def setUp(self):
        super().setUp()
        self.staff = User.objects.create_superuser(
            email="root@example.com", password=PASSWORD
        )
        self.client.force_login(self.staff)

    def test_the_admin_sees_a_photo_no_member_can_moderate(self):
        """``ana``'s photo, on ``org``'s event, in ``admin``'s group: the group
        admin isn't connected to her, so it isn't in *their* album."""
        event = self.make_event()
        photo = self.add_photo(event, self.ana, "ana.jpg")
        self.client.force_login(self.staff)

        changelist = self.client.get("/admin/api/eventphoto/")
        self.assertEqual(changelist.status_code, 200)
        self.assertIn("ana@x.com", changelist.content.decode())
        self.assertEqual(
            self.client.get(f"/admin/api/eventphoto/{photo.pk}/change/").status_code,
            200,
        )

    def test_the_admin_delete_takes_the_row_and_the_files(self):
        """A takedown that leaves the JPEG on disk isn't a takedown, and a
        database delete never touches storage."""
        event = self.make_event()
        photo = self.add_photo(event, self.ana, "ana.jpg")
        image_path, thumb_path = photo.image.path, photo.thumbnail.path
        self.client.force_login(self.staff)

        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/admin/api/eventphoto/{photo.pk}/delete/", {"post": "yes"}
            )
        self.assertEqual(resp.status_code, 302)
        self.assertFalse(EventPhoto.objects.filter(pk=photo.pk).exists())
        self.assertFalse(os.path.exists(image_path))
        self.assertFalse(os.path.exists(thumb_path))

    def test_photos_cannot_be_added_through_the_admin(self):
        """Uploads go through the validated API pipeline (EXIF/GPS stripped,
        re-encoded) or not at all."""
        self.client.force_login(self.staff)
        self.assertEqual(
            self.client.get("/admin/api/eventphoto/add/").status_code, 403
        )


class EventPhotoNotificationTests(EventPhotoBase):
    """Who gets told photos are up."""

    def _rsvp(self, event, user, response):
        EventRSVP.objects.create(event=event, user=user, response=response)

    def test_going_and_maybe_are_told(self):
        event = self.make_event()
        self._rsvp(event, self.me, "going")
        self._rsvp(event, self.admin, "maybe")
        self.add_photo(event, self.org)

        for user in (self.me, self.admin):
            self.assertTrue(
                Notification.objects.filter(
                    recipient=user, kind=Notification.Kind.EVENT_PHOTOS,
                    event=event,
                ).exists(),
                user,
            )

    def test_declined_and_silent_members_are_not(self):
        event = self.make_event()
        self._rsvp(event, self.me, "declined")
        self.add_photo(event, self.org)
        self.assertFalse(
            Notification.objects.filter(
                kind=Notification.Kind.EVENT_PHOTOS
            ).exists()
        )

    def test_the_uploader_is_never_told(self):
        event = self.make_event()
        self._rsvp(event, self.me, "going")
        self.add_photo(event, self.me)
        self.assertFalse(
            Notification.objects.filter(
                recipient=self.me, kind=Notification.Kind.EVENT_PHOTOS
            ).exists()
        )

    def test_an_organiser_who_rsvpd_is_told(self):
        """The organiser is the one recipient the other event kinds exclude,
        because there they're the actor. Here the actor is the uploader."""
        event = self.make_event()
        self._rsvp(event, self.org, "going")
        self.add_photo(event, self.me)
        self.assertTrue(
            Notification.objects.filter(
                recipient=self.org, kind=Notification.Kind.EVENT_PHOTOS
            ).exists()
        )

    def test_someone_not_connected_to_the_uploader_is_not_told(self):
        """The gate doing real work, which is what makes this kind different
        from the five organiser broadcasts: ``ana`` is going, but she can't see
        ``me``'s photos, so telling her would link her to an empty page."""
        event = self.make_event()
        self._rsvp(event, self.ana, "going")
        self.add_photo(event, self.me)
        self.assertFalse(
            Notification.objects.filter(
                recipient=self.ana, kind=Notification.Kind.EVENT_PHOTOS
            ).exists()
        )

    def test_a_second_batch_refreshes_one_unread_row_and_does_not_buzz_again(self):
        """People upload in batches — eight now, four more when they notice
        them. That's one thing that happened."""
        event = self.make_event()
        self._rsvp(event, self.me, "going")
        self.add_photo(event, self.org, "a.jpg")
        self.add_photo(event, self.org, "b.jpg")

        notes = Notification.objects.filter(
            recipient=self.me, kind=Notification.Kind.EVENT_PHOTOS
        )
        self.assertEqual(notes.count(), 1)
        self.assertEqual(
            PushOutbox.objects.filter(notification__in=notes).count(), 1
        )

    def test_reading_the_event_clears_it(self):
        event = self.make_event()
        self._rsvp(event, self.me, "going")
        self.add_photo(event, self.org)
        note = Notification.objects.get(
            recipient=self.me, kind=Notification.Kind.EVENT_PHOTOS
        )

        self.client.force_authenticate(self.me)
        self.client.get(event_url(event))
        note.refresh_from_db()
        self.assertIsNotNone(note.seen_at)

    def test_text_and_deep_link(self):
        event = self.make_event(title="Camping")
        self._rsvp(event, self.me, "going")
        self.add_photo(event, self.org)

        self.client.force_authenticate(self.me)
        row = next(
            n for n in self.client.get("/api/notifications/").json()["results"]
            if n["kind"] == "event_photos"
        )
        self.assertIn("added photos to Camping", row["text"])
        self.assertEqual(row["url"], f"/g/{self.group.id}/events/{event.id}")
        self.assertEqual(row["target"], {"type": "event", "id": event.id})

    def test_android_channel_is_events_not_replies(self):
        """It's the organiser-broadcast shape (an announcement about the event),
        not the ``event_comment`` shape (somebody answering you)."""
        self.assertEqual(
            notifications.channel_for_kind(Notification.Kind.EVENT_PHOTOS),
            "events",
        )

    def test_the_preference_can_be_muted(self):
        event = self.make_event()
        self._rsvp(event, self.me, "going")
        NotificationPreference.objects.create(
            user=self.me, kind=Notification.Kind.EVENT_PHOTOS, enabled=False
        )
        self.add_photo(event, self.org)
        self.assertFalse(
            Notification.objects.filter(
                recipient=self.me, kind=Notification.Kind.EVENT_PHOTOS
            ).exists()
        )

    def _going_crowd(self, event, size, connected_to):
        """``size`` members who are going and connected to ``connected_to`` — an
        audience every one of whom must be told."""
        for i in range(size):
            user = make_user(f"crowd{event.id}-{i}@x.com")
            add_member(self.group, user)
            make_connection(connected_to, user)
            self._rsvp(event, user, "going")

    def test_the_fan_out_does_not_grow_with_the_audience(self):
        """The album's notify step is a **broadcast**, and it runs in the same
        request that has just decoded and re-encoded the upload, on one worker.

        Notifying one recipient at a time cost about seven statements each —
        preference, connection ``EXISTS``, dedup, ``BEGIN``, two inserts,
        ``COMMIT`` — so thirty people going meant over two hundred queries
        behind a photo upload. Asserted as *no growth* rather than an absolute
        number, for the same reason
        ``test_previews_cost_the_same_however_big_the_album_gets`` is: the exact
        count is incidental, the growth is the bug.
        """
        small = self.make_event(title="Small")
        self._going_crowd(small, 2, self.me)
        big = self.make_event(title="Big")
        self._going_crowd(big, 12, self.me)

        self.client.force_authenticate(self.me)
        counts = []
        for event in (small, big):
            with CaptureQueriesContext(connection) as ctx:
                resp = self.client.post(
                    event_photos_url(event),
                    {"photos": [make_image_upload()]},
                    format="multipart",
                )
            self.assertEqual(resp.status_code, 201, resp.content)
            counts.append(len(ctx))
        self.assertEqual(counts[1], counts[0])

        # …and everyone still got told. A bounded query count that reaches
        # nobody would pass the assertion above and break the feature.
        self.assertEqual(
            Notification.objects.filter(
                kind=Notification.Kind.EVENT_PHOTOS, event=big
            ).count(),
            12,
        )
        self.assertEqual(
            PushOutbox.objects.filter(notification__event=big).count(), 12
        )


class MarkConversationUnreadTests(APITestCase):
    """Marking a thread unread again (Phase 9b M6) — ``DELETE
    /conversations/<id>/read/``.

    Used constantly by people who treat the badge as a to-do list. The tests
    are mostly about *where the marker lands*, because the obvious
    implementation (drop the read row) makes a fully-read thread come back
    claiming its entire history is unread.
    """

    def setUp(self):
        self.ada = make_user("unread-ada@example.com")
        self.bea = make_user("unread-bea@example.com")
        make_connection(self.ada, self.bea)
        self.convo = Conversation.objects.create(
            kind="direct", user_a=self.ada, user_b=self.bea
        )
        for user in (self.ada, self.bea):
            p = Participant.objects.create(
                conversation=self.convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=self.convo.created_at
            )
        self.url = f"/api/conversations/{self.convo.id}/read/"
        self.client.force_authenticate(self.ada)

    def _unread_count(self):
        return self.client.get(f"/api/conversations/{self.convo.id}/").data[
            "unread_count"
        ]

    def test_marks_a_read_thread_unread_again(self):
        Message.objects.create(
            conversation=self.convo, sender=self.bea, text="are you free?"
        )
        self.client.post(self.url)
        self.assertEqual(self._unread_count(), 0)

        resp = self.client.delete(self.url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["unread_count"], 1)
        self.assertEqual(self._unread_count(), 1)

    def test_a_long_read_thread_comes_back_as_one_unread_not_all_of_it(self):
        """The whole reason this isn't a delete of the read row.

        With no marker at all, every message in the history counts as unread, so
        flagging a chat you've read to the end would return it wearing "99+".
        The count means "this many are waiting for you", so it has to be one.
        """
        for i in range(12):
            Message.objects.create(
                conversation=self.convo, sender=self.bea, text=f"message {i}"
            )
        self.client.post(self.url)

        self.client.delete(self.url)
        self.assertEqual(self._unread_count(), 1)

    def test_it_aims_past_your_own_trailing_messages(self):
        """Your own messages never count toward unread, so parking the marker
        behind one would produce a thread that says it's read the moment
        anything refreshes it."""
        Message.objects.create(
            conversation=self.convo, sender=self.bea, text="are you free?"
        )
        Message.objects.create(
            conversation=self.convo, sender=self.ada, text="just a sec"
        )
        self.client.post(self.url)

        self.client.delete(self.url)
        self.assertEqual(self._unread_count(), 1)

    def test_a_tombstone_is_not_the_target(self):
        # A deleted message doesn't count toward unread either — aiming at one
        # would be the same silent no-op as aiming at your own.
        keeper = Message.objects.create(
            conversation=self.convo, sender=self.bea, text="are you free?"
        )
        deleted = Message.objects.create(
            conversation=self.convo, sender=self.bea, text="ignore me"
        )
        self.client.force_authenticate(self.bea)
        self.client.delete(
            f"/api/conversations/{self.convo.id}/messages/{deleted.pk}/"
        )
        self.client.force_authenticate(self.ada)
        self.client.post(self.url)

        self.client.delete(self.url)
        self.assertEqual(self._unread_count(), 1)
        marker = ConversationRead.objects.get(
            conversation=self.convo, user=self.ada
        ).last_read_at
        self.assertLess(marker, keeper.created_at)

    def test_nothing_to_mark_unread_is_a_400(self):
        # An empty thread, or one where every message is yours. A 200 that
        # visibly does nothing is worse than saying so.
        self.assertEqual(self.client.delete(self.url).status_code, 400)

        Message.objects.create(
            conversation=self.convo, sender=self.ada, text="anyone there?"
        )
        self.assertEqual(self.client.delete(self.url).status_code, 400)

    def test_a_message_from_inside_your_gap_is_not_the_target(self):
        """🔒 Interval clipping, the rule everything in this file goes through.

        A member with a gap in their membership can't see what was said while
        they were out, so the marker must not be parked against one of those
        messages — that would hand them an unread count for a thread that then
        shows them nothing.
        """
        group = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, created_by=self.bea
        )
        t0 = timezone.now() - timedelta(hours=3)
        t1 = timezone.now() - timedelta(hours=2)
        p_bea = Participant.objects.create(
            conversation=group, user=self.bea, status="active"
        )
        ParticipantInterval.objects.create(participant=p_bea, started_at=t0)
        p_ada = Participant.objects.create(
            conversation=group, user=self.ada, status="active"
        )
        # Ada was in, then out, and is not back yet — so the newest message in
        # the thread is one she was never shown.
        ParticipantInterval.objects.create(
            participant=p_ada, started_at=t0, ended_at=t1
        )
        seen = Message.objects.create(
            conversation=group, sender=self.bea, text="while she was here"
        )
        Message.objects.filter(pk=seen.pk).update(
            created_at=t0 + timedelta(minutes=1)
        )
        seen.refresh_from_db()
        in_gap = Message.objects.create(
            conversation=group, sender=self.bea, text="while she was out"
        )
        Message.objects.filter(pk=in_gap.pk).update(
            created_at=t1 + timedelta(minutes=1)
        )

        resp = self.client.delete(f"/api/conversations/{group.id}/read/")
        self.assertEqual(resp.status_code, 200)
        marker = ConversationRead.objects.get(
            conversation=group, user=self.ada
        ).last_read_at
        self.assertLess(marker, seen.created_at)
        self.assertEqual(resp.data["unread_count"], 1)

    def test_marking_unread_retracts_the_read_receipt(self):
        """🔒 The tick and the badge are the same marker, on purpose.

        Moving it back flips the sender's ✓✓ to ✓ on the message you just
        un-read. That's the intended reading rather than a side effect: a second
        never-decreasing column would let the badge and the tick disagree about
        whether you read something, and on a privacy-first app the direction to
        err is fewer claims about what someone has read.
        """
        sent = Message.objects.create(
            conversation=self.convo, sender=self.bea, text="are you free?"
        )
        self.client.post(self.url)

        def bea_sees_ada_read():
            self.client.force_authenticate(self.bea)
            rows = self.client.get(f"/api/conversations/{self.convo.id}/").data[
                "participants"
            ]
            ada_row = [r for r in rows if r["id"] == self.ada.id][0]
            self.client.force_authenticate(self.ada)
            # ``attach_read_receipts`` puts the raw datetime on the row, so this
            # is still a datetime here — it only becomes a string at render.
            read_at = ada_row["last_read_at"]
            return read_at is not None and read_at >= sent.created_at

        self.assertTrue(bea_sees_ada_read())

        self.client.delete(self.url)

        self.assertFalse(bea_sees_ada_read())

    def test_a_non_member_gets_404(self):
        outsider = make_user("unread-outsider@example.com")
        self.client.force_authenticate(outsider)
        self.assertEqual(self.client.delete(self.url).status_code, 404)


@override_settings(
    EXPO_ACCESS_TOKEN="",
    EXPO_PUSH_RETENTION_DAYS=14,
    # Pinned rather than inherited (#355). Both are operator-tunable via the
    # environment — 0 is the legitimate way to switch the hold off — so tests
    # that read them from the ambient settings would go red for anyone with
    # either exported, and would silently stop testing anything if a default
    # were retuned. The offsets below are chosen against *these* numbers.
    PUSH_MESSAGE_GRACE_SECONDS=6,
    PUSH_ACTIVE_THREAD_SECONDS=60,
    # Off for the class, turned on per-test by the cooldown cases (#354). Every
    # test here builds its conversations from scratch and drains once, so at the
    # real 60s default any case that put two message pushes through one thread
    # would silently be testing the cooldown instead of the thing it names.
    PUSH_MESSAGE_COOLDOWN_SECONDS=0,
)
class SendPushesCommandTests(APITestCase):
    """Draining the outbox (Phase 9, Milestone D).

    Expo is mocked at ``urlopen`` — these assert the request we build and how we
    react to each ticket status, not Expo itself.
    """

    def setUp(self):
        self.me = make_user("drain-recipient@example.com")
        self.actor = make_user("drain-actor@example.com", first_name="Ada")
        make_connection(self.me, self.actor)
        self.post = Post.objects.create(author=self.me, text="hello")
        self.device = DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[aaa]", platform="ios"
        )

    def _queue(self, kind=None, **target):
        return notifications.create_notification(
            self.me,
            self.actor,
            kind or Notification.Kind.POST_REPLY,
            **(target or {"post": self.post}),
        )

    def _run(self, payload=None, payloads=None, **kwargs):
        """Run the command with urlopen mocked; returns the mock.

        ``payloads`` gives a different reply per batch, for the chunking cases.
        """
        from django.core.management import call_command

        with mock.patch(
            "api.management.commands.send_pushes.urllib.request.urlopen"
        ) as urlopen:
            if payloads is not None:
                urlopen.side_effect = [_FakeExpoResponse(p) for p in payloads]
            else:
                urlopen.return_value = _FakeExpoResponse(
                    payload if payload is not None else _ok_tickets(1)
                )
            # Quiet by default so a 68-case run isn't a wall of send lines —
            # and it is a real setting now, not decoration: the command used to
            # accept `--verbosity` and ignore it. `setdefault` rather than a
            # fixed kwarg so the cases that assert on output can ask for 1
            # without colliding with it.
            kwargs.setdefault("verbosity", 0)
            call_command("send_pushes", **kwargs)
        return urlopen

    def _sent_body(self, urlopen):
        request = urlopen.call_args[0][0]
        return json.loads(request.data.decode())

    def test_a_queued_push_is_sent_and_marked(self):
        self._queue()

        urlopen = self._run()

        body = self._sent_body(urlopen)
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["to"], "ExponentPushToken[aaa]")
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_the_payload_reuses_the_serializer_text_and_url(self):
        # The push wording and deep-link must be the same ones the web activity
        # centre renders, so the two can never drift.
        n = self._queue()
        expected = NotificationSerializer(n).data

        urlopen = self._run()

        message = self._sent_body(urlopen)[0]
        self.assertEqual(message["body"], expected["text"])
        self.assertEqual(message["data"]["url"], expected["url"])
        self.assertEqual(message["data"]["notificationId"], n.id)
        self.assertEqual(message["data"]["kind"], n.kind)

    def _queue_message(self, kind="direct", title="", text="secret plans"):
        """Queue a *message* push to self.me, the way the send path sees one."""
        if kind == "direct":
            convo = Conversation.objects.create(
                kind="direct", user_a=self.me, user_b=self.actor
            )
        else:
            convo = Conversation.objects.create(
                kind="group", title=title, created_by=self.actor
            )
        for user in (self.me, self.actor):
            p = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=p, started_at=convo.created_at
            )
        message = Message.objects.create(
            conversation=convo, sender=self.actor, text=text
        )
        notifications.enqueue_message_pushes(message)
        return convo, message

    def test_a_message_push_names_the_sender_and_deep_links_to_the_thread(self):
        convo, _message = self._queue_message()

        urlopen = self._run()

        message = self._sent_body(urlopen)[0]
        self.assertEqual(message["body"], "New message from Ada")
        self.assertEqual(message["data"]["url"], f"/messages/{convo.id}")
        self.assertEqual(message["data"]["kind"], "message")
        # No activity-centre row exists, so there's no id for the app to mark
        # read — it keys off `kind` instead.
        self.assertIsNone(message["data"]["notificationId"])

    def test_a_message_push_carries_the_reply_category(self):
        # What puts a Reply field on a pulled-down push (Phase 9b M8). The name
        # must match the app's `MESSAGE_CATEGORY`: iOS silently ignores a
        # category it doesn't know, which looks exactly like the feature not
        # existing — so this pins the string on the wire.
        self._queue_message()

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["categoryId"], "message")

    def test_a_notification_push_carries_no_category(self):
        # Replying to "Ada replied to your post" would mean posting a comment
        # from the lock screen — a different feature and a different endpoint.
        self._queue()

        urlopen = self._run()

        self.assertNotIn("categoryId", self._sent_body(urlopen)[0])

    # --- Preview previews (Phase 10b) -----------------------------------------

    def test_the_wire_body_never_carries_the_message_text(self):
        # The rule the whole push design rests on, pinned on the wire rather
        # than in a helper: the body transits Expo and Apple/Google, so it names
        # the sender and never quotes them. Phase 10b adds previews *without*
        # touching this — the text reaches the phone over TLS afterwards.
        self._queue_message(text="the secret is under the mat")
        self.device.show_previews = True
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        wire = json.dumps(self._sent_body(urlopen))
        self.assertNotIn("secret", wire)
        self.assertNotIn("under the mat", wire)

    def test_an_opted_in_device_gets_mutable_content_on_a_message_push(self):
        # What wakes the notification service extension. Without it the
        # extension is never run and previews silently do nothing.
        self._queue_message()
        self.device.show_previews = True
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        self.assertTrue(self._sent_body(urlopen)[0]["mutableContent"])

    def test_a_device_with_previews_off_gets_no_mutable_content(self):
        # Nothing to wake, because there is nothing for the extension to fetch.
        self._queue_message()
        self.device.show_previews = False
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        self.assertNotIn("mutableContent", self._sent_body(urlopen)[0])

    def test_a_device_with_previews_off_is_told_nothing_but_that_it_happened(self):
        # The setting governs *both* halves of what a notification discloses:
        # who it is from as well as what they said. Naming the sender while
        # withholding the text would be a strange half-privacy — it is the
        # correspondent, more than the words, that a glance at a lock screen
        # gives away. This is also the one body in the app that Expo and
        # Apple/Google can read no name out of.
        self._queue_message()
        self.device.show_previews = False
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        message = self._sent_body(urlopen)[0]
        self.assertEqual(message["body"], "New message")
        self.assertNotIn("Ada", json.dumps(message))

    def test_a_device_with_previews_off_is_offered_no_reply(self):
        # Reversing the rule this phase started with ("previews off gets exactly
        # today's behaviour, Reply included"), which held only while off still
        # named the sender. Once it doesn't, a reply field answers an unknown
        # message from an unknown person — the trap this phase exists to fix, in
        # a worse form than the one it started with.
        self._queue_message()
        self.device.show_previews = False
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        self.assertNotIn("categoryId", self._sent_body(urlopen)[0])

    def test_previews_being_off_anonymises_nothing_but_messages(self):
        # A reaction push names a person and is not a message preview. The
        # phase's non-goals say so, and the gate is `previewable` for exactly
        # this reason — anonymising the activity centre is a different setting
        # nobody has asked for.
        self._queue()
        self.device.show_previews = False
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        self.assertNotEqual(self._sent_body(urlopen)[0]["body"], "New message")

    def test_a_notification_push_never_gets_mutable_content(self):
        # Gated on the *payload* being a message, not on the device's flag
        # alone. Two failures this pins: waking the extension for "Ada reacted
        # to your post", which has no preview to fetch; and — if the gate read a
        # key the notification branch doesn't set — a KeyError inside the
        # drain's transaction, which would stop all push delivery every tick.
        self._queue()
        self.device.show_previews = True
        self.device.save(update_fields=["show_previews"])

        urlopen = self._run()

        self.assertNotIn("mutableContent", self._sent_body(urlopen)[0])

    def test_an_android_device_gets_no_mutable_content(self):
        # `mutable-content` is an APNs field; FCM has no equivalent, so on
        # Android it wakes nothing and fetches nothing. Setting it anyway would
        # disclose the user's privacy setting to Expo and Google for no benefit
        # at all. Android's rewrite path is M4.
        android = DevicePushToken.objects.create(
            user=self.me,
            expo_token="ExponentPushToken[droid]",
            platform="android",
            show_previews=True,
        )
        self.device.delete()
        self._queue_message()

        urlopen = self._run()

        message = self._sent_body(urlopen)[0]
        self.assertEqual(message["to"], android.expo_token)
        self.assertNotIn("mutableContent", message)

    def test_one_opted_in_device_does_not_opt_in_the_others(self):
        # Per device, because what leaks is a lock screen and a lock screen
        # belongs to a phone: previews on the phone, off on the kitchen tablet.
        tablet = DevicePushToken.objects.create(
            user=self.me,
            expo_token="ExponentPushToken[tablet]",
            platform="ios",
            show_previews=False,
        )
        self.device.show_previews = True
        self.device.save(update_fields=["show_previews"])
        self._queue_message()

        urlopen = self._run(payload=_ok_tickets(2))

        by_token = {m["to"]: m for m in self._sent_body(urlopen)}
        self.assertTrue(by_token[self.device.expo_token]["mutableContent"])
        self.assertNotIn("mutableContent", by_token[tablet.expo_token])

    def test_every_push_carries_the_recipients_icon_badge(self):
        # Issue #179. Unlike `categoryId`/`channelId`, which a kind opts into,
        # the badge is on *every* push: it's the only lever that can put a
        # number on the icon of a phone that isn't running the app, so a kind
        # that skipped it would leave the last number sitting there.
        self._queue()

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["badge"], 1)

    def test_the_icon_badge_sums_unread_messages_and_unread_activity(self):
        # One icon badge is one number and there are deliberately two counts.
        # They can't double-count — messaging sits outside the activity centre —
        # which is what makes the sum honest rather than merely convenient.
        # This also pins that a burst *agrees*: two pushes drained together must
        # not disagree about what's waiting.
        self._queue()  # one unread notification
        self._queue_message()  # one unread message

        urlopen = self._run(payload=_ok_tickets(2))

        badges = [message["badge"] for message in self._sent_body(urlopen)]
        self.assertEqual(badges, [2, 2])

    def test_the_icon_badge_is_zero_once_everything_is_dealt_with(self):
        # Seen on the web between enqueue and drain. The push still goes —
        # there's no recalling one — and what it must carry is what's actually
        # waiting, which is nothing. Omitting the field on this path would leave
        # a stale number on the icon precisely when it's most obviously wrong.
        notification = self._queue()
        Notification.objects.filter(pk=notification.pk).update(
            seen_at=timezone.now()
        )

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["badge"], 0)

    def test_the_icon_badge_is_counted_per_recipient(self):
        # A group message queues one row per member. Each phone gets *that
        # person's* number: the recipient with an extra unread notification sees
        # a higher count than the one without.
        other = make_user("drain-third@example.com")
        DevicePushToken.objects.create(
            user=other, expo_token="ExponentPushToken[bbb]", platform="android"
        )
        convo = Conversation.objects.create(
            kind="group", title="Trip", created_by=self.actor
        )
        for user in (self.me, self.actor, other):
            participant = Participant.objects.create(
                conversation=convo, user=user, status="active"
            )
            ParticipantInterval.objects.create(
                participant=participant, started_at=convo.created_at
            )
        message = Message.objects.create(
            conversation=convo, sender=self.actor, text="who's driving"
        )
        notifications.enqueue_message_pushes(message)
        # …and one extra thing waiting for me alone.
        self._queue()

        urlopen = self._run(payload=_ok_tickets(3))

        badges = {
            message["to"]: message["badge"]
            for message in self._sent_body(urlopen)
        }
        self.assertEqual(badges["ExponentPushToken[aaa]"], 2)
        self.assertEqual(badges["ExponentPushToken[bbb]"], 1)

    def test_the_icon_badge_is_counted_once_per_recipient_in_a_batch(self):
        # The count runs a query per conversation (the same family-scale
        # trade-off the nav badge makes), so a drain that recomputed it per row
        # would multiply that by the batch. Two rows, one recipient, one count.
        self._queue()
        self._queue_message()

        with mock.patch(
            "api.management.commands.send_pushes.badge_count_for",
            side_effect=badge_count_for,
        ) as counted:
            self._run(payload=_ok_tickets(2))

        self.assertEqual(counted.call_count, 1)

    def test_every_notification_kind_maps_to_a_known_android_channel(self):
        """No kind may fall through to the default without someone noticing.

        Android drops a push naming a channel the device doesn't have — silently,
        with nothing in any log. So the failure mode of forgetting to map a new
        kind is "push quietly stops working for it", which is exactly the kind of
        bug that survives to production. Enumerating the enum here means adding a
        kind without a channel fails the suite instead.
        """
        for kind in Notification.Kind.values:
            with self.subTest(kind=kind):
                # Against ``_KIND_CHANNELS``, **not** ``channel_for_kind``.
                # Asserting the latter lands in ``ANDROID_CHANNELS`` is
                # tautological: an unmapped kind falls back to DEFAULT_CHANNEL,
                # which is itself a member — so the test passed for every
                # conceivable input and protected nothing.
                self.assertIn(
                    kind,
                    notifications._KIND_CHANNELS,
                    f"{kind} has no Android notification channel",
                )

    def test_the_channel_ids_match_the_app(self):
        # The other copy lives in mobile/src/push.ts (`CHANNELS`), with the
        # mirror-image test. Hard-coded on both sides on purpose: a test that
        # derived them from the code it checks would agree with itself while the
        # two processes drifted apart.
        self.assertEqual(
            sorted(notifications.ANDROID_CHANNELS),
            ["events", "mentions", "messages", "reactions", "replies", "social"],
        )

    def test_a_notification_push_carries_its_channel(self):
        # A reply belongs in the "replies" channel, so someone who has turned
        # replies down in Android settings gets what they asked for.
        self._queue(kind=Notification.Kind.POST_REPLY, post=self.post)

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["channelId"], "replies")

    def test_a_message_push_carries_the_messages_channel(self):
        # Messages get their own high-importance channel — the one thing people
        # generally do want interrupting them.
        self._queue_message()

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["channelId"], "messages")

    def test_a_mention_push_uses_the_mentions_channel(self):
        """The channel that exists so a mention still reaches you in a muted chat.

        A mention has no ``Notification`` row — ``Kind.MENTION`` only gives the
        *preference* a home — so it rides the message branch. Take the channel
        from ``kind`` alone and every mention files under **messages**, which
        means turning Messages down to quieten a busy group chat silences your
        @mentions with it: exactly what the separate channel is for.
        """
        convo, message = self._queue_message(text="@Me look at this")
        MessageMention.objects.create(message=message, user=self.me)

        urlopen = self._run()

        sent = self._sent_body(urlopen)[0]
        self.assertEqual(sent["channelId"], "mentions")
        # Still a message push in every other respect.
        self.assertEqual(sent["data"]["kind"], "message")

    def test_a_plain_message_push_stays_on_the_messages_channel(self):
        self._queue_message()

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["channelId"], "messages")

    def test_a_message_push_never_carries_the_message_text(self):
        # The body crosses Expo's servers and Apple's. Naming the sender is the
        # most we ever say; quoting a private message would be a real leak.
        self._queue_message(text="meet me at the usual place at nine")

        urlopen = self._run()

        body = json.dumps(self._sent_body(urlopen))
        self.assertNotIn("usual place", body)

    def test_a_group_message_push_names_the_group(self):
        # "New message from Ada" is ambiguous when Ada is in four of your chats.
        self._queue_message(kind="group", title="Book Club")

        urlopen = self._run()

        self.assertEqual(self._sent_body(urlopen)[0]["body"], "Ada in Book Club")

    def test_an_untitled_group_message_falls_back_to_the_plain_wording(self):
        self._queue_message(kind="group", title="")

        urlopen = self._run()

        self.assertEqual(
            self._sent_body(urlopen)[0]["body"], "New message from Ada"
        )

    def test_a_message_already_read_is_dropped_rather_than_sent(self):
        # Someone with the thread open has polled and moved their read marker
        # past this message before the timer fired. Buzzing them for something
        # they're looking at is the fastest way to make push feel broken.
        convo, message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo, user=self.me, last_read_at=timezone.now()
        )

        urlopen = self._run()

        urlopen.assert_not_called()
        # Settled, not retried: it can never become unread again.
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_a_message_deleted_before_the_drain_is_not_sent(self):
        # Message deletion is *soft* (a tombstone, so the thread doesn't
        # reshuffle), so unlike the notification path there's no cascade to take
        # the queued push with it. Without an explicit check, deleting a message
        # you regret still buzzes everyone up to a timer tick later, and the tap
        # lands on "message deleted".
        _convo, message = self._queue_message()
        message.text = ""
        message.deleted_at = timezone.now()
        message.save(update_fields=["text", "deleted_at"])

        urlopen = self._run()

        urlopen.assert_not_called()
        # Settled, not retried — a soft delete is never undone.
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_a_message_read_before_it_arrived_still_sends(self):
        # The guard must compare against *this* message, not merely "has a read
        # marker" — an old marker means the thread was read at some point, which
        # says nothing about the new message.
        convo, message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=message.created_at - timedelta(minutes=5),
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def _backdate(self, message, seconds):
        """Move a message's ``created_at`` into the past.

        ``update`` rather than ``save`` because ``created_at`` is
        ``auto_now_add`` — written on INSERT and never rewritten — and because
        the drain re-reads the row from the database anyway.
        """
        when = timezone.now() - timedelta(seconds=seconds)
        Message.objects.filter(pk=message.pk).update(created_at=when)
        message.created_at = when
        return message

    def test_a_burst_is_not_binned_because_its_first_message_was_read(self):
        # The hole the cooldown widened (issue #354). A queued row keeps
        # pointing at the message it was created for while every later message
        # coalesces onto it — so comparing the read marker against *that*
        # message means glancing at the thread bins the whole rest of the burst,
        # silently, with nothing anywhere recording that it happened. The
        # cooldown holds the row for a minute, which is a minute of exposure
        # every time rather than the old timer's random slice of one.
        convo, first = self._queue_message()
        self._backdate(first, 30)
        later = Message.objects.create(
            conversation=convo, sender=self.actor, text="and another"
        )
        self._backdate(later, 10)
        # No second row: the enqueue coalesces onto the unsent one.
        notifications.enqueue_message_pushes(later)
        self.assertEqual(
            PushOutbox.objects.filter(sent_at__isnull=True).count(), 1
        )
        # Read up to the first message and no further.
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=20),
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def test_reading_the_whole_thread_still_drops_the_push(self):
        # The other side of the same test: the drop is not weakened into "send
        # whenever anything newer exists". Someone genuinely caught up is still
        # not buzzed, which is what "don't buzz me for a thread I'm looking at"
        # costs us — almost nothing.
        convo, first = self._queue_message()
        self._backdate(first, 30)
        later = Message.objects.create(
            conversation=convo, sender=self.actor, text="and another"
        )
        self._backdate(later, 20)
        notifications.enqueue_message_pushes(later)
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=10),
        )

        urlopen = self._run()

        urlopen.assert_not_called()
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_your_own_reply_does_not_resurrect_a_push_you_have_read(self):
        # Sending stamps the read marker ("sending implies you've read
        # everything up to now"), but the marker and the message are two writes,
        # not one instant. Counting your own message as unread mail would buzz
        # you about something you just typed.
        convo, first = self._queue_message()
        self._backdate(first, 30)
        mine = Message.objects.create(
            conversation=convo, sender=self.me, text="on it"
        )
        self._backdate(mine, 10)
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=11),
        )

        urlopen = self._run()

        urlopen.assert_not_called()

    def test_chatter_in_a_muted_thread_does_not_revive_a_read_mention(self):
        # A muted thread only ever queues (or coalesces) a push for someone when
        # they are *named*, so ordinary chatter arriving afterwards is not mail
        # they are waiting for — and treating it as such would buzz them through
        # a quiet they explicitly asked for, which is the one thing mute has to
        # be able to promise.
        convo, first = self._queue_message()
        MessageMention.objects.create(message=first, user=self.me)
        self._backdate(first, 30)
        Participant.objects.filter(conversation=convo, user=self.me).update(
            muted_at=timezone.now()
        )
        chatter = Message.objects.create(
            conversation=convo, sender=self.actor, text="unrelated"
        )
        self._backdate(chatter, 10)
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=20),
        )

        urlopen = self._run()

        urlopen.assert_not_called()

    def test_a_fresh_message_is_held_back_from_someone_still_in_the_thread(self):
        # Issue #355. `_should_drop` above can only see a read marker the
        # recipient's client has already sent, and that client cannot send one
        # until its own 4s poll has told it the message exists. So for the first
        # few seconds "have they read it?" answers *no* even for someone staring
        # straight at the thread — and sending buzzes a phone for a message on
        # its own screen. Marker just *before* the message: they were reading a
        # moment ago, and haven't been told about this one yet.
        convo, _message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=2),
        )

        urlopen = self._run()

        urlopen.assert_not_called()
        row = PushOutbox.objects.get()
        # Held, *not* settled and not failed — it still goes out on a later run
        # if they turn out not to have been reading after all. Spending an
        # attempt here would let a busy thread burn through MAX_ATTEMPTS without
        # Expo ever having been called.
        self.assertIsNone(row.sent_at)
        self.assertEqual(row.attempts, 0)

    def test_a_held_back_message_goes_out_once_the_grace_has_passed(self):
        # The hold is a short wait, not a veto: someone who was reading a minute
        # ago but has since put the phone down still gets their push.
        convo, message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=40),
        )
        # Older than PUSH_MESSAGE_GRACE_SECONDS. `update` rather than `save`
        # only to skip the model's other save-time work — `created_at` is
        # `auto_now_add`, so it is written on INSERT and never rewritten, which
        # is exactly what `_should_defer`'s "cannot strand a row" rests on.
        Message.objects.filter(pk=message.pk).update(
            created_at=timezone.now() - timedelta(seconds=30)
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def test_an_idle_recipient_is_never_held_back(self):
        # The case push exists for: the thread was read hours ago and the phone
        # is in a pocket. Nobody is about to mark anything read, so waiting would
        # be pure delay — this is what keeps the grace off the common path.
        convo, _message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(hours=3),
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def test_never_having_opened_the_thread_is_not_being_active_in_it(self):
        # No marker at all means they have never opened this conversation, which
        # is the *opposite* of reading it right now. A missing row must not be
        # mistaken for a recent one.
        self._queue_message()

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def test_a_marker_just_outside_the_active_window_is_not_held_back(self):
        # Pins the *value* of PUSH_ACTIVE_THREAD_SECONDS, not merely its sign.
        # Without a case either side of the boundary the window could be retuned
        # to almost anything — or its units confused — with nothing going red.
        convo, _message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=61),
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    def test_a_recipient_with_no_devices_is_settled_rather_than_held(self):
        # The hold exists to stop a *phone* buzzing for a message on its screen.
        # Someone with no registered device has no phone to protect, so holding
        # their row would leave it queued for a drain that can never send it —
        # and `enqueue_message_pushes` coalesces onto any unsent row, so the
        # next message would get no row of its own either.
        convo, _message = self._queue_message()
        DevicePushToken.objects.all().delete()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=2),
        )

        urlopen = self._run()

        urlopen.assert_not_called()
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_a_held_row_does_not_hold_up_the_rest_of_the_batch(self):
        # The mixed batch is the usual case in production, and the only one
        # where the `continue` placement and the shared clock matter. A held row
        # must not settle, swallow or delay its neighbours.
        held_convo, _held_message = self._queue_message()
        ConversationRead.objects.create(
            conversation=held_convo,
            user=self.me,
            last_read_at=timezone.now() - timedelta(seconds=2),
        )
        # A second thread with no marker at all — nothing to wait for. A group,
        # because a second *direct* thread between the same pair is barred by
        # `unique_conversation_pair`.
        other_convo, _other_message = self._queue_message(
            kind="group", title="Book Club"
        )

        urlopen = self._run()

        sent = self._sent_body(urlopen)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["data"]["url"], f"/messages/{other_convo.id}")
        # The held row is still queued, unspent; its neighbour is settled.
        held_row = PushOutbox.objects.get(message__conversation=held_convo)
        self.assertIsNone(held_row.sent_at)
        self.assertEqual(held_row.attempts, 0)

    def test_the_send_line_reports_how_long_the_row_waited(self):
        # Our half of push latency, and the only half anyone here can act on:
        # Expo → APNs/FCM → device adds 1-5s that is neither visible nor
        # controllable from the box. Without this number "is the delay ours?" is
        # unanswerable, which is the question issue #354 was opened to settle.
        self._queue()
        PushOutbox.objects.update(
            created_at=timezone.now() - timedelta(seconds=9)
        )

        # verbosity=1 explicitly: `_run` passes 0, which the command now
        # actually honours, and this case is about what it prints.
        out = StringIO()
        self._run(stdout=out, verbosity=1)

        self.assertIn("queued up to 9.", out.getvalue())

    def test_minus_v0_really_is_quiet(self):
        # `--verbosity` used to be accepted and ignored, so the suite passed
        # `verbosity=0` and got a send line per case anyway.
        self._queue()

        out = StringIO()
        self._run(stdout=out, verbosity=0)

        self.assertEqual(out.getvalue(), "")
        # Still did the work, though — quiet is not dry-run.
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_a_drain_that_only_settles_rows_still_says_so(self):
        # Settling writes `sent_at`, so it is work, not idleness — and in
        # `--loop` the "nothing outstanding" line is swallowed as idle. Without
        # this line a drain that binned every queued push would look exactly
        # like an empty queue, which is the one symptom a `_should_drop` bug
        # would produce.
        convo, message = self._queue_message()
        ConversationRead.objects.create(
            conversation=convo,
            user=self.me,
            last_read_at=message.created_at + timedelta(seconds=1),
        )

        out = StringIO()
        urlopen = self._run(stdout=out, verbosity=1)

        urlopen.assert_not_called()
        self.assertIn("Settled 1 row(s) without sending", out.getvalue())

    # --- the cooldown between two buzzes about one thread (issue #354) --------
    #
    # Until the drain became resident, "at most one message buzz per person per
    # thread per minute" was a property of the *timer*, not of any code: the
    # enqueue coalesced onto a row that then sat unsent for up to a minute.
    # Sweeping every two seconds removes the sitting-still without touching the
    # enqueue, so the guarantee has to be asserted somewhere it can't evaporate
    # again the next time an interval is tuned.

    def _already_buzzed(self, convo, when=None):
        """A message push we really sent about ``convo``, ``when`` ago.

        ``delivered_tokens`` is the part that matters: `_last_pushes` reads it
        rather than `sent_at` precisely so that rows settled *without* calling
        Expo don't start a cooldown.
        """
        earlier = Message.objects.create(
            conversation=convo, sender=self.actor, text="earlier"
        )
        return PushOutbox.objects.create(
            message=earlier,
            recipient=self.me,
            sent_at=when or timezone.now(),
            delivered_tokens=[self.device.expo_token],
        )

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_second_message_does_not_buzz_again_straight_away(self):
        convo, _message = self._queue_message()
        self._already_buzzed(convo)

        urlopen = self._run()

        urlopen.assert_not_called()
        # Held exactly like the read-grace holds: no `sent_at`, no `attempts`.
        # Dropping it instead would mean a thread nobody reads goes quiet after
        # one push, which is not what the old timer did.
        row = PushOutbox.objects.get(sent_at__isnull=True)
        self.assertEqual(row.attempts, 0)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_the_held_message_goes_out_once_the_cooldown_expires(self):
        convo, _message = self._queue_message()
        self._already_buzzed(convo, when=timezone.now() - timedelta(seconds=61))

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_push_settled_without_buzzing_starts_no_cooldown(self):
        # The trap `_last_pushes` exists to avoid. `sent_at` is stamped on rows
        # the drain settles without calling Expo at all — including one dropped
        # because the recipient had already read the thread. Counting those as a
        # buzz would silence the *next* message for a minute, and would do it
        # most often to people in a live conversation, who are exactly the ones
        # a fast drain is for.
        convo, _message = self._queue_message()
        silent = self._already_buzzed(convo)
        silent.delivered_tokens = []
        silent.save(update_fields=["delivered_tokens"])

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_mention_is_not_held_by_the_cooldown(self):
        # Being named is how you get someone's attention, and a busy thread is
        # both what puts you in cooldown and where a minute's silence is most
        # obviously wrong. Same carve-out mute gets, for the same reason.
        convo, message = self._queue_message()
        MessageMention.objects.create(message=message, user=self.me)
        self._already_buzzed(convo)

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_mention_that_coalesced_onto_a_queued_row_is_still_exempt(self):
        # The hole the first version of the exemption had. A queued row keeps
        # pointing at the message it was created for while later messages
        # coalesce onto it, so asking `is_mentioned(row.message, …)` answers
        # about the *first* message of a burst. A mention arriving mid-burst
        # creates no row of its own — and a busy thread is the only place a row
        # is reliably already queued, so it is exactly the case the exemption
        # exists for.
        convo, first = self._queue_message()
        self._already_buzzed(convo)
        later = Message.objects.create(
            conversation=convo, sender=self.actor, text="@me look at this"
        )
        MessageMention.objects.create(message=later, user=self.me)
        # No second row: the enqueue coalesces onto the unsent one.
        notifications.enqueue_message_pushes(later)
        self.assertEqual(PushOutbox.objects.filter(sent_at__isnull=True).count(), 1)
        self.assertEqual(
            PushOutbox.objects.get(sent_at__isnull=True).message_id, first.id
        )

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_mention_on_a_deleted_message_does_not_punch_through(self):
        # A mention taken back shouldn't go on beating the cooldown for ever.
        convo, _first = self._queue_message()
        self._already_buzzed(convo)
        later = Message.objects.create(
            conversation=convo,
            sender=self.actor,
            text="@me oops",
            deleted_at=timezone.now(),
        )
        MessageMention.objects.create(message=later, user=self.me)

        urlopen = self._run()

        urlopen.assert_not_called()

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_push_that_only_reaped_a_dead_token_starts_no_cooldown(self):
        # `DeviceNotRegistered` settles a row without any phone having buzzed,
        # so it must not look like a buzz to `_last_pushes`. The moment it fires
        # is a reinstall or a token rotation — precisely when the recipient has
        # a working device again and should hear about the next message.
        convo, _message = self._queue_message()
        self._run(
            payload={
                "data": [
                    {
                        "status": "error",
                        "message": "gone",
                        "details": {"error": "DeviceNotRegistered"},
                    }
                ]
            }
        )
        reaped = PushOutbox.objects.get()
        self.assertIsNotNone(reaped.sent_at)          # settled, not retried
        self.assertEqual(reaped.delivered_tokens, [])  # but nobody was reached

        # They re-register and a new message arrives well inside the cooldown.
        device = DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[new]", platform="ios"
        )
        later = Message.objects.create(
            conversation=convo, sender=self.actor, text="second"
        )
        notifications.enqueue_message_pushes(later)

        urlopen = self._run()

        sent = self._sent_body(urlopen)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["to"], device.expo_token)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_the_cooldown_is_per_thread_not_per_person(self):
        # Otherwise one chatty group would silence every other conversation
        # someone is in — a far worse failure than the buzz storm this prevents.
        self._already_buzzed(
            Conversation.objects.create(
                kind="group", title="Book Club", created_by=self.actor
            )
        )
        convo, _message = self._queue_message()

        urlopen = self._run()

        sent = self._sent_body(urlopen)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["data"]["url"], f"/messages/{convo.id}")

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=0)
    def test_the_cooldown_can_be_switched_off(self):
        # It's operator-tunable, and 0 has to mean off rather than "compare
        # against a zero-length window and hold anyway".
        convo, _message = self._queue_message()
        self._already_buzzed(convo)

        urlopen = self._run()

        self.assertEqual(len(self._sent_body(urlopen)), 1)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_a_held_row_does_not_squat_the_window(self):
        # A held row keeps `sent_at IS NULL` and its original `created_at`, so
        # it stays at the *head* of the selection window — and the cooldown
        # keeps it there for a minute, i.e. across thirty drains. Once enough of
        # them fill a window, every drain would select the same held rows, send
        # nothing, and starve what is queued behind: here a notification row,
        # which is subject to no hold at all and has no reason to wait. The old
        # six-second read-grace could never squat a window for long enough to
        # matter.
        convo, _message = self._queue_message()
        self._already_buzzed(convo)
        n = self._queue()

        # One row per window, so the held message fills the first on its own.
        urlopen = self._run(max_rows=1)

        sent = self._sent_body(urlopen)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["data"]["notificationId"], n.id)
        # And the message row is still queued, unspent — held, not skipped.
        held = PushOutbox.objects.get(
            message__conversation=convo, sent_at__isnull=True
        )
        self.assertIsNone(held.sent_at)
        self.assertEqual(held.attempts, 0)

    @override_settings(PUSH_MESSAGE_COOLDOWN_SECONDS=60)
    def test_running_out_of_windows_is_said_out_loud(self):
        # The looking-again is bounded, because a drain has to stay a
        # predictable amount of work. What it must not be is silent: rows queued
        # behind held ones and a drain that found nothing to do produce exactly
        # the same output otherwise, and "nobody's phone buzzes" is the symptom
        # of both.
        for title in ("Book Club", "Five-a-side", "Cottage"):
            convo, _message = self._queue_message(kind="group", title=title)
            self._already_buzzed(convo)

        out = StringIO()
        self._run(max_rows=1, stdout=out, verbosity=1)

        self.assertIn("Stopped after", out.getvalue())

    def test_a_comment_notification_deep_links_to_its_parent_post(self):
        # The route needs the *post* id, but the notification carries a comment
        # FK — the serializer resolves it, so the app needs no extra round-trip.
        comment = Comment.objects.create(
            post=self.post, author=self.me, text="mine"
        )
        self._queue(Notification.Kind.COMMENT_REPLY, comment=comment)

        urlopen = self._run()

        url = self._sent_body(urlopen)[0]["data"]["url"]
        self.assertEqual(url, f"/p/{self.post.id}?comment={comment.id}")

    def test_every_device_of_a_recipient_gets_the_push(self):
        DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[bbb]", platform="ios"
        )
        self._queue()

        urlopen = self._run(payload=_ok_tickets(2))

        recipients = {m["to"] for m in self._sent_body(urlopen)}
        self.assertEqual(
            recipients, {"ExponentPushToken[aaa]", "ExponentPushToken[bbb]"}
        )

    def test_a_recipient_with_no_device_is_marked_sent_without_calling_expo(self):
        # A web-only user must not leave a row retrying on every timer tick.
        self.device.delete()
        self._queue()

        urlopen = self._run()

        urlopen.assert_not_called()
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_device_not_registered_deletes_the_token(self):
        # Expo's only signal that a token is permanently dead (app uninstalled).
        self._queue()

        self._run(
            payload={
                "data": [
                    {
                        "status": "error",
                        "message": "not registered",
                        "details": {"error": "DeviceNotRegistered"},
                    }
                ]
            }
        )

        self.assertEqual(DevicePushToken.objects.count(), 0)
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_other_errors_count_an_attempt_and_stay_queued(self):
        self._queue()

        self._run(
            payload={
                "data": [
                    {
                        "status": "error",
                        "message": "MessageRateExceeded",
                        "details": {"error": "MessageRateExceeded"},
                    }
                ]
            }
        )

        row = PushOutbox.objects.get()
        self.assertIsNone(row.sent_at)
        self.assertEqual(row.attempts, 1)
        self.assertIn("MessageRateExceeded", row.last_error)
        # The device is intact — only DeviceNotRegistered may delete one.
        self.assertEqual(DevicePushToken.objects.count(), 1)

    def test_a_network_failure_leaves_the_row_queued_for_retry(self):
        from django.core.management import call_command

        self._queue()
        with mock.patch(
            "api.management.commands.send_pushes.urllib.request.urlopen",
            side_effect=OSError("connection refused"),
        ):
            call_command("send_pushes", verbosity=0)

        row = PushOutbox.objects.get()
        self.assertIsNone(row.sent_at)
        self.assertEqual(row.attempts, 1)

    def test_a_row_stops_being_retried_once_attempts_are_exhausted(self):
        # Otherwise one poisoned row is re-sent on every tick, forever.
        self._queue()
        PushOutbox.objects.update(attempts=PushOutbox.MAX_ATTEMPTS)

        urlopen = self._run()

        urlopen.assert_not_called()

    def test_a_partial_multi_device_failure_retries_only_the_missed_device(self):
        """The finding this model's `delivered_tokens` exists for.

        One notification, two devices, one transient error. Marking the row
        sent would lose the retry for the failed device forever; leaving it
        queued without recording the success would re-buzz the device that
        already got it. Neither is acceptable, so the row remembers.
        """
        second = DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[bbb]", platform="ios"
        )
        self._queue()

        self._run(
            payload={
                "data": [
                    {"status": "ok", "id": "t1"},
                    {
                        "status": "error",
                        "message": "MessageRateExceeded",
                        "details": {"error": "MessageRateExceeded"},
                    },
                ]
            }
        )

        row = PushOutbox.objects.get()
        # Still queued, because one device is outstanding.
        self.assertIsNone(row.sent_at)
        self.assertEqual(row.attempts, 1)
        # And it remembers which device already has it.
        first_token = self.device.expo_token
        self.assertEqual(row.delivered_tokens, [first_token])

        # The retry targets *only* the device that missed it.
        urlopen = self._run()
        retried = {m["to"] for m in self._sent_body(urlopen)}
        self.assertEqual(retried, {second.expo_token})

        row.refresh_from_db()
        self.assertIsNotNone(row.sent_at)
        self.assertCountEqual(
            row.delivered_tokens, [first_token, second.expo_token]
        )

    def test_devices_are_batched_in_a_deterministic_order(self):
        # The drain matches Expo's reply onto its messages *positionally*, so
        # the order devices come back in decides which one is credited with
        # which ticket. The query carried no `order_by` for a long time, which
        # left that to Postgres's physical heap order — stable enough to look
        # fine, until a table has seen enough inserts and deletes for it not to
        # be. It failed on CI and passed locally on the same commit, which is
        # the mild version; the same non-determinism is what would make "the
        # wrong device got retried" unreproducible in production.
        #
        # The second device's token sorts *before* setUp's "…[aaa]" while its
        # id comes after, so registration order and alphabetical order disagree.
        # Without that the assertion would hold under either and pin nothing.
        newer = DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[000]", platform="ios"
        )
        self._queue()

        urlopen = self._run(payload=_ok_tickets(2))

        sent = [message["to"] for message in self._sent_body(urlopen)]
        # Registration order, not token order and not whatever the heap holds.
        self.assertEqual(sent, [self.device.expo_token, newer.expo_token])

    def test_a_dead_device_settles_rather_than_blocking_the_row(self):
        # DeviceNotRegistered can never succeed on retry, so it must count as
        # settled — otherwise one uninstalled app keeps a row queued until it
        # exhausts its attempts.
        DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[dead]", platform="ios"
        )
        self._queue()

        self._run(
            payload={
                "data": [
                    {"status": "ok", "id": "t1"},
                    {
                        "status": "error",
                        "message": "not registered",
                        "details": {"error": "DeviceNotRegistered"},
                    },
                ]
            }
        )

        row = PushOutbox.objects.get()
        self.assertIsNotNone(row.sent_at)
        self.assertEqual(row.attempts, 0)
        self.assertEqual(DevicePushToken.objects.count(), 1)

    def test_a_row_whose_devices_all_already_received_it_is_settled(self):
        # Belt and braces for the retry path: if nothing is outstanding there
        # is nothing to send, and the row must not sit in the queue forever.
        self._queue()
        PushOutbox.objects.update(delivered_tokens=[self.device.expo_token])

        urlopen = self._run()

        urlopen.assert_not_called()
        self.assertIsNotNone(PushOutbox.objects.get().sent_at)

    def test_rows_are_settled_correctly_when_devices_straddle_a_batch(self):
        # One row's devices can land in different chunks. Settling mid-loop
        # would mark the row sent while its later devices were still unsent.
        with self.settings(EXPO_PUSH_BATCH_SIZE=1):
            DevicePushToken.objects.create(
                user=self.me, expo_token="ExponentPushToken[bbb]", platform="ios"
            )
            self._queue()

            self._run(
                payloads=[
                    _ok_tickets(1),
                    {
                        "data": [
                            {
                                "status": "error",
                                "message": "MessageRateExceeded",
                                "details": {"error": "MessageRateExceeded"},
                            }
                        ]
                    },
                ]
            )

        row = PushOutbox.objects.get()
        self.assertIsNone(row.sent_at)
        self.assertEqual(len(row.delivered_tokens), 1)

    def test_dry_run_sends_nothing_and_writes_no_state(self):
        self._queue()

        urlopen = self._run(**{"dry_run": True})

        urlopen.assert_not_called()
        self.assertIsNone(PushOutbox.objects.get().sent_at)

    @override_settings(EXPO_ACCESS_TOKEN="secret-token")
    def test_an_access_token_is_sent_as_a_bearer_header(self):
        # With a token configured Expo rejects unauthenticated sends, which is
        # what stops a leaked push token being used to push in our name.
        self._queue()

        urlopen = self._run()

        request = urlopen.call_args[0][0]
        self.assertEqual(request.headers["Authorization"], "Bearer secret-token")

    def test_no_authorization_header_when_no_token_is_configured(self):
        self._queue()

        urlopen = self._run()

        request = urlopen.call_args[0][0]
        self.assertNotIn("Authorization", request.headers)

    def test_delivered_rows_are_pruned_once_past_the_retention_window(self):
        n = self._queue()
        row = PushOutbox.objects.get()
        old = timezone.now() - timedelta(days=15)
        PushOutbox.objects.filter(pk=row.pk).update(sent_at=old, created_at=old)

        self._run()

        self.assertEqual(PushOutbox.objects.count(), 0)
        # Pruning the delivery log must not touch the notification itself.
        self.assertTrue(Notification.objects.filter(pk=n.pk).exists())

    def test_the_drain_does_not_issue_more_queries_as_the_queue_grows(self):
        """Pins the N+1 fix without a brittle absolute query count.

        The serializer reads through to the parent post for a comment
        notification, and to the group for an event, so without select_related
        every extra row costs extra queries. Asserting "the count is the same
        for one row as for several" catches a regression without breaking every
        time an unrelated query is added.
        """
        from django.core.management import call_command

        def drain_queries(n):
            PushOutbox.objects.all().delete()
            Notification.objects.all().delete()
            for i in range(n):
                comment = Comment.objects.create(
                    post=self.post, author=self.me, text=f"c{i}"
                )
                notifications.create_notification(
                    self.me,
                    self.actor,
                    Notification.Kind.COMMENT_REPLY,
                    comment=comment,
                )
            with mock.patch(
                "api.management.commands.send_pushes.urllib.request.urlopen"
            ) as urlopen:
                urlopen.return_value = _FakeExpoResponse(_ok_tickets(n))
                with CaptureQueriesContext(connection) as ctx:
                    call_command("send_pushes", verbosity=0)
            return len(ctx)

        one = drain_queries(1)
        several = drain_queries(4)

        # Per-row writes (marking each row sent) are expected to scale; the
        # *reads* must not. Three extra rows may add at most three writes.
        self.assertLessEqual(several, one + 3)

    @override_settings(EXPO_PUSH_URL="file:///etc/passwd")
    def test_a_non_https_push_url_is_refused(self):
        # EXPO_PUSH_URL is env-configurable and urlopen honours file:// and
        # custom schemes, so a typo'd or hostile value could read a local file
        # and feed it to the ticket parser. Fail loudly instead.
        self._queue()

        self._run()

        row = PushOutbox.objects.get()
        self.assertIsNone(row.sent_at)
        self.assertIn("https", row.last_error)

    def test_recently_delivered_rows_are_kept(self):
        self._queue()

        self._run()

        self.assertEqual(PushOutbox.objects.count(), 1)

    def test_an_accepted_ticket_is_recorded_for_a_receipt_check(self):
        # "ok" only means Expo accepted the message. Keep the ticket id so the
        # receipt pass can find out whether a phone actually got it.
        self._queue()

        self._run(payload={"data": [{"status": "ok", "id": "ticket-xyz"}]})

        receipt = PushReceipt.objects.get()
        self.assertEqual(receipt.ticket_id, "ticket-xyz")
        self.assertEqual(receipt.expo_token, self.device.expo_token)

    def test_a_rejected_ticket_records_no_receipt(self):
        # Nothing was accepted, so there is nothing to follow up.
        self._queue()

        self._run(
            payload={"data": [{"status": "error", "message": "boom"}]}
        )

        self.assertEqual(PushReceipt.objects.count(), 0)


class SendPushesLoopTests(APITestCase):
    """The resident drain, ``send_pushes --loop`` (issue #354).

    This replaced a systemd timer that fired a fresh Django process once a
    minute. Everything the timer used to provide is now this loop's
    responsibility, and each of those things is a way for pushes to stop
    silently — the failure mode is "nobody's phone buzzes", which looks exactly
    like nobody having sent anything.

    Stopping is driven by a **real SIGTERM** rather than by reaching into the
    loop's state, because the signal path is the thing production depends on:
    ``docker compose up -d`` sends SIGTERM on every redeploy, and a loop that
    ignored it would be SIGKILLed partway through an Expo call with rows claimed
    and no record of whether they were sent.
    """

    def _run_loop(self, *, drains=1, side_effect=None, **kwargs):
        """Run the loop, stopping it with SIGTERM after ``drains`` passes.

        Returns ``(stdout_text, drain_calls)``. ``side_effect`` is called with
        the (1-based) pass number before the real drain, so a case can make one
        pass fail.
        """
        from django.core.management import call_command

        from api.management.commands.send_pushes import Command as SendPushes

        real_drain = SendPushes._drain
        passes = []

        def counting_drain(command, *args, **inner):
            passes.append(len(passes) + 1)
            if side_effect is not None:
                side_effect(len(passes))
            try:
                return real_drain(command, *args, **inner)
            finally:
                if len(passes) >= drains:
                    # If the handler somehow isn't installed, SIGTERM would kill
                    # the whole test runner. Fail the case instead.
                    if signal.getsignal(signal.SIGTERM) in (
                        signal.SIG_DFL,
                        signal.SIG_IGN,
                    ):
                        raise AssertionError(
                            "the loop did not install a SIGTERM handler"
                        )
                    os.kill(os.getpid(), signal.SIGTERM)

        out = StringIO()
        with mock.patch.object(SendPushes, "_drain", counting_drain):
            call_command("send_pushes", loop=True, stdout=out, **kwargs)
        return out.getvalue(), len(passes)

    def test_it_keeps_draining_until_it_is_told_to_stop(self):
        _out, drains = self._run_loop(drains=3, interval=0.001)

        self.assertEqual(drains, 3)

    def test_sigterm_finishes_the_current_drain_rather_than_aborting_it(self):
        # The signal only sets a flag. A drain torn down mid-Expo-call would
        # leave rows claimed inside a rolled-back transaction with no record of
        # whether Expo took them, which is the one thing the outbox exists to
        # avoid.
        finished = []

        def note(_n):
            finished.append("started")

        out, drains = self._run_loop(
            drains=1, interval=0.001, side_effect=note
        )

        self.assertEqual(drains, 1)
        self.assertEqual(finished, ["started"])
        self.assertIn("Stopped.", out)

    def test_the_signal_handlers_are_put_back_afterwards(self):
        # A management command that permanently replaces the process's SIGINT
        # handler leaves Ctrl-C dead for whatever runs it next — this suite
        # included.
        before = signal.getsignal(signal.SIGINT)

        self._run_loop(drains=1, interval=0.001)

        self.assertIs(signal.getsignal(signal.SIGINT), before)

    def test_receipts_and_pruning_stay_on_the_slow_schedule(self):
        # The reason for two cadences. Receipts aren't even *asked* for until
        # they are 15 minutes old and pruning is daily work, so running either
        # at drain cadence would be pure waste — and the receipts call is an
        # HTTP round-trip to Expo, so it would also be waste that talks to a
        # third party 43,000 times a day.
        from api.management.commands.send_pushes import Command as SendPushes

        with (
            mock.patch.object(SendPushes, "_check_receipts") as receipts,
            mock.patch.object(SendPushes, "_prune") as prune,
        ):
            _out, drains = self._run_loop(
                drains=5, interval=0.001, maintenance_interval=3600
            )

        self.assertEqual(drains, 5)
        # Once, on the first pass: a restart shouldn't leave receipts unchecked
        # for a whole maintenance interval.
        self.assertEqual(receipts.call_count, 1)
        self.assertEqual(prune.call_count, 1)

    def test_a_failing_maintenance_step_stays_on_its_own_schedule(self):
        # Maintenance used to share the drain's try/except, and `next_maintenance`
        # was only advanced *after* it succeeded — so a stuck prune retried on
        # every single pass, firing Expo's getReceipts endpoint at drain cadence
        # (the exact waste the two-cadence split exists to prevent), reported
        # itself as "Drain failed", and backed the drain off to 10s for a fault
        # that had nothing to do with it.
        from api.management.commands.send_pushes import Command as SendPushes

        with (
            mock.patch.object(SendPushes, "_check_receipts") as receipts,
            mock.patch.object(
                SendPushes, "_prune", side_effect=RuntimeError("lock timeout")
            ),
            # Mocked for the same reason as in the failed-drain case below: the
            # real call would shut the connection this test's own transaction is
            # running in and take the rest of the class with it.
            mock.patch(
                "api.management.commands.send_pushes.close_old_connections"
            ),
        ):
            out, drains = self._run_loop(
                drains=5, interval=0.001, maintenance_interval=3600
            )

        self.assertEqual(drains, 5)
        # Once, not once per pass.
        self.assertEqual(receipts.call_count, 1)
        # And the heartbeat — which deploy.md calls the alarm — still prints,
        # which is when you most need it.
        self.assertIn("Alive:", out)

    def test_a_failing_receipt_check_still_leaves_the_prune_to_run(self):
        # They used to share one try. A receipt check that kept raising — its
        # Expo call is guarded internally, but its `delete()` of expired
        # receipts and dead tokens is not — therefore skipped the prune every
        # time, for ever, and the outbox grew without bound while the site
        # looked perfectly healthy. Swallowing the failure (right, for a
        # resident process) is exactly what made that permanent.
        from api.management.commands.send_pushes import Command as SendPushes

        with (
            mock.patch.object(
                SendPushes,
                "_check_receipts",
                side_effect=RuntimeError("lock timeout"),
            ),
            mock.patch.object(SendPushes, "_prune") as prune,
            mock.patch(
                "api.management.commands.send_pushes.close_old_connections"
            ),
        ):
            out, drains = self._run_loop(
                drains=3, interval=0.001, maintenance_interval=3600
            )

        self.assertEqual(drains, 3)
        # The step after the failing one still ran — once, on its own schedule.
        self.assertEqual(prune.call_count, 1)
        self.assertIn("Alive:", out)

    def test_a_log_nobody_is_reading_does_not_kill_the_loop(self):
        # The recovery path is the easiest place to break the loop's promise:
        # writing to a log whose consumer has gone away raises BrokenPipeError,
        # and closing a connection whose socket is already dead re-raises the
        # driver's error — both while *handling* a fault the loop was meant to
        # survive, and both outside any try before this was fixed.
        class _Broken:
            def write(self, *_args, **_kwargs):
                raise BrokenPipeError("log consumer went away")

            def flush(self):
                pass

            def isatty(self):
                return False

        def explode_once(n):
            if n == 1:
                raise RuntimeError("database is starting up")

        with (
            mock.patch(
                "api.management.commands.send_pushes."
                "_LOOP_ERROR_BACKOFF_SECONDS",
                0.001,
            ),
            mock.patch(
                "api.management.commands.send_pushes.close_old_connections",
                side_effect=OSError("socket is already gone"),
            ),
        ):
            _out, drains = self._run_loop(
                drains=3,
                interval=0.001,
                side_effect=explode_once,
                stderr=_Broken(),
            )

        self.assertEqual(drains, 3)

    def test_a_failed_drain_does_not_kill_the_loop(self):
        # The whole point of being resident. A oneshot could exit on a Postgres
        # restart and get a fresh process next minute; this one has to carry on,
        # or a single transient fault silences push until someone notices.
        #
        # `close_old_connections` is mocked rather than allowed to run: it is
        # the right thing in production — the next pass reconnects instead of
        # reusing a socket Postgres has already dropped — but here it would shut
        # the connection this test case's own transaction is running in, taking
        # the rest of the class down with it. Asserting the call is the part
        # that matters anyway.
        def explode_once(n):
            if n == 1:
                raise RuntimeError("database is starting up")

        with (
            mock.patch(
                "api.management.commands.send_pushes."
                "_LOOP_ERROR_BACKOFF_SECONDS",
                0.001,
            ),
            mock.patch(
                "api.management.commands.send_pushes.close_old_connections"
            ) as reconnect,
        ):
            _out, drains = self._run_loop(
                drains=3, interval=0.001, side_effect=explode_once
            )

        self.assertEqual(drains, 3)
        # A stale connection is the likeliest cause of the failure it just
        # swallowed, so carrying on with the same one would fail for ever.
        reconnect.assert_called_once()

    def test_an_idle_loop_reports_a_heartbeat_instead_of_every_pass(self):
        # At two seconds a pass, "Nothing queued." is 43,000 lines a day saying
        # nothing happened — which is how a log stops being read, and this log
        # is the only place a wedged drain shows up.
        out, _drains = self._run_loop(
            drains=4, interval=0.001, maintenance_interval=3600
        )

        self.assertNotIn("Nothing queued.", out)
        self.assertIn("Alive:", out)

    def test_a_oneshot_run_still_says_what_it_found(self):
        # The other half: quietness belongs to the loop, not to the command. A
        # hand-run is a report someone asked for.
        from django.core.management import call_command

        out = StringIO()
        call_command("send_pushes", stdout=out)

        self.assertIn("Nothing queued.", out.getvalue())

    def test_looping_a_dry_run_is_refused(self):
        # A dry run writes no state, so a looping one would print the same rows
        # for ever without ever making progress.
        from django.core.management import call_command
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("send_pushes", loop=True, dry_run=True)

    def test_a_zero_interval_is_refused(self):
        # It would spin the CPU flat out against Postgres rather than doing
        # anything useful faster.
        from django.core.management import call_command
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("send_pushes", loop=True, interval=0)

    def test_a_zero_maintenance_interval_is_refused(self):
        # Fails differently from the above and was unguarded: it doesn't spin
        # the CPU, it makes every pass a maintenance pass — an HTTP round-trip
        # to Expo and a full-table DELETE every two seconds, which is the exact
        # waste the two cadences exist to avoid, from a setting whose symptom
        # points nowhere near it.
        from django.core.management import call_command
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("send_pushes", loop=True, maintenance_interval=0)


@override_settings(EXPO_RECEIPT_CHECK_DELAY_SECONDS=0)
class PushReceiptCheckTests(APITestCase):
    """Following up tickets with Expo's delivery receipts (Phase 9, D).

    A ticket says Expo accepted the message; only the receipt says whether
    Apple/Google delivered it. These pin the case that motivated the whole
    pass — a token that was alive at send time and dead by delivery, which the
    ticket-time ``DeviceNotRegistered`` check cannot catch.

    ``EXPO_RECEIPT_CHECK_DELAY_SECONDS=0`` so freshly-made rows are eligible;
    the delay itself is covered by its own test below.
    """

    def setUp(self):
        self.me = make_user("receipt-recipient@example.com")
        self.device = DevicePushToken.objects.create(
            user=self.me, expo_token="ExponentPushToken[live]", platform="ios"
        )
        self.receipt = PushReceipt.objects.create(
            ticket_id="ticket-1", expo_token=self.device.expo_token
        )

    def _run(self, payload):
        from django.core.management import call_command

        with mock.patch(
            "api.management.commands.send_pushes.urllib.request.urlopen"
        ) as urlopen:
            urlopen.return_value = _FakeExpoResponse(payload)
            call_command("send_pushes", verbosity=0)
        return urlopen

    def test_a_delivered_receipt_clears_the_row_and_keeps_the_device(self):
        self._run({"data": {"ticket-1": {"status": "ok"}}})

        self.assertEqual(PushReceipt.objects.count(), 0)
        self.assertTrue(
            DevicePushToken.objects.filter(pk=self.device.pk).exists()
        )

    def test_device_not_registered_in_a_receipt_reaps_the_token(self):
        # The point of the whole receipts pass. At send time this token looked
        # fine and produced an "ok" ticket; only the receipt reveals it is dead.
        # Without this the row would sit there forever, wasting a message on
        # every future notification.
        self._run(
            {
                "data": {
                    "ticket-1": {
                        "status": "error",
                        "message": "not registered",
                        "details": {"error": "DeviceNotRegistered"},
                    }
                }
            }
        )

        self.assertFalse(
            DevicePushToken.objects.filter(pk=self.device.pk).exists()
        )
        self.assertEqual(PushReceipt.objects.count(), 0)

    def test_another_error_drops_the_row_but_keeps_the_device(self):
        # A transient/unknown failure is not evidence the token is dead, and
        # there is nothing to retry — the message is already gone.
        self._run(
            {
                "data": {
                    "ticket-1": {
                        "status": "error",
                        "message": "message too big",
                        "details": {"error": "MessageTooBig"},
                    }
                }
            }
        )

        self.assertTrue(
            DevicePushToken.objects.filter(pk=self.device.pk).exists()
        )
        self.assertEqual(PushReceipt.objects.count(), 0)

    def test_a_ticket_expo_has_no_receipt_for_yet_is_left_alone(self):
        # Expo answers only about ids it has receipts for. An absent id means
        # "not ready", not "delivered" — keep it for a later run.
        self._run({"data": {}})

        self.assertTrue(
            PushReceipt.objects.filter(pk=self.receipt.pk).exists()
        )

    @override_settings(EXPO_RECEIPT_CHECK_DELAY_SECONDS=900)
    def test_a_ticket_younger_than_the_delay_is_not_asked_about(self):
        # Asking immediately just returns "not ready" and burns a request.
        urlopen = self._run({"data": {}})

        self.assertFalse(urlopen.called)
        self.assertTrue(
            PushReceipt.objects.filter(pk=self.receipt.pk).exists()
        )

    def test_a_receipt_past_expos_window_is_given_up_on(self):
        # Expo discards receipts after ~24h, so this one will never be answered.
        # Reaping it is what stops PushReceipt growing without bound.
        PushReceipt.objects.filter(pk=self.receipt.pk).update(
            created_at=timezone.now() - timedelta(hours=25)
        )

        self._run({"data": {}})

        self.assertEqual(PushReceipt.objects.count(), 0)

    def test_a_failed_receipt_check_keeps_the_row_for_the_next_run(self):
        from django.core.management import call_command

        with mock.patch(
            "api.management.commands.send_pushes.urllib.request.urlopen"
        ) as urlopen:
            urlopen.side_effect = OSError("expo unreachable")
            call_command("send_pushes", verbosity=0)

        self.assertTrue(
            PushReceipt.objects.filter(pk=self.receipt.pk).exists()
        )
        self.assertTrue(
            DevicePushToken.objects.filter(pk=self.device.pk).exists()
        )

    @override_settings(EXPO_RECEIPTS_URL="file:///etc/passwd")
    def test_a_non_https_receipts_url_is_refused(self):
        # Same reasoning as EXPO_PUSH_URL: urlopen honours file://, so a typo'd
        # or hostile value could feed a local file to the receipt parser.
        self._run({"data": {}})

        self.assertTrue(
            PushReceipt.objects.filter(pk=self.receipt.pk).exists()
        )
        self.assertTrue(
            DevicePushToken.objects.filter(pk=self.device.pk).exists()
        )

    def test_a_receipt_check_failure_does_not_undo_a_send(self):
        # The receipts pass runs outside the drain's transaction on purpose:
        # failing to *ask* about an old ticket must not roll back a push that
        # was just delivered successfully.
        actor = make_user("receipt-actor@example.com", first_name="Ada")
        make_connection(self.me, actor)
        post = Post.objects.create(author=self.me, text="hello")
        notifications.create_notification(
            self.me, actor, Notification.Kind.POST_REPLY, post=post
        )

        from django.core.management import call_command

        with mock.patch(
            "api.management.commands.send_pushes.urllib.request.urlopen"
        ) as urlopen:
            urlopen.side_effect = [
                _FakeExpoResponse(_ok_tickets(1)),  # the send succeeds
                OSError("expo unreachable"),  # the receipt check does not
            ]
            call_command("send_pushes", verbosity=0)

        self.assertIsNotNone(PushOutbox.objects.get().sent_at)


class CreateReviewAccountTests(APITestCase):
    """The isolated App Review demo account for TestFlight (create_review_account).

    Guards the two properties that matter: the reviewer can actually log in
    (both auth gates satisfied), and the account is walled off from real data
    with just one demo companion as a Report/Block target.
    """

    REVIEW = "appreview@your-timeline.net"
    BUDDY = "review-buddy@example.com"

    def test_creates_isolated_loginable_account(self):
        from io import StringIO

        from allauth.account.models import EmailAddress
        from django.core.management import call_command

        out = StringIO()
        call_command("create_review_account", password="ReviewPass123", stdout=out)

        review = User.objects.get(email=self.REVIEW)
        # Both login gates: admin-approved AND no unverified-email block.
        self.assertTrue(review.is_active)
        self.assertTrue(review.check_password("ReviewPass123"))
        self.assertFalse(EmailAddress.objects.filter(user=review).exists())

        # Walled off: connected only to the one demo companion.
        buddy = User.objects.get(email=self.BUDDY)
        self.assertFalse(buddy.has_usable_password())
        self.assertTrue(
            Connection.objects.filter(
                requester=buddy, requestee=review, status=ACCEPTED
            ).exists()
        )
        self.assertEqual(review.connections_requested.count()
                         + review.connections_received.count(), 1)

        # A Report target exists in the review account's feed.
        self.assertTrue(Post.objects.filter(author=buddy).exists())
        self.assertIn(self.REVIEW, out.getvalue())

    def test_rerun_is_a_clean_reset_and_rotates_password(self):
        from io import StringIO

        from django.core.management import call_command

        call_command("create_review_account", password="first", stdout=StringIO())
        call_command("create_review_account", password="second", stdout=StringIO())

        # Exactly one of each account; password rotated to the newest value.
        self.assertEqual(User.objects.filter(email=self.REVIEW).count(), 1)
        self.assertTrue(User.objects.get(email=self.REVIEW).check_password("second"))
        # No duplicate content piled up (one buddy post + one review post).
        self.assertEqual(
            Post.objects.filter(author__email__in=[self.REVIEW, self.BUDDY]).count(),
            2,
        )


# --- Malformed ids in a request body (#205) ---------------------------------


class MalformedRequestBodyTests(APITestCase):
    """The endpoints that read a field straight out of the JSON body rather
    than through a serializer, which is why the coercion never happened.

    A non-numeric id used to reach the ORM untouched: ``get_object_or_404(User,
    pk="abc")`` and ``filter(id__in=["abc"])`` both raise ``ValueError``, which
    DRF has no handler for — so the caller got a 500 and the log got a stack
    trace, when the honest answer is a 400. One test per endpoint, because the
    endpoints don't share a code path and this is exactly the sort of thing that
    regresses invisibly one site at a time.
    """

    def setUp(self):
        self.me = make_user("me@example.com")
        self.friend = make_user("friend@example.com")
        make_connection(self.me, self.friend)
        self.group = make_group(self.me, name="Malformed")
        self.client.force_authenticate(self.me)
        self.convo_id = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": [self.friend.id]}, format="json"
        ).data["id"]

    def test_posting_into_a_group_rejects_a_non_numeric_group_id(self):
        resp = self.client.post(
            POSTS_URL, {"text": "hello", "group": "abc"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Post.objects.exists())

    def test_starting_a_direct_chat_rejects_a_non_numeric_user_id(self):
        resp = self.client.post(CONVERSATIONS_URL, {"user_id": "abc"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_starting_a_group_chat_rejects_a_non_numeric_participant_id(self):
        resp = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": ["abc"]}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_starting_a_group_chat_rejects_a_title_that_isnt_text(self):
        """Not an id, but the same defect one field over in the same body:
        ``(x or "").strip()`` is an AttributeError for anything that isn't a
        string, and an unhandled AttributeError is a 500."""
        resp = self.client.post(
            CONVERSATIONS_URL,
            {"participant_ids": [self.friend.id], "title": ["Book club"]},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_starting_a_group_chat_rejects_a_non_numeric_group_id(self):
        resp = self.client.post(
            CONVERSATIONS_URL,
            {"participant_ids": [self.friend.id], "group_id": "abc"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_adding_participants_rejects_a_non_numeric_user_id(self):
        resp = self.client.post(
            f"/api/conversations/{self.convo_id}/participants/",
            {"user_ids": ["abc"]},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_adding_participants_rejects_a_user_ids_that_isnt_a_list(self):
        """A bare string is iterable, so ``filter(id__in="12")`` would look up
        the ids ``"1"`` and ``"2"`` character by character rather than 12."""
        resp = self.client.post(
            f"/api/conversations/{self.convo_id}/participants/",
            {"user_ids": str(self.friend.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_inviting_to_a_group_rejects_a_non_numeric_user_id(self):
        resp = self.client.post(
            group_members_url(self.group), {"user_id": "abc"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_marking_notifications_seen_rejects_a_non_numeric_id(self):
        resp = self.client.post(NOTIF_SEEN_URL, {"ids": ["abc"]}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_marking_notifications_seen_rejects_ids_that_isnt_a_list(self):
        resp = self.client.post(NOTIF_SEEN_URL, {"ids": "12"}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_an_id_too_big_for_the_column_is_a_400_not_a_500(self):
        """Python ints are unbounded, the column is a bigint. Parsing alone
        isn't enough: a long enough run of digits reaches Postgres as an
        out-of-range value, which is the same 500 by another route."""
        resp = self.client.post(
            CONVERSATIONS_URL, {"user_id": 2**64}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_boolean_is_not_read_as_the_id_it_casts_to(self):
        """``True`` is an int to Python and to the ORM, so ``{"ids": [true]}``
        used to quietly mean "id 1" — the one failure here that isn't a 500 but
        a *wrong row*, which is worse for being silent. Asserted on the
        notification path because it's the one where the mistaken row is
        observable: it gets marked seen."""
        post = Post.objects.create(author=self.friend, text="hi")
        notification = Notification.objects.create(
            recipient=self.me,
            actor=self.friend,
            kind=Notification.Kind.POST_REPLY,
            post=post,
        )
        resp = self.client.post(NOTIF_SEEN_URL, {"ids": [True]}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        notification.refresh_from_db()
        self.assertIsNone(notification.seen_at)

    def test_an_id_sent_as_a_string_of_digits_still_works(self):
        """The coercion tightened, so pin the other side of it: form bodies and
        some clients send ids as strings, and those are ordinary valid ids."""
        resp = self.client.post(
            CONVERSATIONS_URL, {"user_id": str(self.friend.id)}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)

    def test_a_group_id_that_is_falsy_but_present_is_not_read_as_no_group(self):
        """`{"group": 0}` names no group anyone has, so the post must fail —
        not quietly become a *personal* post, published to every connection,
        when the author meant it for one group. `""` is different: that's how a
        multipart form spells an empty select, and it does mean "no group"."""
        resp = self.client.post(
            POSTS_URL, {"text": "private plans", "group": 0}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Post.objects.exists())

        ok = self.client.post(POSTS_URL, {"text": "public", "group": ""})
        self.assertEqual(ok.status_code, status.HTTP_201_CREATED, ok.content)
        self.assertIsNone(Post.objects.get().group)

    def test_a_group_invite_reports_a_false_user_id_as_a_bad_id(self):
        """`false` was *sent*, so "this field is required" is the wrong answer —
        and it has to reach the coercion to be refused as an id rather than read
        as `int(False) == 0`."""
        resp = self.client.post(
            group_members_url(self.group), {"user_id": False}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("This field is required", str(resp.data))

    def test_marking_notifications_seen_rejects_an_explicit_null_ids(self):
        """Omitting `ids` means "all my unread" — an explicit `null` is a client
        whose array came back undefined, and reading that as "mark everything
        seen" clears the whole activity centre on a client bug."""
        post = Post.objects.create(author=self.friend, text="hi")
        notification = Notification.objects.create(
            recipient=self.me,
            actor=self.friend,
            kind=Notification.Kind.POST_REPLY,
            post=post,
        )
        resp = self.client.post(NOTIF_SEEN_URL, {"ids": None}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        notification.refresh_from_db()
        self.assertIsNone(notification.seen_at)

        # The other side of the line: omitting it still marks everything seen.
        allseen = self.client.post(NOTIF_SEEN_URL, {}, format="json")
        self.assertEqual(allseen.status_code, status.HTTP_200_OK)
        notification.refresh_from_db()
        self.assertIsNotNone(notification.seen_at)

    def test_an_id_list_longer_than_the_cap_is_refused(self):
        """Each id becomes a bind parameter, and the driver refuses a statement
        with more than 65535 of them — so an unbounded list is a 500 any
        authenticated caller can post. A guard rail well above real use."""
        resp = self.client.post(
            NOTIF_SEEN_URL,
            {"ids": list(range(1, BODY_IDS_MAX + 2))},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_body_that_isnt_an_object_is_a_400_not_a_500(self):
        """`[]` is valid JSON and DRF passes it straight through, so every
        endpoint that reads its body by hand called `.get` on a list — an
        AttributeError, which is the same unhandled 500 as a malformed id, one
        level up."""
        post = Post.objects.create(author=self.friend, text="hi")
        cases = [
            ("post", CONVERSATIONS_URL),
            ("post", f"/api/conversations/{self.convo_id}/participants/"),
            ("post", group_members_url(self.group)),
            ("post", NOTIF_SEEN_URL),
            ("post", f"/api/posts/{post.pk}/react/"),
            ("post", "/api/account/delete/"),
        ]
        for method, url in cases:
            with self.subTest(url=url):
                resp = getattr(self.client, method)(url, [], format="json")
                self.assertEqual(
                    resp.status_code, status.HTTP_400_BAD_REQUEST, url
                )


class IntIdCoercionTests(SimpleTestCase):
    """`_int_id` direct, for the edges an endpoint test can't reach cleanly.

    It's the single definition of what an id is — for request bodies and for
    `?thread_root=`/`?ids=` alike — so its boundaries are worth pinning rather
    than inferring from a value two doublings clear of them.
    """

    def test_accepts_ints_and_strings_of_digits(self):
        for raw, expected in ((12, 12), ("12", 12), (-3, -3), ("-3", -3), (0, 0)):
            with self.subTest(raw=raw):
                self.assertEqual(_int_id(raw, "f"), expected)

    def test_accepts_the_bigint_boundary_but_not_past_it(self):
        self.assertEqual(_int_id(2**63 - 1, "f"), 2**63 - 1)
        self.assertEqual(_int_id(-(2**63), "f"), -(2**63))
        for raw in (2**63, -(2**63) - 1, 2**64):
            with self.subTest(raw=raw):
                with self.assertRaises(ValidationError):
                    _int_id(raw, "f")

    def test_refuses_what_int_would_have_swallowed(self):
        """`int()` is looser than "a number": these all parse, and none of them
        is an id anyone meant to send."""
        for raw in (True, False, 4.7, 4.0, "1_0", "١٢", " 12 ", "+12",
                    "0x1f", "", None, ["12"]):
            with self.subTest(raw=raw):
                with self.assertRaises(ValidationError):
                    _int_id(raw, "f")

    def test_refuses_a_string_too_long_to_parse_at_all(self):
        """Python won't convert a string of more than 4300 digits, so an
        unbounded parse is itself a way to raise out of a function whose whole
        job is answering 400. Bounded at a bigint's 19 digits instead."""
        with self.assertRaises(ValidationError):
            _int_id("9" * 5000, "f")
