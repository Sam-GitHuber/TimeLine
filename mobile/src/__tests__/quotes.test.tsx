/**
 * Resolving a reply's quoted message by id (Phase 9b M5).
 *
 * 🔒 The property under test is an honesty one, not a caching one. "Original
 * message unavailable" is supposed to mean *you were clipped out of this*, and
 * it only means that if every id the module retires has actually been answered.
 * The screen-level halves of this live in `thread.test.tsx` (a quote that hasn't
 * paged in gets fetched; a genuinely clipped one stays unavailable and is asked
 * about once). What's here is the case a screen can't stage: a batch bigger than
 * one page, where the response comes back **short**.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { clearQuotes, useQuotedMessages } from '@/quotes';
import { saveTokens } from '@/tokens';
import type { Message } from '@/types';

const mockFetch = jest.fn();

/** The server's `PAGE_SIZE` (`config/settings.py`). */
const PAGE_SIZE = 20;

const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };
const GRACE = { id: 3, display_name: 'Grace Hopper', avatar_thumb: null };

function message(overrides: Partial<Message> & { id: number }): Message {
  return {
    sender: ADA,
    text: `Message ${overrides.id}`,
    is_deleted: false,
    is_edited: false,
    created_at: new Date().toISOString(),
    edited_at: null,
    reactions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/** The ids one `?ids=` call asked for, in order. */
function idsAsked(): number[][] {
  return mockFetch.mock.calls
    .map(([url]) => String(url).match(/[?&]ids=([^&]*)/)?.[1])
    .filter((raw): raw is string => !!raw)
    .map((raw) => decodeURIComponent(raw).split(',').map(Number));
}

/**
 * `?ids=` served the way the endpoint serves it — **paginated**, because it's a
 * filter on the ordinary message list rather than an endpoint of its own. A
 * request for more ids than fit in a page is answered with the first page and a
 * `next`, and the rest are simply not in it.
 */
function serve(pool: Message[]) {
  mockFetch.mockImplementation(async (url: string) => {
    const wanted = decodeURIComponent(url.match(/[?&]ids=([^&]*)/)?.[1] ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    const found = pool.filter((m) => wanted.includes(m.id));
    return jsonResponse({
      count: found.length,
      next: found.length > PAGE_SIZE ? `${url}&page=2` : null,
      previous: null,
      results: found.slice(0, PAGE_SIZE),
    });
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  mockFetch.mockReset();
  clearQuotes();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  await saveTokens({ access: 'a', refresh: 'r' });
});

/** `count` replies, each quoting a message the transcript doesn't hold. */
function repliesQuoting(count: number) {
  return Array.from({ length: count }, (_, i) =>
    message({
      id: 1000 + i,
      sender: GRACE,
      text: `reply ${i}`,
      reply_to: { id: i + 1 },
      thread_root_id: i + 1,
    })
  );
}

it('resolves a quote the transcript hasn’t loaded', async () => {
  const quoted = message({ id: 1, sender: ADA, text: 'the original plan' });
  const loaded = repliesQuoting(1);
  serve([quoted]);

  const { result } = await renderHook(() => useQuotedMessages(5, loaded), {
    wrapper,
  });

  await waitFor(() => expect(result.current(1)?.text).toBe('the original plan'));
});

it('asks about a clipped id once and then leaves it alone', async () => {
  // 🔒 An unresolvable id is a *fact* about this viewer, not a transient
  // failure, so re-asking would be a request that can only ever return nothing.
  const loaded = repliesQuoting(1);
  serve([]);

  const { rerender, result } = await renderHook(
    () => useQuotedMessages(5, loaded),
    { wrapper }
  );

  await waitFor(() => expect(idsAsked()).toHaveLength(1));
  // Awaited, like every RNTL v14 interaction: an un-awaited `rerender` leaves
  // its `act` scope open and the *next test's* render lands inside it.
  await rerender({});
  await rerender({});
  expect(idsAsked()).toHaveLength(1);
  expect(result.current(1)).toBeUndefined();
});

it('finishes a batch the endpoint answered short', async () => {
  // The regression this test exists for. `?ids=` paginates, so a batch bigger
  // than a page comes back truncated — and retiring an id the server never
  // *looked* at would leave a quote reading "Original message unavailable"
  // forever, about a message the viewer is perfectly entitled to. That's the one
  // lie this module exists to stop telling, so a short answer only retires what
  // it answered and the remainder go round again.
  const wanted = PAGE_SIZE + 5;
  const originals = Array.from({ length: wanted }, (_, i) =>
    message({ id: i + 1, sender: ADA, text: `original ${i + 1}` })
  );
  const loaded = repliesQuoting(wanted);
  serve(originals);

  const { result } = await renderHook(() => useQuotedMessages(5, loaded), {
    wrapper,
  });

  // Every quote resolves, including the ones past the first page.
  await waitFor(() =>
    expect(result.current(wanted)?.text).toBe(`original ${wanted}`)
  );
  expect(result.current(1)?.text).toBe('original 1');

  // Two requests, and the second asks only for what the first didn't answer —
  // not the whole batch over again.
  const asked = idsAsked();
  expect(asked).toHaveLength(2);
  expect(asked[0]).toHaveLength(wanted);
  expect(asked[1]).toEqual([21, 22, 23, 24, 25]);
});
