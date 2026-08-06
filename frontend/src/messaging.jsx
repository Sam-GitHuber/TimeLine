import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

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

/**
 * **Hold the drawer open while this panel's write is out** (issue #258).
 *
 * The house rule is
 * [connections.md](../../docs/reference/connections.md#reporting-a-refused-write):
 * a component that is the only renderer of its own error may not be dismissed
 * while that write is in flight. Every other member of that family gates its own
 * dismissal route, because the button and the mutation are in the same file.
 * Here they aren't: Escape belongs to `MessagesDrawer`, and the ✕ and the Back
 * arrow to `PanelHeader` — one level above whichever panel is showing, with no
 * way to see its mutation. So the panel says so, and the chrome reads the flag.
 *
 * Counted, not a boolean: panels mount and unmount as `view` walks between them,
 * and a bare flag would let one panel's cleanup clear a hold another had taken.
 */
export function useHoldMessagesOpen(pending) {
  const { beginWrite, endWrite } = useMessaging();
  useEffect(() => {
    if (!pending) return undefined;
    beginWrite();
    return endWrite;
  }, [pending, beginWrite, endWrite]);
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
  // How many writes the open panel has out (see `useHoldMessagesOpen`). While
  // it's above zero the drawer refuses to close, because closing it unmounts
  // the only thing that can report a rejection.
  const [writesInFlight, setWritesInFlight] = useState(0);
  const isWriting = writesInFlight > 0;

  const beginWrite = useCallback(() => setWritesInFlight((n) => n + 1), []);
  const endWrite = useCallback(
    () => setWritesInFlight((n) => Math.max(0, n - 1)),
    []
  );

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
  /**
   * Close the drawer — **unless a panel inside it has a write out** (#258).
   *
   * Closing unmounts whichever panel is showing, and two of them are the only
   * renderer of their own rejection: `NewChatPicker` (add people / start a chat)
   * and `ConversationInfoView` (rename), plus the thread's message edit (#257).
   * A close that lands before the server answers takes the message with it, so
   * you walk away believing two people were added and they weren't.
   *
   * Gated *here* rather than at each caller because there are four ways in —
   * Escape (`MessagesDrawer`), the ✕ and Back (`PanelHeader`), and the nav
   * button (`Layout`) — and one of them, Escape, has no button to disable.
   * The visible controls are held as well, so the ✕ reads as unavailable rather
   * than broken; this is the backstop behind them, not the whole fix.
   *
   * Returns whether it actually closed, which `Layout` needs: on a narrow
   * viewport opening the groups drawer closes this one, and a groups drawer
   * opened over a messages drawer that refused to go would cover the very
   * message the refusal exists to show.
   */
  const close = useCallback(() => {
    if (isWriting) return false;
    setView("closed");
    return true;
  }, [isWriting]);

  // The nav button: open to the list, or close if it's already showing. Only the
  // *closing* half is held — pressing "Messages" to shut a drawer with a write
  // out is a dismissal like any other, but nothing about a write should ever
  // stop the drawer being opened.
  const toggle = useCallback(() => {
    if (view !== "closed" && isWriting) return;
    setView((v) => (v === "closed" ? "list" : "closed"));
    setConversationId(null);
  }, [view, isWriting]);

  const value = useMemo(
    () => ({
      view,
      isOpen: view !== "closed",
      conversationId,
      newPrefill,
      isWriting,
      beginWrite,
      endWrite,
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
      isWriting,
      beginWrite,
      endWrite,
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
