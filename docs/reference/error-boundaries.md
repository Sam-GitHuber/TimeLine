# Error boundaries — what a crash looks like

What each client does when a **render throws**: not a failed request (that's the
next section down), but a component that raises while React is drawing it.

Both clients had nothing here until issue #299. This doc is the record of what
was added — and, as much, of the several things the first attempt got wrong,
because each of them looked right. A boundary is only exercised when something
throws, so the ways one can be quietly useless are not obvious from reading it.

## The failure it replaces

React's answer to an uncaught render error is to **unmount the whole tree**.
That's deliberate on React's part — it would rather show nothing than a
half-broken UI whose state nobody can reason about — but with no boundary
anywhere it meant *any* throw, in any component, on any route, replaced the
entire app with a blank page. No message, no nav, no way back except the reader
thinking to reload.

That is a worse failure here than on a typical app, for two reasons that are
specific to this project:

- **Who's holding it.** TimeLine is used by family and friends with no context
  for what a blank page means. To them it is indistinguishable from "the site is
  down" or "my account is gone", and the next step is a message to Sam rather
  than a reload. On a phone it's worse still: no address bar to retype, no
  reload button.
- **What it costs us.** A blank page reports nothing. There is no
  error-reporting service and there won't be one (privacy-first — see
  [`../SHARED.md`](../SHARED.md)), so the only evidence of the bug is whatever
  the user thought to describe.

A boundary can't *fix* the throw. What it buys is the difference between a
broken page and a broken app.

It was not hypothetical: the query-key collision found in the review of #297
made `getNextPageParam` destructure `undefined` and throw, and what turned a
broken photo album into a white screen was purely the missing boundary. That
specific trigger is gone; the blast radius was the point.

## The shape, on both clients

Three levels on the web, two on mobile — the split is otherwise the same:

| | Web | Mobile |
|---|---|---|
| **Per-page** — the one that does the work | `RouteErrorBoundary` around `<Outlet/>` in `components/Layout.jsx` | `ErrorBoundary` exported from **every** file in `src/app/` (including `(tabs)/_layout.tsx`) |
| **Per-surface** — the shell's own moving parts | `PanelErrorBoundary` around each companion drawer; `NavErrorBoundary` around the activity bell and the user menu | — (the tab bar's boundary above covers the equivalent) |
| **Last resort** | `AppErrorBoundary` in `main.jsx` | `RootErrorBoundary`, exported from `src/app/_layout.tsx` |

The per-page one is the valuable half. A throw inside a page leaves the nav, the
footer and the shell alive, so the reader can go somewhere else *without* a
reload — which is the whole difference the issue was about. The per-surface row
exists because the shell is not only the outlet: the drawers and the nav's bell
render outside it, and wrapping only the outlet left them able to blank the app
from a side panel or a nav button. The last-resort one catches what escapes all
of that: a crash in a provider, in the router itself, or on a page that renders
outside the shell (login, sign-up, the legal pages).

**Where the recovery runs out, stated plainly:** for a signed-out reader whose
crash is on `/login`, "Reload TimeLine" goes home and `ProtectedRoute` bounces
them straight back to `/login`, which throws again. Nothing can fix a login page
that throws deterministically — no button could — but the root boundary's
recovery is best-effort, not a guarantee. The mobile login screen has the same
shape, via `AuthGate`'s redirect.

Both clients offer the same two actions and the same wording, because the two
should not disagree about what a crash looks like — the rule #216/#227 bought.

## Web

`frontend/src/components/ErrorBoundary.jsx`. The decisions worth knowing:

- **It's a class**, and it's the only one in the codebase.
  `getDerivedStateFromError` / `componentDidCatch` are the only API React
  exposes for this and both are class-only. The fallbacks are ordinary function
  components passed in, so nothing else has to be written in class style. No
  `react-error-boundary` dependency: it'd be a library for ~40 readable lines.
- **The root boundary sits inside `QueryClientProvider` but outside
  `BrowserRouter`**, so it survives a crash in the router or in `AuthProvider`.
  The cost is that its fallback has no router to navigate with, so its recovery
  is a full page load — `window.location.assign("/")` rather than `reload()`,
  because if the crash is specific to the current URL then reloading it
  reproduces the crash and the button looks broken.
- **"Try again" drops the cached responses first — `resetQueries({ type:
  "inactive" })`.** By the time a fallback is on screen the crashed subtree has
  unmounted, so *its* queries are the inactive ones, which makes "inactive" a
  surprisingly precise name for "the data that just killed a screen".
  Everything still mounted keeps its data, so recovering one surface doesn't
  blank the ones that were working.

  **The first version got this wrong in a way worth recording**, because it
  looks right: it wired `QueryErrorResetBoundary`'s `reset` to the boundary
  instead. In TanStack v5 that only flips an internal `isReset` flag, and the
  flag is read *solely* for queries using `suspense` or `throwOnError`. This app
  uses neither, so the call was inert — "Try again" re-mounted the children onto
  the exact cached object that had just thrown, guaranteed to fail for the one
  crash class it existed for. If a query ever does adopt `throwOnError`, that
  component becomes worth reaching for again; until then it is dead wiring that
  reads as a mechanism.
- **`location.key` is the reset key**, so simply navigating away clears the
  error. Without it a caught error is sticky: the nav would still be on screen
  and still appear to do nothing, which looks more broken than the blank page.
- **The drawers get their own boundaries, keyed on the drawer's own `isOpen`.**
  A portal escapes the DOM tree but **not** the React tree, so a crash in the
  messages or groups drawer would otherwise sail past the boundary around
  `<main>` and reach the root one — blanking the whole app from a panel.

  The *key* is the subtle half, and the first version got it wrong: it reused
  `location.key`. A drawer is not a route, so that meant the two failure modes a
  reset key exists to prevent, both at once — navigating the page behind a
  crashed drawer reset the boundary, re-mounted the same broken drawer and
  re-threw (a fresh catch and a fresh console report on every click), while the
  one action that genuinely fixes it, closing the drawer, cleared nothing and
  left a fixed, undismissable card describing a panel that was no longer open.
  Keyed on `isOpen`, closing it from the nav is the recovery, and a closed
  drawer renders nothing.

- **The nav's data-driven furniture gets a boundary too** (`NavErrorBoundary`,
  one each around the activity bell and the user menu). They render *above*
  `<main>`, so wrapping only the outlet left the one piece of chrome that
  renders arbitrary server data — an infinite list over notification rows, the
  same shape as the crash that started #299 — able to blank the entire app from
  the nav bar. Its fallback is a single chip, because a card in a nav row would
  wreck the layout, and it has **no reset key**: unlike a page it's mounted for
  the whole session, and nothing about navigating makes a bad notification page
  good.
- **The drawer fallback has no "Close" of its own.** Closing is the obvious
  action and the one the fallback can't perform: the drawer's close chrome died
  with the subtree, and `MessagingProvider.close()` deliberately refuses while a
  write is in flight (#258). The nav button does it instead — which, keyed on
  `isOpen`, is also what clears the card. It positions itself (`fixed`), because
  the fallback is rendered by the boundary back in the normal tree, not through
  the drawer's portal, and in flow it would land under the footer where nobody
  would see it; and it **docks to its own drawer's edge**, because both drawers
  can be open at once on a wide viewport and two centred cards at the same
  `z-40` would sit exactly on top of each other.

- **Both actions on the page fallback go through the reset**, including "Back to
  the feed" — which is a `navigate`, not a `<Link>`, for that reason. As a bare
  link it was inert when the crashed page *was* the feed: it re-rendered the
  same page against the same cache, threw again, and pushed a history entry each
  time it looked like it had done nothing.

## Mobile

`mobile/src/components/ErrorBoundary.tsx`.

**The finding worth writing down: Expo Router installs no error boundary of its
own.** The issue asked someone to check the default first, on the reasonable
suspicion that the mobile failure mode might already be gentler. It isn't. The
framework *ships* a `Try` component and a ready-made `ErrorBoundary` view, which
makes it look handled — but `useScreens.fromImport` only wraps a route in `Try`
**if that route's module exports an `ErrorBoundary`**. Nothing installs it for
you, at any level, in dev or in production. So mobile had exactly React's
behaviour, same as the web.

(The framework's own view wouldn't be what we want anyway: black background,
`Error: <raw message>` shown to whoever is holding the phone, and a `/_sitemap`
link in dev. Fine for a developer, wrong for someone's mum.)

Consequences:

- **Every route file carries a one-line `export { ErrorBoundary } from
  '@/components/ErrorBoundary';`.** That's the registration. It's per-screen
  rather than only on the root layout because `Try` wraps the *component the
  module exports*: a boundary on a screen sits inside the navigator and leaves
  the tabs and the stack standing, while one on a layout replaces that layout.
  `(tabs)/_layout.tsx` carries it too, accepting that cost — it runs three badge
  queries of its own, and without it a throw there skipped all twenty per-screen
  boundaries and took the whole app down through the root one.

  **A new screen is unprotected until someone adds that line**, which nothing in
  a build or a run would reveal, so `src/__tests__/errorBoundary.test.tsx`
  asserts it off the filesystem — over `.ts`/`.js`/`.jsx` as well as `.tsx`,
  since expo-router treats all four as routes.

  **A structural alternative exists and is worth knowing about:** React
  Navigation's `screenLayout` prop, which expo-router forwards, wraps each screen
  individually from *one* declaration per navigator — two props would cover all
  21 screens with nothing to remember. It's the better long-term shape. It isn't
  what's here because the explicit export is the documented expo-router idiom and
  is verifiable from the filesystem; if the registration ever drifts in practice,
  `screenLayout` is the fix to reach for.
- **The root boundary must be hook-free.** `Try` wraps the root layout, so its
  fallback renders *outside* every provider that layout mounts — no
  `QueryClientProvider`, and the navigator may be the thing that died. Reaching
  for a query client or `router` there would throw inside the fallback, which
  React treats as unrecoverable and answers with the blank screen we're
  preventing. All it can honestly offer is "try again", which re-mounts the
  layout — a phone's version of reloading the page. **That is genuinely weaker
  than the web's equivalent**, and worth saying plainly: `queryClient` is created
  at module scope and survives the remount, so a root crash caused by a poisoned
  cache entry will re-throw. The native answer would be `Updates.reloadAsync()`;
  `expo-updates` isn't a dependency, and adding it for this alone hasn't been
  judged worth it.
- **Both actions reset the query cache first**, with the same `{ type:
  'inactive' }` scoping as the web. "Back to the feed" needs it as much as "Try
  again", which the first version missed: on the feed tab itself
  `router.replace('/')` targets the route already on screen, so without the reset
  that button did nothing at all on the app's most-used screen. The first version
  also reset the cache *unfiltered*, which on a phone is worse than it sounds —
  React Navigation keeps the tabs and the stack beneath mounted, so recovering
  one screen blanked the three tab badges, dropped every mounted sibling to a
  spinner, and threw away every page of every `useInfiniteQuery` (months of a
  scrolled-back conversation, to fix an unrelated screen).
- **"Back to the feed" uses `router.replace('/')`, not `back()`.** A cold-start
  deep link — a tapped notification, the most common way anyone lands deep in
  this app — has nothing to go back to, so `back()` would silently do nothing
  and strand the reader on the fallback.
- **The fallback logs the error itself**, because nothing else does — see the
  next section.

## What both fallbacks say, and to whom

The sentence is written for the person holding the device: *nothing you did
caused this, nothing you've posted is affected*, and then an action. Every web
fallback is a `role="alert"` and moves focus to its heading — without that a
crash is *silent* to a screen reader, since focus was on an element that no
longer exists and drops to `<body>` with nothing announced, which is the audio
spelling of the blank page. The **raw
error message and stack are development-only** on both clients (`import.meta.env
.DEV` / `__DEV__`, so the mobile branch is stripped from a release bundle
entirely). A stack trace means nothing to a family member and reads as "this is
really broken", which is the impression the fallback exists to avoid.

The other half of that decision: **the error is always logged**, on both
clients. Catching means React no longer reports it itself, so a boundary that
swallowed it in development too would be a *downgrade* on the blank page it
replaced — the blank page at least left React's own report in the console. In
production the console is the only trace there is.

On the web that's `componentDidCatch`. On mobile it has to be done by the
*fallback*, because the catching class is expo-router's `Try`, which implements
`getDerivedStateFromError` and nothing else — no `componentDidCatch`, no
logging. The first version of this relied on the framework and so, in a release
build, caught a crash and discarded it completely: nothing on screen, nothing in
the console, nothing in device logs. The mobile fallbacks now log it themselves,
tagged `[crash]` like `push.ts`'s warnings.

## The cost to the web suite, and how it's paid (#357/#360)

Catching a throw took something away that nobody had written down as coverage: a
render error used to propagate out of RTL's `render()` and **fail the test**.
Caught, it renders a fallback and logs, and the test carries on against a subtree
that rendered *nothing* — so every `queryBy…toBeNull()` around it passes for the
wrong reason. Measured, not assumed: injecting a throw into
`ConversationThreadView` left four tests in `messaging.test.jsx` green, each of
them asserting the absence of something that was absent because the whole thread
had crashed.

`frontend/test/console-guard.js` closes it. It wraps the console, and fails the
test in an `afterEach` if anything reached it. The decisions:

- **The console, not React's `onCaughtError`.** The narrower hook fires only for
  boundary-caught errors, but it has to be passed to every `createRoot` — i.e.
  every `render()` call site. The console catches the same crashes plus
  everything else React reports that way (act() violations, invalid props,
  duplicate keys) from one place, and asks nothing of the tests.
- **`console.warn` as well as `console.error`, which was not the first
  instinct.** It's tempting to say everything React reports about a broken render
  is an `error`. It isn't: `defaultOnCaughtError` uses `console.error`, but
  `defaultOnUncaughtError` — the path taken when nothing above the throw is a
  boundary, which is every suite that renders a page bare, `auth.test.jsx`
  included — reports through `console.warn`. Guarding only errors would have left
  that silent while claiming to have closed the gap. The cost is that a
  third-party deprecation warning can now fail a suite; that's a line of
  `allowConsole` once someone has looked at it.
- **Collect and assert afterwards, rather than throwing inside `console.error`.**
  Throwing there raises inside React's rendering, where a boundary may catch it —
  the guard swallowed by the thing it's reporting on.
- **The audit the issues expected wasn't needed.** Instrumenting all 34 suites
  found *zero* `console.error` and zero `console.warn`, so the hook went on with
  no allow-list of pre-existing noise. That's the part to re-check if this is
  ever ported to the mobile suite.
- **Messages are buffered, not passed through to the terminal.** Every console
  call is now either a failure — whose full text and stacks go into the failure
  message — or one a test named in advance, which is noise. Printing the second
  kind is what pushed `error-boundary.test.jsx` into swallowing the console
  wholesale.
- **`sequence: { hooks: "stack" }` is pinned in `vite.config.js`.** It's Vitest's
  default, but the guard rests on it: reverse unwinding is what puts its
  `afterEach` *after* RTL's automatic `cleanup`, so an error thrown while
  unmounting belongs to the test that mounted it rather than the next one. The
  installed Vitest's own `--help` still advertises the old `parallel` default,
  which is reason enough not to inherit it.

A test whose subject *is* a failure calls `allowConsole(...)` with a substring or
pattern — from a `beforeEach` or `afterEach`, never as the body's last statement,
where a failing assertion above would skip it and bury the real failure under a
second one. Anything else it logs still fails it. `error-boundary.test.jsx` uses
that instead of the blanket `vi.spyOn(console, "error")` it used to install —
that spy exempted the one file about crashes from noticing an act() violation or
a bad prop, which is the same shape of hole one level down.

**The mobile suite doesn't have this problem**, for a structural reason worth
knowing: the boundaries there are installed by expo-router's `Try`, and the tests
render components directly with RNTL rather than through the router, so no
boundary is in the tree and a throw still fails the test. If mobile tests ever
start rendering through `expo-router/testing-library`, that changes and this
guard is the thing to port.

## Related, but not this

A boundary catches a **render**. It does not catch an error thrown in an event
handler, in a `setTimeout`, or in a promise callback — those reject where
they're raised and are handled per-call-site. The rules for *those* live
elsewhere and are worth reading alongside this:

- **A rejected request → words a person can act on**:
  [`feed-and-posts.md`](feed-and-posts.md) and `frontend/src/errors.js` —
  `serverMessage` (show the server's sentence, never the runtime's) and
  `waitingMessage` (the paused-offline third state).
- **A failed refetch of something already on screen** is not a reason to take it
  off screen — the "branch on the data, not the query flags" rule, in
  [`feed-and-posts.md`](feed-and-posts.md) for the web and
  [`mobile-app.md`](mobile-app.md) for the app. That rule is what keeps most
  failures from ever reaching a boundary in the first place; the boundary is for
  the ones nobody predicted.
