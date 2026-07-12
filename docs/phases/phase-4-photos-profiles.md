# Phase 4 — Photos & Profiles

**Status:** done

## Goal

Make the app feel real to use: let posts include **photos**, and give each user
a **profile page** (their info + their posts). This is the first phase dealing
with file uploads and storage, which has real cost and privacy implications.

## Runnable product at the end of this phase

- Create a post with one or more photos and see them render in the feed.
- Visit any user's profile page and see their details + their posts.
- Edit your own basic profile (name, bio, avatar).

## Definition of done

- [x] Posts can include image attachments (`PostImage` table — many per post)
- [x] Images are stored via **`django-storages`** so the backend can be swapped
      by config: a **local disk volume** now (and through the home-server beta,
      Phase 7), switching to an **S3 bucket** at the AWS migration (Phase 11)
      without a code change (`STORAGES` seam keyed on `DJANGO_MEDIA_STORAGE`)
- [x] Uploads are validated (file type, size limits) and served safely
      (decode-with-Pillow, SVG rejected, size/count caps, EXIF stripped)
- [x] Profile page shows the person's name (first + last), avatar, bio, and
      their posts
- [x] Users can edit their own name, avatar, and bio (`/settings`)
- [x] Reasonable image handling (resizing + thumbnails) so the app stays fast

## Steps

1. Set up image storage through **`django-storages`** pointed at a local Docker
   volume for now. Using the `django-storages` abstraction from the start is
   deliberate: media stays on local disk through the home-server beta (Phase 7)
   and becomes an S3 bucket at the AWS migration (Phase 11) as a **config change,
   not a rewrite**. Keep storage **private** (not publicly listable).
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
- Storage and bandwidth are the first real ongoing costs (near-zero on the home
  server, but real once photos live in an S3 bucket on AWS); note expected impact
  so it feeds into the Phase 11 cost estimate and the eventual funding ask.

## Notes / decisions log

- **Identity model (confirmed with the user, 2026-07-04): no username, ever.**
  Login is by email; a person's display name **is** their real first + last
  name (no separate "display name" field, no handle). Rationale: this app is for
  connecting with friends and family, so forcing a made-up username adds
  friction for no benefit. `first_name`/`last_name` already exist on the Phase 2
  `User`, so this phase only adds bio + avatar and the edit UI over them.
- **Name-based profile slugs deferred (decided 2026-07-06).** Profile URLs stay
  numeric (`/u/<id>`) for this phase. Slugs are real extra surface (unique field,
  auto-generation, collision handling, reserved-word validation, edit UI,
  migration) that isn't needed to ship photos + profiles, so they move to a small
  standalone follow-up rather than bloating this phase. The original slug design
  is kept below for when we pick it up.
- **Profile URL = a name-based slug, not a username (confirmed 2026-07-04) —
  DEFERRED, see above.**
  The public profile lives at `/u/<slug>`, where the slug is auto-generated from
  the person's name (`sam-jefford`, then `sam-jefford-2` on collision). Users can
  **optionally customise** it (`/u/sam`). Crucially this is a *URL handle only* —
  it's never displayed as the name (that's always first + last) and never used
  to log in (always email). Implementation notes / things that will bite:
  - It's a **unique, indexed `slug` field on `User`**, not a login credential.
  - **Names aren't known at sign-up** (we only collect email + password), so
    there's no name to slugify at creation. Generate the slug when the user
    first sets their name (this phase's profile step), with an email-local-part
    or id-based fallback until then. → see the related open point below.
  - If the slug is editable, **changing it breaks old links** (link rot). For a
    small family app that's acceptable; just don't promise permanence.
  - **Reserve/validate custom slugs**: reject ones that collide with real routes
    (`login`, `signup`, `admin`, `settings`, …), enforce a charset
    (lowercase/digits/hyphen), and keep it tasteful (trusted user base, so
    light-touch).
- **Related open point — do we collect the name at sign-up?** Today's Phase 2
  sign-up asks only for email + password, so a freshly-approved user has *no*
  display name and no natural slug until they fill in a profile. Options: (a) add
  first/last name to the sign-up form, or (b) force a "complete your profile"
  step on first login. Decide at the start of this phase; it's the cleanest point
  to add it. (Leaning (a) — a real name is the whole identity here.)
  **Resolved 2026-07-06: option (a).** First + last name are now required on the
  sign-up form (`CustomRegisterSerializer` + `SignupPage`), so every approved
  account has a real display name from day one — no email-local-part fallback in
  practice.

## Implementation decisions (2026-07-06)

- **Photos: multiple per post.** A `PostImage` table (FK to `Post`) rather than a
  single field, matching "one or more photos". Uploaded as multipart to
  `POST /api/posts/` (`images` repeated); the feed/profile serializers embed each
  image as `{id, image, thumbnail, width, height}` with absolute URLs.
- **All image handling funnels through `api/imaging.py`** (`process_image`) — the
  single place the safety rules live, used for both post photos and avatars:
  - **Validate by decoding, not by extension/Content-Type.** A file is accepted
    only if Pillow opens it *and* its format is in a raster allow-list (JPEG/PNG/
    WebP/GIF). **SVG is rejected** (script vector → stored XSS).
  - **EXIF (incl. GPS) is stripped** by re-encoding from raw pixels, after
    applying the orientation tag so photos aren't stored sideways. Phone photos
    leak home location otherwise — a real privacy win, covered by a test.
  - **Bounded:** ≤10 MB/file, ≤10 photos/post; originals downscaled (long edge
    2048), thumbnails generated (512 post / 128 square avatar). Synchronous —
    fine at family scale; move to Celery if volume grows (see SHARED.md).
- **Unguessable filenames.** `upload_to` uses a UUID, so a raw media URL can't be
  found by walking ids. In dev, Django serves `/media/` openly (DEBUG-only) — an
  acceptable convenience, **not** real access control. Real private media
  (S3 `private` ACL + signed URLs) lands at Phase 11; the `STORAGES` config seam
  and the `default_acl: private` / `querystring_auth` options are already staged.
- **Profile editing rides dj-rest-auth's existing `PATCH /api/auth/user/`** (no
  new endpoint): `UserDetailsSerializer` now writes first/last name + bio and
  accepts an `avatar` upload (processed like a post photo), with `remove_avatar`
  to clear it. The frontend `/settings` page PATCHes multipart, then refetches
  "who am I" so the new name/avatar propagate everywhere immediately.
- **Avatars** surface as a small square `avatar_thumb` on post/comment authors,
  the people list, and the profile header; `Avatar.jsx` renders the photo when
  present and falls back to the coloured initial otherwise.
- **Tests:** backend covers multi-photo upload, photo-only posts, bad-file/SVG/
  over-count rejection, EXIF-strip, feed rendering, avatar upload+clear, and
  name-at-sign-up (temp `MEDIA_ROOT`, Pillow-generated images). Frontend covers
  the Avatar branch, the PostCard gallery, ComposeBox photo add/remove/submit,
  and the profile-edit form.
