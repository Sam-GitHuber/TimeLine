import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";

// The groups you belong to. Groups are private/invite-only shared timelines —
// there's no directory of groups to browse, so this only ever lists your own.
// Ordered by name (not "relevance" — the no-algorithm rule applies here too).
export default function GroupsPage() {
  const query = useInfiniteList(["groups"], api.getGroups);
  const { items: groups, isLoading, isError, error } = query;

  // Surface pending group invitations as a banner into the invites inbox.
  const { data: invitesData } = useQuery({
    queryKey: ["groupInvites"],
    queryFn: api.getGroupInvites,
  });
  const inviteCount = invitesData?.count ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h1 className="font-display text-lg font-bold -tracking-[0.02em] text-ink">
          Groups
        </h1>
        <Link to="/groups/new" className="btn btn-primary btn-sm">
          New group
        </Link>
      </div>

      {inviteCount > 0 && (
        <Link
          to="/group-invites"
          className="flex items-center justify-between border-b border-line bg-accent-tint/40 px-5 py-3 text-sm font-medium text-accent-deep transition hover:bg-accent-tint"
        >
          <span>
            You have {inviteCount}{" "}
            {inviteCount === 1 ? "invitation" : "invitations"} to join a group.
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      )}

      {isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-red-600">
          {error?.message || "Couldn't load your groups."}
        </p>
      )}

      {!isLoading && !isError && groups.length === 0 && (
        <p className="px-6 py-12 text-center text-ink-faint">
          You're not in any groups yet. Create one, or wait for an invitation.
        </p>
      )}

      {groups.map((group) => (
        <Link
          key={group.id}
          to={`/g/${group.id}`}
          className="flex items-center gap-3 border-b border-line px-5 py-3.5 transition hover:bg-accent-tint/40"
        >
          <Avatar
            user={{
              display_name: group.name,
              avatar_thumb: group.avatar_thumb,
            }}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-ink">
                {group.name}
              </span>
              {group.your_role === "admin" && (
                <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[0.68rem] font-semibold text-accent-deep">
                  Admin
                </span>
              )}
            </div>
            <p className="text-sm text-ink-faint">
              {group.member_count}{" "}
              {group.member_count === 1 ? "member" : "members"}
            </p>
          </div>
        </Link>
      ))}

      <LoadMoreButton query={query} />
    </div>
  );
}
