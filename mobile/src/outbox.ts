/**
 * Messages you've sent that the server hasn't accepted yet (Phase 9b M4).
 *
 * **Why an outbox at all, rather than optimistic writes into the TanStack
 * cache** — which is the more obvious shape and what the milestone plan first
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
 * It lives in its own module because the transcript and the focused thread view
 * both render from it — a reply is an ordinary message, so one that fails on its
 * way out of a strand has to be recoverable from the transcript too.
 *
 * **And it outlives the screen**, which is the whole point rather than a detail.
 * Held as component state it was lost the moment you tapped back, so a failed
 * message — the one case this exists for — was silently thrown away by an
 * ordinary navigation, exactly the "never drop text you typed" promise it makes.
 * A module-level store keyed by conversation id survives that; the thread
 * subscribes to its own conversation's slice and re-renders when it moves.
 *
 * 🔒 It is **cleared on sign-out** (`auth.tsx`). Unsent text is one person's
 * words, and the next person to use the phone is not that person.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { PreparedChatPhoto } from '@/api';
import type { Author, Message } from '@/types';

export type Outgoing = {
  /** Negative, so it can never collide with a server id in `keyExtractor`. */
  tempId: number;
  text: string;
  /** Set when this was sent from a strand's composer. */
  replyToId?: number;
  /** Which strand it belongs to, so the focused view can render it too. */
  rootId?: number;
  createdAt: string;
  status: 'sending' | 'failed';
  /**
   * A photo being sent with it (Phase 9b M7), already prepared for upload.
   *
   * Held here rather than in screen state for the same reason the text is: a
   * failed photo send has to survive the navigation away and still be
   * retryable, and the prepared files sit in the app's cache directory, so the
   * URIs stay valid. `previewUri` is what the in-flight bubble draws — the
   * local thumbnail, so a photo appears the instant you hit send rather than
   * after a round trip.
   */
  photo?: OutgoingPhoto;
  /**
   * Who it names with `@` (Phase 9b M8), as user ids — kept with the entry so a
   * **retry sends the same mentions**. Without it a failed message that named
   * someone would quietly stop naming them on the second attempt, and the one
   * thing a mention does (reach a muted thread) would silently not happen.
   */
  mentionIds?: number[];
};

export type OutgoingPhoto = PreparedChatPhoto & { previewUri: string };

let nextTempId = -1;

/**
 * Unsent messages per conversation. A `Map` keyed by conversation id, so two
 * threads open in the same session can't spill into one another and a thread
 * you return to still has what you left in it.
 */
const byConversation = new Map<number, Outgoing[]>();
const listeners = new Map<number, Set<() => void>>();

/**
 * One shared empty array, not a fresh `[]` per call. `useSyncExternalStore`
 * compares snapshots by identity, so returning a new array for an empty outbox
 * would re-render on every check and eventually throw.
 */
const NONE: Outgoing[] = [];

/** What's unsent in this conversation right now. */
export function outboxFor(conversationId: number): Outgoing[] {
  return byConversation.get(conversationId) ?? NONE;
}

/**
 * Replace one conversation's outbox and tell its subscribers.
 *
 * Takes a function of the current list rather than the list itself, so callers
 * can't act on a stale copy — the same reason a state setter takes an updater.
 */
export function updateOutbox(
  conversationId: number,
  update: (entries: Outgoing[]) => Outgoing[]
) {
  const next = update(outboxFor(conversationId));
  if (next.length === 0) byConversation.delete(conversationId);
  else byConversation.set(conversationId, next);
  listeners.get(conversationId)?.forEach((notify) => notify());
}

/**
 * Subscribe to one conversation's outbox. Returns the current entries and
 * re-renders on every change to them — the store's half of `useState`.
 */
export function useOutbox(conversationId: number): Outgoing[] {
  // Both memoised on the conversation id. `useSyncExternalStore` resubscribes
  // whenever `subscribe` changes identity, and the thread re-renders on every
  // poll — so an inline closure would tear the subscription down and build it
  // back up several times a second for nothing.
  const subscribe = useCallback(
    (notify: () => void) => {
      const forThis = listeners.get(conversationId) ?? new Set<() => void>();
      forThis.add(notify);
      listeners.set(conversationId, forThis);
      return () => {
        forThis.delete(notify);
        if (forThis.size === 0) listeners.delete(conversationId);
      };
    },
    [conversationId]
  );
  const snapshot = useCallback(() => outboxFor(conversationId), [conversationId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Throw away every unsent message, everywhere.
 *
 * 🔒 Called on sign-out, and that's the point of it: now that the outbox
 * outlives the screen it would otherwise outlive the *session* too, leaving one
 * person's unsent words on a phone the next person is holding. Also used to
 * reset the module between tests.
 */
export function clearOutbox() {
  const conversations = [...byConversation.keys()];
  byConversation.clear();
  conversations.forEach((id) =>
    listeners.get(id)?.forEach((notify) => notify())
  );
}

/** A fresh outbox entry for a message just handed to `sendMessage` — text, a
 * photo, or both. */
export function newOutgoing({
  text,
  replyToId,
  rootId,
  photo,
  mentionIds,
}: {
  text: string;
  replyToId?: number;
  rootId?: number;
  photo?: OutgoingPhoto;
  mentionIds?: number[];
}): Outgoing {
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
    status: 'sending',
  };
}

/**
 * Dress an outbox entry as a `Message` so a list can render it with the same
 * bubble as everything else.
 *
 * Deliberately a real `Message` shape rather than a parallel "pending bubble"
 * component: a message that looks subtly different while it's in flight is a
 * message that appears to *change* when it lands, and the whole point of showing
 * it immediately is that sending should feel like nothing happened in between.
 */
export function asMessage(entry: Outgoing, me: Author): Message {
  return {
    id: entry.tempId,
    sender: me,
    text: entry.text,
    is_deleted: false,
    is_edited: false,
    created_at: entry.createdAt,
    edited_at: null,
    reactions: [],
    reply_to: entry.replyToId ? { id: entry.replyToId } : null,
    thread_root_id: entry.rootId ?? null,
    reply_count: 0,
    // Highlighted from the moment it appears (M8), rather than only once the
    // server's copy lands — an in-flight bubble that renders differently from
    // the one that replaces it is the flicker the outbox exists to avoid.
    mentions: entry.mentionIds ?? [],
    // The local file stands in for the server's copy until it lands (Phase 9b
    // M7). A negative `id` matching the entry's `tempId` keeps it distinct from
    // any real attachment, and both URLs point at the on-device thumbnail: the
    // bubble draws it, and there's nothing full-size to open yet — the lightbox
    // is keyed off the message being sent, so it never sees this.
    attachments: entry.photo
      ? [
          {
            id: entry.tempId,
            kind: 'image',
            url: entry.photo.previewUri,
            thumbnail: entry.photo.previewUri,
            width: entry.photo.width,
            height: entry.photo.height,
          },
        ]
      : [],
  };
}
