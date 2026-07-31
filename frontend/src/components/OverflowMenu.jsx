import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The ⋯ overflow menu — one implementation, used by a post header (`PostMenu`)
// and by a comment's actions row (`CommentThread`).
//
// **What goes in it is the same question in both places:** your own content
// offers Edit and Delete, someone else's offers Report. Posts settled that shape
// in issue #62 and comments joined them in #128, which is also when this came out
// of `PostMenu.jsx` — two copies of a portalled, viewport-flipping, click-outside
// popover was one more than the app needed.
//
// It paints through a **body-level portal** for the reason the reaction popover
// does: left in the card's stacking context, later feed entries paint over it.
// It's right-aligned under its trigger, closes on click-outside or Escape, and is
// deliberately a `role="dialog"` popover of ordinary buttons rather than an ARIA
// `menu` — those roles advertise arrow-key navigation we don't implement.
//
// `children` is a function taking `close`, so an item can dismiss the menu before
// doing its thing (opening a modal, flipping the card into an editor).
//
// `compact` shrinks the trigger for the comment actions row, where it sits in a
// line of small text buttons rather than alone in a card header — at the post's
// size it would set the row's height and read as the loudest thing on it, which
// is the opposite of what an overflow control is for.
export default function OverflowMenu({ label, compact = false, children }) {
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={`flex shrink-0 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep ${
          compact ? "-my-1 h-6 w-6" : "-mr-1 h-8 w-8"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className={compact ? "h-4 w-4" : "h-5 w-5"}
        >
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <MenuPanel anchorRef={triggerRef} label={label} onClose={close}>
          {children(close)}
        </MenuPanel>
      )}
    </>
  );
}

// One row in the dropdown — a plain button (see the ARIA note above). `danger`
// styles a destructive action, which by convention sits last so the pointer
// heading for the safe action never crosses it.
export function MenuItem({ onClick, danger = false, children }) {
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

// Positioning mirrors the reaction popover's (page coords + flip) and so does
// the click-outside / Escape handling. `anchorRef` is passed to the outside-click
// check as well, so re-clicking the trigger to close doesn't immediately reopen.
const MENU_WIDTH = 176;
const MENU_HEIGHT = 96;

function MenuPanel({ anchorRef, label, onClose, children }) {
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
      aria-label={label}
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
