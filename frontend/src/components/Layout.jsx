import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  posts as initialPosts,
  currentUserId,
  getUserById,
} from "../mockData.js";
import { useAuth } from "../auth.jsx";

// The app shell: a top nav plus whichever page is active (<Outlet />).
//
// Layout owns the list of posts in React state. It starts from the mock data
// and grows when the compose box adds one. Keeping it here (rather than inside
// the feed page) means a new post shows up both in the feed AND on the author's
// profile, since both pages read from this same state. It's shared with child
// pages through react-router's Outlet context.
export default function Layout() {
  const [posts, setPosts] = useState(initialPosts);
  // The real logged-in account (email lives here). The feed itself still runs
  // on mock data until Phase 3 wires posts to the backend, so the compose box
  // is still attributed to the mock `currentUser` for now.
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const currentUser = getUserById(currentUserId);

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

  // Prepend a new post so the newest is first — the feed also sorts by time,
  // but prepending keeps things correct even without the sort.
  function addPost(text) {
    const newPost = {
      id: Date.now(), // stand-in id; the DB assigns real ones later
      authorId: currentUserId,
      createdAt: new Date().toISOString(),
      text,
    };
    setPosts((prev) => [newPost, ...prev]);
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
            <NavLink to={`/u/${currentUser.username}`} className={navLinkClass}>
              Profile
            </NavLink>
            {user && (
              <span className="hidden text-sm text-slate-500 sm:inline">
                {user.email}
              </span>
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
        <Outlet context={{ posts, addPost, currentUser }} />
      </main>
    </div>
  );
}
