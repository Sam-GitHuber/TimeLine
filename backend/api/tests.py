import importlib.util
import os
import shutil
import tempfile
from io import BytesIO
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db.models import Q
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from PIL import Image
from rest_framework import status
from rest_framework.test import APITestCase

from api.views import (
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
    Group,
    GroupMembership,
    Message,
    Participant,
    ParticipantInterval,
    Post,
)

User = get_user_model()

FEED_URL = "/api/feed/"
POSTS_URL = "/api/posts/"
USERS_URL = "/api/users/"
REQUESTS_URL = "/api/connection-requests/"
CONVERSATIONS_URL = "/api/conversations/"
UNREAD_COUNT_URL = "/api/messages/unread-count/"
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
        self.client.post(f"/api/conversations/{self.convo_id}/messages/", {"text": "hi"}, format="json")
        self.client.force_authenticate(self.b)
        unread_before = self.client.get(UNREAD_COUNT_URL)
        self.assertGreaterEqual(unread_before.data["count"], 1)

        res = self.client.post(f"/api/conversations/{self.convo_id}/read/")
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
