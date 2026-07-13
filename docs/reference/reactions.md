# Emoji reactions

React to any **post, comment, or reply** with **any emoji from your keyboard** —
the full Unicode set, not a locked preset. A reaction is a lightweight, positive,
low-friction way to respond that fits the product philosophy without the noise of a
full comment. This doc is the current-state reference.

Code: `Reaction` model + toggle/list views + `visible_reactor_ids` in
`backend/api/`, emoji validation in `backend/api/emoji.py`. Frontend: `ReactionBar`
on `PostCard` and each `CommentNode`, with a self-hosted picker.

## Data model — `Reaction`

A single model whose target is **either** a `Post` **or** a `Comment` — two
nullable FKs, deliberately **not** a `GenericForeignKey`/contenttypes target (both
targets are concrete and few; two FKs + a constraint is the boring, indexable,
migration-friendly choice):

```
Reaction:
  user       FK → User      (CASCADE)
  post       FK → Post      (CASCADE, nullable)
  comment    FK → Comment   (CASCADE, nullable)
  emoji      CharField      (normalised, validated)
  created_at DateTimeField
```

- **CheckConstraint** — exactly one of `post` / `comment` is set.
- Two **conditional** `UniqueConstraint`s — `(user, post, emoji)` and
  `(user, comment, emoji)` — so re-adding the same emoji is a no-op the toggle
  endpoint turns into a removal. Conditional on the relevant FK being non-null,
  because a plain unique tuple treats `NULL` as always-distinct.
- Comment reactions reuse the `Comment` model (which already backs both top-level
  comments and replies), so "reply" reactions need no extra model.

## Emoji validation (`api/emoji.py`, stdlib-only)

- NFC-normalise the string.
- Reject anything that isn't a single emoji grapheme (guards against pasting
  arbitrary text/markup into the field), while still allowing multi-codepoint
  emoji (ZWJ sequences, skin-tone modifiers, flags).
- Length cap so a crafted ZWJ chain can't bloat a row.
- Per-user-per-target **distinct-emoji cap**
  (`MAX_REACTIONS_PER_USER_PER_TARGET = 20`) so one user can't spam a target.

## Visibility & pruning (the privacy-critical piece)

Reactions mirror the [comment tree's](connections.md) per-viewer pruning exactly:

- **Gate:** the toggle endpoints check `can_view_post` / `can_view_comment` — you
  can't react to (or probe) anything you can't see (→ 404, matching the comments
  view).
- **Aggregation is per-viewer:** counts are computed over the viewer plus the
  people they may see — `visible_reactor_ids` = `connected_ids | {viewer}` for
  **both** personal and group posts. Group membership gates *access* to the post;
  it does **not** widen who you see within it (you still only see reactions from
  members you're connected with). A reactor you aren't connected with is never
  counted and never appears in "who reacted", so reactions can't surface a stranger
  second-hand.
- **Consequence (intended):** two viewers can legitimately see different counts on
  the same post — the same way they see different comment trees. Privacy-correct,
  not a bug. (A global count would leak the existence of not-connected reactors.)

## API

- `POST /api/posts/<id>/react/` and `POST /api/comments/<id>/react/` — body
  `{emoji}`. **Toggles:** adds if absent, removes if present. Returns the target's
  updated **pruned** reaction aggregate (so the client updates in place instantly).
- `GET /api/posts/<id>/reactions/` and `GET /api/comments/<id>/reactions/` — the
  visible reactor list grouped by emoji ("who reacted").
- `PostSerializer` / `CommentSerializer` embed a pruned
  `reactions: [{emoji, count, reacted}]` (prefetched — no N+1), where `reacted` is
  whether the requesting user is one of the reactors. The existing feed/thread poll
  reconciles counts.

## Frontend

- **Two-tier picker.** The add-reaction button opens a compact `QuickReactionPopover`
  — four one-tap positive reactions (👍 ❤️ 😂 🎉), kept positive on purpose (product
  philosophy) — with a "more" button that expands to the full picker.
- **Full picker = `emoji-picker-element`** (MIT web component), **self-hosted with
  no external/CDN requests** — its emoji data is bundled by Vite as a first-party
  asset, so the default jsDelivr CDN is never hit (consistent with the self-hosted
  fonts and privacy-first stance). It renders native system emoji glyphs. The full
  picker is **code-split**, so its bundle + data load only when someone expands to
  it. A deliberately-unmocked test (`emoji-picker-import.test.jsx`) resolves the
  real data import and asserts it's a first-party (non-CDN) URL — the rest of the
  suite stubs the picker, so a broken data path would otherwise only fail at
  runtime in the browser (which is exactly what happened once).
- The picker is themed to the app's light look via its CSS-custom-property hooks
  mapped onto the design tokens (one source of truth).
- **Popovers are portalled to `<body>`** and positioned in page coordinates (not
  in-flow) so they escape the feed's stacking context — an in-flow popover was
  painted over by later posts (looked translucent, clicks landed on the content on
  top). See the design note in the git history if this regresses.
- Aggregated `emoji × count` chips on every post, comment, and reply; clicking your
  own chip toggles it off; a count reveals the visible "who reacted" list.
  TanStack Query with an optimistic toggle.

Adding a reaction notifies the target's author via the activity centre (a
`reaction` notification, pruned to the same connection boundary and de-duped while
unread) — see [notifications](notifications.md).

## Out of scope

- Reactions on direct/group **messages** (a possible follow-up).
- Custom/uploaded emoji or emoji packs.
