# Phase 10 — Android App

**Status:** not started — sketch only, refine before starting

## Goal

Bring TimeLine to Android. If Phase 9 used **React Native (Expo)**, most of the
app is already cross-platform, so this phase is largely about Android-specific
polish, testing, and distribution rather than a rewrite. Like Phase 9, it runs
against the home-server beta (Phase 7), before the AWS migration (Phase 11).

## Runnable product at the end of this phase

The app running on an Android emulator (and ideally a real device), able to log
in, view the reverse-chronological feed, post, and **receive push
notifications** against the real backend.

## Likely definition of done (refine when we start)

- [ ] App builds and runs on an Android emulator
- [ ] Log in, feed, and compose all work on Android
- [ ] **Push notifications** work on Android (FCM via Expo), respecting the
      Phase 8 per-type preferences and deep-linking into the app
- [ ] Android-specific UI/behaviour issues resolved
- [ ] Runs on a real Android device
- [ ] A documented path toward Play Store internal/closed testing (keeps the
      beta invite-only; sign-ups stay admin-approved)

## Open questions to resolve before starting

- How much Android-specific work is actually left after Phase 9?
- Google Play Console has a one-time $25 registration fee — note cost/timing.
- FCM setup specifics for Android push (vs. APNs on iOS) via Expo.

## Notes / decisions log

(Record deviations/gotchas here.)
