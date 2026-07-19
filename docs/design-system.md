# TimeLine — Design System

The shared visual language for the whole app. Set once after Phase 3a so that
every later phase (photos, messaging, groups) reads as the same place instead of
triggering a redesign. **Build new UI from these tokens; don't reach for raw
colours or fonts.**

## The idea

A warm, modern, unhurried look — a calm place for the people you already know in
real life (see the [product philosophy](../docs/SHARED.md): sustaining existing
connections, not online discovery or echo chambers). Not a newspaper, not a cold
corporate tool: **warm-modern**. Clean surfaces and a contemporary sans, but with
neutrals that carry a faint warm bias so it never goes clinical.

## The signature — the living line

The feed is a literal timeline. Posts hang off **one continuous vertical spine**;
day-markers punctuate it; the newest post sits at the live "now" node (the
pulsing accent dot on the compose box); and the timestamp is promoted from
throwaway grey text to a **marker on the line**. Scrolling is travelling back
down your days — the product's name and its one promise, made visible.

Implemented by `components/Timeline.jsx` (groups posts by calendar day and draws
the spine) + the `.tl-*` classes in `index.css`. `PostCard` renders one entry;
`ComposeBox` renders the `.tl-compose` "now" node.

## The line, one level down — comment threads

A comment thread is drawn as the same living line, branching. The post's spine
runs on down below the entry; each comment reaches out to it with a **curved
elbow** that lands on that comment's avatar; and a comment with replies grows a
spine of its own for them to hang off. Post, comments and replies are one tree
under one rule, rather than a timeline with a comments widget bolted underneath.

**The rule that matters: every comment branches off its parent's line
individually.** Siblings must not share a spine of their own. This is not a
stylistic preference — it's the thing that makes the thread readable:

> With one line threaded down through all the top-level comments, the second
> top-level comment reads as a *reply to the first*, because they sit on the
> same line and that line's only visible origin is the first comment's avatar.

Who you are replying to is the single most important thing a comment thread has
to communicate, so the line has to carry it. Reply depth is read off **which
vertical line you hang from**, not off indentation alone — the same shape, and
the same reasoning, as a file tree. So a parent's line runs straight down past
all of its children, and each child hooks onto it where it belongs.

Each comment therefore draws up to three pieces of line:

1. its **elbow** — out from the parent's line, curving down onto its own face.
   Every comment has one; for a top-level comment the parent line is the *post's*
   spine.
2. the parent's line **carried past it**, when it isn't the last sibling. The
   last sibling omits this, which is what makes a run terminate on a face rather
   than trail off into the composer.
3. its own **stem**, from its face down to where its replies start — only when it
   has replies showing.

Two constraints fall out of drawing it per-comment rather than as one background
line, and both are easy to reintroduce by accident:

- **Never space comments with a flex `gap`** (or a `space-y-*` utility). A gap is
  empty space no segment covers, so it shows up as a break in the line. Spacing
  goes *inside* a comment, as bottom padding, where the segment above covers it.
  Same trap the feed's day dividers hit.
- **No top padding on a thread or a replies block.** The line above ends exactly
  at the block's top edge and the first elbow starts exactly there; padding
  between them is a visible break. The air comes from the *parent's* bottom
  padding instead.
- **Each comment carries its own step right as left padding; the replies block
  adds none.** The tempting alternative — indent the replies block, and let each
  child reach back out to its parent's line — puts the elbow and the carried-past
  line at a *negative* offset, outside the element that draws them. Browsers and
  iOS both render that; Android is liable to clip it. Paying the indent inside
  each comment keeps every line within its own box, so the question never comes
  up. The parent's line then sits half a bead in from the comment's left edge,
  and the comment's own line one step further.

The indent per level has to clear the avatars, since a parent's line now passes
them: keep it above half a bead width (22pt against a 30pt bead on mobile) or the
line grazes every face it goes by. It shrinks past the third level so deep
threads don't march off the side of a phone; replies start collapsed, so more
than a couple of visible levels is rare.

The elbow is two borders and one rounded corner (`border-left` + `border-bottom`
+ a bottom-left radius) — no SVG needed for what is, in the end, a quarter
circle. Draw it *before* the avatar so the avatar's surface-coloured halo paints
over the end of it and the line appears to run into the face, not under it.

**Implemented on mobile** (`mobile/src/components/CommentThread.tsx`, which has
the geometry constants and the full derivation in its header comment).
**The web still uses the old flat treatment** — `frontend/src/components/
CommentThread.jsx` nests replies under a plain `border-l` rule with
`space-y-4` — and should be brought over to this. Note the `space-y-4` is exactly
the gap problem above, so that port is a real change in structure, not a restyle.

## Tokens (see `frontend/src/index.css`)

All tokens live in Tailwind v4's `@theme`, so they're available as utilities
(`bg-surface`, `text-ink-faint`, `border-line`, `font-display`, …).

### Colour

Neutrals carry a faint warm bias toward the surface — never a flat grey.

| Token | Hex | Use |
|---|---|---|
| `surface` | `#FBFAF7` | app ground (warm near-white) |
| `raised` | `#FFFFFF` | cards, compose, inputs |
| `ink` | `#1C1A16` | primary text |
| `ink-soft` | `#57534B` | secondary text |
| `ink-faint` | `#928D83` | meta, timestamps, placeholders |
| `line` | `#ECE9E2` | hairlines, dividers |
| `line-strong` | `#E0DCD3` | input borders |
| `spine` | `#DED9CF` | the timeline line + hollow nodes |
| `accent` | `#1C8A6A` | **the one accent** — emerald-teal (connection/growth) |
| `accent-deep` | `#146650` | accent hover / press, link text |
| `accent-tint` | `#E6F2ED` | washes: chips, hovers, focus rings |

One accent only. Errors use Tailwind's default `red-600` (semantic, not the
accent). Avatars draw from a warm earth palette (`av-clay`, `av-ochre`,
`av-sage`, `av-teal`, `av-plum`, `av-moss`) hashed off the display name.

### Type — three voices

- **Display · Bricolage Grotesque** (`font-display`) — brand, headings, day
  labels. Contemporary sans with character, used with restraint.
- **Body · Hanken Grotesk** (`font-body`, the default) — everything you read and
  tap. Friendly and legible for every age in the family.
- **Time · IBM Plex Mono** (`font-mono`) — used **only** for timestamps and
  dates (the one place the exact *when* is the point). Never decorative labels.

Fonts are **self-hosted** in `frontend/src/fonts/` (variable woff2). This is a
privacy decision, not just performance: loading from the Google Fonts CDN would
send every visitor's IP to Google, which violates the no-third-party-trackers
principle. Keep new fonts self-hosted.

### Shared components

- `.btn` + `.btn-primary` / `.btn-ghost` + `.btn-sm` / `.btn-block` — the one
  button. Filled to *act* (Post, Connect, Approve), quiet outline for a state
  already in motion (Requested, Connected) or secondary actions.
- Rounded corners (`rounded-xl`/`2xl`), soft depth, generous whitespace.

## Theming note

The app currently commits to a single warm light theme. A "dusk" dark variant is
a deliberate future addition — when it lands, do it token-first (redefine the
`--color-*` values under a dark selector), never by inverting per-component.

## Not yet designed

Relationship labels on posts ("Sister", "Cousin") were sketched in the pitch but
need a real data field before they're honest — omitted until then. Profile bios,
photos and richer profiles arrive in Phase 4 and should use these tokens.
