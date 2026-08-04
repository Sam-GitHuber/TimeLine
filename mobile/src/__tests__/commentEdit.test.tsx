/**
 * Editing and deleting your own comment from the app (issue #128).
 *
 * Comments were create-and-report-only on both clients until now, so everything
 * here is new wiring — and three parts of it are the kind that break quietly:
 *
 *   - the **⋯ menu appears only on your own comment**, and carries Edit above a
 *     destructive Delete. Get the owner check backwards and the app offers
 *     buttons that 403;
 *   - the **"· edited" marker**, the transparency floor that makes editing
 *     something others have read acceptable at all — an edit path that drops it
 *     is worse than no edit path;
 *   - the **tombstone**: a deleted comment with replies stays in the tree as a
 *     blank placeholder, and every affordance on it must go *except* the toggle
 *     that opens the replies it exists to hold up. Hide that one by accident and
 *     the replies are stranded behind a row with no way in.
 *
 * The menu is driven through the shared `./helpers` seam, so this reads the same
 * on both platform projects.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import { CommentThread } from '@/components/CommentThread';
import type { Comment } from '@/types';

import {
  alertSpy,
  menuDestructiveOption,
  menuOptions,
  pickMenuOption,
  pressAlertButton,
  resetMenuSpies,
} from './helpers';

// A fixed viewer (pk 1) over the real AuthProvider — the owner check reads it.
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({ user: { pk: 1, display_name: 'Me Myself' } }),
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

const COMMENT_5 = /\/api\/comments\/5\/$/;

function made(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

function requestBody(match: RegExp, method: string): unknown {
  const call = mockFetch.mock.calls.find(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

/** A comment by the viewer (pk 1) unless `author` says otherwise. */
function comment(overrides: Partial<Comment> & { id: number }): Comment {
  return {
    author: { id: 1, display_name: 'Me Myself', avatar_thumb: null },
    parent: null,
    text: `Comment ${overrides.id}`,
    created_at: '2026-07-30T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    replies: [],
    reactions: [],
    ...overrides,
  };
}

/** Someone else's comment — where Report lives and the ⋯ must not. */
const theirs = (overrides: Partial<Comment> & { id: number }): Comment =>
  comment({
    author: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    text: 'Their reply',
    ...overrides,
  });

// Under RNTL v14 + React 19 the initial commit lands in a microtask, so the
// `render` must be awaited or `screen` is empty on the next synchronous line.
async function renderThread(tree: Comment[]) {
  mockFetch.mockResolvedValue(jsonResponse(tree));
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CommentThread target={{ postId: 7 }} />
      </QueryClientProvider>
    );
  });
  await screen.findByText(tree[0].text || 'Comment deleted');
  return { invalidate };
}

/** Open the ⋯ on comment 5 and choose Edit, leaving the editor on screen. */
async function openEditor(tree: Comment[]) {
  const rendered = await renderThread(tree);
  await fireEvent.press(screen.getByLabelText('Comment options'));
  await act(async () => pickMenuOption('Edit comment'));
  return rendered;
}

beforeEach(() => {
  mockFetch.mockReset();
  resetMenuSpies();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('the ⋯ affordance', () => {
  it('offers Edit above a destructive Delete on your own comment', async () => {
    await renderThread([comment({ id: 5 })]);

    await fireEvent.press(screen.getByLabelText('Comment options'));
    expect(menuOptions()).toEqual(['Edit comment', 'Delete comment']);
    expect(menuDestructiveOption()).toBe('Delete comment');
  });

  it('carries Report instead on someone else’s comment', async () => {
    // One ⋯ for everybody — what's *in* it is what changes. Report used to sit
    // inline beside Reply, which made the same control look like two different
    // kinds of thing depending on whose comment you were looking at.
    await renderThread([theirs({ id: 5 })]);

    await fireEvent.press(screen.getByLabelText('Comment options'));
    expect(menuOptions()).toEqual(['Report comment']);
  });
});

describe('saving an edit', () => {
  it('PATCHes the comment and closes the editor', async () => {
    const { invalidate } = await openEditor([comment({ id: 5 })]);

    const box = screen.getByLabelText('Edit comment text');
    expect(box.props.value).toBe('Comment 5');
    await fireEvent.changeText(box, 'Comment 5, fixed');
    mockFetch.mockResolvedValue(
      jsonResponse(comment({ id: 5, text: 'Comment 5, fixed' }))
    );
    await act(async () => fireEvent.press(screen.getByLabelText('Save comment')));

    await waitFor(() => expect(made(COMMENT_5, 'PATCH')).toBe(true));
    expect(requestBody(COMMENT_5, 'PATCH')).toEqual({ text: 'Comment 5, fixed' });
    // The thread refetches so the new text and its marker appear in place.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['comments', 'post', 7] });
    await waitFor(() =>
      expect(screen.queryByLabelText('Edit comment text')).toBeNull()
    );
  });

  it('says the marker is coming before you save, not only after', async () => {
    await openEditor([comment({ id: 5 })]);
    expect(screen.getByText('Edited comments are marked “edited”.')).toBeTruthy();
  });

  it('treats an unchanged save as a plain close — no request', async () => {
    await openEditor([comment({ id: 5 })]);

    await act(async () => fireEvent.press(screen.getByLabelText('Save comment')));

    expect(made(COMMENT_5, 'PATCH')).toBe(false);
    await waitFor(() =>
      expect(screen.queryByLabelText('Edit comment text')).toBeNull()
    );
  });

  it('cancelling sends nothing and leaves the text alone', async () => {
    await openEditor([comment({ id: 5 })]);

    await fireEvent.changeText(
      screen.getByLabelText('Edit comment text'),
      'abandoned'
    );
    await act(async () => fireEvent.press(screen.getByText('Cancel')));

    expect(made(COMMENT_5, 'PATCH')).toBe(false);
    expect(screen.getByText('Comment 5')).toBeTruthy();
  });

  it('closes the reply box, so hardware back has one thing to close', async () => {
    // `useAndroidBack` registers per dismissible state and RN runs the newest
    // handler first, so a reply box *and* an editor open on the same node makes
    // "what does back close?" a matter of which you opened last.
    await renderThread([comment({ id: 5 })]);

    await act(async () => fireEvent.press(screen.getByText('Reply')));
    expect(screen.getByLabelText('Reply to Me Myself…')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Comment options'));
    await act(async () => pickMenuOption('Edit comment'));

    expect(screen.queryByLabelText('Reply to Me Myself…')).toBeNull();
    expect(screen.getByLabelText('Edit comment text')).toBeTruthy();
  });

  it('won’t save an emptied comment — that’s a delete', async () => {
    await openEditor([comment({ id: 5 })]);

    await fireEvent.changeText(screen.getByLabelText('Edit comment text'), '   ');
    await act(async () => fireEvent.press(screen.getByLabelText('Save comment')));

    expect(made(COMMENT_5, 'PATCH')).toBe(false);
  });
});

describe('the edited marker', () => {
  it('is absent on a comment that was never edited', async () => {
    await renderThread([comment({ id: 5 })]);
    expect(screen.queryByText('· edited')).toBeNull();
  });

  it('shows on one that was', async () => {
    await renderThread([
      comment({ id: 5, edited_at: '2026-07-30T11:00:00Z' }),
    ]);
    expect(screen.getByText('· edited')).toBeTruthy();
  });
});

describe('deleting', () => {
  it('confirms first, then DELETEs', async () => {
    const { invalidate } = await renderThread([comment({ id: 5 })]);

    await fireEvent.press(screen.getByLabelText('Comment options'));
    await act(async () => pickMenuOption('Delete comment'));
    expect(made(COMMENT_5, 'DELETE')).toBe(false);

    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    await act(async () => pressAlertButton('Delete comment?', 'Delete'));

    await waitFor(() => expect(made(COMMENT_5, 'DELETE')).toBe(true));
    // The comment count moved, so the lists carrying it are refetched too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['comments', 'post', 7] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['feed'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['post', '7'] });
  });

  it('cancelling the confirmation deletes nothing', async () => {
    await renderThread([comment({ id: 5 })]);

    await fireEvent.press(screen.getByLabelText('Comment options'));
    await act(async () => pickMenuOption('Delete comment'));
    // Cancel carries no onPress, so nothing runs.
    await act(async () => pressAlertButton('Delete comment?', 'Cancel'));

    expect(made(COMMENT_5, 'DELETE')).toBe(false);
  });

  it('warns that replies will survive when there are any', async () => {
    await renderThread([comment({ id: 5, replies: [theirs({ id: 6, parent: 5 })] })]);

    await fireEvent.press(screen.getByLabelText('Comment options'));
    await act(async () => pickMenuOption('Delete comment'));

    const call = alertSpy.mock.calls.findLast(([t]) => t === 'Delete comment?');
    expect(String(call?.[1])).toMatch(/replies underneath will stay/);
  });
});

describe('a deleted comment (the tombstone)', () => {
  const tombstone = () =>
    comment({
      id: 5,
      text: '',
      deleted_at: '2026-07-30T12:00:00Z',
      replies: [theirs({ id: 6, parent: 5 })],
    });

  it('renders a placeholder instead of the text', async () => {
    await renderThread([tombstone()]);
    expect(screen.getByText('Comment deleted')).toBeTruthy();
  });

  it('offers nothing — not even to the author who deleted it', async () => {
    await renderThread([tombstone()]);

    expect(screen.queryByLabelText('Comment options')).toBeNull();
    expect(screen.queryByLabelText('Report comment')).toBeNull();
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('keeps the way into the replies it exists to hold up', async () => {
    await renderThread([tombstone()]);

    await act(async () => fireEvent.press(screen.getByText('Show 1 reply')));
    expect(screen.getByText('Their reply')).toBeTruthy();
  });

  it('carries no edited marker even if it was edited before deletion', async () => {
    await renderThread([
      comment({
        id: 5,
        text: '',
        edited_at: '2026-07-30T11:00:00Z',
        deleted_at: '2026-07-30T12:00:00Z',
        replies: [theirs({ id: 6, parent: 5 })],
      }),
    ]);
    expect(screen.queryByText('· edited')).toBeNull();
  });
});
