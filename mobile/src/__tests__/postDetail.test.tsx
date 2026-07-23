/**
 * The permalink screen — the target of every post/comment push notification in
 * Milestone D, so it has to stand up on its own from a cold start.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import PostScreen from '@/app/post/[postId]';
import type { Post } from '@/types';

const params: { postId: string; comment?: string } = { postId: '7' };

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => params,
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
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

  it('never scrolls when nothing was deep-linked', async () => {
    serve({ post: jsonResponse(makePost()), comments: nested });

    await renderScreen();
    await screen.findByText('Top level');

    await layout('comment-1', 100);
    await layout('thread', 500);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
