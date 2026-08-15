import { Component, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

/**
 * What the app does when a render throws (issue #299).
 *
 * The full story — why boundaries at all, where each one sits, what a boundary
 * doesn't catch — lives in `docs/reference/error-boundaries.md`. Kept here: the
 * *why*s that only make sense next to the line they explain.
 *
 * **Why a class.** `getDerivedStateFromError` / `componentDidCatch` are the only
 * API React exposes for catching a render error, and both are class-only. This
 * is the one class component in the codebase, and it stays as small as possible:
 * the fallback UI is a plain function component passed in.
 *
 * **Why the fallbacks are dumb.** An error thrown by a boundary's *own* fallback
 * is not caught by that boundary — React escalates it to the next one up, or
 * unmounts the root. So the fallbacks below read no application data and call no
 * API; the only thing they touch is the router, and only where one exists.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    // `hasError` is a separate flag rather than a truthiness check on `error`,
    // because the thrown value is whatever the thrower chose. `throw undefined`
    // (or null, or "") is legal and does happen — rethrown non-Error values,
    // third-party code — and if the flag *were* the payload, the boundary would
    // decide it had no error, render the children again, catch again, and loop
    // until React gave up and unmounted the root. That is the blank page this
    // file exists to prevent, reached by the file itself.
    this.state = { hasError: false, error: null, keyAtCatch: undefined };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  /**
   * Remember the reset key from the last *healthy* render, which is the key that
   * was current when the children threw.
   *
   * This is here rather than in `componentDidCatch` (where `this.props` still
   * holds the previously committed props) or in `componentDidUpdate`'s
   * `prevProps` (same problem) because both read the key from *before* the
   * navigation. A crash reached by clicking a link commits the new
   * `location.key` in the very render that throws, so either of those would
   * compare old-vs-new, read it as "the situation changed", reset immediately,
   * and render the broken page a second time before settling on the fallback.
   * Measured: 1 catch on a crash at mount, 2 when navigating into one — and
   * arriving by clicking something is how nearly every real crash is reached,
   * so that was most crashes running their subtree and effects twice.
   *
   * The boundary renders before its children do, so on the throwing pass this
   * has already stored the new key; once `hasError` is set it holds still.
   */
  static getDerivedStateFromProps(props, state) {
    return state.hasError ? null : { keyAtCatch: props.resetKey };
  }

  componentDidCatch(error, info) {
    // Logged in every build, on purpose. Catching an error means React stops
    // reporting it itself, so a boundary that caught silently would be a
    // *downgrade* on the blank page it replaced — that at least left React's own
    // report in the console. In production this is the only trace that exists:
    // there's no error-reporting service (privacy-first — see docs/SHARED.md).
    console.error("Render error caught by ErrorBoundary:", error, info);
  }

  componentDidUpdate() {
    // Clear the error when the caller says the situation changed. What counts as
    // "changed" is the caller's to decide — the route's location key for a page,
    // the drawer's own open state for a panel — because the wrong key here is
    // worse than none: it resets a boundary whose subtree is about to throw
    // again for exactly the same reason.
    if (this.state.hasError && this.state.keyAtCatch !== this.props.resetKey) {
      this.reset();
    }
  }

  reset() {
    // `onReset` runs first so the caller can clear whatever produced the error
    // before we re-render the children — reset the other way around and they
    // re-mount onto the same poisoned cache entry and throw again immediately.
    this.props.onReset?.();
    this.setState({ hasError: false, error: null, keyAtCatch: undefined });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const Fallback = this.props.fallback;
    return <Fallback error={this.state.error} reset={this.reset} />;
  }
}

/**
 * The stack, in development only.
 *
 * Shown under the apology rather than instead of it, so the dev sees the same
 * screen a user would plus the detail. Never in production: a stack trace means
 * nothing to a family member and reads as "the site is really broken", which is
 * the impression the fallback exists to avoid.
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
 * Focus the fallback's heading when it appears, and mark the region as an alert.
 *
 * Without this a crash is *silent* to a screen reader: React swaps the subtree
 * for the fallback with no announcement, and focus — which was on an element
 * that no longer exists — drops to `<body>`. A blind reader hears nothing and
 * finds themselves at the top of the document with no idea anything happened,
 * which is the audio spelling of the blank white page. The fallbacks are written
 * for people with no context for a failure, so the silent case is the one that
 * matters most.
 */
function useAnnounce() {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/**
 * The fallback for a crash inside a page, with the app shell still around it.
 *
 * Both actions go through `reset`, which drops the cached responses that most
 * likely caused the throw (see `RouteErrorBoundary`). "Back to the feed" is a
 * `navigate`, not a `<Link>`, for that reason: as a bare link it was inert when
 * the crashed page *was* the feed — it would re-render the same page against the
 * same cache, throw again, and push a history entry each time it looked like it
 * had done nothing.
 */
function PageErrorFallback({ error, reset }) {
  const navigate = useNavigate();
  const heading = useAnnounce();
  return (
    <div role="alert" className="flex flex-col items-center px-5 py-16 text-center">
      <h1
        ref={heading}
        tabIndex={-1}
        className="font-display text-lg font-bold tracking-tight text-ink outline-none"
      >
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
        <button
          type="button"
          onClick={() => {
            reset();
            // `replace`, so pressing it on a crashed feed doesn't stack history
            // entries the reader then has to Back through.
            navigate("/", { replace: true });
          }}
          className="btn btn-ghost"
        >
          Back to the feed
        </button>
      </div>
      <DevDetails error={error} />
    </div>
  );
}

/**
 * The fallback for a crash inside a companion drawer (Messages, Groups).
 *
 * **Why it positions itself.** The drawers portal to `<body>`; the fallback that
 * replaces one does not, because it's rendered by the boundary, which sits back
 * in the normal tree at the bottom of `Layout`. In flow it would land under the
 * footer, off the bottom of a long feed, where nobody would see it.
 *
 * **Why it docks to the drawer's own edge** rather than centring: both drawers
 * can be open at once on a wide viewport, and two centred cards at the same
 * `z-40` would sit exactly on top of each other — the second one hiding the
 * first's "Try again" completely.
 *
 * **Why there's no "Close".** Closing is the obvious action and the one we can't
 * offer from here: the drawer's own close chrome was in the subtree that just
 * died, and `MessagingProvider.close()` can refuse while a write is in flight
 * (#258). The nav button closes it instead — and, since this boundary is keyed
 * on the drawer's open state, that also clears this card.
 */
function panelFallbackFor(side) {
  const dock = side === "left" ? "left-3 sm:right-auto" : "right-3 sm:left-auto";
  function PanelErrorFallback({ error, reset }) {
    const heading = useAnnounce();
    return (
      <div
        role="alert"
        className={`fixed inset-x-3 bottom-3 z-40 mx-auto max-w-sm rounded-2xl border border-line bg-raised p-4 text-center shadow-[0_10px_40px_-20px_rgba(28,26,22,0.5)] sm:mx-0 sm:w-[360px] ${dock}`}
      >
        <p
          ref={heading}
          tabIndex={-1}
          className="text-sm font-semibold text-ink outline-none"
        >
          Something went wrong in this panel
        </p>
        <p className="mt-1.5 text-sm text-ink-soft">
          The rest of the app is fine. Nothing you’ve sent is affected — close it
          from the nav, or try again.
        </p>
        <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={reset} className="btn btn-primary btn-sm">
            Try again
          </button>
        </div>
        <DevDetails error={error} />
      </div>
    );
  }
  return PanelErrorFallback;
}

const PANEL_FALLBACKS = {
  left: panelFallbackFor("left"),
  right: panelFallbackFor("right"),
};

/**
 * Drop the cached responses that most plausibly caused a render crash.
 *
 * **`type: "inactive"` is the load-bearing part.** By the time a fallback is on
 * screen, the crashed subtree has unmounted, so *its* queries are the inactive
 * ones — which makes "inactive" a surprisingly precise name for "the data that
 * just killed a screen". Everything still mounted (the nav's unread poll, the
 * page behind a drawer) is left alone, so recovering one surface doesn't blank
 * the ones that were working.
 *
 * The earlier version wired `QueryErrorResetBoundary`'s `reset` here instead,
 * which was **dead wiring**: in TanStack v5 that only flips an `isReset` flag,
 * and the flag is read solely for queries using `suspense` or `throwOnError`.
 * This app uses neither, so "Try again" re-mounted the children onto the exact
 * cached object that had just thrown — guaranteed to fail for the one crash
 * class it was written for. The mobile twin had always done the real thing.
 */
function useCrashReset() {
  const queryClient = useQueryClient();
  return () => queryClient.resetQueries({ type: "inactive" });
}

/**
 * The boundary around the router outlet: resets when you navigate.
 *
 * `location.key` changes on every navigation, including back/forward and a
 * repeat visit to the same URL, so going anywhere else clears the error. Without
 * that a caught error is sticky — the nav would still be on screen and still
 * appear to do nothing, which looks more broken than the blank page did.
 */
export function RouteErrorBoundary({ children }) {
  const location = useLocation();
  const onReset = useCrashReset();
  return (
    <ErrorBoundary
      fallback={PageErrorFallback}
      onReset={onReset}
      resetKey={location.key}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * The boundary around a companion drawer.
 *
 * A separate export rather than a `variant` string on the one above, because the
 * two differ in the thing that matters most — **what counts as the situation
 * changing** — and a string switch made that look like a styling choice. A
 * drawer is not a route: keying it on `location.key` meant the crashed panel
 * re-threw on every navigation of the page *behind* it (a fresh catch, a fresh
 * console report, the card reappearing on each new page), while the one action
 * that genuinely fixes it — closing the drawer — cleared nothing, leaving a
 * fixed, undismissable card describing a panel that was no longer open.
 *
 * So the key is the drawer's own `isOpen`. Closing it from the nav resets the
 * boundary; the children then render, and a closed drawer renders nothing.
 */
export function PanelErrorBoundary({ children, side, isOpen }) {
  const onReset = useCrashReset();
  return (
    <ErrorBoundary
      fallback={PANEL_FALLBACKS[side]}
      onReset={onReset}
      resetKey={isOpen}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * The boundary around the nav's data-driven furniture (the activity bell, the
 * user menu).
 *
 * These render *above* `<main>`, so they were outside every boundary and a throw
 * in one still blanked the whole app through the root — from the one piece of
 * chrome that renders arbitrary server data. `ActivityCenter` is an infinite
 * list over notification rows, which is the same shape as the crash that started
 * #299.
 *
 * The fallback has to be tiny: it sits in a nav bar between other controls, so a
 * card would wreck the layout. It's a single chip that says something is wrong
 * and retries when pressed — the rest of the nav, and the page, keep working.
 *
 * **No `resetKey`.** Unlike a page, this is mounted for the whole session, and
 * nothing about navigating makes a bad notification page good. Resetting on
 * navigation would just re-throw and re-log on every click, which is the trap the
 * drawer boundaries fell into.
 */
function NavErrorFallback({ error, reset }) {
  return (
    <>
      <button
        type="button"
        role="alert"
        onClick={reset}
        title="Something in the menu bar stopped working. Press to try again."
        aria-label="Something in the menu bar stopped working — try again"
        className="rounded-xl px-2 py-1 text-sm font-semibold text-red-600 hover:bg-red-50"
      >
        !
      </button>
      {import.meta.env.DEV && (
        <span className="sr-only">{String(error?.message || error)}</span>
      )}
    </>
  );
}

export function NavErrorBoundary({ children }) {
  const onReset = useCrashReset();
  return (
    <ErrorBoundary fallback={NavErrorFallback} onReset={onReset}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * The last line: a crash *outside* any route — in a provider, in the router
 * itself, or on one of the public pages (login, sign-up, the legal pages) that
 * render outside `Layout` and so have no shell to keep alive.
 *
 * Mounted in `main.jsx` **inside** `QueryClientProvider` but **outside**
 * `BrowserRouter`, which is what shapes this fallback: it can't use `Link` or
 * any router hook, because there is no router above it and if the crash *was*
 * the router then reaching for one would throw inside the fallback. So recovery
 * is a full page load, and `assign("/")` rather than `reload()` — if the crash
 * is specific to the current URL, reloading it reproduces the crash.
 *
 * **Where that reasoning runs out**, honestly: for a signed-out reader whose
 * crash is on `/login`, going home is bounced straight back to `/login` by
 * `ProtectedRoute`, so the button loops. Nothing here can fix a login page that
 * throws deterministically — no button can — but it's worth knowing that this
 * boundary's recovery is best-effort, not a guarantee.
 */
function AppErrorFallback({ error }) {
  const heading = useAnnounce();
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center px-5 py-16 text-center"
    >
      <h1
        ref={heading}
        tabIndex={-1}
        className="font-display text-xl font-bold tracking-tight text-ink outline-none"
      >
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
