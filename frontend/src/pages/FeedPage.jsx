import { useInfiniteQuery } from "@tanstack/react-query";
import ComposeBox from "../components/ComposeBox.jsx";
import PostCard from "../components/PostCard.jsx";
import { api } from "../api.js";

// The home timeline: your posts + everyone you follow, strictly newest-first.
// No ranking, no "suggested" content — that constraint is the whole point of
// the project. The backend already orders and scopes the feed; the frontend
// just renders the pages, following the `next` URL to load older posts.
export default function FeedPage() {
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["feed"],
    queryFn: ({ pageParam }) =>
      pageParam ? api.getPage(pageParam) : api.getFeed(),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });

  const posts = data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div>
      <ComposeBox />

      {isLoading && (
        <p className="px-6 py-10 text-center text-slate-500">Loading feed…</p>
      )}

      {isError && (
        <p className="px-6 py-10 text-center text-rose-600">
          {error?.message || "Couldn't load the feed."}
        </p>
      )}

      {!isLoading && !isError && posts.length === 0 && (
        <p className="px-6 py-10 text-center text-slate-500">
          Your feed is empty. Write something above, or find people to follow.
        </p>
      )}

      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}

      {hasNextPage && (
        <div className="flex justify-center py-4">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-full border border-slate-300 px-5 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
