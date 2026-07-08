import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Avatar from "./Avatar.jsx";
import { PanelHeader } from "./drawer-chrome.jsx";
import { api } from "../api.js";
import { useMessaging } from "../messaging.jsx";
import { useConnections } from "../hooks.js";

// Start a new conversation: check one or more connections, add an optional
// title, and hit Create. One connection with no title is a 1:1 (get-or-create,
// same endpoint the old single-tap flow used); two or more — or a title — makes
// a group chat. Reuses `useConnections` (the same paged/filtered ["users"]
// source the group-invite picker uses) so this can't drift from it on paging or
// the connection filter.
//
// `prefill` narrows the list to a specific group's members and scopes the
// resulting chat to it — set when this view is opened from a group's "start a
// group chat" action instead of the drawer's plain compose button. It also
// doubles as an "add to an existing chat" mode: `{ addToConversationId }` (set
// by the group thread's "Add people" control) skips creating anything and
// instead adds the selected people to that chat, then reopens its thread.
export default function NewChatPicker({ prefill }) {
  const { openList, openThread } = useMessaging();
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [title, setTitle] = useState("");

  const { connections, filtered, isLoading, isError } = useConnections(term);
  const options = prefill?.memberIds
    ? filtered.filter((u) => prefill.memberIds.includes(u.id))
    : filtered;

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const addToConversationId = prefill?.addToConversationId ?? null;

  const create = useMutation({
    mutationFn: () => {
      const ids = [...selected];
      if (addToConversationId) {
        return api.addParticipants(addToConversationId, ids);
      }
      const label = title.trim();
      if (ids.length === 1 && !label) {
        return api.openConversation(ids[0]);
      }
      return api.createGroupChat({
        participantIds: ids,
        title: label,
        groupId: prefill?.groupId ?? null,
      });
    },
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (addToConversationId) {
        queryClient.invalidateQueries({
          queryKey: ["conversation", addToConversationId],
        });
        openThread(addToConversationId);
      } else {
        openThread(conversation.id);
      }
    },
  });

  return (
    <>
      <PanelHeader
        onBack={
          addToConversationId ? () => openThread(addToConversationId) : openList
        }
      >
        <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
          {addToConversationId
            ? "Add people"
            : prefill?.groupName
              ? `New chat in ${prefill.groupName}`
              : "New message"}
        </h2>
      </PanelHeader>

      <div className="border-b border-line px-3 py-2.5">
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search your connections…"
          aria-label="Search your connections"
          className="w-full rounded-xl border border-line-strong bg-raised px-3.5 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}
        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            Couldn’t load your connections.
          </p>
        )}
        {!isLoading && !isError && connections.length === 0 && (
          <div className="px-6 py-12 text-center text-ink-faint">
            <p className="font-medium text-ink">No connections yet</p>
            <p className="mt-1 text-sm">
              You can only message people you’re connected with. Find people to
              connect with first.
            </p>
          </div>
        )}
        {!isLoading && connections.length > 0 && options.length === 0 && (
          <p className="px-5 py-10 text-center text-ink-faint">
            {prefill?.memberIds
              ? "None of your connections are in this group."
              : `No connections match “${term}”.`}
          </p>
        )}

        {options.map((person) => (
          <label
            key={person.id}
            className="flex w-full cursor-pointer items-center gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-accent-tint/40"
          >
            <input
              type="checkbox"
              checked={selected.has(person.id)}
              onChange={() => toggle(person.id)}
              className="h-4 w-4 rounded border-line-strong text-accent focus:ring-accent-tint"
            />
            <Avatar user={person} size="md" />
            <span className="min-w-0 flex-1 truncate font-semibold text-ink">
              {person.display_name}
            </span>
          </label>
        ))}
      </div>

      <div className="border-t border-line px-3 py-3">
        {!addToConversationId && (
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Chat name (optional, for a group)"
            aria-label="Chat name"
            className="w-full rounded-xl border border-line-strong bg-raised px-3.5 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
          />
        )}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-ink-faint">
            {selected.size === 0
              ? "Select at least one connection"
              : `${selected.size} selected`}
          </span>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={selected.size === 0 || create.isPending}
            className="btn btn-primary btn-sm"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
        {create.isError && (
          <p className="mt-2 text-sm text-red-600">
            {create.error?.message ||
              (addToConversationId
                ? "Couldn’t add them to this chat."
                : "Couldn’t start that chat.")}
          </p>
        )}
      </div>
    </>
  );
}
