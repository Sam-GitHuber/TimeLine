import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

// Block / unblock control on a person's profile. Blocking is the strong,
// explicit cut: it severs any connection, stops messaging, hides your
// conversation from both of you, and bars re-connecting — so we confirm first.
// `isBlocked` is whether *you* have blocked them (from the profile payload).
export default function BlockButton({ userId, displayName, isBlocked }) {
  const queryClient = useQueryClient();

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
    if (
      !isBlocked &&
      !window.confirm(
        `Block ${displayName}? This disconnects you, stops messages both ways, ` +
          `and hides your conversation. You can unblock later.`
      )
    ) {
      return;
    }
    mutation.mutate();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={mutation.isPending}
      className="text-sm font-medium text-ink-faint transition hover:text-red-600"
    >
      {isBlocked ? "Unblock" : "Block"}
    </button>
  );
}
