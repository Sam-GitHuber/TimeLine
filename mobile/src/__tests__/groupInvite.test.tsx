/**
 * The group invite picker (Phase 9 E3a) — partial-success handling.
 *
 * The invites are independent requests, so one the server rejects (a since-
 * blocked connection, or someone already invited) must not discard the ones that
 * succeeded. This pins the three outcomes of the `allSettled` tally:
 *   • all succeed        → close the picker, no alert;
 *   • some fail          → tell the user how many landed, then close (the rest
 *                          now have pending invites);
 *   • none succeed       → surface the error and keep the picker open to retry.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { router } from 'expo-router';

import GroupInviteScreen from '@/app/groups/[groupId]/invite';
import type { GroupMember, PersonSummary } from '@/types';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: '7' }),
  router: { back: jest.fn() },
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

function person(id: number, display_name: string): PersonSummary {
  return {
    id,
    display_name,
    bio: '',
    avatar_thumb: null,
    connection_status: 'connected',
    is_blocked: false,
  };
}

const CONNECTIONS = [person(2, 'Ada Lovelace'), person(3, 'Bob Newman')];
// One existing member (you), so neither candidate is filtered out of the pool.
const MEMBERS: GroupMember[] = [
  { user: { id: 1, display_name: 'Me Myself', avatar_thumb: null }, role: 'admin' },
];

/** `failUserIds` are the user ids whose invite POST the server rejects with 400. */
function serve({ failUserIds = [] as number[] } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes('/api/users/?filter=connected')) return jsonResponse(page(CONNECTIONS));
    if (url.includes('/api/groups/7/members/') && init?.method === 'POST') {
      const { user_id } = JSON.parse(init.body ?? '{}');
      return failUserIds.includes(user_id)
        ? jsonResponse({ detail: 'Cannot invite this person.' }, 400)
        : jsonResponse(null, 204);
    }
    if (url.includes('/api/groups/7/members/')) return jsonResponse(MEMBERS);
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupInviteScreen />
    </QueryClientProvider>
  );
}

function invitePosts() {
  return mockFetch.mock.calls.filter(
    ([url, init]) =>
      String(url).includes('/api/groups/7/members/') && init?.method === 'POST'
  );
}

const alertSpy = jest.spyOn(Alert, 'alert');

beforeEach(() => {
  mockFetch.mockReset();
  alertSpy.mockReset().mockImplementation(() => {});
  (router.back as jest.Mock).mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('invites everyone and closes on full success', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Invite'));

  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(alertSpy).not.toHaveBeenCalled();
});

it('keeps the ones that succeed when one fails, and reports the tally', async () => {
  serve({ failUserIds: [3] }); // Bob's invite is rejected
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Bob Newman'));
  await fireEvent.press(screen.getByLabelText('Invite'));

  // Both were attempted — Bob's rejection didn't short-circuit Ada's.
  await waitFor(() => expect(invitePosts()).toHaveLength(2));
  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith(
      'Some invites didn’t send',
      expect.stringContaining('Invited 1 of 2')
    )
  );
  // Some landed, so the picker closes.
  await waitFor(() => expect(router.back).toHaveBeenCalled());
});

it('keeps the picker open when no invite succeeds', async () => {
  serve({ failUserIds: [2, 3] }); // both rejected
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
  await fireEvent.press(screen.getByLabelText('Bob Newman'));
  await fireEvent.press(screen.getByLabelText('Invite'));

  await waitFor(() =>
    expect(alertSpy).toHaveBeenCalledWith(
      'Couldn’t invite anyone',
      expect.stringContaining('Cannot invite this person.')
    )
  );
  expect(router.back).not.toHaveBeenCalled();
});
