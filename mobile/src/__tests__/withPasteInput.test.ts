/**
 * The config plugin that wires the paste-aware composer into the generated iOS
 * project (#400).
 *
 * Worth a suite because every way it can go wrong is silent at the wrong time:
 * a missing `setup` call builds and runs fine and paste just does nothing, and
 * a missing Podfile line only fails `pod install` on EAS, twenty minutes into a
 * build. The edits are pure string functions, so they're pinned here against
 * the shape of Expo's template.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  addBridgingImport,
  addNewArchFlag,
  addPasteInputSetup,
} from '../../plugins/withPasteInput';

/** The relevant part of Expo SDK 57's generated `AppDelegate.swift`. */
const APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: delegate)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('withPasteInput', () => {
  it('hands the library the React host after React Native has started', () => {
    const out = addPasteInputSetup(APP_DELEGATE);
    const setup = out.indexOf('PasteInputModule.setup(factory.rootViewFactory)');
    expect(setup).toBeGreaterThan(out.indexOf('factory.startReactNative('));
    expect(setup).toBeLessThan(out.indexOf('return super.application('));
  });

  it('fails the build rather than ship a paste that does nothing', () => {
    // If Expo changes its template, a silent no-op here would ship an app whose
    // paste quietly never fires.
    expect(() => addPasteInputSetup('class AppDelegate {}')).toThrow(
      /APP_DELEGATE_ANCHOR/
    );
  });

  it('exposes the module to Swift through the bridging header', () => {
    expect(addBridgingImport('//\n// header\n//\n')).toBe(
      '//\n// header\n//\n#import <react-native-paste-input/PasteInputModule.h>\n'
    );
  });

  it('sets the New Architecture flag before anything in the Podfile runs', () => {
    const podfile = "require 'json'\nuse_native_modules!\n";
    expect(addNewArchFlag(podfile).split('\n')[0]).toMatch(
      /^ENV\['RCT_NEW_ARCH_ENABLED'\] = '1'/
    );
  });

  it('changes nothing on a second run', () => {
    // `expo prebuild --no-clean` runs the plugin over a project it has already
    // edited.
    const delegate = addPasteInputSetup(APP_DELEGATE);
    expect(addPasteInputSetup(delegate)).toBe(delegate);
    const header = addBridgingImport('//\n');
    expect(addBridgingImport(header)).toBe(header);
    const podfile = addNewArchFlag('use_native_modules!\n');
    expect(addNewArchFlag(podfile)).toBe(podfile);
  });

  it('runs a paste library with our patch applied', () => {
    // `patches/` narrows what the library intercepts to images, so text copied
    // from Notes or Mail (which carries RTF) still pastes as text, and stops it
    // fetching a URL a keyboard hands over. `patch-package` applies it on every
    // install and fails the install if it no longer fits — this catches the
    // install that skipped it.
    const read = (path: string) =>
      readFileSync(
        join(__dirname, '../../node_modules/@mattermost/react-native-paste-input', path),
        'utf8'
      );
    expect(read('ios/UIPasteboard+GetImageInfo.m')).toContain('TimeLine patch (#400)');
    expect(
      read('android/src/main/java/com/mattermost/pasteinputtext/PasteInputListener.kt')
    ).toContain('TimeLine patch (#400)');
  });

  it('is registered in app.json', () => {
    const config = require('../../app.json');
    expect(config.expo.plugins).toContain('./plugins/withPasteInput');
  });
});
