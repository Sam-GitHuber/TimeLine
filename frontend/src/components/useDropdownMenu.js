import { useEffect, useRef, useState } from "react";

// Shared behaviour for the app's dropdown menus — the nav's account menu, the
// group actions "⋯", and a poll's "⋯". They all want the same wiring:
//   - open state, toggled by the trigger,
//   - close on a click anywhere outside, and on Escape (which also returns focus
//     to the trigger so focus is never orphaned on a menu that's gone),
//   - focus moved into the first item when the menu opens (the menu-button
//     pattern),
//   - Up/Down/Home/End roving through the `role="menuitem"` children (WAI-ARIA).
//
// Each caller still renders its own trigger and panel markup — this owns only
// the wiring, wire the returned refs to `<div ref={menuRef}>` (the wrapper),
// the trigger button (`triggerRef`), and the `role="menu"` panel (`listRef` +
// `onKeyDown={onMenuKeyDown}`). PostMenu deliberately uses a body-level portal
// and `role="dialog"` (no arrow keys) for stacking-context reasons, so it is
// intentionally *not* a consumer.
export function useDropdownMenu() {
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

  return { open, setOpen, menuRef, triggerRef, listRef, onMenuKeyDown };
}

// The shared look of a menu row, so every dropdown's items line up. `danger`
// styles a destructive action (Leave, Delete, Remove).
export const menuItemClass =
  "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-soft transition hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50";
export const menuDangerItemClass =
  "block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50";
