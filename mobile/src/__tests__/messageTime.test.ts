/**
 * The clock time on a chat bubble (Phase 9b M5).
 *
 * The hour format is deliberately the platform's rather than ours — it's the
 * most obviously *wrong-looking* thing you can impose on someone — so all this
 * function does is normalise what comes back. Which makes the shapes it can come
 * back in the whole test: the platform is stubbed here rather than the locale,
 * because a test that leans on the runner's own ICU data asserts something
 * different on every machine.
 */

import { formatMessageTime } from '@/utils';

const AT = '2026-07-28T09:02:00Z';

/** Stand in for the platform's answer, whatever locale it came from. */
function platformSays(formatted: string) {
  return jest
    .spyOn(Date.prototype, 'toLocaleTimeString')
    .mockReturnValue(formatted);
}

afterEach(() => {
  jest.restoreAllMocks();
});

it('pads the hour on a 24-hour clock', () => {
  // Nothing else disambiguates 9 from 21, so the zero earns its place.
  platformSays('9:02');
  expect(formatMessageTime(AT)).toBe('09:02');
});

it('leaves a 24-hour clock alone once it is two digits', () => {
  platformSays('14:32');
  expect(formatMessageTime(AT)).toBe('14:32');
});

it('lowercases a meridiem and drops the padding with it', () => {
  // The two conventions want opposite things about the leading zero: "9:02 am"
  // reads right where the meridiem does the work, "09:02" where nothing does.
  platformSays('9:02 AM');
  expect(formatMessageTime(AT)).toBe('9:02 am');
});

it('handles the dotted meridiem some locales write', () => {
  // The regression. Matching only "AM" sends en-CA down the *other* branch, so
  // the time comes back zero-padded and still dotted: "09:02 a.m.".
  platformSays('9:02 a.m.');
  expect(formatMessageTime(AT)).toBe('9:02 am');
});

it('leaves a leading meridiem exactly as the platform wrote it', () => {
  // ko-KR puts the marker in front. There's no zero to pad and nothing to
  // normalise — rewriting it would only be a chance to get someone's language
  // wrong.
  platformSays('오전 9:02');
  expect(formatMessageTime(AT)).toBe('오전 9:02');
});
