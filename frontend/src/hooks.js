import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api.js";

// Shared paging for our DRF PageNumberPagination endpoints (feed, profile
// posts, people, follow requests — all paginated at PAGE_SIZE on the backend).
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
