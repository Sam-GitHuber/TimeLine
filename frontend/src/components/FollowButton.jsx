import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

// A follow control that reflects the private-account flow. `followStatus` is
// one of "none" | "pending" | "accepted":
//   none     → "Follow"    → sends a follow request
//   pending  → "Requested" → click to withdraw the request
//   accepted → "Following" → click to unfollow
// On success it invalidates the people list, feed, that user's profile, and the
// requests inbox so every view reflects the change.
export default function FollowButton({ userId, followStatus }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      followStatus === "none" ? api.follow(userId) : api.unfollow(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
      queryClient.invalidateQueries({ queryKey: ["followRequests"] });
    },
  });

  const label = {
    none: "Follow",
    pending: "Requested",
    accepted: "Following",
  }[followStatus] ?? "Follow";

  const base =
    "rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50";
  const styling =
    followStatus === "none"
      ? "bg-sky-600 text-white hover:bg-sky-700"
      : "border border-slate-300 text-slate-700 hover:bg-slate-100";

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className={`${base} ${styling}`}
      // A pending request reads as "waiting on them"; make that explicit.
      title={followStatus === "pending" ? "Waiting for approval — click to withdraw" : undefined}
    >
      {label}
    </button>
  );
}
