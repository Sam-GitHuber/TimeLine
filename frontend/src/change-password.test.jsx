import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the API so the change-password flow runs without any network.
vi.mock("./api.js", () => ({
  api: {
    changePassword: vi.fn(),
  },
}));

import { api } from "./api.js";
import { renderWithAuth } from "./test-utils.jsx";
import ChangePasswordSection from "./components/ChangePasswordSection.jsx";

beforeEach(() => {
  vi.clearAllMocks();
});

async function openForm(user) {
  await user.click(screen.getByRole("button", { name: /change password…/i }));
}

describe("Change password", () => {
  it("sends the current + new password and confirms on success", async () => {
    const user = userEvent.setup();
    api.changePassword.mockResolvedValue(null);

    renderWithAuth(<ChangePasswordSection />);
    await openForm(user);

    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "brand-new-pw-99");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "brand-new-pw-99"
    );
    await user.click(screen.getByRole("button", { name: /change password$/i }));

    await waitFor(() =>
      expect(api.changePassword).toHaveBeenCalledWith(
        "old-pw",
        "brand-new-pw-99",
        "brand-new-pw-99"
      )
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/changed/i);
  });

  it("blocks submission and warns when the new passwords don't match", async () => {
    const user = userEvent.setup();

    renderWithAuth(<ChangePasswordSection />);
    await openForm(user);

    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "brand-new-pw-99");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "different-pw-00"
    );

    expect(screen.getByText(/don.t match/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change password$/i })
    ).toBeDisabled();
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("surfaces a backend error (e.g. wrong current password)", async () => {
    const user = userEvent.setup();
    api.changePassword.mockRejectedValue(
      new Error("Your old password was entered incorrectly.")
    );

    renderWithAuth(<ChangePasswordSection />);
    await openForm(user);

    await user.type(screen.getByLabelText("Current password"), "wrong");
    await user.type(screen.getByLabelText("New password"), "brand-new-pw-99");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "brand-new-pw-99"
    );
    await user.click(screen.getByRole("button", { name: /change password$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrectly/i);
  });
});
