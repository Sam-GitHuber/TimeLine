/**
 * The notification service extension's contract with everything around it
 * (Phase 10b, M3).
 *
 * **Why a test suite reads a Swift file as text.** The extension is a separate
 * native process. Jest can't run it, the Simulator can't easily be made to
 * deliver it a push, and — this is the part that matters — *every* way it can be
 * wrong looks identical from outside: the fallback discipline means a broken
 * extension delivers exactly the notification a working one would have delivered
 * before 10b. Nothing crashes, nothing logs, no test goes red. Previews just
 * never appear, on every device, forever.
 *
 * So the failures worth guarding are the ones where two sides stop agreeing,
 * and all of them are string equality between files that no compiler compares:
 *
 *   - the keychain key and service, against `previewCredential.ts`;
 *   - the URL path, against the backend's route;
 *   - the auth scheme keyword, against `push_preview.py`;
 *   - the deep-link prefix, against `conversationIdFromUrl`;
 *   - the Info.plist key, against the plugin that writes it;
 *   - the extension's bundle id and entitlements, between the plugin (which
 *     builds the target) and `app.json` (which is how EAS learns the target
 *     exists at all, fifteen minutes before it would otherwise fail).
 *
 * These are cheap, and they are the whole of what is checkable here. What they
 * cannot tell you is whether the extension *runs* — that is the device matrix in
 * the phase doc, and there is no substitute for it.
 *
 * Like `appIcons.test.ts`, this reads files off disk and has nothing
 * platform-specific to say, so both Jest projects run it for an identical
 * result.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PREVIEW_CREDENTIAL_KEY,
  PREVIEW_KEYCHAIN_SERVICE,
} from '@/previewCredential';

const MOBILE_ROOT = join(__dirname, '..', '..');

const swift = readFileSync(
  join(MOBILE_ROOT, 'plugins', 'notification-service', 'NotificationService.swift'),
  'utf8'
);
const plugin = readFileSync(
  join(MOBILE_ROOT, 'plugins', 'withNotificationService.ts'),
  'utf8'
);
const appJson = JSON.parse(readFileSync(join(MOBILE_ROOT, 'app.json'), 'utf8'));

/**
 * The Swift with its comment lines removed.
 *
 * Needed by the two assertions below that check a thing is **absent**, because
 * the file explains at length *why* `kSecAttrAccessGroup` and `Bearer` aren't
 * there — and a bare `not.toContain` reads those explanations as violations.
 * Whole-line comments only: a `//` mid-line is inside a URL string, never a
 * comment, in this file.
 */
const swiftCode = swift
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** The value of a `private static let <name> = "…"` in the Swift. */
function swiftConstant(name: string): string | null {
  const match = swift.match(
    new RegExp(`private static let ${name}\\s*=\\s*"([^"]*)"`)
  );
  return match ? match[1] : null;
}

describe('the keychain query', () => {
  it('looks under the key the app writes', () => {
    // `kSecAttrAccount`/`kSecAttrGeneric` are the bytes of this string. A
    // mismatch is `errSecItemNotFound` on every push on every device, which the
    // extension cannot tell apart from a missing entitlement.
    expect(swiftConstant('credentialKey')).toBe(PREVIEW_CREDENTIAL_KEY);
  });

  it('names the service including the suffix SecureStore appends', () => {
    // `SecureStoreModule.swift`'s `query()` appends `:no-auth` when
    // `requireAuthentication` is false, which is what `previewCredential.ts`
    // stores under. The pinned half is ours; the suffix is expo's, and the
    // reason the service is pinned at all is so only the suffix is theirs.
    expect(swiftConstant('credentialService')).toBe(
      `${PREVIEW_KEYCHAIN_SERVICE}:no-auth`
    );
  });

  it('passes the key as bytes rather than as a String', () => {
    // The single most likely way to write this wrong. `SecureStore` stores
    // `Data(key.utf8)` in both attributes; the obvious Swift passes the
    // `String` and matches nothing.
    expect(swift).toContain('let key = Data(credentialKey.utf8)');
    expect(swift).toContain('kSecAttrGeneric as String: key');
    expect(swift).toContain('kSecAttrAccount as String: key');
  });

  it('names no access group, so every entitled group is searched', () => {
    // Omitting `kSecAttrAccessGroup` is what lets the extension reach the item
    // the app wrote into the app's own group. Naming a group here would have to
    // name the Team ID, which is the thing M2 chose this design to avoid.
    expect(swiftCode).not.toContain('kSecAttrAccessGroup');
  });
});

describe('the request', () => {
  it('asks the endpoint the backend actually serves', () => {
    // `backend/api/urls.py`: conversations/<int:pk>/push-preview/
    expect(swift).toContain('/api/conversations/\\(conversationId)/push-preview/');
  });

  it('uses the Preview scheme, not Bearer', () => {
    // `push_preview.py` deliberately picks a keyword that isn't `Bearer`, so
    // the account's own token can't be used here and this one can't be used
    // anywhere else. Sending `Bearer` would 401 every time.
    expect(swift).toContain('"Preview \\(credential)"');
    expect(swiftCode).not.toContain('Bearer');
  });

  it('reads the conversation id from the same url the deep link uses', () => {
    // Expo nests the app's `data` under `body` in the APNs payload, which is
    // where `expo-notifications` reads it from too. And the push carries no
    // separate conversation field to fall out of step with the route — see
    // `conversationIdFromUrl`.
    expect(swift).toContain('userInfo["body"] as? [String: Any]');
    expect(swift).toContain('let prefix = "/messages/"');
  });

  it('takes the finished body rather than assembling one', () => {
    // Composition is server-side on purpose: an extension building a body from
    // parts renders a blank line for an uncaptioned photo and "Ada in " for
    // every one-to-one. If this ever reads a second field, that decision has
    // been quietly reversed.
    expect(swift).toContain('json["body"] as? String');
    expect(swift).toContain('bestAttempt.body = body');
  });

  it('changes nothing unless the server answered 200 with a body', () => {
    // Includes the 204 the endpoint returns when there is nothing this person
    // may be shown. Keeping the server's contentless body is right there.
    expect(swift).toContain('http.statusCode == 200');
    expect(swift).toContain('!body.isEmpty');
  });
});

describe('the fallback discipline', () => {
  it('answers the system when iOS is about to kill the process', () => {
    // Apple's contract: a `serviceExtensionTimeWillExpire` that doesn't call
    // the handler gets the notification *dropped*, not delayed.
    expect(swift).toContain('override func serviceExtensionTimeWillExpire()');
  });

  it('cannot call the content handler twice', () => {
    // Two paths race to deliver — the response callback and the expiry hook —
    // and calling a `contentHandler` twice is undefined behaviour. Clearing it
    // first is what makes the loser a no-op.
    expect(swift).toContain('self.contentHandler = nil');
  });
});

describe('what the extension may write down', () => {
  it('logs nothing at all', () => {
    // Everything in this process is either a credential or somebody's private
    // message, and the ordinary way to debug an extension is to print things
    // and read Console.app — which anything on the attached Mac can also read.
    // `tokens.ts` states this rule for JavaScript; it binds harder here.
    for (const call of ['os_log', 'NSLog', 'print(', 'debugPrint', 'dump(']) {
      expect(swift).not.toContain(call);
    }
  });

  it('keeps nothing on disk from the request', () => {
    // No cookie store, no URL cache, no credential storage.
    expect(swift).toContain('URLSession(configuration: .ephemeral)');
  });
});

describe('the backend URL', () => {
  it('reads the Info.plist key the plugin writes', () => {
    const key = swiftConstant('apiUrlInfoPlistKey');
    expect(key).toBeTruthy();
    expect(plugin).toContain(`const API_URL_KEY = '${key}'`);
  });

  it('defaults to production, exactly as the app does', () => {
    // A native target can read neither `process.env` nor `Constants`, so the
    // plugin inlines `EXPO_PUBLIC_API_URL` at prebuild. Both sides need the
    // same default, or a build without a `.env` sends dev traffic to
    // production — which 401s and looks like a broken extension.
    expect(swiftConstant('defaultApiUrl')).toBe('https://your-timeline.net');
    expect(plugin).toContain("'https://your-timeline.net'");
  });
});

describe('the version keys', () => {
  it('come from the app config, not from the app target', () => {
    // The app target *has* MARKETING_VERSION and CURRENT_PROJECT_VERSION
    // settings and they look like the obvious source — but nothing reads them.
    // Expo writes CFBundleShortVersionString/CFBundleVersion straight into the
    // app's Info.plist from the config and never touches the build settings, so
    // copying them produced an extension stamped 1.0 inside an app stamped
    // 1.0.0. An extension whose version keys differ from its host's is rejected
    // at App Store Connect validation — after a fifteen-minute build and an
    // upload, in a message that names neither number.
    expect(plugin).toContain('IOSConfig.Version.getVersion(config)');
    expect(plugin).toContain('IOSConfig.Version.getBuildNumber(config)');
    expect(plugin).not.toContain("appTargetSetting(project, 'MARKETING_VERSION')");
    expect(plugin).not.toContain("appTargetSetting(project, 'CURRENT_PROJECT_VERSION')");
  });
});

describe('what EAS is told', () => {
  // EAS discovers app extensions from app.json, never from the `.pbxproj` this
  // plugin generates — it decides which provisioning profiles to fetch before
  // prebuild has run. Disagree with the plugin and the build dies ~15 minutes
  // in with "No profiles for '…NotificationService' were found".
  const declared = appJson.expo.extra.eas.build.experimental.ios.appExtensions;

  it('declares exactly the one extension the plugin builds', () => {
    expect(declared).toHaveLength(1);
    const targetName = plugin.match(/const TARGET_NAME = '([^']+)'/)?.[1];
    expect(targetName).toBeTruthy();
    expect(declared[0].targetName).toBe(targetName);
  });

  it('agrees with the plugin on the bundle identifier', () => {
    // The plugin builds `<app bundle id>.<target name>`; this is the literal
    // Apple issues an App ID for. A mismatch is a build that provisions the
    // wrong identifier.
    expect(declared[0].bundleIdentifier).toBe(
      `${appJson.expo.ios.bundleIdentifier}.${declared[0].targetName}`
    );
  });

  it('asks for the keychain group the plugin entitles', () => {
    // Both halves are needed and neither implies the other: the plugin writes
    // the entitlements file the compiler embeds, and this is what makes Apple
    // issue a profile that permits it. Ship one without the other and
    // `SecItemCopyMatching` returns -34018 forever, silently.
    const group = `$(AppIdentifierPrefix)${appJson.expo.ios.bundleIdentifier}`;
    expect(declared[0].entitlements['keychain-access-groups']).toEqual([group]);
    expect(plugin).toContain('$(AppIdentifierPrefix)${appBundleIdentifier}');
  });
});

describe('the plugin is registered', () => {
  it('runs on every prebuild', () => {
    // The native dirs are gitignored, so a plugin that isn't listed here simply
    // never runs and the extension silently isn't in the app.
    expect(appJson.expo.plugins).toContain('./plugins/withNotificationService');
  });
});
