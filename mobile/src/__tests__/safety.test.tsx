/**
 * Safety controls (Phase 9 E4a) — the App-Review-critical report + block, plus
 * delete-your-own-post.
 *
 * What's pinned here is the *wiring*, since each control is a single POST/DELETE
 * behind a confirmation:
 *   - the post ⋯ menu reports someone else's post and deletes your own (with a
 *     confirm in between, and an owner-gated menu);
 *   - a comment's inline Report flags it, and is hidden on your own comment;
 *   - Block confirms through the shared warning modal then POSTs; Unblock fires
 *     immediately with no warning.
 *
 * The action sheet and confirm alert are captured, not driven natively (the same
 * approach as `groupMembers.test.tsx`): `ActionSheetIOS.showActionSheetWithOptions`
 * hands us the callback; `Alert.alert` hands us the button list.
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
import type { ReactElement } from 'react';
import { ActionSheetIOS, Alert } from 'react-native';

import { BlockButton } from '@/components/BlockButton';
import { CommentThread } from '@/components/CommentThread';
import { PostMenu } from '@/components/PostMenu';
import type { Comment } from '@/types';

// A fixed viewer (pk 1) over the real AuthProvider — the owner checks read it.
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

const showActionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions');
const alertSpy = jest.spyOn(Alert, 'alert');

/** Invoke the last action sheet's callback with the chosen option index. */
function pickAction(index: number) {
  const callback = showActionSheet.mock.calls.at(-1)?.[1] as (i: number) => void;
  callback(index);
}

/** Press a button (by text) on the last `Alert.alert` with the given title. */
function pressAlertButton(title: string, buttonText: string) {
  const call = alertSpy.mock.calls.find(([t]) => t === title);
  const buttons = call?.[2] as { text?: string; onPress?: () => void }[] | undefined;
  buttons?.find((b) => b.text === buttonText)?.onPress?.();
}

function lastActionSheetOptions(): string[] {
  return (showActionSheet.mock.calls.at(-1)?.[0] as { options: string[] }).options;
}

/** Find a request matching url + method, and parse its JSON body. */
function requestBody(match: RegExp, method: string): unknown {
  const call = mockFetch.mock.calls.find(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

function made(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

// Under RNTL v14 + React 19 the initial commit lands in a microtask, so the
// `render` must be awaited or `screen` is empty on the next synchronous line.
async function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => {
    render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  return { invalidate };
}

beforeEach(() => {
  mockFetch.mockReset();
  showActionSheet.mockReset().mockImplementation(() => {});
  alertSpy.mockReset().mockImplementation(() => {});
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('PostMenu', () => {
  it('reports someone else’s post through the modal', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 99 }, 201));
    await renderWithClient(<PostMenu postId={5} authorId={2} />);

    await fireEvent.press(screen.getByLabelText('Post options'));
    // Not the owner → the menu offers Report, not Delete.
    expect(lastActionSheetOptions()).toEqual(['Report post', 'Cancel']);

    await act(async () => pickAction(0));
    await fireEvent.changeText(
      screen.getByLabelText('Reason for reporting this post'),
      'spam'
    );
    await fireEvent.press(screen.getByText('Send report'));

    await waitFor(() => expect(made(/\/api\/reports\/$/, 'POST')).toBe(true));
    expect(requestBody(/\/api\/reports\/$/, 'POST')).toEqual({
      post: 5,
      reason: 'spam',
    });
  });

  it('deletes your own post after a confirm, and invalidates the feeds', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    const { invalidate } = await renderWithClient(<PostMenu postId={5} authorId={1} />);

    await fireEvent.press(screen.getByLabelText('Post options'));
    // The owner → Delete, marked destructive.
    expect(lastActionSheetOptions()).toEqual(['Delete post', 'Cancel']);
    const opts = showActionSheet.mock.calls.at(-1)?.[0] as {
      destructiveButtonIndex?: number;
    };
    expect(opts.destructiveButtonIndex).toBe(0);

    await act(async () => pickAction(0));
    // Nothing fires until the confirm is actually pressed.
    expect(made(/\/api\/posts\/5\/$/, 'DELETE')).toBe(false);

    await act(async () => pressAlertButton('Delete post?', 'Delete'));

    await waitFor(() => expect(made(/\/api\/posts\/5\/$/, 'DELETE')).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['feed'] });
  });

  it('cancelling the delete confirm is a no-op', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    await renderWithClient(<PostMenu postId={5} authorId={1} />);

    await fireEvent.press(screen.getByLabelText('Post options'));
    await act(async () => pickAction(0));
    // The alert's Cancel has no onPress, so nothing runs.
    await act(async () => pressAlertButton('Delete post?', 'Cancel'));

    expect(made(/\/api\/posts\/5\/$/, 'DELETE')).toBe(false);
  });
});

describe('comment Report', () => {
  function comment(overrides: Partial<Comment> & { id: number }): Comment {
    return {
      author: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
      parent: null,
      text: `Comment ${overrides.id}`,
      created_at: '2026-07-23T10:00:00Z',
      replies: [],
      reactions: [],
      ...overrides,
    };
  }

  function serveComments(tree: Comment[]) {
    mockFetch.mockImplementation(async (url: string) => {
      if (/\/comments\/$/.test(url)) return jsonResponse(tree);
      if (/\/api\/reports\/$/.test(url)) return jsonResponse({ id: 1 }, 201);
      return jsonResponse(null, 204);
    });
  }

  it('flags someone else’s comment', async () => {
    serveComments([comment({ id: 8 })]);
    await renderWithClient(<CommentThread postId={7} />);

    await screen.findByText('Comment 8');
    await fireEvent.press(screen.getByLabelText('Report comment'));
    await fireEvent.press(screen.getByText('Send report'));

    await waitFor(() => expect(made(/\/api\/reports\/$/, 'POST')).toBe(true));
    expect(requestBody(/\/api\/reports\/$/, 'POST')).toEqual({
      comment: 8,
      reason: '',
    });
  });

  it('offers no Report on your own comment', async () => {
    // Authored by the viewer (pk 1) → self-report is pointless, control hidden.
    serveComments([comment({ id: 9, author: { id: 1, display_name: 'Me Myself', avatar_thumb: null } })]);
    await renderWithClient(<CommentThread postId={7} />);

    await screen.findByText('Comment 9');
    expect(screen.queryByLabelText('Report comment')).toBeNull();
  });
});

describe('BlockButton', () => {
  function serve() {
    mockFetch.mockImplementation(async (url: string) => {
      if (/disconnect-impact\/$/.test(url)) return jsonResponse({ chats: [] });
      return jsonResponse(null, 204);
    });
  }

  it('blocks through the warning modal, then invalidates', async () => {
    serve();
    const { invalidate } = await renderWithClient(
      <BlockButton userId={2} displayName="Ada Lovelace" isBlocked={false} />
    );

    await fireEvent.press(screen.getByLabelText('Block'));
    // The modal fetches shared-chat impact; its Confirm ("Block") enables once
    // that resolves. Two "Block" texts then exist — the trigger and the confirm.
    const confirms = await screen.findAllByText('Block');
    await fireEvent.press(confirms.at(-1)!);

    await waitFor(() => expect(made(/\/api\/users\/2\/block\/$/, 'POST')).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 2] });
  });

  it('unblocks immediately with no warning', async () => {
    serve();
    await renderWithClient(
      <BlockButton userId={2} displayName="Ada Lovelace" isBlocked />
    );

    await fireEvent.press(screen.getByLabelText('Unblock'));

    await waitFor(() =>
      expect(made(/\/api\/users\/2\/block\/$/, 'DELETE')).toBe(true)
    );
    // No confirmation modal on the unblock path.
    expect(screen.queryByText(/will remove you from these chats/)).toBeNull();
  });
});
