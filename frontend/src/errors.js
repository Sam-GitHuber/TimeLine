// Turning a rejected request into something worth showing a person.
//
// Only a rejection the *server* authored carries words written for a human:
// `request()` in api.js raises an `ApiError` holding DRF's `detail` ("You can't
// connect with this person."), and flags it `fromServer`. Two kinds of failure
// are *not* that, and both are common:
//
//   - **A network-level failure never reaches that code at all.** It rejects out
//     of `fetch` itself as a bare `TypeError` whose message is the browser's own
//     ("Failed to fetch" in Chrome, "Load failed" in Safari), which tells nobody
//     what happened or what to do. Being offline is the most likely way any
//     write fails, so that's the message a real user hits first.
//   - **A server error with no readable body** — a 500 rendered as a Django HTML
//     page, say — leaves `firstErrorMessage` nothing to pull out, so api.js
//     synthesizes "Request failed (500)". That has a status and a message and
//     would sail through a check that only asked "is this an ApiError?", putting
//     a stack-trace-shaped string under a button.
//
// Hence the flag rather than a status sniff or an `instanceof`: it distinguishes
// the one case worth showing from the two that aren't. (`instanceof` wouldn't
// work here anyway — the class is only reachable as `api.ApiError`, a property
// of the object the test suites replace wholesale with `vi.mock("./api.js")`.)
//
// Issue #240 tracks raising a network failure as an `ApiError` at the source, in
// `api.js`. This stays correct after that lands: such an error would carry
// `fromServer: false` and still fall through to the caller's own sentence.
export function serverMessage(err, fallback) {
  return err?.fromServer && err.message ? err.message : fallback;
}
