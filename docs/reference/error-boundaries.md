# Error boundaries — what a crash looks like

What each client does when a **render throws**: not a failed request (that's the
next section down), but a component that raises while React is drawing it.

Both clients had nothing here until issue #299. This doc is the record of what
was added, and of two findings that are easy to assume the other way round.

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

Two levels, and the split is the same on web and mobile:

| | Web | Mobile |
|---|---|---|
| **Per-page** — the one that does the work | `RouteErrorBoundary` around `<Outlet/>` in `components/Layout.jsx`, and one around each companion drawer | `ErrorBoundary` exported from **every** file in `src/app/` |
| **Last resort** | `AppErrorBoundary` in `main.jsx` | `RootErrorBoundary`, exported from `src/app/_layout.tsx` |

The per-page one is the valuable half. A throw inside a page leaves the nav, the
footer and the shell alive, so the reader can go somewhere else *without* a
reload — which is the whole difference the issue was about. The last-resort one
only catches what escapes that: a crash in a provider, in the router itself, or
on a page that renders outside the shell (login, sign-up, the legal pages).

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
- **`QueryErrorResetBoundary` is wired to the boundary's reset.** A query that
  threw during render stays errored in the cache; resetting the boundary alone
  would re-mount the children onto that same cached error and throw straight
  back. Clearing the errored queries first is what makes "Try again" re-*run*
  the request rather than re-render the failure.
- **`location.key` is the reset key**, so simply navigating away clears the
  error. Without it a caught error is sticky: the nav would still be on screen
  and still appear to do nothing, which looks more broken than the blank page.
- **The drawers get their own boundaries.** A portal escapes the DOM tree but
  **not** the React tree, so a crash in the messages or groups drawer would
  otherwise sail past the boundary around `<main>` and reach the root one —
  blanking the whole app from a panel.
- **The drawer fallback offers "Reload", not "Close".** Closing is the obvious
  action and the one we can't safely offer: `MessagingProvider.close()`
  deliberately refuses while a write is in flight (#258), so a drawer that
  crashed mid-write would hold that refusal forever and seal the reader inside a
  dead panel — the exact trap #258 exists to prevent. It also positions itself
  (`fixed`), because the fallback is rendered by the boundary back in the normal
  tree, not through the drawer's portal, and in flow it would land under the
  footer where nobody would see it.

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

- **Every screen file carries a one-line `export { ErrorBoundary } from
  '@/components/ErrorBoundary';`.** That's the registration, and it's per-screen
  rather than per-layout on purpose: `Try` wraps the *component the module
  exports*, so a boundary on a layout would replace that layout — tab bar and
  all — while a boundary on a screen sits inside the navigator and leaves the
  tabs and the stack standing. **A new screen is unprotected until someone adds
  that line**, which nothing in a build or a run would reveal, so
  `src/__tests__/errorBoundary.test.tsx` asserts it off the filesystem.
- **The root boundary must be hook-free.** `Try` wraps the root layout, so its
  fallback renders *outside* every provider that layout mounts — no
  `QueryClientProvider`, and the navigator may be the thing that died. Reaching
  for a query client or `router` there would throw inside the fallback, which
  React treats as unrecoverable and answers with the blank screen we're
  preventing. All it can honestly offer is "try again", which re-mounts the
  layout — a phone's version of reloading the page.
- **"Try again" resets the query cache first.** There's no
  `QueryErrorResetBoundary` equivalent in play (mobile doesn't use throwing
  queries), and the likeliest cause of a render crash is one unexpected shape in
  a cached response, which a bare retry would hit again immediately.
  `resetQueries()` is blunter than the web's per-boundary reset — it clears
  every query — but a crash isn't the moment to be precious about a cache, and
  everything it drops is server data that refetches. Nothing unsent is in there:
  drafts and the outbox have their own storage.
- **"Back to the feed" uses `router.replace('/')`, not `back()`.** A cold-start
  deep link — a tapped notification, the most common way anyone lands deep in
  this app — has nothing to go back to, so `back()` would silently do nothing
  and strand the reader on the fallback.

## What both fallbacks say, and to whom

The sentence is written for the person holding the device: *nothing you did
caused this, nothing you've posted is affected*, and then an action. The **raw
error message and stack are development-only** on both clients (`import.meta.env
.DEV` / `__DEV__`, so the mobile branch is stripped from a release bundle
entirely). A stack trace means nothing to a family member and reads as "this is
really broken", which is the impression the fallback exists to avoid.

The other half of that decision: **the error is always logged**. Catching means
React no longer reports it itself, so a boundary that swallowed it in
development too would be a *downgrade* on the blank page it replaced — the blank
page at least left React's own report in the console. In production the console
is the only trace there is.

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
