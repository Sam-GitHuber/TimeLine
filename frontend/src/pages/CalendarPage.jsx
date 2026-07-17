import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
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

      {calendar.isLoading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
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
