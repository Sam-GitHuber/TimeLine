import { describe, it, expect } from "vitest";
import { formatRelativeTime, sortByNewest } from "./utils.js";

describe("sortByNewest", () => {
  const older = { id: 1, createdAt: "2026-01-01T00:00:00Z" };
  const newer = { id: 2, createdAt: "2026-06-01T00:00:00Z" };
  const newest = { id: 3, createdAt: "2026-07-01T00:00:00Z" };

  it("orders posts newest-first regardless of input order", () => {
    const result = sortByNewest([older, newest, newer]);
    expect(result.map((p) => p.id)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input array", () => {
    const input = [older, newest, newer];
    sortByNewest(input);
    expect(input.map((p) => p.id)).toEqual([1, 3, 2]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-04T12:00:00Z");

  it("shows 'just now' for very recent times", () => {
    expect(formatRelativeTime("2026-07-04T11:59:40Z", now)).toBe("just now");
  });

  it("shows minutes", () => {
    expect(formatRelativeTime("2026-07-04T11:45:00Z", now)).toBe("15m");
  });

  it("shows hours", () => {
    expect(formatRelativeTime("2026-07-04T09:00:00Z", now)).toBe("3h");
  });

  it("shows days for anything under a week", () => {
    expect(formatRelativeTime("2026-07-02T12:00:00Z", now)).toBe("2d");
  });

  it("falls back to an absolute date past a week", () => {
    // Older than 7 days -> not one of the relative suffixes.
    const result = formatRelativeTime("2026-06-20T12:00:00Z", now);
    expect(result).not.toMatch(/just now|m$|h$|d$/);
  });
});
