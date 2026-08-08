/**
 * The group page (Phase 9 E3a) — its timeline renders, and composing there posts
 * *into the group*, not the home feed.
 *
 * The load-bearing new wiring is the group-scoped compose: `ComposeBox` with a
 * `groupId` must call `createPost` with that id (the server files it under the
 * group). Everything else is the same TimelineList the feed uses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/api';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Group, Post, User } from '@/types';

import { settle } from './helpers';

const mockParams: { groupId: string } = { groupId: '7' };
jest.mock('expo-router', () => ({
  // The screen is always focused under test, so focus is a plain effect — see
  // `jest.setup.js`, whose global stub this local factory overrides. Needed
  // here because the calendar tab renders `MonthGrid`, which uses
  // `useAndroidBack` → `useFocusEffect` (#168).
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useLocalSearchParams: () => mockParams,
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  },
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

const ME: User = {
  pk: 1,
  email: 'me@example.com',
  first_name: 'Me',
  last_name: 'Myself',
  display_name: 'Me Myself',
  bio: '',
  avatar_url: null,
  avatar_thumb: null,
  is_staff: false,
  send_read_receipts: true,
};

const GROUP: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family group',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 4,
  your_role: 'member',
  created_at: '2026-07-01T10:00:00Z',
};

function makePost(overrides: Partial<Post> & { id: number }): Post {
  return {
    author: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    text: `Post ${overrides.id}`,
    images: [],
    group: { id: 7, name: 'The Andersons' },
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    created_at: '2026-07-20T10:00:00Z',
    edited_at: null,
    ...overrides,
  };
}

function serve(posts: Post[]) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/groups/7/posts/')) {
      return jsonResponse({ count: posts.length, next: null, previous: null, results: posts });
    }
    // The E3b events/calendar endpoints — empty here; their own suite covers the
    // populated cases. These must be matched before the generic group route,
    // since their URLs contain `/api/groups/7/` too.
    if (url.includes('/api/groups/7/events/')) return jsonResponse([]);
    if (url.includes('/api/groups/7/calendar/')) return jsonResponse([]);
    if (url.includes('/api/groups/7/')) return jsonResponse(GROUP);
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  await saveTokens({ access: 'a', refresh: 'r' });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  // The client comes back so a test can drive a refetch and read the query's
  // state afterwards; callers that don't care can keep ignoring it.
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GroupScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
  return { client: queryClient, ...view };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('renders the group and its timeline', async () => {
  serve([makePost({ id: 5, text: 'A day on the hills' })]);
  await renderScreen();

  expect(await screen.findByText('A day on the hills')).toBeTruthy();
  // The group name is in the top bar; the member count links to the roster.
  expect(screen.getAllByText('The Andersons').length).toBeGreaterThan(0);
  expect(screen.getByText('4 members ›')).toBeTruthy();
});

it('composes a post into the group, not the home feed', async () => {
  serve([]);
  const createPost = jest
    .spyOn(api, 'createPost')
    .mockResolvedValue(makePost({ id: 9, text: 'Hello group' }));

  await renderScreen();
  await screen.findByText('4 members ›');

  await fireEvent.changeText(
    await screen.findByLabelText("What's happening?"),
    'Hello group'
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Post' }));

  // The third arg is the group id — this is the whole point of a group compose.
  await waitFor(() =>
    expect(createPost).toHaveBeenCalledWith('Hello group', [], 7)
  );
  createPost.mockRestore();
});

// --- A refresh that fails (#309) --------------------------------------------

/**
 * A failed *refresh* of the group must not take the group off the screen.
 *
 * `query-core`'s error action keeps the data it has and only flips `status` to
 * 'error'. `staleTime` is 0 and `focusManager` is wired to `AppState`, so every
 * foreground refetches `['group', id]` — and a failure there used to replace the
 * timeline, the upcoming events and the calendar with "Couldn't load this
 * group", on a screen that had all three.
 */
describe('a refresh that fails', () => {
  /** The group request fails from here on; its posts keep working. */
  function breakTheGroup(status: number, reason: string) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/api/groups/7/') &&
      !url.includes('/posts/') &&
      !url.includes('/events/') &&
      !url.includes('/calendar/')
        ? jsonResponse({ detail: reason }, status)
        : base(url)
    );
  }

  it('keeps the group and its timeline', async () => {
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheGroup(503, 'Service unavailable.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });

    await waitFor(() =>
      expect(client.getQueryState(['group', 7])?.status).toBe('error')
    );
    // The cache flips to 'error' a render before the screen does — React Query
    // notifies on a macrotask through `notifyManager`. Without this flush the
    // assertions below run against the pre-error tree and pass against a screen
    // with the bug still in it.
    await settle(2);
    expect(screen.queryByText('Couldn’t load this group')).toBeNull();
    expect(screen.getByText('A day on the hills')).toBeTruthy();
    expect(screen.getByText('4 members ›')).toBeTruthy();
  });

  it('still says the group is unavailable on a 404, even holding a copy', async () => {
    // A 404 here means left or made private — an answer about *now*, so it
    // outranks the cached copy.
    serve([makePost({ id: 5, text: 'A day on the hills' })]);
    const { client } = await renderScreen();
    await screen.findByText('A day on the hills');
    breakTheGroup(404, 'Not found.');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });

    expect(
      await screen.findByText('This group isn’t available.')
    ).toBeTruthy();
    expect(screen.queryByText('A day on the hills')).toBeNull();
  });

  it('still shows the error card when the first load fails', async () => {
    // Nothing cached to fall back on — the case the card is for.
    serve([]);
    breakTheGroup(503, 'Service unavailable.');
    await renderScreen();

    expect(await screen.findByText('Couldn’t load this group')).toBeTruthy();
  });
});
