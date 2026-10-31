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
event.

Two things about that sentence are narrower than they look, and both are
deliberate:

- **The uploader's limb is checked *first*, before the visibility gate.** You can
  lose sight of an event by leaving the group or disconnecting from its
  organiser, and your photos would go with it — so ownership wins ahead of
  `can_view_event`, exactly as `_owned_comment` does and for the same stated
  reason: your photo stays yours to remove. Gating first is what makes a photo
  unremovable by the one person with the clearest claim to it.
- **The organiser's and the admin's limbs reach only what they can see.** The
  prune above is per viewer, and it is *not* widened for admins — an album is
  the last place to make an exception to the app's single visibility rule. So a
  group admin who isn't connected to an uploader never sees that photo and has
  no id to remove. Behind them sits the maintainer: `EventPhoto` is registered
  in the Django admin, and deactivating an account still sweeps everything it
  authored. A member-facing **report** flow is the honest fix for the gap
  between those two and is tracked separately — this is not a moderation story
  that's finished.

**A photo you can't see is a 404, not a 403** — `can_view_comment`'s split, not
`PostDetailView`'s. The container gate can't decide this one: `EventPhoto.id` is
a global sequential key, so answering 403 for a photo the prune deliberately hid
would let anyone walk the ids and count what people they never connected to have
been posting. The gate that decides *whether you may see it* has to be the same
gate that decides *whether you're told it exists*.

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
  the view (a new vote replaces the old); multi-choice accumulates. That rule
  can't be an index — its condition is `allow_multiple`, a column on another
  table — so it holds by **locking the poll row** instead (`_lock_poll`): the vote's
  checks and its delete-then-insert are one step. Unlocked, a voter with no vote
  yet who double-tapped two options gave neither `DELETE` a row to wait on, so a
  pick-one poll counted them twice, and two pick-any selections merged instead of
  the later replacing the earlier. The poll edit takes the same lock — see the
  zero-votes guard under [API](#api-apiurlspy--apiviewspy).
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
- **`EventCoOrganiser`** (issue #419) — `event` (CASCADE), `user` (CASCADE),
  `added_at`, `UniqueConstraint(event, user)`, ordered oldest-first (the order
  is the handover queue). See [Co-organisers & handover](#co-organisers--handover).
- **`EventReminder`** (issue #417) — `event` (CASCADE), `poll` (CASCADE, null =
  an RSVP reminder), `sent_by` (SET_NULL), `sent_at`, `recipient_count`. The
  rate limit's record. See [Reminding people who haven't answered](#reminding-people-who-havent-answered).
- **`Notification.event`** FK (the fifth concrete target) + five new kinds; the
  `CheckConstraint` widened to "at most one of five targets set". See
  [notifications](notifications.md).

## API (`api/urls.py` / `api/views.py`)

Two gates, mirroring the group timeline: **membership** gates the group's event
endpoints (non-member → 404); each **individual event is connection-gated to its
organiser** (`can_view_event`; a 404 if you're not connected). Managing an event
(edit, polls, finalise, photo removal) is the organiser's **or a co-organiser's**,
through the one `can_manage_event` check; cancel adds a group admin; hard-delete is
the organiser **or a group admin** only.

A poll vote reads `option_ids` straight from the body, so it goes through the
shared id coercion — see
[accounts.md § Security posture](accounts.md#security-posture). **Omitting
`option_ids` clears your vote; sending it as `null` is a 400**, so a client whose
field came back empty can't delete a vote you cast and be told it worked.

**Events** — `GET/POST /api/groups/<gid>/events/?window=upcoming|past|all`
(list you-can-see / create, any member); `GET/PATCH/DELETE /api/events/<id>/`
(detail / edit non-scheduling fields / hard-delete); `POST /api/events/<id>/cancel/`
(soft-cancel, notifies going/maybe).

**Add to my calendar** (issue #418) — `GET /api/events/<id>/ics/` returns the
one event as an `.ics` file (`text/calendar`, an attachment named from the
title), behind the same `can_view_event` 404. Built by hand in `api/ics.py` —
a single `VEVENT` is small enough that a library would be more to trust than
the code. The choices:

- **One file, on demand — no subscription feed.** A subscribable URL would
  need a long-lived secret token and would have a third-party calendar server
  polling us for events on a schedule; a much bigger privacy decision.
- **No date yet → 409.** A `planning` event exists; there is just nothing to
  put in a calendar. A **cancelled** event with a date still exports, as
  `STATUS:CANCELLED`, so someone who already added it can re-import to clear it.
- **A stable `UID`** (`event-<id>@<site domain>`), so downloading again after a
  change updates the entry already in someone's calendar instead of duplicating
  it (in the apps that honour it). The domain and the link back both come from
  `SITE_URL` (env `DJANGO_SITE_URL`, defaulting to the first CORS origin — the
  SPA in dev and in production), **not** the request's host: in dev the API and
  the SPA are different origins, so a link built from the API host would 404.
- **Errors stay readable whatever `Accept` says.** The view forces DRF's content
  negotiation, so a client asking for `text/calendar` still gets the JSON 404 /
  409 instead of a 406.
- **All-day** → `DTSTART;VALUE=DATE` with `DTEND` the next day (iCalendar's end
  is exclusive). **Timed** → instants in **UTC**, not `TZID=<zone>`: RFC 5545
  requires every `TZID` to come with a `VTIMEZONE` block (DST rules), which is
  the fiddly part a library exists for, whereas a UTC instant needs no
  definition and every calendar app shows it in its owner's zone anyway. The
  event's own zone still decides *which* instant (the same fallback as
  `starts_at`). An end at or before the start runs past midnight; no end time
  means no `DTEND` rather than an invented duration.
- **The phone app doesn't use this file.** It authenticates with a bearer
  token, which no system calendar or browser can send, and handing the file to
  Safari meant leaving the app. It opens iOS's / Android's own pre-filled
  "New Event" form instead — see [Mobile](#mobile-phase-9-e3b). (A one-minute
  signed download link was built for it and dropped before merge for that
  reason, which also kept a bearer credential out of URLs.)
- **It names nobody.** No `ORGANIZER`, no `ATTENDEE`, no RSVP names — names are
  gated per viewer (decision 2) and this file leaves the app. Title,
  description, location (name, note, link) and a URL back to the event page.

**Privacy:** the file leaves TimeLine on purpose, into whatever calendar service
the user picks (iCloud, Google, Outlook), carrying the event's location and
description. That is the user's own choice for an event they can already see;
the response is `Cache-Control: private, no-store` so it isn't kept anywhere on
the way.

**Co-organisers** — `POST /api/events/<id>/co-organisers/` (`{user_id}`, the
organiser only; the person must pass `can_view_event`, else a 400; idempotent —
201 new / 200 already there); `DELETE /api/events/<id>/co-organisers/<user_id>/`
(the organiser, or the co-organiser stepping down). Both return the event.
`GET /api/events/<id>/co-organiser-candidates/` (organiser only) lists exactly
who the add would accept — connected active members not already co-organising,
sorted by name — so a client picker can't offer someone the add then refuses.
`serialize_event` carries `co_organisers` (gated to the names the viewer may
see), `is_organiser`, `can_manage` (organiser or co-organiser), `can_cancel`
(+ group admin), `can_moderate` (organiser or group admin — **delete**; its
meaning is unchanged so older app builds never offer a co-organiser delete) and
`unreachable_rsvp_count` (organiser only, else `null` — see below).

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
the affordance too. **The guard and the rewrite run under the poll's row lock**,
the same one every vote takes — checked and written separately, a vote landing in
between was precisely what the guard exists to stop: deleting its option took the
vote with it (CASCADE), rewriting it silently moved the vote, and turning
`allow_multiple` off under a fresh two-option vote left a pick-one poll holding
two votes from one person. Both sides must lock; one alone serialises nothing.
Close and re-open take the same lock implicitly, by saving the poll row. An edit never re-notifies (`poll_opened` already fired).
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
| `event_comment` | someone comments on an event | its **organiser and co-organisers** (each gated on the commenter) |
| `event_photos` | someone adds photos to an event's album | **going/maybe RSVPs** (incl. the organiser), de-duped while unread |
| `event_co_organiser` | the organiser makes you a co-organiser | you — **always-on** |
| `event_handover` | the organiser left the group and the event passed to you | you — **always-on** |
| `event_reminder` | an organiser pressed **Remind** (#417) | the audience who haven't answered — see [below](#reminding-people-who-havent-answered); de-duped while unread |

**A co-organiser acts in the organiser's name.** When a co-organiser opens a
poll, sets a date or cancels, the broadcast still goes out with the
**organiser** as actor, because the actor is what the connection gate checks
and the gate must be the event's audience. Naming the co-organiser would prune
the broadcast to *their* connections, or show their name to people not
connected to them. The co-organiser who acted is skipped (`acted_by`). Known
edge: the organiser isn't told a co-organiser acted (they're the actor, so the
no-self-notification rule drops them) — the event page shows the change.
`event_co_organiser` and `event_handover` are **always-on**, like an invite:
each tells one person about a responsibility they now hold, and they're rare.

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

## Reminding people who haven't answered

Issue #417. The organiser — or a co-organiser — can send **one notification to
the members who haven't answered**: either who haven't RSVP'd, or who haven't
voted in one open poll. `GET /api/events/<id>/remind/` is the panel (`available`
— false for a past or cancelled event — then an `rsvp` row and one row per
**open** poll, each `{pending_count, last_sent_at, next_allowed_at}`);
`POST` with `{}` or `{poll_id}` sends one (201 with `sent_count`). A plain
member is a 403, anyone who can't see the event a 404, like every other
organiser action. Pressed, not scheduled: timed reminders would need a
background job queue, which this stack deliberately doesn't have.

- **Who "hasn't answered".** The event's audience — active members connected to
  the **organiser** — minus the organiser and whoever is sending it, minus
  anyone with an RSVP (for an RSVP reminder) or a vote in that poll (for a poll
  reminder). Someone who **declined** isn't asked to vote on the details;
  they've answered the bigger question.
- **In the organiser's name, counts only.** A co-organiser's reminder goes out
  with the organiser as actor, for the reason every co-organiser broadcast does
  (see [Notifications](#notifications)). That audience can include people the
  co-organiser isn't connected to, so the panel returns a **count and never
  names** — for the organiser too, since one payload shape is simpler than a
  second gate.
- 🔒 **Rate-limited on the server, against spam.** One reminder per target —
  the RSVP, or one poll — per **24 hours** (`REMINDER_COOLDOWN`), shared by the
  organiser and every co-organiser, or adding co-organisers would multiply the
  allowance. A second send is a **429** with `next_allowed_at` and a
  `Retry-After`. The record is its own model, **`EventReminder`** (`event`,
  `poll` — null for an RSVP reminder — `sent_by`, `sent_at`, `recipient_count`),
  not the `Notification` rows: a recipient who muted the kind gets no row, so a
  limit read from what landed would let an organiser whose whole audience muted
  reminders send endlessly. Every check, the record and the fan-out happen in
  one transaction under a `select_for_update` on the event: two presses at once
  can't both get through, a cancel can't land between "it's still on" and the
  send, and a fan-out that fails rolls the allowance back instead of spending
  it. The rows are browsable (read-only) in the Django admin, for the day
  someone says an organiser is nagging. Each poll has its own allowance, so opening a poll this afternoon
  isn't blocked by an RSVP nudge this morning — but the **de-dup** on the kind
  means someone who hasn't read the morning's reminder gets that row refreshed
  rather than a second buzz.
- **Nothing to send is a 409 and costs nothing.** Everyone has answered, the
  event is past or cancelled, or the poll is closed / past its `closes_at`: no
  `EventReminder` row is written, so the allowance isn't used up.
- **One line for both kinds of reminder** — "Or is waiting for your answer on
  Picnic" — because a de-duping row can stand for either, and the event page
  shows what's waiting. The poll's `closes_at` isn't in the push for the same
  reason; the panel shows it to the sender.

## Co-organisers & handover

Issue #419. An event used to belong to exactly one person, and died with that
person's group membership even when others were helping plan it.

**Co-organisers.** The organiser can add co-organisers, who can do everything
that *shapes* the event — edit, open/fix/close/re-open/remove polls, finalise,
cancel, remove album photos. Two things stay the organiser's: **hard-delete**
(it takes everyone's album with it) and **choosing co-organisers**. Every one of
those checks goes through `can_manage_event` — one helper rather than an
`organiser_id ==` per view, so a view can't be left organiser-only by accident.

**Co-organisers don't widen the audience.** The gate stays keyed on the
organiser (decision 1), so a co-organiser must already be *in* the audience —
an active member connected to the organiser — which the add endpoint checks
with `can_view_event`. A co-organiser isn't necessarily connected to everyone
else there, so their tallies show anonymous +1s where the organiser's show
names: decision 2 applies to them like anyone. Their *own* names follow it too
(`co_organisers` is filtered to the viewer's connections).

**A seat lasts only while its holder is in the audience.** `end_connection`
(disconnect and block both go through it) drops any seat either person holds on
the other's events, and a handover drops seats held by people the new organiser
isn't connected to. Left behind, a seat would vanish from the organiser's list —
it's name-gated — while quietly coming back to life if the two reconnected. The
`event_comment` fan-out also skips any co-organiser not connected to the
organiser, so a seat that somehow outlived that can't deliver a notice about an
event that 404s for them. `event_co_organiser` is sent **once per event**, not
once per seat: it's always-on, so remove-and-re-add mustn't become a way to buzz
someone's phone.

**Handover.** The gate needs a *present* organiser. Two paths:
- **Account deletion** — `organiser` is CASCADE, so the events go with the
  account, co-organisers or not.
- **Leaving / being removed from the group** — `events_on_departure` (called from
  the membership-delete view) drops the leaver's co-organiser seats in that group,
  then for each event they organise there: if a co-organiser is still an active
  member **and still connected to the departing organiser**, the longest-standing
  one (`added_at`) **becomes the organiser** and gets `event_handover`; otherwise
  the event is **soft-cancelled** and going/maybe RSVPs are told, as before. The
  "still connected" condition passes over someone the organiser blocked or
  disconnected from: they couldn't see the event, and it isn't theirs to inherit.

**Handover changes the audience, and that was a deliberate call.** Re-anchoring
the gate on the new organiser means the event's audience becomes *their*
connections: RSVPs from people they aren't connected to stop seeing it, and
members connected to them but not the old organiser start to. The options were
to refuse handover unless the new organiser's connections covered every RSVP,
or to hand over and warn; the user chose **hand over and warn**. The warning is
`unreachable_rsvp_count` on the organiser's own payload — going/maybe RSVPs from
people not connected to them — a **count, never names**, since the organiser
isn't connected to those people and naming them would break the rule that hides
the event from them. It's live rather than stored, so it also covers someone who
disconnected from the organiser after replying. Those RSVP rows are kept (and
still count): if the people reconnect, nothing they said is lost.

## Frontend notes / deliberate deviations from the phase sketch

- **Add to my calendar (#418).** Beside **Manage event**, any event with a date
  shows an **Add to my calendar** link (**Mark cancelled in my calendar** once
  cancelled) to `GET /api/events/<id>/ics/`. A plain `<a download>`, not a
  fetch-and-blob: the 1-day `SameSite=Lax` auth cookie rides along like any page
  view, and a real link is what lets iPhone Safari hand the file straight to its
  own "Add to Calendar" sheet. A date-less event shows nothing (the endpoint
  would 409).
- **Reminders live in the Manage dialog (#417)**, between co-organisers and
  cancel — they're part of *running* the event. The section is fetched each time
  the dialog opens (`['eventReminders', id]`, organisers only, hidden when the
  panel says `available: false`) and lists the RSVP and each open poll as
  "4 people haven't replied yet" with a **Remind 4 people** button behind a
  confirm. While the daily limit stands the button is gone and the row reads
  "Reminded 3h ago · you can remind again …"; a refusal (usually someone else's
  reminder landing first) is stated under the row pressed, and the panel is
  re-read either way. A co-organiser is told it goes out in the organiser's name.
- **Running an event — the Manage dialog (#419).** One **Manage event**
  button under the organiser line (organiser, co-organiser or group admin)
  opens `ManageEventDialog`: co-organisers (add from
  `co-organiser-candidates`, remove, or step down), then **Cancel**
  (`can_cancel`) and **Delete** (`can_moderate`), moved here from the foot of
  the page. Unlike the phone's sheet, the dialog **stays open until a write
  lands** and states a refusal inside itself — the `DisconnectWarningModal`
  shape — because the web reports refusals in place (#237) and closing first
  would leave a failed cancel nowhere to be said. Cancel and delete are still
  the page's mutations (handed in as `mutateAsync`), so `invalidate()` and the
  post-delete navigate stay the one copy. The organiser line reads "Organised
  by X with Y"; the organiser sees the handover warning under "Are you going?".
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
  post-shaped entries (`EventTimelineEntry` — the poster-style avatar marker on
  the line, a mono **accent** date on the rail, title/organiser/chips in the
  body; the *when* is the rail's and the chips', never the body's — see below).
  A future event reads apart from a past post by its *position* (above now)
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
  the now boundary (inset via `.tl-inset` so its inputs clear the spine). Its
  **Cancel is held while the POST is out** (#259, on the web) for the reason the
  organiser's other writes report themselves at all: the form is the only
  renderer of its own rejection, and planning an event is a thing you do once, so
  a create that failed into a dismissed form isn't a question you get a second
  look at — you find out when nobody turns up. Same rule as
  [connections.md](connections.md#reporting-a-refused-write); `DimensionEditor`'s
  four Cancels already had it from #296. **The phone's plan form has no Cancel at
  all** — it's a pushed screen, so the ways out are its "← Back", Android's
  hardware back and iOS's swipe, and all three are held instead (#259). The

  **The event screen holds its own "← Back" for three writes** and nothing else:
  the **RSVP**, a **vote**, and a **poll edit**. Those are exactly the three
  handed to their child as `mutateAsync` rather than given an
  `onError: Alert.alert`, and for the same reason — the guests and note are typed
  into `RsvpBar`, the vote's tick is drawn optimistically by `PollTally`, and the
  409 that says voting has started belongs in the edit form in place. Each of
  them therefore reports itself in a component the screen would unmount, so
  leaving mid-flight is the swallow: you believe you're down for three guests and
  nobody is expecting you, or the tally you come back to reads as "nobody has
  voted" rather than "your vote never landed". One hoisted `holding` predicate
  feeds the Back button, its dimming, `goBack` and the screen's single
  `useAndroidBack` registration; every other write here alerts, so none of them
  needs it. The
  header (name · ⋯ · description) is a **second sticky bar pinned directly under
  the nav** (`GroupPage` measures the nav height so it stacks correctly), so the
  group's identity stays put while the upcoming region and timeline scroll up
  behind it — and the now-node's scroll-margin clears *both* sticky bars.
- Past events are merged into the group `Timeline` **on the spine** among the
  posts — the *same* `EventTimelineEntry` as a future event, in its `variant="past"`
  recap form: the rail shows the clock time like a post (the day divider carries the
  date), and the body drops the description and the live RSVP for the turnout alone
  ("6 went"). So an event looks the same threading the line whether it's ahead of
  now or behind it — not a boxed card wedged into the spine. (`EventCard`, the boxed
  form, is still used *off* the line — the staging strip, month day-lists, the
  personal calendar agenda.)
- **A timeline entry says its "when" nowhere in its body** (#293, the web's half
  of #292 below) — on **both** variants. The meta line under the title carries
  the organiser and the venue only. It used to write `formatEventWhen` as well,
  which on a past recap stated the date three times (day divider, meta line,
  `Date` chip) and the time three times (rail, meta line, `Time` chip), and on a
  future entry stated the date three times over (accent rail, meta line, `Date`
  chip) — on entries sitting two rows from a post whose clock time is on the rail
  and nowhere else. That line was written when the entry was a boxed card with
  neither a rail nor a divider over it, and it simply never got revisited when
  the entry moved onto the spine, where **the rail is the voice of time**. The
  future variant was outside #293 as filed and was folded in on the same edit,
  because it's the same mistake in the same file and leaving it would have left
  the web stating a future date three times where the phone states it twice.
  The **`Happened` tag went with it**: position says it — below the now-node,
  under a dated divider, among posts equally in the past that wear no such
  label. `Cancelled` stays, because that one *isn't* legible from position: a
  called-off event is a tombstone, not a memory. The branch is written for
  either variant but only a **past** entry can reach it — `GroupPage` filters
  cancelled events out of `upcoming` before `Timeline` sees them (they resurface
  as a recap once their date passes), so a cancelled event is only ever drawn on
  the line below the now-node.

  Three things deliberately **stay** where they are:

  - the **chips**, including `Date`. A recap missing the one decision it's most
    defined by reads as though it never got a date, and the divider is a property
    of the *timeline* rather than of the event — so the date appears **twice**,
    which was never the complaint;
  - the **venue on the meta line**, alongside the organiser, even though the
    `Where` chip repeats it. #293 asked for it kept, and the web has a reason the
    phone doesn't: the phone dropped its whole meta line (its when sits inline in
    an alignment band instead), so on mobile the chips really are the only place
    the venue is written, while on the web dropping it would leave a line holding
    a name and nothing else. Repetition was the complaint about the *when*, which
    was stated three times in three type styles; a venue named once beside the
    organiser and once in the chip that records it is the same twice-over the
    date gets;
  - `EventCard`'s `Event · happened` — the boxed *off*-the-line form has no
    spine and no divider to place it, so the label is doing real work there, as
    it is on `EventPage`.

  **The rail took on the accessibility the body used to provide.** It splits over
  two lines ("1:00" / "pm", "20" / "Aug"), which assistive tech reads as two
  fragments, and its visible form is lossy — the accent day/month carries no
  year, so two upcoming events twelve months apart draw the same two lines. While
  the body spelled the when out that didn't bite; now it would. So every branch
  of `Rail` is a `<time>` carrying the whole `formatEventWhen` in `title` +
  `aria-label`, which is exactly what `PostCard` already does for its own split
  clock time and for the same reason. Making the all-day branch a `<time>` rather
  than a `<span>` also gets it `.tl-rail > time` in `index.css`, so "all / day"
  finally lines up with the clock times above and below it in the same column.

  Pinned in `frontend/src/events.test.jsx` ("event timeline entries"), with the
  same derive-don't-spell-out rule as the mobile tests below — the suite passes
  under `LC_ALL=fr_FR.UTF-8` and at both ends of the date line.
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
  job is collecting answers before a date. **That message retires only when the
  server *moves to* the very selection you cast** — the request landed and only
  its response was lost, so "your vote didn't go through" would be sitting under
  a tick the server has since confirmed. Both halves are judged on keys recorded
  **at the attempt**, never on when the sync arrives, so a refetch bearing some
  third answer leaves it standing — including one that lands in the same React
  batch as the rejection, which is what #231 reports: the clear used to fire on
  *any* re-sync, and on patchy signal it swallowed the message before it was
  ever painted. Same shape and same reasoning as the RSVP's below, and as
  `ConnectButton`'s `from`/`to` across its four connection states; a refused
  reaction ([reactions.md](reactions.md)) asks only the `from` half, because for
  a boolean the two questions collapse into one.
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
  separating anything the moment offline had one. Mobile sniffed an `ApiError`
  *instance* instead, which #243 retired for the same reason one step later:
  once the app guarded its own `fetch`, offline became an `ApiError` too, and
  both copies now read `fromServer` through `serverMessage`.
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
    that one is retired by the server confirming the very vote it was about, and
    a refetch triggered by some *other* write is no answer to "did my Remove
    poll go through?"), `DimensionEditor` owns Set and Open poll, and only
    `cancel`/`remove` — whose buttons are on the
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
- **The tiles are the payload, and a card fetches nothing.** The previews ride
  `event.photos` / `event.photo_count`, so a page of ten events fires zero album
  requests. Tapping a tile opens a viewer holding **only those previews** — the
  "+N" tile is not a fifth photo but a **link to the event page**, where the
  paginated album lives. That split is the fix for a card that used to promise
  more than it could show: the overlay counts `photo_count` (up to 200) while a
  viewer opened from a card could only ever hold one DRF page, so "+46" opened a
  viewer reading "4 / 20" with the rest unreachable. Per-tile labels therefore
  count against the previews ("View event photo 1 of 4"), matching the counter
  in the viewer they open, and the "+N" says where it goes ("See all 50 photos
  on the event"). **Accepted consequence:** the photo under the "+N" tile isn't
  openable from the grid — it's an arrow away inside the viewer. That reads like
  a bug and isn't; both clients carry a comment saying so.
- 🔑 **`['eventPhotos', id]` has exactly one consumer** — the event page's
  album, and it holds the infinite-query shape. Nothing else may cache a bare
  DRF page under it. The card once did, with a plain `useQuery`, which put two
  incompatible shapes in one TanStack entry: mount the card's viewer first and
  the event page's `getNextPageParam` destructured `undefined` and threw, and
  with no `ErrorBoundary` in `main.jsx` that white-screened the whole app.
  "One cache entry, one invalidation" is now true because there is one reader,
  not because two readers agreed.
- **The grid and the viewer are shared with posts, not copied.** `PhotoGrid`
  (`frontend/src/components/PhotoGrid.jsx`, `mobile/src/components/PhotoGrid.tsx`)
  was lifted out of `PostCard` on both clients and takes `max`/`total` for the
  "+N", plus `onOverflow`/`overflowLabel` for the event card's link-to-the-album
  behaviour; `Lightbox`/`PhotoLightbox` gained a caption (who took it — a post's
  images inherit the post's author, an album's don't) and an optional Remove.
  A post passes none of the new props and is unchanged — and that's a constraint,
  not an observation: a post's images are one bounded set with nowhere to
  navigate to, so **the "+N" default must stay "open the viewer at that index"**.
  Both clients pin it with a test that a post's grid is unchanged, because the
  album's behaviour is the tempting thing to make the default.
- **A refused photo write says so where the control is**, per
  [connections.md](connections.md#reporting-a-refused-write): the web renders
  inline beside Add photos and inside the confirm dialog for a remove; mobile
  alerts, since an `Alert` outlives whatever is on screen. Removing confirms
  first on both — a photo comes off for everyone who can see it.
- **IBM Plex Mono** is used for every date/time (the sanctioned "voice of time");
  location is plain text + an optional pasted link, **never embedded map tiles**
  (which would leak every viewer's IP — see the privacy note in decision-land).

## Mobile (Phase 9 E3b)

**Add to my calendar (#418).** Beside **Manage event**, any event with a date
that isn't cancelled shows **Add to my calendar**, which opens the OS's own
pre-filled **New Event** form (`src/calendarExport.ts`, `expo-calendar`): on
iOS EventKit's editor slides up over the app; on Android it's the calendar
app's insert screen (`ACTION_INSERT` — there is no in-process equivalent), and
Back or Save returns here. The person checks it, picks a calendar, and saves.

- **Why the form, not the server's `.ics`:** opening a file meant handing it to
  Safari — leaving the app — and the browser can't send the bearer token. The
  form needs no server call at all.
- **The cost:** a form-made entry shares no `UID` with the `.ics`, so adding
  twice makes two entries and a later cancel can't update it. Hence **no button
  once cancelled** (the web, whose file *can* mark it off, still offers it).
- **Permissions:** `createEventInCalendarAsync` from **`expo-calendar/legacy`**
  — on **iOS 17+ it needs none** (the editor runs out of process; only the
  person can save from it). The newer class API's `addEventWithForm` needs a
  calendar object, unobtainable without full access, so it's deliberately not
  used. Only **iOS 16** (min deployment 16.4) asks once, and a refusal says
  where to turn it on. **Android needs nothing**, so the module's
  `READ_CALENDAR`/`WRITE_CALENDAR` are in `android.blockedPermissions`.
- **What's filled in:** title; a timed event starts at `starts_at` (the
  server's instant) in the event's own zone, ending at the wall-clock span to
  `end_time` (past midnight when it's at or before the start) or **an hour**
  when there's none — Calendar's own default, and the person sees it before
  saving, unlike the file; a date-only event is all-day. Location name; notes =
  description, location note and link. The link back goes in iOS's own URL
  field, and in the notes only on Android, whose insert screen has none. **No names** — same
  rule as the `.ics`.
- `expo-calendar` is pinned **exactly** to `57.0.1`, the release alongside the
  app's `expo` 57.0.7 (see mobile-release.md on native packages).

**Running an event — the Manage sheet (#419).** One **Manage event** button
under the organiser line (shown to the organiser, a co-organiser or a group
admin) opens `ManageEventSheet`: the organiser adds co-organisers from
`co-organiser-candidates` and removes them; a co-organiser steps down; then
**Cancel** (`can_cancel`) and **Delete** (`can_moderate`), which moved here from
the foot of the screen and still run through the screen's own confirm and
refusal alert. The organiser line reads "Organised by X with Y" (the
co-organisers you may see), and the organiser sees the handover warning
(`unreachable_rsvp_count`) under "Are you going?". The co-organiser fields are
optional in `types.ts` so an installed build keeps working against a server
released before them — `can_cancel` falls back to `can_moderate`.

**Reminders in the Manage sheet (#417)** match the web's: an RSVP row and one per
open poll ("4 people haven't replied yet", **Remind 4 people**), the button gone
while the daily limit stands ("Reminded 3h ago · you can remind again …"). The
confirm and a refusal are `Alert`s, like the screen's other event writes; unlike
cancel, the send runs *inside* the sheet, which holds itself open (`busy`) while
it's out so the "Reminder sent to 4 people." line has somewhere to appear.

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
as on the web, and are now the only place the venue is written. **The web
answered the same repetition in #293**, on both of its variants and without
touching its rail — so neither client now writes the when in an entry's body,
which is the rule the two share. What still differs is *where* it's drawn (the
phone's band, the web's rail — this paragraph's subject) and the **venue**,
which the web keeps on its meta line beside the organiser because it kept that
line; the reasoning is under "A timeline entry says its when nowhere in its
body" above. A past recap
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
*contents*, retiring the message only on the server arriving at the selection
you cast. The rollback earns its keep more here than on the web: a phone's
network is the one that actually drops a request mid-tap, and #231's swallowed
message was found on this copy first. The **RSVP guests/note bullet** above
holds here too and landed on both clients together (#229) — with
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
upcoming view is the passive reminder for now), no external calendar sync (only the
one-off `.ics` download above — no subscription feed), no member-suggested
poll options, no public/discoverable events. Events are a group-coordination
feature, not a product pivot.

On the **album** specifically: no per-photo captions, comments or reactions (the
event's own thread is the place to say something about them), no reordering, no
cover photo, and no "download all". Also no *editing* an event's fields on the
phone — `updateEvent` is a dormant endpoint on the web too.
