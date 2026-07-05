import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// The app shell: a top nav plus whichever page is active (<Outlet />).
//
// As of Phase 3 the feed, profiles and people list each fetch their own data
// from the real API (via TanStack Query), so Layout no longer owns any posts
// state — it just provides the chrome and the logged-in user's nav links.
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Count of pending follow requests, for the nav badge. Shares the
  // ["followRequests"] cache key with the Requests page, so approving/rejecting
  // there updates this badge automatically.
  const { data: requestsData } = useQuery({
    queryKey: ["followRequests"],
    queryFn: api.getFollowRequests,
  });
  // `count` is the paginator's true total; `results.length` would cap at one
  // page (PAGE_SIZE) and under-report once there are more than a page of them.
  const pendingCount = requestsData?.count ?? 0;

  // The Django admin lives on the API host, not the SPA — build the link from
  // the same base URL the API client uses so it's correct in every environment.
  const adminUrl = `${import.meta.env.VITE_API_URL || "http://localhost:8000"}/admin/`;

  async function handleLogout() {
    try {
      await logout();
    } finally {
      // Even if the network call fails, send them to login — clicking logout
      // should never leave you seemingly still logged in.
      navigate("/login", { replace: true });
    }
  }

  const navLinkClass = ({ isActive }) =>
    `rounded-full px-4 py-1.5 font-medium transition ${
      isActive
        ? "bg-slate-900 text-white"
        : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <nav className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-xl font-bold tracking-tight">
            TimeLine
          </Link>
          <div className="flex items-center gap-2">
            <NavLink to="/" end className={navLinkClass}>
              Feed
            </NavLink>
            <NavLink to="/people" className={navLinkClass}>
              People
            </NavLink>
            <NavLink to="/requests" className={navLinkClass}>
              Requests
              {pendingCount > 0 && (
                <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-sky-600 px-1.5 text-xs font-semibold text-white">
                  {pendingCount}
                </span>
              )}
            </NavLink>
            {user && (
              <NavLink to={`/u/${user.pk}`} className={navLinkClass}>
                Profile
              </NavLink>
            )}
            {/* Maintainer-only: the admin lives on the backend, so this is a
                plain external link (new tab). Visibility is cosmetic — Django
                enforces staff access server-side. */}
            {user?.is_staff && (
              <a
                href={adminUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full px-4 py-1.5 font-medium text-slate-600 transition hover:bg-slate-100"
              >
                Admin
              </a>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-full px-4 py-1.5 font-medium text-slate-600 transition hover:bg-slate-100"
            >
              Log out
            </button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-2xl border-x border-slate-200 bg-white">
        <Outlet />
      </main>
    </div>
  );
}
