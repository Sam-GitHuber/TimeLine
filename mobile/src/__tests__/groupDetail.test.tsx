/**
 * The group page (Phase 9 E3a) — its timeline renders, and composing there posts
 * *into the group*, not the home feed.
 *
 * The load-bearing new wiring is the group-scoped compose: `ComposeBox` with a
 * `groupId` must call `createPost` with that id (the server files it under the
 * group). Everything else is the same TimelineList the feed uses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/api';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Group, Post, User } from '@/types';

const mockParams: { groupId: string } = { groupId: '7' };
jest.mock('expo-router', () => ({
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
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GroupScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
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
