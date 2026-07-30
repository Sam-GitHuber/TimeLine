# Releasing the phone apps (EAS build → TestFlight / Android)

The repeatable runbook for getting a new version of the app (`mobile/`, the
Expo/React Native app) onto testers' phones, **and** the rationale behind each
step. This is the mobile sibling of [`deploy.md`](deploy.md): where that doc ships
the backend/web app to the home server, this one ships the phone app to testers.

**iOS is below; [Android has its own section](#android-phase-10).** One codebase,
two quite different distribution stories — Apple's is a single channel
(TestFlight) with a review gate, Android's is a choice of channels with none.

It assumes the app is already built and working — the "how do I put the newest
code on a phone" doc, not "how do I write a feature."

## The one mental model: two kinds of update

An app change ships one of two ways, and knowing which saves you a wasted build:

| Change | Examples | How it ships |
|---|---|---|
| **JS / assets only** | most feature tweaks, copy, logic | **OTA update** — *not set up yet* (see "Follow-on" below) |
| **Native** | app **icon**/splash, a new native module, permissions, SDK bump, `app.json` native config | **new binary**: `eas build` → `eas submit` → TestFlight |

Until OTA is wired up (a planned follow-on, see
`reference/mobile-app.md`), **every** update goes the binary route below. Once
OTA lands, only *native* changes will need a full rebuild.

An `eas build` is **not a deploy** — it produces a beta binary for TestFlight from
whatever branch you point it at. It never touches `main`, the website, or the home
server. So building from a branch to *verify* a change (e.g. seeing an icon on a
real home screen) is safe and normal.

## iOS: one-time setup — already done, do not redo

Recorded here so a fresh checkout knows the state. None of this needs repeating.
(Android's equivalent is [below](#one-time-setup--already-done-do-not-redo-1).)

- **Apple Developer Program** — enrolled and active (account `samejefford@gmail.com`).
- **EAS project** — `@sam-apples-team/timeline`
  (`projectId b40a5a21-a02d-47fd-94a9-06ee94c2e1a1`, in `app.json`). Logged in via
  `eas login` as `sam-apple`.
- **Bundle identifier** — `net.yourtimeline.app` (iOS **and** Android).
- **App Store Connect app record** — public name **"YourTimeLine"**, bundle id
  `net.yourtimeline.app`, created at appstoreconnect.apple.com. (Public store name
  must be globally unique; "TimeLine" was taken — this is separate from the
  home-screen name, which stays "TimeLine" from `app.json`'s `name`.)
  **ASC App ID `6794099197`.**
- **iOS credentials, stored on EAS servers** — a Distribution Certificate and an
  App Store provisioning profile, generated interactively the first time. EAS
  reuses them, so later builds usually need **no Apple login**.
- **App Store Connect API key** — `[Expo] EAS Submit …`, **Key ID `A2RQD86VPP`**,
  role **App Manager** (least privilege that can submit + manage TestFlight),
  stored on EAS servers. This is what `eas submit` uses — no Apple login on submit.
- **Push (APNs) key** — provisioned by EAS during the first production build, so
  push works in TestFlight builds, not just dev builds.
- **Internal testing group** — **"Family and Friends"** in App Store Connect →
  TestFlight, currently the maintainer only.
- **Export compliance** — `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` in
  `app.json`, so Apple never prompts the "does it use encryption?" question that
  otherwise blocks each build.

## iOS: the release, step by step

The order is **branch → PR → merge → build from `main` → submit → verify**. Build
from merged `main` so the binary's recorded commit matches history.

### 1. Land the change (per the always-branch-never-main rule)

```bash
git checkout -b <branch>
# ...make the change...
git add -A && git commit -m "..."
git push -u origin <branch>
gh pr create ...
```

Wait for CI (the `mobile` job runs `npm ci` + `npm test` in `mobile/`; the
`backend`/`frontend`/security jobs must also pass under branch protection, even for
a mobile-only change). Merge (squash) and delete the branch.

### 2. Build the binary on EAS

> **Interactive-TTY gotcha (important).** Anything that needs an Apple login — the
> **first** production build (creating credentials) or the **first** submit — must
> run in a **real Terminal window**, not through Claude Code's `!` prefix. The `!`
> prefix has no interactive TTY, so EAS runs non-interactively and *fails* the
> credential/login step ("Run this command again in interactive mode"). Once
> credentials exist on EAS, later builds/submits are non-interactive and fine.

```bash
git checkout main && git pull
cd mobile
eas build --profile production --platform ios
```

- Bumps the iOS **build number** automatically (`production` profile has
  `autoIncrement`; Apple rejects duplicate build numbers).
- Uploads and builds in EAS's cloud, ~10–15 min. Ends with a green ✔ and an
  `.ipa` URL.
- A *"you have uncommitted changes"* warning is fine if it's only untracked/aside
  files (e.g. a WIP doc) — the committed code is what builds.

### 3. Submit to TestFlight

```bash
eas submit --platform ios --profile production --latest
```

- `--latest` submits the build you just made (no build id needed).
- Uses the stored ASC API key → auto-matches the "YourTimeLine" record → uploads.
- **Then Apple *processes* the build (~10–30 min)** before it appears in
  TestFlight. It shows as *"Processing"* in App Store Connect → YourTimeLine →
  TestFlight. This wait is normal; you can close the terminal — submission
  continues on EAS servers (`Ctrl+C` only stops the local watch).

### 4. Install / verify

Once processing finishes, the build attaches to the **"Family and Friends"** group
(immediately for internal testers — **no Apple review**). Open the **TestFlight**
app on the iPhone (signed in as the same Apple ID) → the new build installs over
the old one.

## iOS testers: internal vs external

- **Internal** (current): people added as users on the App Store Connect team
  (max 100). Builds are available **minutes after processing, no Apple review**.
  Best for the maintainer + very close family. Downside: internal testers are team
  members, so they get some App Store Connect access.
- **External**: invite by email (up to 10,000) *or* a shareable public link, no
  team membership, in groups. The **first build per group needs Apple "Beta App
  Review"** (~a day), and you must fill in **Test Information** including a
  **demo/review account** and "what to test" notes. This is the path for a wider
  friends-and-family beta *without* handing out console access.

### Going external: friends & family via a public link

The app is login-only and sign-ups are admin-approved, so Apple's reviewer can't
self-register — they need a working demo account. **Because the reviewer logs in
as a real user, the demo account must be isolated from real data**, or the
reviewer would see actual friends'/family's private posts.

1. **Create the isolated review account** (on the box; prints the credentials).
   The command ships in the backend image, so it must be **deployed first** —
   publish a GitHub Release and let the box autodeploy (see `deploy.md`; the box
   deploys on **release**, not on merge to `main`). Then, from the repo checkout on
   the box, using the **prod** compose file:
   ```bash
   cd ~/TimeLine
   docker compose -f docker-compose.prod.yml exec backend python manage.py create_review_account
   ```
   (Without `cd ~/TimeLine` + `-f docker-compose.prod.yml`, Compose reports "no
   configuration file provided: not found".)
   `create_review_account` is **prod-safe**: it only ever touches its two fixed
   sentinel accounts (`appreview@your-timeline.net` + a `review-buddy@example.com`
   companion), so it never wipes real data and re-running rotates the password.
   The account logs straight in (active + no unverified-email block) and is
   connected only to the demo companion, who has a post — so the reviewer can try
   **Report** and **Block** (what App Review checks) without seeing real people.
   *(Do **not** use `seed_demo` on prod — it rebuilds a whole demo world and its
   own docstring says never run it against a real deployment.)*
2. **App Store Connect → your app → TestFlight → Test Information**: set a feedback
   email, contact details, a one-line description, tick **Sign-in required**, and
   paste the review account's **email + password** from step 1.
3. **Create an External group** (TestFlight → External Testing → `+`), attach the
   current build, and **enable the public link** (set a tester cap, e.g. 50).
4. **Submit for Beta App Review.** Approval takes ~a day. Only the *first* build a
   group sees needs review; later builds usually distribute without a new review.
5. **Share the public link.** Anyone who taps it installs via TestFlight — but
   your **admin-approval gate still applies**, so nobody can actually use the app
   until you approve their account in Django admin. That's what makes a public
   link safe here.

Re-run `create_review_account` (and update the App Store Connect fields) whenever
you want to rotate the demo password.

## Android (Phase 10)

Same codebase, same `eas build`, different distribution. The mental model above
(JS-only vs native) applies unchanged.

### One-time setup — already done, do not redo

- **Package name** — `net.yourtimeline.app`, matching the iOS bundle id.
  **Permanent** once published to Play.
- **Upload keystore** — generated *in the cloud* by EAS on the first Android
  build and stored there. Unlike iOS, this needed no interactive login: EAS
  detected no local `keytool` and made one itself, so the interactive-TTY gotcha
  above does **not** apply to Android builds.
- **Firebase project `timeline-e428d`** — Cloud Messaging only. Analytics
  deliberately off: it's a third-party tracker, which cuts across the
  privacy-first principle in `SHARED.md`.
- **`google-services.json`** — committed at `mobile/google-services.json` and
  referenced by `app.json`'s `android.googleServicesFile`. **Committing it is
  deliberate**: it ships inside every APK, so anyone with the app already has it,
  and keeping it out of the repo would buy no security while costing an
  `app.config.js` to read it from an env var. It cannot send push — that needs
  the service-account key, which is *not* in the repo and never should be.
- **FCM v1 service account key** — uploaded to EAS (dashboard → project →
  Credentials → Android → the application identifier → **Service Credentials**).
  Note it's on the *identifier's own page*, not the list. Rotate by generating a
  new key in Firebase → Project settings → Service accounts and re-uploading;
  delete the downloaded file afterwards, it's a live credential.

Everything Firebase's "Add the Firebase SDK" page tells you to paste into Gradle
is **already handled** by Expo's config plugin — it injects the
`com.google.gms:google-services` classpath, applies the plugin, and copies the
JSON into `android/app/`. Don't hand-edit `mobile/android/`: it's generated and
gitignored, so `expo prebuild` will wipe your changes.

### Two distribution channels, and when to use each

| | EAS internal distribution | Play internal testing |
|---|---|---|
| Cost | free | $25 one-off |
| Install | link/QR → "install unknown apps" warning | normal Play Store install |
| Review | none | none (internal track only) |
| Updates | manual re-install | automatic |
| Blocked by | nothing | **device verification** (see below) |

**Use the APK for the development loop and for testing before Play is set up.**
It is a genuine channel — friends can install and use the app today. The Play
track is what you want for the settled beta, because it's the only option where a
non-technical relative's experience is the ordinary one.

### Build a shareable APK

```bash
cd mobile
eas build --profile preview --platform android
```

- The `preview` profile sets `android.buildType: "apk"`; `distribution:
  "internal"` gives a download page with a link and QR code. Send either.
- **Check what backend it points at.** `mobile/.env` is gitignored, so it is
  **not** uploaded to EAS and the build falls back to `api.ts`'s default,
  `https://your-timeline.net`. That's what you want for a tester — but it means a
  local `.env` pointing at `10.0.2.2` will *not* leak into a shared build, and
  equally that you cannot point a shared build at a local Django.
- Testers still need an account, and **sign-ups remain admin-approved**. Handing
  someone an APK grants them nothing until you approve them in Django admin.
  That's what makes an open install link safe here.

### Play Store (when the device check is done)

```bash
eas build --profile production --platform android   # AAB, not APK
eas submit --platform android --profile production --latest
```

- `production` builds an **AAB**, which is what Play requires; `autoIncrement`
  handles the versionCode.
- **The first upload must be done by hand** in the Play Console — `eas submit`
  can only target an app record that already has a release.
- `eas submit` needs a **Google Play Developer API** service-account key, which
  is a *different* key from the FCM one. Two service accounts, two consoles;
  they get confused constantly.
- **Play App Signing** re-signs with Google's key, so a lost upload key is
  recoverable. Back the upload keystore up anyway:
  `eas credentials --platform android` can export it — store it with the other
  deploy secrets (see [`backup-restore.md`](backup-restore.md)), never the repo.

**Device verification** gates a *personal* Play account: Google requires the
**Play Console mobile app on a non-rooted physical Android device** running
Android 10+, signed in as the account owner. An emulator will not do — this is
the one step in the whole phase that needs real hardware, and it takes under a
minute on a borrowed phone. Note the widely-cited "12 testers for 14 days" rule
is *not* relevant: it gates **production** access via **closed** testing, and a
friends-and-family beta lives on the internal track indefinitely.

### Local development build

```bash
cd mobile && npx expo run:android      # dev build onto a running emulator
```

Four things that cost time the first time:

- **The first build downloads the ~2.4 GB Android NDK** (reanimated and worklets
  compile C++ from source) plus whichever Build-Tools the pinned AGP wants —
  budget ~30 minutes and a few GB. Later builds are minutes; JS-only changes
  hot-reload and rebuild nothing.
- **The emulator reaches your Mac at `10.0.2.2`**, never `localhost` — and that
  host must also be in Django's `DJANGO_ALLOWED_HOSTS` or every request comes
  back **400 DisallowedHost**. See the comments in `mobile/.env`.
- **`adb reverse tcp:8081 tcp:8081`** is the reliable way to point the dev client
  at Metro, especially behind a VPN, which otherwise breaks the LAN-IP URL Expo
  prints.
- **Use a Google Play system image** for the AVD. It's required for FCM, and it
  is what makes Android push testable with no phone at all — see
  [`reference/notifications.md`](reference/notifications.md).

## Icon / splash / other asset changes

The app **icon** and **launch (splash) screen** are the brand mark from the web
header (`frontend/src/components/Layout.jsx`): the timeline **spine**
(`--color-spine #DED9CF`) + emerald **now-dot** (`--color-accent #1C8A6A`) on the
warm surface (`#FBFAF7`).

- **Icon** — a single full-bleed **1024×1024 PNG** at
  `mobile/assets/images/icon.png`, referenced by `app.json`'s top-level `icon`.
  There is **no `ios.icon` override** (an earlier stock `expo.icon` bundle was
  removed) — iOS generates every size from the one PNG at build time. iOS masks
  the corners itself, so the PNG is a full square with no rounded corners.
- **Splash** — `mobile/assets/images/splash-icon.png` (the mark, transparent
  background), shown centred on `app.json`'s splash `backgroundColor` (`#fbfaf7`).
- **Regenerating them** — the mark is rendered from SVG to PNG with
  `@resvg/resvg-js` (a scratch script; see the icon commit / PR #136 for the exact
  geometry: spine + dot ratios copied faithfully from the web mark's `viewBox`).
- Icon/splash are **native changes** → they need a full rebuild + resubmit (they
  can't ship OTA).

## Follow-on (planned, not built): OTA continuous deployment

[`reference/mobile-app.md`](reference/mobile-app.md) ("Not built: OTA updates")
plans wiring **EAS Update** so JS-only changes reach
installed phones on merge to `main`, mirroring the web's continuous deploy — with
`runtimeVersion: fingerprint` gating, update code-signing, and native changes kept
as a deliberate rebuild. Until then, use the binary route above for everything.

## Quick reference

| Thing | Value |
|---|---|
| EAS project | `@sam-apples-team/timeline` |
| Bundle id | `net.yourtimeline.app` |
| ASC app name / App ID | YourTimeLine / `6794099197` |
| ASC API key (submit) | `A2RQD86VPP` (App Manager, on EAS) |
| Internal group | Family and Friends |
| Build | `eas build --profile production --platform ios` |
| Submit | `eas submit --platform ios --profile production --latest` |
| Login needed? | iOS: only first-time cred setup — run in a **real Terminal**, not `!`. Android: never (EAS makes the keystore itself) |
| Android package | `net.yourtimeline.app` |
| Firebase project | `timeline-e428d` (Cloud Messaging only) |
| Android APK | `eas build --profile preview --platform android` |
| Android Play build | `eas build --profile production --platform android` (AAB) |
