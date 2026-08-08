import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import PeoplePage from "./pages/PeoplePage.jsx";
import { renderWithAuth, unauthoredError, failRefetch } from "./test-utils.jsx";
import { api } from "./api.js";

/**
 * Issue #310, on the people hub's three lists.
 *
 * All three run on `useInfiniteList`, and all three used to `return` on
 * `isError` before they looked at `items`. But `query-core`'s error action
 * writes `status`, `error` and `isInvalidated` and *never touches `data`* — so
 * the pages already loaded are still sitting in the cache when the flag goes
 * true. The everyday way in isn't exotic: scroll a long list, press "Load more",
 * have page two fail, and watch every row you were reading disappear behind one
 * line of red. Window focus refetches all loaded pages, which is the other way.
 *
 * The fix is the shape `FeedPage` and `GroupsDrawer` already use for this hook —
 * error as an extra line *under* the rows, and the empty state gated on
 * `!isError` so "you're not connected with anyone" is never said on the strength
 * of a request that failed.
 */
vi.mock("./api.js", () => ({
  api: {
    listConnections: vi.fn(),
    listDiscover: vi.fn(),
    getConnectionRequests: vi.fn(),
    getPage: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getDisconnectImpact: vi.fn(),
  },
}));

const empty = { count: 0, next: null, results: [] };

function page(results, next = null) {
  return { count: results.length, next, previous: null, results };
}

function person(id, name) {
  return { id, display_name: name, avatar_thumb: null, connection_status: "none" };
}

function renderPeopleAt(route) {
  return renderWithAuth(
    <Routes>
      <Route path="/people" element={<PeoplePage />} />
    </Routes>,
    { route }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listConnections.mockResolvedValue(empty);
  api.listDiscover.mockResolvedValue(empty);
  api.getConnectionRequests.mockResolvedValue(empty);
  api.getDisconnectImpact.mockResolvedValue({ chats: [] });
});

describe("the people hub keeps its rows when a fetch fails", () => {
  it("Connections: the rows stay, with the error under them", async () => {
    api.listConnections.mockResolvedValue(page([person(2, "Priya")]));
    const { queryClient } = renderPeopleAt("/people");
    await screen.findByText("Priya");

    api.listConnections.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["connections"]);

    expect(screen.getByText("Priya")).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't load your connections/)
    ).toBeInTheDocument();
  });

  it("Connections: doesn't claim you have none when the first load fails", async () => {
    api.listConnections.mockRejectedValue(unauthoredError(500));
    renderPeopleAt("/people");

    expect(
      await screen.findByText(/Couldn't load your connections/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/not connected with anyone yet/)).toBeNull();
  });

  it("Discover: the rows stay, and 'everyone already' isn't claimed on a failure", async () => {
    api.listDiscover.mockResolvedValue(page([person(3, "Sanjay")]));
    const { queryClient } = renderPeopleAt("/people?tab=discover");
    await screen.findByText("Sanjay");

    api.listDiscover.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["users", "discover"]);

    expect(screen.getByText("Sanjay")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load people/)).toBeInTheDocument();
    expect(
      screen.queryByText(/connected with everyone here already/)
    ).toBeNull();
  });

  it("Requests: the rows stay, so Approve and Reject are still reachable", async () => {
    api.getConnectionRequests.mockResolvedValue(
      page([{ id: 12, requester: person(4, "Ada") }])
    );
    const { queryClient } = renderPeopleAt("/people?tab=requests");
    await screen.findByText("Ada");

    api.getConnectionRequests.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["connectionRequests", "list"]);

    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load requests/)).toBeInTheDocument();
    expect(screen.queryByText("No pending requests.")).toBeNull();
  });

  /**
   * The extra thing this list used to lose. `decideError` — the message saying
   * an Approve or a Reject was refused — is rendered by the branches *below* the
   * old early return, so a list refetch failing in the same frame took the
   * write's own error off screen with it. #231's shape, by another route.
   */
  it("Requests: a refused Approve keeps saying so through a failed refetch", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    api.getConnectionRequests.mockResolvedValue(
      page([{ id: 12, requester: person(4, "Ada") }])
    );
    api.approveRequest.mockRejectedValue(unauthoredError(500));
    const { queryClient } = renderPeopleAt("/people?tab=requests");
    await screen.findByText("Ada");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(/Couldn’t approve that request/);

    api.getConnectionRequests.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["connectionRequests", "list"]);

    expect(screen.getByText(/Couldn’t approve that request/)).toBeInTheDocument();
  });
});
