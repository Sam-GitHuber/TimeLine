import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

// The group page's actions, collected behind a single "⋯" menu in the header so
// the page opens on its timeline, not a wall of buttons. Invite, Members, Start a
// chat, Leave and (for admins) Edit and Delete all live here. Same accessible
// menu-button behaviour as the nav's account menu: click-outside / Escape to
// close, arrow keys to move between items, focus moved into the menu on open.
export default function GroupActionsMenu({
  groupId,
  isAdmin,
  membersOpen,
  membersBusy,
  onInvite,
  onMembers,
  onStartChat,
  onLeave,
  onDelete,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
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

  useEffect(() => {
    if (!open) return;
    const items = listRef.current?.querySelectorAll('[role="menuitem"]');
    items?.[0]?.focus();
  }, [open]);

  function onMenuKeyDown(e) {
    const items = Array.from(
      listRef.current?.querySelectorAll('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[(i - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  // Run an action and close the menu — the menu is a launcher, not a place to
  // linger. (Panels it toggles, like Members, render on the page below.)
  function run(action) {
    setOpen(false);
    action?.();
  }

  const itemClass =
    "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep";
  const dangerClass =
    "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50";

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Group actions"
        className={`flex h-9 w-9 items-center justify-center rounded-full text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep ${
          open ? "bg-accent-tint text-accent-deep" : ""
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="10" cy="4" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="10" cy="16" r="1.6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          ref={listRef}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-20 mt-2 w-52 overflow-hidden rounded-xl border border-line bg-raised p-1 shadow-lg"
        >
          {isAdmin && (
            <Link
              to={`/g/${groupId}/edit`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={itemClass}
            >
              Edit group
            </Link>
          )}
          <button type="button" role="menuitem" onClick={() => run(onInvite)} className={itemClass}>
            Invite
          </button>
          <button type="button" role="menuitem" onClick={() => run(onMembers)} className={itemClass}>
            {membersOpen ? "Hide members" : "Members"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={membersBusy}
            onClick={() => run(onStartChat)}
            className={itemClass}
          >
            Start a chat
          </button>
          <div className="my-1 border-t border-line" />
          <button type="button" role="menuitem" onClick={() => run(onLeave)} className={dangerClass}>
            Leave group
          </button>
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => run(onDelete)} className={dangerClass}>
              Delete group
            </button>
          )}
        </div>
      )}
    </div>
  );
}
