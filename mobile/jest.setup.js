/**
 * Test environment setup.
 *
 * `expo-secure-store` is a native module — it calls into the iOS Keychain, which
 * doesn't exist under Node. Every test would fail at import without a stand-in,
 * so we swap in an in-memory keychain with the same surface. This is the one
 * place tokens are faked; `src/tokens.ts` is otherwise exercised for real.
 *
 * **It models the options, not just the key** (Phase 10b, M2). It used to be a
 * flat `Map` keyed on `key` alone, which discarded the options argument
 * entirely — so a test that a value is stored with the right service, access
 * group or accessibility was structurally incapable of failing, and so was a
 * test that a delete reaches the copy in a shared group. Those are precisely
 * the properties the notification service extension depends on, and the ones
 * whose failure is invisible from inside the app.
 *
 * Five behaviours of the real thing are reproduced, each because getting it
 * wrong is a shipped bug (`SecureStoreModule.swift` for all five):
 *
 *   1. **The service is part of the identity**, and defaults to expo's `"app"`.
 *      An item stored under a pinned service is not found by a default read.
 *   2. **The stored service carries a `:no-auth` / `:auth` suffix**, chosen by
 *      `requireAuthentication`, and a read falls back through no-auth → auth →
 *      the bare "legacy" service. That suffix is part of the literal M3's Swift
 *      hardcodes, so it has to be a thing a test can see: flip the flag and
 *      every item moves service, the extension gets `errSecItemNotFound` on
 *      every push on every device, and nothing in the app notices.
 *   3. **A read or delete with no access group matches across every group**,
 *      the way `SecItemCopyMatching`/`SecItemDelete` do when
 *      `kSecAttrAccessGroup` is absent. This is the behaviour that made the
 *      plan's original "write it into the group, then delete the original"
 *      migration delete the copy it had just written.
 *   4. **A write with no access group lands in the app's own group**, rather
 *      than in some group-less limbo — an add always picks a group.
 *   5. **Re-writing an existing item changes its value and nothing else.** The
 *      real `set` is a `SecItemAdd` that falls back to a `SecItemUpdate` of
 *      `kSecValueData` alone, so accessibility is stamped once, at first write,
 *      and no later save can correct it. `savePreviewCredential` deletes first
 *      because of this, and this is what makes that provable.
 */

jest.mock('expo-secure-store', () => {
  // The group an add picks when the caller names none: on device, the app's own
  // (`$(AppIdentifierPrefix)net.yourtimeline.app`). The literal doesn't matter —
  // that there is exactly one of it, and that a group-less query ignores it,
  // does.
  const DEFAULT_GROUP = 'app-id-group';
  const DEFAULT_SERVICE = 'app';
  const WHEN_UNLOCKED = 'whenUnlocked';

  // (service, accessGroup, key) -> { value, accessible, ... }. Keyed through
  // JSON rather than a joined string, so a service or key containing the
  // separator can't collide with a different triple.
  const store = new Map();
  const idOf = (service, group, key) => JSON.stringify([service, group, key]);

  const baseService = (options = {}) => options.keychainService ?? DEFAULT_SERVICE;
  /** `null` means "any", for a query. Only `set` resolves it to a real group. */
  const groupOf = (options = {}) => options.accessGroup ?? null;

  // (2) The three service aliases an item can be stored under, newest first —
  // the order the real `get` tries them in.
  const aliases = (options = {}) => {
    const base = baseService(options);
    return [`${base}:no-auth`, `${base}:auth`, base];
  };
  const writeAlias = (options = {}) =>
    `${baseService(options)}:${options.requireAuthentication ? 'auth' : 'no-auth'}`;

  /** Every stored entry a query for (service, key) would match. */
  const matches = (key, service, group) =>
    [...store.values()].filter(
      (entry) =>
        entry.key === key &&
        entry.service === service &&
        (group === null || entry.group === group)
    );

  const remove = (entries) => {
    for (const entry of entries) {
      store.delete(idOf(entry.service, entry.group, entry.key));
    }
  };

  return {
    /** Empty the keychain between tests. */
    __reset: () => store.clear(),
    /** Everything stored, for assertions about how it was stored. */
    __entries: () => [...store.values()],

    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    WHEN_UNLOCKED,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'whenPasscodeSetThisDeviceOnly',

    setItemAsync: jest.fn(async (key, value, options = {}) => {
      const service = writeAlias(options);
      const group = options.accessGroup ?? DEFAULT_GROUP;
      const id = idOf(service, group, key);
      const existing = store.get(id);
      if (existing) {
        // (5) An update writes the data and leaves every attribute alone.
        existing.value = value;
        return;
      }
      store.set(id, {
        key,
        service,
        group,
        value,
        accessible: options.keychainAccessible ?? WHEN_UNLOCKED,
      });
      // A successful add sweeps the other two aliases, so a read can't find an
      // older copy of the same key first.
      remove(
        aliases(options)
          .filter((alias) => alias !== service)
          .flatMap((alias) => matches(key, alias, groupOf(options)))
      );
    }),

    getItemAsync: jest.fn(async (key, options = {}) => {
      for (const service of aliases(options)) {
        const [first] = matches(key, service, groupOf(options));
        if (first) return first.value;
      }
      return null;
    }),

    deleteItemAsync: jest.fn(async (key, options = {}) => {
      // (3) With no group named, this sweeps every group — all of them, not the
      // first. That is the whole hazard, so the mock must delete plurally. All
      // three aliases go, as the real one does.
      remove(aliases(options).flatMap((alias) => matches(key, alias, groupOf(options))));
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
  // Taking back a delivered notification once it's been dealt with in the app
  // (#178). Resolved rather than bare jest.fn()s for the same reason as the two
  // above: every dismissal path awaits these inside a try/catch, and a mock
  // returning undefined would throw on `.filter` of a non-array.
  getPresentedNotificationsAsync: jest.fn(async () => []),
  dismissNotificationAsync: jest.fn(async () => {}),
  // Fires when a push is delivered while the app is running, which is how a
  // message for the thread already on screen is taken back on Android. Returns
  // a subscription because that's what the real one does.
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  // The app icon's badge (#179). Resolved rather than a bare jest.fn() for the
  // same reason as the others: `setAppBadge` attaches a `.catch`, and a mock
  // returning undefined would throw wherever the badge is set.
  setBadgeCountAsync: jest.fn(async () => true),
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
// `useNavigation` needs one for the same reason, and `useHoldSwipeBack`
// (`src/writeHold.tsx`) calls it on every screen that holds a form open while
// its write is out. The only option it ever sets is `gestureEnabled`, which
// governs iOS's interactive pop — a real gesture on a real navigator, and
// nothing a Node test can perform. A suite that wants to assert the hold takes
// the option supplies its own stand-in with a spy (`writeHold.test.tsx`).
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: (callback) => require('react').useEffect(callback, [callback]),
  useNavigation: () => ({ setOptions: () => {} }),
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

  /** Mark a presentation settled before reporting through `handler`. */
  const settle =
    (settled, handler) =>
    (...args) => {
      settled.current = true;
      handler?.(...args);
    };

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
    // Whether this presentation has already reported OK or Cancel. An unsettled
    // one still owes its caller a Cancel when it goes away — see the cleanup.
    const settled = React.useRef(false);

    React.useEffect(
      () => {
        openCount += 1;
        if (failNextOpen) {
          failNextOpen = false;
          // A present that threw put nothing on screen — including when it was
          // a *re*-present, which takes down the dialog that was already up.
          setPresented(false);
          settled.current = true;
          // The real `catch` reports through `onError` alone. Firing anything
          // else here would hide exactly the gap #170 is about.
          onError?.(new Error('Activity is null'));
          return;
        }
        setPresented(true);
        setSpins(0);

        // **Unmounting dismisses the dialog, and that gets reported.** The real
        // component's cleanup calls `DateTimePickerAndroid.dismiss(mode)`, which
        // resolves this presentation's still-pending `open` with the DISMISS
        // action — so `onDismiss` fires, through the handler *this* presentation
        // captured. Asynchronously, which is the whole difficulty: the report
        // lands after a replacement has mounted, so a caller that doesn't scope
        // its close handlers closes the new dialog with the old one's Cancel.
        // Without this, remounting on every press looks free.
        return () => {
          if (settled.current) return;
          setTimeout(() => onDismiss?.(), 0);
        };
      },
      // Deliberately the library's dep list, verbatim.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onChange, onValueChange, onDismiss, onNeutralButtonPress, valueTimestamp, mode]
    );

    if (!presented) return null;

    return React.createElement(
      View,
      { testID: testID ?? 'datetimepicker' },
      // Wrapped so a real OK/Cancel marks this presentation settled — the
      // cleanup then owes it nothing, exactly as a dialog the user has already
      // closed cannot report a second time.
      affordances(settle(settled, onValueChange), settle(settled, onDismiss), {
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
  SecureStore.__reset();
  require('@react-native-community/datetimepicker').__resetPicker();
  jest.clearAllMocks();
});
