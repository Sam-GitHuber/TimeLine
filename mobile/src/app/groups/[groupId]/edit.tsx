/**
 * Edit a group (Phase 9 E3a) — a thin screen wrapping the shared `GroupForm`,
 * pre-filled from the group. Admin-only; the server enforces it (a non-admin's
 * PATCH is rejected). On success it returns to the group.
 */

import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { GroupForm } from '@/components/GroupForm';
import { colors, fontSize, spacing } from '@/theme';

export default function EditGroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  const groupQuery = useQuery({ queryKey: ['group', id], queryFn: () => api.getGroup(id) });
  const group = groupQuery.data;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Edit group</Text>
        <View style={styles.spacer} />
      </View>
      {group ? (
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <GroupForm
              mode="edit"
              groupId={id}
              initial={{
                name: group.name,
                description: group.description,
                avatar_thumb: group.avatar_thumb,
              }}
            />
          </ScrollView>
        </KeyboardAvoidingView>
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
  title: { flex: 1, textAlign: 'center', fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  spacer: { width: 48 },
  spinner: { marginTop: spacing.xl },
});
