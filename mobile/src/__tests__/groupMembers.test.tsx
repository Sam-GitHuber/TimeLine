/**
 * The group members roster (Phase 9 E3a) — admin management.
 *
 * Pins the admin controls that have real branching: promoting a member hits the
 * role endpoint, and — the regression this file exists to guard — **cancelling
 * the remove confirmation is a true no-op** (no `removeGroupMember` call, no
 * cache invalidation), while confirming it actually removes. A non-admin sees
 * the roster read-only, with no action sheet.
 *
 * It also pins the **self-remove fork** (#282). Removing your own row is the same
 * server call as the ⋯ menu's Leave, so it has to refresh what leaving refreshes
 * — membership gates the home feed (`groupCache.ts`) — and removing *someone
 * else* must not, since your own membership didn't change. And the **third**
 * branch (#290): removing someone else still cancels their events in this group
 * server-side, so the group's own event queries and the personal calendar move
 * even though the feed doesn't.
 *
 * Every gated surface is **mounted alongside** the roster rather than seeded into
 * the cache, because that's the situation the bug lives in: the tabs stay mounted
 * for the life of the session, so their queries keep a live observer and never
 * remount, and the group screen sits on the stack right behind this one. A seeded
 * but unobserved entry refetches on its next mount whatever we do, and would pass
 * against the broken build. Same reasoning as `groupActions.test.tsx`.
 *
 * The menu and the confirm dialog are captured, not driven natively: the shared
 * `./helpers` seam hands us the menu to pick an option from — an action sheet on
 * iOS, an `Alert` chooser on Android — and the button list to press on the
 * confirm, so these tests read identically on both platforms.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GroupMembersScreen from '@/app/groups/[groupId]/members';
import type { Group, GroupMember } from '@/types';

import {
  alertSpy,
  menuOptions,
  menuWasShown,
  pickMenuAction,
  pressAlertButton,
  resetMenuSpies,
} from './helpers';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: '7' }),
  router: { push: jest.fn(), back: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args) },
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

/**
 * Two admins — the shape the self-remove scenario needs, since the server's
 * last-admin guardrail refuses the sole admin's removal outright.
 */
const TWO_ADMINS: GroupMember[] = [
  MEMBERS[0],
  { user: { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null }, role: 'admin' },
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
  // The client comes back too, so a test can drive a *refetch* — the half of the
  // error rule that says a failed refresh keeps what's on screen (#321).
  return { invalidate, client: queryClient };
}


/** A tab elsewhere in the app, observing its query the way the real screen does. */
function MountedTab({
  queryKey,
  queryFn,
}: {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
}) {
  useQuery({ queryKey, queryFn });
  return null;
}

/**
 * The four queries the **group screen** holds while the roster sits on top of it
 * — expo-router keeps it mounted underneath, so every one of them has a live
 * observer throughout. `['groupEvents', 7, …]` carries the window suffix the real
 * screen uses, so a fix that invalidated the bare key as an *exact* key wouldn't
 * pass. `groupPosts` is here to be asserted **unchanged** (see #290 below).
 */
const GROUP_SCREEN_KEYS: Record<string, unknown[]> = {
  upcoming: ['groupEvents', 7, 'upcoming'],
  pastEvents: ['groupEvents', 7, 'past'],
  groupCalendar: ['groupCalendar', 7],
  groupPosts: ['groupPosts', 7],
  // Not the group screen's, but the same idea one screen further out. A
  // cancelled event keeps its detail page and its album — the tombstone is the
  // point (`groupCache.ts`) — so `['event', id]` would otherwise still render
  // Ada's picnic as a live plan with an RSVP bar. And the removal drops her from
  // the group's chats, which `['conversation', id]` shows and nothing polls.
  event: ['event', 12],
  eventPhotos: ['eventPhotos', 12],
  conversation: ['conversation', 5],
};

/**
 * The roster, with the membership-gated tabs mounted behind it — and optionally
 * whatever else the case needs observing (`alsoMounted`). Names there must be
 * fresh: silently replacing a base surface would delete a negative assertion
 * while leaving the suite green.
 *
 * `['feed', true]` carries the include-groups-in-feed suffix the real Home tab
 * uses, so a fix that invalidated the bare key as an *exact* key wouldn't pass.
 */
async function renderScreenOverTabs({
  members = MEMBERS,
  alsoMounted = {} as Record<string, unknown[]>,
} = {}) {
  serve({ members });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const tabs: Record<string, { key: unknown[]; fn: jest.Mock }> = {
    feed: { key: ['feed', true], fn: jest.fn(async () => null) },
    calendar: { key: ['personalCalendar'], fn: jest.fn(async () => []) },
    groups: { key: ['groups'], fn: jest.fn(async () => null) },
  };
  for (const [name, key] of Object.entries(alsoMounted)) {
    if (name in tabs) throw new Error(`alsoMounted would shadow "${name}"`);
    tabs[name] = { key, fn: jest.fn(async () => []) };
  }
  render(
    <QueryClientProvider client={queryClient}>
      {Object.entries(tabs).map(([name, tab]) => (
        <MountedTab key={name} queryKey={tab.key} queryFn={tab.fn} />
      ))}
      <GroupMembersScreen />
    </QueryClientProvider>
  );
  // Their first load, so a later call is unambiguously a refetch.
  const firstLoad = Object.fromEntries(Object.keys(tabs).map((name) => [name, 1]));
  await waitFor(() => expect(loadCounts(tabs)).toEqual(firstLoad));
  return { invalidate, tabs };
}

type Tabs = Awaited<ReturnType<typeof renderScreenOverTabs>>['tabs'];

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts(tabs: Tabs) {
  return Object.fromEntries(
    Object.entries(tabs).map(([name, tab]) => [name, tab.fn.mock.calls.length])
  );
}

function madeRequest(match: RegExp, method: string) {
  return mockFetch.mock.calls.some(
    ([url, init]) => match.test(String(url)) && (init?.method ?? 'GET') === method
  );
}

/**
 * Turn the event loop a few times, so an invalidation that *did* fire has had
 * room to reach its query — the only honest way to read the negative in the
 * "leaves the feed alone" tests, since a key that is correctly left alone
 * produces no signal of its own to wait for.
 *
 * Deliberately **not** `settle()` from `./helpers`, which is this idea wrapped in
 * `act()`; under this harness that `act` leaves the renderer in a state where the
 * next test's `render` mounts nothing at all. Nothing here needs React to
 * re-render, only the loop to turn (`groupActions.test.tsx` says the same).
 */
async function turnEventLoop(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mockFetch.mockReset();
  mockReplace.mockReset();
  resetMenuSpies();
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

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(0); // "Make admin"

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

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group" → confirm dialog
  pressAlertButton('Remove member?', 'Cancel');

  // The whole point of the fix: cancelling never touches the API or the cache.
  expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(false);
  expect(invalidate).not.toHaveBeenCalled();
});

it('removes a member when the confirmation is accepted', async () => {
  serve();
  await renderScreen();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group"
  pressAlertButton('Remove member?', 'Remove');

  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(true)
  );
});

it('refreshes the feed and the calendar when an admin removes their own row', async () => {
  const { tabs } = await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(1); // "Leave group"
  pressAlertButton('Leave group?', 'Leave');

  // The same endpoint the ⋯ menu's Leave calls, with your own id — the server
  // treats it as leaving (groups.md).
  await waitFor(() => expect(madeRequest(/\/api\/groups\/7\/members\/1\/$/, 'DELETE')).toBe(true));
  // #282: membership gates both of these, and on the app the lie is permanent —
  // the tabs never unmount, so nothing else marks the feed stale and it keeps
  // offering posts `can_view_post` will now refuse.
  await waitFor(() => expect(loadCounts(tabs)).toEqual({ feed: 2, calendar: 2, groups: 2 }));
  // And you don't stay on the roster of a group you've just left, whose own
  // queries would 404 from here on.
  expect(mockReplace).toHaveBeenCalledWith('/groups');
});

/**
 * #290 — **the roster and the events it silently cancels.**
 *
 * `GroupMemberDetailView.delete` ends with `cancel_events_on_departure`: an
 * event's visibility gate hangs off a *present* organiser, so removing someone
 * soft-cancels every event they organise in that group, in the same transaction.
 * The roster refreshed only its own three keys, so the group screen behind it
 * kept Ada's picnic on its upcoming spine and its Month grid, and the Calendar
 * tab kept listing it — permanently, since neither ever remounts. Only a
 * pull-to-refresh healed it.
 *
 * The `feed` and `groupPosts` counts are assertions in their own right, not
 * bookkeeping. #290 was filed believing a removal drops the member's *posts*
 * from the group timeline; the server doesn't do that.
 * `visible_posts(user, group=pk)` gates on the author being you or a connection
 * and still *active*, never on their membership, and `can_view_post` only asks
 * whether the **viewer** is a member. Ada's posts stay, and stay tappable.
 */
it('refreshes the events a removal cancels, and nothing it doesn’t', async () => {
  const { invalidate, tabs } = await renderScreenOverTabs({
    alsoMounted: GROUP_SCREEN_KEYS,
  });

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(1); // "Remove from group"
  pressAlertButton('Remove member?', 'Remove');

  await waitFor(() => expect(madeRequest(/\/api\/groups\/7\/members\/2\/$/, 'DELETE')).toBe(true));
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['groupMembers', 7] })
  );
  await waitFor(() =>
    expect(loadCounts(tabs)).toEqual({
      // Your own membership didn't change, and neither did who wrote what.
      feed: 1,
      groupPosts: 1,
      // Everything a cancellation moves — all five keys of an event write, not
      // the three the lists happen to sit on.
      calendar: 2,
      upcoming: 2,
      pastEvents: 2,
      groupCalendar: 2,
      event: 2,
      eventPhotos: 2,
      // She's dropped from the group's chats in the same transaction, and this
      // is the one messaging key nothing polls.
      conversation: 2,
      // The roster's own set — `['groups']` counts a member.
      groups: 2,
    })
  );
  expect(mockReplace).not.toHaveBeenCalled();
});

it('leaves the group’s events alone when you only change a role', async () => {
  const { tabs } = await renderScreenOverTabs({ alsoMounted: GROUP_SCREEN_KEYS });

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  pickMenuAction(0); // "Make admin"

  // A role change cancels nothing and moves no visibility boundary — only the
  // roster and the badge on it. `groups: 2` is the tell that the success handler
  // ran, so the untouched counts beside it are a real negative.
  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/2\/role\/$/, 'POST')).toBe(true)
  );
  await turnEventLoop();
  expect(loadCounts(tabs)).toEqual({
    feed: 1,
    calendar: 1,
    groups: 2,
    upcoming: 1,
    pastEvents: 1,
    groupCalendar: 1,
    groupPosts: 1,
    event: 1,
    eventPhotos: 1,
    conversation: 1,
  });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('leaves the feed and the calendar alone when you demote yourself', async () => {
  const { tabs } = await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(0); // "Make member" — your own row, but a role change

  // The fork is on the *action*, not just on whose row it is: giving up admin
  // keeps your membership, so it must not be treated as a leave.
  await waitFor(() =>
    expect(madeRequest(/\/api\/groups\/7\/members\/1\/role\/$/, 'POST')).toBe(true)
  );
  await turnEventLoop();
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 2 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('refreshes nothing when the server refuses the self-removal', async () => {
  const { tabs } = await renderScreenOverTabs({ members: MEMBERS });
  const listing = mockFetch.getMockImplementation()!;
  // The last-admin guardrail, which is exactly the state MEMBERS is in.
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
    /\/members\/\d+\/$/.test(url) && init?.method === 'DELETE'
      ? jsonResponse({ detail: 'Promote another member to admin first.' }, 400)
      : listing(url, init)
  );

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  pickMenuAction(1); // "Leave group"
  pressAlertButton('Leave group?', 'Leave');

  // The surfaced guardrail message is also the tell that the failure has settled,
  // so the counts below are read after the mutation finished rather than before
  // it started. Nothing changed on the server, so nothing is refreshed — and you
  // stay on the roster rather than being bounced out of a group you're still in.
  await waitFor(() =>
    expect(alertSpy.mock.calls.some(([title]) => title === 'Couldn’t do that')).toBe(true)
  );
  expect(loadCounts(tabs)).toEqual({ feed: 1, calendar: 1, groups: 1 });
  expect(mockReplace).not.toHaveBeenCalled();
});

it('calls the self row’s removal a leave, on the menu and the confirm', async () => {
  await renderScreenOverTabs({ members: TWO_ADMINS });

  await fireEvent.press(await screen.findByLabelText('Manage Me Myself'));
  expect(menuOptions()).toContain('Leave group');
  pickMenuAction(1);

  // Same wording as the ⋯ menu's Leave, which makes the identical call — a
  // dialog offering to "remove" you from a group by your own name reads as
  // something being done *to* you, and hides that you're about to navigate out.
  expect(alertSpy.mock.calls.some(([title]) => title === 'Leave group?')).toBe(true);
  pressAlertButton('Leave group?', 'Cancel');
  expect(madeRequest(/\/api\/groups\/7\/members\/1\/$/, 'DELETE')).toBe(false);
});

it('still calls someone else’s removal a removal', async () => {
  await renderScreenOverTabs();

  await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
  expect(menuOptions()).toContain('Remove from group');
});

it('is read-only for a non-admin (no action sheet)', async () => {
  serve({ role: 'member' });
  await renderScreen();

  const row = await screen.findByLabelText('Ada Lovelace');
  fireEvent.press(row);

  expect(menuWasShown()).toBe(false);
});

// --- An admin gate that couldn't be checked (#321) ---------------------------

/**
 * Your role comes from a **different query** than the roster does, and only the
 * roster's `isError` was ever read.
 *
 * So a failed group fetch beside a succeeding members fetch drew a complete,
 * healthy-looking list — right names, right Admin badges — in which nothing was
 * pressable. An admin taps a row to remove a spammer and gets no menu, no alert,
 * nothing at all: indistinguishable from having been quietly demoted. The screen
 * stated by omission "you are not an admin of this group", on the strength of a
 * dropped packet.
 */
describe('a roster whose group fetch failed', () => {
  /** The group detail fails; the members list keeps answering. */
  function breakTheGroup(members = MEMBERS) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/groups/7/members/')) return jsonResponse(members);
      if (url.includes('/api/groups/7/')) {
        // A macrotask late, as a real request is.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: 'Server error.' }, 500);
      }
      return jsonResponse(null, 204);
    });
  }

  it('says the role couldn’t be checked, rather than acting as if you’re not an admin', async () => {
    breakTheGroup();
    await renderScreen();

    expect(
      await screen.findByText(
        'Couldn’t check whether you manage this group, so the member actions aren’t available.'
      )
    ).toBeTruthy();
    // The roster itself loaded fine, which is what made the silence convincing.
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByLabelText('Try checking again')).toBeTruthy();
  });

  it('offers a retry that brings the member actions back', async () => {
    breakTheGroup();
    await renderScreen();
    await screen.findByLabelText('Try checking again');

    serve();
    await fireEvent.press(screen.getByLabelText('Try checking again'));

    await fireEvent.press(await screen.findByLabelText('Manage Ada Lovelace'));
    expect(menuOptions()).toContain('Remove from group');
  });

  it('says nothing when a *refresh* of the group fails', async () => {
    // `isError && !data`, never a bare `isError` (#309/#311): the role we
    // already know survives a failed poll, and the notice must not appear over
    // a roster that is still fully manageable.
    serve();
    const { client } = await renderScreen();
    await screen.findByLabelText('Manage Ada Lovelace');
    breakTheGroup();

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });
    await waitFor(() =>
      expect(client.getQueryState(['group', 7])?.status).toBe('error')
    );

    expect(
      screen.queryByText(
        'Couldn’t check whether you manage this group, so the member actions aren’t available.'
      )
    ).toBeNull();
    expect(screen.getByLabelText('Manage Ada Lovelace')).toBeTruthy();
  });

  it('doesn’t show the notice to a member whose group fetch worked', async () => {
    serve({ role: 'member' });
    await renderScreen();

    await screen.findByLabelText('Ada Lovelace');
    expect(
      screen.queryByText(
        'Couldn’t check whether you manage this group, so the member actions aren’t available.'
      )
    ).toBeNull();
  });
});

/**
 * Review findings on the above: one outage must not produce two error messages,
 * and a 404 has to outrank the cached role.
 */
describe('a roster whose group fetch failed — the other two states', () => {
  it('says nothing about the role when the roster didn’t load either', async () => {
    // The commonest outage — one box, one restart — takes both queries down.
    // The role notice is about rows that look manageable and aren't; with no
    // rows there is no such claim to correct, and stacking it over the members
    // card offers two Try-agains for one failure.
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return jsonResponse({ detail: 'Server error.' }, 500);
    });
    await renderScreen();

    expect(await screen.findByText('Couldn’t load members.')).toBeTruthy();
    expect(
      screen.queryByText(
        'Couldn’t check whether you manage this group, so the member actions aren’t available.'
      )
    ).toBeNull();
  });

  it('stops offering admin actions once a 404 says you’ve been removed', async () => {
    // Nothing clears a query's `data`, a 404 least of all — so the cached group
    // went on saying `your_role: 'admin'` after you'd been removed, leaving
    // every row live behind a full admin menu whose write comes back a 403.
    serve();
    const { client } = await renderScreen();
    await screen.findByLabelText('Manage Ada Lovelace');

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/groups/7/members/')) return jsonResponse(MEMBERS);
      if (url.includes('/api/groups/7/')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return jsonResponse({ detail: 'Not found.' }, 404);
      }
      return jsonResponse(null, 204);
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['group', 7] });
    });
    await waitFor(() =>
      expect(client.getQueryState(['group', 7])?.status).toBe('error')
    );

    expect(
      await screen.findByText('You’re no longer a member of this group.')
    ).toBeTruthy();
    // No retry: a request that will 404 forever is one dead end swapped for
    // another (`edit.tsx`'s lesson in #320).
    expect(screen.queryByLabelText('Try checking again')).toBeNull();
    // And the rows are inert, rather than a menu whose every action 403s.
    fireEvent.press(screen.getByLabelText('Ada Lovelace'));
    expect(menuWasShown()).toBe(false);
  });
});
