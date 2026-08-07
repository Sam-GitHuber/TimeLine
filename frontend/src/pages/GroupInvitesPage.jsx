import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";
import { invalidateGroupMembership } from "../groupCache.js";

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
    // The two decisions differ in what they *change*, not just which endpoint
    // they call, so the choice is a flag the success handler can read rather
    // than the opaque `act` function the row used to pass in.
    mutationFn: ({ accept, id }) =>
      accept ? api.acceptGroupInvite(id) : api.rejectGroupInvite(id),
    onSuccess: (_result, { accept }) => {
      queryClient.invalidateQueries({ queryKey: ["groupInvites"] });
      // Accepting makes you an active member, and membership gates the home
      // feed and the personal calendar as well as this list (see
      // `groupCache.js`). Declining deletes the invite row and leaves every
      // membership alone, so it stays on the narrow set it already had.
      if (accept) invalidateGroupMembership(queryClient);
      else queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });

  return (
    <div>
      <h1 className="border-b border-line px-5 py-4 font-display text-lg font-bold -tracking-[0.02em] text-ink">
        Group invitations
      </h1>

      {/* The **write's** rejection, not the query's (#239). The "Couldn't load
          invitations." line below covers the read and can never fire here: the
          list arrived fine and it's the Accept that failed. Until now nothing
          rendered `decide.isError`, so an invite the group had already revoked
          answered 404, no `onSuccess` ran, no invalidation ran, and the row
          stayed put — leaving you to press it again, or to believe you'd joined
          a group you hadn't. Named per decision (`connections.md`: the fallback
          is per state, never generic), off the variables of the attempt that
          failed. */}
      {decide.isError && (
        <p role="alert" className="px-5 py-2.5 text-sm text-red-600">
          {serverMessage(
            decide.error,
            decide.variables?.accept
              ? "Couldn’t accept that invitation."
              : "Couldn’t decline that invitation."
          )}
        </p>
      )}

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {serverMessage(error, "Couldn't load invitations.")}
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
            onClick={() => decide.mutate({ accept: true, id: invite.id })}
            disabled={decide.isPending}
            className="btn btn-primary btn-sm"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={() => decide.mutate({ accept: false, id: invite.id })}
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
