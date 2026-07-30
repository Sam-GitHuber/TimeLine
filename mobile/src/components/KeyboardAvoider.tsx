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
 * Why not React Native's own `KeyboardAvoidingView` with `behavior="padding"`?
 * Not because it's incapable — an earlier version of this comment claimed that
 * and was wrong. RN 0.86 reports a correct keyboard **height** on Android
 * (`ReactRootView` derives it from `WindowInsets.ime()`), and it positions from
 * `endCoordinates.screenY`, which has an explicit branch for this:
 * `screenY = softInputMode == SOFT_INPUT_ADJUST_NOTHING ? visibleBottom - height
 * : visibleBottom` (`ReactRootView.java:973`). Under `adjustNothing` that first
 * arm is resize-independent and correct.
 *
 * The catch is the mode we're in. With the manifest's `adjustResize` we get the
 * second arm — `visibleBottom`, a resize-era measurement — so `'padding'` reads
 * a number premised on the resize edge-to-edge no longer performs. Reaching
 * `adjustNothing` is possible but not cheap: `app.json` exposes only
 * `android.softwareKeyboardLayoutMode: resize | pan`, so it needs a config
 * plugin or a manifest edit, and it would then apply app-wide.
 *
 * The library was chosen over that route for the animation quality (it tracks
 * the keyboard rather than stepping once it has settled) and because it handles
 * both platforms through one path. That's a trade, not a necessity — worth
 * knowing if the dependency ever needs to come back out.
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
 *
 * ## The Modal side effect — read this before adding a `<Modal>` with an input
 *
 * Mounting `KeyboardProvider` changes every RN `<Modal>` in the app, whether or
 * not it uses an avoider. React Native sets each modal's dialog window to
 * `SOFT_INPUT_ADJUST_RESIZE` (`ReactModalHostView.kt:332`), so modal dialogs
 * were the one surface still being resized even under edge-to-edge — an input in
 * a modal worked with no help at all. The library's `ModalAttachedWatcher`
 * overrides that to `SOFT_INPUT_ADJUST_NOTHING` on every modal show
 * ("imitating edge-to-edge mode behavior", `ModalAttachedWatcher.kt:96`),
 * unconditionally once the provider is mounted.
 *
 * So **a `<Modal>` containing a text input now needs a `KeyboardAvoider`
 * inside it**, where before it needed nothing. That's the reverse of the usual
 * direction of travel and it caught two modals in this app on the way in.
 */

// The one place allowed to import it — that's the whole point of the wrapper.
// eslint-disable-next-line no-restricted-imports
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
 * because `'height'` is legitimately better for some layouts.
 *
 * The default is a **parameter** default, not `behavior="padding"` ahead of a
 * spread, and the difference is load-bearing: object spread copies keys whose
 * value is `undefined`, so `behavior={Platform.select({ ios: 'padding' })}` — or
 * any hoisted ternary evaluating to `undefined` — would overwrite the default
 * with nothing and leave the view inert on *both* platforms. That is strictly
 * worse than the bug being fixed, which at least worked on iOS, and `tsc` can't
 * catch it because `behavior?:` accepts `undefined` happily.
 *
 * `'position'` is deliberately not recommended: in that mode the library routes
 * `style` to a static outer view and animates `contentContainerStyle` instead,
 * so a caller passing only `style={styles.fill}` loses its `flex: 1` on the
 * animated view and the children collapse.
 */
export function KeyboardAvoider({
  behavior = 'padding',
  children,
  ...props
}: KeyboardAvoidingViewProps) {
  return (
    <KeyboardAvoidingView behavior={behavior} {...props}>
      {children}
    </KeyboardAvoidingView>
  );
}
