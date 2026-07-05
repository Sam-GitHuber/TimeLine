# Phase 8 — iPhone App

**Status:** not started — sketch only, refine before starting

## Goal

A native-feeling iOS app that talks to the **same Django backend** as the web
app. Because the web frontend is React, the leading candidate is **React Native
(via Expo)**, which reuses the most knowledge and lets one codebase target both
iOS and Android (Android is Phase 9).

This phase depends on the backend being stable and deployed on AWS (Phase 7b) —
the app is just another client of the same API.

## Runnable product at the end of this phase

An iPhone app (running in the iOS Simulator, and ideally on a real device via
Expo) that can log in, view the reverse-chronological feed, and post — hitting
the production or a staging backend.

## Likely definition of done (refine when we start)

- [ ] React Native (Expo) project set up
- [ ] Log in / log out against the real backend
- [ ] Feed screen (reverse-chronological) and compose screen
- [ ] Runs in the iOS Simulator; ideally on a real device via Expo Go
- [ ] A documented path toward TestFlight for real testers

## Open questions to resolve before starting

- Confirm React Native/Expo vs. any alternative (e.g. PWA / native Swift).
- Apple Developer Program enrolment ($99/yr) is required for TestFlight/App
  Store — note the cost and timing (ties into the funding phase).
- Which API auth flow works cleanly on mobile (tokens vs. cookies)?

## Notes / decisions log

(Record deviations/gotchas here.)
