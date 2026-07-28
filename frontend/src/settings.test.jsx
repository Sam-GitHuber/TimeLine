import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./pages/SettingsPage.jsx";
import { fakeUser, renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// Issue #53: /settings is trimmed to account & security controls only — profile
// editing (name / bio / avatar) moved in place onto your own profile page. Here
// we check the page holds the account sections and none of the profile fields.
vi.mock("./api.js", () => ({
  api: {
    // NotificationPreferencesSection fetches these on mount.
    getNotificationPreferences: vi.fn().mockResolvedValue({}),
    updateNotificationPreferences: vi.fn(),
    changePassword: vi.fn(),
    deleteAccount: vi.fn(),
    setReadReceipts: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getNotificationPreferences.mockResolvedValue({});
});

describe("Settings page", () => {
  it("holds the account/security controls", () => {
    renderWithAuth(<SettingsPage />, { route: "/settings" });

    expect(
      screen.getByRole("heading", { name: "Settings" })
    ).toBeInTheDocument();
    // Change-password and delete-account both live here.
    expect(
      screen.getByRole("button", { name: /change password…/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete my account…/i })
    ).toBeInTheDocument();
  });

  it("no longer edits your profile — name / bio / avatar are gone", () => {
    renderWithAuth(<SettingsPage />, { route: "/settings" });

    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Last name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Bio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("avatar-file-input")).not.toBeInTheDocument();
  });
});

// Phase 9b M4. The web doesn't draw ticks until M9, but the *setting* belongs
// here now: the disclosure happens whether or not this browser renders it, so a
// web-only member has to be able to opt out of it.
describe("Read receipts setting", () => {
  it("reflects the current value from the logged-in user", () => {
    renderWithAuth(<SettingsPage />, {
      route: "/settings",
      auth: { user: { ...fakeUser, send_read_receipts: false } },
    });

    expect(screen.getByLabelText("Send read receipts")).not.toBeChecked();
  });

  it("PATCHes the flipped value and re-reads the user", async () => {
    api.setReadReceipts.mockResolvedValue({ send_read_receipts: false });
    const refreshUser = vi.fn().mockResolvedValue(fakeUser);
    renderWithAuth(<SettingsPage />, { route: "/settings", auth: { refreshUser } });

    await userEvent.click(screen.getByLabelText("Send read receipts"));

    await waitFor(() => expect(api.setReadReceipts).toHaveBeenCalledWith(false));
    // The auth user is the source of truth for the switch, so it's re-read
    // rather than assumed.
    expect(refreshUser).toHaveBeenCalled();
  });

  it("says so when the save fails, without flipping the switch", async () => {
    api.setReadReceipts.mockRejectedValue(new Error("nope"));
    renderWithAuth(<SettingsPage />, { route: "/settings" });

    await userEvent.click(screen.getByLabelText("Send read receipts"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn’t save that/i
    );
    // Not optimistic, deliberately: this decides what the server discloses about
    // you, so showing it off while it's still on is the wrong way round to be
    // wrong.
    expect(screen.getByLabelText("Send read receipts")).toBeChecked();
  });
});
