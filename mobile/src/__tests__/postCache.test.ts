/**
 * Ported from `frontend/src/postCache.test.js`, because the behaviour must match:
 * both clients drive the "N new" badge off the same server-shaped count.
 */

import { QueryClient } from '@tanstack/react-query';

import { markPostCommentsSeen } from '@/postCache';
import type { Paginated, Post } from '@/types';

/**
 * `gcTime: 0` matters here: the default five-minute garbage-collection timer
 * keeps Node's event loop alive, so the suite passes and then Jest refuses to
 * exit — which hangs the CI job rather than failing it.
 */
function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
}

function post(id: number, newCount: number): Post {
  return {
    id,
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: `Post ${id}`,
    images: [],
    group: null,
    reactions: [],
    comment_count: newCount,
    new_comment_count: newCount,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
  };
}

function page(posts: Post[]): Paginated<Post> {
  return { count: posts.length, next: null, previous: null, results: posts };
}

describe('markPostCommentsSeen', () => {
  it('zeroes the new-comment count for that post in the feed', () => {
    const client = makeClient();
    client.setQueryData(['feed'], {
      pages: [page([post(42, 3), post(43, 1)])],
      pageParams: [''],
    });

    markPostCommentsSeen(client, 42);

    const data = client.getQueryData(['feed']) as { pages: Paginated<Post>[] };
    expect(data.pages[0].results[0].new_comment_count).toBe(0);
    // Everyone else is untouched.
    expect(data.pages[0].results[1].new_comment_count).toBe(1);
  });

  it('updates the post across every loaded page', () => {
    const client = makeClient();
    client.setQueryData(['feed'], {
      pages: [page([post(1, 2)]), page([post(42, 5)])],
      pageParams: ['', '?page=2'],
    });

    markPostCommentsSeen(client, 42);

    const data = client.getQueryData(['feed']) as { pages: Paginated<Post>[] };
    expect(data.pages[1].results[0].new_comment_count).toBe(0);
  });

  it('zeroes the permalink query too', () => {
    const client = makeClient();
    client.setQueryData(['post', '42'], post(42, 4));

    markPostCommentsSeen(client, 42);

    expect((client.getQueryData(['post', '42']) as Post).new_comment_count).toBe(0);
  });

  it('keeps the cache entry identical when the post is not there', () => {
    // Identity matters: returning a new object would re-render every feed row
    // for a post that isn't even on screen.
    const client = makeClient();
    const before = { pages: [page([post(1, 2)])], pageParams: [''] };
    client.setQueryData(['feed'], before);

    markPostCommentsSeen(client, 42);

    expect(client.getQueryData(['feed'])).toBe(before);
  });

  it('does nothing, and throws nothing, on an empty cache', () => {
    const client = makeClient();
    expect(() => markPostCommentsSeen(client, 42)).not.toThrow();
  });
});
