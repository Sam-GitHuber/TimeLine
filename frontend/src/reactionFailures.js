import { useState } from "react";
import { serverMessage } from "./errors.js";

// Holding on to reactions the server refused, for the two surfaces that offer
// them: the feed's `ReactionBar` (posts and comments) and `MessageBubble` (a
// message, in the transcript *and* inside a reply strand).
//
// Shared rather than copied because the interesting part isn't the state, it's
// the **clear-condition** below — thirty lines of "when has this message stopped
// being true", first worked out for issue #242 and immediately needed again for
// #251. Two copies of that would have drifted, and drift here is silent: the
// failure mode of getting it wrong is a rejection that never appears, which is
// the bug both issues are about.

// What a rejection sounds like when the server didn't write anything readable
// itself. Named per direction rather than generically because a reaction is a
// toggle and does two opposite things depending on whether that emoji is already
// yours, and "it didn't work" leaves you unable to tell which of them didn't
// happen.
const FALLBACKS = {
  add: "Couldn’t add that reaction — try again.",
  remove: "Couldn’t remove that reaction — try again.",
};

// Whether the viewer has reacted with `emoji`, according to a server summary.
// An emoji absent from the summary is one nobody has used, so: no.
export function hasReacted(summary, emoji) {
  return summary.some((r) => r.emoji === emoji && r.reacted);
}

/**
 * Rejected toggles for one target, keyed by emoji.
 *
 * **A map rather than the single slot the sibling patterns use.**
 * ConnectButton, BlockButton and RsvpBar are each one control doing one thing,
 * so one slot holds every failure they can have. A reaction target carries a
 * *row* of independent toggles, and one slot there means the second failure
 * overwrites the first: two taps that both failed, one message, and the other
 * tap silent again — precisely the bug this exists to fix, reappearing for
 * whichever emoji lost.
 *
 * `summary` is the target's reaction list **as the server last stated it**.
 * Nothing optimistic may be passed here: the clear-condition reads it as
 * evidence of what actually landed, and a locally-simulated toggle would retire
 * a message the moment it was written.
 *
 * Returns `attempt(emoji, run)` — call it in place of firing the toggle
 * yourself. It never rejects, so a fire-and-forget caller can't leave an
 * unhandled rejection behind.
 */
export function useReactionFailures(summary) {
  const [failures, setFailures] = useState({});

  // Retire a message once the server's own answer moves to the state that tap
  // was reaching for — the toggle landed and only its response was lost, so
  // "couldn't add that reaction" would now be sitting beside a chip that says
  // you did. Nothing else clears it, and each is judged only on *its own*
  // emoji: a summary that changed for some other reason (someone else reacted,
  // a different emoji of yours toggled) is not confirmation of your attempt,
  // and clearing on any resync is the swallow issue #231 describes. The
  // comparison is against `mine`, recorded at the attempt rather than at the
  // rejection, so a refetch landing in the same render batch as the rejection
  // can't eat the message before it's painted.
  //
  // Testing "moved off what it was" rather than "arrived at what we wanted" is
  // the same condition here, since an emoji is yours or it isn't — unlike
  // ConnectButton's four states, where the two halves are genuinely different
  // questions and both have to be asked.
  //
  // Done during render (the "adjust state during render" pattern) rather than
  // in an effect, so the stale message never gets painted once beside the
  // evidence that contradicts it.
  const landed = Object.keys(failures).filter(
    (emoji) => hasReacted(summary, emoji) !== failures[emoji].mine
  );
  if (landed.length > 0) {
    const rest = { ...failures };
    for (const emoji of landed) delete rest[emoji];
    setFailures(rest);
  }

  /**
   * Run one toggle, and hold on to what the server said if it refuses.
   *
   * Awaited rather than fired-and-forgotten so the failure can be tagged with
   * what was true when you tapped. Reacting is a small, cheap gesture with no
   * optimistic write behind it, so a rejection has to say so rather than leave
   * the tap looking like it worked: nothing repaints except on success, any
   * popover closes either way, and a silent failure reads as a missed button —
   * so you tap again, at a server that may have taken the first one, where the
   * second tap *removes* it.
   */
  async function attempt(emoji, run) {
    const mine = hasReacted(summary, emoji);
    // Only this emoji's message goes. A fresh attempt on ❤️ says nothing about
    // whether your 👍 landed, so dropping that one here would put the silence
    // straight back — the same reasoning as the clear-condition above, applied
    // to the manual clear rather than the automatic one.
    setFailures((prev) => {
      if (!(emoji in prev)) return prev;
      const rest = { ...prev };
      delete rest[emoji];
      return rest;
    });
    try {
      await run();
    } catch (err) {
      // The server's own words are the point here: the rules that reject a
      // reaction — the per-target distinct-emoji cap, emoji validation — are
      // written for a person. `serverMessage` is what keeps the browser's
      // "Failed to fetch" and a body-less 500's "Request failed (500)" out,
      // both of which a bare `err.message` would show (issue #240).
      setFailures((prev) => ({
        ...prev,
        [emoji]: {
          mine,
          text: serverMessage(err, mine ? FALLBACKS.remove : FALLBACKS.add),
        },
      }));
    }
  }

  return { failures, attempt };
}
