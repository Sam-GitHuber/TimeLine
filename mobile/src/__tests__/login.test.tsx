/**
 * Component tests for the login screen.
 *
 * These drive the real `AuthProvider` with only `fetch` faked, so they cover the
 * screen *and* the wiring underneath it — which is where the interesting bugs
 * live (a form that submits but never updates auth state looks fine in a
 * screen-only test).
 *
 * **Note the `await`s on `render` and `fireEvent`.** React Native Testing
 * Library v14 made both async by default; without the await, `screen` throws
 * "`render` function has not been called" and events silently don't land. Most
 * tutorials still show the synchronous v13 form.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';

import LoginScreen from '@/app/login';
import { AuthProvider } from '@/auth';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function renderLogin() {
  return render(
    <AuthProvider>
      <LoginScreen />
    </AuthProvider>
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

it('disables the button until both fields are filled', async () => {
  await renderLogin();
  const button = screen.getByRole('button', { name: 'Log in' });

  expect(button).toBeDisabled();

  await fireEvent.changeText(
    screen.getByLabelText('Email'),
    'ada@example.com'
  );
  expect(button).toBeDisabled();

  await fireEvent.changeText(screen.getByLabelText('Password'), 'hunter2');
  expect(button).not.toBeDisabled();
});

it('logs in with the entered credentials', async () => {
  mockFetch.mockResolvedValue(
    jsonResponse({
      access: 'access-1',
      refresh: 'refresh-1',
      user: { pk: 1, display_name: 'Ada Lovelace', email: 'ada@example.com' },
    })
  );
  await renderLogin();

  await fireEvent.changeText(
    screen.getByLabelText('Email'),
    '  ada@example.com  '
  );
  await fireEvent.changeText(screen.getByLabelText('Password'), 'hunter2');
  await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toContain('/api/auth/mobile/login/');
  const body = JSON.parse(init.body);
  // Trimmed — a keyboard autocapitalise/space must not cause a login failure.
  expect(body.email).toBe('ada@example.com');
  expect(body.password).toBe('hunter2');
});

it('shows the server message when login is refused', async () => {
  // The real messages matter to a tester: "awaiting approval" and "verify your
  // email" are both expected states in this beta, not just wrong passwords.
  mockFetch.mockResolvedValue(
    jsonResponse(
      {
        non_field_errors: [
          'Please verify your email address before logging in.',
        ],
      },
      400
    )
  );
  await renderLogin();

  await fireEvent.changeText(
    screen.getByLabelText('Email'),
    'ada@example.com'
  );
  await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
  await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));

  expect(
    await screen.findByText(
      'Please verify your email address before logging in.'
    )
  ).toBeTruthy();
});

it('re-enables the button after a failed attempt so you can try again', async () => {
  mockFetch.mockResolvedValue(jsonResponse({ detail: 'Nope.' }, 400));
  await renderLogin();

  await fireEvent.changeText(
    screen.getByLabelText('Email'),
    'ada@example.com'
  );
  await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
  await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));

  await screen.findByText('Nope.');
  expect(screen.getByRole('button', { name: 'Log in' })).not.toBeDisabled();
});
