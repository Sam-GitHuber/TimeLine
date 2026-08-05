import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { Routes, Route } from "react-router-dom";
import BlockButton from "./components/BlockButton.jsx";
import ConnectButton from "./components/ConnectButton.jsx";
import PendingChatPanel from "./components/PendingChatPanel.jsx";
import PeoplePage from "./pages/PeoplePage.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// What each write to a **connection** *refreshes*, not just what it calls
// (issue #288 — the web half of #278 / #285).
//
// `connected_user_ids` is the one set the feed, profiles, group timelines,
// comment trees, the personal calendar and both event lists gate on
// (`connectionCache.js`), so a write that adds or removes an accepted connection
// changes what all of them may show. Before this, each of the four sites held a
// list written from the point of view of the screen it sits on: four sites, four
// different sets, and not one of them naming a calendar or event key.
//
// The gated surfaces are **mounted alongside** the component doing the write
// rather than seeded into the cache, because a seeded but unobserved entry
// refetches on its next mount whatever we do, and would pass against the broken
// build. They sit outside the `<Routes>` so navigating away doesn't take the
// thing under test with it. Same reasoning as `group-membership-cache.test.jsx`.

vi.mock("./messaging.jsx", () => ({
  useMessaging: vi.fn(() => ({ openList: vi.fn(), openThread: vi.fn() })),
}));

vi.mock("./api.js", () => ({
  api: {
    getPage: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getDisconnectImpact: vi.fn(),
    listUsers: vi.fn(),
    listConnections: vi.fn(),
    getConnectionRequests: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
  },
}));

const emptyPage = { results: [], next: null };

/** Ada — the other party in every case here. */
const ADA = 42;

let loads;

// One query per surface `connected_user_ids` gates, keyed exactly as the real
// page keys it. Two of them carry a suffix on purpose: the helper invalidates
// bare first segments, so `["feed", { includeGroups: true }]` and
// `["userPosts", 42]` only refetch if invalidation is prefix-matching the way
// the file claims. A fix that named exact keys wouldn't pass here.
function GatedSurfaces() {
  useQuery({ queryKey: ["feed", { includeGroups: true }], queryFn: loads.feed });
  useQuery({ queryKey: ["userPosts", ADA], queryFn: loads.theirPosts });
  useQuery({ queryKey: ["personalCalendar"], queryFn: loads.calendar });
  useQuery({ queryKey: ["groupCalendar", 3], queryFn: loads.groupCalendar });
  useQuery({ queryKey: ["groupEvents", 3, "upcoming"], queryFn: loads.groupEvents });
  // One event and its album. Both prune on the connection boundary: the album
  // filters uploaders to `visible_reactor_ids`, and the event payload carries
  // that album's preview tiles and `photo_count`, so a connection change moves
  // what the page *and* every card of it may show.
  useQuery({ queryKey: ["event", 7], queryFn: loads.event });
  useQuery({ queryKey: ["eventPhotos", 7], queryFn: loads.eventPhotos });
  useQuery({ queryKey: ["connections"], queryFn: loads.connections });
  useQuery({ queryKey: ["conversations"], queryFn: loads.conversations });
  return null;
}

/** How many times each surface has loaded, keyed by name for a readable diff. */
function loadCounts() {
  return Object.fromEntries(
    Object.entries(loads).map(([name, fn]) => [name, fn.mock.calls.length])
  );
}

/** Every surface at `n` — the shape both the before and after assertions take. */
function allAt(n) {
  return Object.fromEntries(Object.keys(loads).map((name) => [name, n]));
}

async function renderOverGatedSurfaces(ui, route = "/") {
  const utils = renderWithAuth(
    <>
      <GatedSurfaces />
      {ui}
    </>,
    { route }
  );
  // Their first load, so a later call is unambiguously a refetch.
  await waitFor(() => expect(loadCounts()).toEqual(allAt(1)));
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  loads = {
    feed: vi.fn(async () => emptyPage),
    theirPosts: vi.fn(async () => emptyPage),
    calendar: vi.fn(async () => []),
    groupCalendar: vi.fn(async () => []),
    groupEvents: vi.fn(async () => []),
    event: vi.fn(async () => ({ id: 7, photos: [], photo_count: 0 })),
    eventPhotos: vi.fn(async () => emptyPage),
    connections: vi.fn(async () => emptyPage),
    conversations: vi.fn(async () => emptyPage),
  };
  api.connect.mockResolvedValue({});
  api.disconnect.mockResolvedValue({});
  api.blockUser.mockResolvedValue({});
  api.unblockUser.mockResolvedValue({});
  api.getDisconnectImpact.mockResolvedValue({ chats: [] });
  api.approveRequest.mockResolvedValue({});
  api.rejectRequest.mockResolvedValue({});
  api.listUsers.mockResolvedValue(emptyPage);
  api.listConnections.mockResolvedValue(emptyPage);
  api.getConnectionRequests.mockResolvedValue({
    results: [
      {
        id: 12,
        requester: { id: ADA, display_name: "Ada", avatar_thumb: null },
      },
    ],
    next: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Connect button", () => {
  it("refreshes everything the connection gates when you approve", async () => {
    await renderOverGatedSurfaces(
      <ConnectButton userId={ADA} displayName="Ada" connectionStatus="incoming" />
    );

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(ADA));
    // `["userPosts", 42]` is the one that made this a bug rather than a flash:
    // on a profile it's mounted directly beneath this button, so the old list
    // flipped the label to "Connected" over a timeline that stayed empty until
    // you reloaded the page.
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });

  it("refreshes everything the connection gates when you disconnect", async () => {
    await renderOverGatedSurfaces(
      <ConnectButton
        userId={ADA}
        displayName="Ada"
        connectionStatus="connected"
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Connected" }));
    // Disconnecting confirms first, and the dialog holds the write open.
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith(ADA));
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });

  it("refreshes nothing when the server refuses the write", async () => {
    api.connect.mockRejectedValue(
      Object.assign(new Error("You can’t connect with this person."), {
        name: "ApiError",
        status: 400,
        fromServer: true,
      })
    );
    await renderOverGatedSurfaces(
      <ConnectButton userId={ADA} displayName="Ada" connectionStatus="none" />
    );

    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    // The message settling is the tell that the failure path has finished, so
    // the counts are read after the mutation rather than before it started.
    expect(
      await screen.findByText("You can’t connect with this person.")
    ).toBeInTheDocument();
    expect(loadCounts()).toEqual(allAt(1));
  });
});

describe("the Block button", () => {
  it("refreshes everything the connection gates when you block", async () => {
    await renderOverGatedSurfaces(
      <BlockButton userId={ADA} displayName="Ada" isBlocked={false} />
    );

    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    // A block deletes the `Connection` row outright, so it moves the same
    // boundary a disconnect does — including `["connections"]`, which this
    // button never named, and the calendars, which none of the four did.
    await waitFor(() => expect(api.blockUser).toHaveBeenCalledWith(ADA));
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });

  it("refreshes everything the connection gates when you unblock", async () => {
    await renderOverGatedSurfaces(
      <BlockButton userId={ADA} displayName="Ada" isBlocked />
    );

    // Unblocking undoes none of the block's damage, so it needs no warning.
    await userEvent.click(screen.getByRole("button", { name: "Unblock" }));

    // Pinned in both directions on purpose. Unblocking restores no connection,
    // so the content keys are a wasted refetch rather than a wrong one — but
    // it does move `is_blocked` on the profile and the people lists, and it
    // brings the direct thread back (`_conversation_visible`). The reasoning for
    // not splitting the two directions is on the mutation in `BlockButton.jsx`.
    await waitFor(() => expect(api.unblockUser).toHaveBeenCalledWith(ADA));
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });

  it("refreshes nothing when the server refuses the block", async () => {
    api.blockUser.mockRejectedValue(
      Object.assign(new Error("Server error"), { name: "ApiError", status: 500 })
    );
    await renderOverGatedSurfaces(
      <BlockButton userId={ADA} displayName="Ada" isBlocked={false} />
    );

    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByText(/Couldn’t block Ada — they’re not blocked/)
    ).toBeInTheDocument();
    expect(loadCounts()).toEqual(allAt(1));
  });
});

describe("the locked pending-chat panel", () => {
  it("refreshes everything the connection gates when you connect from it", async () => {
    await renderOverGatedSurfaces(
      <PendingChatPanel
        conversationId={11}
        mustConnectWith={[{ id: ADA, display_name: "Ada", avatar_thumb: null }]}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    // This panel already refreshed the thread and the list — it's the screen
    // waiting to unlock. What it didn't know is that connecting from here widens
    // the feed, the calendars and the group timelines exactly as connecting from
    // a profile does.
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(ADA));
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });
});

describe("the connection-requests inbox", () => {
  const requestsRoute = <Route path="/people" element={<PeoplePage />} />;

  async function renderInbox() {
    const utils = await renderOverGatedSurfaces(
      <Routes>{requestsRoute}</Routes>,
      "/people?tab=requests"
    );
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    return utils;
  }

  it("refreshes everything the connection gates when you approve", async () => {
    await renderInbox();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    // Approving is the moment the connection becomes real, so it's the same set
    // as every other connection write — the inbox is just where it was pressed.
    await waitFor(() => expect(api.approveRequest).toHaveBeenCalledWith(12));
    await waitFor(() => expect(loadCounts()).toEqual(allAt(2)));
  });

  it("keeps the narrow set when you reject", async () => {
    await renderInbox();
    // A baseline rather than a literal: the page holds two queries under this
    // key — the list and the segment's own count — and both fetch through here.
    const inboxLoads = api.getConnectionRequests.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    // Rejecting deletes a still-pending row and connects nobody, so the gated
    // surfaces are correct as they stand. Safe to assume only because the
    // *server* guarantees it: `ConnectionRequestActionView` 404s unless the row
    // is still pending. The inbox refetching is the signal that the success
    // handler has run — every invalidation in it happens in that same tick, so
    // if the feed were in the set it would have refetched by now too.
    await waitFor(() => expect(api.rejectRequest).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(api.getConnectionRequests.mock.calls.length).toBeGreaterThan(
        inboxLoads
      )
    );
    expect(loadCounts()).toEqual(allAt(1));
  });
});
