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
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BASE_URL } from '@/api';
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection';
import { DeleteAccountSection } from '@/components/settings/DeleteAccountSection';
import { FeedPreferencesSection } from '@/components/settings/FeedPreferencesSection';
import { NotificationPreferencesSection } from '@/components/settings/NotificationPreferencesSection';
import { colors, fontSize, spacing } from '@/theme';

export default function SettingsScreen() {
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Text style={styles.back}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <FeedPreferencesSection />
        <NotificationPreferencesSection />
        <ChangePasswordSection />
        <LegalSection />
        <DeleteAccountSection />
      </ScrollView>
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
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.base,
    fontWeight: '700',
    color: colors.ink,
  },
  spacer: { width: 48 },
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
