# Notifications & activity centre

An in-site **activity centre** (a nav "Activity" bell + dropdown) that turns the
things that happen *to* you — replies, reactions, connection requests/accepts,
group invites — into notifications you can see and manage. It **keeps a history**
(notifications don't vanish when you glance at them) and has **per-type
preferences**. This is the current-state reference.

Code: `Notification` + `NotificationPreference` models; `api/notifications.py`
(the generation helper); event calls wired into the comment / reaction /
connection / group-invite views; the list/seen/addressed/preferences endpoints in
`api/views.py`; `NotificationSerializer` (the push-ready payload). Frontend:
`ActivityCenter` (bell + dropdown) in the nav, `NotificationPreferencesSection` on
`/settings`, API + poll constant in `frontend/src/api.js`.

**Push delivery is being added in Phase 9.** The device registry
(`DevicePushToken` + `/api/push-tokens/`) already exists — see
[accounts.md](accounts.md#push-device-registration) — but nothing *sends* yet;
that lands in Milestone D, gated by the same per-type preferences described
below. In-app polling stays as the fallback either way.

Delivery is **polling** (TanStack Query `refetchInterval`, `NOTIFICATIONS_POLL_MS`
= 12s), the same model as [messaging](messaging.md) — a later swap to Django
Channels is non-breaking. No WebSockets.

## Why it exists / the design intent

The activity centre is deliberately **unified**: it is the single "someone needs
your attention" place. It **absorbed** what used to be separate nav badges for
connection requests (on People) and group invitations (on Groups) — those pages
keep their *action* lists, but the badge signal now lives only on the bell.
(Direct/group **messages** keep their own unread badge — a conversation is a place
you return to, not a discrete event to log.)

It also fixes what phone notification centres get wrong: a notification isn't
dropped the moment you tap it. It moves through **three states** and is retained.

## Data model — `Notification`

Like [`Reaction`](reactions.md), the **target** is one of a few concrete FKs, not
a `GenericForeignKey` — the target set is small and known, so concrete FKs are
indexable, cascade cleanly, and need no contenttypes machinery.

```
Notification:
  recipient    FK → User        (CASCADE, indexed)   # who receives it
  actor        FK → User        (SET_NULL, null)      # who did it (null = deleted acct)
  kind         CharField(choices)                     # the event-type enum
  post         FK → Post        (CASCADE, null)       # ── at most one target FK is set
  comment      FK → Comment     (CASCADE, null)       #    (a zero-target row is allowed,
  group        FK → Group       (CASCADE, null)       #    reserved for a future system
  connection   FK → Connection  (CASCADE, null)       #    notice); `kind` says which to read
  created_at   DateTimeField(auto_now_add, indexed)
  seen_at      DateTimeField(null)                    # badge-cleared
  addressed_at DateTimeField(null)                    # acted-on
```

- **`CheckConstraint`** — at most one of the four target FKs is set.
- **Indexes** — `(recipient, -created_at)` for the newest-first list;
  `(recipient, seen_at)` for the unread-count badge.
- **`actor` is `SET_NULL`** (not CASCADE): if the actor deletes their account we
  keep the recipient's history (the row reads as generic/"Someone") rather than
  silently vanishing rows out from under them.
- **All target FKs CASCADE**, so a notification never outlives its target — a
  reply notification whose comment was deleted is gone with it. Consequence: there
  are **no dangling deep-links** to filter at read time.

### The three states (two nullable timestamps)

| State | Condition | UI | Badge? |
|---|---|---|---|
| **unread** | `seen_at is null` | bold, accent dot | **yes** (unread count) |
| **seen** | `seen_at` set, `addressed_at` null | emphasised, badge cleared | no |
| **addressed** | `addressed_at` set | dulled, kept in history | no |

- **Opening the centre** marks all currently-unread items **seen** (`POST
  /notifications/seen/`) → the badge clears, but every item stays in the list.
- **Acting on an item** marks it **addressed**. Two ways in:
  1. **Click-through** in the dropdown (`POST /notifications/<id>/addressed/`),
     which also implies seen.
  2. **Resolve-elsewhere** — the "unify" correctness piece. Approving a connection
     request on the People page addresses that `connection_request` notification;
     accepting *or* rejecting a group invite addresses the `group_invite` one.
     Without this the unified badge would keep counting something you've already
     dealt with. (See `address_connection_request` / `address_group_invite`.)
- The **badge count is unread** (`seen_at is null`) — the number that means "new
  since I last looked."

## Event kinds & where they're generated

Notifications are created by an **explicit** `create_notification(...)` call in the
view where the action happens — deliberately **not** Django signals (easier to
read, test, and gate). `api/notifications.py` is the single choke-point for three
cross-cutting rules, so no call site can forget one.

| Kind | Generated in | Recipient | Mutable? |
|---|---|---|---|
| `post_reply` | `PostCommentsView` (top-level comment) | post author | yes |
| `comment_reply` | `PostCommentsView` (reply, `parent` set) | parent comment's author | yes |
| `reaction` | `PostReactionView` / `CommentReactionView` (toggle **add** only) | post/comment author | yes |
| `connection_request` | `ConnectView` (new pending request) | the addressee | **always-on** |
| `connection_accepted` | `ConnectView` / `ConnectionRequestActionView` (approve) | the requester | **always-on** |
| `group_invite` | `GroupMembersView` (POST) | the invitee | **always-on** |
| `event_created` / `poll_opened` / `event_scheduled` / `event_updated` / `event_cancelled` | the [group-event](events.md) views | members connected to the organiser (going/maybe RSVPs for updated/cancelled) | yes |

The five **event** kinds (Phase 8b) added a fifth concrete target FK
(`Notification.event`) and widened the "at most one target" `CheckConstraint`
accordingly — the model was built to grow this way. Their actor is always the
event's **organiser**, so rule 3 below lands them on exactly the audience that can
see the event, with no event-specific gating. `event_updated` is de-duped while
unread, like `reaction`. See [events](events.md).

### The three rules `create_notification` enforces

1. **Never notify yourself** — no-op if `recipient == actor`.
2. **Respect preferences** — a muted (mutable) kind produces **no row at all**,
   which also means no future push.
3. **Never leak an action from someone you can't see** — for the content kinds
   (`post_reply`/`comment_reply`/`reaction`) the actor must be **connected** with
   the recipient, mirroring the per-viewer pruning of the [comment tree and
   reactions](connections.md). A not-connected replier/reactor on a group post
   never surfaces second-hand. The request/invite kinds are **exempt** (a
   connection request necessarily comes from a non-connection — that's the point).

**Reaction de-dup:** a `reaction` notification is upserted while still **unread** —
react / un-react / re-react, or a second emoji on the same target, **bumps one
row** (refreshes `created_at`) rather than stacking near-identical lines. A removal
sends nothing.

## Preferences — `NotificationPreference`

One row per `(user, kind)` with `enabled` — **not** a JSON blob (queryable,
DB-unique, and adding a kind later is data, not a migration of everyone's blob).
**Absence means enabled** (opt-out): new kinds notify by default; users mute what
they don't want.

Only the **mutable** kinds (`post_reply`, `comment_reply`, `reaction`, and the five
[event](events.md) kinds) are ever written here and exposed in the API. The
connection/invite kinds are **always-on**: muting "someone wants to connect" would
hide something you must act
on — and with the badges unified, the bell is the only signal. A `PATCH` that tries
to mute an always-on kind is a 400.

## API

All endpoints are `IsAuthenticated` and **scoped to `request.user`** as recipient
— you can only ever see/mutate your own notifications (someone else's is a 404).

- `GET /api/notifications/` — your notifications, newest-first, paginated (standard
  DRF paginator). Each item is the push-ready payload below.
- `GET /api/notifications/unread-count/` — `{count}` where count = `seen_at is
  null`. Drives the bell badge; polled.
- `POST /api/notifications/seen/` — mark all currently-unread **seen**; optional
  `{ids: [...]}` to scope. Called when the dropdown opens. Idempotent.
- `POST /api/notifications/<id>/addressed/` — mark one **addressed** (implies
  seen). Idempotent.
- `GET /api/notification-preferences/` — the `{kind: bool}` map over the mutable
  kinds (defaults filled for kinds with no row).
- `PATCH /api/notification-preferences/` — partial `{kind: bool}` map; upserts.
  Returns the full merged map.

### Push-ready payload (design once, reuse for Phases 9–10)

`NotificationSerializer` emits the shape the web dropdown renders **and** the
future iPhone/Android phases turn into an OS notification + deep-link — so those
phases add only the *transport*, never a new API shape:

```jsonc
{
  "id": 123,
  "kind": "post_reply",
  "actor": { "id": 7, "display_name": "Sam Lee", "avatar_thumb": "..." },
  "text": "Sam Lee replied to your post",   // phrased server-side, per kind
  "target": { "type": "post", "id": 42 },   // the concrete thing it points at
  "url": "/p/42",                            // in-app deep-link route (permalink)
  "created_at": "2026-07-13T09:00:00Z",
  "seen": false,
  "addressed": false
}
```

- **`text`** is built server-side per `kind` (one place to phrase them; web and a
  future push payload share the wording).
- **`url`** is the in-app route. Post/reply/reaction kinds deep-link to the post
  **permalink** `/p/<id>` (see [feed-and-posts](feed-and-posts.md)); a comment
  reply/reaction adds `?comment=<id>` so the permalink page opens the thread *at
  that comment* — even one 20 replies deep. Requests → `/requests`, group invites
  → `/group-invites`, connection-accepted → the new connection's profile.
  `target {type, id}` rides along regardless, so a client can route by target
  directly without parsing the URL.

## Frontend

- **`ActivityCenter`** — the nav bell. Polls `unread-count` for the badge (reusing
  the `NavBadge` look); fetches the list only when the dropdown is **open**.
  Opening fires `seen` (badge clears, items stay); clicking a row fires `addressed`
  then navigates to `url`. Three visual states: unread = bold + accent dot, seen =
  normal weight, addressed = dulled (`opacity-60`). Empty state: "You're all caught
  up." Closes on outside-click / Escape.
- The old **People pending-request** and **Groups invite** nav badges were
  **retired** in `Layout.jsx` (the pages keep their lists; only the badge moved).
- **`NotificationPreferencesSection`** on `/settings` — a toggle per mutable kind,
  optimistic, PATCHing on change. Always-on kinds never appear.

## Out of scope (deferred)

- **Phone push** (APNs/FCM, device-token registration) — Phases 9–10. This phase
  makes the app *ready* to push (the payload above); it doesn't push to a phone.
- **Email / digest** notifications; **@-mentions** (TimeLine has no mention
  feature); notifications for **messages** (they keep the unread-count badge).
