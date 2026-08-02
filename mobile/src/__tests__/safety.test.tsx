/**
 * Safety controls (Phase 9 E4a) — the App-Review-critical report + block, plus
 * delete-your-own-post.
 *
 * What's pinned here is the *wiring*, since each control is a single POST/DELETE
 * behind a confirmation:
 *   - the post ⋯ menu reports someone else's post and deletes your own (with a
 *     confirm in between, and an owner-gated menu);
 *   - a comment's ⋯ menu offers Report on someone else's, and Edit/Delete on
 *     your own instead;
 *   - a *message* report (Phase 9b M0) posts `{ message: id }` and discloses that
 *     a copy of the message goes with it — the only route by which message text
 *     ever reaches the maintainer;
 *   - Block confirms through the shared warning modal then POSTs; Unblock fires
 *     immediately with no warning.
 *
 * The menu and confirm alert are captured, not driven natively (the same
 * approach as `groupMembers.test.tsx`), through the shared `./helpers` seam —
 * which also absorbs the fact that the menu is an `ActionSheetIOS` on iOS and an
 * `Alert` chooser on Android, so these tests read the same on both platforms.
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
import { Alert } from 'react-native';

import { BlockButton } from '@/components/BlockButton';
import { CommentThread } from '@/components/CommentThread';
import { PostMenu } from '@/components/PostMenu';
import { ReportModal } from '@/components/ReportModal';
import type { Comment } from '@/types';

import {
  menuDestructiveOption,
  menuOptions,
  pickMenuAction,
  pickMenuOption,
  pressAlertButton,
  resetMenuSpies,
} from './helpers';

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
  resetMenuSpies();
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
    await renderWithClient(<PostMenu postId={5} authorId={2} text="Their post" />);

    await fireEvent.press(screen.getByLabelText('Post options'));
    // Not the owner → the menu offers Report, not Delete.
    expect(menuOptions()).toEqual(['Report post']);

    await act(async () => pickMenuAction(0));
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
    const { invalidate } = await renderWithClient(
      <PostMenu postId={5} authorId={1} text="My post" />
    );

    await fireEvent.press(screen.getByLabelText('Post options'));
    // The owner → Edit and Delete, with only Delete marked destructive. The
    // Edit half is covered in postEdit.test.tsx (#146).
    expect(menuOptions()).toEqual(['Edit post', 'Delete post']);
    expect(menuDestructiveOption()).toBe('Delete post');

    await act(async () => pickMenuOption('Delete post'));
    // Nothing fires until the confirm is actually pressed.
    expect(made(/\/api\/posts\/5\/$/, 'DELETE')).toBe(false);

    await act(async () => pressAlertButton('Delete post?', 'Delete'));

    await waitFor(() => expect(made(/\/api\/posts\/5\/$/, 'DELETE')).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['feed'] });
  });

  it('cancelling the delete confirm is a no-op', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    await renderWithClient(<PostMenu postId={5} authorId={1} text="My post" />);

    await fireEvent.press(screen.getByLabelText('Post options'));
    await act(async () => pickMenuOption('Delete post'));
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
      edited_at: null,
      deleted_at: null,
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
    await fireEvent.press(screen.getByLabelText('Comment options'));
    await act(async () => pickMenuOption('Report comment'));
    await fireEvent.press(screen.getByText('Send report'));

    await waitFor(() => expect(made(/\/api\/reports\/$/, 'POST')).toBe(true));
    expect(requestBody(/\/api\/reports\/$/, 'POST')).toEqual({
      comment: 8,
      reason: '',
    });
  });

  it('offers Edit/Delete, not Report, on your own comment', async () => {
    // Authored by the viewer (pk 1) → self-report is pointless, so the same ⋯
    // carries the owner's pair instead.
    serveComments([comment({ id: 9, author: { id: 1, display_name: 'Me Myself', avatar_thumb: null } })]);
    await renderWithClient(<CommentThread postId={7} />);

    await screen.findByText('Comment 9');
    await fireEvent.press(screen.getByLabelText('Comment options'));
    expect(menuOptions()).toEqual(['Edit comment', 'Delete comment']);
  });
});

describe('ReportModal on a message (Phase 9b M0)', () => {
  it('flags a message and says what it hands over', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 4 }, 201));
    await renderWithClient(<ReportModal messageId={31} onClose={() => {}} />);

    // The disclosure is the point of the message variant: a report is the only
    // way message text reaches the maintainer, so the copy must say so *before*
    // the user sends it, not after.
    screen.getByText('Report this message');
    screen.getByText(/A copy of this message is sent with your report/);

    await fireEvent.changeText(
      screen.getByLabelText('Reason for reporting this message'),
      'abusive'
    );
    await fireEvent.press(screen.getByText('Send report'));

    await waitFor(() => expect(made(/\/api\/reports\/$/, 'POST')).toBe(true));
    // `message`, not `post`/`comment` — and no client-supplied snapshot: the
    // server writes the text from the row.
    expect(requestBody(/\/api\/reports\/$/, 'POST')).toEqual({
      message: 31,
      reason: 'abusive',
    });
  });

  it('keeps the post wording (and no message disclosure) for a post', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 5 }, 201));
    await renderWithClient(<ReportModal postId={7} onClose={() => {}} />);

    screen.getByText('Report this post');
    expect(screen.queryByText(/A copy of this message is sent/)).toBeNull();
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

  // Issue #236. A block that never landed used to be pixel-identical to one
  // that did: the modal dismissed on confirm, the mutation had no error path,
  // and the trigger still read "Block". You walked away believing someone was
  // blocked who could still message you and read your posts.
  it('says so — and does not dismiss — when a block is rejected', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockImplementation(async (url: string) => {
      if (/disconnect-impact\/$/.test(url)) return jsonResponse({ chats: [] });
      return jsonResponse({ detail: 'Nope.' }, 500);
    });
    await renderWithClient(
      <BlockButton userId={2} displayName="Ada Lovelace" isBlocked={false} />
    );

    await fireEvent.press(screen.getByLabelText('Block'));
    const confirms = await screen.findAllByText('Block');
    await fireEvent.press(confirms.at(-1)!);

    await waitFor(() => expect(alert).toHaveBeenCalled());
    // The message has to carry the fact that matters — that they are *not*
    // blocked — not the server's 500, which says nothing about safety.
    expect(alert.mock.calls[0][1]).toBe(
      'Couldn’t block Ada Lovelace — they’re not blocked. Try again.'
    );
    // The dialog is still up, so its confirm is the retry. (Waited for: the
    // alert fires inside the catch, before React has repainted the confirm from
    // its in-flight spinner back to a label.)
    // The dialog is still up — Cancel exists only inside it — so its confirm is
    // the retry. (RNTL hides everything outside an `accessibilityViewIsModal`
    // view from queries, which is why the modal's own controls are what's
    // reachable here.)
    expect(screen.getByText('Cancel')).toBeTruthy();
    alert.mockRestore();
  });

  it('says so when an unblock is rejected, naming what is still true', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 500));
    await renderWithClient(
      <BlockButton userId={2} displayName="Ada Lovelace" isBlocked />
    );

    await fireEvent.press(screen.getByLabelText('Unblock'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toBe(
      'Couldn’t unblock Ada Lovelace — they’re still blocked. Try again.'
    );
    alert.mockRestore();
  });

  // Offline is the likeliest way this fails, and React Native rejects with a
  // bare `TypeError: Network request failed` — never fit to show.
  it('shows our own words when the request never reached the server', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await renderWithClient(
      <BlockButton userId={2} displayName="Ada Lovelace" isBlocked />
    );

    await fireEvent.press(screen.getByLabelText('Unblock'));

    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).not.toMatch(/Network request failed/);
    alert.mockRestore();
  });
});
