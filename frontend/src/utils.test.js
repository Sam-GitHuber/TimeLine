import { describe, it, expect } from "vitest";
import {
  dayHeading,
  dayKey,
  eventLocalStart,
  formatEventDate,
  formatEventTimeParts,
  formatRelativeTime,
} from "./utils.js";

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

// An all-day event's `starts_at`, as the API sends it: midnight in the *event's*
// own timezone. Two of them at opposite ends of the offset range, because the
// bug is a disagreement between that zone and the viewer's — and the viewer's
// here is whatever machine runs the suite. No single offset is mis-read
// everywhere, but between +13 and -11 at least one is mis-read in every zone
// from -12 to +14, so the test can't pass by accident on a lucky runner.
const FAR_EAST_MIDNIGHT = "2026-04-05T00:00:00+13:00";
const FAR_WEST_MIDNIGHT = "2026-04-05T00:00:00-11:00";

describe("formatEventTimeParts", () => {
  it("splits the time from its meridiem, or is null when all-day", () => {
    expect(formatEventTimeParts("14:10")).toEqual({ time: "2:10", meridiem: "pm" });
    expect(formatEventTimeParts(null)).toBeNull();
  });

  // Unlike `formatEventTime`, which says "7pm" in prose. This one renders onto
  // the timeline **rail**, directly above and below post times from
  // `formatClockTime`, which always pads — so an unpadded "7" sits visibly out
  // of the column from a "7:00" one row up. Kept in sync with the mobile copy
  // in `mobile/src/eventFormat.ts`.
  it("pads the minutes on the hour, so the rail column stays aligned", () => {
    expect(formatEventTimeParts("19:00")).toEqual({ time: "7:00", meridiem: "pm" });
    expect(formatEventTimeParts("00:00")).toEqual({ time: "12:00", meridiem: "am" });
    // Seconds are along for the ride on an "HH:MM:SS" value from the API.
    expect(formatEventTimeParts("09:00:00")).toEqual({ time: "9:00", meridiem: "am" });
  });
});

describe("eventLocalStart", () => {
  it("puts an all-day event at local midnight on its own date", () => {
    const d = eventLocalStart({ event_date: "2026-04-05", start_time: null });
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 3, 5]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it("uses the event's own wall clock for a timed event", () => {
    const d = eventLocalStart({ event_date: "2026-04-05", start_time: "19:30:00" });
    expect([d.getHours(), d.getMinutes()]).toEqual([19, 30]);
  });

  it("is null while no date is set", () => {
    expect(eventLocalStart({ event_date: null, start_time: null })).toBeNull();
    expect(eventLocalStart(null)).toBeNull();
  });

  it("gives every all-day event the day its own card shows", () => {
    // #126: the day divider used to come from the `starts_at` *instant*, read in
    // the viewer's zone — so an all-day event landed under the previous (or
    // next) day's divider, contradicting the card right beneath it.
    const events = [FAR_EAST_MIDNIGHT, FAR_WEST_MIDNIGHT].map((starts_at) => ({
      event_date: "2026-04-05",
      start_time: null,
      starts_at,
    }));

    for (const event of events) {
      expect(dayHeading(eventLocalStart(event)).label).toBe(
        formatEventDate(event.event_date)
      );
    }
    // …and this zone really is one where the old instant-based key was wrong for
    // at least one of them, so the assertions above aren't passing by luck.
    expect(
      events.some((e) => dayKey(e.starts_at) !== dayKey(eventLocalStart(e)))
    ).toBe(true);
  });
});
