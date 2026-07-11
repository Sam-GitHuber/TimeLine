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

  // Nav items collapse to icons on a phone (below `sm`) and expand to labelled
  // pills on wider screens. The base here holds the shared shape; each item adds
  // its icon (shown only on mobile) and text label (shown only from `sm` up).
  const stateClass = (active) =>
    active
      ? "bg-ink/[0.06] text-ink"
      : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep";
  const navItemBase =
    "relative flex items-center gap-1.5 whitespace-nowrap rounded-xl p-2 text-sm font-medium tracking-tight transition sm:px-3 sm:py-1.5";
  const navLinkClass = ({ isActive }) => `${navItemBase} ${stateClass(isActive)}`;

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[640px] border-x border-line bg-surface">
        <header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur">
          <nav className="flex items-center justify-between gap-2 px-4 py-3.5 sm:gap-3 sm:px-5">
            <Link
              to="/"
              aria-label="TimeLine home"
              className="flex shrink-0 items-center gap-2 font-display text-xl font-bold -tracking-[0.02em] text-ink"
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
              {/* The wordmark hides on the narrowest phones so the mark alone
                  keeps the bar from overflowing; it returns from ~360px up. */}
              <span className="hidden min-[360px]:inline">TimeLine</span>
            </Link>
            <div className="flex items-center gap-0.5">
              <NavLink to="/" end aria-label="Feed" className={navLinkClass}>
                <HomeIcon className="h-5 w-5 sm:hidden" />
                <span className="hidden sm:inline">Feed</span>
              </NavLink>
              {/* People is now the relationships hub: Discover + a Requests
                  tab. The pending-request count rides here (it used to be its
                  own nav item) so "someone needs your attention" still shows. */}
              <NavLink
                to="/people"
                aria-label={
                  pendingCount > 0
                    ? `People, ${pendingCount} pending request${pendingCount === 1 ? "" : "s"}`
                    : "People"
                }
                className={navLinkClass}
              >
                <PeopleIcon className="h-5 w-5 sm:hidden" />
                <span className="hidden sm:inline">People</span>
                {pendingCount > 0 && <NavBadge count={pendingCount} />}
              </NavLink>
              {/* Groups is a companion panel too — the mirror of Messages,
                  docked to the left edge. The button toggles the drawer; picking
                  a group navigates the feed column to that group's timeline. */}
              <button
                type="button"
                onClick={toggleGroups}
                aria-pressed={groupsDrawer.isOpen}
                aria-label={
                  groupInviteCount > 0
                    ? `Groups, ${groupInviteCount} invitation${groupInviteCount === 1 ? "" : "s"}`
                    : "Groups"
                }
                className={`${navItemBase} ${stateClass(groupsDrawer.isOpen)}`}
              >
                <GroupsIcon className="h-5 w-5 sm:hidden" />
                <span className="hidden sm:inline">Groups</span>
                {groupInviteCount > 0 && <NavBadge count={groupInviteCount} />}
              </button>
              {/* Messages is a companion panel, not a page — the button toggles
                  the drawer so you keep your place in the feed. */}
              <button
                type="button"
                onClick={toggleMessages}
                aria-pressed={messaging.isOpen}
                aria-label={
                  unreadMessages > 0
                    ? `Messages, ${unreadMessages} unread`
                    : "Messages"
                }
                className={`${navItemBase} ${stateClass(messaging.isOpen)}`}
              >
                <MessagesIcon className="h-5 w-5 sm:hidden" />
                <span className="hidden sm:inline">Messages</span>
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

// The nav "you have something waiting" indicator. On a phone the item is just an
// icon, so the count wouldn't have room — we show a small accent dot pinned to
// the icon's corner instead. From `sm` up (labels visible) it becomes the count
// pill sitting after the label. The count itself is conveyed to screen readers
// via each item's aria-label, so both forms here are decorative (aria-hidden).
function NavBadge({ count }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-surface sm:hidden"
      />
      <span
        aria-hidden="true"
        className="ml-1.5 hidden min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[0.68rem] font-bold tabular-nums text-white sm:inline-flex"
      >
        {count}
      </span>
    </>
  );
}

// ---- Mobile nav icons ----
// Shown only below `sm`, where the labelled pills collapse to icons. Simple
// stroke glyphs that inherit the item's text colour (so the active/hover states
// carry through). Each is aria-hidden — the accessible name is the item's label.
function HomeIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

function PeopleIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.1a3.2 3.2 0 0 1 0 5.8" />
      <path d="M17 14.3a5.5 5.5 0 0 1 3.5 5.7" />
    </svg>
  );
}

function GroupsIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 12.5 12 17.5l9-5" />
      <path d="M3 17 12 22l9-5" />
    </svg>
  );
}

function MessagesIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M20.5 11.5a7.5 7.5 0 0 1-7.5 7.5 7.9 7.9 0 0 1-3.5-.8L4 20l1.3-4.2A7.5 7.5 0 0 1 4.5 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8.5 7.5Z" />
    </svg>
  );
}
