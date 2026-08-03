# Connections & comments

The social graph and the visibility boundary that everything else keys off. A
**connection** is a symmetric, mutually-approved relationship (there is no
one-directional "follow"), and it's the single predicate that decides whose posts,
comments, and reactions you see. This doc is the current-state reference.

Code: `Connection` / `Comment` models + `connected_user_ids` / `visible_posts` /
comment-tree pruning in `backend/api/views.py`. Frontend: the Connect button,
"Connection requests" inbox, and the comment thread on each post.

## Connections (the relationship)

A connection is stored as a **single** `Connection` row: `requester`, `requestee`,
`status` (`pending` | `accepted`).

- **Private by default, always.** Every connection is a *request* the other person
  approves — no instant connect, no per-account public/private toggle. One
  behaviour, matching the privacy-first mission.
- **Symmetric once accepted.** While `pending`, direction still matters (requester
  asked requestee). Once `accepted`, the row is treated as symmetric and
  visibility checks both endpoints — approving connects **both** accounts (no
  separate "follow back"). One row = one source of truth, so there's no reciprocal
  row to drift out of sync.
- **`connected_user_ids(user)`** collects the *other* party from every accepted row
  where you're either endpoint. This one helper feeds `visible_posts` (so the feed
  and profiles agree) and the comment/reaction pruning.
- **Guardrails live in the DB, not just the API.** A functional unique index —
  `UniqueConstraint(Least("requester_id","requestee_id"), Greatest(...))` — makes
  the *ordered pair of ids* unique, so A↔B and B↔A can't both exist regardless of
  who requested whom. Plus a no-self-connection check. (Postgres-only; Postgres
  runs in dev, test, and prod.)

### Endpoints & button states

- `POST /api/users/<id>/connect/` — send a pending request, **or** accept an
  incoming one (see auto-accept below).
- `DELETE /api/users/<id>/connect/` — cancel a request or disconnect.
- `GET /api/connection-requests/` — your inbox; `POST .../<id>/approve|reject/`,
  guarded so only the requestee can act (else 404, so requests to others aren't
  revealed).
- **`connection_status`** is annotated per-viewer as none / requested (you asked)
  / **incoming** (they asked you) / connected, driving the Connect / Requested /
  **Approve** / Connected button. The "Approve" state calls the same
  `POST /connect/`, so you can accept from someone's profile, not only the inbox.
- **Reverse-request auto-accept:** if B requests A while A already has a pending
  request to B, the intent is clearly mutual — the second `POST` accepts the
  existing row instead of creating a competing one (which the unique constraint
  would reject anyway).

### Reporting a refused write

The Connect button, the Message button and the disconnect path had no error path
at all until issue #236: nothing rendered `isError`, mobile never alerted, and
`onSuccess` is the only place an invalidation runs — so a rejection left the cache
untouched and the button exactly as it was. Press **Requested** to withdraw after
they've already accepted (or closed their account) and the 400 repainted nothing;
the click read as never having registered, so the natural response was to press it
again. Both clients now report it where the action was taken — inline under the
button on the web, `Alert.alert` on the phone.

Two rules the copy follows, worth keeping when this pattern spreads to the other
surfaces in the same family (#237–#240):

- **The server's own words win where it has any.** `ConnectView` rejects with
  sentences written for a person — "You can't connect with this person." when a
  block bars it — which say more than any fallback could. The exception is the
  block itself, where the server has nothing useful to say and safety needs
  stating outright: see [messaging.md](messaging.md#blocking).
- **The fallback is per state, not generic.** "Couldn't withdraw that request",
  not "something went wrong" — knowing *which* of the four things the button does
  didn't happen is most of the value. It's reached whenever the server didn't
  write anything readable, which is **two** cases, not one: a network failure
  (offline, DNS, the connection dropped — the browser's own "Failed to fetch"),
  and a server error with no DRF body (a 500 rendered as a Django HTML page)
  which leaves `firstErrorMessage` nothing to pull out, so `api.js` synthesizes
  "Request failed (500)". Both clients' `ApiError` therefore carries a
  **`fromServer`** flag, and `serverMessage` gates on it — nothing cruder
  separates the two, since the second case has a message *and* a status.

  **Issue #240 made this the whole web client's rule, not three buttons'.**
  `frontend/src/api.js` now wraps the `fetch` itself and re-raises a network
  failure as an `ApiError` with `status: 0`, `fromServer: false` and a sentence
  of ours ("Couldn't reach the server — check your connection and try again."),
  keeping the original `TypeError` as its `cause` for debugging. Every web site
  that renders a rejection — ~45 of them, across the feed, comments, profiles,
  groups, events, messaging and the auth pages — goes through
  `serverMessage(err, fallback)`. Before that they read `err?.message ||
  fallback`, and since a `TypeError` *has* a message the fallback never ran:
  being offline is the most likely way any write fails, so the sentence written
  for exactly that case was the one that could never appear. Two consequences
  worth knowing: **a status check no longer distinguishes anything** (a network
  failure now carries a numeric status of its own — the web `RsvpBar` sniffed for
  one and had to change), and **`GroupMembersPanel` had no fallback to reach**,
  rendering `actionError.message` bare, so one had to be written. The rule now
  reads in one line: *the server's own words when it wrote any, ours otherwise,
  the browser's never.* Pinned in `frontend/src/offline-writes.test.jsx` and
  `api.test.js`. The mobile client has the same unguarded `fetch` at ~25 sites —
  tracked separately in #243. Its *second* unguarded `fetch`, on the token
  refresh path, is guarded as of #245, where the same root cause signed the user
  out rather than mis-wording a message — see
  [accounts.md](accounts.md#only-the-server-may-end-a-session-245).

- **A message is retired only by the server moving to the answer the attempt was
  reaching for** — the request landed and only its response was lost, so the
  message would now sit under the very thing it denies. Any *other* answer leaves
  it standing: a refetch bearing some third status isn't confirmation of your
  attempt, and clearing on any resync is the swallow issue #231 describes. Both
  halves are judged against what was recorded at the attempt, never against when
  the sync arrives, so a refetch landing in the same render batch as the
  rejection can't eat the message before it's painted. This is the discipline
  [events.md](events.md) records for the RSVP, applied to a four-state button;
  the phone doesn't need it, since an `Alert` is dismissed rather than kept.
  On a two-state control the two halves collapse into one comparison — see the
  reaction chips in [reactions.md](reactions.md#frontend) (issue #242), where
  the "answer" is simply whether that emoji is yours.

The disconnect and block paths additionally hold their confirmation modal open
until the write lands, so the failure has somewhere to go — see
[messaging.md](messaging.md#blocking) for why that matters most on the block.
**On mobile that hold is a tripwire**: it depends on `onlineManager` being left
unwired to NetInfo, because wiring it makes React Query *pause* an offline
mutation rather than reject it, and a dialog that refuses Cancel while busy would
then never let go. The deferral note in `mobile/src/app/_layout.tsx` names every
component that depends on it — add to that list, don't just add the dependency.

**Issue #254 made that hold the rule for every dialog that renders its own
rejection**, which is the *unmount* spelling of the same bug: the message is
written into a component that has already been torn down, so nothing renders
anywhere. The four that didn't follow it were `ReportModal` and
`DeleteAccountSection` on both clients, all of which left Escape, the backdrop,
Cancel and (on the phone) `onRequestClose` — the Android hardware back — wired
straight through while the request was open. `ConfirmDeleteDialog.jsx` had
already settled the pattern next door; these just hadn't adopted it. The
invariant is worth stating as a class rather than four instances: **a dialog that
is the only renderer of its own error may not be dismissable while that write is
in flight.** Reporting is the one that matters most — it's the safety path, its
success screen is a whole "Thanks for letting us know" panel, so a silent failure
is indistinguishable from never having pressed Send.

Two things a change here has to keep:

- **Release the flag the moment the write lands, not when the screen goes.** The
  gate exists so a *rejection* has somewhere to render; once the request has
  succeeded there's no rejection left, so holding it any longer only creates a
  second trap. Both `ReportModal`s stay mounted afterwards to show the thanks
  screen, so `submitting` clears alongside `done` or the gate would hold that
  screen shut behind its Done button. Both `DeleteAccountSection`s then do the
  same for a subtler reason: they lean on the screen being torn down, but the
  teardown is *itself* a network round trip — `logout()` on the web,
  `signOut()`'s `unregisterPush`/`logout` on the phone — and those are the one
  part of the flow that can hang. A gate held across them would seal someone into
  a "Deleting…" box with no way out. Both clear the flag right after the delete
  returns and keep the button spent with a separate `done`, so a second press
  can't fire a delete at a session that no longer exists. Pinned in
  `frontend/src/legal-safety.test.jsx`, `mobile/src/__tests__/safety.test.tsx`
  and `mobile/src/__tests__/settings.test.tsx`.
- These four run their request with plain `async`/`await` and `useState`, **not a
  React Query mutation**, so the `onlineManager` tripwire above doesn't reach
  them: an offline `fetch` rejects rather than pausing, and the gate lets go. Move
  one onto a mutation and it joins that list.

## Comments (threaded, connection-pruned)

Posts have a **threaded comment tree** — `Comment` model: `post`, `author`,
`parent` (self-FK, null = top-level), `text`, `created_at`, plus `edited_at` /
`deleted_at` (issue #128).

- `POST /api/posts/<id>/comments/` adds a comment/reply on a post you can see
  (`author` from the session, never the body; optional `parent`).
- `GET /api/posts/<id>/comments/` returns the **pruned, nested** visible tree.
- `PATCH`/`DELETE /api/comments/<pk>/` edit or delete **your own** comment —
  including the reply-preserving tombstone and the extra prune it adds to the tree
  builder. That story lives in
  [feed-and-posts.md](feed-and-posts.md#editing--deleting-your-own-comment).

### The connection boundary (the important bit)

**You only ever see comments/replies from people you're connected with.** A comment
from a not-connected author — *and its entire subtree* — is invisible to you.

- **Why prune the whole subtree, not re-parent:** a reply from someone you *are*
  connected with, sitting under a comment from someone you *aren't*, is hidden too.
  This stops strangers being surfaced to you second-hand, and keeps the tree
  readable (you never see a reply whose parent you can't see). The point of the
  whole feature is to stop people "meeting strangers" by reading a thread.
- **How it's done — a per-viewer subtree prune in Python, not SQL.** Expressing
  "hide this node *and everything under it* when its author isn't connected" in one
  SQL query is hard at arbitrary depth. Instead the endpoint loads a post's
  comments in one query, builds the parent→children map, and walks from the roots:
  at each node, if the author isn't connected-or-self, the node **and its subtree
  are skipped** (we don't recurse into it). Cheap at this app's scale, obviously
  correct, and the client receives an already-pruned tree — hidden content never
  leaves the server.
- The visible set is `connected_user_ids | {viewer}`. For **group** posts,
  membership gates *access* to the post but does **not** widen who you see within
  it — you still only see comments from members you're connected with (see
  [groups](groups.md)).
- **Consequence (intended):** two viewers can legitimately see different comment
  trees on the same post. That's the privacy-correct behaviour, not a bug — and the
  same rule governs [reactions](reactions.md), [notification gating](notifications.md)
  (you're never notified of a reply or reaction from someone you can't see), and
  [group events](events.md) (`visible_events` applies this exact gate keyed on the
  event's organiser — with the deliberate **inversion** that a poll/RSVP *count*
  includes people you can't see, while their *names* stay gated).

### Frontend

Collapsible comment thread (accordion) with an inline reply composer on each post.
Replies start **collapsed**, so a busy post opens as a clean list of top-level
comments each with a "Show N replies" control; opening a reply box (or having just
posted a reply) auto-reveals that sub-thread so your own reply is always visible.
