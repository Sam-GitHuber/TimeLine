import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();
  // Who this browser last held a session for, so a *sign-in* can tell "the same
  // person again" from "somebody else" — see the guard in `login`. A ref rather
  // than state: nothing renders from it, and `login` must read the current value
  // without being re-created on every user change.
  const lastUserPk = useRef(null);

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
        if (!cancelled) {
          lastUserPk.current = me.pk;
          setUser(me);
        }
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

  const login = useCallback(
    async (email, password) => {
      await api.login(email, password);
      // Re-fetch the canonical user record rather than trust the login payload.
      const me = await api.getCurrentUser();
      // 🔒 Somebody else's session can still be sitting in this tab when this
      // runs, because a sign-in doesn't have to follow a sign-out. Two tabs open
      // as Ada, she logs out in one, and the other still holds her user, her
      // cache and her drafts; /login is public, and the sign-up, verify and
      // reset pages all link to it, so the next person reaches the form without
      // anything in this tab ever going null. `useSessionReset` watches for that
      // null and so never fires — hence the second half of the rule here: when
      // the person signing in isn't the one this browser last held, everything
      // the previous one left goes now. Same shape as the app's `signIn`
      // (`mobile/src/auth.tsx`), which needs it for the expiry path.
      //
      // Same pk = the same person back again, and their own drafts are theirs to
      // keep. Safe to clear from here, unlike sign-*out*: whatever route we're
      // on is a public one, so there are no live observers to send refetching.
      if (lastUserPk.current !== null && lastUserPk.current !== me.pk) {
        queryClient.clear();
        clearDrafts();
        clearOutbox();
      }
      lastUserPk.current = me.pk;
      setUser(me);
      return me;
    },
    [queryClient]
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 🔒 Best-effort, exactly like the app's own `api.logout`: a network
      // blink — or a session the server had already dropped — must never trap
      // someone in a logged-in browser. It used to: the teardown below sat
      // after a bare `await`, so a rejected POST skipped all of it while
      // `NavUserMenu` navigated to /login regardless ("clicking logout should
      // never leave you seemingly still logged in"). You landed on the login
      // form with `user` still set, the cache still full and the drafts still
      // there, and the next person to log in inherited the lot (#194).
      //
      // Swallowed *here*, around the one call that can fail for reasons outside
      // our control, rather than at the caller: a throw from the teardown itself
      // is a bug of ours and should stay loud.
      //
      // What no client can undo is the auth cookie: it's httpOnly, so only that
      // POST clears it, and a logout whose request never landed leaves a session
      // a page reload would pick back up. See accounts.md.
    } finally {
      setUser(null);
      lastUserPk.current = null;
      // 🔒 Drafts and the outbox live outside React (`drafts.js`, `outbox.js`)
      // so they can survive a component unmounting — which means nothing tears
      // them down on its own, and they hold one person's unsent words. On a
      // shared computer the next person to open the drawer isn't this person.
      // The app does the same on sign-out. (A third store held *other people's*
      // message text, fetched to fill a reply's quote, until M9g removed quotes
      // from the client entirely.)
      //
      // The query cache — which holds rather more of the session than these two
      // — is emptied by `useSessionReset` off the back of `user` becoming null,
      // not from here. Why it can't be done from here is in that file.
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
