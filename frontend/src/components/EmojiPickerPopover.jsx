import { useEffect, useRef } from "react";
// Vite bundles this JSON as a first-party asset and hands us its URL, so the
// picker loads its emoji data from *our* origin. emoji-picker-element otherwise
// defaults to a jsDelivr CDN — a third-party request we won't make (the app's
// privacy stance is: no external calls, ever). See docs/reference/reactions.md.
import emojiDataUrl from "emoji-picker-element-data/en/emojibase/data.json?url";

// Theme emoji-picker-element to the app's light look. Its style hooks are CSS
// custom properties; because the picker lives in the light DOM (portalled onto
// <body>), it inherits our design tokens, so we can map its hooks straight onto
// them — one source of truth, and it would follow the app into a dark mode for
// free. Forcing `.light` also sets `color-scheme: light` so the search input's
// native chrome matches.
const PICKER_THEME = {
  "--background": "var(--color-raised)",
  "--border-color": "var(--color-line)",
  "--indicator-color": "var(--color-accent)",
  "--input-border-color": "var(--color-line-strong)",
  "--input-font-color": "var(--color-ink)",
  "--input-placeholder-color": "var(--color-ink-faint)",
  "--outline-color": "var(--color-accent)",
  "--category-font-color": "var(--color-ink-soft)",
  "--button-active-background": "var(--color-accent-tint)",
  "--button-hover-background": "var(--color-accent-tint)",
};

// A popover wrapping the `<emoji-picker>` web component (emoji-picker-element):
// a searchable, categorised, full-Unicode picker that renders native system
// emoji (no image assets) and, with `dataSource` pointed at our bundled data,
// makes no network request. Calls `onPick(emoji)` with the chosen emoji string.
//
// Positioned by its parent portal (fixed, on <body>) — it deliberately does no
// positioning itself. `ignoreRef` is the trigger button: a click on it isn't
// treated as "outside" (otherwise re-clicking the button to close would close
// then immediately reopen).
export default function EmojiPickerPopover({ onPick, onClose, ignoreRef }) {
  const hostRef = useRef(null);
  const wrapRef = useRef(null);
  // Keep the latest callbacks in refs so the setup effect runs exactly once
  // (rebuilding the picker on every parent render would be wasteful and would
  // drop the user's search/scroll position). Refs are updated in an effect —
  // never during render — and read only inside event handlers, by which time
  // they hold the current callbacks.
  const onPickRef = useRef(onPick);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onPickRef.current = onPick;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    let picker;
    let cancelled = false;
    async function setup() {
      // Register the custom element lazily — its code + emoji data stay out of
      // the initial bundle and load only when someone actually opens a picker.
      await import("emoji-picker-element");
      if (cancelled || !hostRef.current) return;
      picker = document.createElement("emoji-picker");
      picker.dataSource = emojiDataUrl;
      // Force the light skin and paint it in the app's tokens (see PICKER_THEME).
      picker.classList.add("light");
      for (const [prop, value] of Object.entries(PICKER_THEME)) {
        picker.style.setProperty(prop, value);
      }
      picker.addEventListener("emoji-click", (event) => {
        const unicode = event.detail?.unicode;
        if (unicode) onPickRef.current(unicode);
      });
      hostRef.current.appendChild(picker);
    }
    setup();
    return () => {
      cancelled = true;
      picker?.remove();
    };
  }, []);

  // Dismiss on an outside click or Escape — what anyone expects of a popover.
  useEffect(() => {
    function onPointerDown(e) {
      if (ignoreRef?.current && ignoreRef.current.contains(e.target)) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        onCloseRef.current();
      }
    }
    function onKeyDown(e) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ignoreRef]);

  return (
    <div ref={wrapRef} role="dialog" aria-label="Choose an emoji">
      <div
        ref={hostRef}
        className="overflow-hidden rounded-2xl border border-line shadow-lg"
      />
    </div>
  );
}
