# Group events & planning calendar

Members of a [group](groups.md) can **plan events together** — a family birthday, a
book-club night, a camping weekend — each with a title, date, time and location,
shown on a calendar and on the group's timeline. The distinctive part: an event
**doesn't need a settled date to exist**. The organiser can open an **advisory
poll** on any dimension (date, time, location, or a custom question), members vote,
and the organiser makes the **final call** — the poll never auto-decides. Still no
algorithm: the calendar is time-ordered, events surface by *when they are*. This is
the current-state reference.

Code: `Event` / `Poll` / `PollOption` / `PollVote` / `EventRSVP` models +
`Notification.event` FK; `visible_events` / `can_view_event` (the connection gate,
keyed on the organiser) and the event/poll/RSVP/calendar views in `api/views.py`;
the `serialize_event` / `serialize_poll` / `build_rsvp_summary` builders in
`api/serializers.py`. Frontend: the `EventsSection` + `MonthGrid` on `/g/:id`, the
`EventPage` detail (`/g/:id/events/:eid`, the notification deep-link target), the
personal `CalendarPage` (`/calendar`), and the `DimensionChips` /
`DimensionEditor` / `PollTally` / `RsvpBar` / `EventCard` components under
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

## Organiser departure

The gate needs a *present* organiser. Two paths:
- **Account deletion** — `organiser` is CASCADE, so the events simply go with the
  account.
- **Leaving / being removed from the group** — `cancel_events_on_departure` (called
  from the membership-delete view) **soft-cancels** their events there and notifies
  going/maybe RSVPs. An admin "adopting" an orphaned event onto themselves is a
  future extension.

## Frontend notes / deliberate deviations from the phase sketch

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

The **organiser's control surface** arrives in **E3c**, split into two PRs:

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
  poll). Until it lands, a `polling` chip is read-only on mobile.

## Scope / non-goals (v1)

No recurring events, no maps/geocoding, no timed push reminders (needs a background
scheduler — a shared dependency with the Phase 13 transcode queue; the calendar's
upcoming view is the passive reminder for now), no external calendar sync (a
read-only `.ics` export is a natural privacy-safe follow-up), no member-suggested
poll options, no public/discoverable events. Events are a group-coordination
feature, not a product pivot.
