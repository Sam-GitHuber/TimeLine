/**
 * Create or edit a group (Phase 9 E3a) — name, description, and an optional
 * avatar reframed in the same round `AvatarCropModal` the profile editor uses.
 *
 * One component serves both modes: `create` (POST, you become the first admin →
 * open the new group) and `edit` (PATCH, admin-only server-side → back to the
 * group). It owns the mutation so the two thin screens just supply chrome.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type PhotoUpload } from '@/api';
import { AvatarCropModal } from './AvatarCropModal';
import { Avatar } from './Avatar';
import { colors, fontSize, radius, spacing } from '@/theme';
import type { Group } from '@/types';

const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

type PendingCrop = { uri: string; width: number; height: number };

export function GroupForm({
  mode,
  groupId,
  initial,
}: {
  mode: 'create' | 'edit';
  groupId?: number;
  initial?: { name: string; description: string; avatar_thumb: string | null };
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [avatarFile, setAvatarFile] = useState<PhotoUpload | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<PendingCrop | null>(null);

  const mutation = useMutation({
    mutationFn: (): Promise<Group> => {
      if (mode === 'create') {
        return api.createGroup({
          name: name.trim(),
          description: description.trim(),
          avatar: avatarFile ?? undefined,
        });
      }
      return api.updateGroup(groupId!, {
        name: name.trim(),
        description: description.trim(),
        avatar: avatarFile ?? undefined,
        removeAvatar,
      });
    },
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      if (mode === 'create') {
        // Replace the form with the new group so Back lands on the Groups tab.
        router.replace(`/groups/${group.id}`);
      } else {
        queryClient.invalidateQueries({ queryKey: ['group', groupId] });
        router.back();
      }
    },
  });

  async function pickAvatar() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    setPendingCrop({ uri: asset.uri, width: asset.width, height: asset.height });
  }

  function handleCropped(upload: PhotoUpload) {
    setAvatarFile(upload);
    setRemoveAvatar(false);
    setPendingCrop(null);
  }

  const previewUser = avatarFile
    ? { display_name: name || '?', avatar_thumb: avatarFile.uri }
    : removeAvatar
      ? { display_name: name || '?', avatar_thumb: null }
      : { display_name: name || '?', avatar_thumb: initial?.avatar_thumb ?? null };
  const hasAvatar = Boolean(avatarFile || (initial?.avatar_thumb && !removeAvatar));

  const canSave = name.trim() !== '' && !mutation.isPending;

  return (
    <View style={styles.form}>
      <View style={styles.avatarRow}>
        <Avatar user={previewUser} size="lg" />
        <View style={styles.avatarActions}>
          <Pressable onPress={pickAvatar} accessibilityRole="button" style={styles.ghostButton}>
            <Text style={styles.ghostLabel}>{hasAvatar ? 'Change photo' : 'Add photo'}</Text>
          </Pressable>
          {hasAvatar ? (
            <Pressable
              onPress={() => {
                setAvatarFile(null);
                setRemoveAvatar(true);
              }}
              accessibilityRole="button"
              style={styles.ghostButton}
            >
              <Text style={[styles.ghostLabel, styles.danger]}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View>
        <Text style={styles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX}
          placeholder="e.g. The Anderson family"
          placeholderTextColor={colors.inkFaint}
          style={styles.input}
          accessibilityLabel="Group name"
        />
      </View>

      <View>
        <Text style={styles.label}>Description</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={DESCRIPTION_MAX}
          placeholder="What’s this group for? (optional)"
          placeholderTextColor={colors.inkFaint}
          style={[styles.input, styles.multiline]}
          accessibilityLabel="Group description"
        />
      </View>

      {mutation.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {mutation.error instanceof Error
            ? mutation.error.message
            : 'Couldn’t save the group.'}
        </Text>
      ) : null}

      <Pressable
        onPress={() => canSave && mutation.mutate()}
        disabled={!canSave}
        accessibilityRole="button"
        accessibilityLabel={mode === 'create' ? 'Create group' : 'Save'}
        style={[styles.saveButton, !canSave && styles.saveDisabled]}
      >
        <Text style={styles.saveLabel}>
          {mutation.isPending
            ? mode === 'create'
              ? 'Creating…'
              : 'Saving…'
            : mode === 'create'
              ? 'Create group'
              : 'Save'}
        </Text>
      </Pressable>

      {pendingCrop ? (
        <AvatarCropModal
          photo={pendingCrop}
          onCropped={handleCropped}
          onCancel={() => setPendingCrop(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.lg, padding: spacing.md },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  error: { fontSize: fontSize.sm, color: colors.danger },
  ghostButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600', color: colors.ink },
  danger: { color: colors.danger },
  saveButton: {
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  saveDisabled: { opacity: 0.5 },
  saveLabel: { fontSize: fontSize.base, fontWeight: '700', color: '#ffffff' },
});
