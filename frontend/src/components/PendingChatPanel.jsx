import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { api } from "../api.js";
import { useMessaging } from "../messaging.jsx";

// The locked view for a group chat you've been added to but aren't an active
// member of yet (Phase 6a's clique-gated invite): you can't see messages or
// send until you've connected with everyone in `mustConnectWith`. This
// replaces the messages list + composer entirely — there's nothing to read
// until you're in — and offers a way out via Decline / Leave.
export default function PendingChatPanel({ mustConnectWith, conversationId }) {
  const { openList } = useMessaging();
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    mutationFn: (userId) => api.connect(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveConversation(conversationId),
    onSuccess: () => openList(),
  });

  const people = mustConnectWith ?? [];
  const names = people.map((person) => person.display_name);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-14 text-center">
      <p className="max-w-xs text-ink-soft">
        Connect with <NameList names={names} /> to join this chat.
      </p>

      <ul className="flex w-full max-w-xs flex-col gap-2">
        {people.map((person) => (
          <li
            key={person.id}
            className="flex items-center gap-3 rounded-2xl border border-line-strong bg-raised px-3.5 py-2.5"
          >
            <Avatar user={person} size="sm" />
            <span className="min-w-0 flex-1 truncate text-left font-semibold text-ink">
              {person.display_name}
            </span>
            <button
              type="button"
              onClick={() => connectMutation.mutate(person.id)}
              disabled={connectMutation.isPending}
              className="btn btn-primary btn-sm"
            >
              Connect
            </button>
          </li>
        ))}
      </ul>

      {connectMutation.isError && (
        <p className="text-sm text-red-600">
          {connectMutation.error?.message || "Couldn't send that request."}
        </p>
      )}

      <button
        type="button"
        onClick={() => leaveMutation.mutate()}
        disabled={leaveMutation.isPending}
        className="btn btn-ghost btn-sm"
      >
        {leaveMutation.isPending ? "Leaving…" : "Decline / Leave"}
      </button>
    </div>
  );
}

// "X" / "X & Y" / "X, Y & Z" — bolding each name, matching how the rest of the
// app treats a person's display name as the one thing to draw the eye to.
function NameList({ names }) {
  if (names.length === 0) return <strong className="text-ink">everyone</strong>;
  return names.map((name, i) => (
    <span key={`${name}-${i}`}>
      {i > 0 && (i === names.length - 1 ? " & " : ", ")}
      <strong className="font-semibold text-ink">{name}</strong>
    </span>
  ));
}
