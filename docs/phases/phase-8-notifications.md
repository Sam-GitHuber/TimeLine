# Phase 8 — Notifications & Activity Centre

**Status:** not started — sketch only, refine before starting

> Follows the "flesh out before starting" convention (see `CLAUDE.md`). This is a
> fuller sketch than a stub, but confirm the plan with the user before building.

## Goal

Build the **notification system** for TimeLine: turn the things that happen to you
(someone replies to your post, reacts to it, asks to connect, invites you to a
group) into notifications you can see and manage — surfaced as an **in-site
activity centre** (a nav dropdown), with **per-type preferences** to control what
you're notified about.

Crucially, the activity centre **keeps a history**: notifications don't vanish the
moment you glance at them. Unread ones stand out and drive a nav badge; ones
you've already **addressed are dulled but retained**, so you can scroll back and
see "what have I been notified about lately" — the thing phone notification
centres get wrong by dropping a notification the instant you tap it.

## Why this phase is here (before the apps)

This is the **foundation-first** half of the notifications story. There are two
distinct pieces:

1. **The notification *system*** (this phase) — the event types, generating and
   storing notifications, the in-site activity centre, and preferences. This is
   backend + web work, entirely independent of any phone, and it improves the web
   app on its own.
2. **The *push delivery channel* to a phone** (Phases 9–10) — registering device
   tokens and pushing through Apple's APNs / Google's FCM. This genuinely can't
   be built until the native app exists.

Building the system first means each app phase just *adds a delivery channel* on
top of an API that already exists, instead of one giant phase that invents the
whole notification concept and an app at once. Same layering philosophy as the
`django-storages` seam (build the hard shared part once; add the platform channel
later). See the "Why this order" note in `docs/SHARED.md`.

## Scope / non-goals

- **In scope:** a `Notification` model, event generation for existing actions, an
  in-site activity centre (dropdown + badge), read/dulled states, per-type
  notification preferences, and a settings surface to edit them.
- **Out of scope (deferred to Phases 9–10):** phone push notifications (APNs/FCM,
  device-token registration). This phase makes the app *ready* to push, but does
  not push to a phone.
- **Out of scope (deferred):** email notifications, digest emails.
- **Real-time delivery** is **polling** (TanStack Query `refetchInterval`, the
  same approach as Phase 5 messaging) — a later swap to Django Channels is
  non-breaking. Don't build WebSockets here.

## Design sketch (refine before building)

- **`Notification` model** (in the `api` app), roughly:
  `recipient` (FK User), `actor` (FK User — who did it), `verb`/`kind` (an enum:
  `post_reply`, `comment_reply`, `reaction`, `connection_request`,
  `connection_accepted`, `group_invite`, …), a generic **target** (the post /
  comment / group it points at, for deep-linking), `created_at`, and `read_at`
  (null = unread). Keep it queryable and cheaply paginated (newest-first).
- **States drive the UI the user described:**
  - **Unread** (`read_at is null`) — bright/bold, counts toward the nav badge.
  - **Read/handled** — dulled but *kept*. Opening the centre (or acting on an
    item) marks items read; nothing is deleted.
  - Open question: one tier (`read_at`) or two (a "seen"/badge-cleared flag vs. an
    "addressed"/acted-on flag). Start with one; add the second only if it's
    genuinely wanted.
- **Event generation:** create notifications where the action happens (on comment
  create, reaction create, connection request/accept, group invite). Prefer
  **explicit creation calls in the relevant views/services** over Django signals
  — easier to reason about and test. Never notify yourself for your own action;
  respect the recipient's preferences and existing gates (connection/block/
  membership — don't leak an action from someone you can't see).
- **Preferences:** a per-user, per-`kind` on/off set (a small model or JSON
  field), edited under `/settings`. A muted kind creates no notification (and,
  later, no push).
- **Reactions dependency:** the `reaction` event type depends on the **emoji-
  reactions feature tracked separately** (existing repo issue) landing first. If
  reactions aren't merged when this phase runs, ship the other event types and
  add the `reaction` kind when reactions exist — the model is designed to take a
  new `kind` without a schema change.
- **Relationship to existing badges:** the app already has separate nav badges/
  inboxes for connection requests, group invites, and unread messages. Decide
  whether the new activity centre **subsumes** connection-request / group-invite
  signals or **complements** them (messages likely stay their own thing). Lean
  toward one unified activity centre so users have a single place to look — but
  confirm before consolidating.

## API sketch (refine)

- `GET /api/notifications/` — your notifications, newest-first, paginated.
- `GET /api/notifications/unread-count/` — drives the nav badge.
- `POST /api/notifications/read/` — mark all (or a set) read.
- `GET/PATCH /api/notification-preferences/` — read/update per-type prefs.

## Frontend sketch (refine)

- A **nav "Activity" bell** with an unread badge, opening a **dropdown/panel**
  listing notifications newest-first: unread items emphasised, read items dulled,
  each deep-linking to its target (post/comment/group). "Mark all read".
- A **notification preferences** section in `/settings` (per-type toggles),
  built from the design-system tokens (see `docs/design-system.md`).
- Polling cadence lives with the other intervals in `frontend/src/api.js`.

## Runnable product at the end of this phase

On the **web app**: do something notifiable to a test user (reply to their post,
request to connect, invite them to a group) and it appears in their activity
centre with the nav badge incrementing; they open the centre, the badge clears,
handled items dull but stay in the history; muting a type in settings stops new
notifications of that type. No phone involved yet.

## Likely definition of done (refine when we start)

- [ ] `Notification` model + migration; event generation wired into the existing
      comment / connection / group-invite (and reaction, if merged) flows
- [ ] Notifications respect existing visibility gates (connection/block/
      membership) and never notify you of your own action
- [ ] `GET /api/notifications/`, unread-count, mark-read, and preferences
      endpoints
- [ ] Per-type notification **preferences**, editable in `/settings`; a muted
      type produces no notification
- [ ] In-site **activity centre**: nav bell + unread badge, dropdown list, unread
      emphasised / handled dulled / **history retained**, deep-links to targets
- [ ] Polling refresh (no WebSockets); cadence in `frontend/src/api.js`
- [ ] Backend + frontend tests: event creation, gating/scoping, read-state,
      preference muting
- [ ] `docs/phases/phase-8-notifications.md` updated; status → done

## Open questions to resolve before starting

- One read-state tier (`read_at`) or two ("seen" vs. "addressed")?
- Does the activity centre **absorb** the existing connection-request / group-
  invite badges, or sit alongside them?
- Which actions are notifiable in v1 — confirm the `kind` list (and whether an
  @-mention feature is wanted, which would be new scope, not assumed here).
- Payload shape that the Phase 9/10 apps will reuse for **push** — design it now
  so the mobile phases only add the transport, not a new API.

## Notes / decisions log

- **Foundation-first split confirmed with the user** (2026-07-12): build the
  notification system on the web app here; Phases 9–10 add phone push on top.
- **Reactions are tracked in a separate repo issue** and expected to land before
  this phase; the `reaction` notification kind depends on it but the model
  doesn't (a new kind needs no migration).
- **Polling, not Channels** — consistent with Phase 5/6a messaging; the swap is
  non-breaking and deferred until real-time actually matters.
