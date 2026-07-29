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
 * An entry is `{ tempId, text, replyToId, rootId, createdAt, status }`, where
 * `tempId` is negative so it can never collide with a server id, and `status` is
 * `"sending"` or `"failed"`.
 *
 * `replyToId`/`rootId` arrived with M9d. Both are kept, and they're not the same
 * question: `replyToId` is what a **retry** has to send again, or a reply that
 * failed would quietly turn into an ordinary message on the second attempt;
 * `rootId` is which strand the bubble belongs *in*, and it's the client's own
 * guess (`thread_root_id ?? id` of the message being answered) because there is
 * no server copy to read until the send lands. It's what lets a failed reply be
 * recoverable from inside the strand as well as from the transcript.
 *
 * `photo` arrived with M9e — a prepared photo (see `chatPhotos.js`) held on the
 * entry for the same retry reason as `replyToId`: a failed photo send has to be
 * re-sendable without asking someone to find the picture again.
 *
 * `mentionIds` arrived with M9f, and it's the third instance of that one rule: a
 * mention that a retry dropped would leave the `@Ada` sitting in the text with
 * nothing behind it — no notification through her muted thread, and not even a
 * highlight, since the highlight is driven by the ids. A silent downgrade of
 * what the message *does*, on a second attempt nobody watched.
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
  const previous = outboxFor(conversationId);
  const next = update(previous);
  releaseDropped(previous, next);
  if (next.length === 0) byConversation.delete(conversationId);
  else byConversation.set(conversationId, next);
  listeners.get(conversationId)?.forEach((notify) => notify());
}

/**
 * Free the preview object URLs of entries that have just left the outbox
 * (Phase 9b M9e).
 *
 * An in-flight photo bubble draws a `blob:` URL made from the prepared
 * thumbnail, and an object URL is a *document-lifetime* reference: left
 * dangling, every photo you send pins its thumbnail's bytes in memory until the
 * tab closes. Doing it here rather than at the two call sites that drop an entry
 * (a settled send, a discard) is what makes it impossible to forget — every exit
 * from the outbox goes through this function, including `clearOutbox`.
 *
 * Revoking doesn't disturb the bubble on screen: the entry is being replaced by
 * the server's own message, which carries real `/media/` URLs, and an image the
 * browser has already decoded is unaffected by its URL going away.
 */
function releaseDropped(previous, next) {
  const kept = new Set(next.map((entry) => entry.tempId));
  previous.forEach((entry) => {
    if (!kept.has(entry.tempId) && entry.photo?.previewUrl) {
      URL.revokeObjectURL(entry.photo.previewUrl);
    }
  });
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
  conversations.forEach((id) => releaseDropped(outboxFor(id), NONE));
  byConversation.clear();
  conversations.forEach((id) =>
    listeners.get(id)?.forEach((notify) => notify())
  );
}

/** A fresh outbox entry for a message just handed to `sendMessage`. */
export function newOutgoing({ text, replyToId, rootId, photo, mentionIds }) {
  return {
    tempId: nextTempId--,
    text,
    replyToId,
    rootId,
    photo,
    mentionIds,
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
    /**
     * Why the send failed, if it did (M9e) — **the one field here that isn't a
     * server field**, which is why it's camelCase among snake_case: nothing
     * should mistake it for something the API returned.
     *
     * It rides on the message rather than being passed alongside it because a
     * failed bubble is rendered from two places (the transcript and a reply
     * strand), and a second prop threaded through both is a second thing that
     * can be present in one view and missing in the other.
     */
    outboxError: entry.error ?? null,
    text: entry.text,
    is_deleted: false,
    is_edited: false,
    created_at: entry.createdAt,
    edited_at: null,
    reactions: [],
    // Bare ids, exactly as the server serialises them (M9f), so the optimistic
    // bubble highlights the name it's about to notify rather than lighting up a
    // beat later when the server's copy replaces it.
    mentions: entry.mentionIds ?? [],
    // 🔒 A bare `{ id }`, exactly like the server's own `reply_to` — so an
    // in-flight reply resolves its quote through `quotes.js` the same way an
    // accepted one does, rather than being the one bubble that renders a quote
    // from something it was handed.
    reply_to: entry.replyToId ? { id: entry.replyToId } : null,
    thread_root_id: entry.rootId ?? null,
    reply_count: 0,
    // The local file stands in for the server's copy until it lands (M9e). A
    // negative `id` matching the entry's `tempId` keeps it distinct from any
    // real attachment, and both URLs point at the prepared thumbnail: the bubble
    // draws it, and there's nothing full-size to open yet — which is why the
    // bubble leaves an unsent photo unclickable rather than opening a lightbox
    // onto a smaller copy of what's already on screen.
    attachments: entry.photo
      ? [
          {
            id: entry.tempId,
            kind: "image",
            url: entry.photo.previewUrl,
            thumbnail: entry.photo.previewUrl,
            width: entry.photo.width,
            height: entry.photo.height,
          },
        ]
      : [],
  };
}
