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
 * **baseline captured once** when the transcript first drew:
 *
 *   - a server message is new if its id is above the newest one that first
 *     load held — which rules out the first load itself and every older page,
 *     however late it pages in — and it didn't come from your own outbox;
 *   - an outbox entry is new if it was queued after the screen opened. The
 *     outbox outlives the screen, so a failed message from an earlier visit is
 *     already there on the way back in and shouldn't rise from the composer as
 *     though just sent. Temp ids only ever count *down*, so "queued later" is
 *     "a lower id".
 *
 * A row that remounts for a boring reason (scrolled far away and back) still
 * answers "new" if it arrived this visit, and that's fine: it remounts well
 * outside the viewport, where a 200ms fade is over before it can be seen.
 */
import type { Message } from './types';

export type ArrivalBaseline = {
  /**
   * The newest server id the transcript held when it first loaded, or `null`
   * until it has — nothing from the server is new before there is a first load
   * to be newer than. `0` for a loaded, empty conversation, so its first
   * message is.
   */
  newestOnOpen: number | null;
  /** The lowest temp id already in the outbox when the screen opened; 0 if none. */
  outboxOnOpen: number;
};

/** The newest server id among loaded messages — 0 for none. */
export function newestServerId(messages: Message[]): number {
  return messages.reduce((max, message) => Math.max(max, message.id), 0);
}

export function isArrival(
  message: Message,
  baseline: ArrivalBaseline,
  /** Server ids of messages this screen sent — see the file header. */
  justSent: ReadonlySet<number>
): boolean {
  if (message.id < 0) return message.id < baseline.outboxOnOpen;
  if (baseline.newestOnOpen === null) return false;
  return message.id > baseline.newestOnOpen && !justSent.has(message.id);
}

/**
 * Has this row just taken over from its own outbox bubble — so that its tick
 * should be drawn changing from the clock that bubble wore?
 *
 * Not simply "did this screen send it". That stays true for the whole visit,
 * and a strand opened later mounts the same reply afresh: its tick would run
 * clock → tick again in front of someone who watched it send minutes ago. It
 * has to be newer than the baseline too, which a view opened afterwards never
 * is.
 */
export function isSettledSend(
  message: Message,
  baseline: ArrivalBaseline,
  justSent: ReadonlySet<number>
): boolean {
  if (baseline.newestOnOpen === null) return false;
  return message.id > baseline.newestOnOpen && justSent.has(message.id);
}
