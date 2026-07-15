import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the API so the reset flow runs without any network.
vi.mock("./api.js", () => ({
  api: {
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
  },
}));

import { api } from "./api.js";
import { renderWithAuth } from "./test-utils.jsx";
import ResetPasswordPage from "./pages/ResetPasswordPage.jsx";

beforeEach(() => {
  vi.clearAllMocks();
});

async function requestCode(user, email = "forgot@example.com") {
  await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("button", { name: /send reset code/i }));
}

describe("Reset password", () => {
  it("walks request → confirm and resets the password", async () => {
    const user = userEvent.setup();
    api.requestPasswordReset.mockResolvedValue({ detail: "sent" });
    api.confirmPasswordReset.mockResolvedValue({ detail: "done" });

    renderWithAuth(<ResetPasswordPage />);
    await requestCode(user);

    await waitFor(() =>
      expect(api.requestPasswordReset).toHaveBeenCalledWith("forgot@example.com")
    );

    // Now on the confirm step: code + new password.
    await user.type(screen.getByLabelText("Reset code"), "048213");
    await user.type(screen.getByLabelText("New password"), "fresh-horse-99-staple");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "fresh-horse-99-staple"
    );
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() =>
      expect(api.confirmPasswordReset).toHaveBeenCalledWith(
        "forgot@example.com",
        "048213",
        "fresh-horse-99-staple",
        "fresh-horse-99-staple"
      )
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/has been reset/i);
  });

  it("advances to the code step even for an unknown email (no enumeration)", async () => {
    const user = userEvent.setup();
    // The backend always resolves the request identically; the UI must too.
    api.requestPasswordReset.mockResolvedValue({ detail: "sent" });

    renderWithAuth(<ResetPasswordPage />);
    await requestCode(user, "ghost@example.com");

    expect(await screen.findByLabelText("Reset code")).toBeInTheDocument();
  });

  it("blocks the reset while the two passwords differ", async () => {
    const user = userEvent.setup();
    api.requestPasswordReset.mockResolvedValue({ detail: "sent" });

    renderWithAuth(<ResetPasswordPage />);
    await requestCode(user);
    await screen.findByLabelText("Reset code");

    await user.type(screen.getByLabelText("Reset code"), "048213");
    await user.type(screen.getByLabelText("New password"), "fresh-horse-99-staple");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "different-00-staple"
    );

    expect(screen.getByText(/don.t match/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reset password/i })
    ).toBeDisabled();
    expect(api.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces a backend error on confirm (e.g. wrong/expired code)", async () => {
    const user = userEvent.setup();
    api.requestPasswordReset.mockResolvedValue({ detail: "sent" });
    api.confirmPasswordReset.mockRejectedValue(
      new Error("That code is invalid or has expired.")
    );

    renderWithAuth(<ResetPasswordPage />);
    await requestCode(user);
    await screen.findByLabelText("Reset code");

    await user.type(screen.getByLabelText("Reset code"), "000000");
    await user.type(screen.getByLabelText("New password"), "fresh-horse-99-staple");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "fresh-horse-99-staple"
    );
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or has expired/i);
  });

  it("prefills the email passed from the login page", async () => {
    renderWithAuth(<ResetPasswordPage />, {
      route: "/reset-password",
    });
    // Cold load has no state; the field is empty and focusable.
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });
});
