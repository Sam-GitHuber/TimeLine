/**
 * Intercept Android's hardware/gesture **back** while some in-screen state is
 * open (Phase 10).
 *
 * iOS has no back button, so every dismissible thing in the app was built with
 * only an on-screen affordance to close it. On Android, back is the way people
 * dismiss things — and when nothing claims the press it falls through to the
 * navigator, which *leaves the screen entirely*. The failure is quiet and
 * feels like a bug in the app rather than a missing handler: you tap back to
 * clear a selection and find yourself two screens away with the selection
 * still armed underneath.
 *
 * `<Modal>` doesn't need this — RN routes back to its `onRequestClose`, and
 * every modal in the app already wires one. This is for the state that *isn't*
 * a modal: message multi-select being the case that prompted it.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler, Platform } from 'react-native';

/**
 * While `active` **and** the screen is focused, run `onBack` instead of letting
 * the press navigate.
 *
 * Scoped to focus deliberately: a screen left mounted but pushed behind another
 * would otherwise keep swallowing back presses meant for the screen on top —
 * the one bug this hook could plausibly introduce, so it's designed out rather
 * than left to each caller to remember.
 *
 * A no-op on iOS. `BackHandler` exists there but never fires, so guarding is
 * about saying what we mean rather than avoiding a crash.
 *
 * @param active whether the state this guards is currently open
 * @param onBack what to do instead of navigating — usually "close that state"
 */
export function useAndroidBack(active: boolean, onBack: () => void): void {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !active) return;

      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          onBack();
          // `true` = handled, stop here. Returning false (or nothing) would run
          // our handler *and* navigate away, which is worse than not handling
          // it at all — the state closes and the screen disappears.
          return true;
        }
      );
      return () => subscription.remove();
    }, [active, onBack])
  );
}
