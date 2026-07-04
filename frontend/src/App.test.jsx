import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { renderWithAuth } from "./test-utils.jsx";

// Render the whole app at a given URL as a logged-in user. The feed/profile
// pages are behind ProtectedRoute now, so these tests supply an authenticated
// auth context (see renderWithAuth). Auth gating itself is covered separately
// in auth.test.jsx.
function renderAt(path = "/") {
  return renderWithAuth(<App />, { route: path });
}

describe("Feed page", () => {
  it("renders posts in reverse-chronological order (newest first)", () => {
    renderAt("/");
    const posts = screen.getAllByRole("article");

    // The mock data's newest post is Priya's sunrise; the oldest is Tom's
    // coffee. If ranking ever crept in, this order would break.
    expect(posts[0]).toHaveTextContent("Sunrise over the harbour");
    expect(posts[posts.length - 1]).toHaveTextContent("Coffee first");

    // And the timestamps are strictly non-increasing down the list.
    const times = screen
      .getAllByRole("article")
      .map((article) => article.querySelector("time").getAttribute("datetime"))
      .map((iso) => new Date(iso).getTime());
    const sortedDesc = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sortedDesc);
  });

  it("adds a new post to the top when the compose box is submitted", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const box = screen.getByPlaceholderText("What's happening?");
    await user.type(box, "Hello from the wireframe test");
    await user.click(screen.getByRole("button", { name: "Post" }));

    const posts = screen.getAllByRole("article");
    expect(posts[0]).toHaveTextContent("Hello from the wireframe test");
  });

  it("does not post empty or whitespace-only text", async () => {
    const user = userEvent.setup();
    renderAt("/");
    const before = screen.getAllByRole("article").length;

    await user.type(screen.getByPlaceholderText("What's happening?"), "   ");
    // The Post button is disabled for empty input, so this is a no-op.
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
    expect(screen.getAllByRole("article")).toHaveLength(before);
  });
});

describe("Profile page", () => {
  it("shows only the given user's posts", () => {
    renderAt("/u/priya");

    // Priya's two posts are present...
    expect(screen.getByText(/Sunrise over the harbour/)).toBeInTheDocument();
    expect(screen.getByText(/Booked flights/)).toBeInTheDocument();
    // ...and someone else's post is not.
    expect(screen.queryByText(/Third loaf this week/)).not.toBeInTheDocument();

    const posts = screen.getAllByRole("article");
    expect(posts).toHaveLength(2);
  });

  it("handles an unknown username gracefully", () => {
    renderAt("/u/nobody");
    expect(screen.getByText("User not found")).toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });
});

describe("Admin link", () => {
  it("shows an Admin link only for staff users", () => {
    renderWithAuth(<App />, {
      route: "/",
      auth: { user: { pk: 9, email: "boss@example.com", is_staff: true } },
    });
    const adminLink = screen.getByRole("link", { name: "Admin" });
    // Points at the backend admin, opens in a new tab.
    expect(adminLink).toHaveAttribute("href", expect.stringContaining("/admin/"));
    expect(adminLink).toHaveAttribute("target", "_blank");
  });

  it("hides the Admin link for non-staff users", () => {
    renderWithAuth(<App />, {
      route: "/",
      auth: { user: { pk: 10, email: "member@example.com", is_staff: false } },
    });
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });
});

describe("Navigation", () => {
  it("navigates from the feed to a profile via a post author link", async () => {
    const user = userEvent.setup();
    renderAt("/");

    // Click the first post author's name (Priya). There are multiple "Priya
    // Patel" links; the first is the newest post's author.
    const links = screen.getAllByRole("link", { name: "Priya Patel" });
    await user.click(links[0]);

    // The profile header (bio) is now on screen.
    expect(
      screen.getByText(/Photographer\. Currently somewhere/)
    ).toBeInTheDocument();
  });
});
