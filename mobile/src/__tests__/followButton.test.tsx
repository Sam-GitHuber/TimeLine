/**
 * The Follow / Following toggle on a connected person's profile (#382, app half
 * #383).
 *
 * Three things are worth pinning. The two states map to the right label *and*
 * the right verb — a mis-wire here would unfollow someone when they meant to
 * follow, and the only visible consequence is a notification that silently never
 * arrives. The refusal path alerts, with copy resolved at the attempt (#236): a
 * failed follow that says nothing leaves a button still reading "Follow" and a
 * person believing they'll be told about posts they won't. And the round trip
 * has a visible pending label rather than looking dead (#322).
 *
 * The invalidation is pinned too, in both directions: `['user', id]` and nothing
 * else. A follow moves no visibility boundary — you could already read every one
 * of those posts — so reaching for `invalidateConnectionChange` here would be
 * seventeen refetches to repaint one word, and a future edit that "helpfully"
 * swaps it in should fail this file.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { FollowButton } from '@/components/FollowButton';

import { alertSpy, holdRequest, resetMenuSpies, settle } from './helpers';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

// `render` is async in RNTL v14; awaiting it is what keeps `screen` populated (a
// bare `render(...)` returns a promise that spreads to nothing, and every later
// query then throws "render has not been called").
async function renderButton(isFollowing: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <FollowButton userId={42} displayName="Ada Lovelace" isFollowing={isFollowing} />
    </QueryClientProvider>
  );
  return { ...view, invalidate };
}

/** The one alert body this suite reads, whichever call produced it. */
function alertBody(): string | undefined {
  return alertSpy.mock.calls.at(-1)?.[1] as string | undefined;
}

function alertTitle(): string | undefined {
  return alertSpy.mock.calls.at(-1)?.[0] as string | undefined;
}

beforeEach(() => {
  mockFetch.mockReset();
  resetMenuSpies();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('what it says', () => {
  it('reads "Follow" until you follow someone — off by default', async () => {
    await renderButton(false);
    expect(screen.getByText('Follow')).toBeTruthy();
    expect(screen.queryByText('Following')).toBeNull();
  });

  it('reads "Following" once you do', async () => {
    await renderButton(true);
    expect(screen.getByText('Following')).toBeTruthy();
  });

  // The hint carries what a press *does*, because "Following" names a state and
  // a screen reader landing on it would otherwise learn nothing about the tap.
  it('tells a screen reader what pressing it would do', async () => {
    await renderButton(true);
    const button = screen.getByLabelText('Following Ada Lovelace');
    expect(button.props.accessibilityHint).toBe('Stops notifying you when they post');
    expect(button.props.accessibilityState.selected).toBe(true);
  });
});

describe('following and unfollowing', () => {
  it('POSTs to follow, and refreshes only this profile', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: 'Following.', is_following: true })
    );
    const { invalidate } = await renderButton(false);

    await fireEvent.press(screen.getByText('Follow'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://your-timeline.net/api/users/42/follow/');
    expect(init.method).toBe('POST');

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 42] })
    );
    // **Nothing else.** A follow doesn't move the visibility boundary, so the
    // feed, the calendars, the group timelines and the conversation list are all
    // exactly as fresh as they were.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('DELETEs to unfollow', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unfollowed.', is_following: false })
    );
    const { invalidate } = await renderButton(true);

    await fireEvent.press(screen.getByText('Following'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://your-timeline.net/api/users/42/follow/');
    expect(init.method).toBe('DELETE');
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 42] })
    );
  });

  // #322's second finding, applied to a new button rather than inherited by one:
  // a control that neither moves nor says anything for the length of a round
  // trip is indistinguishable from one that didn't take the press.
  it('says "Saving…" while the write is out, and refuses a second press', async () => {
    const server = holdRequest(mockFetch, { detail: 'Following.' }, 200);
    await renderButton(false);

    // Braced, not a bare arrow: `run` is `async`, so returning its promise to
    // `act` would wait on the very request this test is holding open — and
    // pressing outside `act` leaves its continuation to land in whatever test
    // comes next, where it tears down that one's tree.
    await act(async () => {
      fireEvent.press(screen.getByText('Follow'));
    });
    await server.inFlight('Saving…');

    // Not "Following" — the pending label must not read as the finished state.
    expect(screen.queryByText('Following')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByText('Saving…'));
    });
    await settle(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Let it land before the test ends: a mutation still settling as RNTL tears
    // the tree down leaves an act() straddling the next test's render.
    //
    // It settles back to "Follow" here only because this harness holds
    // `isFollowing` fixed — there is no `['user', 42]` query behind it to
    // repaint. **That is not the product behaviour**, and asserting it as if it
    // were would pin the very bug the returned invalidation promise exists to
    // stop. The real sequence, where a profile query does sit behind the prop,
    // is pinned in `profile.test.tsx`.
    await server.refuse();
    await waitFor(() => expect(screen.getByText('Follow')).toBeTruthy());
  });

  /**
   * A press abandoned mid-flight must not follow you off the screen.
   *
   * Unmounting does nothing to the promise `run` is sitting on, so without the
   * `mounted` guard this alert lands modally over whatever you navigated to —
   * the feed, or the next person's profile, naming someone you're no longer
   * looking at. The web twin has the same exposure and answers it differently,
   * because `/u/:id` doesn't remount between people and its message is inline.
   *
   * The button is dropped by **re-rendering the tree without it** rather than
   * by `unmount()`, which is both closer to what a pop does — the app is still
   * there, this screen isn't — and the only version that leaves the act scope
   * intact for the tests after it.
   */
  it('says nothing if you’ve left the screen before the refusal lands', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { gcTime: 0 },
      },
    });
    const tree = (present: boolean) => (
      <QueryClientProvider client={queryClient}>
        {present ? (
          <FollowButton userId={42} displayName="Priya Shah" isFollowing={false} />
        ) : null}
      </QueryClientProvider>
    );
    const server = holdRequest(mockFetch, { detail: 'Nope.' }, 400);
    const { rerender } = await render(tree(true));

    await act(async () => {
      fireEvent.press(screen.getByText('Follow'));
    });
    await server.inFlight('Saving…');
    // Back pressed: the profile pops and takes the control with it.
    await act(async () => {
      rerender(tree(false));
    });
    await server.refuse();
    await settle(2);

    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('when the write is refused (#236)', () => {
  it('shows the server’s own sentence when it wrote one', async () => {
    // The real refusal: they disconnected while this screen was open, so the
    // subscription can no longer be created. `FollowView` writes that sentence
    // for a person, and it says more than any fallback could.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { detail: "You can only follow people you're connected with." },
        400
      )
    );
    const { invalidate } = await renderButton(false);

    await fireEvent.press(screen.getByText('Follow'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertTitle()).toBe('Couldn’t follow');
    expect(alertBody()).toBe("You can only follow people you're connected with.");
    // And the connection it just told us about is refreshed — see the
    // `it.each` below for what that covers and why it's this failure only.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 42] });
    // The button is back to where it was, not stuck on "Saving…". Waited for,
    // not read at once: the mutation calls `onError` — the alert above — before
    // it clears its pending state, so "Saving…" can outlive the alert by a tick.
    expect(await screen.findByText('Follow')).toBeTruthy();
  });

  /**
   * **The one refusal that is news about the relationship, not just about the
   * write.** Every answer `FollowView` can give a real person says the profile
   * underneath has gone stale: 400 (no longer connected), 403 (a block now
   * stands between you, which severed the connection too), 404 (the account is
   * gone). Repainting only the alert would leave a header still reading
   * *Connected*, a Message button and their whole posts wall standing behind a
   * message saying the opposite.
   *
   * So this failure — and only this one — earns the wide connection set, for
   * exactly the reason the *success* path above earns only `['user', id]`: here
   * the visibility boundary really did move.
   */
  it.each([400, 403, 404])(
    'repaints the whole relationship when the server refuses with a %i',
    async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ detail: 'No.' }, status));
      const { invalidate } = await renderButton(false);

      await fireEvent.press(screen.getByText('Follow'));

      await waitFor(() => expect(alertSpy).toHaveBeenCalled());
      // The connection set, not just this profile — `['feed']` and the calendar
      // keys are the ones that would otherwise keep showing content the server
      // has stopped being willing to serve.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user', 42] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['feed'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['personalCalendar'] });
    }
  );

  it('repaints nothing when the failure said nothing about the relationship', async () => {
    // A 5xx or a dropped connection is not entitled to claim the connection is
    // gone — it knows nothing about it — so it apologises and touches no cache.
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { invalidate } = await renderButton(false);

    await fireEvent.press(screen.getByText('Follow'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('falls back to what is still true, per direction, when it didn’t', async () => {
    // A 500 with no readable detail — or, offline, a `TypeError` from React
    // Native. Neither says the thing that matters, which is that the person is
    // *not* being notified despite having pressed Follow.
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderButton(false);

    await fireEvent.press(screen.getByText('Follow'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertTitle()).toBe('Couldn’t follow');
    expect(alertBody()).toBe(
      'Couldn’t follow Ada Lovelace — you won’t be notified about their posts.'
    );
  });

  it('says the opposite thing when it was an unfollow that failed', async () => {
    // The direction matters more here than anywhere: someone unfollowing wants
    // to stop hearing from a person, and a silent failure leaves them believing
    // they have when the next post will still buzz their phone.
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderButton(true);

    await fireEvent.press(screen.getByText('Following'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertTitle()).toBe('Couldn’t unfollow');
    expect(alertBody()).toBe(
      'Couldn’t unfollow Ada Lovelace — you’re still being notified about their posts.'
    );
  });
});
