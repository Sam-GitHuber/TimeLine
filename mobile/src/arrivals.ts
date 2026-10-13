/**
 * Which rows of a transcript are *new* — the only ones allowed to animate in
 * (#395).
 *
 * This is the part of transcript motion that is easy to get wrong. The thread
 * is an inverted, virtualised `FlatList` whose rows mount for many reasons that
 * are not a message arriving: the first load, a page of older history, a row
 * scrolling back into the render window, and — the subtle one — your own
 * message being *replaced*. An outbox bubble is keyed by its negative temp id
 * and the server's copy by its real one, so when a send lands React unmounts
 * one and mounts the other. Animate on mount and that reads as the message
 * fading up a second time, a third of a second after it appeared: exactly the
 * "message that appears to change when it lands" the outbox exists to prevent.
 * The web hit this first and made the same call (`justSent` in
 * `ConversationThreadView`; messaging.md → M9c): the optimistic bubble
 * animates, its replacement doesn't.
 *
 * So the question is answered from the data, not from mounting, against a
 * **baseline of what this view has already drawn**:
 *
 *   - a server message is new if its id is above the newest one already drawn
 *     — which rules out the first load and every older page, however late it
 *     pages in — and it didn't come from your own outbox;
 *   - an outbox entry is new if it was queued after the ones already drawn.
 *     The outbox outlives the screen, so a failed message from an earlier visit
 *     is already there on the way back in and shouldn't rise from the composer
 *     as though just sent. Temp ids only ever count *down*, so "queued later"
 *     is "a lower id".
 *
 * **The baseline moves up behind each arrival**, in an effect — so after the
 * render that mounts a new row, that row is no longer new. That matters because
 * a row can mount twice: scroll a long way back and the newest rows leave the
 * list's render window, then jump-to-latest brings them back *in view*. Against
 * a baseline frozen at open they would all rise again, and every message you'd
 * sent would replay its clock turning into a tick.
 */
import { useEffect, useMemo, useState } from 'react';

import type { Message } from './types';

export type ArrivalBaseline = {
  /**
   * The newest server id this view has drawn, or `null` until it has loaded —
   * nothing from the server is new before there is a first load to be newer
   * than. `0` for a loaded, empty conversation, so its first message is.
   */
  newestDrawn: number | null;
  /** The lowest (latest) temp id this view has drawn from the outbox; 0 if none. */
  outboxDrawn: number;
};

/** The newest server id among loaded messages — 0 for none. */
export function newestServerId(messages: Message[]): number {
  return messages.reduce((max, message) => Math.max(max, message.id), 0);
}

/** The lowest temp id among unsent messages — 0 for none. */
function lowestTempId(outgoing: Message[]): number {
  return outgoing.reduce((lowest, message) => Math.min(lowest, message.id), 0);
}

/**
 * The baseline for one view of a conversation — the transcript, or a strand.
 *
 * `ready` is the caller saying "what you're holding is the first load, whole
 * and current", and it is the one thing the two views answer differently. Both
 * wait out the fetch in flight, because a reopened view starts from its cached
 * copy and everything said since the last visit would otherwise count as new
 * the moment the refetch landed. The strand also waits for its page-by-page
 * walk to finish: it loads oldest-first, so its second page is twenty messages
 * all newer than its first.
 *
 * Returns one stable object per baseline, so handing it to every row doesn't
 * build one per row per render.
 */
export function useArrivalBaseline({
  loaded,
  outgoing,
  ready,
}: {
  loaded: Message[];
  /** Unsent messages, dressed as messages — negative ids. */
  outgoing: Message[];
  ready: boolean;
}): ArrivalBaseline {
  const [newestDrawn, setNewestDrawn] = useState<number | null>(null);
  // Captured during render, not in the effect below: the rows that mount in
  // this same render have to be measured against it.
  if (newestDrawn === null && ready) setNewestDrawn(newestServerId(loaded));
  const [outboxDrawn, setOutboxDrawn] = useState(() => lowestTempId(outgoing));

  // Then moved up behind whatever that render drew — a frame later, so the
  // rows it mounted were still new when they read the answer. Cancelled if the
  // inputs move first, which just restarts the wait from the newer ones.
  const newest = newestServerId(loaded);
  const lowest = lowestTempId(outgoing);
  useEffect(() => {
    const behind = newestDrawn !== null && newest > newestDrawn;
    if (!behind && lowest >= outboxDrawn) return;
    const frame = requestAnimationFrame(() => {
      if (behind) setNewestDrawn(newest);
      setOutboxDrawn((drawn) => Math.min(drawn, lowest));
    });
    return () => cancelAnimationFrame(frame);
  }, [newest, lowest, newestDrawn, outboxDrawn]);

  return useMemo(
    () => ({ newestDrawn, outboxDrawn }),
    [newestDrawn, outboxDrawn]
  );
}

export function isArrival(
  message: Message,
  baseline: ArrivalBaseline,
  /** Server ids of messages this screen sent — see the file header. */
  justSent: ReadonlySet<number>
): boolean {
  if (message.id < 0) return message.id < baseline.outboxDrawn;
  if (baseline.newestDrawn === null) return false;
  return message.id > baseline.newestDrawn && !justSent.has(message.id);
}

/**
 * Has this row just taken over from its own outbox bubble — so that its tick
 * should be drawn changing from the clock that bubble wore?
 *
 * Not simply "did this screen send it". That stays true for the whole visit,
 * and a row can mount again long after — in a strand opened later, or scrolled
 * out of the render window and back: its tick would run clock → tick again in
 * front of someone who watched it send minutes ago. It has to be newer than
 * what the view has drawn too, which it is exactly once.
 */
export function isSettledSend(
  message: Message,
  baseline: ArrivalBaseline,
  justSent: ReadonlySet<number>
): boolean {
  if (baseline.newestDrawn === null) return false;
  return message.id > baseline.newestDrawn && justSent.has(message.id);
}
