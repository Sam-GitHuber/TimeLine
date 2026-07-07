from django.conf import settings
from django.db import models
from django.db.models.functions import Greatest, Least

from .imaging import (
    group_avatar_thumb_upload_to,
    group_avatar_upload_to,
    post_image_upload_to,
    post_thumb_upload_to,
)


class Post(models.Model):
    """A single text post by a user — the core unit of TimeLine.

    Photos arrive in Phase 4; for now a post is just author + text + when.
    ``created_at`` is what the feed sorts on (newest first, always — the
    project's non-negotiable reverse-chronological rule), so it's indexed.
    """

    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="posts",
    )
    # A post is either a personal-timeline post (``group`` is NULL — the
    # original Phase 3 behaviour, and what the home feed shows) or a post made
    # into a group's shared timeline (Phase 6). Keeping it as one nullable FK
    # rather than a separate ``GroupPost`` model means group posts reuse *all*
    # the post machinery: photos, the comment tree, the serializer, and the
    # imaging pipeline. Deleting a group takes its posts with it. Indexed
    # because both the home feed (``group IS NULL``) and a group timeline
    # (``group = X``) filter on it.
    group = models.ForeignKey(
        "Group",
        on_delete=models.CASCADE,
        related_name="posts",
        null=True,
        blank=True,
        db_index=True,
    )
    text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        # Default to newest-first everywhere this model is queried. The ``-id``
        # tiebreaker keeps pagination stable: posts sharing a ``created_at``
        # (same clock tick) get a deterministic total order, so paging through
        # the feed can't duplicate or skip a post at a page boundary.
        ordering = ["-created_at", "-id"]

    def __str__(self):
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.author} · {preview}"


class PostImage(models.Model):
    """One photo attached to a ``Post`` — a post can have several (Phase 4).

    Its own table (rather than a single field on ``Post``) is what lets a post
    carry multiple photos. Both ``image`` (the bounded original) and
    ``thumbnail`` (what the feed renders) are produced by
    ``api.imaging.process_image`` in the view — validated + metadata-stripped —
    so nothing here trusts a raw upload. ``width``/``height`` are the stored
    original's dimensions, handed to the client so it can reserve layout space
    and avoid reflow. Deleting a post cascades to its images.
    """

    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        related_name="images",
    )
    image = models.ImageField(upload_to=post_image_upload_to)
    thumbnail = models.ImageField(upload_to=post_thumb_upload_to)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # Show a post's photos in the order they were uploaded. ``id`` breaks
        # ties for images created in the same tick, keeping galleries stable.
        ordering = ["id"]

    def __str__(self):
        return f"image #{self.pk} of {self.post}"


class Connection(models.Model):
    """A connection between two accounts — mutual once accepted.

    ``requester`` asks to connect with ``requestee``. Accounts are
    private-by-default: the connection starts **pending** and grants no access
    on its own. Once the requestee **approves** it (``status`` becomes
    ``accepted``) the connection is **symmetric** — each account sees the
    other's posts. There is no one-way "follow": approving is the whole
    relationship. Rejecting or disconnecting deletes the row.

    While pending, direction still matters (who asked whom, for the requests
    inbox). Once accepted, the row is treated as an undirected edge and every
    "who am I connected with" query checks *both* endpoints — so a single row is
    the one source of truth and there's no reciprocal row to drift out of sync.

    Two guardrails live in the database (not just the API) so bad data can't
    sneak in another way:
    - at most one row per unordered pair — no duplicate in *either* direction
      (``UniqueConstraint`` on the min/max of the two ids),
    - you can't connect with yourself (``CheckConstraint``).
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"

    requester = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="connections_requested",
    )
    requestee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="connections_received",
    )
    status = models.CharField(
        max_length=8,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # One row per unordered pair: because a connection is symmetric,
            # A↔B and B↔A are the *same* relationship, so we forbid a second
            # row in the reverse direction too — not just an exact duplicate.
            # The unique index is on the smaller/larger of the two user ids, so
            # the pair is order-independent at the database level.
            models.UniqueConstraint(
                Least("requester_id", "requestee_id"),
                Greatest("requester_id", "requestee_id"),
                name="unique_connection_pair",
            ),
            models.CheckConstraint(
                condition=~models.Q(requester=models.F("requestee")),
                name="no_self_connection",
            ),
        ]

    def __str__(self):
        arrow = "↔" if self.status == self.Status.ACCEPTED else "→"
        return f"{self.requester} {arrow} {self.requestee} ({self.status})"


class Comment(models.Model):
    """A comment on a post, or a reply to another comment — a node in a tree.

    ``parent`` is null for a top-level comment on the post, or points at the
    comment being replied to. The tree can nest to any depth; the reply chain is
    walked in Python when building the (visibility-pruned) tree the API returns.

    Deleting a comment cascades to its replies (``on_delete=CASCADE`` on
    ``parent``): removing a node removes the branch under it, which matches how
    the tree reads — a reply with no visible parent makes no sense.

    Visibility is **not** stored here — it's computed per-viewer against their
    connections when the tree is served (a comment, and everything under it, is
    hidden from anyone not connected with its author). See the comments view.
    """

    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        related_name="comments",
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="comments",
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="replies",
    )
    text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        # Oldest-first: a comment thread reads top-to-bottom in the order it was
        # written (unlike the feed). The ``id`` tiebreaker keeps siblings that
        # share a timestamp in a stable, deterministic order.
        ordering = ["created_at", "id"]

    def __str__(self):
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.author} · {preview}"


class Conversation(models.Model):
    """A private 1:1 message thread between two accounts (Phase 5).

    Same symmetric-pair shape as ``Connection``: the two participants are
    ``user_a``/``user_b`` and a single row represents the unordered pair, so
    there's exactly one conversation per pair whichever way it's opened. The two
    database guardrails mirror ``Connection`` — at most one row per unordered
    pair, and no conversation with yourself.

    ``updated_at`` is bumped whenever a message is sent (see the message-create
    view), so the conversation list can sort by most-recent-activity cheaply —
    time-ordered, never "relevance" (the project's non-negotiable rule applies to
    messaging too). It's indexed for that ordering.

    Group threads are a later extension (Phase 6a): the read-marker lives in its
    own ``ConversationRead`` table rather than as two timestamps here, so adding
    more participants doesn't require reshaping this model.
    """

    class Kind(models.TextChoices):
        DIRECT = "direct", "Direct"
        GROUP = "group", "Group"

    kind = models.CharField(
        max_length=6, choices=Kind.choices, default=Kind.DIRECT, db_index=True
    )
    # A group chat scoped to a Phase 6 Group. NULL = standalone (1:1 or ad-hoc
    # multi-person). CASCADE: deleting a group deletes its chats (agreed 2026-07-07).
    group = models.ForeignKey(
        "Group", on_delete=models.CASCADE, null=True, blank=True,
        related_name="chats",
    )
    title = models.CharField(max_length=100, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="conversations_created",
    )
    user_a = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversations_as_a",
        null=True,
        blank=True,
    )
    user_b = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversations_as_b",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [
            # One row per unordered pair — A↔B and B↔A are the same thread.
            # Order-independent at the database level (index on min/max id).
            models.UniqueConstraint(
                Least("user_a_id", "user_b_id"),
                Greatest("user_a_id", "user_b_id"),
                name="unique_conversation_pair",
            ),
            models.CheckConstraint(
                condition=~models.Q(user_a=models.F("user_b")),
                name="no_self_conversation",
            ),
        ]

    def other_participant(self, user):
        """The participant who isn't ``user`` — the person they're talking to."""
        return self.user_b if self.user_a_id == user.id else self.user_a

    def __str__(self):
        return f"{self.user_a} ↔ {self.user_b}"


class Message(models.Model):
    """One message in a ``Conversation`` (Phase 5).

    ``sender`` is always one of the conversation's two participants (enforced in
    the view — it's taken from the session, never the request body). Deleting a
    conversation cascades to its messages. ``created_at`` is indexed because the
    thread and the unread count both query on it.

    Soft delete: a sender can delete their own message (v1 scope). Rather than
    dropping the row — which would break the "oldest-first, stable" ordering and
    lose the tombstone — we blank ``text`` and set ``deleted_at``, so the thread
    still renders a "message deleted" placeholder in the right place.
    """

    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_messages",
    )
    text = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        # Oldest-first, like a comment thread — a conversation reads top to
        # bottom in send order. ``id`` breaks ties within a clock tick so paging
        # is stable.
        ordering = ["created_at", "id"]

    @property
    def is_deleted(self):
        return self.deleted_at is not None

    def __str__(self):
        if self.is_deleted:
            return f"{self.sender} · (deleted)"
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.sender} · {preview}"


class ConversationRead(models.Model):
    """How far a participant has read in a conversation (Phase 5).

    One row per (conversation, user): ``last_read_at`` is the moment they last
    marked it read. Your unread count for a conversation is the number of
    messages with ``created_at > last_read_at`` that you didn't send (a missing
    row means you've never opened it, so everything is unread).

    Kept as its own table rather than two timestamps on ``Conversation`` so the
    same shape carries over to group threads (Phase 6a) — N participants, N read
    rows — without a migration.
    """

    conversation = models.ForeignKey(
        Conversation,
        on_delete=models.CASCADE,
        related_name="reads",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversation_reads",
    )
    last_read_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "user"],
                name="unique_conversation_read",
            ),
        ]

    def __str__(self):
        return f"{self.user} read {self.conversation} @ {self.last_read_at}"


class Block(models.Model):
    """One account blocking another (Phase 5) — directional, but enforced both
    ways.

    ``blocker`` blocks ``blocked``. A block in *either* direction is enough to
    cut the pair off from each other: it prevents messaging and (re)connecting,
    whichever of them set it. Storing it directionally (rather than as an
    unordered pair like ``Connection``) records *who* did the blocking — needed
    so unblock only lets the blocker lift their own block, and so a mutual block
    is two independent rows.

    ``unique_together`` stops a duplicate block in the same direction; a check
    constraint stops blocking yourself.
    """

    blocker = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="blocks_made",
    )
    blocked = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="blocks_received",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["blocker", "blocked"],
                name="unique_block_pair",
            ),
            models.CheckConstraint(
                condition=~models.Q(blocker=models.F("blocked")),
                name="no_self_block",
            ),
        ]

    def __str__(self):
        return f"{self.blocker} ⊘ {self.blocked}"


class Participant(models.Model):
    """One person's membership of a conversation (Phase 6a).

    Generalises Phase 5's user_a/user_b pair into a set. ``status`` is the
    current state: ``active`` (in the chat, counts toward the clique) or
    ``pending`` (invited but not yet connected to every active member).
    ``left_at`` tombstones a self-leave/decline. History visibility is *not* a
    single join point — see ``ParticipantInterval``.
    """

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        PENDING = "pending", "Pending"

    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="chat_participations",
    )
    status = models.CharField(
        max_length=7, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="chat_invites_sent",
    )
    left_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "user"], name="unique_conversation_participant"
            ),
        ]

    def __str__(self):
        return f"{self.user} · {self.conversation_id} ({self.status})"


class ParticipantInterval(models.Model):
    """A span during which a participant was ``active`` (Phase 6a).

    A message is visible to a participant iff its ``created_at`` falls inside one
    of their intervals. Becoming active opens an interval; dropping to pending /
    leaving closes it (``ended_at``); returning opens a new one — so a
    blocked-then-returned member keeps pre-gap history and never sees the gap.
    """

    participant = models.ForeignKey(
        Participant, on_delete=models.CASCADE, related_name="intervals"
    )
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["started_at", "id"]

    def __str__(self):
        return f"{self.participant_id}: {self.started_at} → {self.ended_at or '…'}"


class Group(models.Model):
    """A private, invite-only shared space with its own timeline (Phase 6).

    A family group, a friend circle, a shared-interest group. Members post into
    the group's timeline (``Post.group`` points here) and read it
    reverse-chronological, exactly like the home feed but scoped to the group —
    no ranking, ever. Group posts deliberately stay *inside* the group and do
    **not** appear in members' home feeds (see the phase doc): the home feed
    means "my connections", a group means "this group", and the two have
    different visibility rules, so they stay separate surfaces.

    Groups are always private/invite-only in this phase — there's no public or
    discoverable group. The ``avatar``/``avatar_thumb`` reuse the same validated,
    EXIF-stripped, downscaled imaging pipeline as user avatars and post photos
    (``api.imaging`` — never a raw upload). URLs are numeric (``/g/:id``), no
    slug, consistent with profiles.
    """

    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)
    avatar = models.ImageField(
        upload_to=group_avatar_upload_to, null=True, blank=True
    )
    avatar_thumb = models.ImageField(
        upload_to=group_avatar_thumb_upload_to, null=True, blank=True
    )
    creator = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        # Keep the group (and its timeline) if the creator's account is deleted —
        # a group outlives any one member. The creator is a record of who made
        # it; the ≥1-admin rule (enforced in the views) keeps the group
        # governable regardless.
        on_delete=models.SET_NULL,
        null=True,
        related_name="groups_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]

    def __str__(self):
        return self.name

    def active_member_count(self):
        """The number of active members (excludes pending invites). The one
        definition of "how many members" — the API list annotates this in bulk
        (no N+1), but the serializer, admin, and detail view all fall back to
        this so the count can't mean different things in different places."""
        return self.memberships.filter(
            status=GroupMembership.Status.ACTIVE
        ).count()


class GroupMembership(models.Model):
    """One person's membership of a ``Group`` — their role and join state.

    A single row per (group, user): an invitation and an active membership are
    the *same* row moving ``status`` from ``invited`` → ``active``, so a person
    can't end up with two rows for one group. "Members of a group" means the
    ``active`` rows; an ``invited`` row grants no access until the invitee
    accepts (consent-first, mirroring ``Connection``).

    Two roles only (see the phase doc): ``member`` (read/post/comment/leave) and
    ``admin`` (also invite-removal, edit, delete, promote). The creator starts as
    an ``admin``; the views enforce that at least one admin always remains.
    ``invited_by`` records who sent the invite (for the "X invited you" line in
    the invites inbox) and survives that person leaving.
    """

    class Role(models.TextChoices):
        MEMBER = "member", "Member"
        ADMIN = "admin", "Admin"

    class Status(models.TextChoices):
        INVITED = "invited", "Invited"
        ACTIVE = "active", "Active"

    group = models.ForeignKey(
        Group,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="group_memberships",
    )
    role = models.CharField(
        max_length=6,
        choices=Role.choices,
        default=Role.MEMBER,
    )
    status = models.CharField(
        max_length=7,
        choices=Status.choices,
        default=Status.INVITED,
        db_index=True,
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="group_invites_sent",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # One membership row per person per group — an invite and an active
            # membership are the same row, so never two for one (group, user).
            models.UniqueConstraint(
                fields=["group", "user"],
                name="unique_group_membership",
            ),
        ]

    def __str__(self):
        return f"{self.user} · {self.group} ({self.role}, {self.status})"
