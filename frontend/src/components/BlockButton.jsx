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
export default function BlockButton({ userId, displayName, isBlocked }) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);

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

  function handleClick() {
    if (isBlocked) {
      mutation.mutate();
      return;
    }
    setShowWarning(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={mutation.isPending}
        className="text-sm font-medium text-ink-faint transition hover:text-red-600"
      >
        {isBlocked ? "Unblock" : "Block"}
      </button>
      {showWarning && (
        <DisconnectWarningModal
          userId={userId}
          userName={displayName}
          action="block"
          onConfirm={() => {
            setShowWarning(false);
            mutation.mutate();
          }}
          onCancel={() => setShowWarning(false)}
        />
      )}
    </>
  );
}
