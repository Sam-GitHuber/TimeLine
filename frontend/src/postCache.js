// Reconcile the cached copies of a post after its comment thread is opened.
//
// Opening a thread marks its comments seen on the server (the GET on the
// comments endpoint), so the "N new" count the feed is still showing for that
// post is now stale. Rather than refetch the whole feed, we mirror the server's
// reset into every cached post list — the home feed, a profile timeline, a group
// timeline — and the single-post permalink query, zeroing `new_comment_count`
// for that one post.
//
// Why this and not a local "already opened" flag on the card: the count isn't
// monotonic (opening resets it to 0 server-side, then a later comment raises it
// to 1 again). Driving the badge purely off this cached, server-shaped value
// keeps it correct when genuinely-new comments arrive after you've looked —
// a per-card flag would suppress them until the card remounts.

// The post-list queries whose data is the paginated infinite-list shape
// `{ pages: [{ results: [post, …] }, …] }` (see useInfiniteList).
const POST_LIST_KEYS = new Set(["feed", "userPosts", "groupPosts"]);

function seen(post, postId) {
  return post.id === postId && post.new_comment_count > 0
    ? { ...post, new_comment_count: 0 }
    : post;
}

export function markPostCommentsSeen(queryClient, postId) {
  // Paginated lists: only rebuild a page (and the list) if it actually holds
  // the post with a non-zero count, so unrelated cache entries keep their
  // identity and don't trigger needless re-renders.
  queryClient.setQueriesData(
    { predicate: (query) => POST_LIST_KEYS.has(query.queryKey[0]) },
    (data) => {
      if (!data?.pages) return data;
      const hit = data.pages.some((page) =>
        page?.results?.some(
          (p) => p.id === postId && p.new_comment_count > 0
        )
      );
      if (!hit) return data;
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          results: page.results.map((p) => seen(p, postId)),
        })),
      };
    }
  );

  // The single-post permalink query (/p/:id): data is the post object itself.
  queryClient.setQueryData(["post", String(postId)], (post) =>
    post ? seen(post, postId) : post
  );
}
