import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import ConfirmDeleteDialog from "./ConfirmDeleteDialog.jsx";
import OverflowMenu, { MenuItem } from "./OverflowMenu.jsx";
import { ReportModal } from "./ReportModal.jsx";

// The ⋯ overflow menu on a post header (issue #62). What it offers depends on
// whether you own the post:
//   - your own post → Edit (flips the card into an inline editor via `onEdit`)
//     and Delete (confirm, then remove),
//   - someone else's → Report (the same modal the inline control used to open —
//     Report now lives here rather than in the footer row).
// The owner check is `user.pk === authorId`, the same one a comment's menu makes.
//
// The menu itself (portal, positioning, click-outside) lives in `OverflowMenu`,
// shared with the comment menu — see there for why it's a `role="dialog"`
// popover rather than an ARIA menu.
export default function PostMenu({ postId, authorId, onEdit }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isOwner = user != null && authorId != null && user.pk === authorId;

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePost(postId),
    onSuccess: () => {
      // The post can be on the home feed, a profile, a group timeline, or its
      // own permalink — invalidate them all (prefix match) so it disappears
      // wherever it's shown.
      queryClient.invalidateQueries({ queryKey: ["feed"] });
      queryClient.invalidateQueries({ queryKey: ["userPosts"] });
      queryClient.invalidateQueries({ queryKey: ["groupPosts"] });
      queryClient.invalidateQueries({ queryKey: ["post", String(postId)] });
    },
  });

  // Nothing to offer a logged-out viewer (they can't reach the feed anyway).
  if (!user) return null;

  return (
    <>
      <OverflowMenu label="Post options">
        {(close) =>
          isOwner ? (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  onEdit();
                }}
              >
                Edit
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  close();
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </MenuItem>
            </>
          ) : (
            <MenuItem
              onClick={() => {
                close();
                setReporting(true);
              }}
            >
              Report
            </MenuItem>
          )
        }
      </OverflowMenu>

      {reporting && (
        <ReportModal postId={postId} onClose={() => setReporting(false)} />
      )}

      {confirmingDelete && (
        <ConfirmDeleteDialog
          title="Delete this post?"
          description="This can’t be undone. Its comments, reactions and photos will be removed too."
          label="Delete post"
          errorFallback="Couldn’t delete the post."
          // Stay in the busy state after success too: on a slow refetch the card
          // hasn't unmounted yet, and a second click would re-fire deletePost on
          // an already-deleted post (404). `isSuccess` keeps the button disabled
          // until this card is removed from the list.
          pending={deleteMutation.isPending || deleteMutation.isSuccess}
          error={deleteMutation.isError ? deleteMutation.error : null}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => deleteMutation.mutate()}
        />
      )}
    </>
  );
}
