import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "./api.js";
import { clearDrafts } from "./drafts.js";
import { clearOutbox } from "./outbox.js";

// Holds "who is logged in" for the whole app. On first load we ask the backend
// "who am I?" (using the httpOnly cookie the browser already has, if any), so a
// page refresh keeps you logged in without re-typing your password.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // `loading` is true until we've had one answer from the backend. Guards
  // against flashing the login page before we know whether there's a session.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Make sure we have a CSRF cookie for later mutations (login/logout).
        await api.ensureCsrf();
      } catch {
        // Backend unreachable — fall through; we'll just be "logged out".
      }
      try {
        const me = await api.getCurrentUser();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    await api.login(email, password);
    // Re-fetch the canonical user record rather than trust the login payload.
    const me = await api.getCurrentUser();
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    // 🔒 `finally`, not a plain `await`: a rejected POST — a network blink, or a
    // session the server had already dropped — used to skip everything below it,
    // and `NavUserMenu` navigates to /login regardless ("clicking logout should
    // never leave you seemingly still logged in"). So you landed on the login
    // form with `user` still set, the cache still full and the drafts still
    // there, and the next person to log in on that browser inherited the lot —
    // the same leak by a different door (#194). Whether the *server* honoured
    // the request is its own question; whether this browser lets go of the
    // session isn't, and we control that half unconditionally.
    //
    // What this can't undo is the auth cookie itself: it's httpOnly, so only
    // that POST can clear it. A logout whose request never landed therefore
    // leaves a session a page reload would pick back up — unchanged by this,
    // and not something the client can fix on its own.
    try {
      await api.logout();
    } finally {
      setUser(null);
      // 🔒 Drafts and the outbox live outside React (`drafts.js`, `outbox.js`)
      // so they can survive a component unmounting — which means nothing tears
      // them down on its own, and they hold one person's unsent words. On a
      // shared computer the next person to open the drawer isn't this person.
      // The app does the same on sign-out. (A third store held *other people's*
      // message text, fetched to fill a reply's quote, until M9g removed quotes
      // from the client entirely.)
      //
      // The other half of that session — the TanStack query cache, which holds
      // rather more of it — is emptied by `useSessionReset` off the back of
      // `user` becoming null, not from here: at this point the feed and the
      // drawers are still mounted, and clearing under live observers just makes
      // them refetch with a cookie the server has already thrown away (#194).
      clearDrafts();
      clearOutbox();
    }
  }, []);

  // register does NOT log you in — new accounts are pending admin approval.
  const register = useCallback(
    (email, password, firstName, lastName, acceptTerms) =>
      api.register(email, password, firstName, lastName, acceptTerms),
    []
  );

  // Re-fetch "who am I" and update the context — used after a profile edit so a
  // new name/avatar propagates to the nav, compose box, etc. immediately.
  const refreshUser = useCallback(async () => {
    const me = await api.getCurrentUser();
    setUser(me);
    return me;
  }, []);

  const value = { user, loading, login, logout, register, refreshUser };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}

// Exported so tests can supply a ready-made auth state without the real
// provider's async fetch.
export { AuthContext };
