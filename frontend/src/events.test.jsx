import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import DimensionEditor from "./components/events/DimensionEditor.jsx";
import EventPage from "./pages/EventPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import EventCard from "./components/events/EventCard.jsx";
import MonthGrid from "./components/events/MonthGrid.jsx";
import PlanEventForm from "./components/events/PlanEventForm.jsx";
import Timeline from "./components/Timeline.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { formatEventDate } from "./utils.js";
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
    editPoll: vi.fn().mockResolvedValue({}),
    closePoll: vi.fn().mockResolvedValue({}),
    reopenPoll: vi.fn().mockResolvedValue({}),
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

  // Issue #216: the tally shows your tick before the server has agreed, so a
  // failed vote must take the tick back with it. Left showing, a dropped vote is
  // invisible — the tally not moving reads as "nobody else has voted yet".
  it("takes a failed vote's tick back and says what happened", async () => {
    api.getEvent.mockResolvedValue(makeEvent({ can_manage: false, can_moderate: false }));
    api.votePoll.mockRejectedValueOnce(new Error("This poll is closed."));
    renderEventPage();
    await screen.findByText("Picnic");

    const cake = screen.getByRole("button", { name: /Cake/ });
    expect(cake).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(cake);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This poll is closed."
    );
    expect(screen.getByRole("button", { name: /Cake/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  // Issue #216, the other half: your ticks were seeded once and then owned
  // locally, so a vote cast elsewhere never reached this copy of the page — the
  // counts refreshed and the ticks didn't, and the component contradicted itself.
  it("re-syncs your ticks when the server's answer changes underneath", async () => {
    const member = { can_manage: false, can_moderate: false };
    const before = makeEvent(member);
    // What the next fetch carries: you moved your date vote on your phone, and
    // the Cake vote you're about to cast here has landed.
    const after = makeEvent(member);
    after.polls[0].your_votes = [102];
    after.polls[1].your_votes = [201];
    api.getEvent.mockResolvedValueOnce(before).mockResolvedValue(after);
    renderEventPage();
    await screen.findByText("Picnic");

    const sat = new RegExp(formatEventDate("2026-07-19"));
    const sun = new RegExp(formatEventDate("2026-07-20"));
    expect(screen.getByRole("button", { name: sat })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Voting on the *other* poll invalidates the event; the refetch brings the
    // date vote with it.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: sun })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    expect(screen.getByRole("button", { name: sat })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  // The rollback undoes our own optimistic tick, not whatever the server has
  // said since: a vote that arrives from another device while this request is in
  // flight is the newer truth, and a snapshot taken before the click mustn't
  // wipe it.
  it("doesn't roll back over an answer the server gave mid-vote", async () => {
    const member = { can_manage: false, can_moderate: false };
    const after = makeEvent(member);
    after.polls[1].your_votes = [202]; // Drinks, cast elsewhere
    api.getEvent.mockResolvedValueOnce(makeEvent(member)).mockResolvedValue(after);
    // The Cake vote fails, but only after a refetch (triggered by the RSVP) has
    // brought the Drinks vote in.
    let rejectVote;
    api.votePoll.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectVote = reject))
    );
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Drinks/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );

    rejectVote(new Error("Offline."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline.");
    // The failure is stated, and the newer vote survives it.
    expect(screen.getByRole("button", { name: /Drinks/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /Cake/ })).toHaveAttribute(
      "aria-pressed",
      "false"
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

  it("lets the maker open a multi-choice custom poll", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(
      screen.getByRole("button", { name: /Ask the group something else/ })
    );
    await userEvent.type(
      screen.getByPlaceholderText(/What should we bring/),
      "What to bring?"
    );
    const opts = screen.getAllByPlaceholderText(/Option/);
    await userEvent.type(opts[0], "Cake");
    await userEvent.type(opts[1], "Drinks");
    // A custom poll defaults to single-choice; the maker opts into multiple.
    await userEvent.click(
      screen.getByLabelText(/Let people pick more than one/)
    );
    await userEvent.click(screen.getByRole("button", { name: "Open poll" }));
    await waitFor(() =>
      expect(api.createPoll).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ dimension: "custom", allowMultiple: true })
      )
    );
  });

  it("saves the pick-one/pick-any change when editing a poll", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    // The custom poll (id 12) is single-choice; open its ⋯ menu and edit it.
    const customPoll = screen
      .getByRole("heading", { name: "What to bring?" })
      .closest(".ev-tally");
    await userEvent.click(
      within(customPoll).getByRole("button", { name: "Poll options" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit poll" }));
    // Flip it to pick-any and save.
    await userEvent.click(
      screen.getByLabelText(/Let people pick more than one/)
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.editPoll).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ allowMultiple: true })
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

  it("offers Change and Poll on a dimension that's already set", async () => {
    api.getEvent.mockResolvedValue(
      makeEvent({
        event_date: "2026-08-01",
        dimensions: {
          date: { state: "set" },
          time: { state: "unset" },
          location: { state: "unset" },
        },
      })
    );
    renderEventPage();
    await screen.findByText("Picnic");
    // The set Date chip carries a Poll option alongside Change, so you can still
    // put the decision to the group after setting a value.
    const change = screen.getByRole("button", { name: "Change" });
    const chip = change.closest("li");
    expect(within(chip).getByRole("button", { name: "Poll" })).toBeInTheDocument();
  });

  it("shows a friendly not-available state on a 404", async () => {
    api.getEvent.mockRejectedValue({ status: 404 });
    renderEventPage();
    expect(await screen.findByText("Event not available")).toBeInTheDocument();
  });
});

describe("date & time entry", () => {
  it("hops from hour to minute after two digits", async () => {
    const onSet = vi.fn();
    renderWithAuth(
      <DimensionEditor
        dimension="time"
        mode="set"
        onSet={onSet}
        onPoll={() => {}}
        onCancel={() => {}}
      />
    );
    const hour = screen.getByLabelText("Hour");
    const minute = screen.getByLabelText("Minute");
    await userEvent.type(hour, "10");
    expect(minute).toHaveFocus(); // auto-advanced, no Tab
    await userEvent.type(minute, "00");
    await userEvent.click(screen.getByRole("button", { name: "Set the time" }));
    expect(onSet).toHaveBeenCalledWith("time", "10:00");
  });

  it("hops day → month → year when typing a date", async () => {
    const onSet = vi.fn();
    renderWithAuth(
      <DimensionEditor
        dimension="date"
        mode="set"
        onSet={onSet}
        onPoll={() => {}}
        onCancel={() => {}}
      />
    );
    const day = screen.getByLabelText("Day");
    const month = screen.getByLabelText("Month");
    const year = screen.getByLabelText("Year");
    await userEvent.type(day, "19");
    expect(month).toHaveFocus();
    await userEvent.type(month, "07");
    expect(year).toHaveFocus();
    await userEvent.type(year, "2026");
    await userEvent.click(screen.getByRole("button", { name: "Set the date" }));
    expect(onSet).toHaveBeenCalledWith("date", "2026-07-19");
  });

  it("keeps the button disabled for an impossible date", async () => {
    const onSet = vi.fn();
    renderWithAuth(
      <DimensionEditor
        dimension="date"
        mode="set"
        onSet={onSet}
        onPoll={() => {}}
        onCancel={() => {}}
      />
    );
    await userEvent.type(screen.getByLabelText("Day"), "31");
    await userEvent.type(screen.getByLabelText("Month"), "02");
    await userEvent.type(screen.getByLabelText("Year"), "2026");
    expect(screen.getByRole("button", { name: "Set the date" })).toBeDisabled();
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

  it("files all-day past events under their own date, not the viewer's", () => {
    // #126: the divider used to come from the `starts_at` *instant*, read in the
    // viewer's zone — so an all-day event (midnight in the *event's* zone)
    // landed under the previous day's divider, contradicting the recap right
    // beneath it. Two events on the same day organised in far-apart zones (this
    // app is for families spread across the world): whatever zone the suite runs
    // in, at least one of them is mis-filed by an instant-based key, and both
    // belong under the one "Sun 5 Apr" divider.
    const pastEvents = [
      "2026-04-05T00:00:00+13:00",
      "2026-04-05T00:00:00-11:00",
    ].map((starts_at, i) => ({
      ...makeEvent({
        id: 12 + i,
        title: `Egg hunt ${i}`,
        status: "scheduled",
        is_past: true,
        event_date: "2026-04-05",
        start_time: null,
        dimensions: {
          date: { state: "set" },
          time: { state: "unset" },
          location: { state: "unset" },
        },
        polls: [],
        rsvp: { counts: { going: 2, maybe: 0, declined: 0, guests: 0 } },
      }),
      starts_at,
    }));
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={pastEvents} />} />
      </Routes>
    );
    const dividers = [...document.querySelectorAll(".tl-day-label")].map(
      (el) => el.textContent
    );
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toContain(formatEventDate("2026-04-05"));
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
