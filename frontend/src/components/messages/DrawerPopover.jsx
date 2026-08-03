import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A popover anchored to something inside the messages drawer (Phase 9b M9b, made
 * shared in M9c) — the ⋯ menu, the emoji picker it expands to, and the
 * who-reacted list off a pill all sit in one of these.
 *
 * **Viewport coordinates, and `position: fixed`** — not the page coordinates
 * `PostMenu` and the feed's `ReactionBar` use. That difference is not a style
 * choice: those are anchored to a post in the normal page flow, so a
 * document-positioned portal scrolls with its anchor. These anchors live inside
 * a **`fixed`** drawer, which doesn't move when the page scrolls — so a
 * document-positioned popover slides away from the bubble it belongs to the
 * moment the feed behind the drawer is scrolled.
 *
 * Portalled to `<body>` rather than left in the flow, which isn't cosmetic
 * either: the transcript is an `overflow-y-auto` scroller, so a popover in the
 * flow would be clipped by it on the bubbles nearest the top and bottom.
 *
 * `width`/`height` are the *expected* size, used only to decide placement (flip
 * above when there's no room below, clamp to the viewport). Re-measured when
 * they change, because the ⋯ menu grows into a full emoji picker in place — a
 * menu-sized position under a picker-sized panel would hang off the window.
 */
export default function DrawerPopover({
  anchorRef,
  width,
  height,
  /** True when the child draws its own frame, so this adds no chrome of its own
   * — two borders around one popover is the tell of a wrapper applied twice. */
  bare = false,
  label,
  onClose,
  children,
}) {
  const wrapRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Right-align with the anchor, clamped to the viewport — the drawer is
    // docked to the right edge, so an un-clamped popover would hang off it.
    let left = Math.min(r.right - width, window.innerWidth - width - 8);
    left = Math.max(8, left);
    const top =
      r.bottom + height > window.innerHeight - 8 && r.top - height - 6 > 8
        ? r.top - height - 6
        : r.bottom + 6;
    setPos({ left, top });
  }, [anchorRef, width, height]);

  useEffect(() => {
    function onPointerDown(e) {
      // The anchor toggles itself; without this, clicking it to close would
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
    // Any scroll anywhere closes it. The popover is measured once and then sits
    // still, so scrolling the transcript underneath it would leave it hovering
    // over a *different* message — and acting on the right one while pointing at
    // the wrong one is the exact failure an anchored menu exists to prevent (see
    // messaging.md on why this isn't a bottom sheet). Re-measuring on every
    // scroll frame would be the other answer, but closing is what a popover
    // whose anchor has moved should do anyway.
    //
    // Capture, because `scroll` doesn't bubble: the transcript is an inner
    // scroller, and a listener on `document` would never hear it otherwise.
    function onScroll(e) {
      if (wrapRef.current?.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose, anchorRef]);

  if (!pos) return null; // avoid a one-frame flash before we measure
  return createPortal(
    <div
      ref={wrapRef}
      // Marks the portalled panel for handlers on whatever *rendered* it. React
      // events propagate through the React tree, not the DOM one, so a click in
      // here bubbles up to the element that owns this popover even though the
      // node lives on `<body>` — which is how a click on a menu's padding used
      // to reach the bubble underneath and open its strand. `role="dialog"`
      // can't do the job: `bare` panels deliberately have no role.
      data-popover=""
      role={bare ? undefined : "dialog"}
      aria-label={bare ? undefined : label}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width,
        zIndex: 60,
      }}
      className={
        bare
          ? ""
          : "overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-lg"
      }
    >
      {children}
    </div>,
    document.body
  );
}
