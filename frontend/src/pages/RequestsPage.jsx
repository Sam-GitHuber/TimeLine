import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import { api } from "../api.js";

// Your inbox of incoming follow requests: people who've asked to follow you and
// are waiting on your approval. Approve grants the follow (they start seeing
// your posts); Reject discards the request.
export default function RequestsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["followRequests"],
    queryFn: api.getFollowRequests,
  });

  const decide = useMutation({
    // `act` is api.approveRequest or api.rejectRequest.
    mutationFn: ({ act, id }) => act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["followRequests"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });

  const requests = data?.results ?? [];

  return (
    <div>
      <h1 className="border-b border-slate-200 px-4 py-4 text-lg font-bold text-slate-900 sm:px-6">
        Follow requests
      </h1>

      {isLoading && (
        <p className="px-6 py-10 text-center text-slate-500">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-rose-600">
          {error?.message || "Couldn't load requests."}
        </p>
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <p className="px-6 py-10 text-center text-slate-500">
          No pending requests.
        </p>
      )}

      {requests.map((req) => (
        <div
          key={req.id}
          className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 sm:px-6"
        >
          <Link to={`/u/${req.requester.id}`} tabIndex={-1} aria-hidden="true">
            <Avatar user={req.requester} size="md" />
          </Link>
          <Link
            to={`/u/${req.requester.id}`}
            className="min-w-0 flex-1 truncate font-semibold text-slate-900 hover:underline"
          >
            {req.requester.display_name}
          </Link>
          <button
            type="button"
            onClick={() => decide.mutate({ act: api.approveRequest, id: req.id })}
            disabled={decide.isPending}
            className="rounded-full bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => decide.mutate({ act: api.rejectRequest, id: req.id })}
            disabled={decide.isPending}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
