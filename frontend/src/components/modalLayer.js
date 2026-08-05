import { useEffect, useRef } from "react";

// The two things every layer that covers the page — the photo viewer, a confirm
// dialog, the report modal, the avatar cropper — has to get right, in one place.
//
// Both were written out by hand in each of them, and both are only correct while
// exactly one layer is open. The album made two of them stack for the first time
// (open a photo, press Remove, and the confirm dialog mounts *over* the viewer),
// which is where each hand-written copy broke:
//
// - **Scroll lock.** Each copy saved `document.body.style.overflow` on mount and
//   put it back on unmount. The dialog mounting second saved `"hidden"` — the
//   value the viewer had just set — as "what it was before". Confirming the
//   delete unmounts both in one commit, React runs the cleanups in child order,
//   so the viewer restored `""` and the dialog then put `"hidden"` back. The
//   whole app could not scroll again until a reload. Counting the locks instead
//   means only the *last* layer to close restores anything, and it restores what
//   was there before the *first* one opened.
// - **Escape.** The viewer listened in the capture phase and stopped
//   propagation, which is right and deliberate: it opens from inside the
//   messages drawer, and the drawer closes on Escape too, so one press used to
//   shut the photo *and* the panel behind it. But the confirm dialog listened in
//   the bubble phase, and the DOM's stop-propagation flag skips document's own
//   bubble listeners — so Escape on the stacked pair closed the viewer
//   *underneath* and left the dialog on screen. A stack fixes both cases with
//   one rule: the layer opened last is the one Escape is about.
//
// Deliberately two hooks, not one: every modal wants the lock, but only the two
// that stack have been moved onto the shared Escape stack (the rest own an
// Escape listener with its own conditions, and none of them stacks with
// anything). A new layer should use both.

// ---------------------------------------------------------------------------
// Background scroll
// ---------------------------------------------------------------------------

// How many layers are currently holding the lock, and what the page's own
// `overflow` was before the first of them took it. Module-level on purpose:
// there is one `document.body`, so there's one count.
let locks = 0;
let overflowBeforeFirstLock = "";

// Hold the background still while this component is mounted.
export function useScrollLock() {
  useEffect(() => {
    if (locks === 0) {
      overflowBeforeFirstLock = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0) document.body.style.overflow = overflowBeforeFirstLock;
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Escape
// ---------------------------------------------------------------------------

// Open layers, oldest first — so the last entry is the one on top.
const layers = [];

function onDocumentKeyDown(event) {
  if (event.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (!top) return;
  // Swallowed whether or not the top layer acts on it. A layer that's holding
  // Escape shut is doing so deliberately (a dialog won't dismiss out from under
  // a delete that's already gone to the server), and letting the press fall
  // through to the viewer *behind* it would be exactly the bug this stack
  // exists to stop. Capture + stopPropagation is the same technique the viewer
  // used to carry on its own, and `DrawerPopover` still does: it runs before any
  // bubble-phase listener on `document`, so the nearest thing wins.
  event.stopPropagation();
  if (top.enabled) top.onEscape();
}

// One document listener for the whole stack, added with the first layer and
// removed with the last, so an app with nothing open has none.
function pushLayer(layer) {
  layers.push(layer);
  if (layers.length === 1) {
    document.addEventListener("keydown", onDocumentKeyDown, true);
  }
}

function popLayer(layer) {
  const at = layers.indexOf(layer);
  if (at !== -1) layers.splice(at, 1);
  if (layers.length === 0) {
    document.removeEventListener("keydown", onDocumentKeyDown, true);
  }
}

/**
 * Register this component as the topmost layer for as long as it's mounted:
 * Escape calls `onEscape`, and reaches nothing behind it.
 *
 * `enabled` is for the dialogs that refuse to dismiss mid-write — pass false and
 * the press is still swallowed, it just doesn't do anything.
 */
export function useEscapeLayer(onEscape, enabled = true) {
  // The handler and the gate change from render to render; the entry in the
  // stack must not, because its *position* is what makes this layer the top one.
  // So the entry is a stable object whose fields are kept up to date.
  const layer = useRef({ onEscape, enabled });
  useEffect(() => {
    layer.current.onEscape = onEscape;
    layer.current.enabled = enabled;
  });

  useEffect(() => {
    const entry = layer.current;
    pushLayer(entry);
    return () => popLayer(entry);
  }, []);
}
