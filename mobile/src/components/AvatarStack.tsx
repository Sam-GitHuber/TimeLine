/**
 * A group chat's identity: overlapping avatars, capped so a big group doesn't
 * blow out a row or a header. Ported from the web's `AvatarStack` (inside
 * `MessagesDrawer.jsx`).
 *
 * Each avatar overlaps the previous one and carries a surface-coloured ring, so
 * the pile reads as a *stack* rather than a row of separate faces. The overlap
 * is a negative margin on every avatar after the first — RN has no `space-x`
 * utility, so it's applied per-child here.
 */

import { StyleSheet, View } from 'react-native';

import { Avatar } from './Avatar';
import { colors, radius } from '@/theme';

type Person = { id: number; display_name: string; avatar_thumb: string | null };

export function AvatarStack({
  participants,
  max = 4,
}: {
  participants: Person[];
  max?: number;
}) {
  const shown = participants.slice(0, max);
  return (
    <View style={styles.stack}>
      {shown.map((person, index) => (
        <View
          key={person.id}
          style={[styles.ring, index > 0 && styles.overlap]}
        >
          <Avatar user={person} size="sm" />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { flexDirection: 'row' },
  // A ring the colour of the surface so overlapping faces stay visually
  // separated — the web uses `ring-2 ring-surface` for the same reason. The pill
  // radius keeps the ring circular around the `sm` (32pt) avatar.
  ring: {
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  overlap: { marginLeft: -12 },
});
