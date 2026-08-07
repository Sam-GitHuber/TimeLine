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
 *
 * It also holds `settle`, which differs by nothing at all: three suites need it
 * and it is fiddly enough (see its docblock) that the fourth hand-written copy
 * would be the one that's subtly wrong.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, BackHandler, Platform } from 'react-native';

/**
 * `Alert`, spied so a test can drive a **confirmation**.
 *
 * Menus no longer go through `Alert` on either platform — they use
 * `useActionMenu`, an `ActionSheetIOS` on iOS and a real rendered bottom sheet
 * on Android. `Alert` is now only what it should always have been: a two- or
 * three-button confirmation.
 */
export const alertSpy = jest.spyOn(Alert, 'alert');

/** The iOS action sheet, spied so a test can pick from it. */
export const showActionSheet = jest.spyOn(
  ActionSheetIOS,
  'showActionSheetWithOptions'
);

/** Reset both spies to silent no-ops. Call from `beforeEach`. */
export function resetMenuSpies(): void {
  showActionSheet.mockReset().mockImplementation(() => {});
  alertSpy.mockReset().mockImplementation(() => {});
}

type AlertButton = { text?: string; onPress?: () => void };

/**
 * The menu options currently on offer, in order, without Cancel.
 *
 * **Reads what the platform actually presents**, which is the correction this
 * seam needed. The previous version read the raw array handed to `Alert.alert`
 * on Android — but React Native's Android `Alert` keeps only
 * `buttons.slice(0, 3)`, so every Android menu assertion certified items the OS
 * silently discarded. Now the Android branch queries the rendered sheet, which
 * has no such limit and is the thing a user sees.
 *
 * Throws if no menu is open. Returning `[]` would let an assertion like
 * `expect(menuOptions()).not.toContain('Edit poll')` pass vacuously when the
 * menu never opened at all.
 */
export function menuOptions(): string[] {
  if (Platform.OS === 'ios') {
    const config = showActionSheet.mock.calls.at(-1)?.[0];
    if (!config) throw new Error('menuOptions: no action sheet was shown');
    return config.options.filter((label) => label !== 'Cancel');
  }
  const items = screen.queryAllByTestId(/^action-menu-item/);
  if (items.length === 0) throw new Error('menuOptions: no menu sheet is open');
  return items.map((item) => String(item.props.accessibilityLabel));
}

/**
 * Choose option `index` from the open menu, on either platform.
 *
 * `index` indexes the options as {@link menuOptions} reports them — Cancel
 * excluded — so a test reads the same on both.
 */
export function pickMenuAction(index: number): void {
  if (Platform.OS === 'ios') {
    const callback = showActionSheet.mock.calls.at(-1)?.[1];
    if (!callback) throw new Error('pickMenuAction: no action sheet was shown');
    callback(index);
    return;
  }
  const items = screen.queryAllByTestId(/^action-menu-item/);
  const item = items[index];
  if (!item) {
    throw new Error(
      `pickMenuAction: no option at index ${index} — offered: ${
        items.map((i) => i.props.accessibilityLabel).join(', ') || '(nothing)'
      }`
    );
  }
  fireEvent.press(item);
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
 * iOS records the intent by index (`destructiveButtonIndex`); the Android sheet
 * renders it in red. Asserting on either mechanism directly would pin the
 * mechanism rather than the intent — what a test wants to know is "is Delete
 * flagged as the dangerous one", which is now true on both. (It was *not* true
 * of the old Android `Alert`, which ignores per-button `style` entirely, so the
 * previous helper asserted a warning the platform never drew.)
 */
export function menuDestructiveOption(): string | undefined {
  if (Platform.OS === 'ios') {
    const config = showActionSheet.mock.calls.at(-1)?.[0];
    const index = config?.destructiveButtonIndex;
    return typeof index === 'number' ? config?.options[index] : undefined;
  }
  const item = screen.queryAllByTestId('action-menu-item-destructive')[0];
  return item ? String(item.props.accessibilityLabel) : undefined;
}

/** Whether a "⋯" menu is currently open, on either platform. */
export function menuWasShown(): boolean {
  return Platform.OS === 'ios'
    ? showActionSheet.mock.calls.length > 0
    : screen.queryByTestId('action-menu') !== null;
}

/** Dismiss an open menu without choosing anything (Android's Cancel). */
export function cancelMenu(): void {
  if (Platform.OS === 'ios') {
    const config = showActionSheet.mock.calls.at(-1)?.[0];
    const callback = showActionSheet.mock.calls.at(-1)?.[1];
    if (!config || !callback) throw new Error('cancelMenu: no action sheet');
    callback(config.cancelButtonIndex ?? config.options.length - 1);
    return;
  }
  fireEvent.press(screen.getByTestId('action-menu-cancel'));
}

/**
 * Press a button (by its text) on the `Alert.alert` with the given title.
 *
 * Confirmations are an `Alert` on both platforms, so this needs no branch.
 * Searches newest-first so re-opening the same dialog presses the live one, and
 * **throws** rather than no-opping on a miss: several callers assert an
 * *absence* afterwards, and would pass identically whether the dialog appeared
 * or was never shown.
 */
export function pressAlertButton(title: string, buttonText: string): void {
  const call = alertSpy.mock.calls.findLast(([t]) => t === title);
  if (!call) {
    throw new Error(
      `pressAlertButton: no alert titled "${title}" — saw: ${
        alertSpy.mock.calls.map(([t]) => String(t)).join(', ') || '(none)'
      }`
    );
  }
  const buttons = call[2] as AlertButton[] | undefined;
  const button = buttons?.find((b) => b.text === buttonText);
  if (!button) {
    throw new Error(
      `pressAlertButton: no "${buttonText}" on "${title}" — offered: ${
        buttons?.map((b) => b.text).join(', ') || '(none)'
      }`
    );
  }
  button.onPress?.();
}

/**
 * Answer the "camera or library?" menu every photo picker opens first.
 *
 * It's the same `useActionMenu` sheet as every other menu, so this is just
 * "wait for it, then pick" — but it needs its own name because the *shape* of
 * the surrounding test is unusual: `pickPhotos` doesn't resolve until the choice
 * is made, so the press that opens the menu must **not** be awaited.
 *
 * ```ts
 * fireEvent.press(screen.getByLabelText('Add photos'));  // no await — see above
 * await choosePhotoSource('Take Photo');
 * ```
 *
 * Requires `resetMenuSpies()` in `beforeEach`, like any other menu test.
 */
export async function choosePhotoSource(
  label: 'Take Photo' | 'Choose from Library'
): Promise<void> {
  await waitFor(() => {
    if (!menuWasShown()) throw new Error('the photo source menu never opened');
  });
  // Inside `act`, and *async* so the microtasks after the choice run inside it
  // too. Everything the caller then does — launching the picker, storing what
  // came back — hangs off that promise chain, and outside `act` every one of
  // those state updates is an "not wrapped in act(...)" warning in the console.
  await act(async () => {
    pickMenuAction(menuOptions().indexOf(label));
  });
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

/**
 * `it`, but only under the **android** project.
 *
 * iOS has no hardware back and `useAndroidBack` registers nothing there, so
 * every one of these tests would be asserting on a listener that doesn't
 * exist. Shared because #168 spread the hook across eight screens and
 * components, and a per-file `Platform.OS === 'android' ? it : it.skip` is the
 * kind of line that gets copied slightly wrong the ninth time.
 */
export const androidIt = Platform.OS === 'android' ? it : it.skip;

// --- Date / time pickers ----------------------------------------------------

/**
 * Pick a value from the built-in date/time editor, on either platform.
 *
 * The two platforms need a different number of taps and that is a real
 * difference, not a test artefact (Phase 10). iOS draws the wheel inline and
 * always mounted, so the stubbed picker is there to press immediately. Android's
 * is a one-shot modal dialog, so the editor shows a trigger first and only
 * mounts the picker once it's pressed.
 *
 * The stub in `jest.setup.js` commits a fixed 2026-08-15 10:30 on press, so
 * either path lands the same value.
 */
export async function pickDateTimeValue(
  dimension: 'date' | 'time'
): Promise<void> {
  if (Platform.OS === 'android') {
    await fireEvent.press(
      screen.getByLabelText(
        dimension === 'date' ? 'Choose a date' : 'Choose a time'
      )
    );
  }
  await fireEvent.press(screen.getByLabelText('Pick a value'));
}

// --- Writes held mid-flight -------------------------------------------------

/**
 * A request that doesn't answer until the test says so, for driving the holds
 * in #256/#257/#259.
 *
 * That whole family of bugs lives *between* pressing the write and the server
 * answering, and shows itself only at the end of the sequence — press the
 * write, try to leave, then let the server refuse. A test that stops after the
 * second step passes against a build with no hold at all, because the form is
 * still on screen either way; what it has to prove is that the refusal is
 * spoken.
 *
 * ```ts
 * const server = holdRequest(mockFetch, { detail: 'No.' }, 403);
 * await act(async () => fireEvent.press(screen.getByLabelText('Save')));
 * await server.inFlight('Saving…');
 * // …try every way out…
 * await server.refuse();
 * expect(await screen.findByText('No.')).toBeTruthy();
 * ```
 *
 * Takes the suite's own `fetch` spy rather than installing one, because every
 * suite already serves its screen's reads through one.
 */
export function holdRequest(
  mockFetch: jest.Mock,
  body: unknown,
  status: number
): {
  inFlight: (pendingLabel: string) => Promise<void>;
  refuse: () => Promise<void>;
} {
  let release: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockFetch.mockImplementation(async () => {
    await answered;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === null ? '' : JSON.stringify(body)),
      json: async () => body,
    };
  });

  return {
    /**
     * Wait until the request is genuinely in flight, and say how you know.
     *
     * React Query dispatches a mutation's pending state through its notify
     * manager, so it lands a macrotask *after* the press — check straight after
     * `fireEvent` and you're reading a mutation that hasn't started, which
     * would pass against a build with no hold at all. `pendingLabel` is the
     * button's own "Saving…" wording, so the wait is anchored to something the
     * user can see rather than to a sleep.
     */
    inFlight: async (pendingLabel: string) => {
      await settle(1);
      if (screen.queryByText(pendingLabel) === null) {
        throw new Error(
          `holdRequest: nothing on screen reads "${pendingLabel}" — the write ` +
            'never started, so nothing below is being tested'
        );
      }
    },
    /** Let the server answer, and let the refusal reach the screen. */
    refuse: async () => {
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

// --- Settling ---------------------------------------------------------------

/**
 * Turn the event loop over `turns` times, so a **repeating** request has room to
 * show itself as more than one call (#248).
 *
 * A `waitFor` can't tell "asked once and stopped" from "asked once *so far*" —
 * and the loop this exists to catch re-fires on the failure itself, so it needs
 * no timer to keep going, just another turn. Anything still looping is hundreds
 * of calls by the time this returns; anything that stopped is still on one.
 *
 * Each turn is a real **macrotask**, not a microtask flush, and that is the part
 * that's easy to get wrong: the loop is one request per render *commit*, so a
 * mock that rejects instantly settles inside the same React batch as the render
 * that fired it and never produces the second commit the effect waits for. The
 * loop would then show up as two calls rather than the two hundred it really is,
 * which makes a passing test out of a broken guard. (A real failed request
 * always spans commits — hence also the deliberate `setTimeout` in the mocks
 * that fail.)
 */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
