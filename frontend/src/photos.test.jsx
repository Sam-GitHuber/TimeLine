import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Avatar from "./components/Avatar.jsx";
import PostCard from "./components/PostCard.jsx";
import ComposeBox from "./components/ComposeBox.jsx";
import ProfileEditPage from "./pages/ProfileEditPage.jsx";
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

describe("PostCard photo gallery", () => {
  it("renders a post's images (thumbnail shown, linking to the full image)", () => {
    const post = {
      id: 5,
      author: { id: 2, display_name: "Priya" },
      text: "Beach day",
      created_at: "2026-07-04T08:00:00Z",
      images: [
        {
          id: 1,
          image: "http://x/full1.jpg",
          thumbnail: "http://x/thumb1.jpg",
          width: 800,
          height: 600,
        },
        {
          id: 2,
          image: "http://x/full2.jpg",
          thumbnail: "http://x/thumb2.jpg",
          width: 800,
          height: 600,
        },
      ],
    };
    renderWithAuth(<PostCard post={post} />);

    const imgs = document.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toHaveAttribute("src", "http://x/thumb1.jpg");
    // The thumbnail links to the full-size original.
    const links = document.querySelectorAll('a[href="http://x/full1.jpg"]');
    expect(links).toHaveLength(1);
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
      expect(api.createPost).toHaveBeenCalledWith("", [file])
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

describe("ProfileEditPage", () => {
  const me = {
    pk: 1,
    display_name: "Old Name",
    first_name: "Old",
    last_name: "Name",
    bio: "",
    avatar_thumb: null,
  };

  it("submits name, bio and avatar, then refreshes the user", async () => {
    const user = userEvent.setup();
    const refreshUser = vi.fn().mockResolvedValue({ pk: 1 });
    renderWithAuth(<ProfileEditPage />, {
      route: "/settings",
      auth: { user: me, refreshUser },
    });

    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "New");
    await user.type(screen.getByLabelText("Bio"), "Hello there");
    await user.upload(screen.getByTestId("avatar-file-input"), pngFile());

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    const args = api.updateProfile.mock.calls[0][0];
    expect(args.first_name).toBe("New");
    expect(args.last_name).toBe("Name");
    expect(args.bio).toBe("Hello there");
    expect(args.avatar).toBeInstanceOf(File);
    expect(refreshUser).toHaveBeenCalled();
  });

  it("blocks saving with an empty name", async () => {
    const user = userEvent.setup();
    renderWithAuth(<ProfileEditPage />, {
      route: "/settings",
      auth: { user: me, refreshUser: vi.fn() },
    });

    await user.clear(screen.getByLabelText("First name"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
