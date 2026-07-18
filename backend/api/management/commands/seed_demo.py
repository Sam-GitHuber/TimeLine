"""Seed a small but *complete* demo world for local testing.

Hand-made test users used to live only as rows in the dev database volume, so a
bulk user-delete wiped them with no way to get them back. This command makes
that world reproducible — and exercises a bit of every feature built so far
(Phases 3–8b): connected *and* unconnected people, a pending connection request,
personal posts with a threaded comment and emoji reactions, profiles/bios, two
groups (with an active member set + a pending invite), group posts, 1:1 messages
with an unread badge, two group chats (one fully active, one with a pending
participant who's locked out until they connect), a spread of group **events**
in every lifecycle state with open **polls** and RSVPs, and an activity centre
holding all three notification states.

**Alice is the viewpoint character.** Log in as her: she is deliberately given
at least one *unread* item behind **every** nav badge (messages and the activity
bell) so a glance at the top bar exercises the whole nav row at once — including
the badge-width regression that once pushed the avatar out of the column. She
also sits on both sides of the event feature: she organises events of her own
*and* is an invited member of Bob's and Carol's, so you can see both the
organiser's controls and a member's view without switching accounts.

Usage (from the repo root):
    docker compose exec backend python manage.py seed_demo

**Idempotent by rebuild:** each run first deletes the demo accounts (by their
``@example.com`` emails) and the named demo groups, then recreates everything
fresh — so re-running is a reliable reset and never piles up duplicates. It only
touches those demo rows; your superuser and any real data are left alone.

Content is **back-dated** across the last couple of weeks rather than all landing
at "just now", so the feed's relative timestamps, the reverse-chronological
ordering and the calendar's past/upcoming split are all actually visible.

The accounts are **active** (unlike real sign-ups, which are pending until an
admin approves them) so you can log straight in. Dev-only convenience — never
run it against a real deployment.
"""

from datetime import time, timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from api import notifications
from api.models import (
    Comment,
    Connection,
    Conversation,
    ConversationRead,
    Event,
    EventRSVP,
    Group,
    GroupMembership,
    Message,
    Notification,
    Participant,
    Poll,
    PollOption,
    PollVote,
    Post,
    Reaction,
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

ALICE = "alice@example.com"
BOB = "bob@example.com"
CAROL = "carol@example.com"
DAVE = "dave@example.com"
ERIN = "erin@example.com"
FRANK = "frank@example.com"


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
        self.verbosity = options.get("verbosity", 1)
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
        self._make_events(u, groups)
        self._make_direct_messages(u)
        self._make_group_chats(u, groups)
        self._age_notifications(u)

        unread_notifications = Notification.objects.filter(
            recipient=u[ALICE], seen_at__isnull=True
        ).count()
        self._say(
            self.style.SUCCESS(
                f"Demo world ready — {len(DEMO_USERS)} accounts, "
                f"password {password!r}. Log in as alice@example.com "
                f"({unread_notifications} unread notifications, "
                f"{self._alice_unread_messages(u)} unread messages)."
            )
        )

    # -- helpers ------------------------------------------------------------

    def _say(self, message):
        """Progress output, silenced by ``--verbosity 0``. The tests call this
        command a dozen times; without the guard the running commentary buries
        the actual test results."""
        if getattr(self, "verbosity", 1):
            self.stdout.write(message)

    def _ago(self, **delta):
        """A timestamp in the past — the spine of the back-dating."""
        return timezone.now() - timedelta(**delta)

    def _at(self, obj, when):
        """Force an ``auto_now_add`` ``created_at`` to ``when``.

        ``auto_now_add`` overwrites whatever you pass to ``create()``, so the
        only way to back-date a row is to update it afterwards — a queryset
        ``update()`` bypasses the field's auto behaviour. Returns ``obj`` so it
        can wrap a create call inline.
        """
        type(obj).objects.filter(pk=obj.pk).update(created_at=when)
        obj.created_at = when
        return obj

    def _alice_unread_messages(self, u):
        """Alice's nav-badge message count, recomputed the way the API does, so
        the summary line can't drift from what the badge will actually show."""
        from api.views import unread_count_for, user_conversations

        alice = u[ALICE]
        read_at = dict(
            ConversationRead.objects.filter(user=alice).values_list(
                "conversation_id", "last_read_at"
            )
        )
        return sum(
            unread_count_for(c, alice, read_at.get(c.id))
            for c in user_conversations(alice)
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
        self._say(f"  created {len(users)} accounts")
        return users

    def _connect(self, a, b, status):
        return Connection.objects.create(requester=a, requestee=b, status=status)

    def _make_connections(self, u):
        A = Connection.Status.ACCEPTED
        P = Connection.Status.PENDING
        # Accepted: alice-bob-carol form a triangle (needed for a fully-active
        # group chat); alice-dave and dave-erin extend the graph.
        self._connect(u[ALICE], u[BOB], A)
        self._connect(u[ALICE], u[CAROL], A)
        self._connect(u[BOB], u[CAROL], A)
        self._connect(u[ALICE], u[DAVE], A)
        self._connect(u[DAVE], u[ERIN], A)
        # Pending requests (populate the requests inbox): frank→alice, carol→dave.
        # Frank's also gives Alice an always-on activity-centre row: the request
        # kinds are exempt from the connection gate (they necessarily come from
        # someone you're *not* yet connected with — see api/notifications.py).
        frank_req = self._connect(u[FRANK], u[ALICE], P)
        notifications.create_notification(
            u[ALICE], u[FRANK],
            Notification.Kind.CONNECTION_REQUEST, connection=frank_req,
        )
        self._connect(u[CAROL], u[DAVE], P)
        # erin↔frank, bob↔dave, etc. are left unconnected on purpose.
        self._say("  created 5 connections + 2 pending requests")

    def _make_posts_and_comments(self, u):
        # (email, text, days-ago) — back-dated so the feed reads as a real
        # reverse-chronological line rather than six posts at the same instant.
        posts = [
            (ALICE, "First! Getting the hang of TimeLine.", 12),
            (ERIN, "Hello TimeLine, I'm new here.", 9),
            (DAVE, "Testing, testing. Is this thing on?", 7),
            (CAROL, "Just finished a great novel — recommendations?", 5),
            (BOB, "Fresh sourdough out of the oven this morning.", 3),
            (ALICE, "Anyone up for a walk this weekend?", 1),
        ]
        made = {}
        for email, text, days in posts:
            p = self._at(
                Post.objects.create(author=u[email], text=text),
                self._ago(days=days),
            )
            made.setdefault(email, []).append(p)

        alice_first, alice_walk = made[ALICE]
        bob_bread = made[BOB][0]

        # A threaded comment on Alice's first post: Bob comments, Carol replies.
        # Each reply also files the notification its view would — so Alice's
        # activity centre is populated the same way the real flow populates it.
        c = self._at(
            Comment.objects.create(
                post=alice_first, author=u[BOB], text="Sounds good!"
            ),
            self._ago(days=11),
        )
        notifications.create_notification(
            u[ALICE], u[BOB], Notification.Kind.POST_REPLY, post=alice_first
        )
        reply = self._at(
            Comment.objects.create(
                post=alice_first, author=u[CAROL], text="I'm in too.", parent=c
            ),
            self._ago(days=11, hours=2),
        )
        # A *reply* notifies the parent comment's author only (Bob), not the post
        # author — mirroring the view exactly, so the demo can't teach you a rule
        # the app doesn't actually follow.
        notifications.create_notification(
            u[BOB], u[CAROL], Notification.Kind.COMMENT_REPLY, comment=reply
        )
        self._say("  created 6 posts + a threaded comment")
        self._make_reactions(u, alice_first, alice_walk, bob_bread, c)

    def _make_reactions(self, u, alice_first, alice_walk, bob_bread, bob_comment):
        """Emoji reactions on posts *and* a comment, both directions.

        Reactions are pruned per viewer (you only see reactors you're connected
        with — see docs/reference/reactions.md), so Dave's reaction below is
        deliberately from someone Bob *isn't* connected to: open Bob's bread post
        as Bob and as Alice to see the same post carry different reactor lists.
        """
        pairs = [
            # (reactor, post, emoji)
            (u[BOB], alice_first, "🎉"),
            (u[CAROL], alice_first, "👍"),
            (u[CAROL], alice_walk, "🥾"),
            (u[DAVE], alice_walk, "👍"),
            (u[ALICE], bob_bread, "😍"),
            (u[CAROL], bob_bread, "👍"),
            (u[DAVE], bob_bread, "🔥"),  # Dave↔Bob unconnected: hidden from Bob
        ]
        for reactor, post, emoji in pairs:
            Reaction.objects.create(user=reactor, post=post, emoji=emoji)
            notifications.create_notification(
                post.author, reactor, Notification.Kind.REACTION, post=post
            )
        # A reaction on a *comment* (the other half of the XOR target).
        Reaction.objects.create(user=u[ALICE], comment=bob_comment, emoji="👍")
        notifications.create_notification(
            bob_comment.author, u[ALICE],
            Notification.Kind.REACTION, comment=bob_comment,
        )
        self._say("  created 8 reactions (7 on posts, 1 on a comment)")

    def _make_groups(self, u):
        Role = GroupMembership.Role
        St = GroupMembership.Status
        groups = {}

        hikers = Group.objects.create(
            name="Weekend Hikers", creator=u[ALICE],
            description="Where shall we walk this week?",
        )
        GroupMembership.objects.create(
            group=hikers, user=u[ALICE], role=Role.ADMIN, status=St.ACTIVE
        )
        for email in (BOB, CAROL):
            GroupMembership.objects.create(
                group=hikers, user=u[email], role=Role.MEMBER, status=St.ACTIVE
            )
        # A pending invite (populates the group-invites inbox): dave. Like the
        # connection request, it files an always-on notification for him.
        GroupMembership.objects.create(
            group=hikers, user=u[DAVE], role=Role.MEMBER,
            status=St.INVITED, invited_by=u[ALICE],
        )
        notifications.create_notification(
            u[DAVE], u[ALICE], Notification.Kind.GROUP_INVITE, group=hikers
        )
        self._at(
            Post.objects.create(
                author=u[ALICE], group=hikers,
                text="Proposing the coast path on Saturday — thoughts?",
            ),
            self._ago(days=4),
        )
        self._at(
            Post.objects.create(
                author=u[BOB], group=hikers, text="I'm in, weather looks good."
            ),
            self._ago(days=4, hours=-3),
        )

        book = Group.objects.create(
            name="Book Club", creator=u[CAROL],
            description="One book a month.",
        )
        GroupMembership.objects.create(
            group=book, user=u[CAROL], role=Role.ADMIN, status=St.ACTIVE
        )
        GroupMembership.objects.create(
            group=book, user=u[ALICE], role=Role.MEMBER, status=St.ACTIVE
        )
        self._at(
            Post.objects.create(
                author=u[CAROL], group=book,
                text="This month's pick: a nice short one to start.",
            ),
            self._ago(days=6),
        )

        groups["hikers"], groups["book"] = hikers, book
        self._say("  created 2 groups (+ a pending invite) and 3 group posts")
        return groups

    # -- events, polls & RSVPs (Phase 8b) -----------------------------------

    def _event(self, group, organiser, title, *, days=None, start=None,
               end=None, description="", location_name="", location_note="",
               cancelled=False):
        """Create an event, deriving ``status`` the way the view does.

        ``days`` is an offset from today (negative = in the past); leaving it
        ``None`` means no date at all, which is exactly what keeps an event in
        ``planning`` — the "being planned" strip, off the line. A date makes it
        ``scheduled``. ``cancelled`` overrides both (cancel is terminal).
        """
        event_date = None if days is None else timezone.localdate() + timedelta(days=days)
        if cancelled:
            status = Event.Status.CANCELLED
        else:
            status = (
                Event.Status.SCHEDULED if event_date else Event.Status.PLANNING
            )
        return Event.objects.create(
            group=group, organiser=organiser, title=title,
            description=description, event_date=event_date,
            start_time=start, end_time=end, timezone="Europe/London",
            location_name=location_name, location_note=location_note,
            status=status,
        )

    def _poll(self, event, dimension, question, options, *, allow_multiple=None,
              status=Poll.Status.OPEN, notify=True):
        """Open a poll with its options.

        ``allow_multiple`` defaults the way the view does: date/time polls are
        "pick every option you can do" (the when2meet behaviour), location and
        custom polls are single-choice. Returns ``{label: PollOption}`` alongside
        the poll so votes below read as prose.
        """
        if allow_multiple is None:
            allow_multiple = dimension in (Poll.Dimension.DATE, Poll.Dimension.TIME)
        poll = Poll.objects.create(
            event=event, dimension=dimension, question=question,
            allow_multiple=allow_multiple, status=status,
            created_by=event.organiser,
        )
        made = {}
        for order, (label, value) in enumerate(options):
            kwargs = {"date_value": None, "time_value": None, "text_value": ""}
            if dimension == Poll.Dimension.DATE:
                kwargs["date_value"] = timezone.localdate() + timedelta(days=value)
            elif dimension == Poll.Dimension.TIME:
                kwargs["time_value"] = value
            else:
                kwargs["text_value"] = value
            made[label] = PollOption.objects.create(
                poll=poll, label=label, order=order, **kwargs
            )
        if notify and status == Poll.Status.OPEN:
            self._notify_event(event, Notification.Kind.POLL_OPENED)
        return poll, made

    def _vote(self, option, *voters):
        for voter in voters:
            PollVote.objects.create(option=option, voter=voter)

    def _rsvp(self, event, user, response, *, guests=0, note=""):
        EventRSVP.objects.create(
            event=event, user=user, response=response, guests=guests, note=note
        )

    def _notify_event(self, event, kind, recipients=None):
        """File an event notification per recipient, defaulting to the event's
        audience (active group members other than the organiser). The choke-point
        in api/notifications.py drops anyone not connected to the organiser, so
        this lands on exactly the people who can see the event — no gating logic
        duplicated here."""
        if recipients is None:
            recipients = User.objects.filter(
                group_memberships__group=event.group,
                group_memberships__status=GroupMembership.Status.ACTIVE,
            ).exclude(id=event.organiser_id).distinct()
        for recipient in recipients:
            notifications.create_notification(
                recipient, event.organiser, kind, event=event
            )

    def _make_events(self, u, groups):
        """A spread of events covering every lifecycle state, both viewpoints.

        The point of the spread is that **Alice** can see the whole feature from
        one login. She organises two (so you get the organiser's controls: open a
        poll, close it, finalise a dimension), and Bob and Carol each organise one
        she's merely a member of (so you get the member's view: vote, RSVP, and an
        activity-centre row you didn't cause). A past and a cancelled event round
        out the states — a past event falls into the group timeline as a memory, a
        cancelled one stays as a tombstone.
        """
        R = EventRSVP.Response
        D = Poll.Dimension
        alice, bob, carol = u[ALICE], u[BOB], u[CAROL]
        hikers, book = groups["hikers"], groups["book"]

        # 1) Alice's settled event: date + time + location all set, nothing left
        #    to poll. The "finished planning" end state.
        coast = self._event(
            hikers, alice, "Coast path walk",
            days=3, start=time(9, 0), end=time(15, 0),
            description="Nine miles, cliffs the whole way. Bring layers.",
            location_name="Trailhead car park",
            location_note="Park at the far end — the near one fills up.",
        )
        self._notify_event(coast, Notification.Kind.EVENT_CREATED)
        self._notify_event(coast, Notification.Kind.EVENT_SCHEDULED)
        self._rsvp(coast, bob, R.GOING, guests=1, note="Bringing my brother.")
        self._rsvp(coast, carol, R.MAYBE)

        # 2) Alice's event still being planned: no date, an **open date poll**
        #    she owns. This is the one to try "close the poll, then set the date"
        #    on — the two distinct organiser actions polls are built around.
        camping = self._event(
            hikers, alice, "Autumn camping weekend",
            description="Two nights somewhere with a view. Which weekend suits?",
        )
        self._notify_event(camping, Notification.Kind.EVENT_CREATED)
        _, camp_dates = self._poll(
            camping, D.DATE, "Which weekend can you do?",
            [("Fri 12th", 12), ("Fri 19th", 19), ("Fri 26th", 26)],
        )
        # Multi-choice: Bob can do two of the three, Carol only the last.
        self._vote(camp_dates["Fri 12th"], bob)
        self._vote(camp_dates["Fri 19th"], bob)
        self._vote(camp_dates["Fri 26th"], bob, carol)

        # 3) **Bob's** event — the member's-eye view. Two open polls Alice hasn't
        #    voted in yet, so her event page opens on the un-voted state, and its
        #    creation/polls give her activity-centre rows she didn't cause.
        maps = self._event(
            hikers, bob, "Sourdough & maps evening",
            description="Route planning over bread. I'll do the bread.",
        )
        self._notify_event(maps, Notification.Kind.EVENT_CREATED)
        _, maps_dates = self._poll(
            maps, D.DATE, "Which evening works?",
            [("Tue 8th", 8), ("Wed 9th", 9), ("Thu 10th", 10)],
        )
        self._vote(maps_dates["Wed 9th"], carol)
        self._vote(maps_dates["Thu 10th"], carol)
        _, maps_where = self._poll(
            maps, D.LOCATION, "Whose kitchen?",
            [("Bob's", "Bob's place"), ("Carol's", "Carol's place")],
        )
        self._vote(maps_where["Bob's"], carol)

        # 4) A **past** event — drops out of "upcoming" and falls into the group
        #    timeline among the posts as a memory (docs/reference/events.md).
        past = self._event(
            hikers, alice, "Hill loop", days=-10, start=time(10, 30),
            location_name="Village green",
        )
        self._rsvp(past, bob, R.GOING)
        self._rsvp(past, carol, R.GOING)

        # 5) A **cancelled** event — a tombstone, kept so RSVP'd members learn
        #    the plan is off. Carol organises it and Alice had said yes, so Alice
        #    gets the cancellation notification (the cancel audience is the
        #    going/maybe RSVPs, not the whole group).
        night = self._event(
            hikers, carol, "Night walk", days=14, start=time(20, 0),
            cancelled=True,
        )
        self._rsvp(night, alice, R.GOING)
        self._notify_event(
            night, Notification.Kind.EVENT_CANCELLED, recipients=[alice]
        )

        # 6) A **second group's** event, so Alice's personal /calendar unions two
        #    groups rather than mirroring one. Carol organises; an open custom
        #    poll shows the informational dimension (no structured field behind
        #    it — the organiser just pins a winning option as the decision).
        meet = self._event(
            book, carol, "Book club meet-up",
            days=9, start=time(19, 30),
            location_name="The Reading Room",
        )
        self._notify_event(meet, Notification.Kind.EVENT_CREATED)
        self._notify_event(meet, Notification.Kind.EVENT_SCHEDULED)
        self._poll(
            meet, D.CUSTOM, "What should we read next?",
            [
                ("Something short", "Something short"),
                ("Something long", "Something long"),
                ("Dealer's choice", "Dealer's choice"),
            ],
        )
        self._rsvp(meet, alice, R.GOING)

        # 7) A **closed** poll on the settled event — the trace of how its 9am
        #    start got decided. Having one closed poll already on screen means
        #    the closed-tally state is visible without closing one by hand, and
        #    it shows a poll and its finalised dimension side by side: the tally
        #    informed, Alice decided (polls never auto-decide).
        _, coast_times = self._poll(
            coast, D.TIME, "What time shall we start?",
            [("9am", time(9, 0)), ("10am", time(10, 0))],
            status=Poll.Status.CLOSED, notify=False,
        )
        self._vote(coast_times["9am"], bob, carol)
        self._vote(coast_times["10am"], carol)

        self._say(
            "  created 6 events (scheduled / planning / past / cancelled), "
            "5 polls and 6 RSVPs"
        )

    def _send(self, convo, sender, text, at=None):
        """Post a message, optionally back-dated.

        Back-dating matters for more than looks: a read marker is a *timestamp*,
        so "read up to here, then two more arrived" can only be expressed if the
        messages sit at distinct, known times.
        """
        msg = Message.objects.create(conversation=convo, sender=sender, text=text)
        return self._at(msg, at) if at else msg

    def _read_to(self, convo, user, at):
        """Mark ``user`` as having read ``convo`` up to ``at``. Anything sent by
        someone else after that point is what their nav badge counts."""
        ConversationRead.objects.update_or_create(
            conversation=convo, user=user, defaults={"last_read_at": at}
        )

    def _touch(self, convo, at=None):
        """Set updated_at so the conversation sorts sensibly in the list."""
        Conversation.objects.filter(pk=convo.pk).update(
            updated_at=at or timezone.now()
        )

    def _direct(self, a, b, hours_ago):
        """A 1:1 conversation created ``hours_ago``.

        The back-dating has to happen **before** the participant rows are wired:
        a direct chat's intervals open at ``convo.created_at``, so a chat created
        "now" would clip every back-dated message below out of both participants'
        visible sets — the thread would render empty.
        """
        convo = Conversation.objects.create(user_a=a, user_b=b)
        self._at(convo, self._ago(hours=hours_ago))
        _ensure_direct_participants(convo)
        return convo

    def _make_direct_messages(self, u):
        alice, bob, carol = u[ALICE], u[BOB], u[CAROL]

        def ago(hours):
            return self._ago(hours=hours)

        # alice ↔ bob: Bob has no read marker at all, so everything Alice sent is
        # unread for him — the "never opened it" case (badge of 2).
        ab = self._direct(alice, bob, 50)
        self._send(ab, alice, "Hey Bob, still on for Saturday?", ago(48))
        self._send(ab, bob, "Definitely — what time?", ago(47))
        self._send(ab, alice, "Let's say 9am at the trailhead.", ago(26))
        self._read_to(ab, alice, ago(20))
        self._touch(ab, ago(26))

        # alice ↔ carol: Alice read it, *then* Carol sent one more — the "read up
        # to here" case, and one of the two unread messages behind her nav badge.
        ac = self._direct(alice, carol, 74)
        self._send(ac, carol, "Did you finish that book I lent you?", ago(72))
        self._send(ac, alice, "Almost! One chapter to go.", ago(70))
        self._read_to(ac, alice, ago(69))
        self._send(ac, carol, "No rush — but the club meets Thursday!", ago(5))
        self._touch(ac, ago(5))
        self._say("  created 2 direct chats (alice and bob each have unread)")

    def _group_chat(self, creator, invitees, title, group=None, at=None):
        """Create a group chat as of ``at`` (default now).

        The timestamp is threaded through deliberately: participation is stored
        as **intervals**, and a message sent before your interval opened isn't
        visible to you (see docs/reference/messaging.md). Back-dating the
        messages without also back-dating the chat's creation would silently clip
        every one of them out of view.
        """
        at = at or timezone.now()
        convo = Conversation.objects.create(
            kind=Conversation.Kind.GROUP, group=group, title=title,
            created_by=creator, updated_at=at,
        )
        creator_p = Participant.objects.create(
            conversation=convo, user=creator, status=ACTIVE_P
        )
        activate(creator_p, at)
        for invitee in invitees:
            Participant.objects.create(
                conversation=convo, user=invitee, status=PENDING_P, invited_by=creator
            )
        promote_participants(convo, at)
        return convo

    def _make_group_chats(self, u, groups):
        alice, bob = u[ALICE], u[BOB]
        carol, dave = u[CAROL], u[DAVE]

        # 1) Fully active group chat scoped to Weekend Hikers (alice-bob-carol
        #    are a triangle, so all three promote to active). Alice read it, then
        #    Carol replied — her second unread message, and the one that makes
        #    the badge come from more than a single thread.
        trail = self._group_chat(
            alice, [bob, carol], "Trail planning", group=groups["hikers"],
            at=self._ago(hours=120),
        )
        self._send(trail, alice, "Made us a chat for Saturday's route.",
                   self._ago(hours=119))
        self._send(trail, bob, "Nice. I'll bring the map.", self._ago(hours=96))
        self._read_to(trail, alice, self._ago(hours=95))
        self._send(trail, carol, "And I'll sort snacks.", self._ago(hours=8))
        self._touch(trail, self._ago(hours=8))

        # 2) Standalone group chat with a PENDING participant: alice invites bob
        #    and dave, but bob↔dave aren't connected, so dave stays pending and
        #    is locked out until he connects with bob (exercises the pending
        #    panel + interval-clipped visibility).
        trip = self._group_chat(alice, [bob, dave], "Mystery trip",
                                at=self._ago(hours=144))
        self._send(trip, alice, "Planning something — details soon!",
                   self._ago(hours=143))
        self._send(trip, bob, "Ooh, intrigued.", self._ago(hours=142))
        self._read_to(trip, alice, self._ago(hours=141))
        self._touch(trip, self._ago(hours=142))
        self._say(
            "  created 2 group chats (one active trio, one with a pending member)"
        )

    def _age_notifications(self, u):
        """Spread Alice's activity centre across all three notification states.

        The centre keeps a notification rather than dropping it once glanced at
        (docs/reference/notifications.md): **unread** is bold and counts toward
        the bell badge, **seen** has had the badge cleared but still stands out,
        **addressed** has been acted on and is dulled but retained. Seeding only
        unread rows would leave two thirds of that UI unexercised — and leave the
        badge with a two-digit count that says nothing useful.

        The rows are back-dated to match the content they point at, so the centre
        reads as a history rather than a pile of "just now".
        """
        alice = u[ALICE]
        now = timezone.now()
        rows = list(
            Notification.objects.filter(recipient=alice).order_by("id")
        )
        # The oldest third is long dealt with, the next third glanced at, and the
        # newest left unread — which is what the bell badge counts.
        addressed = rows[: len(rows) // 3]
        seen = rows[len(rows) // 3: (2 * len(rows)) // 3]
        for i, n in enumerate(addressed):
            when = now - timedelta(days=11, hours=i)
            Notification.objects.filter(pk=n.pk).update(
                created_at=when, seen_at=when, addressed_at=when
            )
        for i, n in enumerate(seen):
            when = now - timedelta(days=5, hours=i)
            Notification.objects.filter(pk=n.pk).update(
                created_at=when, seen_at=when
            )
        self._say(
            f"  aged alice's activity centre: {len(addressed)} addressed, "
            f"{len(seen)} seen, {len(rows) - len(addressed) - len(seen)} unread"
        )
