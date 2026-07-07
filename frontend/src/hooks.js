import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api.js";

// Reactively track a CSS media query (e.g. "(max-width: 799px)"). Returns a
// boolean that updates as the viewport crosses the breakpoint, so components can
// branch on layout width without hard-coding pixel maths. SSR-safe: falls back
// to false when there's no `window` (there isn't in some test setups).
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
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
export function useInfiniteList(queryKey, fetchFirstPage) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : fetchFirstPage(),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  const items = query.data?.pages.flatMap((page) => page.results) ?? [];
  return { ...query, items };
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
