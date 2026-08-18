// Fail a test that reaches `console.error` or `console.warn` (issues #357/#360).
//
// The reasoning — what the error boundaries took away, why the console rather
// than React's `onCaughtError`, why messages are buffered instead of printed —
// is in `docs/reference/error-boundaries.md`. Kept here: the whys that only make
// sense next to the line they explain.
import { beforeEach, afterEach, afterAll } from "vitest";
import { format } from "node:util";

// Both levels, because React uses both: a *caught* render error is reported
// through `console.error` (`defaultOnCaughtError`), but an *uncaught* one —
// which is what a page rendered bare in a test still produces, `auth.test.jsx`
// being the case in point — advises through `console.warn`
// (`defaultOnUncaughtError` in `react-dom-client.development.js`). Guarding only
// the first would leave the second silent.
const LEVELS = ["error", "warn"];

/** `{ level, text }` for every call so far in this test, allowed or not. */
let captured = [];
let allowances = [];
let installed = false;

function isAllowed(text) {
  return allowances.some((matcher) => {
    if (typeof matcher === "string") return text.includes(matcher);
    // `/g` and `/y` make `test()` resume from `lastIndex`, so the same matcher
    // would match one message and skip the next — and a single caught error
    // produces two. The matcher belongs to the caller, so reset rather than
    // assume they knew.
    matcher.lastIndex = 0;
    return matcher.test(text);
  });
}

function unexpected() {
  return captured.filter((entry) => !isAllowed(entry.text));
}

/**
 * Let this test log console output matching `matchers` without failing.
 *
 * For tests whose subject *is* a failure — `error-boundary.test.jsx` makes
 * components throw on purpose — and for a third-party deprecation warning
 * that's been looked at and judged not ours. Cleared after every test.
 *
 * **Register it in a `beforeEach` or an `afterEach`, not at the end of the test
 * body.** As the body's last statement it is skipped when an earlier assertion
 * fails, and the guard then stacks a second, misleading failure on top of the
 * real one.
 *
 * Matchers are deliberately checked: `allowConsole("")` would match every
 * message and silently disable the guard for that test, which is the hole this
 * module exists to close, reopened by a typo.
 *
 * @param {...(string|RegExp)} matchers substring or pattern the message must match
 */
export function allowConsole(...matchers) {
  for (const matcher of matchers) {
    const usable =
      matcher instanceof RegExp ||
      (typeof matcher === "string" && matcher.length > 0);
    if (!usable) {
      throw new TypeError(
        "allowConsole expects a non-empty string or a RegExp, got " +
          format("%o", matcher)
      );
    }
  }
  allowances.push(...matchers);
}

/** Everything logged so far in this test, allowed or not, as formatted strings. */
export function consoleMessages() {
  return captured.map((entry) => entry.text);
}

/** What this test has logged and not allowed, as formatted strings. */
export function unexpectedConsoleMessages() {
  return unexpected().map((entry) => entry.text);
}

/**
 * Wrap the console and fail any test that reaches it. Called once, from
 * `test/setup.js`.
 *
 * A test that replaces `console.error` outright
 * (`vi.spyOn(...).mockImplementation()`) opts itself out entirely for as long as
 * the spy is installed, warnings and all. `allowConsole` is the one to reach for
 * instead: it names what's expected, still reads back what was logged, and
 * leaves everything else failing.
 *
 * Not written for `test.concurrent` — the buffer is one shared list, so
 * concurrent tests in a file would cross-attribute each other's output and
 * cross-apply each other's allowances. There are none in this repo.
 */
export function installConsoleGuard() {
  // Calling twice would register a second set of hooks, and the first pair's
  // `check` would clear the buffer before the second pair read it.
  if (installed) return;
  installed = true;

  for (const level of LEVELS) {
    console[level] = (...args) => {
      captured.push({
        level,
        // `format` rather than joining the arguments: it expands the `%s`/`%o`
        // placeholders React writes its reports with (a join leaves a literal
        // "%o\n\n%s" and strands the message), and prints an `Error` with its
        // stack — which is the whole value of failing here, since the boundary
        // logs `(message, error, info)` and without the stack the failure names
        // a boundary rather than the component that broke.
        //
        // A no-argument call formats to "", which no allowance can match and no
        // reader can act on, so it says what it was instead.
        text: args.length === 0 ? `<console.${level}() with no arguments>` : format(...args),
      });
    };
  }

  beforeEach(() => {
    allowances = [];
  });

  afterEach(() => {
    check("during or before this test");
  });

  // Anything logged after the last test's `afterEach` — a late unmount, a
  // resolved promise nobody awaited — would otherwise have no hook left to
  // report it.
  afterAll(() => {
    check("after the last test in this file");
  });
}

function check(when) {
  const leftover = unexpected();
  // Both cleared before the throw, not after it: a hook that throws doesn't
  // reach its own tail. Leaving the buffer would report everything twice, and
  // leaving the allowances would let the last test's allowance absorb an error
  // raised after it finished — which is precisely what the `afterAll` above
  // exists to catch.
  captured = [];
  allowances = [];
  if (leftover.length === 0) return;
  throw new Error(
    `The console was called ${leftover.length} time(s) ${when}.\n` +
      "A caught render error renders nothing, so absence assertions around it " +
      "pass vacuously — see docs/reference/error-boundaries.md.\n" +
      "If the output is the point of the test, call allowConsole(...) from " +
      "test/console-guard.js in a beforeEach.\n\n" +
      leftover
        .map((entry, i) => `[${i + 1}] console.${entry.level}: ${entry.text}`)
        .join("\n\n")
  );
}
