from django.contrib.auth.models import AbstractUser
from django.db import models

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

    objects = UserManager()

    def __str__(self):
        return self.email
