/**
 * Events — the organiser's *set* surface (Phase 9 E3c-a).
 *
 * Pins the write paths this milestone adds: planning an event (create → open
 * it), the chip Set/Change → the dimension editor → **finalise** (a built-in
 * value written directly — date via the native picker, location via text), and
 * cancel/delete behind a confirm. Plus the two gates: the Set affordance shows
 * only for the organiser (`can_manage`), cancel/delete only for a moderator
 * (`can_moderate`).
 *
 * The native date picker is stubbed in `jest.setup.js` to fire `onChange` with a
 * fixed date (2026-08-15) when pressed, so "the organiser picked a value" is
 * deterministic. The poll builder is E3c-b and isn't exercised here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { api } from '@/api';
import EventScreen from '@/app/events/[eventId]';
import GroupScreen from '@/app/groups/[groupId]';
import { AuthProvider } from '@/auth';
import { PlanEventForm } from '@/components/events/PlanEventForm';
import { saveTokens } from '@/tokens';
import type { Event, Group, User } from '@/types';

const mockParams: Record<string, string> = { eventId: '9', groupId: '7' };
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  // Arrows read the spies lazily (the factory runs before the consts init).
  router: {
    push: (...a: unknown[]) => mockPush(...a),
    replace: (...a: unknown[]) => mockReplace(...a),
    back: jest.fn(),
    canGoBack: () => true,
  },
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

const GROUP: Group = {
  id: 7,
  name: 'The Andersons',
  description: 'Family group',
  avatar_url: null,
  avatar_thumb: null,
  member_count: 4,
  your_role: 'member',
  created_at: '2026-07-01T10:00:00Z',
};

// A blank-slate event: nothing decided, no polls — so every built-in chip is
// `unset` and (for the organiser) shows "Set".
function planningEvent(overrides: Partial<Event> = {}): Event {
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

function serveEvent(event: Event) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/auth/user/')) return jsonResponse(ME);
    if (url.includes('/api/events/9/')) return jsonResponse(event);
    return jsonResponse(null, 404);
  });
}

async function renderWith(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{node}</AuthProvider>
      </QueryClientProvider>
    );
  });
}

beforeEach(async () => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockReplace.mockReset();
  mockParams.eventId = '9';
  mockParams.groupId = '7';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  await saveTokens({ access: 'a', refresh: 'r' });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// --- Plan an event ---------------------------------------------------------

describe('PlanEventForm', () => {
  it('creates an event from a title and opens it', async () => {
    const create = jest
      .spyOn(api, 'createEvent')
      .mockResolvedValue(planningEvent({ id: 42 }));

    await renderWith(<PlanEventForm groupId={7} />);

    await fireEvent.changeText(
      screen.getByLabelText('What are you planning?'),
      'Grandma’s 80th'
    );
    await fireEvent.press(screen.getByText('Plan an event'));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(7, { title: 'Grandma’s 80th', description: '' })
    );
    // Straight to the new event, replacing (not pushing) so Back → the group.
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/events/42'));
    create.mockRestore();
  });

  it('won’t submit an empty title', async () => {
    const create = jest.spyOn(api, 'createEvent');
    await renderWith(<PlanEventForm groupId={7} />);

    await fireEvent.press(screen.getByText('Plan an event'));

    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });
});

// --- Set a dimension (finalise) --------------------------------------------

describe('setting a dimension', () => {
  it('finalises a date the organiser picks', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockResolvedValue(planningEvent());

    await renderWith(<EventScreen />);

    // Open the date editor, "pick" a value (the stub fires 2026-08-15), commit.
    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await fireEvent.press(screen.getByLabelText('Pick a value'));
    await fireEvent.press(screen.getByText('Set the date'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'date', value: '2026-08-15' })
    );
    finalise.mockRestore();
  });

  it('finalises a typed location', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockResolvedValue(planningEvent());

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Where'));
    await fireEvent.changeText(screen.getByLabelText('Set the place'), 'The Oakhouse');
    await fireEvent.press(screen.getByText('Set the place'));

    await waitFor(() =>
      expect(finalise).toHaveBeenCalledWith(9, { dimension: 'location', value: 'The Oakhouse' })
    );
    finalise.mockRestore();
  });

  it('offers Change on an already-set chip and opens its editor', async () => {
    // A date-decided event: the date chip is `set`, so the organiser sees Change.
    serveEvent(
      planningEvent({
        event_date: '2026-08-15',
        dimensions: {
          date: { state: 'set', poll: null },
          time: { state: 'unset', poll: null },
          location: { state: 'unset', poll: null },
        },
      })
    );

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Change Date'));
    // The editor opened — its native picker stub is on screen.
    expect(await screen.findByLabelText('Pick a value')).toBeTruthy();
  });

  it('surfaces a finalise failure in an alert and keeps the editor open', async () => {
    serveEvent(planningEvent());
    const finalise = jest
      .spyOn(api, 'finaliseDimension')
      .mockRejectedValue(new Error('Server said no'));
    const alert = jest.spyOn(Alert, 'alert');

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByLabelText('Set Date'));
    await fireEvent.press(screen.getByLabelText('Pick a value'));
    await fireEvent.press(screen.getByText('Set the date'));

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Couldn’t save', 'Server said no')
    );
    // The editor stays open on error so the organiser can retry.
    expect(screen.getByText('Set the date')).toBeTruthy();
    finalise.mockRestore();
    alert.mockRestore();
  });

  it('offers no Set affordance to a non-organiser', async () => {
    serveEvent(planningEvent({ can_manage: false, can_moderate: false }));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByLabelText('Set Date')).toBeNull();
    // …and the read-only chip still shows its status.
    expect(screen.getAllByText('not set').length).toBeGreaterThan(0);
  });
});

// --- Cancel / delete -------------------------------------------------------

describe('cancel and delete', () => {
  it('cancels the event after a confirm (moderator only)', async () => {
    serveEvent(planningEvent());
    const cancel = jest.spyOn(api, 'cancelEvent').mockResolvedValue(planningEvent());
    const alert = jest.spyOn(Alert, 'alert');

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Cancel event'));
    // The confirm Alert hands us its buttons; press the destructive one.
    await act(async () => {
      const buttons = alert.mock.calls.at(-1)?.[2] as { text?: string; onPress?: () => void }[];
      buttons?.find((b) => b.text === 'Cancel event')?.onPress?.();
    });

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(9));
    cancel.mockRestore();
    alert.mockRestore();
  });

  it('deletes the event after a confirm (moderator only)', async () => {
    serveEvent(planningEvent());
    const del = jest.spyOn(api, 'deleteEvent').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert');

    await renderWith(<EventScreen />);

    await fireEvent.press(await screen.findByText('Delete event'));
    // The confirm Alert hands us its buttons; press the destructive one.
    await act(async () => {
      const buttons = alert.mock.calls.at(-1)?.[2] as { text?: string; onPress?: () => void }[];
      buttons?.find((b) => b.text === 'Delete')?.onPress?.();
    });

    await waitFor(() => expect(del).toHaveBeenCalledWith(9));
    del.mockRestore();
    alert.mockRestore();
  });

  it('hides cancel/delete from a non-moderator', async () => {
    serveEvent(planningEvent({ can_manage: false, can_moderate: false }));

    await renderWith(<EventScreen />);
    await screen.findByText('Summer camping weekend');

    expect(screen.queryByText('Cancel event')).toBeNull();
    expect(screen.queryByText('Delete event')).toBeNull();
  });
});

// --- Group menu: Plan an event ---------------------------------------------

describe('group ⋯ menu', () => {
  it('routes "Plan an event" to the plan screen', async () => {
    const showActionSheet = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation(() => {});
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/user/')) return jsonResponse(ME);
      if (url.includes('/api/groups/7/posts/')) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes('/api/groups/7/events/')) return jsonResponse([]);
      if (url.includes('/api/groups/7/')) return jsonResponse(GROUP);
      return jsonResponse(null, 404);
    });

    await renderWith(<GroupScreen />);
    await fireEvent.press(await screen.findByLabelText('Group actions'));

    const [config, cb] = showActionSheet.mock.calls.at(-1) as [
      { options: string[] },
      (i: number) => void,
    ];
    expect(config.options[0]).toBe('Plan an event');
    await act(async () => cb(0));

    expect(mockPush).toHaveBeenCalledWith('/groups/7/plan');
    showActionSheet.mockRestore();
  });
});
