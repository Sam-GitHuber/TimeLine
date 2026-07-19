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
import { StyleSheet } from 'react-native';

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
