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
export default function MessagesDrawer() {
  const { isOpen, view, close, newPrefill } = useMessaging();
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
      className="msg-drawer fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-[-14px_0_44px_-26px_rgba(28,26,22,0.4)] outline-none sm:w-[400px]"
    >
      {view === "list" && <ConversationListView />}
      {view === "thread" && <ConversationThreadView />}
      {view === "new" && <NewChatPicker prefill={newPrefill} />}
    </aside>,
    document.body
  );
}
