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

## Comments (threaded, connection-pruned)

Posts have a **threaded comment tree** — `Comment` model: `post`, `author`,
`parent` (self-FK, null = top-level), `text`, `created_at`.

- `POST /api/posts/<id>/comments/` adds a comment/reply on a post you can see
  (`author` from the session, never the body; optional `parent`).
- `GET /api/posts/<id>/comments/` returns the **pruned, nested** visible tree.

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
  same rule governs [reactions](reactions.md).

### Frontend

Collapsible comment thread (accordion) with an inline reply composer on each post.
Replies start **collapsed**, so a busy post opens as a clean list of top-level
comments each with a "Show N replies" control; opening a reply box (or having just
posted a reply) auto-reveals that sub-thread so your own reply is always visible.
