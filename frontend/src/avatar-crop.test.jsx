import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AvatarCropModal from "./components/AvatarCropModal.jsx";
import { getCroppedImg } from "./cropImage.js";

// Issue #18: the avatar crop modal. react-easy-crop (drag/zoom/pinch) and the
// canvas export both need a real browser, so we stub them and test *our* logic:
// the reframe stage reports a crop rectangle, and confirming turns it into an
// uploaded File via getCroppedImg. The export util's own canvas maths isn't
// exercised in jsdom (no real canvas) — it's mocked here.
vi.mock("react-easy-crop", () => ({
  // A stub standing in for the cropper: a button that reports a fixed crop
  // rectangle, the way react-easy-crop's onCropComplete would after a drag/zoom.
  default: ({ onCropComplete }) => (
    <button
      type="button"
      data-testid="fire-crop"
      onClick={() =>
        onCropComplete({}, { x: 10, y: 20, width: 200, height: 200 })
      }
    >
      cropper
    </button>
  ),
}));

vi.mock("./cropImage.js", () => ({ getCroppedImg: vi.fn() }));

function chosenFile() {
  return new File(["bytes"], "chosen.png", { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCroppedImg.mockResolvedValue(
    new File(["cropped"], "avatar.jpg", { type: "image/jpeg" })
  );
});

describe("AvatarCropModal", () => {
  it("exports the chosen crop as a File and hands it back", async () => {
    const user = userEvent.setup();
    const onCropped = vi.fn();
    render(
      <AvatarCropModal file={chosenFile()} onCropped={onCropped} onCancel={vi.fn()} />
    );

    // Until the cropper reports a rectangle, there's nothing to export.
    expect(screen.getByRole("button", { name: "Use photo" })).toBeDisabled();

    await user.click(screen.getByTestId("fire-crop"));
    await user.click(screen.getByRole("button", { name: "Use photo" }));

    expect(getCroppedImg).toHaveBeenCalledWith(expect.stringMatching(/^blob:/), {
      x: 10,
      y: 20,
      width: 200,
      height: 200,
    });
    expect(onCropped).toHaveBeenCalledTimes(1);
    expect(onCropped.mock.calls[0][0]).toBeInstanceOf(File);
  });

  it("cancels via the Cancel button and via Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AvatarCropModal file={chosenFile()} onCropped={vi.fn()} onCancel={onCancel} />
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
