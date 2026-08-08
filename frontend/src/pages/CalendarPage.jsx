import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { serverMessage, waitingMessage } from "../errors.js";
import EventCard from "../components/events/EventCard.jsx";
import MonthGrid from "../components/events/MonthGrid.jsx";

// The personal calendar (`/calendar`): everything upcoming across the groups
// you're in, each event labelled with its group. Deliberately its own route, not
// merged into the home feed — groups stay in groups by default; this is the
// opt-in aggregate surface. Available as an agenda or the month grid.
export default function CalendarPage() {
  const [view, setView] = useState("agenda");

  const calendar = useQuery({
    queryKey: ["personalCalendar"],
    queryFn: () => api.getPersonalCalendar(),
  });

  const events = calendar.data || [];

  /**
   * **An empty calendar and an unanswered one are different things** (#314).
   * This page had no error branch at all: a failed load leaves `data`
   * undefined, `events` falls back to `[]`, and the empty state below — written
   * as a flat statement of fact — told someone with a group dinner tomorrow
   * that they were free. In Month view it was worse still: a fully drawn empty
   * grid, which reads as a *verified* empty month rather than an empty state.
   *
   * Offline it paints instantly. `main.jsx` builds a bare `new QueryClient()`,
   * so `networkMode` is the default `'online'` and the query sits *paused* —
   * `isLoading` is `isPending && isFetching`, which is false with no data
   * behind it, so there isn't even a spinner to suggest anything is happening.
   * That's #306's lesson: `!isLoading && !isError` is not enough on its own.
   *
   * `!calendar.data` rather than a bare `isError`, the same way round as the
   * rest of the app (*Branch on the data, not the query flags*, `mobile-app.md`):
   * a failed *refetch* keeps the events it already has, and those stay on screen
   * rather than being replaced by an apology (#310/#313).
   */
  const loadFailed = calendar.isError && !calendar.data;

  return (
    <div className="mx-auto max-w-2xl px-5 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold -tracking-[0.02em] text-ink">
          Calendar
        </h1>
        <div className="ev-toggle" role="group" aria-label="Calendar view">
          <button
            type="button"
            onClick={() => setView("agenda")}
            aria-pressed={view === "agenda"}
            className={view === "agenda" ? "ev-toggle--on" : ""}
          >
            Agenda
          </button>
          <button
            type="button"
            onClick={() => setView("month")}
            aria-pressed={view === "month"}
            className={view === "month" ? "ev-toggle--on" : ""}
          >
            Month
          </button>
        </div>
      </div>

      {loadFailed ? (
        <div className="py-12 text-center">
          <p className="font-medium text-red-600">
            {serverMessage(calendar.error, "Couldn’t load your calendar.")}
          </p>
          <button
            type="button"
            onClick={() => calendar.refetch()}
            className="btn btn-ghost btn-sm mt-4"
          >
            Try again
          </button>
        </div>
      ) : !calendar.data ? (
        <p className="text-sm text-ink-faint">{waitingMessage(calendar)}</p>
      ) : events.length === 0 ? (
        <p className="py-12 text-center text-ink-faint">
          Nothing on the calendar. When a group plans an event, it shows up here.
        </p>
      ) : view === "agenda" ? (
        <div className="space-y-3">
          {events.map((e) => (
            <EventCard key={e.id} event={e} showGroup />
          ))}
        </div>
      ) : (
        <MonthGrid events={events} />
      )}
    </div>
  );
}
