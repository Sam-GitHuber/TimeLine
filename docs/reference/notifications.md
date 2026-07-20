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

## Phone push (Phase 9, Milestone D)

Push adds **transport only** — the payload above is what gets delivered, so the
push wording and deep-link are the same `text` and `url` the web dropdown
renders and cannot drift from it.

**Expo, not APNs directly.** The app registers and receives an *Expo push token*;
the backend sends to Expo; Expo fans out to Apple (and Google in Phase 10). So
one code path covers both platforms, the backend holds **no APNs key** (that
lives with EAS), and Phase 10 needs no schema change — only a different
`platform` value.

### Two models

- **`DevicePushToken`** — `user`, `expo_token` (**globally unique**, not per
  user), `platform`, `created_at`, `last_seen`. One user may have several. The
  global uniqueness is deliberate: a physical device maps to one Expo token, so
  registration *upserts on the token and overwrites `user`*. If someone logs out
  and a housemate logs in on the same phone, the row moves rather than leaving
  the previous owner's notifications buzzing a device they no longer control.
- **`PushOutbox`** — a queued delivery: `notification` (one-to-one, CASCADE),
  `created_at`, `sent_at`, `attempts`, `last_error`, `delivered_tokens`.

  `delivered_tokens` exists because one notification fans out to N devices
  while `sent_at` is a single flag. Without it, a phone that succeeded and a
  tablet that hit a transient error share one row: marking it sent loses the
  retry forever, and leaving it queued re-buzzes the phone that already got it.
  Recording which tokens have been reached lets a retry target **only** the
  devices still outstanding. `DeviceNotRegistered` counts as reached — retrying
  can never help — so one uninstalled app can't hold a row in the queue.

### Why an outbox rather than sending inline

`create_notification` runs inside ordinary web requests. Calling Expo's HTTP API
there would put a third-party round-trip — and its timeouts — on the critical
path of a request that has nothing to do with push. So the request only writes a
row, and `manage.py send_pushes` drains it on a systemd timer every minute
(`deploy/send-pushes.{service,timer}`; install steps in [deploy.md](../deploy.md)).
A push failure can never fail a user's action, and a send that dies halfway is
retried rather than lost — which a fire-and-forget thread could not promise.
A minute is the latency/load trade: still reads as "just happened" to a human,
without waking a process every few seconds on a home server.

**Three properties fall out of putting the enqueue in `create_notification`:**

- **Muting covers push for free.** A muted kind returns `None` *before* any row
  exists, so there's nothing to enqueue. There is deliberately no second mute
  check to keep in sync.
- **A push for deleted content cannot fire.** The cascade chain is target →
  `Notification` → `PushOutbox`, so deleting a post takes its queued pushes with
  it. This is what makes the deep-link map safe: no dangling targets to defend
  against.
- **Dedup means one buzz, not several.** The `reaction` / `event_updated` dedup
  path refreshes a still-unread notification instead of creating one, and
  returns before the enqueue — so a re-reaction or a second edit doesn't buzz
  again for something the recipient was already told about. The mild cost: two
  quick edits to an event produce one push.

### Sending

Device tokens are resolved at **send** time, not enqueue time, so a token that
rotates in between still gets the push and a device that logged out doesn't.
The command batches to Expo (100/request, its documented maximum), then reads
the per-message tickets:

- `ok` → mark `sent_at`.
- `DeviceNotRegistered` → **delete the device row**. This is the only signal Expo
  gives that a token is permanently dead (app uninstalled), so uninstalls
  self-clean instead of accumulating.
- any other error → record it, increment `attempts`, leave queued. After
  `MAX_ATTEMPTS` (5) the row stops being retried, so one poisoned row can't be
  re-sent on every tick forever.

A recipient with **no** registered device is marked sent immediately without
calling Expo — otherwise a web-only user's rows would retry on every tick.
Delivered rows are kept ~14 days as a delivery log, then pruned.

`EXPO_ACCESS_TOKEN` is optional but wanted in production: with it set, Expo
*rejects* sends that don't carry it, which stops anyone who learns one of your
users' push tokens from pushing to them under your app's name.

Two settings, deliberately separate because they count different things:
`EXPO_PUSH_BATCH_SIZE` is **messages per HTTP request** (100, Expo's documented
maximum); `EXPO_PUSH_MAX_ROWS` is **outbox rows per run** (200). One
notification becomes several messages, so letting one bound the other would
make the drain's real workload hard to reason about.

The drain claims its rows with `select_for_update(skip_locked=True)`, so a
hand-run during a timer tick takes different rows rather than sending the same
push twice.

### What leaves the box, and who sees it

Worth being explicit, since privacy-first is a project non-negotiable and push
is the first feature that hands user data to a third party.

A push carries: the Expo push token, the title `TimeLine`, the server-phrased
line (*"Ada replied to your post"*), and the deep-link route. It travels to
**Expo's push service**, then to **Apple's APNs**, before reaching the phone.
So both see a recipient's device token and the **display name of the person who
acted**.

Deliberately **not** included: any post or comment text, any photo, any email
address. A push names people but never quotes them — so a lock screen in a café
leaks no content, and the third parties in the path see no conversation.

**Why Expo rather than talking to APNs directly.** Direct APNs would keep
Apple in the path but remove Expo from it, at the cost of holding and rotating
an APNs key on the box, implementing JWT-signed APNs auth, and writing the
whole thing again for FCM in Phase 10. Expo was chosen as the well-trodden
option; the data it sees is one name per notification, and no content. If that
trade ever stops looking right, the swap is confined to `send_pushes` — nothing
else knows how a push is delivered.

### App side (`mobile/src/push.ts`)

**Registration** runs on sign-in *and* on every launch that restores a session —
Expo can rotate a device's token, and the backend upserts, so re-registering is
cheap and keeps `last_seen` honest. A user permanently logged in would otherwise
register exactly once, ever. It is fire-and-forget on the login path and
**never throws**: no push failure may stop someone signing in. It no-ops on a
simulator (`Device.isDevice`), where `getExpoPushTokenAsync` throws.

**Unregistration runs *before* `api.logout()`**, not after — the endpoint is
authenticated, so once logout has cleared the tokens the DELETE would 401 and
the row would survive, leaving the phone buzzing with the previous user's
notifications. The Expo token is kept in SecureStore precisely so logout can
name *this* device without re-deriving it, which would fail exactly when the
network is flaky. This is the other half of the upsert-on-token rule above.

**A session that *expires* can't unregister at all**, and doesn't try: the
endpoint needs auth, and an expired session is precisely the absence of it —
calling it would 401, trigger a refresh, fail, and re-enter the session-expired
handler that made the call. So that path drops only the local token
(`forgetLocalPushToken`). The server row survives, which is safe: an expiry
doesn't change whose phone it is, the notifications still belong to the person
holding it, and the handed-on-phone case is covered from the other end by
upsert-on-token when the next person logs in.

**Taps** are handled with `useLastNotificationResponse`, which covers a
cold-start launch *and* a tap while running in one API. The listener-only
approach (`addNotificationResponseReceivedListener`) misses the cold start —
the response fires before any listener mounts — which is the classic way this
ships broken. Two guards: dedupe by notification identifier (the hook keeps
returning the same response on re-renders), and wait for `signedIn` so a
cold-start tap doesn't race the auth gate's redirect to `/login`. Tapping marks
the notification **addressed**, matching the web dropdown's click-through.

**Route mapping** (`routeForNotification`) translates the server's one `url`
into a mobile route: `/p/42` → `/post/42`, `?comment=` preserved, `/u/3`
unchanged. Targets whose screens don't exist yet — `/requests` (E1),
`/group-invites` and `/g/…/events/…` (E3) — fall back to the feed, so a
notification always opens the app rather than crashing it. Add cases as those
milestones land.

A foreground `setNotificationHandler` shows banners while the app is open,
which iOS otherwise suppresses: there's no in-app activity centre on mobile
until Milestone E, so a suppressed notification would be lost, not merely
redundant.

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

- **Android push** — Phase 10. The Expo transport above already covers it; only
  a different `platform` value and an FCM credential are outstanding.
- **Email / digest** notifications; **@-mentions** (TimeLine has no mention
  feature); notifications for **messages** (they keep the unread-count badge).
