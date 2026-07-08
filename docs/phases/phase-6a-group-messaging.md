# Phase 6a — Group Messaging

**Status:** done (2026-07-08). Extends Phase 5 direct messaging into
multi-participant chats. See the decisions
log at the bottom for the choices made while designing.

## Goal

Let several people hold a shared, time-ordered conversation — the same messaging
experience as Phase 5, but with more than two participants. Two flavours:

- **Standalone** multi-person chats among your connections.
- **Group-associated** chats created inside a Phase 6 `Group`.

The security gate is **identical** for both: a chat is only ever between people
who are *all mutually connected*. There is no algorithm anywhere; messages are
time-ordered, and the conversation list sorts by most-recent activity.

### Why the clique rule exists

You can be a member of a Phase 6 `Group` with someone you are **not** connected
with (you just can't see their posts — group timelines are pruned to your
connections). A group-associated chat must therefore **never** become a leak
that drops you into a conversation with someone you don't know. So the
non-negotiable invariant, for *both* chat flavours:

> **The set of active participants in a chat is always a fully-connected
> clique** — every active member is connected to every other active member.

`pending` is the waiting room for anyone invited but not yet connected to all
the current active members.

## Runnable product at the end of this phase

A user can start a group chat by picking several of their connections (optionally
scoped to a group they're in), everyone who's fully connected sees messages in
order (near-real-time via polling), a member can add more of their own
connections, leave, and — if they were invited but aren't yet connected to
everyone — see a locked "connect with X & Y to join" panel that lets them fire
off the connection requests (or decline the invite). When the last required
connection is accepted, they're pulled into the chat automatically.

## Definition of done

- [x] `Conversation` generalised to N participants via a new `Participant`
      table; existing 1:1 threads migrated in (2 participants each).
- [x] `ParticipantInterval` table backs history visibility (access is a set of
      time spans, not a single join point).
- [x] Create a group chat (standalone or group-scoped); creator active, invitees
      added `pending` and promoted per the clique rule.
- [x] A `pending` invitee sees a **locked** chat: no messages, a "connect with
      C & D to join" panel with inline connection-request buttons, and a
      **Decline / Leave** button to drop the invite.
- [x] View a group thread oldest-first, paginated, **clipped to your access
      intervals** (you never see what was said while you were pending; you keep
      everything from before you dropped out).
- [x] Send a message (active participants only); soft-delete your own message
      (carried over from Phase 5).
- [x] Any active member can add more of **their own** connections (add-gate =
      Phase 5/6 `can_message`/`can_add_to_group`; group members too for a
      group-scoped chat). No admin concept — **self-leave only**, no removing
      others.
- [x] **Sever handling:** disconnecting or blocking an active co-member warns you
      it will pull you from the shared chats, then drops **you** (the initiator)
      to `pending` in each; you auto-return once connected to everyone still
      active.
- [x] Per-member unread counts + the total nav badge include group chats
      (`ConversationRead` already per-member — unchanged).
- [x] Group-associated lifecycle: leaving / being removed from a `Group` removes
      you from that group's chats.
- [x] Near-real-time via **polling** (reuse Phase 5 cadence) — no new realtime
      infra.
- [x] Backend + frontend tests (below), following the established pattern.

## Data model

Generalise Phase 5's pair-shaped `Conversation` into a participant set (this is
exactly what the Phase 5 model was shaped to allow — see its "participants as
their own concept" note).

- **`Conversation`** (refactored)
  - Drop `user_a`/`user_b` and the unordered-pair unique constraint.
  - Add `kind` (`direct` | `group`), nullable `group` FK (→ `Group`; set only for
    group-associated chats), optional `title`, `created_by` FK.
  - Keep `created_at` / `updated_at` (activity sort, bumped on each message).

- **`Participant`** (new) — the heart of the model.
  - `conversation` FK, `user` FK — unique together.
  - `status`: `active` | `pending`.
  - `invited_by` FK — who added them (drives the "connect with X" prompts and the
    add-gate).
  - `left_at` (nullable) — self-leave / decline tombstone.

- **`ParticipantInterval`** (new) — the spans during which a participant was
  `active`.
  - `participant` FK, `started_at`, `ended_at` (nullable = currently active).
  - Becoming active **opens** an interval; dropping to pending / leaving
    **closes** it; returning opens a new one.
  - **A message is visible to you iff its `created_at` falls inside one of your
    intervals.** So a blocked-then-returned member keeps everything from before
    they dropped out, never sees the gap, and resumes cleanly:

    ```
    active [t0 ──────────── t1)   pending (t1 ─── t2)   active [t2 ─────────→
      ✓ visible                   ✗ hidden (the gap)     ✓ visible
    ```

  - For a first-time joiner this is a single open interval starting at their
    join, so they still see nothing from before them.

- **`Message`** — unchanged (FK `conversation`, `sender`, `text`, `created_at`,
  soft-delete `deleted_at`). Additionally clipped by the viewer's intervals.

- **`ConversationRead`** — unchanged; already `(conversation, user,
  last_read_at)`, so per-member unread "just works" for N participants.

- **`Block`** — unchanged; block still severs the connection (Phase 5) and now
  also flows through the sever path below.

**Migration:** each existing 1:1 `Conversation` → two `active` `Participant`
rows, each with a single `ParticipantInterval(started_at =
conversation.created_at, ended_at = null)`, `kind = direct`. 1:1 get-or-create
becomes "find the `direct` conversation whose participant set is exactly {me,
you}".

## Membership state machine

The single invariant (active set is a clique) yields deterministic rules,
evaluated event-by-event — **never** a maximal-clique search:

- **Add** — an active member adds one of *their own* connections (gate =
  `can_add_to_group`; for a group-scoped chat the invitee must also be a group
  member). Creates a `pending` row, then runs *promote*.
- **Promote** (`pending` → `active`) — fires the instant the user is connected to
  **all current active members**. Evaluated on connection-accept, on someone
  leaving, and after any demotion. Processed **one participant at a time with a
  re-check**, so two mutually-unconnected pending people can't both slip in — the
  second stays pending, prompted to connect with the first. Opens a new
  `ParticipantInterval`.
- **Sever** — when an active member **disconnects or blocks** another active
  member: the **initiator** is warned it will remove them from the N chats they
  share (see `disconnect-impact` below), then drops to `pending` in each (closing
  their current interval). The other member stays active (still connected to
  everyone else). The initiator **auto-returns** the moment they're connected to
  all remaining actives again — i.e. they reconnect, **or** everyone else also
  drops that person so they fall out of the chat entirely and stop being an
  obstacle.
- **Leave / Decline** — self-leave (`POST /leave/`) works from **either** status:
  an active member leaves; a pending invitee declines. Closes the interval, sets
  `left_at`, and triggers a promote re-eval for everyone else.

Worked example — A blocks B in chat `{A, B, C, D}` (all active):
1. A is warned "this removes you from 1 shared chat", confirms.
2. A drops to `pending` (interval closed). Active = `{B, C, D}` — still a clique.
3. A won't reconnect with B (A blocked them), so A stays out. If A had merely
   *disconnected* and later reconnected, A auto-returns (new interval).
4. Alternatively, if C and D also drop B, then B falls out entirely; A is once
   again connected to everyone active and auto-returns.

## API (extends the Phase 5 endpoints)

- `GET /api/conversations/` — direct **and** group chats. Each: `kind`, derived
  name / `title`, group label (if any), participant summary, last-message
  preview, `unread_count`, `updated_at`, **your `status`**, and for `pending`
  the `must_connect_with` user list. Ordered by `updated_at` desc, paginated.
- `POST /api/conversations/` — 1:1 unchanged (`{ user_id }`, get-or-create).
  Group: `{ participant_ids[], title?, group_id? }`. Creator active; invitees
  added `pending` and promoted per the clique. 403 if any invitee fails the
  add-gate; if `group_id` set, every invitee must be a group member.
- `GET /api/conversations/<id>/` — detail: participants + statuses, your status,
  `can_send`, `title`, group. A `pending` viewer gets `must_connect_with`
  instead of message access.
- `GET /api/conversations/<id>/messages/` — oldest-first, paginated, **clipped to
  your access intervals**; 403 (locked) while `pending`.
- `POST /api/conversations/<id>/messages/` — send; active participants only;
  bumps `updated_at`.
- `POST /api/conversations/<id>/read/` — mark read (unchanged).
- `DELETE /api/conversations/<id>/messages/<msg_id>/` — soft-delete own message
  (unchanged).
- `POST /api/conversations/<id>/participants/` — add people (`{ user_ids[] }`);
  any active member, each an addable connection (+ group member for a group
  chat). Creates pending rows, runs promote.
- `POST /api/conversations/<id>/leave/` — self-leave **or** decline-invite;
  works from active or pending.
- `GET /api/users/<id>/disconnect-impact/` — the shared active chats a
  disconnect/block would pull you from, to drive the warning modal before you
  confirm.

**Hooks into existing flows** (no new endpoints): accepting a `Connection` runs a
*promote* sweep across shared pending chats; `DELETE /api/users/<id>/connect/`
and `POST /api/users/<id>/block/` run the *sever* (demote the initiator across
shared active chats, close their interval).

## Frontend (extends the Phase 5 drawer — not new routes)

The Phase 5 messaging companion drawer (`MessagesDrawer.jsx`, driven by
`MessagingProvider`) is extended in place:

- **List** — group chats show a title + stacked participant avatars + a group
  label; `pending` chats render in a **locked** style.
- **New chat** — the connection-picker goes **multi-select** → create a group
  chat (+ optional title). Launched from a Phase 6 **Group** page it's scoped to
  that group (pool = group members ∩ your connections).
- **Thread** — group header (title, participants, **Add people**, **Leave**).
  A `pending` viewer sees the **locked panel**: "Connect with **C** & **D** to
  join", inline connection-request buttons, and a **Decline / Leave** button.
- **Disconnect / Block** on a profile opens a **confirm modal listing the chats
  it will remove you from** (from `disconnect-impact`).
- Nav unread badge already aggregates — group chats fold in. Real-time stays
  **polling** (reuse `MESSAGE_POLL_MS` / `CONVERSATION_LIST_POLL_MS`); a
  promotion or sever just surfaces on the next poll.
- Legacy `/messages[/:id]` URLs keep working (open the drawer), consistent with
  Phase 5.

## Steps

1. Models + migration: refactor `Conversation`, add `Participant` /
   `ParticipantInterval`; data-migrate existing 1:1 threads (two active
   participants + one open interval each).
2. Membership helpers in `api/views.py`: `promote(conversation)` (one-at-a-time
   re-check), `sever(initiator, other)` (demote across shared chats),
   `visible_messages(conversation, viewer)` (interval clip). Reuse
   `connected_user_ids` / `can_message` / `can_add_to_group`.
3. Serializers + views for the endpoints above; wire the promote/sever hooks into
   the existing connection-accept, disconnect, and block views, and the group
   leave/remove views (Phase 6).
4. Frontend: multi-select create, group thread (add/leave), the locked pending
   panel (connect + decline), the disconnect/block warning modal, group-scoped
   "start a chat" entry point on the Group page.
5. Tests both sides (below).

## Privacy / safety notes

- **The clique rule is the headline safety property** — no stranger can ever be
  in a chat with you, even via a shared group. A `pending` invitee can read
  nothing until they're connected to everyone.
- **Sever is symmetric and warned.** Disconnecting/blocking a co-member removes
  *you* (the initiator) from the shared chats after an explicit warning; you don't
  silently keep receiving a stranger's messages, and you don't lose your own
  history (intervals preserve it).
- **Not end-to-end encrypted (yet).** Same as Phase 5: messages are stored in
  plaintext and readable by the maintainer via the Django admin. E2E remains a
  stated long-term goal (see `phase-5-messaging.md`), out of scope here.
- **Retention / deletion.** Account-level "delete my data" (Phase 7) must cascade
  to participants/messages. Leaving a chat closes your access; it doesn't delete
  the thread for others.

## Decisions (agreed with the user, 2026-07-07)

- **Both chat flavours exist** — standalone multi-person chats *and*
  group-associated chats — but the **clique gate is identical** for both, because
  you can share a group with someone you're not connected to and a chat must never
  leak you into contact with them.
- **History is interval-based, not a single join point.** A member who drops to
  pending and later returns keeps their pre-gap history and only loses the gap —
  so a block never penalises the person who was blocked. (Refines the initial
  "only from when they join" idea; a first-time joiner still sees nothing before
  them.)
- **Any active member adds their own connections; self-leave only** — no admin
  role in chats (lighter than Phase 6 groups' admin model).
- **Sever removes the initiator** (not both permanently): the person who clicks
  disconnect/block is the one dropped to pending and prompted to reconnect, so
  "block someone → *you* leave the shared chat" feels right; the other stays.
  Auto-return when the clique is whole again (reconnect, or the others drop the
  obstacle).
- **Pending invitees can decline** — `POST /leave/` works from the pending state,
  surfaced as a Decline / Leave button in the locked panel.
- **Polling, not WebSockets** — reuse the Phase 5 cadence; the swap to Channels
  later stays non-breaking (same REST + model), as Phase 5 established.
- **Generalise the model** (Participant table) rather than parallel group-chat
  models — one code path for DMs and group chats; migrate existing 1:1 threads in.

## Group deletion

- **Deleting a `Group` cascade-deletes its associated chats** (confirmed with the
  user, 2026-07-07) — they were scoped to the group, so the `Conversation.group`
  FK uses `on_delete=CASCADE`.

## Notes / decisions log

- **Sequenced after Phase 6, split out of Phase 5 (confirmed 2026-07-06).** Keeps
  Phase 5 a simple 1:1 MVP; group chat leans on the group model and this phase's
  Participant generalisation. See `phase-5-messaging.md` for the shared messaging
  foundation and the E2E long-term goal.
- **Design agreed 2026-07-07** via the brainstorming flow — see the Decisions
  section above for the resolved questions (clique gate, interval history, sever
  semantics, add/leave permissions, data-model generalisation).
- **Implemented 2026-07-08 (built task-by-task from
  `docs/superpowers/plans/2026-07-07-phase-6a-group-messaging.md`).** Notes on
  where the build refined the plan above:
  - **`user_a`/`user_b` were kept, not dropped.** The Data-model section above
    says "drop `user_a`/`user_b` and the unordered-pair constraint", but the
    migration made them **nullable** and left them in place, so every Phase 5
    test stayed green through the refactor (additive migration `0008` + backfill
    `0009`). Direct-chat get-or-create still keys on the `(user_a, user_b)`
    pair; `_ensure_direct_participants` lazily gives a 1:1 thread its two active
    `Participant` rows + open intervals so it behaves like a promoted group chat.
    Dropping the pair columns is a future cleanup, not required for the feature.
  - **`can_message` → `can_send` in the conversation payload.** The serializer
    field was renamed for N-participant chats; Phase 5 frontend (`api.js`,
    drawer) and tests were updated in lockstep.
  - **List unread is interval-clipped.** Both the per-thread badge and the total
    nav count (`/messages/unread-count/`) count over `visible_messages_for`, so
    a member never sees an unread bump from messages sent during a gap they were
    pending/away for.
  - **Dev seed command added (`api/management/commands/seed_demo.py`).** Rebuilds
    a full demo world (connected + unconnected people, groups, DMs, and two group
    chats incl. a pending participant) idempotently — handy for exercising this
    phase by hand after the dev DB's users were lost. Deletes demo conversations
    before users so standalone group chats don't survive as orphans.
  - **Tests:** backend `api` suite at 147 passing (adds the group-messaging +
    seed classes); frontend Vitest at 98 passing. Both green.
