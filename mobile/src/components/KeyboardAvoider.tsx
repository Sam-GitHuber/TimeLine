/**
 * The one place the app decides how a screen gets out of the keyboard's way.
 *
 * ## Why this exists rather than React Native's `KeyboardAvoidingView`
 *
 * Every screen in the app used to write
 * `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` — deliberately
 * inert on Android, because Android resized the window for us. The manifest
 * still asks for that (`android:windowSoftInputMode="adjustResize"`), and for
 * years it was the correct default.
 *
 * It stopped being correct. Expo SDK 54+ turns on **edge-to-edge** on Android,
 * and Android 15 (API 35) makes it mandatory — our generated
 * `android/gradle.properties` carries `edgeToEdgeEnabled=true`. Under
 * edge-to-edge the window is **no longer resized** when the IME opens; the app
 * is expected to read `WindowInsets.ime()` and make room itself. Nothing did, so
 * the keyboard drew straight over whatever sat at the bottom of the screen —
 * which in a messenger is the compose box. A real tester hit it on their own
 * phone the first day they had an Android build.
 *
 * React Native's own `KeyboardAvoidingView` can't be talked into fixing it
 * either, and it's worth knowing why before anyone tries. RN 0.86 *does* report
 * a correct keyboard **height** on Android (`ReactRootView` derives it from
 * `WindowInsets.ime()`), but `KeyboardAvoidingView` doesn't use the height — it
 * positions itself from `endCoordinates.screenY`, which still comes from the
 * resize-era `getWindowVisibleDisplayFrame()`. So switching `behavior` to
 * `'padding'` on Android buys a number that assumes the very window resize
 * edge-to-edge just took away.
 *
 * `react-native-keyboard-controller` consumes the IME insets directly, on both
 * platforms, and detects the same `edgeToEdgeEnabled` flag our build sets. It
 * also animates in step with the keyboard rather than jumping once it has
 * finished opening, which is the difference between a composer that feels
 * attached to the keyboard and one that chases it.
 *
 * ## Why a wrapper instead of importing the library in eleven screens
 *
 * Because the bug was never in any one screen — it was eleven copies of one
 * decision, and the next screen would have copied it again. Keeping the choice
 * here means `behavior` is set once, and a future change of engine (or a
 * per-platform tweak) is one file rather than another eleven-file sweep.
 *
 * `KeyboardProvider` in `app/_layout.tsx` is what feeds this; without it the
 * component renders but never moves.
 */

import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { KeyboardAvoidingViewProps } from 'react-native-keyboard-controller';

/**
 * A view that lifts its contents clear of the keyboard on both platforms.
 *
 * Drop-in for `KeyboardAvoidingView` — same props, including `style`,
 * `keyboardVerticalOffset` and `enabled`.
 *
 * `behavior` defaults to `'padding'` **and is no longer platform-conditional**;
 * that ternary is the bug this component exists to delete, so a caller
 * reintroducing one should expect a question in review. It stays overridable
 * because `'height'` and `'position'` are legitimately better for some layouts,
 * and the spread below lets a screen say so explicitly.
 */
export function KeyboardAvoider({
  children,
  ...props
}: KeyboardAvoidingViewProps) {
  return (
    <KeyboardAvoidingView behavior="padding" {...props}>
      {children}
    </KeyboardAvoidingView>
  );
}
