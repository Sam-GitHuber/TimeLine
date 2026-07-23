/**
 * Events — the organiser's poll surface (Phase 9 E3c-b).
 *
 * Pins the poll write paths: opening a poll on a dimension (built-in + custom),
 * finalising from the tally (a built-in value, or pinning a custom option), and
 * the lifecycle behind the ⋯ menu (close / remove, and that **Edit is offered
 * only while the poll has no votes** — the client mirror of the server's 409).
 *
 * The native date picker is stubbed in `jest.setup.js` to fire a fixed date on
 * press, so building a date-poll option is deterministic.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { api } from '@/api';
import EventScreen from '@/app/events/[eventId]';
import { AuthProvider } from '@/auth';
import { saveTokens } from '@/tokens';
import type { Event, Poll, User } from '@/types';

const mockParams: Record<string, string> = { eventId: '9' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
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

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 9,
    group: { id: 7, name: 'The Andersons' },
    organiser: { id: 1, display_name: 'Me Myself', avatar_thumb: null },
    title: 'Summer camping weekend',
    description: '',
    event_date: null,
    start_time: null,
    end_time: null,
    timezone: 'Europe/London',
    location_name: '',
    location_url: '',
    location_note: '',
    status: 'planning',
    is_past: false,
    starts_at: null,
    dimensions: {
      date: { state: 'unset', poll: null },
      time: { state: 'unset', poll: null },
      location: { state: 'unset', poll: null },
    },
    rsvp: {
      counts: { going: 0, maybe: 0, declined: 0, guests: 0 },
      your_response: null,
      going_list: [],
      maybe_list: [],
      declined_list: [],
    },
    can_manage: true,
    can_moderate: true,
    created_at: '2026-07-18T10:00:00Z',
    updated_at: '2026-07-18T10:00:00Z',
    polls: [],
    ...overrides,
  };
}

function locationPoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 5,
    event: 9,
    dimension: 'location',
    question: 'Where should we meet?',
    allow_multiple: false,
    status: 'open',
    closes_at: null,
    created_at: '2026-07-18T10:00:00Z',
    options: [
      { id: 50, label: 'The park', date_value: null, time_value: null, text_value: 'The park', order: 0, count: 0, voters: [], you_voted: false },
      { id: 51, label: 'The pub', date_value: null, time_value: null, text_value: 'The pub', order: 1, count: 0, voters: [], you_voted: false },
    ],
    vote_count: 0,
    your_votes: [],
    decided_option: null,
    ...overrides,
  };
}

function customPoll(overrides: Partial<Poll> = {}): Poll {
  return {
    id: 6,
    event: 9,
    dimension: 'custom',
    question: 'What should we bring?',
    allow_multiple: false,
    status: 'open',
    closes_at: null,
    created_at: '2026-07-18T10:00:00Z',
    options: [
      { id: 60, label: 'Snacks', date_value: null, time_value: null, text_value: 'Snacks', order: 0, count: 0, voters: [], you_voted: false },
      { id: 61, label: 'Drinks', date_value: null, time_value: null, text_value: 'Drinks', order: 1, count: 0, voters: [], you_voted: false },
    ],
    vote_count: 0,
    your_votes: [],
    decided_option: null,
    ...overrides,
  };
}

function serve(event: Event) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/events/9/')) return jsonResponse(event);
    return jsonResponse(null, 404);
  });
}

async function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <EventScreen />
        </AuthProvider>
      </QueryClientProvider>
    );
  });
}

const showActionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions');

beforeEach(async () => {
  mockFetch.mockReset();
  showActionSheet.mockReset().mockImplementation(() => {});
  mockParams.eventId = '9';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  await saveTokens({ access: 'a', refresh: 'r' });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// --- Opening a poll --------------------------------------------------------

describe('opening a poll', () => {
  it('opens a date poll from the chip', async () => {
    serve(makeEvent());
    const open = jest.spyOn(api, 'openPoll').mockResolvedValue(locationPoll());

    await renderScreen();

    // Chip → poll builder for the date dimension.
    await fireEvent.press(await screen.findByLabelText('Poll Date'));
    // Each date option is a picker row; tapping it reveals the (stubbed) picker,
    // which commits the fixed 2026-08-15 on press.
    await fireEvent.press(screen.getByLabelText('Option 1'));
    await fireEvent.press(screen.getByLabelText('Pick a value'));
    await fireEvent.press(screen.getByLabelText('Option 2'));
    await fireEvent.press(screen.getByLabelText('Pick a value'));
    await fireEvent.press(screen.getByText('Open poll'));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          dimension: 'date',
          allowMultiple: true, // date default is pick-any
          options: [{ date_value: '2026-08-15' }, { date_value: '2026-08-15' }],
        })
      )
    );
    open.mockRestore();
  });

  it('opens a custom poll from "Ask the group something else"', async () => {
    serve(makeEvent());
    const open = jest.spyOn(api, 'openPoll').mockResolvedValue(customPoll());

    await renderScreen();

    await fireEvent.press(await screen.findByText('+ Ask the group something else'));
    await fireEvent.changeText(screen.getByLabelText('Poll question'), 'What to bring?');
    await fireEvent.changeText(screen.getByLabelText('Option 1'), 'Snacks');
    await fireEvent.changeText(screen.getByLabelText('Option 2'), 'Drinks');
    await fireEvent.press(screen.getByText('Open poll'));

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          dimension: 'custom',
          question: 'What to bring?',
          options: [{ text_value: 'Snacks' }, { text_value: 'Drinks' }],
        })
      )
    );
    open.mockRestore();
  });
});

// --- Finalising from the tally ---------------------------------------------

describe('finalising from a poll', () => {
  it('sets a built-in dimension from an option', async () => {
    serve(makeEvent({ polls: [locationPoll()], dimensions: { date: { state: 'unset', poll: null }, time: { state: 'unset', poll: null }, location: { state: 'polling', poll: 5 } } }));
    const finalise = jest.spyOn(api, 'finaliseDimension').mockResolvedValue(makeEvent());

    await renderScreen();

    await fireEvent.press(await screen.findByLabelText('Set The park'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'location', value: 'The park' })
    );
    finalise.mockRestore();
  });

  it('pins a custom option', async () => {
    serve(makeEvent({ polls: [customPoll()] }));
    const finalise = jest.spyOn(api, 'finaliseDimension').mockResolvedValue(makeEvent());

    await renderScreen();

    await fireEvent.press(await screen.findByLabelText('Pin Snacks'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'custom', optionId: 60 })
    );
    finalise.mockRestore();
  });
});

// --- Poll lifecycle (the ⋯ menu) -------------------------------------------

describe('poll lifecycle', () => {
  it('closes a poll from the menu', async () => {
    serve(makeEvent({ polls: [locationPoll()] }));
    const close = jest.spyOn(api, 'closePoll').mockResolvedValue(locationPoll({ status: 'closed' }));

    await renderScreen();
    await fireEvent.press(await screen.findByLabelText('Poll options'));

    const [config, cb] = showActionSheet.mock.calls.at(-1) as [{ options: string[] }, (i: number) => void];
    await act(async () => cb(config.options.indexOf('Close poll')));

    await waitFor(() => expect(close).toHaveBeenCalledWith(5));
    close.mockRestore();
  });

  it('removes a poll after a confirm', async () => {
    serve(makeEvent({ polls: [locationPoll()] }));
    const del = jest.spyOn(api, 'deletePoll').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert');

    await renderScreen();
    await fireEvent.press(await screen.findByLabelText('Poll options'));

    const [config, cb] = showActionSheet.mock.calls.at(-1) as [{ options: string[] }, (i: number) => void];
    await act(async () => cb(config.options.indexOf('Remove poll')));
    await act(async () => {
      const buttons = alert.mock.calls.at(-1)?.[2] as { text?: string; onPress?: () => void }[];
      buttons?.find((b) => b.text === 'Remove poll')?.onPress?.();
    });

    await waitFor(() => expect(del).toHaveBeenCalledWith(5));
    del.mockRestore();
    alert.mockRestore();
  });

  it('offers Edit only while the poll is unvoted', async () => {
    // A poll with votes locks its wording — the client hides Edit (the server 409s).
    serve(makeEvent({ polls: [locationPoll({ vote_count: 3 })] }));

    await renderScreen();
    await fireEvent.press(await screen.findByLabelText('Poll options'));

    const config = showActionSheet.mock.calls.at(-1)?.[0] as { options: string[] };
    expect(config.options).not.toContain('Edit poll');
  });

  it('edits an unvoted poll', async () => {
    serve(makeEvent({ polls: [customPoll()] }));
    const edit = jest.spyOn(api, 'editPoll').mockResolvedValue(customPoll());

    await renderScreen();
    await fireEvent.press(await screen.findByLabelText('Poll options'));

    const [config, cb] = showActionSheet.mock.calls.at(-1) as [{ options: string[] }, (i: number) => void];
    await act(async () => cb(config.options.indexOf('Edit poll')));

    // The edit form is the create form pre-filled. Change one option and save.
    await fireEvent.changeText(screen.getByLabelText('Option 2'), 'Cake');
    await fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(
        6,
        expect.objectContaining({
          question: 'What should we bring?',
          options: [
            { id: 60, text_value: 'Snacks' },
            { id: 61, text_value: 'Cake' },
          ],
        })
      )
    );
    edit.mockRestore();
  });
});
