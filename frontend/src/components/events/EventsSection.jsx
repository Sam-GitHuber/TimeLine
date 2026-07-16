import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import EventCard from "./EventCard.jsx";
import MonthGrid from "./MonthGrid.jsx";
import PlanEventForm from "./PlanEventForm.jsx";

// The group page's forward-looking events region. On brand, the calendar is the
// timeline's forward mirror: upcoming events sit *above* the now-node (the
// composer below this section), so you scroll up into the planned future and
// down into past posts. The now-node stays at the top of the page on load — this
// region is opt-in, reached by scrolling up — and a conventional month grid
// rides alongside the agenda for practical planning.
//
// The upcoming events (`events` / `isLoading`) are fetched by the parent group
// page so it can settle its scroll-to-now once this region's height is known;
// the month-grid query is owned here (it's only needed in month view).
//
// Events still in `planning` (no date yet) sit in a small "being planned"
// staging strip, off the line; a finalised date moves them onto the agenda.
export default function EventsSection({ groupId, events = [], isLoading = false }) {
  const [view, setView] = useState("agenda"); // "agenda" | "month"
  const [planning, setPlanning] = useState(false);

  const calendar = useQuery({
    queryKey: ["groupCalendar", groupId],
    queryFn: () => api.getGroupCalendar(groupId),
    enabled: view === "month",
  });

  const staging = events.filter((e) => !e.event_date && e.status !== "cancelled");
  const scheduled = events.filter((e) => e.event_date);

  return (
    <section className="border-b border-line px-5 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold -tracking-[0.01em] text-ink">
          Upcoming
        </h2>
        <div className="flex items-center gap-2">
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
          {!planning && (
            <button
              type="button"
              onClick={() => setPlanning(true)}
              className="btn btn-primary btn-sm"
            >
              Plan an event
            </button>
          )}
        </div>
      </div>

      {planning && (
        <div className="mb-4">
          <PlanEventForm groupId={groupId} onClose={() => setPlanning(false)} />
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-ink-faint">Loading events…</p>
      )}

      {view === "agenda" && !isLoading && (
        <>
          {staging.length > 0 && (
            <div className="ev-staging mb-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
                Being planned
              </p>
              <div className="space-y-2">
                {staging.map((e) => (
                  <EventCard key={e.id} event={e} />
                ))}
              </div>
            </div>
          )}

          {scheduled.length > 0 ? (
            <div className="ev-agenda space-y-3">
              {scheduled.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </div>
          ) : (
            staging.length === 0 && (
              <p className="text-sm text-ink-faint">
                No events yet. Plan something — pick a date, or let the group vote
                on one.
              </p>
            )
          )}
        </>
      )}

      {view === "month" && (
        <>
          {calendar.isLoading ? (
            <p className="text-sm text-ink-faint">Loading calendar…</p>
          ) : (
            <MonthGrid events={calendar.data || []} />
          )}
        </>
      )}
    </section>
  );
}
