/**
 * Messages you've sent that the server hasn't accepted yet (Phase 9b M4, on the
 * web in M9c).
 *
 * A port of `mobile/src/outbox.ts`, comments and all — the module the app has
 * been running since M4. If one of these changes, the other should too.
 *
 * **Why an outbox at all, rather than optimistic writes into the TanStack
 * cache** — which is the more obvious shape, and what the milestone plan first
 * sketched: the thread refetches `['messages', id]` every `MESSAGE_POLL_MS`, and
 * a refetch *replaces* an infinite query's pages. Anything written in
 * optimistically survives at most four seconds. That's tolerable for the
 * in-flight moment and fatal for a **failed** send, which has to sit there until
 * the person decides what to do with it — so the cache would quietly eat the one
 * message it mattered most to keep.
 *
 * Keeping unsent messages outside the server-truth cache is what makes "we never
 * drop text you typed" hold, and it means the two never have to be reconciled:
 * the cache holds exactly what the server said, the outbox exactly what it
 * hasn't accepted.
 *
 * **And it outlives the view**, which is the point rather than a detail. The
 * drawer switches between the conversation list and a thread without a route
 * change, so held as component state a failed message — the one case this exists
 * for — would be thrown away by clicking "back to messages". A module-level
 * store keyed by conversation id survives that; the thread subscribes to its own
 * conversation's slice and re-renders when it moves.
 *
 * 🔒 It is **cleared on sign-out** (`auth.jsx`), like the drafts store beside it.
 * Unsent text is one person's words, and on a shared computer the next person to
 * open the drawer isn't them.
 */

import { useCallback, useSyncExternalStore } from "react";

/**
 * An entry is `{ tempId, text, createdAt, status }`, where `tempId` is negative
 * so it can never collide with a server id, and `status` is `"sending"` or
 * `"failed"`.
 *
 * The app's entry carries three more fields, each arriving with the chunk that
 * needs it rather than sitting here unused: `replyToId`/`rootId` (M9d, so a
 * reply that fails inside a strand is recoverable from the transcript too),
 * `photo` (M9e) and `mentionIds` (M9f — kept on the entry so a *retry* sends the
 * same mentions, since otherwise a failed message that named someone would
 * quietly stop naming them on the second attempt).
 */

let nextTempId = -1;

/**
 * Unsent messages per conversation. A `Map` keyed by conversation id, so two
 * threads opened in the same session can't spill into one another and a thread
 * you return to still has what you left in it.
 */
const byConversation = new Map();
const listeners = new Map();

/**
 * One shared empty array, not a fresh `[]` per call. `useSyncExternalStore`
 * compares snapshots by identity, so returning a new array for an empty outbox
 * would re-render on every check and eventually throw.
 */
const NONE = [];

/** What's unsent in this conversation right now. */
export function outboxFor(conversationId) {
  return byConversation.get(conversationId) ?? NONE;
}

/**
 * Replace one conversation's outbox and tell its subscribers.
 *
 * Takes a function of the current list rather than the list itself, so callers
 * can't act on a stale copy — the same reason a state setter takes an updater.
 */
export function updateOutbox(conversationId, update) {
  const next = update(outboxFor(conversationId));
  if (next.length === 0) byConversation.delete(conversationId);
  else byConversation.set(conversationId, next);
  listeners.get(conversationId)?.forEach((notify) => notify());
}

/**
 * Subscribe to one conversation's outbox. Returns the current entries and
 * re-renders on every change to them — the store's half of `useState`.
 */
export function useOutbox(conversationId) {
  // Both memoised on the conversation id. `useSyncExternalStore` resubscribes
  // whenever `subscribe` changes identity, and the thread re-renders on every
  // poll — so an inline closure would tear the subscription down and build it
  // back up several times a second for nothing.
  const subscribe = useCallback(
    (notify) => {
      const forThis = listeners.get(conversationId) ?? new Set();
      forThis.add(notify);
      listeners.set(conversationId, forThis);
      return () => {
        forThis.delete(notify);
        if (forThis.size === 0) listeners.delete(conversationId);
      };
    },
    [conversationId]
  );
  const snapshot = useCallback(
    () => outboxFor(conversationId),
    [conversationId]
  );
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Throw away every unsent message, everywhere.
 *
 * 🔒 Called on sign-out, and that's the point of it: because the outbox outlives
 * the view it would otherwise outlive the *session* too, leaving one person's
 * unsent words in a browser the next person is using. Also used to reset the
 * module between tests.
 */
export function clearOutbox() {
  const conversations = [...byConversation.keys()];
  byConversation.clear();
  conversations.forEach((id) =>
    listeners.get(id)?.forEach((notify) => notify())
  );
}

/** A fresh outbox entry for a message just handed to `sendMessage`. */
export function newOutgoing({ text }) {
  return {
    tempId: nextTempId--,
    text,
    // The device clock, only ever used to sort this bubble to the bottom of the
    // list until the server's own timestamp replaces it wholesale.
    createdAt: new Date().toISOString(),
    status: "sending",
  };
}

/**
 * Dress an outbox entry as a message so the transcript can render it with the
 * same bubble as everything else.
 *
 * Deliberately a real message shape rather than a parallel "pending bubble"
 * component: a message that looks subtly different while it's in flight is a
 * message that appears to *change* when it lands, and the whole point of showing
 * it immediately is that sending should feel like nothing happened in between.
 */
export function asMessage(entry, me) {
  return {
    id: entry.tempId,
    sender: me,
    text: entry.text,
    is_deleted: false,
    is_edited: false,
    created_at: entry.createdAt,
    edited_at: null,
    reactions: [],
    attachments: [],
  };
}
