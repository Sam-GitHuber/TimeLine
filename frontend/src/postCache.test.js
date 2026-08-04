import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidatePostComments, markPostCommentsSeen } from "./postCache.js";

// Zeroing new_comment_count in the caches after a thread is opened (issue #63)
// is what keeps the "N new" badge honest — it follows the server's reset rather
// than a permanent per-card flag, so genuinely-new later comments re-badge.

function post(id, newCount) {
  return { id, comment_count: 5, new_comment_count: newCount };
}

function listData(...posts) {
  return { pages: [{ results: posts, next: null }], pageParams: [undefined] };
}

describe("markPostCommentsSeen", () => {
  it("zeroes the target post's new count in a paginated list, leaving others", () => {
    const qc = new QueryClient();
    qc.setQueryData(["feed", { includeGroups: false }], listData(post(42, 3), post(7, 2)));

    markPostCommentsSeen(qc, 42);

    const results = qc.getQueryData(["feed", { includeGroups: false }]).pages[0].results;
    expect(results.find((p) => p.id === 42).new_comment_count).toBe(0);
    expect(results.find((p) => p.id === 7).new_comment_count).toBe(2);
  });

  it("covers profile and group timelines too", () => {
    const qc = new QueryClient();
    qc.setQueryData(["userPosts", 9], listData(post(42, 4)));
    qc.setQueryData(["groupPosts", 3], listData(post(42, 4)));

    markPostCommentsSeen(qc, 42);

    expect(qc.getQueryData(["userPosts", 9]).pages[0].results[0].new_comment_count).toBe(0);
    expect(qc.getQueryData(["groupPosts", 3]).pages[0].results[0].new_comment_count).toBe(0);
  });

  it("zeroes the single-post permalink query", () => {
    const qc = new QueryClient();
    qc.setQueryData(["post", "42"], post(42, 5));

    markPostCommentsSeen(qc, 42);

    expect(qc.getQueryData(["post", "42"]).new_comment_count).toBe(0);
  });

  it("leaves an unrelated list unchanged (same reference, no needless re-render)", () => {
    const qc = new QueryClient();
    const before = listData(post(7, 1));
    qc.setQueryData(["feed", {}], before);

    markPostCommentsSeen(qc, 42); // 42 isn't in this list

    expect(qc.getQueryData(["feed", {}])).toBe(before);
  });

  it("is a no-op when there's nothing cached", () => {
    const qc = new QueryClient();
    expect(() => markPostCommentsSeen(qc, 42)).not.toThrow();
  });
});

// Invalidating after the tree *changes* (issue #215). The failure this guards
// is a mutation invalidating the comment tree and forgetting the post payload
// that carries `comment_count` — the card then contradicts the list under it.
describe("invalidatePostComments", () => {
  it("invalidates the tree, all three post lists and the permalink", () => {
    const qc = new QueryClient();
    const seen = [];
    qc.invalidateQueries = ({ queryKey }) => seen.push(queryKey);

    invalidatePostComments(qc, 42);

    expect(seen).toEqual([
      ["comments", "post", 42],
      ["feed"],
      ["userPosts"],
      ["groupPosts"],
      ["post", "42"],
    ]);
  });

  it("covers every list markPostCommentsSeen writes to", () => {
    // The two must agree: a list surface that can show a stale "N new" can show
    // a stale total just as easily, so neither may know about a key the other
    // doesn't.
    const qc = new QueryClient();
    qc.setQueryData(["feed", {}], listData(post(42, 1)));
    qc.setQueryData(["userPosts", 9], listData(post(42, 1)));
    qc.setQueryData(["groupPosts", 3], listData(post(42, 1)));
    qc.setQueryData(["post", "42"], post(42, 1));

    invalidatePostComments(qc, 42);

    for (const key of [["feed"], ["userPosts"], ["groupPosts"], ["post", "42"]]) {
      const matches = qc.getQueryCache().findAll({ queryKey: key });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((q) => q.state.isInvalidated)).toBe(true);
    }
  });

  it("leaves an unrelated post's permalink alone", () => {
    const qc = new QueryClient();
    qc.setQueryData(["post", "7"], post(7, 1));

    invalidatePostComments(qc, 42);

    expect(qc.getQueryState(["post", "7"]).isInvalidated).toBe(false);
  });
});
