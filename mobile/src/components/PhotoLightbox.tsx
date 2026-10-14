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
 *
 * **Zoom, save and share (#396)** — the three things every messenger's viewer
 * does. Pinch or double-tap to zoom; the pager swipes only at 1×, and a zoomed
 * photo pans instead, so the two drags never compete for one touch. Save and
 * Share sit top-left on every photo this viewer shows (chat, post or album) —
 * see `photoActions.ts` for how, and for what saving means for privacy.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Linking,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type {
  PanGestureHandlerGestureEvent,
  PanGestureHandlerStateChangeEvent,
  PinchGestureHandlerGestureEvent,
  PinchGestureHandlerStateChangeEvent,
  TapGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {
  GestureHandlerRootView,
  PanGestureHandler,
  PinchGestureHandler,
  State,
  TapGestureHandler,
} from 'react-native-gesture-handler';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { AuthedImage } from './AuthedImage';
import { savePhoto, sharePhoto } from '@/photoActions';
import {
  AT_REST,
  doubleTapZoom,
  fittedSize,
  isZoomed,
  panZoom,
  pinchZoom,
  settleZoom,
  type Size,
  type Zoom,
} from '@/photoZoom';
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
        {/* And a gesture root of its own, for the same reason: the zoom's
            handlers need one above them, and the app's never reaches into a
            Modal (`AvatarCropModal` does the same). */}
        <GestureHandlerRootView style={styles.root}>
          <Pager
            images={images}
            initialIndex={initialIndex}
            onClose={onClose}
            captionFor={captionFor}
            onDelete={onDelete}
            canDelete={canDelete}
          />
        </GestureHandlerRootView>
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
  const list = useRef<FlatList<LightboxPhoto>>(null);
  /**
   * Which page is zoomed in, as `width:id`, or `null`. While one is, **the
   * pager doesn't scroll** — a one-finger drag pans the photo instead — so you
   * can't page away from a zoomed photo; zoom back out (pinch, or double-tap)
   * to swipe on. Only one page can be zoomed for the same reason.
   *
   * **A key, not a boolean, and `zoomed` is derived from it** — because a
   * zoomed page can go away without zooming out: Remove takes it out of
   * `images`, and a rotation remounts every page at 1× (`key={width}` below).
   * A flag only the page itself can clear would stay `true` after either, and
   * the pager would stay locked with nothing on screen zoomed. Derived, it's
   * simply no longer true once that page isn't there.
   */
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);
  const zoomed = images.some((image) => `${width}:${image.id}` === zoomedKey);
  /**
   * What Save or Share is doing, and **for which photo** — so a "Saved" (or a
   * spinner) stays with the photo it's about rather than following a swipe to
   * the next one. `busy` is still viewer-wide: one download at a time.
   */
  const [action, setAction] = useState<{
    kind: 'saving' | 'sharing' | 'saved';
    id: number;
  } | null>(null);

  // "Saved" is a confirmation, not a state to leave on screen: it reverts to
  // the plain button after a moment. The cleanup covers closing the viewer (or
  // saving again) before the moment's up.
  useEffect(() => {
    if (action?.kind !== 'saved') return;
    const timer = setTimeout(() => setAction(null), 2000);
    return () => clearTimeout(timer);
  }, [action]);

  // A pinch that starts at 1× can be half-taken by the pager's own scroll —
  // nothing coordinates a native scroll view with a gesture-handler pinch —
  // which would leave the list stopped between two photos once the lock lands.
  // So the moment a page zooms, put the list square on the page you're on.
  useEffect(() => {
    if (zoomed) list.current?.scrollToOffset({ offset: index * width, animated: true });
  }, [zoomed, index, width]);

  const count = images.length;
  const current = images[index];
  const caption = current && captionFor ? captionFor(current) : null;
  const shown = action && current && action.id === current.id ? action.kind : null;
  const busy = action?.kind === 'saving' || action?.kind === 'sharing';

  // Which photo you've landed on, read off the scroll offset once the swipe has
  // settled. `onMomentumScrollEnd` rather than `onScroll` so the counter changes
  // when you arrive, not while a drag is still in flight and could be reversed.
  function handleSettled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  }

  async function save() {
    if (!current || busy) return;
    const { id } = current;
    setAction({ kind: 'saving', id });
    try {
      const outcome = await savePhoto(current.image);
      if (outcome === 'declined') {
        // They've just answered the OS's own prompt — nothing to add.
        setAction(null);
        return;
      }
      if (outcome === 'blocked') {
        setAction(null);
        // Refused before, so the OS won't ask again — Settings is the only way
        // back, so offer it rather than a button that silently does nothing.
        Alert.alert(
          'Allow TimeLine to add photos',
          'To save photos, turn on photo access for TimeLine in Settings.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ]
        );
        return;
      }
      setAction({ kind: 'saved', id });
    } catch {
      setAction(null);
      Alert.alert('Couldn’t save', 'Check your connection and try again.');
    }
  }

  async function share() {
    if (!current || busy) return;
    setAction({ kind: 'sharing', id: current.id });
    try {
      await sharePhoto(current.image);
    } catch {
      Alert.alert('Couldn’t share', 'Check your connection and try again.');
    } finally {
      setAction(null);
    }
  }

  return (
    <View style={styles.backdrop}>
      <FlatList
        ref={list}
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
        scrollEnabled={!zoomed}
        testID="photo-pager"
        // Every page is exactly the screen's width, so the list can be told its
        // layout instead of measuring — which is what lets `initialScrollIndex`
        // jump straight to the tapped photo rather than scrolling from the start.
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item, index: i }) => (
          <ZoomablePhoto
            photo={item}
            page={{ width, height }}
            label={`Photo ${i + 1} of ${count}`}
            onZoomChange={(now) => setZoomedKey(now ? `${width}:${item.id}` : null)}
          />
        )}
      />

      {/* Chrome sits above the pager, so a swipe anywhere on the photo still
          pages — only the buttons themselves take a touch. */}
      <SafeAreaView style={styles.chrome} pointerEvents="box-none" edges={['top', 'bottom']}>
        <View style={styles.chromeRow}>
          <Pressable
            onPress={save}
            disabled={busy}
            style={({ pressed }) => [styles.chip, styles.worded, pressed && styles.closePressed]}
            accessibilityRole="button"
            accessibilityLabel="Save photo"
            accessibilityState={{ busy: shown === 'saving' }}
            hitSlop={8}
          >
            {shown === 'saving' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.chipText}>{shown === 'saved' ? 'Saved' : 'Save'}</Text>
            )}
          </Pressable>
          <Pressable
            onPress={share}
            disabled={busy}
            style={({ pressed }) => [styles.chip, styles.worded, pressed && styles.closePressed]}
            accessibilityRole="button"
            accessibilityLabel="Share photo"
            accessibilityState={{ busy: shown === 'sharing' }}
            hitSlop={8}
          >
            {shown === 'sharing' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.chipText}>Share</Text>
            )}
          </Pressable>
          {/* Pushes what follows to the right edge: keeping, top-left; the
              destructive Remove and the way out, top-right, where they were. */}
          <View style={styles.spacer} />
          {current && onDelete && canDelete?.(current) ? (
            <Pressable
              onPress={() => onDelete(current)}
              style={({ pressed }) => [
                styles.chip,
                styles.worded,
                pressed && styles.deletePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Remove this photo"
              hitSlop={8}
            >
              <Text style={styles.chipText}>Remove</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              styles.chip,
              styles.close,
              pressed && styles.closePressed,
            ]}
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
          {/* Three Texts, not one. **Only the name may be truncated** — sharing
              one `numberOfLines={1}` with the counter meant a long uploader
              name ellipsized "4 / 20" clean off the end, so the album's own
              photos were the ones that lost the count. `flexShrink` is what
              makes the name the part that gives. */}
          {caption ? (
            <Text
              style={[styles.counterText, styles.caption]}
              numberOfLines={1}
            >
              {caption}
            </Text>
          ) : null}
          {caption && count > 1 ? (
            <Text style={styles.counterText}> · </Text>
          ) : null}
          {count > 1 ? (
            <Text style={styles.counterText}>{`${index + 1} / ${count}`}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One page of the viewer: a photo you can pinch, pan and double-tap.
 *
 * **Why the legacy handlers and RN's own `Animated`**, not `Gesture.Pinch()`
 * and Reanimated like `AvatarCropModal`: this component is rendered by four
 * test suites (the thread, its info screen, posts and event albums), and
 * Reanimated's worklet runtime can't load under Jest — the same trade
 * `SwipeToReply` documents. The crop modal can be mocked out wholesale; this
 * can't without blanking every screen that opens a photo. The maths lives in
 * `photoZoom.ts`, pure and unit-tested.
 *
 * Three handlers, nested because each needs a view of its own:
 *
 * - **Double tap** on the outside: zoom to where you tapped, or back out.
 * - **Pinch**, simultaneous with the pan, so moving both fingers while pinching
 *   drags the photo too.
 * - **Pan**, `enabled` only while zoomed and one-fingered. At 1× it's switched
 *   off entirely, which is what leaves a horizontal swipe to the pager.
 *
 * `useNativeDriver: false` throughout: the drag is a JS callback writing
 * `setValue` every frame, and handing the same values to the native driver for
 * the snap-back is the mixed ownership Animated warns about. One photo, one
 * transform — the JS driver isn't a visible cost here.
 */
function ZoomablePhoto({
  photo,
  page,
  label,
  onZoomChange,
}: {
  photo: LightboxPhoto;
  page: Size;
  label: string;
  onZoomChange: (zoomed: boolean) => void;
}) {
  const fitted = fittedSize(page, photo);
  // Lazy `useState`, not `useRef(new Animated.Value()).current` — the React
  // Compiler fails a ref read during render (see `SwipeToReply`).
  const [scale] = useState(() => new Animated.Value(1));
  const [x] = useState(() => new Animated.Value(0));
  const [y] = useState(() => new Animated.Value(0));
  const [zoomed, setZoomed] = useState(false);
  /** Where the photo is right now — what any gesture starts from. */
  const live = useRef<Zoom>(AT_REST);
  /**
   * The pinch in progress, or `null`: where the photo was when it took over,
   * where the fingers were, and **the scale the pinch already read** — a pinch
   * only activates after the fingers have moved, so its first `scale` is
   * already ~1.05, and multiplying by it raw makes the photo jump the moment
   * the pinch takes over.
   */
  const pinch = useRef<{ from: Zoom; focal: { x: number; y: number }; scale: number } | null>(
    null
  );
  /**
   * The pan's anchor: where the photo was, and how far the finger had already
   * travelled, when this stretch of panning began. `null` means "anchor on the
   * next event" — reset whenever a pinch starts or ends, because the two run
   * simultaneously and each must measure from where the *other* left the
   * photo. Anchoring both on one shared resting point counted a drag twice the
   * moment a second finger landed.
   */
  const pan = useRef<{ from: Zoom; dx: number; dy: number } | null>(null);
  const pinchRef = useRef<PinchGestureHandler>(null);
  const panRef = useRef<PanGestureHandler>(null);

  /** A gesture point, moved from the handler view's corner to its centre. */
  const centred = (px: number, py: number) => ({
    x: px - page.width / 2,
    y: py - page.height / 2,
  });

  function show(zoom: Zoom) {
    live.current = zoom;
    scale.setValue(zoom.scale);
    x.setValue(zoom.x);
    y.setValue(zoom.y);
  }

  /** Land on `zoom` — animated, for a double tap or a snap home. */
  function settle(target: Zoom, animate: boolean) {
    const zoom = settleZoom(target);
    live.current = zoom;
    if (animate) {
      Animated.parallel(
        [
          Animated.timing(scale, { toValue: zoom.scale, duration: 220, useNativeDriver: false }),
          Animated.timing(x, { toValue: zoom.x, duration: 220, useNativeDriver: false }),
          Animated.timing(y, { toValue: zoom.y, duration: 220, useNativeDriver: false }),
        ]
      ).start();
    } else {
      show(zoom);
    }
    const now = isZoomed(zoom);
    setZoomed(now);
    onZoomChange(now);
  }

  function handlePinchState({ nativeEvent }: PinchGestureHandlerStateChangeEvent) {
    if (nativeEvent.state === State.ACTIVE) {
      // Start from where the photo is *now*, which may be mid-pan.
      pinch.current = {
        from: live.current,
        focal: centred(nativeEvent.focalX, nativeEvent.focalY),
        scale: nativeEvent.scale || 1,
      };
      pan.current = null;
      // Lock the pager now, not when the pinch ends: a pinch from 1× must not
      // also be a swipe (the Pager squares the list up as it locks).
      onZoomChange(true);
      return;
    }
    if (nativeEvent.oldState === State.ACTIVE) {
      pinch.current = null;
      pan.current = null;
      // A pinch that ends near 1× snaps home, animated, so letting go a hair
      // off fit doesn't leave the pager locked (see `isZoomed`).
      settle(live.current, !isZoomed(live.current));
    }
  }

  function handlePinch({ nativeEvent }: PinchGestureHandlerGestureEvent) {
    const start = pinch.current;
    if (nativeEvent.state !== State.ACTIVE || !start) return;
    show(
      pinchZoom({
        from: start.from,
        startFocal: start.focal,
        focal: centred(nativeEvent.focalX, nativeEvent.focalY),
        factor: nativeEvent.scale / start.scale,
        page,
        fitted,
      })
    );
  }

  function handlePanState({ nativeEvent }: PanGestureHandlerStateChangeEvent) {
    if (nativeEvent.state === State.ACTIVE) {
      pan.current = null;
      return;
    }
    if (nativeEvent.oldState === State.ACTIVE) {
      pan.current = null;
      // Mid-pinch, the pinch's own end does the settling.
      if (!pinch.current) settle(live.current, false);
    }
  }

  function handlePan({ nativeEvent }: PanGestureHandlerGestureEvent) {
    // While a pinch is live it moves the photo with the fingers itself (see
    // `pinchZoom`), so a pan writing too would fight it frame by frame.
    if (nativeEvent.state !== State.ACTIVE || pinch.current) return;
    if (!pan.current) {
      pan.current = { from: live.current, dx: nativeEvent.translationX, dy: nativeEvent.translationY };
      return;
    }
    const anchor = pan.current;
    show(
      panZoom(
        anchor.from,
        nativeEvent.translationX - anchor.dx,
        nativeEvent.translationY - anchor.dy,
        page,
        fitted
      )
    );
  }

  function handleDoubleTap({ nativeEvent }: TapGestureHandlerStateChangeEvent) {
    if (nativeEvent.state !== State.ACTIVE) return;
    settle(doubleTapZoom(live.current, centred(nativeEvent.x, nativeEvent.y), page, fitted), true);
  }

  return (
    <TapGestureHandler numberOfTaps={2} onHandlerStateChange={handleDoubleTap}>
      {/* The testIDs are where a test posts each handler's events — a pinch
          has no accessible name to query by (see `photos.test.tsx`). */}
      <Animated.View testID="photo-double-tap" style={[styles.page, page]}>
        <PinchGestureHandler
          ref={pinchRef}
          simultaneousHandlers={panRef}
          onGestureEvent={handlePinch}
          onHandlerStateChange={handlePinchState}
        >
          <Animated.View testID="photo-pinch" style={styles.fill}>
            <PanGestureHandler
              ref={panRef}
              simultaneousHandlers={pinchRef}
              enabled={zoomed}
              maxPointers={1}
              onGestureEvent={handlePan}
              onHandlerStateChange={handlePanState}
            >
              <Animated.View
                testID="photo-pan"
                style={[
                  styles.fill,
                  // Translate, *then* scale about the centre — the order
                  // `photoZoom.ts` is written against.
                  { transform: [{ translateX: x }, { translateY: y }, { scale }] },
                ]}
              >
                {/* `AuthedImage` because /media/ is behind forward_auth in
                    production — it attaches the bearer header (scoped to our
                    host) so the full-size photo isn't a blank 401 box. It
                    loads `image`, not the grid's `thumbnail`, matching the
                    web. */}
                <AuthedImage
                  uri={photo.image}
                  // Drawn at its fitted size rather than filling the page, so
                  // the view being scaled *is* the photo — no letterbox bars
                  // grow with it — and the pan limits are the photo's edges.
                  style={fitted}
                  // `contain`, not `cover`: the point of opening a photo is to
                  // see all of it, so letterboxing beats cropping here.
                  contentFit="contain"
                  transition={150}
                  accessibilityLabel={label}
                />
              </Animated.View>
            </PanGestureHandler>
          </Animated.View>
        </PinchGestureHandler>
      </Animated.View>
    </TapGestureHandler>
  );
}

const styles = StyleSheet.create({
  // Not the app's warm surface: a photo should be judged against neutral black,
  // and the viewer is meant to feel like stepping out of the app for a moment.
  backdrop: { flex: 1, backgroundColor: '#000' },
  root: { flex: 1 },
  // Clips a zoomed photo to its own page, so its overflow can't paint over the
  // next one's while the pager is still mid-swipe.
  page: { overflow: 'hidden' },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.sm,
  },
  chromeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spacer: { flex: 1 },
  // What the two chrome buttons share. **Deliberately carries no width**, so
  // the round one and the worded one can each say what they need: the × is a
  // circle, and a `minWidth` + padding on *that* ovalised it to ~48pt across on
  // every screen this viewer serves, not just the album.
  chip: {
    height: CLOSE_SIZE,
    borderRadius: CLOSE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // A translucent white disc rather than a bare glyph: over a photo, a plain
    // × disappears against anything pale.
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  // Square, so the radius draws a circle — Apple's 44pt minimum, exactly.
  close: { width: CLOSE_SIZE },
  // A word (Save, Share, Remove), so it takes the width the word needs and
  // keeps 44pt of height.
  worded: { minWidth: CLOSE_SIZE, paddingHorizontal: spacing.md },
  closePressed: { backgroundColor: 'rgba(255,255,255,0.3)' },
  closeText: { color: '#fff', fontSize: 26, lineHeight: 30, fontWeight: '300' },
  // Worded rather than an icon, and not tinted red until pressed: a destructive
  // control sitting over someone's photos shouldn't shout, but it must be
  // unmistakable about what it does before it's tapped.
  deletePressed: { backgroundColor: 'rgba(220,38,38,0.75)' },
  chipText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    // So the pill can't run off both edges of the screen when the name is long
    // — it shrinks the name instead (see `caption`).
    maxWidth: '90%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  // The only part of the pill allowed to give: the counter is four characters
  // and always worth more than the tail of a name.
  caption: { flexShrink: 1 },
  counterText: {
    color: '#fff',
    fontSize: fontSize.sm,
    // Tabular figures so "1 / 10" doesn't shuffle sideways as you swipe.
    fontVariant: ['tabular-nums'],
  },
});
