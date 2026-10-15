/**
 * The photos waiting to be sent, above a composer (Phase 9b M7, then #400) —
 * where you can see them while writing the caption, and where the ✕ to change
 * your mind is nowhere near Send.
 *
 * A row rather than one thumbnail since a paste can carry several images (see
 * `stagedPhotos.ts`). It scrolls sideways once it's wider than the bar, so ten
 * photos don't push the composer off a small screen. Placeholders hold the place
 * of any still being resized, which on a big photo is long enough to look like
 * nothing happened.
 */

import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { OutgoingPhoto } from '@/outbox';
import { colors, fontSize, radius, spacing } from '@/theme';

export function StagedPhotos({
  photos,
  preparingCount,
  onRemove,
}: {
  photos: OutgoingPhoto[];
  preparingCount: number;
  onRemove: (index: number) => void;
}) {
  if (photos.length === 0 && preparingCount === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.strip}
      // Room for the ✕ that overhangs each thumbnail's corner, which a
      // ScrollView would otherwise clip.
      contentContainerStyle={styles.content}
    >
      {photos.map((photo, index) => (
        // Unique per prepare (each writes a new file), and stable as others
        // are removed — an index in the key would remount every later one.
        <View key={photo.previewUri} style={styles.item}>
          {/* A local file, not our media host — a plain Image is right;
              AuthedImage would attach a pointless header. */}
          <Image source={{ uri: photo.previewUri }} style={styles.thumb} />
          <Pressable
            onPress={() => onRemove(index)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Remove photo"
            style={styles.remove}
          >
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        </View>
      ))}
      {Array.from({ length: preparingCount }, (_, i) => (
        <View
          key={`preparing-${i}`}
          style={[styles.item, styles.preparing]}
          accessibilityLabel="Preparing photo"
        >
          <ActivityIndicator color={colors.accent} />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { marginBottom: spacing.sm - 6, flexGrow: 0 },
  content: { paddingTop: 6, paddingRight: 6, gap: spacing.sm },
  item: { width: 72, height: 72 },
  thumb: { width: 72, height: 72, borderRadius: radius.md },
  preparing: {
    borderRadius: radius.md,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Overlapping the thumbnail's top-right corner, the way a removable chip is
  // dismissed everywhere else in the app (see the compose box's photo strip).
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: {
    color: '#ffffff',
    fontSize: fontSize.sm - 2,
    lineHeight: 14,
  },
});
