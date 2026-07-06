from django.contrib.auth import get_user_model
from rest_framework import serializers

from .imaging import absolute_media_url
from .models import Comment, Connection, Post, PostImage

User = get_user_model()

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

    class Meta:
        model = Post
        fields = ("id", "author", "text", "images", "created_at")
        read_only_fields = ("id", "author", "images", "created_at")

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

    class Meta:
        model = User
        fields = (
            "id",
            "display_name",
            "connection_status",
            "avatar_thumb",
            "bio",
        )

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
