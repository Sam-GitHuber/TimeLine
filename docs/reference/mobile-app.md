# The mobile app

The native app built in Phase 9: **React Native + Expo (Expo Router), TypeScript**,
one codebase for iOS and Android, hitting the same Django API as the web. It is
live in **external TestFlight beta**.

This doc is the **cross-cutting** reference — how the app is laid out, how to run
and test it, and the React Native traps that cost real time. Per-feature detail
lives in the feature docs, most of which now have their own *Mobile* section:
[accounts.md](accounts.md) (including the whole Bearer-token auth handshake),
[feed-and-posts.md](feed-and-posts.md), [connections.md](connections.md),
[messaging.md](messaging.md), [groups.md](groups.md), [events.md](events.md),
[reactions.md](reactions.md), [notifications.md](notifications.md) (push).
Build and release steps live in [`../mobile-release.md`](../mobile-release.md).

## Why Expo, and what that bought

React Native + Expo was chosen over a PWA (no reliable iOS push) and native Swift
(would not share with Android). Expo Router is file-based routing that mirrors
`react-router-dom`, so the mental model carries over from the web app.

The payoff is Phase 10: Android adds **no new screens**. What's left there is FCM
credentials, back-button handling, notification channels, and layout fixes — all
edits inside `mobile/`.

**Full feature parity was a v1 requirement**, not a stretch goal: the first build
handed to any tester mirrored everything the website does. Nothing should feel
"missing" versus the web.

## Repo layout

One `mobile/` folder at the repo root, sibling to `backend/` and `frontend/`:

```
mobile/
├── src/
│   ├── app/         # Expo Router routes (file-based) — note: src/app, not /app
│   ├── api.ts       # fetch wrapper — Bearer token, not cookies
│   ├── auth.tsx     # AuthProvider
│   ├── tokens.ts    # expo-secure-store wrapper
│   ├── types.ts     # hand-written types for the API's JSON
│   ├── components/  # RN components (View/Text, not div/span)
│   └── theme.ts     # design tokens translated from the Tailwind @theme
├── app.json
└── package.json     # its own deps; does NOT merge with frontend's
```

**Not `apps/ios/` + `apps/android/`.** That layout is for two separately written
native apps. We chose React Native precisely so there is *one* codebase; two
folders would imply a split that doesn't exist. Expo does generate `mobile/ios/`
and `mobile/android/` (the real Xcode/Gradle projects), but in the managed
workflow those are **generated and gitignored** — recreated by `npx expo prebuild`
or on EAS's servers, never hand-edited.

**No shared web/mobile package, deliberately.** iOS and Android share ~95% of the
code for free. Web and mobile share far less than it looks: the web's components
are built on `<div>`, `<button>` and Tailwind classes, none of which exist in
React Native — `PostCard` gets rewritten, not imported. What could genuinely be
shared is `utils.js`, `postCache.js`, some query hooks and the design tokens,
roughly **1–1.5k lines out of an 11k-line web app**, and `api.js` only partly
since the auth layer differs. Extracting that means npm workspaces, a build step
and Metro config: permanent complexity for two consumers. So helpers are
**copied** into `mobile/`. The genuinely shared layer is the JSON API itself.
Revisit only if the same bug gets fixed twice in two places.

**The app is TypeScript; the web app stays JavaScript.** The plan specced `.js`
for symmetry, but the Expo template ships TS only and stripping types back out
would leave the documented path for every Expo example. On a phone a mistyped API
field is a crash on a device rather than a red line in a browser console, so the
types earn their keep. `npm run typecheck` runs in CI.

**`frontend/` is arguably misnamed now** that there are two frontends. Renaming it
to `web/` would touch Docker Compose, both CI workflows, the deploy scripts and
most docs. Not worth the churn.

## Running it in development

```bash
docker compose up --build        # backend + db + web app
cd mobile && npx expo start      # Metro → press 'i' for the iOS Simulator
```

The app defaults to `https://your-timeline.net` (the home server), which is
usually what you want to test against. Point `EXPO_PUBLIC_API_URL` in
`mobile/.env` at a local Django when debugging API work — see `.env.example`.

**Where `localhost` works and where it doesn't**, because this has bitten twice:

| Target | `localhost:8000` | Use |
|---|---|---|
| iOS Simulator | ✅ works — it shares the host's network stack | `http://localhost:8000` |
| Real device | ❌ `localhost` is *the phone* | LAN IP, or the live domain |
| Android emulator | ❌ | `10.0.2.2`, or a LAN IP |

A `.env` left pointing at `localhost` from Simulator work is the classic
failed-device-pass cause: every request fails and nothing explains why.

**Expo Go for early work, a dev build once push is involved.** Expo Go is the
fastest loop while there's no native module to worry about; push notifications
need a real dev build. Don't switch earlier "to be safe" — the slower rebuild
cycle isn't worth paying before it's needed. Note the corollary under
*config plugins* below: Expo Go hides a whole class of permissions bug.

## Tests and CI

**Jest + React Native Testing Library, unit and component only** — mirroring the
web's Vitest + RTL. **No Maestro/Detox E2E:** a second tool, simulator
infrastructure in CI, and a well-known flakiness tax that isn't worth it at this
scale. CI runs a `mobile-test` job (`npm ci`, `npm test`, `npm run typecheck`)
alongside `backend` and `frontend`. **App builds happen on EAS, never in GitHub
Actions** — don't try to build an IPA in CI.

**The suite runs twice, once per platform** (Phase 10). `jest.config.js` declares
two `projects` — `jest-expo/ios` and `jest-expo/android` — so ~41 test files
report as ~82 suites, and failures are tagged `[ios]` / `[android]`. The platform
decides what `Platform.OS` reports, so before this the app's Android branches (the
action-sheet fallbacks, keyboard-avoidance behaviour, the date pickers) were
**never executed by CI on any run** — they were first exercised by a person
holding a phone. Two things this turned up, both worth knowing before adding a
test:

- **`src/__tests__/helpers.ts` absorbs the platform-divergent test seams**, so a
  test doesn't branch on `Platform.OS` itself. It owns the `ActionSheetIOS` and
  `Alert` spies and exposes `pickMenuAction` / `pickMenuOption` / `menuOptions` /
  `menuDestructiveOption` / `menuWasShown` — because a "⋯" menu is an action
  sheet on iOS and an `Alert` chooser on Android. It also has `switchValue`,
  since a `<Switch>` reports through `value` on iOS and `on` on Android; **RNTL's
  `toBeChecked()` only understands the iOS shape and silently reports a switch
  that is on as unchecked**, which is worse than having no matcher.
  Corollary: **never `jest.spyOn(Alert, 'alert')` locally and `mockRestore()` it**
  — restoring puts the *original* back and tears out the shared spy, so a later
  test in the same file records nothing and fails somewhere unrelated. This cost
  real time to find.
- **`babel.config.js` had to be added.** The platform presets hand `babel-jest`
  only a `caller`, dropping the `presets` the root `jest-expo` preset injects; with
  no babel config on disk to fall back on, *every* suite dies parsing Flow types
  in React Native's own setup file. The error names `@react-native/jest-preset`,
  so it reads like a broken dependency rather than a missing config. The file
  declares exactly what Metro and jest-expo already resolved implicitly, so it
  changes nothing about the bundle.

Three test-harness traps, all recurring:

- **RNTL v14 made `render` and `fireEvent` async — `await` them.** Without the
  await, `screen` throws "`render` function has not been called" and events
  silently don't land. Most tutorials still show the synchronous v13 form. It
  also hides inside helpers: `{...render(...)}` spreads a *promise*, yielding
  nothing, and every later query fails.
- **Jest hangs on TanStack Query's `gcTime` timers.** All green in a second, then
  the run never exits — which would hang the CI job. Test `QueryClient`s must set
  `gcTime: 0` on **both** `queries` and `mutations`: mutations have a separate
  cache with its own five-minute timer, so any test rendering a component that
  posts will hang until both are zeroed.
- **`gcTime: 0` collects a hand-seeded cache entry immediately** when nothing
  observes it, so a test that seeds `['feed']` then asserts on it reads
  `undefined`. Assert on a query the screen actually subscribes to, and test
  cache fan-out directly against `postCache`.

**Layout is the one thing Jest genuinely cannot check** — the feed geometry was
verified in the Simulator with a throwaway fixture route.

## Design: translated, not copied

Follow [`../design-system.md`](../design-system.md). Tokens don't cross to React
Native automatically — the palette and spacing are translated once into
`theme.ts`. Aim for *native-feeling*, not a pixel copy: native nav patterns,
system fonts where they read better.

Two divergences from the web that are deliberate and load-bearing:

**The spine hugs the left edge, and the time sits inline.** The web puts the clock
in its own rail *left* of the spine, which on a phone pushes the line a third of
the way across the screen. On mobile the spine hugs the left edge with the avatar
beads on it and the time sits inline at the head of each entry, before the
author's name — returning ~48pt of a 390pt screen to content on every line (a long
post drops from five lines to three). The time is still the first thing you read,
so it keeps its role as the voice of the timeline; it just no longer buys that
with a permanent column. `components/timeline.tsx` owns the geometry
(`SPINE_COLUMN`, `SPINE_CENTRE`) and everything derives from it. **A new row type
must derive its indent from those constants** or it will drift.

**Spine continuity is per-row, by necessity.** `FlatList` virtualises rows, so a
single line drawn behind the whole list would scroll out of step. Every row draws
its own segment, which only looks continuous if all rows agree exactly where the
line is. The bug that prompted this: day dividers had no segment, so the line
broke at every change of day. **A new row type must draw a `<Spine />` or it will
punch a hole in the feed.** A row's *margin* can't be painted over (margins sit
outside the padding box), so vertical gaps must come from padding.

**Posts have no card background.** The first cut rendered each post as a raised
white card, which read as objects floating *above* the timeline rather than
entries hanging *off* it. Posts sit straight on the surface, with spacing and day
dividers doing the separating, so the spine stays the thing holding the feed
together. Reaction chips went white to compensate — they're the one element that
should read as pressable.

## React Native traps that cost real time

Each of these was a live bug. Several share a shape worth naming: **the
development harness supports something the real one doesn't**, so the failure
surfaces on a device or in production, not in the loop where you'd catch it.

**Auth-gated media needs a header — use `AuthedImage`.** Caddy `forward_auth`s
every `/media/*` request in production, and a browser satisfies that for free by
attaching its cookie to image requests. A native app gets no such help: a bare
`<Image source={{uri}}>` sends no credentials, so every photo and avatar 401s and
renders blank. `src/components/AuthedImage.tsx` attaches the Bearer header, and
only to our own host so a token can't leak to a third party if a URL field
changes. **Delayed fuse:** Django serves `/media/` openly when `DEBUG` is on, so
a plain `<Image>` works perfectly in development and breaks only in production.

**Uploads must send a `.bytes()`-shaped part.** Expo SDK 54+ replaces the global
`fetch` with its "winter" runtime, whose FormData serializer rejects React
Native's legacy `{uri, name, type}` part (`Unsupported FormDataPart
implementation`), and a real `Blob` is a dead end too because RN's `Blob` can't be
built from an `ArrayBuffer`. What works is the serializer's *FileBlob* branch: an
object exposing `.bytes()`. `api.ts`'s `toFilePart()` reads the picked file with
expo-file-system's `File` and returns `{ bytes, name, type }`, where `name`/`type`
become the multipart filename and content-type. Camera-roll assets often have no
filename, so one is synthesised — the server validates by decoding bytes, not by
extension. The Jest tests mock `fetch`, so the real serializer never runs there:
the api tests assert the FileBlob *shape* instead.

**A native module's config plugin must go in `app.json`, not just
`package.json`.** `expo-image-picker` was installed and working but absent from
the `plugins` array, so nothing injected `NSPhotoLibraryUsageDescription` into
`Info.plist`. It worked anyway because **Expo Go's prebuilt binary carries every
permission string** — the bug would have surfaced only at the dev-build switch, as
an app that dies the moment you tap "Add photos", and as an App Review rejection.
**When adding any Expo package, check whether it ships a config plugin.** Verify
without a full build: `npx expo config --type introspect` prints the resolved
`Info.plist` and Android permissions. Permissions are narrowed deliberately:
**`microphonePermission: false`**, because the picker plugin otherwise adds a
microphone string *and* Android's `RECORD_AUDIO`, and an unexplained microphone
permission on a privacy-first app is a bad look — one the Play listing would
show. Setting it `false` doesn't merely omit the permission, it emits an explicit
`tools:node="remove"` so the merge strips anything a dependency adds; verified in
Phase 10, so don't "fix" that entry when you see it in the introspected manifest.
**The camera permission is real and stays** — chat photos can be taken with the
camera (Phase 9b M7, `launchCameraAsync`), so this is a live capability, not
plugin default cruft.

**Don't use `new URL()`.** React Native ships a partial `URL` implementation
(hence `react-native-url-polyfill`). Paging follows the paginator's `next` URL,
and parsing it with `new URL()` passes every test under Node — whose `URL` is
complete — while silently breaking infinite scroll on device. `api.getPage`
slices the string by hand.

**TanStack Query needs `AppState` wiring.** Query's refetch-on-focus listens for
the browser's `visibilitychange`, which doesn't exist in RN, so *nothing ever
counted as a refocus* — a post made while the app was backgrounded stayed missing
after reopening. `focusManager` is driven from `AppState` in `_layout.tsx`. The
sibling case (refetch on network reconnect) needs `onlineManager` + NetInfo and is
deferred; v1 is **online-only**, with Query's cache giving basic re-view of
already-fetched screens.

**`onLayout` is parent-relative, and children lay out before parents.** A reply
nested under a comment reports an offset like `20` — its position *inside its
parent's replies block* — so scrolling to that lands at the top of the thread.
Every ancestor must add its own offset as the report passes up. And because RN
lays children out first, the target's offset almost always arrives while the
ancestors still don't know their own positions, so summing eagerly bakes in
zeroes: each level buffers a report it can't resolve and flushes it when its own
`onLayout` lands. The "only scroll once" guard has to respect the same rule —
latching it on the early call makes the miss permanent. This matters because
**this route is what every post and comment push notification opens**. Pinned by
tests that fire layout events in RN's real order.

**Animation: built-in `Animated`, not Reanimated, unless it's gesture-driven.**
Reanimated needs a native worklets module that doesn't exist under Jest, and *its
own published mock still imports that module*, so every test touching the
component dies on a cryptic `loadUnpackers` error. Also: `Animated.loop`
registers as an InteractionManager *interaction* by default, so an infinite
decorative loop holds a handle forever and defers anything scheduled with
`runAfterInteractions` — pass `isInteraction: false`.

**The React Compiler forbids `useRef(...).current` during render.** The familiar
`useRef(new Animated.Value(0)).current` idiom fails `react-hooks/refs` and breaks
the build (`reactCompiler` is on in `app.json`). Use
`useState(() => new Animated.Value(0))`.

**There is no portal and no `position: fixed`.** Anchoring an in-place popover
takes the same shape as the web's portal and for the same reason:
`measureInWindow` the trigger, then draw at those window coordinates inside a
full-screen `Modal`. In flow it gets clipped by its container's bounds and painted
over by later rows. **Keep "is it open" and "where is it" as separate state** —
keying open off the measurement gives a popover that silently never appears if
`measureInWindow` doesn't call back: a dead button, near-impossible to reproduce.
It opens first and refines position on measurement, degrading to a centred tray
rather than nothing.

**Gestures don't cross an RN `Modal`'s view tree.** `GestureHandlerRootView` wraps
the root *and* re-roots inside any modal that needs gestures (the avatar cropper
does).

**The emoji picker doesn't cross to React Native.** The web's
`emoji-picker-element` is a DOM web component and cannot run here. The system
keyboard is not a substitute either — **iOS has no way to open the keyboard in
emoji mode**, no `keyboardType`, no API, so an input just opens the ABC keyboard
and hopes the user finds 🙂. The app ships an in-place tray (four positive quick
reactions, whose `+` opens `rn-emoji-keyboard`, a pure-JS MIT grid, ~200 KB of
emoji data). Emoji **validation stays server-side only** (`api/emoji.py`) — a
second copy of "what counts as an emoji" in JS would drift from the one that
decides.

**Port a helper when a screen needs it, not before.** `formatRelativeTime` was
deleted for being unused and came back one PR later; that's the rule working, not
churn. `formatAbsoluteTime` stays out — it fills a *hover* tooltip on the web, and
a phone has no hover.

## Push

Fully documented in [notifications.md](notifications.md) — the `DevicePushToken` /
`PushOutbox` / `PushReceipt` models, tickets vs receipts, per-type preference
gating, `routeForNotification`, and the cold-start vs warm-tap handling. Two
things worth knowing before touching it:

- **iOS push cannot be tested in the Simulator.** It needs a real device and an
  active Apple Developer Program membership. Budget a device pass.
- **Cold start is the path that's easy to miss** — a tap that *launches* the app
  uses a different Expo API from one that arrives while it's running. Test it by
  force-quitting before sending.

Messaging pushes are a special case (no `Notification` row, coalesced per thread,
never quoting message text) — see [messaging.md](messaging.md#push-notifications).

## Releasing

[`../mobile-release.md`](../mobile-release.md) is the runbook — read it before any
release. In short: builds and submissions go through **EAS**, `eas.json` holds the
profiles, and `appVersionSource: "remote"` means **build numbers live on EAS**, so
`app.json`'s `version` staying at `1.0.0` tells you nothing about what shipped.
`eas build:list` is the source of truth for what's on TestFlight.

A **demo account** exists for App Review (`create_review_account`), isolated from
real users' data. The **admin-approval gate is intact for testers**: installing
from TestFlight doesn't grant access — each sign-up is still approved in Django
admin.

## Not built: OTA updates (EAS Update)

**Planned, not wired** — `expo-updates` is not installed, there's no
`runtimeVersion`, no channels in `eas.json`. Until it is, **every** app update
goes the binary route.

The goal is an update story mirroring the web's continuous deploy, for the changes
where that's possible. The mental model is two kinds of change:

| Change type | Examples | How it ships |
|---|---|---|
| **JS / assets only** | Most feature work | **OTA update** (EAS Update) |
| **Native** | A new native module, permissions, icon, SDK bump | **New binary** (`eas build` + resubmit) |

`runtimeVersion: { policy: "fingerprint" }` hashes the native layer and an OTA
update only lands on apps whose fingerprint matches — change a native dep and the
OTA correctly refuses, signalling "this one needs a rebuild". The tooling enforces
the split so a mismatched bundle can't ship.

Three steps when it's built: (1) install `expo-updates`, set the fingerprint
policy, add a `production` channel, `eas update:configure`, then rebuild and
resubmit **once** (adding the updates runtime is itself a native change);
(2) a CI job running `eas update --branch production --auto` on merges to `main`
touching `mobile/`; (3) keep native builds a deliberate, manual step — firing them
on every merge burns build minutes and spams App Review.

Two caveats to fold in rather than bolt on:

- **Add update code-signing.** OTA bundles come from Expo's CDN; without signing,
  a compromised update server could push malicious JS to family phones. Given this
  app holds real family data, treat this as non-optional.
- **Apple permits OTA for bug fixes and JS tweaks** — that's its intended use. The
  line not to cross is OTA-ing a *materially different app* to dodge review.

## Android

Phase 10 (`../phases/phase-10-android-app.md`). No new screens; the work is
Android Studio + an AVD on a **Google Play** system image (needed for FCM push),
FCM credentials registered with Expo, notification **channels** mapped to the
per-type preference groups, the hardware/gesture **back button**, safe areas,
permissions, and Android-only layout bugs. `DevicePushToken.platform` already
exists, so there's no schema change. The Play Console is a **$25 one-off**, needed
only for Play Store distribution — the emulator and a real device via Expo Go work
without it.
