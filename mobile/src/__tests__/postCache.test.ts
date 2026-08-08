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

import {
  invalidateComments,
  invalidatePostComments,
  markEventCommentsSeen,
  markPostCommentsSeen,
} from '@/postCache';
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
    client.setQueryData(['comments', 'post', 42], comments);
    client.setQueryData(['post', '43'], post(43, 5));

    markPostCommentsSeen(client, 42);

    expect(client.getQueryData(['comments', 'post', 42])).toBe(comments);
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

  it('doesn’t un-invalidate a list it has nothing to change', () => {
    // A `setQueryData` updater that hands back the data unchanged is still a
    // *write*: it dispatches a success, which resets `isInvalidated` to false.
    // Not academic — the two helpers meet in one ordinary flow. Posting a
    // comment invalidates every post list and refetches the tree, and the tree's
    // refetch is what calls this. So an unconditional write cancels the
    // invalidation a tick after `invalidatePostComments` made it, and the
    // profile and group timelines come back holding the old `comment_count`.
    //
    // All three bail-outs at once: a list that doesn't hold the post, a matching
    // key whose data isn't a paginated list at all, and a permalink already at 0.
    const client = makeClient();
    client.setQueryData(['feed', false], list([page([post(1, 2)])]));
    client.setQueryData(['groupPosts', 'nonsense'], { anything: true });
    client.setQueryData(['post', '42'], post(42, 0));
    invalidatePostComments(client, 42);

    markPostCommentsSeen(client, 42);

    for (const key of [['feed'], ['groupPosts'], ['post', '42']]) {
      const matches = client.getQueryCache().findAll({ queryKey: key });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((q) => q.state.isInvalidated)).toBe(true);
    }
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
    client.setQueryData(['comments', 'post', 42], [{ id: 9, post: 42 }]);
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
      ['comments', 'post', 42],
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
    client.setQueryData(['comments', 'post', 42], [{ id: 9 }]);
    client.setQueryData(['comments', 43], [{ id: 10 }]);

    invalidatePostComments(client, 42);

    expect(client.getQueryState(['comments', 43])?.isInvalidated).toBe(false);
  });

  it('does nothing, and throws nothing, on an empty cache', () => {
    const client = makeClient();
    expect(() => invalidatePostComments(client, 42)).not.toThrow();
  });
});

// The event twin. The badge lives on the group screen's `EventCard`, off
// `['groupEvents', id, …]` — a key only a comment *write* invalidates — and
// that screen stays mounted behind the pushed event screen, so a read-only
// visit has nothing else to clear it.
describe('markEventCommentsSeen', () => {
  const event = (id: number, newCount: number) =>
    ({ id, comment_count: 5, new_comment_count: newCount }) as never;

  it('clears the badge on every list that renders the event', () => {
    const client = makeClient();
    client.setQueryData(['groupEvents', 7, 'upcoming'], [event(9, 3)]);
    client.setQueryData(['groupEvents', 7, 'past'], [event(9, 3)]);
    client.setQueryData(['groupCalendar', 7], [event(9, 3)]);
    client.setQueryData(['personalCalendar'], [event(9, 3)]);
    client.setQueryData(['event', 9], event(9, 3));

    markEventCommentsSeen(client, 9);

    for (const key of [
      ['groupEvents', 7, 'upcoming'],
      ['groupEvents', 7, 'past'],
      ['groupCalendar', 7],
      ['personalCalendar'],
    ]) {
      expect(
        (client.getQueryData(key) as { new_comment_count: number }[])[0]
          .new_comment_count
      ).toBe(0);
    }
    expect(
      (client.getQueryData(['event', 9]) as { new_comment_count: number })
        .new_comment_count
    ).toBe(0);
  });

  it('leaves another event in the same list alone', () => {
    const client = makeClient();
    client.setQueryData(['groupEvents', 7, 'upcoming'], [event(9, 3), event(10, 2)]);

    markEventCommentsSeen(client, 9);

    const rows = client.getQueryData([
      'groupEvents',
      7,
      'upcoming',
    ]) as { id: number; new_comment_count: number }[];
    expect(rows.find((e) => e.id === 10)!.new_comment_count).toBe(2);
  });

  it('keeps a list identity stable when nothing needed clearing', () => {
    // So an unrelated cache entry doesn't re-render every screen holding it.
    const client = makeClient();
    const rows = [event(10, 0)];
    client.setQueryData(['groupEvents', 7, 'upcoming'], rows);

    markEventCommentsSeen(client, 9);

    expect(client.getQueryData(['groupEvents', 7, 'upcoming'])).toBe(rows);
  });

  it('does nothing, and throws nothing, on an empty cache', () => {
    const client = makeClient();
    expect(() => markEventCommentsSeen(client, 9)).not.toThrow();
  });

  it('doesn’t un-invalidate a list it has nothing to change', () => {
    // Same rule as the post twin above, and the same flow reaches it: commenting
    // on an event invalidates all four of its surfaces and refetches the tree,
    // whose refetch calls this. Here nothing needs clearing — another event's
    // row, and this event's own record already at 0 — so nothing may be written.
    const client = makeClient();
    client.setQueryData(['groupEvents', 7, 'upcoming'], [event(10, 2)]);
    client.setQueryData(['personalCalendar'], 'not a list');
    client.setQueryData(['event', 9], event(9, 0));
    invalidateComments(client, { eventId: 9, groupId: 7 });

    markEventCommentsSeen(client, 9);

    for (const key of [['groupEvents'], ['personalCalendar'], ['event', 9]]) {
      const matches = client.getQueryCache().findAll({ queryKey: key });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((q) => q.state.isInvalidated)).toBe(true);
    }
  });
});
