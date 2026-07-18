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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api, ApiError, setSessionExpiredHandler } from './api';
import { clearTokens, getAccessToken } from './tokens';
import type { User } from './types';

type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  // Let `api.ts` end the session from outside React. It has no way to reach this
  // state otherwise, and a failed refresh has to be able to log the user out.
  useEffect(() => {
    setSessionExpiredHandler(() => {
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
        setUser(me);
        setStatus('signedIn');
      } catch (err) {
        // **Only discard the tokens when the server actually rejected them.**
        // `fetch` throws a plain TypeError when the phone has no connection,
        // and treating that like a rejection would wipe a perfectly good
        // 90-day refresh token — so opening the app once on the Underground
        // would silently end the session and, with it, push notifications.
        // That's the exact failure this phase exists to avoid.
        //
        // A real 401 here means the token is genuinely dead (revoked, or the
        // account was deleted — see PR #96); refresh has already been tried and
        // failed by this point, so there's nothing left to keep.
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
    setUser(me);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut]
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
