# Phase 3 — MVP Timeline

**Status:** not started

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

- [ ] `Post` model (author, text, created_at) via Django migration
- [ ] `Follow` relationship (follower → followee) via Django migration
- [ ] Endpoint to create a post (must be logged in)
- [ ] Endpoint to follow / unfollow a user
- [ ] Feed endpoint returns posts from followed users (+ self), ordered by
      `created_at` descending, with pagination
- [ ] Frontend feed page renders the real feed from the backend
- [ ] Frontend compose box creates real posts
- [ ] A way to find/follow another user (even a basic list or search)
- [ ] Automated tests covering: feed ordering, and that you only see posts from
      people you follow

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

(Record deviations/gotchas here.)
