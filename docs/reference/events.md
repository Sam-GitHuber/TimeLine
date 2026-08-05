# Group events & planning calendar

Members of a [group](groups.md) can **plan events together** — a family birthday, a
book-club night, a camping weekend — each with a title, date, time and location,
shown on a calendar and on the group's timeline. The distinctive part: an event
**doesn't need a settled date to exist**. The organiser can open an **advisory
poll** on any dimension (date, time, location, or a custom question), members vote,
and the organiser makes the **final call** — the poll never auto-decides. Still no
algorithm: the calendar is time-ordered, events surface by *when they are*. An
event also carries a **photo album** anyone who can see it may add to, before,
during and after. This is the current-state reference.

Code: `Event` / `Poll` / `PollOption` / `PollVote` / `EventRSVP` / `EventPhoto`
models + `Notification.event` FK; `visible_events` / `can_view_event` (the
connection gate, keyed on the organiser) and the event/poll/RSVP/photo/calendar
views in `api/views.py`; the `serialize_event` / `serialize_poll` /
`build_rsvp_summary` / `serialize_event_photo` builders in `api/serializers.py`
and the `event_photo_previews` helper in `api/views.py`. Frontend: the
`EventsSection` + `MonthGrid` on `/g/:id`, the `EventPage` detail
(`/g/:id/events/:eid`, the notification deep-link target), the personal
`CalendarPage` (`/calendar`), and the `DimensionChips` / `DimensionEditor` /
`PollTally` / `RsvpBar` / `EventCard` / `EventPhotos` components under
`frontend/src/components/events/`.

## The four load-bearing decisions

### 1. Events follow the *same* connection gate as posts — anchored on the organiser

Not a special case — it's the app's one visibility rule ([connections](connections.md))
applied consistently. Inside a group, whose *posts* you see is gated by connection,
not membership. An event is authored content, so it goes through the same gate,
keyed on the event's **organiser** instead of a post's author: **you see an event
iff you're an active member of the group and connected to its organiser** (or are
the organiser). `visible_events(group, viewer)` reuses `connected_user_ids`; an
event you're not connected to the organiser of is a **404** — it doesn't exist for
you, exactly like their posts never reaching your feed. A block deletes the
`Connection` row, so a blocked organiser's events drop out for free.

**Accepted consequence** (identical to the group timeline): each member sees a
*partial* set of a group's events — "my connections' events under a shared label",
not one identical shared calendar. Same choke point, no group-specific branch.

### 2. Within a visible event, **counts are complete but names stay gated**

The subtle part. An event's audience is "the organiser's connections in the group",
and two people in that audience can both be connected to the organiser without
being connected to *each other*. So when you open an event you can see:

- **Counts are complete.** Every poll tally and RSVP total counts **every**
  participant in the audience — including people you aren't connected to. A partial
  count would mislead a group decision ("only 2 free on Saturday" when really 5
  are); the honest number is the whole point of a planning poll.
- **Names stay gated.** You see *who* voted / who's going only for participants
  you're connected with. Everyone else adds to the count as an anonymous +1.

This is a deliberate **inversion** of the [reactions](reactions.md) rule (where a
non-connection's reaction doesn't even count): a reaction is a personal signal, an
event tally is a shared coordination number. Implemented in `build_poll_results` /
`build_rsvp_summary`: the count is over all rows, `voters` / the named lists are
filtered to `visible_ids` (you + your connections). Because the audience *is* the
organiser's connections, the **organiser is connected to everyone in it** and sees
every name with no special carve-out — the single gate does the right thing.

### 3. Polls are advisory — the organiser's finalise is the decision

A poll **never auto-decides**. Closing a poll and finalising a dimension are two
distinct, explicit organiser actions, and `finalise` accepts **any value** —
including one no one voted for ("actually, let's do Friday"). It's encoded in the
API (`finalise` takes a `value`, not a poll id) and the copy ("Set the date", never
"close poll → winner wins"). The tally *informs*; the organiser *decides*.

### 4. The calendar is the timeline's forward mirror

The feed is a living line you scroll *down* to travel back through your days. The
calendar is its dual — **the same line, ahead of now**. On the group page,
upcoming events extend the spine *upward* (the `EventsSection` sits above the
composer "now" node); a passed event **falls down into the group timeline among the
posts** as a quiet recap card (`Timeline` merges past events with posts by time). A
conventional **month grid** rides alongside for practical planning, and the
personal **`/calendar`** unions upcoming events across all your groups.

### 5. An event is authored content, so it carries comments and reactions

Not a fifth pillar so much as the consequence of the first: if an event goes
through the same gate as a post because it *is* authored content, then it gets
the same pair of things a post gets. "Are we still on for Saturday?" previously
had nowhere to go but the group timeline, detached from the plan it was about.

Both widen an existing model rather than adding a parallel one, which is the
shape this codebase already chose for [reactions](reactions.md) when messages
arrived: `Comment` takes an `event` FK (with `post` now nullable behind a
`comment_targets_exactly_one` check constraint), and `Reaction`'s three-way
constraint becomes four-way. That keeps **one** tree builder, one connection
prune, one edit/delete route, one reply rule and one emoji validator — an
`EventComment` would have been five places for those to drift apart.

**The gate is the only thing that differs.** `can_view_comment` routes an event
comment through `can_view_event` instead of `can_view_post`; everything above it
is identical. The two gates **compose rather than overlap**: you can be able to
see an event (connected to its organiser) and still not see a given comment on
it (not connected to its author) — precisely the group timeline's behaviour, one
level down.

**Reactions on an event are pruned per viewer, like a post's** — deliberately
*unlike* the poll and RSVP tallies sitting a few pixels above them. Both rules
now live on one page on purpose, and the split is decision 2's, read the right
way round: a poll tally and an RSVP count are shared coordination numbers, so
they count everyone; a reaction is a personal signal, so it counts only you and
the people you may see. The rule follows the thing being counted, not the page
it sits on. Pinned side by side in `EventReactionTests`.

**Both surfaces carry the row: the event page, and the group feed.** On the feed
an event entry reads as part of the one line, so it gets the one line's
affordances — react in place, and follow the count through. **The thread itself
does not expand there**, unlike a post's, which unfolds inline: a post *is* the
content, whereas an event's conversation sits beside its polls, its RSVP and its
chips, and unfolding all of that into a timeline row would bury the posts below
it. So the count is a link. On the phone the group page's **upcoming** region is
`EventCard`s rather than timeline entries (the web uses `EventTimelineEntry` for
both), so that card takes a `showActions` prop — **on there, off in the calendar
agenda and the month grid's day lists**, which are indexes you tap through
rather than act in.

Two traps in the widening, both now closed by construction and worth knowing
before touching this code:

- **`post_id IS NULL` is true of *every* event comment.** Any query reaching for
  it without checking which target is set silently widens from "this thread" to
  "every event thread there has ever been" — a correctness bug in the tree walk
  and a leak in anything reading authors out of the result. Hence
  `comment_thread_filter`, which makes the choice once.
- **The notification deep-link read `comment.post_id` unconditionally**, which
  for an event comment renders `/p/None?comment=…`: a link that looks real and
  404s on arrival.

### 6. An event carries an album, and **anyone who can see it may add to it**

The one write on an event that isn't the organiser's. Polls, finalising and
cancelling are theirs by decision 3; the photos from a day out belong to whoever
took them, and an album only one person may fill is a gallery rather than a
shared memory. Before, during and after — a past event is precisely when the
photos exist, so `EventPhoto` is allowed on a **past** and on a **cancelled**
event exactly as the comment thread is.

**Photos prune per viewer, on the uploader.** You see the organiser's and your
connections' — the [comments](#5-an-event-is-authored-content-so-it-carries-comments-and-reactions)
rule, deliberately *not* the complete-count rule the poll and RSVP tallies a few
pixels above them follow. It's decision 2 read the right way round for a third
time: a tally is a shared coordination number, so it counts everyone; a photo is
authored content with an author of its own, so it goes through the one gate.
The alternative would have made an album the first place in TimeLine that shows
you content from someone you never connected to — a widening of the app's single
visibility rule, on its most sensitive content type.

**Accepted consequence:** two people at the same event see different albums, and
neither sees the whole thing. So `photo_count` is *your* slice, not the album's
size, and both clients' empty state says "No photos here yet" rather than
claiming there are none. The **album cap** is the one number counted over
everyone (see below) — it's a storage bound, not a visibility rule, and counting
only the uploader's own slice would let the true total drift past it one
connection-group at a time.

**A photo is a `PostImage` with an uploader**, and that field is the whole
difference between the two models: a post's images have no author of their own
(they inherit the post's, and the post's gate covers them), while an album has
many authors under one event. Everything else is shared — the same
`process_image`, so EXIF/GPS stripping and the HEIC transcode are inherited
rather than re-implemented, and the same grid + lightbox on both clients (see
[feed-and-posts](feed-and-posts.md#photo-layout--the-full-screen-viewer)).

**Removing one is the uploader's, the organiser's, or a group admin's** — an
album anyone can add to needs someone who can take something out of it, and
organiser-or-admin is the moderation pair that already cancels and deletes the
event. The 404/403 split is `PostDetailView`'s, unchanged.

🔒 **The album filters `uploader__is_active`, in both queries.** Deactivating an
account is the maintainer's takedown lever and has to reach *everything* that
account authored — `visible_posts`, `_comment_counts` and `visible_events` all
carry the same filter, and `connected_user_ids` deliberately doesn't, so every
consumer of that set has to apply it. Both the album query and
`event_photo_previews` need it, and need to agree: otherwise the grid on a card
and the album it opens report different counts.

## Concepts & lifecycle

An **event** is a bundle of decisions. Each **dimension** (date / time / location /
custom) is independently `unset` (no value, no poll), `polling` (a poll is open),
or `set` (a value is fixed) — the organiser drives them in any order. The **event**
itself has a status derived from its dimensions on write (`_recompute_event_status`):

- **planning** — created; no date yet. Lives in the "being planned" staging strip,
  off the line (no slot in time).
- **scheduled** — a **date** is set (time optional). It lands on the spine and the
  month grid. Date-only renders all-day; date + time renders timed.
- **cancelled** — called off; kept as a **tombstone** (RSVP'd members are notified,
  history stays honest) rather than deleted.
- **past** — *derived, never stored* (`Event.is_past`; a cancelled event is never
  "past"). A **timed** event is past once its start time passes; an **all-day**
  event once its whole day ends in its own timezone (so a today all-day event is
  still current, not aged out at midnight). The `upcoming`/`past` window split keys
  off this (via `_event_is_over`), **not** the raw date — so an event earlier today
  moves to the past region right away instead of lingering until midnight. A past
  event drops out of "upcoming" and falls into the group timeline as a memory.

"Must-have = date only" is intentional: title + date is enough to be a real event.

## Data model (`backend/api/models.py`)

- **`Event`** — `group` (CASCADE), `organiser` (**CASCADE** — the gate needs a
  living organiser, unlike `Group.creator`'s SET_NULL; see departure below),
  `title` (required), `description`, `event_date` (null until set; the calendar
  key, indexed), `start_time` / `end_time`, `timezone` (one IANA name per event — a
  documented simplification), `location_name` / `location_url` (an organiser-pasted
  link, **no geocoding**) / `location_note`, `status`. `starts_at` and `is_past`
  are computed properties. Index `(group, event_date)`.
- **`Poll`** — `event` (CASCADE), `dimension`, `question`, `allow_multiple`
  (pick-one vs pick-any; **seeded** from the per-dimension default — true for
  date/time, false for location/custom — but the organiser can choose it when
  opening a poll and change it later via the edit while unvoted), `status`
  (`open` /
  `closed`), `closes_at` (a **soft** deadline — stops new votes, does *not*
  auto-finalise), `decided_option` (the pinned option for a finalised **custom**
  poll; built-ins write the event's fields instead). **At most one open poll per
  built-in dimension per event** — enforced in the view.
- **`PollOption`** — `poll` (CASCADE), `label`, one typed value column per
  dimension (`date_value` / `time_value` / `text_value`), `order`. Organiser-
  authored in v1.
- **`PollVote`** — `option` (CASCADE), `voter` (CASCADE), `UniqueConstraint(option,
  voter)`. Single-choice polls additionally enforce one vote per `(poll, voter)` in
  the view (a new vote replaces the old); multi-choice accumulates.
- **`EventRSVP`** — `event` (CASCADE), `user` (CASCADE), `response` (going / maybe /
  declined), `guests` (a "+N" headcount), `note`, `UniqueConstraint(event, user)`
  (upsert).
- **`EventPhoto`** — `event` (CASCADE), **`uploader`** (CASCADE — the field a
  `PostImage` doesn't have; the prune keys on it), `image` / `thumbnail` (written
  by `process_image`, own `events/` media subdir so ops can tell them apart from
  post photos), `width` / `height`, `created_at`. Ordered oldest-first (an album
  reads as the event unfolded, unlike the feed), index `(event, created_at)`.
  Caps in `imaging.py`: **`MAX_PHOTOS_PER_UPLOAD` = 10** (bounds the work one
  request makes Pillow do synchronously — same reasoning and number as a post's)
  and **`MAX_PHOTOS_PER_EVENT` = 200** (bounds the *album*, which no per-request
  limit can, since an album is added to over the life of an event).
- **`Notification.event`** FK (the fifth concrete target) + five new kinds; the
  `CheckConstraint` widened to "at most one of five targets set". See
  [notifications](notifications.md).

## API (`api/urls.py` / `api/views.py`)

Two gates, mirroring the group timeline: **membership** gates the group's event
endpoints (non-member → 404); each **individual event is connection-gated to its
organiser** (`can_view_event`; a 404 if you're not connected). Managing an event is
the organiser's; cancel/hard-delete is the organiser **or a group admin**.

**Events** — `GET/POST /api/groups/<gid>/events/?window=upcoming|past|all`
(list you-can-see / create, any member); `GET/PATCH/DELETE /api/events/<id>/`
(detail / edit non-scheduling fields / hard-delete); `POST /api/events/<id>/cancel/`
(soft-cancel, notifies going/maybe).

**RSVP** — `PUT /api/events/<id>/rsvp/` (upsert); `GET /api/events/<id>/rsvps/`
(full counts + gated named lists).

**Polls** — `POST /api/events/<id>/polls/` (open, organiser); `GET/PATCH/DELETE
/api/polls/<id>/`; `PUT /api/polls/<id>/vote/` (`{option_ids}` — your full
selection, replaces prior votes; open polls only); `POST /api/polls/<id>/close/`
and `POST /api/polls/<id>/reopen/` (organiser, no decision — the tally just
freezes / resumes). `POST /api/events/<id>/finalise/`
(`{dimension, value?, option_id?, close_poll?}`, organiser) — writes the built-in
field or pins a custom outcome, recomputes status, notifies.

**Calendar** — `GET /api/groups/<gid>/calendar/?from=&to=` (one group's dated
events for the month grid); `GET /api/calendar/?from=&to=` (personal union across
every group you're an active member of — a pure time-merge, the same discipline as
the `include_groups` feed toggle).

**Photos** — `GET/POST /api/events/<id>/photos/` (the album, pruned to the
uploaders you may see and **paginated** — unlike a post's ten, an album is added
to over an event's life; add photos, any member who can see the event, multipart
under `photos`); `DELETE /api/event-photos/<id>/` (uploader / organiser / group
admin). Both verbs go through `can_view_event`, the same wall as everything
else here. `serialize_event` carries **`photos`** (the first
`EVENT_PHOTO_PREVIEW_COUNT` = 4, for the card grid) and **`photo_count`**, on
the same terms as the comment counts: **every list that renders an event pays
for them**, because a payload that skipped them says `[]`/`0` and that is
indistinguishable from an empty album. `event_photo_previews` gets both in
**two bounded queries** — a `RowNumber` window for the tiles plus one aggregate
— never a `prefetch_related("photos")`, which would drag up to 200 rows per
event back to render four tiles. The window's `order_by` must match the model's
`Meta.ordering`, or a card's first four are a different four from the album's
first page.

**Comments & reactions** — `GET/POST /api/events/<id>/comments/` (the pruned
tree / add a comment or reply); `POST /api/events/<id>/react/` and
`GET /api/events/<id>/reactions/`. Editing, deleting and reacting to an
individual comment all go through the **existing** `/api/comments/<id>/` routes,
which never needed to know what the comment hangs off. `serialize_event` carries
`reactions`, `comment_count` and `new_comment_count`; **every list that renders
an event pays for its counts** (one query per page, via
`comment_counts_for_events`), because a payload that skipped them says `0` — and
`0` is indistinguishable from an event nobody has commented on.

A **cancelled** event keeps its thread, readable and writable. The tombstone is
kept so RSVP'd members can see what happened, and "sorry, can't do the new date"
is exactly the conversation a cancellation starts; closing the thread at the
moment it becomes most useful would be the wrong reading of what the tombstone
is for. A past event likewise — a recap is a fine place to say thanks.

The scheduling fields (`event_date` / `start_time` / `location_name`) are written
**only** through `finalise`, never the event PATCH — so decision 3 and the status
recompute stay in one place. The event PATCH covers title, description, location
link/note, timezone, end time.

**Editing a poll (`PATCH /api/polls/<id>/`).** The organiser can fix a poll's
`question`, its `allow_multiple` (pick-one vs pick-any), and its `options`, but
**only while the poll has zero votes**. When `options` is given it is the **full
desired set** (the edit form is the create form pre-filled): an entry with an
`id` rewrites that option, an id-less entry is new, and any existing option the
set omits is deleted — the same "at least two" and the same create-time
normalisation (so labels re-derive). The first `PollVote` freezes everything: no
vote can be redefined *or orphaned*, which decision 2's honest-coordination-number
principle demands. The guard is server-side (a **409** if any vote exists), never
trusting the hidden UI; a `vote_count` on the poll payload lets the client hide
the affordance too. An edit never re-notifies (`poll_opened` already fired).
Closing freezes the tally without deciding; `reopen` resumes voting, re-checking
the one-open-poll-per-built-in-dimension rule so it can't create a second live
date poll.

## Notifications

Five new kinds, generated by explicit `create_notification(...)` calls in the event
views (the same choke-point pattern as [notifications](notifications.md), not
signals). The actor is always the **organiser**, so they ride the existing
connection gate — a row only reaches members connected to the organiser (precisely
the audience that can see the event), with **no new gating code**. All five are
**mutable + default-on** in `/settings`. Payload is push-ready (`text` / `url` →
`/g/<gid>/events/<eid>` / `target {type:"event", id}`), so Phases 9–10 add
transport only.

| Kind | When | Recipients |
|---|---|---|
| `event_created` | event created | members connected to the organiser |
| `poll_opened` | a poll opens | members connected to the organiser |
| `event_scheduled` | a **date** is first finalised | members connected to the organiser |
| `event_updated` | a scheduled event's date/time/location changes | going/maybe RSVPs (de-duped while unread, like reactions) |
| `event_cancelled` | event cancelled (or organiser departs) | going/maybe RSVPs |
| `event_comment` | someone comments on an event | its **organiser** |
| `event_photos` | someone adds photos to an event's album | **going/maybe RSVPs** (incl. the organiser), de-duped while unread |

`event_comment` is the event twin of `post_reply`. A *reply* to an event comment
reuses `comment_reply`, because the recipient and the target are the same
question there whatever the thread hangs off; only "someone commented on the
thing you made" needs to know it was an event, since it targets the `event` FK.
Its Android channel is **`replies`, not `events`** — the channel groups by what
the notification *is* to the person getting it, and this is somebody answering
you, where the five `events` kinds are the organiser broadcasting. Filing it
with them would mean quietening a busy group's plans also quietened people
talking to you. `see_event_notifications` matches `comment__event` as well as
`event`, so reading a reply on an event stops the badge counting it — the
`comment__post` half `see_post_notifications` has always had.

`event_photos` is the one event kind where the **connection gate does real
work** rather than belt-and-braces. The five broadcasts ride it for free because
their actor is the organiser and the audience *is* the organiser's connections;
this one's actor is the **uploader**, and two people in an event's audience
needn't be connected to each other — so a going/maybe RSVP who can't see the
uploader's photos must not be told about them, or the deep-link lands on an
album that doesn't contain them. Putting the kind in `_CONNECTION_GATED_KINDS`
makes that filter the same one line every content kind already uses; no
event-specific gating code. It's also in `_DEDUP_KINDS`, because people upload
in batches (eight now, four more when they notice them) and that's one thing
that happened — one row, and since `PushOutbox` is only written for genuinely
new notifications, one buzz. Its Android channel is **`events`**, not `replies`:
an announcement *about* the event, not somebody answering you. Its text carries
no count, deliberately — a de-duping row would be stating the first batch's
number. **Known edge:** an organiser who never RSVP'd isn't told, since the
recipients are the RSVP list; the album is on their event page either way.

## Organiser departure

The gate needs a *present* organiser. Two paths:
- **Account deletion** — `organiser` is CASCADE, so the events simply go with the
  account.
- **Leaving / being removed from the group** — `cancel_events_on_departure` (called
  from the membership-delete view) **soft-cancels** their events there and notifies
  going/maybe RSVPs. An admin "adopting" an orphaned event onto themselves is a
  future extension.

## Frontend notes / deliberate deviations from the phase sketch

- **Every event write refreshes the same five keys**, via `EventPage`'s one
  `invalidate()`: `['event', id]`, `['eventPhotos', id]`, `['groupEvents',
  gid]`, `['groupCalendar', gid]` and `['personalCalendar']`. The album is the
  fifth and belongs in the same one call for the same reason the others do:
  adding or removing a photo moves the grid on the event page *and* the preview
  tiles + "+N" on every timeline entry and calendar card, which ride the
  **event** payload rather than the album's. A photo write naming only
  `['eventPhotos']` would leave the card beside it stating the old count —
  #279's shape, one surface further out. An event lives on four surfaces, and a write
  that names fewer leaves the others stating the old answer. Two drifts made that
  the rule rather than a convention (#279, both web-only — mobile has invalidated
  all four on every event write since it was built): **delete** named
  `['groupEvents']` alone and navigated, so the group's Month grid painted the
  deleted event from a stale `['groupCalendar']` on the very page it lands you
  on; and `['personalCalendar']` was read by `CalendarPage` and invalidated by
  **nothing** anywhere in `frontend/src`, so setting a date, cancelling or
  deleting left `/calendar` stale. A key nothing points at from the write side is
  exactly how a surface gets missed. Pinned in `frontend/src/events.test.jsx`
  ("what an event write refreshes"). Creating an event is the one write that
  correctly stops at `['groupEvents']`: `createEvent` takes no date, and both
  calendars filter `event_date__isnull=False`, so a new event cannot be on
  either. A connection change refreshes all three of the calendar/event keys too
  — see [connections.md](connections.md).
- **The chip row is the organiser's control surface** (the plan's "lights chips up
  in any order"), not just a status display. On `EventPage`, an unset built-in chip
  carries inline **Set · Poll** affordances (and a *set* chip carries **Change ·
  Poll**, so a decided dimension can still be re-opened to the group); clicking
  opens *one* contextual `DimensionEditor` beneath the row (scoped to that
  dimension — no picker), and a set value flips the chip ghost→filled. The date and
  time set-inputs are **segmented, auto-advancing** boxes (type `19` `07` `2026`,
  or `10` `00` — focus hops to the next box, no Tab; date is `DD/MM/YYYY`, labelled;
  both hand the API ISO/`HH:MM`). A brand-new, undecided event shows a first-step
  hint so the empty state invites action. Members see the same chips as read-only
  status. (The earlier build split display from a separate always-visible toolkit;
  that was replaced because a freshly-created event wasn't obvious to use.)
- **Upcoming events hang off the timeline spine, above the now-node**, as
  post-shaped entries (`EventTimelineEntry` — the poster-style avatar marker on the
  line, a mono **accent** date on the rail, title/organiser/when/chips in the
  body). A future event reads apart from a past post by its *position* (above now)
  and the accent date, not a permanent ring — the marker's accent ring is
  hover-only, exactly like a post.
  `Timeline` renders them above its `header` (the composer), so it's **one
  continuous line**: future above, now, past below. They're ordered **furthest-
  first**, so the nearest event sits just above now (scroll up = travel forward).
  Date-less "being planned" events sit in a small staging strip off the line just
  above now; **`GroupPage` scrolls to a `.tl-now-anchor` on load** so the now-node
  rests at the top with the future above the fold, a quiet **"↑ N upcoming ↑" cue**
  points up to it, and a **"back to now" pill** returns you from either direction.
  The one simplification left from the phase sketch is the *animated* staging→slot
  transition (a finalised date just re-places the entry). A **Timeline/Calendar
  toggle** in the sticky header swaps the spine for the month grid.
- The **month grid** (`MonthGrid`) renders each event *in its day cell* as a small
  titled chip (mono time + title, accent when scheduled, muted when past, struck
  through when cancelled), linking to the event; a busy day shows the first few and
  a "+N more" that expands the full day list beneath the grid.
- The group page's actions (**Plan an event**, Invite, Members, Start a chat,
  Leave, and — for admins — Edit, Delete) live behind a single
  **`GroupActionsMenu`** ("⋯"); choosing "Plan an event" reveals the plan form at
  the now boundary (inset via `.tl-inset` so its inputs clear the spine). The
  header (name · ⋯ · description) is a **second sticky bar pinned directly under
  the nav** (`GroupPage` measures the nav height so it stacks correctly), so the
  group's identity stays put while the upcoming region and timeline scroll up
  behind it — and the now-node's scroll-margin clears *both* sticky bars.
- Past events are merged into the group `Timeline` **on the spine** among the
  posts — the *same* `EventTimelineEntry` as a future event, in its `variant="past"`
  recap form: the rail shows the clock time like a post (the day divider carries the
  date), and the body drops the planning chips for a one-line mono recap + turnout
  ("6 went"). So an event looks the same threading the line whether it's ahead of
  now or behind it — not a boxed card wedged into the spine. (`EventCard`, the boxed
  form, is still used *off* the line — the staging strip, month day-lists, the
  personal calendar agenda.)
- **An event is placed on the line by its own wall-clock start, never by the
  `starts_at` instant** (`eventLocalStart` — `frontend/src/utils.js` and
  `mobile/src/eventFormat.ts`; used by the web `Timeline`, mobile `toGroupRows`,
  and the upcoming sort on both group pages). An event's day is a calendar date
  in the *event's* timezone, and the card renders that wall clock verbatim —
  `starts_at` is the same moment expressed as an instant, so reading it back in
  the **viewer's** zone moves it. An all-day event starts at midnight in its own
  zone, which anywhere west of that zone is the evening *before*: it used to be
  filed under the previous day's divider, contradicting the recap directly
  beneath it (#126; `Event.timezone` defaults to `settings.TIME_ZONE` = UTC, so
  this hit every viewer in the Americas). Using the same value to sort *and* to
  group also keeps the divider algorithm's invariant — every row's day key is
  the local day of the value it was sorted by — which is what makes the dividers
  come out in order and only once each.
- **A tick in the tally is optimistic, and owes two debts for it** (#216). It
  appears the instant you click, before the server has agreed, so `PollTally`
  (a) takes it back and shows the error if the request is rejected, which is why
  `EventPage` hands voting down as `mutateAsync` rather than `mutate` — the
  rejection has to reach the component holding the tick — and (b) re-derives your
  ticks whenever `poll.your_votes` *changes* (compared by contents, not identity —
  every refetch brings a fresh array), so a vote cast on another device shows up
  here. Without the rollback a dropped vote is invisible: the tally not moving
  reads as "nobody else has voted yet", and you believe you answered while the
  organiser counts you as silent — the worst failure available to a feature whose
  job is collecting answers before a date.
- **The RSVP's guests and note are yours to type, and the server's to correct**
  (#229). They're local state seeded from `rsvp.your_response` — which changes
  under a *mounted* event page on every refetch, since each RSVP/vote/finalise
  here ends in an invalidate. Seeded once, they drifted stale beside the
  `+ N guests` summary read from the fresh payload, and pressing **Update** then
  posted the stale number back, silently reverting an RSVP made on the other
  client. So they're **re-derived whenever that answer changes, compared by
  contents** — the same discipline as the poll ticks above; a refetch hands back
  a fresh object every time, and comparing identity would wipe what you're
  half-way through typing. `RsvpBar` gets the mutation as **`mutateAsync`** for
  the same reason `PollTally` gets voting: a rejected PATCH is otherwise
  *completely* silent, the fields keeping your text as though it saved while the
  count not moving reads as "nobody else has RSVP'd yet". **Its rejection keeps
  your typed values** and states the failure in place — deliberately unlike the
  poll tick's rollback, because a tick is one click to redo and a note isn't, so
  the message does the work and Update retries as typed. (Only the server
  outranks them: a later answer arriving from elsewhere re-seeds the fields per
  the rule above, and the message stands, since your attempt still didn't land.)
  That message retires **only** when the server *moves to* the very answer that
  failed — the request landed and only its response was lost. Both halves of
  that are judged on keys recorded **at the attempt**, never on when the sync
  arrives, so it survives a refetch landing in the same render batch as the
  rejection (the trap #231 describes), an unchanged re-press, and a refetch
  bearing some third answer alike. Only the server's own words are shown, and
  offline is exactly the case the fallback exists for. **Both clients, one PR** —
  splitting #216 from #227 is what left the phone lying for a day. The two copies
  stay behaviourally identical; they differ only in how each spots a
  server-authored error. On the web that is `serverMessage`'s `fromServer` flag
  (see [connections.md](connections.md#reporting-a-refused-write)): it used to be
  a numeric-`status` sniff, which #240 retired when it made `api.js` re-raise a
  network failure as an `ApiError` carrying `status: 0` — a status check stopped
  separating anything the moment offline had one. Mobile still sniffs an
  `ApiError` instance, and has the same unguarded `fetch` the web did (#243).
- **Every organiser write on this page reports its own rejection, beside the
  control that was pressed** (#237). The two bullets above gave the RSVP and the
  vote a rejection path as each was reported; the organiser's other five —
  `closePoll`, `reopenPoll`, `deletePoll`, `cancel` and `remove` — still had
  `onSuccess: invalidate` and nothing else, on both clients. `onSuccess` is the
  only place anything repaints, so a rejection left the page byte-identical to a
  success. **Cancel is the one that matters**: you confirm a dialog that promises
  the people who RSVP'd will be told, the request 403s, and the event never gets
  its Cancelled tag, no `event_cancelled` notification goes out, and nothing says
  so — you find out when they turn up. A refused **close** is the same shape with
  a slower fuse: the poll stays painted open and votes keep arriving into one you
  believe you froze. Where the message goes follows
  [connections.md](connections.md#reporting-a-refused-write): the server's own
  words when it wrote any, a **per-state** fallback of ours otherwise ("Couldn't
  close the poll", not "something went wrong" — *which* of the organiser's six
  actions didn't happen is most of the value). Mobile alerts, since an `Alert`
  outlives whatever is on screen; the web renders inline.
  - **Which component owns the message is the load-bearing part.** On the web
    every renderer now sits in the component that owns the button, which is what
    closed a hole the same issue found: `finalise`'s error paragraph lived inside
    `EventPage`'s `{editing && …}` block, but `PollTally`'s per-option **Set/Pin**
    finalises with the editor *closed*, so on that path the renderer wasn't
    mounted and the rejection had nowhere to appear at all. So `PollTally` owns
    the lifecycle actions and Set/Pin (the same `mutateAsync` handoff it already
    had for `onVote`/`onEdit`, kept in a **separate** state from `voteError` —
    that one is retired by a resync, and a refetch triggered by some *other*
    write is no answer to "did my Remove poll go through?"), `DimensionEditor`
    owns Set and Open poll, and only `cancel`/`remove` — whose buttons are on the
    page — are rendered by the page. Mobile needed none of this restructuring —
    an `Alert` isn't part of the tree that raised it, which is the same property
    that makes it the phone's answer to #261.
  - **Everything that could dismiss the editor is held while its write is out**,
    which is the other half of the same rule — it is now the only renderer of
    that message, so it may not be dismissed before the message arrives. That's
    three routes, not one: its own **Cancel**, and the **chip row** above it,
    where picking a different chip swaps the editor out just as effectively.
    (`DimensionChips` therefore takes a `busy` prop; it doesn't hold the *goto*
    jump on a polling chip, which only scrolls.) The Cancel gates on **this
    editor's** write rather than the page's `busy` — #254 scopes the hold to the
    write whose message would be lost, and a Cancel held shut by somebody else's
    vote is wider than the rule asks for. The editor is additionally **keyed on
    `dimension:mode`**, as mobile's copy already was: one instance is otherwise
    re-propped from chip to chip, so a *settled* rejection from the Date editor
    would sit on under the Where form you moved to.
  - The **free-value box** beside a poll keeps what you typed when the finalise
    is refused, rather than clearing it as it does on success. A rejection that
    also wipes the value means the retry is "type it again".
- **The album appears on three surfaces, and only two of them are the album.**
  The **event page/screen** gets the full section (`EventPhotos.jsx` /
  `EventPhotos.tsx`) — grid, **Add photos**, and a Remove in the viewer on any
  photo whose payload says `can_delete`. A **timeline entry**
  (`EventTimelineEntry`, both clients) gets the first **four** tiles in the
  post grid, with a **"+N"** on the last when `photo_count` exceeds them: an
  event entry reads as part of the one line, so its photos look like the line's
  photos. Drawn on a past recap as much as on a future entry — "after" is where
  most event photos land. **`EventCard` gets no grid**: it's the off-the-line
  form used by the staging strip, month day-lists and the calendar agenda,
  which are indexes you tap through rather than act in — the same reason it
  takes `showActions={false}` there.
- **The tiles are the payload; opening one fetches the album.** Both clients
  hold the lightbox's photos behind `enabled: lightboxOpen` on `['eventPhotos',
  id]`, seeded from `event.photos` so the photo you clicked is on screen
  immediately and the rest slot in behind it. A page of ten events must not
  fire ten album requests, and four tiles is not something you can "scroll
  through". It's the **same key** the event page's album uses, so a photo added
  there and a viewer opened on a card can't disagree — one cache entry, one
  invalidation.
- **The grid and the viewer are shared with posts, not copied.** `PhotoGrid`
  (`frontend/src/components/PhotoGrid.jsx`, `mobile/src/components/PhotoGrid.tsx`)
  was lifted out of `PostCard` on both clients and takes `max`/`total` for the
  "+N"; `Lightbox`/`PhotoLightbox` gained a caption (who took it — a post's
  images inherit the post's author, an album's don't) and an optional Remove.
  A post passes none of the new props and is unchanged.
- **A refused photo write says so where the control is**, per
  [connections.md](connections.md#reporting-a-refused-write): the web renders
  inline beside Add photos and inside the confirm dialog for a remove; mobile
  alerts, since an `Alert` outlives whatever is on screen. Removing confirms
  first on both — a photo comes off for everyone who can see it.
- **IBM Plex Mono** is used for every date/time (the sanctioned "voice of time");
  location is plain text + an optional pasted link, **never embedded map tiles**
  (which would leak every viewer's IP — see the privacy note in decision-land).

## Mobile (Phase 9 E3b)

The iPhone app is a client port over the same API — no backend changes. It
covers the **view + participate** side: the group page's upcoming-events section
(`EventCard`s above the composer, furthest-first) with a **Timeline/Calendar**
toggle, past events woven **into** the group timeline as recap entries on the
spine (`toGroupRows` merges them with posts by time, mirroring the web
`Timeline`), the **event detail** screen (`/events/<eid>` — a flat route; the
push deep-link's nested `/g/<gid>/events/<eid>` maps to it), the read-only
dimension **chips**, **RSVP**, and **poll voting**, plus a personal **Calendar**
tab and the group **month grid**. The same two gates and the same
complete-counts / connection-gated-names rules hold — they're server-side, so the
client just renders what arrives. Date/time render through a mobile copy of the
`formatEvent*` helpers (`mobile/src/eventFormat.ts`), kept in sync with
`frontend/src/utils.js`.

**An event's "when" is inline on the phone, on a rail on the web** — and that
divergence is the point, not a porting gap. The web gives every timeline entry a
rail column to the *left* of the spine and puts the date/time in it; on a phone
the spine hugs the screen edge (`SPINE_COLUMN` = 36pt, the 2pt line drawn down
the middle of it), because `PostCard` moved the clock time inline beside the
author's name to win back ~48pt of a 390pt screen — see the note at the top of
`mobile/src/components/timeline.tsx`. `EventTimelineEntry` was ported before
that and kept the rail, so a past event's time was drawn *across* the spine and
wrapped inside a column narrower than it needed. It now follows `PostCard`: the
bead alone in the spine column, and an alignment band of exactly the bead's
height carrying the when, then the organiser. **The two times have to come out
the same width**, not merely sit in the same place — they share a column, and
the organiser's name and the author's name start where their times end. Two
things fall out of that: the band takes **no `fonts.mono`** (mobile's
`PostCard` doesn't use it, so a mono event time beside a system-font post time
would break the column — the *web* honours the design system's mono-for-time
rule on both, and mobile's `PostCard` is the outlier; making them both mono is
a feed-wide change and its own issue), and **`formatEventTimeParts` pads its
minutes** — "7:00", never "7" — because `formatClockTime` above and below it
always does, and the unpadded form is ~24pt narrower. That padding landed in
*both* copies of the helper, mobile and web; the web's rail has the same column
and the same neighbours. A **past** recap leads
with the clock time only (the day divider above it carries the date, which is
also why the body no longer repeats the full `formatEventWhen`); a **future**
entry leads with the whole date in accent, because there are no day dividers
above the now boundary to carry it. The Date · Time · Where chips stay on both,
as on the web, and are now the only place the venue is written. A past recap
therefore states its date twice — the divider above it, and the Date chip — and
that's the settled answer, not an oversight: the chips are the record of what
the event decided, and a recap missing the one decision it's most defined by
reads as though it never got a date, while the divider is a property of the
*timeline* rather than of the event. What did go is the **"Happened" tag**: its
position says it, sitting below the now-node among posts equally in the past
that carry no such label. "Cancelled" stays, because that one isn't legible
from position — a called-off event is a tombstone, not a memory. Pinned in
`mobile/src/__tests__/events.test.tsx` ("EventTimelineEntry"), whose date
assertion is **derived from `formatEventDate`, never spelled out**: it goes
through `toLocaleDateString`, so a hardcoded "Sun 5 Apr" passes on a British
machine and fails on CI's, which renders "Sun, Apr 5" (reproduce with
`LC_ALL=en_US.UTF-8 npx jest`). Same trap as the runner's timezone.

The **optimistic tick and its two debts** (the "Frontend notes" bullet above) hold
here too, as of #227: `PollTally` awaits the vote and rolls its tick back with a
message if it's rejected — which is why `EventScreen` hands voting down as
`mutateAsync` — and re-derives your ticks whenever `poll.your_votes` changes by
*contents*. The rollback earns its keep more here than on the web: a phone's
network is the one that actually drops a request mid-tap. The **RSVP guests/note
bullet** above holds here too and landed on both clients together (#229) — with
one extra way in on a phone: `_layout.tsx` wires `AppState` to `focusManager`,
so merely returning to the foreground refetches the event and moves
`your_response` under the open screen.

The **organiser's control surface** landed in **E3c**, across two PRs:

- **E3c-a — plan & set.** **Plan an event** (a `groups/<id>/plan` form reached from
  the group ⋯ menu), the chip **Set/Change** → a contextual `DimensionEditor` →
  **finalise** a built-in value, and **cancel/delete**. The date/time editor uses
  the **native OS picker** (`@react-native-community/datetimepicker`) rather than a
  port of the web's segmented boxes — the native-adaptation call from the E3 plan;
  it hands `finalise` the same ISO `YYYY-MM-DD` / `HH:MM`. Setting a value is
  advisory (decision 3) and closes any open poll on the dimension. An
  event-*field* edit form is **not** built — `updateEvent` is a dormant endpoint on
  the web too (no UI), so the app ports the method but no form.
- **E3c-b — polls.** The chip **Poll** affordance + the poll builder and lifecycle
  (open / edit-while-unvoted / close / reopen / delete, and finalising a custom
  poll). A `polling` chip stays read-only — its poll is managed from the
  `PollTally` card below it, not from the chip.

The **album** (decision 6) landed on both clients in one PR, which is the rule
#216/#227 bought: splitting them is what left the phone lying for a day. The
phone half is arguably the primary one here — the camera is on it — so
`EventPhotos.tsx` goes through `usePhotoPicker` (camera *and* library,
multi-select, `quality: 0.9`, the composer's settings) and `AuthedImage`, and
the tiles sit **outside** the entry's own `Pressable` on `EventTimelineEntry`,
the rule `PostCard` already follows so "did I open the event or the photo?"
isn't touch-responder luck. `EventCard` gets no grid, matching the web.

## Scope / non-goals (v1)

No recurring events, no maps/geocoding, no timed push reminders (needs a background
scheduler — a shared dependency with the Phase 13 transcode queue; the calendar's
upcoming view is the passive reminder for now), no external calendar sync (a
read-only `.ics` export is a natural privacy-safe follow-up), no member-suggested
poll options, no public/discoverable events. Events are a group-coordination
feature, not a product pivot.

On the **album** specifically: no per-photo captions, comments or reactions (the
event's own thread is the place to say something about them), no reordering, no
cover photo, and no "download all". Also no *editing* an event's fields on the
phone — `updateEvent` is a dormant endpoint on the web too.
