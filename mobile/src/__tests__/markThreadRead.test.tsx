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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { api } from '@/api';
import { dismissConversationNotifications } from '@/push';
import {
  MARK_READ_MAX_ATTEMPTS,
  MARK_READ_RETRY_MS,
  useMarkThreadRead,
} from '@/useMarkThreadRead';

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

/** Drives the hook with nothing else on screen to get in the way. */
function Harness({
  id = 7,
  ready = true,
  count = 1,
}: {
  id?: number;
  ready?: boolean;
  count?: number;
}) {
  useMarkThreadRead(id, ready, count);
  return null;
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
    /** Re-render with new props, keeping the same query client. */
    update: (next: Parameters<typeof Harness>[0]) => view.rerender(wrap(next)),
    unmount: () => view.unmount(),
  };
}

/** One turn of the event loop, for effects and the write behind them. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let effects and the promise chain behind them settle. */
async function settle() {
  await act(async () => {
    await tick();
  });
}

describe('useMarkThreadRead', () => {
  /** The AppState listener the hook subscribed with. */
  let listener: ((status: string) => void) | undefined;

  beforeEach(() => {
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

    await act(async () => {
      listener?.('active');
      await tick();
    });

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
