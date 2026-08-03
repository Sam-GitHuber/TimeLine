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

  // Issue #254. The rejection is rendered *inside* this dialog, so every route
  // out of it has to stay shut until the request settles — otherwise the
  // component that would have shown "wrong password" is already gone, and
  // you're left not knowing whether your account still exists.
  it("can't be dismissed while the delete is in flight", async () => {
    const user = userEvent.setup();
    let reject;
    api.deleteAccount.mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      })
    );

    renderWithAuth(<DeleteAccountSection />);
    await user.click(
      screen.getByRole("button", { name: /delete my account/i })
    );
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: /delete forever/i }));
    await screen.findByRole("button", { name: /deleting/i });

    // All three ways out, while the POST is still open.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("dialog").parentElement);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // So the rejection lands somewhere a person can read it.
    reject(apiError("Password is incorrect.", 400));
    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect/i);
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

  // Issue #254, and the one that matters most: this is the safety path. A
  // report dismissed mid-request unmounts the only renderer of "that didn't
  // send", and the silence is indistinguishable from never having pressed Send.
  it("can't be dismissed while the report is in flight", async () => {
    const user = userEvent.setup();
    let reject;
    api.reportContent.mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      })
    );
    const onClose = vi.fn();

    renderWithAuth(<ReportModal postId={7} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /send report/i }));
    await screen.findByRole("button", { name: /sending/i });

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("dialog").parentElement);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).not.toHaveBeenCalled();

    reject(apiError("Couldn’t send the report.", 500));
    expect(await screen.findByRole("alert")).toHaveTextContent(/report/i);
  });

  // The other half of that gate: `submitting` is what holds the dialog shut, so
  // it has to be released once the report lands — or the "Thanks for letting us
  // know" screen would be stuck behind its Done button.
  it("is dismissable again once the report has landed", async () => {
    const user = userEvent.setup();
    // Explicit: `clearAllMocks` keeps implementations, so the pending promise
    // the test above installs would otherwise carry over.
    api.reportContent.mockResolvedValue({ id: 1 });
    const onClose = vi.fn();

    renderWithAuth(<ReportModal postId={7} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /send report/i }));
    await screen.findByText(/thanks for letting us know/i);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("names the kind of thing being reported", () => {
    // The dialog takes exactly one target id and words itself from it — before
    // Phase 9b M9b it derived "post or else comment", so a message report opened
    // a dialog headed "Report this comment".
    renderWithAuth(<ReportModal commentId={7} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Report comment" })).toBeInTheDocument();
  });
});
