from allauth.account.adapter import get_adapter
from dj_rest_auth.registration.serializers import RegisterSerializer
from dj_rest_auth.serializers import (
    UserDetailsSerializer as BaseUserDetailsSerializer,
)
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import serializers

from api.imaging import (
    absolute_media_url,
    clear_avatar,
    process_avatar,
    save_avatar,
)

User = get_user_model()

# A comfortable cap for a short "about me" — enough for a sentence or two,
# bounded so it can't be used to dump unbounded text into the DB.
BIO_MAX_LENGTH = 500


class CustomRegisterSerializer(RegisterSerializer):
    """Registration serializer for our email-only, admin-approved sign-up.

    Departures from dj-rest-auth's default:
    - Drops the ``username`` field (our User has no username). Setting a declared
      field to ``None`` in a subclass removes it, the DRF-documented way.
    - Collects the person's **real name** (first + last) at sign-up. A real name
      is the whole identity here (there are no usernames), so every account has a
      display name from day one rather than showing as an email local-part until
      they fill in a profile. allauth's ``save_user`` persists these from
      ``get_cleaned_data``.
    - Creates the account **inactive**. New sign-ups cannot log in until the
      maintainer approves them in the Django admin (see the accounts admin).
    """

    # Remove the inherited username field — email is the only identifier.
    username = None
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150)
    # Explicit consent to the Terms + privacy policy, required to sign up. As a
    # data controller (UK GDPR) we record *that* the person agreed, and when
    # (``tos_accepted_at``, stamped in ``save()``). Write-only — it's an input,
    # not part of any response.
    accept_terms = serializers.BooleanField(write_only=True)

    def validate_first_name(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("First name can't be blank.")
        return stripped

    def validate_last_name(self, value):
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("Last name can't be blank.")
        return stripped

    def validate_accept_terms(self, value):
        # A present-but-false box is a refusal — reject it. (An absent field is
        # already a "this field is required" error from BooleanField.)
        if not value:
            raise serializers.ValidationError(
                "You must accept the Terms and Privacy Policy to sign up."
            )
        return value

    def get_cleaned_data(self):
        # allauth's adapter.save_user reads first/last name from here.
        data = super().get_cleaned_data()
        data["first_name"] = self.validated_data.get("first_name", "")
        data["last_name"] = self.validated_data.get("last_name", "")
        return data

    def validate_email(self, email):
        # Account-enumeration hardening: deliberately do NOT reveal whether an
        # email is already registered (the default raises a distinct "already
        # registered" error, which lets anyone probe who has an account here —
        # a real privacy leak for a members-only app). We only normalise the
        # address; a duplicate is handled *silently* in save(), which returns
        # the exact same "pending approval" response as a genuinely new sign-up.
        return get_adapter().clean_email(email)

    def save(self, request):
        email = self.validated_data.get("email", "")
        if email and User.objects.filter(email__iexact=email).exists():
            # The email is taken. Pretend the sign-up succeeded without creating
            # or touching any account, so the response is indistinguishable from
            # a new sign-up. Run a throwaway password hash first so this path
            # takes about as long as the real one — otherwise the response time
            # would itself be a reliable "does this email exist?" oracle.
            User().set_password(self.validated_data.get("password1", ""))
            return None
        user = super().save(request)
        # Pending approval: no one gets in without the maintainer's say-so.
        # Record consent at the same moment (the box was required to get here).
        user.is_active = False
        user.tos_accepted_at = timezone.now()
        user.save(update_fields=["is_active", "tos_accepted_at"])
        return user


class UserDetailsSerializer(BaseUserDetailsSerializer):
    """"Who am I" payload, and the target of profile edits (PATCH /auth/user/).

    Mirrors dj-rest-auth's default minus ``username`` (our User has none), plus
    the Phase 4 profile fields. ``first_name``/``last_name``/``bio`` are
    editable; ``avatar`` is a write-only upload (validated + downscaled +
    metadata-stripped via ``api.imaging`` in ``update``), and ``avatar``/
    ``avatar_thumb`` are returned as URLs. ``remove_avatar`` clears it (a
    boolean is unambiguous over multipart, where sending null is awkward).

    ``is_staff`` is exposed (read-only) so the frontend can show maintainer-only
    UI like the admin link. It's not a security control — the Django admin
    enforces staff access server-side; this just decides whether to render it.
    """

    bio = serializers.CharField(
        required=False, allow_blank=True, max_length=BIO_MAX_LENGTH
    )
    avatar = serializers.ImageField(write_only=True, required=False)
    avatar_url = serializers.SerializerMethodField()
    avatar_thumb = serializers.SerializerMethodField()
    remove_avatar = serializers.BooleanField(write_only=True, required=False)

    class Meta(BaseUserDetailsSerializer.Meta):
        fields = (
            "pk",
            "email",
            "first_name",
            "last_name",
            "display_name",
            "bio",
            "avatar",
            "avatar_url",
            "avatar_thumb",
            "remove_avatar",
            "is_staff",
        )
        read_only_fields = ("pk", "email", "display_name", "is_staff")

    def get_avatar_url(self, obj):
        return absolute_media_url(obj.avatar, self.context.get("request"))

    def get_avatar_thumb(self, obj):
        return absolute_media_url(obj.avatar_thumb, self.context.get("request"))

    def update(self, instance, validated_data):
        avatar_file = validated_data.pop("avatar", None)
        remove_avatar = validated_data.pop("remove_avatar", False)

        # first_name / last_name / bio via the base implementation.
        instance = super().update(instance, validated_data)

        if avatar_file is not None:
            save_avatar(instance, process_avatar(avatar_file))
            instance.save(update_fields=["avatar", "avatar_thumb"])
        elif remove_avatar:
            clear_avatar(instance)
            instance.save(update_fields=["avatar", "avatar_thumb"])

        return instance
