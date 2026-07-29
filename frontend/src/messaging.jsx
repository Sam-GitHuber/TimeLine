import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Messaging is a *companion* to the timeline, not a place you navigate to — so
// its open/closed state lives in context (not the URL). Keeping it out of the
// router is deliberate: the feed underneath never unmounts, so it keeps its
// scroll position while you read and reply. The drawer walks between four
// views — the conversation list, a single thread, the thread's info panel, and
// the new-message picker.
//
// **A view machine, not a router**, and that's the reason the info panel (Phase
// 9b M9e) is a fourth `view` rather than a `/messages/:id/info` route: the app
// pushes a screen because a phone has a navigation stack, and giving the drawer
// one would mean the browser's Back button closed a panel that isn't a page —
// while Escape, which *is* how you close it, left the history behind.
const MessagingContext = createContext(null);

export function useMessaging() {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used within MessagingProvider");
  return ctx;
}

export function MessagingProvider({ children }) {
  // "closed" | "list" | "thread" | "info" | "new"
  const [view, setView] = useState("closed");
  const [conversationId, setConversationId] = useState(null);
  // Carries context into the "new" view when it's opened from somewhere more
  // specific than the plain compose button — e.g. a group's "start a group
  // chat" action passes { groupId, groupName, memberIds } so NewChatPicker can
  // narrow its list to that group's members and scope the chat to it.
  const [newPrefill, setNewPrefill] = useState(null);

  const openList = useCallback(() => {
    setConversationId(null);
    setView("list");
  }, []);

  const openThread = useCallback((id) => {
    setConversationId(id);
    setView("thread");
  }, []);

  /**
   * Everything *about* the open chat (M9e) — participants, mute, rename, the
   * media gallery. It keeps the conversation id it was on, so Back returns to
   * the transcript rather than to the list.
   */
  const openInfo = useCallback(() => setView("info"), []);

  const openNew = useCallback((prefill = null) => {
    setNewPrefill(prefill);
    setView("new");
  }, []);
  const close = useCallback(() => setView("closed"), []);

  // The nav button: open to the list, or close if it's already showing.
  const toggle = useCallback(() => {
    setView((v) => (v === "closed" ? "list" : "closed"));
    setConversationId(null);
  }, []);

  const value = useMemo(
    () => ({
      view,
      isOpen: view !== "closed",
      conversationId,
      newPrefill,
      openList,
      openThread,
      openInfo,
      openNew,
      close,
      toggle,
    }),
    [
      view,
      conversationId,
      newPrefill,
      openList,
      openThread,
      openInfo,
      openNew,
      close,
      toggle,
    ]
  );

  return (
    <MessagingContext.Provider value={value}>
      {children}
    </MessagingContext.Provider>
  );
}
