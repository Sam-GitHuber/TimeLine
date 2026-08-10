/**
 * Emptying the query cache when a session ends (#194).
 *
 * A port of `mobile/src/useSessionReset.ts`, and for the same reason: `logout`
 * clears the module-level stores — outbox, drafts — because they hold one
 * person's session on what may be a shared computer. The TanStack cache holds
 * far more of that session (the feed, conversation previews *including other
 * people's message text*, profiles, both unread counts), lives just as long
 * (module scope, `main.jsx`), and was cleared by nothing. TanStack renders
 * cached data *immediately* while refetching, so the next person to log in on
 * that browser saw a frame or more of the previous person's app.
 *
 * **A hook watching `user` rather than a `queryClient.clear()` inside `logout`,**
 * which is the shorter-looking option. Two reasons:
 *
 * - *Timing.* `logout` runs while the feed, the nav's unread counts and any
 *   open drawer are still mounted, so clearing from there removes queries out
 *   from under live observers, which immediately refetch — a burst of requests
 *   carrying a cookie the server has just invalidated, moments before the
 *   redirect unmounts them all anyway. An effect fires *after* the render in
 *   which `user` became null, by which point `ProtectedRoute` has sent us to
 *   the login page and there are no observers left to react.
 * - *One rule per client.* The app states this as "on every transition to
 *   signed out" and the web should say the same thing, so the two don't
 *   disagree about what a session ending means. The web has only one such
 *   transition today (there's no session-expiry handler here), but a future one
 *   is then covered by the rule rather than by remembering to add a second
 *   call.
 *
 * `loading` is deliberately not cleared on: it's the page-load moment before
 * we know who's there, and a fresh page's cache is empty then anyway (it is
 * never persisted — closing the tab is its own clear).
 *
 * Its own module rather than an effect inside `App.jsx` so a test can drive it
 * directly, the same way the app's copy is tested.
 *
 * See `docs/reference/accounts.md` § "What leaves the session with its owner".
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth.jsx";

export function useSessionReset() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    // 🔒 Whatever is cached belonged to whoever was logged in, and the person
    // now looking at the login page may not be them. Clearing an already-empty
    // cache (a cold load with no session) is a no-op, so every path to
    // logged-out can share the one rule.
    if (!loading && !user) queryClient.clear();
  }, [user, loading, queryClient]);
}
