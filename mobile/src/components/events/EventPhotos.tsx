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
 *
 * **This is the whole album, and the only place it is.** A timeline entry's
 * grid is a preview of four that sends you here for the rest; the paging below
 * is what "the rest" means.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { PhotoGrid } from '../PhotoGrid';
import { PhotoLightbox, type LightboxPhoto } from '../PhotoLightbox';
import { api, serverMessage, type PhotoUpload } from '@/api';
import { usePhotoPicker } from '@/photoSource';
import { colors, fontSize, spacing } from '@/theme';
import type { EventPhoto } from '@/types';

/**
 * How many photos one **pick** may hand over, matching the server's
 * `MAX_PHOTOS_PER_UPLOAD`. Left off, `selectionLimit` is undefined, which
 * expo-image-picker reads as "the system maximum" — i.e. no limit. Two things
 * then go wrong, and the second is the one that bites: the server rejects the
 * request only after buffering the whole body, and before it ever leaves the
 * phone `api.ts` holds one `Uint8Array` per asset *simultaneously*, so a
 * thirty-photo pick is thirty full-resolution images in memory at once. The
 * composer caps for exactly this reason (`ComposeBox`'s `MAX_PHOTOS`).
 *
 * The album's own ceiling (`MAX_PHOTOS_PER_EVENT` = 200) is a different number
 * and stays the server's to enforce — it's counted over the life of the event,
 * which no single pick can know.
 */
const MAX_PHOTOS_PER_UPLOAD = 10;

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

  // **Paged, and "load the rest" is a tap on the last tile** — this section
  // lives inside the event screen's scroll view, so a second scrollable (or an
  // `onEndReached`) would fight it. One page is 20 and an album holds up to 200,
  // so a single un-paged fetch drew twenty tiles beside a heading saying 47 and
  // gave you no way at all to reach the other twenty-seven.
  //
  // Follows `next` with `getPage`, the same contract the feed and every other
  // list on this client uses.
  const photosQuery = useInfiniteQuery({
    queryKey: ['eventPhotos', eventId],
    queryFn: ({ pageParam }) =>
      pageParam
        ? api.getPage<EventPhoto>(pageParam)
        : api.getEventPhotos(eventId),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
  });
  const photos: EventPhoto[] =
    photosQuery.data?.pages.flatMap((page) => page.results ?? []) ?? [];
  // `count` is the server's, off the first page: your slice of the album, which
  // is not `photos.length` until the last page is in.
  const total = photosQuery.data?.pages[0]?.count ?? photos.length;
  const unloaded = Math.max(total - photos.length, 0);

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
      selectionLimit: MAX_PHOTOS_PER_UPLOAD,
      quality: 0.9,
    });
    if (!assets) return;
    add.mutate(
      // Sliced as well as limited, the belt-and-braces `ComposeBox` uses:
      // `selectionLimit` is a request to the OS picker, and the one that comes
      // back is the array we're about to read into memory.
      assets.slice(0, MAX_PHOTOS_PER_UPLOAD).map((asset, i) => ({
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
      ) : photosQuery.isError && photos.length === 0 ? (
        // **Only this line, and not the empty state beside it.** A request that
        // failed is not an album with nothing in it, and saying both at once
        // told you the album was empty *and* that we couldn't tell — the first
        // of which the client has no way of knowing.
        <Text style={styles.error}>Couldn’t load the photos.</Text>
      ) : photos.length === 0 ? (
        // Carefully not "there are no photos": you're seeing your slice of the
        // album, so someone you aren't connected to may well have added some.
        // Reached only when the query *succeeded* and returned nothing.
        <Text style={styles.empty}>No photos here yet — add the first.</Text>
      ) : (
        <>
          <PhotoGrid
            images={photos}
            // Only when there really is another page: a "+N" that loads nothing
            // is a dead tile. Everything loaded ⇒ no overlay, and every photo
            // opens.
            total={photosQuery.hasNextPage ? total : undefined}
            onOpen={setLightboxIndex}
            onOverflow={() => void photosQuery.fetchNextPage()}
            overflowLabel={`Load ${unloaded} more photos`}
          />
          {photosQuery.isFetchingNextPage ? (
            <ActivityIndicator color={colors.accent} />
          ) : null}
          {photosQuery.isError ? (
            // A list that stopped short is indistinguishable from one that
            // ended, and here that silently under-states the album. Same
            // sentence as the web's, and deliberately not the one above: some
            // photos *did* load.
            <Text style={styles.error}>Couldn’t load all the photos.</Text>
          ) : null}
        </>
      )}

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
