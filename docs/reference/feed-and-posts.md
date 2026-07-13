# Feed, posts, photos & profiles

The core of the product: posting text + photos, the reverse-chronological feed,
profile pages, and the image-handling pipeline. Visibility (who can see whose
posts) is owned by [connections](connections.md); group posts are covered in
[groups](groups.md). This doc is the current-state reference.

Code: `Post` / `PostImage` models + feed/profile views in `backend/api/`,
image pipeline in `backend/api/imaging.py`, profile edit rides dj-rest-auth
(`backend/accounts/serializers.py`). Frontend: `PostCard`, `ComposeBox`,
`Avatar`, the feed page, and `/settings`.

## The feed — reverse-chronological, always

No ranking, no "suggested" posts, no algorithm — ever. This is a non-negotiable
product principle, enforced server-side so it can't drift:

- `GET /api/feed/` returns your own posts plus posts from everyone you're
  connected with (see [connections](connections.md)), ordered `created_at`
  descending, paginated.
- **Ordering is enforced in the DB**, not the client: `Post.Meta.ordering =
  ["-created_at", "-id"]`. The `-id` tiebreaker matters — posts sharing a
  timestamp have no stable order otherwise, which made pagination duplicate/skip
  rows on Postgres. `created_at` is indexed.
- The home feed **excludes group posts by default** (`group__isnull=True`) so its
  meaning stays "the people I'm connected with". An opt-in `?include_groups=1`
  toggle merges group posts in strictly chronologically — a pure time-merge, no
  ranking. See [groups](groups.md).

### Pagination

DRF `PageNumberPagination`, `PAGE_SIZE = 20`, applied app-wide. **Consequence to
remember:** turning this on paginates *every* list endpoint (people, requests,
etc.), so every list consumer must page through results, not read only
`data.results`. The frontend does this via a shared `useInfiniteList(queryKey,
firstPageFn)` hook + `<LoadMoreButton>` that follows the response's `next` URL
(`api.getPage`, which parses the URL and keeps only path+query so it works behind
a proxy / on a separate API domain). Nav badges read the paginator's `count`, not
`results.length`.

## Posts

- **`Post`** — `author`, `text`, `created_at`, nullable `group` FK (null = a
  personal post; see [groups](groups.md)). Lives in the `api` app.
- **Author is never trusted from the client** — `POST /api/posts/` ignores any
  `author` in the body and sets it from `request.user`.
- **`visible_posts(user, author=None)`** is the single "who can I see" helper used
  by both the feed and profile views so they can't drift; it filters
  `author__is_active` (a deactivated/banned member's posts drop out everywhere).
- Posts are created via multipart `POST /api/posts/` (text and/or photos).
- **TanStack Query** drives the frontend; mutations invalidate `["feed"]` /
  `["users"]` / `["user", id]` so posting or connecting refreshes the affected
  views immediately.

### Permalink — a single post by id

- **`GET /api/posts/<id>/`** (`PostDetailView`) returns one post, gated by the
  same `can_view_post` wall as the feed (a post you can't see 404s — existence
  isn't leaked). It backs the **`/p/:id` permalink page** (`PostPage`), which
  renders the post with its comment thread opened.
- **Why fetch by id rather than reuse a feed row:** notifications
  ([notifications.md](notifications.md)) deep-link here, and the target post may
  be nowhere near the first page of any feed — fetching it directly is the only
  reliable way to open an old thread. `?comment=<id>` on the page scrolls to and
  highlights a specific comment (auto-expanding its collapsed ancestors), so
  "someone replied" lands you on the exact reply, even one deep in the tree.

## Photos

- **`PostImage`** table (FK to `Post`) — **many photos per post**, not a single
  field. Uploaded as repeated `images` in the multipart `POST /api/posts/`. Feed
  and profile serializers embed each as `{id, image, thumbnail, width, height}`
  with absolute URLs.
- A post can be **photo-only** (no text).
- **Avatars** surface as a small square `avatar_thumb` on post/comment authors,
  the people list, and profile headers; `Avatar.jsx` renders the photo when
  present, else a coloured initial.

### The imaging pipeline (`api/imaging.py`)

All image handling — post photos *and* avatars — funnels through
`process_image`, the single place the safety rules live:

- **Validate by decoding, not by extension/Content-Type.** A file is accepted
  only if Pillow opens it *and* its format is in a raster allow-list
  (JPEG/PNG/WebP/GIF). **SVG is rejected** — a script-bearing vector would be
  stored XSS.
- **EXIF (including GPS) is stripped** by re-encoding from raw pixels, after
  applying the orientation tag so photos aren't stored sideways. Phone photos leak
  home location otherwise — a real privacy win, covered by a test.
- **Bounded:** ≤30 MB per input file, ≤10 photos per post; originals downscaled
  (long edge 2048), thumbnails generated (512 post / 128 square avatar).
  Processing is **synchronous** — fine at family scale; move to Celery if volume
  grows.
- **Why 30 MB and not a tighter cap:** `MAX_UPLOAD_BYTES` is a **DoS/memory
  guard** (stop a client streaming an unbounded file into Pillow), *not* a storage
  limit — every accepted photo is already downscaled + re-encoded at JPEG q85, so
  the *stored* file is well under 1 MB regardless of input size. Modern phone
  photos routinely exceed 10 MB, so the input ceiling is phone-realistic and
  compression handles actual storage/bandwidth. (Note: no other layer blocks large
  uploads — Caddy sets no request-body limit, and Django streams file uploads to a
  temp file, bypassing `DATA_UPLOAD_MAX_MEMORY_SIZE`.) HEIC transcode is a separate
  future item (needs `pillow-heif`/`libheif`).

## Profiles

- A profile page (`/u/:id`) shows the person's name, avatar, bio, and their posts
  (gated by connection — see [connections](connections.md); a non-connection sees
  a locked state, and a `getUser` 404 shows "not found" while other errors show a
  retryable state so a transient blip doesn't claim the account doesn't exist).
- **Profile editing rides dj-rest-auth's existing `PATCH /api/auth/user/`** (no
  new endpoint). `UserDetailsSerializer` writes first/last name + bio and accepts
  an `avatar` upload (processed like a post photo), with `remove_avatar` to clear
  it. The `/settings` page PATCHes multipart, then refetches "who am I" so the new
  name/avatar propagate everywhere immediately.

### Avatar reframing (client-side crop)

Avatars are shown as circles (`Avatar.jsx` masks the square `avatar_thumb` with
`rounded-full`), so how the square is cut matters. Rather than letting the
backend blindly centre-crop, choosing an avatar first opens **`AvatarCropModal`**
(built on `react-easy-crop`): drag to reposition, zoom with a slider / mouse
wheel / two-finger pinch, inside a **round** cutout that dims everything outside
it — a live preview of the circle people will actually see (issue #18). On
confirm, the browser draws the chosen square to a canvas and uploads *just that
square* (`cropImage.js`), capped at 1024px and re-encoded as JPEG.

- **Why client-side, not "upload original + crop coords":** no new endpoint, DB
  field, or migration — the smaller, boring option for a family-scale app. The
  trade-off is we don't keep the uncropped original for later re-cropping.
- **The server pipeline is unchanged and still authoritative.** The cropped file
  goes through the same `process_image` (validate-by-decode, EXIF strip,
  size/format caps). The crop is *framing only*; `thumb_square` centre-crop still
  runs but is a no-op on an already-square upload.
- **Shared by user and group avatars** — the same modal wires into both
  `ProfileEditPage` and `GroupFormPage`, since both render the same circle.

## Storage & media serving

- Media goes through **`django-storages`** so the backend is swappable **by
  config**, not a rewrite: **local disk** now (and through the home-server beta),
  becoming an **S3 bucket** at the AWS migration (Phase 11) via the `STORAGES` seam
  keyed on `DJANGO_MEDIA_STORAGE`. Keep storage **private** (not publicly
  listable).
- **Filenames are unguessable UUIDs** (`upload_to`), so a raw media URL can't be
  found by walking ids.
- **Media is auth-gated in production.** Caddy `forward_auth`s every `/media/*`
  request to `GET /api/media-auth/`, which returns 204 only for a logged-in
  **active** member (SimpleJWT already rejects a deactivated user's token, so a
  banned member's saved URLs stop resolving); an unauthenticated request gets 401.
  A leaked URL is useless to a logged-out stranger. In *dev*, Django serves
  `/media/` openly (DEBUG-only convenience, **not** access control). See
  [deploy.md](../deploy.md) for the Caddy side. **Deferred to Phase 11:** full
  *per-author connection* gating of media (a logged-in member could still fetch a
  photo whose UUID they hold) — accepted for a small closed beta, with the UUID as
  a second layer; real private/signed S3 media lands with the AWS migration.
