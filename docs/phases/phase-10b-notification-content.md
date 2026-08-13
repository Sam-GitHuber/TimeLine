# Phase 10b — Notification content, without leaking it

**Status: IN PROGRESS — M1 done.** Fleshed 2026-07-30 and confirmed with the
user; **revised the same day** after a source-checked review of the plan itself.
The review found that two of the mechanisms this phase leans on don't behave the
way the first draft assumed — see *Corrections from review* at the end for what
changed and why, so the reasoning isn't lost.

**The open decision is settled (2026-08-13): Option B**, a scoped credential.
Its shape changed in the building — see *Notes / decisions log*. M1 (backend) is
merged; M2 (keychain) is next.

**Why the odd number.** It follows Phase 10 (Android) and comes *before* Phase 9c
(E2E), which is scheduled after Android. The numbering is chronological, not a
hierarchy — 9b set the precedent for a lettered follow-on.

## The problem

A message push says `New message from Ada` and carries a **Reply** text field
(Phase 9b M8, `mobile/src/push.ts`). You get a box to answer a message you
cannot read. Testers hit this immediately, and they're right: it's a doorbell
with an intercom that only works one way.

The obvious fix — put the message text in the push body — is the one thing we
must not do. Push bodies transit **Expo's servers**, then **Apple's APNs** or
**Google's FCM**. Today they carry one display name per push; putting message
text in them would hand the plaintext of every private conversation in the app to
two or three third parties. `docs/reference/notifications.md` promises this
doesn't happen, and Phase 9c exists precisely because the user objects to *far*
less exposure than that.

## The fix

**Decrypt-or-fetch on the device, after the push arrives and before it is
shown.** iOS calls this a **Notification Service Extension** (NSE): a separate
process the system wakes for each push, given a few seconds to rewrite the
notification's body before the user sees it. Android's equivalent is a
background task that rewrites (or re-posts) the notification.

The push itself stays exactly as contentless as it is today. The content comes
**straight from our server to the device over TLS**, and never enters the push
path at all. This is how Signal does it, and it's strictly better than the
status quo even setting E2E aside.

## Why this is its own phase, ahead of 9c

Phase 9c's milestone 7 needs this extension to exist. Under E2E the server
*cannot* phrase a push body from the message — it can't read it — so on-device
notification content stops being a nicety and becomes the only way a notification
ever says anything specific again.

Nearly all the hard parts of that work are **independent of the cryptography**:

| Piece | Built here | Survives into 9c |
| --- | --- | --- |
| iOS NSE target + config plugin (CNG) | ✅ | ✅ unchanged |
| Android background rewrite | ✅ | ✅ unchanged |
| Keychain sharing (`keychain-access-groups`) | ✅ | ✅ **extended** — 9c must add protocol state to it |
| Credentials inside an extension, and their expiry | ✅ | ✅ unchanged |
| `mutableContent` payload path, per-device gating | ✅ | ✅ unchanged |
| Fallback discipline when the extension fails | ✅ | ✅ unchanged |
| **The extension only ever reads shared state** | ✅ | ❌ **reopened** — advancing the ratchet is a write |
| **Where the plaintext comes from** | an authenticated fetch | **replaced** by local decryption |

Two rows are thrown away, not one, and the second-to-last is the expensive one:
this phase's central safety property is that the extension is a *reader* — it
never mutates anything the main app also mutates (see *The extension never
refreshes*, below). 9c breaks that property on purpose, because a double-ratchet
step is a write. Building 10b first doesn't de-risk that; 9c's own hard part 7
says so plainly, and both docs should keep saying so.

What 10b *does* de-risk is everything else: a live product complaint fixed months
earlier, and the nastiest scaffolding in 9c built while the payload is still a
plain JSON body that's easy to reason about — rather than debugging a Swift
extension and a double-ratchet at the same time.

**The cost, stated plainly:** we build a fetch path and later delete it. That's
roughly one endpoint and the ~40 lines of Swift that call it.

## Definition of done

1. On **iOS**, a message push from a device with previews enabled displays the
   actual message text (truncated), and the Reply field is answering something
   readable.
2. On **Android**, the same, or a **written decision** to defer it with the
   reason recorded (see M4 — this is genuinely less reliable and may not land).
3. The push payload on the wire still contains **no message content**, verified
   by a test asserting the exact body the server sends.
4. **Previews are per device and off by default**, toggled in the app's
   notification settings, stored on `DevicePushToken`, and **reset to off when
   the device row changes hands** (M1).
5. A device with previews **off** gets exactly today's behaviour — **including
   the Reply field, unchanged**. The trap is fixed by giving Reply something to
   reply to, not by deleting Reply. See *The Reply field is not touched*, below.
6. Every failure path falls back to `New message from Ada` — the body the server
   already composed and put in the payload. **No push is ever silent** because
   the extension had a bad day. This rule constrains the Android design (M4) and
   outranks it.
7. **An upgrading tester stays logged in.** Verified on a build installed *over*
   the current TestFlight build, not a clean install.
8. `notifications.md` and `messaging.md` describe the new shape; the privacy
   policy gains a push section (it has none today).
9. Phase 9c's milestone 7 is rewritten to "swap fetch for decrypt", with this
   doc as its starting point.

### Non-goals

- **Notification grouping / threading** (stacking a conversation's notifications
  into one). Worth having, unrelated, easy to bolt on later.
- **Rich media in notifications** (showing the photo). An NSE can do it, but the
  ~24 MB memory ceiling makes image handling the single most common way these
  extensions crash. Not now.
- **Notification content for anything but messages.** Reactions and replies are
  fine as they are — they name a person and that's the whole story. This is a
  *hard* non-goal: it dictates that the new payload fields are gated on the
  payload being a message, not merely on the device's toggle (M1).
- **Removing Expo from the push path.** Still the right call; see
  `notifications.md`.

## Design decisions, and why

### The extension never refreshes the auth token

This is the most important decision in the phase, and it's a *restriction*.

`ACCESS_TOKEN_LIFETIME` is **1 day** (`backend/config/settings.py:413`), but
`ROTATE_REFRESH_TOKENS` and `BLACKLIST_AFTER_ROTATION` are both **on**: every
refresh mints a new refresh token and blacklists the one that bought it. If the
extension were allowed to refresh, it would be a *second process* rotating a
token the main app also holds — and the app would wake up holding a blacklisted
refresh token. The symptom is spurious logouts that are near-impossible to
reproduce. Not negotiable: **the extension reads a credential and uses it, or
gives up.**

**But the "so it's a rare path" reasoning that made this affordable was wrong,
and it changes what we should build.** Refreshing is **lazy** — the only trigger
in the whole app is `api.ts:310`, `if (response.status === 401 && retry &&
access)`. There is no timer, no `exp` decode, no refresh on foreground.
`auth.tsx`'s own cold-start comment says as much: *"an access token that expired
while the app was closed gets silently refreshed here — the common case for an
app opened days later."* So the token is refreshed only *after* it has already
died, and the window in which it's dead is exactly the window in which the user
isn't opening the app.

Which is exactly this feature's target case. Last refresh Monday 18:00; token
dies Tuesday 18:00; the user glances at the app Tuesday 15:00 (still valid, so no
refresh happens) and not again until Thursday morning. Every push in between —
including both nights on the lock screen, the whole point of the phase — falls
back to `New message from Ada`. Previews would work in testing and feel broken in
use.

#### Decided (2026-08-13): Option B, built as an opaque device credential

**Option A — the access token** (the first draft's plan). No backend work. Costs
the fallback rate above, and puts a **full-privilege account token** in a
keychain group readable by another target.

**Option B — a scoped, non-rotating preview credential** *(recommended)*. Mint a
long-lived token whose only power is `GET …/push-preview/`, store it under its
own key in the shared group, and never put the account token there. Nothing to
rotate, so the two-process hazard can't arise by construction; the extension
stops going dark between app opens; and if the shared group is ever read by
something it shouldn't be, what leaks is read-only access to notification
previews rather than the account.

`backend/accounts/tokens.py` already has the pattern — `MobileRefreshToken`
carries a `client: "mobile"` claim and the refresh path *rejects* tokens without
it, which is precisely the "this credential can only be used for the thing it was
issued for" shape needed here. Costs: one more token type, a mint-on-login /
mint-on-register step, and a revocation story (revoke on logout with the device
row; re-mint on next launch if missing).

**The user chose B.** A's failure mode is that the feature quietly doesn't work
in the case it was built for. See the decisions log for the one way the built
version departs from the sketch above — the credential is an opaque random
string on the device row rather than a JWT, which is what turns B's stated cost
("a revocation story") into a row delete that logout already performs.

### The Reply field is not touched

The first draft proposed attaching `categoryId` only to preview-enabled devices,
so a device without previews would lose the Reply field and "the trap is gone
either way". That's backwards, and it would have shipped a regression:

- `send_pushes.py:295` puts `"category": "message"` on **every** message payload
  and `:332` copies it to the wire; `push.ts:83-95` registers the text input.
  Reply exists on every device today.
- `show_previews` defaults to **off**. So the release meant to fix the
  Reply-with-no-context complaint would have *removed Reply from 100% of
  devices* and fixed nothing by default.
- It also inverts a documented invariant (`send_pushes.py:329-331`: a kind opts
  in by adding `category` to its payload, not by changing `_message`), and
  breaks `tests.py:7879`.
- And it doesn't even work: `categoryId` is attached at *send* time, so a
  preview-enabled device whose NSE fails still gets Reply on a `New message from
  Ada` — the original trap, restored, on the exact path we can't control.

So: **Reply stays exactly as it is.** The fix for the trap is the preview, not
the removal of the field. Devices with previews off are no worse off than today,
which is the correct bar for a phase that adds an opt-in feature.

### Previews are per *device*, and off by default

Per-device because the thing that leaks is a **lock screen**, and a lock screen
belongs to a phone, not an account. Someone can want previews on their own
phone and not on the tablet in the kitchen. It's also nearly free: `_payload()`
is computed once per outbox row, but `_message(device, payload)` already runs per
device (`send_pushes.py:165`), so the flag slots into the existing shape.

**Off by default**, because turning a default on later is one line and quietly
starting to show people's messages on their friends' lock screens is not. Ask
the TestFlight group once it exists.

**And it must reset when the device changes owner.** `DevicePushToken` is keyed
on the *token*, and `PushTokenView.post` deliberately reassigns `user` on an
existing row (`views.py:4583-4589`) — the docstring's "the row must move" is
correct and stays. But a preference about a lock screen must not be inherited:
Ada enables previews, logs out, her partner logs in on the same tablet, and a
stranger's private messages must not start rendering there. So the reassignment
path clears `show_previews`. See M1 for the shape.

### The preview endpoint is conversation-scoped, not message-scoped

The extension asks *"what should the notification for conversation 12 say?"*,
not *"what does message 480 say?"*.

This falls out of an existing quirk. `enqueue_message_pushes` **coalesces**: if
an unsent push is already queued for a conversation, a second message doesn't
add one (`notifications.py:317-333`). So the queued row points at the *first*
message of a burst. With previews, a message-scoped fetch would show you the
oldest unread message and never the newest. A conversation-scoped endpoint
returns the latest visible message and sidesteps that entirely, without touching
the enqueue path.

**The first draft called that coalescing "harmless while bodies are
contentless". It isn't** — it's a live bug today, and worth fixing here because
it's three lines and this is the one phase that will ever be looking at it:
`_payload` reads sender, photo, mention and channel off that *stale* first
message (`send_pushes.py:246,255,261-264,302`). So an @mention arriving mid-burst
is phrased as a plain message **on the messages channel instead of
`MENTION_CHANNEL`** — defeating the exact scenario that channel exists for, since
`Kind.MENTION` never creates a `Notification` row and always rides this branch.
`_should_drop` (`:219-222`) can also bin the whole burst by comparing the read
marker against the stale timestamp. `tests.py:7341` covers coalescing with a
single sender in a direct thread, so none of this is caught.

Fixing it (point the un-sent row at the newest message when coalescing) would
*also* remove the reason for the conversation-scoped endpoint. Keep the endpoint
anyway: conversation-scoped is the right shape for a notification that is about a
thread, it's what 9c will want, and it doesn't depend on enqueue-path behaviour
staying put.

### Whose messages the endpoint may show

This is the security-critical part of M1, and the first draft's one-line answer
("visibility rules **imported from** the messaging module") does not survive
contact with the code:

- **There is no messaging module.** `backend/api/` has no such file.
- The rule inside `enqueue_message_pushes` is an **inline queryset local**
  (`notifications.py:290-307`) that pivots on `message.created_at` — a
  conversation-scoped endpoint has no message to pivot on, so it isn't
  extractable as written.
- The one importable candidate, `visible_messages_for` (`views.py:392`),
  enforces **only the interval window**. No `status=ACTIVE`, no
  `left_at__isnull=True`, no `user__is_active=True`, no `deleted_at` filter —
  every caller adds those itself (`:484`, `:2710`). Calling
  `visible_messages_for(convo, user).last()` and serving the text would show the
  latest message to a `pending` participant, a participant who has left, or a
  deactivated account. That is precisely "showing someone a message they aren't
  allowed to read".

So M1 **extracts** the audience predicate rather than importing a name that
doesn't exist. The full rule for "may this user see the latest message in this
conversation", all five parts:

1. `Participant.status == ACTIVE` and `left_at__isnull=True`
2. `user__is_active=True`
3. a `ParticipantInterval` spanning the message's `created_at`
4. `deleted_at__isnull=True` on the message
5. `.exclude(sender=user)` — see below

**Mute is not on that list, and mustn't be.** Mute is a *delivery* policy
(`notifications.py:309` filters on it when choosing recipients), not a permission
one. By the time the extension calls this endpoint a push has already been
delivered, which means the mute question was answered upstream — including the
@mention carve-out. The endpoint's job is visibility only. The "a muted
participant still gets a preview" test stays; the *justification* changes from
"reuse enqueue's rules" to "mute was decided upstream and isn't this endpoint's
business".

**Excluding your own messages** (5) matters more than it looks. Reply from the
web between the push being queued and delivered, and without it your lock screen
shows a notification titled "New message from Ada" whose body is *your own
words*. `unread_count_for` (`views.py:474-489`) already excludes both `sender` and
`deleted_at` and is the closest existing precedent. When *every* visible message
is excluded, the endpoint returns 204 and the extension keeps the server body —
that case must be specified, not left undefined.

### The endpoint returns a finished body, not its ingredients

The first draft returned `{sender, text, has_photo, conversation_title,
unread_count}` and had the Swift set `bestAttemptContent.body`. That pushes the
phrasing into the one component the Risks section admits can't be unit-tested,
and it's wrong in a case that happens constantly:

- `send_pushes.py:269-280` phrases **four** different bodies (mention / photo /
  titled group / plain).
- A photo sent with **no caption** has empty `text` — `_payload` says so at
  `:253-254`. The Swift would set `body = ""`, and the lock screen would show a
  title over a blank line: strictly worse than today's "Ada sent a photo".
- `Conversation.title` is `blank=True` (`models.py:285`) and is only used when
  `convo.kind == GROUP and convo.title` (`send_pushes.py:268`). An unguarded
  concatenation renders "Ada in " for every 1:1.

So the endpoint returns **`{body, unread_count}`**, where `body` is composed by
the *same* helper `_payload` uses, extended with the message text. Same four
branches, one implementation, covered by the Python suite. The Swift becomes:
take `body`, set it, call the handler. That is also what the Risks section says
we should be doing — "put the logic that *can* be tested on the server".

Under 9c this row is the one that gets replaced anyway (the server won't be able
to compose a body), so the composition logic moving device-side is a 9c cost, not
a 10b one, and it lands then with a working extension already in place.

### The fallback is the current body, always

An NSE is **not guaranteed to run**. iOS may skip it under memory pressure or low
battery, it can time out, the network can be down, the credential can be stale.
Every one of those must degrade to `New message from Ada` — the notification the
server already composed and which is sitting in the payload the whole time.

This is why the push keeps a real `title`/`body` rather than going fully silent:
a silent push that depends on an extension firing is a notification you sometimes
just don't get, and "sometimes doesn't notify you" is worse than "vague". **This
rule outranks the Android design in M4**, which is where it bites.

## Milestones

### M1 — Backend: the preview endpoint and the payload flag ✅ **Done**

Built as written below except for the four deviations in *Notes / decisions
log*: the credential is opaque rather than a JWT, a `pending` participant gets
204 rather than 404, the payload gate is a `previewable` boolean rather than a
conversation id, and the shared body helper is
`notifications.message_push_body`.


- Add `show_previews` (boolean, default `False`) to `DevicePushToken`; migration.
- **Do not put `show_previews` in `PushTokenView.post`'s `update_or_create`
  `defaults`.** The app POSTs on every launch (`auth.tsx:93`), so a value in
  `defaults` either resets the user's toggle on every cold start or — since
  `DevicePushTokenSerializer` doesn't carry the field — raises `KeyError` and
  500s the launch path. Registration keeps its two fields; the toggle gets its
  own endpoint (below).
- **Clear `show_previews` when the row changes owner.** Fetch the row first; if
  it exists and `row.user_id != request.user.id`, reset the flag as part of the
  same save. Test: Ada enables previews, Bob registers the same token, Bob's
  device has previews off.
- A settings endpoint (`PATCH`) for the toggle, scoped to the caller's own
  devices.
- `GET /api/conversations/<id>/push-preview/` → `{body, unread_count}`.
  - **404, not 403**, for a non-participant. `views.py:2256-2258` and
    `:2402-2405` set this convention explicitly ("a thread you're not in
    shouldn't even reveal it exists"). A 403 here would let any approved account
    walk `1..5000` and map how many private threads the install has and, since
    ids are sequential, roughly when each was created.
  - **Add a `throttle_scope`.** `settings.py:328-330` deliberately sets no
    `DEFAULT_THROTTLE_CLASSES` — throttling is opt-in per view — so without one
    nothing rate-limits that walk. `push_register`'s `ScopedRateThrottle` is the
    pattern to copy.
  - Visibility per the five-part rule above, from one extracted helper.
  - `204` when there is no visible non-own message to describe.
  - Body composed server-side, text truncated server-side (**120 chars**, then
    an ellipsis — one number, defined here, not in the Swift).
- `_payload()` gains the conversation id **on the message branch only**. The
  notification branch (`send_pushes.py:231-239`) returns five keys and no
  conversation, so `_message` must gate the new fields the way every other
  message-only field is gated — **on the payload, like `if data.get("category")`
  at `:332`, not on `device.show_previews` alone.** Gate on the device only and
  the first reaction push to a preview-enabled device raises `KeyError` inside
  `_drain`'s `with transaction.atomic():` (`:86-87`), rolling back the drain,
  skipping `_check_receipts`/`_prune` (`:88-92`), and crashing every timer tick
  from then on — all push delivery stops. Gate loosely with `.get()` and you set
  `mutableContent` on every notification push, waking the NSE for "Ada reacted to
  your post" with nothing to fetch, against the hard non-goal above.
- **Don't add `data.conversationId`.** `push.ts:302-306` states the invariant —
  "the push carries no separate conversation field to fall out of step with it" —
  and `conversationIdFromUrl` already parses `/messages/<id>`, which is in every
  message payload. The NSE parses the same `url`. `mutableContent` is the only
  new wire field.
- **Fix the coalescing staleness** while here: point an existing unsent
  `PushOutbox` row at the newest message (`.update(message=message)` in
  `notifications.py:317-326`) so `_payload` phrases the burst from the message
  that actually arrived. Tests: a mid-burst @mention lands on `MENTION_CHANNEL`;
  a burst whose first message predates the read marker isn't dropped.
- Tests: the wire payload never contains message text; a non-participant gets
  **404**; a participant in an interval gap gets 404; a `pending` participant, a
  departed participant and a deactivated user each get 404; a muted participant
  still gets a preview; soft-deleted and own messages are skipped; empty result
  → 204; an uncaptioned photo yields "Ada sent a photo"; a 1:1 never renders a
  trailing "in "; `mutableContent` appears only for opted-in devices **and only
  on message pushes**; `categoryId` is unchanged for every device
  (`tests.py:7879` must still pass untouched).

### M2 — Keychain sharing, and its migration

`expo-secure-store` supports an **`accessGroup`** option, which is what lets the
NSE read the credential written by `src/tokens.ts`. Three things about this are
not obvious and each one is fatal on its own.

**1. The items are currently unreadable on a locked phone.** `tokens.ts:47-53`
passes no options, and `SecureStoreOptions.swift:8` defaults `keychainAccessible`
to `.whenUnlocked` → `kSecAttrAccessibleWhenUnlocked`, stamped at write time. A
push arriving while the phone is locked in a pocket — *the* case this feature
exists for — gets `errSecInteractionNotAllowed` and falls back. It works on every
unlocked dev phone and never on a lock screen. So M2 must also pass
**`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`**.

That is a deliberate at-rest downgrade, and it should be stated in the privacy
work (M5): the credential becomes readable while the device is locked but
booted-and-once-unlocked, instead of only while unlocked. `THIS_DEVICE_ONLY`
keeps it out of iCloud Keychain and encrypted backups, which is the part worth
holding on to. There is no way to have both this feature and the old property.

**2. Accessibility can't be changed by re-saving.** `update()`
(`SecureStoreModule.swift:125-137`) sets only `kSecValueData`, so a `set` over an
existing item keeps its original accessibility. The migration must
**delete-then-add**, not overwrite.

**3. The obvious migration logs everyone out.** The first draft said "rewrite it
with the group and delete the original". But `deleteItemAsync` without options
omits `kSecAttrAccessGroup` (`SecureStoreModule.swift:186-189`), and a group-less
`SecItemDelete` matches **across every entitled group** —
`deleteValueWithKeyAsync` fires three of them (`:42-49`). It would delete the
copy just written. `auth.tsx:76` then sees `getAccessToken()` return null and
sets `signedOut`: every upgrading tester logged out, and a clean install cannot
reproduce it. (On Android it's worse in a duller way — `accessGroup` is iOS-only,
so "rewrite then delete" writes and deletes the same entry.)

**So the migration never deletes.** On launch: read without the group; if found,
write *with* the group and the new accessibility; verify by reading back with the
group; leave the original alone. The stale copy is the same value in the app's
own group and is harmless — and it's swept on logout for free, because
`clearTokens`' group-less delete is exactly the behaviour that broke the
migration: here it's the behaviour we want, matching both copies.

- Add **`keychain-access-groups`** (*not* `com.apple.security.application-groups`
  — different entitlement; `kSecAttrAccessGroup` is satisfied by the former) in
  **three** places: `ios.entitlements` in `app.json` for the app target, the
  plugin's entitlements for the extension target, and the EAS
  `appExtensions[].entitlements` so the provisioning profile carries it. The
  value needs the `$(AppIdentifierPrefix)` Team-ID prefix, and `app.json` today
  has neither an `ios.entitlements` key nor an `ios.appleTeamId`.
  - Get it wrong on the **extension** and nothing fails at build time:
    `SecItemCopyMatching` returns `errSecMissingEntitlement` (-34018) forever,
    the fallback discipline hides it, and DoD 1 just never passes.
  - Get it wrong on the **app** and it's worse: `saveTokens` (`tokens.ts:44-51`)
    awaits `Promise.all` with no catch, so a failing `SecItemAdd` throws up
    through `api.ts:1539` and **nobody can log in**. Wrap the migration in
    try/catch; leave the login path's failure loud but test it.
- **`tokens.ts` passes the options on all six calls** — `setItemAsync` ×2
  (`:47,48`), `getItemAsync` ×2 (`:53,72`), `deleteItemAsync` ×2 (`:78,79`). The
  first draft said "all four", which is the file's *function* count, and the two
  it left out are the deletes. Miss those and `clearTokens` deletes
  group-lessly-but-fine on iOS while **the shared-group copy of a live
  credential survives logout on any path that doesn't** — the extension would go
  on authenticating as a signed-out user and rendering their previews on a
  handed-on phone, which is the hazard `DevicePushTokenView.delete` and
  `forgetLocalPushToken` exist to prevent. Add an explicit logout test.
- **Pin `keychainService` explicitly** (e.g. `'timeline'`). Today the service is
  expo's default `"app"`, and `query()` appends `:no-auth`
  (`SecureStoreModule.swift:172-185`), with `kSecAttrGeneric` **and**
  `kSecAttrAccount` both set to `Data(key.utf8)` — not `String`. The NSE has to
  reproduce that query byte-for-byte; the obvious Swift (service `"app"`, account
  as a `String`) returns `errSecItemNotFound` on every push on every device,
  indistinguishable from the entitlement failure above. Worse, `"app:no-auth"` is
  an internal detail of a package pinned at `~57.0.1` and a routine SDK bump
  would kill previews with no build error. Pinning the service makes the
  extension depend on a value *this repo* chose. Document the exact query shape
  next to the Swift.
- `tokens.ts`'s file docstring gains the extension as a fourth caller — it
  currently says nothing else may touch SecureStore, which was never quite true
  (`push.ts:249-296`, `preferences.tsx:53,65`) and is about to be less true.
- **Fix the test double first.** `jest.setup.js:10-22` mocks `expo-secure-store`
  as a flat `Map` keyed on `key` alone, **discarding the options argument**. As
  it stands, M2's tests ("the migration runs once, is idempotent, and a failure
  leaves the user logged in") are structurally incapable of failing, and neither
  the delete-everywhere bug nor the missing-`accessGroup`-on-delete bug is
  visible to them. Key the mock on `(service, accessGroup, key)` and record
  accessibility, so a group-less delete really does sweep groups.
- Tests: the migration runs once and is idempotent; a migration failure leaves
  the user logged in; every write carries the group and accessibility; logout
  removes **both** copies.
- **Verify on an upgrade install** (DoD 7). Internal TestFlight over the current
  build. A clean install proves nothing here — that's the whole lesson of this
  milestone.

### M3 — The iOS Notification Service Extension

The native dirs are **gitignored** (`mobile/.gitignore:57`), so this is a CNG
project: the extension must come from a **config plugin**, never a hand-edit of
Xcode. `expo-notifications` does not ship an NSE; the well-trodden route is a
plugin that copies a Swift file into a new target and signs it.

- Choose between an existing community plugin and a small local one in
  `mobile/plugins/`. **Lean local**: this is ~100 lines of well-documented
  plugin API, and an unmaintained third-party plugin in the build path is a
  supply-chain risk on the critical path of shipping the app at all. Write it in
  **TypeScript** so `tsconfig`'s `**/*.ts` picks it up, and check that eslint
  doesn't red on Node globals (`__dirname`, `require`) in a config that assumes
  browser/RN — the `mobile` check is required, and a plugin that fails lint
  blocks every release, not just this one.
- **The extension must be told the API base URL, and nothing currently can.**
  `api.ts:69-70` is `process.env.EXPO_PUBLIC_API_URL || 'https://your-timeline.net'`,
  and the comment at `:61` explains that the `EXPO_PUBLIC_` prefix inlines it
  into the **JS bundle** at build time. A Swift NSE is a separate native process:
  no `process.env`, no `Constants.expoConfig`, and `app.json`'s `extra` holds
  only `router` and `eas.projectId`. So **the plugin reads `EXPO_PUBLIC_API_URL`
  at prebuild and writes it into the extension's `Info.plist`**, with the same
  production default. Skip this and the plugin hardcodes production, every
  dev/LAN build's extension fetches previews from production with a dev token →
  401 → permanent fallback, and the extension is untestable against a local
  Django — which is the only way to develop it.
- The Swift is deliberately thin: read the credential from the shared keychain,
  parse the conversation id out of `data.url`, GET the endpoint, set
  `bestAttemptContent.body` from the returned `body`, call the handler. On
  **any** failure — no credential, non-200, timeout, malformed JSON, 204 — call
  the handler with the **unmodified** `request.content`.
- Implement `serviceExtensionTimeWillExpire`; per Apple's contract it must call
  `contentHandler(bestAttemptContent)` with whatever it has, and iOS kills the
  process if it doesn't.
- **Never `os_log` the credential, the body, or the URL with its id.**
  `tokens.ts:13-16`'s "never log a token" rule is written for JS callers; the
  extension needs it in Swift, where the debugging method is otherwise "print
  things and read Console.app". Say it in a comment at the top of the file.
- No image handling (non-goal), which keeps it far under the memory ceiling.
- **EAS will not build the extension target unless it's declared.** In a managed
  / CNG project EAS discovers extensions from
  `extra.eas.build.experimental.ios.appExtensions` in `app.json` — not from the
  `.pbxproj` the plugin generates (`git ls-files mobile/ios` is empty, so EAS
  takes the managed path). Without it the first `eas build --profile production
  --platform ios` provisions `net.yourtimeline.app` only and dies ~15 minutes in
  with *"No profiles for 'net.yourtimeline.app.NotificationService' were
  found"*.
  - A second bundle id means a **new App ID and provisioning profile**, which
    re-enters the interactive Apple-login path `docs/mobile-release.md:83-88`
    warns about. Do it on a build you're prepared to babysit.
  - The extension's `CFBundleShortVersionString`/`CFBundleVersion` must **match
    the app's**, but `eas.json` sets `appVersionSource: remote` with
    `autoIncrement: true` on `production`. A plugin writing literal versions
    drifts on the very first build and is rejected at App Store Connect
    validation. Have the plugin copy the app target's values rather than state
    them.

### M4 — Android, or a written decision not to

**iOS and Android are not symmetric here, and that's the main risk in the phase.**
An NSE runs for every push regardless of app state — that's its whole design.
Android's equivalent through Expo is `Notifications.registerTaskAsync` +
`TaskManager.defineTask` (and `expo-task-manager`, which is **not currently a
dependency**), and there is a **history of that task not firing when the app is
terminated** (expo/expo#19681, #29622, #38223). #38223 was closed with a fix, but
it was filed against SDK 53 and we're on 57 — so this is *verify, don't assume*.

**The first draft's answer — a data-only push — is ruled out by DoD 6.** A
data-only message carries no title or body, so if the fetch fails there is
nothing to fall back to and the user gets **silence**: the outcome M4 itself
names as its highest-likelihood risk, and the exact thing the fallback rule
forbids. It would also mean two payload shapes, which M1 doesn't build.

So Android keeps the same notification-message payload as iOS, and the question
is narrowed to: **can a background task rewrite an already-delivered
notification, or post a replacement, in the states we care about?**

- **Spike first**, before writing anything else. Timebox it. And spike the right
  state: **background, and swiped-away-from-recents — not force-stopped.**
  Android's *stopped state* (after "Force stop" in Settings) delivers no FCM
  messages at all until the user relaunches the app, by design and independent of
  any Expo bug. The first draft's "force-stop the app, send a data-only push,
  confirm the task runs" would have failed for a reason that has nothing to do
  with the question, and could have wrongly killed Android support.
- If the task fires: fetch, then `scheduleNotificationAsync` a replacement in the
  same channel and dismiss the original, same fallback discipline. Accept that
  the two-step is briefly visible.
- If it doesn't: the reliable route is a native `FirebaseMessagingService`
  subclass via a config plugin (what Notifee does). **That is a second native
  surface**, and if the spike fails, the honest answer may be to ship iOS,
  record the finding here, and leave Android on the contentless body — which is
  strictly no worse than today. Hide the toggle on Android in that case rather
  than offering a switch that does nothing.

### M5 — Settings, docs, and the 9c handoff

- Preview toggle in the app's notification settings, with plain wording about
  what it does and where the text comes from. iOS for certain; Android only if
  M4 lands.
- Update `notifications.md`'s "what leaves the box" section. It needs more than
  an addendum — it is **already stale** and this phase makes it more so:
  - It says a push goes to Expo "then to Apple's APNs" with no mention of FCM,
    though Android has shipped.
  - "the third parties in the path see no conversation" is **false and always
    was**: `send_pushes.py:287` puts `"url": f"/messages/{convo.id}"` in every
    message push, so Expo and Apple see a stable conversation identifier. That's
    metadata, not content, and it's defensible — but the doc must say it rather
    than claim otherwise.
  - The 10b addendum's "the rule about what a *push* carries is unchanged" stops
    being true the moment `mutableContent` is per-device: its presence is a
    readout of a privacy setting, disclosed to Expo and Apple. Small, but say it.
  - The addendum also says the fix "is to decrypt on the device"; in 10b it's a
    *fetch*. Decryption is 9c.
- Add a push section to `frontend/src/pages/legal/PrivacyPage.jsx`, which
  currently says nothing about push at all — including the keychain
  accessibility change from M2 and, if Option B is chosen, the preview
  credential.
- Update `messaging.md`'s push section.
- Rewrite Phase 9c hard part 7 / milestone 7 as "replace the fetch with local
  decryption", pointing here for everything already built — and keep its warning
  that the shared-state *write* is the part 10b does not de-risk.

## Risks

- **The Android background task doesn't fire when terminated.** Highest-
  likelihood risk. Mitigated by spiking it first (M4) and by iOS being
  independently shippable.
- **Two processes and one rotating refresh token.** Mitigated by the
  never-refresh rule. Option B removes the hazard by construction.
- **The keychain migration logs people out.** Mitigated by never deleting during
  migration, by failing towards "stay logged in", and by a test double that can
  actually see the bug. Test on a build upgraded from the current TestFlight
  build, not a clean install — a clean install cannot reproduce this.
- **A tester skips the migration release.** "One release later that path can go"
  assumes everyone passes through the migrating build, and there is **no
  minimum-version or forced-update mechanism anywhere in this repo**. Removing
  the migration would silently log out anyone who jumped it. Keep it until such
  a mechanism exists, or add one first.
- **A config plugin breaks the iOS build.** It sits on the path of every
  release. Mitigated by keeping the plugin local and minimal, and by shipping
  through TestFlight internal first — `docs/mobile-release.md` is required
  reading before any of this goes out.
- **The Swift is hard to unit-test.** Accepted, and the reason body composition
  moved to the server. Keep the extension thin enough to eyeball, and write a
  manual device matrix: previews on/off × app foreground/background/terminated ×
  **phone locked/unlocked** × network up/down × credential valid/expired.

## Open questions

- **Which credential** — see the decision box above. Recommendation: B.
- **Does the toggle belong per device or per device *and* per conversation?**
  ("Never preview this one chat.") Suspect that's over-thinking it; revisit if
  anyone asks.
- **Does the unread count earn its place in the body?** It's in the M1 response
  because it's free on the same call, but "3 new messages" may read better as a
  badge than as prose. Decide when the Swift exists and it can be seen.

## Notes / decisions log

Deviations from the plan above, recorded as they were made.

### M1, 2026-08-13 — merged

**The preview credential is an opaque random string on `DevicePushToken`, not a
JWT.** Option B asked for "a long-lived token whose only power is
`GET …/push-preview/`", pointing at `MobileRefreshToken`'s `client` claim as the
shape. The claim pattern is the right *idea* — a credential usable only for what
it was issued for — but a JWT would have had to invent a revocation story, and B
listed exactly that as its cost. An opaque token hashed onto the device row
gives it away for free:

- **Revocation is a row delete**, and logout already deletes that row
  (`DevicePushTokenView.delete`, `forgetLocalPushToken`). No blacklist table, no
  second lifecycle to keep in sync with the account's.
- **Scoping is structural**, not a claim to be checked: it authenticates through
  `PushPreviewAuthentication`, which is mounted on that one view and nowhere
  else. Pinned in both directions — the account's own Bearer token is refused
  here, and the preview credential works nowhere else.
- **It is per device**, which is the grain `show_previews` already has.
- Stored as a SHA-256, so a database dump yields nothing usable. Plaintext
  exists in the registration response and the app's keychain, nowhere else.

It is **minted fresh on every registration**, which the app already does on every
launch — so a device that loses its copy repairs itself on the next open, with no
recovery path to build or test. Safe to rotate here in a way the account's
refresh token is not: only the app ever mints or writes it, the extension only
ever reads, so there is no second process left holding a dead one. The cost is
that `POST /push-tokens/` now answers **200 with `{preview_token}` instead of
204**. Checked against the shipped app: `api.ts`'s `request` parses whatever body
arrives and `registerPushToken` is typed `<void>`, so builds already on testers'
phones ignore it.

**A `pending` participant gets 204, not the 404 the plan asked for.** The plan
listed pending alongside "departed" and "deactivated" as 404 cases. Departed and
deactivated already are, through the gate every per-thread route starts from
(`_thread_for_viewer`, and the credential's own `is_active` check) — but pending
is *not* something that gate refuses anywhere else in the API: a pending member
can list the thread and can mute it. Special-casing it here would have meant a
second copy of the visibility rule that could drift from the thread endpoint's.
They have no `ParticipantInterval`, so the message query returns nothing and they
get the 204 that already means "nothing here you may be shown". Same security
property, one gate. The distinction the endpoint actually draws is **404 where
the thread is unreachable, 204 where it is reachable but empty of anything
showable** — which is also what a member in an interval *gap* gets: the newest
message they may read, never the one sent while they were out.

**`previewable`, not a conversation id, is what `_message` gates on.** The plan
said `_payload()` should gain the conversation id on the message branch. It
didn't need to: the gate only has to answer "is this a message push", the wire
already carries `/messages/<id>` in `url`, and the plan separately forbids a
second conversation field that could fall out of step with it. A bare boolean on
the message branch says exactly what the gate asks and adds nothing to the wire.

**The body composition helper lives in `notifications.py`**
(`message_push_body`), called contentless by `send_pushes` and with
`preview=True` by the endpoint. The preview shape is the ordinary body with the
text appended — `Ada: hello`, `Ada in Sunday Lunch: hello`, `Ada mentioned you:
hello`, and an uncaptioned photo still just `Ada sent a photo`. The one branch
that differs is the plain 1:1, which is `New message from Ada` contentless and
`Ada: …` with text, because the former doesn't extend into a sentence.

**The coalescing staleness fix landed with it and broke no existing test** —
worth noting, because `tests.py`'s coalescing coverage passed both before and
after. Three new tests pin the behaviour that was actually wrong: the row points
at the newest message, a mid-burst @mention reaches `MENTION_CHANNEL`, and a
burst isn't binned by a read marker that only passed its first message.

## Corrections from review

Recorded so the reasoning isn't repeated. The first draft asserted, and source
says otherwise:

1. **Sharing the keychain is enough for the NSE to read tokens.** No — the items
   are `kSecAttrAccessibleWhenUnlocked`, so they're unreadable on a locked
   phone, which is the only case that matters (M2).
2. **"Rewrite with the group and delete the original."** The delete matches
   across groups and removes the new copy: every upgrading tester logged out
   (M2).
3. **"All four calls" / "the only file that touches token storage."** Six calls,
   two of them deletes; `push.ts` and `preferences.tsx` also use SecureStore
   (M2).
4. **Gating the new payload fields on `device.show_previews`.** Crashes the push
   drain on the first non-message push (M1).
5. **`show_previews` in the register upsert.** Resets on every launch, or is
   inherited by the phone's next owner (M1).
6. **"Visibility rules imported from the messaging module."** No such module;
   the importable helper enforces one of the five required guards (M1).
7. **"Previews off ⇒ no Reply field."** Deletes a shipped feature from every
   device by default (design decisions).
8. **The extension can find the API base URL.** Nothing exposes it to a native
   target (M3).
9. **"Verify the EAS build signs both targets."** EAS won't know the target
   exists without `appExtensions` (M3).
10. **"App Group / keychain-sharing entitlement via `app.json`."** Two different
    entitlements, and `app.json` reaches only the app target (M2).
11. **The 1-day access lifetime makes expiry rare.** Refresh is lazy, so the
    token is dead exactly overnight (design decisions).
12. **Android data-only.** Contradicts DoD 6; and the spike as written tested the
    stopped state, which Android forbids regardless (M4).
13. **The endpoint returns body components.** An uncaptioned photo yields a blank
    lock-screen line, and phrasing moves into untestable Swift (design
    decisions).
14. **403 for a non-participant.** Reverses a deliberate 404 convention and gives
    an enumeration oracle, unthrottled (M1).
15. **Coalescing is "harmless while bodies are contentless".** It misroutes
    mid-burst @mentions off the mentions channel today (design decisions).
