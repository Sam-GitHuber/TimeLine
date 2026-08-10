/**
 * Emptying the query cache when a session ends (#194).
 *
 * The cache holds most of a session — the feed, conversation previews
 * *including other people's message text*, profiles, both unread counts — lives
 * as long as the tab (module scope, `main.jsx`), and was cleared by nothing.
 * TanStack paints cached data immediately while it refetches, so on a shared
 * computer the next person to log in saw a frame or more of the previous
 * person's app. The rule and its reasoning live in `docs/reference/accounts.md`
 * § *What leaves the browser with the session (#194)*; this file is the half of
 * it that couldn't go in `logout`.
 *
 * **Why not simply `queryClient.clear()` inside `logout`,** which is the
 * shorter-looking option: at that moment the feed, the nav's unread counts and
 * any open drawer are still mounted, so clearing pulls queries out from under
 * live observers, which refetch with a cookie the server has just invalidated —
 * a render before the redirect unmounts them anyway.
 *
 * **`useLayoutEffect`, not `useEffect`, and that's load-bearing.** This sits
 * above the router, and passive effects run child-first, so a `useEffect` here
 * would fire *after* the newly-mounted logged-out route's own effects — meaning
 * a public page that ever starts a query on mount would have it removed a beat
 * after it began. Layout effects run before any of that commit's passive
 * effects while still running after the DOM mutation that unmounted the
 * protected subtree, which is the window this needs: no observers left behind,
 * none started yet. It also means the cache is empty *before* the logged-out
 * screen paints rather than just after.
 *
 * **It covers the cache only.** Drafts and the outbox are cleared by `logout`
 * and by `login` (when the person differs), because keeping-or-dropping unsent
 * words is a judgement about *whose* words they are rather than about the
 * session ending — the phone deliberately keeps its stores across a session
 * expiry for that reason. So if the web ever grows an expiry path, wiring it to
 * set `user` null gets the cache handled by this hook and still leaves that
 * decision to make explicitly.
 *
 * Its own module rather than an effect inside `App.jsx` so a test can drive it
 * directly, the same way `mobile/src/useSessionReset.ts` is tested.
 */

import { useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth.jsx";

export function useSessionReset() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    // 🔒 Whatever is cached belonged to whoever was logged in, and the person
    // now looking at the login page may not be them. Clearing an already-empty
    // cache (a cold load with no session) is a no-op, so every path to
    // logged-out can share the one rule. `loading` is the page-load moment
    // before we know who's there, which is not the same as nobody being there.
    if (!loading && !user) queryClient.clear();
  }, [user, loading, queryClient]);
}
