import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// Your inbox of incoming connection requests: people who've asked to connect
// with you and are waiting on your approval. Approve makes the connection mutual
// (you both start seeing each other's posts); Reject discards the request.
export default function RequestsPage() {
  const queryClient = useQueryClient();

  // Paginated so every request is reachable, not just the first page. Uses a
  // child of the ["connectionRequests"] key the nav badge holds, so
  // invalidating ["connectionRequests"] (below, and from ConnectButton)
  // refreshes both.
  const query = useInfiniteList(
    ["connectionRequests", "list"],
    api.getConnectionRequests
  );
  const { items: requests, isLoading, isError, error } = query;

  const decide = useMutation({
    // `act` is api.approveRequest or api.rejectRequest.
    mutationFn: ({ act, id }) => act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectionRequests"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });

  return (
    <div>
      <h1 className="border-b border-line px-5 py-4 font-display text-lg font-bold -tracking-[0.02em] text-ink">
        Connection requests
      </h1>

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn't load requests."}
        </p>
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <p className="px-6 py-10 text-center text-ink-faint">
          No pending requests.
        </p>
      )}

      {requests.map((req) => (
        <div
          key={req.id}
          className="flex items-center gap-3 border-b border-line px-5 py-3.5"
        >
          <Link to={`/u/${req.requester.id}`} tabIndex={-1} aria-hidden="true">
            <Avatar user={req.requester} size="md" />
          </Link>
          <Link
            to={`/u/${req.requester.id}`}
            className="min-w-0 flex-1 truncate font-semibold text-ink hover:text-accent-deep"
          >
            {req.requester.display_name}
          </Link>
          <button
            type="button"
            onClick={() => decide.mutate({ act: api.approveRequest, id: req.id })}
            disabled={decide.isPending}
            className="btn btn-primary btn-sm"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => decide.mutate({ act: api.rejectRequest, id: req.id })}
            disabled={decide.isPending}
            className="btn btn-ghost btn-sm"
          >
            Reject
          </button>
        </div>
      ))}

      <LoadMoreButton query={query} />
    </div>
  );
}
