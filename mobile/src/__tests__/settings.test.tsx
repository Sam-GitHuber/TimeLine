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

import SettingsScreen from '@/app/settings';
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
import { DeleteAccountSection } from '@/components/settings/DeleteAccountSection';
import { FeedPreferencesSection } from '@/components/settings/FeedPreferencesSection';
import { NotificationPreferencesSection } from '@/components/settings/NotificationPreferencesSection';
import { PrivacySection } from '@/components/settings/PrivacySection';

import {
  androidIt,
  captureBackHandler,
  holdRequest,
  pressBack,
  settle,
  switchValue,
} from './helpers';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  // Spread first: this suite mounts the whole Settings screen, and a factory
  // that replaced the module wholesale would leave every other export
  // `undefined` — which renders as a blank tree rather than as an error, and
  // takes every test after it down with the broken act scope.
  ...jest.requireActual('expo-router'),
  // Focus is a plain effect under test, and there is no navigator to take the
  // swipe option — the stand-ins `jest.setup.js` installs globally, repeated
  // because this factory overrides them.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  useNavigation: () => ({ setOptions: () => {} }),
  router: {
    back: (...args: unknown[]) => mockBack(...args),
    replace: jest.fn(),
    canGoBack: () => true,
  },
}));

// The legal rows open the web app's own hosted pages in an in-app browser; the
// whole screen is mounted below, so the native module needs a stand-in.
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const mockSignOut = jest.fn();
const mockRefreshUser = jest.fn();
// `send_read_receipts` comes off the auth user rather than its own fetch — it
// rides on the "who am I" payload the app already holds (Phase 9b M4).
let mockUser: { send_read_receipts: boolean } | null = {
  send_read_receipts: true,
};
jest.mock('@/auth', () => ({
  ...jest.requireActual('@/auth'),
  useAuth: () => ({
    signOut: mockSignOut,
    refreshUser: mockRefreshUser,
    user: mockUser,
  }),
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
  mockRefreshUser.mockReset();
  mockBack.mockReset();
  mockIncludeGroups = false;
  mockUser = { send_read_receipts: true };
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
    expect(switchValue(replies)).toBe(true);
    expect(
      switchValue(screen.getByLabelText('Reactions to your posts and comments'))
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

  // --- A load that fails (#317) ---------------------------------------------

  it('says the settings didn’t load rather than showing no settings', async () => {
    // The whole family: only `mutation.isError` was ever rendered, so a failed
    // GET left the heading and its blurb over zero toggles — which reads as
    // "there are no settings", not "we couldn't load them".
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Server error.' }, 500));
    await renderWithClient(<NotificationPreferencesSection />);

    expect(await screen.findByText('Server error.')).toBeTruthy();
    // And a way to ask again — without one the only recovery was to guess that
    // leaving Settings and coming back might help.
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('retries the load when asked', async () => {
    let calls = 0;
    mockFetch.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ detail: 'Server error.' }, 500)
        : jsonResponse({ post_reply: true });
    });
    await renderWithClient(<NotificationPreferencesSection />);

    await fireEvent.press(await screen.findByText('Try again'));

    expect(await screen.findByLabelText('Replies to your posts')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('keeps the toggles when a refresh fails', async () => {
    // `isError && !prefs`, not a bare `isError`: the switches you are looking at
    // stay put when a refetch behind them fails.
    let calls = 0;
    mockFetch.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ post_reply: true })
        : jsonResponse({ detail: 'Server error.' }, 500);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <NotificationPreferencesSection />
        </QueryClientProvider>
      );
    });
    await screen.findByLabelText('Replies to your posts');

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['notificationPreferences'],
      });
    });
    await settle(2);

    expect(screen.getByLabelText('Replies to your posts')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
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

  /**
   * Android back collapses the form rather than leaving Settings (#168).
   *
   * The form is inline, not a Modal, so the press fell through to the tab
   * navigator — abandoning a half-filled password change *and* the screen, when
   * the user only meant the first.
   */
  androidIt('collapses the form on Android back, staying in Settings', async () => {
    captureBackHandler();
    await openForm();
    await fireEvent.changeText(screen.getByLabelText('Current password'), 'old-pw');

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    expect(screen.queryByLabelText('Current password')).toBeNull();
    // Collapsed back to the section's own affordance, still on the page.
    expect(screen.getByText('Change password…')).toBeTruthy();
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

  /**
   * Offline, the sentence written for offline is the one that shows (#243).
   *
   * This is the sharpest instance of that bug in the app. The fields don't clear
   * (only the success path clears them), and the red line used to read `Network
   * request failed` — indistinguishable from the server having rejected the
   * change. Which password the account now has becomes a guess, and the next
   * login is where you find out.
   */
  it('says its own sentence when the request never left the phone', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await openForm();

    await fireEvent.changeText(screen.getByLabelText('Current password'), 'old-pw');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'new-pw-123');
    await fireEvent.changeText(
      screen.getByLabelText('Confirm new password'),
      'new-pw-123'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Couldn’t change your password.')).toBeTruthy();
    expect(screen.queryByText('Network request failed')).toBeNull();
  });

  it('still shows the server’s own words when the server answered', async () => {
    // The other half of the guard: `serverMessage` must not flatten a real
    // refusal into the generic line. "Your old password was entered
    // incorrectly" is the whole diagnosis, and only the server can give it.
    mockFetch.mockResolvedValue(
      jsonResponse({ old_password: ['Your old password was entered incorrectly.'] }, 400)
    );
    await openForm();

    await fireEvent.changeText(screen.getByLabelText('Current password'), 'wrong');
    await fireEvent.changeText(screen.getByLabelText('New password'), 'new-pw-123');
    await fireEvent.changeText(
      screen.getByLabelText('Confirm new password'),
      'new-pw-123'
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));

    expect(
      await screen.findByText('Your old password was entered incorrectly.')
    ).toBeTruthy();
  });

  /**
   * Nothing collapses the form while the POST is out (#256).
   *
   * This is the sharpest case in that family, because it leaves you wrong about
   * your own credentials: the 400 of *"Your old password was entered
   * incorrectly"* renders inside this form and nowhere else, so a route that
   * takes the form off screen takes the sentence with it — and you go on
   * believing your password is the new one.
   *
   * Abandoning a half-*filled* password change is what the back handler is for
   * and stays fine; a half-*sent* one is the bug.
   */
  describe('holding the form open until the server answers', () => {
    const REFUSAL = 'Your old password was entered incorrectly.';

    async function startSaving() {
      await fireEvent.changeText(screen.getByLabelText('Current password'), 'old-pw');
      await fireEvent.changeText(screen.getByLabelText('New password'), 'new-pw-123');
      await fireEvent.changeText(
        screen.getByLabelText('Confirm new password'),
        'new-pw-123'
      );

      const server = holdRequest(mockFetch, { old_password: [REFUSAL] }, 400);
      // Braced, not a bare arrow: `handleSubmit` is `async`, so returning its
      // promise to `act` would wait on the very request this test is holding
      // open — and pressing outside `act` leaves its continuation to land in
      // whatever comes next.
      await act(async () => {
        fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
      });
      await server.inFlight('Saving…');
      return server;
    }

    it('refuses Close, then shows the refusal', async () => {
      await openForm();
      const server = await startSaving();

      await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByLabelText('Current password')).toBeTruthy();

      await server.refuse();
      expect(await screen.findByText(REFUSAL)).toBeTruthy();
    });

    androidIt('refuses hardware back, then shows the refusal', async () => {
      captureBackHandler();
      await openForm();
      const server = await startSaving();

      await act(async () => {
        // Claimed, not passed on: falling through would leave Settings too.
        expect(pressBack()).toBe(true);
      });
      expect(screen.getByLabelText('Current password')).toBeTruthy();

      await server.refuse();
      expect(await screen.findByText(REFUSAL)).toBeTruthy();
    });

    it('refuses the Settings screen’s Back, two levels above the request', async () => {
      // The screen's Back is the route the section itself can't see. A
      // declaration reaches only the nearest hold, so this passes only because
      // the section's hold forwards itself to the screen's.
      mockFetch.mockResolvedValue(jsonResponse({}, 200));
      await renderWithClient(<SettingsScreen />);
      await fireEvent.press(screen.getByText('Change password…'));
      const server = await startSaving();

      await fireEvent.press(screen.getByLabelText('Back'));
      expect(mockBack).not.toHaveBeenCalled();

      await server.refuse();
      expect(await screen.findByText(REFUSAL)).toBeTruthy();
    });
  });
});

/**
 * The other two sections that report a refusal inside themselves and nowhere
 * else (#256). Both are one-line declarations into the same hold the change-
 * password form uses; what they need pinning for is that leaving Settings while
 * a toggle is saving would take the message with it.
 */
describe('leaving Settings while a section is saving', () => {
  async function renderScreen() {
    mockFetch.mockResolvedValue(jsonResponse({ reaction: true }, 200));
    await renderWithClient(<SettingsScreen />);
  }

  it('refuses Back while read receipts are saving, then says it failed', async () => {
    // A privacy setting you believe you changed and haven't: you go on
    // broadcasting when you've read people's messages.
    await renderScreen();
    const server = holdRequest(mockFetch, { detail: 'Nope.' }, 500);
    await act(async () => {
      fireEvent(screen.getByLabelText('Send read receipts'), 'valueChange', false);
    });

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();

    await server.refuse();
    expect(
      await screen.findByText('Couldn’t save that. Please try again.')
    ).toBeTruthy();
  });

  androidIt('refuses hardware back while read receipts are saving', async () => {
    // The section registers no `useAndroidBack` of its own — only
    // `ChangePasswordSection` does, and only while its accordion is open — so
    // without the screen's registration this press is unclaimed and pops
    // Settings, which is the swallow all over again.
    captureBackHandler();
    await renderScreen();
    const server = holdRequest(mockFetch, { detail: 'Nope.' }, 500);
    await act(async () => {
      fireEvent(screen.getByLabelText('Send read receipts'), 'valueChange', false);
    });

    await act(async () => {
      expect(pressBack()).toBe(true);
    });

    await server.refuse();
    expect(
      await screen.findByText('Couldn’t save that. Please try again.')
    ).toBeTruthy();
  });

  it('refuses Back while a notification preference is saving', async () => {
    await renderScreen();
    const toggle = await screen.findByLabelText(
      'Reactions to your posts and comments'
    );
    const server = holdRequest(mockFetch, { detail: 'Nope.' }, 500);
    await act(async () => {
      fireEvent(toggle, 'valueChange', false);
    });
    // React Query dispatches `isPending` through its notify manager, so it
    // lands a macrotask after the flip — press Back before that and nothing
    // below is being tested. (`toBeDisabled` can't stand in here: RN's Switch
    // doesn't put `disabled` into `accessibilityState`.)
    await settle(1);

    await fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();

    await server.refuse();
    expect(
      await screen.findByText('Couldn’t save that preference. Please try again.')
    ).toBeTruthy();
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

  // #243, on the one irreversible action in the app. Offline the modal used to
  // read `Network request failed`, which says nothing about whether the account
  // still exists — and this sentence is the only thing someone has to go on
  // before deciding whether to press Delete forever again.
  it('says its own sentence when the request never left the phone', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await openModal();

    await fireEvent.changeText(screen.getByLabelText('Password'), 'my-pw');
    await fireEvent.press(screen.getByText('Delete forever'));

    expect(await screen.findByText('Couldn’t delete your account.')).toBeTruthy();
    expect(screen.queryByText('Network request failed')).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  // Issue #254. The rejection — "wrong password", most often — renders inside
  // this modal, so dismissing it mid-request tears down the only thing that
  // could say why nothing happened, and leaves you unsure whether the account
  // you just asked to erase still exists. On Android it's one hardware-back
  // press away, which is why `onRequestClose` is in here too.
  it('holds every way out shut while the delete is in flight', async () => {
    let settle: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    await openModal();
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    // Deliberately not awaited: `fireEvent` hands back the handler's own
    // promise, and this one is the request we're keeping open — awaiting it
    // would hang the test rather than leave the modal mid-write.
    fireEvent.press(screen.getByText('Delete forever'));
    await waitFor(() =>
      expect(made(/\/api\/account\/delete\/$/, 'POST')).toBe(true)
    );

    // Android hardware back, the backdrop, and Cancel — the three routes out.
    // `requestClose` is fired at the backdrop and bubbles to the `Modal`'s
    // `onRequestClose`, which is what the OS calls on a hardware-back press.
    await fireEvent(screen.getByTestId('delete-account-backdrop'), 'requestClose');
    await fireEvent.press(screen.getByTestId('delete-account-backdrop'));
    await fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByText('Delete your account?')).toBeTruthy();

    // So the rejection has somewhere to land.
    await act(async () => {
      settle(jsonResponse({ detail: 'Incorrect password.' }, 403));
    });
    expect(await screen.findByText('Incorrect password.')).toBeTruthy();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  // The gate exists so a *rejection* has somewhere to land, so it has to let go
  // the moment the delete itself lands — before `signOut`, which makes its own
  // round trips and is the part that can hang. Holding it across that would
  // just move the trap rather than remove it.
  it('releases the gate once the delete lands, before signOut finishes', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    let finishSignOut: (value?: unknown) => void = () => {};
    mockSignOut.mockReturnValue(
      new Promise((resolve) => {
        finishSignOut = resolve;
      })
    );
    await openModal();

    await fireEvent.changeText(screen.getByLabelText('Password'), 'my-pw');
    // The press isn't awaited — `fireEvent` hands back the handler's own
    // promise and `signOut` is deliberately left hanging. `act` still flushes
    // the state updates the resolved delete makes on the way past.
    await act(async () => {
      fireEvent.press(screen.getByText('Delete forever'));
    });
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());

    // Still mid-teardown, and the modal now lets go.
    await fireEvent(screen.getByTestId('delete-account-backdrop'), 'requestClose');
    await waitFor(() =>
      expect(screen.queryByText('Delete your account?')).toBeNull()
    );
    finishSignOut();
  });
});

describe('FeedPreferencesSection', () => {
  it('reflects the current preference', async () => {
    mockIncludeGroups = true;
    await renderWithClient(<FeedPreferencesSection />);

    expect(
      switchValue(screen.getByLabelText('Show group posts in your feed'))
    ).toBe(true);
  });

  it('writes the flipped value back through the preference setter', async () => {
    await renderWithClient(<FeedPreferencesSection />);

    const toggle = screen.getByLabelText('Show group posts in your feed');
    await act(async () => fireEvent(toggle, 'valueChange', true));

    expect(mockSetIncludeGroups).toHaveBeenCalledWith(true);
  });
});

describe('PrivacySection (Phase 9b M4)', () => {
  it('renders the current setting from the auth user, with no fetch', async () => {
    // It rides on the "who am I" payload the app already holds, so opening
    // Settings costs nothing extra to show the right state.
    mockUser = { send_read_receipts: false };
    await renderWithClient(<PrivacySection />);

    expect(switchValue(screen.getByLabelText('Send read receipts'))).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('PATCHes the user endpoint and refreshes', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ send_read_receipts: false }));
    await renderWithClient(<PrivacySection />);

    await act(async () =>
      fireEvent(screen.getByLabelText('Send read receipts'), 'valueChange', false)
    );

    expect(made(/\/api\/auth\/user\//, 'PATCH')).toBe(true);
    expect(requestBody(/\/api\/auth\/user\//, 'PATCH')).toEqual({
      send_read_receipts: false,
    });
    // The auth user is the source of truth for the switch, so it has to be
    // re-read rather than assumed.
    expect(mockRefreshUser).toHaveBeenCalled();
  });

  it('says so when the save fails, and leaves the switch where it was', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 500));
    await renderWithClient(<PrivacySection />);

    await act(async () =>
      fireEvent(screen.getByLabelText('Send read receipts'), 'valueChange', false)
    );

    expect(await screen.findByText('Couldn’t save that. Please try again.')).toBeTruthy();
    // Not optimistic, deliberately: this one decides what the server discloses
    // about you, so showing it as off while it's still on would be the wrong
    // way round to be wrong.
    expect(switchValue(screen.getByLabelText('Send read receipts'))).toBe(true);
  });
});
