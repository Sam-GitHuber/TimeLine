/**
 * Keeping cached copies of a post honest after its thread is opened.
 *
 * Ported from `frontend/src/postCache.js` — the same deliberate copy the repo
 * layout decision calls for (see docs/reference/mobile-app.md); fix a bug
 * here and fix it there too.
 *
 * Opening a comment thread marks it seen **on the server** (the GET on the
 * comments endpoint stamps `last_seen_at`), so the "N new" count the feed is
 * still showing for that post is immediately stale. Rather than refetch the
 * whole feed to learn something we already know, mirror the server's reset into
 * the cache.
 *
 * **Why this and not a local "already opened" flag on the card:** the count is
 * not monotonic. Opening resets it to 0 server-side, and a later comment raises
 * it to 1 again. Driving the badge purely off this cached, server-shaped value
 * stays correct when new comments arrive after you've looked — a per-card flag
 * would suppress them until the card remounted.
 */

import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { CommentTarget } from './api';
import type { Paginated, Post } from './types';

/**
 * The post-list queries, whose data is the paginated infinite-list shape
 * `{ pages: [{ results: [post, …] }, …] }`.
 *
 * Matched on the **first** key segment only, never on the whole key. Every one
 * of these keys carries a suffix the writer here doesn't know — the home feed is
 * `['feed', includeGroups]` (the include-groups-in-feed preference), a profile
 * is `['userPosts', id]`, a group timeline `['groupPosts', id]`. An exact-key
 * `setQueryData(['feed'], …)` matches none of them and updates nothing, silently
 * — which is exactly how the badge came to sit there stale (#195).
 */
const POST_LIST_KEYS = new Set(['feed', 'userPosts', 'groupPosts']);

function seen(post: Post, postId: number): Post {
  return post.id === postId && post.new_comment_count > 0
    ? { ...post, new_comment_count: 0 }
    : post;
}

export function markPostCommentsSeen(
  queryClient: QueryClient,
  postId: number
): void {
  // Paginated lists: only rebuild a page (and the list) when it actually holds
  // this post with a non-zero count, so unrelated cache entries keep their
  // identity and don't trigger needless re-renders down the tree.
  queryClient.setQueriesData<InfiniteData<Paginated<Post>, string>>(
    { predicate: (query) => POST_LIST_KEYS.has(query.queryKey[0] as string) },
    (data) => {
      if (!data?.pages) return data;
      const hit = data.pages.some((page) =>
        page?.results?.some((p) => p.id === postId && p.new_comment_count > 0)
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

  // The single-post permalink query, whose data is the post itself.
  queryClient.setQueryData<Post>(['post', String(postId)], (post) =>
    post ? seen(post, postId) : post
  );
}

/**
 * Refetch everything a *change* to a post's comment tree touches: the tree
 * itself, and the post's `comment_count` wherever a card renders it.
 *
 * The total rides the post payload rather than the comment tree, so adding or
 * deleting a comment moves data in two different queries. Invalidate only the
 * tree and the open thread shows four comments under a button still reading
 * "Comments · 3" — as does every other surface holding that post (home feed,
 * profile timeline, group timeline, permalink) until something unrelated
 * refetches.
 *
 * It's one helper rather than a list of keys copied into each mutation because
 * that copying is the actual failure mode: delete had the full set and add had
 * three keys of it (#273, the mobile half of #215). Deriving the list surfaces
 * from POST_LIST_KEYS means a new one can't be added to `markPostCommentsSeen`
 * without the invalidation following it.
 *
 * Prefix-matching is what makes the bare keys work: `['userPosts']` reaches the
 * real `['userPosts', id]` entry. That's the opposite of `setQueryData` above,
 * which needs the exact key — the asymmetry is the whole reason #195 happened.
 */
export function invalidatePostComments(
  queryClient: QueryClient,
  postId: number
): void {
  invalidateComments(queryClient, { postId });
}

/**
 * The query key for one comment thread.
 *
 * A thread hangs off a post **or** an event, and the two id spaces are separate
 * — post 7 and event 7 both exist — so the kind is part of the key. Without it
 * the two would share a cache entry and whichever loaded second would paint the
 * other's comments. Mirrors `commentsQueryKey` in `frontend/src/postCache.js`.
 *
 * `connectionCache` invalidates the `['comments']` prefix, which still matches
 * both, deliberately: a connection change re-prunes every tree.
 */
export function commentsQueryKey({ postId, eventId }: CommentTarget): unknown[] {
  if (postId != null) return ['comments', 'post', Number(postId)];
  if (eventId != null) return ['comments', 'event', Number(eventId)];
  throw new Error('commentsQueryKey needs a postId or an eventId');
}

/**
 * Refetch everything a *change* to a comment tree touches: the tree itself, and
 * the target's `comment_count` wherever a card renders it.
 *
 * **An event lives on four surfaces and this names all four** — the rule
 * `EventScreen`'s own invalidate already follows, now applied to comment
 * writes. `groupId` is optional only because a caller without it still wants
 * the other keys refreshed; pass it wherever it's known.
 *
 * Every event key is coerced to a **number**, because that's what
 * `EventScreen` builds its keys from while the post permalink keeps the raw
 * string. A key of the wrong type matches nothing and fails silently.
 */
export function invalidateComments(
  queryClient: QueryClient,
  { postId, eventId, groupId }: CommentTarget
): void {
  const keys: unknown[][] = [
    commentsQueryKey(postId != null ? { postId } : { eventId }),
  ];
  if (postId != null) {
    keys.push(
      ...[...POST_LIST_KEYS].map((key) => [key]),
      // Keyed by string: that's what the route param hands the permalink query.
      ['post', String(postId)]
    );
  } else {
    keys.push(['event', Number(eventId)], ['personalCalendar']);
    if (groupId != null) {
      keys.push(
        ['groupEvents', Number(groupId)],
        ['groupCalendar', Number(groupId)]
      );
    }
  }
  for (const queryKey of keys) {
    queryClient.invalidateQueries({ queryKey });
  }
}
