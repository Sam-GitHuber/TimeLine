import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import LoadMoreButton from "./LoadMoreButton.jsx";
import { api } from "../api.js";
import { useGroupsDrawer } from "../groups-drawer.jsx";
import { useInfiniteList } from "../hooks.js";

// The groups drawer: a non-modal panel docked to the LEFT edge — the mirror
// image of the messages drawer on the right. It's a *switcher*, not a place you
// read: it lists the groups you belong to, and picking one navigates the main
// column to that group's full-width timeline (`/g/:id`) and closes the drawer,
// so you read the group feed where it belongs (not squeezed into 400px beside
// your home feed). No scrim / no scroll-lock, matching messaging: the feed
// underneath stays interactive.
export default function GroupsDrawer() {
  const { isOpen, close } = useGroupsDrawer();
  const panelRef = useRef(null);

  // Esc closes; focus lands in the panel so keys + screen readers work. Like
  // the messages drawer we deliberately don't trap focus or set aria-modal —
  // the rest of the page is meant to stay usable.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return createPortal(
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Groups"
      tabIndex={-1}
      className="groups-drawer fixed inset-y-0 left-0 z-40 flex w-full flex-col border-r border-line bg-surface shadow-[14px_0_44px_-26px_rgba(28,26,22,0.4)] outline-none sm:w-[400px]"
    >
      <GroupsListView />
    </aside>,
    document.body
  );
}

// The brand glyph (a node on the spine) — same mark the messages drawer uses,
// tying both companion panels back to the timeline's living line.
function SpineMark() {
  return (
    <svg
      width="12"
      height="16"
      viewBox="0 0 16 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
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
  );
}

function StrokeIcon({ path, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function IconButton({ onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep"
    >
      {children}
    </button>
  );
}

function GroupsListView() {
  const { close } = useGroupsDrawer();
  const navigate = useNavigate();

  const query = useInfiniteList(["groups"], api.getGroups);
  const { items: groups, isLoading, isError, error } = query;

  // Pending group invitations, surfaced as a banner into the invites inbox.
  // Shares the ["groupInvites"] key with the nav badge and the invites page.
  const { data: invitesData } = useQuery({
    queryKey: ["groupInvites"],
    queryFn: api.getGroupInvites,
  });
  const inviteCount = invitesData?.count ?? 0;

  // Navigating to a group (or any full page) closes the drawer — the main
  // column is about to change under it, so leaving it open would be confusing.
  function go(to) {
    close();
    navigate(to);
  }

  return (
    <>
      <header className="flex items-center gap-1.5 border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
          <SpineMark />
          <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
            Groups
          </h2>
        </div>
        <IconButton onClick={() => go("/groups/new")} label="New group">
          {/* plus */}
          <StrokeIcon path="M12 5v14M5 12h14" />
        </IconButton>
        <IconButton onClick={close} label="Close groups">
          <StrokeIcon path="M6 6l12 12M18 6L6 18" />
        </IconButton>
      </header>

      {inviteCount > 0 && (
        <button
          type="button"
          onClick={() => go("/group-invites")}
          className="flex items-center justify-between border-b border-line bg-accent-tint/40 px-4 py-3 text-left text-sm font-medium text-accent-deep transition hover:bg-accent-tint"
        >
          <span>
            You have {inviteCount}{" "}
            {inviteCount === 1 ? "invitation" : "invitations"} to join a group.
          </span>
          <span aria-hidden="true">→</span>
        </button>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}

        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            {error?.message || "Couldn't load your groups."}
          </p>
        )}

        {!isLoading && !isError && groups.length === 0 && (
          <div className="px-6 py-14 text-center text-ink-faint">
            <p className="font-medium text-ink">No groups yet</p>
            <p className="mt-1 text-sm">
              Create one, or wait for an invitation.
            </p>
            <button
              type="button"
              onClick={() => go("/groups/new")}
              className="btn btn-primary btn-sm mt-4"
            >
              New group
            </button>
          </div>
        )}

        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => go(`/g/${group.id}`)}
            className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-accent-tint/40"
          >
            <Avatar
              user={{
                display_name: group.name,
                avatar_thumb: group.avatar_thumb,
              }}
              size="md"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-ink">
                  {group.name}
                </span>
                {group.your_role === "admin" && (
                  <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[0.68rem] font-semibold text-accent-deep">
                    Admin
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-faint">
                {group.member_count}{" "}
                {group.member_count === 1 ? "member" : "members"}
              </p>
            </div>
          </button>
        ))}

        <LoadMoreButton query={query} />
      </div>
    </>
  );
}
