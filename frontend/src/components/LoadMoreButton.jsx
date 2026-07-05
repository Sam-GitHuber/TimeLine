// The "Load more" control shared by every paginated list. Pass it the query
// object from useInfiniteList; it renders nothing when there's no next page and
// disables itself while the next page is loading. Keeping it in one place means
// the button's look and paging behaviour can't drift between the feed, a
// profile, the people list, and the requests inbox.
export default function LoadMoreButton({ query }) {
  if (!query.hasNextPage) return null;

  return (
    <div className="flex justify-center py-4">
      <button
        type="button"
        onClick={() => query.fetchNextPage()}
        disabled={query.isFetchingNextPage}
        className="rounded-full border border-slate-300 px-5 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
      >
        {query.isFetchingNextPage ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}
