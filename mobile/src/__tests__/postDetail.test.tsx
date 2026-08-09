/**
 * The permalink screen — the target of every post/comment push notification in
 * Milestone D, so it has to stand up on its own from a cold start.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { ScrollView } from 'react-native';

import PostScreen from '@/app/post/[postId]';
import type { Post } from '@/types';

import { holdRequest, pickMenuOption, resetMenuSpies } from './helpers';

const params: { postId: string; comment?: string } = { postId: '7' };

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  // The screen holds iOS's swipe-back while a comment write is out (#256);
  // there's no navigator under test and no gesture Node can perform.
  useNavigation: () => ({ setOptions: () => {} }),
  useLocalSearchParams: () => params,
  router: {
    push: jest.fn(),
    back: (...args: unknown[]) => mockBack(...args),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

// The post card's ⋯ menu and each comment's Report affordance read the current
// user (owner checks). A fixed stub avoids wrapping this screen in an
// AuthProvider; pk 99 is nobody in these fixtures, so both surfaces just offer
// "Report", which this file (deep-link scrolling) doesn't exercise.
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

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 7,
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: 'A day on the hills',
    images: [],
    group: null,
    reactions: [],
    comment_count: 2,
    new_comment_count: 2,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

/** Answer by URL: the screen fires the post and its comments concurrently. */
function serve({
  post,
  comments = [],
  commentsStatus = 200,
}: {
  post: unknown;
  comments?: unknown[];
  commentsStatus?: number;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/comments/')) {
      return commentsStatus === 200
        ? jsonResponse(comments)
        : jsonResponse({ detail: 'Service unavailable.' }, commentsStatus);
    }
    return post;
  });
}

// `render` is async in RNTL v14 and must be awaited — spreading the promise
// silently yields nothing, and every query then fails with the baffling
// "`render` function has not been called".
async function renderScreen(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
) {
  const view = await render(
    <QueryClientProvider client={client}>
      <PostScreen />
    </QueryClientProvider>
  );
  return { client, ...view };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockBack.mockReset();
  resetMenuSpies();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  params.comment = undefined;
});

it('renders the post and its thread', async () => {
  serve({
    post: jsonResponse(makePost()),
    comments: [
      {
        id: 1,
        author: { id: 2, display_name: 'Bo Bell', avatar_thumb: null },
        parent: null,
        text: 'Looks freezing',
        created_at: '2026-07-18T11:00:00Z',
        replies: [],
        reactions: [],
      },
    ],
  });

  await renderScreen();

  expect(await screen.findByText('A day on the hills')).toBeTruthy();
  expect(await screen.findByText('Looks freezing')).toBeTruthy();
});

it('says the post is unavailable on a 404, without claiming it exists', async () => {
  // A post you can't see 404s rather than 403s, so the app can't be used to
  // probe for the existence of other people's posts.
  serve({ post: jsonResponse({ detail: 'Not found.' }, 404) });

  await renderScreen();

  expect(await screen.findByText('Post not available')).toBeTruthy();
});

it('clears the post’s "new comments" badge on open', async () => {
  // Opening the thread is the "seen" event server-side, so the cached counts
  // have to mirror that rather than be refetched to be told what we know.
  //
  // Asserted on the permalink entry rather than a seeded ['feed'] one: with
  // `gcTime: 0` a hand-seeded cache entry that nothing is observing is
  // collected immediately, so it would read as undefined here. This screen's
  // own query observes ['post', '7'], so it survives — and the fan-out across
  // feed pages is covered directly in postCache.test.ts.
  serve({ post: jsonResponse(makePost({ new_comment_count: 2 })) });

  const { client } = await renderScreen();

  await waitFor(() => {
    const cached = client.getQueryData(['post', '7']) as Post | undefined;
    expect(cached?.new_comment_count).toBe(0);
  });
});

it('leaves the badge alone when the comments never loaded', async () => {
  // The server stamps "seen" as a side effect of the comments GET. If that GET
  // failed, nothing was stamped — so clearing the badge locally would hide two
  // comments the user has still never been shown, until something else happened
  // to refetch the feed.
  serve({
    post: jsonResponse(makePost({ new_comment_count: 2 })),
    commentsStatus: 503,
  });

  const { client } = await renderScreen();
  await screen.findByText('Service unavailable.');

  const cached = client.getQueryData(['post', '7']) as Post | undefined;
  expect(cached?.new_comment_count).toBe(2);
});

/**
 * A failed *refresh* of the post must not take the screen off the screen (#307).
 *
 * `query-core`'s error action keeps the data it has and flips `status` to
 * 'error', and this screen's refetch is routine: posting a comment invalidates
 * `['post', id]` through `invalidateComments`, and so does every foreground. With
 * the error branch ahead of the post, a comment that went through on a patchy
 * connection was followed a second later by the card, the thread and a half-typed
 * reply being replaced by an error panel — undoing, from one level up, exactly
 * what `CommentThread` was taught to survive.
 */
describe('a refresh that fails', () => {
  /** The post request fails from here on; comments keep working. */
  function breakThePost(status: number, detail: string) {
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/comments/')
        ? jsonResponse([])
        : jsonResponse({ detail }, status)
    );
  }

  it('keeps the post and its thread', async () => {
    serve({ post: jsonResponse(makePost()) });
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakThePost(503, 'Service unavailable.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['post', '7'] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['post', '7'])?.status).toBe('error')
    );
    expect(screen.getByText('A day on the hills')).toBeTruthy();
    // The thread and the box you were typing in, which is the costly half.
    expect(screen.getByLabelText('Write a comment…')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load this post')).toBeNull();
  });

  it('still says the post has gone on a 404, even holding a copy of it', async () => {
    // The one error that outranks the cached copy: a 404 is an answer about
    // *now* — deleted, or put out of reach — not a failure to ask.
    serve({ post: jsonResponse(makePost()) });
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakThePost(404, 'Not found.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['post', '7'] });
    });

    expect(await screen.findByText('Post not available')).toBeTruthy();
    expect(screen.queryByText('A day on the hills')).toBeNull();
  });
});

it('opens a deep-linked reply even when it is nested inside collapsed parents', async () => {
  params.comment = '3';
  serve({
    post: jsonResponse(makePost()),
    comments: [
      {
        id: 1,
        author: { id: 2, display_name: 'Bo Bell', avatar_thumb: null },
        parent: null,
        text: 'Top level',
        created_at: '2026-07-18T11:00:00Z',
        reactions: [],
        replies: [
          {
            id: 3,
            author: { id: 3, display_name: 'Cy Cole', avatar_thumb: null },
            parent: 1,
            text: 'The reply you were told about',
            created_at: '2026-07-18T12:00:00Z',
            replies: [],
            reactions: [],
          },
        ],
      },
    ],
  });

  await renderScreen();

  expect(await screen.findByText('The reply you were told about')).toBeTruthy();
});

/**
 * Aiming the deep-link scroll.
 *
 * The thread reports the target's offset from its own top, which is only
 * useful once the screen knows where the thread starts — and React Native lays
 * the thread's children out first, so that offset almost always arrives before
 * the thread's own. The first cut marked the scroll "done" on that early call
 * and landed short by the entire height of the post, with no second chance.
 */
describe('scrolling to a deep-linked comment', () => {
  const nested = [
    {
      id: 1,
      author: { id: 2, display_name: 'Bo Bell', avatar_thumb: null },
      parent: null,
      text: 'Top level',
      created_at: '2026-07-18T11:00:00Z',
      reactions: [],
      replies: [
        {
          id: 3,
          author: { id: 3, display_name: 'Cy Cole', avatar_thumb: null },
          parent: 1,
          text: 'The reply you were told about',
          created_at: '2026-07-18T12:00:00Z',
          replies: [],
          reactions: [],
        },
      ],
    },
  ];

  function layout(testID: string, y: number) {
    return fireEvent(screen.getByTestId(testID), 'layout', {
      nativeEvent: { layout: { x: 0, y, width: 300, height: 40 } },
    });
  }

  let scrollTo: jest.SpyInstance;

  beforeEach(() => {
    scrollTo = jest
      .spyOn(
        (ScrollView as unknown as { prototype: { scrollTo: () => void } }).prototype,
        'scrollTo'
      )
      .mockImplementation(() => {});
  });

  afterEach(() => scrollTo.mockRestore());

  it('waits for the thread’s position instead of aiming at zero', async () => {
    params.comment = '3';
    serve({ post: jsonResponse(makePost()), comments: nested });

    await renderScreen();
    await screen.findByText('The reply you were told about');

    // Children first, exactly as React Native delivers them: the reply's offset
    // arrives while the screen still has no idea where the thread begins.
    await layout('comment-3', 20);
    await layout('replies-1', 60);
    await layout('comment-1', 100);

    // Nothing yet — aiming now would put it at the top of the page.
    expect(scrollTo).not.toHaveBeenCalled();

    // The thread lands 500 down the page, below the post.
    await layout('thread', 500);

    // 500 (thread) + 180 (the reply within it) − 80 (headroom).
    expect(scrollTo).toHaveBeenCalledWith({ y: 600, animated: true });
  });

  it('does not yank you back when the thread re-renders later', async () => {
    params.comment = '3';
    serve({ post: jsonResponse(makePost()), comments: nested });

    await renderScreen();
    await screen.findByText('The reply you were told about');

    await layout('comment-3', 20);
    await layout('replies-1', 60);
    await layout('comment-1', 100);
    await layout('thread', 500);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // A reply posted or a reaction toggled re-lays the thread out. Someone
    // reading further down must not be dragged back to the notification target.
    await layout('comment-3', 20);
    await layout('replies-1', 60);
    await layout('comment-1', 100);

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('re-aims when a second notification names a different comment (#177)', async () => {
    // A tapped push reuses this screen now rather than stacking a second copy of
    // it, so the *only* thing a second notification for the same post changes is
    // the `comment` param — nothing remounts. The scroll guard and each branch's
    // collapsed state both used to be seeded once per mount, which left the new
    // target highlighted inside a still-collapsed branch, off-screen, with the
    // notification looking answered.
    const twoBranches = [
      ...nested,
      {
        id: 2,
        author: { id: 4, display_name: 'Di Dench', avatar_thumb: null },
        parent: null,
        text: 'Another top level',
        created_at: '2026-07-18T13:00:00Z',
        reactions: [],
        replies: [
          {
            id: 4,
            author: { id: 5, display_name: 'Ez Ellis', avatar_thumb: null },
            parent: 2,
            text: 'The reply the second push is about',
            created_at: '2026-07-18T14:00:00Z',
            replies: [],
            reactions: [],
          },
        ],
      },
    ];
    params.comment = '3';
    serve({ post: jsonResponse(makePost()), comments: twoBranches });

    const view = await renderScreen();
    await screen.findByText('The reply you were told about');

    // Comment 2's branch is collapsed: it holds no ancestor of the first target.
    expect(screen.queryByText('The reply the second push is about')).toBeNull();

    await layout('comment-3', 20);
    await layout('replies-1', 60);
    await layout('comment-1', 100);
    await layout('thread', 500);
    expect(scrollTo).toHaveBeenCalledWith({ y: 600, animated: true });

    // The second push arrives and is tapped: same screen, new target.
    params.comment = '4';
    await view.rerender(
      <QueryClientProvider client={view.client}>
        <PostScreen />
      </QueryClientProvider>
    );

    // Its branch opens, so there is something to highlight and aim at.
    expect(
      await screen.findByText('The reply the second push is about')
    ).toBeTruthy();

    await layout('comment-4', 30);
    await layout('replies-2', 70);
    await layout('comment-2', 200);

    // 500 (thread, still known) + 300 (the new reply within it) − 80 (headroom).
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 720, animated: true });
  });

  it('never scrolls when nothing was deep-linked', async () => {
    serve({ post: jsonResponse(makePost()), comments: nested });

    await renderScreen();
    await screen.findByText('Top level');

    await layout('comment-1', 100);
    await layout('thread', 500);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});

/**
 * Viewing is seeing — and the mirror of it rides the GET (#318).
 *
 * The fetch marks this post's notifications seen server-side, so the screen
 * mirrors that locally: it drops the count the icon badge watches, and takes
 * the delivered pushes back out of the tray. Both hang off the resolution of
 * the request, not off a render — see the note on the `queryFn`.
 */
describe('seen-on-view', () => {
  /** What's sitting in the notification tray. */
  function tray(...entries: { identifier: string; url: string | null }[]) {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue(
      entries.map(({ identifier, url }) => ({
        request: { identifier, content: { data: { url } } },
      }))
    );
  }

  /** The identifiers taken out of the tray, in any order. */
  const dismissed = () =>
    (Notifications.dismissNotificationAsync as jest.Mock).mock.calls
      .map(([identifier]) => identifier)
      .sort();

  beforeEach(() => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValue([]);
    (Notifications.dismissNotificationAsync as jest.Mock).mockClear();
  });

  it('refreshes the unread count and clears the tray once the post lands', async () => {
    // Otherwise the badge holds its stale number until the bell's next poll or
    // the next foreground, and the push stays on the lock screen for a post
    // that's open in front of you.
    serve({ post: jsonResponse(makePost()) });
    tray(
      { identifier: 'mine', url: '/p/7?comment=3' },
      { identifier: 'someone-else', url: '/p/8' }
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
    });
    // A spy rather than reading query state back: with `gcTime: 0` and no
    // observer mounted here, the count query would be collected the moment it's
    // touched, leaving nothing to inspect.
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    await renderScreen(client);
    await screen.findByText('A day on the hills');

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notificationsUnread'] })
    );
    await waitFor(() => expect(dismissed()).toEqual(['mine']));
  });

  it('keeps the notification when a warm-cache reopen turns out to be a 404', async () => {
    // #318. `useQuery` hands back a cached post *synchronously*, so while the
    // mirror lived in an effect gated on `!!post` it fired on the first commit
    // — before the mount refetch had been anywhere near the server. Read a
    // post, back out, get a reply push, tap it within `gcTime`, and if the
    // refetch 404s (deleted, or the author has since disconnected) the screen
    // says the post is gone *and* the notification that would have brought you
    // back has already been dismissed. A guard can't close it: `notFound` is
    // false on that commit, because a cached entry carries no error yet.
    serve({ post: jsonResponse({ detail: 'Not found.' }, 404) });
    tray({ identifier: 'mine', url: '/p/7' });
    // `gcTime: Infinity`, unlike the tests above: a seeded entry with nothing
    // observing it is collected before the render on the default here — and a
    // warm cache is the whole scenario.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: 0 } },
    });
    client.setQueryData(['post', '7'], makePost());
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    await renderScreen(client);

    expect(await screen.findByText('Post not available')).toBeTruthy();
    expect(dismissed()).toEqual([]);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['notificationsUnread'] });
  });
});

/**
 * Leaving the post is held while a comment write is out (#256).
 *
 * `CommentNode` holds the routes it owns — Cancel, Android's back, the Reply
 * toggle — but "← Feed" and iOS's swipe belong to this screen, and both unmount
 * the write box that is the only renderer of a refused edit. The node declares
 * the write and this screen reads it, which is the whole point of the hold
 * forwarding upward.
 */
it('refuses “← Feed” while a comment edit is saving, then shows the refusal', async () => {
  serve({
    post: jsonResponse(makePost()),
    comments: [
      {
        id: 1,
        // The viewer (pk 99 — see the auth stub above), so the ⋯ offers Edit.
        author: { id: 99, display_name: 'Test Viewer', avatar_thumb: null },
        parent: null,
        text: 'Mine',
        created_at: '2026-07-18T11:00:00Z',
        replies: [],
        reactions: [],
      },
    ],
  });

  await renderScreen();
  await screen.findByText('Mine');
  await fireEvent.press(screen.getByLabelText('Comment options'));
  await act(async () => pickMenuOption('Edit comment'));
  await fireEvent.changeText(
    screen.getByLabelText('Edit comment text'),
    'Mine, fixed'
  );

  const server = holdRequest(
    mockFetch,
    { detail: 'Editing is only allowed for 15 minutes.' },
    403
  );
  await act(async () => fireEvent.press(screen.getByLabelText('Save comment')));
  await server.inFlight('Saving…');

  await fireEvent.press(screen.getByLabelText('Back to feed'));
  expect(mockBack).not.toHaveBeenCalled();

  await server.refuse();
  expect(
    await screen.findByText('Editing is only allowed for 15 minutes.')
  ).toBeTruthy();
});
