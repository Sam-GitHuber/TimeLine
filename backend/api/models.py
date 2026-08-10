from django.conf import settings
from django.db import models
from django.db.models.functions import Greatest, Least

from .imaging import (
    event_photo_thumb_upload_to,
    event_photo_upload_to,
    group_avatar_thumb_upload_to,
    group_avatar_upload_to,
    message_attachment_thumb_upload_to,
    message_attachment_upload_to,
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
    # When the author last edited the post's text (issue #62). **Null until the
    # first edit** — that's how "created but never edited" is told apart, so the
    # feed can show a quiet "· edited" marker only on posts that really were
    # changed. Set explicitly in the update view (not ``auto_now``) so it tracks
    # a real content edit, never an incidental ``save()`` — mirroring how
    # ``Conversation.updated_at`` is bumped deliberately, not automatically.
    edited_at = models.DateTimeField(null=True, blank=True)

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
    """A comment on a post **or a group event**, or a reply to another comment —
    a node in a tree.

    The target is exactly one of a ``Post`` or an ``Event``, guarded by a check
    constraint. That's the same shape ``Reaction`` uses, and it was chosen for
    the same reason: the targets are concrete and few, so two nullable FKs plus
    a constraint beats ``GenericForeignKey``/contenttypes machinery, and it
    keeps **one** tree builder, one prune, one edit/delete route and one reply
    rule rather than a parallel ``EventComment`` that would drift from all five.
    ``post`` is nullable *only* because of this — every comment still has
    exactly one target.

    An **event** comment is the ordinary "are we still on for Saturday?" that
    used to have nowhere to go but the group timeline, detached from the plan it
    was about. Its tree behaves identically to a post's; only the gate differs
    (``can_view_event`` instead of ``can_view_post`` — see ``can_view_comment``).

    ``parent`` is null for a top-level comment on the target, or points at the
    comment being replied to. The tree can nest to any depth; the reply chain is
    walked in Python when building the (visibility-pruned) tree the API returns.
    A reply always shares its parent's target — enforced in the view, which
    refuses a ``parent`` from a different post/event.

    Deleting a comment cascades to its replies (``on_delete=CASCADE`` on
    ``parent``): removing a node removes the branch under it, which matches how
    the tree reads — a reply with no visible parent makes no sense. **That
    cascade is exactly why author-deletion is only sometimes a row delete** —
    see ``deleted_at``.

    Visibility is **not** stored here — it's computed per-viewer against their
    connections when the tree is served (a comment, and everything under it, is
    hidden from anyone not connected with its author). See the comments view.
    """

    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        related_name="comments",
        null=True,
        blank=True,
    )
    # The event this comment is on, when it isn't on a post. CASCADE like
    # ``post``: delete the thing and its conversation goes with it.
    event = models.ForeignKey(
        "Event",
        on_delete=models.CASCADE,
        related_name="comments",
        null=True,
        blank=True,
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
    text = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    # When the author last edited the text (issue #128) — **null until the first
    # edit**, exactly like ``Post.edited_at``, so "written and never touched" is
    # told apart without timestamp-comparison guesswork. Set explicitly in the
    # detail view rather than ``auto_now``, so an incidental ``save()`` (the
    # soft-delete write below, say) can't mislabel a comment as edited.
    edited_at = models.DateTimeField(null=True, blank=True)
    # Set when the author deletes a comment that has replies (issue #128).
    #
    # **Deletion is hard when it can be and soft when it must be**, decided by
    # whether the comment has any replies at all:
    #
    # - **No replies** → the row is deleted outright. This is the common case (a
    #   typo, a comment you regret) and it should leave nothing behind.
    # - **Has replies** → the row stays, ``text`` blanked and ``deleted_at``
    #   stamped, so the thread renders a "comment deleted" tombstone with the
    #   replies still hanging off it. A hard delete here would take *other
    #   people's* replies down with it via the ``parent`` cascade above, which is
    #   not a thing your own delete should be able to do.
    #
    # The choice is made on **all** replies, not the ones a given viewer can see,
    # so every viewer gets the same outcome from one delete. A tombstone whose
    # replies a viewer can't see is then hidden *for that viewer* by the tree
    # builder — see ``build_visible_comment_tree``.
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        # Oldest-first: a comment thread reads top-to-bottom in the order it was
        # written (unlike the feed). The ``id`` tiebreaker keeps siblings that
        # share a timestamp in a stable, deterministic order.
        ordering = ["created_at", "id"]
        constraints = [
            # A comment hangs off exactly one thing — a post or an event. Never
            # both (which target would its replies belong to?), and never
            # neither (a comment on nothing is unreachable and unprunable, since
            # every gate starts from the target).
            models.CheckConstraint(
                name="comment_targets_exactly_one",
                condition=(
                    models.Q(post__isnull=False, event__isnull=True)
                    | models.Q(post__isnull=True, event__isnull=False)
                ),
            ),
        ]
        indexes = [
            # The event thread's one query, mirroring the implicit index the
            # ``post`` FK already gives the post thread.
            models.Index(fields=["event", "created_at"]),
        ]

    @property
    def target(self):
        """The ``Post`` or ``Event`` this comment is on.

        The constraint guarantees exactly one, so callers that only need "the
        thing this hangs off" (the notification deep-link, the reply-target
        check) can ask once instead of branching on two FKs and getting it
        subtly wrong in one of the places.
        """
        return self.post if self.post_id else self.event

    @property
    def is_deleted(self):
        return self.deleted_at is not None

    @property
    def is_edited(self):
        return self.edited_at is not None

    def __str__(self):
        if self.is_deleted:
            return f"{self.author} · (deleted)"
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.author} · {preview}"


class PostCommentRead(models.Model):
    """How recently a user last opened a post's **or event's** comment thread
    (issue #63).

    One row per (target, user): ``last_seen_at`` is stamped whenever the user
    opens the thread (the ``GET`` on the comments endpoint). It's the marker the
    feed uses to show a "N new" count next to *Comments* — a visible comment is
    "new" to you if its ``created_at`` is after this timestamp (a missing row
    means you've never opened the thread, so every comment is new).

    Widened for event threads the same way ``Comment`` itself was: a nullable
    ``event`` beside a now-nullable ``post``, exactly one set. **The name is
    now half-wrong and is kept anyway** — renaming the model is a table rename
    plus a `related_name` change across the read paths, and the cost of that
    lands on a live database holding real beta data for no behavioural gain. If
    it's ever renamed, do it on its own, not folded into a feature.

    Deliberately the same shape as ``ConversationRead`` (which tracks how far a
    participant has read a message thread): a single last-seen timestamp per
    (thing, user), cheap to upsert on open and cheap to left-join when counting.
    "Seen" here is thread-level, not per-comment — opening the thread clears the
    whole count at once, matching how opening a conversation clears its unread
    badge.
    """

    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        related_name="comment_reads",
        null=True,
        blank=True,
    )
    event = models.ForeignKey(
        "Event",
        on_delete=models.CASCADE,
        related_name="comment_reads",
        null=True,
        blank=True,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="post_comment_reads",
    )
    last_seen_at = models.DateTimeField()

    class Meta:
        constraints = [
            # Both are **conditional** on their FK being set. The original was a
            # plain unique (post, user); left that way once ``post`` went
            # nullable, every event row would have NULL there — and Postgres
            # treats NULLs as distinct, so it would stop enforcing anything for
            # events while silently still looking like it did.
            models.UniqueConstraint(
                fields=["post", "user"],
                condition=models.Q(post__isnull=False),
                name="unique_post_comment_read",
            ),
            models.UniqueConstraint(
                fields=["event", "user"],
                condition=models.Q(event__isnull=False),
                name="unique_event_comment_read",
            ),
            models.CheckConstraint(
                name="comment_read_targets_exactly_one",
                condition=(
                    models.Q(post__isnull=False, event__isnull=True)
                    | models.Q(post__isnull=True, event__isnull=False)
                ),
            ),
        ]

    def __str__(self):
        target = self.post if self.post_id else self.event
        return f"{self.user} saw {target} comments @ {self.last_seen_at}"


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

    Edit (Phase 9b M1): a sender can correct their own message for a short window
    after sending, which stamps ``edited_at``. We keep no revision history — the
    row holds the current text only. ``edited_at`` exists so the client can mark
    the bubble "Edited": a thread is a shared record, and silently changing what
    someone already read would make the record untrustworthy. The *window* is the
    other half of that guarantee and lives in the view (``MESSAGE_EDIT_WINDOW``).

    Reply threads (Phase 9b M3): ``reply_to`` is the message this one answers and
    ``thread_root`` the head of the thread it belongs to — see ``save``. The
    reply's *text* is never carried on the quoting message; a client that wants
    the quoted body fetches it through the interval-clipped messages endpoint
    like any other message, which is what keeps a reply from becoming a window
    into history the viewer was clipped out of.

    Mentions (Phase 9b M8): naming someone with ``@`` writes a ``MessageMention``
    row rather than leaving the fact in the text, so the "a mention notifies even
    in a muted chat" rule is decided from metadata — which is what keeps it
    working once the text is ciphertext.
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
    # NULL = never edited. Not ``auto_now``: only an edit stamps it, whereas
    # ``auto_now`` would also fire on the soft-delete write and mislabel a
    # deleted message as edited.
    edited_at = models.DateTimeField(null=True, blank=True)
    # Phase 9b M3. The message this one answers — what the collapsed quote and
    # the focused thread view render. ``SET_NULL``, not CASCADE: deleting a
    # quoted message must not delete the replies to it (and message deletion is
    # soft anyway, so the row usually survives — this covers a hard delete).
    reply_to = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="replies",
    )
    # The message at the head of the reply thread this one belongs to — NULL on
    # a message that isn't part of one. Denormalised in ``save`` below.
    thread_root = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_index=True,
        related_name="thread_messages",
    )

    class Meta:
        # Oldest-first, like a comment thread — a conversation reads top to
        # bottom in send order. ``id`` breaks ties within a clock tick so paging
        # is stable.
        ordering = ["created_at", "id"]

    def save(self, *args, **kwargs):
        """Keep ``thread_root`` in step with ``reply_to``.

        **Reply threads are one level deep, always.** Replying to a reply joins
        the thread that reply is already in rather than starting a nested one —
        so ``thread_root`` is the *reply target's* root if it has one, else the
        target itself. A tree would need recursive reads to render and would let
        a conversation grow branches nobody can follow on a phone screen; one
        flat thread per root is the shape every mainstream messenger settled on.

        Derived here rather than in the view so it can't be forgotten by a second
        write path (an import, a management command, a future bulk send). The
        column exists at all because it turns "give me this thread" and "how many
        replies has this got" into single indexed queries instead of a recursive
        walk.
        """
        # Only on insert. Later writes pass ``update_fields`` (the edit and
        # soft-delete paths both do), so recomputing here would silently not be
        # persisted — better to derive it once, where it's true.
        if self._state.adding and self.reply_to_id and not self.thread_root_id:
            self.thread_root_id = self.reply_to.thread_root_id or self.reply_to_id
        super().save(*args, **kwargs)

    @property
    def is_deleted(self):
        return self.deleted_at is not None

    @property
    def is_edited(self):
        return self.edited_at is not None

    def __str__(self):
        if self.is_deleted:
            return f"{self.sender} · (deleted)"
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.sender} · {preview}"


class MessageAttachment(models.Model):
    """A photo sent in a chat (Phase 9b M7) — the same shape as ``PostImage``,
    with two deliberate differences.

    **1. It is a table with a ``kind``, not an image field on ``Message``.**
    Phase 13 adds video clips (``docs/phases/phase-13-video-clips.md``) and that
    should slot in as another ``kind`` on this row — same endpoint, same bubble
    layout, same lightbox — rather than growing a parallel model and a second
    upload path beside this one. ``thumbnail`` is already the right field for a
    video's poster frame. Only ``IMAGE`` exists today; adding ``VIDEO`` before
    anything can produce one would be a promise the code doesn't keep.

    The row is a table for a second reason: a message carrying *several* photos
    is then additive. Today the API accepts **one attachment per message** and
    the app sends a multi-photo pick as several messages — see messaging.md for
    why that's the better chat shape (each photo gets its own bubble, and so its
    own reactions, replies and delete).

    **2. 🔒 Nothing here was decoded by us.** ``PostImage`` is written by
    ``api.imaging.process_image`` — validated by opening it, EXIF-stripped,
    downscaled. A message attachment is processed **on the client** instead, so
    the pipeline still works when the server is handed ciphertext under E2E
    (phase 9c). The server enforces byte size and count only, which are the
    limits that survive an opaque blob. Consequences worth knowing:

    - ``width``/``height`` are what the **client says** they are. They're layout
      hints — the bubble reserves space so the transcript doesn't reflow — and
      nothing security-sensitive keys off them. They're bounds-checked so a
      nonsense value can't wedge a layout, not trusted.
    - The stored filename always ends ``.jpg`` regardless of what was uploaded
      (``message_attachment_upload_to``), because the file server picks a
      Content-Type from the extension and an unverified blob served as markup
      would be stored XSS. See that callable for the whole argument.
    - A ``FileField``, not an ``ImageField``: ``ImageField`` validation would
      open the file with Pillow on every save, which is exactly the server-side
      decode this design is built to do without.
    """

    class Kind(models.TextChoices):
        IMAGE = "image", "Image"

    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="attachments",
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.IMAGE)
    file = models.FileField(upload_to=message_attachment_upload_to)
    thumbnail = models.FileField(upload_to=message_attachment_thumb_upload_to)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # Upload order, ``id`` breaking ties — same rule as ``PostImage``, so a
        # message that carries more than one attachment renders stably.
        ordering = ["id"]

    def __str__(self):
        return f"{self.kind} #{self.pk} on message #{self.message_id}"


class MessageMention(models.Model):
    """Someone named with ``@`` in a message (Phase 9b M8).

    **A real relation, not a name parsed out of the text.** Two reasons, and both
    are the kind that only bite later:

    - **Display names change.** A mention resolved by matching text would stop
      notifying the moment someone married, and would start notifying the wrong
      person if two members' names ever collided.
    - **🔒 Under E2E the server cannot read the message at all.** Whoever a
      mention notifies has to be decidable from *metadata*, because the words
      will be ciphertext (phase 9c). A row per mentioned user is exactly that,
      and it's why this table exists on the day mentions ship rather than being
      "extracted properly later".

    What it's *for* is one thing only: **a mention notifies even in a muted
    thread** (see ``notifications.enqueue_message_pushes``). That's the whole
    point of naming someone, and it's also the one justified exception to
    ``Participant.muted_at`` — so it's opt-out per user, via the ``mention``
    notification preference.

    The **client** decides who it offers to mention and sends the ids; the
    serializer checks each one is an active participant of that conversation, so
    a message can never carry a mention of someone who isn't in the room.
    ``CASCADE`` on both sides: the mention is a fact about a message and a user,
    and outlives neither.
    """

    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="mentions",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="message_mentions",
    )

    class Meta:
        constraints = [
            # Naming someone twice in one message is one mention of them — the
            # notification rule is per-person, so a second row would be a second
            # chance to get the "did we already queue one" logic wrong.
            models.UniqueConstraint(
                fields=["message", "user"], name="unique_message_mention"
            ),
        ]
        indexes = [
            # The push path's question: who did this message name?
            models.Index(fields=["message"]),
        ]

    def __str__(self):
        return f"@{self.user} in message #{self.message_id}"


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
    # When this person muted the thread's **push notifications** (null = unmuted).
    #
    # Per-participant, not per-conversation: muting a noisy group chat is one
    # member's choice and must not silence it for everyone else. It lives here
    # rather than in ``NotificationPreference`` because messaging is deliberately
    # not part of the activity centre (see docs/reference/messaging.md), so there
    # is no notification *kind* to hang a preference off.
    #
    # A timestamp rather than a boolean for the same reason ``left_at`` is: it
    # records *when*, which is free to store and answers "since when has this
    # been quiet?" when someone reports missing messages.
    #
    # Mute affects **push only**. The thread still accrues unread messages and
    # still shows its unread badge — muting means "don't buzz my phone", not
    # "hide this conversation", which would be a much bigger promise and would
    # risk someone silently missing a thread entirely.
    muted_at = models.DateTimeField(null=True, blank=True)
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


# A report reason is free text but bounded — a sentence or two of "why", not an
# essay. Optional (the flag itself is the signal); capped to bound the DB row.
# Defined here (next to the model) so the serializer's cap and the field's cap
# are the same number from one source, not two that can drift.
REPORT_REASON_MAX_LENGTH = 1000


class Report(models.Model):
    """A member's report of a post, comment or message for the maintainer to
    review (Phase 7 — content-takedown path; messages added in Phase 9b M0).

    Required before inviting real people: as an operator we need a way for
    someone to flag content they believe infringes copyright or shouldn't be
    here, and for the maintainer to act on it (see the Legal / IP notes in
    docs/SHARED.md). The report just *records the flag*; removal is a manual
    admin action — the maintainer reads the reported item in the Django admin
    (where posts and comments are already moderatable) and deletes it if
    warranted, then marks the report resolved.

    A report targets **exactly one** of a post, a comment or a message (a DB
    check constraint enforces it). ``reporter`` is CASCADE: if someone deletes
    their account their open reports go with them (the flag was theirs to make).
    The target FKs are CASCADE too — once the content is gone the report has done
    its job.

    **A reported message is the only way message text reaches the admin**, and
    the reason ``message_text`` exists. The Django admin deliberately cannot
    render a conversation's messages (see ``api/admin.py``), so a report has to
    carry its own copy of what was flagged:

    - Message deletion is *soft* — the sender can blank the text a second after
      being reported, which would leave the maintainer an empty report about
      nothing. The snapshot is the evidence, and it's what makes acting on a
      report possible at all.
    - It's written **server-side from the message row**, never from the request
      body: a reporter must not be able to put words in someone else's mouth in
      the moderation queue.
    - It is content the reporter *deliberately showed the maintainer*, which is
      the whole point — access to message text is now scoped to "what was
      reported", not "whatever the maintainer feels like reading".
    """

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        RESOLVED = "resolved", "Resolved"
        DISMISSED = "dismissed", "Dismissed"

    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="reports_made",
    )
    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="reports",
    )
    comment = models.ForeignKey(
        Comment,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="reports",
    )
    message = models.ForeignKey(
        "Message",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="reports",
    )
    # The flagged message's text as it read when reported — see the class
    # docstring. Empty for a post/comment report (those are readable in their
    # own admin, so there's nothing to snapshot).
    message_text = models.TextField(blank=True, default="")
    reason = models.TextField(blank=True, max_length=REPORT_REASON_MAX_LENGTH)
    status = models.CharField(
        max_length=9,
        choices=Status.choices,
        default=Status.OPEN,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            # Exactly one target: a report is about a post, a comment or a
            # message — never two, never none. Written as three explicit
            # alternatives rather than counting NULLs so it reads the same on
            # Postgres and SQLite.
            models.CheckConstraint(
                condition=(
                    models.Q(
                        post__isnull=False,
                        comment__isnull=True,
                        message__isnull=True,
                    )
                    | models.Q(
                        post__isnull=True,
                        comment__isnull=False,
                        message__isnull=True,
                    )
                    | models.Q(
                        post__isnull=True,
                        comment__isnull=True,
                        message__isnull=False,
                    )
                ),
                name="report_targets_exactly_one",
            ),
            # One open flag per (reporter, target): don't let a double-click or a
            # repeat click stack duplicate rows in the moderation queue. The
            # target column that isn't in use is NULL, and both Postgres and
            # SQLite treat NULLs as distinct, so a comment-report (post NULL)
            # never collides on the post constraint, and vice-versa. The view
            # also pre-checks and returns the existing report, so this is the
            # race-proof backstop, not the first line of defence.
            models.UniqueConstraint(
                fields=["reporter", "post"],
                name="one_report_per_reporter_post",
            ),
            models.UniqueConstraint(
                fields=["reporter", "comment"],
                name="one_report_per_reporter_comment",
            ),
            models.UniqueConstraint(
                fields=["reporter", "message"],
                name="one_report_per_reporter_message",
            ),
        ]

    def target_label(self):
        """Human-readable target, e.g. ``"message #12"`` — shared by ``__str__``
        and the admin column so the two can't word it differently."""
        if self.post_id:
            return f"post #{self.post_id}"
        if self.comment_id:
            return f"comment #{self.comment_id}"
        return f"message #{self.message_id}"

    def __str__(self):
        return f"report #{self.pk} on {self.target_label()} ({self.status})"


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


class Reaction(models.Model):
    """An emoji reaction by a user on a single post, comment **or message**.

    The target is exactly one of a ``Post``, a ``Comment`` or a ``Message`` —
    never two, never none. Rather than a ``GenericForeignKey`` (contenttypes
    machinery we don't need when the targets are concrete, few, and already
    exist), it's three nullable FKs guarded by a check constraint. A comment
    reaction covers replies too, since ``Comment`` already backs both.

    ``message`` was added in Phase 9b M2. Widening this model rather than
    building a parallel ``MessageReaction`` keeps one toggle path, one emoji
    validator and one aggregation function — three copies of "one row per
    (user, target, emoji)" would have drifted, and the constraint work is the
    same either way.

    ``emoji`` is a normalised/validated Unicode emoji string (see
    ``api.emoji.normalise_emoji``) — the picker sends real emoji, but the API
    validates server-side and never trusts the client.

    Visibility is **not** stored here, and it differs by target:

    - A post/comment reaction is **pruned per viewer** when served (you only see
      reactions from yourself + people you may see), so a not-connected reactor
      is never surfaced.
    - A *message* reaction needs no pruning: a conversation's active
      participants are a clique by construction, so anyone who can see the
      message can already see everyone who could have reacted to it. The clip is
      on the message itself, not on the reactors.

    See the reactions views/serializers, and ``docs/reference/reactions.md``.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="reactions",
    )
    post = models.ForeignKey(
        Post,
        on_delete=models.CASCADE,
        related_name="reactions",
        null=True,
        blank=True,
    )
    comment = models.ForeignKey(
        Comment,
        on_delete=models.CASCADE,
        related_name="reactions",
        null=True,
        blank=True,
    )
    message = models.ForeignKey(
        Message,
        on_delete=models.CASCADE,
        related_name="reactions",
        null=True,
        blank=True,
    )
    # The fourth target: a group event. Same widening as ``message`` before it,
    # for the same reason — one toggle path, one validator, one aggregation.
    event = models.ForeignKey(
        "Event",
        on_delete=models.CASCADE,
        related_name="reactions",
        null=True,
        blank=True,
    )
    emoji = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # A reaction targets exactly one thing — post, comment, message or
            # event. Spelled as "one is set and the other three aren't" four
            # times over rather than something clever: it's the shape Postgres
            # can check per-row, and the previous version of this comment said
            # it was obvious what a fourth target would need, which turned out
            # to be true when the event became one.
            models.CheckConstraint(
                name="reaction_targets_exactly_one",
                condition=(
                    models.Q(
                        post__isnull=False, comment__isnull=True,
                        message__isnull=True, event__isnull=True,
                    )
                    | models.Q(
                        post__isnull=True, comment__isnull=False,
                        message__isnull=True, event__isnull=True,
                    )
                    | models.Q(
                        post__isnull=True, comment__isnull=True,
                        message__isnull=False, event__isnull=True,
                    )
                    | models.Q(
                        post__isnull=True, comment__isnull=True,
                        message__isnull=True, event__isnull=False,
                    )
                ),
            ),
            # One of each emoji per user per target, so re-adding toggles off.
            # Conditional on the FK being set: a plain unique tuple treats the
            # NULL side as always-distinct, which would let duplicates through.
            models.UniqueConstraint(
                fields=["user", "post", "emoji"],
                condition=models.Q(post__isnull=False),
                name="unique_user_post_emoji",
            ),
            models.UniqueConstraint(
                fields=["user", "comment", "emoji"],
                condition=models.Q(comment__isnull=False),
                name="unique_user_comment_emoji",
            ),
            models.UniqueConstraint(
                fields=["user", "message", "emoji"],
                condition=models.Q(message__isnull=False),
                name="unique_user_message_emoji",
            ),
            models.UniqueConstraint(
                fields=["user", "event", "emoji"],
                condition=models.Q(event__isnull=False),
                name="unique_user_event_emoji",
            ),
        ]

    def __str__(self):
        if self.post_id:
            target = f"post {self.post_id}"
        elif self.comment_id:
            target = f"comment {self.comment_id}"
        elif self.message_id:
            target = f"message {self.message_id}"
        else:
            target = f"event {self.event_id}"
        return f"{self.user} · {self.emoji} · {target}"


class Notification(models.Model):
    """One thing that happened *to* a user, for the in-site activity centre (8).

    A notification is generated where the action happens (a reply, a reaction, a
    connection request/accept, a group invite) and points the recipient at what
    to look at. Like ``Reaction``, the **target** is one of a few concrete FKs
    (post / comment / group / connection) rather than a ``GenericForeignKey`` —
    the target set is small and known, so concrete FKs are indexable, cascade
    cleanly, and need no contenttypes machinery. ``kind`` says which FK to read
    and how to phrase/deep-link the notification.

    **Three states, two nullable timestamps** (the product ask — a notification
    is *kept*, not dropped the moment it's glanced at):

    - ``seen_at is null``  → **unread**: bold, and it counts toward the nav badge.
    - ``seen_at`` set, ``addressed_at`` null → **seen**: the badge has been
      cleared (the centre was opened) but the item still stands out until dealt
      with.
    - ``addressed_at`` set → **addressed**: acted on (clicked through, or the
      underlying request/invite was resolved elsewhere) — dulled but retained in
      history.

    The badge count is the number of **unread** rows. Notifications are never
    auto-deleted; the read endpoint just skips any whose target no longer
    resolves (a reply whose comment was deleted, say) so we never render a dead
    deep-link.
    """

    class Kind(models.TextChoices):
        POST_REPLY = "post_reply", "Reply to your post"
        COMMENT_REPLY = "comment_reply", "Reply to your comment"
        REACTION = "reaction", "Reaction to your content"
        CONNECTION_REQUEST = "connection_request", "Connection request"
        CONNECTION_ACCEPTED = "connection_accepted", "Connection accepted"
        GROUP_INVITE = "group_invite", "Group invitation"
        # Group events (Phase 8b) — the organiser's five broadcasts. The actor is
        # always the event's organiser, so these ride the same connection gate as
        # the content kinds: a member not connected to the organiser gets no row
        # (see notifications.py). Like the two event kinds added below them (a
        # comment on an event, and photos added to one, both of which have a
        # different actor), they target the ``event`` FK and deep-link to
        # /g/<gid>/events/<eid>.
        EVENT_CREATED = "event_created", "New group event"
        POLL_OPENED = "poll_opened", "Poll opened on an event"
        EVENT_SCHEDULED = "event_scheduled", "Event date set"
        EVENT_UPDATED = "event_updated", "Event changed"
        EVENT_CANCELLED = "event_cancelled", "Event cancelled"
        # A top-level comment on an event, notifying its organiser — the event
        # twin of ``POST_REPLY``. A *reply* to an event comment reuses
        # ``COMMENT_REPLY``, because the recipient and the target are the same
        # question there whatever the comment hangs off; only "someone commented
        # on the thing you made" needs to know it was an event, since it targets
        # the ``event`` FK and deep-links to the event page.
        EVENT_COMMENT = "event_comment", "Comment on your event"
        # Photos added to an event's album. Unlike the five broadcast kinds
        # above, the actor is the **uploader**, not the organiser — the same
        # shape as ``EVENT_COMMENT`` — and unlike that one it goes out to the
        # people who RSVP'd going/maybe rather than to the organiser: "photos
        # are up" is worth most to whoever was there. The uploader-as-actor is
        # why the kind must sit in ``_CONNECTION_GATED_KINDS`` (notifications.py)
        # rather than riding the organiser gate the five broadcasts get free.
        EVENT_PHOTOS = "event_photos", "Photos added to an event"
        # Phase 9b M8. **No Notification row is ever created with this kind**,
        # and that isn't an omission. Messaging is deliberately outside the
        # activity centre — it has its own unread badge — so a mention has no
        # bell row to sit in. The kind exists because the *preference* needs a
        # home, and a genuine notification kind belongs in ``NotificationPreference``
        # with the others rather than as a one-off boolean: it inherits the
        # absence-means-enabled rule, the API's ``{kind: bool}`` map, and both
        # clients' settings screens for free. It governs exactly one thing —
        # whether an @mention overrides a *muted* chat (see
        # ``notifications.enqueue_message_pushes``), never whether mentions
        # notify at all. Contrast ``User.send_read_receipts`` (Phase 9b M4),
        # which lives on the user model precisely because there is no
        # notification kind behind it; the two placements are the same rule
        # applied honestly, not an inconsistency.
        MENTION = "mention", "You were mentioned in a chat"

    # Kinds a user is allowed to mute in preferences. The request/invite kinds
    # are deliberately *always-on*: muting "someone wants to connect" or "you've
    # been invited" would hide something you genuinely need to act on, and with
    # the badges now unified into the activity centre it'd be the only signal.
    # The event kinds *are* mutable (a busy group's event chatter is exactly what
    # a user might mute) and default-on, exactly like the content kinds.
    MUTABLE_KINDS = frozenset(
        {
            Kind.POST_REPLY,
            Kind.COMMENT_REPLY,
            Kind.REACTION,
            Kind.EVENT_CREATED,
            Kind.POLL_OPENED,
            Kind.EVENT_SCHEDULED,
            Kind.EVENT_UPDATED,
            Kind.EVENT_CANCELLED,
            Kind.EVENT_COMMENT,
            Kind.EVENT_PHOTOS,
            # Mutable, and default-on like the rest: naming someone is how you
            # get their attention, so it should reach them by default — but
            # punching through a quiet they deliberately asked for has to be
            # something they can decline. See the kind's note above.
            Kind.MENTION,
        }
    )

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notifications",
        db_index=True,
    )
    # Who did the thing. SET_NULL (not CASCADE) so that if the actor deletes
    # their account we keep the recipient's history rather than silently
    # vanishing rows out from under them; the row just reads as generic/system.
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="notifications_sent",
        null=True,
        blank=True,
    )
    kind = models.CharField(max_length=32, choices=Kind.choices)

    # Concrete-FK target — at most one is set (a future system notice could set
    # none). ``kind`` tells the serializer which to read. All CASCADE: if the
    # target is deleted the notification goes with it (nothing to point at).
    post = models.ForeignKey(
        Post, on_delete=models.CASCADE, related_name="notifications",
        null=True, blank=True,
    )
    comment = models.ForeignKey(
        Comment, on_delete=models.CASCADE, related_name="notifications",
        null=True, blank=True,
    )
    group = models.ForeignKey(
        "Group", on_delete=models.CASCADE, related_name="notifications",
        null=True, blank=True,
    )
    connection = models.ForeignKey(
        Connection, on_delete=models.CASCADE, related_name="notifications",
        null=True, blank=True,
    )
    # Group-event target (Phase 8b) — the fifth concrete FK. CASCADE like the
    # others: if the event is deleted the notification has nothing to point at
    # and goes with it. The activity centre was built to grow this way (the
    # constraint already allowed a zero-target row), so this adds a column and a
    # constraint branch, not new machinery.
    event = models.ForeignKey(
        "Event", on_delete=models.CASCADE, related_name="notifications",
        null=True, blank=True,
    )

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    seen_at = models.DateTimeField(null=True, blank=True)
    addressed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            # At most one concrete target set (zero allowed — a future
            # system/system-wide notice may point at nothing). Now five targets.
            models.CheckConstraint(
                name="notification_at_most_one_target",
                condition=(
                    models.Q(post__isnull=True, comment__isnull=True,
                             group__isnull=True, connection__isnull=True,
                             event__isnull=True)
                    | models.Q(post__isnull=False, comment__isnull=True,
                               group__isnull=True, connection__isnull=True,
                               event__isnull=True)
                    | models.Q(post__isnull=True, comment__isnull=False,
                               group__isnull=True, connection__isnull=True,
                               event__isnull=True)
                    | models.Q(post__isnull=True, comment__isnull=True,
                               group__isnull=False, connection__isnull=True,
                               event__isnull=True)
                    | models.Q(post__isnull=True, comment__isnull=True,
                               group__isnull=True, connection__isnull=False,
                               event__isnull=True)
                    | models.Q(post__isnull=True, comment__isnull=True,
                               group__isnull=True, connection__isnull=True,
                               event__isnull=False)
                ),
            ),
        ]
        indexes = [
            # The newest-first list for one recipient.
            models.Index(fields=["recipient", "-created_at"]),
            # The unread-count badge query (recipient + seen_at IS NULL).
            models.Index(fields=["recipient", "seen_at"]),
        ]

    def __str__(self):
        return f"{self.kind} → {self.recipient} (from {self.actor})"


class NotificationPreference(models.Model):
    """A user's on/off choice for one notification ``kind`` (Phase 8).

    One row per ``(user, kind)``, with ``enabled``. Modelled as rows (not a JSON
    blob on the user) so it's queryable and DB-unique, and adding a future kind
    is a data concern, not a migration of everyone's blob.

    **Absence means enabled** (opt-out): a user with no row for a kind is
    notified — new kinds notify by default and users mute what they don't want.
    Only ``Notification.MUTABLE_KINDS`` are ever written here; the always-on
    request/invite kinds are never suppressed.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_preferences",
    )
    kind = models.CharField(max_length=32, choices=Notification.Kind.choices)
    enabled = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "kind"], name="unique_user_notification_kind"
            ),
        ]

    def __str__(self):
        state = "on" if self.enabled else "off"
        return f"{self.user} · {self.kind} · {state}"


class Event(models.Model):
    """A plannable group event — a birthday, a book-club night, a trip (8b).

    An event is a *bundle of decisions* (title, date, time, location, plus any
    custom questions). Each decision is a **dimension** that can be unset, being
    polled, or set — the organiser drives them in any order (poll the date, settle
    it, then poll the time, or just set a value outright). This is why the
    when-fields are all nullable: an event can exist as "title + a date poll" long
    before it has a fixed slot.

    **Visibility** is the app's single connection gate, applied to the
    ``organiser`` exactly as a post's gate keys on its author: you see an event
    iff you're an active member of its group **and** connected to its organiser
    (see ``visible_events`` in the views). An event you're not connected to the
    organiser of does not exist for you — a 404, like their posts never reaching
    your feed. That's why ``organiser`` is **CASCADE**, not SET_NULL like
    ``Group.creator``: the gate needs a *living, present* organiser, so if they
    delete their account (or leave the group) the event is removed unless a group
    admin **adopts** it first (re-anchoring the gate on themselves).

    **Lifecycle** — ``status`` is derived from the dimensions on write:

    - ``planning`` — created; the must-have dimensions (at minimum a **date**)
      aren't all set. It lives in a "being planned" staging area, off the
      timeline (no slot in time yet).
    - ``scheduled`` — a **date** is set (time optional). Now it has a slot on the
      spine and the month grid. Date-only renders all-day; date + time renders
      timed.
    - ``cancelled`` — called off; kept as a tombstone so RSVP'd members are
      notified and the history stays honest (never silently deleted).

    ``past`` is **derived, not stored** (``starts_at < now``): a past event drops
    out of "upcoming" surfaces and falls into the group timeline among the posts
    as a memory. One row, shown two ways — never a separate model.
    """

    class Status(models.TextChoices):
        PLANNING = "planning", "Planning"
        SCHEDULED = "scheduled", "Scheduled"
        CANCELLED = "cancelled", "Cancelled"

    group = models.ForeignKey(
        Group,
        on_delete=models.CASCADE,
        related_name="events",
        db_index=True,
    )
    organiser = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="events_organised",
    )
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    # The calendar key. NULL until a date is set/finalised — an event in
    # ``planning`` has no position in time. Indexed for the per-group window query.
    event_date = models.DateField(null=True, blank=True, db_index=True)
    start_time = models.TimeField(null=True, blank=True)
    end_time = models.TimeField(null=True, blank=True)
    # One IANA timezone per event (e.g. "Europe/London"). DST / cross-tz nuance
    # is a documented simplification — fine at family scale. Defaults from
    # settings.TIME_ZONE at create time.
    timezone = models.CharField(max_length=64, blank=True)
    location_name = models.CharField(max_length=200, blank=True)
    # An organiser-pasted link (a maps URL, a venue page). Rendered as a plain
    # anchor — **no geocoding, no embedded map tiles** (those would leak every
    # viewer's IP to a third party, breaking the no-trackers principle).
    location_url = models.URLField(blank=True)
    location_note = models.CharField(max_length=200, blank=True)
    status = models.CharField(
        max_length=9,
        choices=Status.choices,
        default=Status.PLANNING,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # Upcoming-first isn't meaningful across planning (date-less) events, so
        # order by the date. Rows without a date sort last; ``-id`` is a stable
        # tiebreaker. Views apply their own window ordering on top of this.
        ordering = ["event_date", "id"]
        indexes = [
            # The per-group calendar window query filters (group, event_date).
            models.Index(fields=["group", "event_date"]),
        ]

    @property
    def starts_at(self):
        """A tz-aware datetime for ordering / the personal-calendar union, or
        ``None`` while no date is set. A date-only event starts at midnight in
        its own timezone (it's all-day); date + time uses the time."""
        if self.event_date is None:
            return None
        from datetime import datetime, time
        from zoneinfo import ZoneInfo

        from django.conf import settings as dj_settings

        tzname = self.timezone or dj_settings.TIME_ZONE
        try:
            tz = ZoneInfo(tzname)
        except Exception:
            tz = ZoneInfo(dj_settings.TIME_ZONE)
        return datetime.combine(
            self.event_date, self.start_time or time.min, tzinfo=tz
        )

    @property
    def is_past(self):
        """Derived, never stored. A cancelled event is never "past" — it's a
        tombstone that stays visible as cancelled, not a memory.

        A **timed** event is past once its start time has gone by. A **date-only
        (all-day)** event is past only once its whole day has ended in its own
        timezone — an all-day event happening *today* is still current, not a
        memory (using midnight as the cutoff would wrongly age it out the instant
        the day began)."""
        from django.utils import timezone as dj_tz

        if self.status == self.Status.CANCELLED or self.event_date is None:
            return False
        if self.start_time is None:
            from zoneinfo import ZoneInfo

            from django.conf import settings as dj_settings

            tzname = self.timezone or dj_settings.TIME_ZONE
            try:
                tz = ZoneInfo(tzname)
            except Exception:
                tz = ZoneInfo(dj_settings.TIME_ZONE)
            return self.event_date < dj_tz.now().astimezone(tz).date()
        return self.starts_at < dj_tz.now()

    def __str__(self):
        return f"{self.title} · {self.group} ({self.status})"


class Poll(models.Model):
    """An advisory poll on one dimension of an ``Event`` (8b).

    A poll **never auto-decides** — closing it and finalising the dimension are
    two distinct organiser actions, and finalising accepts *any* value, not just a
    winning option (see ``Event.finalise`` in the views). The tally *informs*; the
    organiser *decides*. Built-in dimensions (``date``/``time``/``location``) feed
    the event's structured fields on finalise; ``custom`` polls are informational
    ("What should we bring?") and pin a winning option as a recorded decision
    without writing a structured field.

    **At most one open poll per built-in dimension per event** (you can't have two
    open date polls) — enforced in the view, not the DB, since it's conditional on
    ``status='open'``. ``custom`` polls have no such cap.
    """

    class Dimension(models.TextChoices):
        DATE = "date", "Date"
        TIME = "time", "Time"
        LOCATION = "location", "Location"
        CUSTOM = "custom", "Custom"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        CLOSED = "closed", "Closed"

    event = models.ForeignKey(
        Event, on_delete=models.CASCADE, related_name="polls"
    )
    dimension = models.CharField(max_length=8, choices=Dimension.choices)
    question = models.CharField(max_length=200)
    # Default True for date/time ("pick every option you can do" — the when2meet
    # behaviour), False for a single-choice location/custom. Set by the view from
    # the dimension when the organiser doesn't specify.
    allow_multiple = models.BooleanField(default=False)
    status = models.CharField(
        max_length=6, choices=Status.choices, default=Status.OPEN, db_index=True
    )
    # A *soft* deadline: the view stops accepting new votes past it and nudges the
    # organiser, but it does **not** auto-finalise (polls are advisory).
    closes_at = models.DateTimeField(null=True, blank=True)
    # For a **custom** poll, the option the organiser pinned as the recorded
    # decision on finalise ("we'll bring the cake"). Built-in polls write their
    # outcome onto the event's structured fields instead, so this stays null for
    # them. SET_NULL so deleting the option doesn't erase the whole poll.
    decided_option = models.ForeignKey(
        "PollOption",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="polls_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self):
        return f"{self.get_dimension_display()} poll · {self.event} ({self.status})"


class PollOption(models.Model):
    """One candidate option in a ``Poll`` (8b).

    Organiser-authored in v1 (member-suggested options are a future extension).
    One typed column carries the value per dimension — ``date_value`` for a date
    poll, ``time_value`` for time, ``text_value`` for location/custom — so
    finalising a built-in poll can copy a structured value straight onto the
    event. ``label`` is the display text shown in the tally.
    """

    poll = models.ForeignKey(
        Poll, on_delete=models.CASCADE, related_name="options"
    )
    label = models.CharField(max_length=200)
    date_value = models.DateField(null=True, blank=True)
    time_value = models.TimeField(null=True, blank=True)
    text_value = models.CharField(max_length=200, blank=True)
    order = models.SmallIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return f"{self.label} · {self.poll_id}"


class PollVote(models.Model):
    """One person's vote for one ``PollOption`` (8b).

    A ``UniqueConstraint(option, voter)`` stops a double-vote for the same option.
    Multi-choice polls let a voter hold several rows across a poll's options;
    single-choice polls additionally enforce one row per ``(poll, voter)`` in the
    view (a new vote replaces the old). Votes are pruned per-viewer when tallied:
    the **count** includes everyone in the event's audience (a shared coordination
    number must be honest), but the **names** shown are gated to your connections
    — see the poll serializer. Both FKs CASCADE.
    """

    option = models.ForeignKey(
        PollOption, on_delete=models.CASCADE, related_name="votes"
    )
    voter = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="poll_votes",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["option", "voter"], name="unique_poll_vote"
            ),
        ]

    def __str__(self):
        return f"{self.voter} → {self.option_id}"


class EventRSVP(models.Model):
    """One person's RSVP to an ``Event`` (8b).

    ``UniqueConstraint(event, user)`` — one RSVP per person, upserted (a new
    response replaces the old). Like poll votes, RSVP tallies are honest across
    the whole audience (the ``going`` count includes people you can't see) while
    the **named** lists are connection-gated — see the RSVP serializer.
    ``guests`` is an optional "+N" headcount; ``note`` an optional short message.
    """

    class Response(models.TextChoices):
        GOING = "going", "Going"
        MAYBE = "maybe", "Maybe"
        DECLINED = "declined", "Declined"

    event = models.ForeignKey(
        Event, on_delete=models.CASCADE, related_name="rsvps"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="event_rsvps",
    )
    response = models.CharField(max_length=8, choices=Response.choices)
    guests = models.SmallIntegerField(default=0)
    note = models.CharField(max_length=200, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["event", "user"], name="unique_event_rsvp"
            ),
        ]

    def __str__(self):
        return f"{self.user} · {self.event} ({self.response})"


class EventPhoto(models.Model):
    """One photo in an ``Event``'s album — added by any member who can see the
    event, before, during or after it.

    Shaped like ``PostImage`` (same two files, same width/height, written by the
    same ``api.imaging.process_image``, so EXIF/GPS stripping and the HEIC
    transcode are inherited rather than re-implemented) with one field a post's
    images don't need: **``uploader``**.

    That field is the whole difference between the two models. A post's photos
    have no author of their own — they inherit the post's, and the post's gate
    covers them. An event's album has *many* authors under one event, and the
    app's one connection gate has to key on each photo's own uploader: you see
    a photo iff you can see the event **and** you're connected to whoever added
    it (or it's yours). So the album prunes per viewer exactly as the event's
    comments and reactions do — see the "photos are authored content" decision
    in ``docs/reference/events.md`` for why it follows those rather than the
    complete-count rule the poll and RSVP tallies beside them use.

    ``uploader`` is CASCADE for the same reason ``Comment.author`` is: a photo
    with no author has nothing for the gate to read, so it goes with the
    account. Deleting the event takes its photos too — and in both cases a
    database cascade doesn't touch storage, so the *files* are swept by the
    ``post_delete`` receiver in ``api/media_cleanup.py``. Don't hand-gather them
    at a new delete path; the receiver already has it, cascades included.
    """

    event = models.ForeignKey(
        Event,
        on_delete=models.CASCADE,
        related_name="photos",
    )
    uploader = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="event_photos",
    )
    image = models.ImageField(upload_to=event_photo_upload_to)
    thumbnail = models.ImageField(upload_to=event_photo_thumb_upload_to)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # Upload order, oldest first — an album reads as the event unfolded,
        # unlike the feed's newest-first. ``id`` breaks ties for photos created
        # in the same tick, which keeps a batch upload's order stable and (more
        # importantly) makes the windowed preview query deterministic.
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["event", "created_at"])]

    def __str__(self):
        return f"Photo {self.pk} on {self.event}"


class DevicePushToken(models.Model):
    """One device that can receive push notifications for a user (Phase 9).

    Registered when the app logs in (and refreshed on later launches, since Expo
    can rotate a token), deleted on logout. **One user can have several rows** —
    a phone and a tablet are separate devices and both should buzz.

    ``expo_token`` is an Expo push token, not a raw APNs/FCM one: the backend
    sends to Expo's push service and Expo fans out to Apple or Google. That's why
    a single model covers both platforms and why Phase 10 (Android) needs no
    schema change — only a different value in ``platform``.

    The token is **globally unique**, not unique per user: a physical device maps
    to one Expo token, so if someone logs out and a housemate logs in on the same
    phone, the row must move to the new user rather than leaving the previous
    owner's notifications going to a device they no longer control. Registration
    therefore upserts on ``expo_token`` and overwrites ``user``.

    Sending logic lives in the push outbox, not here. See
    docs/reference/notifications.md for the delivery pipeline and
    docs/reference/mobile-app.md for the app that registers the token.
    """

    class Platform(models.TextChoices):
        IOS = "ios", "iOS"
        ANDROID = "android", "Android"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="push_tokens",
    )
    expo_token = models.CharField(max_length=255, unique=True)
    platform = models.CharField(max_length=16, choices=Platform.choices)
    created_at = models.DateTimeField(auto_now_add=True)
    # Bumped every time the app re-registers, so a device that hasn't been seen
    # for a long time can be pruned later rather than us pushing into the void
    # forever. Expo also reports permanently-dead tokens on send (Milestone D).
    last_seen = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            # The send path (Milestone D) always asks "which devices does this
            # user have?", so index that lookup.
            models.Index(fields=["user"]),
        ]

    def __str__(self):
        return f"{self.user} · {self.platform} · {self.expo_token[:16]}…"


class PushOutbox(models.Model):
    """One push queued for delivery to a user's devices (Phase 9, Milestone D).

    **Why an outbox rather than sending inline.** ``create_notification`` runs
    inside ordinary web requests (someone posts a reply, someone reacts). Calling
    Expo's HTTP API there would put a third-party network round-trip — and its
    timeouts — on the critical path of a request that has nothing to do with
    push. So the request only writes a row; ``manage.py send_pushes`` drains the
    queue on a systemd timer (see ``deploy/send-pushes.timer``). A push failure
    can never fail a user's action, and a send that dies halfway is retried
    rather than lost, which a fire-and-forget thread could not promise.

    **No device tokens are stored here.** The recipient's ``DevicePushToken``
    rows are looked up at *send* time, not enqueue time, so a device that
    registers (or re-registers with a rotated token) in between still gets the
    push, and a device that logged out in between correctly doesn't.

    **Two kinds of push, one queue.** Exactly one of ``notification`` and
    ``message`` is set (enforced by a check constraint):

    - ``notification`` — an activity-centre event (a reply, a reaction, an
      invite). Its wording and deep-link come from ``NotificationSerializer``,
      so the phone and the bell always say the same thing.
    - ``message`` — a **direct/group message** (issue #118). Messaging is
      deliberately *not* part of the activity centre — it has its own unread
      badge (see docs/reference/messaging.md) — so a message must be able to
      buzz a phone **without** creating a ``Notification`` row that would
      double-surface every message in the bell. Rather than let this model carry
      a free-text payload, it points at the ``Message`` itself and the send
      command phrases the line; that keeps the cascade guarantee below intact and
      leaves no way to smuggle message text into a stored push body.

    **Deletion is the safety net.** Both FKs cascade, and ``Notification``
    itself cascades from its target — so deleting a post takes its notifications
    and their queued pushes with it, and deleting a conversation takes its
    messages and theirs. A push for since-deleted content cannot fire, which is
    the same guarantee the deep-link map relies on.

    **Muting happens before here, on both paths.** ``create_notification``
    returns ``None`` for a muted kind before any row exists, so the per-type
    ``NotificationPreference`` gate covers push automatically; the message path
    checks ``Participant.muted_at`` at enqueue for the same reason. There is
    deliberately no second mute check at send time to keep in sync.

    Rows are kept after sending (``sent_at`` set) as a short delivery log; the
    send command prunes ones older than a fortnight.
    """

    notification = models.OneToOneField(
        "Notification",
        on_delete=models.CASCADE,
        related_name="push",
        null=True,
        blank=True,
    )
    # The message this push announces — the non-notification target above. Not
    # a OneToOne: one message fans out to every participant, so it's one row per
    # (message, recipient), which the unique constraint below pins down.
    message = models.ForeignKey(
        "Message",
        on_delete=models.CASCADE,
        related_name="pushes",
        null=True,
        blank=True,
    )
    # Who this push is for.
    #
    # Denormalised from ``notification.recipient`` on that path (and backfilled
    # for pre-existing rows in migration 0021) rather than resolved through the
    # FK, so the drain reads one field whichever target is set instead of
    # branching. Safe to denormalise because a notification's recipient is fixed
    # at creation and never reassigned — there is nothing for the copy to drift
    # from.
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="queued_pushes",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # Null until delivered to *every* device. The command selects on
    # `sent_at is null`, so this is the queue marker as well as the log.
    sent_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    # Last failure, kept for diagnosis from the admin/shell. Truncated on write.
    last_error = models.TextField(blank=True)
    # Expo tokens this notification has already reached.
    #
    # Needed because one notification fans out to N devices but `sent_at` is a
    # single flag. Without this, a phone that succeeded and a tablet that hit a
    # transient error share one row: marking it sent loses the retry, and
    # leaving it queued re-buzzes the phone that already got it. Recording the
    # delivered tokens lets a retry target only the devices still outstanding.
    delivered_tokens = models.JSONField(default=list, blank=True)

    # Give up after this many failed drains, so one permanently-poisoned row
    # can't be retried forever on every timer tick.
    MAX_ATTEMPTS = 5

    class Meta:
        constraints = [
            # Exactly one target. A row with neither has nothing to say and
            # nothing to link to; a row with both would have two competing
            # wordings, and the drain would have to pick.
            models.CheckConstraint(
                name="push_outbox_exactly_one_target",
                condition=(
                    models.Q(notification__isnull=False, message__isnull=True)
                    | models.Q(notification__isnull=True, message__isnull=False)
                ),
            ),
            # One push per person per message. The coalescing at enqueue is the
            # real defence against a buzz storm; this is the backstop that makes
            # a double-enqueue (a retried request, a future second call site) an
            # error rather than a second buzz. NULLs compare as distinct in
            # Postgres, so notification rows are unaffected by it.
            models.UniqueConstraint(
                fields=["message", "recipient"],
                name="unique_message_push_per_recipient",
            ),
        ]
        indexes = [
            # The drain query: unsent rows, oldest first.
            models.Index(fields=["sent_at", "created_at"]),
            # Coalescing asks "has this person already got an unsent push for
            # this conversation?" on every message sent, so index the recipient.
            models.Index(fields=["recipient", "sent_at"]),
        ]

    def __str__(self):
        state = "sent" if self.sent_at else f"queued (attempts={self.attempts})"
        target = "message" if self.message_id else "notification"
        return f"push #{self.pk} · {target} · {state}"


class PushReceipt(models.Model):
    """An Expo ticket awaiting its delivery receipt (Phase 9, Milestone D).

    **Why this exists: a ticket is not a delivery.** When we POST to Expo we get
    back a *ticket* per message, synchronously. ``status: "ok"`` there means only
    that Expo accepted and validated the message — it says nothing about whether
    Apple or Google actually handed it to a handset. That answer arrives later,
    from a separate ``getReceipts`` call.

    Without checking receipts, the failure that matters is silent: a token that
    has gone dead *since* registration (app deleted, token retired by the OS)
    still yields an ``ok`` ticket, so the outbox row is recorded delivered, the
    push is never seen, and the ``DevicePushToken`` is never cleaned up. Dead
    tokens then accumulate forever, and every future notification wastes a
    message on each one. ``DeviceNotRegistered`` *is* handled at ticket time, but
    only for tokens already dead when we sent.

    **Why a separate table rather than a field on ``PushOutbox``:**

    - One outbox row fans out to N devices, so it holds N tickets — the natural
      grain here is the ticket, not the notification.
    - Outbox rows are pruned once delivered (``EXPO_PUSH_RETENTION_DAYS``), which
      would take still-unchecked tickets with them.
    - The two have unrelated lifecycles: receipts are checked after a short delay
      and expire within a day, while outbox rows live a fortnight as a log.

    **``expo_token`` is stored as a string, deliberately denormalised** rather
    than an FK to ``DevicePushToken``. The row's whole purpose is to identify a
    token that may need deleting, and an FK would cascade the receipt away with
    the device it was meant to condemn.
    """

    # Expo's ticket id, the handle used to ask for the receipt later.
    ticket_id = models.CharField(max_length=200, unique=True)
    # Which device this ticket was for — the token to delete if the receipt
    # comes back DeviceNotRegistered. See the class docstring for why it's a
    # plain string.
    expo_token = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            # The check query: oldest first, filtered on age.
            models.Index(fields=["created_at"]),
        ]

    def __str__(self):
        return f"receipt {self.ticket_id} · {self.expo_token[:20]}…"
