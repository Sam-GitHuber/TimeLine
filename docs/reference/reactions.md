# Emoji reactions

React to any **post, comment, reply, or message** with **any emoji from your
keyboard** — the full Unicode set, not a locked preset. A reaction is a
lightweight, positive, low-friction way to respond that fits the product
philosophy without the noise of a full comment. This doc is the current-state
reference.

Code: `Reaction` model + toggle/list views + `visible_reactor_ids` in
`backend/api/`, emoji validation in `backend/api/emoji.py`. Frontend: `ReactionBar`
on `PostCard` and each `CommentNode`, with a self-hosted picker. Message
reactions are mobile-only for now — see [messaging.md](messaging.md).

## Data model — `Reaction`

A single model whose target is **exactly one** of a `Post`, a `Comment` or a
`Message` — three nullable FKs, deliberately **not** a
`GenericForeignKey`/contenttypes target (the targets are concrete and few; three
FKs + a constraint is the boring, indexable, migration-friendly choice):

```
Reaction:
  user       FK → User      (CASCADE)
  post       FK → Post      (CASCADE, nullable)
  comment    FK → Comment   (CASCADE, nullable)
  message    FK → Message   (CASCADE, nullable)   ← Phase 9b M2
  emoji      CharField      (normalised, validated)
  created_at DateTimeField
```

- **CheckConstraint** (`reaction_targets_exactly_one`) — exactly one of the three
  is set.
- Three **conditional** `UniqueConstraint`s — `(user, post, emoji)`,
  `(user, comment, emoji)`, `(user, message, emoji)` — so re-adding the same
  emoji is a no-op the toggle endpoint turns into a removal. Conditional on the
  relevant FK being non-null, because a plain unique tuple treats `NULL` as
  always-distinct.
- Comment reactions reuse the `Comment` model (which already backs both top-level
  comments and replies), so "reply" reactions need no extra model.
- **Widening this model rather than adding a `MessageReaction`** keeps one toggle
  path, one emoji validator and one aggregation function. Three copies of "one
  row per (user, target, emoji)" would have drifted, and the constraint work is
  the same either way.

## Emoji validation (`api/emoji.py`, stdlib-only)

- NFC-normalise the string.
- Reject anything that isn't a single emoji grapheme (guards against pasting
  arbitrary text/markup into the field), while still allowing multi-codepoint
  emoji (ZWJ sequences, skin-tone modifiers, flags).
- Length cap so a crafted ZWJ chain can't bloat a row.
- Per-user-per-target **distinct-emoji cap**
  (`MAX_REACTIONS_PER_USER_PER_TARGET = 20`) so one user can't spam a target.

## Visibility & pruning (the privacy-critical piece)

**On a post or comment**, reactions mirror the [comment tree's](connections.md)
per-viewer pruning exactly. **On a message they are not pruned at all** — see
[the section below](#message-reactions-phase-9b-m2) for why that's the correct
answer rather than a gap.

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

- `POST /api/posts/<id>/react/`, `POST /api/comments/<id>/react/` and
  `POST /api/messages/<id>/react/` — body `{emoji}`. **Toggles:** adds if absent,
  removes if present. Returns the target's updated reaction aggregate (so the
  client updates in place instantly).
- `GET /api/posts/<id>/reactions/`, `.../comments/<id>/reactions/` and
  `.../messages/<id>/reactions/` — the reactor list grouped by emoji ("who
  reacted").
- `PostSerializer` / `CommentSerializer` / `MessageSerializer` embed
  `reactions: [{emoji, count, reacted}]` (prefetched — no N+1), where `reacted` is
  whether the requesting user is one of the reactors. The existing feed/thread poll
  reconciles counts.
- The shared helpers `_toggle_reaction` and `_reactors_grouped` take the pruning
  decision as a **required argument** (`visible_reactor_ids(user)`, or the
  `EVERYONE` sentinel), so no caller can prune — or fail to — by accident.

## Message reactions (Phase 9b M2)

Same model, same validator, same route shape; three things differ, and each is a
decision rather than an omission.

**The gate is the messaging gate, not the feed's.** A message target resolves
through `can_view_message`, which is interval-clipped exactly like the thread,
the edit route and the report gate — so a member who was `pending` across a gap
gets a **404** for a message from inside it, and reacting can't become an
existence oracle for history they were clipped out of. See
[messaging.md](messaging.md#history-is-interval-clipped).

**Reacting requires that you could still *send*.** A reaction is content
everyone else in the thread sees, so someone disconnected or severed from a chat
gets a **403** — the same reasoning that gates editing. History stays readable
either way; only writing stops.

**A deleted message is removal-only** (`allow_add=False` on the shared toggle):
adding a new reaction is a 400, taking an existing one off still works. Refusing
both looks tidier and is wrong — a tombstone still shows reactions left before
the delete, and it has no long-press menu, so the who-reacted sheet is the *only*
route to remove one. Blocking it would strand someone with a 😂 on a message that
no longer exists and no way to retract it. Removing isn't adding, so the "nothing
left to react to" reasoning simply doesn't apply to it.

**The reactor list isn't pruned per viewer.** Post reactions are, because a
reactor might be someone the viewer can't see. A conversation can't have one: its
active participants are a **clique by construction**, so anyone who can see the
message can already see everyone who reacted. Clipping happens on the *message*,
not on the people — which also means everyone in a thread sees the same counts,
where two people can legitimately see different counts on the same post. The
opt-out is the explicit `EVERYONE` sentinel in `serializers.py`, not a missing
argument.

**No `Notification` row and no push**, unlike a post/comment reaction. Messaging
sits outside the activity centre entirely (messaging.md explains why), and
buzzing a phone for a 👍 is how people end up turning notifications off. Both
halves are asserted in `MessageReactionTests`, because the shared toggle helper
writes a notification for every *other* target.

**They stay server-side plaintext when E2E lands** — a knowing carve-out, not an
oversight. Encrypting them would kill server-side aggregation for very little
gain: a bare emoji, detached from the message it's on, reveals close to nothing.
Recorded here so a future session doesn't discover it and assume it was missed.

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

## Mobile

The app has the same two tiers on the feed (`ReactionBar` → `ReactionTray` → the
`rn-emoji-keyboard` grid) and, in a chat thread, a **quick-reaction row across the
top of the long-press message menu**: six one-tap emoji plus a `＋` opening the
same grid. Both spellings of the picker share one theme
(`emojiPickerTheme` in `theme.ts`) so it can't look different depending on where
you opened it.

**The chat's six are not the feed's four.** `ReactionTray` keeps its quick set
strictly positive (👍 ❤️ 😂 🎉) because reacting to someone's *post* with 😢 reads
as a verdict on it. In a conversation the opposite holds: 😮 and 😢 to someone's
news are the warm answers, and a set that can only be cheerful makes you type a
whole message to say "oh no". The chat set is 👍 ❤️ 😂 😮 😢 🙏.

Message reactions render as pills hanging off the bubble's lower edge on its near
side. **A pill has one gesture: tap opens "who reacted".** It never toggles.

That's a deliberate departure from the feed's chips, which *do* toggle on tap, and
it was settled by trying both. A pill is a display of what the thread said, so a
tap should go to the detail of it rather than silently change it — and a target
that small doing two different things depending on how long you held it is where
a mis-timed press does the wrong thing. A post has no long-press menu to carry the
alternative, so its chip has to toggle; a message has two better homes for it:

- **the long-press menu's emoji row** — tapping an emoji you've already used takes
  it off (it renders as active, and reads "Remove 👍 reaction" to assistive tech);
- **the sheet itself** — your own row reads **"Tap to remove"**, and tapping it
  removes the reaction and closes the sheet.

The sheet takes `meId` as a *prop* rather than calling `useAuth()`, so it stays a
pure renderer of what the server sent and the feed's callers don't inherit a
dependency on an auth provider for a feature only the thread uses. Both the
remove affordance and the menu's emoji row disappear in a thread you can no longer
send to — the list stays readable and inert, which is the same line the server
draws.

**Toggling a message reaction drops the reactor-list cache** (`removeQueries` on
`reactorsQueryKey`, exported from `ReactorsSheet` so the key can't be spelled two
ways). That cache outlives the sheet, so without it a reopened sheet renders the
pre-toggle rows — and those rows are *actionable*: a "Tap to remove" for a
reaction you already removed would call the toggle again and put it back.
Invalidating isn't enough, because a closed sheet's query is inactive and would
only be marked stale, leaving exactly that window open. Dropping the entry means
the next open can only show a spinner.

**Handing over to the full grid keeps the menu mounted** and hides it with
`visible={false}`, rather than unmounting it. On iOS you must not tear down a
presented modal in the same commit that presents the next one — the new one can
fail to appear and leave the screen unresponsive behind a dismissed one. This is
the shape `ReactionTray` already uses; dismissing the grid then closes both.

The pills sit *outside* `BubbleBody` so the action menu can re-render that
component at the bubble's measured rect without duplicating them.

Adding a reaction to a post or comment notifies its author via the activity centre
(a `reaction` notification, pruned to the same connection boundary and de-duped
while unread) — see [notifications](notifications.md). **A message reaction
notifies nobody**, deliberately; see above.

## Out of scope

- Message reactions **on the web** — they're mobile-only until Phase 9b M9 (web
  parity). The field is additive, so the drawer simply ignores it.
- Custom/uploaded emoji or emoji packs.
