# Phase 3 — MVP Timeline

**Status:** done

> **Followed by [Phase 3a — Connections & comments](phase-3a-connections-comments.md):**
> the one-directional *follow* built here is being reworked into a symmetric
> *connection*, and posts are gaining a connection-scoped threaded comment tree
> (issues #11 and #12). Where this doc says "follow", read the current model in
> the 3a doc.

## Goal

The core of the whole product: real users can **post text**, **follow** other
users, and see a **reverse-chronological feed** of posts from the people they
follow. This is the smallest thing that proves TimeLine's core idea end to end,
now backed by a real database instead of Phase 1's mock data.

Reverse-chronological, always. No ranking, no "suggested" posts, no algorithm
(see `docs/SHARED.md`).

## Runnable product at the end of this phase

Two real accounts can:
- Follow / unfollow each other.
- Write a text post.
- See a feed containing their own posts + posts from everyone they follow,
  strictly newest first.

## Definition of done

- [x] `Post` model (author, text, created_at) via Django migration
- [x] `Follow` relationship (follower → followee) via Django migration
- [x] Endpoint to create a post (must be logged in)
- [x] Endpoint to follow / unfollow a user
- [x] Feed endpoint returns posts from followed users (+ self), ordered by
      `created_at` descending, with pagination
- [x] Frontend feed page renders the real feed from the backend
- [x] Frontend compose box creates real posts
- [x] A way to find/follow another user (even a basic list or search)
- [x] Automated tests covering: feed ordering, and that you only see posts from
      people you follow

### Follow requests & approval (private-by-default)

- [x] A follow is a **request** (`Follow.status = pending`) that only takes
      effect once the requestee **approves** it (`accepted`)
- [x] Endpoints: list incoming requests, approve, reject; follow-request is the
      `POST` on the follow endpoint, cancel/unfollow is the `DELETE`
- [x] Feed and **profile posts** are both gated on an accepted follow (you only
      see a user's posts if it's you or an accepted follower)
- [x] Frontend: Follow button reflects none/pending/accepted; a Requests inbox
      (with a nav badge) to approve/reject; profile shows a private/locked state
- [x] Tests covering: request stays hidden until approved, approve reveals
      posts, reject/cancel, profile gating, and can't act on others' requests

## Steps

1. Add `Post` and `Follow` models + migrations; register them in the Django
   admin so posts can be moderated/deleted from there.
2. Build post-create and feed endpoints; enforce "logged in" and correct
   ordering + pagination.
3. Build follow/unfollow endpoints.
4. Replace Phase 1's mock data in the frontend with real API calls.
5. Add a minimal "find people to follow" UI.
6. Write tests for ordering and follow-scoping (the two things most likely to
   silently break the core promise).

## Notes / decisions log

- **Where the models live.** `Post` and `Follow` went into the existing `api`
  app rather than a new app — it already had `models.py`/`views.py`/`urls.py`/
  `admin.py`/`tests.py` wired in, so this kept the change small. If posts grow
  their own concerns (comments, likes-that-aren't-ranking, etc.) a dedicated
  app can be split out later.
- **No username → profile URLs use the numeric user id.** There is no username
  in this project (email login). Phase 1's `/u/:username` routes became
  `/u/:id`, and post/author payloads carry `{ id, display_name }`.
- **`display_name` and the privacy fallback.** Registration only collects
  email + password, so `first_name`/`last_name` are blank until the Phase 4
  profile UI. `User.display_name` (a property, the single source of truth used
  by every serializer) is `"First Last"` when set, else the **email local-part**
  (before the `@`) — never the full address, so members don't see each other's
  emails in the feed or people list. The maintainer sets real names in the
  Django admin when approving a sign-up.
- **Author is never trusted from the client.** `POST /api/posts/` ignores any
  `author` in the body and sets it from `request.user`; a test asserts you
  can't post as someone else.
- **Guardrails in the database, not just the API.** `Follow` has a
  `UniqueConstraint` (no double-follow) and a `CheckConstraint` (no self-follow)
  so bad data can't arrive by another path. The follow endpoint is idempotent
  (`get_or_create` / delete-if-present).
- **Feed ordering is enforced server-side.** `Post.Meta.ordering` +
  `created_at` (indexed) mean the API always returns newest-first; the frontend
  renders in the order received. The old client-side `sortByNewest` helper was
  removed as dead code.
- **Pagination.** DRF `PageNumberPagination`, `PAGE_SIZE = 20`. Every list view
  pages through a shared `useInfiniteList` hook + `<LoadMoreButton>` that follows
  the response's `next` URL (via `api.getPage`) — see the code-review-fixes note
  below for why this is shared rather than per-page.
- **TanStack Query added** (per `docs/SHARED.md`, the point earmarked for it):
  `QueryClientProvider` in `main.jsx`; mutations invalidate `["feed"]` /
  `["users"]` / `["user", id]` so following someone or posting refreshes the
  affected views immediately.
- **Verification.** 39 backend + 35 frontend tests pass; a live HTTP E2E
  (real login cookies + CSRF) confirmed follow-scoping and newest-first
  ordering, and that self-follow is 400 and unfollow drops a user's posts.

### Follow requests & approval (added after the initial Phase 3 build)

- **Private-by-default, always.** The maintainer asked that a follow be a request
  the other person approves, not an instant follow. Chosen model: **every** follow
  requires approval — no per-account public/private toggle (keeps one behaviour;
  matches the privacy-first mission). A toggle can be added later if wanted.
- **`status` on `Follow`, not a separate table.** `Follow` gained a
  `status` (`pending` | `accepted`, `TextChoices`) — one row per (follower,
  followee), status transitions on approve. Simpler than a separate
  `FollowRequest` table. Migration `0002` backfills existing rows to `accepted`
  (they predate the feature and were real instant-follows).
- **Profile posts are gated too, not just the feed.** If only the feed respected
  approval, anyone could still read all your posts at `/u/:id`. `UserPostsView`
  returns posts only to yourself or an accepted follower; the profile page shows
  a "posts are private" locked state otherwise. Private-by-default is enforced on
  both surfaces.
- **`is_following` (bool) → `follow_status` (none/pending/accepted).** Annotated
  via a `Subquery` on the requester's follow row; drives the three-state Follow
  button (Follow / Requested / Following).
- **Endpoints.** `POST /api/users/<id>/follow/` sends a pending request;
  `DELETE` cancels a request or unfollows. `GET /api/follow-requests/` is your
  inbox; `POST /api/follow-requests/<id>/approve|reject/` — guarded so only the
  requestee can act (else 404, so requests to others aren't revealed).
- **Frontend.** New Requests page + nav badge (pending count, shares the
  `["followRequests"]` query cache). Live E2E confirmed: request stays hidden
  until approved, approval reveals feed + profile posts, non-followers see a
  private profile, cross-user approve is 404, unfollow revokes.

### Code-review fixes (after the request/approval build)

A high-effort review of the Phase 3 branch surfaced a cluster of issues, all now
fixed with tests:

- **The global pagination we added silently truncated the un-paginated lists.**
  Turning on `PageNumberPagination` app-wide meant `/api/users/` and
  `/api/follow-requests/` also paginate, but the People page, the Requests inbox,
  and the nav badge each read only the first page (`data.results`). Past 20
  members/requests, people became unfollowable and requests un-approvable, and
  the badge capped at 20. Fixed by making all list consumers page: a shared
  `useInfiniteList(queryKey, firstPageFn)` hook + `<LoadMoreButton>` (in
  `hooks.js` / `components/`), now used by the feed, profile, People, and
  Requests. The badge uses the paginator's `count`, not `results.length`. The
  Requests list uses the `["followRequests", "list"]` child key so invalidating
  `["followRequests"]` still refreshes both it and the badge.
- **The feed leaked deactivated members' posts.** `is_active` was gated on the
  profile/people endpoints but not the feed, so a deactivated (banned) member's
  posts kept showing in existing followers' feeds. The "who can I see" rule now
  lives in one `visible_posts(user, author=None)` helper used by both `FeedView`
  and `UserPostsView` (so they can't drift), and it filters `author__is_active`.
- **Feed pagination could duplicate/skip posts.** `Post.Meta.ordering` was
  `["-created_at"]` with no unique tiebreaker; posts sharing a timestamp have no
  stable order across page queries on Postgres. Now `["-created_at", "-id"]`
  (migration `0003`).
- **`getPage` broke behind a proxy / on a separate API domain.** It stripped
  `BASE_URL` from DRF's absolute `next` URL by string replace, which no-ops when
  the origins differ. Now it parses the URL and keeps only path+query, rebasing
  onto `BASE_URL`.
- **Profile "User not found" hid transient errors.** Any `getUser` failure
  rendered the 404 state; a 5xx/network blip told the user a real account didn't
  exist. Now only `status === 404` shows not-found; other errors show a
  retryable state.
- **Verification.** 41 backend + 39 frontend tests pass (added: deactivated-author
  feed exclusion, same-timestamp pagination stability, cross-origin `getPage`,
  People/Requests "Load more", compose-shows-post, 404-vs-transient, and a
  restored strict reverse-chronological DOM assertion).
