/**
 * The ⋯ overflow menu on a post header. What it offers depends on whether you
 * own the post (mirrors the web `PostMenu.jsx`, owner check `user.pk === authorId`):
 *
 *   - **your own post** → *Edit* (opens `PostEditModal`) and *Delete* (confirmed,
 *     then removed everywhere it shows).
 *   - **someone else's** → *Report* (opens the shared `ReportModal`).
 *
 * Edit sits **above** Delete and is styled plainly: the destructive item goes
 * last, so the finger heading for the safe action never passes over it.
 *
 * Presented through `useActionMenu` — an `ActionSheetIOS` on iOS, a bottom sheet
 * on Android — the same pattern the group ⋯ menu uses
 * (`app/groups/[groupId].tsx`).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet } from 'react-native';

import { api } from '@/api';
import { useAuth } from '@/auth';
import { useActionMenu } from './ActionMenu';
import { KebabIcon } from './icons';
import { PostEditModal } from './PostEditModal';
import { ReportModal } from './ReportModal';
import { colors, radius, spacing } from '@/theme';

export function PostMenu({
  postId,
  authorId,
  /** The post's current text, the starting point for an edit. */
  text,
  /** Whether the post has photos — a photo-only post may be left with no text. */
  hasImages = false,
}: {
  postId: number;
  authorId: number;
  text: string;
  hasImages?: boolean;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [editing, setEditing] = useState(false);

  const isOwner = user != null && user.pk === authorId;

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePost(postId),
    onSuccess: () => {
      // A post can be on the home feed (`['feed', includeGroups]`, prefix-matched
      // by `['feed']`), a profile, a group timeline, or its own permalink —
      // invalidate all so it disappears wherever it's shown, exactly as the web
      // `PostMenu` does.
      for (const key of [['feed'], ['userPosts'], ['groupPosts'], ['post', String(postId)]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (err) => {
      Alert.alert(
        'Couldn’t delete',
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    },
  });

  function confirmDelete() {
    Alert.alert('Delete post?', 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMutation.mutate() },
    ]);
  }

  const { openMenu, menu } = useActionMenu();

  const showMenu = () =>
    openMenu({
      title: 'Post options',
      items: isOwner
        ? [
            { label: 'Edit post', onPress: () => setEditing(true) },
            { label: 'Delete post', destructive: true, onPress: confirmDelete },
          ]
        : [{ label: 'Report post', onPress: () => setReporting(true) }],
    });

  // Nothing to offer a logged-out viewer (they can't reach the feed anyway).
  if (!user) return null;

  return (
    <>
      <Pressable
        onPress={showMenu}
        accessibilityRole="button"
        accessibilityLabel="Post options"
        hitSlop={8}
        style={styles.trigger}
      >
        <KebabIcon color={colors.inkFaint} />
      </Pressable>

      {menu}

      {editing ? (
        <PostEditModal
          postId={postId}
          initialText={text}
          hasImages={hasImages}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {reporting ? (
        <ReportModal postId={postId} onClose={() => setReporting(false)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    marginLeft: 'auto',
    padding: spacing.xs,
    borderRadius: radius.pill,
  },
});
