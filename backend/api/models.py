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
