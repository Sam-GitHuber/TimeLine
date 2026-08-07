/**
 * Create a group (Phase 9 E3a) — a thin screen wrapping the shared `GroupForm`.
 * You become the new group's first member and sole admin; on success it opens
 * the new group.
 */

import { router } from 'expo-router';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GroupForm } from '@/components/GroupForm';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { colors, fontSize, spacing } from '@/theme';
import { useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function NewGroupScreen() {
  // Back is the only control on this screen that isn't the form's, and it
  // unmounts the form's error with it — so it reads the form's declared write
  // (#259). The form itself holds the hardware back and the swipe.
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
        <Text style={styles.title}>New group</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAwareScroll style={styles.fill} keyboardShouldPersistTaps="handled">
        <WriteHoldProvider hold={hold}>
          <GroupForm mode="create" />
        </WriteHoldProvider>
      </KeyboardAwareScroll>
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
});
