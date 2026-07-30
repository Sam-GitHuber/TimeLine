# Phase 10b — Notification content, without leaking it

**Status: PLAN.** Fleshed 2026-07-30 and confirmed with the user. Ready to
execute.

**Why the odd number.** It follows Phase 10 (Android, shipped) and comes
*before* Phase 9c (E2E), which is scheduled after Android. The numbering is
chronological, not a hierarchy — 9b set the precedent for a lettered follow-on.

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
notification's body before the user sees it. Android's equivalent is a data-only
message handled in a background task that posts a local notification.

The push itself stays exactly as contentless as it is today. The content comes
**straight from our server to the device over TLS**, and never enters the push
path at all. This is how Signal does it, and it's strictly better than the
status quo even setting E2E aside.

## Why this is its own phase, ahead of 9c

Phase 9c's milestone 7 needs this extension to exist. Under E2E the server
*cannot* phrase a push body — it can't read the message — so on-device
notification content stops being a nicety and becomes the only way a notification
ever says anything again.

Nearly all the hard parts of that work are **independent of the cryptography**:

| Piece | Built here | Survives into 9c |
| --- | --- | --- |
| iOS NSE target + config plugin (CNG) | ✅ | ✅ unchanged |
| Android data-only + local notification | ✅ | ✅ unchanged |
| Keychain access group / App Group sharing | ✅ | ✅ unchanged |
| Auth inside an extension, and its expiry | ✅ | ✅ unchanged |
| `mutableContent` payload path, per-device gating | ✅ | ✅ unchanged |
| Fallback discipline when the extension fails | ✅ | ✅ unchanged |
| **Where the plaintext comes from** | an authenticated fetch | **replaced** by local decryption |

Only the last row is thrown away. Building it now fixes a live product complaint
months earlier and de-risks the nastiest scaffolding in 9c while the payload is
still a plain JSON body that's easy to reason about — rather than debugging a
Swift extension and a double-ratchet at the same time.

**The cost, stated plainly:** we build a fetch path and later delete it. That's
roughly one endpoint and the ~20 lines of Swift that call it.

## Definition of done

1. On **iOS**, a message push from a device with previews enabled displays the
   actual message text (truncated), and the Reply field is answering something
   readable.
2. On **Android**, the same, or a **written decision** to defer it with the
   reason recorded (see M4 — this is genuinely less reliable and may not land).
3. The push payload on the wire still contains **no message content**, verified
   by a test asserting the exact body the server sends.
4. **Previews are per device and off by default**, toggled in the app's
   notification settings, stored on `DevicePushToken`.
5. A device with previews **off** gets today's behaviour *and no Reply field* —
   the trap is gone either way.
6. Every failure path falls back to `New message from Ada`. **No push is ever
   silent** because the extension had a bad day.
7. `notifications.md` and `messaging.md` describe the new shape; the privacy
   policy gains a push section (it has none today).
8. Phase 9c's milestone 7 is rewritten to "swap fetch for decrypt", with this
   doc as its starting point.

### Non-goals

- **Notification grouping / threading** (stacking a conversation's notifications
  into one). Worth having, unrelated, easy to bolt on later.
- **Rich media in notifications** (showing the photo). An NSE can do it, but the
  ~24 MB memory ceiling makes image handling the single most common way these
  extensions crash. Not now.
- **Notification content for anything but messages.** Reactions and replies are
  fine as they are — they name a person and that's the whole story.
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
reproduce.

So: **the extension reads the access token and uses it, or gives up.** If it's
missing or rejected, the notification keeps its server-phrased body and the app
refreshes normally on next foreground. The 1-day access lifetime makes this a
rare path, not the common one — which is exactly why this restriction is
affordable here and must be re-examined if that lifetime ever shortens.

### Previews are per *device*, and off by default

Per-device because the thing that leaks is a **lock screen**, and a lock screen
belongs to a phone, not an account. Someone can want previews on their own
phone and not on the tablet in the kitchen. It's also nearly free: `_payload()`
is computed once per outbox row, but `_message(device, payload)` already runs per
device (`send_pushes.py:165`), so the flag slots into the existing shape.

**Off by default**, because turning a default on later is one line and quietly
starting to show people's messages on their friends' lock screens is not. Ask
the TestFlight group once it exists.

### The preview endpoint is conversation-scoped, not message-scoped

The extension asks *"what should the notification for conversation 12 say?"*,
not *"what does message 480 say?"*.

This falls out of an existing quirk. `enqueue_message_pushes` **coalesces**: if
an unsent push is already queued for a conversation, a second message doesn't
add one. So the queued row points at the *first* message of a burst. Harmless
while bodies are contentless; with previews, a message-scoped fetch would show
you the oldest unread message and never the newest. A conversation-scoped
endpoint returns the latest visible message and sidesteps that entirely, without
touching the enqueue path.

It must reuse the **same visibility rules** as `enqueue_message_pushes` — active
participant, not left, `ParticipantInterval` spanning the message — rather than
reimplementing them. Two copies of that rule will diverge, and the failure mode
is showing someone a message they aren't allowed to read.

### The fallback is the current body, always

An NSE is **not guaranteed to run**. iOS may skip it under memory pressure or low
battery, it can time out, the network can be down, the token can be stale. Every
one of those must degrade to `New message from Ada` — the notification the server
already composed and which is sitting in the payload the whole time.

This is why the push keeps a real `title`/`body` rather than going fully silent:
a silent push that depends on an extension firing is a notification you sometimes
just don't get, and "sometimes doesn't notify you" is worse than "vague".

## Milestones

### M1 — Backend: the preview endpoint and the payload flag

- Add `show_previews` (boolean, default `False`) to `DevicePushToken`; migration.
- Extend the register-token endpoint to accept and update it; add an endpoint (or
  extend the existing one) for the settings screen to flip it.
- `GET /api/conversations/<id>/push-preview/` → `{sender, text, has_photo,
  conversation_title, unread_count}`. Authenticated; visibility rules **imported
  from** the messaging module, not rewritten. Excludes soft-deleted messages.
  Text truncated server-side.
- `send_pushes._payload()` gains the conversation id; `_message(device, payload)`
  sets `mutableContent: true` and `data.conversationId` **only** when
  `device.show_previews`, and attaches `categoryId` only in that same case (DoD 5).
- Tests: the wire payload never contains message text; a non-participant gets
  403; a participant in an interval gap gets 403; a muted participant still gets
  a preview (mute is about buzzing, not permission); soft-deleted messages are
  skipped; `mutableContent`/`categoryId` appear only for opted-in devices.

### M2 — Keychain access group, and its migration

`expo-secure-store` supports an **`accessGroup`** option on `setItemAsync` /
`getItemAsync`, which is what lets the NSE read `timeline.access` from
`src/tokens.ts`.

**The migration is the fiddly bit.** Items already written *without* an access
group live in the app's default group, and a read specifying a different group
will not find them. Every existing tester would silently appear logged out. So:
on launch, read without the group, and if a token is found, rewrite it with the
group and delete the original. One release later that path can go.

- Add the App Group / keychain-sharing entitlement via `app.json`.
- `tokens.ts` passes `accessGroup` on all four calls (it's the only file that
  touches token storage — the existing rule pays off here).
- Tests: the migration runs once, is idempotent, and a failure leaves the user
  logged in rather than logged out.

### M3 — The iOS Notification Service Extension

The native dirs are **gitignored** (`mobile/.gitignore:57`), so this is a CNG
project: the extension must come from a **config plugin**, never a hand-edit of
Xcode. `expo-notifications` does not ship an NSE; the well-trodden route is a
plugin that copies a Swift file into a new target and signs it.

- Choose between an existing community plugin and a small local one in
  `mobile/plugins/`. **Lean local**: this is ~100 lines of well-documented
  plugin API, and an unmaintained third-party plugin in the build path is a
  supply-chain risk on the critical path of shipping the app at all.
- The Swift is deliberately thin: read the token from the shared keychain, GET
  the endpoint, set `bestAttemptContent.body`, call the handler. Implement
  `serviceExtensionTimeWillExpire` to deliver the unmodified content.
- No image handling (non-goal), which keeps it far under the memory ceiling.
- Verify the EAS build signs both targets.

### M4 — Android, or a written decision not to

**iOS and Android are not symmetric here, and that's the main risk in the phase.**
An NSE runs for every push regardless of app state — that's its whole design.
Android's equivalent through Expo is `Notifications.registerTaskAsync` +
`TaskManager.defineTask`, and there is a **history of that task not firing when
the app is terminated** (expo/expo#19681, #29622, #38223). #38223 was closed with
a fix, but it was filed against SDK 53 and we're on 57 — so this is *verify,
don't assume*.

- **Spike first**, before writing anything else: build a dev client, force-stop
  the app, send a data-only push, confirm the task runs. Timebox it.
- If it works: data-only push → task → `scheduleNotificationAsync` with the
  fetched body, same fallback discipline.
- If it doesn't: the reliable route is a native `FirebaseMessagingService`
  subclass via a config plugin (what Notifee does). **That is a second native
  surface**, and if the spike fails, the honest answer may be to ship iOS,
  record the finding here, and leave Android on the contentless body — which is
  strictly no worse than today.

### M5 — Settings, docs, and the 9c handoff

- Preview toggle in the app's notification settings, with plain wording about
  what it does and where the text comes from. Both platforms, even if only iOS
  acts on it.
- Update `notifications.md` (the "what leaves the box" section needs to become
  precise: the *push* carries no content; the *device* fetches it) and
  `messaging.md`'s push section.
- Add a push section to `frontend/src/pages/legal/PrivacyPage.jsx`, which
  currently says nothing about push at all.
- Rewrite Phase 9c hard part 7 / milestone 7 as "replace the fetch with local
  decryption", pointing here for everything already built.

## Risks

- **The Android background task doesn't fire when terminated.** Highest-
  likelihood risk. Mitigated by spiking it first (M4) and by iOS being
  independently shippable.
- **Two processes and one rotating refresh token.** Mitigated by the
  never-refresh rule above. Re-check if the access lifetime ever shortens.
- **The keychain access-group migration logs people out.** Mitigated by
  migrate-on-launch and by failing towards "stay logged in". Test on a build
  upgraded from the current TestFlight build, not a clean install — a clean
  install cannot reproduce this.
- **A config plugin breaks the iOS build.** It sits on the path of every
  release. Mitigated by keeping the plugin local and minimal, and by shipping
  through TestFlight internal first — `docs/mobile-release.md` is required
  reading before any of this goes out.
- **The Swift is hard to unit-test.** Accepted. Keep the extension thin enough
  to eyeball, put the logic that *can* be tested (payload construction,
  visibility, the toggle) on the server and in TS where the suite already is,
  and write a manual device matrix: previews on/off × app foreground/background/
  terminated × network up/down × token valid/expired.

## Open questions

- **Should the preview endpoint return the unread count**, so the notification
  can say "3 new messages"? Cheap here, and it needs the same call. Probably yes.
- **Does the toggle belong per device or per device *and* per conversation?**
  ("Never preview this one chat.") Suspect that's over-thinking it; revisit if
  anyone asks.
- **What does the extension show for a photo with no caption?** Today's `Ada
  sent a photo` is already right, so possibly nothing changes.
