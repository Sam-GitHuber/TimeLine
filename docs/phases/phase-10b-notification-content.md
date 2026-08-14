# Phase 10b — Notification content, without leaking it

**Status: IN PROGRESS — M1, M2, M3 and M5 done; M4 (Android) is all that
remains, and it may end in a written decision not to.** Fleshed 2026-07-30 and confirmed with the
user; **revised the same day** after a source-checked review of the plan itself.
The review found that two of the mechanisms this phase leans on don't behave the
way the first draft assumed — see *Corrections from review* at the end for what
changed and why, so the reasoning isn't lost.

**The open decision is settled (2026-08-13): Option B**, a scoped credential.
Its shape changed in the building — see *Notes / decisions log*. The whole iOS
path exists: endpoint, credential, extension, and the switch that turns it on.

**What is owed is not code.** Nothing here has run on a real phone. The
extension's failure mode is that it delivers exactly the notification a working
one would have delivered before this phase, so the only thing that can tell them
apart is the device matrix under *Risks* — and it needs a TestFlight build
installed **over** the current one, which is also the build that re-enters the
interactive Apple-login path (`docs/mobile-release.md`). As always, git is the
authority on what has actually merged — this file says what has been *done*.

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
4. **Previews are per device**, toggled in the app's notification settings,
   stored on `DevicePushToken`, and **reset when the device row changes hands**
   (M1). *Revised 2026-08-14: **on** by default, and the reset is to that
   default — see the M5 revision log.*
5. ~~A device with previews **off** gets exactly today's behaviour — including
   the Reply field, unchanged.~~ **Reversed 2026-08-14.** That held while "off"
   still named the sender. Off now hides the sender too, so a Reply field would
   answer an unknown message from an unknown person — the trap this phase
   exists to fix, in a worse form. Off means `New message` and no Reply; *on*
   keeps Reply and gives it something to reply to, which was always the point.
   See the M5 revision log, and *The Reply field is not touched* below for the
   reasoning that still stands (Reply must never be removed from the **default**
   experience).
6. Every failure path falls back to `New message from Ada` — the body the server
   already composed and put in the payload. **No push is ever silent** because
   the extension had a bad day. This rule constrains the Android design (M4) and
   outranks it.
7. **An upgrading tester stays logged in.** Verified on a build installed *over*
   the current TestFlight build, not a clean install. *(M2 made this hold by
   construction — no existing keychain item changes — but it is still checked on
   the first release that ships the extension, because M3 adds an entitlement
   and a second signed target.)*
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

### Previews are per *device* (and, since 2026-08-14, on by default)

Per-device because the thing that leaks is a **lock screen**, and a lock screen
belongs to a phone, not an account. Someone can want previews on their own
phone and not on the tablet in the kitchen. It's also nearly free: `_payload()`
is computed once per outbox row, but `_message(device, payload)` already runs per
device (`send_pushes.py:165`), so the flag slots into the existing shape.

~~**Off by default**, because turning a default on later is one line and quietly
starting to show people's messages on their friends' lock screens is not. Ask
the TestFlight group once it exists.~~

**Revised to on by default, 2026-08-14**, before anyone outside the maintainer's
own devices had the build. The caution above was answering a question **Apple
has already answered**: *Settings → Notifications → Show Previews* defaults to
*When Unlocked* on any Face ID iPhone, so the OS withholds a notification's
contents until its owner is looking at the phone. We supply the words; Apple
decides when it is safe to reveal them — and there is no hook for us to make
that decision ourselves, since the extension runs once at delivery and the
reveal happens later, repeatedly, at display time. WhatsApp and Signal both
default this on for the same reason. See the M5 revision log.

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

### M2 — Keychain sharing, and its migration ✅ **Done**

Built to the three warnings below, but **not to the shape they assumed**: there
is no migration and no `accessGroup`, because Option B's credential is a new key
no shipped build has ever written. See the decisions log for the full reasoning
— it is the second time in this phase that choosing B has made a piece of the
plan unnecessary rather than merely different. What survived intact is warning
1 (accessibility), warning 2 (which is why the save deletes first), and the
insistence on a test double that can see any of it.

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

### M3 — The iOS Notification Service Extension ✅ **Built**

Built as written below, with the deviations in *Notes / decisions log*. The one
thing it cannot claim is **verified**: the extension compiles and the app embeds
it, but whether it *runs* is the device matrix under Risks, and that needs a
TestFlight build over the current one.



The native dirs are **gitignored** (`mobile/.gitignore:57`), so this is a CNG
project: the extension must come from a **config plugin**, never a hand-edit of
Xcode. `expo-notifications` does not ship an NSE; the well-trodden route is a
plugin that copies a Swift file into a new target and signs it.

- **The extension must declare the app's keychain access group** — the half of
  M2's entitlement work that moved here, because it is the target that needs it.
  The extension's own App ID gives it
  `$(AppIdentifierPrefix)net.yourtimeline.app.NotificationService`, which is not
  where the credential is; it must list
  `keychain-access-groups: ["$(AppIdentifierPrefix)net.yourtimeline.app"]` in
  the plugin's entitlements **and** in the EAS `appExtensions[].entitlements`,
  so the provisioning profile carries it. The Xcode variable is expanded in the
  plist, so no Team ID literal is needed anywhere.
  - Get it wrong and nothing fails at build time: `SecItemCopyMatching` returns
    `errSecMissingEntitlement` (-34018) forever, the fallback discipline hides
    it, and DoD 1 just never passes. It is indistinguishable from the wrong-query
    failure below, so change one thing at a time.
  - The **app** target needs no entitlement. Adding one would make its first
    entry the default access group for every `SecItemAdd` the app makes,
    including `tokens.ts`'s — see the M2 decisions log.
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

> **⛔ Blocked, and not on us (2026-08-14).** The spike below needs an Android
> push to arrive, and **Android push doesn't work yet**: Phase 10 lists *"FCM
> credentials"* as outstanding, meaning the Firebase service-account key has
> never been uploaded to EAS. Until it is, Expo cannot deliver to FCM at all,
> and the one question M4 exists to answer is unanswerable. A local
> `scheduleNotificationAsync` is no substitute — the background task consumer
> fires from `FirebaseMessagingDelegate.onMessageReceived`, which a local
> notification never reaches.
>
> **The prerequisite is Phase 10's, not this phase's**, and it needs the
> maintainer's Firebase console: create the service-account private key
> (Firebase → Project settings → Service accounts) and upload it to EAS as the
> *FCM V1 service account key*. `google-services.json` is already in place; it
> is the client half, and the two must belong to the same Firebase project or
> push fails silently.

#### What the source already answers, before the spike runs

Read out of `expo-notifications@~57.0.6` in `node_modules`, so it describes the
version we are pinned to rather than the one the issue tracker was arguing about.
It changes the shape of the milestone in both directions.

**Good news: the task path exists and is reached on every message.**
`FirebaseMessagingDelegate.onMessageReceived` ends with
`runTaskManagerTasks(...)`, and `BackgroundRemoteNotificationTaskConsumer`
registers itself into that delegate. More tellingly, `onMessageReceived`
*constructs and presents the notification itself*
(`createNotification` → `NotificationsService.receive`) — which is only
reachable in the background if Expo sends **data-only** messages to FCM, since a
notification-message is drawn by the system without ever calling
`onMessageReceived`. So the callback is live when the app isn't, and the
milestone's central worry is narrower than "does anything run at all".

**Bad news, and it's structural: the notification is presented _before_ the task
runs.** Those two lines are in that order, and nothing in between can suppress
the first. So Android cannot do what iOS does — there is no "rewrite it before
anyone sees it". The best available is **present, then replace**, and the
replacement is visible as a change on screen rather than as the original.

That is not fatal, and there is a lever for it: `getNotificationIdentifier`
uses `remoteMessage.data["tag"]` as the notification id, with the explicit
comment that *"if a notification comes in with the same tag as a notification
that is already in the tray, the existing notification is replaced"*. A
replacement scheduled under the same identifier should therefore **swap in
place** rather than stack — which is the difference between a brief flicker and
two notifications. **Verify this in the spike**; it is the single thing that
decides whether the Android experience is acceptable or merely possible.

**And the fallback route is cheaper than the plan feared.**
`FirebaseMessagingDelegate` is an `open class` and `createNotificationRequest`
is `protected open`, i.e. deliberately built for subclassing. If the task route
fails, a delegate subclass could suppress or alter the first presentation
instead of racing it — still a native surface, but a documented extension point
rather than a reimplementation of `FirebaseMessagingService`.

**Unchanged:** `expo-task-manager` is still not a dependency (confirmed against
`package.json`), so the task route adds one.

---

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

- **Spike first**, before writing anything else. Timebox it. It now has three
  questions rather than one, in this order — stop at the first that fails:
  1. Does the task fire at all when the app is swiped away? (The source says the
     callback is reached; the issue history says it sometimes isn't.)
  2. Does a replacement scheduled under the **same identifier** swap in place,
     rather than stacking a second notification?
  3. Is the visible present-then-replace acceptable to look at, or does it read
     as a glitch? This one is a judgement call and needs a person holding the
     phone, not a log line.
- And spike the right
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

### M5 — Settings, docs, and the 9c handoff ✅ **Built**

Everything below is done except the Android half of the toggle, which waits on
M4. See the decisions log for the one thing the plan didn't anticipate — the app
had no way to *read* its own setting — and for a factual error in the privacy
policy that this work surfaced.



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
- ~~**The keychain migration logs people out.**~~ **Gone** (M2). There is no
  migration: the credential is a new key, and no existing keychain item changes
  in any way. What was mitigated is now absent, which is the better outcome.
  The one thing to keep from it is the test double, which was rewritten to see
  keychain options and is what any future migration would be judged by.
- ~~**A tester skips the migration release.**~~ **Gone with it** (M2) — and the
  underlying observation stands and should outlive this phase: there is **no
  minimum-version or forced-update mechanism anywhere in this repo**, so any
  future change that assumes every install passed through a particular build is
  unsound until one exists.
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

**The coalescing staleness fix was written, reviewed, and taken back out.** The
plan called it "three lines"; it isn't, and an `xhigh` review of the M1 diff
found five separate ways it goes wrong. Recorded here because the reasoning is
the valuable part, and because the underlying bug is still real:

1. **It can 500 the message send.** `PushOutbox` has a unique constraint on
   `(message, recipient)`. Two concurrent sends can each queue a row for the
   same recipient under READ COMMITTED — different `message_id`s, so the
   constraint permits both — and a later `UPDATE ... SET message_id` collapses
   them onto the same pair. `enqueue_message_pushes` runs *inside* the
   message-create transaction, so that's a rolled-back message and a 500 for the
   sender, repeating for every message in the thread until a drain settles one.
2. **It is asymmetric.** It fixes chatter-then-mention and breaks
   mention-then-chatter: the row is re-pointed off the mention, losing
   `MENTION_CHANNEL` and the "Ada mentioned you" wording — for the person who
   turned Messages down precisely because the group is busy.
3. **A soft-delete swallows the burst.** Re-point at a message, delete that
   message, and `_should_drop` bins the row — including the earlier, undeleted
   messages it was originally for.
4. **It puts a lock on the request path.** `send_pushes` holds
   `select_for_update` across its Expo HTTP calls. An `UPDATE` here blocks on
   those locks, so a slow Expo would start stalling message sends — breaking the
   promise made three lines above the call site: *"the send is out-of-band, so
   Expo being slow or down can never slow down or fail sending a message."*
5. **It strands delivery state.** `delivered_tokens`, `attempts` and
   `last_error` still describe the old message, so a partially-delivered row
   permanently skips the device that received the *previous* one.

The mid-burst @mention misrouting is a genuine live bug and is filed as its own
issue, along with a second one the review turned up beside it: a row that
exhausts `MAX_ATTEMPTS` keeps `sent_at` NULL forever, so the coalescing check
matches it and that thread's pushes go permanently silent. Neither belongs in
this milestone — and **10b never needed the fix**, which is exactly why the
endpoint is conversation-scoped.

### M1 review, 2026-08-13 — other fixes

- **`mutableContent` is iOS-only.** It is an APNs field with no FCM equivalent,
  so on Android it woke nothing and fetched nothing while still disclosing the
  user's privacy setting to Expo and Google. M4 is where Android opts in.
- **`is_mentioned` is one predicate**, shared by the wording and the channel.
  Two copies of it is precisely how a body reading "Ada mentioned you" ends up
  on the messages channel.
- **Whitespace collapses before truncation**, so a message with newlines can't
  render a multi-line lock-screen body — the one way a preview would look
  visibly unlike the contentless notification it replaces.
- **The empty-credential guard moved before the hash.** As written it tested the
  stored value, which `sha256("")` can never equal, so it was unreachable and
  its test pinned nothing.
- **Registration kept `update_or_create`**, which resolves the create/create
  race on the unique `expo_token` rather than 500ing on it.

### M2, 2026-08-14

**There is no migration, because there is nothing to migrate.** M2's whole
middle section — read without the group, write with the group, never delete,
and the warning that the obvious version logs every upgrading tester out — was
written for **Option A**, where the item the extension reads is the access token
the app has already been storing since Phase 9. Under Option B the item is a
credential no shipped build has ever written, under a key nothing has ever used.
The first write on every device is a fresh add with the right properties, so
there is no old copy to move and no delete to get wrong.

That collapses a risk rather than mitigating one. *"The keychain migration logs
people out"* and *"a tester skips the migration release"* both come off the
Risks list: no existing keychain item changes in any way, so DoD 7 (an upgrading
tester stays logged in) holds by construction. It still wants confirming on a
real upgrade install, but that check now belongs to M3, which is the first
release with anything to see.

**No `accessGroup` is passed, and no entitlement is added to the app target.**
The credential lands in the app's own keychain access group —
`$(AppIdentifierPrefix)net.yourtimeline.app`, where everything this app stores
already lands — and M3's extension declares *that* group in its own
entitlements. The separate `…shared` group the plan imagined was rejected for
two reasons, either sufficient:

1. **It needs the literal ten-character Team ID at runtime.**
   `$(AppIdentifierPrefix)` is expanded by Xcode inside an entitlements plist
   and means nothing to `kSecAttrAccessGroup` at runtime, so the group string
   would have to be compiled into the JS (via `ios.appleTeamId`, which
   `app.json` doesn't have). A wrong or stale literal there fails the way this
   milestone's warnings say everything fails: no build error, no runtime
   complaint, `errSecMissingEntitlement` forever, and previews that just never
   work.
2. **Adding `keychain-access-groups` to the app target changes where every
   existing write goes.** The first entry in that array becomes the default
   access group for any `SecItemAdd` that doesn't name one — which is every call
   `tokens.ts` makes. Get the ordering wrong and the session's items move house
   and everyone is logged out: the exact failure M2 exists to avoid, arrived at
   from a direction the plan didn't consider. Not adding the entitlement at all
   is unambiguously safe, and the app has implicit access to its own group
   regardless.

**The cost, stated plainly:** the extension is *entitled* to read the account
tokens, since they share that group. It never queries them, it is forty lines of
our own Swift, and the boundary between an app and its own extension is not a
security boundary against anyone who can run code in either. What Option B
actually buys is untouched: the credential the extension **uses** is scoped to
one read-only endpoint, doesn't rotate, and is revoked by a row delete. If we
ever want the stronger separation as well, the way back is `ios.appleTeamId` in
`app.json` plus the literal group in `previewCredential.ts` — and it would then
need the entitlement on both targets, app group listed first.

**The at-rest downgrade is scoped to the credential**, which is a dividend of
the above worth writing down for M5's privacy text. `tokens.ts` is untouched, so
the access and refresh tokens keep `WHEN_UNLOCKED`; only the preview credential
is stored `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Under Option A that weakening
would have had to apply to the account session itself. M5 should say *the
credential* becomes readable on a locked phone, not *your tokens*.

**`savePreviewCredential` deletes before it writes** — not for the migration
reason, which is gone, but for warning 2. SecureStore's `set` is a `SecItemAdd`
that falls back to a `SecItemUpdate` of `kSecValueData` alone, so accessibility
is stamped once, at first write, and no later save can correct it. An install
that ever stored this item the wrong way would be unrepairable from the app and
undiagnosable from outside it. Nothing is at risk in the gap: the server rotates
the credential on every registration, so the value being replaced is already
dead.

**The credential's write is epoch-guarded; the Expo token's deliberately
isn't.** `push.ts` writes the Expo token *before* the POST because losing it
strands a live server row. The credential goes the other way — a sign-out
landing during the POST would otherwise write a working read-credential onto a
phone nobody is signed in on, immediately after the teardown meant to clear it.
Dropping it costs nothing, because the next registration mints another; that
self-repair is the same property that made rotating it safe in M1. It also
closes, for this key, the window `forgetLocalPushToken` documents for the Expo
token, since the epoch is bumped synchronously before that function's first
await.

**`registerPushToken` tolerates a backend that answers 204.** M1 changed the
response from 204 to `200 {preview_token}`, and `request` resolves an empty body
as `null`. A LAN dev box or a staging box mid-release is exactly that case, and
destructuring `null` would have thrown into `runRegistration`'s catch — turning
"no previews" into "push never registers at all", on the login path, silently.

**The plan's "`tokens.ts` passes the options on all six calls" is void**, along
with its instruction to add the extension to that file's docstring as a fourth
caller. `tokens.ts` passes no options at all and its keys are not what the
extension reads. Its docstring instead now says which rule is about the *keys*
rather than about SecureStore, names the three other files that legitimately use
the store, and records why the account tokens didn't have to change.

**The test double was rewritten first, as instructed, and it earned it.** The
old flat `Map` discarded the options argument, so every assertion in this
milestone would have passed no matter what the code did. It now keys on
(service, access group, key), records accessibility, models a group-less
query as matching *across* groups — the behaviour that would have broken the
plan's migration — and reproduces the update-keeps-attributes rule above.
Verified the hard way: removing the delete-before-write, and unpinning the
service, each make a test fail.

### M2 review, 2026-08-14 — fixes

An `xhigh` review of the M2 diff. Three findings were about the same mistake
seen from three sides — **a credential has more teardown paths than a
preference does** — and they are the ones worth remembering.

- **The session guard moved into `previewCredential.ts`, and grew two more
  checks.** The first version guarded the *call* to `savePreviewCredential` from
  `push.ts`, which closes the window only up to the moment that function is
  entered — and the function then awaits twice. A sign-out landing inside the
  delete deletes nothing (we have just deleted) and then watches the credential
  be written onto a phone that is by then on the login screen. It now owns a
  counter of its own, exactly as `tokens.ts` does, checked on entry, again after
  the delete, and again after the write, with a compare-and-delete undo for the
  sliver that remains. Declining to write is better than writing-and-undoing,
  because a teardown can be followed by a *new* registration storing its own
  credential — the undo can remove what it wrote but cannot put back what it
  clobbered. That last case was found by a test written to assert the opposite.
- **There is a third teardown path, and it isn't in `push.ts`.** `signOut` calls
  `unregisterPush` and the expiry handler calls `forgetLocalPushToken`, but a
  refresh that *succeeds* followed by a replay that 401s never fires the expiry
  handler — it lands in `auth.tsx`'s cold-start catch, which reaches
  `clearTokens` directly. An account deactivated while the app was closed looks
  exactly like that, and `is_active=False` is an ordinary state here because
  sign-ups are admin-gated. The device reached the login screen still holding
  both push secrets. That gap pre-dates 10b for the Expo token; it now clears
  both.
- **The two local deletes are independent.** Android's
  `deleteValueWithKeyAsync` rethrows failures as a `DeleteException`, unlike
  iOS, which ignores `SecItemDelete`'s status — so sequential awaits let a
  hiccup on the Expo token skip the credential entirely, leaving the more
  sensitive of the two behind because the less sensitive one failed. From inside
  `unregisterPush`'s `finally` it would also reject past the catch that exists
  to stop a network failure trapping someone in a logged-in app. Both now go
  through one `Promise.allSettled`.
- **A failed credential write is no longer a failed registration.** It sits
  after the POST, so the row exists and the Expo token is stored; letting it
  fall to `runRegistration`'s catch reported a registration that wholly
  succeeded as `null`.
- **The test double now models `requireAuthentication`**, which is what decides
  the `:no-auth` suffix on the service — part of the literal M3's Swift
  hardcodes. Flip that flag and every item moves service, the extension gets
  `errSecItemNotFound` on every push on every device, and nothing in the app
  notices. It also models the read's fallback through the three service aliases,
  as the real `get` does. The test now asserts the exact string
  `timeline:no-auth` rather than the pinned half of it.
- **The "account tokens aren't stored alongside" test checks both keys.** It
  filtered on `timeline.access`, so a tidy-up that moved only the *refresh*
  token onto the credential's options — the long-lived half, which buys a whole
  session — would have downgraded its accessibility with the suite still green.
- **`accounts.md` claimed the local copy and the server row "go at the same
  time".** They don't: only sign-out deletes the row. The doc now states the
  asymmetry, since it is the one M5's privacy text will be written from.

### M3, 2026-08-14

**The plugin is local, and it is bigger than "~100 lines".** The estimate
assumed the plugin API does the work; most of it is `xcode`'s `addTarget`, which
handles the genuinely fiddly half — the product reference, the build
configuration list, the Copy Files phase that embeds the `.appex`, and the app's
dependency on it. What's left is the build settings Xcode's target template
would have filled in and which `addTarget` leaves out: the entitlements path,
`SWIFT_VERSION`, the device family, and the three settings copied off the app
target. Still well short of taking a third-party plugin onto the release path.

**Everything happens in one `withXcodeProject` mod**, including writing the
files, rather than a `withDangerousMod` for the files and a second mod for the
project. Two mods would have depended on the order Expo applies them in, which
is not something this repo should be pinned to; the paths are all available from
`modRequest` either way.

**It is idempotent, which the plan didn't ask for.** The files and the build
settings are rewritten on every run — so editing the Swift, or bumping the
version, and re-running prebuild does the obvious thing — while the target
itself is created only if it isn't already there. The path that needs this is
`expo prebuild --no-clean`; **cleaning is the default and there is no `--clean`
flag**, which is worth knowing both ways round, since a plain `expo prebuild`
silently deletes `ios/build` along with everything else.

**The versions are copied — but not from where the plan said, and the difference
was a live bug.** "Have the plugin copy the app target's values rather than state
them" is the right instinct and the wrong source. The app target *does* carry
`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`, and **nothing reads them**:
Expo writes `CFBundleShortVersionString`/`CFBundleVersion` straight into the
app's Info.plist from the config and never touches the build settings
(`@expo/config-plugins`' `ios/Version.ts` mentions neither). Copying them
produced an extension stamped **1.0** inside an app stamped **1.0.0** — which is
precisely the App Store Connect validation rejection the plan warned about, and
it would have arrived after a fifteen-minute build and an upload, in a message
naming neither number.

Caught by building the app and diffing the two `Info.plist`s by hand, which is
the only place it was visible: the extension target built fine, the app built
fine, and every test passed. The fix is `IOSConfig.Version.getVersion` /
`getBuildNumber` — the same two functions Expo's own writer uses — so the two
bundles cannot disagree. That also survives `appVersionSource: remote` +
`autoIncrement`, because EAS puts the resolved build number in the config
*before* prebuild runs. `IPHONEOS_DEPLOYMENT_TARGET` is still copied off the app
target, because that one really is a build setting.

**`NSAllowsLocalNetworking` is in the extension's Info.plist.** Not in the plan,
and needed for the plan's own dev story to work: `EXPO_PUBLIC_API_URL` pointed at
a LAN Django is `http://192.168.x.x`, which App Transport Security blocks
outright. This exception covers LAN and loopback addresses only, so public HTTPS
is exactly as strict as before — the alternative would have been an extension
that cannot be developed against a local backend, which is the only way to
develop it.

**The tests read the Swift as text, and that is the point.** Jest cannot run an
extension and the Simulator cannot easily be made to deliver one a push — but
worse, the fallback discipline means *every* way it can be wrong looks identical
from outside: it delivers exactly the notification a working one would have
delivered before 10b. Nothing crashes and nothing logs. So the suite pins the
string equalities no compiler checks: the keychain key and service against
`previewCredential.ts`, the URL path against the backend route, the `Preview`
auth keyword, the `/messages/` prefix, the Info.plist key against the plugin,
and — the one that saves fifteen minutes of EAS build time — that `app.json`'s
`appExtensions` entry agrees with the plugin on the bundle identifier and the
entitlement.

It also asserts the extension logs *nothing*: no `os_log`, `NSLog`, `print`,
`debugPrint` or `dump`. The usual way to debug an extension is to print things
and read Console.app, everything this process touches is either a credential or
somebody's private message, and Console.app is readable by anything on the Mac
the phone is plugged into.

**Two Swift fixes found by reading rather than by building**, both of which
would have shipped as "previews are flaky and nobody can say why":

- The `URLSession` was created locally and never held, so it was free to be
  released while its request was in flight — which cancels the request.
  `finishTasksAndInvalidate()` after `resume()` is the documented way to say
  "let what's outstanding finish, then let go".
- The completion closure captured `self` weakly. There was no cycle to break
  (the session is invalidated), and a released instance would mean the content
  handler was never called at all — a notification dropped rather than merely
  un-previewed. Strong capture is the safer failure here.

**Verified as far as a laptop can:** `expo prebuild --clean` produces the target;
`xcodebuild` builds the `.appex`; the whole app builds and ships it in
`TimeLine.app/PlugIns/`; and the embedded bundle carries the right
`NSExtensionPointIdentifier`, a principal class of
`NotificationService.NotificationService` resolved from `$(PRODUCT_MODULE_NAME)`,
the injected API URL, and version keys equal to the app's. What is left is the
device matrix, and `docs/mobile-release.md` now carries the warning that the
first build with the extension re-enters the interactive Apple-login path.

### M3 review, 2026-08-14 — fixes

An `xhigh` review of the M3 diff. The theme: **the idempotent path was never
actually exercised, so nothing in it worked** — and it was written to be
exercised by an invocation the plan had backwards.

- **The idempotency guard could never fire.** `addTarget` stores the target's
  name *quoted*, and `pbxTargetByName` compares the section comment verbatim, so
  `pbxTargetByName('NotificationService')` returns `null` forever. Confirmed by
  driving the `xcode` library against the real generated project: a second run
  produced two targets, four build configurations, and two `.appex` rows in the
  app's Copy Files phase — precisely the unbuildable project the guard was there
  to prevent. Replaced with a lookup that accepts either spelling and returns
  the *uuid*, which is what the rest of the plugin needs anyway.
- **And the settings it guarded were the ones that must not be skipped.** The
  early `return` meant the versions, the entitlements path and the deployment
  target were written only on the run that created the target. With the guard
  repaired, a `--no-clean` prebuild after a version bump would have left the
  extension stamped with the old version while Expo rewrote the app's Info.plist
  with the new — the App Store Connect rejection this milestone had *already*
  been rewritten once to avoid, arriving by a second route. They now sit outside
  the branch and refresh every run. Verified by bumping `expo.version`,
  re-prebuilding, and watching both extension configurations follow.
- **The settings are applied through the target's own configuration list**, not
  by scanning the whole project for a matching `PRODUCT_NAME`. A name match is a
  coincidence away from writing into another target and one change in how
  `xcode` quotes that value away from matching *nothing* — which would silently
  drop `CODE_SIGN_ENTITLEMENTS`, the one setting this milestone turns on, with
  the Swift's fallback discipline hiding the result forever.
- **`deliver()` could drop a notification entirely.** If `mutableCopy()` ever
  returned nil, both it and `serviceExtensionTimeWillExpire` fell through their
  `guard` and the content handler was never called — so iOS dropped the push
  rather than showing the contentless body. That is the one outcome the file's
  own header says cannot happen. It now keeps the original content and delivers
  that.
- **`deliver()` was not thread-safe.** The URLSession completion runs on the
  session's queue and the expiry hook on the system's, so a response landing as
  the budget expires let both pass the nil-check before either cleared it, and
  call the handler twice — undefined behaviour, not a duplicate notification.
  The same window raced the body write against the read. An `NSLock` now covers
  the take-and-clear and the write.
- **Orphan build files removed.** `addPbxGroup` registers a `PBXBuildFile` for
  each path it hasn't seen, so the Info.plist and the entitlements came away
  with build files belonging to no phase — inert, but labelled `in Resources`,
  which reads as though the entitlements plist is copied into the shipped
  bundle.
- **The `??` on the bundle identifier was dead code.**
  `IOSConfig.BundleIdentifier.getBundleIdentifier` is literally
  `config.ios?.bundleIdentifier ?? null` — the same expression as the left-hand
  side. A fallback that can never supply a value is worse than none.
- **The default API URL is read out of `api.ts`** rather than restated in the
  test. It lives in three files that must agree, and a test carrying its own
  fourth copy compared all three against a literal none of them has to match.
- **The `logs nothing` assertion scans the comment-stripped source**, like its
  two neighbours. As written, strengthening the Swift's own warning comment to
  name the calls it forbids would have failed the suite — and the obvious repair
  is to weaken the check.
- **`app.json`'s `appExtensions` is read with optional chaining.** Dereferenced
  in a `describe` body, deleting that block took the whole file down at
  collection time with a `TypeError`, losing all forty assertions — including
  the three that would have said what broke.
- **The `ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES` comment was wrong.** The value
  is right; the setting controls whether the Swift runtime dylibs are copied
  into the bundle, not symbol stripping. In this repo the comments are the
  reference, so a wrong *why* leaves the next reader unable to tell whether the
  value was chosen for it.

### M5, 2026-08-14

**The plan forgot that the app cannot read its own setting.** `show_previews`
was writable (`PATCH`) and readable by nobody: `POST /push-tokens/` answered
only the credential, and there is no GET. A switch has to be drawn in the
position it is actually in, so registration now answers `show_previews` too.
That is cheaper than the alternatives and can't drift: the app registers on
every launch, and the only two things that change the value are that upsert —
which resets it when the phone changes hands — and the PATCH the switch sends.
A GET would have had to carry a device identifier in a URL, which is the one
thing `tokens.ts`'s rules forbid outright.

It also makes the owner-change reset visible. Without it, the new owner's app
would go on drawing the switch where the *previous* owner left it while the
server had already turned it off — so someone would toggle it off and on again
to fix a setting that was never on.

**The mirror stores the server's answer, not the value asked for.** They agree
today. A local copy that records the request rather than the result is how a
mirror starts drifting from the thing it mirrors, and this one is read on every
Settings visit and believed.

**"Not registered for push" and "previews off" are different states with
different words.** A phone that never got notification permission has no server
row to toggle, so a switch there would `404`. It gets a sentence pointing at the
OS settings instead. Conflating them would have told someone their previews were
off when the truth is that nothing can notify them at all.

**Its own section, not a row inside Notification preferences.** Those are per
*account* and decide whether you are notified; this is per *device* and decides
how much a notification says. Merging them would have put two different scopes
under one heading with nothing on screen saying which was which.

**The switch is absent on Android rather than disabled.** `mutable-content` is
an APNs field with no FCM equivalent, so there it would set a server flag that
nothing acts on. M4 decides whether Android gets a path of its own; until then,
no control beats a dead one. A shared `iosIt` helper joins `androidIt` in the
test helpers for the same reason the latter exists.

**The privacy policy said the server lives in the operator's home.** It hasn't
since Phase 11 moved to AWS on 2026-08-12 — so a legal document was wrong about
which jurisdiction and which company holds members' personal data, which is
squarely the sort of thing that policy exists to state. Corrected while writing
the push section, since that is the section that sends people to read it.

The new push section says, in plain words: notifications pass through Expo and
then Apple or Google; they deliberately carry no message text; previews are
opt-in, per device, and fetched by the phone directly afterwards; the phone
stores a limited key to do it, removed on sign-out; and — stated rather than
implied — with previews on, anyone who can see your lock screen can read your
messages.

**Known noise:** three of the new Settings tests emit React's *"testing
environment is not configured to support act"* on stderr. It is react-query
notifying its observers as a settled mutation is dropped, after RNTL has already
switched the act environment off; the assertions pass and the updates are
benign. Chased through `settle`, an explicit in-`act` unmount, and removing both
`useHoldOpen` and `cancelQueries` — none of which moved it — and then left,
because the remaining candidates are all inside react-query's teardown and the
cost of the noise is lower than the cost of contorting the component around it.

### M5 review, 2026-08-14 — fixes

An `xhigh` review of the M5 diff. The two that matter most are the same shape:
**a state was being inferred from the wrong signal, and the wrong answer looked
like a normal one.**

- **"Is this device registered?" was answering the Expo token's presence**, and
  the token is deliberately written *before* the registration POST — so it can
  name a row that was never created. A first launch whose POST went out and lost
  its answer would have drawn the switch, and flipping it would have put "Not
  found." under a privacy control. It now keys off the mirror, which only a
  registration *response* writes; that also removes the second keychain read,
  and with it the `Promise.all` that would have discarded a good token read
  because the preference read failed.
- **A failed read rendered as "you haven't turned on notifications."** Exactly
  #317, one section along: no error branch meant a keychain failure fell through
  to the not-registered note and told someone to switch on notifications they
  already had on, with no retry and no way to reach their own switch.
- **The not-registered note was a dead end within the session.** Registration
  runs on sign-in and cold start and nowhere else, so following the instruction,
  returning to the app and finding the same note was the likely outcome — with a
  force-quit as the only cure, and nothing on screen saying so. It now offers
  *Check again*, which re-registers and re-reads.
- **The mirror had no tests.** The settings tests seeded it by hand, so deleting
  either the write in `runRegistration` or the delete in `clearLocalPushState`
  left the suite green — including the owner-change reset this milestone's whole
  argument rests on. Four tests now cover it, checked by breaking the code.
- **The privacy policy was missing the at-rest downgrade `previewCredential.ts`
  promises M5 would disclose**, and it named three US companies as new
  recipients without saying that a transfer outside the UK occurs — in a policy
  that invokes UK GDPR by name, in the very section added to close a
  transparency gap. Both stated now, in plain words.
- Smaller: the query is `enabled` only on iOS, so Android's Settings no longer
  does two Keystore reads for a section that renders nothing;
  `clearLocalPushState`'s docstring said "both" and "the two" when it now clears
  three things; and the `setPushPreviews` guard is labelled as the defensive
  assertion it is, since `serverMessage` can never surface a non-`ApiError`
  message and the sentence it authored was unreachable.
- **`notifications.md`'s "it cannot drift" was an overclaim.** A launch whose
  POST never lands leaves the previous value for the session — swallowed on
  purpose, because push must not break a launch. Now stated, so nobody later
  decides against a reconciliation path on the strength of an absolute.

### M5 revised, 2026-08-14 — what the first real handset changed

The build reached a phone, previews worked, and using it for ten minutes
produced two corrections that no amount of review had caught. Both came from the
user; both are recorded here because the *reasoning* is the part worth keeping.

**"Show message text on the lock screen" was the wrong label, in both
directions.** The setting doesn't govern the lock screen — it governs whether
the notification *contains* the sender and the text at all, everywhere a
notification appears. The label under-described what it does *and* implied a
locked/unlocked distinction the feature cannot make. It is now "Show message
previews", with the lock screen where it belongs: as the *reason* you might turn
it off, in the explanatory text.

**The locked/unlocked behaviour we thought we might owe is Apple's, and we get
it free.** The user asked for WhatsApp's behaviour — text hidden on a locked
screen, revealed once you pick the phone up. That is not WhatsApp; it is
*Settings → Notifications → Show Previews*, which defaults to **When Unlocked**
on any Face ID iPhone and applies to every app. We could not build it if we
wanted to: the extension runs once, at delivery, and produces one body, while
the reveal decision is made later and repeatedly at display time. So the OS is
already doing the hard half.

That collapses the whole off-by-default argument. It was written to avoid
"quietly starting to show people's messages on their friends' lock screens" —
which iOS already prevents. **Default is now on**, matching WhatsApp and Signal,
with a data migration bringing existing rows along (safe here, and *only* here,
because nothing outside the maintainer's own devices has ever had the feature —
flipping a privacy default under people who have made a choice is a different
act and would need telling them).

**A third thing followed from the second.** If the switch is what people reach
for when they want privacy, then "off" naming the sender is a strange
half-privacy: it is *who* is messaging you, more than what they said, that a
glance at a lock screen gives away. So off now hides both, and the body on the
wire becomes `New message` — which is also the one privacy gain in this phase
that has nothing to do with a lock screen, since it is the body Expo and
Apple/Google see.

**And the Reply field had to go with it**, reversing DoD 5. That rule was
written when "off" still named the sender, and it was right then. Once it
doesn't, a reply field answers an unknown message from an unknown person: the
trap this entire phase exists to fix, in a worse form than the one it started
with. Reply stays on the default path, which was always the real point of the
rule.

**Note the shape of this.** Three of the four corrections came from *using* the
thing for ten minutes, not from reading it. The design was internally coherent
and wrong at the edges, and the specific way it was wrong — a label that
described the risk rather than the behaviour — is not something a reviewer with
the same mental model as the author will catch.

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
