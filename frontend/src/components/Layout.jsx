import { Link, NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, CONVERSATION_LIST_POLL_MS } from "../api.js";
import { useMediaQuery } from "../hooks.js";
import { useMessaging } from "../messaging.jsx";
import { useGroupsDrawer } from "../groups-drawer.jsx";
import MessagesDrawer from "./MessagesDrawer.jsx";
import GroupsDrawer from "./GroupsDrawer.jsx";
import NavUserMenu from "./NavUserMenu.jsx";

// The app shell: a top nav plus whichever page is active (<Outlet />).
//
// As of Phase 3 the feed, profiles and people list each fetch their own data
// from the real API (via TanStack Query), so Layout no longer owns any posts
// state — it just provides the chrome and the logged-in user's nav links.
export default function Layout() {
  const messaging = useMessaging();
  const groupsDrawer = useGroupsDrawer();

  // The two companion drawers are 400px each, docked to opposite edges. Below
  // 800px there isn't room for both at once (2 × 400px), so they'd overlap in
  // the middle — and below 640px each is full-width, hiding the other entirely.
  // So on a narrow viewport, opening one closes the other; on a wide one (a
  // laptop) both can sit side-by-side. We only close the *other* drawer when a
  // toggle is about to *open* its own, never when it's closing.
  const tooNarrowForBoth = useMediaQuery("(max-width: 799px)");

  function toggleGroups() {
    if (tooNarrowForBoth && !groupsDrawer.isOpen) messaging.close();
    groupsDrawer.toggle();
  }

  function toggleMessages() {
    if (tooNarrowForBoth && !messaging.isOpen) groupsDrawer.close();
    messaging.toggle();
  }

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

  // Pending group invitations, for a badge on the Groups link. Shares the
  // ["groupInvites"] key with the invitations page so accepting/declining there
  // updates the badge.
  const { data: groupInvitesData } = useQuery({
    queryKey: ["groupInvites"],
    queryFn: api.getGroupInvites,
  });
  const groupInviteCount = groupInvitesData?.count ?? 0;

  // Total unread messages, for the nav badge. Polled (no WebSockets yet — see
  // the Phase 5 doc) so it stays roughly current without the user reloading.
  // Shares the ["unreadMessages"] key so opening a thread can refresh it.
  const { data: unreadData } = useQuery({
    queryKey: ["unreadMessages"],
    queryFn: api.getUnreadMessageCount,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const unreadMessages = unreadData?.count ?? 0;

  const navLinkClass = ({ isActive }) =>
    `whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-medium tracking-tight transition ${
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
              {/* People is now the relationships hub: Discover + a Requests
                  tab. The pending-request count rides here (it used to be its
                  own nav item) so "someone needs your attention" still shows. */}
              <NavLink to="/people" className={navLinkClass}>
                People
                {pendingCount > 0 && <NavBadge count={pendingCount} />}
              </NavLink>
              {/* Groups is a companion panel too — the mirror of Messages,
                  docked to the left edge. The button toggles the drawer; picking
                  a group navigates the feed column to that group's timeline. */}
              <button
                type="button"
                onClick={toggleGroups}
                aria-pressed={groupsDrawer.isOpen}
                className={`whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-medium tracking-tight transition ${
                  groupsDrawer.isOpen
                    ? "bg-ink/[0.06] text-ink"
                    : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
                }`}
              >
                Groups
                {groupInviteCount > 0 && <NavBadge count={groupInviteCount} />}
              </button>
              {/* Messages is a companion panel, not a page — the button toggles
                  the drawer so you keep your place in the feed. */}
              <button
                type="button"
                onClick={toggleMessages}
                aria-pressed={messaging.isOpen}
                className={`whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-medium tracking-tight transition ${
                  messaging.isOpen
                    ? "bg-ink/[0.06] text-ink"
                    : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
                }`}
              >
                Messages
                {unreadMessages > 0 && <NavBadge count={unreadMessages} />}
              </button>
              {/* Profile, Settings, Admin and Log out — all "about me" — live
                  behind the avatar so they don't crowd the destinations. */}
              <NavUserMenu />
            </div>
          </nav>
        </header>

        <main>
          <Outlet />
        </main>
      </div>

      {/* Both companion drawers portal to <body>, so they sit above the column
          and dock to the viewport edges regardless of the centered layout —
          groups on the left, messages on the right. */}
      <GroupsDrawer />
      <MessagesDrawer />
    </div>
  );
}

// The small accent count pill on a nav item (pending requests, group invites,
// unread messages). `inline-flex` inside a `whitespace-nowrap` item so it stays
// on the same line as its label — the crowding used to break it onto its own.
function NavBadge({ count }) {
  return (
    <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white">
      {count}
    </span>
  );
}
