# Phase 10 — Android App

**Status:** not started — **plan ready, refine at kickoff**

Because Phase 9 builds in **React Native (Expo)**, the app is *already*
cross-platform — this phase is **not a second app**. It is Android-specific
polish, push wiring, and distribution on top of the same codebase. Keep this doc
short deliberately; most "how" lives in Phase 9.

## Costs to be aware of (before starting)

- **Google Play Console — $25 one-time (required only for Play Store
  distribution).** Not needed to build, run, or test: the Android Emulator
  (bundled with Android Studio, free) and Expo Go on a real Android device both
  work without it. Pay it only when you're ready for Play Store internal/closed
  testing.
- No per-year fee (unlike Apple's $99/yr in Phase 9). Everything else — Android
  Studio, the emulator, Expo, FCM push via Expo — is free.

## Goal

Bring the Phase 9 app to Android: builds and runs on the Android Emulator, all
features work, **push notifications** work via **FCM** (through Expo), and it's
distributable via Play Store internal/closed testing. Like Phase 9, it runs
against the home-server beta (Phase 7), before the AWS migration (Phase 11).

## Decisions locked

- **Emulator-only development; real Android device deferred.** The maintainer has
  no Android phone. All daily development and testing happen on the **Android
  Emulator** (Android Studio, free, arm64 image on Apple Silicon — genuinely
  fast). A real-device pass is an **optional stretch**, not a gate: rely on Play
  Store **internal testers' own devices** to surface real-hardware issues. This
  removes the "borrow a phone" dependency from the definition of done.
  - Note: push (FCM) **can** be tested on the emulator, provided the AVD uses a
    **Google Play** system image (not plain AOSP) — pick that image when creating
    the virtual device.

## What's actually Android-specific (the real work)

Most screens come free from Phase 9. Budget effort for:

- **Toolchain:** install **Android Studio**, create an AVD with a Google Play
  image, wire Expo to launch it.
- **Push via FCM:** Expo Push already fans out to FCM, but Android needs an
  **FCM project + credentials** registered with Expo (the Android analogue of
  APNs setup). The backend `DevicePushToken` model from Phase 9 already carries a
  `platform` field, so no data-model change — just register Android tokens.
- **Android UX conventions:** hardware/gesture **back button**, notification
  **channels** (Android groups notifications by channel — map them to the Phase 8
  notification kinds / per-type prefs), status-bar and safe-area handling, ripple
  vs. iOS press feedback.
- **Layout/behaviour bugs** that only show on Android (fonts, keyboard avoidance,
  image picker permissions, date formatting).

## Milestones

**A. Runs on the emulator.** Android Studio + AVD (Google Play image); the Phase 9
app builds and runs; log in, feed, compose, profiles all work. 
**B. Push on Android.** FCM credentials in Expo; a Phase 8 event lands in the
Android notification centre via a Google-Play-image emulator, respects per-type
prefs, deep-links in; notification channels mapped.
**C. Android polish.** Back-button, safe areas, permissions, and any
Android-only layout bugs fixed across the full (parity) feature set.
**D. Distribution.** EAS build → **Play Store internal testing**; testers install
on their own devices; sign-ups stay admin-approved.

## Definition of done

- [ ] App builds and runs on the Android Emulator (Google Play image).
- [ ] Full feature parity works on Android (same set as Phase 9 — feed, compose,
      post detail, profiles, connections, messaging, groups, reactions, activity
      centre, settings, report/block).
- [ ] **Push notifications** work on Android (FCM via Expo), respect the Phase 8
      per-type preferences, deep-link into the app, and use notification channels.
- [ ] Android-specific UI/behaviour issues (back button, safe areas, permissions)
      resolved.
- [ ] Real tests still green on the shared codebase (Android build included in CI
      where practical).
- [ ] **Play Store internal/closed testing** path documented and working; beta
      stays invite-only / admin-approved.
- [ ] _Stretch (optional):_ verified on a real Android device.

## Open questions still to resolve (at kickoff)

- How much Android-specific work is *actually* left after Phase 9? (Re-scope A–C
  once Phase 9 ships — this plan assumes "some polish," not a rewrite.)
- FCM credential setup specifics with Expo (current EAS flow at the time).
- Notification-channel granularity: one channel per Phase 8 kind, or a few
  grouped channels? (Default: mirror the per-type preference groups.)

## Notes / decisions log

(Record deviations/gotchas here as we build.)
