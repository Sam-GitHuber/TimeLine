import {
  useCallback,
  useEffect,
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
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  // Deduped by id: page-*number* paging re-sends a row when the underlying set
  // shifts mid-scroll, and two rows can't share a React key. The repeat is
  // dropped rather than de-duplicated by position, so the server's order —
  // the product's one non-negotiable guarantee on the feed — is untouched.
  // Written up in feed-and-posts.md; the app's twin is `dedupeById`.
  const seen = new Set();
  const items = [];
  for (const page of query.data?.pages ?? []) {
    for (const item of page.results) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
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

// The viewer's accepted connections, for the "pick someone you already know"
// pickers (new message, group invite). Pulls *every* page of the shared
// ["users"] list — a connection can sort past the first page — then filters to
// accepted connections, optionally narrowed by a name search. One place so the
// two pickers can't drift on paging or the connection filter. Returns the full
// `connections` set (for empty-state copy) and the `filtered` subset to render.
export function useConnections(search = "") {
  const usersQuery = useInfiniteList(["users"], api.listUsers);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = usersQuery;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
