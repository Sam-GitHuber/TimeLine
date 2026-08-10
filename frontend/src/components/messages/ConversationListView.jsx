import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SpineMark, StrokeIcon, IconButton, PanelHeader } from "../drawer-chrome.jsx";
import ConversationRow from "./ConversationRow.jsx";
import LoadMoreButton from "../LoadMoreButton.jsx";
import { api, CONVERSATION_LIST_POLL_MS } from "../../api.js";
import { useAuth } from "../../auth.jsx";
import { serverMessage } from "../../errors.js";
import {
  useFetchAllPages,
  useInfiniteList,
  trimQueryToFirstPage,
} from "../../hooks.js";
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

  /**
   * **Every chat, not the first twenty** (#213).
   *
   * `/api/conversations/` is `PageNumberPagination`'d at `PAGE_SIZE` like every
   * other list endpoint, and this read used to be a plain `useQuery` rendering
   * `data.results` — so once you passed twenty chats the least-recently-active
   * ones simply weren't in the UI, with nothing on screen saying so. The list is
   * ordered by most recent activity, so the ones that fell off the end were
   * exactly the dormant ones you'd go looking for. Same defect as #134 on the
   * activity centre, so it gets #134's answer: `useInfiniteList` + the shared
   * `LoadMoreButton`, which is the one place paging behaviour lives.
   *
   * The poll rides along in `options` (the hook won't let a caller change how it
   * pages, only what surrounds it). ⚠️ A refetch of an infinite query refetches
   * **all** its loaded pages, so a poll costs one request per page you've asked
   * for — which is why the effect below drops back to one page on the way out.
   */
  const query = useInfiniteList(["conversations"], api.getConversations, {
    refetchInterval: CONVERSATION_LIST_POLL_MS,
  });
  const { items: all, data, isLoading, isError, error } = query;
  /**
   * **A failed *poll* is not a reason to paint a failure over a working list**
   * (#324, in the sweep behind it — same root cause as the two sites that issue
   * names). This list polls on `CONVERSATION_LIST_POLL_MS`, and a bare `isError`
   * meant one dropped packet put "Couldn't load your messages." in red *above*
   * every row, which was still there and still openable. Worse, the two
   * empty-state lines below were gated on `!isError`, so a failed poll also
   * swallowed "No conversations match …" while you were typing in the search
   * box — a claim about the search replaced by a claim about the request.
   *
   * `!data`, so it still says so when there's nothing to show (#310/#313).
   */
  const loadFailed = isError && !data;
  const needle = search.trim().toLowerCase();
  const searching = needle !== "";

  /**
   * **Searching pulls the rest of the list in** (#213, the half that made the
   * truncation into a lie rather than an omission).
   *
   * The filter below runs over the rows in hand, which is fine when that's every
   * row and misleading when it isn't: type a name you haven't messaged since the
   * spring, get "No conversations match", and the sentence you've just been told
   * is that the chat is gone. There's no server-side search on this endpoint, so
   * covering the whole list means having the whole list — `useFetchAllPages`,
   * exactly as `useConnections` does for the two pickers.
   *
   * Only *while* you're searching, the way `EventPhotos` walks its album only
   * when it must: the drawer's ordinary use is reading the top of a
   * most-recent-first list, and this endpoint is the app's most expensive one
   * per row (#206). Clearing the box stops the walk and leaves the pages already
   * fetched.
   */
  useFetchAllPages(query, searching);

  /**
   * The error branch that hook says its callers owe the viewer.
   *
   * `useFetchAllPages` stops on a failed page rather than looping — deliberately
   * — so a dropped connection halfway through leaves a *partial* list. Filtering
   * that and printing "No conversations match" would be the original bug again,
   * one layer down: a list that stopped short looks exactly like a list that
   * ended.
   *
   * Two ways the walk stops short, and the predicate has to name both, because
   * anything it misses falls through to a confident "no match" over a partial
   * list:
   *
   * - **A page came back an error.** `isFetchNextPageError` — the hook's own
   *   stopping condition read back out, and deliberately *not* the query-wide
   *   `isError`, which this polled list sets on any dropped poll (that's the
   *   #324 distinction `loadFailed` makes three lines up).
   * - **Offline.** `networkMode` is TanStack's default, so with no connection a
   *   page fetch *pauses* instead of failing: no error, `isFetchingNextPage`
   *   false, `hasNextPage` still true. Left out, that's a panel stuck on
   *   "Searching…" forever with no retry and the no-match line suppressed
   *   indefinitely — the exact "won't tell you what it knows" failure this whole
   *   change exists to remove, reachable through the commonest fault there is.
   *
   * ⚠️ **And nothing in flight**, which is doing more work than it looks.
   * `isFetchNextPageError` is derived as *query errored* ∧ *the last fetch went
   * forward* (`infiniteQueryObserver`), so a poll that drops while a page is on
   * the wire is attributed to that page. Requiring the walk to be idle keeps
   * that race showing "Searching…", which is what's actually happening, and it
   * means the retry below can't be pressed twice — the moment it fires, this
   * goes false and the working line takes over. That's better feedback than the
   * disabled button `LoadMoreButton` uses, because it says what's going on
   * rather than just refusing.
   */
  const searchStalled =
    searching &&
    query.hasNextPage &&
    !query.isFetchingNextPage &&
    (query.isFetchNextPageError || query.isPaused);
  // Still walking: matches so far are real, but "no match" isn't a fact yet.
  const searchWalking = searching && query.hasNextPage && !searchStalled;

  const conversations = useMemo(
    () =>
      needle
        ? all.filter((convo) => matchesSearch(convo, needle, me?.pk))
        : all,
    [all, needle, me?.pk]
  );

  /**
   * How many chats you have, which is **not** how many are loaded.
   *
   * The search field appears at a threshold, and answering "how long is this
   * list?" with the number of rows *fetched* is the same mistake the list itself
   * was making. It happens to give the same answer today — a page is 20 and the
   * threshold is 6, so any account past the threshold has a first page past it
   * too — but only because `PAGE_SIZE > SEARCH_FROM`, which nothing enforces and
   * neither number knows about the other. `count` is the fact about the account;
   * `all.length` covers the cold render before any page has landed.
   */
  const total = data?.pages?.[0]?.count ?? all.length;

  /**
   * **Put the walked pages away again** — when the search is cleared, and when
   * the view goes away (ActivityCenter does the same on close; the app trims on
   * unmount).
   *
   * This list polls, and a refetch of an infinite query refetches *every* loaded
   * page. So without the first half, one search on a long list leaves the drawer
   * re-fetching N pages of the app's heaviest endpoint every
   * `CONVERSATION_LIST_POLL_MS` — and again on every row action's invalidation —
   * for as long as it stays open, for rows that are no longer being filtered.
   * Clearing the box is the honest moment to drop them: you're back to the top of
   * a most-recent-first list, with Load more right there.
   *
   * ⚠️ Under `StrictMode` the unmount half also runs on the dev-only double
   * mount, cancelling the first page fetch that the remount then reissues — one
   * wasted request in dev, none in production. Worth knowing rather than working
   * around; a ref that swallowed the second run would be a lie about a mount that
   * really did happen.
   */
  // On the *transition* out of searching, not on every render that isn't one:
  // this runs on mount too, and a bare trim there would cancel the first page
  // fetch of every cold open.
  const walkedForSearch = useRef(false);
  useEffect(() => {
    if (searching) {
      walkedForSearch.current = true;
      return;
    }
    if (!walkedForSearch.current) return;
    walkedForSearch.current = false;
    trimQueryToFirstPage(queryClient, ["conversations"]);
  }, [searching, queryClient]);

  useEffect(
    () => () => {
      trimQueryToFirstPage(queryClient, ["conversations"]);
    },
    [queryClient]
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
            read. Keyed off the server's *unfiltered* total, so filtering down to
            one result doesn't pull the field out from under what you just typed
            — and so it doesn't hinge on how many pages happen to be loaded. */}
        {total >= SEARCH_FROM && (
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
        {loadFailed && (
          <p className="px-5 py-10 text-center text-red-600">
            {serverMessage(error, "Couldn't load your messages.")}
          </p>
        )}
        {rowAction.isError && (
          <p role="alert" className="px-5 py-2 text-center text-sm text-red-600">
            {serverMessage(rowAction.error, "Couldn’t do that.")}
          </p>
        )}
        {!isLoading && !loadFailed && all.length === 0 && (
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
        {/* "Nothing matches" is a claim about your whole list, so it waits until
            the walk has one to make (#213). Until then the matches found so far
            stay on screen and the state of the walk is reported below them. */}
        {!isLoading &&
          !loadFailed &&
          !searchWalking &&
          !searchStalled &&
          all.length > 0 &&
          conversations.length === 0 && (
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

        {/* Announced, because the matches on screen are provisional and a
            sighted reader can see the line arrive. `status` for the working
            state, `alert` for the failure — the pairing `rowAction` above
            already uses. */}
        {!isLoading && !loadFailed && searchWalking && (
          <p
            role="status"
            className="px-5 py-2 text-center text-sm text-ink-faint"
          >
            Searching your other chats…
          </p>
        )}
        {!isLoading && !loadFailed && searchStalled && (
          <p role="alert" className="px-5 py-2 text-center text-sm text-red-600">
            {query.isPaused
              ? "You’re offline — this is only the chats already loaded."
              : "Couldn’t search all your chats — this is only the ones loaded."}{" "}
            {/* The accessible name has to *contain* the visible one, or voice
                control can't act on what it can see (WCAG 2.5.3) — so extend
                "Try again", never replace it. No `disabled` guard: pressing it
                makes `searchStalled` false, so the whole line is replaced by
                "Searching your other chats…" and there's nothing left to press
                twice. (`fetchNextPage` defaults to `cancelRefetch: true`, which
                is what a second press would have cost.) */}
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              aria-label="Try again — search the rest of your chats"
              className="font-medium underline"
            >
              Try again
            </button>
          </p>
        )}

        {/* Only when you're not searching: a search walks itself to the end, and
            a button offering to do what's already happening is one more thing to
            reason about mid-type. The stalled case gets its own retry above. */}
        {!searching && <LoadMoreButton query={query} />}
      </div>
    </>
  );
}
