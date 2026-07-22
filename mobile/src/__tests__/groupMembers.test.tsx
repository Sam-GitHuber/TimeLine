/**
 * The group members roster (Phase 9 E3a) — admin management.
 *
 * Pins the admin controls that have real branching: promoting a member hits the
 * role endpoint, and — the regression this file exists to guard — **cancelling
 * the remove confirmation is a true no-op** (no `removeGroupMember` call, no
 * cache invalidation), while confirming it actually removes. A non-admin sees
 * the roster read-only, with no action sheet.
 *
 * The action sheet and the confirm dialog are captured, not driven natively:
 * `ActionSheetIOS.showActionSheetWithOptions` hands us the callback to invoke
 * with a chosen index, and `Alert.alert` hands us the button list to press.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import GroupMembersScreen from '@/app/groups/[groupId]/members';
import type { Group, GroupMember } from '@/types';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: '7' }),
  router: { push: jest.fn(), back: jest.fn() },
}));

// `me` only drives the "(you)" label and the self-row. A fixed stub (over the
// real AuthProvider) keeps its async auth setState from bleeding across tests —
// that churn was starving later renders of their queries.
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

const GROUP: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family group',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 2,
  your_role: 'admin',
  created_at: '2026-07-01T10:00:00Z',
};

const MEMBERS: GroupMember[] = [
  { user: { id: 1, display_name: 'Me Myself', avatar_thumb: null }, role: 'admin' },
  { user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null }, role: 'member' },
];

function serve({ role = 'admin' as 'admin' | 'member', members = MEMBERS } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    // A role change or a removal — both are member sub-resources; answer 204
    // before the members-list branch below can swallow them.
    if (/\/members\/\d+\/role\/$/.test(url)) return jsonResponse(null, 204);
    if (/\/members\/\d+\/$/.test(url) && init?.method === 'DELETE') {
      return jsonResponse(null, 204);
    }
    if (url.includes('/api/groups/7/members/')) return jsonResponse(members);
    if (url.includes('/api/groups/7/')) return jsonResponse({ ...GROUP, your_role: role });
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
  render(
    <QueryClientProvider client={queryClient}>
      <GroupMembersScreen />
    </QueryClientProvider>
  );
  // Let the auth + group + members queries fire before the test touches
  // `screen`: RNTL's screen proxy isn't ready on the synchronous tick right
  // after render, and this settle step (which never touches `screen` itself)
  // is what lets the subsequent `findBy*` queries resolve.
  await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(0));
  return { invalidate };
}

const showActionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions');
const alertSpy = jest.spyOn(Alert, 'alert');

/**
 * Invoke the last action sheet's callback with the chosen option index.
 *
 * Deliberately *not* wrapped in `act()`: the callback kicks off an async
 * mutation whose fetch resolves after the callback returns, so wrapping only the
 * synchronous call would leak that work out of the act and poison the next
 * render. The test's trailing `waitFor` flushes it instead.
 */
function pickAction(index: number) {
  const callback = showActionSheet.mock.calls.at(-1)?.[1] as (i: number) => void;
  callback(index);
}

/** Press a button (by its text) on the last `Alert.alert` with the given title. */
function pressAlertButton(title: string, buttonText: string) {
  const call = alertSpy.mock.calls.find(([t]) => t === title);
  const buttons = call?.[2] as { text?: string; onPress?: () => void }[] | undefined;
  buttons?.find((b) => b.text === buttonText)?.onPress?.();
}

function madeRequest(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  showActionSheet.mockReset().mockImplementation(() => {});
  alertSpy.mockReset().mockImplementation(() => {});
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// Unmount and flush between tests: a mutation's onSuccess invalidates queries,
// which schedules a background refetch, and a leaked one starves the following
// render of its own queries. Explicit cleanup + a macrotask tick clears it.
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

it('promotes a member via the role endpoint', async () => {
  serve();
  const { invalidate } = await renderScreen();

  fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickAction(0); // "Make admin"

  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/role\/$/, 'POST')).toBe(true)
  );
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupMembers', 7] })
  );
});

it('does nothing when the remove confirmation is cancelled', async () => {
  serve();
  const { invalidate } = await renderScreen();

  fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickAction(1); // "Remove from group" → confirm dialog
  pressAlertButton('Remove member?', 'Cancel');

  // The whole point of the fix: cancelling never touches the API or the cache.
  expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(false);
  expect(invalidate).not.toHaveBeenCalled();
});

it('removes a member when the confirmation is accepted', async () => {
  serve();
  await renderScreen();

  fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickAction(1); // "Remove from group"
  pressAlertButton('Remove member?', 'Remove');

  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(true)
  );
});

it('is read-only for a non-admin (no action sheet)', async () => {
  serve({ role: 'member' });
  await renderScreen();

  const row = await screen.findByLabelText('Ada Lovelace');
  fireEvent.press(row);

  expect(showActionSheet).not.toHaveBeenCalled();
});
