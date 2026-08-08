/**
 * The comment thread: the tree, collapsing, replying, and the deep-link path a
 * push notification will use in Milestone D.
 *
 * The pruning itself is a *server* guarantee (connections.md) and is tested in
 * `backend/`; what matters here is that the client renders the tree it was given
 * without dropping or reordering anything.
 */

import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
  useQuery,
} from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { CommentThread, ancestorIdsOf } from '@/components/CommentThread';
import { commentsQueryKey } from '@/postCache';
import type { Comment } from '@/types';

import { androidIt, captureBackHandler, pressBack } from './helpers';

// CommentThread reads the current user (to hide "Report" on your own comment).
// A fixed stub keeps the real AuthProvider's async setState out of these tests;
// pk 99 is nobody in these fixtures, so Report shows on every comment here.
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({ user: { pk: 99, display_name: 'Test Viewer' } }),
}));

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function comment(overrides: Partial<Comment> & { id: number }): Comment {
  return {
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    parent: null,
    text: `Comment ${overrides.id}`,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    replies: [],
    reactions: [],
    ...overrides,
  };
}

/**
 * `gcTime: 0` keeps Jest able to exit: the default five-minute collection timer
 * holds Node's event loop open, which hangs the CI job rather than failing it.
 * The price is that an *unobserved* seeded cache entry is collected on the next
 * tick — so anything asserted on across an `await` has to be mounted, not seeded
 * (see `renderThreadOverTimelines` and `renderFeed`).
 */
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
}

function renderThread(
  props: Partial<Parameters<typeof CommentThread>[0]> = {},
  queryClient: QueryClient = makeClient()
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentThread target={{ postId: 7 }} {...props} />
    </QueryClientProvider>
  );
}

/**
 * A timeline screen sitting in the stack underneath the post you're reading.
 *
 * It renders nothing — all that matters is that it *observes* its query, the
 * way the real screen does, because that's what decides whether an invalidation
 * refetches now or is merely noted for later.
 */
function TimelineScreen({
  queryKey,
  queryFn,
}: {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
}) {
  useQuery({ queryKey, queryFn });
  return null;
}

function postList(newCommentCount: number) {
  return {
    pages: [
      {
        count: 1,
        next: null,
        previous: null,
        results: [
          { id: 7, comment_count: 3, new_comment_count: newCommentCount },
        ],
      },
    ],
    pageParams: [undefined],
  };
}

/**
 * The thread, with the surfaces that also show its post mounted alongside it.
 *
 * **Mounted, not seeded, and that's the point.** Expo Router's native stack
 * keeps the screen you came *from* mounted while you read a post, so its query
 * has a live observer and never remounts when you go back — which is exactly
 * why a stale count sat there in the first place (#273). A seeded, unobserved
 * cache entry doesn't reproduce that: with `staleTime` at 0 an unmounted screen
 * refetches on its next mount whatever we do here, so it would pass against the
 * broken build. Asserting on refetches also side-steps a race — the
 * seen-marking effect writes to these same queries a tick after the thread
 * refetches, and a `setQueryData` clears `isInvalidated`, so the flag is not a
 * dependable thing to wait on.
 */
async function renderThreadOverTimelines() {
  const queryClient = makeClient();
  // Non-zero `new_comment_count`, so the seen-marking write really does fire on
  // these queries and the test covers the two writes interleaving.
  const screens = {
    feed: { key: ['feed', false], fn: jest.fn(async () => postList(2)) },
    userPosts: { key: ['userPosts', '1'], fn: jest.fn(async () => postList(2)) },
    groupPosts: { key: ['groupPosts', '5'], fn: jest.fn(async () => postList(2)) },
    permalink: {
      key: ['post', '7'],
      fn: jest.fn(async () => ({ id: 7, comment_count: 3, new_comment_count: 2 })),
    },
  };
  await render(
    <QueryClientProvider client={queryClient}>
      {Object.entries(screens).map(([name, s]) => (
        <TimelineScreen key={name} queryKey={s.key} queryFn={s.fn} />
      ))}
      <CommentThread target={{ postId: 7 }} />
    </QueryClientProvider>
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() =>
    expect(loadCounts(screens)).toEqual({
      feed: 1,
      userPosts: 1,
      groupPosts: 1,
      permalink: 1,
    })
  );
  return { queryClient, screens };
}

type Screens = Awaited<ReturnType<typeof renderThreadOverTimelines>>['screens'];

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts(screens: Screens) {
  return Object.fromEntries(
    Object.entries(screens).map(([name, s]) => [name, s.fn.mock.calls.length])
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// `onlineManager` is a module-level singleton, so a test that takes it offline
// would take every test after it offline too. Restored here rather than in the
// test, which runs before RNTL's cleanup: resuming a paused query on a component
// about to be unmounted is a warning nobody needs to read.
afterEach(() => {
  onlineManager.setOnline(true);
});

describe('ancestorIdsOf', () => {
  const tree = [
    comment({
      id: 1,
      replies: [
        comment({ id: 2, parent: 1, replies: [comment({ id: 3, parent: 2 })] }),
      ],
    }),
    comment({ id: 4 }),
  ];

  it('returns the trail of parents above a deep target', () => {
    // Replies start collapsed, so a notification pointing at comment 3 has to
    // open 1 and 2 — and nothing else — for it to be reachable.
    expect(ancestorIdsOf(tree, 3)).toEqual(new Set([1, 2]));
  });

  it('returns nothing for a top-level target', () => {
    expect(ancestorIdsOf(tree, 4)).toEqual(new Set());
  });

  it('returns nothing when the target is not in the tree', () => {
    // A comment pruned away for this viewer, or since deleted.
    expect(ancestorIdsOf(tree, 999)).toEqual(new Set());
  });
});

describe('the tree', () => {
  it('renders top-level comments in the order given', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({ id: 1, text: 'First' }),
        comment({ id: 2, text: 'Second' }),
      ])
    );

    await renderThread();

    expect(await screen.findByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('collapses replies behind a toggle, so a busy post opens clean', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({
          id: 1,
          text: 'Parent',
          replies: [comment({ id: 2, parent: 1, text: 'Hidden reply' })],
        }),
      ])
    );

    await renderThread();

    expect(await screen.findByText('Parent')).toBeTruthy();
    expect(screen.queryByText('Hidden reply')).toBeNull();

    await fireEvent.press(screen.getByText('Show 1 reply'));

    expect(await screen.findByText('Hidden reply')).toBeTruthy();
  });

  it('auto-expands the ancestors of a deep-linked comment', async () => {
    // The Milestone D path: "someone replied" must land you on the reply, even
    // one buried inside collapsed parents.
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({
          id: 1,
          text: 'Top',
          replies: [
            comment({
              id: 2,
              parent: 1,
              text: 'Middle',
              replies: [comment({ id: 3, parent: 2, text: 'The reply' })],
            }),
          ],
        }),
      ])
    );

    await renderThread({ highlightCommentId: 3 });

    expect(await screen.findByText('The reply')).toBeTruthy();
  });

  it('shows an empty state rather than a bare box', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));

    await renderThread();

    expect(
      await screen.findByText('No comments yet. Start the conversation.')
    ).toBeTruthy();
  });

  it('says so when the thread can’t be loaded at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'That post is gone.' }, 404));

    await renderThread();

    expect(await screen.findByText('That post is gone.')).toBeTruthy();
    // No write box over nothing: there's no thread to add to.
    expect(screen.queryByLabelText('Write a comment…')).toBeNull();
  });

  it('keeps an open thread when a refetch fails', async () => {
    // The render used to return on `error` before it looked at the tree — and
    // query-core's error action sets `status: 'error'` while *keeping* the data
    // it has. So a failed foreground refetch of an open thread replaced the
    // whole conversation with one line of red text and took the composer, and
    // any half-typed reply, with it. A failed refresh of something already on
    // screen is not a reason to take it off screen.
    const queryClient = makeClient();
    queryClient.setQueryData(commentsQueryKey({ postId: 7 }), [
      comment({ id: 1, text: 'Already read this' }),
    ]);
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Offline.' }, 500));

    await renderThread({}, queryClient);
    // The cached tree paints synchronously, before the refetch goes anywhere.
    expect(screen.getByText('Already read this')).toBeTruthy();

    await waitFor(() =>
      expect(
        queryClient.getQueryState(commentsQueryKey({ postId: 7 }))?.status
      ).toBe('error')
    );

    expect(screen.getByText('Already read this')).toBeTruthy();
    expect(screen.getByLabelText('Write a comment…')).toBeTruthy();
  });

  /**
   * Unreachable in the shipped app, and pinning the branch anyway.
   *
   * `onlineManager` is deliberately left unwired to NetInfo (`app/_layout.tsx`),
   * so an offline GET *rejects* and lands on the error line above. Wiring it is a
   * one-line change, and on the day someone does, the failure here would be a
   * spinner that never stops with nothing on screen saying why. Driving
   * `onlineManager` directly is exactly what that change does.
   */
  it('says so, rather than spinning for ever, when the request is paused', async () => {
    onlineManager.setOnline(false);
    mockFetch.mockResolvedValue(jsonResponse([]));

    await renderThread();

    expect(await screen.findByText('Waiting for a connection…')).toBeTruthy();
    // Paused means not yet attempted — the request is still to come.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('writing', () => {
  it('posts a top-level comment with no parent', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse(comment({ id: 9 }), 201));

    await renderThread();
    await screen.findByText('No comments yet. Start the conversation.');

    await fireEvent.changeText(
      screen.getByLabelText('Write a comment…'),
      '  Lovely photo  '
    );
    await fireEvent.press(screen.getByLabelText('Post comment'));

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(1));
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toContain('/api/posts/7/comments/');
    // Trimmed, and explicitly parentless — a top-level comment.
    expect(JSON.parse(init.body)).toEqual({ text: 'Lovely photo', parent: null });
  });

  it('posts a reply carrying its parent id', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([comment({ id: 4, text: 'Parent' })]))
      .mockResolvedValue(jsonResponse(comment({ id: 10, parent: 4 }), 201));

    await renderThread();
    await screen.findByText('Parent');

    await fireEvent.press(screen.getByText('Reply'));
    await fireEvent.changeText(
      await screen.findByLabelText('Reply to Alice Anderson…'),
      'Thanks!'
    );
    await fireEvent.press(screen.getByLabelText('Post reply'));

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(1));
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body).toEqual({ text: 'Thanks!', parent: 4 });
  });

  /**
   * Android back closes the reply box, not the post (#168).
   *
   * The box is inline under the comment it answers, so an unclaimed press
   * popped the whole post screen — abandoning the reply and the thread you were
   * reading in one go.
   */
  androidIt('closes the reply box on Android back', async () => {
    captureBackHandler();
    mockFetch.mockResolvedValue(jsonResponse([comment({ id: 4, text: 'Parent' })]));

    await renderThread();
    await screen.findByText('Parent');
    await fireEvent.press(screen.getByText('Reply'));
    await fireEvent.changeText(
      await screen.findByLabelText('Reply to Alice Anderson…'),
      'half a reply'
    );

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    expect(screen.queryByLabelText('Reply to Alice Anderson…')).toBeNull();
    // The comment it hung off is still there — we closed the box, not the post.
    expect(screen.getByText('Parent')).toBeTruthy();
    // Nothing was posted on the way out.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('will not post an empty comment', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));

    await renderThread();
    await screen.findByText('No comments yet. Start the conversation.');

    // Whitespace only — the same rule the server enforces.
    await fireEvent.changeText(screen.getByLabelText('Write a comment…'), '   ');

    expect(screen.getByLabelText('Post comment')).toBeDisabled();
  });

  /**
   * The count on the card, not the tree (#273 — the mobile half of #215).
   *
   * `comment_count` rides the *post* payload, so a mutation that refetches only
   * `['comments', 7]` leaves every card holding that post reading the old total.
   * The composer used to invalidate the feed and the permalink but not the two
   * timeline surfaces, which is why the home feed was right and the group
   * timeline you'd just posted from was wrong.
   */
  it('refreshes the count on every surface holding the post', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse(comment({ id: 9 }), 201));

    const { screens } = await renderThreadOverTimelines();
    await screen.findByText('No comments yet. Start the conversation.');

    await fireEvent.changeText(
      screen.getByLabelText('Write a comment…'),
      'a fourth comment'
    );
    await fireEvent.press(screen.getByLabelText('Post comment'));

    // The profile and group timelines are the two that were missed: the home
    // feed refreshed, which is what made it read as a per-screen glitch.
    // Asserted as one object so a failure's diff names the stale surface.
    await waitFor(() =>
      expect(loadCounts(screens)).toEqual({
        feed: 2,
        userPosts: 2,
        groupPosts: 2,
        permalink: 2,
      })
    );
  });

  it('leaves those surfaces alone when the comment is refused', async () => {
    // Only a success moves the count. Refetching on the attempt would reload
    // every timeline in the stack each time a comment fails to send.
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 400));

    const { screens } = await renderThreadOverTimelines();
    await screen.findByText('No comments yet. Start the conversation.');

    await fireEvent.changeText(screen.getByLabelText('Write a comment…'), 'Hi');
    await fireEvent.press(screen.getByLabelText('Post comment'));

    expect(await screen.findByText('Nope.')).toBeTruthy();
    expect(loadCounts(screens)).toEqual({
      feed: 1,
      userPosts: 1,
      groupPosts: 1,
      permalink: 1,
    });
  });

  it('surfaces the server’s message when a comment is rejected', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValue(jsonResponse({ detail: 'That post is gone.' }, 404));

    await renderThread();
    await screen.findByText('No comments yet. Start the conversation.');

    await fireEvent.changeText(screen.getByLabelText('Write a comment…'), 'Hi');
    await fireEvent.press(screen.getByLabelText('Post comment'));

    expect(await screen.findByText('That post is gone.')).toBeTruthy();
  });
});

/**
 * **When** the badge clears (#307, the mobile half of #230).
 *
 * The server stamps `last_seen_at` as a side effect of the comments GET, so the
 * cache write that mirrors it has to be the resolution of that GET. An effect
 * gated on `data` is not that: `useQuery` hands back a cached tree
 * *synchronously*, so on a reopen the effect fired on the stale tree before the
 * refetch had been anywhere near the server.
 *
 * **The feed is mounted and loaded before the thread arrives, deliberately.** The
 * mirror only reaches what is *in* the cache when the GET lands, so a feed still
 * in flight isn't written to at all — and a test that mounts both at once would
 * pass against the effect version by accident, for that reason rather than the
 * right one.
 */
describe('the “· N new” badge follows the request, not the render', () => {
  /** A loaded feed carrying post 7 with a live badge, and nothing else yet. */
  async function renderFeed() {
    const queryClient = makeClient();
    const feed = jest.fn(async () => postList(2));
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <TimelineScreen queryKey={['feed', false]} queryFn={feed} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(newCount(queryClient)).toBe(2));

    /**
     * Mount the thread over it, as opening a post does.
     *
     * Awaited: `rerender` is a Promise here, and without it the tree the thread
     * paints from the cache isn't on screen yet when the assertion runs.
     */
    const openThread = async (cachedTree: Comment[] | null = null) => {
      if (cachedTree) {
        queryClient.setQueryData(commentsQueryKey({ postId: 7 }), cachedTree);
      }
      await view.rerender(
        <QueryClientProvider client={queryClient}>
          <TimelineScreen queryKey={['feed', false]} queryFn={feed} />
          <CommentThread target={{ postId: 7 }} />
        </QueryClientProvider>
      );
    };
    return { queryClient, openThread };
  }

  function newCount(queryClient: QueryClient) {
    const data = queryClient.getQueryData(['feed', false]) as
      | ReturnType<typeof postList>
      | undefined;
    return data?.pages[0].results[0].new_comment_count;
  }

  it('keeps the badge on a reopen whose refetch fails', async () => {
    // The reopen path: the thread was read once, a new comment has since
    // legitimately re-badged the card, and now there's no signal. The cached
    // tree paints instantly — and that paint is what the old effect fired on.
    const { queryClient, openThread } = await renderFeed();
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Offline.' }, 500));

    await openThread([comment({ id: 1, text: 'Read this one earlier' })]);
    expect(screen.getByText('Read this one earlier')).toBeTruthy();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(commentsQueryKey({ postId: 7 }))?.status
      ).toBe('error')
    );

    // The server still has that comment unseen, so the card must still say so.
    expect(newCount(queryClient)).toBe(2);
  });

  it('keeps the badge when a first open fails', async () => {
    // #230's shape, which mobile never had — with no cached tree the effect had
    // nothing to fire on either. A pin, so the move can't reintroduce it.
    const { queryClient, openThread } = await renderFeed();
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Offline.' }, 500));

    await openThread();
    expect(await screen.findByText('Offline.')).toBeTruthy();

    expect(newCount(queryClient)).toBe(2);
  });

  it('clears the badge once the thread has actually loaded', async () => {
    // What the move must not break.
    const { queryClient, openThread } = await renderFeed();
    mockFetch.mockResolvedValue(jsonResponse([]));

    await openThread();

    await waitFor(() => expect(newCount(queryClient)).toBe(0));
  });

  /**
   * The event twin, which the web has no equivalent of: an event's badge is
   * rendered by the *group* screen off `['groupEvents', …]`, and that screen
   * stays mounted behind the event you pushed, so nothing else clears it. It
   * moved into the same `queryFn`, so it needs the same pin — this is the branch
   * a port from the web would silently drop.
   */
  it('clears an event’s badge from its own request too', async () => {
    const queryClient = makeClient();
    const events = jest.fn(async () => [
      { id: 9, comment_count: 3, new_comment_count: 2 },
    ]);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <TimelineScreen queryKey={['groupEvents', 5, 'upcoming']} queryFn={events} />
      </QueryClientProvider>
    );
    const badge = () =>
      (
        queryClient.getQueryData(['groupEvents', 5, 'upcoming']) as {
          new_comment_count: number;
        }[]
      )[0].new_comment_count;
    await waitFor(() => expect(badge()).toBe(2));
    mockFetch.mockResolvedValue(jsonResponse([]));

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <TimelineScreen queryKey={['groupEvents', 5, 'upcoming']} queryFn={events} />
        <CommentThread target={{ eventId: 9, groupId: 5 }} />
      </QueryClientProvider>
    );

    await waitFor(() => expect(badge()).toBe(0));
  });
});

/**
 * The lines that make the thread a tree.
 *
 * These assert *structure*, not pixels: which pieces of line each comment draws.
 * That's where the fragility is — `indent` and `isLast` are threaded down a
 * recursive component, and getting either wrong (passing a node's own indent to
 * its children, dropping the `isLast` guard) misplaces or duplicates the line at
 * every level while every other test stays green, because nothing else here
 * renders differently.
 *
 * The three pieces, per `CommentThread`'s geometry notes: `branch-N` hooks a
 * comment onto its parent's line, `past-N` carries the parent's line on to the
 * next sibling, `stem-N` runs from a comment's own face down to its replies.
 */
describe('the lines', () => {
  /**
   * A line that is *rendered* but has no height is invisible, and that is not a
   * hypothetical: removing a style entry once left every vertical measuring
   * zero while the elbows carried on drawing, so the thread still looked
   * plausible in a screenshot and every presence-only assertion still passed.
   * Check the geometry, not just the element.
   */
  function expectDrawsALine(testID: string) {
    const style = StyleSheet.flatten(screen.getByTestId(testID).props.style);
    expect(style.width).toBeGreaterThan(0);
    // Anchored top *and* bottom is what gives it height; `top` alone measures 0.
    expect(style.bottom).toBe(0);
    expect(style.top).toBeGreaterThanOrEqual(0);
  }

  it('hooks every comment onto its parent, and stops the run at the last one', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([comment({ id: 1 }), comment({ id: 2 }), comment({ id: 3 })])
    );

    await renderThread();
    await screen.findByText('Comment 1');

    // Every comment reaches out to the line above it — top-level ones included,
    // whose parent line is the post's spine.
    expect(screen.getByTestId('branch-1')).toBeTruthy();
    expect(screen.getByTestId('branch-3')).toBeTruthy();

    // The run carries on past the comments that have a sibling below...
    expectDrawsALine('past-1');
    expectDrawsALine('past-2');
    // ...and stops at the last, so the line ends on a face rather than
    // trailing off into the composer.
    expect(screen.queryByTestId('past-3')).toBeNull();
  });

  it('grows a stem only while a comment’s replies are showing', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({ id: 1, replies: [comment({ id: 2, parent: 1 })] }),
      ])
    );

    await renderThread();
    await screen.findByText('Comment 1');

    // Collapsed: there is nothing below to hold up, so no stem.
    expect(screen.queryByTestId('stem-1')).toBeNull();

    await fireEvent.press(screen.getByText('Show 1 reply'));
    await screen.findByText('Comment 2');

    expectDrawsALine('stem-1');
    // The reply hangs off that stem, and is alone, so the run ends on it.
    expect(screen.getByTestId('branch-2')).toBeTruthy();
    expect(screen.queryByTestId('past-2')).toBeNull();
  });

  it('keeps every elbow reaching the line it hangs from, however deep', async () => {
    // The `indent` / `childIndent` mix-up — handing a node its own indent rather
    // than its parent's — leaves elbows reaching for a line that isn't there.
    //
    // **The chain has to be this deep to catch it.** Above the level where the
    // step shrinks, a node's indent and its children's are the same number, so
    // the two are interchangeable and the bug is invisible. Only past that
    // point do they differ. A shallower version of this test passed against a
    // deliberately broken build.
    const chain = comment({
      id: 1,
      replies: [
        comment({
          id: 2,
          parent: 1,
          replies: [
            comment({
              id: 3,
              parent: 2,
              replies: [
                comment({
                  id: 4,
                  parent: 3,
                  replies: [comment({ id: 5, parent: 4 })],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    mockFetch.mockResolvedValue(jsonResponse([chain]));

    // Deep-linking the leaf opens the whole trail down to it.
    await renderThread({ highlightCommentId: 5 });
    await screen.findByText('Comment 5');

    const styleOf = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style);

    // Each comment's step right is its own `paddingLeft`, and its elbow spans
    // exactly that — from its parent's line to its own.
    for (const id of [1, 2, 3, 4, 5]) {
      expect(styleOf(`branch-${id}`).width).toBe(styleOf(`comment-${id}`).paddingLeft);
    }

    // The step shrinks past the third level. This is the assertion that catches
    // the mix-up: handed its parent's own indent instead of the one meant for
    // it, the deepest comment keeps the wider step and these come out equal.
    expect(styleOf('comment-5').paddingLeft).toBeLessThan(
      styleOf('comment-4').paddingLeft
    );
  });
});

/**
 * Where a deep-linked comment actually *is* on screen.
 *
 * `onLayout` reports an offset within a view's immediate parent, so the number
 * that reaches the screen is only useful if every ancestor has added its own on
 * the way up. Getting this wrong doesn't break anything visibly in a test that
 * only checks the comment rendered — which is exactly how it shipped broken —
 * so these assert the arithmetic directly.
 *
 * Layout events are fired in the order React Native delivers them: children
 * before their parents.
 */
describe('locating a deep-linked comment', () => {
  function layout(testID: string, y: number) {
    return fireEvent(screen.getByTestId(testID), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 300, height: 40 } },
    });
  }

  it('reports a top-level comment’s own offset', async () => {
    mockFetch.mockResolvedValue(jsonResponse([comment({ id: 1 })]));
    const onHighlightLayout = jest.fn();

    await renderThread({ highlightCommentId: 1, onHighlightLayout });
    await screen.findByText('Comment 1');

    await layout('comment-1', 100);

    expect(onHighlightLayout).toHaveBeenCalledWith(100);
  });

  it('sums a nested reply’s offset with every ancestor above it', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({ id: 1, replies: [comment({ id: 3, parent: 1 })] }),
      ])
    );
    const onHighlightLayout = jest.fn();

    await renderThread({ highlightCommentId: 3, onHighlightLayout });
    await screen.findByText('Comment 3');

    // The reply sits 20 into its replies block, which sits 60 into comment 1,
    // which sits 100 into the thread — so the thread should hear 180, not 20.
    await layout('comment-3', 20);
    await layout('replies-1', 60);
    await layout('comment-1', 100);

    expect(onHighlightLayout).toHaveBeenCalledWith(180);
  });

  it('stays silent when nothing is deep-linked', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        comment({ id: 1, replies: [comment({ id: 3, parent: 1 })] }),
      ])
    );
    const onHighlightLayout = jest.fn();

    await renderThread({ onHighlightLayout });
    // No highlight means nothing is auto-expanded, so the reply stays collapsed
    // behind its toggle — only the top-level comment is on screen to lay out.
    await screen.findByText('Comment 1');

    await layout('comment-1', 100);

    expect(onHighlightLayout).not.toHaveBeenCalled();
  });
});
