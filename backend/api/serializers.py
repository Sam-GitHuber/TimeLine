from django.contrib.auth import get_user_model
from rest_framework import serializers

from .imaging import absolute_media_url
from .models import (
    REPORT_REASON_MAX_LENGTH,
    Comment,
    Connection,
    Conversation,
    DevicePushToken,
    Event,
    EventRSVP,
    Group,
    GroupMembership,
    Message,
    Notification,
    Poll,
    Post,
    PostImage,
    Report,
)

User = get_user_model()

# A generous cap so a post can't be used to dump unbounded text into the DB,
# while being far more than any real status update needs. Comments share it.
POST_MAX_LENGTH = 5000


def summarise_reactions(reactions, visible_ids, me_id):
    """Aggregate a target's reactions into ``[{emoji, count, reacted}]``, pruned
    to who the viewer may see (Phase 7b).

    ``reactions`` is the target's (prefetched) ``Reaction`` rows. ``visible_ids``
    is the set of user ids the viewer is allowed to see — themselves plus their
    connections — mirroring the comment tree's pruning, so a reaction by someone
    the viewer isn't connected with is never counted and can't leak a stranger.
    Fail-closed: if ``visible_ids`` is ``None`` (context wasn't supplied) nothing
    is shown rather than an unpruned count. ``reacted`` flags the emoji the
    viewer themselves used, so the UI can highlight their own reaction.

    Ordered by count (desc), then by the emoji string, so the display order is
    stable and deterministic (tests, and no jitter between polls).
    """
    if visible_ids is None:
        return []
    counts = {}
    reacted = set()
    for r in reactions:
        if r.user_id not in visible_ids:
            continue
        counts[r.emoji] = counts.get(r.emoji, 0) + 1
        if r.user_id == me_id:
            reacted.add(r.emoji)
    items = [
        {"emoji": emoji, "count": count, "reacted": emoji in reacted}
        for emoji, count in counts.items()
    ]
    items.sort(key=lambda item: (-item["count"], item["emoji"]))
    return items


def reactions_representation(obj, context):
    """The pruned reaction summary for a post or comment, from serializer context.

    Reads the target's prefetched ``reactions`` and the viewer's
    ``visible_reactor_ids`` (set by the view). Shared by ``PostSerializer`` and
    ``CommentSerializer`` so both prune identically.
    """
    request = context.get("request")
    me_id = request.user.id if request and request.user.is_authenticated else None
    return summarise_reactions(
        obj.reactions.all(), context.get("visible_reactor_ids"), me_id
    )


class AuthorSerializer(serializers.ModelSerializer):
    """The tiny slice of a user we embed in a post or expose in a list.

    Deliberately minimal: an id (for profile links), a display name, and the
    small avatar thumbnail the UI renders. No email — see ``User.display_name``
    for why we don't leak addresses.
    """

    display_name = serializers.CharField(read_only=True)
    avatar_thumb = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "display_name", "avatar_thumb")

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))


class PostImageSerializer(serializers.ModelSerializer):
    """One photo on a post: the (bounded) original plus its thumbnail, as
    absolute URLs, with the original's dimensions so the client can reserve
    layout space and avoid reflow while images load."""

    image = serializers.SerializerMethodField()
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = PostImage
        fields = ("id", "image", "thumbnail", "width", "height")

    def get_image(self, obj):
        return absolute_media_url(obj.image, self.context.get("request"))

    def get_thumbnail(self, obj):
        return absolute_media_url(obj.thumbnail, self.context.get("request"))


class PostSerializer(serializers.ModelSerializer):
    """Read + create a post.

    ``author`` is read-only and set from the logged-in user in the view — it is
    never taken from the request body, so a client can't post as someone else.
    ``images`` are read-only here; the files are uploaded as multipart and
    processed in ``PostCreateView`` (validated + metadata-stripped via
    ``api.imaging``). ``text`` is optional — a photo-only post is allowed — but
    the view still rejects a post with neither text nor a photo.
    """

    author = AuthorSerializer(read_only=True)
    text = serializers.CharField(
        max_length=POST_MAX_LENGTH, required=False, allow_blank=True, default=""
    )
    images = PostImageSerializer(many=True, read_only=True)
    # Which group this post belongs to — ``null`` for a personal-timeline post,
    # or ``{id, name}`` for a group post. The name lets the feed label a group
    # post ("in <group>") when the "include groups" view merges them in.
    # Read-only here — the view sets the group from the validated request and
    # checks membership, never trusting the body to place a post in a group.
    group = serializers.SerializerMethodField()
    # Pruned per viewer — see ``reactions_representation``. Read-only; reactions
    # are added/removed via the toggle endpoint, never in the post body.
    reactions = serializers.SerializerMethodField()
    # How many comments this viewer would see if they expanded the thread, and
    # how many of those are new since they last opened it (issue #63). Both are
    # computed once per page by the view (``comment_counts_for_posts``) and passed
    # in via ``context["comment_counts"]`` — so the feed carries them without a
    # per-post query. Absent from context (e.g. the create response) ⇒ 0, which
    # is correct for a brand-new post with no comments yet.
    comment_count = serializers.SerializerMethodField()
    new_comment_count = serializers.SerializerMethodField()

    class Meta:
        model = Post
        fields = (
            "id",
            "author",
            "text",
            "images",
            "group",
            "reactions",
            "comment_count",
            "new_comment_count",
            "created_at",
            "edited_at",
        )
        read_only_fields = (
            "id",
            "author",
            "images",
            "group",
            "reactions",
            "comment_count",
            "new_comment_count",
            "created_at",
            # Server-controlled — stamped by the update view on a real edit, never
            # written from the request body.
            "edited_at",
        )

    def get_group(self, obj):
        if obj.group_id is None:
            return None
        return {"id": obj.group_id, "name": obj.group.name}

    def get_reactions(self, obj):
        return reactions_representation(obj, self.context)

    def _counts(self, obj):
        return (self.context.get("comment_counts") or {}).get(obj.id) or {}

    def get_comment_count(self, obj):
        return self._counts(obj).get("total", 0)

    def get_new_comment_count(self, obj):
        return self._counts(obj).get("new", 0)

    def validate_text(self, value):
        # A photo-only post is fine, so blank text is allowed here; the view
        # enforces "must have text or at least one photo". Normalise whitespace.
        return value.strip()


class UserListSerializer(serializers.ModelSerializer):
    """A person in the "find people to connect with" list, or a profile header.

    ``connection_status`` describes the *requesting* user's relationship to this
    person, so the UI can render the right button: ``"none"`` (Connect),
    ``"requested"`` (you asked — awaiting them), ``"incoming"`` (they asked —
    awaiting you), or ``"connected"`` (mutual). It's annotated onto the queryset
    in the view (one query, no N+1).
    """

    display_name = serializers.CharField(read_only=True)
    connection_status = serializers.CharField(read_only=True)
    avatar_thumb = serializers.SerializerMethodField()
    bio = serializers.CharField(read_only=True)
    # Whether the requesting user has blocked this person. Annotated only on the
    # profile-detail queryset; defaults to False elsewhere (e.g. the people
    # list, which doesn't surface block state).
    is_blocked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "display_name",
            "connection_status",
            "avatar_thumb",
            "bio",
            "is_blocked",
        )

    def get_is_blocked(self, obj):
        return bool(getattr(obj, "is_blocked", False))

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))


class ConnectionRequestSerializer(serializers.ModelSerializer):
    """An incoming connection request shown in the requestee's "Requests" inbox.

    ``id`` is the Connection row's id — the handle used to approve/reject it.
    ``requester`` is the person asking to connect with you.
    """

    requester = AuthorSerializer(read_only=True)

    class Meta:
        model = Connection
        fields = ("id", "requester", "created_at")


class CommentSerializer(serializers.ModelSerializer):
    """A node in the visible comment tree, with its visible replies nested under
    it.

    ``replies`` is read from ``_visible_children`` — the list the view's tree
    builder attached after pruning — **not** from the raw ``replies`` relation,
    so hidden branches never appear. The serializer is recursive: each reply is
    rendered with this same serializer.
    """

    author = AuthorSerializer(read_only=True)
    replies = serializers.SerializerMethodField()
    reactions = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = (
            "id",
            "author",
            "parent",
            "text",
            "created_at",
            "replies",
            "reactions",
        )

    def get_replies(self, obj):
        children = getattr(obj, "_visible_children", [])
        return CommentSerializer(
            children, many=True, context=self.context
        ).data

    def get_reactions(self, obj):
        return reactions_representation(obj, self.context)


class CommentCreateSerializer(serializers.ModelSerializer):
    """Create a comment or a reply.

    ``author`` and ``post`` are set in the view (from the session and the URL),
    never the body. ``parent`` is optional — omit it for a top-level comment,
    or give the id of the comment being replied to (the view checks it belongs
    to the same post).
    """

    text = serializers.CharField(max_length=POST_MAX_LENGTH)

    class Meta:
        model = Comment
        fields = ("id", "parent", "text", "created_at")
        read_only_fields = ("id", "created_at")

    def validate_text(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A comment can't be empty.")
        return stripped


# Direct messages share the post/comment length cap — plenty for a chat message
# while still bounding what a single row can write to the database.
MESSAGE_MAX_LENGTH = POST_MAX_LENGTH


class MessageSerializer(serializers.ModelSerializer):
    """A single message in a conversation thread.

    ``sender`` is the embedded author slice (id + display name + avatar), so the
    thread can align/label each bubble. A soft-deleted message reports
    ``is_deleted: true`` with blank ``text`` — the client renders a "message
    deleted" placeholder in its place, keeping the thread's order intact.
    """

    sender = AuthorSerializer(read_only=True)
    is_deleted = serializers.BooleanField(read_only=True)

    class Meta:
        model = Message
        fields = ("id", "sender", "text", "is_deleted", "created_at")


class MessageCreateSerializer(serializers.ModelSerializer):
    """Create a message. ``sender`` and ``conversation`` are set in the view
    (from the session and the URL), never the body."""

    text = serializers.CharField(max_length=MESSAGE_MAX_LENGTH)

    class Meta:
        model = Message
        fields = ("id", "text", "created_at")
        read_only_fields = ("id", "created_at")

    def validate_text(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A message can't be empty.")
        return stripped


class ParticipantSerializer(serializers.Serializer):
    """One member of a group chat (or an implicit 1:1 side) for the
    ``participants`` list on a conversation — id, display name, avatar thumb,
    and their membership ``status`` (``"active"``/``"pending"``), enough to
    render the member list and explain a pending-lock panel."""

    id = serializers.IntegerField(source="user.id")
    display_name = serializers.CharField(source="user.display_name")
    avatar_thumb = serializers.ImageField(source="user.avatar_thumb", allow_null=True)
    status = serializers.CharField()


class ConversationSerializer(serializers.ModelSerializer):
    """A row in your conversation list, or the single-thread detail view.

    Covers both a 1:1 (``kind="direct"``) and a group chat (Phase 6a):
    ``other`` stays populated for a direct thread — the person you're talking
    to, resolved per-viewer in the view — for backward-compatible Phase 5
    rendering. ``title``/``group``/``participants`` describe a group chat (see
    ``chat_display_for``). ``my_status`` is your own membership state
    (``"active"``/``"pending"`` — a pending member sees a locked, read-only
    view driven by ``must_connect_with``). ``last_message``/``unread_count``
    are attached per-viewer by ``decorate_conversations`` (no N+1 across the
    list). ``can_send`` reports whether you may still post — set only on the
    detail view (the composer keys off it); history stays visible even when
    it's False.
    """

    group = serializers.SerializerMethodField()
    other = serializers.SerializerMethodField()
    participants = ParticipantSerializer(source="participant_rows", many=True, read_only=True)
    my_status = serializers.SerializerMethodField()
    must_connect_with = AuthorSerializer(source="must_connect", many=True, read_only=True)
    last_message = serializers.SerializerMethodField()
    unread_count = serializers.IntegerField(read_only=True)
    # Whether you can still *send* in this thread (connected/active, not
    # blocked). Set only on the conversation-detail view; ``null`` in the
    # list, which doesn't need it. Renamed from Phase 5's ``can_message``.
    can_send = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = (
            "id",
            "kind",
            "title",
            "group",
            "other",
            "participants",
            "my_status",
            "must_connect_with",
            "last_message",
            "unread_count",
            "can_send",
            "updated_at",
        )
        read_only_fields = ("id", "kind", "title", "updated_at")

    def get_other(self, obj):
        if obj.kind != Conversation.Kind.DIRECT:
            return None
        other = getattr(obj, "other", None)
        if other is None:
            return None
        return AuthorSerializer(other, context=self.context).data

    def get_group(self, obj):
        # The view (``decorate_conversations``) precomputes this via
        # ``chat_display_for`` and stashes it on the instance — this
        # serializer can't import from ``views`` (views already imports from
        # here), so it reads the result rather than calling the helper.
        return getattr(obj, "_group_display", None)

    def get_my_status(self, obj):
        return getattr(obj, "my_status", None)

    def get_can_send(self, obj):
        return getattr(obj, "_can_message", None)

    def get_last_message(self, obj):
        # The view attaches the latest message (or None) as ``_last_message`` to
        # avoid an N+1 across the list.
        message = getattr(obj, "_last_message", None)
        if message is None:
            return None
        return {
            "text": "" if message.is_deleted else message.text,
            "is_deleted": message.is_deleted,
            "sender_id": message.sender_id,
            "created_at": message.created_at,
        }


# --- Groups (Phase 6) --------------------------------------------------------

GROUP_NAME_MAX_LENGTH = 100
GROUP_DESCRIPTION_MAX_LENGTH = 2000


class GroupSerializer(serializers.ModelSerializer):
    """Read + create + edit a group.

    Read fields give the group page + list what they need: ``avatar_url`` (full)
    and ``avatar_thumb`` (small, for the list), plus two **per-viewer** fields the
    view attaches — ``member_count`` (active members) and ``your_role``
    (``member``/``admin``, driving whether admin controls show). ``name`` and
    ``description`` are writable (create + PATCH); the avatar is uploaded
    separately as multipart and processed in the view (validated + downscaled +
    EXIF-stripped via ``api.imaging``), same as user avatars — never a raw file.
    """

    name = serializers.CharField(max_length=GROUP_NAME_MAX_LENGTH)
    description = serializers.CharField(
        max_length=GROUP_DESCRIPTION_MAX_LENGTH,
        required=False,
        allow_blank=True,
        default="",
    )
    avatar_url = serializers.SerializerMethodField()
    avatar_thumb = serializers.SerializerMethodField()
    member_count = serializers.SerializerMethodField()
    your_role = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = (
            "id",
            "name",
            "description",
            "avatar_url",
            "avatar_thumb",
            "member_count",
            "your_role",
            "created_at",
        )
        read_only_fields = ("id", "created_at")

    def validate_name(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A group needs a name.")
        return stripped

    def validate_description(self, value):
        return value.strip()

    def get_avatar_url(self, obj):
        return absolute_media_url(obj.avatar, self.context.get("request"))

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))

    def get_member_count(self, obj):
        # Attached by the view (annotated in bulk, no N+1); falls back to the
        # model's shared count for safety if a caller forgot to annotate.
        count = getattr(obj, "member_count", None)
        if count is None:
            count = obj.active_member_count()
        return count

    def get_your_role(self, obj):
        return getattr(obj, "_your_role", None)


class GroupMemberSerializer(serializers.ModelSerializer):
    """One active member of a group: the person plus their role, so the members
    panel can badge admins and show admin-only controls."""

    user = AuthorSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ("user", "role")


class GroupInviteSerializer(serializers.ModelSerializer):
    """A pending invite in your group-invites inbox.

    ``id`` is the membership row's id — the handle used to accept/reject.
    ``group`` is a minimal card of the group you've been invited to, and
    ``invited_by`` is who invited you (for the "X invited you to Y" line).
    """

    group = serializers.SerializerMethodField()
    invited_by = AuthorSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ("id", "group", "invited_by", "created_at")

    def get_group(self, obj):
        return {
            "id": obj.group_id,
            "name": obj.group.name,
            "avatar_thumb": absolute_media_url(
                obj.group.avatar_thumb, self.context.get("request")
            ),
        }


class ReportCreateSerializer(serializers.ModelSerializer):
    """Flag a post or comment for the maintainer (Phase 7 takedown path).

    The body carries **exactly one** target — ``post`` OR ``comment`` (by id) —
    plus an optional free-text ``reason``. ``reporter`` and ``status`` are set by
    the view/model, never the body. The model's check constraint is the ultimate
    guardrail; validating here too gives a clean 400 instead of a 500.
    """

    reason = serializers.CharField(
        max_length=REPORT_REASON_MAX_LENGTH,
        required=False,
        allow_blank=True,
        default="",
    )

    class Meta:
        model = Report
        fields = ("id", "post", "comment", "reason", "created_at")
        read_only_fields = ("id", "created_at")

    def validate(self, attrs):
        if bool(attrs.get("post")) == bool(attrs.get("comment")):
            raise serializers.ValidationError(
                "Report exactly one of a post or a comment."
            )
        return attrs


class NotificationSerializer(serializers.ModelSerializer):
    """One activity-centre notification, in a **push-ready** shape (Phase 8).

    The same payload the web dropdown renders is what the future iPhone/Android
    phases (9–10) turn into an OS notification + deep-link — so the mobile phases
    add only the *transport*, never a new API shape. The two pieces that make it
    reusable:

    - ``text`` — a human-readable line, phrased **server-side** per ``kind`` so
      the web app and a future push payload share one wording.
    - ``url`` — the in-app route to open. Post/reply/reaction kinds deep-link to
      the post **permalink** (``/p/<id>``); a comment reply/reaction adds
      ``?comment=<id>`` so the thread opens *at that comment* (even one 20 replies
      deep). Requests/invites point at their existing inboxes. ``target`` also
      carries ``{type, id}`` for clients that want to route by target directly.

    ``seen``/``addressed`` are the two read-state booleans (see ``Notification``).
    All four target FKs cascade-delete, so a notification never outlives its
    target — there are no dangling deep-links to filter out.
    """

    actor = AuthorSerializer(read_only=True)
    text = serializers.SerializerMethodField()
    target = serializers.SerializerMethodField()
    url = serializers.SerializerMethodField()
    seen = serializers.SerializerMethodField()
    addressed = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = (
            "id",
            "kind",
            "actor",
            "text",
            "target",
            "url",
            "created_at",
            "seen",
            "addressed",
        )

    def _actor_name(self, obj):
        return obj.actor.display_name if obj.actor else "Someone"

    def get_seen(self, obj):
        return obj.seen_at is not None

    def get_addressed(self, obj):
        return obj.addressed_at is not None

    def get_text(self, obj):
        name = self._actor_name(obj)
        K = Notification.Kind
        if obj.kind == K.POST_REPLY:
            return f"{name} replied to your post"
        if obj.kind == K.COMMENT_REPLY:
            return f"{name} replied to your comment"
        if obj.kind == K.REACTION:
            what = "post" if obj.post_id else "comment"
            return f"{name} reacted to your {what}"
        if obj.kind == K.CONNECTION_REQUEST:
            return f"{name} asked to connect"
        if obj.kind == K.CONNECTION_ACCEPTED:
            return f"{name} accepted your connection request"
        if obj.kind == K.GROUP_INVITE:
            group_name = obj.group.name if obj.group_id else "a group"
            return f"{name} invited you to {group_name}"
        # Event kinds (Phase 8b) — the actor is the organiser; name the event so
        # the line is meaningful in a push payload with no surrounding context.
        title = obj.event.title if obj.event_id else "an event"
        if obj.kind == K.EVENT_CREATED:
            return f"{name} planned {title}"
        if obj.kind == K.POLL_OPENED:
            return f"{name} opened a poll on {title}"
        if obj.kind == K.EVENT_SCHEDULED:
            return f"{name} set a date for {title}"
        if obj.kind == K.EVENT_UPDATED:
            return f"{name} updated {title}"
        if obj.kind == K.EVENT_CANCELLED:
            return f"{name} cancelled {title}"
        return f"{name} did something"

    def get_target(self, obj):
        """``{type, id}`` for the concrete thing the notification points at, or
        ``None``. Lets a client deep-link precisely (now or in a future app)."""
        if obj.post_id:
            return {"type": "post", "id": obj.post_id}
        if obj.comment_id:
            return {"type": "comment", "id": obj.comment_id}
        if obj.group_id:
            return {"type": "group", "id": obj.group_id}
        if obj.connection_id:
            return {"type": "connection", "id": obj.connection_id}
        if obj.event_id:
            return {"type": "event", "id": obj.event_id}
        return None

    def get_url(self, obj):
        K = Notification.Kind
        # Post permalink (/p/<id>), with ?comment=<id> when the notification is
        # about a specific comment so the thread opens right at it.
        if obj.kind == K.POST_REPLY and obj.post_id:
            return f"/p/{obj.post_id}"
        if obj.kind == K.COMMENT_REPLY and obj.comment_id:
            return f"/p/{obj.comment.post_id}?comment={obj.comment_id}"
        if obj.kind == K.REACTION:
            if obj.comment_id:
                return f"/p/{obj.comment.post_id}?comment={obj.comment_id}"
            if obj.post_id:
                return f"/p/{obj.post_id}"
        if obj.kind == K.CONNECTION_REQUEST:
            return "/requests"
        if obj.kind == K.CONNECTION_ACCEPTED and obj.actor_id:
            return f"/u/{obj.actor_id}"
        if obj.kind == K.GROUP_INVITE:
            return "/group-invites"
        # Event kinds deep-link to the event on its group page.
        if obj.event_id:
            return f"/g/{obj.event.group_id}/events/{obj.event_id}"
        return "/"


class NotificationPreferencesSerializer(serializers.Serializer):
    """The user's per-kind on/off map for the **mutable** kinds (Phase 8).

    Not a ``ModelSerializer``: preferences are stored one row per (user, kind)
    with *absence meaning enabled*, so the API presents them as a flat
    ``{kind: bool}`` map over exactly ``Notification.MUTABLE_KINDS`` (the
    request/invite kinds are always-on and never appear here). GET fills defaults
    for kinds with no row; PATCH accepts a partial map and upserts.
    """

    def to_representation(self, user):
        rows = {
            p.kind: p.enabled
            for p in user.notification_preferences.all()
        }
        return {
            kind: rows.get(kind, True)
            for kind in sorted(Notification.MUTABLE_KINDS)
        }

    def validate(self, attrs):
        # DRF hands raw fields in via the view; we validate the incoming map here.
        data = self.initial_data
        if not isinstance(data, dict):
            raise serializers.ValidationError("Expected a {kind: bool} object.")
        cleaned = {}
        for kind, enabled in data.items():
            if kind not in Notification.MUTABLE_KINDS:
                raise serializers.ValidationError(
                    {kind: "Not a mutable notification kind."}
                )
            if not isinstance(enabled, bool):
                raise serializers.ValidationError(
                    {kind: "Expected true or false."}
                )
            cleaned[kind] = enabled
        return cleaned


# ---------------------------------------------------------------------------
# Phase 8b — group events, polls, RSVPs
#
# The delicate rule (decision 2 in the phase doc): within an event a viewer can
# already see, **poll/RSVP counts are complete** (every participant in the
# audience — a shared coordination number must be honest) but **names are
# connection-gated** (you only see *who* voted / who's going among your own
# connections). This is the deliberate inverse of ``summarise_reactions`` above,
# where a non-connection's reaction doesn't even count. ``visible_ids`` here is
# the same set as ``visible_reactor_ids`` (you + your connections); the count is
# over *all* rows, the names filtered to that set.
# ---------------------------------------------------------------------------

EVENT_TITLE_MAX = 200
EVENT_DESCRIPTION_MAX = 5000
EVENT_TEXT_FIELD_MAX = 200  # location fields, poll option label/question, notes
MAX_GUESTS = 50  # a sane cap on a "+N" headcount


def _author_dict(user, request):
    return AuthorSerializer(user, context={"request": request}).data


def build_poll_results(poll, *, visible_ids, me_id, request):
    """A poll's options with **complete counts** + **connection-gated voter
    names** + the viewer's own selections.

    ``poll.options`` and each option's ``votes`` (with ``voter``) must be
    prefetched. ``count`` is every vote for the option; ``voters`` lists only
    those in ``visible_ids`` (you + your connections) — everyone else folds into
    the count as an anonymous +1. ``you_voted`` flags the viewer's own picks.
    """
    options = []
    your_votes = []
    for opt in poll.options.all():
        votes = list(opt.votes.all())
        voter_ids = {v.voter_id for v in votes}
        options.append({
            "id": opt.id,
            "label": opt.label,
            "date_value": opt.date_value,
            "time_value": opt.time_value,
            "text_value": opt.text_value,
            "order": opt.order,
            "count": len(votes),
            "voters": [
                _author_dict(v.voter, request)
                for v in votes if v.voter_id in visible_ids
            ],
            "you_voted": me_id in voter_ids,
        })
        if me_id in voter_ids:
            your_votes.append(opt.id)
    return options, your_votes


def serialize_poll(poll, *, visible_ids, me_id, request):
    """One poll as a dict: metadata + results (counts full, names gated)."""
    options, your_votes = build_poll_results(
        poll, visible_ids=visible_ids, me_id=me_id, request=request
    )
    # Total votes across every option (complete, not gated). The frontend gates
    # the "edit poll" affordance on this being 0 — a poll locks its wording the
    # moment the first vote lands (see the PATCH guard in the poll view).
    vote_count = sum(o["count"] for o in options)
    return {
        "id": poll.id,
        "event": poll.event_id,
        "dimension": poll.dimension,
        "question": poll.question,
        "allow_multiple": poll.allow_multiple,
        "status": poll.status,
        "closes_at": poll.closes_at,
        "created_at": poll.created_at,
        "options": options,
        "vote_count": vote_count,
        "your_votes": your_votes,
        # For a finalised custom poll, the option the organiser pinned (else null).
        "decided_option": poll.decided_option_id,
    }


def _dimension_states(event, open_builtin_polls):
    """Per built-in dimension (date/time/location): ``set`` if its field is
    populated, else ``polling`` if an open poll targets it, else ``unset``. The
    open poll id is surfaced regardless so a re-poll on an already-set dimension
    still shows a live tally on the chip."""
    populated = {
        "date": event.event_date is not None,
        "time": event.start_time is not None,
        "location": bool(event.location_name),
    }
    states = {}
    for dim in ("date", "time", "location"):
        poll = open_builtin_polls.get(dim)
        if populated[dim]:
            state = "set"
        elif poll is not None:
            state = "polling"
        else:
            state = "unset"
        states[dim] = {"state": state, "poll": poll.id if poll else None}
    return states


def build_rsvp_summary(event, *, visible_ids, me_id, request, named=True):
    """RSVP tallies for an event: **complete counts** + the viewer's own RSVP,
    and (when ``named``) **connection-gated** named lists per response.

    ``event.rsvps`` (with ``user``) must be prefetched. ``counts.guests`` is the
    summed "+N" headcount of the *going* responses only.
    """
    counts = {"going": 0, "maybe": 0, "declined": 0, "guests": 0}
    your = None
    lists = {"going": [], "maybe": [], "declined": []}
    for r in event.rsvps.all():
        counts[r.response] = counts.get(r.response, 0) + 1
        if r.response == EventRSVP.Response.GOING:
            counts["guests"] += max(r.guests or 0, 0)
        if r.user_id == me_id:
            your = {"response": r.response, "guests": r.guests, "note": r.note}
        if named and r.user_id in visible_ids:
            lists[r.response].append(_author_dict(r.user, request))
    out = {"counts": counts, "your_response": your}
    if named:
        out["going_list"] = lists["going"]
        out["maybe_list"] = lists["maybe"]
        out["declined_list"] = lists["declined"]
    return out


def serialize_event(event, *, viewer, visible_ids, request,
                    is_group_admin=False, detail=True):
    """The full event payload — scalar fields, dimension states, RSVP summary,
    and (in ``detail``) the polls.

    Built as a dict rather than a ``ModelSerializer`` because the gated
    aggregates (poll/RSVP names) don't map onto plain fields. Push-ready: a client
    (web now, a phone later) has everything to render the card and deep-link. The
    view must prefetch ``polls__options__votes__voter`` and ``rsvps__user``.
    """
    me_id = viewer.id
    can_manage = event.organiser_id == me_id
    polls = list(event.polls.all())
    open_builtin = {
        p.dimension: p
        for p in polls
        if p.status == Poll.Status.OPEN and p.dimension != Poll.Dimension.CUSTOM
    }
    data = {
        "id": event.id,
        "group": {"id": event.group_id, "name": event.group.name},
        "organiser": _author_dict(event.organiser, request),
        "title": event.title,
        "description": event.description,
        "event_date": event.event_date,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "timezone": event.timezone,
        "location_name": event.location_name,
        "location_url": event.location_url,
        "location_note": event.location_note,
        "status": event.status,
        "is_past": event.is_past,
        "starts_at": event.starts_at,
        "dimensions": _dimension_states(event, open_builtin),
        "rsvp": build_rsvp_summary(
            event, visible_ids=visible_ids, me_id=me_id, request=request,
            named=detail,
        ),
        "can_manage": can_manage,
        "can_moderate": can_manage or is_group_admin,
        "created_at": event.created_at,
        "updated_at": event.updated_at,
        # Polls are included even in list/summary payloads — the dimension chips
        # need each poll's option tallies (a "polling" chip shows the live count)
        # and the custom-poll chips. Voter names ride along already connection-
        # gated. Only the heavier RSVP *named* lists are held back to ``detail``.
        "polls": [
            serialize_poll(p, visible_ids=visible_ids, me_id=me_id, request=request)
            for p in polls
        ],
    }
    return data


class EventWriteSerializer(serializers.ModelSerializer):
    """Validate an event **create** or **edit** body (organiser-authored fields).

    The scheduling dimensions (``event_date``/``start_time``/``location_name``)
    are deliberately **not** here — they're written only through ``finalise`` so
    the advisory-poll rule (decision 3) and the ``status`` recompute live in one
    place. This serializer covers the title, description, the auxiliary location
    detail (link/note), the timezone, and the optional end time.
    """

    title = serializers.CharField(max_length=EVENT_TITLE_MAX)
    description = serializers.CharField(
        max_length=EVENT_DESCRIPTION_MAX, required=False, allow_blank=True,
        default="",
    )

    class Meta:
        model = Event
        fields = (
            "title", "description", "location_url", "location_note",
            "timezone", "end_time",
        )

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("An event needs a title.")
        return value


class PollOptionWriteSerializer(serializers.Serializer):
    """One candidate option in a poll-create body. The typed value used depends
    on the poll's dimension (validated in the view, which knows the dimension):
    ``date_value`` for date, ``time_value`` for time, ``text_value`` for
    location/custom. ``label`` is optional — the view fills a sensible default
    from the value when it's blank."""

    label = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )
    date_value = serializers.DateField(required=False, allow_null=True)
    time_value = serializers.TimeField(required=False, allow_null=True)
    text_value = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )


class PollCreateSerializer(serializers.Serializer):
    """Validate a poll-create body: a dimension, an optional question (auto-phrased
    for built-ins when omitted), at least two options, and the poll knobs."""

    dimension = serializers.ChoiceField(choices=Poll.Dimension.choices)
    question = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )
    allow_multiple = serializers.BooleanField(required=False, allow_null=True,
                                              default=None)
    closes_at = serializers.DateTimeField(required=False, allow_null=True)
    options = PollOptionWriteSerializer(many=True)

    def validate_options(self, value):
        if len(value) < 2:
            raise serializers.ValidationError(
                "A poll needs at least two options."
            )
        return value


class PollOptionEditSerializer(PollOptionWriteSerializer):
    """One option in a poll-**edit** body: the same typed value fields as a
    created option (``date_value`` / ``time_value`` / ``text_value`` / ``label``,
    interpreted per the poll's dimension), plus an **optional** ``id``. An entry
    with an ``id`` rewrites that existing option; without one it's a brand-new
    option. Reconciling the set (add/rewrite/drop) is only safe because the whole
    edit is gated on the poll having zero votes — no cast vote can be redefined
    or orphaned."""

    id = serializers.IntegerField(required=False)


class PollEditSerializer(serializers.Serializer):
    """Validate a poll-**edit** body (organiser fixing mistakes): a new
    ``question`` and/or rewritten ``options``. Both are optional so a caller can
    touch just one; the view rejects the edit entirely if the poll already has
    any votes."""

    question = serializers.CharField(max_length=EVENT_TEXT_FIELD_MAX, required=False)
    allow_multiple = serializers.BooleanField(required=False)
    options = PollOptionEditSerializer(many=True, required=False)

    def validate_question(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("A poll needs a question.")
        return value


class RSVPWriteSerializer(serializers.Serializer):
    """Validate an RSVP upsert body: a response, optional +guests, optional note."""

    response = serializers.ChoiceField(choices=EventRSVP.Response.choices)
    guests = serializers.IntegerField(
        required=False, min_value=0, max_value=MAX_GUESTS, default=0
    )
    note = serializers.CharField(
        max_length=EVENT_TEXT_FIELD_MAX, required=False, allow_blank=True,
        default="",
    )


class FinaliseSerializer(serializers.Serializer):
    """Validate a ``finalise`` body — the organiser's *decision* on a dimension.

    ``value`` is a raw string interpreted per dimension in the view (a date, a
    time, or free text), and it need **not** match any poll option (decision 3 —
    the organiser can set a value no one voted for). For a ``custom`` poll,
    ``option_id`` pins a winning option instead. ``close_poll`` (default true)
    closes the related open poll as part of finalising.
    """

    dimension = serializers.ChoiceField(choices=Poll.Dimension.choices)
    value = serializers.CharField(required=False, allow_blank=True,
                                  allow_null=True, default="")
    option_id = serializers.IntegerField(required=False, allow_null=True)
    close_poll = serializers.BooleanField(required=False, default=True)


class DevicePushTokenSerializer(serializers.ModelSerializer):
    """Register/refresh one device's Expo push token (Phase 9, Milestone A)."""

    class Meta:
        model = DevicePushToken
        fields = ["expo_token", "platform"]
        # `expo_token` is globally unique on the model, which would normally make
        # DRF reject a re-registration as a duplicate. Registration is an upsert
        # by design (the same device re-registers on every launch, and may move
        # to a different user), so the uniqueness is resolved in the view's
        # update_or_create rather than as a validation error here.
        extra_kwargs = {"expo_token": {"validators": []}}
