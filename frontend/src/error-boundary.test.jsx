import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { AppErrorBoundary } from "./components/ErrorBoundary.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { allowConsoleError, consoleErrors } from "../test/console-guard.js";

// Issue #299: before this, a render error anywhere unmounted the whole React
// tree and left a blank white page — no message, no nav, no way back except the
// reader thinking to reload. These tests pin the two things the boundaries buy,
// because both are invisible until something throws:
//
//   1. the *shell survives* — a crash in one surface leaves the rest standing;
//   2. the error *clears* — and clears on the thing that actually fixes it,
//      which is different for a page (navigate away) and a panel (close it).
//
// A test that only asserted the apology text would pass against a boundary
// wrapped around the whole app, which is the thing we're avoiding. So every case
// checks what is *still on screen* next to the apology.

vi.mock("./api.js", () => ({
  api: { getUnreadMessageCount: vi.fn().mockResolvedValue({ count: 0 }) },
  CONVERSATION_LIST_POLL_MS: 60_000,
}));

// Nav furniture. ActivityCenter can be made to throw: it's the piece of chrome
// that renders arbitrary server data, and it lives *above* `<main>`, so it's the
// reason the header needed a boundary of its own.
let bellThrows = false;
vi.mock("./components/ActivityCenter.jsx", () => ({
  default: () => {
    if (bellThrows) throw new Error("bell exploded");
    return <div>activity bell</div>;
  },
}));
vi.mock("./components/NavUserMenu.jsx", () => ({
  default: () => <div>user menu</div>,
}));

// The drawers' open state is read by Layout to key their boundaries, so the
// tests drive it the way the nav buttons do. It has to be a real subscription,
// not a module-level `let`: toggling a plain variable doesn't re-render Layout,
// so the boundary would never see the new key and the test would "pass" against
// a version that ignores it.
let messagesOpen = false;
const openListeners = new Set();
function setMessagesOpen(value) {
  messagesOpen = value;
  openListeners.forEach((fn) => fn());
}
vi.mock("./messaging.jsx", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useMessaging: () => ({
      isOpen: useSyncExternalStore(
        (fn) => {
          openListeners.add(fn);
          return () => openListeners.delete(fn);
        },
        () => messagesOpen
      ),
      isWriting: false,
      close: () => true,
      toggle: () => setMessagesOpen(!messagesOpen),
    }),
  };
});
vi.mock("./groups-drawer.jsx", () => ({
  useGroupsDrawer: () => ({
    isOpen: false,
    close: () => {},
    toggle: () => {},
  }),
}));

// Stands in for a companion drawer, including the part that matters to the
// boundary: like the real one, it renders *nothing* when closed. That's what
// makes closing a crashed drawer a real recovery rather than a reset straight
// back into the same throw.
let drawerThrows = false;
vi.mock("./components/MessagesDrawer.jsx", () => ({
  default: () => {
    if (!messagesOpen) return null;
    if (drawerThrows) throw new Error("drawer exploded");
    return <div>messages drawer</div>;
  },
}));
vi.mock("./components/GroupsDrawer.jsx", () => ({
  default: () => <div>groups drawer</div>,
}));

// A page that throws while the flag is set. Deliberately a flag rather than a
// "throw the first N renders" counter: React retries a failed *concurrent*
// render synchronously before handing the error to a boundary, so a counter of
// 1 is spent on that retry and the boundary never sees the error at all. The
// flag models the real thing better anyway — a page is broken until whatever
// made it broken (usually one bad cached response) changes.
let pageThrows = false;
function Boom() {
  if (pageThrows) throw new Error("page exploded");
  return <p>feed content</p>;
}

// What the boundary itself logged, as opposed to what React logged. React 19
// reports every caught error through its own `console.error` *before* the
// boundary does, so a bare "something was logged" check passes even with
// `componentDidCatch` deleted — a vacuous assertion for the one property it was
// written to pin. Counting our own message is what makes it real, and it
// doubles as a catch-counter for the tests below that care how many times a
// crash was caught.
function boundaryLogs() {
  return consoleErrors().filter((text) =>
    text.startsWith("Render error caught by ErrorBoundary:")
  ).length;
}

function renderApp() {
  renderWithAuth(
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Boom />} />
        <Route path="people" element={<p>people content</p>} />
      </Route>
    </Routes>
  );
}

beforeEach(() => {
  pageThrows = false;
  drawerThrows = false;
  bellThrows = false;
  setMessagesOpen(false);
  // Every test in this file makes something throw on purpose, so both reports a
  // caught error produces — React's and the boundary's own — are expected here.
  // Named rather than swallowed with a blanket `vi.spyOn(console, "error")`:
  // that would exempt the file from the console guard entirely (#357/#360), and
  // the one file about crashes is the last one that should stop noticing an
  // act() violation or a bad prop. Anything else logged still fails the test;
  // `boundaryLogs()` reads these back rather than a spy.
  allowConsoleError(
    "Render error caught by ErrorBoundary:",
    /The above error occurred in/
  );
});

describe("a page that throws", () => {
  it("keeps the app shell alive instead of blanking the screen", () => {
    pageThrows = true;
    renderApp();

    expect(
      screen.getByText(/Something went wrong on this page/i)
    ).toBeInTheDocument();
    // The point of the whole exercise: the nav is still there to leave by.
    expect(screen.getByRole("link", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toBeInTheDocument();
    expect(boundaryLogs()).toBe(1);
  });

  it("announces itself rather than silently swapping the content", () => {
    pageThrows = true;
    renderApp();

    // Without a live region and a focus move, a crash is *silent* to a screen
    // reader: focus was on an element that no longer exists, so it drops to
    // <body> with nothing announced — the audio spelling of the blank page.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Something went wrong on this page/i);
    expect(
      screen.getByRole("heading", { name: /Something went wrong on this page/i })
    ).toHaveFocus();
  });

  it("catches once when the crash is reached by navigating", async () => {
    renderApp();
    expect(screen.getByText("feed content")).toBeInTheDocument();
    pageThrows = true;

    await userEvent.click(screen.getByRole("link", { name: "People" }));
    await userEvent.click(screen.getByRole("link", { name: "Feed" }));

    // The boundary latches the reset key *at the moment it catches*. Comparing
    // against the last committed props instead would see the pre-navigation key,
    // read that as "the situation changed", reset immediately, and render the
    // broken page a second time before settling — so almost every real crash
    // (they're nearly all reached by clicking something) would run its subtree
    // and its effects twice.
    expect(boundaryLogs()).toBe(1);
  });

  it("clears itself when you navigate away", async () => {
    pageThrows = true;
    renderApp();
    expect(screen.getByText(/Something went wrong on this page/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "People" }));

    // Without the location-key reset the caught error is sticky, so the nav
    // would still be on screen and still appear to do nothing — arguably worse
    // than the blank page, because it looks like it's working.
    expect(screen.getByText("people content")).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it("recovers in place when Try again works", async () => {
    pageThrows = true;
    renderApp();
    expect(screen.getByText(/Something went wrong on this page/i)).toBeInTheDocument();

    // The common real case: the thing that made the page throw has gone (the
    // reset dropped the cached response behind it).
    pageThrows = false;
    await userEvent.click(screen.getByRole("button", { name: /Try again/i }));

    expect(screen.getByText("feed content")).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it("stays on the fallback when Try again doesn't help", async () => {
    pageThrows = true;
    renderApp();

    await userEvent.click(screen.getByRole("button", { name: /Try again/i }));

    // Re-catching rather than escaping to the root boundary is what keeps this
    // a broken page: the nav is still there after a failed retry.
    expect(screen.getByText(/Something went wrong on this page/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Feed" })).toBeInTheDocument();
  });

  it("does something when Back to the feed is pressed on the broken feed", async () => {
    pageThrows = true;
    renderApp();

    pageThrows = false;
    await userEvent.click(screen.getByRole("button", { name: /Back to the feed/i }));

    // As a bare `<Link to="/">` this was inert when the crashed page *was* the
    // feed: it re-rendered the same page against the same cache, threw again,
    // and pushed a history entry each time it looked like it had done nothing.
    // It resets first now, so it recovers rather than looking broken.
    expect(screen.getByText("feed content")).toBeInTheDocument();
  });
});

describe("a falsy thrown value", () => {
  it("still shows the fallback rather than looping", () => {
    // `throw undefined` is legal, and reachable from rethrown non-Error values
    // or third-party code. When the thrown value doubled as the has-error flag,
    // the boundary decided it had no error, rendered the children again, caught
    // again, and looped until React gave up and unmounted the root — delivering
    // the blank page this whole thing exists to prevent.
    function ThrowsUndefined() {
      throw undefined;
    }
    render(
      <AppErrorBoundary>
        <ThrowsUndefined />
      </AppErrorBoundary>
    );

    expect(screen.getByText(/TimeLine hit a problem/i)).toBeInTheDocument();
  });
});

describe("a companion drawer that throws", () => {
  it("doesn't take the page down with it", () => {
    setMessagesOpen(true);
    drawerThrows = true;
    renderApp();

    // A portal escapes the DOM tree but not the React tree, so a drawer crash
    // would otherwise sail past the outlet's boundary to the root one and blank
    // the app from a panel. Its own boundary is what stops that.
    expect(screen.getByText("feed content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Something went wrong in this panel/i
    );
    // And the *other* drawer is unaffected — one boundary each, not one shared.
    expect(screen.getByText("groups drawer")).toBeInTheDocument();
  });

  it("clears when the drawer is closed from the nav", async () => {
    setMessagesOpen(true);
    drawerThrows = true;
    renderApp();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Messages/i }));

    // Keyed on the drawer's own open state, not `location.key`. The drawer's ✕
    // and its Escape handler died with the subtree, so the nav button is the
    // only way to close it — and when the key was the route's, closing cleared
    // nothing and left a fixed, undismissable card pinned over the app,
    // describing a panel that was no longer open.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("doesn't re-throw every time you navigate the page behind it", async () => {
    setMessagesOpen(true);
    drawerThrows = true;
    renderApp();
    expect(boundaryLogs()).toBe(1);

    await userEvent.click(screen.getByRole("link", { name: "People" }));

    // Navigating changes nothing about why the drawer threw — same `view`, same
    // conversation, the router never touched either. On `location.key` this
    // reset the boundary on every click, re-mounted the broken drawer,
    // re-threw, re-logged, and re-presented the card on each new page as if it
    // were a fresh failure.
    expect(screen.getByText("people content")).toBeInTheDocument();
    expect(boundaryLogs()).toBe(1);
  });
});

describe("the nav's data-driven furniture", () => {
  it("doesn't blank the app when the activity bell throws", () => {
    bellThrows = true;
    renderApp();

    // The bell renders above `<main>`, so it was outside every boundary: one bad
    // notification page took the entire app down through the root boundary,
    // from the one piece of chrome that renders arbitrary server data.
    expect(screen.getByText("feed content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Feed" })).toBeInTheDocument();
    // The menu beside it keeps working — one boundary each.
    expect(screen.getByText("user menu")).toBeInTheDocument();
    expect(
      screen.getByRole("alert", { name: /menu bar stopped working/i })
    ).toBeInTheDocument();
  });
});

describe("the root boundary", () => {
  it("offers a reload when there's no shell left to keep", () => {
    function Exploding() {
      throw new Error("provider exploded");
    }
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>
    );

    expect(screen.getByText(/TimeLine hit a problem/i)).toBeInTheDocument();
    // A full page load, not a router navigation: this boundary sits *outside*
    // BrowserRouter so it can survive a crash in the router itself, which means
    // it has no router to navigate with.
    expect(
      screen.getByRole("button", { name: /Reload TimeLine/i })
    ).toBeInTheDocument();
    expect(boundaryLogs()).toBe(1);
  });
});
