/**
 * The list of people offered while you type `@` (Phase 9b M8).
 *
 * Sits directly **above the composer**, between it and the transcript, which is
 * the only place it can go: your thumb is already at the bottom of the screen
 * and the keyboard owns everything below. It's a strip, not a modal — you're
 * still writing, and a sheet that has to be dismissed would turn naming someone
 * into a detour.
 *
 * Deliberately renders nothing when there's nobody to suggest, so a caller can
 * mount it unconditionally and let it decide. Same reason it takes the already
 * filtered list: matching is a string question that belongs in `mentions.ts`
 * with its tests, not in a component.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import type { Mentionable } from '@/mentions';
import { colors, fontSize, radius, spacing } from '@/theme';

export function MentionSuggestions({
  people,
  onChoose,
}: {
  people: Mentionable[];
  onChoose: (person: Mentionable) => void;
}) {
  if (people.length === 0) return null;

  return (
    <View style={styles.strip}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // The keyboard must stay up: choosing a name is the middle of writing a
        // sentence, and a dismissed keyboard would put the composer back down
        // the screen and make you tap into it again.
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.row}
      >
        {people.map((person) => (
          <Pressable
            key={person.id}
            onPress={() => onChoose(person)}
            accessibilityRole="button"
            accessibilityLabel={`Mention ${person.display_name}`}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          >
            <Avatar user={person} size="xs" />
            <Text style={styles.name} numberOfLines={1}>
              {person.display_name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingLeft: spacing.xs,
    paddingRight: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  chipPressed: { backgroundColor: colors.accentTint },
  name: {
    maxWidth: 160,
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.ink,
  },
});
