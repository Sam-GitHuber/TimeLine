from django.contrib.auth import get_user_model
from rest_framework import serializers

from .imaging import absolute_media_url
from .models import (
    Comment,
    Connection,
    Conversation,
    Group,
    GroupMembership,
    Message,
    Post,
    PostImage,
    Report,
)

User = get_user_model()

# A report reason is free text but bounded — a sentence or two of "why", not an
# essay. Optional (the flag itself is the signal), capped to bound the DB row.
REPORT_REASON_MAX_LENGTH = 1000

# A generous cap so a post can't be used to dump unbounded text into the DB,
# while being far more than any real status update needs. Comments share it.
POST_MAX_LENGTH = 5000


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

    class Meta:
        model = Post
        fields = ("id", "author", "text", "images", "group", "created_at")
        read_only_fields = ("id", "author", "images", "group", "created_at")

    def get_group(self, obj):
        if obj.group_id is None:
            return None
        return {"id": obj.group_id, "name": obj.group.name}

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

    class Meta:
        model = Comment
        fields = ("id", "author", "parent", "text", "created_at", "replies")

    def get_replies(self, obj):
        children = getattr(obj, "_visible_children", [])
        return CommentSerializer(
            children, many=True, context=self.context
        ).data


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
