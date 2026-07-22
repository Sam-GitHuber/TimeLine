/**
 * The generic list helpers shared by the feed and the people/requests lists.
 *
 * `dedupeById` guards a real, hard-to-see bug: page-number pagination re-sends a
 * row across a page boundary when the set shifts mid-scroll, and duplicate keys
 * make FlatList recycle the wrong row. The order-preservation is the part worth
 * pinning — the feed's reverse-chronological guarantee is not ours to reorder.
 */

import type { InfiniteData } from '@tanstack/react-query';

import { dedupeById, trimToFirstPage } from '@/lists';
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

  it('returns the same reference when there is nothing to trim', () => {
    const one = pages(1);
    // Identity preserved so no needless cache-driven re-render fires.
    expect(trimToFirstPage(one)).toBe(one);
    expect(trimToFirstPage(undefined)).toBeUndefined();
  });
});
