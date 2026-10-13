/**
 * `mergeNewestPage` — laying a fresh newest page over a paged-back transcript
 * (#394). The poll that calls it, and what the screen does with the result,
 * are pinned in `thread.test.tsx`; this is the arithmetic.
 */

import type { Message, Paginated } from '@/types';
import { mergeNewestPage } from '@/useNewestMessagesPoll';

const m = (id: number, text = `m${id}`) => ({ id, text }) as Message;

function page(ids: number[], next: string | null = null): Paginated<Message> {
  return { count: 8, next, previous: null, results: ids.map((id) => m(id)) };
}

const cached = () => ({
  pages: [page([8, 7, 6, 5], '/page2'), page([4, 3, 2, 1])],
  pageParams: ['', '/page2'],
});

const ids = (p: Paginated<Message>) => p.results.map((x) => x.id);

it('puts a new arrival first and keeps what it pushed off the page', () => {
  const merged = mergeNewestPage(cached(), { ...page([9, 8, 7, 6]), count: 9 })!;

  expect(ids(merged.pages[0])).toEqual([9, 8, 7, 6, 5]);
  expect(merged.pages[0].count).toBe(9);
});

it('takes the fresh copy of a message both hold', () => {
  const fresh = page([8, 7, 6, 5]);
  fresh.results[1] = m(7, 'edited');

  const merged = mergeNewestPage(cached(), fresh)!;

  expect(merged.pages[0].results[1].text).toBe('edited');
  expect(ids(merged.pages[0])).toEqual([8, 7, 6, 5]);
});

it('leaves the older pages, and the link the next one is followed from, alone', () => {
  const before = cached();

  const merged = mergeNewestPage(before, page([9, 8, 7, 6], '/elsewhere'))!;

  expect(merged.pages[1]).toBe(before.pages[1]);
  expect(merged.pages[0].next).toBe('/page2');
  expect(merged.pageParams).toBe(before.pageParams);
});

it('writes nowhere when there is no transcript to write into', () => {
  expect(mergeNewestPage(undefined, page([1]))).toBeUndefined();
  const empty = { pages: [], pageParams: [] };
  expect(mergeNewestPage(empty, page([1]))).toBe(empty);
});
