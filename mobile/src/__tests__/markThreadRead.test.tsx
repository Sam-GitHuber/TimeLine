/**
 * Keeping the conversation read marker honest (issue #355).
 *
 * The marker is not cosmetic. `send_pushes._should_drop` reads it to decide
 * whether to buzz a phone for a message already on its screen, and
 * `attach_read_receipts` reads it to draw the sender's second tick — so a write
 * that silently doesn't happen is a stray push *and* a wrong tick.
 *
 * The bug this pins was that the write had exactly one trigger (the loaded
 * message count changing), swallowed its own failures, and relied on "the next
 * open marks it again" — while nothing ever re-opens the screen: a push tapped
 * for the thread already on screen reuses the mounted one, and the thread stays
 * mounted behind its own info screen. Reading a message could therefore leave
 * the server believing it was unread until the app was force-quit.
 *
 * So what's pinned here is the *set of reasons* the write happens, and that a
 * failure is retried rather than dropped on the floor.
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { api } from '@/api';
import { dismissConversationNotifications } from '@/push';
import {
  MARK_READ_MAX_ATTEMPTS,
  MARK_READ_RETRY_MS,
  useMarkThreadRead,
} from '@/useMarkThreadRead';

/**
 * A **focusable** `useFocusEffect`, overriding the global stub.
 *
 * `jest.setup.js` replaces `useFocusEffect` with a plain `useEffect` for the
 * whole app, on the reasonable grounds that most screens are always focused
 * under test. That stub makes this suite's headline claims untestable: swap the
 * hook to a bare `useEffect` and every assertion still passes, because under it
 * the two are literally the same hook. Since focus is precisely what #355
 * changed — it is the gate on the write, and the reason a re-focused thread
 * marks itself read at all — the suite has to be able to blur.
 *
 * `jest.setup.js` says a suite may supply its own; this is that suite.
 */
jest.mock('expo-router', () => {
  // `require` inside the factory: it is hoisted above the imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const state = {
    focused: true,
    /** Bumped on every focus change, to re-run the effects below. */
    generation: 0,
    // Every mounted `useFocusEffect`'s re-render trigger. Untyped on purpose:
    // a type parameter inside a hoisted `jest.mock` factory reads to Babel's
    // out-of-scope check as a variable reference, and the suite won't load.
    subscribers: new Set(),
  };
  return {
    __focus: state,
    useFocusEffect: (callback: () => void | (() => void)) => {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        state.subscribers.add(force);
        return () => {
          state.subscribers.delete(force);
        };
      }, []);
      React.useEffect(() => {
        // Blurred screens don't run their effect — and a dependency change
        // while blurred re-subscribes without invoking it, which is the real
        // hook's behaviour and the whole point of this stand-in.
        if (!state.focused) return undefined;
        return callback();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [callback, state.generation]);
    },
  };
});

/** The focus state the stub above hands back, for the tests to drive. */
const focusState = (
  jest.requireMock('expo-router') as {
    __focus: {
      focused: boolean;
      generation: number;
      subscribers: Set<(n: number) => void>;
    };
  }
).__focus;

/** Focus or blur the screen, the way navigating within the app would. */
async function setFocused(next: boolean) {
  await act(async () => {
    focusState.focused = next;
    focusState.generation += 1;
    focusState.subscribers.forEach((force) => force(focusState.generation));
    await tick();
  });
}

jest.mock('@/api', () => ({
  api: { markConversationRead: jest.fn(async () => ({})) },
}));

jest.mock('@/push', () => ({
  dismissConversationNotifications: jest.fn(async () => {}),
}));

const markRead = api.markConversationRead as jest.MockedFunction<
  typeof api.markConversationRead
>;
const dismiss = dismissConversationNotifications as jest.MockedFunction<
  typeof dismissConversationNotifications
>;

/**
 * Stands in for the thread's own transcript query.
 *
 * It has to be a real *observer*, not a seeded cache entry: `refetchQueries`
 * only touches active queries, so without something subscribed the foreground
 * guard would have nothing to refetch and would pass vacuously.
 */
function Transcript({
  id,
  queryFn,
}: {
  id: number;
  queryFn: () => Promise<unknown>;
}) {
  useQuery({ queryKey: ['messages', id], queryFn, retry: false });
  return null;
}

/** Drives the hook with nothing else on screen to get in the way. */
function Harness({
  id = 7,
  ready = true,
  count = 1,
  transcript,
}: {
  id?: number;
  ready?: boolean;
  count?: number;
  transcript?: () => Promise<unknown>;
}) {
  useMarkThreadRead(id, ready, count);
  return transcript ? <Transcript id={id} queryFn={transcript} /> : null;
}

async function renderHook(props: Parameters<typeof Harness>[0] = {}) {
  // `gcTime: 0` so Query doesn't leave a five-minute collection timer behind
  // and keep Node alive after the suite passes.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrap = (next: Parameters<typeof Harness>[0]) => (
    <QueryClientProvider client={client}>
      <Harness {...next} />
    </QueryClientProvider>
  );
  // **Awaited.** RNTL 14's `render` is async — it opens its own act scope and
  // returns a promise. Not awaiting it hands back a promise wearing none of the
  // result's methods, and leaves an act scope open across the next render.
  const view = await render(wrap(props));
  return {
    client,
    /** Re-render with new props, keeping the same query client. */
    update: (next: Parameters<typeof Harness>[0]) => view.rerender(wrap(next)),
    unmount: () => view.unmount(),
  };
}

/** One turn of the event loop, for effects and the write behind them. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The AppState listener the hook subscribed with. */
let listener: ((status: string) => void) | undefined;

/**
 * A real return to the app: `background` then `active`.
 *
 * The hook ignores a bare `inactive` → `active`, because iOS emits that for
 * Control Centre, the notification shade and permission dialogs — none of which
 * are a foreground.
 */
async function foreground() {
  await act(async () => {
    listener?.('background');
    listener?.('active');
    await tick();
    await tick();
  });
}

/** Let effects and the promise chain behind them settle. */
async function settle() {
  await act(async () => {
    await tick();
  });
}

describe('useMarkThreadRead', () => {
  beforeEach(() => {
    // Focus is module state on the stub, so it has to be reset between tests
    // or a blurred screen leaks into the next one.
    focusState.focused = true;
    focusState.generation = 0;
    listener = undefined;
    markRead.mockReset();
    markRead.mockResolvedValue({} as never);
    dismiss.mockReset();
    dismiss.mockResolvedValue(undefined);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation(((_event: string, handler: (s: string) => void) => {
        listener = handler;
        return { remove: jest.fn() };
      }) as never);
  });

  afterEach(() => {
    // Unconditional: a test that fails *before* its own `useRealTimers` would
    // otherwise leave fake timers installed, and the next test's `settle()`
    // would hang on a `setTimeout` nothing ever advances.
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('marks the thread read once the transcript is on screen', async () => {
    await renderHook();
    await settle();

    expect(markRead).toHaveBeenCalledWith(7);
  });

  it('writes nothing while the transcript is not showing', async () => {
    // `ready` is the screen's own "the messages are actually on screen" answer.
    // Marking a thread read the reader can't see a line of would clear their
    // badge and tell the sender they'd read it — the lesson of #315/#321/#324.
    await renderHook({ ready: false });
    await settle();

    expect(markRead).not.toHaveBeenCalled();
  });

  it('marks read again when a new message lands', async () => {
    const view = await renderHook({ count: 1 });
    await settle();
    markRead.mockClear();

    await view.update({ count: 2 });
    await settle();

    expect(markRead).toHaveBeenCalledWith(7);
  });

  it('marks read again when the app comes back to the foreground', async () => {
    // The reported case: the phone was locked when the message arrived, so the
    // poll was paused and no count ever changed. Without this trigger, coming
    // back and reading it told the server nothing at all.
    await renderHook();
    await settle();
    markRead.mockClear();

    await foreground();

    expect(markRead).toHaveBeenCalledWith(7);
  });

  it('does not claim a read when the transcript refetch fails', async () => {
    // The sharp edge of the foreground trigger. The server stamps the marker
    // `now()`, so writing against the cached pages would claim "read" over
    // every message that arrived while the phone was locked — binning their
    // queued push and drawing the sender a second tick for something nobody
    // saw. Unlocking with no signal is exactly when that happens.
    let fail = false;
    const transcript = () =>
      fail ? Promise.reject(new Error('offline')) : Promise.resolve([]);

    await renderHook({ transcript });
    await settle();
    markRead.mockClear();

    fail = true;
    await foreground();

    expect(markRead).not.toHaveBeenCalled();
  });

  it('claims the read once the transcript refetch succeeds', async () => {
    // The other half: the guard must not be so strict that the trigger never
    // fires. This is the reported case — phone locked, polls paused, nothing
    // but the return to say the messages have been seen.
    await renderHook({ transcript: () => Promise.resolve([]) });
    await settle();
    markRead.mockClear();

    await foreground();

    expect(markRead).toHaveBeenCalledWith(7);
  });

  it('ignores a foreground transition that is not "active"', async () => {
    await renderHook();
    await settle();
    markRead.mockClear();

    await act(async () => {
      listener?.('background');
      await tick();
    });

    expect(markRead).not.toHaveBeenCalled();
  });

  it('ignores an inactive blip that never backgrounded the app', async () => {
    // iOS emits `inactive` → `active` for Control Centre, the notification
    // shade, permission dialogs and the app switcher. Treating those as a
    // return would force a transcript refetch and a `read/` POST every time
    // someone glanced at Control Centre with a thread open.
    await renderHook();
    await settle();
    markRead.mockClear();

    await act(async () => {
      listener?.('inactive');
      listener?.('active');
      await tick();
      await tick();
    });

    expect(markRead).not.toHaveBeenCalled();
  });

  it('marks read again when the thread is re-focused', async () => {
    // The actual fix for "nothing ever re-opens this screen": a push tapped for
    // the thread already on screen reuses the mounted one, and the thread stays
    // mounted behind its own info screen — so coming back to it is a re-focus,
    // never a remount, and the old count-keyed effect saw nothing at all.
    await renderHook();
    await settle();
    markRead.mockClear();

    await setFocused(false);
    await setFocused(true);

    expect(markRead).toHaveBeenCalledWith(7);
  });

  it('does not mark read while the thread sits blurred behind another screen', async () => {
    // The deliberate tightening. A message arriving while the reader is on the
    // thread's info screen still moves `messageCount` — the poll is running —
    // but they can see none of it, and marking it read would clear their badge
    // and tell the sender they had read it.
    const view = await renderHook({ count: 1 });
    await settle();
    await setFocused(false);
    markRead.mockClear();

    await view.update({ count: 2 });
    await settle();

    expect(markRead).not.toHaveBeenCalled();
  });

  it('still clears the tray for a thread that is blurred', async () => {
    // The other half of that tightening, and the one that must *not* be
    // focus-gated (#178): a blurred thread is exactly when its pushes get
    // filed rather than suppressed, so the sweep has to keep running or "New
    // message from Ada" is stranded on the lock screen.
    const view = await renderHook({ count: 1 });
    await settle();
    await setFocused(false);
    dismiss.mockClear();

    await view.update({ count: 2 });
    await settle();

    expect(dismiss).toHaveBeenCalledWith([7]);
  });

  it('retries a write that did not land', async () => {
    // The old code swallowed this and moved on, leaving the marker behind with
    // nothing scheduled to correct it.
    jest.useFakeTimers();
    markRead.mockRejectedValue(new Error('offline'));

    await renderHook();
    await act(async () => {
      await Promise.resolve();
    });
    expect(markRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(MARK_READ_RETRY_MS);
      await Promise.resolve();
    });

    expect(markRead).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('gives up after a bounded number of attempts', async () => {
    // A write that has failed this often is failing for a reason another go
    // won't fix, and any fresh trigger starts the schedule over anyway.
    jest.useFakeTimers();
    markRead.mockRejectedValue(new Error('offline'));

    await renderHook();
    await act(async () => {
      await Promise.resolve();
    });

    for (let n = 1; n <= MARK_READ_MAX_ATTEMPTS + 2; n += 1) {
      await act(async () => {
        jest.advanceTimersByTime(MARK_READ_RETRY_MS * (n + 1));
        await Promise.resolve();
      });
    }

    expect(markRead).toHaveBeenCalledTimes(MARK_READ_MAX_ATTEMPTS);
    jest.useRealTimers();
  });

  it("takes the thread's notifications back off the lock screen", async () => {
    // #178. Not chained onto the write: whether the server hears about it
    // doesn't change the fact the user has read it, and the shade is local.
    await renderHook();
    await settle();

    expect(dismiss).toHaveBeenCalledWith([7]);
  });

  it('refreshes the badge and the conversation list after a read lands', async () => {
    // The whole user-visible point of the write: without these the badge goes
    // on claiming mail the reader has just read until the next 12s poll.
    const view = await renderHook();
    const invalidate = jest.spyOn(view.client, 'invalidateQueries');
    markRead.mockClear();
    invalidate.mockClear();

    await view.update({ count: 2 });
    await settle();

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(['unreadMessages']);
    expect(keys).toContainEqual(['conversations']);
  });

  it('still refreshes them when the reader has already left the thread', async () => {
    // The regression this guards: blur (not just unmount) runs the cleanup, so
    // gating the invalidation on it left the tab badge claiming mail the reader
    // had just read whenever they tapped Back inside the round trip. The write
    // landed; the cache has to hear about it either way.
    let settleWrite: (() => void) | undefined;
    markRead.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleWrite = () => resolve();
        }) as never
    );

    const view = await renderHook();
    const invalidate = jest.spyOn(view.client, 'invalidateQueries');
    await view.unmount();

    await act(async () => {
      settleWrite?.();
      await tick();
    });

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(['unreadMessages']);
  });

  it('does not write for a thread it has been unmounted from', async () => {
    jest.useFakeTimers();
    markRead.mockRejectedValue(new Error('offline'));

    const view = await renderHook();
    await act(async () => {
      await Promise.resolve();
    });
    await view.unmount();
    markRead.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(MARK_READ_RETRY_MS * 4);
      await Promise.resolve();
    });

    expect(markRead).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
