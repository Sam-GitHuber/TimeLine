import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { AppErrorBoundary } from "./components/ErrorBoundary.jsx";
import {
  allowConsoleError,
  unexpectedConsoleErrors,
} from "../test/console-guard.js";

// Issues #357/#360: the error boundaries (#299, merged in #356) quietly took a
// safety net away. A render throw used to propagate out of RTL's `render()` and
// fail the test; caught, it renders a fallback and logs instead, and the test
// carries on against a subtree that rendered *nothing* — so every absence
// assertion around it passes for the wrong reason.
//
// These tests are the guard's own coverage, and they have to make errors happen
// on purpose. So each one reads `unexpectedConsoleErrors()` *before* allowing
// anything — that list is exactly what would have failed the test — and only
// then calls `allowConsoleError` to let itself pass.

function Boom() {
  throw new Error("page exploded");
}

describe("a caught render error", () => {
  it("is reported to the harness instead of passing silently", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );

    // What the guard would fail this test with, if the test hadn't asked for it.
    const reported = unexpectedConsoleErrors();
    expect(reported.length).toBeGreaterThan(0);
    // The boundary's own report, not only React's — that's the one that exists
    // in production, and the one that carries the component stack.
    expect(
      reported.some((text) =>
        text.startsWith("Render error caught by ErrorBoundary:")
      )
    ).toBe(true);
    // The thrown error travels with it. A failure that named the boundary but
    // not the crash would send the reader looking in the wrong file.
    expect(reported.join("\n")).toContain("page exploded");

    allowConsoleError(/page exploded/);
  });

  it("is why an absence assertion around it can't be trusted on its own", () => {
    render(
      <AppErrorBoundary>
        <Boom />
        <p>page content</p>
      </AppErrorBoundary>
    );

    // The whole point of the issue, in three lines: the crashed subtree renders
    // nothing, so this passes — and would pass just as happily against a page
    // that had broken for real. Before the boundaries the `render()` above threw
    // and the test never got here.
    expect(screen.queryByText("page content")).toBeNull();
    expect(screen.getByText(/TimeLine hit a problem/i)).toBeInTheDocument();
    expect(unexpectedConsoleErrors().length).toBeGreaterThan(0);

    allowConsoleError(/page exploded/);
  });
});

describe("an error logged while unmounting", () => {
  // This pair pins the hook order. RTL's automatic `cleanup` unmounts after the
  // test body, and the guard's `afterEach` has to run *after* that or an error
  // raised on the way out belongs to nobody. Vitest unwinds `afterEach` in
  // reverse registration order, and the guard registers first (from
  // `test/setup.js`), so it unwinds last.
  it("is caught by the test that mounted the component", () => {
    function LogsOnUnmount() {
      useEffect(() => () => console.error("unmount exploded"), []);
      return <p>mounted</p>;
    }
    render(<LogsOnUnmount />);
    expect(screen.getByText("mounted")).toBeInTheDocument();

    // Nothing yet — the component is still mounted. The allowance is what makes
    // this test pass, and it can only work if the check happens after cleanup.
    expect(unexpectedConsoleErrors()).toEqual([]);
    allowConsoleError("unmount exploded");
  });

  it("and doesn't spill into the next test", () => {
    // If the order above ever inverts, the previous test's unmount lands here
    // instead — against this test's empty allowance list — and this fails rather
    // than the error being dropped.
    expect(unexpectedConsoleErrors()).toEqual([]);
  });
});

describe("the allowance", () => {
  it("matches on a substring or a pattern, and only what it names", () => {
    console.error("expected: %s", new Error("wanted"));
    console.error("also expected");
    console.error("not expected");

    allowConsoleError(/wanted/, "also expected");

    // The unrelated one is still reported, so an allowance can't quietly cover a
    // real crash that happens alongside the one a test asked for.
    expect(unexpectedConsoleErrors()).toEqual(["not expected"]);

    allowConsoleError("not expected");
  });
});
