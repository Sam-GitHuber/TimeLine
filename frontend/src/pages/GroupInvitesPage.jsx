import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// Your inbox of group invitations: groups someone has invited you to join.
// Accept adds you as a member; Decline discards the invite. Mirrors the
// connection-requests inbox. Shares a child of the ["groupInvites"] key the nav
// badge holds, so acting here updates the badge automatically.
export default function GroupInvitesPage() {
  const queryClient = useQueryClient();

  const query = useInfiniteList(
    ["groupInvites", "list"],
    api.getGroupInvites
  );
  const { items: invites, isLoading, isError, error } = query;

  const decide = useMutation({
    // `act` is api.acceptGroupInvite or api.rejectGroupInvite.
    mutationFn: ({ act, id }) => act(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groupInvites"] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });

  return (
    <div>
      <h1 className="border-b border-line px-5 py-4 font-display text-lg font-bold -tracking-[0.02em] text-ink">
        Group invitations
      </h1>

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn't load invitations."}
        </p>
      )}

      {!isLoading && !isError && invites.length === 0 && (
        <p className="px-6 py-10 text-center text-ink-faint">
          No pending invitations.
        </p>
      )}

      {invites.map((invite) => (
        <div
          key={invite.id}
          className="flex items-center gap-3 border-b border-line px-5 py-3.5"
        >
          <Avatar
            user={{
              display_name: invite.group.name,
              avatar_thumb: invite.group.avatar_thumb,
            }}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">
              {invite.group.name}
            </p>
            {invite.invited_by && (
              <p className="text-sm text-ink-faint">
                Invited by {invite.invited_by.display_name}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() =>
              decide.mutate({ act: api.acceptGroupInvite, id: invite.id })
            }
            disabled={decide.isPending}
            className="btn btn-primary btn-sm"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={() =>
              decide.mutate({ act: api.rejectGroupInvite, id: invite.id })
            }
            disabled={decide.isPending}
            className="btn btn-ghost btn-sm"
          >
            Decline
          </button>
        </div>
      ))}

      <LoadMoreButton query={query} />
    </div>
  );
}
