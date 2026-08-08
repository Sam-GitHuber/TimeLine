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

import { settle } from './helpers';

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

/**
 * `failUserIds` are the user ids whose invite POST the server rejects with 400.
 *
 * `connections` stages the two #248 shapes: `'partial'` lands page one carrying
 * a `next` and 500s the page it points at; `'fail'` 500s the list outright. Both
 * failures are a macrotask late on purpose — a mock that rejects instantly
 * settles inside the same React batch as the render that fired it, which is not
 * how a real request behaves and would hide the loop (see `settle`).
 */
function serve({
  failUserIds = [] as number[],
  connections = 'ok' as 'ok' | 'partial' | 'fail',
  members = MEMBERS,
}: {
  failUserIds?: number[];
  connections?: 'ok' | 'partial' | 'fail';
  members?: GroupMember[];
} = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes('/api/users/?filter=connected')) {
      if (connections === 'fail' || (connections === 'partial' && url.includes('page=2'))) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: 'Server error.' }, 500);
      }
      if (connections === 'partial') {
        return jsonResponse({
          count: 2,
          next: 'http://localhost:8000/api/users/?filter=connected&page=2',
          previous: null,
          // Only Ada fits on page one; the person you're looking for is on the
          // page that never arrives.
          results: [CONNECTIONS[0]],
        });
      }
      return jsonResponse(page(CONNECTIONS));
    }
    if (url.includes('/api/groups/7/members/') && init?.method === 'POST') {
      const { user_id } = JSON.parse(init.body ?? '{}');
      return failUserIds.includes(user_id)
        ? jsonResponse({ detail: 'Cannot invite this person.' }, 400)
        : jsonResponse(null, 204);
    }
    if (url.includes('/api/groups/7/members/')) return jsonResponse(members);
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

it('stops paging your connections when a page fails, instead of looping on it', async () => {
  serve({ connections: 'partial' });
  await renderScreen();

  // What did land is still invitable — a stopped walk keeps its pages.
  expect(await screen.findByLabelText('Ada Lovelace')).toBeTruthy();
  // And says why it might be short. Without this, Bob's absence reads as "you
  // aren't connected to Bob" — a wrong answer rather than a missing one, whose
  // one suggested action is to go and request a connection you already have.
  expect(await screen.findByText('Couldn’t load your connections.')).toBeTruthy();

  // #248: the failure re-armed the effect that asked for the page — the server
  // never said there was no page 2, so `hasNextPage` stayed true, and
  // `isFetchingNextPage` going false again *is* the condition it waits for.
  await settle();
  expect(
    mockFetch.mock.calls.filter(([url]) => String(url).includes('page=2'))
  ).toHaveLength(1);
});

it('doesn’t claim everyone is already in the group when the load failed', async () => {
  // Nothing loaded at all: the empty state is the same lie in stronger terms,
  // since the truth is that we failed to ask.
  serve({ connections: 'fail' });
  await renderScreen();

  expect(await screen.findByText('Couldn’t load your connections.')).toBeTruthy();
  expect(
    screen.queryByText('Everyone you’re connected with is already in this group.')
  ).toBeNull();
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

// --- A roster we don't have (#317) ------------------------------------------

/**
 * The roster is what filters this picker, so failing to load it produces a
 * **wrong** list rather than a short one — and then the Invite button acted on
 * it. `(membersQuery.data ?? [])` turned "we couldn't ask who's in this group"
 * into "this group has nobody in it", so people already in the group were
 * offered, ticked, and invited: the tally came back "Invited 0 of 3".
 *
 * The web's twin is `GroupPage`'s "Start a chat" (#314).
 */
describe('when the member roster doesn’t load', () => {
  /** The roster GET fails; connections and the invite POST keep working. */
  function breakTheRoster() {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        if (!url.includes('/api/groups/7/members/') || init?.method === 'POST') {
          return base(url, init);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: 'Server error.' }, 500);
      }
    );
  }

  it('says the list may include people who are already members', async () => {
    serve();
    breakTheRoster();
    await renderScreen();

    // Before the tick, not after the "Invited 0 of 3": nothing about the rows
    // themselves shows that the filter never ran.
    expect(
      await screen.findByText(
        /Couldn’t check who’s already in this group/
      )
    ).toBeTruthy();
  });

  it('refuses to invite rather than firing at an unfiltered list', async () => {
    serve();
    breakTheRoster();
    await renderScreen();

    await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
    await fireEvent.press(screen.getByLabelText('Invite'));
    await settle(2);

    // Not one invite went out, and the refusal says why.
    expect(invitePosts()).toHaveLength(0);
    expect(alertSpy).toHaveBeenCalledWith(
      'Couldn’t check who’s already in this group',
      expect.stringContaining('may already be members')
    );
    // The picker stays open, and the refusal asks the server again itself.
    expect(router.back).not.toHaveBeenCalled();
  });

  it('takes existing members out of the pool when the roster does land', async () => {
    // The premise the rest of this block rests on. With the default fixtures the
    // only member is you (id 1) and the connections are 2 and 3, so the filter
    // removes nobody and every assertion around it would pass with `memberIds`
    // deleted outright.
    serve({
      members: [
        ...MEMBERS,
        {
          user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
          role: 'member',
        },
      ],
    });
    await renderScreen();

    expect(await screen.findByLabelText('Bob Newman')).toBeTruthy();
    expect(screen.queryByLabelText('Ada Lovelace')).toBeNull();
  });

  it('doesn’t invite someone the arriving roster turns out to have', async () => {
    // The refusal alone only *delays* the wrong write. Ada is ticked off the
    // unfiltered list; the roster then lands and says she's already a member, so
    // she leaves the list — and a selection read straight off the ticks would
    // still carry her into the POSTs, which is "Invited 1 of 2" for exactly the
    // reason this screen was fixed.
    const withAda: GroupMember[] = [
      ...MEMBERS,
      {
        user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null },
        role: 'member',
      },
    ];
    serve({ members: withAda });
    const base = mockFetch.getMockImplementation()!;
    let rosterCalls = 0;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        const isRoster =
          url.includes('/api/groups/7/members/') && init?.method !== 'POST';
        if (isRoster) rosterCalls += 1;
        if (isRoster && rosterCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return jsonResponse({ detail: 'Server error.' }, 500);
        }
        return base(url, init);
      }
    );
    await renderScreen();

    // Unfiltered, so Ada is offered even though she's in the group.
    await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
    await fireEvent.press(await screen.findByLabelText('Bob Newman'));
    // Refused, and the refusal refetches the roster.
    await fireEvent.press(screen.getByLabelText('Invite'));
    await settle(2);
    expect(invitePosts()).toHaveLength(0);

    // Ada is gone from the list now, and must be gone from the selection too.
    expect(screen.queryByLabelText('Ada Lovelace')).toBeNull();
    expect(screen.getByText('1 selected')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Invite'));
    await waitFor(() => expect(invitePosts()).toHaveLength(1));
    expect(JSON.parse(invitePosts()[0][1].body)).toEqual({ user_id: 3 });
  });

  it('still says a search matched nothing', async () => {
    // The suppressed empty state is only about the *pool* being empty — that's
    // the claim a missing roster makes unsafe. A search that matches none of a
    // pool we do have is an answer we can stand behind, and swallowing it leaves
    // a blank area under the banner with nothing said at all.
    serve();
    breakTheRoster();
    await renderScreen();
    await screen.findByLabelText('Ada Lovelace');

    await fireEvent.changeText(
      screen.getByLabelText('Search your connections'),
      'zzz'
    );

    expect(screen.getByText('No connections match “zzz”.')).toBeTruthy();
  });

  it('invites normally once the roster arrives', async () => {
    // The refusal is about the missing roster, not a dead button: the retry it
    // fires off must put the screen back in working order.
    serve();
    const base = mockFetch.getMockImplementation()!;
    let rosterCalls = 0;
    mockFetch.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        const isRoster =
          url.includes('/api/groups/7/members/') && init?.method !== 'POST';
        if (isRoster) rosterCalls += 1;
        if (isRoster && rosterCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return jsonResponse({ detail: 'Server error.' }, 500);
        }
        return base(url, init);
      }
    );
    await renderScreen();

    await fireEvent.press(await screen.findByLabelText('Ada Lovelace'));
    await fireEvent.press(screen.getByLabelText('Invite'));
    await settle(2);
    expect(invitePosts()).toHaveLength(0);

    // The refetch the refusal fired has landed by now; pressing again works.
    await fireEvent.press(screen.getByLabelText('Invite'));
    await waitFor(() => expect(invitePosts()).toHaveLength(1));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
  });
});
