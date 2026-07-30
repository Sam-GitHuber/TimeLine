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
 * `react-native-keyboard-controller` was chosen over that route because it
 * consumes the IME insets directly on both platforms — detecting the same
 * `edgeToEdgeEnabled` flag our build sets — and because it animates *in step*
 * with the keyboard rather than jumping once it has finished opening, which is
 * the difference between a composer that feels attached to the keyboard and one
 * that chases it. A trade, not a necessity: worth knowing if the dependency ever
 * needs to come back out.
 *
 * ## Why a wrapper instead of importing the library in every screen
 *
 * Because the bug was never in any one screen — it was eleven copies of one
 * decision, and the next screen would have copied it again. Keeping the choice
 * here means `behavior` is set once, and a future change of engine (or a
 * per-platform tweak) is one file rather than another fifteen-file sweep.
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
 *
 * ## Two library defaults left alone, deliberately
 *
 * - **`automaticOffset` stays `false`.** When on, the avoider measures its own
 *   position on screen instead of assuming it reaches the window bottom. Every
 *   call site here *does* reach the bottom, and turning it on would change all
 *   fifteen at once on a guess — it's the first thing to try if a specific screen
 *   lifts by the wrong amount, not a blanket default to flip.
 * - **`preload` stays `true`** (iOS only): it warms the keyboard so the first
 *   focus of a session isn't visibly slow. Worth knowing it exists, because it
 *   means the keyboard is instantiated before anyone taps a field.
 */

import { forwardRef } from 'react';
import type { Ref } from 'react';
import type { ScrollView, View } from 'react-native';
// The one place allowed to import these — that's the whole point of the wrappers.
// Scoped to this statement rather than the file, so a *second* direct import
// added later still trips the rule.
/* eslint-disable no-restricted-imports */
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
/* eslint-enable no-restricted-imports */
import type {
  KeyboardAvoidingViewProps,
  KeyboardAwareScrollViewProps,
  KeyboardAwareScrollViewRef,
} from 'react-native-keyboard-controller';

import { spacing } from '@/theme';

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
export const KeyboardAvoider = forwardRef<View, KeyboardAvoidingViewProps>(
  function KeyboardAvoider({ behavior = 'padding', children, ...props }, ref) {
    return (
      <KeyboardAvoidingView behavior={behavior} ref={ref} {...props}>
        {children}
      </KeyboardAvoidingView>
    );
  }
);

/**
 * What a `KeyboardAwareScroll` ref actually gives you.
 *
 * The library's own `KeyboardAwareScrollViewRef` is narrower than the handle it
 * returns: `useImperativeHandle` hands back the **ScrollView instance** with
 * `assureFocusedInputVisible` bolted on, but the published type declares only
 * that one method. Typed as the library declares it, an existing
 * `scrollRef.current?.scrollTo(…)` stops compiling against a call that works
 * perfectly at runtime — so this widens it back to the truth.
 */
export type KeyboardAwareScrollRef = ScrollView & KeyboardAwareScrollViewRef;

/**
 * Whether the keyboard is currently up.
 *
 * For the one thing an avoider can't do for you: **dropping a safe-area bottom
 * inset while the keyboard covers it.** A bar pinned to the bottom of the screen
 * pads itself past the home indicator / navigation bar, and that pad is right
 * until the keyboard opens — at which point the avoider has already lifted the
 * bar clear and the inset becomes dead space between the bar and the keys.
 *
 * On iOS that was a ~34pt gap the code apologised for in a comment. On Android
 * it's worse: the library pads by the **full** `WindowInsets.ime()` measured
 * from the window bottom (it skips the navigation-bar subtraction, because
 * edge-to-edge reports a translucent navigation bar), so a three-button
 * navigation device gets a ~48dp band. Hence `insets.bottom * (visible ? 0 : 1)`
 * at the composer sites rather than a bare `insets.bottom`.
 *
 * Deliberately re-exported from here rather than imported from the library at
 * each call site, so every keyboard concern in the app has one front door.
 */
export function useKeyboardVisible(): boolean {
  return useKeyboardState((state) => state.isVisible);
}

/**
 * A scrolling form that keeps the **focused** field above the keyboard.
 *
 * Use this instead of `KeyboardAvoider` wrapping a `ScrollView`. Both keep the
 * keyboard off the bottom of the screen, but only this one scrolls the field you
 * just tapped into view. With padding alone a field low in a long form is
 * *reachable* — the viewport shrank, so you can scroll — but not *revealed*, and
 * the user ends up scrolling blind past a keyboard to find where they're typing.
 * Settings (three password fields under five sections) and the event planner
 * (poll fields deep in a long page) are where the difference is obvious.
 *
 * Takes every `ScrollView` prop, forwards its ref, and adds `bottomOffset` —
 * breathing room between the field and the keyboard, defaulted here so the
 * focused input isn't flush against it.
 */
export const KeyboardAwareScroll = forwardRef<
  KeyboardAwareScrollRef,
  KeyboardAwareScrollViewProps
>(function KeyboardAwareScroll({ bottomOffset = spacing.md, children, ...props }, ref) {
  return (
    <KeyboardAwareScrollView
      bottomOffset={bottomOffset}
      // The cast pays for the widened ref type above. `Ref<T>` includes
      // `RefCallback<T>`, which is contravariant, so a ref for the wider handle
      // is not structurally assignable to one for the library's narrower
      // declaration even though the object it receives is the same. Casting here
      // keeps the inaccuracy in one line, behind an accurate public type.
      ref={ref as Ref<KeyboardAwareScrollViewRef>}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
});
