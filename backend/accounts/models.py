from django.contrib.auth.models import AbstractUser
from django.db import models

from api.imaging import avatar_thumb_upload_to, avatar_upload_to

from .managers import UserManager


class User(AbstractUser):
    """Custom user model, set from the start (see docs/phases/phase-2-accounts.md).

    Django strongly recommends defining a custom user model at project start:
    swapping it in later — once real accounts exist — is a painful data
    migration. We do it now while the dev DB is empty.

    Differences from the default user:
    - ``email`` is the login identifier (``USERNAME_FIELD``) and is unique.
    - The ``username`` field is dropped entirely.

    Profile fields (display name, bio — already shown in the Phase 1 wireframe)
    will be added here in Phase 4; this model is their natural home.
    """

    # Drop the inherited username field; email identifies the user.
    username = None
    email = models.EmailField("email address", unique=True)

    USERNAME_FIELD = "email"
    # Fields prompted for by `createsuperuser` in addition to USERNAME_FIELD +
    # password. Email is already the identifier, so nothing extra is required.
    REQUIRED_FIELDS = []

    # Profile fields (Phase 4). A short free-text bio, and an avatar with a small
    # square thumbnail generated at upload (the size the feed/lists render). Both
    # avatar fields are set together via api.imaging.process_image — never by the
    # client directly — so a stored avatar is always validated + metadata-stripped.
    bio = models.TextField(blank=True, default="")
    avatar = models.ImageField(
        upload_to=avatar_upload_to, null=True, blank=True
    )
    avatar_thumb = models.ImageField(
        upload_to=avatar_thumb_upload_to, null=True, blank=True
    )

    objects = UserManager()

    def __str__(self):
        return self.email

    @property
    def display_name(self):
        """The human label shown for this user across the app.

        Real first + last name once set (the maintainer fills these in when
        approving a sign-up, and the Phase 4 profile UI lets users edit them).
        Until then we fall back to the email's local-part (the bit before the
        ``@``) rather than the full address, so members don't see each other's
        email addresses in the feed or the people list (privacy-first).
        """
        full_name = f"{self.first_name} {self.last_name}".strip()
        return full_name or self.email.split("@", 1)[0]
