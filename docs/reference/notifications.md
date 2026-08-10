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
  are **no dangling deep-links** to filter at read time. A **soft**-deleted
  comment (issue #128 — the tombstone that survives to hold replies up) has no
  CASCADE to ride, so the delete view clears its notifications by hand: the two
  delete paths must leave the recipient in the same place, and a deep-link into a
  blank placeholder is exactly the dangling link this bullet promises doesn't
  exist.

### The three states (two nullable timestamps)

| State | Condition | UI | Badge? |
|---|---|---|---|
| **unread** | `seen_at is null` | bold, accent dot | **yes** (unread count) |
| **seen** | `seen_at` set, `addressed_at` null | emphasised, badge cleared | no |
| **addressed** | `addressed_at` set | dulled, kept in history | no |

- **Opening the centre** marks all currently-unread items **seen** (`POST
  /notifications/seen/`) → the badge clears, but every item stays in the list.
  ⚠️ **On both clients that write waits for the list to arrive** (#312 for the
  app, #314 for the web). It used to
  fire from a mount effect, unconditionally, and the two came apart in the case
  that matters: open the bell with no signal, the fetch fails, and the screen —
  which had no error branch at all — said *You're all caught up* while the POST
  cleared every unread server-side. The badge that would have brought the reader
  back was gone, and the screen had just told them there was nothing to come
  back for. It is gated on `listLoaded` (the same value the empty/error branches
  read) rather than `isSuccess`, because a warm list whose *refetch* failed is
  still a screen full of notifications someone is looking at. That is the
  #307/#308 rule on a second surface: a write that mirrors what the reader has
  *seen* rides the read that showed it to them, not a render that happened
  anyway. `ActivityCenter.jsx` gates on the same `listLoaded`, fires once per
  *open* (a ref, since the panel stays mounted and the badge poll keeps moving
  underneath it), and carries a `.catch()` — a failed seen-write leaves the
  badge up, which is the honest answer, and the next open tries again. On the
  web it had the extra failure the app can't have: the badge is a *separate*
  query, so a succeeding count poll beside a failing list fetch put "Activity, 5
  unread" directly above "You're all caught up".
- **Acting on an item** marks it **addressed**. Two ways in:
  1. **Click-through** in the dropdown (`POST /notifications/<id>/addressed/`),
     which also implies seen.
  2. **Resolve-elsewhere** — the "unify" correctness piece. Approving a connection
     request on the People page addresses that `connection_request` notification;
     accepting *or* rejecting a group invite addresses the `group_invite` one.
     Without this the unified badge would keep counting something you've already
     dealt with. (See `address_connection_request` / `address_group_invite`.)
- **Viewing the content marks its notifications seen** (2026-08-01) — the
  content half of resolve-elsewhere. Fetching a post's permalink
  (`PostDetailView` GET) or its comment tree (`PostCommentsView` GET) marks
  every unread notification pointing at that post *or any comment on it* seen;
  opening an event (`EventDetailView` GET) does the same for everything aimed at
  that event or at a comment on it. Reading the reply **is** reading the
  notification: without this, the
  badge kept counting a reply someone had gone and read via the feed, which
  read as "the badge won't clear". Seen only, never addressed — the row keeps
  its not-yet-dealt-with weight in the centre. Matched on the target FKs, not
  kinds (anything aimed at content you're looking at is, by definition, seen).
  See `see_post_notifications` / `see_event_notifications` in
  `notifications.py`; the comment-tree hook sits beside the `PostCommentRead`
  stamp, which is the same "opening the thread is the seen event" rule for the
  "N new comments" count. Safe from scroll-by: both clients load comments only
  on a deliberate open (the web feed's thread is lazy; mobile's lives on the
  post screen). The mobile post/event screens invalidate
  `['notificationsUnread']` once their fetch lands, so the icon badge drops
  immediately rather than on the bell's next poll — and dismiss the delivered
  pushes for that post/event from the tray (the #178 rule below: an OS
  notification is a badge signal). The web bell self-corrects on its 12s poll.
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
| `event_comment` | `EventCommentsView` (top-level comment) | the event's **organiser** | yes |
| `event_photos` | `EventPhotosView` (POST) | going/maybe RSVPs **∩ the uploader's connections** | yes |

The five **event** kinds (Phase 8b) added a fifth concrete target FK
(`Notification.event`) and widened the "at most one target" `CheckConstraint`
accordingly — the model was built to grow this way. Their actor is always the
event's **organiser**, so rule 3 below lands them on exactly the audience that can
see the event, with no event-specific gating. `event_updated` is de-duped while
unread, like `reaction`. See [events](events.md).

The two later event kinds break that "actor is the organiser" pattern, and the
break is what makes each interesting. `event_comment` is the event twin of
`post_reply` — actor the commenter, recipient the organiser — and its Android
channel is **`replies`, not `events`**, because the channel groups by what the
notification *is* to the person getting it and this is somebody answering you.
`event_photos` keeps the `events` channel (an announcement about the event) but
is the one kind here where **rule 3 does real work**: its actor is the
uploader, two people in an event's audience needn't be connected to each other,
and the album prunes on the uploader — so a going RSVP who can't see those
photos must not be told about them. It is also de-duped while unread, because
people upload in batches. See [events](events.md).

### The three rules `create_notification` enforces

1. **Never notify yourself** — no-op if `recipient == actor`.
2. **Respect preferences** — a muted (mutable) kind produces **no row at all**,
   which also means no future push. This is stronger than the convention
   elsewhere, where muting silences the push but keeps the in-app record to catch
   up on: here a muted event leaves **no trace in the activity centre either**.

   **Deliberate, and reaffirmed 2026-07-21.** Mute is read as "I don't want to
   know about this", not "tell me quietly" — so the event is never recorded. The
   cost is accepted: a muted reply is discoverable only by opening the post
   itself. The benefit is that the preference check sits at the top of
   `create_notification`, so **every** downstream channel (activity centre, push,
   and anything added later) inherits muting for free, with no second check that
   could drift out of sync. Moving the check to the push enqueue would be the
   change to make if this is ever revisited.
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

Only the **mutable** kinds (`post_reply`, `comment_reply`, `reaction`, all seven
[event](events.md) kinds — the organiser's five broadcasts plus `event_comment`
and `event_photos` — and `mention`) are ever written here and exposed in the
API. The
connection/invite kinds are **always-on**: muting "someone wants to connect" would
hide something you must act
on — and with the badges unified, the bell is the only signal. A `PATCH` that tries
to mute an always-on kind is a 400.

**`mention` is the odd one, and deliberately so** (Phase 9b M8). No
`Notification` row is *ever* created with that kind — messaging keeps its own
unread badge and stays outside the bell. The kind exists because the preference
needs a home, and what it governs is a genuine delivery: whether an `@mention`
notifies you **in a chat you muted**. Putting it here buys the
absence-means-enabled rule, the `{kind: bool}` API and both clients' Settings
screens for nothing.

It is *not* a blanket mentions on/off, and it's labelled as exactly what it does
— *"Let @mentions notify me in muted chats"*. A mention in an unmuted thread
notifies either way, through the ordinary message push; a muted thread with this
off stays fully silent. Getting that backwards would hand someone a setting that
silences mentions they wanted. See
[messaging.md](messaging.md#-a-mention-is-a-relation-and-the-only-thing-that-beats-mute).

**What does *not* belong here, and why the boundary is worth stating.** A row is
keyed by a notification *kind*, so a preference only lives here if there is
something being created and delivered to switch off. Two settings deliberately
sit elsewhere:

- **`Participant.muted_at`** — silencing one conversation. Per-thread, and there
  is no "message" notification kind (messaging stays out of the bell entirely —
  see [messaging.md](messaging.md#push-notifications)).
- **`accounts.User.send_read_receipts`** — whether you share read state. Nothing
  is ever notified when someone reads a message; the setting governs a *payload
  field*, not a delivery. See
  [messaging.md](messaging.md#the-setting-usersend_read_receipts). Read it beside
  `mention` above: the two placements are the same rule applied honestly, not an
  inconsistency.

Both are on the object the setting actually describes rather than in a preference
table that would have to invent a fake kind to hold them. The rule is simply: if
switching it off doesn't stop a `Notification` or a push, it isn't a notification
preference.

## API

All endpoints are `IsAuthenticated` and **scoped to `request.user`** as recipient
— you can only ever see/mutate your own notifications (someone else's is a 404).
`POST /notifications/seen/` reads its body by hand, so its `ids` go through the
shared id coercion — see
[accounts.md § Security posture](accounts.md#security-posture) for the rule.
**An absent `ids` marks everything unread as seen; an explicit `null` is a 400**,
because a client whose array came back undefined hasn't asked to clear the whole
centre.

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
`platform` value, plus the `channelId` described under "Android notification
channels" below.

### Three models

- **`DevicePushToken`** — `user`, `expo_token` (**globally unique**, not per
  user), `platform`, `created_at`, `last_seen`. One user may have several. The
  global uniqueness is deliberate: a physical device maps to one Expo token, so
  registration *upserts on the token and overwrites `user`*. If someone logs out
  and a housemate logs in on the same phone, the row moves rather than leaving
  the previous owner's notifications buzzing a device they no longer control.
- **`PushOutbox`** — a queued delivery: `notification` (one-to-one, CASCADE),
  `message` (FK, CASCADE), `recipient`, `created_at`, `sent_at`, `attempts`,
  `last_error`, `delivered_tokens`.

  **Exactly one of `notification` and `message` is set**, by check constraint.
  The `message` target (issue #118) lets a direct/group message buzz a phone
  **without** creating a `Notification` row: messaging keeps its own unread badge
  and sits outside the activity centre, so a row per message would double-surface
  every one of them in the bell. It points at the `Message` rather than carrying a
  free-text body, which keeps the cascade guarantee below and leaves no way to
  store message text in a push. The wording rules and gating are messaging's, and
  live in [messaging.md](messaging.md#push-notifications).

  `recipient` is denormalised (backfilled from `notification.recipient` in
  migration `0021`) so the drain reads one field whichever target is set. Safe
  because a notification's recipient is fixed at creation — there's nothing for
  the copy to drift from.

  `delivered_tokens` exists because one notification fans out to N devices
  while `sent_at` is a single flag. Without it, a phone that succeeded and a
  tablet that hit a transient error share one row: marking it sent loses the
  retry forever, and leaving it queued re-buzzes the phone that already got it.
  Recording which tokens have been reached lets a retry target **only** the
  devices still outstanding. `DeviceNotRegistered` counts as reached — retrying
  can never help — so one uninstalled app can't hold a row in the queue.

- **`PushReceipt`** — one accepted Expo **ticket** awaiting its delivery
  **receipt**: `ticket_id`, `expo_token`, `created_at`. Its own table rather than
  a field on `PushOutbox` because the grain is the *ticket*, not the
  notification (one row fans out to N devices), because outbox rows are pruned
  once delivered and would take unchecked tickets with them, and because the two
  have unrelated lifecycles. `expo_token` is denormalised as a plain string on
  purpose — an FK would cascade the receipt away with the very device it exists
  to condemn.

### Tickets vs receipts — and why both are needed

Expo answers a send in two stages, and conflating them is the trap here:

- A **ticket** comes back synchronously, one per message. `status: "ok"` means
  Expo *accepted and validated* the message — nothing more.
- A **receipt**, fetched later from `getReceipts`, is what says whether Apple or
  Google actually delivered it.

So an `ok` ticket is **not proof a handset buzzed**. The failure that makes this
matter is silent: a token alive at registration but dead by delivery (app
deleted, token retired by the OS) still produces an `ok` ticket. Settling on the
ticket alone would record the row delivered, never show the push, and never clean
up the `DevicePushToken` — so dead tokens would accumulate forever, each wasting
a message on every future notification. Ticket-time `DeviceNotRegistered`
handling catches only tokens already dead when we sent, which is the easy half.

`send_pushes` therefore records a `PushReceipt` per accepted ticket and checks
them on a later run. Four outcomes:

| Receipt | Action |
|---|---|
| `ok` | Delivered. Drop the row. |
| `DeviceNotRegistered` | **Delete the `DevicePushToken`** — the reason this pass exists. |
| any other error | Log and drop. Nothing to retry: the message is gone and the outbox row was settled at ticket time. |
| absent from the reply | Expo has no receipt *yet*. Leave it for a later run. |

Timing is bounded at both ends (`EXPO_RECEIPT_*` in `settings.py`): a ticket is
asked about after **15 min** (sooner just returns "not ready" and burns a
request) and given up on after **24 h**, which is when Expo discards receipts.
That expiry is load-bearing — without it `PushReceipt` would grow without bound,
reproducing the exact leak it was built to fix.

The check runs **outside the drain's transaction**, so a receipts failure can't
roll back sends that already succeeded, and a send failure can't stop dead
tokens being reaped.

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
  against. Message pushes get the same guarantee from the same cascade
  (`Conversation` → `Message` → `PushOutbox`) **plus** an explicit check at send
  time, because message deletion is *soft* and so leaves the row standing — see
  [messaging.md](messaging.md#push-notifications).
- **Dedup means one buzz, not several.** The `reaction` / `event_updated` /
  `event_photos` dedup path (`_DEDUP_KINDS`) refreshes a still-unread
  notification instead of creating one, and returns before the enqueue — so a
  re-reaction, a second edit, or a second batch of photos doesn't buzz again for
  something the recipient was already told about. The mild cost: two quick edits
  to an event produce one push.

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

### Replying from the notification (Phase 9b M8)

A **message** push carries `categoryId: "message"` — an iOS notification
category, which is what puts a text field under the push when it's pulled down.
The app registers that category with a single `reply` action at launch (see
`mobile/src/push.ts`), and `opensAppToForeground: false` is the point of it: the
reply is sent without the app taking over the screen someone was on.

Only message pushes carry it. Replying to *"Ada replied to your post"* would mean
posting a comment from the lock screen — a different feature against a different
endpoint. A kind that grows an action later opts in by adding a category to its
payload rather than by changing the sender.

Two things about this are easy to get wrong:

- **The category name must match on both sides.** iOS silently ignores one it
  doesn't know, which looks precisely like the feature not existing — so the
  string is pinned by a test in the backend suite *and* in the app's.
- **The reply comes back through the ordinary send endpoint**, from the app.
  Nothing in the push path receives anything; Expo is a one-way street. What the
  app does when that send fails is described in
  [messaging.md](messaging.md#replying-from-the-notification-phase-9b-m8) — it
  keeps the words rather than dropping them.

### Android notification channels (Phase 10)

Android 8+ files every notification into a **channel**, and the channel — not
the app — owns whether it makes a sound, shows a heads-up banner, or stays
silent. The user tunes each one in system settings, which is the point: *"let
messages interrupt me but keep reactions quiet"* becomes something they decide
without us building a screen for it.

Every push therefore carries a **`channelId`** (`_message` in `send_pushes`),
derived from its `kind` by `notifications.channel_for_kind`. iOS ignores the
field.

Six channels, mirroring the **per-type preference groups** so the OS control and
the in-app one tell the same story:

| Channel | Kinds | Importance |
|---|---|---|
| `messages` | the message push (no `Notification` row) | high |
| `mentions` | `mention` | high |
| `replies` | `post_reply`, `comment_reply`, `event_comment` | default |
| `reactions` | `reaction` | **low** — nice to know, never urgent, and a popular post shouldn't buzz a pocket twenty times |
| `events` | the organiser's five broadcast kinds **+ `event_photos`** | default |
| `social` | `connection_request`, `connection_accepted`, `group_invite` | default |

Deliberately **not one channel per kind**: six separate event channels would be
a wall of switches nobody reads. The two kinds whose actor *isn't* the organiser
land on opposite sides of that grouping — `event_comment` in `replies`,
`event_photos` in `events` — because the channel asks what the notification *is*
to the person receiving it, not who generated it (see above).

Three properties that make this fussier than it looks:

- **A push naming a channel the device doesn't have is dropped silently.** It
  does *not* fall back to a default, and nothing appears in any log — so a
  mismatch between the two lists looks exactly like push being broken. The ids
  are therefore hard-coded on **both** sides (`ANDROID_CHANNELS` here,
  `CHANNELS` in `mobile/src/push.ts`) with a test on each pinning the set. A
  test that derived them from the code it checks would agree with itself while
  the two processes drifted apart. Same belt-and-braces as `MESSAGE_CATEGORY`.
- **A channel is immutable once created on a device.** Changing an importance in
  code does nothing for anyone who already has the app — only a new channel id
  takes effect, and that loses whatever the user had tuned. So the importances
  above are chosen to be lived with.
- **The channels are created at launch, not at login** (`_layout.tsx`), for the
  same reason as the iOS categories: a push can arrive before anyone signs in,
  and the channel must exist before the notification does.

A kind with no mapping falls back to `social` rather than being dropped — but a
test enumerates `Notification.Kind`, so adding a kind without a channel fails the
suite rather than quietly half-working.

### What leaves the box, and who sees it

Worth being explicit, since privacy-first is a project non-negotiable and push
is the first feature that hands user data to a third party.

A push carries: the Expo push token, the title `TimeLine`, the server-phrased
line (*"Ada replied to your post"*), and the deep-link route. It travels to
**Expo's push service**, then to **Apple's APNs** or **Google's FCM** (Phase 10),
before reaching the phone. So both see a recipient's device token and the
**display name of the person who acted**.

**The deep-link route is metadata, and it is not nothing.** A message push
carries `"url": "/messages/<conversation id>"` (`send_pushes.py:287`), so the
services in the path see a stable identifier for *which* thread buzzed, and can
count how often it does. That's defensible — it's the price of a push that opens
the right screen, it names no participant and quotes no text — but it means the
honest claim is "no content", not "no conversation".

A mention says *"Ada mentioned you"* (Phase 9b M8) — which is the same rule, and
earns its place because a chat you silenced suddenly buzzing owes you an
explanation.

**The icon badge is metadata too** (#179). Every push carries a `badge` — the
recipient's total unread count — so the services in the path also see *how much*
is waiting for a device, and can watch that number rise and fall. Same category
as the deep-link route above: a count, naming nobody and quoting nothing, and
the only way to put a number on the icon of a phone that isn't running the app.

Deliberately **not** included: any post, comment **or message** text, any photo,
any email address. A push names people but never quotes them — so a lock screen
in a café leaks no content. That rule is what makes pushing private messages
acceptable: a new message says *"New message from Ada"* and nothing more.

**The known cost of that rule** (2026-07-30). It collides with the **Reply**
action a message push carries (Phase 9b M8): you get a text field for a message
you cannot read. The fix is *not* to start putting message text in the body —
that would hand every private message's plaintext to Expo, Apple and Google, and
under E2E the server won't be able to compose one anyway. It's to fill the body
in **on the device, after the push arrives and before it is shown**, in an iOS
**Notification Service Extension** and its Android equivalent — so the
notification gains content without the content ever entering the push path.
That's [Phase 10b](../phases/phase-10b-notification-content.md), which has the
extension **fetch** the body over TLS from our own server;
[Phase 9c](../phases/phase-9c-e2e-encryption.md) later swaps that fetch for a
local **decrypt**, once there's a ciphertext to decrypt.

**Until 10b ships, the rule above stands exactly as written.** After it, the
push still carries no message content — but two smaller things change, and this
section should be rewritten rather than appended to when they do:

- Previews are **per device and off by default**, so a push to an opted-in
  device sets `mutableContent`. Its presence on the wire is therefore a readout
  of one privacy setting, visible to Expo and Apple.
- The **device** learns more, from us, over TLS. That's the point of the design:
  the extra content moves on the one leg of the journey that has no third party
  in it.

**Why Expo rather than talking to APNs directly.** Direct APNs would keep
Apple in the path but remove Expo from it, at the cost of holding and rotating
an APNs key on the box, implementing JWT-signed APNs auth, and writing the
whole thing again for FCM in Phase 10. Expo was chosen as the well-trodden
option; the data it sees is one name per notification, and no content. If that
trade ever stops looking right, the swap is confined to `send_pushes` — nothing
else knows how a push is delivered.

### App side (`mobile/src/push.ts`)

**Where registration is possible** is not simply "a real device". `registerForPush`
asks `canRegisterForPush()`, which is `Device.isDevice || Platform.OS === 'android'`.
The `isDevice` check is really asking *"is this the iOS Simulator"*, where
`getExpoPushTokenAsync` throws; an **Android emulator on a Google Play system
image** has genuine Play Services and registers a genuine FCM token. Excluding it
bought nothing and cost the only way to test Android push without owning a phone
— and the failure was silent, indistinguishable from push being broken.

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

**Registering and unregistering are sequenced against each other (#219).**
Fire-and-forget registration plus an awaited unregister is a race: sign in and
immediately sign out, and unregister finds no stored token yet, no-ops, and the
registration lands *after* the session ended — recreating the server row and
rewriting the local token, so the phone keeps delivering the previous user's
notifications, message content included. `push.ts` holds the in-flight
registration in a module-level record alongside a **session epoch** that every
teardown bumps. A registration checks the epoch immediately before its first
write and abandons itself if it has moved; the flag saying it got past that
check is set in the *same synchronous step*, so a teardown can tell with
certainty whether it must wait. It waits only for a registration already past
that point — never for the permission prompt, which the user can leave on screen
indefinitely and which nothing could cancel anyway. By the time
`unregisterPush` reads SecureStore, then, either nothing was written or
everything was.

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

A tap navigates with **`router.navigate`, never `router.push`** (#177). `push`
appends a screen unconditionally, so a push for the thread you were already
reading stacked a second copy of it and Back walked through the duplicates one
at a time instead of returning to the list — one extra copy per push opened.
`navigate` replaces the top screen in place when the route name *and* its path
params match (expo-router's `getSingularId`), reusing the existing screen's key
so nothing remounts, and pushes normally for a genuinely different target. The
activity centre's rows go through the same verb, so in-app and push
click-through still agree.

Deliberately **not `dismissTo`**, which would pop back to a match anywhere in the
stack rather than only the top. No screen sets `dangerouslySingular`, so its
router matches by route *name* alone — a push for conversation 5 tapped while
reading conversation 9 would pop 9 off and reuse its screen. Matching on the
params is the point.

**What `navigate` does not cover**, all of it a consequence of it comparing only
the top of the stack:

- A push for `/messages/5` tapped while on `/messages/5/info` still stacks a
  thread screen above the info screen.
- A push whose target is a **tab** (`/`, `/people`, `/groups`), tapped from a
  stack screen like a thread, appends a second `(tabs)` route rather than
  reusing the one underneath. Not the `PUSH`-vs-`NAVIGATE` distinction: expo
  -router downgrades `PUSH` outside a stack, but that test is on the navigator
  where the action and the current state *diverge* (`findDivergentState`), and
  from a thread that navigator is the root **stack**. It doesn't accumulate —
  the second tap diverges inside the tab navigator and jumps — and Back returns
  where you were, so it's left alone.
- Tapping a message push for the thread already on screen is now visibly
  nothing: the screen doesn't remount, and its open-at-the-unread-divider jump
  is deliberately once-per-mount so a poll can't yank a reader back
  (`[conversationId].tsx`). The message still arrives on the four-second poll,
  with jump-to-latest one tap away. Making a tap mean "take me to the newest"
  needs a re-open signal into the screen, which is its own change.

A second deep link **is** honoured within a screen that stays mounted, which
took two fixes once the remount went away: `[postId].tsx` re-arms its
scrolled-once guard when the `comment` param changes, and `CommentThread`
reopens a branch that a *new* target sits in (keyed on the target, not on the
expand set, which is rebuilt on every poll and would otherwise spring open a
branch the reader had just collapsed).

**Route mapping** (`routeForNotification`) translates the server's one `url`
into a mobile route: `/p/42` → `/post/42` (`?comment=` preserved), `/u/3`
unchanged, `/requests` → `/people`, `/group-invites` → `/groups`,
`/g/<gid>/events/<eid>` → `/events/<eid>` (mobile keeps events flat), and
`/messages/<id>` → `/messages/[conversationId]`. Anything unrecognised falls back
to the feed, so a notification always opens the app rather than crashing it.

The message case is the odd one: it's the only push with no `Notification` behind
it, so it arrives with `kind: "message"` and `notificationId: null`. Nothing
downstream needs to care — the tap can't mark an activity-centre row addressed
because there isn't one, and the thread screen's mark-read-on-open is what clears
its badge instead.

A foreground `setNotificationHandler` shows banners while the app is open,
which iOS otherwise suppresses: there's no in-app activity centre on mobile
until Milestone E, so a suppressed notification would be lost, not merely
redundant. Its one exception is the on-screen thread — see below.

### Taking a notification back once it's been dealt with (#178)

Push used to be **write-only**: once delivered, a notification sat in the
phone's notification centre until it was tapped or swiped, however thoroughly
you had since read it *in the app*. Read everything in a thread, go back to the
home screen, and "New message from Ada" was still on the lock screen. The server
already did the *pre*-delivery half well — `_should_drop` bins a queued message
push whose read marker has moved past it, so a thread you read before the timer
ticked never buzzes — but nothing existed for after delivery.

Seven things now remove one. All of them are **local** —
`getPresentedNotificationsAsync` + `dismissNotificationAsync` — with no new
payload field and no backend change.

| When | What it clears | Where |
|---|---|---|
| The thread screen marks itself read (on open, and as messages land) — **only once the transcript has actually loaded** (#321) | every notification whose `url` is `/messages/<this id>` | `[conversationId].tsx` |
| **Mark read** swiped on a row in the conversation list | the same | `(tabs)/messages.tsx` |
| The activity centre marks everything seen (on open) | every notification carrying a `notificationId` | `activity.tsx` |
| A **Reply** typed into a notification *lands* | that conversation's notifications | `usePushTaps.ts` |
| A message arrives for the thread already on screen | that one, as it arrives | `push.ts` |
| The app opens, and each time it returns to the foreground | conversations the payload now reports as `unread_count: 0` | `usePushDismissals.ts` |
| The post / event **GET resolves** (that GET marked the notifications seen — viewing is seeing, above) | that post's (`/p/<id>`, `?comment=` included) / that event's | `post/[postId].tsx`, `events/[eventId].tsx` — inside the `queryFn`, via `dismissPostNotifications` / `dismissEventNotifications` |

Both mark-read paths are listed on purpose: dealing with a thread from the list
is the same act as reading it, and covering only the thread screen left the badge
clearing while the lock screen kept its notification.

⚠️ **A dismissal is not undoable, so the thing that triggers it has to be sure.**
The thread screen's row above waits for the *transcript*, not merely for the
conversation (#321): its header and composer render from a different query and
are fine while the messages are errored, so it used to clear the tray for a
thread whose messages the reader was being told we couldn't load — told there is
nothing there, and robbed of the one signal that would bring them back. The guard
is `!!pages`, not "the messages query hasn't errored": the latter still fires on
the commit *before* the request fails, which was the same trap the post and event
screens fell into.

**On those two, no guard was sufficient and the dismissal moved into the
`queryFn` (#318).** `useQuery` returns a cached post/event *synchronously*, so an
effect gated on `!!data` fired on the first commit of a warm reopen — before the
mount refetch had asked the server anything. Tap a reply push within `gcTime`,
have the refetch 404 (deleted post; cancelled-then-deleted event), and the screen
said the thing was gone while the notification and the badge that would have
explained it were already cleared. A `!notFound && !!data` guard reads as the fix
but isn't: a cached entry carries no error yet on that commit. Dismissing after
the `await` instead means a 404 rejects first and a cached render never dismisses
at all — the same move `CommentThread` made in #307/#308 for its seen-stamp
mirror. It now runs on each successful fetch rather than once per mount, which is
deliberate and is the point rather than a side effect: **the server stamps on
every one of those GETs too**, so mirroring once per mount left the app's own
tray and badge lagging its backend. Nothing in that block may throw — the
server has already stamped by then, and a throw would reject a GET that succeeded
(see `postCache.ts`'s note in the same position).

**Three GETs stamp, so three mirror.** The third is the comment tree, and it is
the one that hides: `PostCommentsView.get` calls `_see_notifications` beside its
own `PostCommentRead` upsert, so opening a thread marks the post's/event's
notifications seen exactly as fetching the post does — but until #318's review
`CommentThread` mirrored only the `· N new` count. A warm reopen whose *detail*
fetch failed while its *comments* fetch succeeded therefore left a push in the
tray and a number on the badge that nothing would clear, the server having
already decided both were read. All three call `mirrorPostSeen` /
`mirrorEventSeen` (`mobile/src/seenMirror.ts`), which is the single place that
answers "what does a seen-stamp imply locally" — the count half stays out of it,
because only the comments GET stamps `PostCommentRead` and clearing that from a
detail fetch would hide comments nobody has been shown.

The same guard governs **`setOnScreenConversation`**, which is a suppression
rather than a dismissal and so easier to overlook. Claiming the thread makes the
foreground handler return `shouldShowList: false` for its pushes (the row above,
and *Show notifications that arrive while the app is foregrounded* in `push.ts`)
— so while the transcript was an error card, a message arriving for that chat
bannered once and was never filed here at all. It claims the thread only while
it can actually show it.

Notifications are matched on the push's own `url`, parsed with the same
`conversationIdFromUrl` the deep link uses — one shape on the wire, with no
second conversation field to fall out of step with it. The activity centre's
sweep keys on `notificationId` instead, which is exactly what separates the two
kinds of push down at tray level: a message push has no `Notification` row and
sends `null`, so opening the bell can never clear a message you haven't read.

**A message for the thread you're looking at is no longer filed.** The handler
returns `shouldShowList: false` when the push's conversation is the one on
screen (tracked by `setOnScreenConversation`, set on **focus** — the thread stays
mounted under its own info screen and must stop claiming pushes once it isn't on
top). The banner is deliberately kept: it's transient, and at worst redundant.

That covers iOS, which honours banner and notification-centre entry
independently. **Android has no such split** —
`NotificationBehaviorRecord.shouldPresentAlert` is `shouldShowBanner ||
shouldShowList`, so anything that banners is posted to the shade whatever the
handler says. Nor can the mark-read effect be relied on to mop it up: that effect
re-runs on the message *count*, and the thread's four-second poll usually adds
the message before the push lands, so the count doesn't change and the effect
doesn't fire. So on Android the **arrival itself** is the trigger —
`configureOnScreenDismissal` registers one `addNotificationReceivedListener` for
the app's lifetime, which dismisses a push whose conversation is the one on
screen. A no-op on iOS, where there's nothing in the tray to dismiss.

**Every path swallows its failures**, like the rest of `push.ts`. The worst
outcome of a failed dismissal is the behaviour we had all along — a notification
that stays put — so none of it may fail loudly at the moment someone is reading a
thread. `conversationIdFromUrl` is **total** for the same reason: the foreground
handler calls it on every arriving push, `data` is untyped JSON off the wire, and
a handler that *rejects* means the notification isn't presented at all.

Three things about the foreground reconcile specifically:

- **It runs on mount as well as on every AppState foreground.** A cold start —
  tapping the icon after the process was killed — emits no AppState change at
  all, and that's the commonest way the app is opened.
- **It reads the tray before fetching anything.** The overwhelmingly common
  foreground has nothing waiting, and it must not add a request to every one of
  them.
- **It dismisses the notifications it looked at, not whatever is in the tray
  afterwards.** The `unread_count` it judges by was fetched before the round
  trip, so a message arriving *during* that window would otherwise be dismissed
  on the strength of a count that predates it — the one way this feature could
  hide something genuinely unread. Holding the identifiers from the first read
  closes that and saves a second trip across the bridge.

It looks only at the first page of conversations, which is safe in the same
direction as everything else here: a thread too far down simply isn't dismissed.

**A reply dismisses on success only.** A failed reply has changed nothing
server-side — the read marker moves inside the send's transaction — so the thread
is still unread, and with no screen in front of anyone (that path runs in the
background by design) the notification is the only remaining trace that something
is waiting. The words are kept in the outbox; the prompt is kept in the tray.

**What none of this covers is reading somewhere else** — the web, or a second
phone. There is no APNs/FCM "unsend"; reaching a phone that isn't running the app
means sending it something, and both silent-delivery paths are best-effort by
construction (iOS budgets and throttles `_contentAvailable` and drops it entirely
after a force-quit; Android may deliver nothing at all from a stopped state).
That half is deliberately parked on **Phase 10b's** background-delivery spike
rather than guessed at, and the foreground reconcile is the cheap 80% of it in
the meantime.

### The app-icon badge (#179)

The home-screen icon carries a number: **unread messages + unread activity**.

**Why the sum.** There are deliberately two counts — the Messages tab badge and
the activity bell — because messaging sits outside the activity centre (see
*Out of scope*). One icon badge is one number, so it has to be a sum, a choice,
or nothing. It sums, and the *same* decision that makes two in-app badges
correct is what makes one summed icon badge honest: because messages are
excluded from the bell, there is nothing counted twice. `badge_count_for`
(`views.py`) adds `unread_message_total` to `unread_notification_total` — the
very functions the two count endpoints serve, so the icon and the app can't
disagree about what's waiting.

**Two halves, because there are exactly two levers.**

- **The server, on every push.** `_message` puts `badge` on every outgoing
  message — not just message pushes, and never omitted, because this is the only
  thing that can reach a phone that isn't running the app, and a kind that
  skipped it would leave the previous number sitting there. Counted at *send*
  time, not enqueue: what belongs on the icon is what's waiting when the push
  lands. `_badge` caches per recipient for the batch — **not** for the group
  case (a group message's twenty rows are twenty different people, so it's
  twenty counts regardless) but for one person holding several rows at once, a
  message and a reaction say. The count runs a query per conversation, the same
  family-scale trade-off `UnreadMessageCountView` makes, so that cache is also
  the only way every push in a drain agrees on the number.
- **The app, whenever it knows better** — `useBadgeCount`, mounted in the root
  layout. It **watches the two count caches** (`['unreadMessages']`,
  `['notificationsUnread']`) rather than setting the badge at each place a count
  changes: every mark-read path in the app already invalidates one of those two
  keys, so subscribing means all of them — and every future one — move the icon
  by construction. The badge is therefore exactly as fresh as the in-app badges
  are. Those observers don't poll — the tab bar and the bell already do, and a
  third poller on the same key would double the traffic to learn what we're
  already being told — but they do fetch on mount and on foreground, so the icon
  is right when the phone is picked up.

  **And it re-asserts on every landed count, not only on a changed one** (#232).
  That distinction is the whole difference between the icon self-correcting and
  sticking, because there are *two* writers: an effect keyed on our count alone
  fires only when **our** number moves, so when the server moved the icon behind
  our back and our counts then land on the value the cache already holds, the
  deps don't change and the server's number stands. `dataUpdatedAt` from both
  `useQuery` results is in the effect's deps for exactly this: it advances on
  every *successful* fetch whether or not the number did, which turns "write
  when our count changes" into "re-assert what we believe, whenever we've just
  confirmed it".

  **Both halves have to be currently good, not just one of them.** A failed
  fetch keeps its last successful `data`, so one count failing while the other
  succeeds still advances the survivor's stamp — and an ungated effect would
  write a sum half of which nobody has checked in a while. The server pushes 3,
  the phone comes back on bad signal, the messages count fails and the activity
  count returns the same 0 as before, and the icon that was *right* gets
  cleared. So both queries' `isError` are in the deps and gate the write, which
  is what keeps "never write a number we haven't earned" true of a partial
  failure and not merely of a cold start. Leaving the icon alone on a failed
  fetch is the decision: the last number the server pushed beats a stale one of
  ours.

  **What the re-assert costs**, since "nothing" would be the wrong answer: both
  keys are polled every 12s while the app is foregrounded (the tab bar and the
  bell), so their stamps advance on that cadence whether or not anything
  happened — roughly ten `setBadgeCountAsync` calls a minute, where before there
  were close to none. `BadgeModule.swift` doesn't compare against the current
  value, so each is a bridge hop plus a `notificationSettings()` read and a
  `setBadgeCount()`. Small beside the two HTTP polls it rides on, and both stop
  dead when the app is backgrounded. The cheaper shape — remember the last
  number written and skip the call when it matches, forgetting it whenever the
  app leaves the foreground, since that's the only window in which the server
  can move the icon — was considered and rejected: it makes the fix depend on
  catching every `AppState` transition, and a badge that quietly stops
  re-asserting itself is the bug being fixed.

**Which means the icon and the in-app badges are the same numbers**, not two
counts that agree by convention: `badge_count_for` is `unread_message_total` +
`unread_notification_total`, and those are the two functions
`GET /messages/unread-count/` and `GET /notifications/unread-count/` serve. If
the Messages tab says 2 and the bell says 1, the icon says 3. And every drop is
a **recount**, not a decrement — reading a thread with three unread in it makes
the server re-add the whole total from scratch — so the number can't drift out
of step no matter how many events it misses.

Every action that changes a count invalidates the key behind it, and **that is
the property the badge depends on**, so it's worth listing:

| Action | Invalidates | Where |
| --- | --- | --- |
| Open a thread | `unreadMessages` | `[conversationId].tsx`, after the `read/` POST |
| Swipe read / unread in the list | `unreadMessages` | `(tabs)/messages.tsx`'s `rowAction` |
| Block, leave, accept a pending chat | `unreadMessages` | `BlockButton`, `info.tsx`, `PendingChatPanel` |
| Open the activity centre | `notificationsUnread` | `activity.tsx`, after `seen` |
| Click a row in the activity centre | `notificationsUnread` | `activity.tsx`'s `handlePress` |
| **Tap a push** | `notificationsUnread` | `usePushTaps.ts` — addressed implies *seen* (`NotificationAddressedView` sets `seen_at` too), so this drops the count and has to say so |
| **Reply from the lock screen** | `unreadMessages` | `usePushTaps.ts`'s `sendReply`, success path only |
| **Any successful fetch of a post** | `notificationsUnread` | `post/[postId].tsx`'s `queryFn` → `mirrorPostSeen` — that GET marked the post's notifications seen (viewing is seeing, above) |
| **Any successful fetch of an event** | `notificationsUnread` | `events/[eventId].tsx`'s `queryFn` → `mirrorEventSeen` — same |
| **Any successful fetch of a comment tree** | `notificationsUnread` | `CommentThread.tsx`'s `queryFn` → the same two — `PostCommentsView.get` stamps seen as well as `PostCommentRead` |

**Reply from the lock screen** and the three content-fetch rows are #179's doing
(the third of those, and the "any successful fetch" wording on all three, came
with #318 — see the dismissal section above for why the mirror rides the request
and why the comment tree is one of them). They all previously relied on "the app
refetches on foreground", which was a fine answer while nothing outside the app
showed a count. The lock-screen reply is the sharpest of them: it is the one path that
deals with a message while the app is deliberately *not* in front of anyone, so
the next thing the user sees is the home screen — an icon still claiming the
message they just answered is the most visible possible version of this being
wrong. Both hang off the **success** path, for the same reason the #178
dismissal beside them does: a reply that failed moved no read marker, so the
thread is still unread and the badge is still right.

**Three rules that are easy to get backwards:**

- **`shouldSetBadge` stays `false`.** With a server-sent badge, flipping it
  would apply the push's count while the app is on screen — usually right, and
  wrong in the case that matters most: a push for the thread you're reading,
  counted a tick before you read it. While the app runs, the app owns the number.
- **The app never sets a badge it hasn't earned.** Both counts start unknown at
  launch; treating that as zero would wipe a badge the server had set correctly,
  on every launch. `useBadgeCount` sets nothing until both have landed — and
  sets `0` on `signedOut` (not on `loading`), so a count can't outlive the
  session it belonged to.
- **Badge writes are iOS-only, and that's a decision.** On Android
  `setBadgeCountAsync(0)` doesn't clear a badge: `BadgeHelper` calls
  `notificationManager.cancelAll()` and dismisses *every* notification the app
  has posted — a "clear the badge on foreground" would silently wipe the shade
  this release just taught us to manage precisely. Android badges are also
  launcher-dependent (best-effort through ShortcutBadger) and Expo's push API
  has no Android badge field at all, so the most we could offer there is a
  number we can set and never take back. Android instead gets what its launcher
  derives from the notification shade, which the dismissal work above keeps
  honest.

**The known stale case is the same one as above:** read a thread on the web and
this phone's badge is wrong until the next push or the next foreground. Nothing
in APNs corrects a badge without sending something, so it inherits Phase 10b's
background-delivery question along with everything else in this section. Until
#232 the foreground half of that sentence was aspirational — the refetch fired
but wrote nothing when the number hadn't moved, which is precisely the case a
web-side read produces, so the icon stayed wrong indefinitely. It now holds.

**A refused write is reported rather than discarded** (#233). `setBadgeCountAsync`
resolves to a **boolean**, and `false` is not an error: it is the module saying
iOS declined. `setAppBadge` returns that instead of throwing it away, and warns
in `__DEV__` on the *transition* into refusal — deduped, because level-triggering
means a phone with badges off would otherwise log on every foreground and every
mark-read.

Worth being precise about what `false` means, because a plausible-sounding list
would cost the next investigation an afternoon: `BadgeModule.swift` returns it
when `settings.badgeSetting != .enabled` **and at no other time**. That is the
app's badge *authorisation* — Settings → Notifications → TimeLine → Badges. A
Focus mode changes how notifications are delivered, not that setting, so a phone
in Focus still resolves `true`. A **throw** is a third outcome and is warned
about separately, since it's the one carrying real diagnostic text
(`setBadgeCount()` can throw on iOS 16+; an unlinked module raises
`UnavailabilityError`); it resolves `false` to the caller, because no badge was
set either way. Android resolves **`null`**, which is deliberately not `false`:
there the app never attempts a write, so "was it refused?" has no answer, and a
caller acting on `false` would otherwise read every Android launch as a refusal.

What it deliberately does **not** do is change what the user sees: a refused
write stays a silent no-op, never a retry, a throw, or a nag. It's their phone
and their setting, and the failure mode — an icon holding the last number the
server pushed — is the behaviour we had before any of this existed. The point is
that the *next* investigation can answer "did our write land?" on-device in
seconds, rather than by reading the Expo module's Swift source and asking a
tester to photograph a Settings screen, which is what #234 actually cost.

## Frontend

- **`ActivityCenter`** — the nav bell. Polls `unread-count` for the badge (reusing
  the `NavBadge` look); fetches the list only when the dropdown is **open**.
  Opening fires `seen` (badge clears, items stay); clicking a row fires `addressed`
  then navigates to `url`. Three visual states: unread = bold + accent dot, seen =
  normal weight, addressed = dulled (`opacity-60`). Empty state: "You're all caught
  up." Closes on outside-click / Escape.
- **The list is paginated on both clients** (#134). `GET /api/notifications/`
  pages like every other list here, so rendering `results` and stopping left
  everything older than page one unreachable — while the badge counts *all*
  unread, which is how the count could promise more than the list would ever
  show. The web dropdown follows `next` behind the shared `LoadMoreButton`
  (via `useInfiniteList`, which now takes query options so the list can stay
  `enabled: open`); the app's `activity.tsx` pages on `onEndReached`, like its
  feed. Rows are **deduped by id** on both sides — see
  [feed-and-posts](feed-and-posts.md#pagination), where that now lives for every
  list.
- **Putting the list away drops it back to one page** — the web on close, the
  app when the screen unmounts (`trimToFirstPage`, one in `hooks.js` and one in
  `mobile/src/lists.ts`). The `["notifications"]` cache outlives both, and a
  refetch of an infinite query refetches *every* loaded page in turn, so
  reopening — and the seen-on-open invalidation that follows it — would pay for
  rows nobody is looking at. Only the first page can hold anything new, and
  both clients reopen at the top.

  On the web the trim **cancels the query first**: a "Load more" in flight is
  merged against the pages it saw when it started, so it would put its page
  back after the trim, and cancelling *reverts* to those same pages, so a trim
  that ran first would be undone too. Cancel, then trim. The app needs none of
  this — its trim runs on unmount, by which point there is no live query left
  to land.
- The old **People pending-request** and **Groups invite** nav badges were
  **retired** in `Layout.jsx` (the pages keep their lists; only the badge moved).
- **`NotificationPreferencesSection`** on `/settings` — a toggle per mutable kind,
  optimistic, PATCHing on change. Always-on kinds never appear.

## Out of scope (deferred)

- **Android push** — Phase 10, partly landed. The Expo transport above already
  covers it and `DevicePushToken.platform` needed no schema change, but the
  claim once made here that *only* a `platform` value and an FCM credential were
  outstanding was **wrong**: Android also needs a **notification channel** on
  every push. See "Android notification channels" below. Still outstanding: the
  FCM credential itself.
- **Email / digest** notifications; **@-mentions** (TimeLine has no mention
  feature).
- **Messages in the activity centre** — still deliberately out, and now
  permanently so: messaging keeps its own unread badge, and message *push* rides
  the outbox without a `Notification` row (issue #118, see
  [messaging.md](messaging.md#push-notifications)).
