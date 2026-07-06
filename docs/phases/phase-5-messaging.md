# Phase 5 — Direct Messaging

**Status:** done — implemented on branch `phase-5-messaging`. Backend
(`Conversation`/`Message`/`ConversationRead`/`Block` + endpoints) and frontend
(`/messages` list, `/messages/:id` thread, nav badge, profile Message/Block
controls) are in, with backend + frontend tests passing. See the notes log below
for the choices made while building.

## Goal

Add private one-to-one messaging between **connected** users, layered onto the
timeline app from Phases 2–4. Still no algorithm anywhere — a conversation is
just a chronological list of messages, and the conversation list is ordered by
most-recent activity (time, not "relevance").

## Runnable product at the end of this phase

Two connected, logged-in users can open a conversation, send messages back and
forth, and see them appear in order and near-real-time (short-interval polling).
A nav badge shows unread messages, and you can block someone.

## Definition of done

- [x] `Conversation` + `Message` tables (and a read-marker) via migrations
      (`0006`, plus a `Block` table)
- [x] Start (or reopen) a 1:1 conversation with **a person you're connected
      with** — not strangers (private-by-default, consistent with connections)
- [x] Send a message; view a conversation thread oldest-first, paginated
- [x] Delete your own message (confirmed in scope for v1) — soft delete, keeps a
      "message deleted" tombstone in place
- [x] A list of your conversations, most-recent-activity first, each showing the
      other person, a last-message preview, and an unread count
- [x] Unread indicator (per-conversation count + a total badge in the nav)
- [x] Near-real-time delivery via **polling** (TanStack Query `refetchInterval`)
      — WebSockets deferred (see decisions log)
- [x] **Block a user**: prevents messaging (and re-connecting) both ways
- [x] A "Message" affordance on a connected person's profile
- [x] Backend + frontend tests (send/scope/read/block), following the
      established pattern

## API sketch (REST, reuses the Phase 3/3a auth + connection model)

- `GET  /api/conversations/` — your conversations: other participant (with
  `avatar_thumb`/`display_name`), last-message preview, `unread_count`,
  `updated_at`; ordered by `updated_at` desc, paginated.
- `POST /api/conversations/` — body `{ user_id }`; **get-or-create** the 1:1
  conversation with that (connected, non-blocked) user. Idempotent — returns the
  existing one if any. 403 if not connected / blocked, 404 if unknown/inactive.
- `GET  /api/conversations/<id>/messages/` — messages oldest-first, paginated;
  404 unless you're a participant.
- `POST /api/conversations/<id>/messages/` — body `{ text }`; sender is the
  session user, never the body. Bumps `Conversation.updated_at`.
- `POST /api/conversations/<id>/read/` — mark read up to now (sets your
  `last_read_at`), which clears the unread count.
- `DELETE /api/conversations/<id>/messages/<msg_id>/` — delete your own message
  (only the sender; the thread then shows it gone / "message deleted").
- `POST` / `DELETE /api/users/<id>/block/` — block / unblock.

## Data model

- **`Conversation`** — a 1:1 thread. Same symmetric-pair pattern as
  `Connection`: `user_a`/`user_b` with a `UniqueConstraint(Least, Greatest)` so
  there's exactly one row per unordered pair, and a `no_self` check. Carries
  `created_at` and `updated_at` (bumped on each new message, so the list can sort
  by activity cheaply).
- **`Message`** — `conversation` (FK, `related_name="messages"`), `sender` (FK),
  `text`, `created_at` (indexed). `ordering = ["created_at", "id"]` (oldest-first,
  stable tiebreak) — mirrors `Comment`.
- **`ConversationRead`** — `(conversation, user, last_read_at)`, unique together.
  Unread for you = messages in the conversation with `created_at > last_read_at`
  and `sender != you`. Its own table (rather than two timestamps on
  `Conversation`) keeps 1:1 clean and extends to group threads in Phase 6.
- **`Block`** — `(blocker, blocked)` directional, unique together. A block in
  **either** direction hides the pair from each other and blocks messaging +
  connecting.

## Steps

1. Add the models + migrations (`Conversation`, `Message`, `ConversationRead`,
   `Block`) in the `api` app.
2. A shared `can_message(me, other)` gate: connected, both active, neither has
   blocked the other. Reuse `connected_user_ids` from `api/views.py`.
3. Serializers + views for the endpoints above; wire the block gate into the
   existing connect view too (can't connect to someone you've blocked / who
   blocked you).
4. Frontend: a `/messages` list page and a `/messages/:id` thread page (compose
   box + chronological messages), a nav "Messages" link with an unread badge
   (same pattern as the Requests badge in `Layout.jsx`), and a "Message" button
   on connected profiles. Poll the open thread + the list on a short interval;
   `POST /read/` when a thread is viewed.
5. A "Block / Unblock" control (on the profile or in the thread header).
6. Tests both sides: message send + participant-scoping (non-participant 404),
   can't message a non-connection, unread count + mark-read, block prevents
   messaging and connecting.

## Privacy / safety notes

- **Messaging is connection-gated.** You can only DM someone you're mutually
  connected with — no cold DMs from strangers. Disconnecting stops future
  messages; blocking is the stronger, explicit cut.
- **Not end-to-end encrypted (yet).** Messages are stored in the database in
  plaintext and are readable by the maintainer via the Django admin (like all app
  data). Say this plainly in any future privacy policy — don't imply E2E privacy
  we don't provide. **E2E is a stated long-term goal** (the maintainer wants
  everyone private and safe), but it's a large, separate undertaking and out of
  scope for this phase — noted here so it isn't forgotten. Honest framing of why
  it's hard, for when we pick it up:
  - E2E means the **server can never read messages** — so features that lean on
    the server seeing content (search, previews in the conversation list,
    web-based reading without the user's key) get harder or move client-side.
  - It needs **client-managed keys** (per device), a key-exchange/verification
    story, and multi-device sync — genuinely complex, especially across the
    future iOS/Android apps (Phases 8–9). Best tackled once those clients exist,
    likely on a proven protocol (e.g. Signal/libsignal) rather than hand-rolled.
  - Practical interim privacy: keep transport TLS (Phase 7), lock down admin
    access, and consider **encryption at rest** for the messages table as a
    lighter step before full E2E.
- **Retention / deletion.** Messages are kept until a participant deletes them
  (message/conversation deletion can be a small follow-up if not in v1). The
  account-level "delete my data" path is a Phase 7 concern and should cascade to
  messages.
- **Abuse at small scale.** Block covers the main case; the maintainer can also
  moderate/remove via the admin. Report-a-message can wait unless needed.

## Decisions (recommended — confirm before building)

- **Polling before WebSockets (confirmed with the user, 2026-07-06).** Start with
  TanStack Query `refetchInterval` (e.g. ~3–5s on an open thread, slower on the
  list). Rationale: real-time chat via Django Channels needs an ASGI server +
  Redis channel layer — real infra that `docs/SHARED.md` explicitly defers to
  "add later." At family scale, polling is indistinguishable to users and far
  simpler/cheaper. **The swap is deliberately non-breaking:** the REST endpoints
  and data model stay exactly the same; going real-time later just adds a
  Channels consumer that pushes new messages, and the frontend replaces the
  interval with a socket subscription — no schema/API migration. Keep the
  polling interval in one small config spot so it's a one-line change.
- **1:1 only this phase.** Group conversations are a **sub-phase after Phase 6
  (groups)** — call it Phase 6a — not part of Phase 5 (confirmed 2026-07-06). The
  read-marker/participant shape here is chosen so a group thread is a later
  extension, not a rewrite; "leave a conversation" lands with group chats then.
- **Message deletion in v1 (confirmed 2026-07-06).** You can delete your own
  messages now. Per-message "delete for me vs. everyone" nuance can stay simple
  (delete removes it for both — it's a 1:1 thread); revisit for group chats.
- **Connection-gated recipients** (see privacy notes) — the single biggest
  safety decision, and it falls straight out of the app's philosophy.

## Resolved with the user (2026-07-06)

- **Polling for v1** — accepted, on the understanding it swaps cleanly to a
  scalable real-time solution later (it does — non-breaking, see decisions above).
- **Message deletion in v1** — yes.
- **Group chats** — a sub-phase **after** Phase 6 (groups), not here; "leave
  conversation" ships with them.
- **Full E2E encryption** — a long-term goal, understood as not feasible in this
  phase; captured under privacy notes so it stays on the roadmap.

## Notes / decisions log

- **Message deletion is a *soft* delete, not a row drop.** Deleting blanks
  ``text`` and sets ``deleted_at`` rather than removing the row. Two reasons:
  the thread keeps a "message deleted" placeholder in its original spot (no
  silent reshuffle), and the stable ``created_at, id`` ordering / pagination
  isn't disturbed by a hole. Deleted messages don't count toward unread.
- **Two extra endpoints beyond the API sketch**, both to keep the client simple
  and correct:
  - ``GET /api/conversations/<id>/`` (conversation detail) — the messages
    endpoint doesn't carry the *other participant*, so the thread page needs
    this for its header to be right on a cold load/refresh. It also returns a
    server-computed ``can_message`` boolean (connected + not blocked) that drives
    whether the composer is shown — matching the real send gate exactly, so the
    UI and the 403 can't disagree.
  - ``GET /api/messages/unread-count/`` — a single-number endpoint for the nav
    badge, so the badge doesn't have to load and sum the (paginated)
    conversation list.
- **Unread + last-message are computed without N+1.** The conversation-list
  decorator (`decorate_conversations` in `api/views.py`) does one
  Postgres ``DISTINCT ON (conversation_id)`` query for each thread's latest
  message and one grouped-``Count`` query (with a per-viewer ``last_read_at``
  ``Subquery``) for unread — a fixed number of queries per page regardless of
  page size. Note ``DISTINCT ON`` is Postgres-specific (fine — Postgres is the
  chosen DB, and the tests run on it).
- **Blocking severs the connection.** ``POST /users/<id>/block/`` deletes any
  ``Connection`` row between the pair as well as creating the ``Block`` — you
  shouldn't stay "connected" to someone you've blocked. Unblock only lifts *your*
  own block (a mutual block is two independent rows). A block in either direction
  hides the conversation from **both** lists and 404s the thread, and bars
  (re)connecting (wired into the existing `ConnectView`).
- **`can_message(me, other)`** is the single gate (active + connected + not
  blocked) that both create-conversation and send-message consult, and it reuses
  `connected_user_ids`. History stays readable after a disconnect (GET works);
  only *sending* is gated, so `POST` re-checks it and 403s.
- **Polling cadence lives in one place** — `MESSAGE_POLL_MS` (open thread) and
  `CONVERSATION_LIST_POLL_MS` (list + nav badge) in `frontend/src/api.js`. The
  thread page eagerly pulls all message pages (threads are short at family
  scale) so the newest messages are always on screen; going real-time later
  swaps the interval for a socket subscription with no schema/API change, as
  planned.
- **`is_blocked` on the profile payload** (annotated only on the user-detail
  view, defaults False elsewhere) tells the profile page whether *you've* blocked
  this person, so it can show Unblock + a note and hide the Message/Connect
  actions. A block severs the connection, so "connected" already implies "not
  blocked" — the two never both show.
