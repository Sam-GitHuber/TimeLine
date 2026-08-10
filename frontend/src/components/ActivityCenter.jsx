import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, NOTIFICATIONS_POLL_MS } from "../api.js";
import { useInfiniteList, trimQueryToFirstPage } from "../hooks.js";
import { serverMessage, waitingMessage } from "../errors.js";
import { formatRelativeTime } from "../utils.js";
import Avatar from "./Avatar.jsx";
import LoadMoreButton from "./LoadMoreButton.jsx";
import NavBadge from "./NavBadge.jsx";

// The nav "Activity" bell + dropdown — the single, unified place "something
// happened to you" shows up (Phase 8). It absorbs what used to be separate
// connection-request and group-invite nav badges, so the feed, People and Groups
// no longer each carry their own "you have something waiting" count.
//
// Three states drive the look, matching the model (see the phase doc):
//   - unread  → bold, and it's what the badge counts.
//   - seen    → the badge is cleared (we mark everything seen when the panel
//               opens) but the item still stands out until dealt with.
//   - addressed → dulled, but kept in the history (click-through addresses it).
//
// Delivery is polling, like messaging — no WebSockets (a non-breaking swap
// later). The badge query shares the ["notificationsUnread"] key so acting on a
// notification can refresh it immediately.
export default function ActivityCenter() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  // The badge: unread count, polled. Cheap endpoint, slow cadence.
  const { data: unreadData } = useQuery({
    queryKey: ["notificationsUnread"],
    queryFn: api.getUnreadNotificationCount,
    refetchInterval: NOTIFICATIONS_POLL_MS,
  });
  const unread = unreadData?.count ?? 0;

  // The list: only fetched while the panel is open (no need to pull the full
  // list just to render a badge), and **paginated** (#134) — see
  // notifications.md for what rendering `results` alone cost.
  const notificationsQuery = useInfiniteList(
    ["notifications"],
    api.getNotifications,
    { enabled: open }
  );
  const { items: notifications } = notificationsQuery;

  /**
   * **Is the list itself on screen?** (#314) This panel had no error branch at
   * all: a failed fetch leaves `data` undefined, `items` falls back to `[]`,
   * and "You're all caught up" — a flat statement of fact — rendered on the
   * strength of a request that never arrived. It could even contradict itself
   * out loud, since the badge is a *separate* query: the bell reading
   * "Activity, 5 unread" directly above a panel saying there was nothing there.
   *
   * `data !== undefined` rather than a bare `isError`, the same way round as
   * every other surface (*Branch on the data, not the query flags*): a failed
   * *refetch*, or a failed page two, keeps the pages already loaded.
   *
   * Declared here, next to the data, because the seen-write below has to ask
   * the same question — asking it a second way is how the two halves of a file
   * drift apart.
   */
  const listLoaded = notificationsQuery.data !== undefined;
  const loadFailed = notificationsQuery.isError && !listLoaded;

  /**
   * Opening the panel marks everything currently unread as *seen* — the badge
   * clears, but every item stays in the list (that's the whole point). Fire it
   * once per open, then refresh the badge + list so the UI reflects it.
   *
   * **It waits for the list now (#314), where it used to fire on the open
   * transition.** The two came apart in the case that matters: open the bell
   * with no signal, the fetch fails, and this cleared every unread server-side
   * while the panel said "You're all caught up" — so the badge that would have
   * brought you back was gone, and the screen had just told you there was
   * nothing to come back for. That is the #307/#308 rule reaching another
   * surface: a write that mirrors what the reader has *seen* has to ride the
   * read that showed it to them, not a render that happened anyway. The app
   * took the same turn for its activity screen in #312.
   *
   * `listLoaded`, not `isSuccess`: a warm cache whose refetch failed is still a
   * panel full of notifications the reader is looking at, and those have been
   * seen. It's the same value the branches below read.
   */
  const seenSentRef = useRef(false);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
    // A fresh open gets a fresh attempt — including one whose fetch failed
    // last time, which is the whole point of gating it.
    if (!open) seenSentRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || seenSentRef.current || !listLoaded || unread === 0) return;
    // Once per open, not once per render: `listLoaded` and `unread` both move
    // while the panel is up (paging, the badge poll), and each POST would
    // otherwise be sent again. The ref is checked and set together so a
    // re-render mid-flight can't slip a second one past it.
    seenSentRef.current = true;
    api
      .markNotificationsSeen()
      .then(() => {
        // Closed in the meantime: the list query is `enabled: open`, so there's
        // nothing mounted to refresh, and the badge poll will catch up anyway.
        if (!openRef.current) return;
        queryClient.invalidateQueries({ queryKey: ["notificationsUnread"] });
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
      })
      .catch(() => {
        // Nothing to show and nothing to undo — the badge simply stays up,
        // which is the honest answer, and the next open tries again. Caught
        // rather than left to reject: an unhandled rejection is noise in the
        // console exactly when something else is already going wrong.
      });
  }, [open, listLoaded, unread, queryClient]);

  // Closing the panel drops back to a single page, so a reopen doesn't refetch
  // pages nobody is looking at (notifications.md; the app trims on unmount).
  // The cancel-then-trim ordering lives in `trimQueryToFirstPage` now that the
  // conversation drawer needs it too (#213).
  useEffect(() => {
    if (open) return;
    trimQueryToFirstPage(queryClient, ["notifications"]);
  }, [open, queryClient]);

  // Close on outside click / Escape — the two things any dropdown owes the user.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleClick(notification) {
    setOpen(false);
    // Click-through addresses it (the dulled, dealt-with state) and deep-links to
    // its target. Optimism isn't needed — we navigate away immediately and let
    // the badge/list refetch settle in the background.
    if (!notification.addressed) {
      try {
        await api.markNotificationAddressed(notification.id);
      } catch {
        // A failed address shouldn't block navigation; the poll will reconcile.
      }
      queryClient.invalidateQueries({ queryKey: ["notificationsUnread"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
    navigate(notification.url || "/");
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Activity, ${unread} unread` : "Activity"
        }
        className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-xl p-2 text-sm font-medium tracking-tight transition sm:px-3 sm:py-1.5 ${
          open
            ? "bg-ink/[0.06] text-ink"
            : "text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
        }`}
      >
        <BellIcon className="h-5 w-5 sm:hidden" />
        <span className="hidden sm:inline">Activity</span>
        {unread > 0 && <NavBadge count={unread} />}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-raised shadow-lg"
        >
          <div className="border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold text-ink">Activity</p>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {loadFailed ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-red-600">
                  {serverMessage(
                    notificationsQuery.error,
                    "Couldn’t load your activity."
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => notificationsQuery.refetch()}
                  className="btn btn-ghost btn-sm mt-3"
                >
                  Try again
                </button>
              </div>
            ) : !listLoaded ? (
              <p className="px-4 py-6 text-center text-sm text-ink-faint">
                {waitingMessage(notificationsQuery)}
              </p>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-faint">
                You're all caught up.
              </p>
            ) : (
              <>
                <ul>
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <NotificationRow notification={n} onClick={handleClick} />
                    </li>
                  ))}
                </ul>
                {/* Older notifications live behind the paginator's `next`. The
                    same explicit control every other list here uses, rather
                    than scroll-triggered loading inside a dropdown. */}
                <LoadMoreButton query={notificationsQuery} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// One row. The visual weight encodes the state: unread is bold with an accent
// dot; seen is normal weight; addressed is dulled (but still there).
function NotificationRow({ notification, onClick }) {
  const { actor, text, created_at, seen, addressed } = notification;
  const dulled = addressed;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onClick(notification)}
      className={`flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition last:border-b-0 hover:bg-accent-tint ${
        dulled ? "opacity-60" : ""
      }`}
    >
      <Avatar user={actor} size="sm" />
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm text-ink ${
            !seen ? "font-semibold" : "font-normal"
          }`}
        >
          {text}
        </p>
        <p className="mt-0.5 text-xs text-ink-faint">
          {formatRelativeTime(created_at)}
        </p>
      </div>
      {!seen && (
        <span
          aria-hidden="true"
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"
        />
      )}
    </button>
  );
}

function BellIcon(props) {
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
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}
