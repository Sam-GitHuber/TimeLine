import { useRef, useState } from "react";
import DrawerPopover from "./DrawerPopover.jsx";

/**
 * A `⋯` menu inside the messages drawer (Phase 9b M9e) — a trigger, a portalled
 * panel, and a list of actions.
 *
 * Extracted when the drawer grew its second and third one: a conversation row's
 * (Mute · Mark unread · Leave) and the thread header's (Info · Mute · Add ·
 * Leave), beside the bubble's, which stays in `MessageMenu` because its panel
 * carries an emoji row and a lazily-loaded picker that nothing else wants.
 *
 * **Items are data, not JSX**, the same shape `messageActions` produces —
 * `{ label, onClick, danger }` — so a caller decides what a menu offers by
 * building a list rather than by threading conditionals through markup.
 *
 * `getActions` is a *function*, called when the menu opens rather than during
 * render, because an item's availability can be a fact about *now* rather than
 * about the last time React drew the row.
 *
 * The panel is a `DrawerPopover` — portalled to `<body>` and positioned in
 * viewport coordinates. That isn't a flourish: these anchors sit inside a
 * `fixed` drawer whose list is an `overflow-y-auto` scroller, so a menu left in
 * the flow would be clipped on the rows nearest the bottom, which are exactly
 * the rows a long list has.
 */
export default function DrawerMenu({
  getActions,
  label,
  /** Width of the panel, in px — placement only (`DrawerPopover` flips it above
   * when there's no room below). Wider than the bubble menu's default where the
   * items are sentences ("Mark unread") rather than verbs. */
  width = 176,
  /**
   * Reveal the trigger only on hover, as a bubble's does — for a row in a list,
   * where a permanently visible `⋯` on every line would be visual noise. A
   * header's trigger is always visible, because it's the only way to reach what
   * it holds. See `msg-menu-trigger` in `index.css` for why an input that can't
   * hover always sees it.
   */
  onHover = false,
  className = "",
}) {
  const triggerRef = useRef(null);
  const [actions, setActions] = useState(null);
  const open = actions !== null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          // The row underneath is itself clickable (it opens the thread), and a
          // menu that also opened the chat it was about would be unusable.
          event.stopPropagation();
          if (open) setActions(null);
          else setActions(getActions());
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={`${
          onHover ? "msg-menu-trigger" : ""
        } flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep ${className}`}
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
        <DrawerPopover
          anchorRef={triggerRef}
          label={label}
          width={width}
          height={actions.length * ITEM_HEIGHT + PANEL_PADDING}
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
        </DrawerPopover>
      )}
    </>
  );
}

/**
 * One row in a drawer menu — a plain button.
 *
 * Deliberately not ARIA `menuitem`/`menu`, matching `PostMenu`: those roles
 * advertise arrow-key navigation we don't implement, so a `role="dialog"`
 * popover of ordinary buttons is the honest house pattern.
 */
export function MenuItem({ onClick, danger = false, children }) {
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

const ITEM_HEIGHT = 36;
const PANEL_PADDING = 8;
