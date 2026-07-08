import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Messaging is a *companion* to the timeline, not a place you navigate to — so
// its open/closed state lives in context (not the URL). Keeping it out of the
// router is deliberate: the feed underneath never unmounts, so it keeps its
// scroll position while you read and reply. The drawer walks between three
// views — the conversation list, a single thread, and the new-message picker.
const MessagingContext = createContext(null);

export function useMessaging() {
  const ctx = useContext(MessagingContext);
  if (!ctx) throw new Error("useMessaging must be used within MessagingProvider");
  return ctx;
}

export function MessagingProvider({ children }) {
  // "closed" | "list" | "thread" | "new"
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
