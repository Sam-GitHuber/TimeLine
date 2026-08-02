import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the API so the delete/report flows are exercised without any network.
vi.mock("./api.js", () => ({
  api: {
    deleteAccount: vi.fn(),
    logout: vi.fn().mockResolvedValue({}),
    reportContent: vi.fn().mockResolvedValue({ id: 1 }),
  },
}));

import { api } from "./api.js";
import { renderWithAuth, fakeUser, apiError } from "./test-utils.jsx";
import DeleteAccountSection from "./components/DeleteAccountSection.jsx";
import { ReportModal } from "./components/ReportModal.jsx";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Delete account", () => {
  let originalLocation;
  beforeEach(() => {
    // Stub navigation — jsdom doesn't implement real page loads.
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: vi.fn() },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("confirms with a password and calls the delete endpoint", async () => {
    const user = userEvent.setup();
    api.deleteAccount.mockResolvedValue(null);

    renderWithAuth(<DeleteAccountSection />);

    await user.click(
      screen.getByRole("button", { name: /delete my account/i })
    );
    // The confirm dialog asks for the password before anything happens.
    await user.type(screen.getByLabelText("Password"), "my-password");
    await user.click(screen.getByRole("button", { name: /delete forever/i }));

    await waitFor(() =>
      expect(api.deleteAccount).toHaveBeenCalledWith("my-password")
    );
    // Session cleared + redirected to a clean logged-out boot.
    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    expect(window.location.assign).toHaveBeenCalledWith("/login");
  });

  it("shows an error and keeps the account on a wrong password", async () => {
    const user = userEvent.setup();
    api.deleteAccount.mockRejectedValue(
      apiError("Password is incorrect.", 400)
    );

    renderWithAuth(<DeleteAccountSection />);

    await user.click(
      screen.getByRole("button", { name: /delete my account/i })
    );
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: /delete forever/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect/i);
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});

describe("Report content", () => {
  it("reports a post with a reason", async () => {
    const user = userEvent.setup();

    // The dialog itself, which is what every "Report" item opens — a post's ⋯
    // menu, a comment's (#128) and a message bubble's. Who may *reach* it is the
    // menus' business and is covered where they are; this is the flow inside.
    renderWithAuth(<ReportModal postId={7} onClose={() => {}} />);

    await user.type(
      screen.getByPlaceholderText(/what.s the problem/i),
      "not theirs"
    );
    await user.click(screen.getByRole("button", { name: /send report/i }));

    await waitFor(() =>
      expect(api.reportContent).toHaveBeenCalledWith({
        postId: 7,
        commentId: undefined,
        messageId: undefined,
        reason: "not theirs",
      })
    );
    expect(await screen.findByText(/thanks for letting us know/i)).toBeInTheDocument();
  });

  it("names the kind of thing being reported", () => {
    // The dialog takes exactly one target id and words itself from it — before
    // Phase 9b M9b it derived "post or else comment", so a message report opened
    // a dialog headed "Report this comment".
    renderWithAuth(<ReportModal commentId={7} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Report comment" })).toBeInTheDocument();
  });
});
