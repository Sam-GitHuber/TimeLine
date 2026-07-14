import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Avatar from "./components/Avatar.jsx";
import PostCard from "./components/PostCard.jsx";
import ComposeBox from "./components/ComposeBox.jsx";
import ProfileEditForm from "./components/ProfileEditForm.jsx";
import { renderWithAuth } from "./test-utils.jsx";
import { api } from "./api.js";

// Phase 4: photos on posts + editable profiles (avatar/bio). The upload/
// validation/thumbnail logic lives (and is tested) on the backend; here we
// check the frontend renders images and wires the compose/profile forms to the
// API correctly.
vi.mock("./api.js", () => ({
  api: {
    createPost: vi.fn(),
    updateProfile: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
  },
}));

// The crop modal (issue #18) sits between choosing a file and setting the
// avatar. Its real behaviour (react-easy-crop + canvas export) is covered in
// avatar-crop.test.jsx; here we stub it to a "Use photo" button that hands back
// a cropped File, so these tests stay about the form's wiring.
vi.mock("./components/AvatarCropModal.jsx", () => ({
  default: ({ onCropped }) => (
    <button
      type="button"
      onClick={() => onCropped(new File(["cropped"], "avatar.jpg", { type: "image/jpeg" }))}
    >
      Use photo
    </button>
  ),
}));

function pngFile(name = "photo.png") {
  return new File(["fake-bytes"], name, { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.createPost.mockResolvedValue({});
  api.updateProfile.mockResolvedValue({ pk: 1 });
  api.getComments.mockResolvedValue([]);
});

describe("Avatar", () => {
  it("shows the uploaded photo when the user has one", () => {
    renderWithAuth(
      <Avatar
        user={{ display_name: "Priya", avatar_thumb: "http://x/a.jpg" }}
      />
    );
    const img = document.querySelector("img");
    expect(img).toHaveAttribute("src", "http://x/a.jpg");
  });

  it("falls back to the initial when there's no photo", () => {
    renderWithAuth(<Avatar user={{ display_name: "Priya" }} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("P")).toBeInTheDocument();
  });
});

function galleryPost(imageCount = 2) {
  return {
    id: 5,
    author: { id: 2, display_name: "Priya" },
    text: "Beach day",
    created_at: "2026-07-04T08:00:00Z",
    images: Array.from({ length: imageCount }, (_, i) => ({
      id: i + 1,
      image: `http://x/full${i + 1}.jpg`,
      thumbnail: `http://x/thumb${i + 1}.jpg`,
      width: 800,
      height: 600,
    })),
  };
}

describe("PostCard photo gallery", () => {
  it("renders a post's images as clickable thumbnails", () => {
    renderWithAuth(<PostCard post={galleryPost(2)} />);

    const imgs = document.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute("src", "http://x/thumb1.jpg");
    // Each thumbnail is a button that opens the viewer.
    expect(
      screen.getByRole("button", { name: "View photo 1 of 2" })
    ).toBeInTheDocument();
  });
});

describe("Lightbox", () => {
  it("opens on the clicked photo and flips through with the arrows", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={galleryPost(3)} />);

    await user.click(screen.getByRole("button", { name: "View photo 2 of 3" }));

    // Opens showing the full-size version of the clicked photo (#2).
    const dialog = screen.getByRole("dialog", { name: "Photo viewer" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByAltText("Photo 2 of 3")).toHaveAttribute(
      "src",
      "http://x/full2.jpg"
    );

    // Next → photo 3, then wraps to photo 1.
    await user.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByAltText("Photo 3 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByAltText("Photo 1 of 3")).toBeInTheDocument();

    // Previous wraps back to photo 3.
    await user.click(screen.getByRole("button", { name: "Previous photo" }));
    expect(screen.getByAltText("Photo 3 of 3")).toBeInTheDocument();
  });

  it("navigates with the arrow keys and closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={galleryPost(2)} />);

    await user.click(screen.getByRole("button", { name: "View photo 1 of 2" }));
    expect(screen.getByAltText("Photo 1 of 2")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByAltText("Photo 2 of 2")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on a click of the backdrop", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={galleryPost(2)} />);

    await user.click(screen.getByRole("button", { name: "View photo 1 of 2" }));
    const dialog = screen.getByRole("dialog", { name: "Photo viewer" });
    await user.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows no arrows for a single-photo post", async () => {
    const user = userEvent.setup();
    renderWithAuth(<PostCard post={galleryPost(1)} />);

    await user.click(screen.getByRole("button", { name: "View photo 1 of 1" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next photo" })
    ).not.toBeInTheDocument();
  });
});

describe("ComposeBox with photos", () => {
  it("lets you post photos with no text and sends the files", async () => {
    const user = userEvent.setup();
    renderWithAuth(<ComposeBox />);

    const file = pngFile();
    await user.upload(screen.getByTestId("compose-file-input"), file);

    // A local preview appears, and Post is enabled despite empty text.
    expect(
      await screen.findByAltText("Selected photo 1")
    ).toBeInTheDocument();
    const postButton = screen.getByRole("button", { name: "Post" });
    expect(postButton).toBeEnabled();

    await user.click(postButton);
    await waitFor(() =>
      expect(api.createPost).toHaveBeenCalledWith("", [file], null)
    );
  });

  it("can remove a chosen photo before posting", async () => {
    const user = userEvent.setup();
    renderWithAuth(<ComposeBox />);

    await user.upload(screen.getByTestId("compose-file-input"), pngFile());
    expect(
      await screen.findByAltText("Selected photo 1")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove photo 1" }));
    expect(screen.queryByAltText("Selected photo 1")).not.toBeInTheDocument();
    // With no text and no photos, Post is disabled again.
    expect(screen.getByRole("button", { name: "Post" })).toBeDisabled();
  });
});

// The inline profile editor lives on your own profile page now (issue #53), but
// its form wiring is the same one this suite has always covered.
describe("ProfileEditForm", () => {
  const me = {
    pk: 1,
    display_name: "Old Name",
    first_name: "Old",
    last_name: "Name",
    bio: "",
    avatar_thumb: null,
  };

  it("submits name, bio and avatar, then refreshes the user and closes", async () => {
    const user = userEvent.setup();
    const refreshUser = vi.fn().mockResolvedValue({ pk: 1 });
    const onDone = vi.fn();
    renderWithAuth(<ProfileEditForm onDone={onDone} />, {
      auth: { user: me, refreshUser },
    });

    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Bio"), "Hello there");
    // Choosing a file opens the crop modal; confirming it sets the avatar.
    await user.upload(screen.getByTestId("avatar-file-input"), pngFile());
    await user.click(screen.getByRole("button", { name: "Use photo" }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    const args = api.updateProfile.mock.calls[0][0];
    expect(args.first_name).toBe("New");
    expect(args.last_name).toBe("Name");
    expect(args.bio).toBe("Hello there");
    expect(args.avatar).toBeInstanceOf(File);
    expect(refreshUser).toHaveBeenCalled();
    // A successful save flips the profile back out of edit mode.
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("blocks saving with an empty name", async () => {
    const user = userEvent.setup();
    renderWithAuth(<ProfileEditForm onDone={vi.fn()} />, {
      auth: { user: me, refreshUser: vi.fn() },
    });

    await user.clear(screen.getByLabelText("First name"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("closes without saving when you cancel", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderWithAuth(<ProfileEditForm onDone={onDone} />, {
      auth: { user: me, refreshUser: vi.fn() },
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });
});
