# Phase 1 — Wireframe Web App

**Status:** done

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

- [x] Feed page renders a list of mock posts in reverse-chronological order
- [x] Each post shows author, timestamp, and text
- [x] Compose box exists and visibly adds a post to the on-screen list
- [x] A profile page exists showing a fake user + their posts
- [x] Navigation between feed and profile works
- [x] Runs locally with one documented command (via Docker or `npm run dev`)
- [x] Mock data lives in one obvious file so it's easy to see the "shape" of a
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

- **Router:** added `react-router-dom` (v6). The stack table in `SHARED.md`
  didn't name a router; chose the boring standard for React SPAs so we get real
  URLs (`/`, `/u/:username`), working back button, and shareable links — and
  it's the same router later phases will lean on. Recorded in `SHARED.md`.
- **Shared post state lives in `Layout`**, handed to pages via react-router's
  `<Outlet context>` (rather than React Context or prop-drilling). This is why a
  post added from the compose box shows up both in the feed *and* on the
  author's profile — both pages read the same state.
- **Mock data shape (`src/mockData.js`) is the future backend contract:**
  `user { id, username, displayName, bio, joinedAt }` and
  `post { id, authorId, createdAt, text }`. Posts reference the author by
  `authorId` (foreign-key style) rather than embedding the author, mirroring how
  it'll be stored. `currentUserId` stands in for the logged-in user until auth
  (Phase 2).
- **Reverse-chronological is enforced in two places:** the feed sorts a copy by
  `createdAt` descending, and new posts are prepended. A regression test asserts
  timestamps are non-increasing down the list, so ranking can't sneak in.
- **Tests:** added Vitest + React Testing Library (frontend test tooling per the
  "tests every phase" rule). `npm test` runs 11 tests covering feed ordering,
  compose-adds-a-post, empty-post guard, profile filtering, unknown-user
  handling, and feed→profile navigation. CI is still the placeholder for now —
  the frontend suite is ready to wire into `.github/workflows/main.yml` when we
  turn CI real.
- **Styling:** minimal Tailwind, deliberately plain (a light Twitter-ish single
  column). Avatars are coloured initials — real photos are Phase 4.
- **Gotcha:** left the Phase 0 `App.jsx` backend smoke-test screen behind; it's
  now the router (`Routes`). `main.jsx` wraps the app in `BrowserRouter`.
