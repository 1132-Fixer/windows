# Testing

From a clone of this repository on Windows:

```bash
npm ci
npm test
node feedback-proxy/test.js
```

`npm test` is the unit and integration smoke chain in `package.json`. It covers
copy, identity, independence wording, brand placement, Fix-now routing,
cancellation, profile safety, Electron isolation, the updater channel, the
screen action map (`tools/screen-actions-smoke.js`), the plain-English
Details model (`tools/details-view-smoke.js`) and the release checksum
manifest bytes (`tools/release-checksums-smoke.js`: no CR, no BOM, final LF,
sorted, hashes match, `sha256sum -c` passes unmodified; needs `sha256sum` —
coreutils or Git for Windows).

## Repair source regressions

Run `npm run test:repair-source` from PowerShell 7 for the Node-only safety,
process, cancellation, result, form and support-client regressions. These use
inert native adapters, clocks, DOM elements and transport responses. They do
not launch Electron, control a browser, delete a profile, install the app or
submit a support message. CI runs this command in addition to `npm test`.

The helper-reset controller fixes its target to `C:\Users\user1`. Its synthetic
acceptance requires verified folder and profile-registration absence, with no
residual or unknown owned paths, before account recreation. These receipts
prove controller behavior only. Native adapters and their integration into
the repair handler remain unfinished; this source unit is not a delivered
native safety repair.

The normal `npm test` chain includes two native PowerShell 7 transport drivers:
`ps-encoding-smoke.js` and `elevation-controller-smoke.js`. Both verify the
actual Core host, preserve Unicode and quoting checks, and fail usefully when
PowerShell 7 is missing or a required fixture is refused. They do not change
execution policy or launch Windows PowerShell 5.1. Elevation and UAC outcomes
remain mocked; owned Node fixtures exercise bounded children and inherited
stdio. The source regression command does not replace the complete suite.

Rendered, packaged and destructive Windows acceptance are separate. Browser
or desktop control needs explicit operator authorization for that purpose.
Full account/profile purge and recreation must run in an authorized disposable
Windows environment, including Windows Home; never on the operator's working
profile or everyday workstation. Preserve security policies and required reviews.

## Rendered screens (headless Chromium)

```bash
npm install -g playwright   # once; downloads Chromium
node tools/ready-screen-capture.js --out artifacts/ready-screen
```

Renders the real `index.html`, `renderer.js` and shell with a mocked
`window.electronAPI`, drives Checking, Ready, Fixing, Complete, Unable and
Blocked through the real renderer paths at 520×600 (100/125/150 %), 520×560
and 440×520, and asserts per screen: only the allowed controls are visible,
Explore is never visible, no document or nested scrollbar, nothing outside
the viewport, footer not overlapped, focus rings and 24px targets, the
Details round trip (open, category, Back to details, Back, Escape) with the
checkbox preserved and focus returned, and no technical text on the Details
surface. Label every capture "harness render — real page code and assets,
mocked electronAPI"; the packaged binary is proven by
`tools/packaged-acceptance.js` on CI.

## What does not need Zoom

Most `tools/*-smoke.js` suites are offline. They read source and fixtures.

## What needs Windows

Packaged portable/NSIS builds, `scripts/package-inventory.mjs` against
`dist/win-unpacked`, and Authenticode checks.

## Packaged update acceptance (version A → version B)

Unit tests cannot prove that an installed app updates itself. From an
**elevated** Windows session (the per-machine installer and the
requireAdministrator app would otherwise each need a Windows approval prompt
that automation cannot answer):

```bash
node tools/build-update-test-pair.js
```

```bash
node tools/packaged-update-acceptance.js
```

The first builds two real NSIS installers (default 6.9.0 and 6.9.1) whose
only difference from a release is a generic update feed at
`http://127.0.0.1:47831/`. The second uninstalls any existing copy, installs
A, launches it from the installed path, serves B, waits for *Ready to
restart*, approves, and proves B was applied to the same directory,
relaunched itself from the canonical executable, logged the verified
relaunch, opens again on manual reopen, and left shortcuts, registry
records and app data correct. Evidence (report, screenshots, updater log
excerpt) lands in `update-acceptance/evidence/`. The reboot check is
reported as not-run and is done by hand. `--keep` leaves B installed;
`--dry-run` checks preconditions only.

## Packaged inactivity acceptance (real elapsed time)

```bash
node tools/packaged-inactivity-acceptance.js --exe "dist/win-unpacked/1132 Fixer.exe"
```

Drives a throwaway asInvoker copy of the unpacked build (no approval
prompt) through the real 30 s warning and 60 s exit, activity reset,
reopen, keyboard, reduced motion and the 100/125/150 % layouts. With
`--feed-dir <dir holding latest.yml + installer>` it also proves a verified
update waiting to install suspends the warning. Evidence lands in
`inactivity-evidence/`. Cases that need elevation (a running repair, an
installing update) are reported as not-run and covered by
`tools/inactivity-smoke.js` and `tools/packaged-update-acceptance.js`.

## What needs an isolated disposable VM

Deleting and recreating `user1`, launching Zoom as that account, and proving
the profile is not TEMP. **Do not** run those tests against a developer's
real Windows profile.

## Visual acceptance

Brand-guard CI is not packaged visual proof. Packaged Electron screenshots of
Checking, Ready, Fixing, Success, and Failure belong under this repository
when they are captured from the shipped `.exe`.
