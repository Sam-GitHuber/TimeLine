import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./utils.js";

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
