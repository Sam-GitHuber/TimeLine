import { useQuery } from "@tanstack/react-query";
import { SpineMark, StrokeIcon, IconButton, PanelHeader } from "../drawer-chrome.jsx";
import ConversationRow from "./ConversationRow.jsx";
import { api, CONVERSATION_LIST_POLL_MS } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { useMessaging } from "../../messaging.jsx";

// The drawer's first view: every conversation, most-recent-activity first,
// polled so a new message shows up without a reload.
export default function ConversationListView() {
  const { openThread, openNew } = useMessaging();
  const { user: me } = useAuth();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["conversations"],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const conversations = data?.results ?? [];

  return (
    <>
      <PanelHeader
        actions={
          <IconButton onClick={() => openNew()} label="New message">
            {/* compose / pencil */}
            <StrokeIcon path="M12 20h9 M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
          </IconButton>
        }
      >
        <SpineMark />
        <h2 className="truncate font-display text-lg font-bold -tracking-[0.02em] text-ink">
          Messages
        </h2>
      </PanelHeader>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}
        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            {error?.message || "Couldn't load your messages."}
          </p>
        )}
        {!isLoading && !isError && conversations.length === 0 && (
          <div className="px-6 py-14 text-center text-ink-faint">
            <p className="font-medium text-ink">No conversations yet</p>
            <p className="mt-1 text-sm">
              Start one with someone you’re connected with.
            </p>
            <button
              type="button"
              onClick={() => openNew()}
              className="btn btn-primary btn-sm mt-4"
            >
              New message
            </button>
          </div>
        )}

        {conversations.map((convo) => (
          <ConversationRow
            key={convo.id}
            convo={convo}
            me={me}
            onOpen={() => openThread(convo.id)}
          />
        ))}
      </div>
    </>
  );
}
