import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth.jsx";

// Gate for pages that require a logged-in user. While we're still checking for
// a session, show nothing (avoids flashing the login page). If there's no user,
// bounce to /login, remembering where they were headed so we can send them back
// after a successful login.
export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-ink-faint">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
