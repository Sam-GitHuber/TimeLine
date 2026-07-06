import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "./api.js";

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
    await api.logout();
    setUser(null);
  }, []);

  // register does NOT log you in — new accounts are pending admin approval.
  const register = useCallback(
    (email, password, firstName, lastName) =>
      api.register(email, password, firstName, lastName),
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
