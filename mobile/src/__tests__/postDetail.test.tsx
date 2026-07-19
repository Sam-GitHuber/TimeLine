/**
 * The permalink screen — the target of every post/comment push notification in
 * Milestone D, so it has to stand up on its own from a cold start.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';

import PostScreen from '@/app/post/[postId]';
import type { Post } from '@/types';

const params: { postId: string; comment?: string } = { postId: '7' };

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => params,
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
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
function serve({ post, comments = [] }: { post: unknown; comments?: unknown[] }) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/comments/')) return jsonResponse(comments);
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
