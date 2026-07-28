/**
 * What tick a message of *yours* shows (Phase 9b M4).
 *
 * Kept as a pure module rather than inlined into the bubble for two reasons:
 * it's the single definition of "who counts as having read this", which is the
 * bit that would otherwise drift between the transcript and the focused thread
 * view; and it's the half of the milestone worth unit-testing directly, since
 * the interesting cases (a late arrival, an opt-out, a group of one) are awkward
 * to stage through a rendered screen.
 *
 * **Three states, not the four you may be used to.** There is no "delivered"
 * tick, and that's a decision rather than a gap: nothing in our stack reports
 * that a device actually received a message. We could infer one from an Expo
 * push receipt, but that means "we handed it to Apple", which is emphatically
 * not what anyone reads a tick as. Better one fewer state, honestly.
 *
 * 🔒 **None of this is an access control.** The server decides what a viewer may
 * see; these ticks are a display heuristic over data it already chose to send
 * (see `attach_read_receipts`). A participant whose read state is withheld
 * simply arrives without the fields and drops out of the calculation here.
 */

import type { Message, Participant } from '@/types';

/**
 * `sending` and `failed` come from the outbox (a message that hasn't reached
 * the server yet); `sent` and `read` are computed from participants' markers.
 */
export type SendState = 'sending' | 'failed' | 'sent' | 'read';

/**
 * The people whose reading of a message the tick waits on.
 *
 * Three exclusions, each answering a way the tick would otherwise be wrong:
 *
 * - **You.** Sending is self-evidently reading.
 * - **`pending` members.** They're in the waiting room and genuinely can't read
 *   the thread, so waiting on one means a tick that never completes for as long
 *   as an invitation sits unanswered — days, realistically.
 * - **Anyone not reporting** (no `last_read_at` key, or no open interval). That
 *   covers both an opt-out and a member who's currently between spells of
 *   membership. Excluding rather than blocking is deliberate: one person turning
 *   receipts off shouldn't silently disable ticks for a whole group, which would
 *   make the setting antisocial to use. The cost is that the double tick means
 *   "everyone who shares read state has read it" — a slightly weaker claim,
 *   stated here so it isn't mistaken for a bug later.
 */
function audienceFor(
  message: Message,
  participants: Participant[],
  meId: number | undefined
): Participant[] {
  const sentAt = Date.parse(message.created_at);
  return participants.filter((p) => {
    if (p.id === meId) return false;
    if (p.status !== 'active') return false;
    // `undefined` = withheld, and distinct from `null` = never read. Only the
    // key's presence decides whether they report at all.
    if (p.last_read_at === undefined) return false;
    // No open interval → not currently able to read; don't wait on them.
    if (!p.active_since) return false;
    // Joined after this was sent, so it was never theirs to read. This is the
    // client-side shadow of the server's interval clipping — it doesn't grant
    // access to anything, it just stops the tick waiting on someone who was
    // never shown the message.
    return Date.parse(p.active_since) <= sentAt;
  });
}

/**
 * The tick for one of your own messages.
 *
 * Returns `sent` unless *every* member of the audience has a read marker at or
 * past the message. An empty audience stays `sent` — nobody to have read it, so
 * claiming otherwise would be a lie, and it's the honest state for a thread
 * where the other person has receipts off (or hasn't joined yet).
 *
 * Callers pass `sending`/`failed` themselves; those come from the outbox and
 * never reach here, because a message that hasn't been accepted by the server
 * has no `created_at` to compare against.
 */
export function readStateFor(
  message: Message,
  participants: Participant[],
  meId: number | undefined
): 'sent' | 'read' {
  const audience = audienceFor(message, participants, meId);
  if (audience.length === 0) return 'sent';
  const sentAt = Date.parse(message.created_at);
  const everyone = audience.every(
    (p) => p.last_read_at != null && Date.parse(p.last_read_at) >= sentAt
  );
  return everyone ? 'read' : 'sent';
}

/**
 * Whether this thread can show ticks at all — false when *you* have receipts
 * off, which the server signals by withholding every marker including your own.
 *
 * Worth checking explicitly rather than letting every message fall through to
 * `sent`: a row of permanent single ticks reads as "nobody is ever reading
 * these", where showing none says the truthful thing, which is that you asked
 * not to be part of this.
 */
export function receiptsVisible(participants: Participant[]): boolean {
  return participants.some((p) => p.last_read_at !== undefined);
}
