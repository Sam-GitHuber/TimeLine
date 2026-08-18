// Make a caught render error fail the test that caused it (issues #357, #360).
//
// Before the error boundaries (#299, merged in #356), a render throw inside a
// page or a drawer propagated straight out of RTL's `render()` / `userEvent`
// and failed the test. Nobody wrote that safety net, but it was one: any
// regression that made a component throw took the suite red.
//
// The boundaries took it away. A caught error renders a fallback and writes to
// `console.error`, and the test carries on — against a subtree that rendered
// *nothing*. So every "this shouldn't be on screen" assertion around it passes
// vacuously, and the two suites that render the whole `App`
// (`messaging.test.jsx`, `App.test.jsx`) are precisely the ones that would go
// green while the app was visibly broken.
//
// **Why `console.error` and not a React `onCaughtError` handler.** The narrower
// option only fires for boundary-caught errors, but it has to be passed to each
// `createRoot`, which means every `render()` call site in the repo. Going
// through the console catches the same crashes plus the rest of what React
// reports that way — act() violations, invalid props, duplicate keys — from one
// place, and needs nothing of the tests.
//
// **Why not `console.warn` too.** Everything React says about a broken render
// goes to `console.error`; `console.warn` in this stack is third-party
// deprecation notices, which shouldn't fail a suite. Warnings are left to the
// terminal.
//
// **Why capture-then-assert rather than throwing inside `console.error`.**
// Throwing there raises at an arbitrary point inside React's rendering, which
// React may itself catch — the guard would be swallowed by the very boundary
// it's reporting on. Collecting and failing in `afterEach` reports the whole
// list, attributed to the test that caused it, with the app's stack intact.
//
// **Why the messages are buffered rather than passed through to the terminal.**
// Every `console.error` in this suite is now one of two things: a failure, whose
// full text (stacks included) goes into the thrown message below, or one a test
// asked for by name, which is noise. Printing the second kind is what pushed
// `error-boundary.test.jsx` into swallowing the console wholesale — and a
// blanket `mockImplementation(() => {})` hides React's warnings too, which is
// the hole this guard exists to close. The cost is that a test which never
// finishes (a timeout) takes its buffer with it.
import { beforeEach, afterEach, afterAll } from "vitest";
import { format } from "node:util";

let captured = [];
let allowances = [];

/**
 * Render one `console.error(...)` call as the single string a console would
 * have shown.
 *
 * Node's `format` rather than a hand-rolled join, for two reasons: it expands
 * the `%s`/`%o` placeholders React's own reports are written with (joining the
 * arguments leaves a literal `"%o\n\n%s"` and drops the message into the
 * wrong place), and it prints an `Error` with its stack. The stack is the whole
 * value of failing here — the boundary logs
 * `("Render error caught by ErrorBoundary:", error, info)`, and without it the
 * failure names a boundary rather than the component that broke.
 */
function formatCall(args) {
  return format(...args);
}

function isAllowed(text) {
  return allowances.some((matcher) =>
    matcher instanceof RegExp ? matcher.test(text) : text.includes(matcher)
  );
}

/**
 * Let this test log `console.error` without failing.
 *
 * For tests whose subject *is* a caught error — `error-boundary.test.jsx` makes
 * components throw on purpose and asserts on what was logged. The allowance is
 * cleared before every test, so it can't leak into the next one.
 *
 * Keep matchers specific: a broad one (`/./`) re-opens the hole this closes for
 * the whole file.
 *
 * @param {...(string|RegExp)} matchers substring or pattern the message must match
 */
export function allowConsoleError(...matchers) {
  allowances.push(...matchers);
}

/** Everything logged so far in this test, allowed or not, as formatted strings. */
export function consoleErrors() {
  return [...captured];
}

/** What the current test has logged and not allowed, as formatted strings. */
export function unexpectedConsoleErrors() {
  return captured.filter((text) => !isAllowed(text));
}

/**
 * Wrap `console.error` and fail any test that reaches it. Called once, from
 * `test/setup.js`.
 *
 * A test that replaces `console.error` outright
 * (`vi.spyOn(...).mockImplementation()`) opts itself out entirely for as long as
 * the spy is installed, warnings and all. `allowConsoleError` is the one to
 * reach for instead: it names what's expected, still reads back what was
 * logged, and leaves everything else failing.
 */
export function installConsoleGuard() {
  console.error = (...args) => {
    captured.push(formatCall(args));
  };

  // Allowances are per-test; the captured list deliberately is not. Vitest
  // unwinds `afterEach` in reverse registration order (`sequence.hooks:
  // "stack"`), so installing here — before any test file imports
  // `@testing-library/react` — puts this hook *after* RTL's automatic
  // `cleanup`, and an error thrown while unmounting is caught by the test that
  // mounted it. Carrying the list across the boundary anyway means that if that
  // order ever changes, a late error is reported against the following test
  // rather than silently dropped. `console-guard.test.jsx` pins it.
  beforeEach(() => {
    allowances = [];
  });

  afterEach(() => {
    check("during this test");
  });

  // Anything logged after the last test's `afterEach` — a late unmount, a
  // resolved promise nobody awaited — would otherwise have no hook left to
  // report it.
  afterAll(() => {
    check("after the last test in this file");
  });
}

function check(when) {
  const unexpected = unexpectedConsoleErrors();
  // Cleared before the throw, not after it: a hook that throws doesn't reach
  // its own tail, and the leftovers would be reported all over again.
  captured = [];
  if (unexpected.length === 0) return;
  throw new Error(
    `console.error was called ${unexpected.length} time(s) ${when}.\n` +
      "A caught render error renders nothing, so absence assertions around it " +
      "pass vacuously — see docs/reference/error-boundaries.md.\n" +
      "If the error is the point of the test, call allowConsoleError(...) from " +
      "test/console-guard.js.\n\n" +
      unexpected.map((text, i) => `[${i + 1}] ${text}`).join("\n\n")
  );
}
