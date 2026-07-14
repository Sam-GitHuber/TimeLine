# Phase 9 — iPhone App

**Status:** not started — **plan ready, refine at kickoff**

This is a full execution plan, not a sketch. The two scope decisions that were
open are now locked (see **Decisions locked** below). Re-confirm the "Open
questions still to resolve" list at kickoff, then work the milestones in order.

## Costs to be aware of (before starting)

- **Apple Developer Program — $99/yr (required).** Needed to run on a real device
  beyond the 7-day free limit, to test **push notifications** (the whole point of
  going native — iOS push cannot be tested in the Simulator), and to distribute
  via TestFlight. The user has agreed to this cost. Enrol at the start of the
  phase, not the end — push work (Milestone D) is blocked until it's active.
- Everything else in this phase is free: Expo, the iOS Simulator (bundled with
  Xcode), and testing on the maintainer's own iPhone via Expo Go / a dev build.

_(Android's separate one-time $25 Google Play fee is a Phase 10 concern — see
`phase-10-android-app.md`.)_

## Goal

A native-feeling iOS app that talks to the **same Django backend** as the web
app, built with **React Native (via Expo)** so one codebase targets both iOS and
Android (Android is Phase 10, which is then mostly polish + distribution).

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
events to land in the phone's notification centre. Today notification delivery is
**12s polling** (`NOTIFICATIONS_POLL_MS`, see
[`../reference/notifications.md`](../reference/notifications.md)); push is an
*additional* channel, not a replacement — the poll stays as the in-app fallback.

## Decisions locked

- **React Native + Expo, with Expo Router.** Expo Router is file-based routing
  that mirrors `react-router-dom` on the web, so the mental model carries over.
  Confirmed over PWA (no reliable iOS push) and native Swift (would not share
  with Android).
- **Full feature parity for v1.** The first shippable app mirrors everything the
  web app does — feed, photos, profiles, connections, comments, messaging,
  groups, reactions, notifications, push — before it goes to any tester. Rationale
  from the user: no feature should feel "missing" versus the website. This makes
  the phase larger; the milestones below are ordered so there is always a
  runnable, demoable app, and so the auth + push spine lands early.
- **Bearer-token auth on mobile** (see "Backend change" below).
- **Dev on Simulator + Emulator; real iPhone via a dev build for push.**

## Backend change — mobile auth flow (do this first, Milestone A)

The web app carries its JWT in an **httpOnly cookie** with CSRF protection (see
[`../reference/accounts.md`](../reference/accounts.md)). That is right for a
browser but wrong for a native app: there is no cookie jar / CSRF story we want to
lean on, and the token needs to be read and attached deliberately. Native apps
conventionally send `Authorization: Bearer <access-token>`.

The backend already issues JWTs via `simplejwt`, so this is **accepting the token
a second way**, not a rewrite:

1. **Login returns the token in the response body for mobile clients.** Stock
   dj-rest-auth already puts the access token in the login response body (the web
   app just ignores it in favour of the cookie). Confirm it's there; the mobile
   client reads it from the body instead of relying on the cookie.
2. **Add `JWTAuthentication` (Bearer header) to DRF's authentication classes**,
   alongside the existing cookie-JWT class. DRF tries each in turn, so web
   (cookie) and mobile (Bearer) both authenticate with no per-view changes.
   Because Bearer requests carry no cookie, `JWT_AUTH_COOKIE_USE_CSRF` does not
   apply to them — CSRF is a cookie-session concern, so mobile skips it cleanly.
3. **Token storage on device:** store the access token in **`expo-secure-store`**
   (Keychain-backed), never `AsyncStorage`. Attach it in a single fetch/axios
   wrapper.
4. **Refresh:** access-token lifetime is 1 day and there is no silent refresh yet
   (see accounts.md). For v1, on a `401` clear the token and route to login
   (same "you were logged out" UX the web has). Add refresh-token rotation later
   if the 1-day expiry annoys testers — note it, don't build it now.
5. **Tests:** add a backend test asserting a `Bearer` token authenticates a
   protected endpoint and a bad/expired one 401s. (Every phase ships real tests —
   see the project memory.)

This change is small and backend-only; keep it in its own PR so the app work
rebases on a stable API.

## Screen inventory (full parity) → where each feature is specced

Build these as Expo Router routes. Each maps to an existing web feature; **read
the linked reference doc before building the screen** — it has the data model,
endpoints, and visibility rules. Reuse the same API endpoints the web frontend
calls (see `frontend/src/api.js`).

| Screen / area | Reference doc | Notes for mobile |
|---|---|---|
| Login / logout | [accounts.md](../reference/accounts.md) | Bearer flow above. Sign-up screen too (stays admin-approved → show "await approval" state). |
| Feed (reverse-chron) | [feed-and-posts.md](../reference/feed-and-posts.md) | `FlatList`, infinite scroll, pull-to-refresh. **Never re-order** — chronological only. |
| Compose post (text + photo) | [feed-and-posts.md](../reference/feed-and-posts.md) | `expo-image-picker` for the photo; multipart upload to the same endpoint. |
| Post detail: comments + reactions | [feed-and-posts.md](../reference/feed-and-posts.md), [reactions.md](../reference/reactions.md) | Pruned comment trees; emoji reaction picker. |
| Profiles (own + others), edit, avatar | [accounts.md](../reference/accounts.md) | Numeric profile URLs → route params. Edit-profile separate from account settings (mirrors web). |
| Connections / People / requests | [connections.md](../reference/connections.md) | Symmetric graph; request / accept / decline. **This doc owns visibility rules** — messaging/groups/feed all defer to it. |
| Messaging (DM + group threads) | [messaging.md](../reference/messaging.md) | Own unread badge (not in the activity centre). Polling today; push lands new-message alerts. |
| Groups (list, detail, invites) | [groups.md](../reference/groups.md) | Invites surface in the activity centre. |
| Reactions | [reactions.md](../reference/reactions.md) | Shared component used by posts + comments. |
| Activity centre (notifications) | [notifications.md](../reference/notifications.md) | The bell/history. Three states (created → seen → addressed). Push deep-links into the target here. |
| Settings: per-type notification prefs, account, ToS/privacy, **account deletion** | [accounts.md](../reference/accounts.md), [notifications.md](../reference/notifications.md) | Deletion + ToS/privacy already exist server-side (Phase 7/8) — surface them; App Review checks for account deletion. |
| **Report / block / moderation** | Phase 7 (deploy/moderation) | Must be reachable from posts/profiles — **App Review requires working report + block** for any social app. |

Design language: follow [`../design-system.md`](../design-system.md) (the
warm-modern "living line" look). Tokens don't cross to React Native automatically
— translate the palette/spacing into an RN theme object once, then reuse. Aim for
*native-feeling*, not a pixel copy of the web (native nav patterns, system fonts
where it reads better).

## Push notifications — design

- **Expo Push** abstracts APNs (and FCM on Android) behind one service: the app
  registers and gets an **Expo push token**; the backend sends to Expo; Expo
  fans out to Apple. Avoids talking to APNs directly.
- **New model, `DevicePushToken`** (backend): `user` FK, `expo_token`,
  `platform`, `created_at`, `last_seen`. Endpoint to register/refresh on login and
  to delete on logout. One user can have several devices.
- **Sending:** where Phase 8 already *creates* a `Notification` row, also enqueue
  an Expo push to that user's device tokens — **gated by the same per-type
  `NotificationPreference`** (a muted type sends no push). Do the send out-of-band
  so a push failure never blocks the request; a management command / lightweight
  task is fine at this scale (no Celery yet — see SHARED.md "add later").
- **Payload → deep link:** the `NotificationSerializer` is already push-ready
  (`kind` + one target FK). Map `kind` to an Expo Router path so tapping opens the
  right post/comment/group/connection and marks it seen, keeping the in-app
  activity centre in sync.
- **Constraint:** iOS push needs a **real device + Apple Developer Program** — it
  cannot be tested in the Simulator. Plan a real-device pass for Milestone D.

## Milestones (each ends with something runnable)

**A. Backend mobile-auth PR.** Bearer auth + login-body token + `DevicePushToken`
model/endpoints + tests. No app code. Ends: web app still green; `curl` with a
Bearer token hits a protected endpoint.

**B. Expo project spine.** Create the Expo Router app, secure-store token,
fetch wrapper, login/logout, and a "who am I" gate. Point it at
`https://your-timeline.net`. Ends: log in on the iOS Simulator and see your
identity; runs on the maintainer's iPhone via Expo Go.

**C. Read + write core.** Feed, post detail (comments + reactions), compose with
photo, profiles. Ends: you can scroll, open, react, comment, and post from the
Simulator against the real backend.

**D. Push notifications.** Apple Developer enrolment, dev build (not Expo Go —
push needs a real build), device registration, backend send + preference gating,
deep-link handling. Ends: a Phase 8 event lands in the iPhone's notification
centre, tapping it opens the target, activity centre stays in sync, a muted type
sends nothing.

**E. Parity fill-in.** Connections/People, messaging (DM + group), groups +
invites, settings (notification prefs, account, account deletion), ToS/privacy,
and the report/block surfaces. Ends: no web feature is missing from the app.

**F. Distribution.** Build with EAS, upload to **TestFlight**, add real testers.
Ends: friends/family install via TestFlight; sign-ups remain admin-approved.

## Definition of done

- [ ] Backend accepts `Authorization: Bearer` alongside the cookie-JWT (web
      unaffected), login returns the token in the body, tests cover both, PR merged.
- [ ] Expo (Expo Router) app logs in/out against the real backend, token in
      `expo-secure-store`, 401 → re-login.
- [ ] **Full parity**: feed, compose (text+photo), post detail with comments +
      reactions, profiles (view/edit/avatar), connections/requests, messaging (DM
      + group), groups + invites, activity centre, settings (per-type notification
      prefs + account deletion), ToS/privacy, and **working report + block**.
- [ ] **Push notifications**: device registers for APNs via Expo, a Phase 8 event
      lands in the iOS notification centre, tapping it deep-links to the target and
      syncs the in-app activity centre, and a muted per-type preference suppresses
      the push.
- [ ] Runs in the iOS Simulator and on a real iPhone via a dev build.
- [ ] Follows the design system (translated RN theme), native-feeling nav.
- [ ] Real tests for the app's critical paths (auth flow, feed render, compose) —
      every phase ships tests.
- [ ] **TestFlight** path documented and working; a **demo account** exists for
      App Review; beta stays invite-only / admin-approved.

## Open questions still to resolve (at kickoff)

- **Refresh tokens:** ship v1 with 1-day access token + re-login on 401, or add
  refresh rotation now? (Default: defer, note it.)
- **Expo Go vs dev build for daily work:** Expo Go is fastest for A–C, but push
  (D) needs a dev/EAS build — decide when to switch.
- **Offline behaviour:** how much should work with no connection? (Default:
  online-only for v1; TanStack Query cache gives basic re-view.)
- App Review specifics: confirm the demo account + report/block flows are
  demonstrable end-to-end before submitting.

## Notes / decisions log

(Record deviations/gotchas here as we build.)
