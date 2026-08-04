import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "./auth.jsx";

// A stand-in logged-in user for tests that just need to be "past the gate".
export const fakeUser = {
  pk: 1,
  email: "you@example.com",
  first_name: "",
  last_name: "",
  display_name: "you",
  bio: "",
  avatar_thumb: null,
  is_staff: false,
  // Default on, like the server's (Phase 9b M4).
  send_read_receipts: true,
};

// Render `ui` inside a router, an auth context, and a fresh QueryClient (pages
// now fetch their data via TanStack Query). Retries are off so a rejected query
// surfaces its error state immediately instead of after backoff. Pass
// `auth: { user: null }` to simulate a logged-out visitor, or override any of
// the context callbacks.
//
// Alongside RTL's own `rerender`, the result carries **`setProps`**: the same
// thing, but keeping this render's providers and QueryClient in place. Bare
// `rerender` replaces the root, dropping the wrappers. It's for the case where
// what's being tested is a component reacting to the server's answer changing
// *underneath it while it stays mounted* — driving that through the app would
// navigate, which remounts the component and takes the state under test with it.
//
// It also carries **`queryClient`**, for the tests whose subject is the cache
// itself: seed a key before rendering, or assert what a mutation invalidated.
export function renderWithAuth(ui, { route = "/", auth = {} } = {}) {
  const value = {
    user: fakeUser,
    loading: false,
    login: async () => {},
    logout: async () => {},
    register: async () => {},
    refreshUser: async () => fakeUser,
    ...auth,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[route]}>{node}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
  const utils = render(wrap(ui));
  return {
    ...utils,
    queryClient,
    setProps: (node) => utils.rerender(wrap(node)),
  };
}

// ---------------------------------------------------------------------------
// Stand-ins for the three rejections `request()` in `api.js` can produce.
//
// Tests can't use the real `ApiError`: the class is only reachable as
// `api.ApiError`, and every suite here replaces that whole object with
// `vi.mock("./api.js")`. So the shapes are rebuilt by hand — and getting them
// *right* is the point, because `serverMessage` (`errors.js`) reads
// `fromServer` to decide whether a rejection carries words a person should see.
// A fake that omits the flag silently tests the wrong branch: it reads as a
// server rejection and behaves like a network blink.
//
// Three near-copies had grown across the suites by the time issue #240 made
// every call site depend on them, so they live in one place now.
// ---------------------------------------------------------------------------

/**
 * What the server said, in its own words — DRF's `detail`, written for a person
 * ("That code is invalid or has expired."). The only kind `serverMessage` shows.
 */
export function apiError(message, status = 500) {
  return Object.assign(new Error(message), {
    name: "ApiError",
    status,
    fromServer: true,
  });
}

/**
 * The server answered, but with nothing readable — a 500 rendered as a Django
 * HTML page, say. `api.js` synthesizes "Request failed (500)", which carries a
 * message *and* a status and so defeats any check cruder than the flag.
 */
export function unauthoredError(status = 500) {
  return Object.assign(new Error(`Request failed (${status})`), {
    name: "ApiError",
    status,
    fromServer: false,
  });
}

/**
 * No response at all — offline, DNS, the connection dropped. Since #240 this is
 * converted at the source, so it reaches a component as an `ApiError` with
 * `status: 0` and a sentence of ours rather than the browser's raw `TypeError`.
 * `fromServer` stays false because the sentence is ours, which is what still
 * lets a call site prefer its own, more specific copy.
 */
export function offlineError() {
  return Object.assign(
    new Error(
      "Couldn’t reach the server — check your connection and try again."
    ),
    { name: "ApiError", status: 0, fromServer: false }
  );
}
