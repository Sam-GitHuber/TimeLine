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
├── scripts/         # build-time Node tools (icon generation) — never bundled
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
two `projects` — `jest-expo/ios` and `jest-expo/android` — so ~43 test files
report as ~86 suites, and failures are tagged `[ios]` / `[android]`. The platform
decides what `Platform.OS` reports, so before this the app's Android branches (the
action-sheet fallbacks and the date pickers) were **never executed by CI on any
run** — they were first exercised by a person holding a phone. Keyboard avoidance
used to head that list; #172 removed the branch entirely, so keyboard handling is
now identical on both platforms and the doubled run asserts the *same* result
twice rather than two different paths. Two things this turned up, both worth
knowing before adding a test:

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
**The camera permission is real and stays** — every photo picker in the app can
take a shot (`launchCameraAsync`), so this is a live capability, not plugin
default cruft. **Both** usage strings name posts, chats *and* profiles: Apple
shows those sentences to the person in the prompt and to App Review, and they're
the only explanation either gets.

### Branch on the data, not the query flags

**A failed refresh of something already on screen is not a reason to take it off
screen.** `query-core`'s `error` action sets `status: 'error'` **while keeping the
data the query already has** — it writes `status`, `error` and `isInvalidated` and
never touches `data`. So `isError` is true on a *failed refetch* of a query that
is rendering perfectly good content, and any screen that reads the flags before it
reads the data throws that content away.

That refetch is not an edge case in this app: `staleTime` is 0 everywhere,
`focusManager` is wired to `AppState` (`app/_layout.tsx`), a native stack keeps
pushed screens mounted, and the conversation detail polls on a timer besides. So
**backgrounding the app and coming back on patchy signal** is a foreground refetch
against a screen full of cached data — the single commonest thing a phone does.

The shape every screen uses (`post/[postId].tsx` is the reference):

```
notFound ? gone : data ? content : isError ? "couldn't load" : spinner
```

A **404 outranks the cached copy** — deleted or out of reach is an answer about
*now* — and nothing else does. Two distinct mistakes come out of getting this
wrong, and #309 fixed both across seven sites:

- **Throwing away data we have.** `u/[userId].tsx`, `groups/[groupId].tsx`,
  `messages/[conversationId].tsx`, `components/ReactorsSheet.tsx` and
  `components/DisconnectWarningModal.tsx` all read the error flag first. The chat
  was the costly one: the transcript, the header identity *and* the composer with
  a half-typed message in it were replaced by "Couldn't load this conversation."
  and a *Back to messages* button, having lost nothing server-side. The
  disconnect modal was the dangerous one: a failed re-check swapped the concrete
  list of chats you're about to be ejected from for "You can still continue", in
  front of a destructive action.
- **Answering "gone" when the truth is "couldn't ask".** `events/[eventId].tsx`
  (`notFound || !event`) and `messages/[conversationId]/info.tsx` (`!detail`)
  reported a dropped packet as a cancelled event / a removed conversation.
  A missing thing and an unreachable one are different answers, and only the
  server's 404 justifies the first.

**A failed refresh stays silent** while stale content is up — no "you may be
looking at an old copy" banner. That was weighed and declined in #309: it would
be a new piece of UI on every screen, firing on every flaky refetch, to say
something the next successful refetch fixes by itself. `CommentThread` and the
web behave the same way.

Two idioms in this codebase are already correct and shouldn't be "fixed":
`isError && items.length === 0` (`components/events/EventPhotos.tsx`, with its own
note on why), and every list screen whose error branch lives in
`ListEmptyComponent` — which only renders when the list is empty, so it is the
data check, structurally.

#### Ask "is it on screen" once, not twice

The rule has a second half, and it is the one that bit twice. A **404 on a
refetch doesn't clear the cached data either** — the error action writes
`status`, `error` and `isInvalidated` and touches nothing else — so `!!data`
stays true while every render branch has correctly switched to a *gone* card.
Any effect beside them guarding on `!!data` is then firing writes for something
showing nothing.

`messages/[conversationId].tsx` had exactly that (#315): the mark-read effect
guarded on `detailLoaded` while the render decided from
`notAvailable || (isError && !detail)`, so a conversation you'd been removed from
went on POSTing `mark_read` for as long as the screen stayed open, on the detail
poll's schedule. `notAvailable`, `loadError` and the `showingThread` derived from
them are now declared **once, up beside the data**, in one block: the mark-read
effect and the `⋯` menu gate read `showingThread`, the header and body branches
read `loadError` and `notAvailable`, and every one of them is the same three
lines rather than a fresh phrasing at each site. That is the property that
matters — not that one identifier appears everywhere, but that no site
re-derives the answer for itself, which is how the two halves of a file drift
apart.
`markConversationRead` carries a `.catch()` besides, since the old error flag in
the guard was what used to keep the write off a failing connection.

Still open, same shape, different fix: `post/[postId].tsx` and
`events/[eventId].tsx` dismiss a post's/event's pushes from an effect gated on
`!!data`, and a **warm cache** hands that data back synchronously on the first
render, so the dismissal lands before the mount refetch has been anywhere near
the server. A guard can't close that one — the write has to ride the request, as
`CommentThread`'s did in #308. Tracked as #318.

#### The mirror image: no error branch at all

The opposite mistake — reading `isError` *never* rather than too early — is a
separate family, because an empty state written as a statement of fact reports a
dropped packet as an answer. Fixed on the app's two worst sites in #312 and on
the rest in #317. **Each names the failure once, up beside its query, and every
branch reads that name rather than re-deriving it** — usually
`loadFailed = isError && !data`, and on the invite picker `rosterMissing = !roster`,
which is stricter because a roster still in flight filters the list no better
than one that failed. `&& !data` in all of them, so a failed *refresh* still
keeps what's on screen — the rule above, and the half #309/#311 had backwards:

- **`app/(tabs)/calendar.tsx`** told someone with a group dinner tomorrow that
  they had nothing on. It reads `isError && !data` now, with a *Try again*.
- **`app/activity.tsx`** said *You're all caught up* — and cleared the badge
  besides; see [notifications.md](notifications.md) for that half. Its error
  branch lives in `ListEmptyComponent`, per the rule above.
- **`groups/[groupId].tsx`** hangs *four* queries off a page whose header
  renders from a fifth, and only that fifth had a branch. "No posts here yet —
  say something to the group" on a group with two years of history reads as a
  brand-new one, and the natural response to that sentence is to post into it
  again. The calendar tab said "No dated events yet" for a group with a wedding
  in it on Saturday. Past-event recaps vanished out of the middle of a timeline
  that still looked complete. And a failed *upcoming* fetch made the count
  compute 0, which hid the "↑ N upcoming" region along with the events — so
  nothing on screen distinguished "nothing is planned" from "we couldn't ask".
  That last one needs a line of its own for exactly that reason; the other three
  are an error state, a footnote, and a footnote.
- **`u/[userId].tsx`** said "*Ada* hasn't posted yet", naming a person, under a
  header that had loaded perfectly because it is a different query — and on your
  **own** profile, where `userQuery` is disabled entirely, said it about your own
  timeline.
- **`components/settings/NotificationPreferencesSection.tsx`** rendered only
  `mutation.isError`, never the query's, so a failed load left the heading and
  its blurb over zero toggles: "there are no settings" rather than "we couldn't
  load them", with no retry.

**#321 finished the family off** with the four the sweep behind #320 had left —
three of them in messaging, which is its own subsystem with its own reference
doc, and one on a screen that reaches no empty state at all:

- **`messages/[conversationId].tsx`** said *"No messages yet — say hello."* in a
  thread with years of history. The loudest instance in the app, and the exact
  twin of the web's `ConversationThreadView`. Its two waiting states are worth
  keeping straight: the transcript query is `enabled` only once the detail has
  landed, and a **disabled** query is neither loading nor errored — so the branch
  it needs is **`!pages`**, not `isLoading`, or the empty state paints in the gap
  before the messages have even been asked for. (That is the same shape the
  paused-query warning below describes, reached without `onlineManager`.)

  ⚠️ **`ListEmptyComponent` is not enough on its own, on any screen with an
  outbox or a second source of rows.** It doesn't render while `rows` is
  non-empty, so a cold failure with one unsent message queued leaves the card —
  and the only retry — undrawn. The transcript keeps the bubble and puts a
  *line* in `ListFooterComponent` (the top, inverted) instead, which is the same
  answer the group timeline reached in #320 when recaps loaded beside failed
  posts. Whenever a list can hold rows from somewhere other than the query that
  failed, the error needs a home outside the empty slot.
- **`messages/[conversationId]/info.tsx` twice, both by omission.** The media
  gallery renders `null` with no photos on purpose — a heading over a blank
  square is a feature announcing it has nothing for you — so a *failed* fetch
  said "this chat has never carried a picture". That one case gets the heading
  and a line. The **Block** control was gated on `otherQuery.data` and simply
  wasn't drawn: someone who opened Details to block a harasser found the screen
  ending at *Leave chat*. It stays undrawn as a **button** — `BlockButton` takes
  `is_blocked` and uses it for both the label and the direction of the write, so
  one rendered without it could unblock someone you meant to block (#236) — and
  what replaces it is a line saying we couldn't check, with the retry.
- **`groups/[groupId]/members.tsx`** drew a complete, healthy-looking roster
  whose rows were **inert**. `isAdmin` comes from `['group', id]`; only
  `['groupMembers', id]`'s error was ever read. An admin taps a row to remove a
  spammer, nothing happens at all, and the screen has stated by omission "you are
  not an admin of this group". The rows stay inert — every control behind them
  would 403 if we guessed wrong, and guessing *up* offers an admin action to a
  member — but a notice says so and offers the retry.

  Three things about that notice, each of which was wrong first: it sits
  **outside the `FlatList`**, because a `ListHeaderComponent` scrolls away and
  the explanation for why nothing is pressable has to still be on screen when
  someone taps a row forty rows down; it renders **only over a roster that
  loaded**, since with no rows there is no false claim to correct and the
  commonest outage fails both queries and would stack two retries for one
  failure; and a **404 takes precedence**, saying you're no longer a member and
  offering *no* retry, because nothing clears a query's `data` and the cached
  `your_role: 'admin'` otherwise kept every row live after you'd been removed.

**And one write, folded in with them.** The thread's mark-read effect was gated
on `showingThread`, which answers for the *conversation*: its header, its
participants, its composer, all from `convoQuery` and all fine while the
transcript is errored. So the screen said "Couldn't load these messages" while
the effect beside it dismissed that thread's delivered pushes and POSTed `read`.
The reader is told there is nothing there **and** the only signal that would
bring them back is gone — #318's outcome reached from #321's cause. It reads
`readingMessages = showingThread && !!pages` now, and **`!!pages` rather than
`!messagesLoadFailed` is the whole fix**: gating on the failure alone still fires
on the first commit after the detail lands, while the transcript request is in
flight and neither errored nor loaded, so the dismissal has already happened by
the time we find out. A failed *poll* still marks read, because `pages` survives
it and the reader is looking at the messages (#309).

**`setOnScreenConversation` needed the same guard**, and is the easier one to
miss because it destroys nothing itself: claiming the thread on focus makes
`configureNotificationHandler` return `shouldShowList: false` for its pushes, so
a message arriving while the error card was up bannered once and was never filed
in the notification centre. Every write *and* every claim beside a screen has to
agree with what the screen is actually showing — that is the whole of #315, and
"claim" is the half that reads as nothing at all.

Two of them are not a wrong sentence:

- **`groups/[groupId]/invite.tsx` reaches past the display, and turned a failed
  read into a wrong write.** The roster is what filters the picker, so
  `(membersQuery.data ?? [])` made "we couldn't ask who's in this group" into
  "this group has nobody in it" — and the picker then offered people who were
  already members, took three ticks, and came back "Invited 0 of 3". The roster
  is named once now, the list and the write read the same value, and **Invite
  refuses and refetches** rather than firing at a list it couldn't filter. Not
  `disabled`: a control that goes dead with no explanation is its own dead end,
  and the picker looks entirely normal in this state. Same shape as the web's
  "Start a chat" (#314).

  **The refusal is only half of it**, and the half that's easy to stop at. What
  actually goes out is `chosen` — the ticks intersected with the pool they were
  ticked from, derived on every render. Without that, a roster arriving *late*
  leaves an already-member ticked and counted after she's gone from the list, and
  the second press invites her: the wrong write delayed by one tap rather than
  prevented. Selection state outlives the list it was made against, so it can't
  be the answer on its own.
- **`groups/[groupId]/edit.tsx` was a spinner that never resolved.** It reaches
  no write — it's the same missing branch reaching the same dead end, for an
  admin who tapped ⋯ → Edit group on bad signal. It takes the 404 branch too, for
  the same reason the group page and the profile do: a retry against a request
  that will 404 forever is one dead end swapped for another.

**The web finished its half first (#314)** — eleven sites, including the two
that reach past the display: the activity centre's seen-write waits on the list
landing, and the group page's "Start a chat" refuses rather than building a chat
from an empty roster. [`feed-and-posts.md`](feed-and-posts.md) § *The mirror
image: no error branch at all — the web's sites* holds that half. It also
records the **badge-shaped counts** decision — deliberately left reading zero on
a failed poll, on both clients, *except* the app-icon badge in
`useBadgeCount.ts`, which re-asserts a known count on purpose. The app's
instances of that decision are `(tabs)/_layout.tsx`'s three tab pips,
`components/ActivityBell.tsx`, `(tabs)/people.tsx`'s Requests count and
`(tabs)/groups.tsx`'s invites count, all `data?.count ?? 0`. **Swept in #317 and
deliberately left alone**, for the reason recorded there: a badge is an
*absence*, there is no sensible error affordance on a tab pip, and a count frozen
at a stale value is worse than none. Don't "fix" these to match
`useBadgeCount.ts`, or it to match them.

⚠️ **One part of the web's shape does *not* port yet, and will the day someone
wires `onlineManager`.** The web gates its waiting branch on `!data` rather than
`isLoading`, because with `networkMode: 'online'` an offline query **pauses** —
never sent, never failed, `isLoading` false with nothing behind it — and an empty
state gated on `!isLoading` renders anyway. The app doesn't have that state:
`onlineManager` is deliberately left unwired to NetInfo (`app/_layout.tsx`), so
an offline request *rejects*, which lands in the `isError` branch. Wiring it
would hand every screen here the paused state at once, and every empty state
gated on `isLoading` would start stating a request that was never sent as fact.
That is the same warning `_layout.tsx`, `MessageButton.tsx`, `BlockButton.tsx`
and `CommentThread.tsx` already carry for the *write* side; it applies to reads
too, and the web's `waitingMessage()` (`errors.js`) is the shape to port when it
happens.

### Show the server's words, or your own — never the runtime's

The sibling rule to the one above, and the one this client was slowest to learn.
Having decided *whether* to show an error, a screen has to decide *what text*.
There are three kinds of rejection and only one of them is fit to read:

| Rejection | Message it carries | Fit to show? |
|---|---|---|
| The server refused, with a DRF body | `"Your old password was entered incorrectly."` | **Yes** — it's the diagnosis |
| The server answered with nothing showable (a 500 as an HTML page) | `"Request failed (500)"`, synthesized by `request()` | No |
| The request never reached the server | React Native's `"Network request failed"` | No |

Every rejection out of `api.ts` is now an **`ApiError`**, and the one bit that
separates the first row from the other two is **`fromServer`**. Reading it is
`serverMessage(err, fallback)`'s whole job, so **every screen that renders a
rejection goes through `serverMessage`** and none reach for `.message`.

Two ways to get this wrong, both of which were live:

- **`err instanceof Error ? err.message : 'our sentence'`** — the spelling ~35
  screens were written with, and the reason #243 existed. A `TypeError` *is* an
  `Error` and *has* a `message`, so the ternary never reached the authored
  sentence: it was unreachable by construction, in every file that had one. What
  a user got instead was `Network request failed` — on Change password and
  Delete account, where "did the server refuse me, or did my train go into a
  tunnel?" is the entire question.
- **`err instanceof ApiError ? err.message : 'our sentence'`** — the *fix* for
  the first one, and still wrong, which is what makes it worth naming. Once a
  lost connection is re-raised as an `ApiError` (which is how it stops being
  React Native's words), the class stops separating anything. `PollTally` and
  `RsvpBar` were written this way and were held up in #240 as the two files that
  "got it right"; they were the two that would have broken *quietest*.

`api.ts` guards both places a connection can die — the `fetch`, and the body read
after it — and re-raises with `status: 0` (no answer arrived) or the real status
(headers did), `fromServer: false`, and a sentence of ours. The JSON body is
serialized *above* that `try` on purpose: a `JSON.stringify` that throws is our
bug, and dressing it as a connection problem sends someone to check their signal
over a mistake at the call site (#244).

`WENT_WRONG` beside `serverMessage` is the default fallback, so a dozen screens
don't each write a slightly different version of the same sentence — but a
screen that can say something more specific should. `frontend/src/errors.js` is
the web's mirror of all of this, and took the fix first (#240).

**When you write a test that refuses a write, reject with an `ApiError` carrying
a `detail`, not a bare `new Error(msg)`.** A bare `Error` is now the shape of a
*lost connection*, so a test that uses one is asserting the fallback, not the
server's words — five tests were passing on exactly that confusion before #243.

### Taking a photo: camera or library

Every place that adds a photo — a post, a chat message, a profile or group
avatar, an [event's album](events.md) — asks **"Take Photo / Choose from
Library"** first, through the shared `src/photoSource.tsx`. Only chat had the camera when photos first shipped
(Phase 9b M7); the rest opened the camera roll and nothing else, which on a phone
is the wrong default — "add a photo" to what you're writing about *right now*
very often means the thing in front of you, and a trip out to the camera app and
back is the friction that makes an app feel like a website in a wrapper.

**`usePhotoPicker` owns the whole flow, not just the wording.** One `await`
returns assets or `null`:

```tsx
const { pickPhotos, photoMenu } = usePhotoPicker();
const assets = await pickPhotos('Add a photo');
if (!assets) return;   // backed out, refused, or failed — already explained
// …and render {photoMenu}, which is null on iOS.
```

That shape is deliberate. The fragile part was never the prompt; it was the
five-step dance around it (ask → guard → launch → guard → `assets[0]`), which
drifted the first time it was copied — one screen guarded an empty `assets`, two
didn't, and that guard is the difference between a cancelled pick and
`cannot read property 'uri' of undefined`. Collapsing it to one guard per screen
is what keeps four surfaces honest.

Four things in it are worth knowing before touching it:

- **It's a menu, so it uses `useActionMenu`, not `Alert`.** Android's `Alert`
  maps buttons to neutral/negative/positive in *reverse* array order, so "Cancel"
  would land in the emphasised primary slot and "Take Photo" in the throwaway
  neutral one, and it defaults to `cancelable: false` so Back wouldn't dismiss
  it. `ActionMenu.tsx` records that war story in full.
- **Dismissal is a third outcome, and it has to be delivered.** `ActionMenuRequest`
  grew an `onCancel` for this: the menu's result is *awaited*, and a sheet closed
  by Cancel, the backdrop or Back must settle the promise or the button is dead
  for the rest of the screen's life.
- **Only the camera path asks permission.** The modern library picker runs out of
  process and hands back only what was chosen, so prompting for library access
  would be a prompt for nothing. A refused camera resolves `null` after saying
  why — and *which* sentence depends on `canAskAgain`, because on Android a first
  "Deny" leaves the OS willing to ask again, and sending someone to a Settings
  toggle that doesn't exist yet reads as the app being broken.
- **A rejected picker is reported, not swallowed.** The native side rejects for
  real reasons (no camera on a simulator, no current view controller, a failed
  write); uncaught, that's a floating promise and a button that quietly does
  nothing.

Multi-select is a library-only option (`allowsMultipleSelection`,
`selectionLimit`): the camera returns one shot. The post composer and the
[event album](events.md) are the two callers that ask for several at once, and
the two that pick at less than full quality (0.9) — their photos go up as
picked, so that's the one compression they get, while chat photos and avatars
are re-encoded on the phone afterwards and would only lose detail twice.

In tests, the press that opens the sheet **must not be awaited** — `pickPhotos`
doesn't resolve until a source is chosen — and `helpers.choosePhotoSource()`
answers it on either platform.

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

**Keyboard avoidance needs `KeyboardAvoider`, not `KeyboardAvoidingView`.** Use
`src/components/KeyboardAvoider.tsx` for anything with a text input near the
bottom of the screen; a lint rule enforces it. The long version is in that file's
header, but the short one is worth carrying: Android used to resize the window
when the keyboard opened (`android:windowSoftInputMode="adjustResize"`), so
eleven screens correctly did nothing themselves and wrote
`behavior={Platform.OS === 'ios' ? 'padding' : undefined}`. **Edge-to-edge
removed the resize** — Expo SDK 54+ enables it, Android 15 (API 35) mandates it,
and our generated `android/gradle.properties` carries `edgeToEdgeEnabled=true` —
so the app has to consume `WindowInsets.ime()` itself. Nothing did, and the
keyboard drew over the message composer.

**Why a library rather than `behavior="padding"`, stated accurately.** An earlier
version of this section claimed RN's `KeyboardAvoidingView` simply *can't* work
under edge-to-edge. That was wrong, and the correction is worth having because
the false version rules out a cheaper fix. RN 0.86 reports a correct keyboard
height, and `ReactRootView.java:973` has an explicit branch for the position too:
`screenY = softInputMode == SOFT_INPUT_ADJUST_NOTHING ? visibleBottom - height :
visibleBottom`. Under `adjustNothing` that is resize-free and correct — so RN's
component *would* work, in that mode. What we actually have is the manifest's
`adjustResize`, which takes the second arm: a resize-era measurement of a window
that no longer resizes. Reaching `adjustNothing` needs a config plugin or manifest
edit, since `app.json` exposes only `android.softwareKeyboardLayoutMode:
resize | pan`, and it would apply app-wide. `react-native-keyboard-controller`
was chosen over that for animation quality — it tracks the keyboard rather than
stepping once it settles — and for one code path across both platforms. A trade,
not a necessity.

**Mounting `KeyboardProvider` re-configures every `<Modal>` in the app.** This is
the part that bites. RN sets each modal's dialog window to
`SOFT_INPUT_ADJUST_RESIZE` (`ReactModalHostView.kt:332`), so modal dialogs were
the one surface still being resized under edge-to-edge — an input inside a modal
worked with no help. The library's `ModalAttachedWatcher` overrides that to
`ADJUST_NOTHING` on every modal show ("imitating edge-to-edge mode behavior",
`ModalAttachedWatcher.kt:96`), unconditionally. So **a `<Modal>` with a text
input now needs a `KeyboardAvoider` inside it, where before it needed nothing** —
the reverse of the usual direction, and it caught `ReportModal` and
`DeleteAccountSection` on the way in. The provider also has to sit above the
navigator; without it every avoider renders but never moves, which looks exactly
like the original bug. `keyboardAvoider.test.tsx` asserts its position for that
reason.

**And the emulator hides it — this is the "harness is more forgiving" shape
again, in its worst form.** Gboard comes up as a **small vertical pill** on the
left edge (backspace / enter / emoji / ☰) instead of a keyboard. It takes almost
no vertical space, so nothing is covered and two attempts to reproduce the
reported bug both "passed".

That pill is Gboard's **physical-keyboard toolbar**, not floating mode, and the
distinction is what makes it fixable. Android has decided a hardware keyboard is
in use, so Gboard collapses to a toolbar — and **a toolbar reports a zero-height
IME inset**, which means no amount of app-side keyboard handling can respond to
it. The app is behaving correctly; there is simply nothing to avoid.

Getting a real keyboard, in order:

1. `adb shell settings put secure show_ime_with_hard_keyboard 1` — a *secure*
   setting, so it survives reboots. Necessary but not sufficient on its own.
2. **`adb reboot`.** This is the part that actually works. The "physical keyboard
   is in use" state lives in the system input-method service; force-stopping
   Gboard, re-selecting the IME and `pm clear`ing Gboard all fail to shift it.
3. Don't send `adb shell input keyevent` at the emulator while testing the
   keyboard. Those are injected as *hardware* key events and flip Gboard straight
   back to the toolbar — which is how this state kept coming back mid-session.
   Drive it with `input tap` only, or with the mouse.

**Verify with insets, never with your eyes**, because the pill and a real
keyboard are easy to confuse in a screenshot:

```
adb shell dumpsys window | grep "type=ime"
```

- `frame=[0,0][0,0]` or `frame=[0,2400][1080,2400]`, i.e. zero height → the
  toolbar. **Whatever you are looking at proves nothing.**
- `frame=[0,1517][1080,2400] … visible=true sideHint=BOTTOM` → a real docked
  keyboard, and the check is now meaningful.

`adb shell uiautomator dump` then grepping the composer's `EditText` `bounds=`
gives the other half objectively: its bottom edge should sit just above the IME
frame's top, and the gap should *shrink* by the navigation-bar inset when the
keyboard opens (that is `useKeyboardVisible` doing its job). Measured on a Pixel 8
/ API 36: composer `[152,2206][869,2311]` closed → `[152,1386][869,1491]` open,
against an IME top of 1517. Jest can't see
it either — layout is the one thing the suite genuinely cannot check — so the
guard is `keyboardAvoider.test.tsx` (the props the wrapper asks for, under both
platform projects) plus a lint rule. **The lint rule blocks the direct spellings
only**: `no-restricted-imports` on the name, and a `no-restricted-syntax`
selector for an inline `Platform` ternary in a `behavior` prop. A hoisted
`const behavior = Platform.OS === 'ios' ? …`, a `Platform.select({ … })`, or
`import * as RN from 'react-native'` all slip past it. It's a guard against
copy-paste, which is how this happened, not a proof.

**This is also the app's one deliberate exception to the Reanimated rule above.**
`react-native-keyboard-controller` is Reanimated-backed and drives a
`Reanimated.View` in all fifteen call sites, none of it gesture-driven. That's a
knowing trade for keyboard tracking that follows the finger, and it only avoids
the documented Jest breakage because `jest.setup.js` mocks the library wholesale
— which means **a Reanimated or worklets upgrade that breaks the real avoider
will still show a green suite** and fail only on a device. Worth remembering at
the next SDK bump.

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
- **Android push *can* be tested on the emulator**, provided the AVD uses a
  **Google Play** system image — it has real Play Services and mints a real FCM
  token. This is why `registerForPush` guards on `canRegisterForPush()` rather
  than `Device.isDevice`: an emulator reports `isDevice: false` exactly like the
  iOS Simulator, so the original guard silently skipped registration on Android
  and made push look broken. Verified end to end (Phase 10) with no Android
  hardware involved.
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

### The back button

iOS has no hardware back, so every dismissible thing in the app was built with
only an **on-screen** way to close it — a Cancel, an ✕, a tap outside. On Android
back is *the* way people dismiss things, and a press nothing claims doesn't just
do nothing: it falls through to the navigator and **leaves the screen**. The
failure is quiet and reads as a bug in the app rather than a missing handler.

The rule, in two halves:

- **`<Modal>` needs nothing.** React Native routes the press to its
  `onRequestClose`, and every modal in the app wires one. Keep it that way — a
  new `<Modal>` without `onRequestClose` is the same bug in a different shape.
- **Everything else needs `useAndroidBack(active, onBack)`**
  (`mobile/src/useAndroidBack.ts`). Inline editors, staged attachments,
  multi-select, expanding panels, search fields — all of them are plain views,
  and all of them fell through before #168.

Three things about that hook are load-bearing:

- **It's scoped to focus** (`useFocusEffect`). A screen left mounted behind
  another would otherwise keep swallowing presses meant for the screen on top.
  The cost is that a unit test rendering a screen outside a navigator throws, so
  `jest.setup.js` stubs `useFocusEffect` as a plain `useEffect` for the whole
  suite — a suite that replaces `expo-router` with its own factory has to include
  the same stub.
- **`onBack` is read through a ref**, so callers don't have to memoise it and an
  inline arrow is fine. Across a dozen call sites the likelier mistake is a fresh
  closure silently resubscribing on every render, or a `useCallback` with stale
  deps closing over old state. `active` is the only thing that subscribes, which
  is what the hook actually means.
- **The handler returns `true`.** Returning false runs your handler *and*
  navigates — the state closes and the screen disappears, which is worse than not
  handling the press at all.

**When one screen has several dismissible states, give it one handler with an
explicit priority**, not one `useAndroidBack` per state. React Native runs back
handlers most-recently-registered-first, so separate subscriptions rank
themselves by the order the user happened to *open* things — on the message
thread, a photo staged before hitting Edit would claim the press meant for the
edit. The thread screen decides the order itself: selection, then edit, then
staged photo, then leave.

Order that priority by **what's on screen**, not by what the state model
suggests. Select mode replaces the thread's composer with a bulk-action bar, so
while it's on, the editing banner and the staged-photo preview are unmounted —
dismissing either of them first would read as a dead press that quietly binned
your photo, discovered only after leaving select mode. Selection is therefore
first even though it's the state you opened last.

The edit case is why this is a correctness bug and not a polish one. Cancelling
an edit is the **only** path that restores `stashedDraft` to the composer
(`messaging.md`), so a back press that popped the screen instead destroyed
whatever you'd half-typed before you paused to fix a typo — and put you two
screens away from noticing.

Tests are per-screen and Android-only, gated with `androidIt` from the test
helpers; `androidBack.test.tsx` pins the hook's own contract. The two layers are
both needed — the unit test says the hook works, the screen tests say the screens
still call it, and the second is what a refactor silently drops.

**iOS's swipe-back is a gesture like any other, and one screen doesn't get it.**
The conversation thread sets `gestureEnabled: false` on its route in
`app/_layout.tsx`, because a rightward drag on a message bubble means *reply*
there and two responders claiming one drag is a race, not a preference — see
[messaging.md](messaging.md#swipe-to-reply-and-the-back-gesture-it-cost) for the
full story, including the day the trade was made the other way round. Everywhere
else keeps the gesture. Two things to know before adding a swipe to any other
screen: `gestureEnabled` is iOS-only (Android's back gesture belongs to the OS
and ignores it), and a route-level option belongs in the layout rather than in
the screen, so it holds from the first frame.

**The one exception is temporary and belongs to the screen**: a form holding
itself open while its write is in flight turns the gesture off for the length of
that request and puts it back
(`useHoldSwipeBack`, `mobile/src/writeHold.tsx`), because a swipe is a dismissal
route with no button to disable. The rule it serves — *a form that is the only
renderer of its own error may not be dismissed while that write is in flight* —
and the reason the phone needed a mechanism where the web needed a `disabled`
attribute are in
[connections.md](connections.md#reporting-a-refused-write). The load-bearing
constraint for anything in this section: **hold the state a screen already
registers `useAndroidBack` for by gating that handler, never by adding a second
registration** — two handlers for one press rank themselves by hook order, which
is the race this whole section exists to avoid.

Under test, `useHoldSwipeBack` reaches for the navigator that isn't there, so
`jest.setup.js` stubs `useNavigation` alongside `useFocusEffect` — a suite with
its own `expo-router` factory needs both, and needs to spread
`jest.requireActual` if it mounts a whole screen (a factory that drops the
module's other exports renders a blank tree rather than throwing, and takes
every test after it down with it).

### The date/time picker

`@react-native-community/datetimepicker` is **two different components behind one
import**, and the difference is not styling. On iOS it's an inline wheel that
lives in the layout and stays put. On Android it renders *nothing* and opens a
**modal dialog as a side effect** — the picker in the event `DimensionEditor` and
`PollOptionFields` therefore mounts only while the dialog should be up, and
unmounts when it closes, because one mounted instance opens exactly once.

Three consequences, each of which was a bug (#131, #169, #170):

- **The dialog re-opens whenever the library's effect re-runs**, and its deps are
  `[onChange, onValueChange, onDismiss, onNeutralButtonPress, valueTimestamp,
  mode]` — mostly *callback identities*. Inline arrows are a fresh identity every
  render, so any re-render underneath an open dialog (a react-query refetch, a
  `busy` flip) re-presented it and snapped the calendar back to the `value` prop,
  throwing away a selection the organiser was halfway through. **Memoise every
  handler you pass, and the seeded `Date` too** — `PollOptionFields` seeded blank
  options with a bare `new Date()`, so even the timestamp moved every render.
- **A failed open reports through `onError` alone.** `DateTimePickerAndroid.open`
  presents inside a `try`/`catch`, so a rejected present (a null host activity, a
  configuration change mid-present) fires *neither* OK nor Cancel. Without an
  `onError` the "is it open" flag stays `true` and the trigger — which only ever
  set it `true` — becomes a no-op: the editor is dead for the rest of the visit.
  Pass `onError`, and make the trigger tolerate a stuck flag anyway
  (`DimensionEditor` bumps a nonce used as the picker's `key`, so a press
  remounts regardless of what the flag says). Remounting isn't free, though:
  the outgoing instance's cleanup calls `DateTimePickerAndroid.dismiss(mode)`,
  which resolves *its* pending open as a Cancel. So **scope the close handlers
  to the presentation that produced them** — `DimensionEditor` compares the
  nonce a handler was created with against the live one — or an ordinary
  double-tap on the trigger opens a second dialog and then closes it with the
  first one's `onDismiss`.
- **A stub with no effects can't see any of this.** The Jest stand-in in
  `jest.setup.js` is platform-split for that reason: iOS gets the flat
  always-mounted version, Android reproduces the real dep list, loses its
  in-progress selection on a re-present, and exposes `__failNextOpen()` /
  `__openCount()` so a test can drive the failure path and count presentations.
  Before it did, both bugs above passed the suite — including a regression test
  written for exactly this component, which only ever exercised a React
  conditional.

### The icons — three slots, three geometries

The brand mark (the `Layout.jsx` spine + emerald now-dot) has to be authored
**three different ways** for Android, and getting that wrong is invisible until
someone is holding a phone. Both mistakes were made here (#171):

| Asset | Canvas | Glyph fills | Read as |
|---|---|---|---|
| `notification-icon.png` | 96px = 24dp | **~92%** (22 of 24dp) | alpha only |
| `android-icon-foreground.png` | 432px = 108dp | ~31% | full colour |
| `android-icon-monochrome.png` | 432px = 108dp | ~31% | alpha only |

- **Notification icons are full-bleed.** Android draws a 24dp slot and expects
  ~22dp of glyph. It also reads **only the alpha channel**, tinting it with the
  plugin's `color` — hand it a colour image and you get a solid tinted blob.
- **Adaptive layers are not.** Only the central 72 of their 108dp is visible and
  only the central 66dp *circle* is safe from a launcher's mask, so they're
  authored with a wide transparent margin. The mark is sized so its share of that
  visible 72dp matches its share of the iOS `icon.png` square — otherwise the same
  app reads at two different sizes on the two platforms.

Passing an adaptive layer to `expo-notifications` therefore *looks* right (it is
monochrome, it is our mark) and renders at **half** the size of every neighbouring
app's, on every push. That was shipped for a whole phase.

**Regenerate with `node scripts/generate-icons.mjs`** — dependency-free, and the
geometry in it is the source of truth. `src/__tests__/appIcons.test.ts` decodes the
committed PNGs and asserts each slot's fill fraction and the mark's aspect ratio,
so a wrong-shaped asset is a red test. It deliberately doesn't checksum: a
checksum fails on every legitimate re-render *and* would have passed on the stock
Expo logo, which is what was actually there.

`icon.png` (iOS, and Android's legacy square) and `splash-icon.png` are authored
artwork, not generated. The adaptive icon has **no background image** — Android
gets `adaptiveIcon.backgroundColor` (`#fbfaf7`) instead, which is the warm surface
`icon.png` sits on. An icon change is a **native** change: it needs a rebuild and
resubmit, not an OTA (see *Releasing*).
