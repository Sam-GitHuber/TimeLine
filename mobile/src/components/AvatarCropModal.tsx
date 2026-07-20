/**
 * Reframe an avatar before it's uploaded — the native counterpart of the web's
 * `AvatarCropModal` (issue #18).
 *
 * Shows the chosen photo under a **round** cutout that dims everything outside
 * it, so people frame for the circle the avatar is actually shown in, not a
 * square. Pinch to zoom, drag to recentre; "Use photo" exports just the framed
 * square as a fresh JPEG (the `Avatar` component then masks it to the circle,
 * exactly as on the web).
 *
 * **Why a custom cropper and not the OS "Move and Scale".** The iOS picker's
 * `allowsEditing` crop supports pinch/pan but only ever shows a *square* guide —
 * you can't see the circle you're framing for. Matching the web's round preview
 * is the whole point, and the gesture libraries it needs
 * (`react-native-gesture-handler` + `react-native-reanimated`) were already in
 * the app; only `expo-image-manipulator` (bundled in Expo Go) was added.
 *
 * The crop maths lives in `avatarCrop.ts`, pure and unit-tested; this file owns
 * only the gestures and the native crop, which Jest can't exercise.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Image } from 'expo-image';
import { useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import type { PhotoUpload } from '@/api';
import { computeCropRect, coverScale } from '@/avatarCrop';
import { colors, fontSize, spacing } from '@/theme';

/** The exported avatar's pixel size — plenty for a thumbnail, small to upload. */
const OUTPUT = 512;
const MAX_ZOOM = 5;

type CropPhoto = { uri: string; width: number; height: number };

export function AvatarCropModal({
  photo,
  onCropped,
  onCancel,
}: {
  photo: CropPhoto;
  onCropped: (upload: PhotoUpload) => void;
  onCancel: () => void;
}) {
  // The crop window is a square as wide as the screen (less a margin); the round
  // guide is inscribed in it.
  const crop = Math.min(Dimensions.get('window').width - spacing.xl, 360);
  const fitScale = coverScale(photo.width, photo.height, crop);
  // The photo at rest, cover-fitted; the gesture transform scales/pans from here.
  const baseWidth = photo.width * fitScale;
  const baseHeight = photo.height * fitScale;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const [working, setWorking] = useState(false);

  // Clamp helpers, kept as **self-contained worklets**: the gesture callbacks
  // below run on the UI thread, and a worklet may not call an ordinary JS
  // function there (doing so crashes the app the instant a gesture starts). So
  // the pan-clamp maths from `avatarCrop.ts` is inlined here rather than called
  // across the bridge; `avatarCrop.ts` keeps the same logic (unit-tested, and
  // used by the JS-thread crop below) as the single source of truth to mirror.
  const clampX = (value: number) => {
    'worklet';
    const max = Math.max(0, (photo.width * fitScale * scale.value - crop) / 2);
    return Math.min(max, Math.max(-max, value));
  };
  const clampY = (value: number) => {
    'worklet';
    const max = Math.max(0, (photo.height * fitScale * scale.value - crop) / 2);
    return Math.min(max, Math.max(-max, value));
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      const next = Math.min(MAX_ZOOM, Math.max(1, savedScale.value * event.scale));
      scale.value = next;
      // Zooming out can leave the photo short of covering the window — pull the
      // pan back in step so a gap never opens under the circle.
      translateX.value = clampX(translateX.value);
      translateY.value = clampY(translateY.value);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      translateX.value = clampX(savedX.value + event.translationX);
      translateY.value = clampY(savedY.value + event.translationY);
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  const gesture = Gesture.Simultaneous(pinch, pan);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  async function usePhoto() {
    if (working) return;
    setWorking(true);
    try {
      const rect = computeCropRect({
        imageWidth: photo.width,
        imageHeight: photo.height,
        crop,
        fitScale,
        scale: scale.value,
        translateX: translateX.value,
        translateY: translateY.value,
      });
      const context = ImageManipulator.manipulate(photo.uri);
      context.crop(rect);
      context.resize({ width: OUTPUT, height: OUTPUT });
      const rendered = await context.renderAsync();
      const result = await rendered.saveAsync({
        compress: 0.9,
        format: SaveFormat.JPEG,
      });
      onCropped({
        uri: result.uri,
        name: `avatar-${Date.now()}.jpg`,
        type: 'image/jpeg',
      });
    } catch {
      // Cropping failed (an undecodable file, a native hiccup). Close back to
      // the editor rather than trapping the user in a broken sheet; they can
      // pick again. The editor still has whatever avatar it had before.
      onCancel();
    } finally {
      setWorking(false);
    }
  }

  const radius = crop / 2;

  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      {/* Gestures inside an RN Modal need their own root — the modal renders in
          a separate native view tree that the app-root provider doesn't reach. */}
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.backdrop}>
          <Text style={styles.title}>Reframe your photo</Text>

          <GestureDetector gesture={gesture}>
            <View style={[styles.window, { width: crop, height: crop }]}>
              <Animated.View style={imageStyle}>
                <Image
                  source={{ uri: photo.uri }}
                  style={{ width: baseWidth, height: baseHeight }}
                  contentFit="fill"
                />
              </Animated.View>

              {/* Round cutout: one even-odd path dims the square's corners, a
                  circle draws the guide ring. Non-interactive so it never eats a
                  drag. */}
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <Svg width={crop} height={crop}>
                  <Path
                    d={`M0,0 H${crop} V${crop} H0 Z M${radius},0 A${radius},${radius} 0 1,0 ${radius},${crop} A${radius},${radius} 0 1,0 ${radius},0 Z`}
                    fill="rgba(0,0,0,0.55)"
                    fillRule="evenodd"
                  />
                  <Circle
                    cx={radius}
                    cy={radius}
                    r={radius - 1}
                    stroke="rgba(255,255,255,0.9)"
                    strokeWidth={2}
                    fill="none"
                  />
                </Svg>
              </View>
            </View>
          </GestureDetector>

          <Text style={styles.hint}>Pinch to zoom · drag to recentre</Text>

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              disabled={working}
              style={styles.ghostButton}
            >
              <Text style={styles.ghostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={usePhoto}
              accessibilityRole="button"
              disabled={working}
              style={[styles.useButton, working && styles.useDisabled]}
            >
              {working ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.useLabel}>Use photo</Text>
              )}
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,18,15,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: '#ffffff' },
  window: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  hint: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.7)' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ghostButton: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  ghostLabel: { fontSize: fontSize.base, fontWeight: '600', color: '#ffffff' },
  useButton: {
    minWidth: 120,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  useDisabled: { opacity: 0.6 },
  useLabel: { fontSize: fontSize.base, fontWeight: '700', color: '#ffffff' },
});
