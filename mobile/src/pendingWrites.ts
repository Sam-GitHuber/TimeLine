/**
 * Writes to a message the server hasn't answered yet (#393).
 *
 * Sending has been instant since the outbox (Phase 9b M4); reacting, deleting
 * and editing each waited for the round trip — and delete and edit for a refetch
 * of every loaded page on top — which next to an instant send reads as the tap
 * not registering. This is the outbox's counterpart for those three: what you
 * just did is drawn at once, and the server's answer replaces it.
 *
 * **It is a layer drawn over the messages, not a write into the TanStack cache**
 * — the same decision the outbox made, for the same reason. The thread refetches
 * `['messages', id]` every `MESSAGE_POLL_MS` and a refetch *replaces* an
 * infinite query's pages, so an optimistic write in the cache can be undone
 * mid-flight by a poll that left before the request did: the pill appears,
 * vanishes, and comes back. Kept out here, the cache holds exactly what the
 * server said and `present` re-applies what it hasn't said yet to whatever the
 * cache currently holds, however many times that changes underneath it.
 *
 * Rolling back is therefore not a thing that has to be done. A refused write
 * drops its entry and the message draws as the server has it again — there is
 * no snapshot to restore, and so no snapshot to go stale.
 *
 * Unlike the outbox this is **screen state, not a store**. A failed send has to
 * sit and wait for a decision, so it must outlive the screen; a failed
 * reaction, delete or edit waits for nothing — it reverts and says so in an
 * `Alert`, which outlives the screen on its own.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import type { Message, Reaction } from '@/types';

/** "My reaction with this emoji should be on (or off)". */
type PendingReaction = { emoji: string; on: boolean; token: number };

type PendingMessage = {
  deleted?: boolean;
  edit?: { text: string; token: number };
  reactions?: PendingReaction[];
};

export type PendingWrites = Readonly<Record<number, PendingMessage>>;

const NONE: PendingWrites = {};

/**
 * A reaction list with my reaction for `emoji` forced on or off.
 *
 * **A statement of where it should end up, not a toggle** — which is what makes
 * it safe to apply over a list that may or may not include the write already. A
 * poll can land between the tap and the response carrying the new aggregate;
 * toggling that again would take the pill straight back off. Asked "make mine
 * on" of a list where mine is on, this changes nothing.
 *
 * The order is the server's (`summarise_reactions`: count descending, then the
 * emoji), copied so a new pill doesn't land in one place and hop to another when
 * the answer arrives. It is the one server rule mirrored here; the ones that can
 * *refuse* a reaction (the per-target emoji cap, emoji validation) are not, and
 * a refusal takes the pill away again with the server's own words.
 */
export function withReaction(
  reactions: Reaction[] | undefined,
  emoji: string,
  on: boolean
): Reaction[] {
  const current = reactions ?? [];
  const existing = current.find((r) => r.emoji === emoji);
  if ((existing?.reacted ?? false) === on) return current;

  const next = on
    ? existing
      ? current.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, reacted: true } : r
        )
      : [...current, { emoji, count: 1, reacted: true }]
    : current
        .map((r) =>
          r.emoji === emoji ? { ...r, count: r.count - 1, reacted: false } : r
        )
        .filter((r) => r.count > 0);

  return next.sort(
    (a, b) =>
      b.count - a.count || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0)
  );
}

/**
 * What a deleted message looks like, as the server would send it: blank text,
 * no photos. Reactions stay — a tombstone keeps the ones left before the delete
 * (see reactions.md).
 */
export function asTombstone(message: Message): Message {
  return { ...message, text: '', is_deleted: true, attachments: [] };
}

/** One message with whatever is still outstanding against it applied. */
function presentOne(message: Message, pending: PendingMessage): Message {
  if (pending.deleted) return asTombstone(message);
  let next = message;
  if (pending.edit) {
    next = { ...next, text: pending.edit.text, is_edited: true };
  }
  if (pending.reactions?.length) {
    let reactions = next.reactions;
    for (const { emoji, on } of pending.reactions) {
      reactions = withReaction(reactions, emoji, on);
    }
    next = { ...next, reactions };
  }
  return next;
}

/**
 * The messages as they should be drawn. Returns the list it was given when
 * nothing is outstanding, and the same object for every message nothing is
 * outstanding against, so a memoised row doesn't re-render for a reaction three
 * screens away.
 */
export function present(messages: Message[], pending: PendingWrites): Message[] {
  if (pending === NONE) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const entry = pending[message.id];
    if (!entry) return message;
    changed = true;
    return presentOne(message, entry);
  });
  return changed ? next : messages;
}

/** Replace one message's entry, dropping it (and the map) once it's empty. */
function update(
  state: PendingWrites,
  messageId: number,
  change: (entry: PendingMessage) => PendingMessage
): PendingWrites {
  const entry = change(state[messageId] ?? {});
  const empty = !entry.deleted && !entry.edit && !entry.reactions?.length;
  const next = { ...state };
  if (empty) delete next[messageId];
  else next[messageId] = entry;
  return Object.keys(next).length ? next : NONE;
}

/**
 * The screen's pending writes, and the handful of things that change them.
 *
 * Every `begin…` returns a **token**, and the matching `settle…` only removes
 * the entry that token made. Two taps on the same emoji in quick succession are
 * two requests whose answers can arrive in either order; without the token the
 * first answer would clear the second tap's entry and the pill would flicker
 * back to a state you'd already changed.
 */
export function usePendingWrites() {
  const [pending, setPending] = useState<PendingWrites>(NONE);
  const lastToken = useRef(0);

  const beginReaction = useCallback(
    (messageId: number, emoji: string, on: boolean) => {
      const token = ++lastToken.current;
      setPending((state) =>
        update(state, messageId, (entry) => ({
          ...entry,
          reactions: [
            // The newest intent for an emoji replaces any older one — they
            // contradict each other, and the latest tap is the one meant.
            ...(entry.reactions ?? []).filter((r) => r.emoji !== emoji),
            { emoji, on, token },
          ],
        }))
      );
      return token;
    },
    []
  );

  const settleReaction = useCallback((messageId: number, token: number) => {
    setPending((state) =>
      update(state, messageId, (entry) => ({
        ...entry,
        reactions: entry.reactions?.filter((r) => r.token !== token),
      }))
    );
  }, []);

  const beginEdit = useCallback((messageId: number, text: string) => {
    const token = ++lastToken.current;
    setPending((state) =>
      update(state, messageId, (entry) => ({ ...entry, edit: { text, token } }))
    );
    return token;
  }, []);

  const settleEdit = useCallback((messageId: number, token: number) => {
    setPending((state) =>
      update(state, messageId, (entry) =>
        entry.edit?.token === token ? { ...entry, edit: undefined } : entry
      )
    );
  }, []);

  const beginDelete = useCallback((messageIds: number[]) => {
    setPending((state) =>
      messageIds.reduce(
        (acc, messageId) =>
          update(acc, messageId, (entry) => ({ ...entry, deleted: true })),
        state
      )
    );
  }, []);

  const settleDelete = useCallback((messageIds: number[]) => {
    setPending((state) =>
      messageIds.reduce(
        (acc, messageId) =>
          update(acc, messageId, (entry) => ({ ...entry, deleted: false })),
        state
      )
    );
  }, []);

  /** Is an edit still out? The screen holds a few things while one is. */
  const editPending = useMemo(
    () => Object.values(pending).some((entry) => entry.edit),
    [pending]
  );

  return {
    pending,
    editPending,
    beginReaction,
    settleReaction,
    beginEdit,
    settleEdit,
    beginDelete,
    settleDelete,
  };
}
