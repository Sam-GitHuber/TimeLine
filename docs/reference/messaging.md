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
  message must orphan its replies, never take them with it. Photos hang off it
  via `MessageAttachment` (Phase 9b M7) — see
  [Photo messages](#photo-messages), which is also where the one place chat
  media differs from every other upload in the app is explained.
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

**An edit and a send don't ask the same question, and both clients have to keep
them apart.** A send needs text *or* a queued photo. An edit is a `PATCH` of text
alone, so what's queued in the composer is irrelevant to it: Save comes alive on
words, *or* on the edited message carrying [a photo of its own](#photo-messages)
— because a caption may be edited down to nothing and still leave a message,
which is exactly what `MessageSerializer.validate`'s `has_attachments` allows.
Conflating the two was a real bug on both clients (web #163, app #164): one guard
read the composer's attachment for both modes, which let an emptied edit fire a
`PATCH` the server 400s, *and* blocked the one edit — clearing a caption — the
server permits. One `canSubmit` per composer answers each mode's own question,
and the button's `disabled` and the submit handler both read it so they can't
disagree. A queued photo is **hidden while editing rather than dropped**: it
can't ride along on the `PATCH`, but losing it because someone stopped to fix a
typo is the betrayal the stashed draft exists to prevent, so it comes back with
the draft when the edit ends.

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
where it belongs chronologically, marked as part of a thread — and tapping it
brings **the whole strand forward** over a blurred transcript, scrollable, with
its own composer. What that mark is changed in M9g: see
[The strand edge](#the-strand-edge).

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
- **The body *and the author* are fetched, not sent along.** No client asks any
  more — [M9g](#the-strand-edge) stopped drawing quotes, so a reply's id is now
  only ever used to say *that* it belongs to a thread. While quotes existed the
  client rendered them from a message it already held, from the thread endpoint
  below, or by asking for it by id ([`?ids=`](#api), added in M5) — all three
  interval-clipped, which is the only property that ever mattered. When it
  couldn't be resolved, "Original message unavailable" was a *true* statement about a message
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
| **Tapping a reply** (its strand edge) | the strand's root | down |

Replying to a reply targets *that* reply, not the root. The server flattens it
into the same strand either way, so this costs nothing and keeps the strand's
composer label naming who you actually answered. The strand names the target
above its composer only when it isn't the root — otherwise the label would
restate the message already sitting at the top of the screen.

**A reply being a way in isn't just convenience.** When the root is one the
viewer was clipped out of, its replies stand alone in the transcript with no root
to carry a count, so without it the strand would be unreachable for exactly the
person whose view of it is already partial. It opens headless, saying so.

Because the strand has its own composer, replying no longer competes with
editing: a half-written message, or an edit in progress, is untouched by a trip
into a thread and still there when you close it.

### The strand edge

Added in M9g, on both clients at once. **A reply in the transcript wears one bar
down the outer side of its bubble, and tapping the bubble opens its strand.** The
bar is the accent on their side; on yours it's white on the accent fill, inside a
1px `accent-deep` ring — white against the warm ground has no outer edge of its
own, and the ring is what it ends against. A root wears nothing: it already
carries *"N replies"* underneath, which says more than a bar could.

**What the bar says is deliberately the whole of it: *this message is part of a
thread*.** Not which thread, and not whose. Two side-conversations running at
once wear the same mark, and you tell them apart by opening one. Colour-keying
the bar per `thread_root_id` was drawn up and rejected — it works, and it would
have made the app's one-accent rule into a palette where hue carries meaning that
colour alone can't carry accessibly.

This replaced a **collapsed quote** inside every reply's bubble (M3 on the phone,
M9d on the web): the name of whoever was answered and two `line-clamp`ed lines of
what they said. The quote said more, and that was the problem.

- **It repeated itself.** Three replies to one message meant the same two lines
  three times, most often directly under the message they quoted.
- **It cost two lines on every reply**, which is what made a busy group's
  transcript read as mostly chrome.
- **It still couldn't separate two live strands**, because a quote names a
  *message*, never a conversation — the same limitation that made the
  quote-only design wrong [in the first place](#why-a-focused-thread-and-not-just-a-quote).
- **And it announced privacy clips in the middle of the chat.** A reply whose
  root you were clipped out of read *"Original message unavailable"* on every one
  of its bubbles. With the bar it simply looks like a reply, which is all a
  viewer was ever entitled to know.

🔒 **Dropping it also removed the only request that could ever have surfaced a
clipped body.** The transcript used to resolve every quote by id through the
[`?ids=`](#api) endpoint. It was correctly gated — that's what the endpoint's
clipping is for — but a bar is drawn from the bare `{ id }` a reply already
carries, so the transcript now fetches nothing at all to mark a reply.

**Inside a strand there is no mark and no quote — just bubbles.** A first cut
kept the collapsed quote in there, on the reasoning that a flat list can't
otherwise show which of its messages was answered. In use that was wrong twice
over: everything in a strand belongs to the one thread, so a mark saying so on
each bubble says nothing, and the message being quoted is almost always a few
rows up the same short list. What you're answering is named **above the
composer** instead, and only when it isn't the root. `insideStrand` on the bubble
picks between the two treatments and defaults to the transcript's, so anything
drawing a bubble on its own (the phone's action-menu preview) agrees with the
transcript by construction.

**So the client draws no quotes at all now, and `quotes.ts` / `quotes.js` are
gone** — along with the sign-out hook that cleared them. That store was the one
place a client held *other people's* message text outside the query cache, so
removing it is a small privacy win as well as a deletion: there is now nothing to
clear. 🔒 The **server** side of [`?ids=`](#api) stays, with its tests: it's a
legitimate endpoint, and the clipping it enforces is what makes the id-only wire
format safe in the first place.

**Tapping the bubble is a revision of "one gesture per target"**, the rule M2
settled, and worth recording as such. The bubble's own tap used to do nothing
outside select mode; now it opens the strand, but *only* on a bubble wearing a
bar. What makes that safe is that the tap is earned by a visible mark, does one
thing wherever it appears, and only opens a view — nothing is sent, changed or
deleted by a mis-timed press, and closing the strand puts you back. The narrower
version had the same property on a much smaller target, since tapping the quote
was already the way in. Select mode still wins the tap, and long-press still
opens the action menu.

Two client-specific notes, both about the web:

- **A click that ends a text selection doesn't open anything**, and neither does
  one that lands on the ⋯ menu, a link or a photo. On a page you read with a
  mouse, selecting text is the gesture the bubble would otherwise steal; the
  phone has no equivalent problem, because selecting text there is a long-press,
  which is the action menu.
- **The bar is also a `<button>`** spanning the bubble's edge, invisible until
  focused. A `div` with an `onClick` is a mouse-only affordance, and this is a
  route into a conversation — it can't be one. Its label says "Part of a thread —
  open thread" and names nobody, for the same reason the bar draws no name.

One consequence, stated plainly because it's the trade: the quote answered
*"replying to what?"* without leaving the transcript, and that is now a tap.

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
same reasoning put `Participant.muted_at` on the participant. (Contrast M8's
[mentions-override](#-a-mention-is-a-relation-and-the-only-thing-that-beats-mute),
which *is* a notification kind and so does belong there. The pair reads as a
rule, not an inconsistency.)

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

## Photo messages

Added in Phase 9b M7. Send a photo — from the camera or the library — with or
without a caption. It arrives as a bubble you can react to, reply to and delete
like any other message, and the whole chat's photos have a grid on the
[thread info screen](#the-info-screen-phase-9b-m6).

### 🔒 The photo is processed on the *client*, and that inverts how posts work

This is the one genuinely surprising decision in the feature, so it's worth being
precise about, because it looks like a mistake if you arrive from
[`feed-and-posts.md`](feed-and-posts.md).

Every other upload in TimeLine is processed **server-side** by
`backend/api/imaging.py`: the file is decoded to prove it really is an image,
rebuilt from raw pixels (which is what strips EXIF, including the GPS
coordinates a phone stamps on every shot), downscaled and re-encoded. A chat
photo does none of that on the server. It is resized, stripped and re-encoded
**on whichever client is sending it** — `mobile/src/chatPhotos.ts` on the phone,
`frontend/src/chatPhotos.js` in the browser — and the server stores the bytes it
is handed without opening them.

**Why:** end-to-end encryption is a committed goal for messaging
(`docs/phases/phase-9c-e2e-encryption.md`). Under E2E the server holds bytes it
cannot read, so it *cannot* strip or resize them. Building this on the
server-side path would mean writing code we'd have to tear out — and, worse, a
privacy guarantee that would quietly stop holding on the day it mattered. Doing
it on the client puts the pipeline in the only place that will always be able to
run it. `expo-image-manipulator` was already a dependency (the avatar cropper
uses it), so this cost nothing to adopt.

**The trade, stated plainly: the server can no longer verify that an attachment
is really an image.** Three things carry that load instead, and they are the
whole of the server-side defence — treat all three as load-bearing:

| Guard | What it does |
| --- | --- |
| **Byte caps** (`MESSAGE_ATTACHMENT_MAX_BYTES` 4 MB, `MESSAGE_THUMBNAIL_MAX_BYTES` 512 KB) | Per *file*, not per request — a total would let one enormous file through whenever the others were small. The thumbnail's much lower cap stops a client sidestepping the point of having one by sending the full image twice. |
| **A count cap** (`MESSAGE_ATTACHMENTS_MAX`, currently 1) | Without it, an unbounded count is the way around the byte cap. |
| **A forced `.jpg` filename** (`message_attachment_upload_to`) | The stored-XSS fix, and the least obvious of the three. Caddy serves `/media/*` off disk and picks the Content-Type from the *extension*, so a blob kept as `.html` or `.svg` would be served as **markup from our own origin**, next to the session cookie. Forcing `.jpg` means a browser is always told "JPEG" whatever the bytes are, and a browser will not execute a JPEG. `X-Content-Type-Options: nosniff` on that route (added in the same milestone) is the second layer. |
| **A 6 MB body cap at the proxy** (`deploy/Caddyfile`, `@chat_upload`) | What makes the byte cap true *at the door*. Django buffers a multipart upload to a temp file before DRF ever sees it, so the 4 MB check limits what we **store**, not what we accept — without this an authenticated client could stream gigabytes at the disk and be refused only afterwards. The one route on the box with its own body limit, because it's the one upload the server never decodes. Raise it in step with the two byte caps, never below them. |

Both halves are pinned by tests that will fail loudly if someone "improves" them:
`test_the_stored_file_keeps_a_jpg_name_whatever_was_uploaded` and
`test_the_bytes_are_stored_exactly_as_sent`. If you're reading this because one
of them failed: re-encoding server-side is what stops working under E2E, so the
test is probably right and the change probably isn't.

### The data model

**`MessageAttachment`** — `message` FK (CASCADE), `kind`, `file`, `thumbnail`,
`width`, `height`, `created_at`. Shaped like `PostImage`, with two differences:

- **It's a table with a `kind`, not an image field on `Message`.** Phase 13 adds
  video clips, and that should slot in as another `kind` on this row — same
  endpoint, same bubble, same lightbox — rather than growing a parallel model
  and a second upload path beside this one. `thumbnail` is already the right
  field for a video's poster frame. Only `image` exists today; adding `video`
  before anything can produce one would be a promise the code doesn't keep.
  (The plan for M7 called the model `MessageImage`; it was built as
  `MessageAttachment` to satisfy the same milestone's "leave a seam for video"
  step, which a name meaning *picture* would have fought.)
- **`width`/`height` are client-declared.** They're layout hints — the bubble
  reserves space from them so the transcript doesn't reflow as photos load — and
  nothing security-sensitive keys off them. They're bounds-checked so a nonsense
  value can't produce an unrenderable bubble, not trusted.

It's a `FileField`, not an `ImageField`, because `ImageField` validation opens
the file with Pillow on every save — exactly the server-side decode this design
exists to do without.

**One attachment per message**, and the app sends a multi-photo pick as several
messages. That's the better chat shape as well as the smaller one: each photo
gets its own bubble, and so its own reactions, replies, read state and delete.
The model is a table and the wire format is a list of parallel fields, so raising
the cap later is a server constant, not an API change.

### Deleting a photo message hard-deletes the photo

A message delete is [soft](#api) — the row stays, blanked, so the thread keeps its
shape. **Its attachments are deleted outright, files and all.**

The tombstone exists to leave an empty slot where something was, and blanked text
achieves that. A photo is different in kind: the stored file is a URL that **any
signed-in member who holds it can fetch** (media is gated at the door, not
per-author — see [`../deploy.md`](../deploy.md)), so leaving it would mean
"delete" removed the caption and left the picture on the internet. When someone
deletes a photo they sent, the photo is what they mean. `MessageSerializer` also
returns no attachments for a tombstone, so nothing can render one through a code
path that forgot.

### What the clients do with it

- **The bubble** draws the thumbnail at the size the sender's phone recorded, so
  the transcript doesn't reflow as images load — worse than it sounds when you're
  scrolled into history and every load shoves what you were reading. Tapping
  opens the full-size image in the existing `PhotoLightbox`. This is the second
  exception to the bubble's "tap does nothing" rule (a link is the first), and
  for the same reason: it's a smaller target with its own affordance, and a
  long-press over it still opens the action menu.

  **The photo has to re-offer the long-press itself, and this was shipped
  wrong.** M7 assumed a `Pressable` with only an `onPress` "doesn't claim long
  presses", so the hold would fall through to the bubble's handler. It doesn't:
  the photo becomes the touch responder for anything starting on it, so the
  bubble's `onLongPress` never fired, and the hold instead ran `onPress` on
  release — press-and-hold opened the lightbox and Reply/React/Report were
  unreachable from a photo message. The fix threads the bubble's own handler
  down to `MessagePhoto` (`onPhotoLongPress`), which both restores the menu and
  suppresses the tap, since RN skips `onPress` once a long press has been
  dispatched. It anchors to the *whole bubble*, not the photo's rect, so the
  menu doesn't move depending on where your finger landed.

  Note that **no Node test can catch this class of bug**: RNTL bubbles a
  `longPress` event up to the nearest ancestor handler, so the menu opens under
  test whether or not the photo carries its own. The regression test asserts the
  *wiring* (via the accessibility hint, which is rendered only when the handler
  is present); the gesture itself needs a simulator.
- **The composer** offers **camera and library**, not just the library. Sending a
  picture of what's in front of you is at least half of what a photo in a chat is
  for, and routing someone out to the camera app and back is the friction that
  makes an app feel like a website in a wrapper. The whole flow now lives in
  `mobile/src/photoSource.tsx` (`usePhotoPicker`) and is shared with every other
  picker in the app (post composer, profile and group avatars) — see
  [`mobile-app.md`](mobile-app.md#taking-a-photo-camera-or-library) for why it's
  the shared action menu rather than an `Alert`, and what a caller has to handle.

  🔒 **The camera permission is load-bearing config.**
  `mobile/app.json` must keep a real `cameraPermission` *string* in the
  `expo-image-picker` plugin block. Setting it to `false` (as it was before M7,
  when nothing used the camera) tells the config plugin to **delete**
  `NSCameraUsageDescription` from Info.plist and to add
  `android.permission.CAMERA` to `blockedPermissions` — and iOS terminates an
  app that reaches for the camera with no usage description, so "Take Photo"
  becomes a hard crash. No Jest test can see this (they mock the picker), so
  `thread.test.tsx` asserts the config file itself. It's a **native** change:
  editing it needs a fresh EAS build, not an OTA update — see
  [`../mobile-release.md`](../mobile-release.md).
- **A photo inside a focused reply strand draws but doesn't open**, because the
  strand is itself a `Modal` and stacking two on iOS is the trap `ReactionTray`
  documents. It renders no tap affordance rather than promising one that does
  nothing; the transcript behind the blur has the same photo.
- **The conversation list** previews a captionless photo as **"📷 Photo"** (and a
  captioned one as "📷 <caption>"), from an `attachment_count` on
  `last_message`. A count and not a rendered string: the phrasing is the
  client's, and a count is also the one fact about an attachment that survives
  the server not being able to see it.
- **The media gallery** on the info screen is the answer to "the picture someone
  sent last week". It renders **nothing at all** when a chat has no photos — a
  heading over an empty grid is a feature announcing it has nothing for you.
- **The web** does the same, since
  [M9e](#photos-the-list-and-the-info-panel-on-the-web-phase-9b-m9e) — a sized
  thumbnail into the shared `Lightbox`, the same list preview, and its own
  canvas-based version of this pipeline. (Between M7 and M9e it drew a thumbnail
  linking to the raw file, a deliberate stopgap: the app could send a captionless
  photo from the day M7 shipped, and without it the web drew an empty bubble,
  which reads as a bug in the other person's message.)

### Push, moderation, backups

- **The push body is "Ada sent a photo"** (plus " in <group>" for a titled group
  chat). It names the sender and the medium and quotes nothing, which is the
  same rule every other push body here follows — and it's more useful than "New
  message", because knowing a picture is waiting is often the whole reason to
  open the app. Said whenever there's an attachment, caption or not.
- **A reported photo is visible to the maintainer**, as thumbnails on the report
  in the Django admin. M0's rule is that [a report is the only
  window](#moderation-a-report-is-the-only-window) onto a private message, and
  M7 made a message able to be nothing but a photo — without this, reporting an
  abusive image produced an empty snapshot and photo abuse would have been the
  one thing moderation couldn't act on. Unlike `message_text` it's a **live**
  read, not a snapshot: we don't copy someone's photo into a second place to
  hold as evidence, so if the sender deletes the message the photo is genuinely
  gone and the report shows none. That trade is the right way round.

  🔒 **The thumbnail is inlined as a `data:` URI, never linked from `/media/`.**
  That route is `forward_auth`ed to `/api/media-auth/`, which authenticates with
  the **JWT cookie** — and the admin runs on Django's *session* cookie, which it
  doesn't accept. An `<img src="/media/…">` there 401s, so the queue would show
  broken images unless the maintainer happened to also be signed into the app in
  the same browser. Reading the file server-side means nothing is fetched and so
  nothing has to be authorised. It's the safer rendering too: a chat attachment
  is never decoded by us, and a `data:image/jpeg` in an `<img>` has no navigable
  URL and can't execute whatever the bytes turn out to be.
- **Backups need no change**, and this was checked rather than assumed:
  `deploy/backup.sh` and `deploy/restore.sh` both `rclone sync` the *whole*
  media directory, so `media/messages/` was covered the moment it existed. See
  [`../backup-restore.md`](../backup-restore.md) — an enumerated list of
  subdirectories there would be a data-loss bug that only surfaces the night you
  need the backup.

## Writing a message: formatting and @mentions

Both added in Phase 9b M8 and brought to the web in M9f. The parser is one module
ported between the two clients (`mobile/src/messageText.ts` ↔
`frontend/src/messageText.js`) and so is the composer's half
(`mentions.ts` ↔ `mentions.js`) — change one, change the other, or the two
clients start disagreeing about what a message says.

### Inline formatting is a render-time parse, never a stored transform

`*bold*`, `_italic_`, `~strikethrough~` and `` `monospace` `` are drawn as what
people meant by them. This is not a feature anyone asks for by name — it's the
absence of one that reads as broken, because people type these out of habit and
a message full of literal asterisks says *this app doesn't know that*.

**The markup characters stay in the database.** The parse happens when a bubble
is drawn (`messageText.ts` / `messageText.js`), so the raw string is the source of truth
throughout: an edit shows you exactly what you typed, and the body stays one
opaque blob the day it becomes ciphertext. Stripping markup on the way in would
also mean the *server* deciding what a message says, which is the thing E2E has
to make impossible.

Two decisions inside the parser are worth knowing before changing it:

- **Links and marks are found in one walk of the string**, not by linkifying and
  then formatting the pieces. Two passes fight: a URL full of underscores is not
  italic, and a `` `code span` `` holding a URL is not a link. Asking "link
  here? delimiter here?" at each index settles both in the order the characters
  actually appear.
- **A delimiter with a word character before it opens nothing.** That single rule
  is what keeps `read_file_sync`, `2*3*4` and an email address intact. The bias
  is deliberate and the inverse of what it looks like: leaving an asterisk on
  screen is a shrug, while italicising half of someone's variable name is the
  app corrupting what they wrote.

Places that show a message as *one line of plain text* — a conversation row's
preview, a push body — drop the markup rather than drawing it
(`plainMessageText`). A preview can't carry emphasis, and showing raw asterisks
there while the bubble renders them is the seam that reads as half-finished.

### 🔒 A mention is a relation, and the only thing that beats mute

Typing `@` in a group chat offers the thread's active members; picking one puts
their whole name in the text **and records their user id**. The picker is a strip
above the composer, and it is **not offered while editing** a message: an edit
carries no `mention_ids`, so a name picked there would notify nobody and wouldn't
even highlight (the highlight comes from the ids, not the words). Adding a
mention means sending a message.

**Why an id and not the name in the text.** Names change, two people in a family
can share one, and — the load-bearing reason — under E2E there is no text for
the server to read. Whoever a mention notifies has to be decidable from
*metadata*, so it's a `MessageMention` row per (message, user) from day one
rather than "extracted properly later".

| Field | |
| --- | --- |
| `message` | CASCADE — the mention is a fact about a message and outlives neither it nor the user. |
| `user` | CASCADE, unique together with `message`: naming someone twice in one message is one mention of them. |

**What a mention does is exactly one thing: it notifies through a muted thread.**
That's the whole point of naming someone, and it's the one justified exception to
`Participant.muted_at`. It's also unavoidably a way to punch through a quiet
someone deliberately asked for, so the override is **opt-out per user** — the
`mention` notification preference, phrased in Settings as exactly what it does:
*"Let @mentions notify me in muted chats."* Default on.

Be precise about that setting, because getting it wrong silences mentions
someone wanted:

- muted thread + setting on → **notified** (this is the whole feature);
- muted thread + setting off → **silent**;
- unmuted thread → **notified either way**, through the ordinary message push.
  Someone who turned the override off has not asked to stop hearing their name.

**Mute is the only rule it overrides.** Every other gate still applies: you must
be an active participant, not left, with an interval spanning the message.
A mention cannot make a message readable that isn't, so it cannot announce one.
That's enforced by carving the mentioned recipients out of the *same* audience
queryset the ordinary recipients come from (`enqueue_message_pushes`), rather
than assembling a second one that could disagree about visibility.

**🔒 The ids a client may send are checked against the conversation's active
participants.** An unchecked id would make the send endpoint a way to buzz a
stranger's phone about a thread they aren't in — the exact thing the clique
invariant exists to prevent. A `pending` member is refused too: they can't read a
line of the thread, so naming them would announce something the app would then
refuse to show them.

**🔒 Group chats only, and the *server* is what enforces it.** `mention_ids` on a
direct conversation is a 400, not a silently ignored field. The reason is the
override itself: in a 1:1 the one person you might mute is the only person who
can send you anything, so accepting an id there would let them defeat that mute
on every message — muting a *person* would stop meaning anything, and the
`mention` preference is no escape since turning it off to get away from one
person costs you mentions in every group. Neither client offers a picker in a
1:1, and that's exactly why the endpoint mustn't accept one: an endpoint wider
than any client sends is only ever an attack surface. (`_mentionable_user_ids`
returns nothing for a direct thread, legacy Participant-less ones included.)

**On the wire a mention is a bare user id**, exactly like [`reply_to`](#reply-threads)
— no name, no avatar. The client resolves it against the participants payload it
already holds; an id it can't resolve simply renders as the words the sender
typed, which is the honest outcome and needs no special case. Serialised as `[]`
on a tombstone. It isn't pruned per viewer, and that was considered rather than
skipped: anyone who can read the message can already read the `@Ada` *in* it, so
the id says nothing the body doesn't.

The push body says **"Ada mentioned you"** (plus " in <group>"). A silenced chat
that suddenly buzzes owes you an explanation, and that's it — still naming the
person and quoting nothing, like every other push here.

**Where the setting lives is a rule, not a coincidence.** The mention override is
a genuine notification kind, so it sits in `NotificationPreference` with the
others and inherits absence-means-enabled, the `{kind: bool}` API and both
clients' Settings screens. Contrast
[`User.send_read_receipts`](#the-setting-usersend_read_receipts), which lives on
the user model precisely *because* there's no notification kind behind it. Read
the two together. (No `Notification` row is ever created for a mention:
messaging keeps its own unread badge and stays outside the activity centre.)

## Renaming a group chat

Added in Phase 9b M6. `PATCH /api/conversations/<id>/` with `{ title }`. Until
then a title could only be set at creation, so "Weekend plans" outlived the
weekend — and an ad-hoc group started from a profile could never be named at all.

Four rules, each a decision rather than a default:

| Rule | Why |
| --- | --- |
| **Group chats only** (400) | A 1:1's name *is* the other person, resolved per-viewer — there is no shared title to change, and letting one side rename the other would be a small act of vandalism. |
| **Any active member** (403 otherwise) | Chats have no admin role at all (see the [membership state machine](#membership-state-machine)), and inventing one for a text field would be the wrong place to start. A `pending` member is excluded for the same reason they can't send: they haven't been let in. |
| **Blank clears it** | Both clients then fall back to a comma-joined list of the other members, which is a better name for an ad-hoc chat than a stale one. Whitespace is stripped, so a "name" of spaces can't render as an untitled chat with the fallback suppressed. |
| **It doesn't bump `updated_at`** | A rename isn't activity, so it mustn't jump the thread to the top of everyone's list — the same rule an [edit](#editing-a-message) and a reaction follow. `update_fields=["title"]` is what makes that true. Asserted in `ConversationRenameTests`, because the pairing (name changes everywhere / order doesn't) is easy to break by accident. |

**Nobody is told.** There is no "Sam renamed this chat" system message, because
there is no system-message concept in the model and inventing one for this is a
bigger change than the feature. Recorded as a real gap rather than an oversight:
the name simply changes for everyone the next time they look.

## Marking a thread unread

Added in Phase 9b M6. `DELETE /api/conversations/<id>/read/` — for the people
who use the badge as a to-do list ("I'll reply properly later").

**It moves your read marker to just behind the newest message you didn't send —
it does not delete the read row.** Deleting is the obvious reading of "un-read
this" and it's wrong: with no marker, [every message in the thread's history
counts as unread](#history-is-interval-clipped), so a chat you had read to the
end and flagged for later would come back wearing "99+". The count is supposed to
mean "this many are waiting for you", so the smallest edit that makes the thread
unread is the honest one, and it lands at **one**.

Three details behind that, each of which would otherwise be a silent no-op:

- **Interval-clipped**, through `_messages_for_viewer` like everything else here.
  A member with a gap in their membership must not have their marker parked
  against a message they were never shown — that would hand them a permanent
  unread count for something the thread then refuses to display.
- **Not your own message, and not a tombstone.** Neither counts toward unread, so
  aiming at one would produce a thread that reads as *read* the moment anything
  refreshes it.
- **A microsecond behind**, since the unread rule is strictly
  `created_at > last_read_at` and Postgres stores microsecond precision.

**400 when there's nothing to mark unread** — an empty thread, or one where every
visible message is yours. It aims at the newest qualifying message *anywhere* in
the thread, not at the last one, so a chat you replied to marks unread fine —
the marker lands past your own trailing messages.

The mobile list's swipe gate is **narrower than that**, and knowingly: a list row
carries only `last_message`, so "I replied last" and "I've been talking to myself
since I opened this chat" look identical from there, and only the second is a
400. It offers the action when the newest message is incoming and undeleted, and
leaves the rest to the thread screen. Widen it if a row ever grows a
"has incoming history" flag.

### 🔒 It retracts your read receipt, and that's the intended reading

`last_read_at` is one column, and [the ticks](#send-state--read-receipts) are
served from it. So marking a thread unread flips the sender's ✓✓ back to ✓ on the
message you just un-read — they stop being told you've read it, because you've
just said you haven't dealt with it.

This is deliberate rather than a side effect. The alternative is a second,
never-decreasing column for receipts, which buys a tick that survives the badge
at the cost of letting the two disagree about whether you read something — the
exact drift the single `unread_count_for` implementation exists to prevent. And
where the two readings conflict, a privacy-first app should err toward **fewer**
claims about what someone has read, not more: the retraction is the option that
tells the other person less. Pinned by
`MarkConversationUnreadTests.test_marking_unread_retracts_the_read_receipt`, so
it can't quietly change.

The blast radius is one message: the marker only moves behind the newest incoming
one, so everything older stays read and stays ticked.

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

**A block that fails has to say so — this is the one place where a silent write
failure is a safety problem** (issue #236). The clients originally closed the
confirmation modal *before* firing the mutation and had no error path at all, so a
POST that never landed (offline, or a 500) was pixel-identical to one that worked:
the button still read "Block", and you walked away believing someone could no
longer message you or see your posts. Both `BlockButton`s now `await
mutateAsync`, so:

- **The warning modal stays up until the write lands.** It closes on success
  only; on a rejection it holds, which is what gives the failure somewhere to go
  and makes its confirm button the retry (relabelled "Try again" on the web).
  While the write is in flight the dialog takes no further taps — no backdrop,
  Esc, or Android back — because dismissing it would hide the outcome.
- **The message states what is still true**, rather than repeating the server's:
  *"Couldn't block Priya — they're not blocked. Try again."* `BlockView`'s only
  authored rejection is "You can't block yourself", which this UI can't reach, so
  every failure a real person hits here is a 404, a 500 or a dropped connection —
  none of which mention the fact that matters. That's the deliberate exception to
  the house rule (see [connections.md](connections.md#reporting-a-refused-write))
  that the server's own words win where it has any.

Web renders the message inside the dialog (and beneath the button once the dialog
is dismissed); mobile alerts over it. Same behaviour, each client's idiom.

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
- `PATCH /api/conversations/<id>/` — **rename a group chat** (Phase 9b M6), body
  `{ title }`. See [Renaming a group chat](#renaming-a-group-chat).
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
  - `?ids=<a,b,c>` narrows it to **specific messages** (Phase 9b M5) — added so a
    reply's collapsed quote could get its words and its author once the app's
    transcript began paging lazily. No client calls it since
    [M9g](#the-strand-edge) dropped quotes; it stays because the rule it encodes
    is the server's, not a client's. Same trick, same reason: an id the viewer is clipped
    out of is simply **absent** from the response, indistinguishable from one
    that never existed, with no second code path to get wrong. Capped at
    `MESSAGE_IDS_MAX` (50); an empty list returns nothing rather than everything.
    It **paginates like the rest of the endpoint**, and the cap is deliberately
    above the page size — so a batch bigger than a page comes back short, and
    "absent" then means *clipped **or** on a later page*. A client must follow
    `next` before reading anything into a missing id, or it will tell someone a
    message is unavailable when it was only unasked-for. See
    [Reply threads](#reply-threads).
  - `?media=1` narrows it to **messages carrying a photo** (Phase 9b M7) — the
    thread info screen's media gallery. A third filter on the same queryset for
    the third time and the same reason: the gallery must not be able to show a
    photo the transcript wouldn't. Excludes tombstones, whose attachments are
    genuinely gone. Composes with `?order=desc`, which is how a gallery reads.
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
  - Optional `mention_ids` names people (Phase 9b M8), **group chats only**,
    capped at `MESSAGE_MENTIONS_MAX` (20) and **validated against the
    conversation's active participants** — an id from outside the room, or any id
    at all on a direct thread, is a 400 rather than a silent drop, because a
    mention is the one thing that beats a muted thread. Duplicates collapse.
    Sent as repeated parts on the multipart (photo) path, one per id. The
    messages payload carries them back as `mentions: [<user id>]`,
    bare ids like `reply_to`. See
    [@mentions](#-a-mention-is-a-relation-and-the-only-thing-that-beats-mute).
  - **Multipart when it carries a photo** (Phase 9b M7): parallel lists
    `attachments`, `attachment_thumbnails`, `attachment_widths`,
    `attachment_heights`, validated to the same length. `text` may then be
    **blank** — a message must be text, a photo, or both, never neither, which
    is the rule posts have enforced since Phase 4. See
    [Photo messages](#photo-messages).
- `POST /api/conversations/<id>/read/` — mark read up to now (clears unread);
  `DELETE` marks it **unread** again (Phase 9b M6). See
  [Marking a thread unread](#marking-a-thread-unread).
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
  **Attachments are not editable** — parts sent here are ignored. A photo
  message's caption may be edited, including down to nothing (there's still a
  message); swapping the *picture* under something someone has already looked at
  is not a change the "Edited" marker can honestly disclose.
- `POST /api/conversations/<id>/participants/` — add people; **group chats only**,
  any active member, each an addable connection. A 1:1 is a closed thing between
  two people and 400s here. That guard was missing at first, and the server was
  therefore more permissive than either client: both have always hidden "Add
  people" on a 1:1, but a hand-made POST at a direct conversation's id let one
  participant drop a third person into the other's private thread — with no
  consent from them and no signal, since a direct thread shows no sender
  attribution and names nobody in its header, so the arrival was visible only to
  someone who opened the info panel. `_mentionable_user_ids` refuses the analogous
  thing for mentions; this now matches it.
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

**Reading the thread takes the notification back** (#178). The two drops above
are both *pre*-delivery; once a push is on the phone, opening the thread (or
replying from the lock screen, or foregrounding the app after reading it on the
web) dismisses it from the notification centre, and a message arriving for the
thread you're looking at banners without being filed there at all. That's app-side
bookkeeping with no messaging endpoint behind it — see
[notifications.md](notifications.md#taking-a-notification-back-once-its-been-dealt-with-178).

**The body never quotes the message.** It reads `New message from Ada`, or
`Ada in Book Club` for a titled group. Push bodies transit Expo's servers and
Apple's, so naming the sender is the most we ever say — that rule is what makes
pushing private messages acceptable at all. Its known cost is the **Reply**
action below: a text field for a message you can't read. The fix is on-device
fetch (later decryption) in a notification service extension, not a chattier
body — see [notifications.md](notifications.md#what-leaves-the-box-and-who-sees-it)
and [Phase 10b](../phases/phase-10b-notification-content.md).

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
info → new-message:

- **New chat** — a multi-select connection picker → 1:1 or group chat. Launched
  from a Group page it's scoped to that group (pool = group members ∩ your
  connections). **The optional name field only appears once two people are
  ticked, and a name left behind by an untick is ignored rather than sent**
  (#156, both clients — the title is read on the group branch of the create
  mutation, not cleared on untick, so a mis-tap doesn't bin your typing and the
  name is visible again the moment it can be used): the title is what *makes* a
  chat a group — `_create_group` writes `kind=GROUP` —
  so naming a single selection used to hand you a two-person group in place of
  the pair's direct thread. That's not a cosmetic difference. It sits outside
  `unique_conversation_pair`, so you can make any number of them while the
  profile Message button still opens the direct thread (history split across
  two threads, unmergeable); it renders as a group throughout (sender
  attribution, Add people / Leave / rename); and `_shared_active_chats` severs
  it on a disconnect, which can 403 the initiator out of a two-person history
  the direct-thread rule promises stays readable. Pre-existing two-person titled
  groups are left alone — they're valid group chats; this only closes the way
  new ones were being made by accident.
- **Thread** — the header is identity + a `⋯` (Details · Mute · Add people ·
  Leave) since [M9e](#photos-the-list-and-the-info-panel-on-the-web-phase-9b-m9e),
  which also added the [info panel](#photos-the-list-and-the-info-panel-on-the-web-phase-9b-m9e)
  behind Details. A `pending` viewer sees a **locked panel**: "Connect with C & D
  to join", inline connection-request buttons, and a **Decline / Leave** button.
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

Since **Phase 9b M9a** the drawer file is a ~55-line shell — the portal, Esc, and
the three-way view switch — over `frontend/src/components/messages/`. The thread
view is **keyed on the conversation id**, so switching chats remounts it: the
transcript now holds state that is only true of one conversation (the latched
divider, the draft, the message being edited), and carrying any of it into a
different chat would be worse than a flicker.

**Phase 9b M9 closed the gap between the two clients**, in six chunks written up
below ([M9b](#the-web-transcript-phase-9b-m9b), [M9c](#reactions-send-state-and-ticks-on-the-web-phase-9b-m9c),
[M9d](#reply-threads-on-the-web-phase-9b-m9d), [M9e](#photos-the-list-and-the-info-panel-on-the-web-phase-9b-m9e),
[M9f](#mentions-formatting-and-multi-select-on-the-web-phase-9b-m9f) — M9a was the
code move above). **Every 9b feature is now on both**, and the sections below
record the handful of places the web deliberately differs, each because the
medium does rather than because it's behind: a **hover `⋯`** instead of a
long-press, a **strand that covers the transcript** instead of blurring it, **no
camera** on the composer, a **`⋯` on a list row** instead of a swipe, an **info
panel** instead of a pushed screen, and a **checkbox** in select mode.

The rule that made shipping them one at a time safe is worth keeping in mind if
this is ever done again: **every 9b response field is additive**, and the backend
ships before either client — so an old client ignores what it doesn't know rather
than breaking on it. What that bought is real: five of these six chunks shipped
while the drawer was still missing features the app had, and none of them ever
made the web *wrong*, only incomplete.

⚠️ **Two cascade traps live in this drawer**, and both have the same shape: the
`⋯` trigger's visibility under `@media (hover: none)`, and the bubble reserving
its corner. Tailwind's utilities layer comes last, so a rule that has to beat a
utility can't be written as one — both live in `index.css`, and half of either
pair silently does nothing on its own. Details in
[M9b](#the-web-transcript-phase-9b-m9b) below.

🔒 **Two module-level stores hold message text outside React** — `drafts.js` and
`outbox.js` — which is what lets a draft and a failed send survive the drawer
switching views. They are **cleared on sign-out**
in `auth.jsx` for exactly that reason: on a shared computer the next person to
open the drawer isn't the one who typed it.

### The web transcript (Phase 9b M9b)

M9b brought the app's [transcript](#the-transcript-phase-9b-m5) and its
[action menu](#the-long-press-action-menu-phase-9b-m1) across. The two clients
now share the modules that decide what a transcript *is* — `threadRows.js`,
`messageText.js` and `drafts.js` are ports of the app's, comments included, and
the point of the port is that they stop diverging. Change one, change the other.

**It loads one page.** The drawer used to walk `fetchNextPage` in an effect until
every page was in memory — the same defect, for the same reason, that M5 fixed on
the phone: the endpoint's default order is oldest-first, so reaching the bottom
of a chat meant loading all of it. It reads [`?order=desc`](#api) now and pages
backwards as you scroll up.

**The scroller is `flex-col-reverse`, which is the web's answer to the app's
inverted `FlatList`.** Rows are newest-first, index 0 paints at the bottom, and
the scroll origin is the newest message — so the thread opens at the bottom with
no scrolling code (it deleted a `scrollIntoView`-on-every-change effect), and a
page of older messages prepending doesn't move what you're reading, because the
browser measures from the bottom. `scrollTop` is 0 at the newest message and runs
negative going back; the two thresholds take `Math.abs` of it, since that sign
convention is the spec's but was not always every engine's.

**Scrolling up can't be the *only* way to reach history**, so the shared
`LoadMoreButton` sits at the top of the transcript as well. `onScroll` never
fires on a transcript that doesn't overflow — one page of short messages in a
tall window — and the rest of the chat would then be unreachable with no sign
anything was missing. The app has no equivalent gap because `onEndReached` fires
on *layout*, not on scroll.

**The transcript is `role="log"` with `aria-live="off"`.** The role is right and
the implied live region isn't: a live region announces *additions*, and this
container grows at both ends, so paging in twenty older messages would read all
twenty aloud. Announcing genuinely new messages wants a separate visually-hidden
region fed one at a time — a job of its own, not a side effect of the role.

Everything else is [M5's write-up](#the-transcript-phase-9b-m5) and holds
identically here: day separators re-derived at local midnight (`useDayBoundary`
in `hooks.js`, ported), **clock times** rather than "5m ago" (the conversation
*list* keeps relative time, where the question really is how recent something
is), run grouping with the timestamp on the run's last bubble — exempting the
**"Edited"** marker, which is a disclosure and can't be hidden by where a bubble
sits — a **latched** unread divider the thread opens at, jump-to-latest with a
count of what arrived since, clickable links, emoji-only messages drawn large,
and per-conversation drafts (🔒 cleared on sign-out in `auth.jsx`, like the app
clears them). Inline formatting comes across with the parser rather than after
it: `messageText.js` finds links and `*bold*` runs in **one walk** (a URL full of
underscores is not italic), so splitting the port in half would have meant
rendering a message with its markup silently deleted and nothing styled.

**The menu is a `⋯` on hover, not a long-press** — the one thing that differs
because the medium does, and the way the drawer's inline Delete already worked.
It's revealed by hovering the bubble and by `:focus-visible`, so a keyboard
reaches every action a mouse can, and it portals to `<body>` like `PostMenu`
because the transcript is an `overflow-y-auto` scroller that would otherwise clip
it.

**It sits in the bubble's top-right corner, inside it.** It began as a flex
sibling *beside* the bubble, which cost real width: every bubble that could be
acted on sat pushed in off the panel edge, and once M9c hung reaction pills off
the bubble's own edge the two no longer lined up. The corner is also where a
message's own actions belong. `msg-menu-host` on the bubble is the positioning
context and ⚠️ **reserves that corner (`padding-right`) on every device, not
only where nothing can hover.** The first cut reserved it under
`@media (hover: none)` alone, reasoning that a trigger which only appears on
hover could sit over the words while you hover. Rendering it settled that: the
trigger is *opaque*, so it doesn't crowd the text, it hides it — the first line
of every wrapped message lost its last couple of characters and read as
truncated. A bubble 18px wider than its text is the cheaper cost. Reserving
always has a second benefit: the bubble doesn't reflow when you mouse over it.

That padding lives in `index.css` rather than as a `px-3.5` utility for the same
cascade reason the visibility rules do, pointing the other way: `.msg-menu-host`
has to *override* `.msg-bubble-body`, which works on same-layer source order and
could never work against a utility, since Tailwind's utilities layer comes last.
Both halves in CSS, or neither does anything.

⚠️ **It positions in *viewport* coordinates (`position: fixed`), unlike
`PostMenu`, and closes on any scroll.** `PostMenu` is anchored to a post in the
normal page flow, so a document-positioned portal scrolls along with it. This
anchor sits inside a **`fixed`** drawer over a page that stays scrollable — and
inside an inner scroller of its own — so a document-positioned menu drifts away
from its bubble in *both* directions. Closing on scroll (a capture-phase
listener, since `scroll` doesn't bubble) is the rest of the answer: a menu still
open over a message that has moved is exactly the mistake the anchored design
exists to prevent. Inside
it matches the app: **Copy · Edit · Delete** on your own, **Copy · Report** on
someone else's, no menu on a tombstone. The items are **data**, and the list is
built when the menu opens rather than during render — Edit expires after fifteen
minutes, and a list built at render time would depend on when React last redrew.

🔒 **A hover affordance has to answer for the people who can't hover.** The
drawer is used in phone browsers as well as on a desktop, and a touch device
never fires `:hover` — so a trigger hidden behind it would leave every message
action (including **Report**, which is the only route a message has to the
maintainer, and which App Review requires be reachable) as an invisible
zero-opacity button. One rule in `index.css` keeps `.msg-menu-trigger` visible
under `@media (hover: none)`. The visibility rules live in CSS rather than as
`opacity-0 group-hover:opacity-100` utilities for a cascade reason worth knowing:
Tailwind's utilities layer comes *after* `@layer components`, so a media query
written there loses to `opacity-0` and the touch case silently doesn't work. And
the question asked is `hover: none`, not a width breakpoint — a touchscreen
laptop still hovers, and a narrow desktop window doesn't stop having a mouse.

**Editing happens in the composer**, which grows an "Editing message" bar showing
the original with an ✕; the input is prefilled and focused and Send becomes Save.
Cancelling (or Escape, which the composer swallows so it doesn't also close the
drawer) restores whatever you were half-typing. Saving unchanged text is a no-op
rather than a `PATCH` that would stamp the message "Edited" for nothing.

**Report widened `ReportModal` to take a `messageId`.** It took a post or a
comment id only and derived its wording as "post, or else comment" — so wiring a
message straight into it would have opened a dialog headed *"Report this
comment"* that POSTed a report with no target at all. It now carries the
three-way target and 🔒 **the message-specific copy the app has**: since
[M0](#moderation-a-report-is-the-only-window) a report is the only route by which
a message ever reaches the maintainer, so telling the reporter that a copy goes
with it is what makes that design honest rather than a quiet exception to it.
A test asserts the wording, because the failure mode is a dialog that looks right
and reports nothing.

The read-receipts *setting* shipped on the web (a Privacy section on
`/settings`) **a milestone before the ticks it governs** — deliberately, because
the disclosure happens whether or not this browser draws them, so a member who
only ever uses the web had to be able to opt out either way. A setting that
exists only where the feature is visible would be a setting half the members
can't reach.

### Reactions, send state and ticks on the web (Phase 9b M9c)

M9c brought [reactions](#reacting-to-a-message) and
[send state](#send-state--read-receipts) across. `readReceipts.js` and
`outbox.js` are ports of the app's modules, comments and unit tests included —
same rule about not letting them diverge.

**Reactions live in the ⋯ menu, on the pill, and nowhere else.** The menu grows a
quick row of **the chat's six** (👍 ❤️ 😂 😮 😢 🙏 — not the feed's four; a set
that can only be cheerful makes you type a whole message to say "oh no") with a
`＋` that **expands the panel in place** into the existing code-split
`emoji-picker-element`. One popover, one anchor, and no moment where two are on
screen fighting over the same outside-click. Reacting is dropped entirely — row
and all — in a thread you can no longer send to, because a reaction is content
everyone sees and the server 403s it exactly as it does a message.

Pills sit on the bubble's lower edge on its near side — **which is what moved the
`⋯` inside the bubble.** Beside it, the trigger took real width and held the
bubble in off the panel edge, so the pills hanging off the bubble's own edge no
longer lined up under it; see the transcript section above for where it went and
what that cost in CSS.

⚠️ **The pill row is `relative z-10`, and that has to stay paired with the
negative margin that creates the overlap.** Making the bubble the `⋯` menu's
anchor made it a *positioned* element, and a positioned element paints over
in-flow content whatever the DOM order — so the bubble covers the top of every
pill and they read as clipped. The two changes are a milestone apart and the
symptom shows up nowhere near either.

🔒 **A pill has one gesture: it opens "who reacted", it never toggles.** That's a
deliberate departure from the feed's chips, and the reasoning is
[M2's](reactions.md#message-reactions-phase-9b-m2): a pill is a *display* of what
the thread said, so a click belongs on the detail of it. Removing happens in the
two unambiguous places — the menu's emoji row (an emoji you've used reads as
active and clicking it takes it off) and **"tap to remove"** on your own row in
the list, which `ReactorsPopover` grew along with `messageId` and a `meId` prop.
`meId` is a prop rather than a `useAuth()` call so the popover stays a pure
renderer and the feed's callers don't inherit an auth dependency for a feature
only the drawer uses.

There is **no optimistic reaction toggle** (M2's fifth decision holds here): the
pill is what the server answered with, written into the cached page by
`patchReactions`. A toggle also **drops the reactor-list cache** with
`removeQueries` — not `invalidateQueries`, because the popover is closed by then
and an inactive query would only be marked stale, leaving a window in which a
stale "tap to remove" row is still clickable and would put the reaction back.
`reactorsQueryKey` is exported so the key can't be spelled two ways.

**Sending is instant, and a failed send keeps its place.** The composer clears on
dispatch and never blocks; the bubble appears immediately with a clock, and on
failure it sits there dimmed with **Not sent · Retry · Discard**. The failure is
reported on the bubble rather than under the composer — nearer the thing that
went wrong, and the only place that can say *which* of two messages in flight
fell over. An unsent message has no ⋯ menu: every action it offers needs a server
id it hasn't got.

⚠️ **The bubble that replaces an optimistic one doesn't re-animate**, and the
transcript tracks which ids came from your own outbox (`justSent`) purely to
arrange that. A row is keyed `m-${id}`, so settling an entry swaps a negative
temp id for the server's and React remounts the bubble — which re-runs
`.msg-bubble`'s `tl-rise` and fades the message up from nothing a fraction of a
second after it appeared. That flash is exactly the "message that appears to
*change* when it lands" the optimistic bubble exists to prevent, so the
optimistic one animates and its replacement doesn't. A test asserts the class,
since nothing in jsdom would show the flash itself.

🔒 **The outbox is a module-level store, not a cache write** — the same decision,
for the same reason, as [the app's](#optimistic-send-the-outbox). A poll
*replaces* an infinite query's pages, so an optimistic write survives about four
seconds, which is fatal for the one message that has to sit and wait for a
decision. It also has to outlive the *view*: the drawer switches between the list
and a thread without a route change, so component state would throw a failed send
away on the most ordinary click there is. It is **cleared on sign-out** in
`auth.jsx`, beside the drafts store and for the same reason. On success the
accepted message is written into the cache *before* the outbox entry is dropped,
so the bubble is never absent for the frame between the two.

**Ticks are three states, not four**, and appear on your own messages only.
`readStateFor` decides them from each participant's `last_read_at` and
`active_since`; when *you* have receipts off the server withholds every marker
including your own, `receiptsVisible` is false, and the whole column disappears
rather than freezing on one tick. Nothing is hidden client-side — the field
simply isn't on the payload, and hiding data already in the browser would be
theatre.

⚠️ **The conversation detail is polled now** (`CONVERSATION_DETAIL_POLL_MS`,
12s), where the drawer fetched it once. It carries the read markers, and a marker
taken when the thread opened is by construction older than every message you send
afterwards — so a mount-time snapshot could only ever say "sent" about the
message you're actually watching. Slower than the message poll on purpose: the
detail costs several per-conversation queries where a message poll is one cheap
page.

### Reply threads on the web (Phase 9b M9d)

M9d brought [reply threads](#reply-threads) across. The behaviour is the app's —
one flat strand per root and
[every route landing in the strand](#every-route-to-a-reply-goes-through-the-strand).
It also ported the app's `quotes.js`, comments included; both copies were deleted
in [M9g](#the-strand-edge) along with the quote itself.

**The strand takes the panel, at every width.** M9d was planned the other way
(widen the drawer to 740px on a big window so the strand could sit *beside* the
transcript) and that was built, looked at, and rejected: a drawer that grows to
half the window stops being a companion to the timeline and becomes a takeover,
which is the one trade this panel is shaped not to make. So the strand covers the
transcript, which is closer to what the app does than the widened version was,
and leaves the drawer one width with no breakpoint to reason about. **Don't
reinstate the widening** — it reads fine in a screenshot and wrong in use.

**The transcript is hidden, not unmounted.** It holds a half-typed draft, an edit
in progress, a latched unread divider and a poll, and
[M3 settled](#every-route-to-a-reply-goes-through-the-strand) that a trip into a
thread must cost none of them. `display: none` keeps all of it at the price of
one thing — scroll position, which a box with no layout can't hold — so closing a
strand lands you at the newest message rather than where you were reading. That's
the right way round: the newest message is where a conversation resumes, and
jump-to-latest is there for the other case.

⚠️ **Nothing may report a failure from inside that column while a strand can be
open.** `display: none` costs the transcript its scroll position, and it costs
anything rendered in there its *audience* — including the composer, which is
where several of this file's error lines live. A reaction refused inside a strand
painted its message into that hidden subtree and so said nothing at all, for as
long as strands existed (issue #251); with no optimistic pill to take away, the
tap was indistinguishable from one that worked. The rule the fix settles on: an
action offered in **both** the transcript and the strand reports on the **bubble**
it was taken on, which is the only place both can see — the same rule a failed
send already followed. Consequences to know before adding another: the handler
the bubble is given must return a **rejecting promise** (`mutateAsync`, not
`mutate`), and a mutation-level `isError` can't serve, since one mutation covers
every bubble on both screens and a flag on it can't say which one failed. See
[reactions.md](reactions.md#in-the-messages-drawer-phase-9b-m9c).

**Three others had no bubble to move to, so they moved out of the column
instead** (issue #253). `editMutation`, `deleteManyMutation` and `photoError`
rendered in the composer, and M9d's first reading of the rule above was that they
were safe because neither Edit nor Select can be *triggered* from a strand
(`getStrandActions` passes `allowEdit: false` and omits `onSelect`). That gates
the trigger; the `hidden` is on the renderer. A strand opened while one of them
was still in flight hid the answer just the same — and for the bulk delete there
was no race to win at all, since `confirmDeleteSelected` ends select mode on the
line *after* `mutate()` while its DELETEs go out one at a time, leaving the
transcript fully interactive for the length of the selection. A failed edit,
likewise, is reachable from an open strand because edit mode doesn't stand the
reply counts down. All three now render in a small bar **outside the column
entirely** — a sibling of the row that holds both it and the strand panel — so it
survives whichever of the two is on screen; and it's kept out of the column
rather than merely conditioned on `!strand`, because the message is worth *more*
over an open strand. A `role="alert"` in a `display: none` subtree isn't
announced either, so this was silent to a screen reader as well as invisible.

⚠️ **This closes the hiding half, not the unmounting half.** Leaving the thread
for the conversation list unmounts the whole view — `MessagesDrawer` renders it
only while `view === "thread"` (the `key={conversationId}` beside it is what
forces a remount when you switch *between* chats, a different thing) — and that
takes the bar with it, mid-write and all. The drawer's Back, ✕ and Escape sit a
level above this component and can't see a write in flight, so they can still
tear it down: that's **#258**, still open, and its fix is a `useMessaging`
in-flight flag the chrome reads. `editMutation` has a second hole of its own in
**#257** (`stopEditing` calls `reset()` unconditionally, discarding a rejection
that hasn't arrived). Both are the same family one dismissal-route spelling over.

**So the invariant is about the rendering, not about who can reach what:**
nothing in that column may be the only renderer of a write that can outlive the
transcript being visible. Both halves are pinned in `messaging.test.jsx` — that
the column really is hidden, and that the message isn't inside it. (`toBeVisible`
can't stand in for the second: jsdom loads no stylesheet, so Tailwind's `hidden`
is only a class name there.) This is the same class as
[#254/#255](connections.md#reporting-a-refused-write), one dismissal-route
spelling over.

**The two halves in the transcript.** A reply wears the
[strand edge](#the-strand-edge) and opens its strand when clicked; a root renders
**"3 replies"** on a branch line under it — the same living line the feed's
comment threads use, so a strand reads as growing out of the message rather than
as a button stuck under it.

M9d shipped a **collapsed quote** inside every reply's bubble instead, resolved
through `quotes.js` rather than read off the reply. M9g replaced it with the bar
and dropped the quote from the strand panel too, so the web transcript — like the
phone's — now asks for nothing at all in order to mark a reply, and `quotes.js`
has been deleted.

Two things the web does that the phone doesn't need to: a click that ends a
**text selection** doesn't open the strand (nor does one on the ⋯ menu, a link or
a photo), and the bar doubles as a focusable **`<button>`** spanning the bubble's
edge — a `div` with an `onClick` would make a route into a conversation
mouse-only.

**The strand carries the ⋯ menu, unlike the app's**, which leaves it out only
because its strand is a `Modal` and so is the menu — an iOS constraint the web
hasn't got. Without one the strand would be action-less, since it's the only
thing on screen while it's open. It's deliberately one item shorter: **no Edit**.
Editing needs a composer mode and the strand's composer already has a job; the
transcript keeps Edit, and closing the strand is one click. **Reply inside the strand re-aims the composer** rather than opening
anything, since a reply to a reply flattens into the strand you're already in;
the label above the composer names the target, and clears back to the root.

**The strand pulls every page, where the transcript pages lazily**, and that's
the difference between the two views rather than an inconsistency — a transcript
is unbounded, a strand is one exchange inside it. Reading only page one would cut
a busy strand off at its *oldest* twenty and hide the reply you just sent, while
the root's count climbed past what the strand showed. It walks those pages
through the shared `useFetchAllPages` — with the guard that stops a *failed* page
becoming an unthrottled retry loop, which on this panel would have run for as
long as the strand stayed open; see
[feed-and-posts](feed-and-posts.md#pagination) (#214).

Replies go through the **same outbox** as everything else, so one appears the
instant you send it and a failed one keeps its place with Retry — in the strand
as well as the transcript, which matters because the transcript is hidden while
you're in there. ⚠️ The entry keeps `replyToId` so a **retry is still
a reply**; without it a failed reply would quietly become an ordinary message on
the second attempt. It keeps `rootId` too — the client's own guess, since there's
no server copy until the send lands — purely so the strand knows which unsent
bubbles are its own. On success the accepted message is written into *both*
caches, the transcript's and the strand's, using `thread_root_id` off the
server's copy rather than the client's guess: the server decides which strand a
reply flattens into.

⚠️ **Everything that changes a message has to reach both caches**, and that send
is only the first case of it. The strand reads `['thread', id, rootId]` where the
transcript reads `['messages', id]`, so a reaction patched into the transcript
alone, or a delete that only invalidates it, is *invisible* rather than
wrong-looking: the transcript holding the right answer is hidden while a strand
is open, so the click looks as though it did nothing until the next poll — up to
`MESSAGE_POLL_MS` later. Reactions are written into every cached strand of the
conversation (`setQueriesData` on the `['thread', id]` prefix, not just the open
one, so a strand you come back to can't return holding a stale pill); delete
invalidates the same prefix. An edit needs neither: it isn't offered in the
strand, and reopening one refetches it.

**Escape closes the strand, not the drawer**, handled on the strand's own section
so it works wherever focus is in there. Same rule as the composer's Escape
leaving edit mode: the nearer thing wins, and losing the whole panel — along with
the sight of the draft and the edit the strand is hidden *over* — because you
wanted to step out of a thread would be a surprise. Closing a strand by either
route then puts focus back in the transcript's composer, because the element it
was on has just unmounted and the drawer is deliberately not a focus trap: left
alone, focus falls to `<body>` and the next Tab starts at the top of the page,
outside the panel entirely.

### Photos, the list and the info panel on the web (Phase 9b M9e)

M9e brought [photo messages](#photo-messages) and the app's
[conversation list](#the-conversation-list-phase-9b-m6) and
[info screen](#the-info-screen-phase-9b-m6) across. It's the one chunk of M9 that
**rewrites rather than ports**, and the rewrite is the interesting part.

🔒 **`frontend/src/chatPhotos.js` is a rewrite of the app's module, not a port.**
`expo-image-manipulator` has no browser equivalent, so the decoding and
re-encoding happen on a `<canvas>`: `drawImage` paints decoded pixels, `toBlob`
writes a fresh JPEG from them, and metadata isn't carried across — so EXIF,
including the GPS a phone stamps on every shot, simply doesn't exist in the
output. Same technique as the server's `_strip_and_encode`, which is why the two
produce comparable results. **The numbers are copied exactly** (1600px long edge
at quality 0.8, a 480px thumbnail at 0.6) and have to stay that way: two clients
producing visibly different photos from one source is the divergence M9 exists to
end. It is deliberately **not** routed through `api/imaging.py` — see
[why the photo is processed on the client](#-the-photo-is-processed-on-the-client-and-that-inverts-how-posts-work),
which is the whole reason this file exists.

Two browser-specific things worth knowing before touching it:

- **The strip is verified, not assumed.** A 3000×2000 JPEG carrying GPS and a
  Make/Model went through the drawer against a local stack: what the server
  stored was 1600×1067 with **zero EXIF tags and no GPS**, and the thumbnail
  480×320, likewise clean. Worth repeating by hand if this file is ever changed —
  jsdom has no decoder and no `canvas.toBlob`, so no test in the suite can see it.
- **EXIF orientation is the browser's job, not ours.** `image-orientation:
  from-image` is the default for `<img>`, so a photo tagged "rotate 90°" decodes
  already upright and `naturalWidth`/`naturalHeight` report the upright
  dimensions — which is what makes drawing it straight onto a canvas correct.
  Setting `image-orientation: none` to "fix" something would silently rotate
  everyone's photos.
- **The preview is a `blob:` URL, and something has to revoke it.** An object URL
  is a document-lifetime reference, so one left dangling pins its thumbnail's
  bytes until the tab closes. `outbox.js` owns the lifetime: every exit from the
  outbox — a settled send, a discard, sign-out — goes through one function that
  frees it, rather than the two call sites that would each have to remember.

**There is no camera, and that's finished rather than missing.** The app offers
one because taking a picture of what's in front of you is half of what a photo in
a chat is for on a phone; at a desk it isn't, and `getUserMedia` would mean a
permission prompt, a preview surface and a shutter built to serve the one case a
webcam serves worse than the file picker already does. `<input type="file"
accept="image/*">` is the whole affordance.

**The bubble draws a *sized* thumbnail** from the `width`/`height` on the
payload, fitted into the bubble's 224px of content width, and that's what those
two columns are for: the box exists before the image arrives, so a photo loading
while you're scrolled back through history doesn't shove what you were reading.
Clicking opens the shared `Lightbox`. Unlike the phone, **a photo inside a reply
strand opens perfectly well** — the app leaves that one inert because its strand
is a `Modal` and iOS won't stack two, and the web has no such trap, so it doesn't
inherit the restriction. An **unsent** photo is inert, because both its URLs
point at the same local thumbnail and a lightbox would be a blurry copy of what's
already on screen.

**The list gained search and a row `⋯`.** Search appears at six threads, matches a
group's title *and* its members' names, and lives inside the scroller so it
scrolls away rather than permanently narrowing the panel — 🔒 and it searches
names only, never message content, for the reason on the
[not-building list](#not-end-to-end-encrypted-yet). The row actions are
**Mark read/unread · Mute · Leave**, behind a hover `⋯` rather than the app's
swipe: a list row on a desktop has no swipe, and a pointer has somewhere to rest.
The `⋯` is a **sibling** of the row's own button, not a child — a button can't
nest a button, and the version that tried it opened the chat on every menu click.
The mark-unread gate is the app's, and
[narrower than the server's](#marking-a-thread-unread) for the same reason.

**The info panel is a fourth drawer *view*, not a route** (`messaging.jsx` is a
view machine). The app pushes a screen because a phone has a navigation stack;
giving the drawer one would mean the browser's Back button closed a panel that
isn't a page, while Escape — which *is* how you close it — left the history
behind. It carries what the app's screen does: participants with their **Pending**
badges, mute, add people, leave, block on a 1:1, **rename a group in place**, and
the **media gallery** (`?media=1&order=desc`, one page, `count` for the heading
because the grid isn't the whole chat, and **nothing at all** when there are no
photos). A rename writes the server's response straight into the
`['conversation', id]` cache the thread header reads, so the new name is up before
any refetch lands.

**The thread header is now identity + `⋯`** — Details · Mute · Add people ·
Leave — for the reason the app's is: three icon buttons were crowding the name of
the person you're talking to, which is the one thing a chat header is for. One
exception stayed behind: **a muted thread still says "Muted" up there**, because
everything else the header carried was an *action* and belongs in the menu, while
mute is a *state* and the whole risk of it is forgetting you did. Leave now
confirms first, matching the app and the rest of the web's destructive actions.

### Mentions, formatting and multi-select on the web (Phase 9b M9f)

M9f closed the gap. It brought
[@mentions](#-a-mention-is-a-relation-and-the-only-thing-that-beats-mute) and
[multi-select](#multi-select-phase-9b-m8) across, and with them the last of the
"the web is behind" caveats that used to live in this section.

**Inline formatting was already here**, because M9b ported the whole parser
rather than half of it: it finds links and `*bold*` runs in one walk, so shipping
the link half alone would have meant a bubble that deletes the asterisks and
styles nothing. What M9f actually added on that side is the **mention segment** —
the parser could always emit one, and nothing on the web passed it any names
until there was a picker and a name map to build them from.

**`frontend/src/mentions.js` is a port of the app's module** (the four string
questions, character for character, with its unit tests ported beside them) with
**one deliberate divergence in the hook**: the app *estimates* the caret from the
size of each edit, because an RN `TextInput` reports its selection a beat later
and sometimes not at all. A DOM `<textarea>` gives `selectionStart` synchronously
on the event that changed the text, so the web reads it — the estimate would be
strictly worse here, since it can't tell typing from a paste, an undo or a
drag-and-drop, none of which a phone keyboard produces. The mirror image of that
difference is that picking a name *sets* the caret on the web (and puts focus
back in the textarea), where the app leaves it alone: choosing is a **click** on
this side, so without it you'd be dumped at the end of the message with the
composer blurred. `onMouseDown` is prevented on every chip for the same reason.

Everything else about a mention is the [rule above](#-a-mention-is-a-relation-and-the-only-thing-that-beats-mute)
and holds identically: the picker is a strip above the composer, offered in
**group chats only** (the server 400s `mention_ids` on a 1:1) and **not while
editing**; the ids are reconciled against the words actually sent, so a name
picked and then deleted notifies nobody; and a mention is drawn **weighted, not
underlined or clickable** — there is nowhere useful to send a click, and a link
inside the message body would be one more thing fighting the ⋯ menu and select
mode for the same gesture. 🔒 An id the viewer can't resolve renders as the words
the sender typed, with no name invented for it.

⚠️ **A retry carries the mention ids off the outbox entry**, which is the third
instance of the rule M9d found with `replyToId` and M9e with `photo`: a failed
send retried without them keeps the `@Ada` in the text with nothing behind it —
no notification through her mute, no highlight — and the change is invisible
unless a test asserts the *second* call's arguments.

**Select mode differs from the app in three places, all because of the medium.**
It's entered from the ⋯ menu's **Select** (the app's long-press menu), the header
becomes "N selected" with Cancel, and the composer's slot becomes **Copy** and —
only when [every ticked message is one you could delete alone](#multi-select-phase-9b-m8)
— **Delete**. The differences:

- ⚠️ **A capture-phase click handler wraps the row, and the `preventDefault` is
  load-bearing.** A bubble contains links, a photo, a reply count and — since
  M9g — a click of its own when it wears a strand edge, every one of which would
  otherwise fire on the click that was meant to tick the box — opening a lightbox or navigating away mid-selection. Intercepting once in
  the capture phase settles all of them, rather than threading a "we're selecting"
  flag through every child that has a click of its own.
- **There's a real checkbox**, because the row is not a button and can't become
  one (a `<button>` can't contain the `<a>` a linkified message renders). The box
  is the accessible control and the row click is the convenience; a keyboard's
  Space on the box arrives at the same handler as any other click. Its label
  carries the **clock time** as well as the sender, because a burst is what this
  mode is for and a burst is several messages from one person — three boxes all
  saying "select message from Priya" are three controls a screen reader can't
  tell apart. The count is a `role="status"`, so ticking announces itself;
  without it the whole mode is silent, since a header swapping and a number
  going up are both purely visual events.
- **Unsent messages can't be ticked.** They have no server id to copy or delete
  by, so a tick-box on one would offer to include it in an action it can't be
  part of. (The app tolerates the tick and drops it later; this is the better
  end of that difference.)

**Escape leaves select mode rather than closing the drawer** — the nearer thing
wins, as it already does for edit mode and for a strand. It's a *capture-phase*
`document` listener, which is what puts it ahead of the drawer's own bubble-phase
Escape handler; there's no composer to swallow the key here, since the bulk bar
has taken its place.

Deletes go out one at a time and invalidate **on settle**, including the strand's
`['thread', id]` cache — M9d's sixth lesson, and multi-select is exactly the kind
of mutation it was written for.

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

**The composer's keyboard handling is not the platform default** (#172). It goes
through `components/KeyboardAvoider.tsx`, over
`react-native-keyboard-controller`, because Android's `adjustResize` stopped
resizing the window once edge-to-edge became mandatory — so the keyboard drew
straight over the compose box, which a tester hit on the first Android build. The
transcript needs no help of its own: it's an **inverted** `FlatList`, so the
newest message stays pinned while the keyboard animates rather than being chased
back into view. The composer bar also **drops its safe-area bottom inset while the
keyboard is up** (`useKeyboardVisible`), because the avoider has already lifted it
clear and the inset would otherwise be a dead band — up to ~48dp on Android
three-button navigation. The full reasoning, including the trap that a
`<Modal>` with an input now *needs* an avoider where it previously needed none,
is in [`mobile-app.md`](mobile-app.md).

### The conversation list (Phase 9b M6)

**Swipe a row for its actions**, the shape every mainstream messenger's list has
and the reason people are surprised when a row doesn't move. It follows iOS's own
convention so it needs no teaching: **swipe right** for the read/unread toggle,
**swipe left** for mute and leave.

- **Mark unread** is the one people came for — the write-up is
  [above](#marking-a-thread-unread). It's offered only where the server would
  accept it (an incoming message you've already read), because an action that
  reliably comes back a 400 is worse than one that isn't there. The mirror,
  **Mark read**, appears when the thread *has* unread.
- **Mute** reads as its state ("Unmute" once silenced), like the thread's control
  does — the whole risk of muting is forgetting you did.
- **Leave** confirms first, and on an invitation you haven't accepted it is
  **Decline**: the same endpoint, and a very different sentence.

**Why a swipe is safe here when [M3's swipe-to-reply wasn't](#reply-threads-on-the-phone-phase-9b-m3).**
That one raced the navigator's interactive back gesture and usually lost. The
conversation list is a **tab root** — there's nothing to go back to and no
competing responder — so the same gesture is unambiguous here. Worth saying,
because "we removed a swipe once" otherwise reads as "swipes don't work in this
app".

The row is built on `react-native-gesture-handler`'s **deprecated** `Swipeable`
rather than its current `ReanimatedSwipeable`, behind our own `SwipeableRow`
seam. Same trade `MessageActionMenu` made in M1: **Reanimated's worklet runtime
can't load under Jest**, so importing the current one fails the suite at
`require` time and the only way past is mocking the swipe away — which here would
mock away the actions, so no test could prove that Leave leaves. When RNGH
eventually drops the old component, one file changes.

**Search is by name, and deliberately not by message content.** It appears once
the list is long enough to need it (six threads), matches a group's title *and*
its members' names — an untitled group is displayed as its members, so you should
be able to find a chat by the name on the screen in front of you — and it lives
in the list header so it scrolls away rather than permanently narrowing the
screen. 🔒 Searching *messages* is the obvious next thought and is on the
[not-building list](#not-end-to-end-encrypted-yet): server-side search dies under
E2E, so building toward it means building something to tear out. Matching the
previews that happen to be loaded would also be a half-feature that silently
searches only each thread's newest message.

### The info screen (Phase 9b M6)

`/messages/[conversationId]/info` — everything *about* a chat, as opposed to what
was said in it: the participant list (with a **Pending** badge, which means
[waiting on connections](#membership-state-machine) rather than ignoring an
invitation), mute, add people, leave, block on a 1:1, and the rename control.

**It exists because the thread header had grown three text buttons** — Mute, Add,
Leave — competing with the name of the person you're talking to, which is the one
thing a chat header is for. The header is now identity + `⋯`, with one exception:
a **muted** thread still says "Muted" up there, because the whole risk of muting
is forgetting you did, so it has to be visible somewhere you'd notice.

Renaming happens **in place** rather than on a screen of its own — it's one
field, and a round trip through a form would be more navigation than the change
deserves. The response is the fresh conversation, written straight into the
`['conversation', id]` cache the thread header reads, so the new name is up before
any refetch lands.

**The media gallery** (added by M7, one milestone later than the rest of this
screen) is the natural home for "the picture someone sent last week": a grid of
the chat's photos, newest first, tapping into the shared `PhotoLightbox` as a
swipeable gallery. It reads the *messages* endpoint with `?media=1`, so it can
never show a photo the transcript wouldn't, and it renders nothing at all in a
chat with no photos. M6 shipped this screen without it deliberately — there were
no photo messages until M7, and an empty grid promising a feature that doesn't
exist is worse than its absence. See [Photo messages](#photo-messages).

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
started editing, and emptying the composer just disables Save — the one exception
being a message carrying a photo of its own, where clearing the caption is a
legitimate edit ([the full rule](#editing-a-message)) and still leaves the photo
behind. Either way there is no path from "editing" to an accidental delete.

**Report** was already built end-to-end by M0 (endpoint, `reportContent`,
`ReportModal`); M1 only added the menu entry that opens it, which is the UI entry
point M0 deliberately shipped without.

**Select** (M8) is the way into multi-select, and this menu is the right door for
it: it's already the answer to "do something with this message", and the second
message you want is the one you long-press *after* deciding there's more than
one. See [Multi-select](#multi-select-phase-9b-m8).

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
bubble: **long-press** for the action menu (Reply lives in it), **tap** to open
the thread. M3 gave the tap to the branch line and a reply's quote only, leaving
the bubble itself inert; M9g widened it to the whole bubble on replies, which now
wear the [strand edge](#the-strand-edge) — see there for why that's a revision of
the rule rather than a break with it. A plain message's tap still does nothing.

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

**The strand pulls every page**, like its web twin and for the same reason — page
one is a strand's *oldest* twenty, so reading only it hides the newest replies
and the one you just sent, while the root's count climbs past what's on screen.
It walks them through the shared `useFetchAllPages` (`mobile/src/lists.ts`), with
the guard that stops a *failed* page becoming an unthrottled retry loop: this
query polls and the strand is a `Modal` that stays mounted, so before #248 that
loop ran for the whole time the strand was open. The cost of stopping is that the
strand can sit clipped until a poll gets through, so a footer line says the
newest replies are missing rather than letting a short strand pass for a whole
one; see [feed-and-posts](feed-and-posts.md#pagination).

**The focused view** (`MessageThreadView`) is an `expo-blur` `BlurView` over the
transcript with the strand floating on it. The blur is doing real work rather
than decoration: a plain dim scrim reads as "a modal over a list", where the blur
reads as the same conversation pushed out of focus — you haven't gone anywhere,
you've narrowed to one strand. **It deliberately offers no long-press menu**:
`MessageActionMenu` is itself a `Modal`, and presenting a modal from inside a
presented one is the iOS trap the emoji picker already documents. Close the
thread and act on the message in the transcript.

**On Android there is no blur, and the wash covers for it** (Phase 10).
`expo-blur` is iOS-first: its Android `blurMethod` defaults to `'none'`, which
paints a flat translucent tint, and switching it on additionally needs a
`<BlurTargetView>` wrapping the content to be blurred *in the same window* — a
`Modal` is a window of its own, so that route isn't open here. The strand
therefore sat over a perfectly legible transcript (roughly 35% show-through once
the tint and the wash were combined) and the two conversations' text overlapped.
Android now takes a near-solid wash (`rgba(251,250,247,0.94)`) where iOS keeps
the light one (`0.55`); a blur can be light because it destroys the detail
behind it, a wash can't. **What lands on screen is ~5% show-through, not the 6%
that alpha alone implies** — the `BlurView` stays mounted underneath and adds its
own flat tint (~0.22 at `intensity={28}`), so the two compose; measured on a
Pixel 8 emulator, ink behind the wash reads (240,239,236) against a
(251,250,247) ground. That margin is deliberate: the transcript's colour stays
faintly present, so it still reads as this conversation pushed back rather than a
screen you navigated to. Tune the number against the composite, not on its own.
A test pins the split (Android ≥ 0.9, iOS ≤ 0.6) in each platform project,
deliberately as a threshold rather than an exact colour so that retuning against
a real screen doesn't fail a test with nothing to say.

**The strand opens at its newest reply, and on Android that takes two goes**
(Phase 10). Unlike the transcript below, this list isn't inverted — it reads
oldest-first with the root at the top — so it keeps the `scrollToEnd`-on-content-size
that inversion let the transcript delete. `scrollToEnd` is a command to the
*native* list, and on Android it arrives before the new content height has been
committed: it scrolls to a bottom that is still the old one (0, on a strand
that has just opened), and the next event is a `layout` rather than a content
size, so nothing corrects it. The strand opened at the root with its newest
replies hidden behind the composer. The call is now made twice, the second
inside a `requestAnimationFrame`; iOS commits synchronously and is already at
the end by then, so its second call is a no-op rather than a second jump.
Inverting this list the way the transcript is inverted would remove the need for
either call, and is the better fix if this area is reworked — it was judged too
much surface area to flip (header/footer swap, `ListEmptyComponent`, row order)
for a bug that has a one-line answer.

**Known limitation, unchanged by that fix and older than it**: the strand only
re-scrolls on a *content size* change, so anything that shrinks the list's
**viewport** without changing its content leaves it where it was — the keyboard
coming up on a strand longer than the screen, or the composer growing to a
second line, can put the newest reply behind them. The transcript doesn't have
this because inversion pins it to the newest message through a resize. Fixing it
here means either an `onLayout` re-scroll (which would also yank someone who had
scrolled up to read the root) or the inversion above.

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
only the run's last bubble carries the timestamp. A run breaks at a divider as
well as at a change of sender: one straddling "Yesterday" would read as a single
sitting.

The run's last bubble also **squared off its near-bottom corner** until M9g,
which dropped it: with a [strand edge](#the-strand-edge) running down the side, a
bar that ends bluntly on some bubbles and curves away on others reads as though
the difference means something. Every bubble now has the same corner, which is
also what the web always did.

Two things are **exempt from run grouping's timestamp suppression**, and both are
load-bearing rather than tidy-ups. An **"Edited" marker** is a disclosure — the
thing that [makes editing safe at all](#editing-a-message) — so it can't be
hidden by where a bubble happens to sit in a run. And an **unsent message** shows
its clock or its failure wherever it lands, or two queued messages would leave
the first looking sent.

**An unread divider** marks where you stopped reading, and the thread **opens
there** rather than at the bottom — that's what the divider is for, and why it's
accented while the day separators aren't. It's positioned from `unread_count` on
the conversation detail, captured **once during render** before the mark-read
write goes out — which is also why that write now waits for the detail to land,
since if it won the race there'd be nothing left to capture. The count, not your
own `last_read_at`: the detail withholds every read marker, including yours, when
you've [turned receipts off](#the-setting-usersend_read_receipts), and a divider
that quietly stopped working for anyone who opted out of an unrelated setting
would be a bad trade. When the unread run is longer than the loaded page the
divider is **left out** rather than placed at the top of what happened to load —
pointing at the wrong message is worse than pointing at nothing, and it resolves
itself on the next page.

**Both the position and the label are latched, not re-derived.** The count locates
the divider by counting back from the newest message, and the newest message keeps
changing: left live, every message arriving while you read pushes a fixed count
one further down and slides the marker past the messages it was placed to mark,
while the label climbs and describes a thread you're sitting and watching as five
unread. So the anchor is fixed the first render it can be worked out and the
label is the number that was waiting when you opened it. The opening scroll is
likewise once-only — re-running it on the four-second poll would yank the list
back up under someone who had scrolled away — and after it, jump-to-latest is how
you get to the bottom.

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
conversation, 🔒 cleared on sign-out with the outbox; a session *expiry*
deliberately keeps both, and a sign-in by a *different* person clears them —
see [accounts.md](accounts.md#what-leaves-the-phone-with-the-session-191)).
Deliberately *not* while editing: in edit mode the composer holds someone's sent words rather than a draft
of yours, so persisting them would mean coming back to a message you never wrote.

**Quotes are fetched when they haven't paged in.** This is the debt M3 left, and
it had to be settled here. *(M9g deleted `quotes.ts`: the client draws no quotes
anywhere any more — see [The strand edge](#the-strand-edge). Kept below because it
is the reasoning behind the `?ids=` endpoint, which is still the server's rule for
handing a message over by id.)* The transcript resolved a quote's body and author from
messages it already held, which was complete *only* because it loaded every page.
With lazy paging a miss also means "not paged in yet", so "Original message
unavailable" — which is supposed to mean *you were clipped out of this* — would
be a lie some of the time, and a message that lies sometimes is worth nothing in
the case where it's true. `quotes.ts` fetches the misses through
[`?ids=`](#api), the same interval-clipped endpoint, and **never** a wider
payload. Each id is asked about **once**: an unresolvable id is a fact about this
viewer, not a transient failure, so re-asking every poll would be a request that
can only ever return nothing. 🔒 What it held was other people's message text, so
it was cleared on sign-out too — and since M9g there is no store to clear.

**New-message push** (issue #118) is the one place the app gets something the web
can't have. A tapped message push deep-links to the thread via `routeForNotification`
(`/messages/<id>` → `/messages/[conversationId]`); the thread screen's existing
mark-read-on-open clears the badge, so the tap path needs nothing special. It's the
only push with `notificationId: null` and `kind: "message"` — there's no
activity-centre row behind it. See [Push notifications](#push-notifications).

### Multi-select (Phase 9b M8)

Select in the long-press menu turns the header into "N selected" with Cancel, and
the composer's slot into **Copy** and **Delete**. Deleting a burst one long-press
at a time is genuinely irritating, and it's the only part of the thread where the
app made you repeat yourself.

Four decisions:

- **The pressed message comes with you into the mode.** A burst is exactly where
  you already know you want the next few, so entering with nothing ticked would
  waste the tap you just made.
- **A tap on a bubble ticks it** — the one state where a bubble's own tap does
  anything. That's a *suspension* of the [one-gesture-per-target
  rule](#the-long-press-action-menu-phase-9b-m1) rather than an exception to it:
  while selecting, a tap means one thing everywhere on screen. The long-press
  menu stands down for the same reason, so two modes can't race.
- **Delete is offered only when every ticked message is one you could delete on
  its own.** A bulk action that silently did *part* of what it says — yours,
  quietly skipping theirs — is worse than one that isn't there. Absent reads as
  "not yours"; permanently greyed reads as a bug. Copy stays either way, since
  quoting an exchange is what you'd select someone else's messages for.
- **Copy joins them oldest-first**, prefixed with who said what in a group. An
  exchange between three people is unreadable pasted without names, and only
  reads correctly in the order it happened. Messages with no words (a photo on
  its own) are skipped rather than rendered as a placeholder.

Deletes go out one at a time rather than in parallel — nobody is waiting on the
round trip, since the bubbles are already gone from the selection — with one
invalidation at the end, on settle rather than success: a partial failure still
deleted some of them, and leaving those on screen would look like the whole
action failed.

### Replying from the notification (Phase 9b M8)

A message push carries an iOS notification **category**, so pulling it down gives
you a text field: type, send, and the app never comes to the foreground. That's
what turns a push from a doorbell into something you can answer, and it's why the
handler navigates nowhere on a reply — opening the thread would defeat the point.

The moving parts, which have to agree by name: the backend puts
`categoryId: "message"` on message pushes only (`send_pushes`), and the app
registers that category with a `reply` action at launch (`push.ts`), because iOS
keeps categories per *app* and a push can arrive before anyone signs in on this
launch. **iOS silently ignores a category it doesn't know**, which looks exactly
like the feature not existing — so the string is pinned by a test on both sides.

**A reply that fails to send is kept.** There's no screen to report on — by
construction the app isn't in front of anyone — and a second notification saying
"couldn't send" would be a poor apology for having eaten what someone wrote. So
it goes into the same [outbox](#optimistic-send-the-outbox) an in-app send uses
and shows up as a failed bubble with Retry the next time the thread is opened.
"We never drop text you typed" covers text typed into a notification too.

Only messages get the category: replying to "Ada replied to your post" would mean
posting a comment from the lock screen, which is a different feature against a
different endpoint. See
[notifications.md](notifications.md#phone-push-phase-9-milestone-d).

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

**E2E is a stated long-term goal** but a large, separate undertaking — comparable
in size to the entire iPhone app, and the highest-risk work in the project,
because the failure modes are *permanently unreadable messages* and *a false sense
of security*, both worse than the status quo. The server could then never read
messages, so previews/search/web-reading move client-side; it needs per-device
keys, key exchange and verification, multi-device sync, group key rotation on
every membership change (and the clique state machine churns membership a *lot*),
and an answer for the web client that doesn't amount to "trust the server that
serves you the JavaScript". Best built on a proven protocol like libsignal.
Sketched as [`../phases/phase-9c-e2e-encryption.md`](../phases/phase-9c-e2e-encryption.md);
flesh it out and confirm it before starting, per the repo convention.

**Encryption at rest for the message column: a modest, honest improvement, not a
priority.** Off-box backups are *already* encrypted before they leave the house
(`deploy/backup.sh`, rclone `crypt`), so the headline benefit is banked. Column
encryption would additionally cover locally staged dumps, direct `psql` access and
a stolen disk — but the key would live in the environment **on the same box**, so
anyone who can read the database can almost certainly read the key. It also costs
a non-additive migration (rewriting every row) and makes key loss equal permanent
message loss.

### Three things in the current design are shaped by E2E being the goal

Deciding E2E now rather than later stopped us building things we'd have to
demolish. **Don't undo these for convenience:**

1. **A reply quote is a reference, never embedded text.** A reply serializes its
   target as a bare `{ id }` — not the text, not even the author; both come from
   the client's own copy or a fetch through the interval-clipped messages
   endpoint, never from anything the server attached to the reply. Under E2E the
   server *couldn't* embed quote text, and refusing to embed it now also removes
   an interval-clipping leak entirely, because there's no server-side text to
   leak. See *🔒 The visibility rule* above for the exact line.
2. **Photos are processed on the client, not the server.** Under E2E the server
   stores opaque bytes and cannot EXIF-strip or downscale them, so building on the
   server-side `api/imaging.py` path would mean tearing it out later. The server
   still enforces byte-size and count limits, which work fine on opaque blobs. See
   *🔒 The photo is processed on the client* above.
3. **Reactions stay server-side plaintext — a knowing exception.** Encrypting them
   would kill server-side aggregation for very little gain: a bare emoji, detached
   from the message it's on, reveals close to nothing. A deliberate carve-out, not
   an oversight.

Two things need no change at all: **read receipts are metadata** and survive E2E
untouched, and **push bodies already never quote message text**.

## What messaging deliberately doesn't have

Stated explicitly, because "as good as the big messengers" is otherwise unbounded.
These are decisions, not gaps — reopen one only with a reason.

| Not built | Why |
| --- | --- |
| **Typing indicators / "online" / "last seen"** | Presence is a surveillance feature with a much worse value-to-creepiness ratio than read receipts, and on polling it needs a write per keystroke-ish plus a poll to read it. Revisit only alongside real-time. |
| **Forwarding** | It's the mechanic that makes chain messages and misinformation move. Nobody in a friends-and-family app needs one-tap broadcast; copy and paste still exists. |
| **Ephemeral broadcast ("stories"/"status")** | A different product. We have a timeline. |
| **Disappearing messages** | Sounds privacy-first, isn't: it implies a deletion guarantee we can't make (the server reads plaintext, backups exist, screenshots exist). Promising it would be dishonest. |
| **Starred messages, archive, chat wallpaper** | Real features, low value at family scale. Cheap to add later if anyone asks. |
| **Link previews** | The server would fetch every URL anyone pastes — a tracking leak and an SSRF surface, for a thumbnail. |
| **Voice notes, calls** | Separate phases with real infra (media pipeline, WebRTC). |
| **Server-side message search** | Dies under E2E anyway. Don't build toward it. |
| **Stickers / GIF search** | GIF search means a third-party API on every keystroke — a tracker in the composer, straight against the privacy principle. Emoji and photos cover the need. |
| **Video in chat** | Not "never" — it's **Phase 13** (`../phases/phase-13-video-clips.md`), which builds the whole video pipeline. The attachment model was shaped to let a second media type slot in. |
| **A "delivered" tick** | The category shows sending → sent → **delivered** → read; we do three states, not four. Delivery means a device acknowledged receipt, and with polling + push nothing reports that. Faking it from the push receipt would be a lie with a tick on it. See *Ticks: three states, not four*. |

## Open questions

Settled if and when someone actually asks, not before.

- **Edit window length.** 15 minutes matches the common default and is a guess for
  us. One constant; revisit after real use.
- **Delete for me vs delete for everyone.** The category generally has both; we
  have only "delete for everyone" (soft-delete + tombstone). Two-mode deletion is
  more concept than it's worth at family scale unless someone asks.
- **Adaptive polling.** Only if the cadence feels laggy in real use — see
  *Real-time = polling* above.
- **Pinned chats.** Deliberately left out: it's user-controlled ordering, not an
  algorithm, so it doesn't offend the principles — it's just low value until
  someone has enough conversations to lose one.
- **Search within a conversation.** Client-side over loaded messages is possible
  and survives E2E; server-side doesn't.
- **Per-person read state in a group** ("message info"). The data exists; it's a
  small screen if anyone asks for it.
