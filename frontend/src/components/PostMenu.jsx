import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { ReportModal } from "./ReportButton.jsx";

// The ⋯ overflow menu on a post header (issue #62). What it offers depends on
// whether you own the post:
//   - your own post → Edit (flips the card into an inline editor via `onEdit`)
//     and Delete (confirm, then remove),
//   - someone else's → Report (the same modal the inline control used to open —
//     Report now lives here rather than in the footer row).
// The owner check mirrors `ReportButton`: `user.pk === authorId`.
//
// The menu paints through a body-level portal for the same reason the reaction
// popover does — left in the post's stacking context, later feed cards would
// paint over it. It's right-aligned under the kebab and closes on click-outside
// or Escape, matching the QuickReactionPopover/ReactorsPopover convention (a
// lightweight `role="dialog"` popover, not an ARIA menu).
export default function PostMenu({ postId, authorId, onEdit }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isOwner = user != null && authorId != null && user.pk === authorId;

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePost(postId),
    onSuccess: () => {
      // The post can be on the home feed, a profile, a group timeline, or its
      // own permalink — invalidate them all (prefix match) so it disappears
      // wherever it's shown.
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["userPosts"] });
      queryClient.invalidateQueries({ queryKey: ["groupPosts"] });
      queryClient.invalidateQueries({ queryKey: ["post", String(postId)] });
    },
  });

  // Nothing to offer a logged-out viewer (they can't reach the feed anyway).
  if (!user) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Post options"
        className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep"
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="h-5 w-5"
        >
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <MenuPanel
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
        >
          {isOwner ? (
            <>
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
              >
                Edit
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  setOpen(false);
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : (
            <MenuItem
              onClick={() => {
                setOpen(false);
                setReporting(true);
              }}
            >
              Report
            </MenuItem>
          )}
        </MenuPanel>
      )}

      {reporting && (
        <ReportModal postId={postId} onClose={() => setReporting(false)} />
      )}

      {confirmingDelete && (
        <ConfirmDeleteDialog
          // Stay in the busy state after success too: on a slow refetch the card
          // hasn't unmounted yet, and a second click would re-fire deletePost on
          // an already-deleted post (404). `isSuccess` keeps the button disabled
          // until this card is removed from the list.
          pending={deleteMutation.isPending || deleteMutation.isSuccess}
          error={deleteMutation.isError ? deleteMutation.error : null}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => deleteMutation.mutate()}
        />
      )}
    </>
  );
}

// One row in the dropdown — a plain button. We deliberately don't use ARIA
// `menuitem`/`menu` roles: those advertise arrow-key navigation we don't
// implement, so a `role="dialog"` popover of ordinary buttons (the house
// QuickReactionPopover pattern) is the honest, consistent choice. `danger`
// styles a destructive action (Delete).
function MenuItem({ onClick, danger = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-4 py-2 text-left text-sm font-medium transition hover:bg-accent-tint ${
        danger ? "text-red-600 hover:text-red-700" : "text-ink hover:text-accent-deep"
      }`}
    >
      {children}
    </button>
  );
}

// The dropdown panel, portalled to <body> and right-aligned under the trigger.
// Mirrors the reaction popover's positioning (page coords + flip) and its
// click-outside / Escape handling (`ignoreRef` = the trigger, so re-clicking it
// to close doesn't immediately reopen).
const MENU_WIDTH = 176;
const MENU_HEIGHT = 96;

function MenuPanel({ anchorRef, onClose, children }) {
  const wrapRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = window.scrollX;
    const sy = window.scrollY;
    // Right-align the menu's right edge with the button's right edge, clamped
    // to the viewport.
    let left = Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8);
    left = Math.max(8, left) + sx;
    let top;
    if (
      r.bottom + MENU_HEIGHT > window.innerHeight - 8 &&
      r.top - MENU_HEIGHT - 6 > 8
    ) {
      top = r.top - MENU_HEIGHT - 6 + sy;
    } else {
      top = r.bottom + 6 + sy;
    }
    setPos({ left, top });
  }, [anchorRef]);

  useEffect(() => {
    function onPointerDown(e) {
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, anchorRef]);

  if (!pos) return null; // avoid a one-frame flash before we measure
  return createPortal(
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Post options"
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: MENU_WIDTH,
        zIndex: 60,
      }}
      className="overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

// A confirm step before a delete — a post can carry comments, reactions and
// photos, so this isn't a one-click action. Same modal shape as `ReportModal`
// (portal, focus, Escape, backdrop close).
function ConfirmDeleteDialog({ onConfirm, onCancel, pending, error }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const stop = (event) => event.stopPropagation();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-sm"
      onClick={pending ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Delete post"
        tabIndex={-1}
        onClick={stop}
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-xl outline-none"
      >
        <h2 className="font-display text-lg font-semibold text-ink">
          Delete this post?
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          This can’t be undone. Its comments, reactions and photos will be
          removed too.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {error.message || "Couldn’t delete the post."}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="btn btn-sm bg-red-600 text-white hover:bg-red-700"
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
