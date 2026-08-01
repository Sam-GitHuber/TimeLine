/**
 * Tests for what leaves the phone when a session ends (#191).
 *
 * The threat model is a shared or handed-on phone: Ada signs out (or her
 * session expires), someone else signs in, and nothing of Ada's may still be
 * on the device. The query cache is the big one — TanStack renders cached data
 * immediately while refetching, so anything left in it is a frame or more of
 * the previous person's app, message previews included.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import { api } from '@/api';
import { AuthProvider, useAuth } from '@/auth';
import { clearDrafts, getDraft, setDraft } from '@/drafts';
import { clearOutbox, newOutgoing, outboxFor, updateOutbox } from '@/outbox';
import { clearTokens, saveTokens } from '@/tokens';
import { useSessionReset } from '@/useSessionReset';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const ADA = { pk: 1, display_name: 'Ada Lovelace' };
const GRACE = { pk: 2, display_name: 'Grace Hopper' };

/** Routes the fetch mock: login succeeds as `user`, everything else 401s. */
function loginAs(user: { pk: number; display_name: string }) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/auth/mobile/login/')) {
      return jsonResponse({ access: 'access-2', refresh: 'refresh-2', user });
    }
    if (url.endsWith('/api/auth/mobile/logout/')) {
      return jsonResponse(null, 204);
    }
    return jsonResponse({ detail: 'Invalid token.' }, 401);
  });
}

/**
 * Ends the session the way `api.ts` does: an ordinary request 401s, the
 * refresh 401s too, and `onSessionExpired` fires — the path that lands on
 * login without `signOut` ever running. Wrapped in `act` because the expiry
 * handler sets provider state from outside any test event.
 */
async function expireSession() {
  mockFetch.mockResolvedValue(jsonResponse({ detail: 'Invalid token.' }, 401));
  await act(async () => {
    await expect(api.getUnreadMessageCount()).rejects.toThrow(
      'session has expired'
    );
  });
  expect(await screen.findByText('signedOut:none')).toBeTruthy();
}

/**
 * Drives auth the way the app does, with `useSessionReset` mounted where
 * `AuthGate` mounts it — inside both providers.
 */
function Probe() {
  const { status, user, signIn, signOut } = useAuth();
  useSessionReset();
  return (
    <>
      <Text>{`${status}:${user?.display_name ?? 'none'}`}</Text>
      <Pressable onPress={() => void signIn('who@example.com', 'pw')}>
        <Text>go-sign-in</Text>
      </Pressable>
      <Pressable onPress={() => void signOut()}>
        <Text>go-sign-out</Text>
      </Pressable>
    </>
  );
}

function renderProbe(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/** A test client. gcTime 0 so no GC timer outlives the test run. */
function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

/** Boots the app signed in as Ada from stored tokens (the cold-start path). */
async function coldStartAsAda(queryClient: QueryClient) {
  await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
  mockFetch.mockResolvedValue(jsonResponse(ADA));
  await renderProbe(queryClient);
  expect(await screen.findByText('signedIn:Ada Lovelace')).toBeTruthy();
}

beforeEach(async () => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  await clearTokens();
  clearOutbox();
  clearDrafts();
});

it('empties the query cache on sign-out', async () => {
  const queryClient = newQueryClient();
  await coldStartAsAda(queryClient);

  // Ada's session data — the conversation list is the entry that matters
  // most, because it carries other people's message previews.
  queryClient.setQueryData(['conversations'], {
    results: [{ id: 7, last_message: 'meet at 6?' }],
  });
  loginAs(ADA); // routes the logout call; nothing signs in here

  await fireEvent.press(screen.getByText('go-sign-out'));

  expect(await screen.findByText('signedOut:none')).toBeTruthy();
  expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
});

it('empties the query cache when the session expires under the app', async () => {
  const queryClient = newQueryClient();
  await coldStartAsAda(queryClient);
  queryClient.setQueryData(['feed'], { results: [{ id: 1, body: 'hello' }] });

  await expireSession();

  expect(queryClient.getQueryData(['feed'])).toBeUndefined();
});

it('keeps drafts and unsent messages across an expiry for the same person', async () => {
  const queryClient = newQueryClient();
  await coldStartAsAda(queryClient);
  setDraft(7, 'half-written reply');
  updateOutbox(7, () => [newOutgoing({ text: 'never sent' })]);

  await expireSession();

  // Ada logs straight back in: her words are still waiting for her.
  loginAs(ADA);
  await fireEvent.press(screen.getByText('go-sign-in'));

  expect(await screen.findByText('signedIn:Ada Lovelace')).toBeTruthy();
  expect(getDraft(7)).toBe('half-written reply');
  expect(outboxFor(7)).toHaveLength(1);
});

it('clears drafts and unsent messages when a different person signs in after an expiry', async () => {
  const queryClient = newQueryClient();
  await coldStartAsAda(queryClient);
  setDraft(7, 'half-written reply');
  updateOutbox(7, () => [newOutgoing({ text: 'never sent' })]);

  await expireSession();

  // The expiry landed on the login screen, and someone else signs in on it —
  // the one route by which Ada's unsent words could reach another session.
  loginAs(GRACE);
  await fireEvent.press(screen.getByText('go-sign-in'));

  expect(await screen.findByText('signedIn:Grace Hopper')).toBeTruthy();
  expect(getDraft(7)).toBe('');
  expect(outboxFor(7)).toHaveLength(0);
});
