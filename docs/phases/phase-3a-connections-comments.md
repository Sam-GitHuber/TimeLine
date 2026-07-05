# Phase 3a — Connections & comments

**Status:** done

A sub-phase of [Phase 3](phase-3-mvp-timeline.md), carved out so the core
timeline work stays "done" while we rework two things it got wrong for a
private, family-and-friends network:

1. **Following → connecting.** Phase 3's follow is *one-directional*: if A's
   request to B is approved, A sees B's posts but B does **not** see A's. That's
   a Twitter/broadcast mental model. This project is closer to a private address
   book, so a relationship should be **mutual**: approving a request connects
   both accounts and each sees the other. There is no such thing as a one-way
   follow any more. (Issue #11.)
2. **Threaded comments that respect the connection boundary.** Posts gain
   **comments** in a collapsible tree. But you only ever see comments/replies
   from people **you** are connected with — a comment from someone you aren't
   connected with (and its entire subtree) is invisible to you. The point is to
   stop people "meeting strangers" by reading a thread; it also keeps the reply
   tree legible (no half-conversations talking to invisible people). There is no
   public profile. (Issue #12.)

Terminology: the relationship is a **connection** (more personal than "link"),
the verb is **connect**, and the button states are **Connect / Requested /
Connected**.

## Goal

Rework the Phase 3 follow graph into a symmetric **connection**, and add a
**threaded comment tree** whose visibility obeys the same connection boundary as
the feed — all keyed off a single "who am I connected with" predicate so the
feed, profiles, and comments can't drift apart.

## Runnable product at the end of this phase

Two real accounts can:
- Send a **connection request**; when the other approves, **both** immediately
  see each other's posts (no separate "follow back").
- **Comment** on a post they can see, and **reply** to a comment, in a
  collapsible tree.
- See a comment tree that shows **only** comments/replies from people they're
  connected with — any branch rooted at a not-connected author is hidden
  entirely.

## Definition of done

### Connections (replaces following)

- [x] `Follow` model renamed to **`Connection`** (`requester` → `requestee`,
      `status` pending/accepted) via migration; DB guardrails kept (no duplicate
      in *either* direction, no self-connection)
- [x] Data migration **converts** existing follows to connections and dedupes
      any A→B + B→A pair into one symmetric row (keeps existing test data)
- [x] Visibility is **bidirectional**: one `connected_user_ids(user)` helper
      (accepted rows in either direction) feeds `visible_posts`; feed **and**
      profile posts both use it
- [x] Endpoints renamed to connect: `POST/DELETE /api/users/<id>/connect/`,
      `GET /api/connection-requests/`, `POST .../approve|reject/`
- [x] Requesting someone who already has a **pending request to you**
      auto-accepts it (mutual intent — no second row, no ping-pong)
- [x] Frontend: **Connect / Requested / Connected** (plus **Approve** for an
      incoming request) button; "Connection requests" inbox + nav badge;
      profile locked state reworded
- [x] Tests: approve connects **both** directions; no one-way leak; reverse
      request auto-accepts; can't act on others' requests

### Comments (new)

- [x] `Comment` model: `post`, `author`, `parent` (self FK, null = top-level),
      `text`, `created_at`, via migration; registered in the admin
- [x] `GET /api/posts/<id>/comments/` returns the **pruned, nested** visible
      tree — a comment from a not-connected author (and its whole subtree) is
      omitted before it ever reaches the client
- [x] `POST /api/posts/<id>/comments/` adds a comment/reply on a post you can
      see; `author` from the session (never the body); optional `parent`
- [x] Frontend: collapsible comment tree (accordion) + inline reply composer on
      each post
- [x] Tests: tree returns only connected-or-self authors; a **connected reply
      nested under a not-connected parent is pruned** (whole subtree hidden);
      you can't comment on a post you can't see

## Steps

1. Rename `Follow` → `Connection` (model, admin) and add the `Comment` model;
   write the migrations (rename + convert/dedupe; new comment table).
2. Swap the visibility helpers to the bidirectional `connected_user_ids`; update
   `visible_posts` and the status annotation.
3. Rename the follow views/URLs/serializers to connect; add the reverse-request
   auto-accept.
4. Add the comment list/create endpoints with the subtree-pruning tree builder.
5. Frontend: rename follow→connect surfaces; build the comment tree component.
6. Tests (backend + frontend); run the full suite; drive the flow in the app.

## Notes / decisions log

- **Why symmetric, and why one row.** A connection is stored as a *single*
  `Connection` row. While **pending** the direction still matters (requester
  asked requestee); once **accepted** the row is treated as symmetric and
  visibility checks both endpoints. One row = one source of truth, so there's no
  reciprocal row to drift out of sync. `connected_user_ids` collects the *other*
  party from every accepted row where you're either endpoint.
- **Reverse-request auto-accept.** If B sends a request to A while A already has
  a pending request to B, the two are clearly mutual — the second `POST` accepts
  the existing row instead of creating a competing one. Avoids two pending rows
  for the same pair (which the "no duplicate in either direction" constraint
  would reject anyway).
- **Comment visibility is a per-viewer subtree prune, done in Python.** Rather
  than try to express "hide this node *and everything under it* when its author
  isn't connected" in one SQL query (hard at arbitrary depth), the endpoint
  loads a post's comments in one query, builds the parent→children map, then
  walks from the roots: at each node, if the author isn't connected-or-self, the
  node **and its subtree are skipped** (we don't recurse into it). Cheap at this
  app's scale and obviously correct. The client receives an already-pruned tree,
  so hidden content never leaves the server.
- **Why prune the whole subtree, not re-parent.** A reply from someone you *are*
  connected with, sitting under a comment from someone you *aren't*, is hidden
  too. That's deliberate: it stops strangers being surfaced to you second-hand,
  and keeps the tree readable (you never see a reply whose parent you can't see).
- **Migration converts rather than wipes.** We're pre-launch (productionisation
  is Phase 7), so existing rows are test data — the migration keeps them.
  Converting a one-way accepted follow to a symmetric connection retroactively
  lets the other side see posts too; that widening is acceptable for test data
  and is the correct end state anyway.
- **The one-row-per-pair constraint is a functional unique index.**
  `UniqueConstraint(Least("requester_id","requestee_id"),
  Greatest(...))` — a unique index on the *ordered* pair of ids, so A↔B and B↔A
  can't both exist regardless of who requested whom. Postgres-only feature; the
  project already runs Postgres in dev, test, and prod.
- **Incoming request adds a fourth button state.** `connection_status` is
  annotated as none / requested (you asked) / **incoming** (they asked you) /
  connected. The Connect button shows "Approve" for `incoming` and calls the
  same `POST /connect/`, which accepts their pending request — so you can accept
  from someone's profile, not only the Requests inbox.
- **Replies collapse by default (post-design-system refinement).** After the
  site-wide design system landed (see `docs/design-system.md`), the comment tree
  was tuned for readability: replies now start **collapsed**, so a busy post
  opens as a clean list of top-level comments, each with a clear "Show N replies"
  control (accent-coloured + chevron, visually distinct from "Reply"). Opening a
  reply box — or having just posted a reply — auto-reveals that sub-thread so
  your own reply is always visible. Frontend-only; aimed at making long threads
  followable for less technical users. Guarded by a test.
- **Verification.** `makemigrations --check` clean; migration `0004` applied to
  the real dev DB without data loss. 39 backend + 43 frontend tests pass
  (added: bidirectional visibility, disconnect clears both feeds, reverse-request
  auto-accept, all four connection states, the comment-tree subtree prune, and
  the comment endpoints). A live HTTP E2E (real login + CSRF) confirmed
  request→auto-accept, bidirectional feed, a comment+reply tree, and that the
  new endpoints enforce CSRF. Frontend production build is clean.
