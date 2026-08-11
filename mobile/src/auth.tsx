/**
 * Who is logged in, for the whole app.
 *
 * One `AuthProvider` sits at the root (`app/_layout.tsx`) and holds the current
 * user; screens read it with `useAuth()`. The provider is the only thing that
 * calls `api.login` / `api.logout`, so "am I logged in?" has exactly one answer
 * and one place that changes it.
 *
 * The `status` field is deliberately three-valued rather than a boolean. On a
 * cold start we have to *ask the server* who we are (the stored token may have
 * been revoked while the app was closed), and during that check we are neither
 * signed in nor signed out. Collapsing that into `user === null` would flash the
 * login screen at an already-logged-in user every launch — the single most
 * common bug in this pattern.
 */

import { useSegments } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api, ApiError, setSessionExpiredHandler } from './api';
import { clearDrafts } from './drafts';
import { clearOutbox } from './outbox';
import { forgetLocalPushToken, registerForPush, unregisterPush } from './push';
import { clearTokens, getAccessToken } from './tokens';
import type { User } from './types';

type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Re-fetch "who am I" and update the held user. Called after editing your own
   * profile so the new name/avatar repaint everywhere they're read from auth —
   * the nav bead, the compose box — not just on the profile screen.
   */
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  // 🔒 Whose words the module stores (outbox/drafts/quotes) may still hold.
  //
  // A session *expiry* deliberately does not clear them: your unsent messages
  // and half-written drafts surviving a token refresh failing under you is the
  // point of having them, and an expiry doesn't change whose phone it is. But
  // the expiry lands on the login screen, where anyone can sign in — so the
  // clearing `signOut` does is instead done at the next sign-*in*, if and only
  // if it's by someone else (#191). Same person back: their words are waiting.
  // Different person: nothing crosses over.
  //
  // A ref, not state: nothing renders from it, and it must survive the expiry
  // handler's `setUser(null)` — being forgotten alongside the user is exactly
  // what it exists to avoid. (A process death forgets it too, but takes the
  // in-memory stores with it, so there's nothing left to guard.)
  const lastUserPk = useRef<number | null>(null);

  // Let `api.ts` end the session from outside React. It has no way to reach this
  // state otherwise, and a failed refresh has to be able to log the user out.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      // Local-only, deliberately: calling the *server* unregister here would
      // 401 (the session is precisely what has just died), trigger a refresh,
      // fail, and re-enter this very handler. The server row therefore
      // survives an expiry — see forgetLocalPushToken for why that's safe.
      void forgetLocalPushToken();
      setUser(null);
      setStatus('signedOut');
    });
    return () => setSessionExpiredHandler(() => {});
  }, []);

  // Cold start: do we have a token, and does the server still accept it?
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (!cancelled) setStatus('signedOut');
        return;
      }
      try {
        // This goes through the normal request path, so an access token that
        // expired while the app was closed gets silently refreshed here — the
        // common case for an app opened days later.
        const me = await api.getCurrentUser();
        if (cancelled) return;
        lastUserPk.current = me.pk;
        setUser(me);
        setStatus('signedIn');
        // Re-register on every launch, not just at login: Expo can rotate a
        // device's token, and the backend upserts, so this is cheap and keeps
        // `last_seen` honest. A user who is permanently logged in would
        // otherwise register exactly once, ever.
        void registerForPush();
      } catch (err) {
        // **Only discard the tokens when the server actually rejected them.**
        // A phone with no connection would otherwise wipe a perfectly good
        // 90-day refresh token — so opening the app once on the Underground
        // would silently end the session and, with it, push notifications.
        // That's the exact failure this phase exists to avoid.
        //
        // A real 401 here means the token is genuinely dead (revoked, or the
        // account was deleted — see PR #96); refresh has already been tried and
        // failed by this point, so there's nothing left to keep.
        //
        // ⚠️ **`status`, not the class.** Since #243 `api.ts` re-raises a lost
        // connection as an `ApiError` too — that's how it stopped being React
        // Native's `Network request failed` — so `err instanceof ApiError` is
        // now true offline and would clear the tokens on its own. What separates
        // the two is the status a lost connection carries: `0`, meaning we never
        // asked. Never loosen this to the class (#245).
        const rejected = err instanceof ApiError && err.status === 401;
        if (rejected) await clearTokens();
        if (cancelled) return;
        setUser(null);
        // Offline with good tokens still lands on the login screen, because v1
        // is deliberately online-only and we have no cached user to render.
        // The difference is that the tokens survive, so the next launch with a
        // connection restores the session without a re-login.
        setStatus('signedOut');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const me = await api.login(email, password);
    // 🔒 The stores can only be non-empty here after a session ended without
    // `signOut` — an expiry, which keeps them so their owner can retry. If the
    // person now signing in is someone else, the previous person's unsent
    // words must not follow them into this session.
    if (lastUserPk.current !== null && lastUserPk.current !== me.pk) {
      clearOutbox();
      clearDrafts();
    }
    lastUserPk.current = me.pk;
    setUser(me);
    setStatus('signedIn');
    // Not awaited: registering asks for the OS permission prompt and talks to
    // Expo, and neither should hold up landing on the feed. registerForPush
    // never throws, so there is no unhandled rejection to chase here.
    void registerForPush();
  }, []);

  const signOut = useCallback(async () => {
    // **Before** api.logout, not after: the unregister endpoint is
    // authenticated, so once logout has cleared the tokens it would 401 and the
    // device row would survive — leaving this phone buzzing with the previous
    // user's notifications. That's the exact case DevicePushToken's
    // upsert-on-token rule exists to prevent, and this is its other half.
    await unregisterPush();
    await api.logout();
    // 🔒 Unsent messages (M4) and half-written drafts live in module-level
    // stores, so they'd otherwise survive into the next person's session on a
    // shared phone. They're this person's own words, and none of it is the next
    // person's, so it goes out with them. (A third store held *other people's*
    // words — messages fetched to fill a reply's quote — until M9g removed
    // quotes from the client entirely.)
    clearOutbox();
    clearDrafts();
    // The stores are empty now, so the next sign-in has nothing to guard.
    lastUserPk.current = null;
    setUser(null);
    setStatus('signedOut');
  }, []);

  // Best-effort by design: the caller (the profile editor) has *already* saved
  // server-side by the time it asks for this, so a blip re-fetching "who am I"
  // must not surface as a save failure. It throws on a real error so the caller
  // can choose to log it, but the profile is safe either way — the editor's
  // query invalidations still pull the fresh copy onto the screen.
  const refreshUser = useCallback(async () => {
    const me = await api.getCurrentUser();
    setUser(me);
  }, []);

  const value = useMemo(
    () => ({ status, user, signIn, signOut, refreshUser }),
    [status, user, signIn, signOut, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return context;
}

/**
 * Is the login screen the thing currently on top?
 *
 * Two callers need this and they have to agree, which is why it is one function
 * and not one `segments[0] === 'login'` each. AuthGate uses it to decide when to
 * redirect a signed-in user off the login screen; `usePushTaps` uses it to hold
 * a tapped notification until that redirect has happened, rather than navigating
 * into it and being replaced (#220 §1). Two copies of the predicate would drift
 * the moment the route moves — put login in a group, say, and segments become
 * `['(auth)', 'login']`; whoever moved it fixes AuthGate because AuthGate visibly
 * breaks, while the push guard silently evaluates false forever and the deep
 * link is quietly lost again, which is exactly the bug it was added to fix.
 *
 * Lives here rather than in `_layout.tsx` because `_layout.tsx` imports
 * `usePushTaps`, so the dependency has to point this way.
 *
 * **A boolean, not the segments array.** `useSegments` is backed by
 * `useSyncExternalStore` over a cached route-info snapshot, so the array is a
 * stable reference *between* navigations but a fresh one on every navigation —
 * meaning an effect that depends on it re-runs each time the user goes anywhere
 * in the app. The only thing either caller cares about is crossing this one
 * boundary, so that is what they depend on.
 */
export function useOnLoginScreen(): boolean {
  return useSegments()[0] === 'login';
}
