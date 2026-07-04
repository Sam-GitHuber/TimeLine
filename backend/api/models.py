from django.conf import settings
from django.db import models


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
        # Default to newest-first everywhere this model is queried.
        ordering = ["-created_at"]

    def __str__(self):
        preview = self.text[:40] + ("…" if len(self.text) > 40 else "")
        return f"{self.author} · {preview}"


class Follow(models.Model):
    """A directed follow request: ``follower`` asks to follow ``followee``.

    Accounts are private-by-default: a follow starts **pending** and only lets
    the follower see the followee's posts once the followee **approves** it
    (``status`` becomes ``accepted``). Rejecting or unfollowing deletes the row.

    Two guardrails live in the database (not just the API) so bad data can't
    sneak in another way:
    - you can't follow the same person twice (``UniqueConstraint``),
    - you can't follow yourself (``CheckConstraint``).
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"

    follower = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="following",
    )
    followee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="followers",
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
            models.UniqueConstraint(
                fields=["follower", "followee"],
                name="unique_follow",
            ),
            models.CheckConstraint(
                condition=~models.Q(follower=models.F("followee")),
                name="no_self_follow",
            ),
        ]

    def __str__(self):
        return f"{self.follower} → {self.followee} ({self.status})"
