/**
 * Test environment setup.
 *
 * `expo-secure-store` is a native module — it calls into the iOS Keychain, which
 * doesn't exist under Node. Every test would fail at import without a stand-in,
 * so we swap in an in-memory map with the same four-method surface. This is the
 * one place tokens are faked; `src/tokens.ts` is otherwise exercised for real.
 */

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key);
    }),
  };
});

// `expo-file-system`'s `File` is a native module that reads bytes off the
// device filesystem — no filesystem under Node. `api.ts`'s `toBlob` uses it to
// turn a picked photo into an uploadable Blob, so stand it in with a File whose
// `arrayBuffer()` returns empty bytes. The upload *shape* (a Blob carrying the
// right filename + content-type) is what the api tests assert; the bytes
// themselves are the backend's to validate.
jest.mock('expo-file-system', () => ({
  File: class {
    constructor(uri) {
      this.uri = uri;
    }
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  },
}));

// `expo-notifications` is imported transitively by anything that touches auth
// (auth.tsx → push.ts), so nearly every suite pulls it in. Importing the real
// module under Node isn't just noisy — it runs the library's device-token
// auto-registration side effect at import time and warns about Expo Go. Stub
// the surface we use; `push.test.ts` overrides this with its own mock to drive
// the permission branches.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({
    granted: false,
    canAskAgain: false,
  })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: null })),
  setNotificationHandler: jest.fn(),
  // Registers the Reply action on a message push (Phase 9b M8). Resolved
  // rather than a bare jest.fn(): `configureNotificationCategories` attaches a
  // `.catch`, and a mock returning undefined would throw at import time in
  // every suite that pulls the module in.
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  // Creates an Android notification channel (Phase 10). Resolved rather than a
  // bare jest.fn() for the same reason as the category above:
  // `configureNotificationChannels` attaches a `.catch`, and a mock returning
  // undefined would throw at import time in every suite that pulls this in.
  setNotificationChannelAsync: jest.fn(async () => ({})),
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
  useLastNotificationResponse: jest.fn(() => null),
}));

// `react-native-safe-area-context` measures the real notch/home-indicator insets
// through a native view. Under Node there's nothing to measure, so its provider
// renders nothing and any component inside it (the photo lightbox) disappears
// from the tree. The library ships this mock for exactly that — it reports a
// fixed iPhone-ish frame so children render.
// (`.default` because the mock is published as a default-exported object, while
// the real module is imported by name.)
jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default
);

/**
 * `useFocusEffect` needs a navigator above it, and a unit test renders a screen
 * or a component on its own — so the real one throws "Couldn't find a
 * navigation object" (#168).
 *
 * Stubbed as a plain `useEffect`, which is honest for a test: there is exactly
 * one screen and it is always focused. The cleanup still runs on unmount, so
 * `useAndroidBack`'s subscribe/unsubscribe pairing is exercised for real rather
 * than assumed — that pairing is the part a broken hook would get wrong.
 *
 * Global rather than per-suite because `useAndroidBack` is now spread across
 * eight screens and components; a per-file stub means every future suite that
 * happens to mount one of them fails on a navigation error that has nothing to
 * do with what it's testing. Everything else in `expo-router` stays real.
 *
 * A suite that replaces `expo-router` wholesale with its own factory (to fake
 * `router` or `useLocalSearchParams`) overrides this and must include the same
 * stub — that's a property of `jest.mock`, not something this can prevent.
 */
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: (callback) => require('react').useEffect(callback, [callback]),
}));

// `@react-native-community/datetimepicker` is a native module (the OS date/time
// wheel) with no Node counterpart, and it's imported by the event dimension
// editor (E3c). Stand it in with two pressables: one that commits a **fixed**
// date (2026-08-15 10:30) through `onValueChange`, so a test can drive "the
// organiser picked a value" deterministically, and one that fires `onDismiss`.
//
// `onValueChange`/`onDismiss` rather than the old `onChange` (Phase 10): the
// single-callback API is deprecated and warns at runtime, and the split maps
// onto what Android actually reports — OK versus Cancel. The dismiss affordance
// is what lets a test cover the Android path where the dialog is closed without
// a choice, which is the path that used to leave the picker inert.
//
// **The Android stand-in models the library's effect, not just its markup**
// (#169/#170). The real Android component renders nothing at all: it opens a
// modal dialog as a side effect of a `useEffect` keyed on
// `[onChange, onValueChange, onDismiss, onNeutralButtonPress, valueTimestamp,
// mode]`, and presents inside a `try`/`catch` whose only failure exit is
// `onError`. Almost everything that can go wrong with this component is a
// consequence of those two facts, and a stub with no effects can see none of
// it — the flat version certified both bugs as fixed while they were live.
//
// So the Android branch reproduces the three behaviours a caller has to get
// right:
//
//   1. It re-runs whenever any of those deps changes identity, and a re-run
//      **discards the in-progress selection** (the real dialog snaps back to
//      the `value` prop). `Spin the picker` moves the selection and
//      `Picker selection` reads it back, so a test can assert it survived a
//      re-render it didn't ask for.
//   2. `__failNextOpen()` makes the next present throw, which fires `onError`
//      and *none* of OK/Cancel — the state a caller can wedge itself in.
//   3. It never unmounts itself. Whether the dialog is up is the caller's
//      state, so `queryByLabelText('Pick a value')` still asks the real
//      question: "did the component under test unmount this so the next press
//      gets a live instance?"
//
// iOS keeps the flat, always-mounted stub, because that is what its inline
// wheel is.
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Platform, Pressable, Text, View } = require('react-native');

  // What a press commits, and the unit `Spin the picker` moves by: whole days
  // for a date, so an assertion reads as a date rather than an offset.
  const PICKED = new Date(2026, 7, 15, 10, 30);
  const DAY_MS = 24 * 60 * 60 * 1000;

  let failNextOpen = false;
  let openCount = 0;

  const affordances = (onValueChange, onDismiss, extra) =>
    [
      React.createElement(
        Pressable,
        {
          key: 'pick',
          accessibilityLabel: 'Pick a value',
          onPress: () =>
            onValueChange?.(
              { nativeEvent: { timestamp: 0, utcOffset: 0 } },
              extra ? extra.picked() : PICKED
            ),
        },
        React.createElement(Text, null, 'picker')
      ),
      React.createElement(
        Pressable,
        {
          key: 'dismiss',
          accessibilityLabel: 'Dismiss the picker',
          onPress: () => onDismiss?.(),
        },
        React.createElement(Text, null, 'dismiss')
      ),
    ].concat(extra ? extra.nodes : []);

  function IosPicker({ onValueChange, onDismiss, testID }) {
    return React.createElement(
      View,
      { testID: testID ?? 'datetimepicker' },
      affordances(onValueChange, onDismiss)
    );
  }

  function AndroidPicker({
    value,
    mode,
    onChange,
    onValueChange,
    onDismiss,
    onNeutralButtonPress,
    onError,
    testID,
  }) {
    // `presented`: the open succeeded. `spins`: how far the organiser has moved
    // the selection since it opened — reset by a re-present, which is the bug.
    const [presented, setPresented] = React.useState(false);
    const [spins, setSpins] = React.useState(0);
    const valueTimestamp = value ? value.getTime() : 0;

    React.useEffect(
      () => {
        openCount += 1;
        if (failNextOpen) {
          failNextOpen = false;
          // The real `catch` reports through `onError` alone. Firing anything
          // else here would hide exactly the gap #170 is about.
          onError?.(new Error('Activity is null'));
          return;
        }
        setPresented(true);
        setSpins(0);
      },
      // Deliberately the library's dep list, verbatim.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onChange, onValueChange, onDismiss, onNeutralButtonPress, valueTimestamp, mode]
    );

    if (!presented) return null;

    return React.createElement(
      View,
      { testID: testID ?? 'datetimepicker' },
      affordances(onValueChange, onDismiss, {
        picked: () => new Date(PICKED.getTime() + spins * DAY_MS),
        nodes: [
          React.createElement(
            Pressable,
            {
              key: 'spin',
              accessibilityLabel: 'Spin the picker',
              onPress: () => setSpins((n) => n + 1),
            },
            React.createElement(Text, null, 'spin')
          ),
          React.createElement(
            Text,
            { key: 'selection', accessibilityLabel: 'Picker selection' },
            String(spins)
          ),
        ],
      })
    );
  }

  return {
    __esModule: true,
    default: Platform.OS === 'android' ? AndroidPicker : IosPicker,
    /** Make the next present throw, as a null host activity does. */
    __failNextOpen: () => {
      failNextOpen = true;
    },
    /** How many times a picker has been presented since the last reset. */
    __openCount: () => openCount,
    __resetPicker: () => {
      failNextOpen = false;
      openCount = 0;
    },
  };
});

// `expo-haptics` drives the taptic engine — no hardware under Node, and the real
// module throws on import. The message long-press fires a light impact, so every
// thread test would fail without this. Assertions never care *that* it buzzed;
// they care what the gesture opened.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// `expo-clipboard` is a native pasteboard bridge. The message action menu's Copy
// item calls it, so stub it with a spy-able no-op — a test can assert the copied
// string without a real pasteboard.
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(async () => ''),
}));

// Measuring a view asks the real layout engine where it ended up on screen —
// native, and there's no screen here. React Native's own `measureInWindow`
// doesn't throw under Node, it just never calls back, so a component that waits
// for the rect before rendering (the message action menu anchors itself under
// the bubble you long-pressed) would hang forever. RN's Jest preset installs
// that no-op as a per-instance `jest.fn()` reached via `requireActual`, so it
// can't be mocked directly — which is why `src/measure.ts` exists as a seam we
// own. Stand it in with a fixed, plausible rect: tests assert *what the menu
// offers*, never where it lands, since pixel placement is a device concern.
jest.mock('@/measure', () => ({
  measureInWindow: (_node, onMeasured) =>
    onMeasured({ x: 0, y: 0, width: 240, height: 44 }),
}));

// `expo-blur` renders a real native blur layer (UIVisualEffectView on iOS).
// There's nothing to blur under Node and no native view to build, so stand it in
// with a plain View that keeps its children in the tree — the focused reply
// thread (Phase 9b M3) renders *inside* the BlurView, so a null stand-in would
// make every message in it unqueryable. That it actually blurs is a device
// check; what a test can prove is what the thread shows and sends.
jest.mock('expo-blur', () => {
  const { View } = require('react-native');
  return { BlurView: View };
});

// `react-native-keyboard-controller` reads the keyboard's insets through a
// native view (and a Reanimated worklet), neither of which exists under Node.
// Every screen pulls it in via `KeyboardAvoider`, and the root layout mounts its
// `KeyboardProvider`, so without a stand-in the whole suite fails at import.
//
// The library ships this mock for exactly that, and the important property is
// the same one the `expo-blur` mock above needs: `KeyboardAvoidingView` becomes
// a plain `View`, so it **keeps its children in the tree**. These wrap entire
// screens — a null stand-in would make every message, field and button inside
// them unqueryable, and dozens of unrelated tests would fail for a reason that
// looks nothing like the cause.
//
// (`require` of the subpath, not a hand-rolled stub, so the fake surface tracks
// the library's own across upgrades.)
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest')
);

// Reset between tests so a token stored by one can't leak into the next — and
// likewise the picker stub's open count and armed failure, which are
// module-level and would otherwise carry into the next test in the file.
beforeEach(() => {
  const SecureStore = require('expo-secure-store');
  SecureStore.__store.clear();
  require('@react-native-community/datetimepicker').__resetPicker();
  jest.clearAllMocks();
});
