import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, useQuery } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import DimensionEditor from "./components/events/DimensionEditor.jsx";
import EventPage from "./pages/EventPage.jsx";
import PollTally from "./components/events/PollTally.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import EventCard from "./components/events/EventCard.jsx";
import MonthGrid from "./components/events/MonthGrid.jsx";
import PlanEventForm from "./components/events/PlanEventForm.jsx";
import Timeline from "./components/Timeline.jsx";
import {
  renderWithAuth,
  apiError,
  offlineError,
  unauthoredError,
  failRefetch,
} from "./test-utils.jsx";
import { formatEventDate, formatEventWhen, parseEventDate } from "./utils.js";
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
    // The photo album.
    getEventPhotos: vi.fn().mockResolvedValue({ results: [], next: null, count: 0 }),
    addEventPhotos: vi.fn().mockResolvedValue([]),
    deleteEventPhoto: vi.fn().mockResolvedValue(undefined),
    getPage: vi.fn(),
    // Comments and reactions on the event itself.
    getComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue({}),
    toggleReaction: vi.fn().mockResolvedValue({ reactions: [] }),
    getReactors: vi.fn().mockResolvedValue([]),
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
    reactions: [],
    comment_count: 0,
    new_comment_count: 0,
    // The album's first few tiles + its (pruned) size. Two numbers on purpose:
    // `photo_count` can exceed `photos.length`, which is what the "+N" is.
    photos: [],
    photo_count: 0,
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

// Move your votes in one of the event's polls to `ids`. The per-option
// `you_voted` flags move with them: the component reads only `your_votes`, but a
// fixture whose two halves disagree would mislead the next person about which of
// them drives the sync. (The app's suite has `movedVotes` for the same reason.)
function setVotes(event, pollIndex, ids) {
  const poll = event.polls[pollIndex];
  poll.your_votes = ids;
  poll.options = poll.options.map((o) => ({ ...o, you_voted: ids.includes(o.id) }));
  return event;
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
  // `clearAllMocks` wipes the *calls*, not the implementations, so a
  // `mockResolvedValue` set inside one test would otherwise be the album (or
  // the upload failure) every test after it inherits. Re-establish the album's
  // defaults here: every test starts from an empty album that accepts uploads,
  // and says so explicitly when it wants otherwise.
  api.getEventPhotos.mockResolvedValue({ results: [], next: null, count: 0 });
  api.addEventPhotos.mockResolvedValue([]);
  api.deleteEventPhoto.mockResolvedValue(undefined);
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

  // Issue #229. `guests`/`note` are typed into RsvpBar but the server owns the
  // answer: `your_response` changes under the mounted page on every refetch,
  // and every RSVP/vote/finalise here ends in one. Seeded once, the fields kept
  // a stale answer beside a fresh "+ N guests" summary — and Update then posted
  // the stale number back, reverting an RSVP made elsewhere.
  function makeRsvpEvent(mine) {
    return makeEvent({
      can_manage: false,
      can_moderate: false,
      rsvp: {
        counts: { going: 2, maybe: 1, declined: 0, guests: mine?.guests || 0 },
        your_response: mine,
        going_list: [you],
        maybe_list: [],
        declined_list: [],
      },
    });
  }

  it("re-derives your guests and note when your RSVP changes underneath", async () => {
    api.getEvent
      .mockResolvedValueOnce(
        makeRsvpEvent({ response: "going", guests: 2, note: "" })
      )
      .mockResolvedValue(
        makeRsvpEvent({ response: "going", guests: 4, note: "bringing wine" })
      );
    renderEventPage();
    await screen.findByText("Picnic");
    expect(screen.getByLabelText(/Bringing guests/)).toHaveValue(2);

    // Voting invalidates the event; the refetch carries the RSVP you changed on
    // your phone a moment ago.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Bringing guests/)).toHaveValue(4)
    );
    expect(screen.getByLabelText(/^Note$/)).toHaveValue("bringing wine");

    // ...and Update sends the newer answer, not the 2 it was seeded with.
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(api.rsvpEvent).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ guests: 4, note: "bringing wine" })
      )
    );
  });

  // The other half of #229: nothing rendered `rsvp.isError`, so a rejected PATCH
  // left the fields showing your text as if it had saved and the count simply
  // not moving — which reads as "nobody else has RSVP'd yet".
  it("says an RSVP that failed didn't save, and keeps what you typed", async () => {
    api.getEvent.mockResolvedValue(
      makeRsvpEvent({ response: "going", guests: 2, note: "" })
    );
    api.rsvpEvent.mockRejectedValueOnce(apiError("Couldn't reach the server."));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.type(screen.getByLabelText(/^Note$/), "bringing wine");
    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach the server."
    );
    // Your text stays put, so pressing Update again retries it as typed.
    expect(screen.getByLabelText(/^Note$/)).toHaveValue("bringing wine");
  });

  // Offline, `fetch` rejects out of itself with a bare TypeError ("Failed to
  // fetch") — no status, and not a sentence to show a person. Offline is also
  // the case this message exists for, so it's the one a tester hits first.
  it("falls back to our own words when the failure isn't the server's", async () => {
    api.getEvent.mockResolvedValue(
      makeRsvpEvent({ response: "going", guests: 2, note: "" })
    );
    api.rsvpEvent.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't save/);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  // The clear is deliberately narrower than "the server said something": only
  // the server *arriving at your attempt* retires the message. A refetch
  // carrying some third answer is not confirmation, and swallowing the failure
  // there would put us back where #229 started — silently.
  it("keeps the failure showing when the server moves to a different answer", async () => {
    api.getEvent
      .mockResolvedValueOnce(
        makeRsvpEvent({ response: "going", guests: 2, note: "" })
      )
      .mockResolvedValue(
        makeRsvpEvent({ response: "maybe", guests: 5, note: "from my phone" })
      );
    api.rsvpEvent.mockRejectedValueOnce(apiError("Couldn't reach the server."));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.type(screen.getByLabelText(/^Note$/), "bringing wine");
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // A refetch brings an answer that is neither what we sent nor what the
    // server held when we sent it. Your attempt still didn't land, so it still
    // says so — even though the fields have moved on to the newer truth.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Maybe/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't reach the server."
    );
  });

  // Re-pressing a response you already hold sends exactly what the server
  // already has, so "the server is confirming the attempt" can't be judged on
  // the answer alone — without also remembering what the server said *before*
  // the attempt, this failure would be cleared the instant it was set.
  it("still says so when the rejected RSVP changed nothing", async () => {
    api.getEvent.mockResolvedValue(
      makeRsvpEvent({ response: "going", guests: 2, note: "" })
    );
    api.rsvpEvent.mockRejectedValueOnce(apiError("Couldn't reach the server."));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach the server."
    );
  });

  // The request had landed after all — only its response was lost. Once the
  // server states that very answer, "didn't save" would be sitting under one
  // that did.
  it("stops saying so once the server confirms the answer that failed", async () => {
    api.getEvent
      .mockResolvedValueOnce(
        makeRsvpEvent({ response: "going", guests: 2, note: "" })
      )
      .mockResolvedValue(
        makeRsvpEvent({ response: "going", guests: 2, note: "bringing wine" })
      );
    api.rsvpEvent.mockRejectedValueOnce(apiError("Couldn't reach the server."));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.type(screen.getByLabelText(/^Note$/), "bringing wine");
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Anything that refetches the event carries the server's answer with it.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
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
    api.votePoll.mockRejectedValueOnce(apiError("This poll is closed.", 400));
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
    setVotes(after, 0, [102]);
    setVotes(after, 1, [201]);
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
    setVotes(after, 1, [202]); // Drinks, cast elsewhere
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

    // Genuinely offline, which since #240 arrives as an `ApiError` carrying our
    // own sentence rather than the browser's "Failed to fetch" — so what the
    // component shows is `PollTally`'s fallback, not anything the server said.
    rejectVote(offlineError());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your vote didn't go through — try again."
    );
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

  // The request had landed after all — only its response was lost. Once the
  // server states that very selection, "your vote didn't go through" would be
  // sitting under a tick the server has confirmed (issue #226). The mobile copy
  // has pinned this since #228; the web never did.
  it("stops saying so once the server confirms the vote that failed", async () => {
    const member = { can_manage: false, can_moderate: false };
    const after = makeEvent(member);
    setVotes(after, 1, [201]); // the Cake vote landed after all
    api.getEvent.mockResolvedValueOnce(makeEvent(member)).mockResolvedValue(after);
    api.votePoll.mockRejectedValueOnce(offlineError());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your vote didn't go through — try again."
    );

    // Anything that refetches the event carries the server's answer with it.
    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    );
  });

  // Issue #231: the clear used to fire on *any* re-sync, so a refetch that spoke
  // about something else swallowed the failure — including when it landed in the
  // same React batch as the rejection, where the message was never painted at
  // all. Judging it on keys recorded at the attempt rather than on the sync
  // arriving is what makes the answer independent of which order they land in.
  it("keeps the failure showing when the server moves to a different vote", async () => {
    const member = { can_manage: false, can_moderate: false };
    const after = makeEvent(member);
    setVotes(after, 1, [202]); // Drinks, cast on the web meanwhile
    api.getEvent.mockResolvedValueOnce(makeEvent(member)).mockResolvedValue(after);
    api.votePoll.mockRejectedValueOnce(apiError("This poll is closed."));
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This poll is closed."
    );

    // A refetch brings a selection that is neither what we cast nor what the
    // server held when we cast it. Your vote still didn't land, so it still says
    // so — even though the ticks have moved on to the newer truth.
    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Drinks/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This poll is closed.");
  });

  // The exact shape issue #231 reports: the new `poll` and the rejection land in
  // **one** React batch, so the component renders once holding both, and a clear
  // that fired on the sync alone ran before the message was ever painted —
  // nothing appeared at all, on patchy signal, which is the case it exists for.
  //
  // `PollTally` directly, not through `EventPage`: React Query hands a cache
  // change to its observers on a **batched timer**, so a refetch resolved beside
  // the rejection shares a batch with it only sometimes — a test built that way
  // passed two runs in three. A `rerender` inside the same `act` is the same
  // condition without the scheduler in it.
  it("keeps the failure showing when the new poll and the rejection share a batch", async () => {
    const poll = makeEvent().polls[1]; // custom, pick-one, no vote of yours
    // Drinks, cast on the phone meanwhile — neither what we cast nor what the
    // server held when we cast it.
    const moved = {
      ...poll,
      your_votes: [202],
      options: poll.options.map((o) => ({ ...o, you_voted: o.id === 202 })),
    };
    let rejectVote;
    const onVote = vi.fn(
      () => new Promise((_, reject) => (rejectVote = reject))
    );
    const { rerender } = render(
      <PollTally poll={poll} onVote={onVote} busy={false} />
    );

    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    expect(onVote).toHaveBeenCalledWith([201]);

    // Both at once. Inside `act`, React holds the rerender and the rejection's
    // `setState` until the scope ends, so they flush as a single render.
    await act(async () => {
      rerender(<PollTally poll={moved} onVote={onVote} busy={false} />);
      rejectVote(offlineError());
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your vote didn't go through — try again."
    );
    // And the sync did happen — the ticks are the server's, not ours.
    expect(screen.getByRole("button", { name: /Drinks/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /Cake/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  // Casting exactly what the server already shows is reachable in the window
  // between a vote landing and its refetch catching up: your tick is ahead of
  // `your_votes`, so tapping it again sends the server its own answer back. So
  // "the server is confirming the attempt" can't be judged on the selection
  // alone — without also remembering what the server said *before* the attempt,
  // this failure would be cleared the instant it was set.
  it("still says so when the rejected vote changed nothing", async () => {
    const member = { can_manage: false, can_moderate: false };
    // The server hasn't caught up: every refetch still reports no vote of yours
    // in the custom poll, so `your_votes` never moves off empty.
    api.getEvent.mockResolvedValue(makeEvent(member));
    api.votePoll
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(apiError("This poll is closed."));
    renderEventPage();
    await screen.findByText("Picnic");

    // Tick Cake. It lands, so the tally is a step ahead of the server.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Cake/ })).not.toBeDisabled()
    );
    expect(screen.getByRole("button", { name: /Cake/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Untick it — an empty selection, which is exactly what the server still
    // reports. That one is refused.
    await userEvent.click(screen.getByRole("button", { name: /Cake/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This poll is closed."
    );
  });

  // `voteKey` sorts, so the fingerprint is order-independent — and a **pick-any**
  // poll is the only place that matters. `Array.from(next)` is insertion order,
  // while DRF promises no order on a reverse relation, so the server can hand the
  // same two votes back the other way round. Drop the sort and the confirm-clear
  // silently stops working for every multi-select poll, with no single-choice
  // test any the wiser.
  it("clears a confirmed pick-any vote whatever order the server lists it in", async () => {
    const member = { can_manage: false, can_moderate: false };
    const after = makeEvent(member);
    setVotes(after, 0, [102, 101]); // both dates, listed the other way round
    api.getEvent.mockResolvedValueOnce(makeEvent(member)).mockResolvedValue(after);
    api.votePoll.mockRejectedValueOnce(offlineError());
    renderEventPage();
    await screen.findByText("Picnic");

    // The date poll is pick-any and you already hold Sat, so ticking Sun casts
    // both — insertion order, [101, 102].
    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(formatEventDate("2026-07-20")) })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your vote didn't go through — try again."
    );

    // It had landed after all, and the server states both — in its own order.
    await userEvent.click(screen.getByRole("button", { name: /^Going/ }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
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

  // Issue #310. `retry: false` on this query means a single dropped packet on
  // the *first* load left `isLoading` false with no data — and the page then
  // told you the event may have been cancelled, which the client has no way of
  // knowing. Only a 404 is allowed to say that now.
  it("says the load failed, not that the event was cancelled, on a 500", async () => {
    api.getEvent.mockRejectedValue(unauthoredError(500));
    renderEventPage();
    expect(
      await screen.findByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
    expect(screen.queryByText("Event not available")).toBeNull();
  });

  // …and a failed *refresh* of an event already on screen keeps it there: the
  // polls, the RSVP bar with a typed guest count, the album, the comments. The
  // page refetches on window focus and again after every RSVP or vote, so this
  // is routine.
  it("keeps a loaded event on screen when a refresh fails", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    const { queryClient } = renderEventPage();
    await screen.findByText("Picnic");

    api.getEvent.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["event", 7]);

    expect(screen.getByText("Picnic")).toBeInTheDocument();
    expect(screen.queryByText("Event not available")).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("still takes the event away when a refresh 404s", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    const { queryClient } = renderEventPage();
    await screen.findByText("Picnic");

    api.getEvent.mockRejectedValue(apiError("Not found.", 404));
    await failRefetch(queryClient, ["event", 7]);

    expect(await screen.findByText("Event not available")).toBeInTheDocument();
    expect(screen.queryByText("Picnic")).toBeNull();
  });
});

// Issue #237. `onSuccess` is the only place these writes repaint anything, so a
// rejection left the page byte-identical to a success — and on the organiser's
// controls that's the difference between "everyone was told the picnic is off"
// and nobody being told. Each of the five now reports where it was pressed,
// following `connections.md#reporting-a-refused-write`: the server's own words
// when it wrote any, our per-state fallback otherwise.
describe("EventPage — a refused organiser write says so", () => {
  it("states a refused cancel, in the server's own words", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.cancelEvent.mockRejectedValueOnce(
      apiError("You can no longer manage this event.", 403)
    );
    renderEventPage();
    await screen.findByText("Picnic");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "Cancel event" }));
    confirm.mockRestore();

    await waitFor(() => expect(api.cancelEvent).toHaveBeenCalledWith(7));
    expect(
      await screen.findByText("You can no longer manage this event.")
    ).toBeInTheDocument();
    // Nothing else moved — no "Cancelled" tag — which is precisely why the
    // message has to exist: there is no other tell.
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
  });

  it("states a refused delete, and leaves you on the event", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    // Offline is the likeliest way any write fails, and since #240 it arrives
    // carrying our own sentence rather than the server's — so this is the case
    // the per-state fallback exists for.
    api.deleteEvent.mockRejectedValueOnce(offlineError());
    renderEventPage();
    await screen.findByText("Picnic");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    confirm.mockRestore();

    expect(
      await screen.findByText("Couldn't delete the event — try again.")
    ).toBeInTheDocument();
    // `navigate` runs from `onSuccess` only, so you're still looking at the
    // event you believe you deleted — indistinguishable from a slow request,
    // and the natural next move is to press it again.
    expect(screen.queryByText("group page")).not.toBeInTheDocument();
  });

  it.each([
    ["Close poll", "closePoll"],
    ["Remove poll", "deletePoll"],
  ])("states a refused %s on the poll it was pressed on", async (item, method) => {
    api.getEvent.mockResolvedValue(makeEvent());
    api[method].mockRejectedValueOnce(apiError("That poll no longer exists.", 404));
    renderEventPage();
    await screen.findByText("Picnic");

    const customPoll = screen
      .getByRole("heading", { name: "What to bring?" })
      .closest(".ev-tally");
    await userEvent.click(
      within(customPoll).getByRole("button", { name: "Poll options" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: item }));

    await waitFor(() => expect(api[method]).toHaveBeenCalledWith(12));
    // On that card — the ⋯ menu is part of it, and the date poll above is a
    // different question the organiser didn't touch.
    expect(await within(customPoll).findByRole("alert")).toHaveTextContent(
      "That poll no longer exists."
    );
  });

  // The path that had no renderer at all: the page's finalise paragraph lived
  // inside `{editing && …}`, and Pin finalises with the editor closed.
  it("states a refused Pin with no editor open", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.finaliseEvent.mockRejectedValueOnce(
      apiError("Someone has already set that.", 409)
    );
    renderEventPage();
    await screen.findByText("Picnic");
    // No editor is open — the chip row shows Set/Poll affordances, not a form.
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Pin" })[0]);

    await waitFor(() => expect(api.finaliseEvent).toHaveBeenCalled());
    expect(
      await screen.findByText("Someone has already set that.")
    ).toBeInTheDocument();
  });

  // The other half of the same rule: the editor is now the only renderer of its
  // own rejection, so it may not be dismissed while that write is in flight.
  it("holds the editor's Cancel while its Set is in flight, then states the failure", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    let rejectSet;
    api.finaliseEvent.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectSet = reject))
    );
    renderEventPage();
    await screen.findByText("Picnic");

    // The first unset chip is Time; open its editor and set a value.
    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
    await userEvent.type(await screen.findByLabelText("Hour"), "10");
    await userEvent.type(screen.getByLabelText("Minute"), "00");
    await userEvent.click(screen.getByRole("button", { name: "Set the time" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    );

    rejectSet(apiError("That time has already passed.", 400));
    expect(
      await screen.findByText("That time has already passed.")
    ).toBeInTheDocument();
    // Still open, so the message is still there to read.
    expect(screen.getByRole("button", { name: "Set the time" })).toBeInTheDocument();
  });

  // The chip row sits directly above the editor that reports the write, and
  // picking a different chip swaps that editor out — so it's a dismissal route
  // like the Cancel beside it, and needs the same hold.
  it("holds the chip row while an editor's write is in flight", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    let rejectSet;
    api.finaliseEvent.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectSet = reject))
    );
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
    await userEvent.type(await screen.findByLabelText("Hour"), "10");
    await userEvent.type(screen.getByLabelText("Minute"), "00");
    await userEvent.click(screen.getByRole("button", { name: "Set the time" }));

    // Every chip action is held — including the other chips', which is the one
    // that would have swapped this editor out from under its own message.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Poll" })[0]).toBeDisabled()
    );
    expect(screen.getAllByRole("button", { name: "Set" })[1]).toBeDisabled();

    // Released once it settles, so the failure can be acted on.
    rejectSet(apiError("That time has already passed.", 400));
    await screen.findByText("That time has already passed.");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Poll" })[0]).toBeEnabled()
    );
  });

  // …and once it has settled, moving to another chip must not carry the old
  // message under the new form. Mobile keys its editor for exactly this.
  it("doesn't carry a settled editor error over to the next chip", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.finaliseEvent.mockRejectedValueOnce(
      apiError("That time has already passed.", 400)
    );
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[0]);
    await userEvent.type(await screen.findByLabelText("Hour"), "10");
    await userEvent.type(screen.getByLabelText("Minute"), "00");
    await userEvent.click(screen.getByRole("button", { name: "Set the time" }));
    expect(
      await screen.findByText("That time has already passed.")
    ).toBeInTheDocument();

    // Switch to the Where chip's Set without cancelling first ([0] is Time,
    // still open; the Date chip is polling, so it offers no Set).
    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[1]);
    expect(await screen.findByLabelText("Set the place")).toBeInTheDocument();
    expect(
      screen.queryByText("That time has already passed.")
    ).not.toBeInTheDocument();
  });

  // The free-value box beside a poll: a rejection that also wiped what you typed
  // would make the retry mean typing it again.
  it("keeps a typed free value when finalising it is refused", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.finaliseEvent.mockRejectedValueOnce(offlineError());
    renderEventPage();
    await screen.findByText("Picnic");

    // The date poll's card carries the free-value form (custom polls don't).
    const datePoll = screen
      .getByRole("heading", { name: "Which date works?" })
      .closest(".ev-tally");
    const field = within(datePoll).getByLabelText("Set the date");
    await userEvent.type(field, "2026-08-01");
    await userEvent.click(
      within(datePoll).getByRole("button", { name: "Set the date" })
    );

    expect(
      await within(datePoll).findByText("Couldn't set the date — try again.")
    ).toBeInTheDocument();
    expect(field).toHaveValue("2026-08-01");
  });
});

// An event is authored content, so it carries the same pair a post does. The
// visibility rules are the server's (and tested there); what matters here is
// that the thread and the chips are wired to the *event*, not to a post.
describe("EventPage — comments and reactions", () => {
  it("loads the thread for the event, not for a post of the same id", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    // The two id spaces are separate: event 7 and post 7 both exist, so a
    // thread keyed or routed on the bare number would fetch the wrong one.
    await waitFor(() =>
      expect(api.getComments).toHaveBeenCalledWith({ eventId: 7, groupId: 3 })
    );
  });

  it("posts a comment onto the event", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.type(
      await screen.findByPlaceholderText("Write a comment…"),
      "are we still on?"
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(api.addComment).toHaveBeenCalledWith(
        { eventId: 7, groupId: 3 },
        { text: "are we still on?", parent: null }
      )
    );
  });

  it("toggles a reaction on the event", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.toggleReaction.mockResolvedValue({
      reactions: [{ emoji: "🎉", count: 1, reacted: true }],
    });
    renderEventPage();
    await screen.findByText("Picnic");

    await userEvent.click(screen.getByRole("button", { name: "Add a reaction" }));
    await userEvent.click(await screen.findByRole("button", { name: /🎉/ }));

    await waitFor(() =>
      expect(api.toggleReaction).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 7, emoji: "🎉" })
      )
    );
  });

  it("renders the reaction chips the server sent", async () => {
    api.getEvent.mockResolvedValue(
      makeEvent({ reactions: [{ emoji: "🎉", count: 3, reacted: false }] })
    );
    renderEventPage();

    expect(await screen.findByText("3")).toBeInTheDocument();
  });

  it("shows the comment count beside the chips", async () => {
    api.getEvent.mockResolvedValue(makeEvent({ comment_count: 4 }));
    renderEventPage();

    expect(await screen.findByText("4 comments")).toBeInTheDocument();
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
  // One past recap, shared by the tests below so the fixture has a single home.
  const makePastReunion = (overrides = {}) =>
    makeEvent({
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
      ...overrides,
    });

  it("renders a past event as a quiet recap on the spine (not a boxed card)", () => {
    const past = makePastReunion();
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[past]} />} />
      </Routes>
    );
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
    // #293: and it no longer wears a "Happened" tag — its position below the
    // now-node, under a dated divider among posts equally in the past, says it.
    expect(screen.queryByText("Happened")).toBeNull();
  });

  it("doesn't repeat a past recap's when under its title (#293)", () => {
    // The rail carries the clock time, the day divider above carries the date,
    // and the Date · Time chips carry what the event settled on. The meta line
    // used to write both again — a boxed card's line, left behind when the entry
    // moved onto the spine — so the date read three times and the time three
    // times. It now carries the organiser and the venue only.
    const past = makePastReunion();
    // Rendered the way `GroupPage` really renders it — a composer at the now
    // node and a post below — because both of those carry a `.tl-rail` and a
    // `.tl-body` of their own, and a bare first-match selector would read them.
    renderWithAuth(
      <Routes>
        <Route
          path="/"
          element={
            <Timeline
              pastEvents={[past]}
              posts={[
                {
                  id: 1,
                  author: you,
                  body: "A post on the same spine",
                  created_at: "2026-06-01T09:00:00Z",
                  comment_count: 0,
                },
              ]}
              header={<div className="tl-entry tl-now-anchor" />}
            />
          }
        />
      </Routes>
    );
    const entry = document.querySelector(".tl-entry--event-past");
    // Derived, never spelled out: these go through `toLocaleDateString`, so a
    // hardcoded "Mon 1 Jun" passes here and fails on CI, which renders
    // "Mon, Jun 1". That exact mistake failed CI on #292.
    expect(within(entry).queryByText(formatEventWhen(past))).toBeNull();
    expect(within(entry).getByText("You · The Oakhouse")).toBeInTheDocument();
    // What does say when: the rail's clock time, and the chips. (The rail pads
    // its minutes and the chip doesn't — the rail shares a column with the
    // posts' clock times and has to come out their width; see events.md.)
    const rail = entry.querySelector(".tl-rail time");
    expect(within(entry.querySelector(".tl-rail")).getByText("1:00pm"))
      .toBeInTheDocument();
    expect(
      within(entry.querySelector(".ev-chips")).getByText(
        formatEventDate("2026-06-01")
      )
    ).toBeInTheDocument();
    expect(
      within(entry.querySelector(".ev-chips")).getByText("1pm")
    ).toBeInTheDocument();
    // The rail splits over two lines, so — as `PostCard` does for its clock
    // time — it hands the whole when to assistive tech and to the tooltip. That
    // matters more now the body doesn't write it.
    expect(rail).toHaveAttribute("aria-label", formatEventWhen(past));
    expect(rail).toHaveAttribute("title", formatEventWhen(past));
  });

  it("labels an all-day past recap's rail, and keeps it a <time> (#293)", () => {
    // The visible rail reads "all" / "day" with no date at all, so the label is
    // the only unambiguous statement of when for a screen reader. `<time>` also
    // picks up `.tl-rail > time`, which is what lines it up with the clock times
    // above and below it in the same column.
    const past = makePastReunion({ start_time: null });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[past]} />} />
      </Routes>
    );
    const rail = document
      .querySelector(".tl-entry--event-past")
      .querySelector(".tl-rail time");
    expect(rail.textContent).toBe("allday");
    expect(rail).toHaveAttribute(
      "aria-label",
      `${formatEventDate("2026-06-01")} · all day`
    );
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
    // #293: a future entry doesn't write its when under the title either — the
    // accent rail beside it dates it and the chips hold the record, so writing
    // it here made three statements of the date. Read off the meta line itself,
    // since the Date chip legitimately states the same date.
    const entry = document.querySelector(".tl-entry--event");
    expect(entry.querySelector(".tl-body p").textContent).toBe("You");
    // The rail dates it in the accent day/month form, and the Date chip holds
    // the full record — the two places a future entry is allowed to say it.
    // Derived, never spelled out: the month goes through `toLocaleDateString`,
    // so a hardcoded "Aug" passes here and fails a French runner on "août".
    const rail = entry.querySelector(".tl-rail time");
    expect(rail).toHaveAttribute("dateTime", "2026-08-20");
    expect(rail.textContent).toBe(
      `20${parseEventDate("2026-08-20").toLocaleDateString(undefined, {
        month: "short",
      })}`
    );
    // The rail shows no year, so its label carries the whole date — the fix for
    // two upcoming events twelve months apart drawing the same two lines. This
    // fixture sets no `start_time`, so it says so rather than implying midnight.
    expect(rail).toHaveAttribute(
      "aria-label",
      `${formatEventWhen(fut)} · all day`
    );
    expect(
      within(entry.querySelector(".ev-chips")).getByText(
        // The chip renders `formatEventDate`, not `formatEventWhen` — they only
        // coincide while this fixture has no `start_time`.
        formatEventDate("2026-08-20")
      )
    ).toBeInTheDocument();
  });

  it("carries the reaction row and comment count, as a post on this spine does", () => {
    const ev = makeEvent({
      id: 11,
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
      rsvp: { counts: { going: 0, maybe: 0, declined: 0, guests: 0 } },
      reactions: [{ emoji: "🎉", count: 2, reacted: false }],
      comment_count: 3,
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline futureEvents={[ev]} />} />
      </Routes>
    );

    expect(screen.getByText("2")).toBeInTheDocument();
    // The count links through to the event page rather than expanding the
    // thread in place, unlike a post's — an event's conversation lives beside
    // its polls, its RSVP and its chips.
    expect(
      screen.getByRole("link", { name: /3 comments/ })
    ).toHaveAttribute("href", "/g/3/events/11");
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

  // #314. A failed load left `data` undefined, `events` fell back to `[]`, and
  // this page told someone with a group dinner tomorrow that they were free.
  it("says the load failed instead of claiming the calendar is empty", async () => {
    api.getPersonalCalendar.mockRejectedValue(offlineError());
    renderWithAuth(<CalendarPage />);
    expect(
      await screen.findByText("Couldn’t load your calendar.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing on the calendar/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // The Month view is the worse half: a fully drawn empty grid reads as a
  // *verified* empty month, not as an empty state.
  it("doesn't draw an empty month grid for a failed load", async () => {
    const user = userEvent.setup();
    api.getPersonalCalendar.mockRejectedValue(offlineError());
    renderWithAuth(<CalendarPage />);
    await screen.findByText("Couldn’t load your calendar.");
    await user.click(screen.getByRole("button", { name: "Month" }));
    // The grid names its weekdays; none of them are on screen.
    expect(screen.queryByText("Mon")).toBeNull();
    expect(screen.getByText("Couldn’t load your calendar.")).toBeInTheDocument();
  });

  // The other half of the rule (#310/#313): a failed *refresh* keeps what's up.
  it("keeps the events it has when a refetch fails", async () => {
    api.getPersonalCalendar.mockResolvedValue([
      makeEvent({ event_date: "2026-08-01", status: "scheduled", polls: [] }),
    ]);
    const { queryClient } = renderWithAuth(<CalendarPage />);
    await screen.findByText("Picnic");

    api.getPersonalCalendar.mockRejectedValue(offlineError());
    await failRefetch(queryClient, ["personalCalendar"]);

    expect(screen.getByText("Picnic")).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load your calendar.")).toBeNull();
  });

  /**
   * The state that is neither loading nor errored, and the one the first cut of
   * this fix missed. With `networkMode: 'online'` (a bare `new QueryClient()`)
   * a query on an offline browser is **paused**: `status` stays `pending`,
   * `fetchStatus` goes to `paused`, the request is never sent, and `isLoading`
   * — `isPending && isFetching` — is *false* with no data behind it. Gating the
   * empty state on `!isLoading` therefore let it render anyway. #306 hit this
   * in `CommentThread`; the branch every screen owes this state is `!data`.
   */
  it("says it's waiting for a connection, not that the calendar is empty", async () => {
    api.getPersonalCalendar.mockResolvedValue([]);
    onlineManager.setOnline(false);
    try {
      renderWithAuth(<CalendarPage />);
      expect(
        await screen.findByText("Waiting for a connection…")
      ).toBeInTheDocument();
      expect(screen.queryByText(/Nothing on the calendar/)).toBeNull();
      // The request was never sent — this is not a failure, it's a pause.
      expect(api.getPersonalCalendar).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // Retrying has to actually ask again.
  it("refetches when Try again is pressed", async () => {
    const user = userEvent.setup();
    api.getPersonalCalendar.mockRejectedValue(offlineError());
    renderWithAuth(<CalendarPage />);
    await screen.findByText("Couldn’t load your calendar.");

    api.getPersonalCalendar.mockResolvedValue([
      makeEvent({ event_date: "2026-08-01", status: "scheduled", polls: [] }),
    ]);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Picnic")).toBeInTheDocument();
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

// What an event write *refreshes*, not just what it calls (issue #279).
//
// Ten of `EventPage`'s eleven writes shared one `invalidate()`; delete named
// `["groupEvents"]` alone and navigated. And no web write anywhere named
// `["personalCalendar"]`, though `CalendarPage` reads it — a whole surface the
// write side had never heard of, which is exactly how a key gets missed.
//
// Both surfaces are **mounted alongside** the page doing the write rather than
// seeded into the cache, because a seeded but unobserved entry refetches on its
// next mount whatever we do, and would pass against the broken build. They sit
// outside the `<Routes>` so that navigating away — which delete does — doesn't
// take the thing under test with it. Same reasoning as
// `group-membership-cache.test.jsx`.
// The album. Who may see which photo is enforced (and tested exhaustively) on
// the backend; here we check what the client owns — that a card shows the
// previews and says how many more there are, that the "+N" goes to the page
// that actually holds them, and that the album page itself is honest about
// what it has (an upload you can see, an error that doesn't read as "empty").
function makePhoto(id, uploader = you, overrides = {}) {
  return {
    id,
    image: `https://x/full-${id}.jpg`,
    thumbnail: `https://x/thumb-${id}.jpg`,
    width: 120,
    height: 90,
    uploader,
    created_at: "2026-06-01T10:00:00Z",
    can_delete: false,
    ...overrides,
  };
}

describe("event photos", () => {
  const ali = { id: 2, display_name: "Ali", avatar_thumb: null };

  it("shows the album's previews on a timeline entry", () => {
    const event = makeEvent({
      id: 9,
      title: "Reunion",
      status: "scheduled",
      is_past: true,
      event_date: "2026-06-01",
      start_time: "13:00:00",
      starts_at: "2026-06-01T13:00:00Z",
      polls: [],
      photos: [makePhoto(1), makePhoto(2)],
      photo_count: 2,
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[event]} />} />
      </Routes>
    );
    expect(
      screen.getByRole("button", { name: "View event photo 1 of 2" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View event photo 2 of 2" })
    ).toBeInTheDocument();
  });

  // An entry with four preview tiles standing in front of an eleven-photo
  // album — the shape every card-side assertion below is about.
  function previewEvent(overrides = {}) {
    return makeEvent({
      id: 9,
      title: "Reunion",
      status: "scheduled",
      is_past: true,
      event_date: "2026-06-01",
      starts_at: "2026-06-01T13:00:00Z",
      polls: [],
      photos: [1, 2, 3, 4].map((n) => makePhoto(n)),
      photo_count: 11,
      ...overrides,
    });
  }

  it("caps the tiles at four and puts the rest behind a +N that leads to the event", () => {
    // The two numbers earning their keep: the payload carries four photos, the
    // album holds eleven, and the card has to say so rather than imply the
    // album is what it was sent. The "+N" is a **link to the event page**, not
    // a viewer button: the album is paginated and the card holds four of it.
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[previewEvent()]} />} />
      </Routes>
    );
    expect(document.querySelectorAll(".tl-entry--event img")).toHaveLength(4);
    expect(screen.getByText("+7")).toBeInTheDocument();
    const more = screen.getByRole("link", {
      name: "See all 11 photos on the event",
    });
    expect(more).toHaveAttribute("href", "/g/3/events/9");
    // And the tiles that *do* open the viewer count against the previews, not
    // the album: the viewer they open holds four, so "1 of 11" would be the
    // card describing photos it hasn't got.
    expect(
      screen.getByRole("button", { name: "View event photo 1 of 4" })
    ).toBeInTheDocument();
  });

  it("opens a preview tile on the previews alone, fetching nothing", async () => {
    // The card requests no album at all now. It used to fetch one on open with
    // a plain `useQuery` — which gets page 1 and no more, so the viewer read
    // "1 / 20" on an album of fifty — and cached that page-shaped answer under
    // the key the event page reads as an infinite query. See the next test.
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[previewEvent()]} />} />
      </Routes>
    );

    await userEvent.click(
      screen.getByRole("button", { name: "View event photo 1 of 4" })
    );

    const viewer = await screen.findByRole("dialog", { name: "Photo viewer" });
    // 1 / 4 — the counter and the tile's label agree, and both are true.
    expect(within(viewer).getByText("1 / 4")).toBeInTheDocument();
    expect(api.getEventPhotos).not.toHaveBeenCalled();
  });

  it("survives a card's viewer and then the event page in one cache", async () => {
    // The crash this replaced: two components read `['eventPhotos', id]` with
    // incompatible shapes, so whichever mounted second got the other's answer —
    // `InfiniteQueryObserver` destructured `{pages}` off a bare DRF page and
    // threw on `pages.length`, unmounting the whole app (there's no error
    // boundary) to a blank white page. Both surfaces, both orders, one
    // QueryClient: only `EventPhotos` reads that key now.
    api.getEvent.mockResolvedValue(previewEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [1, 2, 3, 4, 5].map((n) => makePhoto(n, ali)),
      next: null,
      count: 5,
    });
    renderWithAuth(
      <Routes>
        <Route path="/" element={<Timeline pastEvents={[previewEvent()]} />} />
        <Route path="/g/:id/events/:eid" element={<EventPage />} />
      </Routes>
    );

    // Open the card's viewer first — the write that used to poison the key.
    await userEvent.click(
      screen.getByRole("button", { name: "View event photo 1 of 4" })
    );
    expect(
      await screen.findByRole("dialog", { name: "Photo viewer" })
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // Then walk to the event page the "+N" points at, well inside `gcTime`.
    await userEvent.click(
      screen.getByRole("link", { name: "See all 11 photos on the event" })
    );

    expect(await screen.findByRole("heading", { name: /Photos/ })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "View photo 5 of 5" })
    ).toBeInTheDocument();
  });

  it("lists the album on the event page and names who added each photo", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [makePhoto(1, ali)],
      next: null,
      count: 1,
    });
    renderEventPage();

    expect(await screen.findByRole("heading", { name: /Photos/ })).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "View photo 1 of 1" })
    );
    const viewer = await screen.findByRole("dialog", { name: "Photo viewer" });
    expect(within(viewer).getByText("Ali")).toBeInTheDocument();
  });

  it("says the album is *this viewer's* slice, never that it's empty", async () => {
    // Deliberate wording: what you see is pruned to the uploaders you may see,
    // so "no photos yet" would be a claim the client can't make.
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    expect(
      await screen.findByText("No photos here yet — add the first.")
    ).toBeInTheDocument();
  });

  it("uploads what you pick and says so when the server refuses", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.addEventPhotos.mockRejectedValue(
      apiError("This event's album is full (200 photos). Remove some first.", 400)
    );
    renderEventPage();
    await screen.findByRole("heading", { name: /Photos/ });

    const file = new File(["x"], "beach.jpg", { type: "image/jpeg" });
    await userEvent.upload(
      screen.getByLabelText("Add photos to this event"),
      file
    );

    await waitFor(() => expect(api.addEventPhotos).toHaveBeenCalledWith(7, [file]));
    // The server's own words — "which photo, and why not?" is most of the value,
    // and a generic failure line would drop both.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event's album is full"
    );
  });

  it("falls back to its own words when the failure came from the network", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.addEventPhotos.mockRejectedValue(offlineError());
    renderEventPage();
    await screen.findByRole("heading", { name: /Photos/ });

    await userEvent.upload(
      screen.getByLabelText("Add photos to this event"),
      new File(["x"], "beach.jpg", { type: "image/jpeg" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't add those photos."
    );
  });

  it("only offers Remove on a photo the payload says you can remove", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [makePhoto(1, ali, { can_delete: false })],
      next: null,
      count: 1,
    });
    renderEventPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "View photo 1 of 1" })
    );
    const viewer = await screen.findByRole("dialog", { name: "Photo viewer" });
    expect(
      within(viewer).queryByRole("button", { name: "Remove this photo" })
    ).not.toBeInTheDocument();
  });

  it("confirms before removing, then removes", async () => {
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [makePhoto(1, you, { can_delete: true })],
      next: null,
      count: 1,
    });
    renderEventPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "View photo 1 of 1" })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove this photo" })
    );
    // A photo comes off for everyone, so it stops at a confirm — the same rule
    // a post's delete follows, with wording specific to what it takes.
    const dialog = await screen.findByRole("dialog", { name: "Remove photo" });
    expect(api.deleteEventPhoto).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteEventPhoto).toHaveBeenCalledWith(1));
  });

  // The confirm dialog opens *over* the open viewer — the album is the first
  // place in the app where two layers stack, and both of them used to assume
  // they were the only one. See `components/modalLayer.js`.
  async function openTheConfirmOverTheViewer() {
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [makePhoto(1, you, { can_delete: true })],
      next: null,
      count: 1,
    });
    renderEventPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "View photo 1 of 1" })
    );
    expect(document.body.style.overflow).toBe("hidden");
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove this photo" })
    );
    return await screen.findByRole("dialog", { name: "Remove photo" });
  }

  it("gives the page its scroll back when both layers close at once", async () => {
    const dialog = await openTheConfirmOverTheViewer();

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteEventPhoto).toHaveBeenCalledWith(1));

    // Both unmount in one commit, and React runs their cleanups in child order.
    // With a saved-and-restored `overflow` in each, the viewer put back "" and
    // the dialog then put back the "hidden" it had captured *from the viewer* —
    // and nothing in the app could scroll again until a reload.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove photo" })).toBeNull()
    );
    await waitFor(() => expect(document.body.style.overflow).toBe(""));
  });

  it("closes the confirm dialog on Escape, not the viewer under it", async () => {
    await openTheConfirmOverTheViewer();

    await userEvent.keyboard("{Escape}");

    // The viewer listens in the capture phase and stops propagation there (it
    // has to: it opens inside the messages drawer, which closes on Escape too).
    // The dialog listened in the bubble phase, which that flag skips — so the
    // press went to the layer *underneath*, closing the photo and leaving the
    // confirm hanging over nothing.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove photo" })).toBeNull()
    );
    expect(
      screen.getByRole("dialog", { name: "Photo viewer" })
    ).toBeInTheDocument();
    expect(api.deleteEventPhoto).not.toHaveBeenCalled();
  });

  it("shows the photos you just added to an album longer than one page", async () => {
    // The album is ordered oldest-first, so an upload lands on its **last**
    // page — and only the first was ever loaded. The count in the heading went
    // 20 → 23, the grid stayed at 20, a "Load more" quietly appeared, and from
    // where the user is standing the upload did nothing: so they press Add
    // again, and spend the 200-photo cap twice.
    api.getEvent.mockResolvedValue(makeEvent());
    const firstPage = Array.from({ length: 20 }, (_, i) => makePhoto(i + 1));
    api.getEventPhotos.mockResolvedValue({
      results: firstPage,
      next: null,
      count: 20,
    });
    renderEventPage();
    expect(
      await screen.findByRole("button", { name: "View photo 20 of 20" })
    ).toBeInTheDocument();

    // From here the server holds 23, so page 1 no longer ends the album.
    api.getEventPhotos.mockResolvedValue({
      results: firstPage,
      next: "/api/events/7/photos/?page=2",
      count: 23,
    });
    api.getPage.mockResolvedValue({
      results: [21, 22, 23].map((n) => makePhoto(n)),
      next: null,
      count: 23,
    });

    await userEvent.upload(
      screen.getByLabelText("Add photos to this event"),
      new File(["x"], "beach.jpg", { type: "image/jpeg" })
    );

    await waitFor(() => expect(api.addEventPhotos).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: "View photo 23 of 23" })
    ).toBeInTheDocument();
    expect(api.getPage).toHaveBeenCalledWith("/api/events/7/photos/?page=2");
  });

  it("uploads at most one batch of what you picked, and says what it left", async () => {
    // Nothing stopped a "select all" in a phone's picker: thirty full-size
    // photos went up through the parser to be rejected wholesale, saving none —
    // and over a hundred files Django refuses the request before the view can
    // even say why. Both post composers cap for exactly this reason.
    api.getEvent.mockResolvedValue(makeEvent());
    renderEventPage();
    await screen.findByRole("heading", { name: /Photos/ });

    const picked = Array.from(
      { length: 12 },
      (_, i) => new File(["x"], `beach-${i}.jpg`, { type: "image/jpeg" })
    );
    await userEvent.upload(
      screen.getByLabelText("Add photos to this event"),
      picked
    );

    await waitFor(() =>
      expect(api.addEventPhotos).toHaveBeenCalledWith(7, picked.slice(0, 10))
    );
    // And the two that didn't go are said out loud — a silent trim is the same
    // "did that work?" the upload itself was fixed for.
    expect(await screen.findByRole("status")).toHaveTextContent(
      /2 of the ones you picked/
    );
  });

  it("says it couldn't read the album rather than that it's empty", async () => {
    // `isLoading` is `isPending && isFetching` in TanStack v5, so a failed
    // query is "not loading" with no items — which fell through to the empty
    // state, and rendered it *beside* the error line. The empty state is a
    // claim about the server's answer; there wasn't one.
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockRejectedValue(offlineError());
    renderEventPage();

    expect(
      await screen.findByText("Couldn’t load the photos.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No photos here yet — add the first.")
    ).toBeNull();
  });

  it("keeps the partial wording when a later page is the one that failed", async () => {
    // The other half of the same rule: rows did arrive, so the album is
    // under-stated rather than unread, and neither the empty state nor the
    // "couldn't read it at all" line is true.
    api.getEvent.mockResolvedValue(makeEvent());
    api.getEventPhotos.mockResolvedValue({
      results: [makePhoto(1), makePhoto(2)],
      next: "/api/events/7/photos/?page=2",
      count: 5,
    });
    api.getPage.mockRejectedValue(offlineError());
    renderEventPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "Load more" })
    );

    expect(
      await screen.findByText("Couldn’t load all the photos.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load the photos.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "View photo 1 of 2" })
    ).toBeInTheDocument();
  });
});

describe("what an event write refreshes", () => {
  let loads;

  function CalendarSurfaces() {
    // Keyed exactly as `GroupPage` and `CalendarPage` key them, month grid
    // included: the group's calendar is a sibling of the Upcoming list delete
    // already refreshed, and it paints the same event on a grid.
    useQuery({ queryKey: ["groupCalendar", 3], queryFn: loads.groupCalendar });
    useQuery({ queryKey: ["personalCalendar"], queryFn: loads.personalCalendar });
    return null;
  }

  function loadCounts() {
    return {
      groupCalendar: loads.groupCalendar.mock.calls.length,
      personalCalendar: loads.personalCalendar.mock.calls.length,
    };
  }

  async function renderOverCalendars() {
    const utils = renderWithAuth(
      <>
        <CalendarSurfaces />
        <Routes>
          <Route path="/g/:id/events/:eid" element={<EventPage />} />
          <Route path="/g/:id" element={<div>group page</div>} />
        </Routes>
      </>,
      { route: "/g/3/events/7" }
    );
    // Their first load, so a later call is unambiguously a refetch.
    await waitFor(() =>
      expect(loadCounts()).toEqual({ groupCalendar: 1, personalCalendar: 1 })
    );
    return utils;
  }

  beforeEach(() => {
    loads = {
      groupCalendar: vi.fn(async () => []),
      personalCalendar: vi.fn(async () => []),
    };
    api.getEvent.mockResolvedValue(makeEvent({ event_date: "2026-07-19" }));
  });

  it("refreshes both calendars when you delete", async () => {
    await renderOverCalendars();
    await screen.findByText("Picnic");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    confirm.mockRestore();

    // The group's Month view is the one you land on: delete navigates back to
    // `/g/3`, where the grid painted the deleted event from a stale
    // `["groupCalendar", 3]` for the length of the refetch.
    await waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(loadCounts()).toEqual({ groupCalendar: 2, personalCalendar: 2 })
    );
    expect(await screen.findByText("group page")).toBeInTheDocument();
  });

  it("refreshes the personal calendar when you cancel", async () => {
    await renderOverCalendars();
    await screen.findByText("Picnic");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await userEvent.click(screen.getByRole("button", { name: "Cancel event" }));
    confirm.mockRestore();

    // Cancel already refreshed the group's two views; `/calendar` merges this
    // group's events in with every other group's, and was left stating an event
    // is on that the server now reports cancelled.
    await waitFor(() => expect(api.cancelEvent).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(loadCounts()).toEqual({ groupCalendar: 2, personalCalendar: 2 })
    );
  });

  it("refreshes the personal calendar when a date is finalised", async () => {
    await renderOverCalendars();
    await screen.findByText("Picnic");

    // Setting the date is what *puts* an event on the calendars — both filter
    // `event_date__isnull=False` — so it's the write that most obviously has to
    // reach them, and the one that never did.
    await userEvent.click(screen.getAllByRole("button", { name: "Pin" })[0]);

    await waitFor(() => expect(api.finaliseEvent).toHaveBeenCalled());
    await waitFor(() =>
      expect(loadCounts()).toEqual({ groupCalendar: 2, personalCalendar: 2 })
    );
  });

  it("refreshes every surface when a photo is added", async () => {
    // A photo write moves two different things: the album on this page, and the
    // preview tiles + "+N" that ride the *event* payload on every card and
    // calendar entry. Naming only `['eventPhotos']` would leave the card beside
    // it stating the old count — #279's shape, one surface further out.
    await renderOverCalendars();
    await screen.findByText("Picnic");
    const before = api.getEvent.mock.calls.length;

    await userEvent.upload(
      screen.getByLabelText("Add photos to this event"),
      new File(["x"], "beach.jpg", { type: "image/jpeg" })
    );

    await waitFor(() => expect(api.addEventPhotos).toHaveBeenCalled());
    await waitFor(() =>
      expect(loadCounts()).toEqual({ groupCalendar: 2, personalCalendar: 2 })
    );
    await waitFor(() =>
      expect(api.getEvent.mock.calls.length).toBeGreaterThan(before)
    );
  });
});
