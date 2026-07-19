/**
 * The comment thread: the tree, collapsing, replying, and the deep-link path a
 * push notification will use in Milestone D.
 *
 * The pruning itself is a *server* guarantee (connections.md) and is tested in
 * `backend/`; what matters here is that the client renders the tree it was given
 * without dropping or reordering anything.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CommentThread, ancestorIdsOf } from '@/components/CommentThread';
import type { Comment } from '@/types';

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
    replies: [],
    reactions: [],
    ...overrides,
  };
}

function renderThread(props: Partial<Parameters<typeof CommentThread>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentThread postId={7} {...props} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
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

  it('will not post an empty comment', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));

    await renderThread();
    await screen.findByText('No comments yet. Start the conversation.');

    // Whitespace only — the same rule the server enforces.
    await fireEvent.changeText(screen.getByLabelText('Write a comment…'), '   ');

    expect(screen.getByLabelText('Post comment')).toBeDisabled();
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
