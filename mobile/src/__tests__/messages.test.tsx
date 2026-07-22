/**
 * The Messages tab — the conversation list (Phase 9 E2a).
 *
 * What's worth pinning: a 1:1 row shows the other person and a "You: …" preview
 * when the last message is yours; a group row falls back to its members' names
 * and shows an unread pill; a pending invite reads "Invited — connect to join"
 * (not a message preview it can't see); and tapping a row pushes that thread.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';

import MessagesScreen from '@/app/(tabs)/messages';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Conversation } from '@/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  // Arrow so the read of `mockPush` is deferred to call time (the hoisted
  // factory runs before the `const` initialises — the trap the C4 notes describe).
  router: { push: (...args: unknown[]) => mockPush(...args) },
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

const ME = {
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

function convo(overrides: Partial<Conversation> & { id: number }): Conversation {
  return {
    kind: 'direct',
    title: '',
    group: null,
    other: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
    participants: [],
    my_status: 'active',
    must_connect_with: [],
    last_message: null,
    unread_count: 0,
    can_send: null,
    updated_at: '2026-07-22T10:00:00Z',
    ...overrides,
  };
}

function serve(conversations: Conversation[]) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/conversations/')) {
      return jsonResponse({
        count: conversations.length,
        next: null,
        previous: null,
        results: conversations,
      });
    }
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
        <MessagesScreen />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('shows a 1:1 row with a “You:” preview for your own last message', async () => {
  serve([
    convo({
      id: 10,
      last_message: {
        text: 'See you Saturday',
        is_deleted: false,
        sender_id: ME.pk,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  // The "You:" prefix is a styled child node; the preview text sits beside it.
  // Regex matchers test each Text node's composed content, dodging the
  // nested-<Text> fragmentation getByText('exact') is brittle about.
  expect(screen.getByText(/^You:/)).toBeTruthy();
  expect(screen.getByText(/See you Saturday/)).toBeTruthy();
});

it('previews a deleted last message as “Message deleted”', async () => {
  serve([
    convo({
      id: 11,
      last_message: {
        text: '',
        is_deleted: true,
        sender_id: 2,
        created_at: '2026-07-22T10:00:00Z',
      },
    }),
  ]);

  await renderScreen();

  expect(await screen.findByText('Message deleted')).toBeTruthy();
});

it('names an untitled group by its other members and shows an unread pill', async () => {
  serve([
    convo({
      id: 12,
      kind: 'group',
      other: null,
      participants: [
        { id: 1, display_name: 'Me Myself', avatar_thumb: null, status: 'active' },
        { id: 2, display_name: 'Ada', avatar_thumb: null, status: 'active' },
        { id: 3, display_name: 'Grace', avatar_thumb: null, status: 'active' },
      ],
      unread_count: 3,
    }),
  ]);

  await renderScreen();

  // Excludes "Me Myself" from the fallback name.
  expect(await screen.findByText('Ada, Grace')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
});

it('shows a pending invite as “Invited — connect to join”', async () => {
  serve([convo({ id: 13, kind: 'group', other: null, my_status: 'pending', title: 'Hikers' })]);

  await renderScreen();

  expect(await screen.findByText('Hikers')).toBeTruthy();
  expect(screen.getByText('Invited — connect to join')).toBeTruthy();
});

it('taps a row through to its thread', async () => {
  serve([convo({ id: 14 })]);

  await renderScreen();
  fireEvent.press(await screen.findByText('Ada Lovelace'));

  expect(mockPush).toHaveBeenCalledWith('/messages/14');
});

it('shows the empty state when you have no conversations', async () => {
  serve([]);

  await renderScreen();

  expect(await screen.findByText('No conversations yet')).toBeTruthy();
});
