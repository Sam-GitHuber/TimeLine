/**
 * Tests for the fetch wrapper — the auth spine.
 *
 * The refresh path is the part worth testing hardest: it's invisible when it
 * works, and when it breaks it logs people out at random, which is exactly the
 * failure that would stop push notifications arriving (the point of Phase 9).
 */

import { api, ApiError, setSessionExpiredHandler } from '@/api';
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

  it('clears tokens and signals session-expired when refresh fails', async () => {
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
