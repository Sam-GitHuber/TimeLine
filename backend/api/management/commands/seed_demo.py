"""Seed a small but *complete* demo world for local testing.

Hand-made test users used to live only as rows in the dev database volume, so a
bulk user-delete wiped them with no way to get them back. This command makes
that world reproducible — and exercises a bit of every feature built so far
(Phases 3–6a): connected *and* unconnected people, a pending connection request,
personal posts with a threaded comment, profiles/bios, two groups (with an
active member set + a pending invite), group posts, 1:1 messages with an unread
badge, and two group chats — one fully active, one with a pending participant
who's locked out until they connect.

Usage (from the repo root):
    docker compose exec backend python manage.py seed_demo

**Idempotent by rebuild:** each run first deletes the demo accounts (by their
``@example.com`` emails) and the named demo groups, then recreates everything
fresh — so re-running is a reliable reset and never piles up duplicates. It only
touches those demo rows; your superuser and any real data are left alone.

The accounts are **active** (unlike real sign-ups, which are pending until an
admin approves them) so you can log straight in. Dev-only convenience — never
run it against a real deployment.
"""

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from api.models import (
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Group,
    GroupMembership,
    Message,
    Participant,
    Post,
)
from api.views import (
    ACTIVE_P,
    PENDING_P,
    _ensure_direct_participants,
    activate,
    promote_participants,
)

User = get_user_model()

DEFAULT_PASSWORD = "demo-pass-123"  # nosec B105 — dev-only seed accounts

# (email, first, last, bio) — the demo cast.
DEMO_USERS = [
    ("alice@example.com", "Alice", "Anderson", "Weekend hiker and keen photographer."),
    ("bob@example.com", "Bob", "Baker", "Baker by name, baker by trade."),
    ("carol@example.com", "Carol", "Clarke", "Book lover. Always mid-chapter."),
    ("dave@example.com", "Dave", "Davies", ""),
    ("erin@example.com", "Erin", "Evans", "New here — say hi!"),
    ("frank@example.com", "Frank", "Foster", ""),
]

DEMO_GROUP_NAMES = ["Weekend Hikers", "Book Club"]


class Command(BaseCommand):
    help = "Rebuild a complete demo world (people, groups, posts, messages, chats)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--password",
            default=DEFAULT_PASSWORD,
            help=f"Password for every demo account (default: {DEFAULT_PASSWORD!r}).",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        password = options["password"]
        emails = [u[0] for u in DEMO_USERS]

        # --- Clean slate: drop prior demo rows so a re-run is a reset. ---------
        # Order matters. Standalone group chats have group=NULL and
        # created_by=SET_NULL, so deleting the users would leave them behind as
        # orphans (the exact junk that accumulated before this command existed).
        # So delete conversations that touch a demo user *first*, while those
        # links still resolve; then the users (cascading posts/connections/
        # memberships/messages/participants); then the named groups (Group.creator
        # is SET_NULL, so they'd otherwise survive orphaned too).
        Conversation.objects.filter(
            Q(created_by__email__in=emails)
            | Q(user_a__email__in=emails)
            | Q(user_b__email__in=emails)
            | Q(participants__user__email__in=emails)
        ).distinct().delete()
        User.objects.filter(email__in=emails).delete()
        Group.objects.filter(name__in=DEMO_GROUP_NAMES).delete()

        u = self._make_users(password)
        self._make_connections(u)
        self._make_posts_and_comments(u)
        groups = self._make_groups(u)
        self._make_direct_messages(u)
        self._make_group_chats(u, groups)

        self.stdout.write(
            self.style.SUCCESS(
                f"Demo world ready — {len(DEMO_USERS)} accounts, "
                f"password {password!r}. Log in as alice@example.com."
            )
        )

    # -- builders -----------------------------------------------------------

    def _make_users(self, password):
        users = {}
        for email, first, last, bio in DEMO_USERS:
            user = User(
                email=email, first_name=first, last_name=last,
                bio=bio, is_active=True,
            )
            user.set_password(password)
            user.save()
            users[email] = user
        self.stdout.write(f"  created {len(users)} accounts")
        return users

    def _connect(self, a, b, status):
        Connection.objects.create(requester=a, requestee=b, status=status)

    def _make_connections(self, u):
        A = Connection.Status.ACCEPTED
        P = Connection.Status.PENDING
        # Accepted: alice-bob-carol form a triangle (needed for a fully-active
        # group chat); alice-dave and dave-erin extend the graph.
        self._connect(u["alice@example.com"], u["bob@example.com"], A)
        self._connect(u["alice@example.com"], u["carol@example.com"], A)
        self._connect(u["bob@example.com"], u["carol@example.com"], A)
        self._connect(u["alice@example.com"], u["dave@example.com"], A)
        self._connect(u["dave@example.com"], u["erin@example.com"], A)
        # Pending requests (populate the requests inbox): frank→alice, carol→dave.
        self._connect(u["frank@example.com"], u["alice@example.com"], P)
        self._connect(u["carol@example.com"], u["dave@example.com"], P)
        # erin↔frank, bob↔dave, etc. are left unconnected on purpose.
        self.stdout.write("  created 5 connections + 2 pending requests")

    def _make_posts_and_comments(self, u):
        posts = {
            "alice@example.com": [
                "First! Getting the hang of TimeLine.",
                "Anyone up for a walk this weekend?",
            ],
            "bob@example.com": ["Fresh sourdough out of the oven this morning."],
            "carol@example.com": ["Just finished a great novel — recommendations?"],
            "dave@example.com": ["Testing, testing. Is this thing on?"],
            "erin@example.com": ["Hello TimeLine, I'm new here."],
        }
        first_alice_post = None
        for email, texts in posts.items():
            for text in texts:
                p = Post.objects.create(author=u[email], text=text)
                if email == "alice@example.com" and first_alice_post is None:
                    first_alice_post = p
        # A threaded comment on Alice's first post: Bob comments, Carol replies.
        c = Comment.objects.create(
            post=first_alice_post, author=u["bob@example.com"], text="Sounds good!"
        )
        Comment.objects.create(
            post=first_alice_post, author=u["carol@example.com"],
            text="I'm in too.", parent=c,
        )
        self.stdout.write("  created 6 posts + a threaded comment")

    def _make_groups(self, u):
        Role = GroupMembership.Role
        St = GroupMembership.Status
        groups = {}

        hikers = Group.objects.create(
            name="Weekend Hikers", creator=u["alice@example.com"],
            description="Where shall we walk this week?",
        )
        GroupMembership.objects.create(
            group=hikers, user=u["alice@example.com"], role=Role.ADMIN, status=St.ACTIVE
        )
        for email in ("bob@example.com", "carol@example.com"):
            GroupMembership.objects.create(
                group=hikers, user=u[email], role=Role.MEMBER, status=St.ACTIVE
            )
        # A pending invite (populates the group-invites inbox): dave.
        GroupMembership.objects.create(
            group=hikers, user=u["dave@example.com"], role=Role.MEMBER,
            status=St.INVITED, invited_by=u["alice@example.com"],
        )
        Post.objects.create(
            author=u["alice@example.com"], group=hikers,
            text="Proposing the coast path on Saturday — thoughts?",
        )
        Post.objects.create(
            author=u["bob@example.com"], group=hikers, text="I'm in, weather looks good."
        )

        book = Group.objects.create(
            name="Book Club", creator=u["carol@example.com"],
            description="One book a month.",
        )
        GroupMembership.objects.create(
            group=book, user=u["carol@example.com"], role=Role.ADMIN, status=St.ACTIVE
        )
        GroupMembership.objects.create(
            group=book, user=u["alice@example.com"], role=Role.MEMBER, status=St.ACTIVE
        )
        Post.objects.create(
            author=u["carol@example.com"], group=book,
            text="This month's pick: a nice short one to start.",
        )

        groups["hikers"], groups["book"] = hikers, book
        self.stdout.write("  created 2 groups (+ a pending invite) and 3 group posts")
        return groups

    def _send(self, convo, sender, text):
        Message.objects.create(conversation=convo, sender=sender, text=text)

    def _touch(self, convo):
        """Bump updated_at so the conversation sorts sensibly in the list."""
        Conversation.objects.filter(pk=convo.pk).update(updated_at=timezone.now())

    def _make_direct_messages(self, u):
        # alice ↔ bob, with bob left unread (no read marker → all unread for him).
        ab = Conversation.objects.create(
            user_a=u["alice@example.com"], user_b=u["bob@example.com"]
        )
        _ensure_direct_participants(ab)
        self._send(ab, u["alice@example.com"], "Hey Bob, still on for Saturday?")
        self._send(ab, u["bob@example.com"], "Definitely — what time?")
        self._send(ab, u["alice@example.com"], "Let's say 9am at the trailhead.")
        # Alice has read up to now; Bob has no marker, so his nav badge shows 2.
        ConversationRead.objects.create(
            conversation=ab, user=u["alice@example.com"], last_read_at=timezone.now()
        )
        self._touch(ab)

        # alice ↔ carol
        ac = Conversation.objects.create(
            user_a=u["alice@example.com"], user_b=u["carol@example.com"]
        )
        _ensure_direct_participants(ac)
        self._send(ac, u["carol@example.com"], "Did you finish that book I lent you?")
        self._send(ac, u["alice@example.com"], "Almost! One chapter to go.")
        self._touch(ac)
        self.stdout.write("  created 2 direct chats (bob has an unread badge)")

    def _group_chat(self, creator, invitees, title, group=None):
        now = timezone.now()
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, group=group, title=title,
            created_by=creator, updated_at=now,
        )
        creator_p = Participant.objects.create(
            conversation=convo, user=creator, status=ACTIVE_P
        )
        activate(creator_p, now)
        for invitee in invitees:
            Participant.objects.create(
                conversation=convo, user=invitee, status=PENDING_P, invited_by=creator
            )
        promote_participants(convo, now)
        return convo

    def _make_group_chats(self, u, groups):
        alice, bob = u["alice@example.com"], u["bob@example.com"]
        carol, dave = u["carol@example.com"], u["dave@example.com"]

        # 1) Fully active group chat scoped to Weekend Hikers (alice-bob-carol
        #    are a triangle, so all three promote to active).
        trail = self._group_chat(
            alice, [bob, carol], "Trail planning", group=groups["hikers"]
        )
        self._send(trail, alice, "Made us a chat for Saturday's route.")
        self._send(trail, bob, "Nice. I'll bring the map.")
        self._send(trail, carol, "And I'll sort snacks.")
        self._touch(trail)

        # 2) Standalone group chat with a PENDING participant: alice invites bob
        #    and dave, but bob↔dave aren't connected, so dave stays pending and
        #    is locked out until he connects with bob (exercises the pending
        #    panel + interval-clipped visibility).
        trip = self._group_chat(alice, [bob, dave], "Mystery trip")
        self._send(trip, alice, "Planning something — details soon!")
        self._send(trip, bob, "Ooh, intrigued.")
        self._touch(trip)
        self.stdout.write(
            "  created 2 group chats (one active trio, one with a pending member)"
        )
