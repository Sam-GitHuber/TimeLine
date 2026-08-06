import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import NewChatPicker from "./NewChatPicker.jsx";
import ConversationInfoView from "./messages/ConversationInfoView.jsx";
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
 * The panel itself: full width on a phone, 400px from `sm`, and **that width
 * whatever is open inside it**.
 *
 * Phase 9b M9d tried the other thing first — widening to 740 on a big window so
 * a reply strand could sit *beside* the transcript — and it was rejected on
 * sight: a drawer that grows to half the window stops being a companion to the
 * timeline and starts being a takeover, which is the one thing this panel is
 * shaped not to do. A strand opens over the transcript instead, at every width.
 * One width, one column, no breakpoint to reason about.
 */
const PANEL_CLASS =
  "msg-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[-14px_0_44px_-26px_rgba(28,26,22,0.4)] outline-none sm:w-[400px]";

export default function MessagesDrawer() {
  const { isOpen, view, close, newPrefill, conversationId } = useMessaging();
  const panelRef = useRef(null);

  // Focus lands in the panel **on open** so keys + screen readers work. We
  // deliberately don't trap focus or set aria-modal — the rest of the page is
  // meant to stay usable (that's the whole point of the companion panel).
  //
  // ⚠️ Its own effect, keyed on `isOpen` alone, and that separation is
  // load-bearing rather than tidiness. It used to share the effect below, which
  // is keyed on `close` — and since #258 `close`'s identity changes every time a
  // panel's write starts *and* every time one settles. Left together, pressing
  // Save on a message edit re-ran this line and yanked focus out of the
  // composer, then did it again when the answer landed, mid-typing. An effect
  // that grabs focus must depend only on the thing that should grab it.
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  // Esc closes. `close()` itself declines while a panel has a write out
  // (#258) — this listener is the one dismissal route with no button to hold, so
  // the refusal has to live in the function rather than beside the control.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
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
      {/* The info panel (M9e). Unlike the transcript it holds nothing worth
          preserving across a visit — the rename is the only editable thing on
          it, and abandoning one halfway is a reason to *not* keep it. */}
      {view === "info" && <ConversationInfoView key={conversationId} />}
      {view === "new" && <NewChatPicker prefill={newPrefill} />}
    </aside>,
    document.body
  );
}
