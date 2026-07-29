import importlib.util
import json
import os
import shutil
import tempfile
from datetime import UTC, time, timedelta
from io import BytesIO
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.db.models import Q
from django.db.utils import OperationalError
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase

from api import imaging, notifications
from api.emoji import (
    MAX_REACTIONS_PER_USER_PER_TARGET,
    InvalidEmoji,
    normalise_emoji,
)
from api.serializers import (
    CONVERSATION_TITLE_MAX_LENGTH,
    MESSAGE_ATTACHMENT_MAX_BYTES,
    MESSAGE_ATTACHMENTS_MAX,
    MESSAGE_MAX_LENGTH,
    MESSAGE_THUMBNAIL_MAX_BYTES,
    NotificationSerializer,
)
from api.views import (
    MESSAGE_EDIT_WINDOW,
    MESSAGE_IDS_MAX,
    activate,
    active_participant_ids,
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
       a stranger's phone — exactly what the clique invariant forbids.
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


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}},
)
class DeleteAccountTests(APITestCase):
    def setUp(self):
        cache.clear()  # /account/delete/ is throttled per user — isolate it
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
        shutil.rmtree(_DELETE_MEDIA_ROOT, ignore_errors=True)

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

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
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

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(DevicePushToken.objects.count(), 1)
        self.assertEqual(DevicePushToken.objects.get().user, self.me)

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


@override_settings(EXPO_ACCESS_TOKEN="", EXPO_PUSH_RETENTION_DAYS=14)
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
            call_command("send_pushes", verbosity=0, **kwargs)
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
