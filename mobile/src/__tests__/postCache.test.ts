/**
 * Ported from `frontend/src/postCache.test.js`, because the behaviour must match:
 * both clients drive the "N new" badge off the same server-shaped count.
 *
 * **Seed the real keys, never a bare `['feed']`.** Every post list this touches
 * caches under a suffixed key — `['feed', includeGroups]`, `['userPosts', id]`,
 * `['groupPosts', id]`. Seeding `['feed']` tests a cache entry the app never
 * writes, which is how an exact-match `setQueryData` passed its suite while the
 * badge sat stale on a real phone (#195).
 */

import { QueryClient } from '@tanstack/react-query';

import { invalidatePostComments, markPostCommentsSeen } from '@/postCache';
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

function list(pages: Paginated<Post>[]) {
  return { pages, pageParams: pages.map((_, i) => (i ? `?page=${i + 1}` : '')) };
}

function counts(client: QueryClient, key: unknown[]): number[] {
  const data = client.getQueryData(key) as { pages: Paginated<Post>[] };
  return data.pages.flatMap((p) => p.results.map((x) => x.new_comment_count));
}

describe('markPostCommentsSeen', () => {
  it('zeroes the new-comment count for that post in the feed', () => {
    const client = makeClient();
    client.setQueryData(['feed', false], list([page([post(42, 3), post(43, 1)])]));

    markPostCommentsSeen(client, 42);

    // Everyone else is untouched.
    expect(counts(client, ['feed', false])).toEqual([0, 1]);
  });

  it('reaches the feed whichever include-groups variant is cached', () => {
    // The home feed key carries the preference, and both variants can be in the
    // cache at once after a toggle. An exact-key write matches neither.
    const client = makeClient();
    client.setQueryData(['feed', true], list([page([post(42, 3)])]));
    client.setQueryData(['feed', false], list([page([post(42, 2)])]));

    markPostCommentsSeen(client, 42);

    expect(counts(client, ['feed', true])).toEqual([0]);
    expect(counts(client, ['feed', false])).toEqual([0]);
  });

  it('zeroes the count on a profile timeline', () => {
    const client = makeClient();
    client.setQueryData(['userPosts', '7'], list([page([post(42, 4)])]));

    markPostCommentsSeen(client, 42);

    expect(counts(client, ['userPosts', '7'])).toEqual([0]);
  });

  it('zeroes the count on a group timeline', () => {
    const client = makeClient();
    client.setQueryData(['groupPosts', '3'], list([page([post(42, 6)])]));

    markPostCommentsSeen(client, 42);

    expect(counts(client, ['groupPosts', '3'])).toEqual([0]);
  });

  it('updates the post across every loaded page', () => {
    const client = makeClient();
    client.setQueryData(
      ['feed', true],
      list([page([post(1, 2)]), page([post(42, 5)])])
    );

    markPostCommentsSeen(client, 42);

    expect(counts(client, ['feed', true])).toEqual([2, 0]);
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
    const before = list([page([post(1, 2)])]);
    client.setQueryData(['feed', false], before);

    markPostCommentsSeen(client, 42);

    expect(client.getQueryData(['feed', false])).toBe(before);
  });

  it('leaves queries outside the post lists alone', () => {
    // The match is on the first key segment, so anything else in the cache —
    // a comment thread, a group's own record — must be passed over untouched.
    const client = makeClient();
    const comments = [{ id: 9, post: 42 }];
    client.setQueryData(['comments', 42], comments);
    client.setQueryData(['post', '43'], post(43, 5));

    markPostCommentsSeen(client, 42);

    expect(client.getQueryData(['comments', 42])).toBe(comments);
    expect((client.getQueryData(['post', '43']) as Post).new_comment_count).toBe(5);
  });

  it('passes over a matching key whose data is not a paginated list', () => {
    const client = makeClient();
    const plain = { anything: true };
    client.setQueryData(['groupPosts', 'nonsense'], plain);

    expect(() => markPostCommentsSeen(client, 42)).not.toThrow();
    expect(client.getQueryData(['groupPosts', 'nonsense'])).toBe(plain);
  });

  it('does nothing, and throws nothing, on an empty cache', () => {
    const client = makeClient();
    expect(() => markPostCommentsSeen(client, 42)).not.toThrow();
  });
});

/**
 * The other half: the *total*, which only the server knows after pruning, so it
 * has to be refetched rather than computed (#273).
 *
 * Seed the suffixed keys here for the same reason as above — but note the check
 * is the reverse one. `invalidateQueries` prefix-matches, so a bare
 * `['userPosts']` is *meant* to reach `['userPosts', '7']`; these tests exist to
 * prove every surface is on the list at all, which is the bit that drifted.
 */
describe('invalidatePostComments', () => {
  function seedEverySurface(client: QueryClient) {
    client.setQueryData(['comments', 42], [{ id: 9, post: 42 }]);
    client.setQueryData(['feed', false], list([page([post(42, 0)])]));
    client.setQueryData(['userPosts', '7'], list([page([post(42, 0)])]));
    client.setQueryData(['groupPosts', '3'], list([page([post(42, 0)])]));
    client.setQueryData(['post', '42'], post(42, 0));
  }

  function invalidated(client: QueryClient, key: unknown[]): boolean {
    const matches = client.getQueryCache().findAll({ queryKey: key });
    expect(matches.length).toBeGreaterThan(0);
    return matches.every((q) => q.state.isInvalidated);
  }

  it('marks the tree and every surface carrying the count', () => {
    const client = makeClient();
    seedEverySurface(client);

    invalidatePostComments(client, 42);

    // The profile and group timelines are the two that were missing: a card
    // there read "Comments · 3" over a thread of four until something else
    // refetched.
    for (const key of [
      ['comments', 42],
      ['feed'],
      ['userPosts'],
      ['groupPosts'],
      ['post', '42'],
    ]) {
      expect(invalidated(client, key)).toBe(true);
    }
  });

  it('covers every post list markPostCommentsSeen writes to', () => {
    // The two helpers have to agree: a surface added to one and not the other
    // is exactly the drift the shared key set exists to prevent. So rather than
    // restate the list, seed only post lists, let the *write* tell us which
    // ones it reaches, and require the invalidation to have reached all of them.
    const client = makeClient();
    client.setQueryData(['feed', true], list([page([post(42, 3)])]));
    client.setQueryData(['feed', false], list([page([post(42, 3)])]));
    client.setQueryData(['userPosts', '7'], list([page([post(42, 3)])]));
    client.setQueryData(['groupPosts', '3'], list([page([post(42, 3)])]));

    markPostCommentsSeen(client, 42);
    const written = client
      .getQueryCache()
      .getAll()
      .filter((q) => counts(client, q.queryKey as unknown[]).includes(0))
      .map((q) => q.queryKey as unknown[]);
    expect(written).toHaveLength(4);

    invalidatePostComments(client, 42);

    for (const key of written) {
      expect(invalidated(client, key)).toBe(true);
    }
  });

  it('leaves another post’s permalink alone', () => {
    // Two of the five keys carry the post id — the permalink and the tree
    // below. They're the ones that must *not* reach another post, in contrast
    // to the three bare list keys, whose whole job is to reach every id-suffixed
    // entry. Getting one of these written as a bare key would be silent.
    const client = makeClient();
    client.setQueryData(['post', '42'], post(42, 0));
    client.setQueryData(['post', '43'], post(43, 0));

    invalidatePostComments(client, 42);

    expect(client.getQueryState(['post', '43'])?.isInvalidated).toBe(false);
  });

  it('leaves another post’s comment tree alone', () => {
    const client = makeClient();
    client.setQueryData(['comments', 42], [{ id: 9 }]);
    client.setQueryData(['comments', 43], [{ id: 10 }]);

    invalidatePostComments(client, 42);

    expect(client.getQueryState(['comments', 43])?.isInvalidated).toBe(false);
  });

  it('does nothing, and throws nothing, on an empty cache', () => {
    const client = makeClient();
    expect(() => invalidatePostComments(client, 42)).not.toThrow();
  });
});
