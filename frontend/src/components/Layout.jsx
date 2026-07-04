import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  posts as initialPosts,
  currentUserId,
  getUserById,
} from "../mockData.js";

// The app shell: a top nav plus whichever page is active (<Outlet />).
//
// Layout owns the list of posts in React state. It starts from the mock data
// and grows when the compose box adds one. Keeping it here (rather than inside
// the feed page) means a new post shows up both in the feed AND on the author's
// profile, since both pages read from this same state. It's shared with child
// pages through react-router's Outlet context.
export default function Layout() {
  const [posts, setPosts] = useState(initialPosts);
  const currentUser = getUserById(currentUserId);

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
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-2xl border-x border-slate-200 bg-white">
        <Outlet context={{ posts, addPost, currentUser }} />
      </main>
    </div>
  );
}
