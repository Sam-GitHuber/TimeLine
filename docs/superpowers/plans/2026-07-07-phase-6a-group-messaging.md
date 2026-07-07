# Phase 6a — Group Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Phase 5 direct messaging into N-participant group chats (standalone and Phase 6 group-scoped), gated so every active member is mutually connected.

**Architecture:** Generalise the pair-shaped `Conversation` into a participant set via new `Participant` + `ParticipantInterval` tables (kept additive so Phase 5 stays green through the refactor), add a small event-driven membership state machine (promote / sever / interval-clipped history), then extend the existing REST endpoints and the messaging companion drawer. Real-time stays polling.

**Tech Stack:** Django 5 / DRF (backend, Postgres), React + TanStack Query + Vite/Vitest (frontend). Cookie auth with CSRF. No new dependencies.

## Global Constraints

- **Database is PostgreSQL** — `DISTINCT ON` and partial/expression constraints are allowed and used.
- **No new dependencies** (backend or frontend) — `docs/SHARED.md` requires raising stack changes first.
- **Tests every phase** — backend `APITestCase` in `backend/api/tests.py`; frontend Vitest in `frontend/src/*.test.jsx`. Both suites must stay green after every task.
- **Backend test command:** from `backend/`, `uv run python manage.py test api` (single test: `uv run python manage.py test api.tests.ClassName.test_method`).
- **Frontend test command:** from `frontend/`, `npm test` (single file: `npm test -- src/messaging.test.jsx`).
- **Branch + PR, never commit to `main`.** All work is on branch `phase-6a-group-messaging` (already created).
- **Polling cadence lives only in `frontend/src/api.js`** (`MESSAGE_POLL_MS`, `CONVERSATION_LIST_POLL_MS`) — reuse it; add no realtime infra.
- **The clique invariant is non-negotiable:** the set of `active` participants in any chat is always fully mutually-connected. Every membership change re-derives this; never do a maximal-clique search — apply the event rules in this plan.
- **Constants** already defined at the top of `backend/api/views.py`: `ACCEPTED`, `PENDING` (connection), `ACTIVE`, `INVITED`, `ADMIN`, `MEMBER` (group). Reuse them; add participant-status constants in Task 3.
- **Time:** always `django.utils.timezone.now()`; store times, never derive "now" in the DB layer for interval logic.

---

## File map

**Backend (all in `backend/api/`)**
- `models.py` — extend `Conversation`; add `Participant`, `ParticipantInterval`.
- `migrations/0008_group_messaging.py` — schema (new tables + Conversation fields).
- `migrations/0009_backfill_participants.py` — data migration for existing 1:1 threads.
- `views.py` — new helpers (`participant_ids`, `active_participant_ids`, `promote_participants`, `sever_shared_chats`, `visible_messages_for`, `must_connect_with`, `chat_display_for`); rework `user_conversations` / `decorate_conversations` / conversation views to be participant-based; new views (`ConversationParticipantsView`, `ConversationLeaveView`, `DisconnectImpactView`); hooks in `ConnectView`, `BlockView`, `ConnectionRequestActionView`, `GroupMemberDetailView`.
- `serializers.py` — rework `ConversationSerializer` (participant-based) + add `ParticipantSerializer`.
- `urls.py` — routes for participants / leave / disconnect-impact.
- `tests.py` — new `APITestCase` classes.

**Frontend (all in `frontend/src/`)**
- `api.js` — new API methods (create group chat, participants, leave, disconnect-impact).
- `messaging.jsx` — provider: carry group-chat creation context (preselected group / participants).
- `components/MessagesDrawer.jsx` — list (group rows + pending style), thread (group header, pending locked panel, add/leave), multi-select new-chat.
- `components/NewChatPicker.jsx` *(new)* — multi-select connection picker.
- `components/PendingChatPanel.jsx` *(new)* — locked "connect with X & Y" + decline.
- `components/DisconnectWarningModal.jsx` *(new)* — lists chats a disconnect/block removes you from.
- `components/ConnectButton.jsx`, `components/BlockButton.jsx` — call the warning modal before disconnect/block.
- `components/GroupsDrawer.jsx` — "Start a chat" entry scoped to the group.
- `messaging.test.jsx`, `groups.test.jsx` — extend.

---

## Task 1: Data model — Conversation fields + Participant/ParticipantInterval tables

**Files:**
- Modify: `backend/api/models.py` (the `Conversation` class, ~203-255)
- Create: `backend/api/migrations/0008_group_messaging.py` (generated)
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: `Conversation.kind` (`"direct"|"group"`), `Conversation.group` (FK→Group, nullable, `CASCADE`), `Conversation.title` (str, blank), `Conversation.created_by` (FK→User, nullable). `Participant(conversation, user, status, invited_by, left_at, created_at)` with `status ∈ {"active","pending"}`, unique `(conversation, user)`. `ParticipantInterval(participant, started_at, ended_at)`.

- [ ] **Step 1: Write the failing test**

Add to `backend/api/tests.py` (import `Participant, ParticipantInterval` from `.models` at the top alongside the existing model imports):

```python
class GroupChatModelTests(APITestCase):
    def test_conversation_defaults_to_direct_kind(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        convo = Conversation.objects.create(user_a=a, user_b=b)
        self.assertEqual(convo.kind, "direct")
        self.assertIsNone(convo.group)

    def test_participant_and_interval_round_trip(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        convo = Conversation.objects.create(kind="group", created_by=a)
        p = Participant.objects.create(conversation=convo, user=a, status="active")
        ParticipantInterval.objects.create(participant=p, started_at=timezone.now())
        self.assertEqual(convo.participants.count(), 1)
        self.assertEqual(p.intervals.count(), 1)
        self.assertIsNone(p.intervals.first().ended_at)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatModelTests`
Expected: FAIL — `ImportError: cannot import name 'Participant'`.

- [ ] **Step 3: Extend `Conversation` and add the new models**

In `backend/api/models.py`, add to the `Conversation` class body (keep `user_a`/`user_b` and both constraints — they stay through the migration window; make the FKs nullable so group chats can omit them):

```python
    class Kind(models.TextChoices):
        DIRECT = "direct", "Direct"
        GROUP = "group", "Group"

    kind = models.CharField(
        max_length=6, choices=Kind.choices, default=Kind.DIRECT, db_index=True
    )
    # A group chat scoped to a Phase 6 Group. NULL = standalone (1:1 or ad-hoc
    # multi-person). CASCADE: deleting a group deletes its chats (agreed 2026-07-07).
    group = models.ForeignKey(
        "Group", on_delete=models.CASCADE, null=True, blank=True,
        related_name="chats",
    )
    title = models.CharField(max_length=100, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="conversations_created",
    )
```

Change the `user_a`/`user_b` fields to add `null=True, blank=True` (a group chat has no pair). Then, after the `Block` class, add:

```python
class Participant(models.Model):
    """One person's membership of a conversation (Phase 6a).

    Generalises Phase 5's user_a/user_b pair into a set. ``status`` is the
    current state: ``active`` (in the chat, counts toward the clique) or
    ``pending`` (invited but not yet connected to every active member).
    ``left_at`` tombstones a self-leave/decline. History visibility is *not* a
    single join point — see ``ParticipantInterval``.
    """

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        PENDING = "pending", "Pending"

    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="chat_participations",
    )
    status = models.CharField(
        max_length=7, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="chat_invites_sent",
    )
    left_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["conversation", "user"], name="unique_conversation_participant"
            ),
        ]

    def __str__(self):
        return f"{self.user} · {self.conversation_id} ({self.status})"


class ParticipantInterval(models.Model):
    """A span during which a participant was ``active`` (Phase 6a).

    A message is visible to a participant iff its ``created_at`` falls inside one
    of their intervals. Becoming active opens an interval; dropping to pending /
    leaving closes it (``ended_at``); returning opens a new one — so a
    blocked-then-returned member keeps pre-gap history and never sees the gap.
    """

    participant = models.ForeignKey(
        Participant, on_delete=models.CASCADE, related_name="intervals"
    )
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["started_at", "id"]

    def __str__(self):
        return f"{self.participant_id}: {self.started_at} → {self.ended_at or '…'}"
```

- [ ] **Step 4: Make the migration**

Run: `cd backend && uv run python manage.py makemigrations api --name group_messaging`
Expected: creates `backend/api/migrations/0008_group_messaging.py` altering `Conversation` and adding two models.

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatModelTests`
Expected: PASS (2 tests).

- [ ] **Step 6: Full suite stays green**

Run: `cd backend && uv run python manage.py test api`
Expected: PASS — the new fields are optional, so Phase 5/6 tests are unaffected.

- [ ] **Step 7: Commit**

```bash
git add backend/api/models.py backend/api/migrations/0008_group_messaging.py backend/api/tests.py
git commit -m "feat(6a): Conversation fields + Participant/ParticipantInterval models"
```

---

## Task 2: Data migration — backfill participants for existing 1:1 threads

**Files:**
- Create: `backend/api/migrations/0009_backfill_participants.py`
- Test: `backend/api/tests.py`

**Interfaces:**
- Consumes: models from Task 1.
- Produces: every pre-existing `Conversation` has two `active` `Participant` rows, each with one open `ParticipantInterval(started_at = conversation.created_at, ended_at=None)`, and `kind="direct"`.

- [ ] **Step 1: Write the failing test**

Add to `backend/api/tests.py`:

```python
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


class BackfillParticipantsMigrationTests(APITestCase):
    def test_existing_conversation_gets_two_active_participants(self):
        # A conversation created "before" the backfill (rows already exist).
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        convo = Conversation.objects.create(user_a=a, user_b=b)
        Participant.objects.filter(conversation=convo).delete()  # simulate pre-migration

        # Re-run the data migration's forward function directly.
        from api.migrations import _backfill  # helper module below
        _backfill(Conversation, Participant, ParticipantInterval)

        parts = Participant.objects.filter(conversation=convo)
        self.assertEqual(parts.count(), 2)
        self.assertTrue(all(p.status == "active" for p in parts))
        for p in parts:
            iv = p.intervals.get()
            self.assertEqual(iv.started_at, convo.created_at)
            self.assertIsNone(iv.ended_at)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.BackfillParticipantsMigrationTests`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.migrations._backfill'`.

- [ ] **Step 3: Write the backfill helper + migration**

Create `backend/api/migrations/_backfill.py` (a plain importable module so the logic is unit-testable, called by the migration):

```python
def backfill(Conversation, Participant, ParticipantInterval):
    """Give every existing conversation two active participants + open intervals."""
    for convo in Conversation.objects.all().iterator():
        for user_id in (convo.user_a_id, convo.user_b_id):
            if user_id is None:
                continue
            participant, created = Participant.objects.get_or_create(
                conversation_id=convo.id, user_id=user_id,
                defaults={"status": "active"},
            )
            if created:
                ParticipantInterval.objects.create(
                    participant=participant, started_at=convo.created_at, ended_at=None,
                )
    Conversation.objects.filter(kind="").update(kind="direct")


# Callable used by the test with real model classes.
def _backfill(Conversation, Participant, ParticipantInterval):
    return backfill(Conversation, Participant, ParticipantInterval)
```

Create `backend/api/migrations/0009_backfill_participants.py`:

```python
from django.db import migrations

from api.migrations._backfill import backfill


def forwards(apps, schema_editor):
    backfill(
        apps.get_model("api", "Conversation"),
        apps.get_model("api", "Participant"),
        apps.get_model("api", "ParticipantInterval"),
    )


def backwards(apps, schema_editor):
    apps.get_model("api", "Participant").objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [("api", "0008_group_messaging")]
    operations = [migrations.RunPython(forwards, backwards)]
```

Add `from api.migrations import _backfill  # noqa` importability by ensuring the test import path is `from api.migrations._backfill import _backfill`. Update the test's import line to `from api.migrations._backfill import _backfill`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.BackfillParticipantsMigrationTests`
Expected: PASS.

- [ ] **Step 5: Full suite green + migrations apply cleanly**

Run: `cd backend && uv run python manage.py migrate && uv run python manage.py test api`
Expected: migrations apply; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/api/migrations/0009_backfill_participants.py backend/api/migrations/_backfill.py backend/api/tests.py
git commit -m "feat(6a): backfill participants for existing conversations"
```

---

## Task 3: Membership helpers (state machine core)

**Files:**
- Modify: `backend/api/views.py` (add near `can_message`, ~line 118; import `Participant`, `ParticipantInterval` in the `.models` import block)
- Test: `backend/api/tests.py`

**Interfaces:**
- Consumes: `connected_user_ids`, `can_message` (existing).
- Produces:
  - `ACTIVE_P = Participant.Status.ACTIVE`, `PENDING_P = Participant.Status.PENDING`.
  - `active_participant_ids(convo) -> set[int]`
  - `participant_user_ids(convo) -> set[int]` (active + pending, not left)
  - `open_interval(participant)` / `close_intervals(participant, when)`
  - `activate(participant, when)` — set active + open interval (idempotent)
  - `deactivate(participant, when)` — set pending + close open interval
  - `promote_participants(convo, when)` — one-at-a-time re-check promotion sweep
  - `must_connect_with(convo, user) -> list[User]` — active members `user` isn't connected to
  - `visible_messages_for(convo, user)` — messages queryset clipped to `user`'s intervals

- [ ] **Step 1: Write the failing tests**

Add to `backend/api/tests.py` a helper to build a connection and a chat, then:

```python
from api.views import (
    activate, active_participant_ids, deactivate, must_connect_with,
    promote_participants, visible_messages_for,
)


class MembershipHelperTests(APITestCase):
    def _connect(self, u1, u2):
        Connection.objects.create(requester=u1, requestee=u2, status="accepted")

    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD)

    def test_promote_requires_connection_to_all_actives(self):
        # a connected to b and c; b and c NOT connected to each other.
        self._connect(self.a, self.b)
        self._connect(self.a, self.c)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        pa = Participant.objects.create(conversation=convo, user=self.a, status="active")
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        Participant.objects.create(conversation=convo, user=self.b, status="pending")
        Participant.objects.create(conversation=convo, user=self.c, status="pending")

        promote_participants(convo, timezone.now())

        # First pending connected to all actives {a} → promotes (now active {a,b}).
        # Second pending must connect to {a,b}; not connected to b → stays pending.
        actives = active_participant_ids(convo)
        self.assertEqual(len(actives), 2)
        self.assertIn(self.a.id, actives)

    def test_must_connect_with_lists_unconnected_actives(self):
        self._connect(self.a, self.b)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        for u, st in [(self.a, "active"), (self.b, "active"), (self.c, "pending")]:
            p = Participant.objects.create(conversation=convo, user=u, status=st)
            if st == "active":
                ParticipantInterval.objects.create(participant=p, started_at=timezone.now())
        # c is connected to nobody active → must connect with a and b.
        ids = {u.id for u in must_connect_with(convo, self.c)}
        self.assertEqual(ids, {self.a.id, self.b.id})

    def test_visible_messages_clipped_to_intervals(self):
        self._connect(self.a, self.b)
        convo = Conversation.objects.create(kind="group", created_by=self.a)
        pa = Participant.objects.create(conversation=convo, user=self.a, status="active")
        pb = Participant.objects.create(conversation=convo, user=self.b, status="active")
        ParticipantInterval.objects.create(participant=pa, started_at=timezone.now())
        t0 = timezone.now()
        ib = ParticipantInterval.objects.create(participant=pb, started_at=t0)
        m1 = Message.objects.create(conversation=convo, sender=self.a, text="in")
        # Close b's interval, send a gap message, reopen.
        deactivate(pb, timezone.now())
        m_gap = Message.objects.create(conversation=convo, sender=self.a, text="gap")
        activate(pb, timezone.now())
        m2 = Message.objects.create(conversation=convo, sender=self.a, text="back")

        visible_ids = set(visible_messages_for(convo, self.b).values_list("id", flat=True))
        self.assertIn(m1.id, visible_ids)
        self.assertNotIn(m_gap.id, visible_ids)
        self.assertIn(m2.id, visible_ids)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run python manage.py test api.tests.MembershipHelperTests`
Expected: FAIL — `ImportError` on the helper names.

- [ ] **Step 3: Implement the helpers**

Add to `backend/api/views.py` (below `can_message`). Add `Participant`, `ParticipantInterval` to the `.models` import block first.

```python
ACTIVE_P = Participant.Status.ACTIVE
PENDING_P = Participant.Status.PENDING


def active_participant_ids(convo):
    return set(
        convo.participants.filter(status=ACTIVE_P, left_at__isnull=True)
        .values_list("user_id", flat=True)
    )


def participant_user_ids(convo):
    return set(
        convo.participants.filter(left_at__isnull=True).values_list("user_id", flat=True)
    )


def activate(participant, when):
    """Make a participant active and open a fresh access interval (idempotent)."""
    open_iv = participant.intervals.filter(ended_at__isnull=True).exists()
    if participant.status != ACTIVE_P or participant.left_at is not None:
        participant.status = ACTIVE_P
        participant.left_at = None
        participant.save(update_fields=["status", "left_at"])
    if not open_iv:
        ParticipantInterval.objects.create(participant=participant, started_at=when)


def deactivate(participant, when):
    """Drop a participant to pending and close any open interval."""
    participant.intervals.filter(ended_at__isnull=True).update(ended_at=when)
    if participant.status != PENDING_P:
        participant.status = PENDING_P
        participant.save(update_fields=["status"])


def promote_participants(convo, when):
    """Promote every pending participant now connected to all current active
    members — one at a time, re-checking after each, so two mutually-unconnected
    pending people can't both slip in (the clique invariant holds)."""
    changed = True
    while changed:
        changed = False
        actives = active_participant_ids(convo)
        pending = convo.participants.filter(status=PENDING_P, left_at__isnull=True)
        for p in pending.select_related("user"):
            connected = connected_user_ids(p.user)
            if actives <= connected:  # connected to every active member
                activate(p, when)
                changed = True
                break  # re-derive actives before considering the next one


def must_connect_with(convo, user):
    """Active members ``user`` must still connect with to join (drives the
    locked pending panel + the 'connect with X & Y' prompt)."""
    connected = connected_user_ids(user)
    missing_ids = active_participant_ids(convo) - connected - {user.id}
    return list(User.objects.filter(id__in=missing_ids, is_active=True))


def visible_messages_for(convo, user):
    """Messages ``user`` may see: those whose created_at falls in one of their
    access intervals. Empty for a pending/never-joined participant."""
    intervals = ParticipantInterval.objects.filter(
        participant__conversation=convo, participant__user=user
    ).values_list("started_at", "ended_at")
    window = Q(pk__in=[])
    for started_at, ended_at in intervals:
        span = Q(created_at__gte=started_at)
        if ended_at is not None:
            span &= Q(created_at__lt=ended_at)
        window |= span
    return convo.messages.filter(window).select_related("sender")
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.MembershipHelperTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/api/views.py backend/api/tests.py
git commit -m "feat(6a): membership state-machine helpers (promote/intervals/visibility)"
```

---

## Task 4: Create a group chat (`POST /api/conversations/`)

**Files:**
- Modify: `backend/api/views.py` (`ConversationListCreateView.create`, ~788)
- Modify: `backend/api/serializers.py` (add `ParticipantSerializer`; extend `ConversationSerializer` in Task 5 — here just the create path)
- Test: `backend/api/tests.py`

**Interfaces:**
- Consumes: `promote_participants`, `activate`, `can_add_to_group`, `is_group_member`.
- Produces: `POST /api/conversations/` accepts either `{user_id}` (1:1, unchanged) or `{participant_ids: [...], title?, group_id?}` (group). Creator active; invitees pending then promoted. Returns `{id}` at minimum plus the serialized conversation.

- [ ] **Step 1: Write the failing tests**

```python
class CreateGroupChatTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD, first_name="A", last_name="A")
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD, first_name="B", last_name="B")
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD, first_name="C", last_name="C")
        for u in (self.b, self.c):
            Connection.objects.create(requester=self.a, requestee=u, status="accepted")
        self.client.force_authenticate(self.a)

    def test_create_group_chat_creator_active_invitees_promoted_per_clique(self):
        # b and c are NOT connected to each other.
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id], "title": "Trip"}, format="json")
        self.assertEqual(res.status_code, 201)
        convo = Conversation.objects.get(id=res.data["id"])
        self.assertEqual(convo.kind, "group")
        self.assertEqual(convo.title, "Trip")
        actives = set(convo.participants.filter(status="active").values_list("user_id", flat=True))
        # a (creator) + exactly one of b/c can be active; the other stays pending.
        self.assertIn(self.a.id, actives)
        self.assertEqual(len(actives), 2)
        self.assertEqual(convo.participants.filter(status="pending").count(), 1)

    def test_cannot_add_a_non_connection(self):
        stranger = User.objects.create_user(email="s@x.com", password=PASSWORD)
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [stranger.id]}, format="json")
        self.assertEqual(res.status_code, 403)

    def test_group_scoped_requires_group_membership(self):
        group = Group.objects.create(name="Fam", creator=self.a)
        GroupMembership.objects.create(group=group, user=self.a, role="admin", status="active")
        # b is a connection but not a group member.
        res = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id], "group_id": group.id}, format="json")
        self.assertEqual(res.status_code, 400)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run python manage.py test api.tests.CreateGroupChatTests`
Expected: FAIL — the create view ignores `participant_ids` (400 on missing `user_id`).

- [ ] **Step 3: Implement the group branch in `create`**

In `ConversationListCreateView.create`, before the existing `user_id` handling, add a branch:

```python
    def create(self, request, *args, **kwargs):
        if "participant_ids" in request.data:
            return self._create_group(request)
        return self._create_direct(request)

    def _create_group(self, request):
        ids = request.data.get("participant_ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"participant_ids": "Pick at least one connection."})
        title = (request.data.get("title") or "").strip()[:100]
        group_id = request.data.get("group_id")
        group = None
        if group_id is not None:
            group = get_object_or_404(Group, pk=group_id)
            if not is_group_member(request.user, group.id):
                raise NotFound()

        invitees = list(User.objects.filter(id__in=ids, is_active=True).exclude(id=request.user.id))
        for invitee in invitees:
            if not can_add_to_group(request.user, invitee):
                raise PermissionDenied("You can only add people you're connected with.")
            if group is not None and not is_group_member(invitee, group.id):
                raise ValidationError({"participant_ids": f"{invitee.pk} isn't in this group."})

        now = timezone.now()
        with transaction.atomic():
            convo = Conversation.objects.create(
                kind=Conversation.Kind.GROUP, group=group, title=title,
                created_by=request.user, updated_at=now,
            )
            creator = Participant.objects.create(
                conversation=convo, user=request.user, status=ACTIVE_P,
            )
            activate(creator, now)
            for invitee in invitees:
                Participant.objects.create(
                    conversation=convo, user=invitee, status=PENDING_P,
                    invited_by=request.user,
                )
            promote_participants(convo, now)
        decorate_conversations([convo], request.user)
        return Response(self.get_serializer(convo).data, status=status.HTTP_201_CREATED)
```

Rename the existing body of `create` (the `user_id` logic) into a `_create_direct(self, request)` method returning the same `Response`.

Note: `decorate_conversations` / `get_serializer` are reworked in Task 5 to be participant-safe; until then this task's tests assert on `res.data["id"]` and the DB, which pass regardless. Ensure `Conversation.objects.create(...)` here still returns `id`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.CreateGroupChatTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite green**

Run: `cd backend && uv run python manage.py test api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/api/views.py backend/api/tests.py
git commit -m "feat(6a): create group chat endpoint with clique-gated invites"
```

---

## Task 5: Participant-based list / detail / messages + serializer

**Files:**
- Modify: `backend/api/views.py` (`user_conversations`, `decorate_conversations`, `ConversationDetailView`, `ConversationMessagesView`, add `chat_display_for`)
- Modify: `backend/api/serializers.py` (`ConversationSerializer`, add `ParticipantSerializer`)
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: `GET /api/conversations/` returns direct **and** group chats, each with `kind`, `title`, `group` (id/name or null), `participants` (list of `{id, display_name, avatar_thumb, status}`), `my_status`, `must_connect_with`, `last_message`, `unread_count`, `updated_at`. `GET /api/conversations/<id>/` adds `can_send`. `GET /api/conversations/<id>/messages/` is interval-clipped and 403s while pending.

- [ ] **Step 1: Write the failing tests**

```python
class GroupChatViewTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD, first_name="A", last_name="A")
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD, first_name="B", last_name="B")
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD, first_name="C", last_name="C")
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        Connection.objects.create(requester=self.a, requestee=self.c, status="accepted")
        self.client.force_authenticate(self.a)
        self.convo_id = self.client.post(
            CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id], "title": "T"}, format="json"
        ).data["id"]

    def test_list_includes_group_chat_with_my_status_active(self):
        res = self.client.get(CONVERSATIONS_URL)
        row = [c for c in res.data["results"] if c["id"] == self.convo_id][0]
        self.assertEqual(row["kind"], "group")
        self.assertEqual(row["my_status"], "active")

    def test_pending_member_sees_locked_chat_and_cannot_read_messages(self):
        # c is pending (not connected to b). Send a message as a.
        self.client.post(f"/api/conversations/{self.convo_id}/messages/", {"text": "hi"}, format="json")
        self.client.force_authenticate(self.c)
        detail = self.client.get(f"/api/conversations/{self.convo_id}/")
        self.assertEqual(detail.data["my_status"], "pending")
        self.assertEqual({u["id"] for u in detail.data["must_connect_with"]}, {self.b.id})
        msgs = self.client.get(f"/api/conversations/{self.convo_id}/messages/")
        self.assertEqual(msgs.status_code, 403)

    def test_active_member_reads_only_their_interval(self):
        self.client.post(f"/api/conversations/{self.convo_id}/messages/", {"text": "one"}, format="json")
        res = self.client.get(f"/api/conversations/{self.convo_id}/messages/")
        self.assertEqual(len(res.data["results"]), 1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatViewTests`
Expected: FAIL — `my_status`/`participants` KeyErrors; messages not participant-scoped.

- [ ] **Step 3: Rework `user_conversations` to be participant-based**

Replace `user_conversations` so it selects conversations where you have a non-left participant row (any status), hiding blocked/inactive *direct* counterparts as before:

```python
def user_conversations(user):
    blocked = _blocked_with_ids(user)  # extract the existing block-flatten into a helper
    convo_ids = Participant.objects.filter(
        user=user, left_at__isnull=True
    ).values_list("conversation_id", flat=True)
    qs = (
        Conversation.objects.filter(id__in=convo_ids)
        .select_related("user_a", "user_b", "group")
        .order_by("-updated_at", "-id")
    )
    # For 1:1, still hide a thread whose other party is blocked/inactive.
    return [c for c in qs if _conversation_visible(c, user, blocked)]
```

Add `_blocked_with_ids(user)` (the existing block-flatten block) and `_conversation_visible(convo, user, blocked)` that returns True for group chats and applies the Phase 5 rule for direct ones. Because this now returns a list, adjust `ConversationListCreateView.list` to paginate the list (it already handles `page is not None`).

- [ ] **Step 4: Rework `decorate_conversations` + add `chat_display_for`**

`decorate_conversations` should set, per conversation: `.my_status`, `.participant_rows` (active+pending, not left, with users), `.must_connect` (via `must_connect_with` when pending, else `[]`), and keep `_last_message` / `unread_count` (unchanged queries — they already key on `conversation_id`). For direct chats keep `.other`. Compute unread against `visible_messages_for` window? No — keep the existing per-conversation unread query but restrict to messages the viewer can see by joining on their intervals is overkill; instead compute unread from `visible_messages_for(convo, user)` filtered by `created_at > last_read_at`. Implement `unread` for the list via a per-conversation count over the interval-clipped queryset (family scale — acceptable).

Add:

```python
def chat_display_for(convo, user):
    """(title, kind, group_dict_or_None) for the list/detail serializer."""
    group = None
    if convo.group_id:
        group = {"id": convo.group_id, "name": convo.group.name}
    return convo.title, convo.kind, group
```

- [ ] **Step 5: Rework the serializer**

Replace `ConversationSerializer` so it emits `kind`, `title`, `group`, `participants`, `my_status`, `must_connect_with`, keeps `last_message`, `unread_count`, `can_send` (renamed from `can_message`, still `SerializerMethodField` reading `_can_message`), `updated_at`. Add:

```python
class ParticipantSerializer(serializers.Serializer):
    id = serializers.IntegerField(source="user.id")
    display_name = serializers.CharField(source="user.display_name")
    avatar_thumb = serializers.ImageField(source="user.avatar_thumb", allow_null=True)
    status = serializers.CharField()
```

`participants` = `ParticipantSerializer(obj.participant_rows, many=True)`; `must_connect_with` = the `AuthorSerializer(obj.must_connect, many=True)` (or a small id/name serializer); `my_status` = `getattr(obj, "my_status", None)`. Keep `other` for backward-compatible 1:1 rendering (present only when `kind == "direct"`).

- [ ] **Step 6: Rework `ConversationDetailView` + `ConversationMessagesView`**

- Detail: fetch via a participant row (`Participant.objects.filter(user=user, conversation_id=pk, left_at__isnull=True)`), 404 if none; set `my_status`; for direct chats keep the block check + `_can_message`; for group chats set `convo._can_message = my_status == "active"`.
- Messages GET: resolve the viewer's participant row (404 if none); if `my_status != "active"` return `403 PermissionDenied("Connect with everyone to join this chat.")`; else `get_queryset` returns `visible_messages_for(convo, user)`.
- Messages POST: replace the 1:1 `can_message(other)` gate with: for group chats, require the sender's participant row is `active` (403 otherwise); for direct chats keep the existing `can_message` gate. Bump `updated_at`, mark read (unchanged).

- [ ] **Step 7: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatViewTests api.tests.GroupChatModelTests`
Expected: PASS.

- [ ] **Step 8: Fix + run the full suite (Phase 5 tests may assert old fields)**

Run: `cd backend && uv run python manage.py test api`
Expected: PASS. If a Phase 5 test asserts `can_message` in the payload, update it to `can_send`; if it asserts a bare list vs `results`, keep pagination behaviour identical to before. Make the minimal edits and re-run.

- [ ] **Step 9: Commit**

```bash
git add backend/api/views.py backend/api/serializers.py backend/api/tests.py
git commit -m "feat(6a): participant-based conversation list/detail/messages + serializer"
```

---

## Task 6: Add participants to an existing chat (`POST /api/conversations/<id>/participants/`)

**Files:**
- Modify: `backend/api/views.py` (new `ConversationParticipantsView`), `backend/api/urls.py`
- Test: `backend/api/tests.py`

**Interfaces:**
- Consumes: `promote_participants`, `can_add_to_group`, `is_group_member`.
- Produces: `POST /api/conversations/<id>/participants/` body `{user_ids: [...]}`; any *active* member adds their own connections (+ group members for a group chat). New rows pending → promote. 403 if caller not active; 400 for a non-connection.

- [ ] **Step 1: Write the failing test**

```python
class AddParticipantsTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.d = User.objects.create_user(email="d@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        Connection.objects.create(requester=self.a, requestee=self.d, status="accepted")
        Connection.objects.create(requester=self.b, requestee=self.d, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id]}, format="json").data["id"]

    def test_active_member_adds_a_mutual_connection(self):
        res = self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [self.d.id]}, format="json")
        self.assertEqual(res.status_code, 200)
        convo = Conversation.objects.get(id=self.cid)
        # d connected to a and b → promotes straight to active.
        self.assertIn(self.d.id, set(convo.participants.filter(status="active").values_list("user_id", flat=True)))

    def test_non_member_cannot_add(self):
        self.client.force_authenticate(self.d)
        res = self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [self.b.id]}, format="json")
        self.assertEqual(res.status_code, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.AddParticipantsTests`
Expected: FAIL — 404 (no route).

- [ ] **Step 3: Implement the view + route**

```python
class ConversationParticipantsView(APIView):
    def post(self, request, pk):
        convo = get_object_or_404(Conversation, pk=pk)
        me = convo.participants.filter(
            user=request.user, status=ACTIVE_P, left_at__isnull=True
        ).first()
        if me is None:
            raise PermissionDenied("Only an active member can add people.")
        ids = request.data.get("user_ids") or []
        invitees = list(User.objects.filter(id__in=ids, is_active=True).exclude(id=request.user.id))
        for invitee in invitees:
            if not can_add_to_group(request.user, invitee):
                raise PermissionDenied("You can only add people you're connected with.")
            if convo.group_id and not is_group_member(invitee, convo.group_id):
                raise ValidationError({"user_ids": f"{invitee.pk} isn't in this group."})
        now = timezone.now()
        with transaction.atomic():
            for invitee in invitees:
                Participant.objects.get_or_create(
                    conversation=convo, user=invitee,
                    defaults={"status": PENDING_P, "invited_by": request.user},
                )
            promote_participants(convo, now)
        return Response({"detail": "Added."}, status=status.HTTP_200_OK)
```

Add to `urls.py`: `path("conversations/<int:pk>/participants/", views.ConversationParticipantsView.as_view(), name="conversation-participants")`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.AddParticipantsTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/views.py backend/api/urls.py backend/api/tests.py
git commit -m "feat(6a): add participants to a chat"
```

---

## Task 7: Leave / decline a chat (`POST /api/conversations/<id>/leave/`)

**Files:**
- Modify: `backend/api/views.py` (new `ConversationLeaveView`), `backend/api/urls.py`
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: `POST /api/conversations/<id>/leave/` works from active **or** pending: sets `left_at`, closes open interval, status pending, then re-runs `promote_participants` for the others. 404 if not a participant.

- [ ] **Step 1: Write the failing test**

```python
class LeaveChatTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=self.b, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id]}, format="json").data["id"]

    def test_leave_closes_interval_and_drops_you(self):
        res = self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.assertEqual(res.status_code, 200)
        p = Participant.objects.get(conversation_id=self.cid, user=self.a)
        self.assertIsNotNone(p.left_at)
        self.assertFalse(p.intervals.filter(ended_at__isnull=True).exists())

    def test_pending_invitee_can_decline(self):
        # c pending (never connected to b).
        c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        Connection.objects.create(requester=self.a, requestee=c, status="accepted")
        self.client.post(f"/api/conversations/{self.cid}/participants/", {"user_ids": [c.id]}, format="json")
        self.client.force_authenticate(c)
        res = self.client.post(f"/api/conversations/{self.cid}/leave/")
        self.assertEqual(res.status_code, 200)
        self.assertIsNotNone(Participant.objects.get(conversation_id=self.cid, user=c).left_at)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.LeaveChatTests`
Expected: FAIL — 404 (no route).

- [ ] **Step 3: Implement the view + route**

```python
class ConversationLeaveView(APIView):
    def post(self, request, pk):
        p = get_object_or_404(
            Participant, conversation_id=pk, user=request.user, left_at__isnull=True
        )
        now = timezone.now()
        with transaction.atomic():
            deactivate(p, now)
            p.left_at = now
            p.save(update_fields=["left_at"])
            promote_participants(p.conversation, now)
        return Response({"detail": "Left the chat."}, status=status.HTTP_200_OK)
```

Add route: `path("conversations/<int:pk>/leave/", views.ConversationLeaveView.as_view(), name="conversation-leave")`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.LeaveChatTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/views.py backend/api/urls.py backend/api/tests.py
git commit -m "feat(6a): leave/decline a chat"
```

---

## Task 8: Promote on connection-accept

**Files:**
- Modify: `backend/api/views.py` (`ConnectionRequestActionView.post` approve branch; `ConnectView.post` auto-accept branch)
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: accepting a connection sweeps every chat the two users both belong to and promotes any now-eligible pending member. New helper `promote_shared_chats(u1, u2, when)`.

- [ ] **Step 1: Write the failing test**

```python
class PromoteOnConnectTests(APITestCase):
    def test_pending_member_auto_joins_when_last_connection_accepted(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        Connection.objects.create(requester=a, requestee=b, status="accepted")
        Connection.objects.create(requester=a, requestee=c, status="accepted")
        self.client.force_authenticate(a)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [b.id, c.id]}, format="json").data["id"]
        convo = Conversation.objects.get(id=cid)
        pending = convo.participants.get(status="pending")  # b or c
        other_active = convo.participants.exclude(user=a).get(status="active")
        # The pending one requests the active one; accept it.
        req = Connection.objects.create(requester=pending.user, requestee=other_active.user, status="pending")
        self.client.force_authenticate(other_active.user)
        res = self.client.post(f"/api/connection-requests/{req.id}/approve/")
        self.assertEqual(res.status_code, 200)
        convo.refresh_from_db()
        self.assertEqual(convo.participants.filter(status="active").count(), 3)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.PromoteOnConnectTests`
Expected: FAIL — pending member stays pending (no promotion hook).

- [ ] **Step 3: Add the helper + wire both accept paths**

```python
def promote_shared_chats(u1, u2, when):
    """After u1↔u2 become connected, promote eligible pendings in every chat they
    both belong to."""
    shared = Conversation.objects.filter(
        participants__user=u1, participants__left_at__isnull=True
    ).filter(
        participants__user=u2, participants__left_at__isnull=True
    ).distinct()
    for convo in shared:
        promote_participants(convo, when)
```

In `ConnectionRequestActionView.post`, after `connection.save(...)` in the approve branch:

```python
            promote_shared_chats(connection.requester, connection.requestee, timezone.now())
```

In `ConnectView.post`, in the "they asked you first → accept" branch after `existing.save(...)`:

```python
            promote_shared_chats(existing.requester, existing.requestee, timezone.now())
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.PromoteOnConnectTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/views.py backend/api/tests.py
git commit -m "feat(6a): auto-promote pending members when a connection is accepted"
```

---

## Task 9: Sever on disconnect/block + disconnect-impact endpoint

**Files:**
- Modify: `backend/api/views.py` (`ConnectView.delete`, `BlockView.post`, new `DisconnectImpactView`, new `sever_shared_chats`), `backend/api/urls.py`
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: `sever_shared_chats(initiator, other, when)` — in every chat both are active in, drop the **initiator** to pending (close interval) and re-run promote. `GET /api/users/<id>/disconnect-impact/` returns `{chats: [{id, title, kind}]}` — the chats a disconnect/block would remove you from.

- [ ] **Step 1: Write the failing tests**

```python
class SeverTests(APITestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        self.b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        self.c = User.objects.create_user(email="c@x.com", password=PASSWORD)
        for x, y in [(self.a, self.b), (self.a, self.c), (self.b, self.c)]:
            Connection.objects.create(requester=x, requestee=y, status="accepted")
        self.client.force_authenticate(self.a)
        self.cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [self.b.id, self.c.id]}, format="json").data["id"]

    def test_disconnect_impact_lists_shared_chat(self):
        res = self.client.get(f"/api/users/{self.b.id}/disconnect-impact/")
        self.assertEqual([c["id"] for c in res.data["chats"]], [self.cid])

    def test_disconnect_drops_initiator_to_pending_other_stays(self):
        self.client.delete(f"/api/users/{self.b.id}/connect/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "pending")
        self.assertEqual(convo.participants.get(user=self.b).status, "active")

    def test_block_pulls_blocker_out_of_shared_chat(self):
        self.client.post(f"/api/users/{self.b.id}/block/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "pending")

    def test_initiator_auto_returns_on_reconnect(self):
        self.client.delete(f"/api/users/{self.b.id}/connect/")
        # a re-requests b; b accepts.
        self.client.post(f"/api/users/{self.b.id}/connect/")
        req = Connection.objects.get(requester=self.a, requestee=self.b)
        self.client.force_authenticate(self.b)
        self.client.post(f"/api/connection-requests/{req.id}/approve/")
        convo = Conversation.objects.get(id=self.cid)
        self.assertEqual(convo.participants.get(user=self.a).status, "active")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run python manage.py test api.tests.SeverTests`
Expected: FAIL — no impact route; disconnect doesn't touch participants.

- [ ] **Step 3: Implement sever + impact + wire disconnect/block**

```python
def _shared_active_chats(u1, u2):
    return Conversation.objects.filter(
        participants__user=u1, participants__status=ACTIVE_P, participants__left_at__isnull=True
    ).filter(
        participants__user=u2, participants__status=ACTIVE_P, participants__left_at__isnull=True
    ).distinct()


def sever_shared_chats(initiator, other, when):
    """Drop the initiator to pending in every chat both are active in, then let
    the promotion sweep settle the rest (the other stays if still connected)."""
    for convo in _shared_active_chats(initiator, other):
        p = convo.participants.get(user=initiator)
        deactivate(p, when)
        promote_participants(convo, when)


class DisconnectImpactView(APIView):
    def get(self, request, pk):
        other = get_object_or_404(User, pk=pk)
        chats = _shared_active_chats(request.user, other)
        data = [{"id": c.id, "title": c.title, "kind": c.kind} for c in chats]
        return Response({"chats": data})
```

In `ConnectView.delete`, wrap the delete so the sever runs first (initiator = `request.user`):

```python
    def delete(self, request, pk):
        target = self._target(pk)
        now = timezone.now()
        with transaction.atomic():
            sever_shared_chats(request.user, target, now)
            Connection.objects.filter(
                Q(requester=request.user, requestee=target)
                | Q(requester=target, requestee=request.user)
            ).delete()
        return Response({"detail": "Removed.", "connection_status": "none"}, status=status.HTTP_200_OK)
```

In `BlockView.post`, inside the existing `transaction.atomic()` block, call `sever_shared_chats(request.user, target, timezone.now())` **before** deleting the `Connection` rows.

Add route: `path("users/<int:pk>/disconnect-impact/", views.DisconnectImpactView.as_view(), name="disconnect-impact")`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.SeverTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite green**

Run: `cd backend && uv run python manage.py test api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/api/views.py backend/api/urls.py backend/api/tests.py
git commit -m "feat(6a): sever shared chats on disconnect/block + impact endpoint"
```

---

## Task 10: Leaving/removal from a Group drops you from its chats

**Files:**
- Modify: `backend/api/views.py` (`GroupMemberDetailView.delete`)
- Test: `backend/api/tests.py`

**Interfaces:**
- Produces: removing/leaving a group membership closes the departing user's participation (leave semantics) in every chat scoped to that group.

- [ ] **Step 1: Write the failing test**

```python
class GroupChatLifecycleTests(APITestCase):
    def test_leaving_group_removes_you_from_its_chats(self):
        a = User.objects.create_user(email="a@x.com", password=PASSWORD)
        b = User.objects.create_user(email="b@x.com", password=PASSWORD)
        Connection.objects.create(requester=a, requestee=b, status="accepted")
        group = Group.objects.create(name="Fam", creator=a)
        GroupMembership.objects.create(group=group, user=a, role="admin", status="active")
        GroupMembership.objects.create(group=group, user=b, role="member", status="active")
        self.client.force_authenticate(a)
        cid = self.client.post(CONVERSATIONS_URL, {"participant_ids": [b.id], "group_id": group.id}, format="json").data["id"]
        # b leaves the group.
        self.client.force_authenticate(b)
        self.client.delete(f"/api/groups/{group.id}/members/{b.id}/")
        p = Participant.objects.get(conversation_id=cid, user=b)
        self.assertIsNotNone(p.left_at)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatLifecycleTests`
Expected: FAIL — `left_at` is None.

- [ ] **Step 3: Wire the group-departure hook**

In `GroupMemberDetailView.delete`, after `target.delete()` (the membership row), before returning, drop that user from the group's chats:

```python
        now = timezone.now()
        for convo in Conversation.objects.filter(group_id=group.id):
            p = convo.participants.filter(user_id=user_id, left_at__isnull=True).first()
            if p is not None:
                deactivate(p, now)
                p.left_at = now
                p.save(update_fields=["left_at"])
                promote_participants(convo, now)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run python manage.py test api.tests.GroupChatLifecycleTests`
Expected: PASS.

- [ ] **Step 5: Full suite green + confirm group-delete cascade**

Run: `cd backend && uv run python manage.py test api`
Expected: PASS. (Cascade-delete of chats on group delete is covered by the `on_delete=CASCADE` FK from Task 1 — add a one-line assertion to this class if desired.)

- [ ] **Step 6: Commit**

```bash
git add backend/api/views.py backend/api/tests.py
git commit -m "feat(6a): drop members from a group's chats when they leave the group"
```

---

## Task 11: Frontend API layer

**Files:**
- Modify: `frontend/src/api.js` (in the messaging section, ~209-258)
- Test: `frontend/src/api.test.js`

**Interfaces:**
- Produces: `api.createGroupChat({participantIds, title, groupId})`, `api.addParticipants(conversationId, userIds)`, `api.leaveConversation(conversationId)`, `api.getDisconnectImpact(userId)`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/api.test.js` (follow the existing fetch-mock pattern in that file):

```js
it("createGroupChat posts participant_ids/title/group_id", async () => {
  const fetchMock = mockFetchOnce({ id: 7 });
  await api.createGroupChat({ participantIds: [1, 2], title: "Trip", groupId: 3 });
  const [, opts] = fetchMock.mock.calls[0];
  expect(JSON.parse(opts.body)).toEqual({ participant_ids: [1, 2], title: "Trip", group_id: 3 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/api.test.js`
Expected: FAIL — `api.createGroupChat is not a function`.

- [ ] **Step 3: Add the methods**

In `frontend/src/api.js`, in the messaging section:

```js
  // Create a multi-person chat. participantIds are your connections; a
  // non-connection is rejected. Optional title, and groupId to scope it to a
  // Phase 6 group (everyone must be a member of it).
  createGroupChat: ({ participantIds, title = "", groupId = null } = {}) =>
    request("/api/conversations/", {
      method: "POST",
      body: {
        participant_ids: participantIds,
        title,
        ...(groupId ? { group_id: groupId } : {}),
      },
    }),

  // Add more of your connections to an existing chat (any active member).
  addParticipants: (conversationId, userIds) =>
    request(`/api/conversations/${conversationId}/participants/`, {
      method: "POST",
      body: { user_ids: userIds },
    }),

  // Leave a chat (or decline an invite while pending).
  leaveConversation: (conversationId) =>
    request(`/api/conversations/${conversationId}/leave/`, { method: "POST" }),

  // The chats a disconnect/block would remove you from (for the warning modal).
  getDisconnectImpact: (userId) =>
    request(`/api/users/${userId}/disconnect-impact/`),
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- src/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.js frontend/src/api.test.js
git commit -m "feat(6a): frontend API methods for group chats"
```

---

## Task 12: New-chat multi-select + provider context

**Files:**
- Modify: `frontend/src/messaging.jsx` (provider)
- Create: `frontend/src/components/NewChatPicker.jsx`
- Modify: `frontend/src/components/MessagesDrawer.jsx` (wire the "new" view to `NewChatPicker`)
- Test: `frontend/src/messaging.test.jsx`

**Interfaces:**
- Consumes: `api.listUsers` (connections), `api.createGroupChat`, `api.openConversation` (1:1).
- Produces: `MessagingProvider` gains `openNew(prefill)` accepting `{groupId, groupName, memberIds}`; `NewChatPicker` renders a multi-select of your connections (filtered to `memberIds` when group-scoped), an optional title, and a Create button. Selecting one person + no title creates a 1:1 (`openConversation`); 2+ creates a group chat.

- [ ] **Step 1: Write the failing test**

Read `frontend/src/messaging.test.jsx` for the render/mock pattern, then add a test that opens the drawer's new-chat view, selects two connections, submits, and asserts `api.createGroupChat` was called with both ids. Expected initial run: FAIL (`NewChatPicker` missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Extend the provider**

In `messaging.jsx`, replace `openNew` to carry an optional prefill and expose it:

```jsx
  const [newPrefill, setNewPrefill] = useState(null);
  const openNew = useCallback((prefill = null) => {
    setNewPrefill(prefill);
    setView("new");
  }, []);
```

Add `newPrefill` to the memoised `value`.

- [ ] **Step 4: Build `NewChatPicker`**

Create `frontend/src/components/NewChatPicker.jsx`: a component using `useQuery(["users"], api.listUsers)`, filtering to `connection_status === "connected"` (and to `prefill.memberIds` when present), rendering a checkbox list keyed on user id, a title `<input>`, and a Create button whose `onClick` calls `api.createGroupChat({ participantIds, title, groupId: prefill?.groupId })` for 2+ selections or `api.openConversation(id)` for exactly one with no title, then `openThread(result.id)`. Follow the styling of the existing picker inside `MessagesDrawer.jsx` (read it first) and the design tokens in `docs/design-system.md`.

- [ ] **Step 5: Wire it into the drawer**

In `MessagesDrawer.jsx`, in the `view === "new"` branch, render `<NewChatPicker prefill={newPrefill} />` (import `newPrefill` from `useMessaging()`).

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/messaging.jsx frontend/src/components/NewChatPicker.jsx frontend/src/components/MessagesDrawer.jsx frontend/src/messaging.test.jsx
git commit -m "feat(6a): multi-select new-chat picker"
```

---

## Task 13: Group thread — header, pending locked panel, add/leave

**Files:**
- Create: `frontend/src/components/PendingChatPanel.jsx`
- Modify: `frontend/src/components/MessagesDrawer.jsx` (thread view)
- Test: `frontend/src/messaging.test.jsx`

**Interfaces:**
- Consumes: conversation detail (`kind`, `title`, `participants`, `my_status`, `must_connect_with`), `api.connect`, `api.leaveConversation`, `api.addParticipants`.
- Produces: thread header shows title + participant avatars for group chats; when `my_status === "pending"` the message area is replaced by `PendingChatPanel` (locked); an **Add people** control (opens the picker in add mode) and a **Leave** control are present for group chats.

- [ ] **Step 1: Write the failing test**

Add a test: render the thread for a conversation whose detail mock has `my_status: "pending"` and `must_connect_with: [{id, display_name}]`; assert the message composer is absent and a "Connect" button for that person is present; clicking it calls `api.connect`. Also a test that `my_status: "active"` group chat shows the composer. Expected: FAIL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Build `PendingChatPanel`**

Create `frontend/src/components/PendingChatPanel.jsx`: given `mustConnectWith` (array) and `conversationId`, render "Connect with **X** & **Y** to join this chat", a Connect button per person (`useMutation(() => api.connect(id))`, invalidating `["conversation", conversationId]` and `["conversations"]` on success), and a **Decline / Leave** button (`api.leaveConversation(conversationId)` then `openList()`). Style from the design tokens.

- [ ] **Step 4: Wire the thread view**

In `MessagesDrawer.jsx` thread branch: when the detail query's `my_status === "pending"`, render `<PendingChatPanel mustConnectWith={detail.must_connect_with} conversationId={id} />` instead of the messages list + composer. For group chats (`kind === "group"`) render the title + a horizontal stack of participant `Avatar`s in the header, an **Add people** button (`openNew({ addToConversationId: id })` — extend the picker's Create path to call `api.addParticipants` when `addToConversationId` is set), and a **Leave** button (`api.leaveConversation(id)` → `openList()`). Poll cadence unchanged (`MESSAGE_POLL_MS`).

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PendingChatPanel.jsx frontend/src/components/MessagesDrawer.jsx frontend/src/messaging.test.jsx
git commit -m "feat(6a): group thread header, pending locked panel, add/leave"
```

---

## Task 14: Conversation list — group rows + pending style

**Files:**
- Modify: `frontend/src/components/MessagesDrawer.jsx` (list view)
- Test: `frontend/src/messaging.test.jsx`

**Interfaces:**
- Consumes: list items with `kind`, `title`, `participants`, `my_status`, `last_message`, `unread_count`.
- Produces: a group row shows the title (or a comma-joined participant names fallback) + stacked avatars; a `my_status === "pending"` row shows a "Invited — connect to join" hint and no message preview.

- [ ] **Step 1: Write the failing test**

Add a test rendering the list with one direct and one group (pending) conversation; assert the group title renders and the pending row shows the invited hint. Expected: FAIL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the list row renderer, branch on `kind`: for `"group"`, show `title || participantNames`, a small stacked-avatar cluster, and — when `my_status === "pending"` — replace the preview with "Invited — connect to join" and a lock affordance. Keep the existing direct-chat row untouched.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MessagesDrawer.jsx frontend/src/messaging.test.jsx
git commit -m "feat(6a): group + pending rows in the conversation list"
```

---

## Task 15: Disconnect/block warning modal

**Files:**
- Create: `frontend/src/components/DisconnectWarningModal.jsx`
- Modify: `frontend/src/components/ConnectButton.jsx`, `frontend/src/components/BlockButton.jsx`
- Test: `frontend/src/messaging.test.jsx` (or a new `connections.test.jsx`)

**Interfaces:**
- Consumes: `api.getDisconnectImpact`, `api.disconnect`, `api.blockUser`.
- Produces: `DisconnectWarningModal({ userId, action, onConfirm, onCancel })` — fetches the impacted chats and, if any, lists them and requires confirmation before running the disconnect/block; if none, it can proceed directly.

- [ ] **Step 1: Write the failing test**

Add a test: mock `getDisconnectImpact` to return two chats; click Disconnect; assert the modal lists both titles and that the actual `api.disconnect` only fires after confirming. Expected: FAIL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Build the modal + wire the buttons**

Create `DisconnectWarningModal.jsx`: on mount `useQuery(["disconnect-impact", userId], () => api.getDisconnectImpact(userId))`; render the chat titles with the copy "Disconnecting from **Name** will remove you from these chats until you're connected to everyone again:" and Confirm/Cancel. In `ConnectButton.jsx` (disconnect path) and `BlockButton.jsx`, open the modal first and only call `api.disconnect` / `api.blockUser` from its `onConfirm`. Invalidate `["conversations"]` + the user query on success.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- src/messaging.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DisconnectWarningModal.jsx frontend/src/components/ConnectButton.jsx frontend/src/components/BlockButton.jsx frontend/src/messaging.test.jsx
git commit -m "feat(6a): warn before a disconnect/block that removes you from chats"
```

---

## Task 16: "Start a chat" entry point on a Group

**Files:**
- Modify: `frontend/src/components/GroupsDrawer.jsx` (or the group page — read it first)
- Test: `frontend/src/groups.test.jsx`

**Interfaces:**
- Consumes: `useMessaging().openNew`, `api.getGroupMembers`.
- Produces: a group view has a **Start a chat** button that opens the new-chat picker scoped to that group (`openNew({ groupId, groupName, memberIds })`), so the pool is group members ∩ your connections.

- [ ] **Step 1: Write the failing test**

Add a test to `frontend/src/groups.test.jsx`: render the group view, click **Start a chat**, assert `openNew` is invoked with the group's id and member ids. Expected: FAIL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/groups.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add a **Start a chat** button to the group view that calls `openNew({ groupId: group.id, groupName: group.name, memberIds })` where `memberIds` comes from `api.getGroupMembers(group.id)`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- src/groups.test.jsx`
Expected: PASS.

- [ ] **Step 5: Full frontend + backend suites green**

Run: `cd frontend && npm test` then `cd ../backend && uv run python manage.py test api`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/GroupsDrawer.jsx frontend/src/groups.test.jsx
git commit -m "feat(6a): start a group-scoped chat from a group"
```

---

## Task 17: Docs + phase close-out

**Files:**
- Modify: `docs/phases/phase-6a-group-messaging.md` (tick the DoD, add a notes/decisions entry, mark **done**)
- Modify: `CLAUDE.md` ("Current status" line)

- [ ] **Step 1: Update the phase doc** — check off each Definition-of-done item that shipped, add a "Notes / decisions log" entry for anything non-obvious discovered while building (e.g. list unread computed over interval-clipped messages), and set **Status: done**.
- [ ] **Step 2: Update `CLAUDE.md`** — replace the "Phase 6a … is next" line with a one-paragraph "done" summary in the same style as the other phases, and name the next phase.
- [ ] **Step 3: Commit**

```bash
git add docs/phases/phase-6a-group-messaging.md CLAUDE.md
git commit -m "docs(6a): mark group messaging done; update status"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin phase-6a-group-messaging
gh pr create --fill --base main
```

---

## Self-review notes (for the implementer)

- **Interval-clipped unread (Task 5):** the Phase 5 unread query counts all non-deleted messages newer than your read marker. For group chats it must also respect your intervals (don't count gap messages). Compute unread from `visible_messages_for(convo, user)` — verify the list badge and `GET /messages/unread-count/` both use the clipped set.
- **`display_name` / `avatar_thumb`:** confirm these exist on the user model (used by `AuthorSerializer`) before reusing them in `ParticipantSerializer` — they do (Phase 4). 
- **Pagination shape:** keep `GET /api/conversations/` returning the same paginated envelope (`results`) after `user_conversations` becomes a list — the view already branches on `page is not None`.
- **1:1 unaffected:** every Phase 5 test must still pass; the direct-chat create/detail/messages paths keep the `can_message` gate. Only the payload key `can_message → can_send` changes (update Phase 5 tests + `api.js`/drawer references accordingly in Task 5).
