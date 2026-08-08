/**
 * The Edit group screen's load states (#317).
 *
 * The screen itself is a thin wrapper over the shared `GroupForm` — which has
 * its own suite — so what's pinned here is the one thing the wrapper decides:
 * what to draw while, and if, the group doesn't arrive. It used to be
 * `{group ? <GroupForm/> : <ActivityIndicator/>}` with `groupQuery.isError` read
 * nowhere, so an admin who tapped ⋯ → Edit group on bad signal got a spinner
 * that never resolved, never explained itself and offered no way to ask again.
 *
 * Not a false empty state like the rest of #317, but the same missing branch and
 * the same dead end.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import EditGroupScreen from '@/app/groups/[groupId]/edit';
import type { Group } from '@/types';

import { settle } from './helpers';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: '7' }),
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  // The form holds both navigator-owned ways off the screen while its write is
  // out (#259) — same stand-ins as `groupForm.test.tsx`.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useNavigation: () => ({ setOptions: () => {} }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
}));

// The form's avatar picker reaches the real cropper, which needs reanimated and
// gesture-handler — neither of which runs under Jest. Same stand-in as
// `groupForm.test.tsx`, which is where the picking itself is tested; nothing
// here presses it.
jest.mock('@/components/AvatarCropModal', () => ({ AvatarCropModal: () => null }));

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
  member_count: 4,
  your_role: 'admin',
  created_at: '2026-07-01T10:00:00Z',
};

/** `fails` many attempts 500 before the group comes back. */
function serve(fails = 0) {
  let calls = 0;
  mockFetch.mockImplementation(async (url: string) => {
    if (!url.includes('/api/groups/7/')) return jsonResponse(null, 404);
    calls += 1;
    if (calls <= fails) {
      // A macrotask late, as a real request is.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: 'Server error.' }, 500);
    }
    return jsonResponse(GROUP);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <EditGroupScreen />
    </QueryClientProvider>
  );
  return { client: queryClient, ...view };
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('pre-fills the form from the group', async () => {
  serve();
  await renderScreen();

  expect(await screen.findByDisplayValue('The Andersons')).toBeTruthy();
});

it('says the load failed instead of spinning forever', async () => {
  serve(1);
  await renderScreen();

  expect(await screen.findByText('Couldn’t load this group')).toBeTruthy();
  expect(screen.getByText('Server error.')).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('loads the form when the retry lands', async () => {
  serve(1);
  await renderScreen();

  await fireEvent.press(await screen.findByText('Try again'));

  expect(await screen.findByDisplayValue('The Andersons')).toBeTruthy();
  expect(screen.queryByText('Couldn’t load this group')).toBeNull();
});

it('keeps the form when a refresh fails', async () => {
  // `isError && !group`, never a bare `isError`: a failed refetch must not take
  // the form — and whatever has been typed into it — off the screen.
  serve();
  const { client } = await renderScreen();
  await screen.findByDisplayValue('The Andersons');

  mockFetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return jsonResponse({ detail: 'Server error.' }, 500);
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['group', 7] });
  });
  await settle(2);

  expect(screen.getByDisplayValue('The Andersons')).toBeTruthy();
  expect(screen.queryByText('Couldn’t load this group')).toBeNull();
});

it('says the group is gone on a 404, without offering a retry', async () => {
  // A 404 is an answer about *now* — deleted, or you've been removed — so it
  // outranks the transient-failure card. Offering "Try again" for a request that
  // will 404 forever replaces one dead end with another, which is the failure
  // this screen was fixed for. `groups/[groupId].tsx` and `u/[userId].tsx` both
  // branch on the status first.
  mockFetch.mockImplementation(async () =>
    jsonResponse({ detail: 'Not found.' }, 404)
  );
  await renderScreen();

  expect(await screen.findByText('This group isn’t available.')).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
});
