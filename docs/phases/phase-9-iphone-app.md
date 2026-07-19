# Phase 9 — iPhone App

**Status:** in progress — **Milestone A done** (PR #91), **Milestone B done**
(PR #97: Expo spine — auth, token storage, silent refresh, login/logout, CI).
**Milestone C in progress**, split one PR per screen area as the PR strategy
below calls for:

- **C1 — feed.** Done: reverse-chronological list, day dividers, the timeline
  spine, photos, reaction counts, infinite scroll, pull-to-refresh.
- **C2 — compose.** Done: the pulsing "now" tip capping the line, your avatar on
  the spine, text + photo posting. *Brought forward ahead of post detail* — the
  live tip caps the timeline, so without it the feed looks cut off at the top
  rather than open-ended at the present.
- **C3 — post detail.** Done: the `/post/[postId]` permalink, the pruned comment
  tree with collapsible replies, writing comments and replies, and reactions made
  interactive on posts *and* comments (plus "who reacted"). Deep-link support
  (`?comment=`) is built now rather than in D, since the route exists to be
  opened by a notification.
- **C4 — profiles** (view / edit / avatar). Next.

This is a full execution plan. All scope decisions are locked (see **Decisions
locked** below); the questions that were open at kickoff have been resolved and
folded into the plan. Do the **Prerequisite** below on day one, then work the
milestones in order.

## Prerequisite — enrol in the Apple Developer Program *before* Milestone A

Enrolment is **not instant** — approval commonly takes 24–48 hours and can run
longer if Apple asks for identity verification. It hard-blocks Milestone D (push
cannot be tested without it) and Milestone F (TestFlight).

Start the enrolment **on day one**, before writing any code, so the wait overlaps
with Milestones A–C instead of stalling the phase at D. It is not a milestone
because there is nothing to build — it is a form to submit and then forget about
until D.

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
- **One `mobile/` folder at the repo root** — not `apps/ios` + `apps/android`,
  and no shared web/mobile package. See **Repo layout** below for the reasoning.
- **Refresh-token rotation ships in Milestone A** (changed from the earlier
  "defer" default). A phone app is expected to stay logged in indefinitely, and a
  logged-out app receives **no push notifications** — which would undercut the
  main goal of the phase. `simplejwt` has rotation built in, so this is
  configuration plus a refresh call in the fetch wrapper, done once while we're
  already in the auth code rather than retrofitted mid-phase.
- **Tests: Jest + React Native Testing Library, unit + component only.** Mirrors
  the web app's Vitest + RTL approach, so the mental model carries over and CI
  stays fast. **No Maestro/Detox E2E** — a second tool, simulator infrastructure
  in CI, and a well-known flakiness tax that isn't worth it at this scale.
- **Online-only for v1.** No offline mode; TanStack Query's cache gives basic
  re-view of already-fetched screens and that's enough. Revisit only if testers
  complain.
- **Expo Go for Milestones B–C, dev build from D onward.** Expo Go is the fastest
  loop while there's no native module to worry about; push notifications require a
  real dev build, so D is the switching point. Don't switch earlier "to be safe" —
  the slower rebuild cycle isn't worth paying before it's needed.

## Repo layout

**Decision: one `mobile/` folder at the repo root, sibling to `backend/` and
`frontend/`.**

```
TimeLine/
├── backend/          # Django + DRF — serves all three clients
├── frontend/         # React + Vite web app (JavaScript)
├── mobile/           # ← this phase: Expo app, iOS + Android from one source
│   ├── src/
│   │   ├── app/         # Expo Router routes (file-based)
│   │   ├── api.ts       # fetch wrapper — Bearer token, not cookies
│   │   ├── auth.tsx     # AuthProvider: who is logged in
│   │   ├── tokens.ts    # expo-secure-store wrapper
│   │   ├── types.ts     # hand-written types for the API's JSON
│   │   ├── components/  # RN components (View/Text, not div/span)
│   │   └── theme.ts     # design tokens translated from the Tailwind @theme
│   ├── app.json
│   └── package.json  # its own deps; does NOT merge with frontend's
└── docs/
```

Two corrections to the original sketch, both settled in Milestone B: **the app is
TypeScript** (see the decisions log), and **routes live in `src/app/`, not a
top-level `app/`** — that's where the current Expo template puts them, and
fighting the template's default buys nothing.

**Why not `apps/ios/` + `apps/android/`.** That layout is for two separately
written native apps (Swift + Kotlin). We chose React Native precisely so there is
*one* codebase; Phase 10 (Android) adds no new screens, only FCM credentials,
back-button handling, notification channels, and layout fixes — all edits inside
`mobile/`. Two folders would imply a split that doesn't exist.

Expo *does* generate `mobile/ios/` and `mobile/android/` subfolders (the real
Xcode/Gradle projects), but in the managed workflow those are **generated and
gitignored** — recreated by `npx expo prebuild` or on EAS's build servers, never
hand-edited. They exist on disk without being part of the source.

**Why no shared web/mobile package.** iOS and Android share ~95% of the mobile
code — that's the whole point of Expo, and it comes free. **Web and mobile share
far less than it first appears:** the web app's components are built on `<div>`,
`<button>`, and Tailwind classes, none of which exist in React Native. `PostCard`
gets rewritten, not imported. What could genuinely be shared is `utils.js`,
`postCache.js`, some query hooks, and the design tokens — roughly **1–1.5k lines
out of an 11k-line web app** — and `api.js` only partially, since the auth layer
differs (cookie + CSRF vs Bearer).

Extracting that into a workspace package would mean npm workspaces, a build step,
and Metro bundler configuration: real, permanent complexity for two consumers and
~1k shared lines. That's the "clever over boring" trade `docs/SHARED.md` tells us
to avoid. **So: copy `utils.js` and the token values into `mobile/`, write
`mobile/src/api.js` fresh for Bearer auth.** The genuinely shared layer is the
JSON API itself — that's where the logic that matters already lives. Revisit
extraction only if the same bug gets fixed twice in two places.

**Note:** once `mobile/` exists, the name `frontend/` is arguably misleading —
there are then two frontends. Renaming it to `web/` would touch Docker Compose,
both CI workflows, the deploy scripts, and most docs. **Not worth the churn;
leave it.**

### Running the stack in development

Three processes instead of two:

```bash
docker compose up --build        # backend + db + web app, as today
cd mobile && npx expo start      # Metro bundler → press 'i' for iOS Simulator
```

The app defaults to `https://your-timeline.net` (the Phase 7 home server), which
is what we normally want to be testing against. Use a `mobile/.env` with
`EXPO_PUBLIC_API_URL` to aim at a local Django when debugging API work — see
`mobile/.env.example`.

**Correction to the original plan:** it claimed the iOS Simulator can't reach
`localhost:8000`. It can — the Simulator shares the host's network stack, so
`EXPO_PUBLIC_API_URL=http://localhost:8000` works fine and that's how Milestone B
was verified. The restriction is real for the **Android emulator** (which needs
`10.0.2.2` or a LAN IP) and for a **real device** (LAN IP) — so it'll matter
again in Phase 10 and at the Milestone D device pass.

### CI

Add a third job, `mobile-test`, to `.github/workflows/main.yml` alongside the
existing `backend` and `frontend` jobs: `npm ci` then `npm test` in `mobile/`.
Actual app *builds* happen on **EAS** (Expo's cloud build service), not in GitHub
Actions — don't try to build an IPA in CI.

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
4. **Refresh-token rotation — build it now.** Today `SIMPLE_JWT` is
   `ACCESS_TOKEN_LIFETIME` 1 day / `REFRESH_TOKEN_LIFETIME` 7 days with no silent
   refresh (`config/settings.py`), so a client is simply logged out when the
   access token expires. That's tolerable on the web and wrong on a phone: an app
   that logs you out weekly stops receiving **push notifications**, which defeats
   the phase.

   - Enable `ROTATE_REFRESH_TOKENS` and `BLACKLIST_AFTER_ROTATION`, and add
     `rest_framework_simplejwt.token_blacklist` to `INSTALLED_APPS` (it ships
     migrations — run them). Rotation means each refresh returns a *new* refresh
     token and invalidates the old one, so a stolen token has a short useful life.
   - **Lengthen `REFRESH_TOKEN_LIFETIME` to ~90 days** so the app stays logged in
     across normal use. **Leave `ACCESS_TOKEN_LIFETIME` at 1 day** — do *not*
     shorten it as a "security improvement" here: the web app has no refresh
     logic, so a shorter access token would start logging family members out of
     the website. Changing that is a separate, later piece of work.
   - Store **both** tokens in `expo-secure-store`. The fetch wrapper retries once
     through refresh on a `401`, then falls back to clearing tokens and routing to
     login. Guard against a refresh stampede — several parallel 401s must share
     one in-flight refresh, not fire five.
   - **On logout, blacklist the refresh token server-side.** Deleting it from the
     device only is not enough; a copy lifted from a backup would still work.
5. **Privacy/security note.** A Bearer token in `expo-secure-store` is
   Keychain-backed and does not leave the device, but unlike the web's httpOnly
   cookie it *is* readable by our own JS. Never log it, never put it in an error
   report, and never append it to a URL query string (URLs land in server logs).
6. **Tests:** a `Bearer` token authenticates a protected endpoint; a bad/expired
   one 401s; a refresh returns a new pair; a rotated-away refresh token is
   rejected; logout blacklists. (Every phase ships real tests.)

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
  (`kind` + one target FK). Map each `kind` to an Expo Router path so tapping
  opens the right target and marks it **addressed** (which implies seen), keeping
  the in-app activity centre in sync — the same click-through semantics the web
  dropdown already has (see [notifications.md](../reference/notifications.md)).

  All eleven kinds, with their target FK and destination route:

  | `kind` | Target FK | Route |
  |---|---|---|
  | `post_reply` | `post` | `/post/[postId]` |
  | `comment_reply` | `comment` | `/post/[postId]` → scroll to comment |
  | `reaction` | `post` *or* `comment` | `/post/[postId]` |
  | `connection_request` | `connection` | `/people` (requests) |
  | `connection_accepted` | `connection` | `/profile/[actorId]` |
  | `group_invite` | `group` | `/groups/invites` |
  | `event_created` | `event` | `/events/[eventId]` |
  | `poll_opened` | `event` | `/events/[eventId]` |
  | `event_scheduled` | `event` | `/events/[eventId]` |
  | `event_updated` | `event` | `/events/[eventId]` |
  | `event_cancelled` | `event` | `/events/[eventId]` |

  **Gap to check in Milestone D:** the `comment_reply` and comment-targeted
  `reaction` rows carry a `comment` FK, but the route needs the **parent post's
  id**. Confirm `NotificationSerializer` exposes it; if not, add it there rather
  than making the app fetch the comment first to find its post — one extra field
  beats a round-trip on every notification tap.

  Because all target FKs `CASCADE`, a notification never outlives its target, so
  there are **no dangling deep-links** to defend against. A tap on a
  notification for since-deleted content can't happen — the row is gone too.

- **Cold start vs. warm tap.** Handle both: a tap that *launches* the app
  (initial notification response) and one that arrives while it's foregrounded or
  backgrounded. These are different Expo APIs and the cold-start path is the one
  that's easy to miss and easy to get wrong — test it explicitly by force-quitting
  the app before sending.
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

**D. Push notifications.** Switch to a dev build (Expo Go can't do push), device
registration, backend send + preference gating, the deep-link map above, cold-start
handling. Requires the Apple Developer enrolment from the **Prerequisite** to be
live by now. Ends: a Phase 8 event lands in the iPhone's notification centre,
tapping it opens the target, activity centre stays in sync, a muted type sends
nothing.

**E. Parity fill-in.** The long tail — **budget roughly 40% of the phase here**.
It's four independent chunks, each its own PR, in this order (most-used first, so
if you pause the phase you've built the things people actually open):

- **E1. Connections / People.** Request, accept, decline, the symmetric graph.
  Gates real multi-user testing, so it comes first.
- **E2. Messaging.** DM + group threads, unread badge, 4s open-thread polling.
  The largest single chunk — the web app's `messaging.jsx` is its own module.
- **E3. Groups + events.** Group list/detail/invites, group timelines, and the
  Phase 8b event surfaces (event detail, RSVP, polls, calendar).
- **E4. Settings + safety.** Per-type notification prefs, account settings,
  account deletion, ToS/privacy, and **report + block**. Small in code, but
  **App Review will reject a social app without working report and block** —
  don't leave it to the end of E4.

Ends: no web feature is missing from the app.

**F. Distribution.** Build with EAS, upload to **TestFlight**, add real testers.
Ends: friends/family install via TestFlight; sign-ups remain admin-approved.

### PR strategy

Per the project's branching rule (branch + PR, never commit to `main`):

- **A lands alone, before any app code.** It changes how *every* request
  authenticates, so if the web app breaks there must be no ambiguity about why.
  Verify the web app is still green before opening B.
- **B lands alone too** — it's the scaffold everything else imports (routing,
  fetch wrapper, theme, token storage). Churning it underneath in-flight feature
  PRs would be painful.
- **C onward: one PR per screen area**, roughly the rows of the screen inventory.
  Keeps reviews readable and means a broken screen never blocks the others.
- **Add the `mobile-test` CI job in B**, not later, so every subsequent PR is
  covered from the start.

### Rough sizing

Measured against the web app (11,074 lines of non-test source, 4,670 of tests,
36 components, 15 pages), full parity puts `mobile/` in the same ballpark:
**~8–12k lines of source, ~2–3k of tests**, i.e. roughly doubling the repo's
source. On disk it adds ~1.5 GB of `node_modules` and build artifacts, all
gitignored; committed source growth is a few MB. This is the largest phase so
far by a clear margin — a direct consequence of the locked full-parity decision.

## Definition of done

- [ ] Backend accepts `Authorization: Bearer` alongside the cookie-JWT (web
      unaffected), login returns the token in the body, tests cover both, PR merged.
- [ ] **Refresh-token rotation works**: rotation + blacklist-after-rotation on,
      ~90-day refresh lifetime, the app silently refreshes on a `401` without the
      user noticing, logout blacklists server-side, and the **web app's login
      lifetime is unchanged**.
- [ ] Expo (Expo Router) app logs in/out against the real backend, both tokens in
      `expo-secure-store`, failed refresh → re-login.
- [ ] Lives in a single `mobile/` folder; no `apps/ios`/`apps/android` split, no
      shared web/mobile package; `mobile-test` job green in CI.
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
- [ ] Real tests for the app's critical paths (auth flow incl. refresh, feed
      render, compose) via **Jest + React Native Testing Library** — every phase
      ships tests.
- [ ] **TestFlight** path documented and working; a **demo account** exists for
      App Review; beta stays invite-only / admin-approved.

## Resolved at kickoff

The four questions that were open are now decided and folded into the plan above:

- **Refresh tokens** → build rotation now, in Milestone A (not deferred).
- **Expo Go vs dev build** → Expo Go for B–C, dev build from D.
- **Offline behaviour** → online-only for v1.
- **App Review** → the demo account and report/block flows are checklist items in
  Milestone F and E4 respectively, not open questions.

## Things to verify while building (not blockers)

- Does `NotificationSerializer` expose the parent post id for comment-targeted
  notifications? (Deep-link map above — check in D.)
- Confirm dj-rest-auth's login response actually contains the access token in the
  body, as expected in Milestone A step 1.
- How much genuinely-Android-specific work is left for Phase 10 — re-scope that
  plan once this one ships.

## Notes / decisions log

(Record deviations/gotchas here as we build.)

**2026-07-19 — the mobile feed layout deliberately diverges from the web's.**

The web puts the clock time in its own rail to the **left** of the spine, which
pushes the line about a third of the way into a phone screen and squeezes every
post into what's left. On mobile the spine now **hugs the left edge** with the
avatar beads on it, and the time sits **inline at the head of each entry**, just
before the author's name.

That returns ~48pt of a 390pt screen to the content on every line of every post
— a long post drops from five lines to three. The time is still the first thing
you read on an entry, so it keeps its role as the voice of the timeline; it just
no longer buys that with a permanent column.

**The two clients now differ here on purpose.** `timeline.tsx` owns the geometry
(`SPINE_COLUMN`, `SPINE_CENTRE`) and everything derives from it — post rows, the
compose box, the day dividers, and the permalink's comment thread, which indents
to line up with the post's own text column. A new row type must derive its
indent from those constants rather than hard-coding one, or it will drift.

Verified in the Simulator with a throwaway fixture-data route, since layout is
the one thing Jest genuinely cannot check.

**2026-07-19 — Milestone C3: the emoji picker doesn't cross to React Native.**

The web's full picker is `emoji-picker-element`, a **DOM web component**, so it
cannot run here at all. Two attempts:

**First cut (wrong, and worth recording why).** A bottom sheet with the four
quick reactions plus a text input, on the theory that the *system* emoji
keyboard could serve as the full picker with zero dependencies. The maintainer
rejected it on sight, correctly. The flaw is a platform fact I should have
checked first: **iOS has no way to open the keyboard in emoji mode** — no
`keyboardType`, no API. So the input opened the ABC keyboard and the user had to
know to tap 🙂 themselves. WhatsApp doesn't do this either; its `+` opens
WhatsApp's *own* emoji grid. "Use the system keyboard" was never the shape a
phone user expects.

**Shipped: an in-place tray, WhatsApp-style.** Tapping `+` opens a small
anchored row of the four positive quick reactions (kept positive on purpose),
whose own `+` opens a real emoji grid — **`rn-emoji-keyboard`**, agreed with the
user. Pure JS (no native module, so Expo Go and Jest are untouched), MIT, zero
runtime dependencies, and about **+200 KB** of bundle for the emoji data.
Verified it bundles under Metro with React 19 + the React Compiler, since its
last release (May 2024) predates both.

**Anchoring an in-place popover in RN** takes the same shape as the web's
portal, for the same reason: there is no portal and no `position: fixed`, so
`measureInWindow` the trigger and draw the tray at those window coordinates
inside a full-screen `Modal`. In-flow it would be clipped by the post's bounds
and painted over by later rows — the exact bug the web hit.

**Open state and measured position must be separate state.** Keying "is the tray
open" off the measurement means a tray that silently never appears if
`measureInWindow` doesn't call back — a dead button, and near-impossible to
reproduce. It opens first and refines position on measurement, degrading to a
centred tray rather than nothing.

Emoji **validation stays server-side only** (`api/emoji.py` — single grapheme,
length cap, per-target cap). A second copy of "what counts as an emoji" in JS
would drift from the one that actually decides.

Two smaller notes:

- **`formatRelativeTime` came back**, one PR after being deleted for being
  unused. That's the "port a helper when a screen needs it" rule working, not
  churn: C1 didn't need it (the rail shows an exact clock time), C3's comment
  timestamps do. `formatAbsoluteTime` stays out — it fills a *hover* tooltip on
  the web, and a phone has no hover.
- **`gcTime: 0` collects a hand-seeded cache entry immediately** when nothing is
  observing it, so a test that seeds `['feed']` and then asserts on it reads
  `undefined`. Assert on a query the screen actually subscribes to, and test
  cache fan-out directly against `postCache` instead.
- **The RNTL v14 async-`render` trap bit again**, this time hidden inside a
  helper: `{...render(...)}` spreads a *promise*, silently yielding nothing, and
  every later query fails with "`render` function has not been called". Await
  the render inside the helper.

**2026-07-19 — review of the C1+C2 PR, and the delayed fuse it found.**

**A native module's config plugin must go in `app.json`, not just
`package.json`.** `expo-image-picker` was installed and working, but never added
to the `plugins` array — so nothing injected `NSPhotoLibraryUsageDescription`
into `Info.plist`. It worked anyway because **Expo Go's prebuilt binary carries
every permission string**, which is exactly what makes this class of bug
dangerous: it would have surfaced at Milestone D, when we switch to a dev build,
as an app that dies the moment you tap "Add photos" — and as an App Review
rejection. Same shape as the `AuthedImage` media trap below: fine in the
development harness, broken in the real one. **When adding any Expo package,
check whether it ships a config plugin.**

Verify without a full build: `npx expo config --type introspect` prints the
resolved `Info.plist` / Android permissions.

The permissions are also narrowed deliberately — `cameraPermission: false` and
`microphonePermission: false`. The plugin adds *both* by default (plus Android's
`RECORD_AUDIO`), and we only ever open the photo library. Shipping an unexplained
microphone permission on a privacy-first app is a bad look, and Phase 10 would
have inherited it on the Play listing.

Three testing gotchas, all in the same family (the harness lies about what it
supports):

1. **RNTL v14 + fake timers needs `await act(async () => …)`.** A bare `act()`
   runs the timer but React never flushes the re-render, so the hook's value
   silently doesn't change and the failure looks exactly like a broken hook.
2. **`UNSAFE_getByType` is gone in v14**, and **`FlatList` doesn't virtualise
   under test**, so `fireEvent.scroll` never triggers `onEndReached`. Reaching
   into a list's props to drive paging isn't available — extract the logic
   (`trimToFirstPage`) and test it directly instead of fighting the component.
3. **Module state outlives a test, mocked native state doesn't.** The
   `expo-secure-store` mock resets per test but `tokens.ts`'s in-memory token
   cache does not, so two `api.test.ts` cases were quietly passing on residue
   rather than their own setup. `api.test.ts` now clears tokens in `beforeEach`.

Also fixed in review: `refetch()` on a `useInfiniteQuery` refetches **every
loaded page** sequentially (v5 removed `refetchPage`; trim the cache to page one
first), and page-number pagination **re-sends a post across the page boundary**
when someone posts mid-scroll, producing duplicate `FlatList` keys — `toRows`
now drops repeats by id without touching order.

**2026-07-19 — Milestone C2 (compose): three React-Native-specific traps.**

1. **`FormData` takes `{uri, name, type}`, not a `Blob`.** The runtime reads the
   file off disk itself. A browser-style Blob uploads *nothing* while still
   returning a cheerful 201 — a silent failure, hence a test pinning it. The part
   must also carry a filename: camera-roll assets often have none, so one is
   synthesised (the server validates by decoding bytes, not by extension).
2. **Built-in `Animated`, not Reanimated, for the "now" pulse.** Reanimated needs
   a native worklets module that doesn't exist under Jest, and *its own published
   mock still imports that module*, so every test touching the component died on
   a cryptic `loadUnpackers` error. Built-in `Animated` needs no native module
   and is plenty for a two-property loop. Reach for Reanimated only when
   something is genuinely gesture-driven.
3. **The React Compiler forbids `useRef(...).current` during render.** The
   familiar `useRef(new Animated.Value(0)).current` idiom fails
   `react-hooks/refs` and breaks the build (`reactCompiler` is on in `app.json`).
   Use `useState(() => new Animated.Value(0))` instead.

Also: `Animated.loop` registers as an InteractionManager *interaction* by
default, so an infinite decorative loop holds a handle forever and defers
anything scheduled with `runAfterInteractions`. Pass `isInteraction: false`.

**2026-07-19 — Jest hung again, and it was NOT the animation.** Chased the
looping animation first and was wrong. The cause was TanStack Query's **mutation**
cache: `gcTime: 0` had been set on `queries` only, and mutations have a separate
cache with its own five-minute timer. Any test rendering a component that posts
will hang the CI job until `defaultOptions.mutations.gcTime` is zeroed too.
Isolating one suite at a time found it in a minute after guessing had burned far
longer.

**2026-07-19 — spine continuity is per-row, by necessity.** `FlatList`
virtualises rows, so a single line drawn behind the whole list would scroll out
of step with them. Every row therefore draws its own segment, which only looks
continuous if all rows agree exactly where the line is — hence the shared
geometry in `components/timeline.tsx`. The visible bug that prompted it: day
dividers had no segment, so the line broke at every change of day. **A new row
type must draw a `<Spine />` or it will punch a hole in the feed.** Note also
that a row's *margin* can't be painted over (margins sit outside the padding
box), so vertical gaps between rows must come from padding.

**2026-07-18 — Milestone C1: media is auth-gated, so images need a header.**
The biggest surprise of the milestone. In production Caddy `forward_auth`s every
`/media/*` request to `/api/media-auth/`, and the web app satisfies that for free
because a browser attaches its auth cookie to image requests. **A native app gets
no such help** — a bare `<Image source={{uri}}>` sends no credentials, so every
photo and avatar would 401 and render blank. Hence `src/components/AuthedImage.tsx`,
which attaches the Bearer header (and only to our own host, so a token can't leak
to a third party if a URL field ever changes).

**This is a trap with a delayed fuse:** Django serves `/media/` openly when
`DEBUG` is on, so a plain `<Image>` works perfectly in development and breaks only
in production. **Use `AuthedImage` for anything under `/media/`.** It is also the
one part of C1 that could not be verified locally — dev has no gate to test
against, and the live server doesn't have the mobile endpoints yet. **Confirm
photos actually load on the box** as soon as the release carrying #91 is deployed.

**2026-07-18 — TanStack Query needed AppState wiring.** Query's refetch-on-focus
listens for the browser's `visibilitychange`, which doesn't exist in React
Native, so *nothing ever counted as a refocus*: a post made while the app was
backgrounded stayed missing after reopening it. Fixed by driving `focusManager`
from `AppState` in `_layout.tsx`. The sibling case — refetch on network
reconnect — needs `onlineManager` + NetInfo and is deferred (another dependency,
and v1 is online-only).

**2026-07-18 — don't use `new URL()` in the app.** React Native ships a partial
`URL` implementation (the reason `react-native-url-polyfill` exists). Paging
follows the paginator's `next` URL, and parsing it with `new URL()` would have
passed every test under Node — whose `URL` is complete — while silently breaking
infinite scroll on device. `api.getPage` slices the string by hand instead.

**2026-07-18 — Jest hung after the feed tests.** All green in ~1s, then the run
never exited, which would hang the CI job. Not an open handle: TanStack Query's
default five-minute `gcTime` timer keeps Node's event loop alive. Test
`QueryClient`s set `gcTime: 0`.

**2026-07-18 — post cards have no background, deliberately.** First cut rendered
each post as a raised white card, which read as objects floating *above* the
timeline rather than entries hanging *off* it — the maintainer flagged it
immediately. Posts now sit straight on the surface with spacing and day dividers
doing the separating, so the spine stays the thing holding the feed together.
Reaction chips went white to compensate, since they're the one element that
should read as pressable.

Related: the clock time, avatar bead and author name are aligned by giving each
an explicit line box of exactly the bead's height (`BEAD` in `PostCard.tsx`)
rather than by nudging paddings — the eye reads the bead and name as one unit, so
drift there is very visible, and hard-coded paddings would break at a different
text size.

**2026-07-18 — Apple Developer Program enrolled.** £79 (the UK price of the $99
tier), status *pending approval*. Started on day one per the Prerequisite above,
so the wait overlaps Milestones A–C.

**2026-07-18 — two findings while starting Milestone A, from reading the
installed `dj_rest_auth` source.**

1. **Bearer auth already works; no settings change needed.**
   `JWTCookieAuthentication` (`dj_rest_auth/jwt_auth.py`) subclasses
   `JWTAuthentication` and checks the `Authorization` header *first* — when a
   header is present it uses it and never reads the cookie or runs the CSRF
   check. So the plan's original step 2 ("add `JWTAuthentication` alongside") was
   unnecessary. The outcome the plan predicted was right, the mechanism was not:
   it isn't DRF trying two classes in turn, it's one class preferring the header.
   Step 2 became "write a test that pins this behaviour" instead.

2. **The refresh token is blanked out of the login response body.**
   `dj_rest_auth/views.py` sets `data['refresh'] = ""` whenever
   `JWT_AUTH_HTTPONLY` is on — which it is, deliberately, as the web app's XSS
   mitigation. So `/api/auth/login/` cannot give mobile a refresh token, which
   blocked the rotation decision. **We did not turn `JWT_AUTH_HTTPONLY` off** —
   weakening the website to serve the app is the wrong trade.

   **Decision: dedicated mobile endpoints** — `/api/auth/mobile/login/`,
   `/api/auth/mobile/refresh/`, `/api/auth/mobile/logout/`. They return both
   tokens in the body and set no cookies; the web path is untouched. Rejected
   varying the existing endpoint on a client header (same URL, two behaviours —
   implicit and easy to misread later).

   **Trap worth remembering:** building these on simplejwt's stock
   `TokenObtainPairView` would skip `CustomLoginSerializer` and with it the
   **email-verification check** and the **per-IP login throttle** — a mobile login
   bypassing controls the web enforces. They must subclass `ThrottledLoginView`.

**2026-07-18 — Milestone B: the app is TypeScript, not JavaScript.** The plan
specced `.js` to match the web app, but the current Expo template ships
TypeScript only, and stripping the types back out would have put us off the
documented path for every Expo example we'll copy from. Decided with the user in
favour of TS: on a phone, a mistyped API field is a crash on a device rather than
a visible error in a browser console, and the types catch that at build time. The
web app stays JavaScript — the two frontends now differ, which is accepted.
`npm run typecheck` runs in CI so a type error fails the build.

**2026-07-18 — RNTL v14 made `render` and `fireEvent` async.** Every component
test must `await` them. Without the await, `screen` throws "`render` function has
not been called" and events silently don't land — a confusing failure, and most
tutorials still show the synchronous v13 form. Cost about twenty minutes.

**2026-07-18 — the live server is still on pre-#91 code.**
`https://your-timeline.net/api/auth/mobile/login/` 404s, so Milestone A's
endpoints aren't deployed yet. Milestone B was therefore verified against a local
`docker compose` backend. **Before the Milestone D device pass, the box needs the
release that carries #91** — and that release also needs the one-time manual
`token-flush` systemd timer install (see `docs/deploy.md`).

**2026-07-18 — Milestone B verification.** The app boots in the iOS Simulator,
the auth gate redirects a tokenless launch to `/login`, and the login screen
renders in the design system's palette. The *interactive* login tap could not be
automated (macOS blocks synthetic keystrokes without an accessibility grant), so
that specific step is a manual check. The backend contract was verified
separately by `curl`: mobile login returns `access` + `refresh` + `user` in the
body, matching `src/types.ts`.

**Simulator setup gotcha:** a fresh Xcode 26 install had *no* iOS simulator
devices and no matching runtime, so `expo start --ios` failed with "No iOS
devices available". Fix: `xcrun simctl create "iPhone 16 Pro" <device-type>
<runtime>` against the installed iOS 18.4 runtime. Expo Go also had to be
sideloaded by hand (`xcrun simctl install`) — its auto-download died when the CLI
process exited.

**CI:** the new `mobile` job must be added to the **required status checks** in
the repo's branch-protection settings, or it can't block a merge.
