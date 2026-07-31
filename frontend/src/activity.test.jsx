import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import ActivityCenter from "./components/ActivityCenter.jsx";
import NotificationPreferencesSection from "./components/NotificationPreferencesSection.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// The activity centre (Phase 8): a nav bell + dropdown, three read-states, and
// deep-linking. We mock the api and assert the badge, the seen-on-open
// behaviour, and click-through addressing + navigation.
vi.mock("./api.js", () => ({
  api: {
    getUnreadNotificationCount: vi.fn(),
    getNotifications: vi.fn(),
    // Following a paginator's `next` goes through getPage, like every other
    // list on the site (#134).
    getPage: vi.fn(),
    markNotificationsSeen: vi.fn(),
    markNotificationAddressed: vi.fn(),
    getNotificationPreferences: vi.fn(),
    updateNotificationPreferences: vi.fn(),
  },
  NOTIFICATIONS_POLL_MS: 1_000_000, // effectively off in tests
}));

function page(results, next = null) {
  return { count: results.length, next, previous: null, results };
}

function note(overrides = {}) {
  return {
    id: 1,
    kind: "post_reply",
    actor: { id: 2, display_name: "Priya", avatar_thumb: null },
    text: "Priya replied to your post",
    target: { type: "post", id: 5 },
    url: "/p/5",
    created_at: "2026-07-13T08:00:00Z",
    seen: false,
    addressed: false,
    ...overrides,
  };
}

// A tiny probe so we can assert where a click deep-links to.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="path">{location.pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getUnreadNotificationCount.mockResolvedValue({ count: 0 });
  api.getNotifications.mockResolvedValue(page([]));
  api.markNotificationsSeen.mockResolvedValue({ updated: 0 });
  api.markNotificationAddressed.mockResolvedValue({ detail: "Addressed." });
});

describe("ActivityCenter", () => {
  it("shows an unread badge from the count endpoint", async () => {
    api.getUnreadNotificationCount.mockResolvedValue({ count: 3 });
    renderWithAuth(<ActivityCenter />);
    // The count is exposed to assistive tech via the button's label, and shown
    // as a pill.
    expect(
      await screen.findByRole("button", { name: /Activity, 3 unread/ })
    ).toBeInTheDocument();
  });

  it("marks everything seen when the panel opens, and lists notifications", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 1 });
    api.getNotifications.mockResolvedValue(page([note()]));
    renderWithAuth(<ActivityCenter />);

    await user.click(
      await screen.findByRole("button", { name: /Activity/ })
    );
    // Opening the centre clears the badge (marks unread → seen) but keeps items.
    await waitFor(() =>
      expect(api.markNotificationsSeen).toHaveBeenCalled()
    );
    expect(
      await screen.findByText("Priya replied to your post")
    ).toBeInTheDocument();
  });

  it("shows the caught-up empty state when there are none", async () => {
    const user = userEvent.setup();
    api.getNotifications.mockResolvedValue(page([]));
    renderWithAuth(<ActivityCenter />);
    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it("loads older notifications behind the paginator's next (#134)", async () => {
    // The defect: the dropdown rendered `results` and stopped, so everything
    // past page one was unreachable.
    const user = userEvent.setup();
    api.getNotifications.mockResolvedValue(
      page([note({ id: 1, text: "Newest" })], "/api/notifications/?page=2")
    );
    api.getPage.mockResolvedValue(page([note({ id: 2, text: "Oldest" })]));
    renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    expect(await screen.findByText("Newest")).toBeInTheDocument();
    // Page one only, until asked for more.
    expect(screen.queryByText("Oldest")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Load more/ }));

    expect(await screen.findByText("Oldest")).toBeInTheDocument();
    expect(api.getPage).toHaveBeenCalledWith("/api/notifications/?page=2");
    // Nothing more to follow — the control goes away rather than lying.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Load more/ })
      ).not.toBeInTheDocument()
    );
  });

  it("renders a row once when paging re-sends it", async () => {
    // Page two can re-send a row page one already showed — two list items with
    // one React key.
    const user = userEvent.setup();
    api.getNotifications.mockResolvedValue(
      page(
        [note({ id: 1, text: "Newest" }), note({ id: 2, text: "Middle" })],
        "/api/notifications/?page=2"
      )
    );
    api.getPage.mockResolvedValue(
      page([note({ id: 2, text: "Middle" }), note({ id: 3, text: "Oldest" })])
    );
    renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    await user.click(await screen.findByRole("button", { name: /Load more/ }));

    expect(await screen.findByText("Oldest")).toBeInTheDocument();
    expect(screen.getAllByText("Middle")).toHaveLength(1);
  });

  it("drops back to one page when the dropdown closes", async () => {
    // Reopening otherwise refetches every page loaded last time, one after
    // another, for rows nobody is looking at — only the first page can hold
    // anything new.
    const user = userEvent.setup();
    api.getNotifications.mockResolvedValue(
      page([note({ id: 1, text: "Newest" })], "/api/notifications/?page=2")
    );
    api.getPage.mockResolvedValue(page([note({ id: 2, text: "Oldest" })]));
    renderWithAuth(<ActivityCenter />);

    const bell = await screen.findByRole("button", { name: /Activity/ });
    await user.click(bell);
    await user.click(await screen.findByRole("button", { name: /Load more/ }));
    await screen.findByText("Oldest");

    await user.click(bell); // close
    api.getPage.mockClear();
    await user.click(bell); // reopen

    expect(await screen.findByText("Newest")).toBeInTheDocument();
    // Back at page one: the second page isn't re-fetched, and isn't on screen.
    expect(screen.queryByText("Oldest")).not.toBeInTheDocument();
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it("still drops to one page when a load lands after the close", async () => {
    // The race the trim has to survive: a "Load more" in flight is merged
    // against the pages it saw when it started, so a page that arrives after
    // the panel closed would otherwise put itself straight back.
    const user = userEvent.setup();
    api.getNotifications.mockResolvedValue(
      page([note({ id: 1, text: "Newest" })], "/api/notifications/?page=2")
    );
    let releasePage2;
    api.getPage.mockReturnValue(
      new Promise((resolve) => {
        releasePage2 = () => resolve(page([note({ id: 2, text: "Oldest" })]));
      })
    );
    renderWithAuth(<ActivityCenter />);

    const bell = await screen.findByRole("button", { name: /Activity/ });
    await user.click(bell);
    await user.click(await screen.findByRole("button", { name: /Load more/ }));
    await user.click(bell); // close, page two still in flight
    releasePage2();

    await user.click(bell); // reopen
    expect(await screen.findByText("Newest")).toBeInTheDocument();
    expect(screen.queryByText("Oldest")).not.toBeInTheDocument();
  });

  it("addresses a notification and deep-links to its target on click", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 1 });
    api.getNotifications.mockResolvedValue(page([note({ id: 9 })]));
    renderWithAuth(
      <>
        <ActivityCenter />
        <LocationProbe />
      </>
    );

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    await user.click(
      await screen.findByText("Priya replied to your post")
    );

    expect(api.markNotificationAddressed).toHaveBeenCalledWith(9);
    // Deep-linked to the post permalink.
    await waitFor(() =>
      expect(screen.getByTestId("path")).toHaveTextContent("/p/5")
    );
  });
});

describe("NotificationPreferencesSection", () => {
  beforeEach(() => {
    api.getNotificationPreferences.mockResolvedValue({
      post_reply: true,
      comment_reply: true,
      reaction: true,
    });
    api.updateNotificationPreferences.mockResolvedValue({
      post_reply: true,
      comment_reply: true,
      reaction: false,
    });
  });

  it("renders a toggle per mutable kind, all on by default", async () => {
    renderWithAuth(<NotificationPreferencesSection />);
    const toggle = await screen.findByLabelText(
      "Reactions to your posts and comments"
    );
    expect(toggle).toBeChecked();
    expect(
      screen.getByLabelText("Replies to your posts")
    ).toBeChecked();
  });

  it("saves a mute when a toggle is switched off", async () => {
    const user = userEvent.setup();
    renderWithAuth(<NotificationPreferencesSection />);
    const toggle = await screen.findByLabelText(
      "Reactions to your posts and comments"
    );
    await user.click(toggle);
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({
      reaction: false,
    });
  });
});
