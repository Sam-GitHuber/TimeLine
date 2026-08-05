/**
 * The event's photo album, on the event screen.
 *
 * **Anyone who can see the event can add to it**, before, during or after — the
 * one write in this feature that isn't the organiser's, because the photos from
 * a day out belong to whoever took them. And the phone is where they're taken,
 * which is why the picker offers the camera as well as the library.
 *
 * What you *see* is pruned to the uploaders you may see (the organiser plus
 * your connections), exactly like the event's comments and unlike the poll and
 * RSVP tallies above it. That's server-side, so this renders what arrives — but
 * it's why the count here can differ from what the person beside you sees, and
 * why the empty state doesn't claim the album is empty.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { PhotoGrid } from '../PhotoGrid';
import { PhotoLightbox, type LightboxPhoto } from '../PhotoLightbox';
import { api, serverMessage, type PhotoUpload } from '@/api';
import { usePhotoPicker } from '@/photoSource';
import { colors, fontSize, spacing } from '@/theme';
import type { EventPhoto } from '@/types';

export function EventPhotos({
  eventId,
  onChange,
}: {
  eventId: number;
  onChange: () => void;
}) {
  const queryClient = useQueryClient();
  const { pickPhotos, photoMenu } = usePhotoPicker();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // The first page only. The album is paginated server-side, and "load the
  // rest" is a tap on the last tile rather than a scroll here — this section
  // lives inside the event screen's scroll view, so a second scrollable would
  // fight it.
  const photosQuery = useQuery({
    queryKey: ['eventPhotos', eventId],
    queryFn: () => api.getEventPhotos(eventId),
  });
  const photos: EventPhoto[] = photosQuery.data?.results ?? [];
  const total = photosQuery.data?.count ?? photos.length;

  const add = useMutation({
    mutationFn: (uploads: PhotoUpload[]) => api.addEventPhotos(eventId, uploads),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['eventPhotos', eventId] });
      onChange();
    },
    // An `Alert` rather than an inline line, for the reason every refused write
    // on this screen uses one: it outlives whatever is on screen, and a phone's
    // network is the one that actually drops a request mid-tap.
    onError: (err) =>
      Alert.alert('Couldn’t add those photos', serverMessage(err, 'Please try again.')),
  });

  const remove = useMutation({
    mutationFn: (photoId: number) => api.deleteEventPhoto(photoId),
    onSuccess: () => {
      setLightboxIndex(null);
      queryClient.invalidateQueries({ queryKey: ['eventPhotos', eventId] });
      onChange();
    },
    onError: (err) =>
      Alert.alert('Couldn’t remove that photo', serverMessage(err, 'Please try again.')),
  });

  async function onAdd() {
    // Multi-select is library-only (the camera returns one shot) and the pick
    // is at `quality: 0.9` — the composer's settings, because an event photo is
    // uploaded as picked, so that's the one compression it gets.
    const assets = await pickPhotos('Add photos', {
      allowsMultipleSelection: true,
      quality: 0.9,
    });
    if (!assets) return;
    add.mutate(
      assets.map((asset, i) => ({
        uri: asset.uri,
        name: asset.fileName ?? `photo-${i}.jpg`,
        type: asset.mimeType ?? 'image/jpeg',
      }))
    );
  }

  function confirmRemove(photo: LightboxPhoto) {
    Alert.alert(
      'Remove this photo?',
      'It comes off the event for everyone who can see it. This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => remove.mutate(photo.id),
        },
      ]
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        {/* Two Texts rather than one with a nested span: they sit on the row's
            shared baseline, and the count stays independently addressable. */}
        <View style={styles.heading}>
          <Text style={styles.title}>Photos</Text>
          {photos.length > 0 ? <Text style={styles.count}>{total}</Text> : null}
        </View>
        <Pressable
          onPress={onAdd}
          disabled={add.isPending}
          accessibilityRole="button"
          accessibilityLabel="Add photos to this event"
          hitSlop={8}
        >
          <Text style={[styles.action, add.isPending && styles.actionBusy]}>
            {add.isPending ? 'Adding…' : 'Add photos'}
          </Text>
        </Pressable>
      </View>

      {photosQuery.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : photos.length === 0 ? (
        // Carefully not "there are no photos": you're seeing your slice of the
        // album, so someone you aren't connected to may well have added some.
        <Text style={styles.empty}>No photos here yet — add the first.</Text>
      ) : (
        <PhotoGrid images={photos} onOpen={setLightboxIndex} />
      )}

      {photosQuery.isError ? (
        <Text style={styles.error}>Couldn’t load the photos.</Text>
      ) : null}

      {lightboxIndex !== null && photos[lightboxIndex] ? (
        <PhotoLightbox
          images={photos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          captionFor={(photo) =>
            'uploader' in photo ? photo.uploader.display_name : null
          }
          canDelete={(photo) => 'can_delete' in photo && photo.can_delete}
          onDelete={confirmRemove}
        />
      ) : null}

      {photoMenu}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  heading: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  title: { fontSize: fontSize.base, fontWeight: '700', color: colors.ink },
  count: {
    fontSize: fontSize.sm,
    color: colors.inkFaint,
    fontVariant: ['tabular-nums'],
  },
  action: { fontSize: fontSize.sm, fontWeight: '600', color: colors.accent },
  actionBusy: { color: colors.inkFaint },
  empty: { fontSize: fontSize.sm, color: colors.inkFaint },
  error: { fontSize: fontSize.sm, color: colors.danger },
});
