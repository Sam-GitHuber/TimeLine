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
 */

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
};

let nextTempId = -1;

/** A fresh outbox entry for text just handed to `sendMessage`. */
export function newOutgoing({
  text,
  replyToId,
  rootId,
}: {
  text: string;
  replyToId?: number;
  rootId?: number;
}): Outgoing {
  return {
    tempId: nextTempId--,
    text,
    replyToId,
    rootId,
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
  };
}
