# Phase 1 — Wireframe Web App

**Status:** not started

## Goal

Build a clickable, locally-runnable wireframe of the TimeLine web UI, using
**mock/fake data** hard-coded in the frontend. No real backend involvement, no
database, no login yet. The point is to see and feel the product early, and to
make it obvious what data the backend will later need to provide.

See `docs/SHARED.md` for the stack and principles (especially: the feed is
strictly reverse-chronological — no ranking).

## Runnable product at the end of this phase

Run the frontend locally and click through a wireframe with:
- A **timeline/feed page** showing a list of fake posts, newest first.
- A **compose box** (doesn't have to save anything yet — can just add to the
  local list on screen).
- A **profile page** for a fake user.
- Basic navigation between these pages.

It should look like a real (if plain) app, not a polished product — layout and
flow over visual polish.

## Definition of done

- [ ] Feed page renders a list of mock posts in reverse-chronological order
- [ ] Each post shows author, timestamp, and text
- [ ] Compose box exists and visibly adds a post to the on-screen list
- [ ] A profile page exists showing a fake user + their posts
- [ ] Navigation between feed and profile works
- [ ] Runs locally with one documented command (via Docker or `npm run dev`)
- [ ] Mock data lives in one obvious file so it's easy to see the "shape" of a
      post/user (this becomes the contract the backend fulfils later)

## Steps

1. Flesh out the `/frontend` React app with a simple router (feed / profile).
2. Define mock data: a list of users and posts in one file (e.g.
   `frontend/src/mockData.js`), with fields we expect real ones to have
   (id, author, timestamp, text).
3. Build the feed component: sort by timestamp descending, render each post.
4. Build the compose box: on submit, prepend a new post to local state.
5. Build a profile page.
6. Keep styling minimal but usable — this is a wireframe, not the final look.

## Notes / decisions log

(Record deviations/gotchas here.)
