import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Avatar from "./Avatar.jsx";
import { useAuth } from "../auth.jsx";

// The "about me" corner of the nav. Profile, Settings, Admin and Log out used to
// be four separate top-level items — the same account, four times over — which
// crowded the row and pushed the badge counts onto a second line. They now live
// behind the user's own avatar as a small dropdown, the well-trodden pattern for
// account actions, leaving the nav to hold just the app's real destinations.
export default function NavUserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  // Close on a click anywhere outside the menu, and on Escape — the two things a
  // user expects of any dropdown. We only wire these up while it's open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The Django admin lives on the API host, not the SPA — build the link from the
  // same base URL the API client uses so it's correct in every environment.
  const adminUrl = `${import.meta.env.VITE_API_URL || "http://localhost:8000"}/admin/`;

  async function handleLogout() {
    setOpen(false);
    try {
      await logout();
    } finally {
      // Even if the network call fails, send them to login — clicking logout
      // should never leave you seemingly still logged in.
      navigate("/login", { replace: true });
    }
  }

  const itemClass =
    "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep";

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`flex items-center gap-1 rounded-full p-0.5 transition hover:opacity-90 ${
          open ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""
        }`}
      >
        <Avatar user={user} size="sm" />
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={`mr-0.5 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-raised p-1 shadow-lg"
        >
          {user && (
            <div className="border-b border-line px-3 pb-2 pt-1.5">
              <p className="truncate text-sm font-semibold text-ink">
                {user.display_name || "You"}
              </p>
            </div>
          )}
          <div className="pt-1">
            {user && (
              <Link
                to={`/u/${user.pk}`}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={itemClass}
              >
                Profile
              </Link>
            )}
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={itemClass}
            >
              Settings
            </Link>
            {/* Maintainer-only: the admin lives on the backend, so this is a
                plain external link (new tab). Visibility is cosmetic — Django
                enforces staff access server-side. */}
            {user?.is_staff && (
              <a
                href={adminUrl}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onClick={() => setOpen(false)}
                className={itemClass}
              >
                Admin
              </a>
            )}
            <button
              type="button"
              onClick={handleLogout}
              role="menuitem"
              className={itemClass}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
