# Connections & comments

The social graph and the visibility boundary that everything else keys off. A
**connection** is a symmetric, mutually-approved relationship (there is no
one-directional "follow"), and it's the single predicate that decides whose posts,
comments, and reactions you see. This doc is the current-state reference.

Code: `Connection` / `Comment` models + `connected_user_ids` / `visible_posts` /
comment-tree pruning in `backend/api/views.py`. Frontend: the Connect button,
"Connection requests" inbox, and the comment thread on each post.

## Connections (the relationship)

A connection is stored as a **single** `Connection` row: `requester`, `requestee`,
`status` (`pending` | `accepted`).

- **Private by default, always.** Every connection is a *request* the other person
  approves — no instant connect, no per-account public/private toggle. One
  behaviour, matching the privacy-first mission.
- **Symmetric once accepted.** While `pending`, direction still matters (requester
  asked requestee). Once `accepted`, the row is treated as symmetric and
  visibility checks both endpoints — approving connects **both** accounts (no
  separate "follow back"). One row = one source of truth, so there's no reciprocal
  row to drift out of sync.
- **`connected_user_ids(user)`** collects the *other* party from every accepted row
  where you're either endpoint. This one helper feeds `visible_posts` (so the feed
  and profiles agree) and the comment/reaction pruning.
- **Guardrails live in the DB, not just the API.** A functional unique index —
  `UniqueConstraint(Least("requester_id","requestee_id"), Greatest(...))` — makes
  the *ordered pair of ids* unique, so A↔B and B↔A can't both exist regardless of
  who requested whom. Plus a no-self-connection check. (Postgres-only; Postgres
  runs in dev, test, and prod.)

### Endpoints & button states

- `POST /api/users/<id>/connect/` — send a pending request, **or** accept an
  incoming one (see auto-accept below).
- `DELETE /api/users/<id>/connect/` — cancel a request or disconnect.
- `GET /api/connection-requests/` — your inbox; `POST .../<id>/approve|reject/`,
  guarded so only the requestee can act (else 404, so requests to others aren't
  revealed).
- **`connection_status`** is annotated per-viewer as none / requested (you asked)
  / **incoming** (they asked you) / connected, driving the Connect / Requested /
  **Approve** / Connected button. The "Approve" state calls the same
  `POST /connect/`, so you can accept from someone's profile, not only the inbox.
- **Reverse-request auto-accept:** if B requests A while A already has a pending
  request to B, the intent is clearly mutual — the second `POST` accepts the
  existing row instead of creating a competing one (which the unique constraint
  would reject anyway).

### Reporting a refused write

The Connect button, the Message button and the disconnect path had no error path
at all until issue #236: nothing rendered `isError`, mobile never alerted, and
`onSuccess` is the only place an invalidation runs — so a rejection left the cache
untouched and the button exactly as it was. Press **Requested** to withdraw after
they've already accepted (or closed their account) and the 400 repainted nothing;
the click read as never having registered, so the natural response was to press it
again. Both clients now report it where the action was taken — inline under the
button on the web, `Alert.alert` on the phone.

Two rules the copy follows, worth keeping when this pattern spreads to the other
surfaces in the same family (#237–#240):

- **The server's own words win where it has any.** `ConnectView` rejects with
  sentences written for a person — "You can't connect with this person." when a
  block bars it — which say more than any fallback could. The exception is the
  block itself, where the server has nothing useful to say and safety needs
  stating outright: see [messaging.md](messaging.md#blocking).
- **The fallback is per state, not generic.** "Couldn't withdraw that request",
  not "something went wrong" — knowing *which* of the four things the button does
  didn't happen is most of the value. It's reached whenever the server didn't
  write anything readable, which is **two** cases, not one: a network failure
  (offline, DNS, the connection dropped — the browser's own "Failed to fetch"),
  and a server error with no DRF body (a 500 rendered as a Django HTML page)
  which leaves `firstErrorMessage` nothing to pull out, so `api.js` synthesizes
  "Request failed (500)". Both clients' `ApiError` therefore carries a
  **`fromServer`** flag, and `serverMessage` gates on it — nothing cruder
  separates the two, since the second case has a message *and* a status.

  **Issue #240 made this the whole web client's rule, not three buttons'.**
  `frontend/src/api.js` now wraps the `fetch` itself and re-raises a network
  failure as an `ApiError` with `status: 0`, `fromServer: false` and a sentence
  of ours ("Couldn't reach the server — check your connection and try again."),
  keeping the original `TypeError` as its `cause` for debugging. Every web site
  that renders a rejection — ~45 of them, across the feed, comments, profiles,
  groups, events, messaging and the auth pages — goes through
  `serverMessage(err, fallback)`. Before that they read `err?.message ||
  fallback`, and since a `TypeError` *has* a message the fallback never ran:
  being offline is the most likely way any write fails, so the sentence written
  for exactly that case was the one that could never appear. Two consequences
  worth knowing: **a status check no longer distinguishes anything** (a network
  failure now carries a numeric status of its own — the web `RsvpBar` sniffed for
  one and had to change), and **`GroupMembersPanel` had no fallback to reach**,
  rendering `actionError.message` bare, so one had to be written. The rule now
  reads in one line: *the server's own words when it wrote any, ours otherwise,
  the browser's never.* Pinned in `frontend/src/offline-writes.test.jsx` and
  `api.test.js`. The mobile client has the same unguarded `fetch` at ~25 sites —
  tracked separately in #243. Its *second* unguarded `fetch`, on the token
  refresh path, is guarded as of #245, where the same root cause signed the user
  out rather than mis-wording a message — see
  [accounts.md](accounts.md#only-the-server-may-end-a-session-245).

- **A message is retired only by the server moving to the answer the attempt was
  reaching for** — the request landed and only its response was lost, so the
  message would now sit under the very thing it denies. Any *other* answer leaves
  it standing: a refetch bearing some third status isn't confirmation of your
  attempt, and clearing on any resync is the swallow issue #231 describes. Both
  halves are judged against what was recorded at the attempt, never against when
  the sync arrives, so a refetch landing in the same render batch as the
  rejection can't eat the message before it's painted. This is the discipline
  [events.md](events.md) records for the RSVP, applied to a four-state button;
  the phone doesn't need it, since an `Alert` is dismissed rather than kept.
  On a two-state control the two halves collapse into one comparison — see the
  reaction chips in [reactions.md](reactions.md#frontend) (issue #242), where
  the "answer" is simply whether that emoji is yours.

The disconnect and block paths additionally hold their confirmation modal open
until the write lands, so the failure has somewhere to go — see
[messaging.md](messaging.md#blocking) for why that matters most on the block.
**On mobile that hold is a tripwire**: it depends on `onlineManager` being left
unwired to NetInfo, because wiring it makes React Query *pause* an offline
mutation rather than reject it, and a dialog that refuses Cancel while busy would
then never let go. The deferral note in `mobile/src/app/_layout.tsx` names every
component that depends on it — add to that list, don't just add the dependency.

**Issue #254 made that hold the rule for every dialog that renders its own
rejection**, which is the *unmount* spelling of the same bug: the message is
written into a component that has already been torn down, so nothing renders
anywhere. The four that didn't follow it were `ReportModal` and
`DeleteAccountSection` on both clients, all of which left Escape, the backdrop,
Cancel and (on the phone) `onRequestClose` — the Android hardware back — wired
straight through while the request was open. `ConfirmDeleteDialog.jsx` had
already settled the pattern next door; these just hadn't adopted it. The
invariant is worth stating as a class rather than four instances: **a dialog that
is the only renderer of its own error may not be dismissable while that write is
in flight.** Reporting is the one that matters most — it's the safety path, its
success screen is a whole "Thanks for letting us know" panel, so a silent failure
is indistinguishable from never having pressed Send.

Two things a change here has to keep:

- **Release the flag the moment the write lands, not when the screen goes.** The
  gate exists so a *rejection* has somewhere to render; once the request has
  succeeded there's no rejection left, so holding it any longer only creates a
  second trap. Both `ReportModal`s stay mounted afterwards to show the thanks
  screen, so `submitting` clears alongside `done` or the gate would hold that
  screen shut behind its Done button. Both `DeleteAccountSection`s then do the
  same for a subtler reason: they lean on the screen being torn down, but the
  teardown is *itself* a network round trip — `logout()` on the web,
  `signOut()`'s `unregisterPush`/`logout` on the phone — and those are the one
  part of the flow that can hang. A gate held across them would seal someone into
  a "Deleting…" box with no way out. Both clear the flag right after the delete
  returns and keep the button spent with a separate `done`, so a second press
  can't fire a delete at a session that no longer exists. Pinned in
  `frontend/src/legal-safety.test.jsx`, `mobile/src/__tests__/safety.test.tsx`
  and `mobile/src/__tests__/settings.test.tsx`.
- These four run their request with plain `async`/`await` and `useState`, **not a
  React Query mutation**, so the `onlineManager` tripwire above doesn't reach
  them: an offline `fetch` rejects rather than pausing, and the gate lets go. Move
  one onto a mutation and it joins that list.

**Issue #259 widened it from dialogs to every shape a form takes**, on the web.
The rule was written about dialogs because that's where it was found, but nothing
in it is about being a dialog: an **inline** form that expands in place has no
backdrop and no Escape, and its Cancel unmounts it exactly the way a backdrop
click unmounts a modal. The tell in all nine was the same asymmetry — **Save
disabled while the write was in flight, and Cancel right beside it wasn't**:
`ProfileEditForm`, both write boxes in `CommentThread`, `PostCard`'s
`PostEditor`, `GroupInvitePicker` (whose "Close" is a Cancel by another name),
`PlanEventForm`, `ChangePasswordSection`, and — the two the sweep turned up that
the issue hadn't listed — `GroupFormPage`, where the dismissal is a **navigation**
rather than a collapse, and `PendingChatPanel`, where it's the drawer's chrome
(below). Two of them are worth naming for what silence costs:

- **Change password** leaves you wrong about your own credentials. Fill the three
  fields, press Change password, press Close; the 400 of *"Your old password was
  entered incorrectly"* lands in a section that has already collapsed, and you go
  on believing your password is the new one.
- **Plan an event** is a thing you do once, so "did that work?" isn't a question
  you get a second look at. You find out when nobody turns up.

Two things the gate must *not* copy from Save:

- **Gate on `isPending` alone, never on the submit button's own `canSave`.**
  Several of these compute one condition for both — empty text, unchanged
  fields — and a Cancel wearing it is a Cancel you can't press after clearing the
  box.
- **`isPending` isn't the write when `onSuccess` does more work.** React Query
  holds a mutation in its pending state for the whole of `onSuccess`, so a form
  whose success handler awaits a *second* request keeps the gate shut across it —
  and that request has nothing to report, so the hold is pure trap. That's the
  same "moved the trap rather than removing it" the bullet above records for the
  delete dialogs, and `ProfileEditForm` is where it bites on the web: its
  `onSuccess` awaits `refreshUser()`. It sets a `saved` flag first and its Cancel
  reads `isPending && !saved`, which is the rule stated exactly — *release the
  flag the moment the write lands, not when the screen goes.*

**Issue #258 is the case where the component can't gate its own route**, because
the route belongs to something above it. The messages drawer's Escape, ✕, Back
and nav button are all a level up from the panel doing the writing and can't see
its mutation at all, so the panel declares the write into messaging context and
the chrome reads the flag —
[messaging.md](messaging.md#the-drawer-holds-open-while-a-panel-inside-it-has-a-write-out-257258)
has the shape, including why a gate placed on the *mutation's* success path
instead would refuse the one call that has to work. **#257** is the same family
again with nothing unmounted at all: `stopEditing()` called `reset()`
unconditionally, which detaches the observer from a PATCH still on its way back.
All of these are pinned on the web in `inline-form-holds.test.jsx` and
`messaging.test.jsx`.

**The phone has all of this still open**, tracked separately: #256 (Android back
registered where the in-flight flag isn't in scope, at five forms), #261 (three
`Modal`s that cover the edit error's only renderer), and the mobile halves of
#257 and #259.

### A connection *is* the boundary, so its writes refresh everything it gates

`connected_user_ids` is the one set the feed, profiles, group timelines, comment
trees, the personal calendar and both event lists all check, so a write that
adds or removes an accepted connection changes what a dozen screens are allowed
to show — not just the button that made it. **The four writes that move it
therefore share one helper on each client** — `mobile/src/connectionCache.ts`
and `frontend/src/connectionCache.js`, both exporting
`invalidateConnectionChange`: the Connect button, the Block button (blocking
deletes the `Connection` row outright), the locked `PendingChatPanel`, and
approving from the requests inbox. It holds the relationship keys, the
`visible_posts`-gated content keys (`['feed']`, `['userPosts', id]`,
`['groupPosts']`, `['post']`, `['comments']`), the calendar/event family
(`['personalCalendar']`, `['groupEvents']`, `['groupCalendar']`, `['event']`,
`['eventPhotos']`) and the shared group chats that promote and sever with the
connection.

`['eventPhotos']` and `['event']` joined that family with the album
([events](events.md#6-an-event-carries-an-album-and-anyone-who-can-see-it-may-add-to-it)),
and they're the clearest illustration of why this list is a rule rather than a
habit. An album prunes on the **uploader**, so a connection write changes which
photos it may show *and* the count beside them — and because a card's preview
tiles ride the `event` payload rather than the album's, leaving `['event']` out
would refresh the album while the card next to it kept the old number. The
album shipped with **neither** key listed: connect with someone who had added
photos to an event you can both see, reopen it inside `gcTime`, and their
photos stayed hidden and the count stayed wrong.

Before that each site kept its own list, written from the point of view of the
screen it sits on, and the four had drifted apart (#278 on mobile, #288 on the
web) with the whole calendar/event family missing from every one of them (#285) —
the same shape as #215 / #273 / #275 / #277, which is why the rule now lives in
one file per client rather than being copied per call site. On the phone the
drift isn't a flash: the tabs stay mounted for the session, so a query there
keeps a live observer and never remounts, and `staleTime: 0` buys nothing
without something marking it stale. Block the person who organised a dated event
and it sat on your Calendar tab for the rest of the session, answering a tap with
*Event not available*.

On the web react-router unmounts a route and nothing sets a `staleTime`, so most
of it was a flash while the refetch was already on its way. **Two web cases
weren't**, because the write and the surface it invalidates are on the same
mounted page: approving on `/u/:id` flipped the button to "Connected" over a
timeline that stayed empty until you reloaded (`ProfilePage` mounts `['user',
id]` and `['userPosts', id]`, and only the first was refreshed), and blocking
there left that person's posts rendered — and your Connections list still listing
them — under a button now reading "Unblock".

The messaging keys are the one place it departs from the group-membership
helper, which leaves `['conversations']` / `['unreadMessages']` out as polled
and self-healing. The difference is what's on screen when the write is made: a
group leave only removes access and you make it from the Groups tab, where
connecting *grants* access and the locked `PendingChatPanel` is a screen you're
staring at waiting for it to open. A poll cycle of *"Connect with Dana to join
this chat"* after you already have is the bug, not a slow heal. The polled-key
rule still holds everywhere it isn't beaten by something the user is watching.

Two decisions worth keeping:

- **It doesn't fork on which transition it was**, unlike the group-membership
  helper ([groups.md](groups.md)). Only approving and disconnecting move the
  *accepted* set — sending or withdrawing a request leaves a `pending` row — but
  `connection_status` is a snapshot from a cached row that can change underneath
  an open screen: they accept while you're looking, and the DELETE you think is
  withdrawing a request ends a live connection. Forking on a stale prop would
  under-invalidate in exactly that race.
- **Rejecting an incoming request is the exception**, and keeps the narrow set
  (the inbox, its badge, that person's row). Not because the client reasons its
  way there, but because the *server* guarantees it:
  `ConnectionRequestActionView` 404s unless the row is still pending, so a reject
  that succeeds cannot have ended a connection. That's what made the inbox's
  mutation take the decision as a boolean rather than as an opaque `act`
  function — the same shape both invite inboxes settled on.

Pinned on both clients: `frontend/src/connection-cache.test.jsx` and
`mobile/src/__tests__/connectionCache.test.tsx`. Both mount the gated surfaces
*alongside* the component doing the write rather than seeding them into the
cache — a seeded but unobserved entry refetches on its next mount whatever the
helper does, so it would pass against the broken build.

## Comments (threaded, connection-pruned)

Posts have a **threaded comment tree** — `Comment` model: `post`, `author`,
`parent` (self-FK, null = top-level), `text`, `created_at`, plus `edited_at` /
`deleted_at` (issue #128).

- `POST /api/posts/<id>/comments/` adds a comment/reply on a post you can see
  (`author` from the session, never the body; optional `parent`).
- `GET /api/posts/<id>/comments/` returns the **pruned, nested** visible tree.
- `PATCH`/`DELETE /api/comments/<pk>/` edit or delete **your own** comment —
  including the reply-preserving tombstone and the extra prune it adds to the tree
  builder. That story lives in
  [feed-and-posts.md](feed-and-posts.md#editing--deleting-your-own-comment).

### The connection boundary (the important bit)

**You only ever see comments/replies from people you're connected with.** A comment
from a not-connected author — *and its entire subtree* — is invisible to you.

- **Why prune the whole subtree, not re-parent:** a reply from someone you *are*
  connected with, sitting under a comment from someone you *aren't*, is hidden too.
  This stops strangers being surfaced to you second-hand, and keeps the tree
  readable (you never see a reply whose parent you can't see). The point of the
  whole feature is to stop people "meeting strangers" by reading a thread.
- **How it's done — a per-viewer subtree prune in Python, not SQL.** Expressing
  "hide this node *and everything under it* when its author isn't connected" in one
  SQL query is hard at arbitrary depth. Instead the endpoint loads a post's
  comments in one query, builds the parent→children map, and walks from the roots:
  at each node, if the author isn't connected-or-self, the node **and its subtree
  are skipped** (we don't recurse into it). Cheap at this app's scale, obviously
  correct, and the client receives an already-pruned tree — hidden content never
  leaves the server.
- The visible set is `connected_user_ids | {viewer}`. For **group** posts,
  membership gates *access* to the post but does **not** widen who you see within
  it — you still only see comments from members you're connected with (see
  [groups](groups.md)).
- **Consequence (intended):** two viewers can legitimately see different comment
  trees on the same post. That's the privacy-correct behaviour, not a bug — and the
  same rule governs [reactions](reactions.md), [notification gating](notifications.md)
  (you're never notified of a reply or reaction from someone you can't see), and
  [group events](events.md) (`visible_events` applies this exact gate keyed on the
  event's organiser — with the deliberate **inversion** that a poll/RSVP *count*
  includes people you can't see, while their *names* stay gated).

### The boundary gates writing too (#211)

For a long time the prune was read-only: `POST /posts/<id>/comments/` checked that
`parent` was on the same post and wasn't a tombstone, and nothing else. So a reply
could be aimed at a comment your own tree had pruned away — you addressed someone
invisible to you, and *they* got a reply from a stranger in a conversation they'd
never invited one into. Nothing leaked (you still couldn't read the parent), but
it was the one place the graph gated reading and not writing. **`parent` is now
held to exactly the prune the GET applies.**

Two things that fix depends on, both easy to get subtly wrong:

- **`can_view_comment` had to become ancestor-aware first.** It claimed to mirror
  the pruned tree but only checked the comment's *own* author, and the tree's
  prune is a **subtree** prune — a connected friend's reply sitting under a
  stranger is hidden along with the branch. So the helper said "visible" about
  comments the tree would never show, and the obvious one-line fix
  (`can_view_comment(user, parent)`) would have left the hole half-open.
  `_comment_chain_visible` now walks from the comment up to a root, requiring
  every author on the way to be active and visible; deactivation is checked at
  each level too, since the tree builder drops banned authors *before* walking
  and orphans everything under them. It loads the post's comments in one query
  and climbs in Python — the same trade, for the same reason, as the tree builder
  itself, and `comment_counts_for_posts` already documented this exact trap for a
  naive author-filtered `COUNT`. Because it's the shared helper, comment
  **reactions** and **reports** were closed by the same change; they were open in
  precisely the same way.
- **All the rejections have to be one rejection.** Unknown id, wrong post and
  invisible parent previously answered differently — DRF's *"object does not
  exist"* against our *"only reply to a comment on this post"* — which made the
  endpoint a comment-id existence oracle, and a distinct "you can't see that"
  would have confirmed the existence of the very comment being hidden. They all
  return `PARENT_UNAVAILABLE` (`serializers.py`) now, and **as the same JSON
  shape**: the view raises it inside a list, because `{"parent": "…"}` against
  `{"parent": ["…"]}` separates the cases just as well as the wording would.

  **The tombstone is the fourth case, and it's conditional.** A deleted parent
  answers *"That comment was deleted, so you can't reply to it"* — which is the
  right, more useful sentence while your thread still shows the tombstone, and
  an oracle once it doesn't. The tree builder's *second* prune drops a tombstone
  the moment it stops holding anything up, and that state is reachable: a soft
  delete leaves the tombstone, then its last reply is hard-deleted out from
  under it. So the reply path checks whether this viewer's tree still renders it
  (`build_visible_comment_tree` rooted at the parent) and falls back to
  `PARENT_UNAVAILABLE` when it doesn't. That rule is **not** folded into
  `can_view_comment`: reactions and reports want their own explicit
  deleted-content messages, and it costs a subtree walk only this path needs.

Pinned in `ReplyVisibilityTests` (`backend/api/tests.py`), including the
connected-author-under-a-hidden-parent case that a per-comment check passes, the
tombstone before and after it empties, and the report path — whose only previous
visibility test used a stranger's *own* comment, which the old check caught
anyway.

### Frontend

Collapsible comment thread (accordion) with an inline reply composer on each post.
Replies start **collapsed**, so a busy post opens as a clean list of top-level
comments each with a "Show N replies" control; opening a reply box (or having just
posted a reply) auto-reveals that sub-thread so your own reply is always visible.
