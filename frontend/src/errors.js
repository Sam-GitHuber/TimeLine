// Turning a rejected request into something worth showing a person.
//
// Only a rejection the *server* authored carries words written for a human:
// `request()` in api.js raises an `ApiError` holding DRF's `detail` ("You can't
// connect with this person."). A network-level failure never reaches that code
// — it rejects out of `fetch` itself as a bare `TypeError` whose message is the
// browser's own ("Failed to fetch" in Chrome, "Load failed" in Safari), which
// tells nobody what happened or what to do. Being offline is the most likely
// way any write fails, so that's the message a real user hits first.
//
// An `ApiError` is identified by the numeric `status` it carries rather than by
// `instanceof`: the class is only reachable as `api.ApiError`, a property of the
// object the test suites replace wholesale with `vi.mock("./api.js")`, so an
// identity check would quietly stop matching under test. Same sniff as
// `RsvpBar`, `PostPage` and the conversation thread already use.
//
// Issue #240 tracks raising a network failure as an `ApiError` at the source, in
// `api.js`. This stays correct after that lands — it just stops being
// load-bearing.
export function serverMessage(err, fallback) {
  return typeof err?.status === "number" && err.message ? err.message : fallback;
}
