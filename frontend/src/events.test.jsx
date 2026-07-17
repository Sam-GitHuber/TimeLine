import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import EventPage from "./pages/EventPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import EventCard from "./components/events/EventCard.jsx";
import MonthGrid from "./components/events/MonthGrid.jsx";
import PlanEventForm from "./components/events/PlanEventForm.jsx";
import Timeline from "./components/Timeline.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// Phase 8b: group events. The visibility/permission rules are enforced (and
// tested exhaustively) on the backend; here we check the frontend wires the
// event UI to the API correctly — the dimension chips, the RSVP control, the
// poll tally (complete count, gated names), the organiser's finalise controls,
// the personal calendar, and plan-an-event.
vi.mock("./api.js", () => ({
  api: {
    getEvent: vi.fn(),
    rsvpEvent: vi.fn().mockResolvedValue({}),
    finaliseEvent: vi.fn().mockResolvedValue({}),
    votePoll: vi.fn().mockResolvedValue({}),
    closePoll: vi.fn().mockResolvedValue({}),
    deletePoll: vi.fn().mockResolvedValue({}),
    createPoll: vi.fn().mockResolvedValue({}),
    cancelEvent: vi.fn().mockResolvedValue({}),
    deleteEvent: vi.fn().mockResolvedValue({}),
    createEvent: vi.fn(),
    getPersonalCalendar: vi.fn(),
  },
}));

const you = { id: 1, display_name: "You", avatar_thumb: null };

function makeEvent(overrides = {}) {
  return {
    id: 7,
    group: { id: 3, name: "Fam" },
    organiser: you,
    title: "Picnic",
    description: "Bring a rug",
    event_date: null,
    start_time: null,
    end_time: null,
    timezone: "UTC",
    location_name: "",
    location_url: "",
    location_note: "",
    status: "planning",
    is_past: false,
    starts_at: null,
    dimensions: {
      date: { state: "polling", poll: 11 },
      time: { state: "unset", poll: null },
      location: { state: "unset", poll: null },
    },
    rsvp: {
      counts: { going: 2, maybe: 1, declined: 0, guests: 0 },
      your_response: null,
      going_list: [you], // only one connected name, though count is 2
      maybe_list: [],
      declined_list: [],
    },
    can_manage: true,
    can_moderate: true,
    polls: [
      {
        id: 11,
        dimension: "date",
        question: "Which date works?",
        allow_multiple: true,
        status: "open",
        closes_at: null,
        options: [
          {
            id: 101,
            label: "Sat 19 Jul",
            date_value: "2026-07-19",
            time_value: null,
            text_value: "",
            count: 2,
            voters: [you],
            you_voted: true,
          },
          {
            id: 102,
            label: "Sun 20 Jul",
            date_value: "2026-07-20",
            count: 1,
            voters: [],
            you_voted: false,
          },
        ],
        your_votes: [101],
        decided_option: null,
      },
      {
        id: 12,
        dimension: "custom",
        question: "What to bring?",
        allow_multiple: false,
        status: "open",
        closes_at: null,
        options: [
          { id: 201, label: "Cake", text_value: "Cake", count: 2, voters: [you], you_voted: false },
          { id: 202, label: "Drinks", text_value: "Drinks", count: 0, voters: [], you_voted: false },
        ],
        your_votes: [],
        decided_option: null,
      },
    ],
    ...overrides,
  };
}

function renderEventPage() {
  return renderWithAuth(
    <Routes>
      <Route path="/g/:id/events/:eid" element={<EventPage />} />
      <Route path="/g/:id" element={<div>group page</div>} />
    </Routes>,
    { route: "/g/3/events/7" }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EventPage", () => {
  it("renders the event, its chip row, and a live poll tally", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();

    expect(await screen.findByText("Picnic")).toBeInTheDocument();
    // The Date chip is polling and shows a compact tally (2 + 1 = 3 votes).
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    // The custom poll question renders (as a chip label and the poll heading).
    expect(screen.getAllByText("What to bring?").length).toBeGreaterThan(0);
  });

  it("shows a complete count even when a voter's name is hidden", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    // The Cake option counts 2 votes though only one voter (you) is named — the
    // other is a connection-gated anonymous +1. The count is honest.
    const cakeRow = screen.getByRole("button", { name: /Cake/ });
    expect(cakeRow).toHaveTextContent("2");
  });

  it("submits an RSVP", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));
    await waitFor(() =>
      expect(api.rsvpEvent).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ response: "going" })
      )
    );
  });

  it("lets a member vote in a poll", async () => {
    api.getEvent.mockResolvedValue(makeEvent({ can_manage: false, can_moderate: false }));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(api.votePoll).toHaveBeenCalledWith(12, [201])
    );
  });

  it("shows chip-level Set/Poll controls to the organiser only", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    const { unmount } = renderEventPage();
    await screen.findByText("Picnic");
    // Organiser: the unset Time/Where chips carry Set · Poll affordances, plus a
    // Pin control on the custom poll and the "ask something else" entry.
    expect(screen.getAllByRole("button", { name: "Set" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Poll" }).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /Ask the group something else/ })
    ).toBeInTheDocument();
    unmount();

    api.getEvent.mockResolvedValue(makeEvent({ can_manage: false, can_moderate: false }));
    renderEventPage();
    await screen.findByText("Picnic");
    // Plain member: the chips are read-only status, no Set/Poll/Pin controls.
    expect(screen.queryByRole("button", { name: "Set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Poll" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
  });

  it("opens a contextual editor when the organiser clicks Set on a chip", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");
    // The first unset chip is Time — clicking its Set opens the time editor.
    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
    expect(
      await screen.findByRole("button", { name: "Set the time" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("guides a brand-new event with a first-step hint", async () => {
    api.getEvent.mockResolvedValue(
      makeEvent({
        event_date: null,
        start_time: null,
        location_name: "",
        polls: [],
        dimensions: {
          date: { state: "unset", poll: null },
          time: { state: "unset", poll: null },
          location: { state: "unset", poll: null },
        },
      })
    );
    renderEventPage();
    expect(await screen.findByText(/Nothing's set yet/)).toBeInTheDocument();
  });

  it("opens a custom poll from 'ask something else'", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(
      screen.getByRole("button", { name: /Ask the group something else/ })
    );
    await userEvent.type(
      screen.getByPlaceholderText(/What should we bring/),
      "Who drives?"
    );
    const opts = screen.getAllByPlaceholderText(/Option/);
    await userEvent.type(opts[0], "Me");
    await userEvent.type(opts[1], "You");
    await userEvent.click(screen.getByRole("button", { name: "Open poll" }));
    await waitFor(() =>
      expect(api.createPoll).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ dimension: "custom", question: "Who drives?" })
      )
    );
  });

  it("finalises a decision when the organiser pins an option", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getAllByRole("button", { name: "Pin" })[0]);
    await waitFor(() =>
      expect(api.finaliseEvent).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ dimension: "custom", optionId: 201 })
      )
    );
  });

  it("shows a friendly not-available state on a 404", async () => {
    api.getEvent.mockRejectedValue({ status: 404 });
    renderEventPage();
    expect(await screen.findByText("Event not available")).toBeInTheDocument();
  });
});

describe("EventCard", () => {
  it("renders a past event as a quiet recap with turnout", () => {
    const past = makeEvent({
      status: "scheduled",
      is_past: true,
      event_date: "2026-06-01",
      starts_at: "2026-06-01T13:00:00Z",
      rsvp: { counts: { going: 6, maybe: 0, declined: 0, guests: 0 } },
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<EventCard event={past} />} />
      </Routes>
    );
    expect(screen.getByText("Event · happened")).toBeInTheDocument();
    expect(screen.getByText("6 went")).toBeInTheDocument();
  });
});

describe("event timeline entries", () => {
  it("renders a past event as a quiet recap on the spine (not a boxed card)", () => {
    const past = makeEvent({
      id: 9,
      title: "Reunion",
      status: "scheduled",
      is_past: true,
      event_date: "2026-06-01",
      start_time: "13:00:00",
      starts_at: "2026-06-01T13:00:00Z",
      location_name: "The Oakhouse",
      dimensions: {
        date: { state: "set" },
        time: { state: "set" },
        location: { state: "set" },
      },
      polls: [],
      rsvp: { counts: { going: 6, maybe: 0, declined: 0, guests: 0 } },
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[past]} />} />
      </Routes>
    );
    expect(screen.getByText("Happened")).toBeInTheDocument();
    expect(screen.getByText("6 went")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reunion/ })).toHaveAttribute(
      "href",
      "/g/3/events/9"
    );
    // The recap is a spine entry, sharing the post entry's structure.
    expect(document.querySelector(".tl-entry--event-past")).toBeTruthy();
    // It keeps the Date · Time · Where pills, like its future self.
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText("Where")).toBeInTheDocument();
  });

  it("renders a future event on the spine with its RSVP counts", () => {
    const fut = makeEvent({
      id: 10,
      title: "Camping",
      status: "scheduled",
      event_date: "2026-08-20",
      starts_at: "2026-08-20T00:00:00Z",
      dimensions: {
        date: { state: "set" },
        time: { state: "unset" },
        location: { state: "unset" },
      },
      polls: [],
      rsvp: { counts: { going: 2, maybe: 1, declined: 0, guests: 0 } },
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline futureEvents={[fut]} />} />
      </Routes>
    );
    expect(screen.getByRole("link", { name: /Camping/ })).toBeInTheDocument();
    expect(screen.getByText(/2 going/)).toBeInTheDocument();
  });
});

describe("MonthGrid", () => {
  it("renders each event inside its day cell, linking to the event", () => {
    renderWithAuth(
      <Routes>
        <Route
          path="/"
          element={
            <MonthGrid
              events={[
                makeEvent({
                  id: 5,
                  title: "Book club",
                  event_date: "2026-08-15",
                  start_time: "14:00:00",
                  status: "scheduled",
                  polls: [],
                }),
              ]}
            />
          }
        />
      </Routes>
    );
    const link = screen.getByRole("link", { name: /Book club/ });
    expect(link).toHaveAttribute("href", "/g/3/events/5");
  });
});

describe("CalendarPage", () => {
  it("shows the empty state when nothing is planned", async () => {
    api.getPersonalCalendar.mockResolvedValue([]);
    renderWithAuth(<CalendarPage />);
    expect(
      await screen.findByText(/Nothing on the calendar/)
    ).toBeInTheDocument();
  });

  it("lists upcoming events across groups", async () => {
    api.getPersonalCalendar.mockResolvedValue([
      makeEvent({ event_date: "2026-08-01", status: "scheduled", polls: [] }),
    ]);
    renderWithAuth(<CalendarPage />);
    expect(await screen.findByText("Picnic")).toBeInTheDocument();
    expect(screen.getByText("Fam")).toBeInTheDocument();
  });
});

describe("PlanEventForm", () => {
  it("creates an event from a title", async () => {
    api.createEvent.mockResolvedValue({ id: 9, group: { id: 3 } });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<PlanEventForm groupId={3} onClose={() => {}} />} />
        <Route path="/g/:id/events/:eid" element={<div>event page</div>} />
      </Routes>
    );
    await userEvent.type(
      screen.getByPlaceholderText(/Grandma's 80th/),
      "Camping trip"
    );
    await userEvent.click(screen.getByRole("button", { name: "Plan an event" }));
    await waitFor(() =>
      expect(api.createEvent).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ title: "Camping trip" })
      )
    );
  });
});
