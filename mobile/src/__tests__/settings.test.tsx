/**
 * Settings (Phase 9 E4b) — the account controls reached from the profile gear.
 *
 * Each section is a thin wrapper over one request, so what's pinned here is the
 * wiring and the guards, not layout:
 *   - notification prefs render from the GET map and a toggle PATCHes just that
 *     kind (optimistically);
 *   - change-password validates the confirm match client-side, then POSTs the
 *     current + new pair and confirms;
 *   - delete-account confirms through a password modal, POSTs, then signs out.
 *
 * `signOut` is mocked on `@/auth` so the delete path can assert it fires without
 * dragging the real AuthProvider (and its push/token machinery) in.
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

import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
import { DeleteAccountSection } from '@/components/settings/DeleteAccountSection';
import { FeedPreferencesSection } from '@/components/settings/FeedPreferencesSection';
import { NotificationPreferencesSection } from '@/components/settings/NotificationPreferencesSection';

const mockSignOut = jest.fn();
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({ signOut: mockSignOut }),
}));

const mockSetIncludeGroups = jest.fn();
let mockIncludeGroups = false;
jest.mock('@/preferences', () => ({
  usePreferences: () => ({
    includeGroupsInFeed: mockIncludeGroups,
    setIncludeGroupsInFeed: mockSetIncludeGroups,
  }),
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

function requestBody(match: RegExp, method: string): unknown {
  const call = mockFetch.mock.calls.find(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

function made(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

// RNTL v14 + React 19: the initial commit lands in a microtask, so the render
// must be awaited or `screen` is empty on the next synchronous line.
async function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  await act(async () => {
    render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSignOut.mockReset();
  mockSetIncludeGroups.mockReset();
  mockIncludeGroups = false;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('NotificationPreferencesSection', () => {
  it('renders a toggle per mutable kind from the fetched map', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ post_reply: true, reaction: false })
    );
    await renderWithClient(<NotificationPreferencesSection />);

    // Friendly labels, and the switches reflect the fetched values.
    const replies = await screen.findByLabelText('Replies to your posts');
    expect(replies.props.value).toBe(true);
    expect(
      screen.getByLabelText('Reactions to your posts and comments').props.value
    ).toBe(false);
  });

  it('PATCHes just the flipped kind', async () => {
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        return jsonResponse({ post_reply: false, reaction: false });
      }
      return jsonResponse({ post_reply: true, reaction: false });
    });
    await renderWithClient(<NotificationPreferencesSection />);

    const replies = await screen.findByLabelText('Replies to your posts');
    await act(async () => fireEvent(replies, 'valueChange', false));

    await waitFor(() =>
      expect(made(/\/api\/notification-preferences\/$/, 'PATCH')).toBe(true)
    );
    // Only the toggled kind is sent, not the whole map.
    expect(requestBody(/\/api\/notification-preferences\/$/, 'PATCH')).toEqual({
      post_reply: false,
    });
  });

  it('falls back to the raw key for an unknown kind', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ some_new_kind: true }));
    await renderWithClient(<NotificationPreferencesSection />);

    // A kind with no friendly label still renders its toggle rather than dropping.
    expect(await screen.findByLabelText('some_new_kind')).toBeTruthy();
  });
});

describe('ChangePasswordSection', () => {
  async function openForm() {
    await renderWithClient(<ChangePasswordSection />);
    await fireEvent.press(screen.getByText('Change password…'));
  }

  it('blocks submit and warns when the new passwords don’t match', async () => {
    await openForm();

    await fireEvent.changeText(screen.getByLabelText('Current password'), 'old-pw');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'new-pw-1');
    await fireEvent.changeText(
      screen.getByLabelText('Confirm new password'),
      'different'
    );

    expect(screen.getByText('The new passwords don’t match.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
    // The mismatch guard means no request goes out.
    expect(made(/\/api\/auth\/password\/change\/$/, 'POST')).toBe(false);
  });

  it('POSTs the current + new pair and confirms success', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    await openForm();

    await fireEvent.changeText(screen.getByLabelText('Current password'), 'old-pw');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'new-pw-123');
    await fireEvent.changeText(
      screen.getByLabelText('Confirm new password'),
      'new-pw-123'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(made(/\/api\/auth\/password\/change\/$/, 'POST')).toBe(true)
    );
    expect(requestBody(/\/api\/auth\/password\/change\/$/, 'POST')).toEqual({
      old_password: 'old-pw',
      new_password1: 'new-pw-123',
      new_password2: 'new-pw-123',
    });
    expect(await screen.findByText('Your password has been changed.')).toBeTruthy();
  });
});

describe('DeleteAccountSection', () => {
  async function openModal() {
    await renderWithClient(<DeleteAccountSection />);
    await fireEvent.press(screen.getByText('Delete my account…'));
  }

  it('POSTs the password then signs out', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    await openModal();

    await fireEvent.changeText(screen.getByLabelText('Password'), 'my-pw');
    await fireEvent.press(screen.getByText('Delete forever'));

    await waitFor(() =>
      expect(made(/\/api\/account\/delete\/$/, 'POST')).toBe(true)
    );
    expect(requestBody(/\/api\/account\/delete\/$/, 'POST')).toEqual({
      password: 'my-pw',
    });
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
  });

  it('shows the error and does not sign out when the password is wrong', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: 'Incorrect password.' }, 403)
    );
    await openModal();

    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByText('Delete forever'));

    expect(await screen.findByText('Incorrect password.')).toBeTruthy();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('FeedPreferencesSection', () => {
  it('reflects the current preference', async () => {
    mockIncludeGroups = true;
    await renderWithClient(<FeedPreferencesSection />);

    expect(
      screen.getByLabelText('Show group posts in your feed').props.value
    ).toBe(true);
  });

  it('writes the flipped value back through the preference setter', async () => {
    await renderWithClient(<FeedPreferencesSection />);

    const toggle = screen.getByLabelText('Show group posts in your feed');
    await act(async () => fireEvent(toggle, 'valueChange', true));

    expect(mockSetIncludeGroups).toHaveBeenCalledWith(true);
  });
});
