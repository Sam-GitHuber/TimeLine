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

// **`undefined` is how you decline to write.** `setQueryData` bails out the
// moment its updater returns `undefined`, and returning anything else — the
// *identical object included* — is a write: it dispatches a success, which
// resets `isInvalidated` to false. Handing back the unchanged data therefore
// isn't the no-op it reads as; it quietly cancels an invalidation somebody else
// just made. That flow is real and routine: posting a comment invalidates every
// post list (`invalidateComments`) and refetches the tree, and the refetch is
// what calls this — so an unconditional write would un-mark the profile and
// group timelines a tick after they were marked, and they'd come back holding
// yesterday's `comment_count`. Only `staleTime: 0` everywhere hides it today.
export function markPostCommentsSeen(queryClient, postId) {
  // Paginated lists: only rebuild a page (and the list) if it actually holds
  // the post with a non-zero count, so unrelated cache entries keep their
  // identity and don't trigger needless re-renders.
  queryClient.setQueriesData(
    { predicate: (query) => POST_LIST_KEYS.has(query.queryKey[0]) },
    (data) => {
      if (!data?.pages) return undefined;
      const hit = data.pages.some((page) =>
        page?.results?.some(
          (p) => p.id === postId && p.new_comment_count > 0
        )
      );
      if (!hit) return undefined;
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
  // Same rule as above — `undefined` unless the count actually moves.
  queryClient.setQueryData(["post", String(postId)], (post) => {
    const next = post ? seen(post, postId) : undefined;
    return next === post ? undefined : next;
  });
}

// Refetch everything a *change* to a post's comment tree touches: the tree
// itself, and the post's `comment_count` wherever a card renders it.
//
// The count rides the post payload rather than the comment tree, so adding or
// deleting a comment moves data in two different queries. Invalidate only the
// tree and the open thread shows four comments under a button still reading
// "Comments · 3" — as does every other surface holding that post (profile
// timeline, group timeline, permalink) until something unrelated refetches.
//
// It's one helper rather than a list of keys copied into each mutation because
// that copying is the actual failure mode: delete had the full set and add had
// one key of it for months (#215). Deriving the list surfaces from
// POST_LIST_KEYS means a new one can't be added to `markPostCommentsSeen`
// without the invalidation following it.
export function invalidatePostComments(queryClient, postId) {
  invalidateComments(queryClient, { postId });
}

// The query key for one comment thread. A thread hangs off a post **or** an
// event, and the two id spaces are separate — post 7 and event 7 both exist —
// so the kind is part of the key. Without it the two would share a cache entry
// and whichever loaded second would paint the other's comments.
//
// `connectionCache` invalidates the `["comments"]` prefix, which still matches
// both, deliberately: a connection change re-prunes every tree.
export function commentsQueryKey({ postId = null, eventId = null }) {
  if (postId != null) return ["comments", "post", postId];
  if (eventId != null) return ["comments", "event", eventId];
  throw new Error("commentsQueryKey needs a postId or an eventId");
}

// Refetch everything a *change* to a comment tree touches: the tree itself, and
// the target's `comment_count` wherever a card renders it.
//
// The count rides the target's payload rather than the comment tree, so adding
// or deleting a comment moves data in two different queries. Invalidate only
// the tree and the open thread shows four comments under a button still reading
// "Comments · 3" — as does every other surface holding it, until something
// unrelated refetches.
//
// **An event lives on four surfaces, and this names all four** — the same rule
// `EventPage`'s `invalidate()` follows, and for the reason #279 established: a
// key nothing points at from the write side is exactly how a surface gets
// missed. `groupId` is optional only because a caller that doesn't have it
// still wants the other three refreshed; pass it wherever it's known.
export function invalidateComments(
  queryClient,
  { postId = null, eventId = null, groupId = null }
) {
  const target = postId != null ? { postId } : { eventId };
  const keys = [commentsQueryKey(target)];
  if (postId != null) {
    keys.push(
      ...[...POST_LIST_KEYS].map((key) => [key]),
      // Keyed by string: that's what useParams hands the permalink query.
      ["post", String(postId)]
    );
  } else {
    // **Numbers, not strings** — `EventPage` builds its keys from
    // `Number(useParams().eid)`, where the permalink post query keeps the raw
    // string. The two conventions are a trap: a key that doesn't match
    // invalidates nothing at all and fails completely silently, so these are
    // coerced here rather than trusting every caller to have the right type.
    keys.push(["event", Number(eventId)], ["personalCalendar"]);
    if (groupId != null) {
      keys.push(
        ["groupEvents", Number(groupId)],
        ["groupCalendar", Number(groupId)]
      );
    }
  }
  for (const queryKey of keys) {
    queryClient.invalidateQueries({ queryKey });
  }
}
