/**
 * Keeping the conversation read marker honest on the web (issue #355).
 *
 * The marker is not cosmetic. `send_pushes._should_drop` reads it to decide
 * whether to buzz someone's phone for a message already on a screen they're
 * looking at, and `attach_read_receipts` reads it to draw the other person's
 * second tick. A write that silently doesn't happen is a stray push *and* a
 * wrong tick — and the two clients share one marker, so the browser dropping it
 * shows up on the phone.
 *
 * What's pinned here is the *set of reasons* the write happens, and that a
 * failure is retried rather than dropped on the floor. It used to fire only when
 * the loaded message count changed, and swallow its own rejection.
 */

import { act, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import {
  MARK_READ_MAX_ATTEMPTS,
  MARK_READ_RETRY_MS,
  useMarkThreadRead,
} from "./useMarkThreadRead.js";

/**
 * Stands in for the thread's own transcript query.
 *
 * It has to be a real *observer*, not a seeded cache entry: `refetchQueries`
 * only touches active queries, so without something subscribed the guard under
 * test would have nothing to refetch and would pass vacuously.
 */
function Transcript({ id, queryFn }) {
  useQuery({ queryKey: ["messages", id], queryFn, retry: false });
  return null;
}

function Harness({ id = 7, ready = true, count = 1, transcript }) {
  useMarkThreadRead(id, ready, count);
  return transcript ? <Transcript id={id} queryFn={transcript} /> : null;
}

function renderHook(props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrap = (next) => (
    <QueryClientProvider client={queryClient}>
      <Harness {...next} />
    </QueryClientProvider>
  );
  const view = render(wrap(props));
  return {
    ...view,
    queryClient,
    update: (next) => view.rerender(wrap(next)),
  };
}

/** Pretend the tab went away and came back. */
function returnToTab() {
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("useMarkThreadRead", () => {
  let markRead;

  beforeEach(() => {
    markRead = vi
      .spyOn(api, "markConversationRead")
      .mockResolvedValue({ detail: "Marked read." });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the thread read once the transcript is on screen", async () => {
    renderHook();

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(7));
  });

  it("writes nothing while the transcript is not showing", async () => {
    // Marking a thread read the reader can't see a line of would clear their
    // badge and tell the sender they'd read it — the lesson of #315/#321/#324.
    renderHook({ ready: false });

    await Promise.resolve();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks read again when a new message lands", async () => {
    const view = renderHook({ count: 1 });
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    view.update({ count: 2 });

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(7));
  });

  it("marks read again when the tab becomes visible", async () => {
    // A background tab is throttled and may have been away for hours, so this is
    // both the likeliest moment for the marker to be stale and the likeliest
    // moment for the last attempt to have failed.
    renderHook();
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    returnToTab();

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(7));
  });

  it("does not claim a read when the transcript refetch fails", async () => {
    // The sharp edge of the tab-return trigger. The server stamps the marker
    // `now()`, so writing against a stale cached transcript would claim "read"
    // over messages this tab never fetched — binning their queued push and
    // drawing the sender a second tick for something nobody saw. Coming back
    // offline is exactly when that happens, so the refetch has to gate it.
    let fail = false;
    const transcript = () =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve([]);

    const view = renderHook({ transcript });
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    fail = true;
    returnToTab();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(markRead).not.toHaveBeenCalled();
  });

  it("claims the read once the transcript refetch succeeds", async () => {
    // The other half: the guard must not be so strict that the trigger never
    // fires. This is the reported case — phone locked, polls paused, nothing
    // but the return to say the messages have been seen.
    const transcript = () => Promise.resolve([]);

    const view = renderHook({ transcript });
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    returnToTab();

    await waitFor(() => expect(markRead).toHaveBeenCalledWith(7));
    expect(view).toBeTruthy();
  });

  it("ignores a visibility change that hid the tab", async () => {
    renderHook();
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    markRead.mockClear();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    returnToTab();

    await Promise.resolve();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("refreshes the badge and the conversation list after a read lands", async () => {
    // The whole user-visible point of the write: without these the nav badge
    // goes on claiming mail the reader has just read until the next 12s poll.
    const view = renderHook();
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    await waitFor(() => expect(markRead).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["unreadMessages"]);
    expect(keys).toContainEqual(["conversations"]);
  });

  it("still refreshes them when the view has already gone", async () => {
    // The regression this guards: gating the invalidation on the effect's
    // cleanup left the nav badge claiming mail the reader had just read
    // whenever they closed the drawer inside the round trip. The write landed;
    // the cache has to hear about it either way.
    let settleWrite;
    markRead.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleWrite = () => resolve({});
        }),
    );

    const view = renderHook();
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    view.unmount();

    await act(async () => {
      settleWrite();
    });

    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(["unreadMessages"]);
  });

  it("retries a write that did not land", async () => {
    // The old code swallowed this and moved on, leaving the marker behind with
    // nothing scheduled to correct it.
    markRead.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();

    renderHook();
    await vi.advanceTimersByTimeAsync(0);
    expect(markRead).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS);

    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts", async () => {
    // A write that has failed this often is failing for a reason another go
    // won't fix, and any fresh trigger starts the schedule over anyway.
    markRead.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();

    renderHook();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(
      MARK_READ_RETRY_MS * MARK_READ_MAX_ATTEMPTS * 2,
    );

    expect(markRead).toHaveBeenCalledTimes(MARK_READ_MAX_ATTEMPTS);
  });

  it("does not keep retrying for a thread it has been unmounted from", async () => {
    markRead.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();

    const view = renderHook();
    await vi.advanceTimersByTimeAsync(0);
    view.unmount();
    markRead.mockClear();

    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS * 4);

    expect(markRead).not.toHaveBeenCalled();
  });
});
