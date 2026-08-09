/**
 * Tests for the fetch wrapper — the auth spine.
 *
 * The refresh path is the part worth testing hardest: it's invisible when it
 * works, and when it breaks it logs people out at random, which is exactly the
 * failure that would stop push notifications arriving (the point of Phase 9).
 */

import { api, ApiError, serverMessage, setSessionExpiredHandler } from '@/api';
import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from '@/tokens';

const BASE = 'https://your-timeline.net';

/** Build a `fetch`-shaped response. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const mockFetch = jest.fn();

beforeEach(async () => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  setSessionExpiredHandler(() => {});
  // Start every test logged out, explicitly.
  //
  // `tokens.ts` keeps the access token in a module-level cache (so the fetch
  // wrapper and every image in the feed don't each pay a Keychain round-trip),
  // and module state outlives an individual test. Without this, a test that
  // saves a token silently arms the next one, and a test asserting "no token"
  // would be passing on residue rather than on its own setup.
  await clearTokens();
});

describe('authenticated requests', () => {
  it('attaches the access token as a Bearer header', async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ pk: 1 }));

    await api.getCurrentUser();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/auth/user/`);
    expect(init.headers.Authorization).toBe('Bearer access-1');
  });

  it('sends no Authorization header when there is no token', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ pk: 1 }));

    await api.getCurrentUser();

    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('surfaces the API error message from a DRF `detail` body', async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: 'Not found.' }, 404)
    );

    await expect(api.getCurrentUser()).rejects.toThrow('Not found.');
  });
});

/**
 * The ordinary request path's own network guard (#243).
 *
 * The refresh path got this in #245; `request` itself did not, so every one of
 * the ~35 screens rendering a rejection got React Native's `Network request
 * failed` — an `Error` with a `message`, which sailed straight through the
 * `err instanceof Error ? err.message : 'our sentence'` those screens were
 * written with, and made the authored sentence unreachable by construction.
 */
describe('a request that never reaches the server', () => {
  it('re-raises the bare TypeError as an ApiError, keeping the cause', async () => {
    const cause = new TypeError('Network request failed');
    mockFetch.mockRejectedValueOnce(cause);

    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      'Couldn’t reach the server — check your connection and try again.'
    );
    // `status: 0` — no response arrived, so there is no HTTP status to report.
    expect((err as ApiError).status).toBe(0);
    // The flag the whole fix rests on: the sentence above is ours, so a call
    // site with its own more specific copy still gets to use it.
    expect((err as ApiError).fromServer).toBe(false);
    expect((err as ApiError).cause).toBe(cause);
  });

  it('does the same for a write, not just a read', async () => {
    // Writes are the half that matters: a failed GET shows a "couldn't load"
    // card, but a failed POST is where someone has to decide whether to press
    // the button again.
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

    await expect(api.changePassword('old', 'new', 'new')).rejects.toMatchObject({
      status: 0,
      fromServer: false,
    });
  });

  it('covers a connection that dies while the body is being read', async () => {
    // The second place it can happen: the headers arrived, the rest didn't.
    // `response.text()` rejects as a bare TypeError exactly as `fetch` does.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => {
        throw new TypeError('Network request failed');
      },
    });

    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fromServer).toBe(false);
    // The status survives: the server did answer, and a screen asking
    // `err.status === 404` is entitled to a true answer.
    expect((err as ApiError).status).toBe(404);
  });

  it('lets a bad request body throw as itself, not as a lost connection', async () => {
    // #244's lesson, and the reason the body is serialized above the `try`: a
    // `JSON.stringify` that throws is a bug in our code. Dressed up as a
    // connection problem it would send someone to check their signal over a
    // mistake at the call site.
    // A BigInt is the cheapest thing `JSON.stringify` refuses outright.
    const err = await api
      .changePassword(1n as never, 'new-pw', 'new-pw')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('serverMessage', () => {
  it('prefers the caller’s sentence over a lost connection', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(serverMessage(err, 'Couldn’t save your profile.')).toBe(
      'Couldn’t save your profile.'
    );
  });

  it('prefers the caller’s sentence over our "Request failed (500)" stand-in', async () => {
    // The second leak: a 500 rendered as a Django HTML page has no DRF body, so
    // `request` synthesizes a status-shaped string. It is an `ApiError` *and*
    // has a `message`, so only `fromServer` keeps it off the screen.
    mockFetch.mockResolvedValueOnce(jsonResponse('<html>500</html>', 500));
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect((err as ApiError).message).toBe('Request failed (500)');
    expect(serverMessage(err, 'Couldn’t save your profile.')).toBe(
      'Couldn’t save your profile.'
    );
  });

  it('shows the server’s own words when the server wrote some', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: 'Your old password was entered incorrectly.' }, 400)
    );
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(serverMessage(err, 'Couldn’t change your password.')).toBe(
      'Your old password was entered incorrectly.'
    );
  });

  it('falls back when the server authored an empty sentence', async () => {
    // `fromServer` says the server wrote the words, not that it wrote any. A
    // serializer raising `ValidationError('')` is server-authored and blank, and
    // without the truthiness check every call site renders a blank red line —
    // or an `Alert` with a title and no body. Worse than the fallback it
    // displaced, and silent. `frontend/src/errors.js` has always checked this.
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: '' }, 400));
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(serverMessage(err, 'Couldn’t save your profile.')).toBe(
      'Couldn’t save your profile.'
    );
  });

  it('never shows the literal word "undefined" as the server’s diagnosis', async () => {
    // `String(value[0])` on an empty list yields `'undefined'`, which the old
    // `firstErrorMessage` then flagged `fromServer: true` — the runtime's words
    // wearing the server's badge, which is the whole thing #243 is about.
    mockFetch.mockResolvedValueOnce(jsonResponse({ non_field_errors: [] }, 400));
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect((err as ApiError).fromServer).toBe(false);
    expect(serverMessage(err, 'Couldn’t save your profile.')).toBe(
      'Couldn’t save your profile.'
    );
  });

  it('takes a null fallback, for a caller that picks its wording later', async () => {
    // `groups/[groupId]/invite.tsx` needs "the server's words, or nothing" so it
    // can choose between a per-invite reason and its own batch sentence.
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));
    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(serverMessage(err, null)).toBeNull();
  });
});

describe('silent refresh', () => {
  it('refreshes on a 401 and replays the request', async () => {
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access: 'access-2', refresh: 'refresh-2' })
      )
      .mockResolvedValueOnce(jsonResponse({ pk: 7, email: 'a@b.c' }));

    const user = await api.getCurrentUser();

    expect(user).toEqual({ pk: 7, email: 'a@b.c' });
    // The replay carries the *new* token, not the stale one.
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe(
      'Bearer access-2'
    );
  });

  it('stores the rotated refresh token, not just the access token', async () => {
    // Rotation + BLACKLIST_AFTER_ROTATION means the old refresh token is dead
    // the moment it's used. Keeping it would log the user out at the next
    // refresh — silently, hours later.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access: 'access-2', refresh: 'refresh-2' })
      )
      .mockResolvedValueOnce(jsonResponse({ pk: 7 }));

    await api.getCurrentUser();

    expect(await getAccessToken()).toBe('access-2');
    expect(await getRefreshToken()).toBe('refresh-2');
  });

  it('collapses parallel 401s into a single refresh (no stampede)', async () => {
    // Three screens firing at once all 401. Without the single-flight guard the
    // first refresh blacklists the token the other two are holding, and two of
    // the three log the user out.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    mockFetch.mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/api/auth/mobile/refresh/')) {
        return jsonResponse({ access: 'access-2', refresh: 'refresh-2' });
      }
      if (init.headers.Authorization === 'Bearer stale') {
        return jsonResponse(null, 401);
      }
      return jsonResponse({ pk: 7 });
    });

    const results = await Promise.all([
      api.getCurrentUser(),
      api.getCurrentUser(),
      api.getCurrentUser(),
    ]);

    expect(results).toHaveLength(3);
    const refreshCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.endsWith('/api/auth/mobile/refresh/')
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it('clears tokens and signals session-expired when the server refuses the refresh token', async () => {
    await saveTokens({ access: 'stale', refresh: 'dead' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: 'blacklisted' }, 401));

    await expect(api.getCurrentUser()).rejects.toBeInstanceOf(ApiError);

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
  });

  it('keeps the session when the refresh request never reaches the server', async () => {
    // The reported failure (#245): the access token has expired, so the first
    // request 401s — proving the network was up a moment ago — and then the
    // refresh lands in a tunnel. The server has said nothing about this token,
    // so wiping a still-valid 90-day refresh token would cost the user their
    // password for what a dropped packet did.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockRejectedValueOnce(new TypeError('Network request failed'));

    await expect(api.getCurrentUser()).rejects.toMatchObject({
      status: 0,
      fromServer: false,
    });

    expect(onExpired).not.toHaveBeenCalled();
    expect(await getAccessToken()).toBe('stale');
    expect(await getRefreshToken()).toBe('refresh-1');
  });

  it('reports a lost connection in our words, keeping the cause for debugging', async () => {
    // React Native's own `Network request failed` names no cause and suggests
    // no action, and it's what ~25 call sites would render (#243). The original
    // TypeError travels as `cause` — no use to a user, the only thing that says
    // *why* when debugging.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const cause = new TypeError('Network request failed');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockRejectedValueOnce(cause);

    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      'Couldn’t reach the server — check your connection and try again.'
    );
    expect((err as ApiError).cause).toBe(cause);
  });

  it('keeps the session when the refresh endpoint 5xxs', async () => {
    // The box redeploys and Caddy answers 502 for a few seconds. That is the
    // server being unwell, not the server refusing this token — and a release
    // must not sign every phone out.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(null, 502));

    await expect(api.getCurrentUser()).rejects.toBeInstanceOf(ApiError);

    expect(onExpired).not.toHaveBeenCalled();
    expect(await getRefreshToken()).toBe('refresh-1');
  });

  it('does not tell a screen the session expired when it was the server that failed', async () => {
    // This one *reaches* a call site, unlike the refusal message `request`
    // replaces. "Session expired" during a deploy would be a lie told to every
    // phone at once, on the screen the user was already looking at — and
    // `fromServer: false` is what keeps it there rather than on screen.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(null, 503));

    const err = await api.getCurrentUser().catch((e: unknown) => e);

    expect((err as ApiError).message).toBe(
      'Something went wrong on the server — please try again in a moment.'
    );
    expect((err as ApiError).fromServer).toBe(false);
  });

  it('ends the session when the refresh endpoint 400s on the body it was sent', async () => {
    // The other half of a refusal: simplejwt answers 400 when it can't read the
    // request, and the device has nothing usable either way. Without this the
    // 400 arm of `isRefusalStatus` could be deleted and the suite stay green.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({ refresh: ['This field is required.'] }, 400));

    await expect(api.getCurrentUser()).rejects.toThrow(
      'Your session has expired. Please log in again.'
    );

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
  });

  it('keeps the session when a 200 carries something other than the token pair', async () => {
    // A captive portal answering with its own login page: a connection problem
    // wearing a success status. Unguarded, the JSON parse throws and the catch
    // reads it as a refused token — the same sign-out by a different door.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch.mockResolvedValueOnce(jsonResponse(null, 401)).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html>Sign in to WiFi</html>',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    await expect(api.getCurrentUser()).rejects.toMatchObject({ status: 0 });

    expect(onExpired).not.toHaveBeenCalled();
    expect(await getRefreshToken()).toBe('refresh-1');
  });

  it('does not end the session for any of the parallel 401s during a blink', async () => {
    // The stampede guard shares one refresh between every request that 401s, so
    // one blink is one failure — but it's handed to all three callers, and any
    // one of them clearing the tokens would sign the other two out too.
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/auth/mobile/refresh/')) {
        throw new TypeError('Network request failed');
      }
      return jsonResponse(null, 401);
    });

    const results = await Promise.allSettled([
      api.getCurrentUser(),
      api.getCurrentUser(),
      api.getCurrentUser(),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();
    expect(await getRefreshToken()).toBe('refresh-1');
  });

  it('retries only once, so a server that always 401s cannot loop', async () => {
    await saveTokens({ access: 'stale', refresh: 'refresh-1' });
    mockFetch.mockImplementation(async (url: string) =>
      url.endsWith('/api/auth/mobile/refresh/')
        ? jsonResponse({ access: 'access-2', refresh: 'refresh-2' })
        : jsonResponse(null, 401)
    );

    await expect(api.getCurrentUser()).rejects.toBeInstanceOf(ApiError);

    // original + refresh + one replay, then it gives up.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not try to refresh when there was never a token', async () => {
    // An anonymous 401 is a real answer, not an expired session.
    const onExpired = jest.fn();
    setSessionExpiredHandler(onExpired);
    mockFetch.mockResolvedValueOnce(jsonResponse(null, 401));

    await expect(api.getCurrentUser()).rejects.toBeInstanceOf(ApiError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('hits the mobile endpoint and stores both tokens', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access: 'access-1',
        refresh: 'refresh-1',
        user: { pk: 3, display_name: 'Ada Lovelace' },
      })
    );

    const user = await api.login('ada@example.com', 'hunter2');

    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/auth/mobile/login/`);
    expect(user.display_name).toBe('Ada Lovelace');
    expect(await getAccessToken()).toBe('access-1');
    expect(await getRefreshToken()).toBe('refresh-1');
  });

  it('stores nothing when the credentials are rejected', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ non_field_errors: ['Unable to log in.'] }, 400)
    );

    await expect(api.login('ada@example.com', 'wrong')).rejects.toThrow(
      'Unable to log in.'
    );

    expect(await getAccessToken()).toBeNull();
  });
});

describe('logout', () => {
  it('blacklists the refresh token server-side, then wipes the device', async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockFetch.mockResolvedValueOnce(jsonResponse(null, 200));

    await api.logout();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/auth/mobile/logout/`);
    expect(JSON.parse(init.body)).toEqual({ refresh: 'refresh-1' });
    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
  });

  it('does not refresh on the way out, so the live token really is blacklisted', async () => {
    // With an expired access token, a retrying logout would rotate the refresh
    // token first and then post the stale one — leaving the new token valid on
    // the server while the device wiped it. Exactly one call, no refresh.
    await saveTokens({ access: 'expired', refresh: 'refresh-1' });
    mockFetch.mockResolvedValue(jsonResponse(null, 401));

    await api.logout();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/auth/mobile/logout/`);
  });

  it('still clears the device when the blacklist call fails', async () => {
    // Losing signal must never trap someone in a logged-in app.
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
    mockFetch.mockRejectedValueOnce(new Error('offline'));

    await api.logout();

    expect(await getAccessToken()).toBeNull();
    expect(await getRefreshToken()).toBeNull();
  });
});

describe('createPost multipart body', () => {
  /**
   * A stand-in for `FormData` that keeps what was appended — name, value, and
   * the optional filename third argument.
   *
   * Needed because the *shape of the parts* is the thing worth pinning here, and
   * the spec `FormData` Jest runs against doesn't expose its parts. And the
   * shape matters: Expo SDK 54+ swapped the global `fetch` for its winter
   * runtime, whose serializer **rejects** the old React Native `{uri,name,type}`
   * part with `Unsupported FormDataPart implementation`, and also can't build a
   * React Native `Blob` from bytes. The shape it *does* serialise is an object
   * exposing `.bytes()` (its "FileBlob" case), carrying `name` (→ filename) and
   * `type` (→ content-type). So each file part must arrive in that shape.
   */
  class RecordingFormData {
    parts: [string, unknown][] = [];
    append(name: string, value: unknown) {
      this.parts.push([name, value]);
    }
  }

  const realFormData = globalThis.FormData;

  beforeEach(() => {
    globalThis.FormData = RecordingFormData as unknown as typeof FormData;
  });

  afterEach(() => {
    globalThis.FormData = realFormData;
  });

  function partsOf(body: unknown): [string, unknown][] {
    return (body as RecordingFormData).parts;
  }

  /** The winter "FileBlob" contract: `.bytes()` for the payload, name + type. */
  function expectFilePart(part: unknown, name: string, type: string) {
    const filePart = part as { bytes: () => Uint8Array; name: string; type: string };
    expect(typeof filePart.bytes).toBe('function');
    expect(filePart.bytes()).toBeInstanceOf(Uint8Array);
    expect(filePart.name).toBe(name);
    expect(filePart.type).toBe(type);
  }

  it('appends each photo as a bytes()-shaped part with filename and content-type', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.createPost('A day out', [
      { uri: 'file:///tmp/a.jpg', name: 'a.jpg', type: 'image/jpeg' },
      { uri: 'file:///tmp/b.png', name: 'b.png', type: 'image/png' },
    ]);

    const parts = partsOf(mockFetch.mock.calls[0][1].body);
    expect(parts[0]).toEqual(['text', 'A day out']);

    // Repeated `images` parts is the shape `PostCreateView` expects, and each
    // one is a FileBlob — the winter fetch runtime would throw on the old
    // {uri,name,type} object.
    const images = parts.filter(([name]) => name === 'images');
    expect(images).toHaveLength(2);
    expectFilePart(images[0][1], 'a.jpg', 'image/jpeg');
    expectFilePart(images[1][1], 'b.png', 'image/png');
  });

  it('posts text with no images when there are no photos', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.createPost('Just words');

    expect(partsOf(mockFetch.mock.calls[0][1].body)).toEqual([
      ['text', 'Just words'],
    ]);
  });

  it('uploads a profile avatar as a FileBlob, not a {uri} object', async () => {
    // The reported failure: a {uri,name,type} avatar part made the winter fetch
    // runtime throw `Unsupported FormDataPart implementation`.
    mockFetch.mockResolvedValueOnce(jsonResponse({ pk: 1 }));

    await api.updateProfile({
      first_name: 'Alice',
      avatar: { uri: 'file:///tmp/av.jpg', name: 'av.jpg', type: 'image/jpeg' },
    });

    const parts = partsOf(mockFetch.mock.calls[0][1].body);
    expect(parts).toContainEqual(['first_name', 'Alice']);
    const avatar = parts.find(([name]) => name === 'avatar');
    expectFilePart(avatar?.[1], 'av.jpg', 'image/jpeg');
  });

  it('sends a chat photo as parallel multipart lists (M7)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.sendMessage(5, 'look at this', null, {
      photo: { uri: 'file:///tmp/p.jpg', name: 'photo-1.jpg', type: 'image/jpeg' },
      thumbnail: {
        uri: 'file:///tmp/t.jpg',
        name: 'thumb-1.jpg',
        type: 'image/jpeg',
      },
      width: 1600,
      height: 1200,
    });

    const parts = partsOf(mockFetch.mock.calls[0][1].body);
    expect(parts).toContainEqual(['text', 'look at this']);
    // Plural names carrying one entry each: the server takes a list (capped at
    // one for now), so allowing several photos per message later is a server
    // constant rather than a change to the wire shape.
    expectFilePart(
      parts.find(([name]) => name === 'attachments')?.[1],
      'photo-1.jpg',
      'image/jpeg'
    );
    expectFilePart(
      parts.find(([name]) => name === 'attachment_thumbnails')?.[1],
      'thumb-1.jpg',
      'image/jpeg'
    );
    // The dimensions travel because the server never opens the file to measure
    // it — they're what the bubble reserves its space from.
    expect(parts).toContainEqual(['attachment_widths', '1600']);
    expect(parts).toContainEqual(['attachment_heights', '1200']);
  });

  it('sends a photo with no caption as a blank text part, not a missing one', async () => {
    // Blank is legal *with* a photo and only then. Omitting the field entirely
    // would leave the server's `text` unset rather than empty.
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.sendMessage(5, '', null, {
      photo: { uri: 'file:///tmp/p.jpg', name: 'p.jpg', type: 'image/jpeg' },
      thumbnail: { uri: 'file:///tmp/t.jpg', name: 't.jpg', type: 'image/jpeg' },
      width: 100,
      height: 100,
    });

    expect(partsOf(mockFetch.mock.calls[0][1].body)).toContainEqual(['text', '']);
  });

  it('sends a text-only message as JSON, not multipart', async () => {
    // The overwhelmingly common case must not pay for the photo path.
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.sendMessage(5, 'just words');

    expect(mockFetch.mock.calls[0][1].headers['Content-Type']).toBe(
      'application/json'
    );
  });

  it('lets the runtime set the multipart Content-Type, boundary and all', async () => {
    // Setting it by hand omits the boundary, and the server can then parse none
    // of the parts.
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }, 201));

    await api.createPost('Hello');

    expect(mockFetch.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
  });
});

describe('connections (E1)', () => {
  beforeEach(async () => {
    await saveTokens({ access: 'access-1', refresh: 'refresh-1' });
  });

  it('lists connections and discover with the right filter param', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 0, next: null, results: [] }));

    await api.listConnections();
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/users/?filter=connected`);

    await api.listDiscover();
    expect(mockFetch.mock.calls[1][0]).toBe(`${BASE}/api/users/?filter=discover`);
  });

  it('connects with a POST and disconnects with a DELETE on the same URL', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));

    await api.connect(42);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/users/42/connect/`);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');

    await api.disconnect(42);
    expect(mockFetch.mock.calls[1][0]).toBe(`${BASE}/api/users/42/connect/`);
    expect(mockFetch.mock.calls[1][1].method).toBe('DELETE');
  });

  it('approves and rejects a request by the Connection row id, via POST', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));

    await api.approveRequest(7);
    expect(mockFetch.mock.calls[0][0]).toBe(
      `${BASE}/api/connection-requests/7/approve/`
    );
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');

    await api.rejectRequest(7);
    expect(mockFetch.mock.calls[1][0]).toBe(
      `${BASE}/api/connection-requests/7/reject/`
    );
    expect(mockFetch.mock.calls[1][1].method).toBe('POST');
  });

  it('fetches the disconnect impact as a plain GET', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ chats: [] }));

    await api.getDisconnectImpact(42);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `${BASE}/api/users/42/disconnect-impact/`
    );
    // No method override means GET.
    expect(mockFetch.mock.calls[0][1].method).toBe('GET');
  });
});

describe('token storage', () => {
  it('round-trips and clears', async () => {
    await saveTokens({ access: 'a', refresh: 'r' });
    expect(await getAccessToken()).toBe('a');
    await clearTokens();
    expect(await getAccessToken()).toBeNull();
  });
});
