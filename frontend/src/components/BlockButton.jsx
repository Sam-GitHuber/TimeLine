import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { invalidateConnectionChange } from "../connectionCache.js";
import DisconnectWarningModal from "./DisconnectWarningModal.jsx";

// Block / unblock control on a person's profile. Blocking is the strong,
// explicit cut: it severs any connection, stops messaging, hides your
// conversation from both of you, and bars re-connecting — so we confirm first,
// via DisconnectWarningModal (which also surfaces any group chats the block
// would drop you out of). Unblocking undoes none of that damage, so it needs
// no warning.
// `isBlocked` is whether *you* have blocked them (from the profile payload).
//
// A rejected block used to be completely silent (issue #236): the warning modal
// closed before the mutation was even fired, the mutation had no error path, and
// nothing rendered `isError` — so a POST that never landed left the button still
// reading "Block" and looked exactly like one that worked. You then believed
// someone was blocked who could still message you and read your posts. This is
// the one place in the app where a silently-failed write leaves a person with a
// false belief about their own safety, so two things follow from it:
//
//   1. The write has to land before the modal closes. `mutateAsync` is awaited
//      so the dialog can hold the failure and become the retry, rather than
//      leaving the message nowhere to go.
//   2. The message states what is still true rather than repeating the server's
//      words. `BlockView`'s only authored rejection is "You can't block
//      yourself" — unreachable, since the button isn't rendered on your own
//      profile — so every failure a real person hits here is a 404, a 500 or a
//      dropped connection, none of which say the thing that matters.
export default function BlockButton({ userId, displayName, isBlocked }) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);
  const [failure, setFailure] = useState(null);

  const mutation = useMutation({
    mutationFn: () =>
      isBlocked ? api.unblockUser(userId) : api.blockUser(userId),
    // A block deletes the `Connection` row outright (`BlockView.post`), so it
    // moves the same boundary a disconnect does and refreshes the same set
    // (`connectionCache.js`). Its own list was six keys that overlapped the
    // Connect button's six without matching them, and the one it omitted was
    // `["connections"]`: block someone from their profile and your Connections
    // list went on listing the person you'd just cut off, with their posts still
    // rendered under a button now reading "Unblock" (#288). Neither list held a
    // calendar or event key.
    //
    // **Unblocking deliberately fires the same call, and it is a superset of
    // what that direction needs.** `BlockView.delete` only deletes the `Block`
    // row — it restores no connection, so `connected_user_ids` doesn't move and
    // the feed/calendar/event keys are a wasted refetch rather than a wrong one.
    // What unblocking *does* move is most of the rest: `is_blocked` on the
    // profile and the people lists, and the messaging surfaces, since
    // `_conversation_visible` hides a blocked pair's direct thread and lifting
    // the block brings it back. Splitting the two directions to save one refetch
    // on a rare, deliberate action would put the *block* path — the one where
    // being subtly wrong means believing someone is cut off who isn't (#236) —
    // at the mercy of a boolean prop. Not worth it; both directions are pinned
    // in `connection-cache.test.jsx`. Same call the app's `BlockButton.tsx`
    // makes, for the same reasons.
    onSuccess: () => invalidateConnectionChange(queryClient, userId),
  });

  // Retire the message once the server's own answer moves to the one the
  // attempt was reaching for: the request landed after all and only its response
  // was lost. Left standing, "they're not blocked" would sit under a block that
  // has since taken effect — and on this control that stale sentence is a claim
  // about someone's safety, so it must not outlive the fact. Judged against the
  // answer recorded *at the attempt*, never against when the refetch arrives, so
  // a sync landing in the same render batch as the rejection can't swallow the
  // message before it's painted (the trap #231 describes). Render-phase, like
  // RsvpBar's equivalent — no effect, no extra paint.
  if (failure && isBlocked !== failure.from) setFailure(null);

  // The wording is resolved at the attempt and held as a string: a successful
  // block flips `isBlocked` underneath us, and the message must keep describing
  // the action that actually failed.
  async function run() {
    const from = isBlocked;
    const wording = from
      ? `Couldn’t unblock ${displayName} — they’re still blocked. Try again.`
      : `Couldn’t block ${displayName} — they’re not blocked. Try again.`;
    setFailure(null);
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch {
      setFailure({ text: wording, from });
    }
  }

  function handleClick() {
    if (isBlocked) {
      run();
      return;
    }
    // Opening the dialog starts a fresh attempt, so it must not open holding
    // the previous one's failure.
    setFailure(null);
    setShowWarning(true);
  }

  return (
    <>
      {/* A column so the message stacks under the button instead of competing
          with it for width — this control sits in a profile action row and in a
          chat's Details panel, both of them horizontal. A span, not a div: one
          of its callers renders it inside a <p>. */}
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={handleClick}
          disabled={mutation.isPending}
          className="text-sm font-medium text-ink-faint transition hover:text-red-600"
        >
          {isBlocked ? "Unblock" : "Block"}
        </button>
        {/* While the dialog is up it holds the message itself, right where you
            pressed Confirm. */}
        {failure && !showWarning && (
          <span role="alert" className="text-right text-sm text-red-600">
            {failure.text}
          </span>
        )}
      </span>
      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="block"
          busy={mutation.isPending}
          error={failure?.text ?? null}
          onConfirm={run}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}
