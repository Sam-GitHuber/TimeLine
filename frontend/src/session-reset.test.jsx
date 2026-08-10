/**
 * What leaves the browser with the session (#194).
 *
 * The threat model is a shared computer: someone logs out, someone else logs
 * in, and nothing of the first person's may still be on screen. The query cache
 * is the big one — TanStack paints cached data immediately while it refetches,
 * so anything left in it is a frame or more of the previous person's app,
 * other people's message previews included.
 *
 * `auth.test.jsx` drives the whole thing through the real logout button. These
 * are the transition rule itself, stated directly against the hook, because the
 * cases that matter (a page load with no session, a session that's still open)
 * are awkward to stage through the app.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "./auth.jsx";
import { useSessionReset } from "./useSessionReset.js";
import { fakeUser } from "./test-utils.jsx";

function Probe() {
  useSessionReset();
  return null;
}

// Mount the hook under an auth state, and hand back both the client and a way
// to move that state the way the provider does while staying mounted — which
// is the whole point: the hook watches a *transition*, and remounting it would
// test the mount instead.
function mountWith(auth) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["conversations"], [{ id: 3, body: "see you at 6" }]);
  const wrap = (value) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{
          user: null,
          loading: false,
          login: async () => {},
          logout: async () => {},
          register: async () => {},
          refreshUser: async () => null,
          ...value,
        }}
      >
        <Probe />
      </AuthContext.Provider>
    </QueryClientProvider>
  );
  const utils = render(wrap(auth));
  return {
    queryClient,
    setAuth: (value) => utils.rerender(wrap(value)),
    cached: () => queryClient.getQueryData(["conversations"]),
  };
}

describe("Session reset", () => {
  it("🔒 empties the cache when the session ends", () => {
    const { setAuth, cached } = mountWith({ user: fakeUser });
    expect(cached()).toBeTruthy();

    setAuth({ user: null });

    expect(cached()).toBeUndefined();
  });

  it("leaves the cache alone while someone is logged in", () => {
    const { setAuth, cached } = mountWith({ user: fakeUser });

    // A profile edit re-fetches "who am I" and hands back a new object for the
    // same person. That isn't a session ending, and emptying the cache on it
    // would refetch every screen for a changed display name.
    setAuth({ user: { ...fakeUser, first_name: "Ada" } });

    expect(cached()).toBeTruthy();
  });

  it("waits for the who-am-I answer before deciding nobody is there", () => {
    // On a page load `user` is null but unknown, not absent. Clearing then is a
    // no-op on a genuinely fresh cache — but this browser may be mid-restore,
    // and "we haven't asked yet" is not "logged out".
    const { cached } = mountWith({ user: null, loading: true });

    expect(cached()).toBeTruthy();
  });
});
