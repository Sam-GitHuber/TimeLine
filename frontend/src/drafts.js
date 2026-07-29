/**
 * Half-written messages, kept per conversation (Phase 9b M9b).
 *
 * A port of `mobile/src/drafts.ts`. Type three words, click into another chat to
 * check what someone said, come back — the words should still be there. They
 * weren't: the composer's text was component state and died when the drawer
 * switched views, so the most ordinary navigation in the app silently ate a
 * draft. Every mainstream messenger holds this, and its absence is the kind of
 * thing people don't report as a bug so much as quietly stop trusting.
 *
 * A plain map with a get and a set, not a store: a draft has exactly one reader
 * — the `<textarea>` of the thread you're looking at — and that component
 * already re-renders on every keystroke from its own state. It seeds itself from
 * here when it mounts.
 *
 * **In memory only.** It survives leaving and returning to a thread, and a page
 * reload clears it. Persisting would mean unsent words written to disk, which is
 * a bigger promise than "your draft is still here" and wants a deliberate
 * decision about where they live rather than a `localStorage` call added in
 * passing.
 *
 * 🔒 **Cleared on sign-out** (`auth.jsx`): a draft is one person's words, and on
 * a shared computer the next person to use the browser isn't them.
 */

const drafts = new Map();

/** What was left in this conversation's composer, or `""`. */
export function getDraft(conversationId) {
  return drafts.get(conversationId) ?? "";
}

/** Remember (or, for empty text, forget) this conversation's draft. */
export function setDraft(conversationId, text) {
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
}

/** 🔒 Drop every draft. Sign-out, and resetting the module between tests. */
export function clearDrafts() {
  drafts.clear();
}
