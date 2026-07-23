# Releasing the iPhone app (EAS build → TestFlight)

The repeatable runbook for getting a new version of the **iOS app** (`mobile/`,
the Expo/React Native app) onto testers' phones, **and** the rationale behind each
step. This is the mobile sibling of [`deploy.md`](deploy.md): where that doc ships
the backend/web app to the home server, this one ships the phone app to
**TestFlight** (Apple's beta-distribution service).

It assumes the app is already built and working — the "how do I put the newest
code on a phone" doc, not "how do I write a feature."

## The one mental model: two kinds of update

An app change ships one of two ways, and knowing which saves you a wasted build:

| Change | Examples | How it ships |
|---|---|---|
| **JS / assets only** | most feature tweaks, copy, logic | **OTA update** — *not set up yet* (see "Follow-on" below) |
| **Native** | app **icon**/splash, a new native module, permissions, SDK bump, `app.json` native config | **new binary**: `eas build` → `eas submit` → TestFlight |

Until OTA is wired up (a planned follow-on, see the tail of
`phases/phase-9-iphone-app.md`), **every** update goes the binary route below. Once
OTA lands, only *native* changes will need a full rebuild.

An `eas build` is **not a deploy** — it produces a beta binary for TestFlight from
whatever branch you point it at. It never touches `main`, the website, or the home
server. So building from a branch to *verify* a change (e.g. seeing an icon on a
real home screen) is safe and normal.

## One-time setup — already done, do not redo

Recorded here so a fresh checkout knows the state. None of this needs repeating.

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

## The release, step by step

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

## Testers: internal vs external

- **Internal** (current): people added as users on the App Store Connect team
  (max 100). Builds are available **minutes after processing, no Apple review**.
  Best for the maintainer + very close family. Downside: internal testers are team
  members, so they get some App Store Connect access.
- **External** (not set up yet): invite by email (up to 10,000), no team
  membership, in groups. The **first build per group needs Apple "Beta App
  Review"** (~a day), and you must fill in **Test Information** including a
  **demo/review account** and "what to test" notes. This is the path for a wider
  friends-and-family beta *without* handing out console access. When going
  external: create a demo account on the backend (admin-approved like any user),
  put its credentials in App Store Connect's test info, and submit the group for
  review.

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

The tail of [`phases/phase-9-iphone-app.md`](phases/phase-9-iphone-app.md)
("Follow-on to Milestone F") plans wiring **EAS Update** so JS-only changes reach
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
| Login needed? | Only first-time cred setup — run in a **real Terminal**, not `!` |
