# Phase 5 — Direct Messaging

**Status:** not started — planned (this doc is the full plan; confirm before
building)

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

- [ ] `Conversation` + `Message` tables (and a read-marker) via migrations
- [ ] Start (or reopen) a 1:1 conversation with **a person you're connected
      with** — not strangers (private-by-default, consistent with connections)
- [ ] Send a message; view a conversation thread oldest-first, paginated
- [ ] Delete your own message (confirmed in scope for v1)
- [ ] A list of your conversations, most-recent-activity first, each showing the
      other person, a last-message preview, and an unread count
- [ ] Unread indicator (per-conversation count + a total badge in the nav)
- [ ] Near-real-time delivery via **polling** (TanStack Query `refetchInterval`)
      — WebSockets deferred (see decisions log)
- [ ] **Block a user**: prevents messaging (and re-connecting) both ways
- [ ] A "Message" affordance on a connected person's profile
- [ ] Backend + frontend tests (send/scope/read/block), following the
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

(Record deviations/gotchas here once building starts.)
