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

import { api } from '@/api';
import { GroupForm } from '@/components/GroupForm';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { colors, fontSize, spacing } from '@/theme';
import { useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function EditGroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.getGroup(id) });
  const group = groupQuery.data;
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
      {group ? (
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
});
