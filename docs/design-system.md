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
