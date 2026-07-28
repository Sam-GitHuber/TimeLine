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
  soft-delete `deleted_at`, and `edited_at` (null = never edited).
  `ordering = ["created_at", "id"]` (oldest-first, stable tiebreak). `edited_at`
  is deliberately *not* `auto_now`, which would also fire on the soft-delete
  write and mislabel a deleted message as edited. See
  [Editing a message](#editing-a-message). Emoji reactions hang off it via the
  shared `Reaction` model's nullable `message` FK — see
  [Reacting to a message](#reacting-to-a-message). Two nullable self-FKs carry
  reply threads: `reply_to` (the message answered) and `thread_root` (the head of
  its thread, denormalised in `save`) — see
  [Reply threads](#reply-threads). Both are `SET_NULL`: hard-deleting a quoted
  message must orphan its replies, never take them with it.
- **`ConversationRead`** — `(conversation, user, last_read_at)`, unique together.
  Unread for you = visible messages with `created_at > last_read_at` and
  `sender != you`. Its own table (not two timestamps on `Conversation`) is why
  per-member unread "just works" for N participants. Phase 9b M4 gave it a second
  job: it's also what the **read receipt** ticks are computed from — see
  [Send state & read receipts](#send-state--read-receipts). No new model was
  needed, because "when did you last read this" was already stored.
- **`accounts.User.send_read_receipts`** — boolean, default `True`. Whether you
  share read state. On the *user*, not in `NotificationPreference`; see
  [the setting](#the-setting-usersend_read_receipts) for why.
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

## Editing a message

Added in Phase 9b M1, off the first real beta report: *"there's no way to edit
messages to correct spelling mistakes."* `PATCH` the message with a new `text`;
`MessageSerializer` then reports `is_edited: true` and `edited_at`, and both
clients show an **"Edited"** marker beside the timestamp.

**The marker is not decoration — it's the thing that makes editing safe.** A
thread is a record two people share. An edit that showed no trace would let
either side change what the other already read, which quietly makes the whole
history untrustworthy. Disclosure is the price of the feature.

**There's a 15-minute window** (`MESSAGE_EDIT_WINDOW` in `views.py`, one
constant). Unlimited editing has the same problem in slow motion: someone
rewrites a message you already replied to, and your reply now sits under words
that were never said. Fifteen minutes covers "I typed teh" and excludes "I
rewrote yesterday". The mobile client hides the Edit action past the window so it
doesn't offer an action that will 403 — `MESSAGE_EDIT_WINDOW_MS` in
`mobile/src/api.ts` mirrors the constant, and the server stays authoritative.

Five rules, each a deliberate answer rather than an oversight:

| Rule | Why |
| --- | --- |
| The message must be **visible to you** (**404**) | The lookup runs through `_messages_for_viewer`, so it's interval-clipped exactly like the thread and like `can_view_message`'s report gate — [the same rule in all three places](#history-is-interval-clipped), never a second copy that drifts. Without it the 403/404 split below becomes an existence oracle: a member who was `pending` across a gap could tell which message ids landed while they were away. No text leaks either way, but existence is still theirs to not know. |
| Sender only (**403**, not 404) | Within that clipped set the message is visibly there in your thread and you already know who sent it, so 403 leaks nothing and pretending otherwise would be theatre. |
| Not deleted (**400**) | There's no text left to correct, and refilling a tombstone would resurrect a message the thread already showed as gone. |
| Inside the window (**403**) | Above. |
| You must still be able to *send* here (**403**) | An edit writes new text into the thread, so `_assert_can_send` is consulted for both. Without it, the 15 minutes after a disconnect or a sever would be a back door for putting fresh words into a thread you've lost access to. This is the same helper the send path uses — one gate, not two that drift. |

The **404-for-delete / 403-for-edit** asymmetry on the one URL is deliberate and
settled rather than overlooked: each verb is scoped to what its caller can
already see, so both are safe, and re-shaping `DELETE`'s long-shipped contract
purely for symmetry would be churn.

**An edit does not bump `Conversation.updated_at`.** Fixing a typo shouldn't jump
the thread to the top of everyone's conversation list. The list preview still
updates, because it's a `DISTINCT ON` over each thread's latest message and so
reads the new text with no bump needed. Both halves are asserted in
`MessageEditTests` — the pairing is easy to break by accident.

**No push, no `Notification` row, no re-buzz.** The push rules are untouched: an
edit is not news, and a correction buzzing everyone's phone a second time is how
people end up turning notifications off. Nothing had to change for privacy
either, since [push bodies never quoted message text](#push-notifications).

## Reacting to a message

Added in Phase 9b M2. The model, the emoji validator and the endpoint shape are
[the feed's](reactions.md) — `Reaction` was widened with a nullable `message` FK
rather than forked into a parallel model — so **[reactions.md](reactions.md) owns
the details**. What's specific to messaging:

- **The gate is this document's gate.** `POST /api/messages/<id>/react/` resolves
  its target through `can_view_message`, so it's
  [interval-clipped](#history-is-interval-clipped) exactly like the thread, the
  report gate and the edit route — one rule in four places, never a fourth copy
  that drifts. A gap member gets a 404, indistinguishable from an id that never
  existed.
- **Reacting needs `can_send`, like editing does.** A reaction is content the
  whole thread sees, so being severed or disconnected stops it (403). Reading who
  reacted still works: losing the ability to write is not losing the history.
- **A deleted message is removal-only.** Adding a reaction to a tombstone is a
  400 — there's nothing left to react to — but taking one *off* still works,
  because the tombstone keeps showing reactions left before the delete and has no
  long-press menu to remove them from. See
  [reactions.md](reactions.md#message-reactions-phase-9b-m2).
- **No pruning.** Post reactions are pruned per viewer because a reactor might be
  someone you can't see; a chat's active participants are a clique by
  construction, so everyone who can see the message can see every reactor.
  Everyone in a thread therefore agrees on the counts, which is *not* true of a
  post.
- **No push, no `Notification` row** — messaging stays out of the bell for the
  [reason below](#push-notifications), and a phone buzzing for a 👍 is how people
  end up turning notifications off. Both are asserted in `MessageReactionTests`,
  because the shared toggle helper writes a notification for every other target.
- **A reaction doesn't bump `Conversation.updated_at`**, for the same reason an
  edit doesn't: it isn't new activity, so it mustn't jump the thread to the top of
  everyone's list.

## Reply threads

Added in Phase 9b M3. Replying to a message puts your reply in the transcript
where it belongs chronologically, with a collapsed quote above it — and tapping
into it brings **the whole strand forward** over a blurred transcript, scrollable,
with its own composer.

**Why a focused thread and not just a quote.** The cheaper pattern (each reply
shows the one message it answers, and nothing else) was the original plan and was
re-specified after trying it: with only quotes, a back-and-forth inside a busy
chat can't be *read* as a conversation — you reconstruct it by scrolling and
matching quotes by eye. Bringing the strand forward keeps a side conversation
legible without the main thread reordering itself around it.

**One level deep, always.** `reply_to` records exactly which message you
answered; `thread_root` records the head of the thread, derived in
`Message.save` as `reply_to.thread_root or reply_to`. So replying to a reply
*joins* that thread rather than nesting inside it. A tree would need recursive
reads to render and would grow branches nobody can follow on a phone; one flat
strand per root is where every mainstream messenger landed. The denormalised
column is also what makes "give me this thread" and "how many replies has this
got" single indexed queries.

### 🔒 The visibility rule

> **Everything about a quoted message passes through the same interval clipping
> as the thread — its words and its author alike.**

Concretely, two halves:

- **A reply carries a bare id and nothing else.** `MessageSerializer.reply_to` is
  `{ id }`. Embedding the body would hand it to anyone who can see the *reply*,
  walking straight around
  [`visible_messages_for`](#history-is-interval-clipped): a member who was
  `pending` across a gap would read clipped-out history through someone else's
  quote of it.
- **The body *and the author* are fetched, not sent along.** The client renders
  the quote from a message it already holds, from the thread endpoint below, or
  by asking for it by id ([`?ids=`](#api), added in M5) — all three
  interval-clipped, which is the only property that matters. When it can't be
  resolved, "Original message unavailable" is a *true* statement about a message
  the viewer isn't entitled to, and it appears with **no name above it**.

**Why the author counts as history.** M3 first shipped `reply_to` as
`{ id, sender }`, on the reasoning that a name is not a message — you're only
being told who wrote something you may already be looking at. That's wrong in a
group. Someone can join, post, and leave again entirely inside your interval gap,
and `participants` lists only *current* members, so a later reply quoting them was
the one payload that would hand you a name and an avatar for a person you were
never in a chat with. Dropping `sender` costs nothing: a client that resolved the
quoted message has its author already, and a client that couldn't isn't entitled
to the author any more than to the words. One rule, and no per-viewer branch to
get wrong — **if you can't see the message, all you learn is that your reply-mate
answered something.**

An earlier draft of the plan took the stricter line — render the quote only from
the client's own cache, never fetch it — on the grounds that this makes the leak
structurally impossible. It's worth recording why that was relaxed, because the
strict version *looks* safer: fetching the quoted message through the clipped
endpoint doesn't route around the clipping, it goes through the front door. The
strict rule also had a real defect, in that "Original message unavailable" would
appear whenever the original merely hadn't paged in yet — indistinguishable to
the user from a genuine privacy clip, which devalues the message in the case
where it matters. And neither version survives or fails differently under
[E2E](#not-end-to-end-encrypted-yet): the server hands over ciphertext either
way, and fetching a message by id was never the thing encryption takes away.

**Reply counts are clipped too.** `reply_count` is annotated over the *viewer's*
visible messages (`_with_reply_counts`), not with a plain
`Count("thread_messages")`. A count is small, but it's still existence: telling a
gap member "3 replies" on a message they can't see reveals how much happened
while they were out, which is the same thing the 404-not-403 rules elsewhere
refuse to answer.

### Every route to a reply goes through the strand

**Replying opens the focused thread** — it does not aim the transcript's composer
at a message. That holds even when the message has no replies yet, which opens a
strand one bubble long, on purpose: you reply *inside* the conversation you're
joining, with the thing you're answering on screen while you write it.

The first cut did the other thing (a "Replying to X" bar above the transcript's
composer, the way most messengers do it) and it was replaced after use. It shows
you the one message you're answering and none of the exchange around it — the
same limitation that made the collapsed-quote-only design wrong in the first
place. Having built both, the strand is the answer to both.

So there are three ways in, and they differ only in what the composer aims at:

| Route | Composer answers | Keyboard |
| --- | --- | --- |
| **Reply** in the long-press menu | the message you tapped | up |
| **"N replies"** on a root | the root | down |
| **A reply's quote** | the strand's root | down |

Replying to a reply targets *that* reply, not the root. The server flattens it
into the same strand either way, so this costs nothing and keeps the quote naming
who you actually answered. The strand names the target above its composer only
when it isn't the root — otherwise the label would restate the message already
sitting at the top of the screen.

**The quote being a way in isn't just convenience.** When the root is one the
viewer was clipped out of, its replies stand alone in the transcript with no root
to carry a count, so without it the strand would be unreachable for exactly the
person whose view of it is already partial. It opens headless, saying so.

Because the strand has its own composer, replying no longer competes with
editing: a half-written message, or an edit in progress, is untouched by a trip
into a thread and still there when you close it.

A reply is otherwise an ordinary message: it bumps `updated_at`, counts toward
unread, and [pushes](#push-notifications) like any other. Nothing about replying
was made an exception.

## Send state & read receipts

Added in Phase 9b M4. Two halves that ship together but stand alone: a message
appears **the instant you send it**, and your own bubbles carry a tick saying how
far it has got.

### Optimistic send: the outbox

A message used to appear only after the round trip, which on a polling app is
the entire perceived latency of sending. Now it's rendered immediately with a
clock, and reconciled when the server answers.

**It lives in an outbox (`mobile/src/outbox.ts`), not in the TanStack cache** —
the one non-obvious decision here, and the plan originally said the opposite.
The thread refetches `['messages', id]` every `MESSAGE_POLL_MS`, and a refetch
*replaces* an infinite query's pages, so an optimistic write survives at most
four seconds. Tolerable for the in-flight moment; fatal for a **failed** send,
which has to sit there until the person decides what to do with it. Keeping
unsent messages outside the server-truth cache means the two never have to be
reconciled: the cache holds exactly what the server said, the outbox exactly
what it hasn't accepted.

Consequences, each deliberate:

- **A failed send keeps its place**, dimmed, with **Retry** and **Discard** on
  the bubble. Text someone typed is never dropped for them; Discard is one tap,
  but it has to be *their* tap.
- **The failure is reported on the bubble, not in a banner** under the composer.
  It's nearer the thing that went wrong, and it's the only thing that works when
  two messages are in flight and one of them fell over.
- **The composer clears on dispatch and never blocks.** Sending two quick
  messages in a row is ordinary, and waiting for the first is exactly the lag
  this removes. An *edit* still blocks, because it targets one specific message
  and two saves racing on it would be genuinely ambiguous.
- **Replies go through the same outbox**, so a reply that fails inside a strand
  is recoverable both there and in the transcript — rather than existing only
  inside a view you've since closed.
- **An unsent message has no long-press menu.** Every action it offers (edit,
  delete, react, report) needs a server id it hasn't got.

**The store outlives the screen**, keyed by conversation id. It began as
component state, which meant tapping back threw away the failed message — the
one thing the outbox exists to hold on to — on the most ordinary gesture in the
app, silently. Two things follow. Sign-out calls `clearOutbox()`: unsent text is
one person's words, and the next person to pick the phone up isn't them. And a
send still in flight when you leave settles itself, because TanStack captures a
mutation's options when it starts and runs them whether or not the screen is
still mounted — otherwise you'd come back to the message twice, once from the
server and once wearing a clock that never stops.

**One honest gap: Retry can duplicate.** There's no idempotency key, so a POST
the server committed but whose response never reached the phone — a timeout, a
tunnel — lands as `failed`, and retrying it sends the text a second time. Two
identical messages, with nothing to tell them apart. Solving it properly means a
client-generated id the server dedupes on, which is a schema change and a real
piece of protocol for a case that needs a lost response rather than a lost
request. Recorded rather than fixed, because the alternative failure — dropping
what someone typed, or not offering Retry at all — is worse, and a duplicate is
visible and deletable where a lost message isn't.

### Ticks: three states, not four

Clock (sending) → one tick (sent) → **two accented ticks (read)**. There is no
"delivered" tick, and that's a decision rather than a gap: nothing in our stack
reports that a device received a message. We could infer one from an Expo push
receipt, but that means *"we handed it to Apple"*, which is emphatically not what
anyone reads a tick as. Better one fewer state, honestly.

Ticks appear on **your own** messages only — on an incoming one a tick would be
telling you that you read it.

### How "read" is decided

`last_read_at` and `active_since` ride on each entry of the **conversation
detail**'s `participants` list (`attach_read_receipts` in `views.py`); the client
compares them against each message's `created_at` in
`mobile/src/readReceipts.ts`. One small field on a payload the thread already
loads, and **zero per-message cost** — which is why it isn't computed
server-side per message.

**The detail is therefore polled**, on `CONVERSATION_DETAIL_POLL_MS` (12s), and
that's structural rather than a nicety. A marker fetched once when the thread
opened is by construction older than every message you send afterwards, so a
mount-time snapshot can only ever say "sent" about the message you're actually
watching — the second tick would appear only after leaving the thread and coming
back, which is the one moment nobody is looking. Slower than the message poll on
purpose: the detail endpoint costs several per-conversation queries where the
message poll is one cheap page, and a tick landing within ~12s reads as prompt
where a *message* 12s late would not.

The audience for a message excludes three groups, each answering a way the tick
would otherwise be wrong:

| Excluded | Why |
| --- | --- |
| **You** | Sending is self-evidently reading. |
| **`pending` members** | They genuinely can't read the thread, so waiting on one means a tick that never completes for as long as an invitation sits unanswered. The server doesn't send their marker at all, so this holds even if a client forgets to check. |
| **Anyone not reporting** — opted out, or with no open interval | See the setting below. Excluding rather than *blocking* is what stops one person's opt-out silently disabling ticks for a whole group. |

`active_since` (the start of their **currently open** `ParticipantInterval`) is
what stops a late arrival stalling the tick on every message sent before them:
someone added yesterday was not in the audience for last week's message. Without
it the client would either wait on them forever or credit them with reading
something they were never shown.

**This is a display heuristic, and nothing about access control leans on it.**
The authoritative predicate stays in `visible_messages_for` and
`enqueue_message_pushes`; the ticks read data the server already chose to send.
The one place the two diverge is a member who left and came back — the client
sees only their current interval, so a message from before their gap doesn't
wait on them. That's unknowable anyway (their read marker moved on while they
were away) and it errs toward not stalling the tick.

Two honest trade-offs, recorded so they aren't mistaken for bugs:

- The double tick means "everyone **who shares read state** has read it", which
  is a slightly weaker claim than "everyone".
- An empty audience stays at one tick. Nobody to have read it, so claiming
  otherwise would be a lie.

### The setting: `User.send_read_receipts`

**Default on** — it's what people arriving from any mainstream messenger expect,
and a feature nobody discovers is a feature nobody has. Exposed on
`GET`/`PATCH /api/auth/user/` and surfaced in a **Privacy** section of Settings
on both clients.

**Symmetric, and enforced server-side.** With it off your read marker is omitted
from everyone else's payload *and* theirs from yours — you stop reporting and
stop being told, in one switch. Anything else is a one-way mirror, which is the
shape a privacy setting must not have. The client never *receives* what the
setting says it shouldn't have; hiding a tick drawn from data already on the
device would be theatre. `MessageReadReceiptTests` asserts the field is **absent
from the response**, because a UI test showing a tick didn't render proves
nothing about what crossed the wire.

**Absent and `null` mean different things**, and the distinction is load-bearing:

- *key missing* — "we're not telling you" (one of the two has receipts off);
- *`null`* — "they have never read this thread", which is real information the
  setting permits.

Collapsing the two would let a client read an opt-out as someone who never
opened the chat.

**It lives on `accounts.User`, not in `NotificationPreference`.** A preference
row is keyed by a notification *kind*, and there is no "someone read your
message" notification to hang this off — nothing is created, sent or buzzed. The
same reasoning put `Participant.muted_at` on the participant. (Contrast the
planned M8 mentions-override, which *is* a notification kind and so does belong
there. The pair reads as a rule, not an inconsistency.)

**Groups are not carved out.** Some messengers exempt them; we don't — "you
can't turn this off in group chats" is precisely the exception that makes a
privacy toggle untrustworthy.

When *you* have it off the thread shows **no ticks at all**, rather than a column
frozen on one tick — which would read as "nobody is ever opening these", a worse
lie than showing nothing.

**`pending` members are out of it on both sides**, regardless of settings. A
pending *viewer* gets no read state at all: they can't read a message here, and
"who's been active in this thread and when" is still activity in a conversation
they haven't been let into. And a pending *member* is reported to nobody — their
marker can be a real timestamp, because someone who drops back to pending keeps
the one from their last active spell, and it isn't ours to hand over while
they're in the waiting room. The clients skip pending rows when computing ticks
anyway; withholding server-side is the half that doesn't depend on them doing so.

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
  - Each participant also carries **`last_read_at` + `active_since`** (Phase 9b
    M4), omitted entirely when either party has receipts off. **Detail only** —
    a list row shows an unread count, not who's read what, and putting them there
    would pay the extra queries once per row. See
    [Send state & read receipts](#send-state--read-receipts).
- `GET /api/conversations/<id>/messages/` — oldest-first, paginated, **clipped to
  your intervals**; 403 (locked) while pending.
  - `?thread_root=<id>` narrows it to **one reply thread** — that root plus every
    reply hanging off it. A *filter on the same queryset*, deliberately not a
    route of its own: a second endpoint would be a second home for the
    visibility rule, and this way a thread can never show a message the
    transcript wouldn't. A viewer clipped out of the root gets the replies they
    can see and no head. Non-numeric ids are a 400. Being the same endpoint it
    **paginates like the transcript**, so a client must follow `next` — a strand
    longer than one page is otherwise silently cut off at its *oldest* messages,
    hiding the newest replies and the one the reader just sent.
  - `?ids=<a,b,c>` narrows it to **specific messages** (Phase 9b M5) — how a
    reply's collapsed quote gets its words and its author, now that the app's
    transcript pages lazily. Same trick, same reason: an id the viewer is clipped
    out of is simply **absent** from the response, indistinguishable from one
    that never existed, with no second code path to get wrong. Capped at
    `MESSAGE_IDS_MAX` (50); an empty list returns nothing rather than everything.
    See [Reply threads](#reply-threads).
  - `?order=desc` returns **newest-first** (Phase 9b M5). Without it the newest
    messages sit on the *last* page, so opening a chat means walking every page
    to reach the bottom of it — which is exactly what the app used to do. It's
    an opt-in parameter and not a change of default because the web drawer still
    reads the thread oldest-first, and an old client meeting a reordered payload
    is the break the [compatibility rule](#frontend) exists to prevent.
- `POST /api/conversations/<id>/messages/` — send; active participants only; bumps
  `updated_at`. Optional `reply_to_id` makes it a reply
  ([Reply threads](#reply-threads)); it's validated against **your own**
  interval-clipped messages, so an id from another thread or from inside a gap
  is rejected exactly like one that never existed.
- `POST /api/conversations/<id>/read/` — mark read up to now (clears unread).
- `POST` / `DELETE /api/conversations/<id>/mute/` — mute / unmute **your** push
  notifications for this thread; returns `{ muted }`. Member-only (404
  otherwise). The state also rides on the conversation payload as `muted`.
- `DELETE /api/conversations/<id>/messages/<msg_id>/` — **soft-delete** your own
  message (blanks `text`, sets `deleted_at`, keeps a "message deleted" tombstone in
  place so the thread doesn't silently reshuffle and pagination isn't disturbed;
  deleted messages don't count toward unread).
- `PATCH /api/conversations/<id>/messages/<msg_id>/` — **edit** your own message,
  body `{ text }`. Sender-only (403), not deleted (400), within the edit window
  (403), and only while you could still *send* here (403). Validated by exactly
  the same rules as sending. See [Editing a message](#editing-a-message).
- `POST /api/conversations/<id>/participants/` — add people; any active member,
  each an addable connection.
- `POST /api/conversations/<id>/leave/` — self-leave **or** decline-invite.
- `GET /api/users/<id>/disconnect-impact/` — the shared active chats a
  disconnect/block would pull you from, to drive the warning modal.
- `GET /api/messages/unread-count/` — single number for the nav badge (so it
  doesn't load and sum the paginated list).
- `POST /api/messages/<id>/react/` — **toggle** your emoji reaction on a message;
  `GET /api/messages/<id>/reactions/` — who reacted, grouped by emoji. Keyed on
  the message id alone (not nested under the conversation, unlike edit/delete):
  the conversation is reachable from the message and the gate consults it anyway,
  so a conversation id in the path would be a second thing to keep consistent and
  nothing to check against. See [Reacting to a message](#reacting-to-a-message).
- `PATCH /api/auth/user/` with `{ send_read_receipts }` — turn read receipts on
  or off (Phase 9b M4). Not a messaging route: it's a flag on the user, and this
  is already the "who am I / change my settings" payload both clients hold, so
  the Settings toggle needs no extra fetch. See
  [the setting](#the-setting-usersend_read_receipts).
- `POST /api/reports/` with `{ message: <id>, reason? }` — flag a message for the
  maintainer. Shares the endpoint (and the queue) with post/comment reports; see
  [Moderation](#moderation-a-report-is-the-only-window) below and
  [accounts.md](accounts.md).

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

**The web is behind on Phase 9b and that's expected, not broken.** Every 9b
response field is additive, so the drawer ignores `is_edited`/`edited_at`,
`reactions`, `reply_to`/`reply_count` and the participants' `last_read_at`, and
simply renders an edited message as its new text with no marker and a reply as an
ordinary message. Web parity is its own milestone (9b M9), which also splits
`MessagesDrawer.jsx` up. Four visible degradations until then — the missing
"Edited" marker, message reactions being invisible, a reply reading as an
unattached message, and no ticks or optimistic send — worth saying out loud
rather than having someone discover them. All four are stored and all four show
in the app.

**The read-receipts *setting* is the exception, and is on the web now** (a
Privacy section on `/settings`). The disclosure happens whether or not this
browser draws the ticks, so a member who only ever uses the web still has to be
able to opt out of it. A setting that exists only where the feature is visible
would be a setting half the members can't reach.

When M9 does port replies, **the focused thread should not be a blur on the
web**: a phone blurs the transcript because it has one screen, a desktop has
width, so the right shape there is a side panel beside the transcript. Same
endpoint, same data, different medium.

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

Two behaviours differ because the medium does, not the model: **message actions**
are a long-press (a phone has no hover for the web's inline Delete — see below),
and the **Message** button on a profile pushes the thread full-screen rather than
opening a drawer alongside.

### The long-press action menu (Phase 9b M1)

Long-pressing a bubble dims the thread, keeps the pressed bubble at full
brightness, and floats a small menu **directly beneath it** — a quick-reaction
row across the top (M2), then Copy · Edit · Delete on your own, Copy · Report on
someone else's. A deleted message's tombstone has no menu; there's nothing left
to act on. In a thread you can no longer send to, the reaction row is left out
rather than shown offering something the server would 403.

**It's deliberately not an `ActionSheetIOS`,** even though `PostMenu` is and
reusing it would have been less work. A sheet slides up from the bottom of the
screen detached from the thing it acts on, so if the long-press landed on the
wrong bubble there is nothing on screen to tell you before you tap Delete. The
anchored menu makes the target unmistakable, which is the whole justification for
the extra machinery: `MessageBubble` measures its own rect, `MessageActionMenu`
renders a transparent `Modal` and re-renders **the same** `BubbleBody` at that
rect (a real component, not a lookalike that would drift), placing the menu below
— or above, when the bubble sits too low for it to fit.

Three implementation notes worth keeping:

- **The item list is data** (`messageActions()`), not JSX, because M2 (react) and
  M3 (reply) insert entries into this same menu.
- **The actions are decided at press time, not render time** — one of them
  expires, so a render-time `Date.now()` would make the menu's contents depend on
  when React last redrew.
- **`src/measure.ts` is a seam, not indirection.** Measuring a view is native, and
  under Node the callback never fires — RN's Jest preset installs a per-instance
  no-op reached via `requireActual`, so it can't be mocked from outside. Owning
  the seam lets `jest.setup.js` supply a rect, which keeps the menu genuinely
  testable and keeps timers and fallbacks out of the UI.

**Editing happens in the composer**, which grows an "Editing message" bar showing
the original with an ✕ to cancel; the input is prefilled and focused and Send
becomes Save. Cancelling restores whatever you were half-typing before you
started editing, and an emptied composer just disables Save — there is no path
from "editing" to an accidental delete.

**Report** was already built end-to-end by M0 (endpoint, `reportContent`,
`ReportModal`); M1 only added the menu entry that opens it, which is the UI entry
point M0 deliberately shipped without.

**Reactions render as pills** hanging off the bubble's lower edge on its near
side. **Tapping one opens "who reacted"; it never toggles** — a pill displays what
the thread said, so a tap goes to the detail of it rather than quietly changing it.
Changing your own reaction has two unambiguous homes instead: the menu's emoji row
(tapping one you've used takes it off) and that sheet, where your own row reads
"Tap to remove". The full picker opens at
*screen* level rather than inside the menu, because `rn-emoji-keyboard` is itself
a `Modal` and two visible modals stack badly on iOS; the menu closes on its way
there. There's no optimistic pre-tap update: the toggle endpoint returns the whole
fresh aggregate, and simulating it locally would mean a second copy of rules the
server owns (the per-target emoji cap, emoji validation, count-then-emoji
ordering) that could show a pill and then take it away. See
[reactions.md](reactions.md#mobile) for the emoji set and why it differs from the
feed's.

### Send state on the phone (Phase 9b M4)

`MessageBubble` draws the clock/tick beside the timestamp inside `BubbleBody`,
so the action menu's re-render of the pressed bubble shows it too. The glyphs are
hand-drawn SVG (`SendStateIcon` in `icons.tsx`) rather than text: at 13px a font
check doubled up reads as a smudge, and the two ticks need a consistent overlap.
Only **read** is drawn at full strength — sending and sent sit at the
timestamp's opacity, because a tick that shouts on every message is a tick
nobody reads.

The outbox is a store in `outbox.ts` rather than the screen's state (see
[above](#optimistic-send-the-outbox)); the screen subscribes to its own
conversation's slice with `useOutbox(id)` and hands the focused thread view what
it needs by props (`outgoing`, `statusFor`, `onRetry`, `onDiscard`), so the
strand renders its own unsent replies rather than leaving them visible only in
the transcript behind the blur. The strand asks the *status* whether a bubble is
unsent rather than testing its id for a negative sign — the temp id is the
outbox's business, and that view doesn't own the outbox.

### Reply threads on the phone (Phase 9b M3)

**Two affordances, one gesture each** — the rule M2 settled, applied to the same
bubble: **long-press** for the action menu (Reply lives in it), **tap the branch**
(or a reply's quote) to open the thread. The bubble's own tap stays free, and
should: a target that small doing different things by press duration is where a
mis-timed press does the wrong thing.

**There is no swipe-to-reply, and that's a decision, not an omission.** M3 first
shipped a rightward swipe on the bubble and it was pulled after a day of real
use. A rightward drag starting near the left of a screen is also the navigator's
interactive back gesture, so the two raced for the same touch and the navigator
usually won: you'd swipe a bubble and land back on the conversation list with no
reply started. No threshold tunes that away, because both gestures are
legitimately claiming the drag — the loser is whichever responder happens to win
the touch on the day. Long-press → Reply is one unambiguous route that never
fights the navigator. Bringing the swipe back would mean disabling the screen's
own back gesture while a bubble owns the touch, which is more machinery than the
affordance is worth.

The transcript's composer keeps its **two** modes (write, edit) — replying
happens in the strand's own composer, so the two never compete. An earlier cut
gave this screen a third "Replying to X" mode; see
[Every route to a reply goes through the strand](#every-route-to-a-reply-goes-through-the-strand)
for why it went.

**The focused view** (`MessageThreadView`) is an `expo-blur` `BlurView` over the
transcript with the strand floating on it. The blur is doing real work rather
than decoration: a plain dim scrim reads as "a modal over a list", where the blur
reads as the same conversation pushed out of focus — you haven't gone anywhere,
you've narrowed to one strand. **It deliberately offers no long-press menu**:
`MessageActionMenu` is itself a `Modal`, and presenting a modal from inside a
presented one is the iOS trap the emoji picker already documents. Close the
thread and act on the message in the transcript.

### The transcript (Phase 9b M5)

The milestone with no new feature in it, and most of the reason the thread felt
wrong. Everything here is mechanics.

**It loads one page.** The screen used to walk `fetchNextPage` in an effect until
every page was in memory, so opening a chat pulled its entire history —
invisible at family scale on day one and worse every month. That wasn't
carelessness so much as a consequence: the endpoint's default order is
oldest-first, so the *newest* messages are on the last page and "show me the
bottom of this chat" genuinely meant loading all of it.
[`?order=desc`](#api) inverts that, the list is an **inverted `FlatList`**, and
`onEndReached` — the top, on an inverted list — pages backwards into history.

Inverting the list is what makes several other things stop being workarounds. It
deleted a `scrollToEnd`-on-every-content-change hack, and it means the newest
message stays pinned while the keyboard animates rather than being chased back
into view afterwards.

The known cost, and it's the feed's too: the endpoint pages by page *number*, so
a message arriving mid-scroll shifts the window and a page can re-send what the
previous one showed. `toThreadRows` de-duplicates by id — two rows sharing a key
makes React warn and lets `FlatList` recycle the wrong one — and the four-second
poll refetches every loaded page, so any gap at a boundary heals itself.

**Reading a transcript, rather than a list of bubbles.** Day separators
("Today" / "Yesterday" / "12 March", re-derived at local midnight by
`useDayBoundary` so a chat left open overnight doesn't go on saying "Today");
**clock times** rather than "5m ago", because the separator above answers *which*
day and what a bubble has to answer is when in it — the conversation *list* keeps
relative time, where the question really is how recent something is; and **run
grouping**, where consecutive messages from one person sit tighter together and
only the run's last bubble carries the timestamp and the tail corner. A run
breaks at a divider as well as at a change of sender: one straddling "Yesterday"
would read as a single sitting.

Two things are **exempt from run grouping's timestamp suppression**, and both are
load-bearing rather than tidy-ups. An **"Edited" marker** is a disclosure — the
thing that [makes editing safe at all](#editing-a-message) — so it can't be
hidden by where a bubble happens to sit in a run. And an **unsent message** shows
its clock or its failure wherever it lands, or two queued messages would leave
the first looking sent.

**An unread divider** marks where you stopped reading, so a thread you've been
away from opens *there*. It's positioned from `unread_count` on the conversation
detail, captured **once during render** before the mark-read write goes out —
which is also why that write now waits for the detail to land, since if it won
the race there'd be nothing left to capture. The count, not your own
`last_read_at`: the detail withholds every read marker, including yours, when
you've [turned receipts off](#the-setting-usersend_read_receipts), and a divider
that quietly stopped working for anyone who opted out of an unrelated setting
would be a bad trade. When the unread run is longer than the loaded page the
divider is **left out** rather than placed at the top of what happened to load —
pointing at the wrong message is worse than pointing at nothing, and it resolves
itself on the next page.

**Jump-to-latest** appears once you've scrolled away, with a count of what has
arrived since. The count is the point: a bare arrow is a scroll shortcut, and the
open thread is the one place a new message doesn't otherwise announce itself.

**Links are tappable** — URLs and email addresses, opened with `Linking.openURL`.
🔒 This is **not** [link previews](#not-end-to-end-encrypted-yet), which stay on
the "not building" list: nothing is fetched and nothing is rendered from the
target, so none of the tracking/SSRF objection applies. The raw text stays the
source of truth, which also keeps it one opaque blob under E2E. A message that is
**one to three emoji and nothing else** drops its bubble and renders large.

**Drafts survive leaving the thread** (`drafts.ts`, in memory, keyed by
conversation, 🔒 cleared on sign-out with the outbox). Deliberately *not* while
editing: in edit mode the composer holds someone's sent words rather than a draft
of yours, so persisting them would mean coming back to a message you never wrote.

**Quotes are fetched when they haven't paged in.** This is the debt M3 left, and
it had to be settled here. The transcript resolved a quote's body and author from
messages it already held, which was complete *only* because it loaded every page.
With lazy paging a miss also means "not paged in yet", so "Original message
unavailable" — which is supposed to mean *you were clipped out of this* — would
be a lie some of the time, and a message that lies sometimes is worth nothing in
the case where it's true. `quotes.ts` fetches the misses through
[`?ids=`](#api), the same interval-clipped endpoint, and **never** a wider
payload. Each id is asked about **once**: an unresolvable id is a fact about this
viewer, not a transient failure, so re-asking every poll would be a request that
can only ever return nothing. 🔒 What it holds is other people's message text, so
it's cleared on sign-out too.

**New-message push** (issue #118) is the one place the app gets something the web
can't have. A tapped message push deep-links to the thread via `routeForNotification`
(`/messages/<id>` → `/messages/[conversationId]`); the thread screen's existing
mark-read-on-open clears the badge, so the tap path needs nothing special. It's the
only push with `notificationId: null` and `kind: "message"` — there's no
activity-centre row behind it. See [Push notifications](#push-notifications).

## Moderation: a report is the only window

**The Django admin cannot render a conversation's messages.** There is no
`Message` admin, and `ConversationAdmin` shows metadata only — participants,
their status/`left_at`/`muted_at`, kind, timestamps. That metadata is what support
questions are actually about ("why can't Dad see this chat?") and it reveals no
content.

It wasn't always so: a `MessageInline` used to print every message in a thread,
and the docstring called that a disclosed design property. It was removed in Phase
9b, because being *able* to browse a private conversation isn't a feature. The
realistic risk was never an attacker — it was a bored maintainer reading a thread
they had no business reading, and nothing in operating the site needs that.

**The one legitimate reason to read a message is an abuse report, so that's the
only route.** A reporter attaches the specific message, and the `Report` row
stores its own **snapshot** of that text (`Report.message_text`), which the
maintainer reads in the report's admin page. Four properties make this the right
shape rather than a loophole:

- **Scoped to what someone chose to show you.** You see the message that was
  flagged, not the thread around it — and there's no `Message` admin to click
  through to. Acting on a message report means acting on the *person* (block /
  deactivate), not browsing their chat.
- **The snapshot is written server-side from the row, never from the request
  body** — a reporter can't put words in someone else's mouth in the moderation
  queue. It also isn't echoed back in the API response.
- **It survives deletion, which is why it exists.** Message deletion is *soft* (it
  blanks the text), so without a copy a sender could empty the evidence a second
  after being reported. Conversely a message that's *already* deleted can't be
  reported at all (400) — there's nothing left to moderate.
- **The report gate is the messaging gate, not the feed's.** `can_view_message`
  reuses membership + the block check + `visible_messages_for`, so reporting can't
  become a back door into interval-clipped history: a member who was `pending`
  across a gap gets a 404 on a message from inside it, exactly as the thread does.

The snapshot appears only on a report's **detail** page, never the changelist, and
`message_text` is deliberately not searchable — the triage queue shouldn't be a
keyword search over reported private messages.

## Not end-to-end encrypted (yet)

Messages are stored in the database **in plaintext** — like all app data. Say this
plainly in any privacy policy; don't imply E2E we don't provide.

Be precise about what the moderation change above did and didn't achieve. It
removed **casual** access, which is the honest risk here. It did **not** change
what's stored: the rows are still plaintext in Postgres, so anyone with a shell on
the box (the maintainer included) can still read them. Only E2E fixes that, which
is why `PrivacyPage.jsx`'s wording — messages are plaintext, not end-to-end
encrypted, accessible to the operator where necessary — **stays as it is until the
encryption actually ships**.

**E2E is a stated long-term goal** but a large, separate undertaking (the server
could then never read messages, so previews/search/web-reading move client-side;
it needs client-managed per-device keys, key exchange/verification, and
multi-device sync — best on a proven protocol like libsignal, once the phone apps
exist). Practical interim steps: TLS in transit (done), the locked-down admin
(done, above), and possibly encryption-at-rest for the messages table — a modest
improvement, not a substitute, since the key would live on the same box.
