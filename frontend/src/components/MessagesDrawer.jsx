import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import NewChatPicker from "./NewChatPicker.jsx";
import ConversationListView from "./messages/ConversationListView.jsx";
import ConversationThreadView from "./messages/ConversationThreadView.jsx";
import { useMessaging } from "../messaging.jsx";

// The messages drawer: a non-modal panel docked to the right edge, so a
// conversation sits *beside* your timeline instead of replacing it. There's no
// scrim and no scroll-lock on purpose — the feed underneath stays fully
// interactive, so you can read and reply without losing your place. It walks
// between three views (list → thread → new message) held in messaging context.
//
// This file is the shell only. The views live in `components/messages/` — split
// out in Phase 9b M9a, before the parity work, so that five feature diffs
// afterwards weren't tangled with a 600-line file being carved up.
/**
 * The panel itself: full width on a phone, 400px from `sm` — and **740px (400 +
 * a 340px strand) once a reply thread is open** and there's room for both, which
 * is Phase 9b M9d's one change to this file.
 *
 * **The width is driven by the DOM, not by state**, and that's deliberate. The
 * strand is rendered three components down, so a flag would have to be threaded
 * through messaging context and could then disagree with what's actually on
 * screen. `has-[[data-strand]]` asks the only question that matters — is there a
 * strand in here — and can't drift from the answer.
 *
 * ⚠️ It has to be a **utility variant**, not a rule in `index.css`. That's the
 * same cascade trap M9b and M9c each recorded: Tailwind's utilities layer comes
 * last, so a component-layer `.msg-drawer:has(…)` would lose to `sm:w-[400px]`
 * and silently do nothing. Written as a utility, `:has()` contributes its
 * argument's specificity and the rule wins on its own merits.
 *
 * `lg` rather than `sm` because below ~1024px two columns aren't two *readable*
 * columns; there the strand replaces the transcript instead, which
 * `ConversationThreadView` handles.
 */
const PANEL_CLASS =
  "msg-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[-14px_0_44px_-26px_rgba(28,26,22,0.4)] outline-none transition-[width] duration-200 sm:w-[400px] lg:has-[[data-strand]]:w-[740px]";

export default function MessagesDrawer() {
  const { isOpen, view, close, newPrefill, conversationId } = useMessaging();
  const panelRef = useRef(null);

  // Esc closes; focus lands in the panel so keys + screen readers work. We
  // deliberately don't trap focus or set aria-modal — the rest of the page is
  // meant to stay usable (that's the whole point of the companion panel).
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
      aria-label="Messages"
      tabIndex={-1}
      className={PANEL_CLASS}
    >
      {view === "list" && <ConversationListView />}
      {/* Keyed on the conversation so switching threads remounts rather than
          reusing the view. Since Phase 9b M9b the thread holds state that is
          only true of *one* conversation — the latched unread divider, the
          composer's draft, the message being edited — and carrying any of that
          into a different chat would be worse than a flicker. */}
      {view === "thread" && (
        <ConversationThreadView key={conversationId} />
      )}
      {view === "new" && <NewChatPicker prefill={newPrefill} />}
    </aside>,
    document.body
  );
}
