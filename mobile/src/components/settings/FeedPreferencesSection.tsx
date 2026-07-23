/**
 * The "Feed" section of Settings (Phase 9 E4b) — where the include-groups
 * preference lives, moved out of the feed header.
 *
 * On the web this is a per-browser toggle in the feed header; on the phone it's
 * a per-device preference set here and read by the feed (see `preferences.tsx`).
 * Only group *posts* merge into the home feed — group **events** stay on the
 * group pages and the Calendar tab — so the wording says posts, not "posts and
 * events", to match what actually happens.
 */

import { StyleSheet, Switch, Text, View } from 'react-native';

import { usePreferences } from '@/preferences';
import { colors, fontSize, spacing } from '@/theme';

export function FeedPreferencesSection() {
  const { includeGroupsInFeed, setIncludeGroupsInFeed } = usePreferences();

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Feed</Text>

      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Show group posts in your feed</Text>
          <Text style={styles.rowHint}>
            Merges posts from groups you’re in with the rest of your timeline,
            newest first. Events stay on the group pages and your Calendar.
          </Text>
        </View>
        <Switch
          value={includeGroupsInFeed}
          onValueChange={setIncludeGroupsInFeed}
          trackColor={{ true: colors.accent, false: colors.lineStrong }}
          accessibilityLabel="Show group posts in your feed"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  heading: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  row: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rowText: { flex: 1, gap: spacing.xs },
  rowLabel: { fontSize: fontSize.base, color: colors.ink },
  rowHint: { fontSize: fontSize.sm, color: colors.inkSoft, lineHeight: 18 },
});
