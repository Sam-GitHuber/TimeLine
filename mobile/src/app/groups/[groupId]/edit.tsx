/**
 * Edit a group (Phase 9 E3a) — a thin screen wrapping the shared `GroupForm`,
 * pre-filled from the group. Admin-only; the server enforces it (a non-admin's
 * PATCH is rejected). On success it returns to the group.
 */

import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError, serverMessage, WENT_WRONG } from '@/api';
import { GroupForm } from '@/components/GroupForm';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { colors, fontSize, radius, spacing } from '@/theme';
import { useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function EditGroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.getGroup(id) });
  const group = groupQuery.data;
  // A 404 outranks a retry, the same way it does on the group page and the
  // profile: deleted, or you've been removed. Offering *Try again* for a request
  // that will 404 forever replaces one dead end with another, which is the
  // failure this screen was fixed for.
  const notFound =
    groupQuery.error instanceof ApiError && groupQuery.error.status === 404;
  // `&& !group` for the same reason every other screen has it: a failed
  // *refresh* must leave the form — and whatever has been typed into it — alone.
  const loadFailed = groupQuery.isError && !group;
  // Back unmounts the form and the refusal it is the only renderer of, so it
  // reads the write the form declares (#259). The form holds the hardware back
  // and the swipe itself.
  const hold = useWriteHold();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => {
            if (hold.held) return;
            router.back();
          }}
          disabled={hold.held}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={[styles.back, hold.held && styles.backDisabled]}>
            ← Back
          </Text>
        </Pressable>
        <Text style={styles.title}>Edit group</Text>
        <View style={styles.spacer} />
      </View>
      {notFound ? (
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>This group isn’t available.</Text>
          <Text style={styles.emptyBody}>
            It may have been deleted, or you may no longer be a member.
          </Text>
        </View>
      ) : group ? (
        <KeyboardAwareScroll style={styles.fill} keyboardShouldPersistTaps="handled">
          <WriteHoldProvider hold={hold}>
            <GroupForm
              mode="edit"
              groupId={id}
              initial={{
                name: group.name,
                description: group.description,
                avatar_thumb: group.avatar_thumb,
              }}
            />
          </WriteHoldProvider>
        </KeyboardAwareScroll>
      ) : loadFailed ? (
        // Not a false empty state — the same missing branch, reaching the same
        // dead end (#317). `groupQuery.isError` was read nowhere, so an admin
        // who tapped ⋯ → Edit group on bad signal got a spinner that never
        // resolved, never explained itself and offered no way to ask again.
        // `members.tsx` next door has had this branch all along.
        <View style={styles.centre}>
          <Text style={styles.emptyTitle}>Couldn’t load this group</Text>
          <Text style={styles.emptyBody}>
            {serverMessage(groupQuery.error, WENT_WRONG)}
          </Text>
          <Pressable
            onPress={() => groupQuery.refetch()}
            accessibilityRole="button"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { fontSize: fontSize.sm, color: colors.inkFaint, fontWeight: '600' },
  // Unavailable rather than silently declining — a dead Back reads as broken.
  backDisabled: { opacity: 0.4 },
  title: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  spacer: { width: 48 },
  spinner: { marginTop: spacing.xl },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { fontSize: fontSize.base, fontWeight: '600', color: colors.ink },
  emptyBody: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    textAlign: 'center',
    lineHeight: 20,
  },
  // The same outlined button as every other retry in the app.
  retry: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  retryText: { color: colors.ink, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
