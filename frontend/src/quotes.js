/**
 * Resolving the message a reply quotes (Phase 9b M3 on the phone, M9d here).
 *
 * A port of `mobile/src/quotes.ts`, comments and all — the module the app has
 * been running since M5. If one of these changes, the other should too.
 *
 * 🔒 **The rule this exists to keep**, stated in `messaging.md` and unchanged
 * here: *everything about a quoted message passes through the same interval
 * clipping as the thread — its words and its author alike.* A reply's payload is
 * a bare `{ id }`, deliberately, because embedding the body would hand it to
 * anyone who can see the *reply* and walk straight around the server's clipping.
 * So the quote's text and name have to come from somewhere the server already
 * vetted.
 *
 * There are two such somewheres, and the web needs both for the same reason the
 * app does. "Messages this view has already loaded" was complete only while the
 * transcript eagerly loaded **every** page of history; M9b made paging lazy, and
 * that quietly breaks the honesty of the fallback — a miss now also means
 * "hasn't paged in yet", so "Original message unavailable", which is supposed to
 * mean *you were clipped out of this*, would be a lie some of the time. A
 * message that lies sometimes is worth nothing in the case where it's true.
 *
 * The fix is a **fetch through the same clipped endpoint**, never a wider
 * payload. `?ids=` is one more filter on the queryset the transcript itself
 * reads, so an id the viewer was clipped out of comes back absent —
 * indistinguishable from one that never existed — and the honest message is
 * honest again.
 *
 * **A module store, the same shape as `outbox.js` and `drafts.js`**, rather than
 * component state. Two reasons, and the second is the load-bearing one:
 *
 *  - What's held is a *union* across many responses, where each query's own
 *    cache entry holds only its own batch — so it can't simply be read back off
 *    the query cache.
 *  - **Each id must be asked about once.** An unresolvable id is a fact about
 *    this viewer, not a transient failure, so re-asking on every four-second
 *    poll would be a request that can only ever return nothing — forever. That
 *    memory has to outlive a render, and outliving the *view* costs nothing and
 *    saves a refetch when you click back into a thread.
 *
 * 🔒 **Cleared on sign-out** (`auth.jsx`), like the outbox and the drafts beside
 * it: what it holds is other people's message text, and on a shared computer the
 * next person to open the drawer is not this person.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "./api.js";

/**
 * Mirrors `MESSAGE_IDS_MAX` in `api/views.py`, which 400s above it. A screenful
 * of quotes is a handful, so this only ever bites if something goes wrong —
 * slicing rather than sending 51 ids means the fetch degrades to "resolve most
 * of them" instead of failing outright.
 *
 * **It is not the number that comes back.** `?ids=` is a filter on the ordinary
 * message list, so it *paginates* like one: a request for more ids than fit in a
 * page (20) is answered short, with a `next`. `remember` is where that's dealt
 * with, deliberately rather than by capping this at the page size here — the
 * server's cap is a number this file can point at, and its page size is one it
 * would have to guess and then silently get wrong if it ever moved.
 */
const IDS_PER_REQUEST = 50;

/** Quoted messages that came back, per conversation. */
const resolved = new Map();
/** Every id already asked about, answered or not — what makes "ask once" true. */
const asked = new Map();
const listeners = new Map();

/**
 * One shared empty map, not a fresh one per call. `useSyncExternalStore`
 * compares snapshots by identity, so a new object for an empty cache would
 * re-render on every check and eventually throw.
 */
const NONE = new Map();

function resolvedFor(conversationId) {
  return resolved.get(conversationId) ?? NONE;
}

function useResolved(conversationId) {
  // Both memoised on the conversation id: the thread re-renders on every poll,
  // and an inline closure would tear the subscription down and rebuild it
  // several times a second for nothing.
  const subscribe = useCallback(
    (notify) => {
      const forThis = listeners.get(conversationId) ?? new Set();
      forThis.add(notify);
      listeners.set(conversationId, forThis);
      return () => {
        forThis.delete(notify);
        if (forThis.size === 0) listeners.delete(conversationId);
      };
    },
    [conversationId]
  );
  const snapshot = useCallback(
    () => resolvedFor(conversationId),
    [conversationId]
  );
  return useSyncExternalStore(subscribe, snapshot);
}

/** Fold one `?ids=` response in and tell the view. */
function remember(conversationId, ids, page) {
  // A *new* map, because the snapshot is compared by identity — mutating the
  // existing one would leave every subscriber convinced nothing had changed.
  const next = new Map(resolvedFor(conversationId));
  for (const message of page.results) next.set(message.id, message);
  resolved.set(conversationId, next);

  // Normally every id asked for, not every id that answered: the ones that
  // *didn't* come back are the clipped ones, and marking them is what stops the
  // poll asking again.
  //
  // **Unless the response was truncated**, which `next` is the only evidence of.
  // The endpoint paginates, so a request bigger than a page comes back short —
  // and marking an id that was never *looked* at would retire it permanently,
  // turning "you were clipped out of this" into a message that also gets shown
  // to people who weren't. That's the one lie this module exists to stop
  // telling, so a truncated response only retires what it answered and the rest
  // go round again on the next pass (a shorter list, so a different query key
  // and a real refetch rather than a cache hit).
  const answered = new Set(page.results.map((message) => message.id));
  const tried = asked.get(conversationId) ?? new Set();
  for (const id of ids) {
    if (!page.next || answered.has(id)) tried.add(id);
  }
  asked.set(conversationId, tried);

  listeners.get(conversationId)?.forEach((notify) => notify());
}

/** 🔒 Drop every resolved quote. Sign-out, and resetting between tests. */
export function clearQuotes() {
  const conversations = [...resolved.keys()];
  resolved.clear();
  asked.clear();
  conversations.forEach((id) => listeners.get(id)?.forEach((notify) => notify()));
}

/**
 * Look up a quoted message by id, or `undefined` when it can't be resolved —
 * which the bubble renders as "Original message unavailable", **with no name
 * above it**. See `messaging.md`: a client that couldn't resolve the message
 * isn't entitled to its author either.
 */
export function useQuotedMessages(conversationId, loaded) {
  const cache = useResolved(conversationId);

  const loadedById = useMemo(
    () => new Map(loaded.map((message) => [message.id, message])),
    [loaded]
  );

  const wanted = useMemo(() => {
    const tried = asked.get(conversationId);
    const ids = new Set();
    for (const message of loaded) {
      const id = message.reply_to?.id;
      // Already in front of us, already fetched, or already tried: all three
      // mean there is nothing to ask.
      if (id == null || loadedById.has(id) || cache.has(id) || tried?.has(id)) {
        continue;
      }
      ids.add(id);
    }
    return [...ids].slice(0, IDS_PER_REQUEST);
  }, [conversationId, loaded, loadedById, cache]);

  // The joined ids *are* the identity of this request. Deriving the key from
  // them means the poll's new array identity every four seconds doesn't refetch
  // anything, while a genuinely new quote coming into view does.
  useQuery({
    queryKey: ["quotedMessages", conversationId, wanted.join(",")],
    queryFn: async () => {
      const page = await api.getMessagesByIds(conversationId, wanted);
      remember(conversationId, wanted, page);
      return page;
    },
    enabled: wanted.length > 0,
    // A message's text can change (an edit), but this copy only ever fills a
    // two-line quote, and the authoritative one is in the transcript as soon as
    // it pages in. Not worth a poll of its own.
    staleTime: Infinity,
  });

  return (id) => loadedById.get(id) ?? cache.get(id);
}
