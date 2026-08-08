import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import ActivityCenter from "./components/ActivityCenter.jsx";
import NotificationPreferencesSection from "./components/NotificationPreferencesSection.jsx";
import {
  renderWithAuth,
  failRefetch,
  unauthoredError,
} from "./test-utils.jsx";
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

  // #314. The panel had no error branch at all: a failed fetch left `data`
  // undefined, `items` fell back to `[]`, and "You're all caught up" — a flat
  // statement of fact — rendered on the strength of a request that never
  // arrived. It could contradict itself out loud, too, since the badge is a
  // separate query that may well have succeeded.
  it("says the load failed instead of claiming you're all caught up", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 5 });
    api.getNotifications.mockRejectedValue(unauthoredError(500));
    renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));

    expect(
      await screen.findByText("Couldn’t load your activity.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).toBeNull();
    // The bell still says 5 unread — which is exactly the contradiction the
    // old empty state produced, and why the panel must not claim otherwise.
    expect(
      screen.getByRole("button", { name: /Activity, 5 unread/ })
    ).toBeInTheDocument();
  });

  // The paused state, and the worst instance of it: offline the list request is
  // never sent, so `isLoading` is false with no data — and "You're all caught
  // up" rendered under a bell that may well still read "5 unread" from a count
  // fetched before the signal went (#306's trap).
  it("says it's waiting rather than that you're all caught up", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 5 });
    api.getNotifications.mockResolvedValue(page([]));
    renderWithAuth(<ActivityCenter />);
    const bell = await screen.findByRole("button", { name: /Activity, 5 unread/ });

    onlineManager.setOnline(false);
    try {
      await user.click(bell);
      expect(
        await screen.findByText("Waiting for a connection…")
      ).toBeInTheDocument();
      expect(screen.queryByText(/all caught up/i)).toBeNull();
      // And nothing was marked seen, so the badge that brings you back survives.
      expect(api.markNotificationsSeen).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // The write half, and the more serious one. Marking seen used to fire on the
  // *open transition*, so a failed open both said "all caught up" and cleared
  // every unread server-side — the badge that would have brought you back was
  // gone, and the screen had just told you there was nothing to come back for.
  // Same rule as #307/#308, and the same turn the app took in #312.
  it("doesn't mark everything seen when the list never arrived", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 5 });
    api.getNotifications.mockRejectedValue(unauthoredError(500));
    renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    await screen.findByText("Couldn’t load your activity.");

    expect(api.markNotificationsSeen).not.toHaveBeenCalled();
  });

  // …and it must still fire once the list does land, including on a retry.
  it("marks everything seen once the list arrives on a retry", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 1 });
    api.getNotifications.mockRejectedValue(unauthoredError(500));
    renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    await screen.findByText("Couldn’t load your activity.");

    api.getNotifications.mockResolvedValue(page([note()]));
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText("Priya replied to your post")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(api.markNotificationsSeen).toHaveBeenCalledTimes(1)
    );
  });

  // A failed *refresh* keeps the rows already up — and, since those rows are
  // still being read, the seen-write is still right to have fired.
  it("keeps the rows it has when a refetch fails", async () => {
    const user = userEvent.setup();
    api.getUnreadNotificationCount.mockResolvedValue({ count: 1 });
    api.getNotifications.mockResolvedValue(page([note()]));
    const { queryClient } = renderWithAuth(<ActivityCenter />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    await screen.findByText("Priya replied to your post");

    api.getNotifications.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["notifications"]);

    expect(
      screen.getByText("Priya replied to your post")
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn’t load your activity.")).toBeNull();
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

  // #314. Only `mutation.isError` was ever rendered, so a failed *load* left
  // the "Notifications" heading and its blurb standing over zero toggles —
  // "there are no settings", not "we couldn't load them" — with no retry.
  it("says the settings failed instead of showing an empty section", async () => {
    api.getNotificationPreferences.mockRejectedValue(unauthoredError(500));
    renderWithAuth(<NotificationPreferencesSection />);

    expect(
      await screen.findByText("Couldn’t load your notification settings.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the toggles it has when a refetch fails", async () => {
    const { queryClient } = renderWithAuth(<NotificationPreferencesSection />);
    await screen.findByLabelText("Replies to your posts");

    api.getNotificationPreferences.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["notificationPreferences"]);

    expect(screen.getByLabelText("Replies to your posts")).toBeChecked();
    expect(
      screen.queryByText("Couldn’t load your notification settings.")
    ).toBeNull();
  });
});
