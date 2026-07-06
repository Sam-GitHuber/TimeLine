import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "../components/Avatar.jsx";
import ComposeBox from "../components/ComposeBox.jsx";
import Timeline from "../components/Timeline.jsx";
import LoadMoreButton from "../components/LoadMoreButton.jsx";
import GroupMembersPanel from "../components/GroupMembersPanel.jsx";
import GroupInvitePicker from "../components/GroupInvitePicker.jsx";
import { useInfiniteList } from "../hooks.js";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

// A single group: its header + timeline. Members only — the backend 404s a
// non-member, and we render a friendly "not in this group" state for that.
// Any member can invite a connection and can leave; admins also get edit,
// delete, and per-member controls (in GroupMembersPanel).
export default function GroupPage() {
  const { id } = useParams();
  const groupId = Number(id);
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [showInvite, setShowInvite] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const groupQuery = useQuery({
    queryKey: ["group", groupId],
    queryFn: () => api.getGroup(groupId),
    retry: false,
  });

  const postsQuery = useInfiniteList(["groupPosts", groupId], () =>
    api.getGroupPosts(groupId)
  );

  const leave = useMutation({
    mutationFn: () => api.removeGroupMember(groupId, me.pk),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      navigate("/groups");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      navigate("/groups");
    },
  });

  // 404 → you're not a member (or it doesn't exist). Don't leak which.
  if (groupQuery.isError && groupQuery.error?.status === 404) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-ink">Group not available</p>
        <p className="mt-1 text-ink-faint">
          This group doesn't exist, or you're not a member of it.
        </p>
        <Link
          to="/groups"
          className="mt-4 inline-block font-medium text-accent-deep hover:underline"
        >
          ← Back to groups
        </Link>
      </div>
    );
  }

  if (groupQuery.isError) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-lg font-medium text-red-600">
          {groupQuery.error?.message || "Couldn't load this group."}
        </p>
        <button
          type="button"
          onClick={() => groupQuery.refetch()}
          className="btn btn-ghost btn-sm mt-4"
        >
          Try again
        </button>
      </div>
    );
  }

  if (groupQuery.isLoading) {
    return <p className="px-6 py-10 text-center text-ink-faint">Loading…</p>;
  }

  const group = groupQuery.data;
  const isAdmin = group.your_role === "admin";
  const posts = postsQuery.items;

  return (
    <div>
      <section className="border-b border-line px-5 py-7">
        <div className="flex items-start gap-4">
          <Avatar
            user={{
              display_name: group.name,
              avatar_thumb: group.avatar_thumb,
            }}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-4">
              <h1 className="font-display text-2xl font-bold -tracking-[0.02em] text-ink">
                {group.name}
              </h1>
              {isAdmin && (
                <Link
                  to={`/g/${group.id}/edit`}
                  className="btn btn-ghost btn-sm shrink-0"
                >
                  Edit
                </Link>
              )}
            </div>
            {group.description && (
              <p className="mt-2 whitespace-pre-wrap break-words text-ink-soft">
                {group.description}
              </p>
            )}
            <p className="mt-2 text-sm text-ink-faint">
              {group.member_count}{" "}
              {group.member_count === 1 ? "member" : "members"}
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowInvite((v) => !v)}
                className="btn btn-primary btn-sm"
              >
                Invite
              </button>
              <button
                type="button"
                onClick={() => setShowMembers((v) => !v)}
                className="btn btn-ghost btn-sm"
              >
                {showMembers ? "Hide members" : "Members"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(`Leave ${group.name}? You can be re-invited.`)
                  )
                    leave.mutate();
                }}
                disabled={leave.isPending}
                className="btn btn-ghost btn-sm text-red-600"
              >
                Leave
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${group.name}? This removes the group and all its posts for everyone. This can't be undone.`
                      )
                    )
                      remove.mutate();
                  }}
                  disabled={remove.isPending}
                  className="btn btn-ghost btn-sm text-red-600"
                >
                  Delete group
                </button>
              )}
            </div>

            {leave.isError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {leave.error?.message || "Couldn't leave the group."}
              </p>
            )}
            {remove.isError && (
              <p role="alert" className="mt-2 text-sm text-red-600">
                {remove.error?.message || "Couldn't delete the group."}
              </p>
            )}
          </div>
        </div>
      </section>

      {showInvite && (
        <GroupInvitePicker
          groupId={group.id}
          onClose={() => setShowInvite(false)}
        />
      )}

      {showMembers && (
        <GroupMembersPanel groupId={group.id} isAdmin={isAdmin} />
      )}

      <Timeline posts={posts} header={<ComposeBox group={group.id} />} />

      {postsQuery.isLoading && (
        <p className="px-6 py-10 text-center text-ink-faint">Loading posts…</p>
      )}
      {!postsQuery.isLoading && posts.length === 0 && (
        <p className="px-6 py-12 text-center text-ink-faint">
          No posts yet. Be the first to share something with the group.
        </p>
      )}

      <LoadMoreButton query={postsQuery} />
    </div>
  );
}
