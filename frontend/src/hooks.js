import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { dayKey } from "./utils.js";

// Reactively track a CSS media query (e.g. "(max-width: 799px)"). Returns a
// boolean that updates as the viewport crosses the breakpoint, so components can
// branch on layout width without hard-coding pixel maths. Built on
// useSyncExternalStore — the React-blessed way to read from an external source
// like matchMedia — so there's no setState-in-effect. SSR-safe: the server
// snapshot falls back to false when there's no `window` (there isn't in some
// test setups).
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  const getSnapshot = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// A value that changes when the calendar day does (Phase 9b M9b — ported from
// the app's `useDayBoundary`).
//
// Day dividers say "Today" and "Yesterday", computed from the clock at the
// moment the rows are built. Nothing re-derives them on its own, so a tab left
// open across midnight goes on labelling yesterday's messages "Today" — and
// messages from the new day get folded under that same stale divider instead of
// starting one of their own. Waiting for a refetch isn't enough: a poll that
// returns identical data is exactly the case where you'd least expect the labels
// to be wrong.
//
// So this schedules a single timer for the next local midnight and returns the
// current day key, for callers to use as a memo dependency. One timer, rearmed
// once a day.
export function useDayBoundary() {
  const [today, setToday] = useState(() => dayKey(new Date().toISOString()));

  useEffect(() => {
    let timer;
    // Re-arm rather than using a 24h interval, which drifts — and a sleeping
    // laptop is precisely the case that matters. Rescheduling from the real
    // current time means a late fire doesn't accumulate.
    const schedule = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      // +1s of slack: firing a hair early would recompute the same day and
      // leave the label stale until the *next* midnight.
      timer = setTimeout(() => {
        setToday(dayKey(new Date().toISOString()));
        schedule();
      }, midnight.getTime() - now.getTime() + 1000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return today;
}

// Shared paging for our DRF PageNumberPagination endpoints (feed, profile
// posts, people, connection requests — all paginated at PAGE_SIZE on the
// backend).
//
// Give it a queryKey and a function that fetches the *first* page; it follows
// each response's `next` URL for the rest and hands back the flattened `items`
// alongside the usual TanStack query state (isLoading, hasNextPage, …). This is
// the one place paging behaviour lives, so a list page can't silently render
// only the first page and hide the rest.
//
// `options` is spread into the underlying useInfiniteQuery for the occasional
// caller that needs one (the activity centre only fetches while its dropdown is
// open, so it passes `enabled`). Paging itself is not configurable — that's the
// point of the hook.
export function useInfiniteList(queryKey, fetchFirstPage, options = {}) {
  const query = useInfiniteQuery({
    // Spread *first*, so the four keys below win: a caller can pass `enabled`
    // or `refetchInterval`, but cannot reach in and change how the list pages.
    ...options,
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : fetchFirstPage(),
    initialPageParam: undefined,
    // `?.`, not `.`, and the optional chain is the whole point: this is the one
    // shared paging seam on the web, and dereferencing a page that isn't one is
    // exactly how #297/#306 threw — a query-key collision put something else in
    // the cache, and `getNextPageParam` ran during render, so the TypeError took
    // the whole app down. #299 added a boundary underneath, but a net is not a
    // fix: an unpageable `lastPage` means "no next page", which is both true and
    // survivable. Every list in the web client pages through here, so this is
    // one token for the whole class.
    getNextPageParam: (lastPage) => lastPage?.next ?? undefined,
  });

  // Deduped by id: page-*number* paging re-sends a row when the underlying set
  // shifts mid-scroll, and two rows can't share a React key. The repeat is
  // dropped rather than de-duplicated by position, so the server's order —
  // the product's one non-negotiable guarantee on the feed — is untouched.
  // Written up in feed-and-posts.md; the app's twin is `dedupeById`.
  //
  // Memoised on the pages themselves, so `items` keeps its identity between
  // renders that didn't change the data. Without it every caller's own
  // `useMemo(..., [items])` is dead on arrival — a fresh array each render is a
  // fresh dependency — and each of them hands its list a new identity on every
  // keystroke and every poll tick, re-rendering every row.
  const items = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.results) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [query.data]);

  return { ...query, items };
}

// Drop every loaded page but the first.
//
// For `queryClient.setQueryData(key, trimToFirstPage)` before a list is put
// away or refetched wholesale: a refetch of an infinite query refetches **all**
// its loaded pages in turn, when only the first can hold anything new.
// (TanStack v5 removed `refetchPage`; trimming the cache first is the
// documented replacement.) The app's twin lives in `mobile/src/lists.ts`.
// Returns the input unchanged when there's nothing to trim, so the cache entry
// keeps its identity and nothing re-renders needlessly.
export function trimToFirstPage(data) {
  if (!data?.pages || data.pages.length <= 1) return data;
  return {
    ...data,
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}

// Put a paged list away: cancel whatever it has in flight, then drop every page
// but the first.
//
// The cancel has to come first and the trim has to wait on it — an in-flight
// "Load more" would otherwise land its page back into the cache after the trim,
// and the cancel's own revert would undo a trim that ran ahead of it. That
// ordering is subtle enough that the second caller is the point at which it
// stops being copied: the activity centre does this when its panel closes
// (#134), the conversation drawer when its view goes away or a search is
// cleared (#213).
//
// Rejections are swallowed on purpose. There is nothing to show and nothing to
// undo — the worst case is a cache entry keeping pages it didn't need — and an
// unhandled rejection is noise in the console at exactly the moment something
// else is already going wrong. The app's `push.ts` does the same for its own
// fire-and-forget calls.
export function trimQueryToFirstPage(queryClient, queryKey) {
  return queryClient
    .cancelQueries({ queryKey })
    .then(() => queryClient.setQueryData(queryKey, trimToFirstPage))
    .catch(() => {});
}

// Walk an infinite query to the end, pulling each remaining page as soon as the
// one before it lands. For the handful of lists that are bounded by something
// real (your connections; the replies to one message) and so are wanted whole,
// as opposed to the unbounded ones that page on scroll behind a LoadMoreButton.
//
// **The error guard is load-bearing, not defensive.** Without it a *failed* page
// fetch re-arms this effect the instant it fails: `hasNextPage` stays true,
// because the server never said there was no more, while `isFetchingNextPage`
// flips back to false — which is exactly the condition below. So a 500 or a
// dropped connection on page 2 doesn't stop the walk, it restarts it, as fast as
// the browser will go, with TanStack's own retries stacked on each attempt. That
// hammers an endpoint that is by definition already unhealthy, and flattens the
// battery of the phone doing it.
//
// ⚠️ It's **`isFetchNextPageError`, not the query-wide `isError`**, and the
// difference only shows on a list that *polls* (the conversation drawer, #213).
// A failed background refetch of page one sets `status: 'error'` while the data
// stays put — the whole reason surfaces branch on `isError && !data` rather than
// on `isError` — so the broad flag stopped a perfectly healthy walk because some
// unrelated poll dropped a packet, and left it stopped until a later poll
// happened to succeed. The narrow flag says the one thing this guard is about:
// *the page fetch we just asked for came back an error*. It stops the loop it
// was written to stop and nothing else.
//
// Stopping instead leaves a partial list and hands the transient case to the
// query's own retry/backoff. Recovery is automatic: any later fetch that
// succeeds (a poll, a refocus) clears `isError` and the remaining pages resume
// from where they stopped.
//
// ⚠️ **A caller of this hook owes the viewer an `isError` branch**, because a
// list that stops short looks exactly like a list that ended. That's the cost of
// not looping, and it's only paid if it's rendered: a picker missing the person
// you're looking for reads as "they aren't in your connections", which is a
// wrong answer, not a missing one. All three call sites render it.
//
// `enabled` is for the one caller that wants the whole list only *sometimes*:
// an event's album pages on scroll like any other long list, until you upload —
// and since the album is oldest-first, what you just added is on the last page.
// See `EventPhotos.jsx`. Passing it false leaves the query exactly as it is,
// paging behind its Load more button.
//
// One place, so the next list that wants every page can't reintroduce the loop.
export function useFetchAllPages(query, enabled = true) {
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = query;
  useEffect(() => {
    if (
      enabled &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    ) {
      fetchNextPage();
    }
  }, [
    enabled,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  ]);
}

// The viewer's accepted connections, for the "pick someone you already know"
// pickers (new message, group invite). Pulls *every* page of the shared
// ["users"] list — a connection can sort past the first page — then filters to
// accepted connections, optionally narrowed by a name search. One place so the
// two pickers can't drift on paging or the connection filter. Returns the full
// `connections` set (for empty-state copy) and the `filtered` subset to render.
export function useConnections(search = "") {
  const usersQuery = useInfiniteList(["users"], api.listUsers);
  useFetchAllPages(usersQuery);

  const connections = usersQuery.items.filter(
    (u) => u.connection_status === "connected"
  );
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? connections.filter((u) => u.display_name.toLowerCase().includes(needle))
    : connections;

  return {
    connections,
    filtered,
    isLoading: usersQuery.isLoading,
    isError: usersQuery.isError,
  };
}
