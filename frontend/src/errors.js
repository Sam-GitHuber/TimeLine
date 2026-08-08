// Turning a rejected request into something worth showing a person.
//
// Only a rejection the *server* authored carries words written for a human:
// `request()` in api.js raises an `ApiError` holding DRF's `detail` ("You can't
// connect with this person."), and flags it `fromServer`. Two kinds of failure
// are *not* that, and both are common:
//
//   - **A network-level failure** — offline, DNS, the connection dropped. It
//     rejects out of `fetch` itself as a bare `TypeError` whose message is the
//     browser's own ("Failed to fetch" in Chrome, "Load failed" in Safari),
//     which tells nobody what happened or what to do. Being offline is the most
//     likely way any write fails, so that's the message a real user hits first.
//     `api.js` now converts it at the source (issue #240) into an `ApiError`
//     with `status: 0` and a sentence of ours, flagged `fromServer: false` —
//     readable wherever it lands, and still not mistaken for the server's word.
//   - **A server error with no readable body** — a 500 rendered as a Django HTML
//     page, say — leaves `firstErrorMessage` nothing to pull out, so api.js
//     synthesizes "Request failed (500)". That has a status and a message and
//     would sail through a check that only asked "is this an ApiError?", putting
//     a stack-trace-shaped string under a button.
//
// Hence the flag rather than a status sniff or an `instanceof`: it distinguishes
// the one case worth showing from the two that aren't. A status sniff in
// particular *cannot* work now — since #240 a network failure carries a numeric
// `status` of its own. (`instanceof` wouldn't work here anyway — the class is
// only reachable as `api.ApiError`, a property of the object the test suites
// replace wholesale with `vi.mock("./api.js")`.)
//
// This is the one place a rejection becomes user-visible text on the web, so
// every call site that renders an error should come through here rather than
// reaching for `err.message` — that's what makes the fallbacks reachable.
export function serverMessage(err, fallback) {
  return err?.fromServer && err.message ? err.message : fallback;
}

/**
 * What to say while a query has told us nothing yet — the *third* state, and the
 * one that is easy to miss.
 *
 * `main.jsx` builds a bare `new QueryClient()`, so `networkMode` is the default
 * `'online'`: offline, a query doesn't fail, it **pauses**. `status` stays
 * `'pending'` and `fetchStatus` goes to `'paused'`, which makes `isLoading`
 * (`isPending && isFetching`) **false** — with no data behind it and no error
 * either. A render gated on `isLoading` therefore falls straight past this state
 * into whatever comes next, which on most screens is an empty state written as a
 * statement of fact. That's #306's lesson, and #314's: the branch a screen owes
 * this state is **`!data`**, not `!isLoading`.
 *
 * So call sites read `!query.data` and hand the query here for the wording,
 * rather than each deciding for itself whether being offline counts as loading.
 * Two different sentences because they ask two different things of the reader:
 * "Loading…" says wait, and "Waiting for a connection…" says the request hasn't
 * been *sent* and won't be until the signal comes back. A spinner that never
 * resolves and never explains is a dead end.
 *
 * The shape this pairs with, in full:
 *
 *   loadFailed ? <error + retry/>          // isError && !data
 *     : !data ? <p>{waitingMessage(q)}</p> // pending or paused
 *     : items.length === 0 ? <empty/>      // an answer, and it was none
 *     : <content/>
 *
 * `CommentThread.jsx` is the original of it (#306), written inline there.
 */
export function waitingMessage(query) {
  return query.isPaused ? "Waiting for a connection…" : "Loading…";
}
