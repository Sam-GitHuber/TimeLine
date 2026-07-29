import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The ⋯ action menu on a message bubble (Phase 9b M9b — the web's answer to the
// app's long-press menu).
//
// **Hover, not long-press**, which is the one thing that differs from the phone
// and differs because the medium does: a desktop has a pointer, and the drawer
// already surfaced its inline Delete this way. The trigger stays in the DOM and
// is revealed by the bubble row's `group-hover` — and by `:focus-visible`, so a
// keyboard reaches every action a mouse can.
//
// **The items are data, not JSX** (`messageActions` in ConversationThreadView),
// for the same reason the app's are: M9c inserts React, M9d inserts Reply, M9f
// inserts Select, and a menu built out of conditional JSX would have to be
// re-read from scratch by each of them.
//
// `getActions` is a *function*, called when the menu opens rather than during
// render, because one of the entries expires: Edit is offered for fifteen
// minutes, and a list built at render time would make the menu's contents depend
// on when React last happened to redraw the bubble. Same reasoning as the app's
// `messageActions`, where the clock is passed in for exactly this reason.
//
// The panel is portalled to `<body>` and positioned like `PostMenu`'s: page
// coordinates measured in a layout effect, flipped above the trigger when
// there's no room below. In the drawer that isn't cosmetic — the transcript is
// an `overflow-y-auto` scroller, so a menu left in the flow would be clipped by
// it on the bubbles nearest the top and bottom.
export default function MessageMenu({ getActions, mine }) {
  const triggerRef = useRef(null);
  const [actions, setActions] = useState(null);
  const open = actions !== null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setActions((current) => (current ? null : getActions()))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Message options"
        // `msg-menu-trigger` owns when this is *visible* (index.css): hidden
        // until the bubble is hovered, and always visible on an input that
        // can't hover — a phone browser — where hiding it would make the whole
        // menu an invisible button nobody could find.
        className={`msg-menu-trigger mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-faint transition hover:bg-accent-tint hover:text-accent-deep ${
          mine ? "order-first" : ""
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="h-4 w-4"
        >
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>

      {open && (
        <MenuPanel
          anchorRef={triggerRef}
          itemCount={actions.length}
          onClose={() => setActions(null)}
        >
          {actions.map((action) => (
            <MenuItem
              key={action.label}
              danger={action.danger}
              onClick={() => {
                setActions(null);
                action.onClick();
              }}
            >
              {action.label}
            </MenuItem>
          ))}
        </MenuPanel>
      )}
    </>
  );
}

// One row — a plain button. Deliberately not ARIA `menuitem`/`menu`, matching
// `PostMenu`: those roles advertise arrow-key navigation we don't implement, so
// a `role="dialog"` popover of ordinary buttons is the honest house pattern.
function MenuItem({ onClick, danger = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-4 py-2 text-left text-sm font-medium transition hover:bg-accent-tint ${
        danger
          ? "text-red-600 hover:text-red-700"
          : "text-ink hover:text-accent-deep"
      }`}
    >
      {children}
    </button>
  );
}

const MENU_WIDTH = 160;
const ITEM_HEIGHT = 36;
const PANEL_PADDING = 8;

function MenuPanel({ anchorRef, itemCount, onClose, children }) {
  const wrapRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const height = itemCount * ITEM_HEIGHT + PANEL_PADDING;
    // Right-align with the trigger, clamped to the viewport — the drawer is
    // docked to the right edge, so an un-clamped menu would hang off it.
    let left = Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8);
    left = Math.max(8, left) + window.scrollX;
    const top =
      r.bottom + height > window.innerHeight - 8 && r.top - height - 6 > 8
        ? r.top - height - 6 + window.scrollY
        : r.bottom + 6 + window.scrollY;
    setPos({ left, top });
  }, [anchorRef, itemCount]);

  useEffect(() => {
    function onPointerDown(e) {
      // The trigger toggles itself; without this, clicking it to close would
      // close here and immediately reopen there.
      if (anchorRef?.current?.contains(e.target)) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    function onKeyDown(e) {
      // Stopped from propagating, or Escape would also close the whole drawer
      // — one key press, two dismissals, and the thread you were in is gone.
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, anchorRef]);

  if (!pos) return null; // avoid a one-frame flash before we measure
  return createPortal(
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="Message options"
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
    document.body
  );
}
