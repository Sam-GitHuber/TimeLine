from django.conf import settings
from django.db import models
from django.db.models.functions import Greatest, Least

from .imaging import post_image_upload_to, post_thumb_upload_to


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

    user_a = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversations_as_a",
    )
    user_b = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversations_as_b",
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
