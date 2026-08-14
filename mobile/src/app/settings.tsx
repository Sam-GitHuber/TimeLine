/**
 * Settings (Phase 9 E4b) — the account-level controls, ported from the web
 * `SettingsPage.jsx`. Reached from a gear on your own profile screen (where
 * logout lives); it's not a tab, because five tabs is the iOS comfortable max
 * and they're already full (see the phase plan's E4 nav decision).
 *
 * Public-facing profile info (name, bio, avatar) is edited in place on the
 * profile itself, not here — Settings holds only the account controls:
 * per-type notification preferences, change-password, delete-account, and the
 * Terms/Privacy links. The legal pages are the web app's own hosted pages,
 * opened in an in-app browser (`expo-web-browser`) rather than re-implemented —
 * one source of truth for the wording, and App Review wants them reachable.
 */

import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BASE_URL } from '@/api';
import { KeyboardAwareScroll } from '@/components/KeyboardAvoider';
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
import { DeleteAccountSection } from '@/components/settings/DeleteAccountSection';
import { FeedPreferencesSection } from '@/components/settings/FeedPreferencesSection';
import { MessagePreviewSection } from '@/components/settings/MessagePreviewSection';
import { NotificationPreferencesSection } from '@/components/settings/NotificationPreferencesSection';
import { PrivacySection } from '@/components/settings/PrivacySection';
import { colors, fontSize, spacing } from '@/theme';
import { useAndroidBack } from '@/useAndroidBack';
import { useHoldSwipeBack, useWriteHold, WriteHoldProvider } from '@/writeHold';

export default function SettingsScreen() {
  /**
   * Leaving Settings is held while a section below has a write out (#256).
   *
   * `ChangePasswordSection` is the sharpest case in this whole family, because
   * it leaves you wrong about your own credentials: fill the three fields, tap
   * Change password, leave, and the 400 of *"Your old password was entered
   * incorrectly"* lands in a form that has already gone. Nothing is said, and
   * you go on believing your password is the new one.
   *
   * The section is two levels above the request, so the hold is declared from
   * the form and read here rather than passed down as a prop. Android's back is
   * claimed by the section itself (it collapses the form rather than leaving the
   * screen), so only the swipe is taken here — two registrations for one press
   * would race on hook order.
   */
  const hold = useWriteHold();
  useHoldSwipeBack(hold.held);
  // Android's hardware back is the fourth exit, and the only section that
  // claims it is `ChangePasswordSection` — and only while its accordion is
  // open. A read-receipts or notification toggle saving is neither, so without
  // this the press falls through to the navigator and pops the whole screen.
  //
  // Two registrations can be live at once here (this one and the section's),
  // and that's fine because they *agree*: both decline while the hold is up.
  // What must never happen is two that would do different things — see
  // `writeHold.tsx`.
  useAndroidBack(hold.held, () => {});

  const goBack = () => {
    if (hold.held) return;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          disabled={hold.held}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={[styles.back, hold.held && styles.backDisabled]}>
            ← Back
          </Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.spacer} />
      </View>

      {/* `ChangePasswordSection`'s three fields sit low on a long page, so this
          screen needs an avoider even though it never had a
          `KeyboardAvoidingView` to convert — under edge-to-edge nothing resizes
          the window, so without it the field and its Save button go behind the
          keyboard. See `components/KeyboardAvoider.tsx`. */}
      <KeyboardAwareScroll
        style={styles.fill}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Renders no view of its own. `DeleteAccountSection` is inside it and
            declares nothing: it holds its own dialog open (#255) and, once the
            delete lands, deliberately lets go before a teardown that is itself
            two network round trips — a hold across those would seal someone
            into a "Deleting…" box with no way out. */}
        <WriteHoldProvider hold={hold}>
          <FeedPreferencesSection />
          <NotificationPreferencesSection />
          {/* Immediately after the notification preferences, because it is the
              obvious next question once you've decided what notifies you — but
              its own section, because those are per account and this is per
              device. */}
          <MessagePreviewSection />
          <PrivacySection />
          <ChangePasswordSection />
          <LegalSection />
          <DeleteAccountSection />
        </WriteHoldProvider>
      </KeyboardAwareScroll>
    </SafeAreaView>
  );
}

function LegalSection() {
  const open = (path: string) => WebBrowser.openBrowserAsync(`${BASE_URL}${path}`);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>About</Text>
      <LegalRow label="Terms of Service" onPress={() => open('/terms')} />
      <LegalRow label="Privacy Policy" onPress={() => open('/privacy')} />
    </View>
  );
}

function LegalRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      style={styles.legalRow}
    >
      <Text style={styles.legalLabel}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
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
  // Shown as unavailable rather than silently declining — a Back that answers a
  // press with nothing reads as broken.
  backDisabled: { opacity: 0.4 },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  spacer: { width: 48 },
  fill: { flex: 1 },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  section: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  heading: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  legalRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
  },
  legalLabel: { fontSize: fontSize.base, color: colors.ink },
  chevron: { fontSize: fontSize.lg, color: colors.inkFaint },
});
