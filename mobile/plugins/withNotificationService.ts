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
 * It is **idempotent**: a second run over an existing project finds the target
 * already there and refreshes the files and the build settings rather than
 * adding a second copy of everything. That path is reached only by
 * `expo prebuild --no-clean` — cleaning is the *default*, and there is no
 * `--clean` flag — which is precisely why it has to be right: the one
 * invocation that exercises it is the one nobody runs until they are already
 * debugging something else.
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

/** One target's build configurations, Debug and Release. */
function configurationsForTarget(
  project: XcodeProject,
  targetUuid: string
): { buildSettings?: Record<string, string> }[] {
  const listUuid = project.pbxNativeTargetSection()[targetUuid]?.buildConfigurationList;
  const lists = project.pbxXCConfigurationList();
  const configurations = project.pbxXCBuildConfigurationSection();
  return ((lists[listUuid]?.buildConfigurations ?? []) as { value: string }[])
    .map((entry) => configurations[entry.value])
    .filter(Boolean);
}

/**
 * The uuid of a target, found by its name.
 *
 * ⚠️ **Not `pbxTargetByName`, which cannot find this target.** `addTarget`
 * stores the name *quoted* (`"NotificationService"`), and `pbxTargetByName`
 * compares the section comment verbatim — so the obvious call returns `null`
 * forever, and an idempotency guard built on it silently never fires. This
 * accepts either spelling, and returns the uuid rather than the item, which is
 * what everything below actually needs.
 */
function findTargetUuid(project: XcodeProject, name: string): string | undefined {
  const section = project.pbxNativeTargetSection();
  for (const key of Object.keys(section)) {
    if (!key.endsWith('_comment')) continue;
    if (section[key] === name || section[key] === `"${name}"`) {
      return key.slice(0, -'_comment'.length);
    }
  }
  return undefined;
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
 * only because the built bundles were compared by hand. `IOSConfig.Version` is
 * what to use instead.
 */
function appTargetSetting(project: XcodeProject, name: string): string | undefined {
  for (const configuration of configurationsForTarget(
    project,
    project.getFirstTarget().uuid
  )) {
    const value = configuration.buildSettings?.[name];
    if (value !== undefined) return String(value);
  }
  return undefined;
}

const withNotificationService: ConfigPlugin = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.platformProjectRoot;
    // Deliberately not falling back to
    // `IOSConfig.BundleIdentifier.getBundleIdentifier`, which reads as a second,
    // independent source and is literally `config.ios?.bundleIdentifier ?? null`
    // — the same expression. A fallback that can never supply a value is worse
    // than none, because the next reader trusts it.
    const appBundleIdentifier = config.ios?.bundleIdentifier;

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

    // 2. The target — created once, then found on every later run.
    //
    //    `expo prebuild` **cleans by default**; `--no-clean` is the opt-out that
    //    applies changes to the native folders already there. So the common path
    //    never reaches the `else` below — and that is exactly why this has to be
    //    right, because the one path that exercises it is the one nobody runs
    //    until they are debugging something else. Adding the target twice
    //    produces a pbxproj Xcode opens and then refuses to build, blaming
    //    neither this plugin nor the duplicate.
    let targetUuid = findTargetUuid(project, TARGET_NAME);

    if (!targetUuid) {
      // `addTarget` does the genuinely fiddly half: the product reference, the
      // build configuration list, the Copy Files phase that embeds the built
      // `.appex` into the app, and the app's dependency on it. Getting any of
      // those wrong yields an app that builds and ships without its extension.
      // `String(...)` only so the narrowing survives: `addTarget` is untyped,
      // and assigning `any` back into a `string | undefined` leaves it wide.
      targetUuid = String(
        project.addTarget(
          TARGET_NAME,
          'app_extension',
          TARGET_NAME,
          `${appBundleIdentifier}.${TARGET_NAME}`
        ).uuid
      );

      project.addBuildPhase(
        [`${TARGET_NAME}.swift`],
        'PBXSourcesBuildPhase',
        'Sources',
        targetUuid
      );
      // Empty, and kept anyway because Xcode's own extension template creates
      // both and tools downstream (CocoaPods, and Xcode itself when a human
      // opens the project to debug) assume every native target has them.
      // Nothing needs linking here: `UserNotifications` and `Security` are
      // system frameworks that Swift auto-links.
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', targetUuid);
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', targetUuid);

      // 3. The group, so the files are visible in Xcode's navigator. Cosmetic
      //    for a CI build, and the difference between debuggable and not for a
      //    human.
      //
      //    `addPbxGroup` registers a `PBXBuildFile` for every path it hasn't
      //    seen before. The Swift already has one from the Sources phase above
      //    and is reused, but the plist and the entitlements come away with
      //    build files belonging to no phase. They are inert, and they are
      //    labelled `in Resources` — which reads as though the entitlements
      //    plist is copied into the shipped bundle, and would become true if
      //    anything ever reconciled orphans into a phase. So take them back out.
      const buildFiles = project.pbxBuildFileSection();
      const before = new Set(Object.keys(buildFiles));
      const group = project.addPbxGroup(
        [
          `${TARGET_NAME}.swift`,
          `${TARGET_NAME}-Info.plist`,
          `${TARGET_NAME}.entitlements`,
        ],
        TARGET_NAME,
        TARGET_NAME
      );
      for (const key of Object.keys(buildFiles)) {
        if (!before.has(key)) delete buildFiles[key];
      }
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    }

    // 4. The build settings Xcode's own target template would have filled in.
    //    `addTarget` sets PRODUCT_NAME, PRODUCT_BUNDLE_IDENTIFIER, INFOPLIST_FILE
    //    and SKIP_INSTALL; everything below is what it leaves out.
    //
    //    **Outside the branch above, deliberately.** These are refreshed on
    //    every run, like the files in step 1, because the versions come from the
    //    app config: skip them when the target already exists and a `--no-clean`
    //    prebuild after a version bump leaves the extension stamped with the old
    //    one, while Expo rewrites the app's Info.plist with the new — which is
    //    the App Store Connect rejection this file was already rewritten once to
    //    avoid.
    //
    //    Reached through the target's own configuration list rather than by
    //    scanning the project for `PRODUCT_NAME`: a name match is a coincidence
    //    away from writing into someone else's target, and one change to how
    //    `xcode` quotes that value away from matching *nothing* — which would
    //    silently drop `CODE_SIGN_ENTITLEMENTS`, the single setting this
    //    milestone turns on.

    // **The same two functions Expo's own Info.plist writer uses**, so the
    // extension's version keys cannot differ from the app's. Reading them from
    // the config rather than restating them is what survives
    // `appVersionSource: remote` + `autoIncrement`: EAS resolves the build
    // number and puts it in the config *before* prebuild runs, so by the time we
    // are called this is already the number the app will carry.
    const marketingVersion = IOSConfig.Version.getVersion(config);
    const currentProjectVersion = IOSConfig.Version.getBuildNumber(config);
    const deploymentTarget = appTargetSetting(project, 'IPHONEOS_DEPLOYMENT_TARGET');

    for (const configuration of configurationsForTarget(project, targetUuid)) {
      const settings = configuration.buildSettings;
      if (!settings) continue;

      settings.CODE_SIGN_ENTITLEMENTS = `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`;
      settings.SWIFT_VERSION = '5.0';
      // iPhone only, matching `ios.supportsTablet: false` on the app.
      settings.TARGETED_DEVICE_FAMILY = '"1"';
      settings.CLANG_ENABLE_MODULES = 'YES';
      settings.SWIFT_EMIT_LOC_STRINGS = 'YES';
      // Whether the Swift runtime dylibs are copied into this bundle's own
      // `Frameworks` directory. `NO`, because an app extension is loaded inside
      // its host and takes the host's copy; embedding a second set makes the
      // `.appex` several megabytes larger for nothing, and App Store Connect
      // rejects an extension that ships its own.
      settings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = 'NO';
      if (marketingVersion) settings.MARKETING_VERSION = marketingVersion;
      if (currentProjectVersion) settings.CURRENT_PROJECT_VERSION = currentProjectVersion;
      if (deploymentTarget) settings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
    }

    return config;
  });

export default withNotificationService;
