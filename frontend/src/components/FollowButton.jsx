import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

// A follow/unfollow toggle for a given user. On success it invalidates the
// people list, the feed, and that user's profile query so they all refetch —
// e.g. following someone makes their posts appear in your feed immediately.
export default function FollowButton({ userId, isFollowing }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      isFollowing ? api.unfollow(userId) : api.follow(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["user", userId] });
    },
  });

  const base =
    "rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50";
  const styling = isFollowing
    ? "border border-slate-300 text-slate-700 hover:bg-slate-100"
    : "bg-sky-600 text-white hover:bg-sky-700";

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className={`${base} ${styling}`}
    >
      {isFollowing ? "Following" : "Follow"}
    </button>
  );
}
