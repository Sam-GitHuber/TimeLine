# Messaging (direct & group)

Private messaging between connected people — 1:1 and multi-participant. Started as
1:1 DMs and was generalised to N participants; both flavours share one code path
and one safety gate. Still no algorithm anywhere: messages are time-ordered and
the conversation list sorts by most-recent activity. This doc is the current-state
reference.

Code: `Conversation` / `Message` / `Participant` / `ParticipantInterval` /
`ConversationRead` / `Block` models + `can_send` / `promote` / `sever` /
`visible_messages` helpers in `backend/api/views.py`. Frontend: the messaging
companion drawer (`MessagesDrawer.jsx`, driven by `MessagingProvider`).

## The safety gate

- **You can only message people you're mutually [connected](connections.md)
  with** — no cold DMs from strangers. Disconnecting stops future messages;
  **blocking** is the stronger explicit cut.
- **The clique invariant (group chats):** the set of *active* participants in a
  chat is always a **fully-connected clique** — every active member is connected
  to every other active member. This is the headline safety property: no stranger
  can ever be in a chat with you, even via a shared group (you can share a
  [group](groups.md) with someone you're not connected to). `pending` is the
  waiting room for anyone invited but not yet connected to all current actives.
- **`can_send(me, conversation)`** (active + participant + still satisfies the
  gate) is the single check both create and send consult; it's surfaced in the
  conversation payload as `can_send` so the UI and the 403 can't disagree. History
  stays readable after a disconnect (GET works); only *sending* is gated.

## Data model

- **`Conversation`** — `kind` (`direct` | `group`), nullable `group` FK (set only
  for group-associated chats), optional `title`, `created_by`, `created_at` /
  `updated_at` (bumped on each message so the list sorts by activity cheaply).
  - *Legacy shape kept additive:* the original 1:1 `user_a`/`user_b` columns +
    unordered-pair unique constraint were made **nullable** rather than dropped, so
    the Phase 5 tests stayed green through the N-participant refactor (migration
    `0008` + backfill `0009`). Direct-chat get-or-create still keys on the
    `(user_a, user_b)` pair; `_ensure_direct_participants` lazily gives a 1:1
    thread its two active `Participant` rows so it behaves like a promoted group
    chat. Dropping those columns is a future cleanup, not required.
- **`Participant`** — `conversation`, `user` (unique together), `status`
  (`active` | `pending`), `invited_by` (drives the "connect with X" prompts + the
  add-gate), `left_at` (self-leave/decline tombstone), `muted_at` (per-person
  push mute — see [Push notifications](#push-notifications)).
- **`ParticipantInterval`** — the spans during which a participant was `active`:
  `started_at`, `ended_at` (null = currently active). Becoming active **opens** an
  interval; dropping to pending / leaving **closes** it; returning opens a new one.
- **`Message`** — `conversation`, `sender`, `text`, `created_at` (indexed),
  soft-delete `deleted_at`. `ordering = ["created_at", "id"]` (oldest-first, stable
  tiebreak).
- **`ConversationRead`** — `(conversation, user, last_read_at)`, unique together.
  Unread for you = visible messages with `created_at > last_read_at` and
  `sender != you`. Its own table (not two timestamps on `Conversation`) is why
  per-member unread "just works" for N participants.
- **`Block`** — `(blocker, blocked)`, directional, unique together. A block in
  **either** direction hides the pair from each other and bars messaging +
  connecting.

## History is interval-clipped

**A message is visible to you iff its `created_at` falls inside one of your
`ParticipantInterval`s.** So a member who drops to pending and later returns keeps
everything from before the gap, never sees the gap itself, and resumes cleanly:

```
active [t0 ──────────── t1)   pending (t1 ─── t2)   active [t2 ─────────→
  ✓ visible                   ✗ hidden (the gap)     ✓ visible
```

A first-time joiner has a single open interval starting at their join, so they see
nothing from before them. A block never penalises the person who was blocked. Both
the thread and the unread counts (per-thread + the nav badge) count over this
clipped set — `visible_messages(conversation, viewer)` — so a member never gets an
unread bump from messages sent during a gap.

## Membership state machine

The single invariant (active set is a clique) yields deterministic rules,
evaluated **event-by-event** — never a maximal-clique search:

- **Add** — any active member adds one of *their own* connections (gate =
  `can_add_to_group`; for a group-scoped chat the invitee must also be a group
  member). Creates a `pending` row, then runs *promote*. There is **no admin
  role** in chats — self-leave only, no removing others (lighter than
  [groups'](groups.md) admin model).
- **Promote** (`pending` → `active`) — fires the instant the user is connected to
  **all** current active members. Evaluated on connection-accept, on someone
  leaving, and after any demotion. Processed **one participant at a time with a
  re-check**, so two mutually-unconnected pending people can't both slip in — the
  second stays pending, prompted to connect with the first. Opens a new interval.
- **Sever** — when an active member **disconnects or blocks** another active
  member, the **initiator** is warned it will remove them from the N chats they
  share, then drops to `pending` in each (closing their interval). The other member
  stays active (still connected to everyone else). The initiator **auto-returns**
  the moment they're connected to all remaining actives again — i.e. they reconnect,
  **or** everyone else also drops that person so they fall out entirely and stop
  being an obstacle. Sever removes the *initiator* (not both permanently) so
  "block someone → *you* leave the shared chat" feels right.
- **Leave / Decline** — self-leave (`POST /leave/`) works from **either** status:
  an active member leaves; a pending invitee declines. Closes the interval, sets
  `left_at`, triggers a promote re-eval for everyone else.
- **Group lifecycle:** leaving / being removed from a `Group` removes you from that
  group's chats. Deleting a `Group` cascade-deletes its associated chats
  (`Conversation.group` is `on_delete=CASCADE`).

## Blocking

`POST /api/users/<id>/block/` deletes any `Connection` row between the pair as well
as creating the `Block` — you shouldn't stay "connected" to someone you've blocked.
A block in either direction hides the conversation from both lists, 404s the
thread, bars (re)connecting, and flows through the sever path above. Unblock lifts
only *your* own block (a mutual block is two independent rows).

## API

Direct and group chats share the endpoints:

- `GET /api/conversations/` — direct + group chats: `kind`, derived name /
  `title`, group label, participant summary, last-message preview, `unread_count`,
  `updated_at`, **your `status`**, and for `pending` the `must_connect_with` list.
  Ordered by `updated_at` desc, paginated.
- `POST /api/conversations/` — 1:1: `{ user_id }`, get-or-create. Group:
  `{ participant_ids[], title?, group_id? }` (creator active, invitees pending +
  promoted; 403 if any invitee fails the add-gate; `group_id` requires every
  invitee be a group member).
- `GET /api/conversations/<id>/` — detail: participants + statuses, your status,
  `can_send`, `title`, group. A `pending` viewer gets `must_connect_with` instead
  of message access. (This detail endpoint exists because the messages endpoint
  doesn't carry the *other participant* — the thread header needs it on a cold
  load.)
- `GET /api/conversations/<id>/messages/` — oldest-first, paginated, **clipped to
  your intervals**; 403 (locked) while pending.
- `POST /api/conversations/<id>/messages/` — send; active participants only; bumps
  `updated_at`.
- `POST /api/conversations/<id>/read/` — mark read up to now (clears unread).
- `POST` / `DELETE /api/conversations/<id>/mute/` — mute / unmute **your** push
  notifications for this thread; returns `{ muted }`. Member-only (404
  otherwise). The state also rides on the conversation payload as `muted`.
- `DELETE /api/conversations/<id>/messages/<msg_id>/` — **soft-delete** your own
  message (blanks `text`, sets `deleted_at`, keeps a "message deleted" tombstone in
  place so the thread doesn't silently reshuffle and pagination isn't disturbed;
  deleted messages don't count toward unread).
- `POST /api/conversations/<id>/participants/` — add people; any active member,
  each an addable connection.
- `POST /api/conversations/<id>/leave/` — self-leave **or** decline-invite.
- `GET /api/users/<id>/disconnect-impact/` — the shared active chats a
  disconnect/block would pull you from, to drive the warning modal.
- `GET /api/messages/unread-count/` — single number for the nav badge (so it
  doesn't load and sum the paginated list).

**Performance:** the conversation-list decorator computes unread + last-message
without N+1 — one Postgres `DISTINCT ON (conversation_id)` query for each thread's
latest message and one grouped `Count` with a per-viewer `last_read_at` `Subquery`
for unread (a fixed number of queries per page).

## Real-time = polling (deliberately)

Near-real-time is **polling** via TanStack Query `refetchInterval` — cadence in one
place: `MESSAGE_POLL_MS` (open thread) and `CONVERSATION_LIST_POLL_MS` (list + nav
badge) in `frontend/src/api.js`. Real-time chat via Django Channels would need an
ASGI server + Redis channel layer — real infra deferred per `docs/SHARED.md`. At
family scale polling is indistinguishable to users and far simpler/cheaper. **The
swap is non-breaking by design:** the REST endpoints and data model stay identical;
going real-time later just adds a Channels consumer and replaces the interval with
a socket subscription — no schema/API migration.

## Push notifications

A new message buzzes the other participants' phones (issue #118). The mechanics —
outbox, Expo, receipts, device tokens — are shared with every other push and
documented in [`notifications.md`](notifications.md); what's specific to messaging
is *who gets one* and the fact that it **creates no `Notification` row**.

**No activity-centre row, deliberately.** Messaging keeps its own unread badge and
sits outside the bell. A `Notification` per message would double-surface every
message — once in the badge, once in the activity centre — and bury the things the
centre exists for. So `PushOutbox` takes a `Message` as an alternative target to a
`Notification`, and the send command phrases that row itself.

**Who gets buzzed** — decided in one place, `enqueue_message_pushes`:

| Rule | Why |
| --- | --- |
| Not the sender | It isn't news to them. |
| `active`, not left, active account | The same population that can read the thread. |
| Their `ParticipantInterval` spans the message | **The one that's easy to get wrong.** A `pending` member, or one in a gap between intervals, is clipped out of the thread by `visible_messages_for` — buzzing them would announce a message the app then refuses to show. The interval test is a *single* `filter()` call so one interval must satisfy both ends; split in two, Django joins the table twice and a gap member slips through. |
| Not muted (`Participant.muted_at`) | See below. |
| No unsent push already queued for that thread | **Coalescing.** Ten rapid messages must be one buzz — the unread badge carries the count. Without it the outbox faithfully delivers ten, which is the fastest way to make someone turn notifications off. |

**Two things drop a queued push at send time**, both settled rather than retried
since neither state is ever undone:

- **Already read.** Because the send is out-of-band, by the time the timer drains
  the queue anyone with the thread open — web or app — has polled and moved their
  `ConversationRead` marker past the message. Comparing against that marker gets
  "don't buzz me for the thread I'm looking at" with no presence system, no
  heartbeat, and nothing for the app to report. It also covers a message read on
  another device before the timer fired.
- **Deleted since enqueue.** Message deletion is *soft* (a tombstone, so the
  thread doesn't reshuffle), so there's no cascade to take the queued push with
  it the way there is for a hard delete. Without this check, deleting a message
  you regret still buzzes everyone up to a tick later and the tap lands on
  "message deleted". The two together are what make "a push for deleted content
  cannot fire" true for messages in both senses.

**The body never quotes the message.** It reads `New message from Ada`, or
`Ada in Book Club` for a titled group. Push bodies transit Expo's servers and
Apple's, so naming the sender is the most we ever say — that rule is what makes
pushing private messages acceptable at all.

**Mute** is per-participant (`Participant.muted_at`), not per-conversation, so
silencing a busy group chat is your choice alone. It lives on `Participant` rather
than in `NotificationPreference` because there is no notification *kind* to hang a
preference off. It's checked at **enqueue**, matching how a muted kind never
reaches the outbox either — one gate, nothing to keep in sync; the cost is that
muting isn't retroactive (an already-queued push still goes out, a second or two
later). **Mute stops the buzz, not the messages**: the thread keeps accruing unread
and keeps its badge, so a muted chat is quiet, never hidden — nobody should be able
to lose a conversation by silencing it. Both clients expose the toggle in the
thread header, the web included: the setting is server-side and per-person, so the
browser is a perfectly good place to turn off the buzzing in your pocket.

**A thread with no `Participant` rows sends nothing** — the legacy 1:1 shape that
predates Phase 6a (real ones were backfilled by migration `0009`; only threads
built straight off the model, as Phase 5's tests do, still lack them). Silence is
the right failure: visibility is decided by intervals, and without them there's
nothing to decide it with.

## Frontend

Messaging is a **non-modal companion drawer** (`MessagesDrawer.jsx`, driven by
`MessagingProvider` — *not* a route), docked to the edge so the feed stays
scrollable behind it and you keep your scroll position. It walks list → thread →
new-message:

- **New chat** — a multi-select connection picker → 1:1 or group chat (+ optional
  title). Launched from a Group page it's scoped to that group (pool = group
  members ∩ your connections).
- **Thread** — header actions: **Mute** (a bell, struck through when muted — on
  every thread, direct or group) and, for groups, **Add people** and **Leave**. A
  `pending` viewer sees a **locked panel**: "Connect with C & D to join", inline
  connection-request buttons, and a **Decline / Leave** button.
- **Sender attribution (group threads only).** An incoming message in a *group*
  carries its sender's avatar + name on one line above the bubble; a **run** of
  consecutive messages from the same person shares a single label, so a burst
  doesn't repeat the name on every line. Three deliberate exclusions: **1:1
  threads** show none (there's only one person it could be, so it's pure noise),
  **your own** messages show none in either flavour (right-alignment + the accent
  fill already say they're yours), and a run's *later* bubbles show none. The
  label needs no API support — messages already carry a full `sender` object and
  the thread already knows `kind === "group"`. A deleted message still starts a
  run if it's first, so its tombstone stays attributed and you can tell whose
  message went.
- **Disconnect / Block** on a profile opens a confirm modal listing the chats it
  will remove you from (from `disconnect-impact`).
- Legacy `/messages[/:id]` URLs still open the drawer (a catch-all route avoids a
  blank screen). It coordinates with the left-docked [groups](groups.md) drawer on
  narrow viewports (opening one closes the other below 800px).

## Mobile (Phase 9 E2)

The iPhone app is a **client port of exactly this API — no backend change.** It
deliberately drops the web's companion-drawer model (a web-only rationale: keep
the feed's scroll position beside the chat) for the standard phone shape: a
**Messages tab** for the conversation list, with full-screen **thread** and
**new-chat** screens pushed *over* the tab bar. The web's `MessagingProvider`
(view state in React context) is replaced by Expo Router routes —
`mobile/src/app/(tabs)/messages.tsx`, `messages/[conversationId].tsx`, and
`messages/new.tsx`. Same endpoints, same `MESSAGE_POLL_MS` /
`CONVERSATION_LIST_POLL_MS` cadences (paused when the app is backgrounded), same
per-thread + tab unread badges, pending `PendingChatPanel`, and group
sender-attribution runs.

Two behaviours differ because the medium does, not the model: **delete-your-own**
is a long-press → confirm (a phone has no hover for the web's inline Delete), and
the **Message** button on a profile pushes the thread full-screen rather than
opening a drawer alongside.

**New-message push** (issue #118) is the one place the app gets something the web
can't have. A tapped message push deep-links to the thread via `routeForNotification`
(`/messages/<id>` → `/messages/[conversationId]`); the thread screen's existing
mark-read-on-open clears the badge, so the tap path needs nothing special. It's the
only push with `notificationId: null` and `kind: "message"` — there's no
activity-centre row behind it. See [Push notifications](#push-notifications).

## Not end-to-end encrypted (yet)

Messages are stored in the database **in plaintext** and are readable by the
maintainer via the Django admin — like all app data. Say this plainly in any
privacy policy; don't imply E2E we don't provide. **E2E is a stated long-term
goal** but a large, separate undertaking (the server could then never read
messages, so previews/search/web-reading move client-side; it needs
client-managed per-device keys, key exchange/verification, and multi-device sync —
best on a proven protocol like libsignal, once the phone apps exist). Practical
interim steps: TLS in transit (done), locked-down admin, and possibly
encryption-at-rest for the messages table.
