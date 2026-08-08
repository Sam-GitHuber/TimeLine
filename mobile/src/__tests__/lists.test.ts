/**
 * The generic list helpers shared by the feed and the people/requests lists.
 *
 * `dedupeById` guards a real, hard-to-see bug: page-number pagination re-sends a
 * row across a page boundary when the set shifts mid-scroll, and duplicate keys
 * make FlatList recycle the wrong row. The order-preservation is the part worth
 * pinning — the feed's reverse-chronological guarantee is not ours to reorder.
 *
 * `useFetchAllPages` guards a worse one: the walk it replaced answered a *failed*
 * page by asking for it again, on every render commit, for as long as the screen
 * stayed open (#248). Its four states are pinned here directly, so the rule
 * survives even if all three screens are rewritten.
 */

import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';

import { dedupeById, trimToFirstPage, useFetchAllPages } from '@/lists';
import type { Paginated } from '@/types';

describe('dedupeById', () => {
  it('drops later repeats while preserving first-seen order', () => {
    const items = [{ id: 3 }, { id: 1 }, { id: 3 }, { id: 2 }, { id: 1 }];
    expect(dedupeById(items)).toEqual([{ id: 3 }, { id: 1 }, { id: 2 }]);
  });

  it('is a no-op on an already-unique list', () => {
    const items = [{ id: 1 }, { id: 2 }];
    expect(dedupeById(items)).toEqual(items);
  });

  it('handles an empty list', () => {
    expect(dedupeById([])).toEqual([]);
  });
});

describe('trimToFirstPage', () => {
  function pages(n: number): InfiniteData<Paginated<{ id: number }>, string> {
    return {
      pages: Array.from({ length: n }, (_, i) => ({
        count: n,
        next: i < n - 1 ? `?page=${i + 2}` : null,
        previous: null,
        results: [{ id: i }],
      })),
      pageParams: Array.from({ length: n }, (_, i) => (i === 0 ? '' : `?page=${i + 1}`)),
    };
  }

  it('keeps only the first page and its param', () => {
    const trimmed = trimToFirstPage(pages(4));
    expect(trimmed?.pages).toHaveLength(1);
    expect(trimmed?.pageParams).toHaveLength(1);
  });

  it('declines to write at all when there is nothing to trim', () => {
    // `undefined`, not the data back: `setQueryData` bails out only on
    // `undefined`, and handing back the identical object is still a *write* —
    // it dispatches a success, which resets `isInvalidated` and so cancels an
    // invalidation someone else just made (#307, where that cost `postCache` a
    // bug). Declining also keeps the entry's identity, which was the original
    // reason for the unchanged return.
    expect(trimToFirstPage(pages(1))).toBeUndefined();
    expect(trimToFirstPage(undefined)).toBeUndefined();
  });

  it('leaves an invalidated query invalidated when it has nothing to trim', () => {
    // The rule where it actually bites, rather than on the return value alone.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
    client.setQueryData(['feed', false], pages(1));
    client.invalidateQueries({ queryKey: ['feed'] });

    client.setQueryData(['feed', false], trimToFirstPage);

    expect(client.getQueryState(['feed', false])?.isInvalidated).toBe(true);
  });
});

describe('useFetchAllPages', () => {
  /** The three query flags the walk reads; each defaults to "another page is
   *  there for the asking". */
  type State = {
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    isError?: boolean;
  };

  async function walk(initialProps: State = {}) {
    const fetchNextPage = jest.fn();
    const { rerender } = await renderHook(
      (state: State) =>
        useFetchAllPages({
          hasNextPage: state.hasNextPage ?? true,
          isFetchingNextPage: state.isFetchingNextPage ?? false,
          isError: state.isError ?? false,
          // Stable across renders, like TanStack's own — an identity that
          // changed every render would re-run the effect for a reason the real
          // hook never has.
          fetchNextPage,
        }),
      { initialProps }
    );
    return { fetchNextPage, rerender };
  }

  it('pulls the next page as soon as one is available', async () => {
    const { fetchNextPage } = await walk();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing once the server says there is no more', async () => {
    const { fetchNextPage } = await walk({ hasNextPage: false });
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('waits for the page in flight rather than asking twice', async () => {
    const { fetchNextPage } = await walk({ isFetchingNextPage: true });
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('stops on a failed page instead of re-arming on it', async () => {
    const { fetchNextPage, rerender } = await walk();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // The page goes out, and comes back a failure. That leaves exactly the
    // state the effect was waiting for — the server never said there was no
    // next page, so `hasNextPage` is still true, and `isFetchingNextPage` going
    // back to false *is* the trigger. Without `isError` in the guard, every
    // commit from here on is another request (#248).
    await rerender({ isFetchingNextPage: true });
    await rerender({ isFetchingNextPage: false, isError: true });
    await rerender({ isFetchingNextPage: false, isError: true });

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('resumes the walk when a later fetch clears the error', async () => {
    // Recovery needs no retry of our own: a poll or a refocus that succeeds
    // clears the flag, and the remaining pages carry on from where they
    // stopped.
    const { fetchNextPage, rerender } = await walk({ isError: true });
    expect(fetchNextPage).not.toHaveBeenCalled();

    await rerender({ isError: false });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
