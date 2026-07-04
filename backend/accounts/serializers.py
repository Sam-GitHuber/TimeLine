from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import (
    UserDetailsSerializer as BaseUserDetailsSerializer,
)


class CustomRegisterSerializer(RegisterSerializer):
    """Registration serializer for our email-only, admin-approved sign-up.

    Two departures from dj-rest-auth's default:
    - Drops the ``username`` field (our User has no username). Setting a declared
      field to ``None`` in a subclass removes it, the DRF-documented way.
    - Creates the account **inactive**. New sign-ups cannot log in until the
      maintainer approves them in the Django admin (see the accounts admin).
    """

    # Remove the inherited username field — email is the only identifier.
    username = None

    def save(self, request):
        user = super().save(request)
        # Pending approval: no one gets in without the maintainer's say-so.
        user.is_active = False
        user.save(update_fields=["is_active"])
        return user


class UserDetailsSerializer(BaseUserDetailsSerializer):
    """"Who am I" payload. Mirrors dj-rest-auth's default but without the
    ``username`` field, which our custom User model doesn't have."""

    class Meta(BaseUserDetailsSerializer.Meta):
        fields = ("pk", "email", "first_name", "last_name")
        read_only_fields = ("pk", "email")
