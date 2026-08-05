/**
 * Full-screen photo viewer for a post's images.
 *
 * The mobile counterpart to the web's `Lightbox.jsx`, and deliberately the same
 * idea: open at the photo you tapped, flip between the rest, close with the ×.
 * What differs is the gesture — the web has arrow buttons and ← / → keys, which
 * mean nothing on a phone, so here you swipe.
 *
 * **Why the feed can't just show photos big.** A post may carry up to ten of
 * them (see feed-and-posts.md), and a full-width photo each is an enormous
 * amount of scrolling for one entry — it buries the rest of the timeline. So the
 * feed shows a compact grid of thumbnails and this screen is where a photo is
 * actually *looked at*: the grid is navigation, the lightbox is viewing.
 *
 * It loads `image` (the full-size upload) rather than the `thumbnail` the grid
 * uses, matching the web. Worth knowing that's a real download on cellular —
 * acceptable because it only happens when someone deliberately opens a photo.
 */

import { useState } from 'react';
import {
  FlatList,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { AuthedImage } from './AuthedImage';
import type { EventPhoto, PostImage } from '@/types';
import { fontSize, radius, spacing } from '@/theme';

/**
 * What the viewer can show. A post's image and an event's album photo are the
 * same shape as far as this screen is concerned — the album adds an uploader
 * and a `can_delete`, which reach it through the two callbacks below rather
 * than by this component learning what an event is.
 */
export type LightboxPhoto = PostImage | EventPhoto;

/** Circular hit target for the close button — Apple's 44pt minimum. */
const CLOSE_SIZE = 44;

export function PhotoLightbox({
  images,
  /** Which photo to open on — the one that was tapped. */
  initialIndex,
  onClose,
  captionFor,
  onDelete,
  canDelete,
}: {
  images: LightboxPhoto[];
  initialIndex: number;
  onClose: () => void;
  /**
   * A line under the photo — used by an event's album, where each photo has an
   * author of its own (a post's images inherit the post's, already named above
   * the grid). Given the *current* photo, so it follows the swipe.
   */
  captionFor?: (image: LightboxPhoto) => string | null;
  /**
   * Remove the photo on screen. Paired with `canDelete` rather than folded into
   * it: an album is mixed (your photos beside other people's), so whether to
   * *draw* the button is a question that has to be answerable without pressing
   * it.
   */
  onDelete?: (image: LightboxPhoto) => void;
  /** Whether this viewer may remove the photo on screen. */
  canDelete?: (image: LightboxPhoto) => boolean;
}) {
  return (
    <Modal
      visible
      // Fade rather than the default slide-up: a photo viewer isn't a sheet you
      // pushed onto a stack, it's the same photo growing to fill the screen.
      animationType="fade"
      // Android's back button must close it, or the only way out is the ×.
      onRequestClose={onClose}
      // Cover the status bar too — a black viewer with a strip of app chrome
      // above it doesn't read as full screen.
      statusBarTranslucent
    >
      {/*
        A `SafeAreaProvider` of its own, nested inside the Modal.
        React Native renders a Modal in a separate native view hierarchy, so it
        sits outside any provider mounted around the app — the documented fix is
        exactly this nesting. It also makes the component self-sufficient: no
        screen has to remember to wrap itself for the viewer's chrome to clear
        the notch and the home indicator.
      */}
      <SafeAreaProvider>
        <Pager
          images={images}
          initialIndex={initialIndex}
          onClose={onClose}
          captionFor={captionFor}
          onDelete={onDelete}
          canDelete={canDelete}
        />
      </SafeAreaProvider>
    </Modal>
  );
}

/**
 * Split out from `PhotoLightbox` purely so it can call `useSafeAreaInsets` —
 * the hook has to run *below* the provider, not alongside it.
 */
function Pager({
  images,
  initialIndex,
  onClose,
  captionFor,
  onDelete,
  canDelete,
}: {
  images: LightboxPhoto[];
  initialIndex: number;
  onClose: () => void;
  captionFor?: (image: LightboxPhoto) => string | null;
  onDelete?: (image: LightboxPhoto) => void;
  canDelete?: (image: LightboxPhoto) => boolean;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(initialIndex);

  const count = images.length;
  const current = images[index];
  const caption = current && captionFor ? captionFor(current) : null;

  // Which photo you've landed on, read off the scroll offset once the swipe has
  // settled. `onMomentumScrollEnd` rather than `onScroll` so the counter changes
  // when you arrive, not while a drag is still in flight and could be reversed.
  function handleSettled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  }

  return (
    <View style={styles.backdrop}>
      <FlatList
        // Remounting on a width change (rotation) re-runs `initialScrollIndex`
        // with the photo you're currently on. Without it the list keeps its old
        // pixel offset, which after a rotation lands between two photos.
        key={width}
        data={images}
        keyExtractor={(image) => String(image.id)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={index}
        onMomentumScrollEnd={handleSettled}
        // Every page is exactly the screen's width, so the list can be told its
        // layout instead of measuring — which is what lets `initialScrollIndex`
        // jump straight to the tapped photo rather than scrolling from the start.
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item, index: i }) => (
          <View style={[styles.page, { width, height }]}>
            {/* `AuthedImage` because /media/ is behind forward_auth in
                production — it attaches the bearer header (scoped to our host)
                so the full-size photo isn't a blank 401 box. It loads `image`,
                not the grid's `thumbnail`, matching the web. */}
            <AuthedImage
              uri={item.image}
              style={styles.photo}
              // `contain`, not `cover`: the point of opening a photo is to see
              // all of it, so letterboxing beats cropping here.
              contentFit="contain"
              transition={150}
              accessibilityLabel={`Photo ${i + 1} of ${count}`}
            />
          </View>
        )}
      />

      {/* Chrome sits above the pager, so a swipe anywhere on the photo still
          pages — only the buttons themselves take a touch. */}
      <SafeAreaView style={styles.chrome} pointerEvents="box-none" edges={['top', 'bottom']}>
        <View style={styles.chromeRow}>
          {current && onDelete && canDelete?.(current) ? (
            <Pressable
              onPress={() => onDelete(current)}
              style={({ pressed }) => [styles.close, pressed && styles.deletePressed]}
              accessibilityRole="button"
              accessibilityLabel="Remove this photo"
              hitSlop={8}
            >
              <Text style={styles.deleteText}>Remove</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            accessibilityRole="button"
            accessibilityLabel="Close photo viewer"
            hitSlop={8}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      {/* Who took it, and where you are in the set — one pill, so a single
          captioned photo still has somewhere to put its line and an album gets
          both without stacking two floating chips. */}
      {caption || count > 1 ? (
        <View
          style={[styles.counter, { bottom: insets.bottom + spacing.lg }]}
          pointerEvents="none"
        >
          <Text style={styles.counterText} numberOfLines={1}>
            {caption ? caption : ''}
            {caption && count > 1 ? ' · ' : ''}
            {count > 1 ? `${index + 1} / ${count}` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Not the app's warm surface: a photo should be judged against neutral black,
  // and the viewer is meant to feel like stepping out of the app for a moment.
  backdrop: { flex: 1, backgroundColor: '#000' },
  page: { alignItems: 'center', justifyContent: 'center' },
  photo: { width: '100%', height: '100%' },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'flex-end',
    padding: spacing.sm,
  },
  chromeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  close: {
    minWidth: CLOSE_SIZE,
    height: CLOSE_SIZE,
    borderRadius: CLOSE_SIZE / 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    // A translucent white disc rather than a bare glyph: over a photo, a plain
    // × disappears against anything pale.
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  closePressed: { backgroundColor: 'rgba(255,255,255,0.3)' },
  closeText: { color: '#fff', fontSize: 26, lineHeight: 30, fontWeight: '300' },
  // Worded rather than an icon, and not tinted red until pressed: a destructive
  // control sitting over someone's photos shouldn't shout, but it must be
  // unmistakable about what it does before it's tapped.
  deletePressed: { backgroundColor: 'rgba(220,38,38,0.75)' },
  deleteText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  counterText: {
    color: '#fff',
    fontSize: fontSize.sm,
    // Tabular figures so "1 / 10" doesn't shuffle sideways as you swipe.
    fontVariant: ['tabular-nums'],
  },
});
