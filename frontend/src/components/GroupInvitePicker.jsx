import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { useConnections } from "../hooks.js";
import { api } from "../api.js";
import { serverMessage } from "../errors.js";

// Pick one of your connections to invite to a group. You can only invite people
// you're connected with (the backend enforces it), so — like the new-message
// picker — we list users and filter to the accepted connections. Each invite is
// a request the person accepts from their own invites inbox.
export default function GroupInvitePicker({ groupId, onClose }) {
  const [needle, setNeedle] = useState("");
  // Track per-user outcome so the row can show "Invited" / an error inline.
  const [sent, setSent] = useState({});

  // The shared hook lists your connections (paged across every page) and
  // narrows by the search term — the same source the new-message picker uses.
  // `isError` is read for the same reason that picker reads it: the walk stops
  // on a failed page (#214) rather than retrying it forever, so a list short of
  // someone you know has to say why instead of just being short.
  const {
    connections,
    filtered,
    isLoading: usersLoading,
    isError: usersError,
  } = useConnections(needle);

  const invite = useMutation({
    mutationFn: (userId) => api.inviteToGroup(groupId, userId),
    onSuccess: (_data, userId) =>
      setSent((s) => ({ ...s, [userId]: { ok: true } })),
    onError: (error, userId) =>
      setSent((s) => ({
        ...s,
        [userId]: {
          ok: false,
          message: serverMessage(error, "Couldn't invite."),
        },
      })),
  });

  return (
    <div className="border-b border-line bg-raised/50 px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Invite a connection</h2>
        {/* "Close" is a Cancel by another name: it unmounts the panel, and the
            per-row outcome above — including a refused invite's message — lives
            in this component's `sent` state and goes with it. Held while an
            invite is out (#259), so "I ticked them and pressed Invite" can't
            end with three invitations you believe went out and didn't. */}
        <button
          type="button"
          onClick={onClose}
          disabled={invite.isPending}
          className="text-sm text-ink-faint hover:text-ink disabled:opacity-50"
        >
          Close
        </button>
      </div>

      <input
        value={needle}
        onChange={(e) => setNeedle(e.target.value)}
        placeholder="Search your connections…"
        className="mb-3 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
      />

      {usersLoading && (
        <p className="py-2 text-sm text-ink-faint">Loading…</p>
      )}

      {usersError && (
        <p role="alert" className="py-2 text-sm text-red-600">
          Couldn’t load your connections.
        </p>
      )}

      {/* Gated on `usersError` too: with nothing loaded, "you aren't connected
          to anyone" is the one reading this must not offer, since the truth is
          that we failed to ask. */}
      {!usersLoading && !usersError && connections.length === 0 && (
        <p className="py-2 text-sm text-ink-faint">
          You can only invite people you're connected with. Connect with someone
          first.
        </p>
      )}

      {!usersLoading && connections.length > 0 && filtered.length === 0 && (
        <p className="py-2 text-sm text-ink-faint">No connections match.</p>
      )}

      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {filtered.map((person) => {
          const outcome = sent[person.id];
          return (
            <li
              key={person.id}
              className="flex items-center gap-3 rounded-xl px-2 py-1.5"
            >
              <Avatar user={person} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {person.display_name}
              </span>
              {outcome?.ok ? (
                <span className="text-sm font-medium text-accent-deep">
                  Invited
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => invite.mutate(person.id)}
                  disabled={invite.isPending}
                  className="btn btn-primary btn-sm"
                >
                  Invite
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Surface the most recent error (e.g. already a member / invited). */}
      {Object.values(sent).some((o) => o && !o.ok) && (
        <p className="mt-2 text-sm text-red-600">
          {Object.values(sent)
            .reverse()
            .find((o) => o && !o.ok)?.message}
        </p>
      )}
    </div>
  );
}
