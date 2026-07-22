/**
 * The Groups tab (Phase 9 E3a) — the groups list and the invites segment.
 *
 * What's worth pinning: the Groups segment lists your groups and taps through to
 * one; the Invites segment accepts/declines a pending invite via the right
 * endpoint and refreshes the shared count so the tab badge can't go stale.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GroupsScreen from '@/app/(tabs)/groups';
import type { Group, GroupInvite } from '@/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
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

function page(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

const FAMILY: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 4,
  your_role: 'admin',
  created_at: '2026-07-01T10:00:00Z',
};

const INVITE: GroupInvite = {
  id: 99,
  group: { id: 8, name: 'Book Club', avatar_thumb: null },
  invited_by: { id: 3, display_name: 'Ada Lovelace', avatar_thumb: null },
  created_at: '2026-07-22T10:00:00Z',
};

function serve({
  groups = [FAMILY],
  invites = [INVITE],
}: { groups?: Group[]; invites?: GroupInvite[] } = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/group-invites/')) return jsonResponse(page(invites));
    if (url.includes('/api/groups/')) return jsonResponse(page(groups));
    return jsonResponse(null, 204);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  await render(
    <QueryClientProvider client={queryClient}>
      <GroupsScreen />
    </QueryClientProvider>
  );
  return { invalidate };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('lists your groups and taps through to one', async () => {
  serve();
  await renderScreen();

  expect(await screen.findByText('The Andersons')).toBeTruthy();
  expect(screen.getByText('4 members · Admin')).toBeTruthy();

  fireEvent.press(screen.getByText('The Andersons'));
  expect(mockPush).toHaveBeenCalledWith('/groups/7');
});

it('shows invites and accepts one, refreshing the shared count', async () => {
  serve();
  const { invalidate } = await renderScreen();
  await screen.findByText('The Andersons');

  fireEvent.press(screen.getByText('Invites'));
  expect(await screen.findByText('Book Club')).toBeTruthy();
  expect(screen.getByText('Ada Lovelace invited you')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Accept Book Club'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/group-invites/99/accept/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupInvites'] })
  );
});

it('declines an invite via the reject endpoint', async () => {
  serve();
  await renderScreen();
  await screen.findByText('The Andersons');

  fireEvent.press(screen.getByText('Invites'));
  fireEvent.press(await screen.findByLabelText('Decline Book Club'));

  await waitFor(() =>
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/group-invites/99/reject/') &&
          init?.method === 'POST'
      )
    ).toBe(true)
  );
});

it('offers a New group CTA when you have no groups', async () => {
  serve({ groups: [] });
  await renderScreen();

  expect(await screen.findByText('No groups yet')).toBeTruthy();
  fireEvent.press(screen.getByText('New group'));
  expect(mockPush).toHaveBeenCalledWith('/groups/new');
});
