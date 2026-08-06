import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import ChangePasswordSection from "./components/ChangePasswordSection.jsx";
import CommentThread from "./components/CommentThread.jsx";
import GroupFormPage from "./pages/GroupFormPage.jsx";
import GroupInvitePicker from "./components/GroupInvitePicker.jsx";
import PlanEventForm from "./components/events/PlanEventForm.jsx";
import PostCard from "./components/PostCard.jsx";
import ProfileEditForm from "./components/ProfileEditForm.jsx";
import { renderWithAuth, fakeUser, apiError, offlineError } from "./test-utils.jsx";
import { api } from "./api.js";

/**
 * Issue #259 — **an inline form may not be dismissed while its write is out.**
 *
 * The same defect #254/#255 fixed for four dialogs, one component-shape over.
 * These forms expand in place rather than opening over a backdrop, so they read
 * as a different kind of thing — but their Cancel unmounts them exactly the way
 * a backdrop click unmounts a modal, and each is the only renderer of its own
 * rejection. The tell was an asymmetry visible in every one of them: **Save
 * disabled while the request was in flight, and Cancel right beside it wasn't.**
 *
 * What each test pins is one sequence, because it's the sequence people
 * actually perform: press Save, consider yourself finished, press Cancel — and
 * *then* the server refuses. Before this fix that ended with the form gone and
 * nothing said, so you'd walk away believing you had renamed yourself, invited
 * three people, or planned an event. Asserting only "the button is disabled"
 * would pass against a Cancel that was disabled for some unrelated reason, so
 * each test also drives the rejection home and insists the message is on screen.
 *
 * The house rule these all serve is written up in
 * `docs/reference/connections.md#reporting-a-refused-write`.
 */
vi.mock("./api.js", () => ({
  api: {
    updateProfile: vi.fn(),
    getComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    updatePost: vi.fn(),
    deletePost: vi.fn(),
    listUsers: vi.fn(),
    inviteToGroup: vi.fn(),
    createEvent: vi.fn(),
    changePassword: vi.fn(),
    createGroup: vi.fn(),
    getGroup: vi.fn(),
    reportContent: vi.fn(),
    toggleReaction: vi.fn(),
    getReactors: vi.fn(),
  },
}));

/**
 * A request that hangs until the test says otherwise — the in-flight window
 * these forms get wrong. `settle` is wrapped in `act` so the rejection and the
 * re-render it causes are flushed before the assertion that follows.
 */
function hanging() {
  let settle;
  const promise = new Promise((_resolve, reject) => {
    settle = (error) => reject(error);
  });
  // Nobody awaits the rejection but React Query, and an unhandled rejection
  // warning here would be noise about a promise that is being handled.
  promise.catch(() => {});
  return {
    promise,
    reject: async (error) => {
      settle(error);
      // Real macrotasks, not just a microtask flush: React Query walks a
      // rejection through its own retry/settle machinery before the observer
      // repaints, and a single `Promise.resolve()` lands mid-way — which reads
      // in a test as "the gate never let go".
      await act(async () => {
        for (let i = 0; i < 3; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
    },
  };
}

const cancelButton = () => screen.getByRole("button", { name: "Cancel" });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Profile edit", () => {
  it("holds Cancel while the save is out, then says the save was refused", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.updateProfile.mockReturnValue(save.promise);

    renderWithAuth(<ProfileEditForm onDone={vi.fn()} />);

    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());

    await save.reject(apiError("That name isn’t allowed.", 400));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That name isn’t allowed."
    );
  });

  it("lets Cancel go when the PATCH lands, not when the follow-up does", async () => {
    const user = userEvent.setup();
    api.updateProfile.mockResolvedValue({});
    // `onSuccess` awaits `refreshUser()` — a second request — and React Query
    // keeps `isPending` true for the whole of `onSuccess`. A gate left on that
    // alone stays shut across a round trip that has nothing left to report,
    // which is the trap #255 named on the delete-account dialog.
    let finishRefresh;
    const refreshUser = vi.fn(
      () => new Promise((resolve) => { finishRefresh = resolve; })
    );

    renderWithAuth(<ProfileEditForm onDone={vi.fn()} />, {
      auth: { refreshUser },
    });

    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
    expect(cancelButton()).toBeEnabled();

    await act(async () => {
      finishRefresh(fakeUser);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("lets Cancel go the moment the answer lands", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.updateProfile.mockReturnValue(save.promise);
    const onDone = vi.fn();

    renderWithAuth(<ProfileEditForm onDone={onDone} />);

    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await save.reject(offlineError());

    // The gate exists so a rejection has somewhere to land — not to trap you in
    // a form afterwards. Once it's landed, the way out reopens.
    expect(cancelButton()).toBeEnabled();
    await user.click(cancelButton());
    expect(onDone).toHaveBeenCalled();
  });
});

describe("Comment edit", () => {
  const ownComment = {
    id: 5,
    author: { id: fakeUser.pk, display_name: "You", avatar_thumb: null },
    text: "original comment",
    created_at: "2026-07-13T08:00:00Z",
    edited_at: null,
    deleted_at: null,
    reactions: [],
    replies: [],
  };

  it("holds Cancel while the edit is out, then says the edit was refused", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.getComments.mockResolvedValue([ownComment]);
    api.updateComment.mockReturnValue(save.promise);

    renderWithAuth(<CommentThread target={{ postId: 7 }} />);
    await screen.findByPlaceholderText(/Write a comment/);

    await user.click(screen.getByRole("button", { name: "Comment options" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Comment options" })).getByRole(
        "button",
        { name: "Edit" }
      )
    );
    await user.type(screen.getByLabelText("Edit comment text"), " — fixed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());

    await save.reject(apiError("Editing is only allowed for 15 minutes.", 403));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Editing is only allowed for 15 minutes."
    );
  });

  it("keeps Cancel pressable on an empty box, which isn't the same as busy", async () => {
    const user = userEvent.setup();
    api.getComments.mockResolvedValue([ownComment]);

    renderWithAuth(<CommentThread target={{ postId: 7 }} />);
    await screen.findByPlaceholderText(/Write a comment/);

    await user.click(screen.getByRole("button", { name: "Comment options" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Comment options" })).getByRole(
        "button",
        { name: "Edit" }
      )
    );
    await user.clear(screen.getByLabelText("Edit comment text"));

    // Save is off here too, but for a different reason — there's nothing to
    // save. Gating Cancel on the same condition would strand you in a form you
    // could neither submit nor leave.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(cancelButton()).toBeEnabled();
  });
});

describe("Comment reply", () => {
  it("holds Cancel while the reply is out, then says the reply was refused", async () => {
    const user = userEvent.setup();
    const post = hanging();
    api.getComments.mockResolvedValue([
      {
        id: 6,
        author: { id: 999, display_name: "Priya", avatar_thumb: null },
        text: "anyone coming?",
        created_at: "2026-07-13T08:00:00Z",
        edited_at: null,
        deleted_at: null,
        reactions: [],
        replies: [],
      },
    ]);
    api.addComment.mockReturnValue(post.promise);

    renderWithAuth(<CommentThread target={{ postId: 7 }} />);
    await user.click(await screen.findByRole("button", { name: "Reply" }));
    const box = screen.getByPlaceholderText(/Reply to Priya/);
    await user.type(box, "Me!");
    // Scoped to the composer: the comment's own "Reply" toggle is still on
    // screen above it, wearing the same word.
    const composer = within(box.closest("form"));
    await user.click(composer.getByRole("button", { name: "Reply" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());

    await post.reject(offlineError());
    expect(
      await screen.findByText("Couldn't post. Try again.")
    ).toBeInTheDocument();
  });
});

describe("Post edit", () => {
  it("holds Cancel while the edit is out, then says the edit was refused", async () => {
    const user = userEvent.setup();
    const save = hanging();
    api.updatePost.mockReturnValue(save.promise);

    renderWithAuth(
      <PostCard
        post={{
          id: 3,
          author: { id: fakeUser.pk, display_name: "You", avatar_thumb: null },
          text: "the original post",
          created_at: "2026-07-13T08:00:00Z",
          edited_at: null,
          images: [],
          reactions: [],
          comment_count: 0,
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Post options" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Edit post text"), " (typo fixed)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());

    await save.reject(apiError("You can no longer edit this post.", 403));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can no longer edit this post."
    );
  });
});

describe("Group invite picker", () => {
  it("holds Close while an invite is out, then says the invite was refused", async () => {
    const user = userEvent.setup();
    const invite = hanging();
    api.listUsers.mockResolvedValue({
      results: [
        {
          id: 2,
          display_name: "Priya",
          avatar_thumb: null,
          connection_status: "connected",
        },
      ],
      count: 1,
      next: null,
    });
    api.inviteToGroup.mockReturnValue(invite.promise);

    renderWithAuth(<GroupInvitePicker groupId={4} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Invite" }));

    // "Close" rather than "Cancel", which is exactly why this one was missed —
    // it does the same thing to the same kind of form.
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeDisabled();
    await user.click(close);

    await invite.reject(apiError("They’ve already left this group.", 400));
    expect(
      await screen.findByText("They’ve already left this group.")
    ).toBeInTheDocument();
  });
});

// The two below weren't in #259's list — found sweeping for the same root cause
// while the fix was open, and folded in because the same edit covers them.
describe("Change password", () => {
  it("holds Close while the change is out, then says the change was refused", async () => {
    const user = userEvent.setup();
    let refuse;
    api.changePassword.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      })
    );

    renderWithAuth(<ChangePasswordSection />);
    await user.click(screen.getByRole("button", { name: /change password…/i }));
    await user.type(screen.getByLabelText("Current password"), "old-pw");
    await user.type(screen.getByLabelText("New password"), "brand-new-pw-99");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "brand-new-pw-99"
    );
    await user.click(screen.getByRole("button", { name: /change password$/i }));

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeDisabled();
    await user.click(close);

    // This one is the sharpest in the family: Close collapses the whole section,
    // so the 400 landed nowhere and you went on believing your password had
    // changed when it hadn't.
    await act(async () => {
      refuse(apiError("Your old password was entered incorrectly.", 400));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your old password was entered incorrectly."
    );
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
  });
});

describe("Create a group", () => {
  it("holds Cancel while the create is out, then says the create was refused", async () => {
    const user = userEvent.setup();
    const create = hanging();
    api.createGroup.mockReturnValue(create.promise);

    // Real routes, because here the dismissal is a *navigation* — Cancel leaves
    // the page, and leaving the page is what destroys the error.
    renderWithAuth(
      <Routes>
        <Route path="/groups/new" element={<GroupFormPage />} />
        <Route path="/groups" element={<p>Your groups</p>} />
      </Routes>,
      { route: "/groups/new" }
    );

    await user.type(
      screen.getByPlaceholderText("Family, book club, five-a-side…"),
      "New Crew"
    );
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());
    expect(screen.queryByText("Your groups")).toBeNull();

    await create.reject(apiError("You already have a group with that name.", 400));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You already have a group with that name."
    );
  });
});

describe("Plan an event", () => {
  it("holds Cancel while the create is out, then says the create was refused", async () => {
    const user = userEvent.setup();
    const create = hanging();
    api.createEvent.mockReturnValue(create.promise);

    renderWithAuth(<PlanEventForm groupId={4} onClose={vi.fn()} />);

    await user.type(
      screen.getByLabelText(/What are you planning/),
      "Grandma’s 80th"
    );
    await user.click(screen.getByRole("button", { name: "Plan an event" }));

    expect(cancelButton()).toBeDisabled();
    await user.click(cancelButton());

    await create.reject(offlineError());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't create the event."
    );
  });
});
