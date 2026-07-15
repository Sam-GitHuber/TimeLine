import secrets
from datetime import timedelta

from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone

from api.imaging import avatar_thumb_upload_to, avatar_upload_to

from .managers import UserManager


def generate_code(length=6):
    """A cryptographically-random, zero-padded numeric code (e.g. ``"048213"``).

    ``secrets`` (not ``random``) because this is a credential — it must not be
    predictable from a seeded/observed PRNG.
    """
    return f"{secrets.randbelow(10 ** length):0{length}d}"


class User(AbstractUser):
    """Custom user model, set from the start (see docs/reference/accounts.md).

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

    # When this person accepted the Terms of Service + privacy policy (Phase 7).
    # Stamped at sign-up (registration is gated on ticking the box) — a defensible
    # record of consent, which we need as a data controller under UK GDPR. Nullable
    # because accounts created before this existed (e.g. the maintainer's own,
    # created via createsuperuser) won't have it; a NULL means "no recorded
    # acceptance", not "accepted at the epoch".
    tos_accepted_at = models.DateTimeField(null=True, blank=True)

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


class EmailVerificationCode(models.Model):
    """A short-lived 6-digit code proving control of a sign-up email address.

    Email is our sole login identifier (there is no username), so we need to know
    a member actually controls the address they signed up with — otherwise a typo
    means an unrecoverable account, and a deliberately wrong address points the
    login identifier at someone else's inbox. See docs/reference/accounts.md.

    Two deliberate choices:

    - **Only a hash of the code is stored** (``django.contrib.auth.hashers``),
      never the plaintext — so a database leak can't hand out live codes. Sign-up
      volume is tiny, so PBKDF2's cost is irrelevant here.
    - **Verification proves address *control* only.** Admin approval
      (``User.is_active``) remains the membership gate; *both* are required to log
      in (enforced in ``CustomLoginSerializer``). The durable "is this address
      verified" flag lives on allauth's ``EmailAddress.verified`` — this row is
      just the transient challenge and is deleted once redeemed.

    One row per user (``OneToOneField``); issuing a new code replaces the old one.
    """

    CODE_LENGTH = 6
    # A code is valid for this long after it's issued.
    EXPIRY = timedelta(minutes=15)
    # After this many wrong guesses the code is dead (online-guessing guard: with
    # 6 digits and 5 tries the odds of a hit are 5-in-a-million).
    MAX_ATTEMPTS = 5
    # Don't send a fresh code more often than this, even across rotating IPs —
    # blunts using "resend" to flood someone's inbox.
    RESEND_COOLDOWN = timedelta(seconds=60)

    user = models.OneToOneField(
        "accounts.User",
        on_delete=models.CASCADE,
        related_name="email_verification_code",
    )
    code_hash = models.CharField(max_length=128)
    # Set explicitly on (re)issue rather than auto_now_add, so reissuing resets
    # the clock (auto_now_add only fires on first insert).
    created_at = models.DateTimeField(default=timezone.now)
    attempts = models.PositiveSmallIntegerField(default=0)

    def __str__(self):
        return f"email verification code for user {self.user_id}"

    @property
    def is_expired(self):
        return timezone.now() - self.created_at >= self.EXPIRY

    @classmethod
    def issue(cls, user):
        """Replace any existing code for ``user`` with a fresh one.

        Returns the **plaintext** code (the only place it exists in the clear) for
        the caller to email; the DB keeps only its hash.
        """
        code = generate_code(cls.CODE_LENGTH)
        cls.objects.update_or_create(
            user=user,
            defaults={
                "code_hash": make_password(code),
                "created_at": timezone.now(),
                "attempts": 0,
            },
        )
        return code

    @classmethod
    def issue_if_due(cls, user):
        """Like :meth:`issue`, but returns ``None`` (issuing nothing) if a code
        was sent within ``RESEND_COOLDOWN`` — the anti-flood guard for resend."""
        existing = cls.objects.filter(user=user).first()
        if existing and timezone.now() - existing.created_at < cls.RESEND_COOLDOWN:
            return None
        return cls.issue(user)

    def verify(self, code):
        """Return whether ``code`` matches; a wrong guess burns one attempt.

        A dead code (too many attempts, or expired) always fails without leaking
        which. The attempt counter is bumped atomically (``F``) so racing
        submissions can't get extra tries.
        """
        if self.attempts >= self.MAX_ATTEMPTS or self.is_expired:
            return False
        if check_password(code, self.code_hash):
            return True
        self.attempts = models.F("attempts") + 1
        self.save(update_fields=["attempts"])
        self.refresh_from_db(fields=["attempts"])
        return False
