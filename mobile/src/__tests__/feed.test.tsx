/**
 * Tests for the feed screen and its day-grouping.
 *
 * The ordering assertion is the important one: reverse-chronological is the
 * product's single non-negotiable principle, so a test pins that the screen
 * renders exactly what the server sent, in that order.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';

import FeedScreen from '@/app/index';
import { toRows } from '@/feed';
import { AuthProvider } from '@/auth';
import type { Post } from '@/types';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function makePost(overrides: Partial<Post> & { id: number }): Post {
  return {
    author: { id: 1, display_name: 'Alice Anderson', avatar_thumb: null },
    text: `Post ${overrides.id}`,
    images: [],
    group: null,
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-18T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

function feedPage(results: Post[], next: string | null = null) {
  return { count: results.length, next, previous: null, results };
}

function renderFeed() {
  // A fresh QueryClient per test, or one test's cache answers the next one's
  // query and the fetch mock never fires.
  //
  // `retry: false` so an error test fails fast instead of waiting out backoff.
  // `gcTime: 0` because the default five-minute garbage-collection timer keeps
  // Node's event loop alive long after the assertions finish — the tests pass,
  // then Jest sits there refusing to exit and the CI job hangs.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <FeedScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('day grouping', () => {
  it('emits one divider per calendar day, before that day’s posts', () => {
    const rows = toRows([
      makePost({ id: 1, created_at: '2026-07-18T15:00:00Z' }),
      makePost({ id: 2, created_at: '2026-07-18T09:00:00Z' }),
      makePost({ id: 3, created_at: '2026-07-17T09:00:00Z' }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual([
      'day',
      'post',
      'post',
      'day',
      'post',
    ]);
  });

  it('preserves the server’s order exactly', () => {
    // Reverse-chronological is enforced server-side and must never be re-sorted
    // here. Feed the rows in deliberately, and check they come out untouched.
    const rows = toRows([
      makePost({ id: 10, created_at: '2026-07-18T15:00:00Z' }),
      makePost({ id: 11, created_at: '2026-07-18T09:00:00Z' }),
      makePost({ id: 12, created_at: '2026-07-18T12:00:00Z' }),
    ]);

    const ids = rows
      .filter((r): r is Extract<typeof r, { kind: 'post' }> => r.kind === 'post')
      .map((r) => r.post.id);
    expect(ids).toEqual([10, 11, 12]);
  });

  it('returns nothing for an empty feed', () => {
    expect(toRows([])).toEqual([]);
  });
});

describe('feed screen', () => {
  it('renders the posts the API returns', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({ id: 1, text: 'Anyone up for a walk this weekend?' }),
          makePost({ id: 2, text: 'Second post' }),
        ])
      )
    );

    await renderFeed();

    expect(
      await screen.findByText('Anyone up for a walk this weekend?')
    ).toBeTruthy();
    expect(screen.getByText('Second post')).toBeTruthy();
  });

  it('shows the empty state when there are no posts', async () => {
    mockFetch.mockResolvedValue(jsonResponse(feedPage([])));

    await renderFeed();

    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
  });

  it('shows a retryable error state when the feed fails', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: 'Something broke.' }, 500)
    );

    await renderFeed();

    expect(await screen.findByText('Couldn’t load your feed')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('marks an edited post', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({ id: 1, text: 'Fixed a typo', edited_at: '2026-07-18T11:00:00Z' }),
        ])
      )
    );

    await renderFeed();

    // The marker is the transparency floor — see feed-and-posts.md.
    expect(await screen.findByText('· edited')).toBeTruthy();
  });

  it('shows reaction counts and the new-comment badge', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        feedPage([
          makePost({
            id: 1,
            reactions: [{ emoji: '👍', count: 3, reacted: true }],
            comment_count: 12,
            new_comment_count: 3,
          }),
        ])
      )
    );

    await renderFeed();

    expect(await screen.findByText('3')).toBeTruthy();
    expect(screen.getByText(/12 comments/)).toBeTruthy();
    expect(screen.getByText(/3 new/)).toBeTruthy();
  });
});
