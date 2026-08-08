import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { serverMessage } from "../errors.js";

// The members of a group, each with their role. If the viewer is an admin, each
// other member gets promote/demote + remove controls. The backend enforces the
// real rules (admin-only, and "a group must keep at least one admin"); this just
// surfaces them and any error they return.
export default function GroupMembersPanel({ groupId, isAdmin }) {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();

  const membersQuery = useQuery({
    queryKey: ["groupMembers", groupId],
    queryFn: () => api.getGroupMembers(groupId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["groupMembers", groupId] });
    queryClient.invalidateQueries({ queryKey: ["group", groupId] });
  };

  const setRole = useMutation({
    mutationFn: ({ userId, role }) =>
      api.setGroupMemberRole(groupId, userId, role),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (userId) => api.removeGroupMember(groupId, userId),
    onSuccess: refresh,
  });

  const members = membersQuery.data ?? [];
  const actionError = setRole.error || remove.error;

  // **A "Members" heading over an empty list reads as a group with no members**
  // (#314) — and worse, the admin controls simply aren't there to press, so an
  // admin who came here to remove someone finds no one to remove. `!data`
  // rather than a bare `isError`: a failed refetch keeps the roster it has.
  const loadFailed = membersQuery.isError && !membersQuery.data;

  return (
    <section className="border-b border-line px-5 py-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">
        Members{members.length > 0 && ` (${members.length})`}
      </h2>

      {membersQuery.isLoading && (
        <p className="text-sm text-ink-faint">Loading…</p>
      )}

      {loadFailed && (
        <p className="text-sm text-red-600">
          {serverMessage(membersQuery.error, "Couldn’t load the members.")}{" "}
          <button
            type="button"
            onClick={() => membersQuery.refetch()}
            className="font-medium underline"
          >
            Try again
          </button>
        </p>
      )}

      {actionError && (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {/* The server's rules here are the point — "a group must keep at
              least one admin", "only admins can remove members" — so its own
              words are shown whenever it wrote any. It didn't always: offline,
              or on a 500 with no readable body, this rendered a bare
              `err.message` and put the browser's "Failed to fetch" above the
              member list (issue #240). Hence a sentence of our own to fall back
              to, which until now this panel didn't have. */}
          {serverMessage(
            actionError,
            "That didn’t work — check your connection and try again."
          )}
        </p>
      )}

      <ul className="space-y-1">
        {members.map(({ user, role }) => {
          const isSelf = user.id === me?.pk;
          return (
            <li key={user.id} className="flex items-center gap-3 py-1">
              <Link to={`/u/${user.id}`} tabIndex={-1} aria-hidden="true">
                <Avatar user={user} size="sm" />
              </Link>
              <Link
                to={`/u/${user.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:text-accent-deep"
              >
                {user.display_name}
                {isSelf && (
                  <span className="text-ink-faint"> (you)</span>
                )}
              </Link>
              {role === "admin" && (
                <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[0.68rem] font-semibold text-accent-deep">
                  Admin
                </span>
              )}
              {/* Admins get controls on everyone else. */}
              {isAdmin && !isSelf && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setRole.mutate({
                        userId: user.id,
                        role: role === "admin" ? "member" : "admin",
                      })
                    }
                    disabled={setRole.isPending}
                    className="btn btn-ghost btn-sm"
                  >
                    {role === "admin" ? "Demote" : "Make admin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(user.id)}
                    disabled={remove.isPending}
                    className="btn btn-ghost btn-sm text-red-600"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
