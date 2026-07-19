/**
 * Keeping cached copies of a post honest after its thread is opened.
 *
 * Ported from `frontend/src/postCache.js` — the same deliberate copy the repo
 * layout decision calls for (see docs/phases/phase-9-iphone-app.md); fix a bug
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

import type { Paginated, Post } from './types';

function seen(post: Post, postId: number): Post {
  return post.id === postId && post.new_comment_count > 0
    ? { ...post, new_comment_count: 0 }
    : post;
}

export function markPostCommentsSeen(
  queryClient: QueryClient,
  postId: number
): void {
  // The paginated feed. Only rebuild a page (and the list) when it actually
  // holds this post with a non-zero count, so unrelated cache entries keep their
  // identity and don't trigger needless re-renders down the tree.
  queryClient.setQueryData<InfiniteData<Paginated<Post>, string>>(
    ['feed'],
    (data) => {
      if (!data?.pages) return data;
      const hit = data.pages.some((page) =>
        page.results.some((p) => p.id === postId && p.new_comment_count > 0)
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
