/**
 * Plan an event in a group (Phase 9 E3c-a) — a thin screen wrapping the shared
 * `PlanEventForm`, reached from the group ⋯ menu's "Plan an event". On success
 * it opens the new event so the organiser can set/poll its dimensions.
 */

import { router, useLocalSearchParams } from 'expo-router';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { PlanEventForm } from '@/components/events/PlanEventForm';
import { colors, fontSize, spacing } from '@/theme';
import { useWriteHold, WriteHoldProvider } from '@/writeHold';

// A render error on this screen stops here instead of blanking the whole app
// (#299). expo-router wraps a route in its `ErrorBoundary` export, and installs
// nothing by default — see `components/ErrorBoundary` for what that means.
export { ErrorBoundary } from '@/components/ErrorBoundary';

export default function PlanEventScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = Number(groupId);
  // Back is the only control here that isn't the form's, and it unmounts the
  // form's error with it — so it reads the write the form declares (#259).
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
        <Text style={styles.title}>Plan an event</Text>
        <View style={styles.spacer} />
      </View>
      <KeyboardAwareScroll style={styles.fill} keyboardShouldPersistTaps="handled">
        <WriteHoldProvider hold={hold}>
          <PlanEventForm groupId={id} />
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
