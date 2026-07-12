# Phase 9 — iPhone App

**Status:** not started — sketch only, refine before starting

## Goal

A native-feeling iOS app that talks to the **same Django backend** as the web
app. Because the web frontend is React, the leading candidate is **React Native
(via Expo)**, which reuses the most knowledge and lets one codebase target both
iOS and Android (Android is Phase 10).

**This phase runs on the home-server beta (Phase 7), before the AWS migration
(Phase 11) — a deliberate reordering.** The app is just another client of the
same JSON API, so its only real dependency is a stable, publicly-reachable HTTPS
backend, which the home server already provides at `https://your-timeline.net`.
The point of building the apps *before* paying for cloud hosting is to prove that
people will actually use TimeLine once they can download it — and only then let
that demand justify the always-on AWS spend (see the "Why this order" note in
`docs/SHARED.md`). When Phase 11 later moves the backend to AWS, the URL stays
the same, so the app needs no change.

**Push notifications are a first-class goal of this phase** — they're the main
reason for going native over an installable web app (a PWA can't reliably do iOS
push). This phase adds the *delivery channel* (registering the device with
Apple's APNs, via Expo's push service) on top of the notification **system**
built in Phase 8 (event types, the activity centre, per-type preferences). Phase
8 already decided *what* gets notified and stores it; this phase gets those
events to land in the phone's notification centre.

## Runnable product at the end of this phase

An iPhone app (running in the iOS Simulator, and ideally on a real device via
Expo) that can log in, view the reverse-chronological feed, post, and **receive
push notifications** — hitting the home-server backend (or a staging copy).

## Likely definition of done (refine when we start)

- [ ] React Native (Expo) project set up
- [ ] Log in / log out against the real backend
- [ ] Feed screen (reverse-chronological) and compose screen
- [ ] **Push notifications**: device registers for APNs (via Expo), a test event
      from Phase 8 lands in the iOS notification centre, tapping it deep-links
      into the app, and the in-app activity centre stays in sync
- [ ] Respects the Phase 8 per-type notification preferences (no push for a type
      the user has muted)
- [ ] Runs in the iOS Simulator; ideally on a real device via Expo Go
- [ ] A documented path toward TestFlight for real testers (keeps the beta
      invite-only; sign-ups stay admin-approved)

## Open questions to resolve before starting

- Confirm React Native/Expo vs. any alternative (e.g. PWA / native Swift).
- Apple Developer Program enrolment ($99/yr) is required for TestFlight/App
  Store — note the cost and timing (ties into the funding phase).
- **API auth flow on mobile.** The web app carries its JWT in an httpOnly cookie;
  native apps conventionally store the token and send it as an `Authorization:
  Bearer` header. The backend is already token-based (simplejwt), so this is
  *accepting the token a second way + returning it in the login response body for
  mobile clients*, not a rewrite — confirm and implement the mobile flow.
- Apple's review will want a **demo account** and working **report / block /
  moderation** (all built in Phase 7) — confirm the app surfaces them.

## Notes / decisions log

(Record deviations/gotchas here.)
