import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "./App.jsx";

// Render the whole app at a given URL. App relies on a router being present
// (main.jsx uses BrowserRouter in the real app); MemoryRouter is the in-memory
// equivalent used for tests.
function renderAt(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
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
