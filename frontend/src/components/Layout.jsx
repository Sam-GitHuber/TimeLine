import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, CONVERSATION_LIST_POLL_MS } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useMessaging } from "../messaging.jsx";
import MessagesDrawer from "./MessagesDrawer.jsx";

// The app shell: a top nav plus whichever page is active (<Outlet />).
//
// As of Phase 3 the feed, profiles and people list each fetch their own data
// from the real API (via TanStack Query), so Layout no longer owns any posts
// state — it just provides the chrome and the logged-in user's nav links.
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const messaging = useMessaging();

  // Count of pending connection requests, for the nav badge. Shares the
  // ["connectionRequests"] cache key with the Requests page, so
  // approving/rejecting there updates this badge automatically.
  const { data: requestsData } = useQuery({
    queryKey: ["connectionRequests"],
    queryFn: api.getConnectionRequests,
  });
  // `count` is the paginator's true total; `results.length` would cap at one
  // page (PAGE_SIZE) and under-report once there are more than a page of them.
  const pendingCount = requestsData?.count ?? 0;

  // Total unread messages, for the nav badge. Polled (no WebSockets yet — see
  // the Phase 5 doc) so it stays roughly current without the user reloading.
  // Shares the ["unreadMessages"] key so opening a thread can refresh it.
  const { data: unreadData } = useQuery({
    queryKey: ["unreadMessages"],
    queryFn: api.getUnreadMessageCount,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const unreadMessages = unreadData?.count ?? 0;

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
    `rounded-xl px-3 py-1.5 text-sm font-medium tracking-tight transition ${
      isActive
        ? "bg-ink/[0.06] text-ink"
        : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
    }`;

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[640px] border-x border-line bg-surface">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur">
          <nav className="flex items-center justify-between gap-3 px-5 py-3.5">
            <Link
              to="/"
              className="flex items-center gap-2 font-display text-xl font-bold -tracking-[0.02em] text-ink"
            >
              <svg
                width="15"
                height="19"
                viewBox="0 0 16 20"
                fill="none"
                aria-hidden="true"
              >
                <line
                  x1="8"
                  y1="2"
                  x2="8"
                  y2="18"
                  stroke="var(--color-spine)"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="8" cy="6" r="4" fill="var(--color-accent)" />
              </svg>
              TimeLine
            </Link>
            <div className="flex items-center gap-0.5">
              <NavLink to="/" end className={navLinkClass}>
                Feed
              </NavLink>
              <NavLink to="/people" className={navLinkClass}>
                People
              </NavLink>
              {/* Messages is a companion panel, not a page — the button toggles
                  the drawer so you keep your place in the feed. */}
              <button
                type="button"
                onClick={messaging.toggle}
                aria-pressed={messaging.isOpen}
                className={`rounded-xl px-3 py-1.5 text-sm font-medium tracking-tight transition ${
                  messaging.isOpen
                    ? "bg-ink/[0.06] text-ink"
                    : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
                }`}
              >
                Messages
                {unreadMessages > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
                    {unreadMessages}
                  </span>
                )}
              </button>
              <NavLink to="/requests" className={navLinkClass}>
                Requests
                {pendingCount > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
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
                  className="rounded-xl px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep"
                >
                  Admin
                </a>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-xl px-3 py-1.5 text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep"
              >
                Log out
              </button>
            </div>
          </nav>
        </header>

        <main>
          <Outlet />
        </main>
      </div>

      {/* The messages drawer portals to <body>, so it sits above the column and
          docks to the viewport edge regardless of the centered layout. */}
      <MessagesDrawer />
    </div>
  );
}
