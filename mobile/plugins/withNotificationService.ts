/**
 * Add the iOS notification service extension to the generated Xcode project
 * (Phase 10b, M3).
 *
 * **Why a config plugin at all.** `mobile/ios` is gitignored — this is a
 * managed / CNG project, and `npx expo prebuild` recreates the Xcode project
 * from `app.json` every time. A target added by hand in Xcode survives exactly
 * until the next prebuild, which on EAS is every build. So the target has to be
 * *generated*, and this file is the generator.
 *
 * **Why local rather than a community plugin.** `expo-notifications` ships no
 * NSE support, and the third-party plugins that do would sit on the critical
 * path of every release of this app — an unmaintained one going stale is a
 * supply-chain risk on the one thing we can't ship without. This is a few
 * hundred lines of documented API against `xcode`, which Expo already depends
 * on, and it does nothing clever.
 *
 * **What it does, in order:** writes the extension's three files into the
 * generated project, creates an `app_extension` target for them, wires the
 * build settings Xcode would have filled in through its target template, and
 * writes the entitlement without which the extension cannot read the keychain.
 *
 * It is **idempotent**: a second prebuild over an existing project finds the
 * target already there and only refreshes the files. That matters because
 * `expo prebuild` without `--clean` is the normal local workflow.
 *
 * ⚠️ **EAS also needs to be told the target exists.** In a managed project EAS
 * discovers app extensions from `extra.eas.build.experimental.ios.appExtensions`
 * in `app.json`, not from the `.pbxproj` this file generates — it can't, because
 * the pbxproj doesn't exist until EAS has already decided which provisioning
 * profiles to fetch. Without that entry the build provisions the app alone and
 * dies about fifteen minutes in with "No profiles for
 * 'net.yourtimeline.app.NotificationService' were found". The two must agree on
 * the bundle identifier and on the entitlements; see `app.json`.
 */

import {
  ConfigPlugin,
  IOSConfig,
  withXcodeProject,
  type XcodeProject,
} from 'expo/config-plugins';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The target's name, its folder inside the Xcode project, and the last
 * component of its bundle identifier — all one string, because Xcode's own
 * template makes them one and every tool downstream assumes it.
 *
 * ⚠️ Changing this changes the extension's **bundle identifier**, which means a
 * new App ID and a new provisioning profile at Apple. Not a rename.
 */
const TARGET_NAME = 'NotificationService';

/** Where this plugin's copies of the extension's sources live in the repo. */
const SOURCE_DIR = path.join(__dirname, 'notification-service');

/** The Info.plist key the Swift reads its backend URL from. */
const API_URL_KEY = 'TimeLineApiUrl';

/**
 * Mirrors `src/api.ts`'s `BASE_URL`, and has to stay mirrored.
 *
 * `||` rather than `??` for the same reason it gives: a commented-out or blank
 * line in `.env` yields an empty string, and an empty base URL would send every
 * preview request to a relative path that goes nowhere — which in here surfaces
 * as previews silently never working rather than as an error.
 */
function apiUrl(): string {
  return process.env.EXPO_PUBLIC_API_URL || 'https://your-timeline.net';
}

/**
 * The extension's Info.plist.
 *
 * `NSExtensionPrincipalClass` uses `$(PRODUCT_MODULE_NAME)` rather than a
 * literal module name so it can't drift from `PRODUCT_NAME` below. The two
 * version keys read the build settings this plugin copies off the app target —
 * see `copyVersionFrom` for why they are copied rather than stated.
 *
 * `NSAllowsLocalNetworking` is the one deliberate ATS relaxation: it permits
 * cleartext to LAN addresses only, which is what a dev build pointed at a local
 * Django over `http://192.168.x.x` needs. Public HTTPS is unaffected, so
 * production is exactly as strict as it was.
 */
function infoPlist(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>${TARGET_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>${API_URL_KEY}</key>
	<string>${url}</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.usernotifications.service</string>
		<key>NSExtensionPrincipalClass</key>
		<string>$(PRODUCT_MODULE_NAME).${TARGET_NAME}</string>
	</dict>
</dict>
</plist>
`;
}

/**
 * The extension's entitlements — the single thing this whole milestone turns on.
 *
 * The extension's own App ID gives it the access group
 * `$(AppIdentifierPrefix)net.yourtimeline.app.NotificationService`, which is not
 * where the credential is: `previewCredential.ts` writes into the *app's* group,
 * with everything else the app stores. Listing the app's group here is what lets
 * `SecItemCopyMatching` reach it.
 *
 * `$(AppIdentifierPrefix)` is expanded by Xcode when it processes this file, so
 * the ten-character Team ID appears nowhere in the repo — which is the reason
 * M2 chose the app's own group over a separate shared one.
 *
 * Get this wrong and **nothing fails at build time**: the query returns
 * `errSecMissingEntitlement` (-34018) forever, the fallback discipline in the
 * Swift hides it, and previews simply never appear. It is indistinguishable
 * from a mismatched keychain query, so change one at a time.
 */
function entitlements(appBundleIdentifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>keychain-access-groups</key>
	<array>
		<string>$(AppIdentifierPrefix)${appBundleIdentifier}</string>
	</array>
</dict>
</plist>
`;
}

/**
 * Copy a build setting from the app target rather than restating it.
 *
 * Used for the deployment target, for a dull reason: an extension built against
 * a newer iOS than its host fails to install.
 *
 * ⚠️ **Not usable for the versions**, which is worth knowing because it looks as
 * though it should be. The app target *has* `MARKETING_VERSION` and
 * `CURRENT_PROJECT_VERSION` settings, but they are Xcode template leftovers that
 * nothing reads: Expo writes `CFBundleShortVersionString`/`CFBundleVersion`
 * straight into the app's Info.plist from the config and never touches the build
 * settings (`@expo/config-plugins`' `ios/Version.ts` mentions neither). Copying
 * them gave an extension stamped `1.0` inside an app stamped `1.0.0` — caught
 * here only because the built bundles were compared by hand. See
 * `versionsFromConfig` for what to use instead.
 */
function appTargetSetting(project: XcodeProject, name: string): string | undefined {
  const appTarget = project.getFirstTarget();
  const listUuid = appTarget.firstTarget.buildConfigurationList;
  const configurations = project.pbxXCBuildConfigurationSection();
  const lists = project.pbxXCConfigurationList();
  const configurationUuids: string[] = (
    lists[listUuid]?.buildConfigurations ?? []
  ).map((entry: { value: string }) => entry.value);

  for (const uuid of configurationUuids) {
    const value = configurations[uuid]?.buildSettings?.[name];
    if (value !== undefined) return String(value);
  }
  return undefined;
}

const withNotificationService: ConfigPlugin = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.platformProjectRoot;
    const appBundleIdentifier =
      config.ios?.bundleIdentifier ??
      IOSConfig.BundleIdentifier.getBundleIdentifier(config);

    if (!appBundleIdentifier) {
      throw new Error(
        '[withNotificationService] `ios.bundleIdentifier` is not set, so the ' +
          "extension has no identifier to hang off and no way to name the app's " +
          'keychain access group.'
      );
    }

    // 1. The files. Written on every prebuild, even when the target already
    //    exists, so editing the Swift in this repo and re-running prebuild does
    //    what you'd expect.
    const targetDir = path.join(projectRoot, TARGET_NAME);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(
      path.join(SOURCE_DIR, `${TARGET_NAME}.swift`),
      path.join(targetDir, `${TARGET_NAME}.swift`)
    );
    fs.writeFileSync(
      path.join(targetDir, `${TARGET_NAME}-Info.plist`),
      infoPlist(apiUrl())
    );
    fs.writeFileSync(
      path.join(targetDir, `${TARGET_NAME}.entitlements`),
      entitlements(appBundleIdentifier)
    );

    // 2. The target — but only once. `expo prebuild` without `--clean` runs
    //    over an existing project, and adding the target twice produces a
    //    pbxproj Xcode opens and then refuses to build, with an error naming
    //    neither this plugin nor the duplicate.
    if (project.pbxTargetByName(TARGET_NAME)) return config;

    // **The same two functions Expo's own Info.plist writer uses**, so the
    // extension's version keys cannot differ from the app's. Reading them from
    // the config rather than restating them is what survives
    // `appVersionSource: remote` + `autoIncrement`: EAS resolves the build
    // number and puts it in the config *before* prebuild runs, so by the time we
    // are called this is already the number the app will carry. A literal here
    // would be wrong on the very next build, and an extension whose
    // `CFBundleVersion` differs from its host's is rejected at App Store Connect
    // validation — after the upload, in a message naming neither number.
    const marketingVersion = IOSConfig.Version.getVersion(config);
    const currentProjectVersion = IOSConfig.Version.getBuildNumber(config);
    const deploymentTarget = appTargetSetting(project, 'IPHONEOS_DEPLOYMENT_TARGET');

    // `addTarget` does the genuinely fiddly half: the product reference, the
    // build configuration list, the Copy Files phase that embeds the built
    // `.appex` into the app, and the app's dependency on it. Getting any of
    // those wrong yields an app that builds and ships without its extension.
    const target = project.addTarget(
      TARGET_NAME,
      'app_extension',
      TARGET_NAME,
      `${appBundleIdentifier}.${TARGET_NAME}`
    );

    project.addBuildPhase(
      [`${TARGET_NAME}.swift`],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid
    );
    // Empty, and kept anyway because Xcode's own extension template creates
    // both and tools downstream (CocoaPods, and Xcode itself when a human opens
    // the project to debug) assume every native target has them. Nothing needs
    // linking here: `UserNotifications` and `Security` are system frameworks
    // that Swift auto-links.
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    // 3. The group, so the files are visible in Xcode's navigator. Cosmetic for
    //    a CI build and the difference between debuggable and not for a human.
    const group = project.addPbxGroup(
      [`${TARGET_NAME}.swift`, `${TARGET_NAME}-Info.plist`, `${TARGET_NAME}.entitlements`],
      TARGET_NAME,
      TARGET_NAME
    );
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);

    // 4. The build settings Xcode's own target template would have filled in.
    //    `addTarget` sets PRODUCT_NAME, PRODUCT_BUNDLE_IDENTIFIER, INFOPLIST_FILE
    //    and SKIP_INSTALL; everything below is what it leaves out.
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key]?.buildSettings;
      if (settings?.PRODUCT_NAME !== `"${TARGET_NAME}"`) continue;

      settings.CODE_SIGN_ENTITLEMENTS = `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`;
      settings.SWIFT_VERSION = '5.0';
      // iPhone only, matching `ios.supportsTablet: false` on the app.
      settings.TARGETED_DEVICE_FAMILY = '"1"';
      settings.CLANG_ENABLE_MODULES = 'YES';
      settings.SWIFT_EMIT_LOC_STRINGS = 'YES';
      // The extension ships inside the app rather than being installed, so it
      // must not be stripped of the symbols the app's own dSYM references.
      settings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = 'NO';
      if (marketingVersion) settings.MARKETING_VERSION = marketingVersion;
      if (currentProjectVersion) settings.CURRENT_PROJECT_VERSION = currentProjectVersion;
      if (deploymentTarget) settings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
    }

    return config;
  });

export default withNotificationService;
