# Feed, posts, photos & profiles

The core of the product: posting text + photos, the reverse-chronological feed,
profile pages, and the image-handling pipeline. Visibility (who can see whose
posts) is owned by [connections](connections.md); group posts are covered in
[groups](groups.md). This doc is the current-state reference.

Code: `Post` / `PostImage` models + feed/profile views in `backend/api/`,
image pipeline in `backend/api/imaging.py`, profile edit rides dj-rest-auth
(`backend/accounts/serializers.py`). Frontend: `PostCard`, `ComposeBox`,
`Avatar`, the feed page, and `ProfileEditForm` (inline on the profile page).

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

### Editing & deleting your own posts

The **`⋯` overflow menu** on a post's header (`PostMenu.jsx`, rendered by
`PostCard`) is where per-post actions live. What it offers keys off the same
owner check `ReportButton` uses (`user.pk === author.id`):

- **Your own post:** **Edit** (flips the text into an inline editor — `PostEditor`
  in `PostCard.jsx`, no separate page) and **Delete** (confirms first, since a
  post can carry comments/reactions/photos).
- **Someone else's post:** **Report** — the report control **moved off the footer
  row into this menu**. (Comments still carry an inline `ReportButton`; only posts
  moved.)

Both edit and delete share the permalink route — `PostDetailView` is a
`RetrieveUpdateDestroyAPIView`:

- **`PATCH /api/posts/<id>/`** — **owner-only**, updates **text only** (v1 scope:
  adding/removing photos is deliberately out). It stamps `edited_at` and rejects
  emptying a text-only post (a post must still have text or a photo, mirroring
  create). `PUT` is disallowed (405) — text is the only writable field.
- **`DELETE /api/posts/<id>/`** — **owner-only**, 204 on success. The model's
  CASCADE relations take the post's images, comments (and replies), reactions,
  reports and notifications with it. *(As with group deletion, the DB rows
  cascade but the image **files** on disk aren't swept — deferred with the S3
  media work in Phase 11.)*
- **Permission shape mirrors `GroupDetailView`:** a post you can't see is a
  **404** (existence stays hidden); a post you can see but don't own is a **403**.
  The **author path bypasses the visibility gate** — you can always edit/delete
  your own post, including a group post you've since left the group of (your
  content stays yours to remove). A no-op edit (text unchanged) is a 200 that
  does **not** stamp `edited_at`, so the marker only ever means a real change.

**The edited marker is the transparency floor.** `Post.edited_at` is **null until
the first edit** — that's how "created but never edited" is told apart (no
`updated_at`/timestamp-comparison guesswork). The serializer exposes it read-only;
`PostCard` shows a quiet **"· edited"** next to the author line **only** when it's
set, with the exact edit time on hover/focus (`title`/`aria-label`, the same
pattern `created_at` uses). Silently altering content others have already read is
a trust problem on an app holding real friends'/family's conversations, so the
marker isn't optional.

**No edit window and no version history** (v1) — this is a private friends/family
app, not a public record; the "edited + when" marker is the agreed transparency
floor. On the client, an edit/delete invalidates `["feed"]`, `["userPosts"]`,
`["groupPosts"]` and `["post", id]` so the change shows wherever the post appears.
- **Why fetch by id rather than reuse a feed row:** notifications
  ([notifications.md](notifications.md)) deep-link here, and the target post may
  be nowhere near the first page of any feed — fetching it directly is the only
  reliable way to open an old thread. `?comment=<id>` on the page scrolls to and
  highlights a specific comment (auto-expanding its collapsed ancestors), so
  "someone replied" lands you on the exact reply, even one deep in the tree.

### Comment counts next to "Comments" (issue #63)

The **Comments** control on each post shows two numbers: the **total** comments
you'd see if you expanded the thread, and — in the accent colour — how many are
**new** since you last opened it (e.g. *Comments · 12 · 3 new*). Both ride the
feed payload, so nothing fires a request per post on feed load.

- **Serializer fields.** `PostSerializer` gains read-only `comment_count` and
  `new_comment_count`. They're **not** SQL annotations — they're computed once per
  page by `comment_counts_for_posts(posts, viewer)` and handed to the serializer
  via `context["comment_counts"]`. Absent from context (e.g. the create response)
  ⇒ 0, which is correct for a brand-new post.
- **Counts honour the exact same pruning as the thread.** The count must match
  what actually opens, so `comment_counts_for_posts` reuses
  `build_visible_comment_tree` (see [connections](connections.md#comments-threaded-connection-pruned)):
  a comment from a not-connected or deactivated author — *and its whole subtree* —
  is excluded. A plain `COUNT` can't express arbitrary-depth subtree pruning, and
  a naive author-filtered count would over-count a connected author's reply
  sitting under a hidden parent. Replies count toward the total (one number for
  the whole visible thread).
- **Cheap and page-size-independent.** One query loads every comment on the
  page's posts, one loads the viewer's last-seen markers; the trees are built in
  Python. This is wired in via `CommentCountMixin` on the feed, profile
  (`UserPostsView`), and group (`GroupPostsView`) timelines, and directly on
  `PostDetailView` so the `/p/:id` permalink carries the counts too.

**The "new" marker — `PostCommentRead`.** A new model, one row per `(post, user)`
with a single `last_seen_at`, deliberately the same shape as `ConversationRead`
(messaging). A comment is **new** to you if it's visible, authored by *someone
else*, and its `created_at` is after your `last_seen_at` for that post; a missing
row (thread never opened) makes every such comment new. Your own comments are
never "new" — you've self-evidently seen them, mirroring how unread message
counts exclude your own messages.

- **When "new" clears — on opening the thread.** `GET /api/posts/<id>/comments/`
  upserts your `last_seen_at` to now, so opening the thread clears its whole
  count at once (seen is thread-level, not per-comment) — consistent with how
  opening a conversation clears its unread badge. The upsert is wrapped to
  survive a concurrent-open race (two tabs both INSERT ⇒ one falls back to an
  UPDATE, not a 500).
- **Frontend keeps the badge honest via the cache, not a flag.** On open, the
  client zeroes `new_comment_count` for that post in the cached feed / profile /
  group / permalink queries (`markPostCommentsSeen`), mirroring the server's
  reset without a refetch. The badge is then driven purely by that server-shaped
  count — so it clears on open **and** genuinely-new later comments re-badge once
  a refetch legitimately raises the count. (A per-card "already opened" flag
  would suppress those later comments until the card remounted.)

## Photos

- **`PostImage`** table (FK to `Post`) — **many photos per post**, not a single
  field. Uploaded as repeated `images` in the multipart `POST /api/posts/`. Feed
  and profile serializers embed each as `{id, image, thumbnail, width, height}`
  with absolute URLs.
- A post can be **photo-only** (no text).
- **Avatars** surface as a small square `avatar_thumb` on post/comment authors,
  the people list, and profile headers; `Avatar.jsx` renders the photo when
  present, else a coloured initial.
- **The post's marker on the timeline rail is the poster's avatar** (issue #64),
  not a plain dot — a warmer, scan-by-face cue that fits the "living line" look.
  It's an `Avatar size="xs"` in a profile link (`.tl-avatar-node`), centred on
  the spine with the same right-offset formula the old dot used (so it stays
  threaded at any gutter width); a surface-coloured halo separates the bead from
  the line, and hover adds an accent ring — both on the avatar element itself so
  they hug the visible circle. The avatar link is decorative (`tabIndex=-1` +
  `aria-hidden`) — the author's name beside it is the single accessible link to
  the profile, matching the avatar+name pattern in `CommentThread` /
  `GroupMembersPanel`. The **day-divider** dots (`.tl-day-dot`) stay plain.
- **The compose box mirrors this**: the pulsing green **"now"** node (`.tl-node`,
  TimeLine's live-tip "logo") is lifted to cap the top of the line, and *your own*
  avatar hangs on the spine just below it (same `.tl-avatar-node`), so the live
  end of the timeline reads like every other entry. The compose avatar gets no
  accent hover ring — that rule is scoped to `.tl-entry`, so `.tl-compose` reuses
  the class and gets a plain bead for free.
- **On mobile the compose box aligns to the spine in two bands** (`ComposeBox.tsx`),
  because the eye pairs each spine element with whatever sits beside it: the word
  **"now"** is level with the pulsing node (the node *is* now), and the **text
  box** is level with your avatar bead (that's you, about to write). Both centres
  are computed from the constants the spine column is built from rather than
  nudged by hand, so changing the node size or the bead gap moves the body with
  them. `BEAD_GAP` is deliberately wider than the node needs — it's what keeps
  the two pairs reading as two statements rather than one stack.

### Photo layout & the full-screen viewer

Both clients follow the same two rules, because both hit the same problem: a
post may carry up to ten photos, and rendering them full-width each turns one
entry into screens of scrolling, which buries the rest of the timeline.

- **One photo keeps its natural shape; several go into a two-column square
  grid.** The grid is *navigation* — a compact index of what's in the post — and
  is deliberately not where a photo gets looked at. Cost per post is then bounded
  no matter how many photos it has.
- **Tapping/clicking a photo opens a full-screen viewer** at that photo, loading
  the full-size `image` rather than the grid's `thumbnail`. On the web
  (`Lightbox.jsx`) you flip with arrow buttons or ← / →, and Esc / the × / the
  backdrop close it. On mobile (`PhotoLightbox.tsx`) you **swipe** — arrows mean
  nothing on a phone — with a × top-right and an `n / total` counter.

Two things worth knowing about the mobile viewer:

- It mounts a **`SafeAreaProvider` of its own inside the `Modal`**. React Native
  renders a Modal in a separate native view hierarchy, so it sits outside any
  provider mounted around the app; nesting is the documented fix, and it also
  means no screen has to wrap itself for the chrome to clear the notch.
- **Photos sit outside the card's own `Pressable`** (as the reaction chips
  already did). Nested pressables make "did I open the post or the photo?" a
  matter of touch-responder luck; side by side, the two targets can't collide.

### The imaging pipeline (`api/imaging.py`)

All image handling — post photos *and* avatars — funnels through
`process_image`, the single place the safety rules live:

- **Validate by decoding, not by extension/Content-Type.** A file is accepted
  only if Pillow opens it *and* its format is in a raster allow-list
  (JPEG/PNG/WebP/GIF/MPO/HEIF). **SVG is rejected** — a script-bearing vector
  would be stored XSS. Rejections name the detected format and the accepted ones,
  so "which photo, and convert it to what?" is answerable.
- **EXIF (including GPS) is stripped** by re-encoding from raw pixels, after
  applying the orientation tag so photos aren't stored sideways. Phone photos leak
  home location otherwise — a real privacy win, covered by a test.
- **HEIC/HEIF is accepted and transcoded** (issue #41). It's the *default* iPhone
  photo format, so rejecting it turned away the photos this app's actual audience
  takes — and because iOS only *sometimes* converts to JPEG on the way out
  (depending on browser, pick method, and the Camera "Most Compatible" setting),
  it presented as an intermittent "some of my photos won't upload". `pillow-heif`
  registers a HEIF opener at import of `imaging.py` — not in `AppConfig.ready()`,
  so it cannot be missing whatever the app-loading order. Everything downstream is
  unchanged: a HEIC is stored as an ordinary JPEG with metadata gone, which also
  means browsers that can't display HEIC (most) still render it. The prebuilt
  manylinux wheels bundle libheif, so **the backend image needs no apt packages**.

  > **Trap, if you touch orientation.** A real iPhone HEIC is decoded *upright*:
  > pillow-heif/libheif bake the camera's rotation into the pixels on open and
  > reset the EXIF orientation to 1. Plain `ImageOps.exif_transpose` is therefore
  > exactly right for both formats — it rotates a JPEG (whose pixels are still in
  > sensor orientation) and correctly no-ops on an already-upright HEIC. **Do not**
  > re-apply `info["original_orientation"]`: on a real iPhone photo that stashed
  > flag's rotation is already in the pixels, so re-applying it rotates a second
  > time and stores every portrait sideways — permanently, since we strip the flag.
  > This actually shipped once (a `_apply_orientation` helper did exactly that) and
  > hid behind a green test, because a HEIC written by pillow-heif's *own* encoder
  > leaves its pixels un-rotated — unlike any real camera. The regression test now
  > uses an already-upright fixture and asserts the dimensions come out unchanged.

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
  it. The edit PATCHes multipart, then refetches "who am I" so the new name/avatar
  propagate everywhere immediately.
- **You edit your profile in place, on your own profile page** (issue #53). An
  "Edit profile" button flips the header into `ProfileEditForm` (name / bio /
  avatar) and saves without leaving `/u/:id` — a profile is public-facing info, so
  you edit it where you (and everyone else) see it. There's no separate
  profile-edit route; `/settings` is now **account/security only** (notification
  prefs, password change, account deletion — see [accounts](accounts.md)).

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
  `ProfileEditForm` and `GroupFormPage`, since both render the same circle.
- **Undecodable files fail early with a message.** The modal probes whether the
  browser can decode the chosen file; if not (an unsupported type the file picker
  let through — e.g. HEIC on a browser without HEIC support — or a corrupt file),
  it shows "that file couldn't be opened, try a JPEG/PNG/WebP/GIF" instead of a
  cropper that never lets you continue. The backend still rejects the same files;
  this just surfaces it before the user tries to save.

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
