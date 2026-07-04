# Phase 4 — Photos & Profiles

**Status:** not started

## Goal

Make the app feel real to use: let posts include **photos**, and give each user
a **profile page** (their info + their posts). This is the first phase dealing
with file uploads and storage, which has real cost and privacy implications.

## Runnable product at the end of this phase

- Create a post with one or more photos and see them render in the feed.
- Visit any user's profile page and see their details + their posts.
- Edit your own basic profile (name, bio, avatar).

## Definition of done

- [ ] Posts can include image attachments
- [ ] Images are stored somewhere sensible (decide: local volume for now vs.
      object storage; note the plan for production in Phase 5)
- [ ] Uploads are validated (file type, size limits) and served safely
- [ ] Profile page shows the person's name (first + last), avatar, bio, and
      their posts
- [ ] Users can edit their own name, avatar, and bio
- [ ] Reasonable image handling (e.g. resizing/thumbnails) so the app stays fast

## Steps

1. Decide image storage approach and document it (Django's default file storage
   to a local Docker volume is fine for dev; production likely S3-compatible
   object storage via `django-storages` — coordinate with Phase 5).
2. Add image upload endpoint(s) with validation (type/size).
3. Extend the `Post` model / add an attachments table for images.
4. Add profile fields to the `User` model (**bio, avatar**) via migration. There
   is **no** separate display-name field — the display name is `first_name` +
   `last_name`, which already exist on the model (Phase 2). The edit UI just
   needs to write those two, plus bio + avatar.
5. Build profile page + profile edit UI on the frontend.
6. Render images in the feed and on profiles; add thumbnailing if needed.

## Privacy / cost notes

- Photos of real friends/family are sensitive — keep storage private by default,
  not publicly listable.
- Storage and bandwidth are the first real ongoing costs; note expected impact
  so it feeds into the Phase 5 hosting decision and the eventual funding ask.

## Notes / decisions log

- **Identity model (confirmed with the user, 2026-07-04): no username, ever.**
  Login is by email; a person's display name **is** their real first + last
  name (no separate "display name" field, no handle). Rationale: this app is for
  connecting with friends and family, so forcing a made-up username adds
  friction for no benefit. `first_name`/`last_name` already exist on the Phase 2
  `User`, so this phase only adds bio + avatar and the edit UI over them.
- **Open: the public profile-URL identifier.** With no username, `/u/:username`
  can't stand. Names aren't unique, so the boring, robust default is the numeric
  id (e.g. `/u/42`); an optional unique slug could be added later if we want
  prettier URLs. Decide this when wiring real profile pages (late Phase 3 /
  Phase 4). It will **not** be a username.
