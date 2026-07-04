from django.contrib.auth import get_user_model
from rest_framework import serializers

from .models import Post

User = get_user_model()

# A generous cap so a post can't be used to dump unbounded text into the DB,
# while being far more than any real status update needs.
POST_MAX_LENGTH = 5000


class AuthorSerializer(serializers.ModelSerializer):
    """The tiny slice of a user we embed in a post or expose in a list.

    Deliberately minimal: an id (for profile links) and a display name. No
    email — see ``User.display_name`` for why we don't leak addresses.
    """

    display_name = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = ("id", "display_name")


class PostSerializer(serializers.ModelSerializer):
    """Read + create a post.

    ``author`` is read-only and set from the logged-in user in the view — it is
    never taken from the request body, so a client can't post as someone else.
    """

    author = AuthorSerializer(read_only=True)
    text = serializers.CharField(max_length=POST_MAX_LENGTH)

    class Meta:
        model = Post
        fields = ("id", "author", "text", "created_at")
        read_only_fields = ("id", "author", "created_at")

    def validate_text(self, value):
        # A post must actually say something — reject blank/whitespace-only.
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("A post can't be empty.")
        return stripped


class UserListSerializer(serializers.ModelSerializer):
    """A person in the "find people to follow" list.

    ``is_following`` reflects whether the *requesting* user already follows this
    person, so the UI can render Follow vs Unfollow. It's annotated onto the
    queryset in the view (a single query, no N+1).
    """

    display_name = serializers.CharField(read_only=True)
    is_following = serializers.BooleanField(read_only=True)

    class Meta:
        model = User
        fields = ("id", "display_name", "is_following")
