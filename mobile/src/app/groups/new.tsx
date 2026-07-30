/**
 * Create a group (Phase 9 E3a) — a thin screen wrapping the shared `GroupForm`.
 * You become the new group's first member and sole admin; on success it opens
 * the new group.
 */

import { router } from 'expo-router';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupForm } from '@/components/GroupForm';
import { KeyboardAvoider } from '@/components/KeyboardAvoider';
import { colors, fontSize, spacing } from '@/theme';

export default function NewGroupScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>New group</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAvoider style={styles.fill}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <GroupForm mode="create" />
        </ScrollView>
      </KeyboardAvoider>
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
});
