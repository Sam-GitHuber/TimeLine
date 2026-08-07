/**
 * Holding a form open until its write lands (#256/#257/#259).
 *
 * The invariant, settled for dialogs in #254/#255 and widened to every shape a
 * form takes in #259 — see
 * `docs/reference/connections.md#reporting-a-refused-write`:
 *
 * > **A form that is the only renderer of its own error may not be dismissed
 * > while that write is in flight.**
 *
 * Nothing in it is about being a dialog. An inline editor that expands in place
 * is dismissed by its own Cancel, by Android's hardware back, and — if it lives
 * on a pushed screen — by that screen's Back and by iOS's swipe-back. Every one
 * of those unmounts the thing holding the rejection, so the answer arrives with
 * nowhere to go and the refusal is never spoken. You believe you changed your
 * password.
 *
 * **Why a context rather than a prop.** The phone's version of this bug has a
 * structural cause (#256): `useAndroidBack` is registered on the parent that
 * owns the open/closed flag, while the pending flag lives in the child doing the
 * write, so the two can never agree. The child has to tell someone. A callback
 * prop would work for a direct child and not for `ChangePasswordForm`, which is
 * two levels below the screen whose Back is one of the routes — and a prop that
 * a caller can simply forget to pass has the same silent failure mode as the bug
 * itself. So the child *declares* its write and whichever ancestor is holding
 * reads the count, which is the shape the web settled on in #258
 * (`useHoldMessagesOpen`).
 *
 * Three things a caller has to get right:
 *
 * - **Release the moment the write lands, not when the screen goes.** React
 *   Query keeps a mutation pending for the whole of `onSuccess`, so a form whose
 *   success handler awaits a *second* request (`ProfileEditForm` awaits
 *   `refreshUser()`) would hold across a round trip that has nothing to report —
 *   moving the trap rather than removing it.
 * - **Hold on the pending flag alone, never on the submit button's `canSave`.**
 *   That is also false for an empty box, which would be a Cancel you couldn't
 *   press after clearing the text.
 * - **Never let two Android-back registrations *disagree* about one press.** RN
 *   runs the most recently registered handler first, so two handlers that would
 *   do different things rank themselves by an accident of hook order — the race
 *   `CommentThread.tsx` keeps one write box per comment to avoid. Two that both
 *   decline are harmless, which is what makes the Settings screen's
 *   screen-level hold safe alongside `ChangePasswordSection`'s own. The rule in
 *   practice: where a screen already registers `useAndroidBack` for the state
 *   being held, prefer gating *that* handler and taking `useHoldSwipeBack`
 *   alone; `useHoldScreen` is for screens with nothing else registered.
 */

import { useNavigation } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAndroidBack } from '@/useAndroidBack';

/**
 * What a child calls to declare a write. Stable for the life of the provider —
 * the *count* changes, this doesn't, so declaring a write can't re-run every
 * declaring child's effect.
 */
type WriteHoldChannel = { begin: () => void; end: () => void };

const WriteHoldContext = createContext<WriteHoldChannel | null>(null);

/** What `useWriteHold` hands back: the flag to gate on, and the channel. */
export type WriteHold = WriteHoldChannel & {
  /** Some descendant has a write out — refuse every way out of this form. */
  held: boolean;
};

/**
 * Own a hold, in the component that owns the dismissal routes.
 *
 * A count rather than a boolean because more than one descendant can be writing
 * (a comment's editor and its reply box are separate mutations), and the last
 * one to finish must not release a hold the other still needs.
 */
export function useWriteHold(): WriteHold {
  const [writes, setWrites] = useState(0);
  const begin = useCallback(() => setWrites((n) => n + 1), []);
  const end = useCallback(() => setWrites((n) => Math.max(0, n - 1)), []);
  // **A hold forwards itself to any hold above it**, so nesting composes
  // instead of swallowing. `ChangePasswordSection` owns the routes that
  // collapse its form, and the Settings screen around it owns "← Back" and the
  // swipe — a declaration reaches only the *nearest* provider, so without this
  // the screen would never learn that a password change was in flight. Reading
  // the context here rather than inside the provider is what makes it the
  // ancestor's: the provider we render is our own descendant.
  useHoldOpen(writes > 0);
  return useMemo(
    () => ({ held: writes > 0, begin, end }),
    [writes, begin, end]
  );
}

/** Publish a hold to everything rendered inside it. */
export function WriteHoldProvider({
  hold,
  children,
}: {
  hold: WriteHold;
  children: ReactNode;
}) {
  // Deliberately *not* `hold` itself: that object changes identity whenever the
  // count moves, and every declaring child's effect lists this value. Passing it
  // through would tear down and re-run each declaration on every begin/end — at
  // best wasted work, at worst a begin/end pair that cancels the hold it just
  // took.
  const channel = useMemo(
    () => ({ begin: hold.begin, end: hold.end }),
    [hold.begin, hold.end]
  );
  return (
    <WriteHoldContext.Provider value={channel}>
      {children}
    </WriteHoldContext.Provider>
  );
}

/**
 * Declare a write to whichever ancestor is holding, for as long as it's out.
 *
 * A no-op with no provider above, which is the honest answer: the routes out of
 * this form belong to somebody, and if nobody is holding there is nothing to
 * refuse. The cleanup runs on unmount as well as when the write settles, so a
 * child torn down some other way can't strand the hold shut.
 */
export function useHoldOpen(pending: boolean): void {
  const channel = useContext(WriteHoldContext);
  useEffect(() => {
    if (!pending || !channel) return undefined;
    channel.begin();
    return channel.end;
  }, [pending, channel]);
}

/**
 * Refuse iOS's interactive swipe-back while a write is out.
 *
 * The one dismissal route with no button and no key: it belongs to the
 * navigator, so the only way to decline it is to turn it off for as long as the
 * hold lasts. Android's system back gesture isn't governed by this (it goes
 * through `BackHandler`, i.e. `useAndroidBack`) — the same split
 * `app/_layout.tsx` records for the conversation screen.
 *
 * Restores the gesture rather than leaving it off, because every screen using
 * this takes the stack's default (enabled); the one screen that disables it for
 * good does so in the layout, not here.
 */
export function useHoldSwipeBack(pending: boolean): void {
  const navigation = useNavigation<{
    setOptions: (options: { gestureEnabled: boolean }) => void;
  }>();
  useEffect(() => {
    if (!pending) return undefined;
    navigation.setOptions({ gestureEnabled: false });
    return () => navigation.setOptions({ gestureEnabled: true });
  }, [navigation, pending]);
}

/**
 * Both routes out of a pushed screen that belong to the navigator rather than
 * to any button: Android's back and iOS's swipe.
 *
 * Android back is *swallowed*, not redirected — while the write is out there is
 * nothing for the press to do, and popping the screen is precisely what must not
 * happen. Returning "handled" is what stops the navigator taking it (see
 * `useAndroidBack`).
 *
 * Only for screens with no other `useAndroidBack` registration live for the same
 * state — see the note at the top of this file.
 */
export function useHoldScreen(pending: boolean): void {
  useAndroidBack(pending, () => {});
  useHoldSwipeBack(pending);
}
