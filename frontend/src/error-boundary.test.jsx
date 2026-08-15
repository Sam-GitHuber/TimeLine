import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import { AppErrorBoundary } from "./components/ErrorBoundary.jsx";
import { renderWithAuth } from "./test-utils.jsx";

// Issue #299: before this, a render error anywhere unmounted the whole React
// tree and left a blank white page — no message, no nav, no way back except
// the reader thinking to reload. These tests pin the two things the boundaries
// buy, because both are invisible until something throws:
//
//   1. the *shell survives* — a crash in a page leaves the nav and footer
//      standing, so leaving is possible without a reload;
//   2. the error *clears* — on navigation, and on "Try again".
//
// A test here that only asserted the apology text would pass against a
// boundary wrapped around the whole app, which is the thing we're avoiding. So
// every case below checks what is *still on screen* next to the apology.

vi.mock("./api.js", () => ({
  api: { getUnreadMessageCount: vi.fn().mockResolvedValue({ count: 0 }) },
  CONVERSATION_LIST_POLL_MS: 60_000,
}));

// Nav furniture that fetches or opens menus of its own — not what's under test.
vi.mock("./components/ActivityCenter.jsx", () => ({ default: () => null }));
vi.mock("./components/NavUserMenu.jsx", () => ({ default: () => null }));

vi.mock("./messaging.jsx", () => ({
  useMessaging: () => ({
    isOpen: false,
    isWriting: false,
    close: () => true,
    toggle: () => {},
  }),
}));
vi.mock("./groups-drawer.jsx", () => ({
  useGroupsDrawer: () => ({ isOpen: false, open: () => {}, close: () => {}, toggle: () => {} }),
}));

// The messages drawer stands in for "a companion drawer", so one test can make
// it throw. It portals in the real app; the mock doesn't need to, because what
// matters is only that it renders inside Layout's React tree.
let drawerThrows = false;
vi.mock("./components/MessagesDrawer.jsx", () => ({
  default: () => {
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

function renderApp() {
  return renderWithAuth(
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Boom />} />
        <Route path="people" element={<p>people content</p>} />
      </Route>
    </Routes>
  );
}

let consoleError;

beforeEach(() => {
  pageThrows = false;
  drawerThrows = false;
  // The boundary logs every catch on purpose (it's the only trace that exists
  // in production — there's no error-reporting service). Swallow it here so a
  // passing suite isn't full of red stacks, but assert it happened: a boundary
  // that caught *silently* would be a downgrade on the blank page it replaced,
  // which still left React's own report in the console.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("a page that throws", () => {
  it("keeps the app shell alive instead of blanking the screen", async () => {
    pageThrows = true;
    renderApp();

    expect(
      screen.getByText(/Something went wrong on this page/i)
    ).toBeInTheDocument();
    // The point of the whole exercise: the nav is still there to leave by.
    expect(screen.getByRole("link", { name: "Feed" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
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

    // The common real case: the thing that made the page throw has gone (a
    // refetch returned a sane shape), and the reader would rather stay here
    // than navigate out and back.
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
});

describe("a companion drawer that throws", () => {
  it("doesn't take the page down with it", () => {
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
  });
});
