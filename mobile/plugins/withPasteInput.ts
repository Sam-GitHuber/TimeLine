/**
 * Wire `@mattermost/react-native-paste-input` into the generated iOS project
 * (#400 — pasting a picture into the message box). Android needs nothing;
 * autolinking covers it.
 *
 * **Why a config plugin.** `mobile/ios` is gitignored and regenerated from
 * `app.json` by `expo prebuild` on every EAS build (see
 * `withNotificationService.ts`), so anything added to the Xcode project by hand
 * lasts until the next build. Three edits, each failing differently without it:
 *
 * 1. **The AppDelegate hands the library the React host**, after React Native
 *    has started — `PasteInputModule.setup(factory.rootViewFactory)`, per the
 *    library's README. Without it the native module can't find the composer's
 *    text view, and pasting a picture silently does nothing: the composer
 *    behaves exactly as it did before the library was added.
 *
 * 2. **The bridging header imports the module's header**, because that call is
 *    made from Swift and the library is a static Objective-C pod with no Swift
 *    module — `import react_native_paste_input` fails with "no such module".
 *    The bridging header is the standard way to expose an Objective-C class to
 *    Swift.
 *
 * 3. **The Podfile sets `RCT_NEW_ARCH_ENABLED=1` before autolinking.** The
 *    library's podspec refuses to install unless that variable is `1`. React
 *    Native sets it itself — unconditionally, since the New Architecture is the
 *    only one there is — but inside `use_react_native!`, which Expo's Podfile
 *    calls *after* `use_native_modules!` has already evaluated every
 *    autolinked podspec. So `pod install` fails on a variable that would have
 *    been `1` a few lines later. Setting it at the top only moves React Native's
 *    own assignment earlier; it doesn't change what any pod ends up seeing.
 *    (The library documents support up to RN 0.83; we're past that, and this is
 *    the one thing that needed working around — check it again on an RN bump.)
 *
 * All three are **idempotent**: a second run over a project that already has
 * them leaves it alone.
 */

import {
  ConfigPlugin,
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withPodfile,
} from 'expo/config-plugins';
import * as fs from 'fs';
import * as path from 'path';

const HEADER_IMPORT = '#import <react-native-paste-input/PasteInputModule.h>';
const SETUP_LINE = 'PasteInputModule.setup(factory.rootViewFactory)';

/**
 * The line in Expo's AppDelegate template the setup call goes in front of: the
 * end of `didFinishLaunchingWithOptions`, after `startReactNative`. The host
 * the call reads doesn't exist before that.
 */
const APP_DELEGATE_ANCHOR =
  'return super.application(application, didFinishLaunchingWithOptions: launchOptions)';

const PODFILE_LINE =
  "ENV['RCT_NEW_ARCH_ENABLED'] = '1' # withPasteInput: see plugins/withPasteInput.ts";

export function addPasteInputSetup(contents: string): string {
  if (contents.includes(SETUP_LINE)) return contents;
  if (!contents.includes(APP_DELEGATE_ANCHOR)) {
    // Fail the build rather than ship an app whose paste quietly does nothing:
    // Expo changing its template is exactly when this needs a human.
    throw new Error(
      'withPasteInput: AppDelegate.swift no longer matches Expo’s template ' +
        'this plugin edits — update APP_DELEGATE_ANCHOR.'
    );
  }
  return contents.replace(
    APP_DELEGATE_ANCHOR,
    `${SETUP_LINE}\n\n    ${APP_DELEGATE_ANCHOR}`
  );
}

export function addBridgingImport(contents: string): string {
  if (contents.includes(HEADER_IMPORT)) return contents;
  return `${contents.trimEnd()}\n${HEADER_IMPORT}\n`;
}

export function addNewArchFlag(contents: string): string {
  if (contents.includes(PODFILE_LINE)) return contents;
  return `${PODFILE_LINE}\n${contents}`;
}

const withPasteInput: ConfigPlugin = (config) => {
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('withPasteInput: expected a Swift AppDelegate.');
    }
    cfg.modResults.contents = addPasteInputSetup(cfg.modResults.contents);
    return cfg;
  });
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      // Expo's template names it `<Project>/<Project>-Bridging-Header.h`.
      const sourceRoot = IOSConfig.Paths.getSourceRoot(
        cfg.modRequest.projectRoot
      );
      const header = path.join(
        sourceRoot,
        `${path.basename(sourceRoot)}-Bridging-Header.h`
      );
      if (!fs.existsSync(header)) {
        throw new Error(`withPasteInput: no bridging header at ${header}.`);
      }
      fs.writeFileSync(
        header,
        addBridgingImport(fs.readFileSync(header, 'utf8'))
      );
      return cfg;
    },
  ]);
  return withPodfile(config, (cfg) => {
    cfg.modResults.contents = addNewArchFlag(cfg.modResults.contents);
    return cfg;
  });
};

export default withPasteInput;
