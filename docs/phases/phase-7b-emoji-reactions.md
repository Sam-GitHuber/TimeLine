# Phase 7b — Emoji reactions

**Status:** done

## Goal

Let people react to any **post**, **comment**, or **reply** with **any emoji
from their keyboard** — the full Unicode set, not a locked preset of 5–6. A
reaction is a lightweight, low-friction way to respond that fits the product
philosophy: it helps sustain real-life connections without the noise of a full
comment, and allowing *any* emoji (rather than an "engagement-optimised" fixed
set) keeps expression personal and playful.

Tracked by issue #48. Slotted here (a small standalone feature phase) rather
than inside Phase 7 — reactions are explicitly out of scope for
productionisation — and deliberately *before* Phase 8, whose notification centre
already lists reactions as an event source.

## Runnable product at the end of this phase

- Open the reaction control on any post, comment, or reply and pick any emoji
  from a searchable, categorised picker.
- See reactions aggregated as `emoji × count`, and who reacted (within your
  visibility boundary).
- Toggle your own reaction off by adding the same emoji again.
- Counts stay current in the feed/thread via the existing polling.

## Definition of done

- [x] A reaction control appears on every post, comment, and reply
      (`ReactionBar` in `PostCard` and each `CommentNode`).
- [x] The picker covers the full standard emoji set (categories + search), and
      is **self-hosted with no external/CDN requests** — `emoji-picker-element`
      with `dataSource` pointed at a Vite-bundled first-party copy of the emoji
      data (the default jsDelivr CDN is never hit). Confirmed by the build:
      `data-*.json` ships as an app asset.
- [x] A user can add and remove their own reactions; re-adding the same emoji
      toggles it off (`POST .../react/`).
- [x] Reactions are aggregated and shown as `emoji × count`, with a "Who
      reacted?" popover (`GET .../reactions/`) — both pruned to the viewer's
      visible people.
- [x] Reactions respect the **same visibility gates** as the thing reacted to —
      `can_view_post` / `can_view_comment` gate the endpoints (404 otherwise),
      and the aggregate/who-list prune to `visible_reactor_ids`, so a
      not-connected reactor is never leaked.
- [x] Counts update in the feed/thread — the toggle response carries the fresh
      pruned summary (instant in-place update); the existing feed poll
      reconciles.
- [x] Server-side emoji validation (`api/emoji.py`: rejects non-emoji /
      oversized, NFC-normalises) and a per-user-per-target cap
      (`MAX_REACTIONS_PER_USER_PER_TARGET = 20`).
- [x] Backend (`ReactionConstraintTests`, `PostReactionToggleTests`,
      `ReactionVisibilityTests`, `CommentReactionTests`, `EmojiValidationTests`)
      + frontend (`reactions.test.jsx`) tests cover toggle, uniqueness,
      validation, pruning, group scoping, the visibility gate, and the cap.
      Full suites green: backend 221, frontend 117.

## Design

### Data model — `Reaction` (in the `api` app)

A single model with a target that is **either** a `Post` **or** a `Comment`.
Deliberately **not** a `GenericForeignKey`/contenttypes target — that's more
machinery than we need when both `Post` and `Comment` are concrete models that
already exist. Instead, two nullable FKs guarded by a constraint:

```
Reaction:
  user       FK → User        (CASCADE)
  post       FK → Post        (CASCADE, nullable)
  comment    FK → Comment     (CASCADE, nullable)
  emoji      CharField        (normalised, validated)
  created_at DateTimeField
```

- **CheckConstraint** — exactly one of `post` / `comment` is set (a reaction
  targets one thing).
- Two conditional **UniqueConstraints** — `(user, post, emoji)` and
  `(user, comment, emoji)` — so re-adding the same emoji is a no-op the toggle
  endpoint turns into a removal. (Conditional on the relevant FK being non-null,
  because a plain unique tuple treats `NULL` as always-distinct.)
- Comment reactions reuse the `Comment` model, which already backs both
  top-level comments and replies — so "reply" reactions need no extra model.

### Emoji validation (server-side)

- NFC-normalise the string.
- Reject anything that isn't a single emoji grapheme (guards against pasting
  arbitrary text/markup into the field), while still allowing multi-codepoint
  emoji (ZWJ sequences, skin-tone modifiers, flags).
- Length cap (bytes/codepoints) so a crafted ZWJ chain can't bloat a row.
- Per-user-per-target **distinct-emoji cap** (e.g. 20) so a single user can't
  spam hundreds of reactions onto one target.

### Visibility & pruning (the privacy-critical piece)

Reactions mirror the existing per-viewer comment pruning exactly:

- **Gate:** the toggle endpoints check `can_view_post` / `can_view_comment`;
  you can't react to (or probe) anything you can't see (→ 404, matching the
  comments view).
- **Aggregation is per-viewer:** counts are computed over **the viewer plus the
  people they may see**, exactly mirroring the comment tree's pruning — which,
  per the actual `PostCommentsView` code, is `connected_ids | {viewer}` for
  **both** personal and group posts (group membership gates *access* to the
  post; it does not widen who you see within it — you still only see reactions
  from members you're connected with). A reactor the viewer isn't connected with
  is never counted and never appears in "who reacted", so reactions can't
  surface a stranger second-hand.
- **Consequence (intended):** two viewers can legitimately see different counts
  on the same post — the same way they already see different comment trees. This
  is the privacy-correct behaviour, not a bug.

### API

- `POST /api/posts/<id>/react/` — body `{emoji}`. Toggles: adds the reaction if
  absent, removes it if present. Returns the target's updated pruned reaction
  aggregate.
- `POST /api/comments/<id>/react/` — same, for a comment/reply.
- `GET /api/posts/<id>/reactions/` and `GET /api/comments/<id>/reactions/` —
  the connection/group-visible reactor list grouped by emoji ("who reacted").
- `PostSerializer` and `CommentSerializer` embed a pruned
  `reactions: [{emoji, count, reacted}]` (prefetched — no N+1), where `reacted`
  is whether the requesting user is one of the reactors.

### Frontend

- **Two-tier picker.** The add-reaction button opens a compact
  `QuickReactionPopover` — four one-tap positive reactions (👍 ❤️ 😂 🎉), kept
  positive on purpose (product philosophy) — with a "more" button that expands
  to the full **`emoji-picker-element`** (MIT web component; bundles its own
  emoji data, renders native system emoji glyphs, makes **no network
  requests**). The full picker is code-split, so its bundle + data load only when
  someone actually expands to it.
- The full picker is themed to the app's **light** look: `.light` forced, and its
  CSS-custom-property hooks mapped onto the design tokens (`--color-raised`,
  `--color-line`, `--color-accent`, …). Because it's portalled into the light DOM
  it inherits those tokens, so there's one source of truth.
- Popovers are portalled to `<body>` and positioned `absolute` in **page**
  coordinates (rect + scroll), so they escape the feed's stacking context (the
  "translucent picker" bug) *and* scroll glued to their trigger button rather
  than floating (a `fixed` popover detaches on scroll).
- Aggregated `emoji × count` chips on every post, comment, and reply; clicking
  your own chip toggles it off; a count reveals the visible "who reacted" list.
- TanStack Query with an optimistic toggle; counts refresh on the existing
  feed/thread `refetchInterval`.

## Steps

1. `Reaction` model + migration `0011`, with the check + conditional unique
   constraints. Add the emoji-normalise/validate helper (+ caps).
2. Toggle endpoints (posts + comments) behind the existing visibility gates.
3. Per-viewer pruned aggregation; embed `reactions` in the post + comment
   serializers (prefetched). "Who reacted" endpoints.
4. Backend tests: toggle add/remove, uniqueness, validation, per-viewer pruning
   (not-connected reactor invisible), group scoping, visibility 404, cap.
5. Frontend: self-host `emoji-picker-element`, reaction control + chips on
   posts/comments/replies, optimistic toggle, who-reacted.
6. Frontend tests (Vitest): chips render, toggle, picker opens, who-reacted.
7. Wrap-up: update the roadmap row, CLAUDE.md status line, PR, close #48.

## Out of scope (this phase)

- Reactions on direct/group **messages** (a possible follow-up).
- Custom/uploaded emoji or emoji packs.

## Notes / decisions log

- **Emoji picker = `emoji-picker-element` (confirmed with the user,
  2026-07-12).** Self-contained web component, no CDN/network calls, ships its
  own data and uses native emoji glyphs — consistent with the app's self-hosted
  fonts and privacy-first stance. Alternatives weighed: `emoji-mart` (popular,
  but its default data is CDN-fetched — an easy privacy footgun) and `frimousse`
  (headless/newer, more wiring for a tighter token fit). Boring + self-contained
  won.
- **Own phase, running in parallel with Phase 7's leftover ops chores
  (confirmed 2026-07-12).** Phase 7's remaining DoD (uptime monitoring + a
  monthly cost note) are ops tasks that don't block a self-contained feature
  branch.
- **Two-nullable-FK target, not `GenericForeignKey`.** Both targets are concrete
  and few; the FK+constraint shape is the boring, indexable, migration-friendly
  choice and avoids pulling in contenttypes plumbing.
- **Per-viewer counts are intended.** They fall straight out of reusing the
  existing connection/group visibility rules; a global count would leak the
  existence of not-connected reactors.
- **New frontend deps need the node_modules volume renewed.** This phase adds
  `emoji-picker-element` + `emoji-picker-element-data`. The dev `frontend`
  container keeps `node_modules` in an anonymous volume that shadows the image,
  so after pulling this branch the running container won't have the new packages
  and Vite fails with *"Failed to resolve import
  emoji-picker-element-data/…/data.json?url"*. Fix: rebuild + renew the volume —
  `docker compose up -d --build --renew-anon-volumes frontend` (the standard
  "deps changed" procedure). A fresh clone building from scratch is unaffected.
- **A test now guards the emoji-data import** (`emoji-picker-import.test.jsx`,
  deliberately *unmocked*). The rest of the suite stubs the picker, so a missing
  package or broken data path would otherwise pass tests and only fail at runtime
  in the browser — which is exactly what happened once. This test resolves the
  real `?url` import and asserts it's a first-party (non-CDN) URL.
- **The popover is portalled to `<body>`, not positioned in-flow.** First cut
  put the picker `absolute` inside the reaction bar. It rendered, but later feed
  content (the same post's Comments/Report row, and posts below) painted *over*
  it — the picker looked translucent and clicks landed on the content on top, so
  reacting did nothing. Root cause: an in-flow popover is trapped in the feed's
  stacking context and `z-index` can't lift it above sibling posts. Fix:
  `ReactionBar` renders the popover through `createPortal` to `document.body`
  with `fixed` positioning anchored to the trigger button (`PopoverPortal`),
  escaping the stacking context. Verified end-to-end in the seeded app (headless
  Chrome, real timers): picker is opaque and a click POSTs `/react/` and shows
  the chip. Guarded by two tests asserting the popover mounts under `<body>`.
  (Note: `--virtual-time-budget` headless screenshots are useless here — they
  break IndexedDB, so the picker sits on "Loading…" forever; drive it with real
  timers via puppeteer instead.)
