import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import SettingsPage from "./pages/SettingsPage.jsx";
import { renderWithAuth } from "./test-utils.jsx";
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
