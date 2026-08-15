import { Component } from "react";
import { Link, useLocation } from "react-router-dom";
import { QueryErrorResetBoundary } from "@tanstack/react-query";

/**
 * What the app does when a render throws (issue #299).
 *
 * React's behaviour for an uncaught render error is to **unmount the whole
 * tree** — deliberately, because it would rather show nothing than a
 * half-broken UI whose state nobody can reason about. With no boundary anywhere
 * that meant *any* throw, in any component, on any route, replaced the entire
 * app with a blank white page: no message, no nav, no way back except the user
 * thinking to reload.
 *
 * That is a worse failure here than on a typical app. The people using TimeLine
 * are family and friends with no context for what a blank page means; to them
 * it's indistinguishable from "the site is down" or "my account is gone", and
 * the next step is a message to Sam rather than a reload. A blank page also
 * reports nothing, so the only evidence of the bug is whatever the user thought
 * to describe.
 *
 * A boundary can't *fix* the throw. What it buys is the difference between a
 * broken page and a broken app: the nav and the rest of the shell stay alive,
 * so the reader can go somewhere else under their own steam.
 *
 * ---
 *
 * **Why a class.** There is no hook or function-component equivalent —
 * `getDerivedStateFromError` / `componentDidCatch` are the only API React
 * exposes for catching a render error, and both are class-only. This is the one
 * class component in the codebase, and it stays as small as possible: the
 * fallback UI is a plain function component passed in, so nothing else has to
 * be written in class style.
 *
 * **Why not `react-error-boundary`.** It would be one more dependency for ~40
 * lines we can read, and `docs/SHARED.md` asks that libraries be raised first.
 *
 * **What a boundary does not catch** — worth knowing, because it sets
 * expectations for the two mounted below:
 *
 *   - errors thrown in event handlers (a click, a submit) — those reject where
 *     they're raised and are already handled per-call-site (`errors.js`);
 *   - errors in `setTimeout`/promise callbacks that aren't part of a render;
 *   - errors thrown by the boundary's *own* fallback (hence the fallback here
 *     is deliberately dumb — static text, a `Link`, a `button`; it reads no
 *     application data and calls no API);
 *   - anything rendered through a **portal to elsewhere in the DOM is still
 *     caught** (portals follow the React tree, not the DOM tree) — which is why
 *     the drawers in `Layout` are inside a boundary even though they paint over
 *     the whole viewport.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Always, in every build. Swallowing this in development would hide exactly
    // the stack traces the boundary makes harder to see — before #299 an
    // uncaught error at least left React's own report in the console, and a
    // boundary that caught it silently would be a *downgrade* for debugging.
    // In production this is the only trace that survives at all: there's no
    // error-reporting service (privacy-first — see `docs/SHARED.md`), so the
    // console is where a maintainer sitting next to the affected person looks.
    console.error("Render error caught by ErrorBoundary:", error, info);
  }

  componentDidUpdate(prevProps) {
    // Clear the error when the caller says the situation changed — `resetKey`
    // is the route's location key for the boundary around the page, so simply
    // navigating away puts the app back into a working state with no explicit
    // "try again". Without this, a boundary that has caught once renders its
    // fallback forever: `state.error` is sticky, so the nav links would still
    // be there and still appear to do nothing.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset() {
    // `onReset` runs first so the caller can clear whatever produced the error
    // (TanStack's errored queries) *before* we re-render the children — reset
    // the other way around and the children re-mount onto the same failed
    // query and throw again immediately.
    this.props.onReset?.();
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const Fallback = this.props.fallback;
    return <Fallback error={error} reset={this.reset} />;
  }
}

/**
 * The stack, in development only.
 *
 * Shown under the apology rather than instead of it, so the dev sees the same
 * screen a user would plus the detail. Never in production: a stack trace can
 * carry code paths and identifiers that mean nothing to a family member and
 * everything to someone probing the app, and it reads as "the site is really
 * broken" to the person we were trying to reassure.
 */
function DevDetails({ error }) {
  if (!import.meta.env.DEV) return null;
  return (
    <details className="mt-5 w-full max-w-lg text-left">
      <summary className="cursor-pointer text-xs font-medium text-ink-faint">
        Error details (development only)
      </summary>
      <pre className="mt-2 overflow-x-auto rounded-xl bg-raised p-3 text-[11px] leading-relaxed text-ink-soft">
        {error?.stack || String(error)}
      </pre>
    </details>
  );
}

/**
 * The fallback for a crash inside a page, with the app shell still around it.
 *
 * "Try again" is offered first because it usually works: most render errors of
 * this shape come from one bad piece of data in one query, and a reset that
 * re-runs the query lands on a good response. "Back to the feed" is the honest
 * second option — a `Link`, so it's a normal client-side navigation, which also
 * trips the `resetKey` change above.
 */
function PageErrorFallback({ error, reset }) {
  return (
    <div className="flex flex-col items-center px-5 py-16 text-center">
      <h1 className="font-display text-lg font-bold tracking-tight text-ink">
        Something went wrong on this page
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-soft">
        Nothing you did caused this, and nothing you’ve posted is affected. Try
        again, or head back to your feed.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link to="/" className="btn btn-ghost">
          Back to the feed
        </Link>
      </div>
      <DevDetails error={error} />
    </div>
  );
}

/**
 * The fallback for a crash inside a companion drawer (Messages, Groups).
 *
 * **Why this one is positioned, when the page fallback isn't.** The drawers
 * portal to `<body>`; the fallback that replaces one does not, because it's
 * rendered by the boundary, which sits back in the normal tree at the bottom of
 * `Layout`. In flow it would land under the footer, off the bottom of a long
 * feed, where nobody would ever see it. So it places itself — a small card
 * pinned above the app, at the same `z-40` the drawers use.
 *
 * **Why "Reload" and not "Close".** Closing the drawer is the obvious action
 * and the one we can't safely offer: `MessagingProvider.close()` deliberately
 * *refuses* while a write is in flight (#258), and a drawer that crashed
 * mid-write would hold that refusal forever, sealing the reader inside a dead
 * panel — the exact trap #258 exists to prevent, reintroduced by the thing
 * meant to rescue them. A full page load can't be refused by anything.
 */
function PanelErrorFallback({ error, reset }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-sm rounded-2xl border border-line bg-raised p-4 text-center shadow-[0_10px_40px_-20px_rgba(28,26,22,0.5)]"
    >
      <p className="text-sm font-semibold text-ink">
        Something went wrong in this panel
      </p>
      <p className="mt-1.5 text-sm text-ink-soft">
        The rest of the app is fine. Nothing you’ve sent is affected.
      </p>
      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={reset} className="btn btn-primary btn-sm">
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          className="btn btn-ghost btn-sm"
        >
          Reload TimeLine
        </button>
      </div>
      <DevDetails error={error} />
    </div>
  );
}

/**
 * A boundary that resets on navigation and knows about TanStack Query.
 *
 * Two pieces beyond the bare class:
 *
 *   1. **`QueryErrorResetBoundary`** — a query that threw during render (or one
 *      using `throwOnError`) stays errored in the cache. Resetting the boundary
 *      alone would re-mount the children onto that same cached error and throw
 *      straight back, so "Try again" would look broken. `reset()` from this
 *      context clears the errored queries first; wiring it to `onReset` is what
 *      makes the button re-*run* the request rather than re-render the failure.
 *   2. **`location.key`** — changes on every navigation, including back/forward
 *      and a repeat visit to the same URL. Handing it in as `resetKey` means
 *      going anywhere else clears the error, which is the whole point of
 *      keeping the nav alive.
 *
 * `variant` picks the fallback: `"page"` (default) for the router outlet,
 * `"panel"` for a drawer.
 */
export function RouteErrorBoundary({ children, variant = "page" }) {
  const location = useLocation();
  const fallback = variant === "panel" ? PanelErrorFallback : PageErrorFallback;
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          fallback={fallback}
          onReset={reset}
          resetKey={location.key}
        >
          {children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

/**
 * The last line: a crash *outside* any route — in a provider, in the router
 * itself, or on one of the public pages (login, sign-up, the legal pages) that
 * render outside `Layout` and so have no shell to keep alive.
 *
 * Mounted in `main.jsx` **inside** `QueryClientProvider` but **outside**
 * `BrowserRouter`, which is what shapes this fallback:
 *
 *   - It can't use `Link` or any router hook — there's no router above it, and
 *     if the crash *was* the router then reaching for one would throw inside
 *     the fallback, which React treats as unrecoverable.
 *   - So recovery is a full page load, not a reset. That is the right tool
 *     anyway: at this level we don't know what state is bad, and reloading
 *     clears all of it. `assign("/")` rather than `reload()` deliberately —
 *     if the crash is specific to the current URL, reloading it reproduces the
 *     crash and the button looks broken, while going home almost always works.
 *
 * It renders its own centred layout with the app's tokens (it is inside no
 * shell) but stays deliberately plain — see the note on fallbacks that throw.
 */
function AppErrorFallback({ error }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 py-16 text-center">
      <h1 className="font-display text-xl font-bold tracking-tight text-ink">
        TimeLine hit a problem
      </h1>
      <p className="mt-2 max-w-sm text-sm text-ink-soft">
        Something went wrong while loading the app. Your account and everything
        in it are fine — reloading usually clears it.
      </p>
      <button
        type="button"
        onClick={() => window.location.assign("/")}
        className="btn btn-primary mt-5"
      >
        Reload TimeLine
      </button>
      <DevDetails error={error} />
    </div>
  );
}

export function AppErrorBoundary({ children }) {
  return <ErrorBoundary fallback={AppErrorFallback}>{children}</ErrorBoundary>;
}
