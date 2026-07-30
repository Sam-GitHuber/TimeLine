/**
 * Shared test helpers for the things that **differ by platform** (Phase 10).
 *
 * The suite runs twice, once as iOS and once as Android (see `jest.config.js`).
 * Two bits of React Native present the same user-facing thing through different
 * host props or different APIs, so a test written against one platform's shape
 * fails on the other for reasons that have nothing to do with the app being
 * broken. Rather than branch on `Platform.OS` in five test files, the difference
 * is absorbed here once.
 *
 * This file is in `__tests__/` but is **not itself a suite** — `testMatch` only
 * collects `*test.ts(x)` / `*spec.ts(x)`.
 */

import { ActionSheetIOS, Alert, BackHandler, Platform } from 'react-native';

/**
 * The two ways the app opens a "⋯" menu, spied so a test can drive them.
 *
 * The app shows an `ActionSheetIOS` on iOS and falls back to a plain
 * `Alert.alert` chooser on Android (`PostMenu`, the group menu, the poll menu,
 * the member menu). Both spies are installed because a test file typically
 * needs the `Alert` one anyway — confirmations are an `Alert` on *both*
 * platforms.
 */
export const showActionSheet = jest.spyOn(
  ActionSheetIOS,
  'showActionSheetWithOptions'
);
export const alertSpy = jest.spyOn(Alert, 'alert');

/** Reset both spies to silent no-ops. Call from `beforeEach`. */
export function resetMenuSpies(): void {
  showActionSheet.mockReset().mockImplementation(() => {});
  alertSpy.mockReset().mockImplementation(() => {});
}

type AlertButton = { text?: string; onPress?: () => void };

/**
 * Choose option `index` from the menu the app just opened, on either platform.
 *
 * `index` is an index into the app's own `labels` array, which is the one thing
 * both branches genuinely share — the Android fallback maps `labels` to alert
 * buttons in order and appends its own Cancel, so the indices line up and a test
 * can stay written in terms of "the third item in the menu".
 *
 * Deliberately *not* wrapped in `act()`: the callback kicks off an async
 * mutation whose fetch resolves after it returns, so wrapping only the
 * synchronous call would leak that work out of the act and poison the next
 * render. The caller's trailing `waitFor` flushes it instead.
 */
export function pickMenuAction(index: number): void {
  if (Platform.OS === 'ios') {
    const callback = showActionSheet.mock.calls.at(-1)?.[1] as (
      i: number
    ) => void;
    callback(index);
    return;
  }

  // Android: the most recent alert *is* the menu — a confirmation, if the
  // chosen action raises one, can only come after this press.
  const buttons = alertSpy.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
  if (!buttons) throw new Error('pickMenuAction: no menu alert was shown');
  buttons[index]?.onPress?.();
}

/**
 * The labels currently on offer in the menu, in order, without the Cancel item.
 *
 * Lets a test assert *what a menu offers* (e.g. that Edit disappears once a poll
 * has votes) rather than only what happens when you pick something.
 */
export function menuOptions(): string[] {
  if (Platform.OS === 'ios') {
    const options = showActionSheet.mock.calls.at(-1)?.[0]?.options ?? [];
    return options.filter((label) => label !== 'Cancel');
  }
  const buttons = (alertSpy.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
  return buttons
    .map((b) => b.text ?? '')
    .filter((label) => label !== 'Cancel' && label !== '');
}

/**
 * Choose the menu option with this label — the readable form of
 * {@link pickMenuAction}, and the one to prefer when a menu's contents vary
 * (the poll menu drops "Edit poll" once a vote is in, shifting every index
 * after it).
 */
export function pickMenuOption(label: string): void {
  const index = menuOptions().indexOf(label);
  if (index === -1) {
    throw new Error(
      `pickMenuOption: no "${label}" in the menu — offered: ${
        menuOptions().join(', ') || '(nothing)'
      }`
    );
  }
  pickMenuAction(index);
}

/**
 * The label of the option the menu marks as **destructive**, if any.
 *
 * The two platforms record the same intent differently — iOS by index
 * (`destructiveButtonIndex`), Android by a per-button `style` — so asserting on
 * either directly would pin the mechanism rather than the intent. What a test
 * actually wants to know is "is Delete flagged as the dangerous one", which is
 * true on both.
 */
export function menuDestructiveOption(): string | undefined {
  if (Platform.OS === 'ios') {
    const config = showActionSheet.mock.calls.at(-1)?.[0];
    const index = config?.destructiveButtonIndex;
    return typeof index === 'number' ? config?.options[index] : undefined;
  }
  const buttons = (alertSpy.mock.calls.at(-1)?.[2] ?? []) as (AlertButton & {
    style?: string;
  })[];
  return buttons.find((b) => b.style === 'destructive')?.text;
}

/** Whether the app opened a "⋯" menu at all, on either platform. */
export function menuWasShown(): boolean {
  return Platform.OS === 'ios'
    ? showActionSheet.mock.calls.length > 0
    : alertSpy.mock.calls.length > 0;
}

/**
 * Press a button (by its text) on the `Alert.alert` with the given title.
 *
 * Confirmations are an `Alert` on both platforms, so this needs no branch — but
 * on Android the menu is *also* an alert, hence matching on title rather than
 * taking the most recent call. Searches newest-first so that re-opening the same
 * dialog in one test presses the live one.
 */
export function pressAlertButton(title: string, buttonText: string): void {
  const call = alertSpy.mock.calls.findLast(([t]) => t === title);
  const buttons = call?.[2] as AlertButton[] | undefined;
  buttons?.find((b) => b.text === buttonText)?.onPress?.();
}

/**
 * Read a `<Switch>`'s on/off state, whichever platform rendered it.
 *
 * iOS renders an `RCTSwitch` carrying `value`; Android renders an
 * `AndroidSwitch` carrying `on`. RNTL's `toBeChecked()` matcher only understands
 * the iOS shape, so it silently reports *unchecked* for a switch that is very
 * much on — which is worse than not having a matcher at all. Throws rather than
 * defaulting, so a query that grabbed the wrong element fails loudly instead of
 * reading as `false`.
 */
export function switchValue(element: {
  type?: unknown;
  // Structural rather than RNTL's `ReactTestInstance`: the queries return
  // RNTL's own instance type, which isn't assignable to the identically-named
  // one from `react-test-renderer`. Only these two props are read.
  props: { value?: boolean; on?: boolean };
}): boolean {
  const value = element.props.value ?? element.props.on;
  if (typeof value !== 'boolean') {
    throw new Error(
      `switchValue: element (${String(element.type)}) has neither a \`value\` ` +
        'nor an `on` prop — is it really a Switch?'
    );
  }
  return value;
}

// --- Android back button ----------------------------------------------------

const backHandlers: (() => boolean)[] = [];

/**
 * Capture Android back-button registrations so a test can fire one.
 *
 * `BackHandler.addEventListener` is a native bridge: under Node it registers
 * nothing and there is no way to press back. This records the handlers instead.
 * Call from `beforeEach`; pair with `pressBack()`.
 *
 * Returns a `removed` counter so a test can assert the listener is actually
 * torn down — a screen that subscribes and never unsubscribes swallows back
 * presses for the rest of its life, which is a screen you can't leave.
 */
export function captureBackHandler(): { removed: () => number } {
  let removed = 0;
  backHandlers.length = 0;
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      backHandlers.push(handler as () => boolean);
      return {
        remove: () => {
          removed += 1;
          const index = backHandlers.indexOf(handler as () => boolean);
          if (index >= 0) backHandlers.splice(index, 1);
        },
      };
    });
  return { removed: () => removed };
}

/**
 * Fire the Android back button, returning whether anything claimed it.
 *
 * Invokes the most recently registered handler, matching React Native's
 * documented "last registered wins" ordering.
 */
export function pressBack(): boolean {
  const handler = backHandlers.at(-1);
  return handler ? handler() : false;
}

/** How many back handlers are currently registered. */
export function backHandlerCount(): number {
  return backHandlers.length;
}
