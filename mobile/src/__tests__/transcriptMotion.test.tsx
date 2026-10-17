/**
 * The small movements in a message thread (#395), at the level of one bubble.
 *
 * Nothing under Node can see a frame, so what's pinned is the decision: *which*
 * animation runs, and — most of the value — that none runs when nothing
 * happened. Every one of these was a way for the transcript to shimmer on a
 * poll, on opening a thread, or on paging back through it. The animation
 * functions are wrapped rather than replaced, so the real `Animated` calls
 * still run underneath.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';

import { MessageBubble } from '@/components/MessageBubble';
import { Presence } from '@/components/Presence';
import * as motion from '@/motion';
import type { Message, Reaction } from '@/types';

jest.mock('@/motion', () => {
  const actual = jest.requireActual('@/motion');
  return {
    ...actual,
    rise: jest.fn(actual.rise),
    pop: jest.fn(actual.pop),
    bump: jest.fn(actual.bump),
    settle: jest.fn(actual.settle),
    ease: jest.fn(actual.ease),
  };
});
const rise = motion.rise as jest.Mock;
const pop = motion.pop as jest.Mock;
const bump = motion.bump as jest.Mock;
const settle = motion.settle as jest.Mock;

const ADA = { id: 2, display_name: 'Ada Lovelace', avatar_thumb: null };

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 7,
    sender: ADA,
    text: 'dinner at 7?',
    is_deleted: false,
    is_edited: false,
    created_at: new Date().toISOString(),
    edited_at: null,
    reactions: [],
    attachments: [],
    ...overrides,
  };
}

const thumbs = (count: number, reacted = false): Reaction => ({
  emoji: '👍',
  count,
  reacted,
});

type BubbleProps = Partial<React.ComponentProps<typeof MessageBubble>>;
const bubble = (props: BubbleProps = {}) => (
  <MessageBubble message={message()} mine={false} showSender={false} {...props} />
);

/**
 * The OS's Reduce Motion switch. `motion.ts` subscribes once for the life of
 * the module, so the listener is captured before anything renders and driven
 * from here.
 */
let reduceMotionChanged: (enabled: boolean) => void = () => {};
const listen = jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockImplementation(((event: string, handler: (enabled: boolean) => void) => {
    if (event === 'reduceMotionChanged') reduceMotionChanged = handler;
    return { remove: jest.fn() };
  }) as never);
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);

async function setReduceMotion(enabled: boolean) {
  await act(async () => reduceMotionChanged(enabled));
}

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(async () => {
  await setReduceMotion(false);
});

describe('a bubble arriving', () => {
  it('rises in when the screen says it is new', async () => {
    await render(bubble({ entering: true }));
    expect(rise).toHaveBeenCalledTimes(1);
  });

  it('doesn’t when it is merely mounting', async () => {
    // The first load, a page of history, a row scrolled back into the window.
    await render(bubble());
    expect(rise).not.toHaveBeenCalled();
  });

  it('rises once, not again each time the row re-renders', async () => {
    // A four-second poll re-renders every row with a fresh message object.
    const view = await render(bubble({ entering: true }));
    await view.rerender(bubble({ entering: true, message: message() }));
    await view.rerender(bubble({ entering: true, message: message() }));
    expect(rise).toHaveBeenCalledTimes(1);
  });
});

describe('a reaction pill', () => {
  it('pops when it is the bubble’s first reaction', async () => {
    const view = await render(bubble());
    await view.rerender(bubble({ message: message({ reactions: [thumbs(1, true)] }) }));

    expect(screen.getByLabelText(/^👍, 1/)).toBeTruthy();
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('pops when it joins others already there', async () => {
    const heart: Reaction = { emoji: '❤️', count: 1, reacted: false };
    const view = await render(bubble({ message: message({ reactions: [heart] }) }));
    await view.rerender(
      bubble({ message: message({ reactions: [heart, thumbs(1, true)] }) })
    );
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('doesn’t pop for reactions the bubble mounted with', async () => {
    // Otherwise opening a thread pops every reaction in it at once.
    await render(bubble({ message: message({ reactions: [thumbs(2)] }) }));
    expect(pop).not.toHaveBeenCalled();
  });

  it('doesn’t pop again when the server’s answer replaces the one drawn on the tap', async () => {
    const view = await render(bubble());
    await view.rerender(bubble({ message: message({ reactions: [thumbs(1, true)] }) }));
    await view.rerender(bubble({ message: message({ reactions: [thumbs(1, true)] }) }));
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('pops again when it is taken off and put back', async () => {
    const view = await render(bubble({ message: message({ reactions: [thumbs(1, true)] }) }));
    await view.rerender(bubble());
    await view.rerender(bubble({ message: message({ reactions: [thumbs(1, true)] }) }));
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it('nudges when its count changes, and only then', async () => {
    const view = await render(bubble({ message: message({ reactions: [thumbs(1)] }) }));
    expect(bump).not.toHaveBeenCalled();

    await view.rerender(bubble({ message: message({ reactions: [thumbs(2)] }) }));
    expect(bump).toHaveBeenCalledTimes(1);
    // The same count again — a poll — is not a change.
    await view.rerender(bubble({ message: message({ reactions: [thumbs(2)] }) }));
    expect(bump).toHaveBeenCalledTimes(1);
    expect(pop).not.toHaveBeenCalled();
  });
});

describe('the send tick', () => {
  const mine = (props: BubbleProps) => bubble({ mine: true, ...props });

  it('cross-fades when sent becomes read', async () => {
    const view = await render(mine({ status: 'sent' }));
    expect(settle).not.toHaveBeenCalled();

    await view.rerender(mine({ status: 'read' }));
    expect(screen.getByLabelText('Read')).toBeTruthy();
    // Two halves: the single tick leaving, the double tick resolving in.
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('doesn’t animate a tick that was simply there', async () => {
    const view = await render(mine({ status: 'read' }));
    await view.rerender(mine({ status: 'read' }));
    expect(settle).not.toHaveBeenCalled();
  });

  it('changes from the clock when the bubble has just taken over from the outbox', async () => {
    // A send landing swaps the row's key, so this bubble never *was* the clock —
    // it is told it replaced one.
    await render(mine({ status: 'sent', settled: true }));
    expect(screen.getByLabelText('Sent')).toBeTruthy();
    expect(settle).toHaveBeenCalledTimes(2);
  });
});

describe('an edit and a delete', () => {
  it('resolves the new words in when the text changes', async () => {
    const view = await render(bubble());
    expect(settle).not.toHaveBeenCalled();

    await view.rerender(bubble({ message: message({ text: 'dinner at 8?', is_edited: true }) }));
    expect(screen.getByText('dinner at 8?')).toBeTruthy();
    expect(settle).toHaveBeenCalledTimes(1);

    // The poll that confirms it brings the same words.
    await view.rerender(bubble({ message: message({ text: 'dinner at 8?', is_edited: true }) }));
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settles a delete into its tombstone', async () => {
    const view = await render(bubble());
    await view.rerender(bubble({ message: message({ text: '', is_deleted: true }) }));

    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('doesn’t animate a tombstone that was already one', async () => {
    await render(bubble({ message: message({ text: '', is_deleted: true }) }));
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('with Reduce Motion on', () => {
  it('moves nothing at all', async () => {
    await setReduceMotion(true);

    const view = await render(bubble({ mine: true, entering: true, status: 'sent', settled: true }));
    await view.rerender(
      bubble({
        mine: true,
        entering: true,
        status: 'read',
        message: message({ text: 'edited', reactions: [thumbs(1)] }),
      })
    );
    await view.rerender(
      bubble({
        mine: true,
        entering: true,
        status: 'read',
        message: message({ text: 'edited', reactions: [thumbs(2)] }),
      })
    );
    await view.rerender(
      bubble({
        mine: true,
        message: message({ text: '', is_deleted: true, reactions: [thumbs(2)] }),
      })
    );

    // …and everything is still drawn, in its end state.
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.getByLabelText(/^👍, 2/)).toBeTruthy();
    for (const animation of [rise, pop, bump, settle]) {
      expect(animation).not.toHaveBeenCalled();
    }
  });

  it('asks the OS once, however many bubbles there are', async () => {
    await render(
      <>
        {bubble()}
        {bubble({ message: message({ id: 8 }) })}
      </>
    );
    // Zero here if an earlier test in this file already subscribed — the point
    // is that it is never once per bubble.
    expect(listen.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('Presence', () => {
  const control = (visible: boolean, label = 'Editing message') => (
    <Presence visible={visible}>
      <Text>{label}</Text>
    </Presence>
  );

  it('draws nothing until it is wanted', async () => {
    const view = await render(control(false));
    expect(view.toJSON()).toBeNull();

    await view.rerender(control(true));
    expect(screen.getByText('Editing message')).toBeTruthy();
  });

  it('is gone to touch and to a screen reader at once, and unmounts when the exit ends', async () => {
    const view = await render(control(true));
    await view.rerender(control(false));

    // Still drawn — that is the exit — but not as something you can reach.
    expect(screen.queryByText('Editing message')).toBeNull();
    expect(
      screen.getByText('Editing message', { includeHiddenElements: true })
    ).toBeTruthy();

    await waitFor(() => expect(view.toJSON()).toBeNull());
  });

  it('keeps drawing what it held while it leaves, not what replaced it', async () => {
    // The edit bar quotes the message being edited, which is null by now.
    const view = await render(control(true, 'the original'));
    await view.rerender(control(false, ''));
    expect(
      screen.getByText('the original', { includeHiddenElements: true })
    ).toBeTruthy();
  });

  it('survives being wanted again halfway out', async () => {
    const view = await render(control(true));
    await view.rerender(control(false));
    await view.rerender(control(true));

    // Long enough for the abandoned exit to have unmounted it, had it run on.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, motion.DURATION.base * 2));
    });
    expect(screen.getByText('Editing message')).toBeTruthy();
  });

  it('is a plain conditional under Reduce Motion', async () => {
    await setReduceMotion(true);
    const view = await render(control(true));
    await view.rerender(control(false));
    expect(view.toJSON()).toBeNull();
  });
});

it('still opens the reactors sheet from a pill', async () => {
  // The pill grew an animated wrapper; the press has to reach through it.
  const onShowReactors = jest.fn();
  await render(bubble({ message: message({ reactions: [thumbs(1)] }), onShowReactors }));
  await fireEvent.press(screen.getByLabelText(/^👍, 1/));
  expect(onShowReactors).toHaveBeenCalledTimes(1);
});
