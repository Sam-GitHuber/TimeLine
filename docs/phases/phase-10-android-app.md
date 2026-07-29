# Phase 10 — Android App

**Status:** plan — **fleshed out, awaiting go-ahead to start**

Because Phase 9 built the app in **React Native (Expo)**, the app is *already*
cross-platform — this phase is **not a second app**. Every screen already exists.
The work is: toolchain, FCM credentials, notification channels, the Android back
button, Android-only layout/behaviour bugs, and a **distribution channel for
friends and family** that is the equivalent of TestFlight.

Read [`../reference/mobile-app.md`](../reference/mobile-app.md) first (how the app
is laid out and its React Native traps), and
[`../mobile-release.md`](../mobile-release.md) (the iOS release runbook this
phase's Android half will mirror).

## Goal

An installable Android app on the same codebase, with working FCM push, running
against the home-server beta (Phase 7), distributed **privately to invited
friends and family** — the Android analogue of the current external TestFlight
beta. Sign-ups stay admin-approved, so distribution reach never means data
exposure.

---

## 1. How we test and distribute (the TestFlight question)

Android has no single TestFlight. It has four channels with different
trade-offs, and the honest answer is that **we want two of them**: a free,
instant one for the development loop, and a Play Store one for the actual family
beta.

### The options

| Channel | Cost | Who can install | Install path | Review wait | Auto-updates |
|---|---|---|---|---|---|
| **EAS internal distribution** (`preview` profile → APK + link/QR) | free | anyone you send the link to | tap link, allow "install unknown apps" once | none | ❌ manual re-install |
| **Firebase App Distribution** | free | testers you add by email | "App Tester" app or emailed link | none | ⚠️ notified, tap to install |
| **Play internal testing** | $25 one-off | up to **100** testers, added by Google-account email | normal **Play Store** install via an opt-in link | **none** | ✅ like any Play app |
| Play closed / open testing | same $25 | larger groups, public link | Play Store | days (first release) | ✅ |

### The recommendation

**Both, in this order:**

1. **EAS internal distribution APK** for the whole build-and-fix loop. `eas build
   --profile preview --platform android` produces an **APK** with a download page
   and QR code. No Play Console, no $25, no waiting — this is what we use to get
   a build onto a real Android phone the first time (a borrowed one, or the first
   willing tester) to shake out the "works on the emulator, dies on hardware"
   class of bug. It's also the fallback if the Play account hits any verification
   snag.

2. **Play Console internal testing** as the actual family channel — this is the
   real TestFlight analogue and the one we should end on. It matters because it
   is the only option where a family member's experience is *the normal one*:
   they install from the Play Store like any other app, and updates arrive
   silently in the background. Everything else asks a non-technical relative to
   tap through an "install unknown apps" security warning, which is both a bad
   experience and bad security hygiene to teach.

**Firebase App Distribution is deliberately skipped.** We'll already have a
Firebase project for FCM, so it's tempting — but it lands in exactly the same
place as the EAS APK (sideload, warnings, manual updates) while adding a second
console and a tester-side app to explain. It earns its keep for teams that need
crash-reporting tie-in; we don't.

### Play internal testing vs TestFlight — the differences that matter

Worth knowing before spending the $25, because a couple of these are *better*
than TestFlight and one is worse:

- **No app review, ever, on the internal track.** Internal testing is exempt from
  the usual policy/security review, and a release reaches testers within minutes.
  That's better than TestFlight's external track (which needs Beta App Review for
  the first build per group). It also means **the `create_review_account` demo
  account is not needed for Android** — nobody at Google logs into the app.
- **No expiry.** TestFlight builds die after 90 days and testers get nagged to
  update. A Play internal-testing build just stays installed.
- **Testers are added by Google-account email address** (up to 100), on a list in
  Play Console, and each gets an **opt-in link** they must accept once. The email
  must be the Google account on their device, which is the one fiddly bit to
  explain — the same shape as TestFlight needing their Apple ID.
- **Internal testing does *not* require the full store setup.** No Data safety
  form, no content rating, no store listing screenshots, no privacy-policy URL
  are required to publish to the internal track — Play only needs a valid app
  bundle. (Play Console will still show those sections as incomplete; that's a
  nag, not a block. They only become mandatory if we ever go to closed/open
  testing or production.)
- **The one genuinely worse thing: developer account verification.** A *personal*
  Play developer account has to complete identity verification (government ID,
  name and address) before publishing anything. Budget for it taking a few days
  and do it **first**, not at the end.
- **The "12 testers for 14 days" rule does not apply to us.** That rule gates
  *production* access for personal accounts created after Nov 2023, and it only
  counts **closed** testing. We are never applying for production access — a
  friends-and-family beta lives on the internal track indefinitely. This is worth
  writing down because it's the single most confusing thing in current Play
  documentation and it would otherwise look like a blocker.

### Signing — the one irreversible decision

Android's equivalent of the iOS certificate dance, and the part that's genuinely
hard to undo:

- EAS generates and stores an **upload keystore** for us (same model as the iOS
  Distribution Certificate — it lives on EAS's servers, not in the repo).
- Play then re-signs with **Play App Signing**, so Google holds the *app* signing
  key. This is the default and what we want: it means a lost upload key is
  recoverable (Google can reset it), whereas a lost app-signing key without Play
  App Signing would mean **never being able to update the app again**.
- **Take a backup anyway:** `eas credentials --platform android` can export the
  keystore. Store it wherever the home-server backup secrets live (see
  `backup-restore.md`), not in the repo.
- The **package name `net.yourtimeline.app` is permanent** once published to Play.
  It already matches the iOS bundle id and is set in `app.json`, so nothing to
  decide — just don't change it.

### What testing actually looks like

Four layers, cheapest first — the same philosophy as the rest of the project:

1. **Jest, on both platforms.** `jest-expo` can run the suite twice, once per
   platform, so `Platform.OS === 'android'` branches are actually executed
   instead of being dead code in CI. We have ~17 files with platform branches
   (action sheets, keyboard avoidance) that today are **only ever tested on the
   iOS path**. This is the highest-value testing change in the phase and costs a
   config edit plus some CI minutes.
2. **The Android Emulator**, for the daily loop. Android Studio, an AVD on a
   **Google Play** system image (required for FCM push to work), arm64 on Apple
   Silicon so it's genuinely fast. Unlike iOS, **push can be tested on the
   emulator** — a real advantage over Phase 9, which needed a device pass.
3. **A real device pass**, via the EAS APK link. Still worth doing once even
   though the emulator covers push: hardware keyboards, real gesture navigation,
   scroll performance and the camera-roll picker are where emulators lie.
4. **Real testers' devices**, via Play internal testing — the widest hardware
   coverage we'll get, and free. Manufacturer skins (Samsung One UI in
   particular) are the usual source of surprises.

**No Detox/Maestro E2E**, unchanged from Phase 9 — a second tool plus emulator
infrastructure in CI isn't worth the flakiness tax at this scale.

**Emulator-only development remains acceptable** (the maintainer has no Android
phone). The real-device pass is an *optional stretch*, not a gate.

---

## 2. What's actually Android-specific (the real work)

Audited against the current codebase rather than assumed. Every item below is a
real, located thing.

### Push (the biggest piece)

- **Firebase project + FCM v1 credentials.** Google deprecated the legacy FCM
  protocol, so this is the v1 flow: create a Firebase project, add an Android app
  with package `net.yourtimeline.app`, download **`google-services.json`**, and
  reference it from `app.json` (`android.googleServicesFile`). Separately,
  generate a **service account private key** (Firebase → Project settings →
  Service accounts) and upload it to EAS as the *FCM V1 service account key*.
  Both must belong to the same Firebase project or push silently fails.
- **Keep `google-services.json` out of the public repo.** It's client config, not
  a secret, and Expo's docs are relaxed about committing it — but this repo is
  public and privacy-first, and there's no upside. Store it as an **EAS file
  secret** (`GOOGLE_SERVICES_JSON`) and point `app.json` at the injected path.
- **Two different service-account keys, easily confused:** one for **FCM v1**
  (sending push) and, if we automate submission, another for the **Play Developer
  API** (`eas submit`). Different consoles, different purposes.
- **Notification channels.** Android 8+ requires them; without an explicit one,
  everything lands in a generic "Default" channel that the user can only mute
  wholesale. Create channels with `Notifications.setNotificationChannelAsync` at
  launch (before any push can arrive), **mirroring the Phase 8 per-type
  preference groups** — so the in-app preference and the OS channel tell the same
  story rather than fighting. Messages get their own channel (higher importance,
  it's the one thing people want to interrupt them). **Channel settings are
  immutable after creation** — once a user has it, changing importance in code
  does nothing; you'd need a new channel id. So get the ids and importances right
  first time.
- **Android 13+ runtime notification permission.** `POST_NOTIFICATIONS` is a
  runtime prompt now. `registerForPush()` in `mobile/src/push.ts` already asks via
  `requestPermissionsAsync` and treats refusal as normal, so this should work
  unchanged — but it needs verifying, and the prompt's *timing* on Android
  (currently on sign-in) should be checked against how it reads on first launch.
- **The notification icon.** Android draws the status-bar icon as a **monochrome
  silhouette**; hand it a colour icon and you get a grey blob. The
  `expo-notifications` plugin takes `icon` and `color` — we already have
  `assets/images/android-icon-monochrome.png` from the adaptive icon work, which
  is likely reusable. This is a visible-quality item, not cosmetic pedantry: it's
  on every single notification.
- **Verify the message Reply action.** `MESSAGE_CATEGORY` / `REPLY_ACTION` in
  `push.ts` gives iOS an inline reply field on a message push. Expo's
  notification categories are supported on Android too, but the options differ —
  confirm reply-from-the-shade actually works, and if it doesn't, degrade
  gracefully rather than shipping a dead button.
- Nothing changes on the **backend**: `DevicePushToken.platform` already exists,
  and `api.ts` already sends `Platform.OS`, so an Android token registers as
  `"android"` today with no code change. The whole Expo transport
  (`PushOutbox` → Expo → APNs/FCM) is platform-agnostic by design.

### The back button

Android's hardware/gesture back has no iOS equivalent, and this is where a
cross-platform app usually feels broken. Expo Router handles back for *stack
navigation* automatically. The work is everything that isn't a stack push —
**nine `<Modal>` components** currently in `src/components/`:

`PhotoLightbox`, `ReportModal`, `MessageActionMenu`, `AvatarCropModal`,
`DisconnectWarningModal`, `ReactionTray`, `ReactorsSheet`,
`DeleteAccountSection`'s confirm, and the popover inside `MessageThreadView`.

RN's `Modal` has an `onRequestClose` prop that Android's back button fires —
each of these needs it wired, or back either does nothing (feels frozen) or
escapes the whole screen underneath the open modal. Plus non-modal transient
state that should absorb a back press: **message multi-select mode** and the
emoji tray. And the root case: back on the feed tab should **exit the app**, not
bounce between tabs.

`app.json` currently sets `predictiveBackGestureEnabled: false` — fine to keep
for v1; revisit once the modals are behaving, since predictive back is
increasingly the platform default.

### Date and time pickers (a known, already-documented gap)

`src/components/events/DimensionEditor.tsx` carries this comment, written during
Phase 8b:

> *iOS renders the spinner inline and persistently, which is what this layout
> assumes. Android's picker is a one-shot modal dialog: an always-mounted
> instance shows once and won't reopen after dismissal, so Phase 10 (Android)
> will need a `show` state + remount around this. iOS-only for now.*

That's two components (`DimensionEditor` and `PollOptionFields`) and it affects
**event planning and every date/time poll** — the most Android-broken feature in
the app today. It needs a `show`-state wrapper, handling `event.type ===
'dismissed'`, and the `display="spinner"` / `themeVariant` props are iOS-shaped
and should become platform-conditional.

### Layout and visual polish

- **Edge-to-edge is mandatory** on modern Android under Expo SDK 54+: the status
  and navigation bars draw *over* the app. Every screen needs its safe-area
  insets checked, especially the message composer sitting above the gesture bar.
- **Shadows don't cross over.** 15 `shadow*` style usages against only 5
  `elevation` — iOS shadow props render nothing on Android. Each needs an
  `elevation` counterpart or the depth cues just vanish.
- **`BlurView`** (`MessageThreadView`, the composer backdrop) is expensive and
  visually different on Android; check `experimentalBlurMethod` or fall back to a
  solid translucent surface.
- **Keyboard avoidance:** nine screens pass `behavior={Platform.OS === 'ios' ?
  'padding' : undefined}`, i.e. Android relies entirely on `adjustResize`. That's
  the correct default, but it's never actually been *looked at* on Android — the
  message composer and the login screen most of all.
- **Action sheets already have Android fallbacks** (four `ActionSheetIOS` sites
  fall back to `Alert.alert`), one of which is explicitly commented "Phase 10
  refines this". They work; they just look like a stack of alert buttons. Worth a
  pass to see whether they're good enough or want a proper bottom sheet.
- **Fonts** — the system font is Roboto, not SF. The timeline spine geometry
  derives from constants (`SPINE_COLUMN`, `SPINE_CENTRE`) so it should hold, but
  line heights and the day dividers want eyes on them.
- **Ripple feedback** — Android users expect `android_ripple` on pressables.
- Narrow the **camera permission**: `app.json` currently sets
  `cameraPermission` on `expo-image-picker`, which adds `CAMERA` to the manifest.
  If we only ever open the photo library, drop it — an unexplained permission on
  a privacy-first app's Play listing is a bad look (`mobile-app.md` already makes
  this argument about the microphone).

### Dev-loop gotcha

`localhost` does not reach the host from an Android emulator — it's `10.0.2.2`,
or a LAN IP. Already documented in `mobile-app.md`; it will bite anyway.

---

## 3. Milestones

**A. Emulator + toolchain.** Android Studio, an AVD on a **Google Play** system
image, `npx expo run:android` / dev build launching. Log in, feed, compose,
profiles work. Fix whatever's outright broken.

**B. Both platforms tested.** `jest-expo` multi-project config so the suite runs
under `Platform.OS === 'android'` as well as iOS; CI updated. Do this *before*
the fixing milestones so the Android branches are covered as we write them.

**C. Push on Android.** Firebase project, `google-services.json` via EAS secret,
FCM v1 service account on EAS, notification channels mapped to the Phase 8
preference groups, monochrome notification icon, runtime permission verified. A
real notification lands on the emulator, respects per-type prefs, and deep-links
in. Verify cold-start taps (force-quit first) and the message Reply action.

**D. Android polish.** Back button across all nine modals + multi-select, the
date/time pickers, edge-to-edge safe areas, elevation, blur, keyboard, ripple,
permission narrowing. Full parity pass over every feature.

**E. Distribution.** Play Console account + identity verification (**start this
at the beginning of the phase**, it's the long pole), app record, first AAB
uploaded manually, internal testing track, tester list, opt-in links out. Plus an
`eas build --profile preview` APK path documented for the pre-Play loop.

**F. Docs.** Extend `mobile-release.md` with the Android half of the runbook
(build, submit, tester management, keystore backup) and fold the phase into
`reference/mobile-app.md`, then delete this file — per the repo's convention.

---

## 4. Definition of done

- [ ] App builds and runs on the Android Emulator (Google Play system image).
- [ ] Full feature parity on Android — feed, compose, post detail, profiles,
      connections, messaging (including photos, reactions, replies, mentions,
      multi-select), groups, events + calendar, reactions, activity centre,
      settings, report/block.
- [ ] **Push works on Android** via FCM: respects Phase 8 per-type preferences,
      deep-links in (warm *and* cold start), uses notification channels mapped to
      the preference groups, and shows a proper monochrome status-bar icon.
- [ ] Back button behaves correctly in every modal, in multi-select, and at the
      root; no dead-end or app-exiting surprises.
- [ ] Date/time pickers work on Android (event planning + date/time polls).
- [ ] Edge-to-edge safe areas, elevation, keyboard avoidance and press feedback
      pass a full-app visual review.
- [ ] Jest suite runs on **both** platforms in CI and is green.
- [ ] **Play internal testing** working end-to-end: a tester installs from the
      Play Store via an opt-in link and receives a push.
- [ ] Upload keystore backed up outside EAS.
- [ ] `mobile-release.md` covers the Android release; `reference/mobile-app.md`
      updated; this phase file deleted.
- [ ] _Stretch:_ verified on a real Android device beyond the emulator.

---

## 5. Costs

- **Google Play Console: $25, one-time.** Needed only for Play distribution —
  the emulator and the EAS APK path work without it.
- No annual fee (unlike Apple's $99/yr). Android Studio, the emulator, Firebase
  FCM and Expo push are free. EAS free-tier build queues are slow at peak but
  adequate.

---

## 6. Open questions

- **Notification-channel granularity** — one channel per Phase 8 kind, or one per
  *preference group*? Default: mirror the preference groups, so the OS and the
  in-app settings agree. Decide before shipping to anyone, since channels are
  immutable once created on a device.
- **Do the `Alert.alert` action-sheet fallbacks stay?** Decide after seeing them
  on a real Android screen, not before.
- **Does the message Reply action work from the Android shade?** If not, do we
  build it another way or drop it on Android?
- Whether to keep `predictiveBackGestureEnabled: false` past v1.

---

## 7. Notes / decisions log

(Record deviations and gotchas here as we build.)
