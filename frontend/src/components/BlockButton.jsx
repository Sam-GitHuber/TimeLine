import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
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
    onSuccess: () => {
      // A block/unblock changes connection state, feeds, and messaging surfaces.
      for (const key of [
        ["user", userId],
        ["users"],
        ["feed"],
        ["conversations"],
        ["unreadMessages"],
        ["connectionRequests"],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  // Resolved at the attempt and held as a string: a successful block flips
  // `isBlocked` underneath us, and the message must keep describing the action
  // that actually failed.
  async function run() {
    const wording = isBlocked
      ? `Couldn’t unblock ${displayName} — they’re still blocked. Try again.`
      : `Couldn’t block ${displayName} — they’re not blocked. Try again.`;
    setFailure(null);
    try {
      await mutation.mutateAsync();
      setShowWarning(false);
    } catch {
      setFailure(wording);
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
            {failure}
          </span>
        )}
      </span>
      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="block"
          busy={mutation.isPending}
          error={failure}
          onConfirm={run}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}
