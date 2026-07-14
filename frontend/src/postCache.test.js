import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { markPostCommentsSeen } from "./postCache.js";

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
