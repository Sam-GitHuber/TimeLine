/**
 * Tests for `AuthProvider` — specifically the cold-start path.
 *
 * This is the sequence that runs every time the app is opened, and its failure
 * modes are the ones users actually notice: a flash of the login screen for
 * someone who *is* logged in, or being stuck on a spinner forever. It's also the
 * one bit of the spine a Simulator smoke-test can't easily be driven through.
 */

import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AuthProvider, useAuth } from '@/auth';
import { getAccessToken, saveTokens } from '@/tokens';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

/** Renders the auth state as text so tests can assert on it. */
function Probe() {
  const { status, user } = useAuth();
  return <Text>{`${status}:${user?.display_name ?? 'none'}`}</Text>;
}

function renderProbe() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('settles on signedOut when there is no stored token', async () => {
  await renderProbe();

  expect(await screen.findByText('signedOut:none')).toBeTruthy();
  // No token means no point asking the server who we are.
  expect(mockFetch).not.toHaveBeenCalled();
});

it('restores the session from a stored token', async () => {
  await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
  mockFetch.mockResolvedValue(
    jsonResponse({ pk: 1, display_name: 'Alice Anderson' })
  );

  await renderProbe();

  expect(await screen.findByText('signedIn:Alice Anderson')).toBeTruthy();
});

it('signs out and wipes tokens when the stored token is rejected', async () => {
  // The account was deleted, or the token was revoked, while the app was closed
  // (see PR #96). The app must not sit in a half-authenticated state.
  await saveTokens({ access: 'stale', refresh: 'also-stale' });
  mockFetch.mockResolvedValue(jsonResponse({ detail: 'Invalid token.' }, 401));

  await renderProbe();

  expect(await screen.findByText('signedOut:none')).toBeTruthy();
  expect(await getAccessToken()).toBeNull();
});

it('keeps the tokens when the cold-start check fails on a network error', async () => {
  // Opening the app with no signal must not end the session. `fetch` rejects
  // with a TypeError here, not a 401 — wiping the 90-day refresh token on that
  // would log the user out for good, and stop push notifications arriving.
  await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
  mockFetch.mockRejectedValue(new TypeError('Network request failed'));

  await renderProbe();

  expect(await screen.findByText('signedOut:none')).toBeTruthy();
  expect(await getAccessToken()).toBe('access-1');
});

it('signs in silently when only the access token has expired', async () => {
  // The common case for an app reopened days later: the access token is stale
  // but the 90-day refresh token is good, so the user should never see login.
  await saveTokens({ access: 'stale', refresh: 'refresh-1' });
  mockFetch.mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => {
    if (url.endsWith('/api/auth/mobile/refresh/')) {
      return jsonResponse({ access: 'access-2', refresh: 'refresh-2' });
    }
    if (init.headers?.Authorization === 'Bearer stale') {
      return jsonResponse(null, 401);
    }
    return jsonResponse({ pk: 1, display_name: 'Alice Anderson' });
  });

  await renderProbe();

  expect(await screen.findByText('signedIn:Alice Anderson')).toBeTruthy();
  expect(await getAccessToken()).toBe('access-2');
});
