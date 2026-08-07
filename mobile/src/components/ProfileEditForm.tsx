/**
 * Inline editor for your own profile, ported from
 * `frontend/src/components/ProfileEditForm.jsx`.
 *
 * Edits your real name (first + last — the display name, since there are no
 * usernames), a short bio, and an avatar. Saves via dj-rest-auth's user
 * endpoint, then refreshes the logged-in user so the new name/avatar show up
 * everywhere they're read from auth (the nav bead, the compose box), and
 * invalidates the cached profile/feed so this screen and others repaint.
 *
 * **Avatar cropping is a round cropper matching the web** (`AvatarCropModal`):
 * a chosen photo is handed to it to pinch/pan-reframe under a circular guide,
 * and it returns the cropped square. We deliberately *don't* use the OS picker's
 * `allowsEditing` crop — that only ever shows a square guide, so you can't see
 * the circle you're framing for.
 *
 * `onDone` closes the editor (used by Cancel and after a successful save).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api, type PhotoUpload } from '@/api';
import { useAuth } from '@/auth';
import { usePhotoPicker } from '@/photoSource';
import { AvatarCropModal } from './AvatarCropModal';
import { Avatar } from './Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import { useHoldOpen } from '@/writeHold';

/** A just-picked photo waiting to be reframed in the crop modal. */
type PendingCrop = { uri: string; width: number; height: number };

export function ProfileEditForm({ onDone }: { onDone: () => void }) {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  // avatarFile: a freshly cropped photo to upload. removeAvatar: clear the
  // existing one. They're mutually exclusive — picking a photo cancels a pending
  // removal, and removing clears any picked photo.
  const [avatarFile, setAvatarFile] = useState<PhotoUpload | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  // A just-chosen photo waiting to be reframed in the crop modal.
  const [pendingCrop, setPendingCrop] = useState<PendingCrop | null>(null);
  // The PATCH has landed — set before `onSuccess` does its follow-up work. See
  // `holding` below for why `mutation.isPending` alone is the wrong flag.
  const [saved, setSaved] = useState(false);
  const { pickPhotos, photoMenu } = usePhotoPicker();

  const mutation = useMutation({
    mutationFn: () =>
      api.updateProfile({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        bio,
        avatar: avatarFile ?? undefined,
        // `removeAvatar` and `avatarFile` are mutually exclusive by
        // construction — picking a photo clears the removal flag, removing
        // clears the picked file — so this needs no `&& !avatarFile` guard.
        removeAvatar,
      }),
    onSuccess: async () => {
      // The write has landed, so there is no longer a rejection for this form to
      // be the only renderer of — let go *now*, before the follow-up below.
      // React Query keeps `isPending` true for the whole of `onSuccess`, so a
      // hold left on it alone would stay shut across the `refreshUser()` round
      // trip, which has nothing to report: that moves the trap rather than
      // removing it (#255's note on the delete dialogs, #259's on the web's
      // ProfileEditForm).
      setSaved(true);
      // The profile is already saved server-side here. Refreshing "who am I" is
      // best-effort — if that refetch blips, don't strand the user in an open
      // editor with no error (the mutation succeeded); close anyway and let the
      // invalidations below repaint the new details.
      try {
        await refreshUser();
      } catch {
        // ignore — the invalidations still pull the fresh profile
      }
      // Any cached copy of this profile / the feed may show a stale name or
      // avatar — drop them so they refetch with the new details.
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['userPosts'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      onDone();
    },
  });

  async function pickAvatar() {
    // Camera as well as library: a profile photo is the one picture most people
    // want to take on the spot rather than dig out of a camera roll. No
    // `allowsEditing` — we want the *full* image so our round cropper can
    // reframe it, not the OS square crop.
    const assets = await pickPhotos('Profile photo');
    if (!assets) return;

    const asset = assets[0];
    setPendingCrop({ uri: asset.uri, width: asset.width, height: asset.height });
  }

  // The crop modal hands back the reframed square, ready to upload.
  function handleCropped(upload: PhotoUpload) {
    setAvatarFile(upload);
    setRemoveAvatar(false);
    setPendingCrop(null);
  }

  function handleRemove() {
    setAvatarFile(null);
    setRemoveAvatar(true);
  }

  // What the preview shows: a freshly picked file wins (its local `uri` goes
  // straight through `Avatar` → `AuthedImage`, which sends no bearer header to a
  // non-backend `file://` uri); otherwise the current avatar, unless we're about
  // to remove it, in which case fall back to the initial.
  const previewUser = avatarFile
    ? { display_name: user?.display_name, avatar_thumb: avatarFile.uri }
    : removeAvatar
      ? { display_name: user?.display_name, avatar_thumb: null }
      : user;
  const hasAvatar = Boolean(
    avatarFile || (user?.avatar_thumb && !removeAvatar)
  );

  const canSave =
    firstName.trim() !== '' && lastName.trim() !== '' && !mutation.isPending;

  /**
   * Nothing may close this form while the PATCH is out (#256/#259).
   *
   * The error above is its only renderer, and every way out unmounts it: this
   * form's own Cancel, Android's hardware back and the profile screen's
   * "← Back" (both held by the screen, which reads this through the hold) and
   * iOS's swipe-back. Pick a new avatar on mobile data, hit Save, leave — and a
   * multipart upload the server then rejects for its image allow-list leaves the
   * old avatar showing and nothing said.
   */
  const holding = mutation.isPending && !saved;
  useHoldOpen(holding);

  return (
    <View style={styles.form}>
      <View style={styles.avatarRow}>
        <Avatar user={previewUser} size="lg" />
        <View style={styles.avatarActions}>
          <Pressable
            onPress={pickAvatar}
            accessibilityRole="button"
            style={styles.ghostButton}
          >
            <Text style={styles.ghostLabel}>
              {hasAvatar ? 'Change photo' : 'Add photo'}
            </Text>
          </Pressable>
          {hasAvatar ? (
            <Pressable
              onPress={handleRemove}
              accessibilityRole="button"
              style={styles.ghostButton}
            >
              <Text style={[styles.ghostLabel, styles.danger]}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.nameRow}>
        <View style={styles.nameField}>
          <Text style={styles.label}>First name</Text>
          <TextInput
            value={firstName}
            onChangeText={setFirstName}
            textContentType="givenName"
            style={styles.input}
            accessibilityLabel="First name"
          />
        </View>
        <View style={styles.nameField}>
          <Text style={styles.label}>Last name</Text>
          <TextInput
            value={lastName}
            onChangeText={setLastName}
            textContentType="familyName"
            style={styles.input}
            accessibilityLabel="Last name"
          />
        </View>
      </View>

      <View>
        <Text style={styles.label}>Bio</Text>
        <TextInput
          value={bio}
          onChangeText={setBio}
          multiline
          maxLength={500}
          placeholder="A sentence or two about you."
          placeholderTextColor={colors.inkFaint}
          style={[styles.input, styles.bio]}
          accessibilityLabel="Bio"
        />
      </View>

      {mutation.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {mutation.error instanceof Error
            ? mutation.error.message
            : 'Couldn’t save your profile.'}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={onDone}
          disabled={holding}
          accessibilityRole="button"
          style={[styles.ghostButton, holding && styles.ghostDisabled]}
        >
          <Text style={styles.ghostLabel}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => canSave && mutation.mutate()}
          disabled={!canSave}
          accessibilityRole="button"
          style={[styles.saveButton, !canSave && styles.saveDisabled]}
        >
          <Text style={styles.saveLabel}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
      </View>

      {pendingCrop ? (
        <AvatarCropModal
          photo={pendingCrop}
          onCropped={handleCropped}
          onCancel={() => setPendingCrop(null)}
        />
      ) : null}

      {/* The camera/library sheet. `null` on iOS, where it's native. It closes
          before the cropper opens, so the two modals never stack. */}
      {photoMenu}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.lg },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  nameRow: { flexDirection: 'row', gap: spacing.md },
  nameField: { flex: 1, gap: spacing.xs },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.inkSoft },
  input: {
    marginTop: spacing.xs,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  bio: { minHeight: 88, textAlignVertical: 'top' },
  error: { fontSize: fontSize.sm, color: colors.danger },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  ghostButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  // Matches `saveDisabled` beside it: while the write is out both halves of the
  // pair are unavailable, which is the asymmetry #259 was about.
  ghostDisabled: { opacity: 0.5 },
  danger: { color: colors.danger },
  saveButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  saveDisabled: { opacity: 0.5 },
  saveLabel: { fontSize: fontSize.sm, fontWeight: '700', color: '#ffffff' },
});
