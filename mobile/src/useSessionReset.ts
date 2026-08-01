/**
 * Emptying the query cache when a session ends (#191).
 *
 * `signOut` clears the module-level stores — outbox, drafts, quotes — because
 * they hold one person's session on what may be a shared phone. The TanStack
 * cache holds far more of that session (the feed, conversation previews,
 * profiles, both unread counts), lives just as long (module scope,
 * `_layout.tsx`), and was cleared by nothing. TanStack renders cached data
 * *immediately* while refetching, so the next person to sign in saw a frame or
 * more of the previous person's app — including other people's message
 * previews.
 *
 * **Watching `status` rather than adding a call inside `signOut`** covers all
 * three ways a session ends — explicit sign-out, the session-expiry handler,
 * and the cold-start 401 — with one rule, and keeps `auth.tsx` free of the
 * React Query dependency it deliberately doesn't have. Clearing on the
 * transition *out* rather than on the next sign-in means the data is gone
 * while the login screen is showing, not merely replaced after someone else
 * arrives.
 *
 * `'loading'` is deliberately not cleared on: it's the cold-start moment
 * before we know who's there, and the cache is empty then anyway (it is not
 * persisted to disk — a process death is its own clear).
 *
 * Its own module rather than an effect in `_layout.tsx` for the reason
 * `useBadgeCount` and `usePushDismissals` are: a hook can be rendered by a
 * test harness and driven directly.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useAuth } from '@/auth';

export function useSessionReset(): void {
  const { status } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    // 🔒 Whatever is cached belonged to whoever was signed in, and the person
    // now looking at the login screen may not be them. Clearing an
    // already-empty cache (the no-stored-token cold start) is a no-op, so
    // every path to `signedOut` can share the one rule.
    if (status === 'signedOut') queryClient.clear();
  }, [status, queryClient]);
}
