import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { AppErrorBoundary } from "./components/ErrorBoundary.jsx";
import {
  allowConsole,
  consoleMessages,
  unexpectedConsoleMessages,
} from "../test/console-guard.js";

// Issues #357/#360: the error boundaries (#299, merged in #356) quietly took a
// safety net away. A render throw used to propagate out of RTL's `render()` and
// fail the test; caught, it renders a fallback and logs instead, and the test
// carries on against a subtree that rendered *nothing* — so every absence
// assertion around it passes for the wrong reason.
//
// These tests are the guard's own coverage, so they have to log on purpose.
// Each one reads `unexpectedConsoleMessages()` in the body — that list is
// exactly what would have failed the test — and the allowance that lets it pass
// is registered in a **hook**, never as the body's last statement. Vitest
// unwinds a file's `afterEach` before the guard's, so an allowance registered
// there is in place even when an assertion above it failed; at the end of the
// body it would be skipped, and a real failure would arrive wearing a second,
// misleading one about the console.

function Boom() {
  throw new Error("page exploded");
}

describe("a caught render error", () => {
  afterEach(() => allowConsole(/page exploded/));

  it("is reported to the harness instead of passing silently", () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );

    const reported = unexpectedConsoleMessages();
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
    expect(unexpectedConsoleMessages().length).toBeGreaterThan(0);
  });
});

describe("an error logged while unmounting", () => {
  // This pair pins the hook order. RTL's automatic `cleanup` unmounts after the
  // test body, and the guard's `afterEach` has to run *after* that or an error
  // raised on the way out belongs to nobody. Vitest unwinds `afterEach` in
  // reverse registration order (`sequence.hooks: "stack"`, pinned in
  // `vite.config.js`), and the guard registers first, so it unwinds last.
  let mounted = false;

  it("is caught by the test that mounted the component", () => {
    function LogsOnUnmount() {
      useEffect(() => () => console.error("unmount exploded"), []);
      return <p>mounted</p>;
    }
    render(<LogsOnUnmount />);
    expect(screen.getByText("mounted")).toBeInTheDocument();
    mounted = true;

    // Nothing yet — the component is still mounted. The allowance below is what
    // makes this pass, and it can only work if the check happens after cleanup.
    expect(unexpectedConsoleMessages()).toEqual([]);
    allowConsole("unmount exploded");
  });

  it("and doesn't spill into the next test", () => {
    // Asserts on the test above having run, so this can't quietly become a
    // no-op if the pair is ever split, filtered by name, or reordered — it is
    // the only test that catches an inverted hook order, and the first of the
    // pair passes either way.
    expect(mounted).toBe(true);
    // If the order inverts, the previous test's unmount lands here instead,
    // against this test's empty allowance list, and this fails rather than the
    // error being dropped.
    expect(unexpectedConsoleMessages()).toEqual([]);
  });
});

describe("the allowance", () => {
  afterEach(() => allowConsole("not expected", "left over"));

  it("matches on a substring or a pattern, and only what it names", () => {
    console.error("expected: %s", new Error("wanted"));
    console.error("also expected");
    console.error("not expected");

    allowConsole(/wanted/, "also expected");

    // The unrelated one is still reported, so an allowance can't quietly cover a
    // real crash that happens alongside the one a test asked for.
    expect(unexpectedConsoleMessages()).toEqual(["not expected"]);
  });

  it("doesn't survive into the next test", () => {
    // The previous test allowed "not expected". If allowances leaked, the same
    // message would be waved through here — and, worse, the guard's `afterAll`
    // would inherit the last test's list and wave through a genuinely orphaned
    // error, which is the one thing that hook exists for.
    console.error("left over");
    expect(unexpectedConsoleMessages()).toEqual(["left over"]);
  });
});

describe("a matcher with the global flag", () => {
  // `/g` and `/y` make `RegExp.test` resume from `lastIndex`, so one matcher
  // matched the first message and skipped the second — and a single caught
  // error produces exactly two (React's report, then the boundary's).
  beforeEach(() => allowConsole(/exploded/g));

  it("matches every message, not every other one", () => {
    console.error("first exploded");
    console.error("second exploded");

    expect(unexpectedConsoleMessages()).toEqual([]);
  });
});

describe("what the guard refuses to accept", () => {
  it("rejects a matcher that would wave everything through", () => {
    // `"".includes` is true of every string, so this would disable the guard for
    // the whole test with no signal at all.
    expect(() => allowConsole("")).toThrow(TypeError);
    expect(() => allowConsole(undefined)).toThrow(TypeError);
  });
});

describe("output that isn't an error", () => {
  afterEach(() => allowConsole("no arguments", "deprecated"));

  it("still reports a call made with no arguments", () => {
    console.error();

    // Formats to "" otherwise, which no allowance can match and no reader can
    // act on.
    expect(consoleMessages()).toEqual(["<console.error() with no arguments>"]);
  });

  it("covers console.warn, which is how React reports an *uncaught* render error", () => {
    console.warn("deprecated: %s", "something");

    expect(unexpectedConsoleMessages()).toEqual(["deprecated: something"]);
  });
});
