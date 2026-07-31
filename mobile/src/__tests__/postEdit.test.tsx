/**
 * Editing your own post from the app (issue #146).
 *
 * The app could already *show* a "· edited" marker but never produce one — a
 * typo made on the phone could only be fixed from the web. What's pinned here is
 * the wiring plus the two rules the server enforces, because a client that gets
 * either wrong offers a button that 400s:
 *
 *   - the ⋯ menu offers **Edit** only on your own post, above the destructive
 *     Delete;
 *   - a save PATCHes the post and invalidates every list the post can appear in,
 *     so the new text and its marker show up wherever it's rendered;
 *   - a **text-only** post can't be emptied (the server's rule), while a post
 *     with photos can;
 *   - a failed save keeps the sheet open with the server's message, rather than
 *     closing over a change that didn't happen.
 *
 * The menu is captured rather than driven natively, through the shared
 * `./helpers` seam — same approach as `safety.test.tsx`, and it reads the same
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
import type { ReactElement } from 'react';

import { PostMenu } from '@/components/PostMenu';

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

const PATCH_POST = /\/api\/posts\/5\/$/;

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

/** Open the ⋯ menu on a post and choose Edit, leaving the sheet on screen. */
async function openEditor(props: {
  authorId?: number;
  text?: string;
  hasImages?: boolean;
} = {}) {
  const rendered = await renderWithClient(
    <PostMenu
      postId={5}
      authorId={props.authorId ?? 1}
      text={props.text ?? 'Original text'}
      hasImages={props.hasImages ?? false}
    />
  );
  await fireEvent.press(screen.getByLabelText('Post options'));
  await act(async () => pickMenuOption('Edit post'));
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

describe('the Edit affordance', () => {
  it('offers Edit above Delete on your own post, and only Delete is destructive', async () => {
    await renderWithClient(<PostMenu postId={5} authorId={1} text="Original text" />);

    await fireEvent.press(screen.getByLabelText('Post options'));

    // Order matters: the destructive item goes last, so a finger heading for
    // Edit never passes over Delete.
    expect(menuOptions()).toEqual(['Edit post', 'Delete post']);
    expect(menuDestructiveOption()).toBe('Delete post');
  });

  it('is absent on someone else’s post', async () => {
    await renderWithClient(<PostMenu postId={5} authorId={2} text="Their text" />);

    await fireEvent.press(screen.getByLabelText('Post options'));

    expect(menuOptions()).toEqual(['Report post']);
  });

  it('opens the sheet on the post’s current text', async () => {
    await openEditor({ text: 'Original text' });

    expect(screen.getByLabelText('Edit post text').props.value).toBe('Original text');
  });
});

describe('saving an edit', () => {
  it('PATCHes the trimmed text and invalidates everywhere the post shows', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ id: 5, text: 'Fixed text', edited_at: '2026-07-31T10:00:00Z' })
    );
    const { invalidate } = await openEditor({ text: 'Original text' });

    await fireEvent.changeText(screen.getByLabelText('Edit post text'), '  Fixed text  ');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(made(PATCH_POST, 'PATCH')).toBe(true));
    expect(requestBody(PATCH_POST, 'PATCH')).toEqual({ text: 'Fixed text' });

    // The post can be on the home feed, a profile, a group timeline or its own
    // permalink — the edited text has to reach all four, not just the one it was
    // edited from.
    for (const queryKey of [['feed'], ['userPosts'], ['groupPosts'], ['post', '5']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    // The sheet closes on success.
    await waitFor(() => expect(screen.queryByLabelText('Edit post text')).toBeNull());
  });

  it('keeps the sheet open and shows the server’s message when the save fails', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: 'You can only edit or delete your own posts.' }, 403)
    );
    const { invalidate } = await openEditor({ text: 'Original text' });

    await fireEvent.changeText(screen.getByLabelText('Edit post text'), 'Fixed text');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() =>
      expect(
        screen.getByText('You can only edit or delete your own posts.')
      ).toBeTruthy()
    );
    // Still editable, and nothing was refetched over a change that didn't happen.
    expect(screen.getByLabelText('Edit post text')).toBeTruthy();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('won’t empty a text-only post — the server’s rule, enforced before the request', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 5 }));
    await openEditor({ text: 'Original text', hasImages: false });

    await fireEvent.changeText(screen.getByLabelText('Edit post text'), '   ');
    await fireEvent.press(screen.getByText('Save'));

    expect(made(PATCH_POST, 'PATCH')).toBe(false);
  });

  it('lets a post with photos keep no text at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 5, text: '' }));
    await openEditor({ text: 'A caption', hasImages: true });

    await fireEvent.changeText(screen.getByLabelText('Edit post text'), '');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(made(PATCH_POST, 'PATCH')).toBe(true));
    expect(requestBody(PATCH_POST, 'PATCH')).toEqual({ text: '' });
  });
});

describe('leaving the sheet', () => {
  it('closes straight away when nothing was typed', async () => {
    await openEditor({ text: 'Original text' });

    await fireEvent.press(screen.getByText('Cancel'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Edit post text')).toBeNull();
  });

  it('asks before throwing away an edit in progress', async () => {
    await openEditor({ text: 'Original text' });

    await fireEvent.changeText(screen.getByLabelText('Edit post text'), 'Half-typed');
    await fireEvent.press(screen.getByText('Cancel'));

    // Still there until the confirm is answered.
    expect(screen.getByLabelText('Edit post text')).toBeTruthy();

    await act(async () => pressAlertButton('Discard changes?', 'Discard'));

    expect(screen.queryByLabelText('Edit post text')).toBeNull();
    expect(made(PATCH_POST, 'PATCH')).toBe(false);
  });
});
