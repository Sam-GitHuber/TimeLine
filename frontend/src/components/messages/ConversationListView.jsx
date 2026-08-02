import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SpineMark, StrokeIcon, IconButton, PanelHeader } from "../drawer-chrome.jsx";
import ConversationRow from "./ConversationRow.jsx";
import { api, CONVERSATION_LIST_POLL_MS } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { serverMessage } from "../../errors.js";
import { useMessaging } from "../../messaging.jsx";

/**
 * How many conversations before the search field is worth its space (Phase 9b
 * M9e).
 *
 * Below this you can see every chat you have, so a search box is chrome that
 * only makes the panel busier. Same threshold as the app's, because it's the
 * same judgement about the same list.
 */
const SEARCH_FROM = 6;

/**
 * Does this conversation match what you typed?
 *
 * 🔒 **Names only — never the message previews.** Searching message *content* is
 * the obvious next thought and it's deliberately not built: it dies under
 * end-to-end encryption (the server won't have the words, and the client won't
 * have the history), so building toward it now means building something to tear
 * out. Matching the preview text that happens to be loaded would also be a
 * half-feature that quietly searches only the newest message in each thread,
 * which is worse than not searching.
 *
 * A group matches on its title *and* its members' names, because an untitled
 * group is displayed as its members and you should be able to find a chat by
 * what it's called on the screen in front of you.
 */
export function matchesSearch(convo, needle, meId) {
  const names = [
    convo.title,
    convo.other?.display_name ?? "",
    ...(convo.participants ?? [])
      .filter((person) => person.id !== meId)
      .map((person) => person.display_name),
  ];
  return names.some((name) => (name ?? "").toLowerCase().includes(needle));
}

// The drawer's first view: every conversation, most-recent-activity first,
// polled so a new message shows up without a reload.
//
// Phase 9b M9e brought the app's M6 list across — search by name, and per-row
// Mute / Mark unread / Leave. On the phone those hang off a swipe; here they sit
// behind a `⋯` that appears on hover, because a row on a desktop has no swipe
// and a pointer has somewhere to rest.
export default function ConversationListView() {
  const { openThread, openNew } = useMessaging();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["conversations"],
    queryFn: api.getConversations,
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const all = useMemo(() => data?.results ?? [], [data]);
  const needle = search.trim().toLowerCase();
  const conversations = useMemo(
    () =>
      needle
        ? all.filter((convo) => matchesSearch(convo, needle, me?.pk))
        : all,
    [all, needle, me?.pk]
  );

  /**
   * Every row action, sharing one mutation.
   *
   * All three are a small write followed by the same invalidations, so passing
   * the call in keeps each handler to a line — the shape the app's list uses.
   * A failure has to *say so*: the menu closes on click, so a mute that didn't
   * take would otherwise look exactly like a mute that did.
   */
  const rowAction = useMutation({
    mutationFn: (call) => call(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Mark-unread and leave both move the nav badge, and it's the number
      // someone is watching when they flag a chat to come back to.
      queryClient.invalidateQueries({ queryKey: ["unreadMessages"] });
      // And the thread's own payload, which holds `muted` and `unread_count`
      // too. Its poll would heal this within a cycle, but opening a chat you
      // just acted on and finding the header disagreeing with the row you acted
      // on is exactly the kind of small lie that reads as a bug.
      queryClient.invalidateQueries({ queryKey: ["conversation"] });
    },
  });

  /**
   * What the row's `⋯` offers.
   *
   * **The mark-unread gate is narrower than the server's, on purpose.** The
   * server aims at the newest *visible, incoming, undeleted* message anywhere in
   * the thread, so it happily marks unread a chat you replied to — it lands past
   * your trailing messages. This list can't tell that case apart: a row carries
   * only `last_message`, so "I replied last" and "I've been talking to myself
   * since I started this chat" look identical from here, and only the second is
   * a 400. An action that sometimes comes back an error is worse than one
   * offered slightly less often, and the thread is one click away. Widen it if a
   * row ever grows a "has incoming history" flag.
   */
  function rowActions(convo) {
    // Clear the last failure as a new menu opens. `getActions` is called on the
    // click that opens one, not during render, so this is an event handler doing
    // event-handler work — and without it a single failed mute leaves a red line
    // over the list until some *other* action happens to succeed, long after
    // it's stopped being true.
    rowAction.reset();
    const actions = [];
    const leaving = convo.my_status === "pending";
    if (!leaving) {
      if (convo.unread_count > 0) {
        actions.push({
          label: "Mark read",
          onClick: () =>
            rowAction.mutate(() => api.markConversationRead(convo.id)),
        });
      } else if (
        convo.last_message &&
        !convo.last_message.is_deleted &&
        convo.last_message.sender_id !== me?.pk
      ) {
        actions.push({
          label: "Mark unread",
          onClick: () =>
            rowAction.mutate(() => api.markConversationUnread(convo.id)),
        });
      }
    }
    // Mute reads as its state ("Unmute" once silenced) rather than staying an
    // imperative, the same way the thread's control does — the whole risk of
    // muting is forgetting you did.
    actions.push({
      label: convo.muted ? "Unmute" : "Mute",
      onClick: () =>
        rowAction.mutate(() =>
          api.setConversationMuted(convo.id, !convo.muted)
        ),
    });
    // On an invitation you haven't accepted, leaving is *Decline*: the same
    // endpoint, and a very different sentence.
    actions.push({
      label: leaving ? "Decline" : "Leave",
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            leaving
              ? "Decline this invite? You won’t join this conversation."
              : "Leave this chat? You’ll stop receiving messages here."
          )
        ) {
          rowAction.mutate(() => api.leaveConversation(convo.id));
        }
      },
    });
    return actions;
  }

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
        {/* Inside the scroller, not pinned above it: the field scrolls away with
            the list rather than permanently narrowing the thing you came here to
            read. Keyed off the *unfiltered* count, so filtering down to one
            result doesn't pull the field out from under what you just typed. */}
        {all.length >= SEARCH_FROM && (
          <div className="border-b border-line px-4 py-2.5">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search names"
              aria-label="Search conversations"
              className="w-full rounded-xl border border-line-strong bg-raised px-3 py-1.5 text-sm text-ink transition placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-tint"
            />
          </div>
        )}

        {isLoading && (
          <p className="px-5 py-10 text-center text-ink-faint">Loading…</p>
        )}
        {isError && (
          <p className="px-5 py-10 text-center text-red-600">
            {serverMessage(error, "Couldn't load your messages.")}
          </p>
        )}
        {rowAction.isError && (
          <p role="alert" className="px-5 py-2 text-center text-sm text-red-600">
            {serverMessage(rowAction.error, "Couldn’t do that.")}
          </p>
        )}
        {!isLoading && !isError && all.length === 0 && (
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
        {!isLoading && !isError && all.length > 0 && conversations.length === 0 && (
          <p className="px-5 py-10 text-center text-ink-faint">
            No conversations match “{search.trim()}”.
          </p>
        )}

        {conversations.map((convo) => (
          <ConversationRow
            key={convo.id}
            convo={convo}
            me={me}
            onOpen={() => openThread(convo.id)}
            getActions={() => rowActions(convo)}
          />
        ))}
      </div>
    </>
  );
}
