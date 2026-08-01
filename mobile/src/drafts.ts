/**
 * Half-written messages, kept per conversation (Phase 9b M5).
 *
 * Type three words, tap back to check what someone said in another chat, come
 * back — the words should still be there. They weren't: the composer's text was
 * component state and died with the screen, so the most ordinary navigation in
 * the app silently ate a draft. Every mainstream messenger holds this, and its
 * absence is the kind of thing people don't report as a bug so much as quietly
 * stop trusting.
 *
 * **A deliberately smaller sibling of `outbox.ts`, not a copy of it.** They look
 * alike and answer different questions: the outbox holds text the server has
 * been *asked* to take and hasn't, which is why it's a subscribable store that
 * re-renders bubbles. A draft has exactly one reader — the `TextInput` of the
 * screen you're on — and that screen already re-renders on every keystroke via
 * its own state. So this is a plain map with a get and a set, and the screen
 * seeds its state from it on mount. Making it a store would buy nothing and cost
 * a subscription per keystroke.
 *
 * **In memory only, which is the milestone's own instruction** ("in-memory is
 * enough to start"). It survives leaving and returning to a thread, and a cold
 * app start clears it. Persisting would mean unsent words written to disk, which
 * is a bigger promise than "your draft is still here" and wants a deliberate
 * decision about where they live rather than a `SecureStore` call added in
 * passing.
 *
 * 🔒 **Cleared on sign-out** (`auth.tsx`) — and, like the outbox, at the next
 * sign-in when a *different* person follows an expiry (#191) — for exactly the
 * reason the outbox is: a draft is one person's words, and the next person to
 * pick the phone up isn't them.
 */

const drafts = new Map<number, string>();

/** What was left in this conversation's composer, or `''`. */
export function getDraft(conversationId: number): string {
  return drafts.get(conversationId) ?? '';
}

/** Remember (or, for empty text, forget) this conversation's draft. */
export function setDraft(conversationId: number, text: string) {
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
}

/** 🔒 Drop every draft. Sign-out, a different person's sign-in after an
 * expiry (#191), and resetting the module between tests. */
export function clearDrafts() {
  drafts.clear();
}
