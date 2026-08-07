/**
 * `writeHold` — the machinery behind "a form that is the only renderer of its
 * own error may not be dismissed while that write is in flight"
 * (#256/#257/#259).
 *
 * The per-form tests live with the forms (`commentEdit`, `eventsPolls`,
 * `profile`, `settings`, `newChat`, `groupForm`, `thread`). This one pins the
 * contract they all lean on, which is invisible from any single screen:
 *
 *   - a declaration raises the hold and lets go when the write settles **or**
 *     when the declaring component goes;
 *   - two writes are counted, so the first to finish doesn't release the
 *     second's hold;
 *   - a nested hold forwards itself upward, which is the only reason the
 *     Settings screen learns about a password change two levels below it;
 *   - the swipe hold turns iOS's interactive pop off and puts it back.
 */

import { act, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Text } from 'react-native';

import {
  useHoldOpen,
  useHoldSwipeBack,
  useWriteHold,
  WriteHoldProvider,
} from '@/writeHold';

// `mock`-prefixed so the hoisted factory below may close over it — Jest's one
// exception to the out-of-scope-variable rule.
const mockSetOptions = jest.fn();

jest.mock('expo-router', () => ({
  // Focus is a plain effect under test — the same stand-in `jest.setup.js`
  // installs globally, repeated because this factory replaces it wholesale.
  useFocusEffect: (callback: () => void | (() => void)) =>
    // `require`, not an import: the factory is hoisted above the imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useEffect(callback, [callback]),
  // A spy rather than the global no-op, so the swipe hold's one effect is
  // observable: there is no navigator under Node and no gesture to perform.
  useNavigation: () => ({
    setOptions: (...args: unknown[]) => mockSetOptions(...args),
  }),
}));

/** A child that declares a write for as long as `pending` says. */
function Writer({ pending }: { pending: boolean }) {
  useHoldOpen(pending);
  return <Text>writing</Text>;
}

/** A parent holding, reporting the flag its dismissal routes would read. */
function Holder({ children }: { children?: React.ReactNode }) {
  const hold = useWriteHold();
  return (
    <WriteHoldProvider hold={hold}>
      <Text>{hold.held ? 'held' : 'free'}</Text>
      {children}
    </WriteHoldProvider>
  );
}

beforeEach(() => {
  mockSetOptions.mockClear();
});

it('holds while a write is declared and lets go when it settles', async () => {
  const view = await render(
    <Holder>
      <Writer pending />
    </Holder>
  );
  expect(screen.getByText('held')).toBeTruthy();

  await act(async () => {
    view.rerender(
      <Holder>
        <Writer pending={false} />
      </Holder>
    );
  });

  // Released on the *answer*, not on the screen going: the hold exists so a
  // rejection has somewhere to render, and once the request has settled there
  // is no rejection left to protect.
  expect(screen.getByText('free')).toBeTruthy();
});

it('lets go when the declaring component unmounts', async () => {
  // The hold is what stops that unmount happening mid-write — but a screen torn
  // down some other way must not leave the flag stuck up, or the controls above
  // it are dead for good.
  const view = await render(
    <Holder>
      <Writer pending />
    </Holder>
  );
  expect(screen.getByText('held')).toBeTruthy();

  await act(async () => {
    view.rerender(<Holder />);
  });

  expect(screen.getByText('free')).toBeTruthy();
});

it('counts writes, so one settling doesn’t release another’s hold', async () => {
  // A comment's editor and its reply box are separate mutations under one node.
  const view = await render(
    <Holder>
      <Writer pending />
      <Writer pending />
    </Holder>
  );

  await act(async () => {
    view.rerender(
      <Holder>
        <Writer pending={false} />
        <Writer pending />
      </Holder>
    );
  });

  expect(screen.getByText('held')).toBeTruthy();
});

it('forwards a nested hold to the hold above it', async () => {
  // `ChangePasswordSection` owns the routes that collapse its form; the Settings
  // screen around it owns "← Back" and the swipe. A declaration reaches only the
  // nearest provider, so without forwarding the screen would never learn that a
  // password change was in flight — and Back would still take the error with it.
  const view = await render(
    <Holder>
      <Section pending />
    </Holder>
  );

  expect(screen.getByText('held')).toBeTruthy();
  expect(screen.getByText('section: held')).toBeTruthy();

  await act(async () => {
    view.rerender(
      <Holder>
        <Section pending={false} />
      </Holder>
    );
  });

  expect(screen.getByText('free')).toBeTruthy();
});

/** A hold inside a hold — the Settings shape, in miniature. */
function Section({ pending }: { pending: boolean }) {
  const hold = useWriteHold();
  return (
    <WriteHoldProvider hold={hold}>
      <Text>{`section: ${hold.held ? 'held' : 'free'}`}</Text>
      <Writer pending={pending} />
    </WriteHoldProvider>
  );
}

describe('the swipe-back hold', () => {
  function Screen({ pending }: { pending: boolean }) {
    useHoldSwipeBack(pending);
    return <Text>screen</Text>;
  }

  it('turns the gesture off while a write is out and puts it back', async () => {
    const view = await render(<Screen pending={false} />);
    expect(mockSetOptions).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(<Screen pending />);
    });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: false });

    await act(async () => {
      view.rerender(<Screen pending={false} />);
    });
    // Restored, not left off: every screen using this takes the stack's default,
    // and a swipe that never comes back is a way out lost for good.
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  });

  it('restores the gesture when the screen goes', async () => {
    const view = await render(<Screen pending />);
    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: false });

    await act(async () => {
      view.unmount();
    });

    expect(mockSetOptions).toHaveBeenLastCalledWith({ gestureEnabled: true });
  });
});

it('does nothing at all with no hold above it', async () => {
  // The thread-level comment composer has no ancestor holding and needs none —
  // nothing dismisses it. Declaring into thin air must not throw.
  function Loose() {
    const [pending, setPending] = useState(true);
    useHoldOpen(pending);
    return <Text onPress={() => setPending(false)}>loose</Text>;
  }

  await render(<Loose />);
  expect(screen.getByText('loose')).toBeTruthy();
});
