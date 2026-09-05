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

## What needs an isolated disposable VM

Deleting and recreating `user1`, launching Zoom as that account, and proving
the profile is not TEMP. **Do not** run those tests against a developer's
real Windows profile.

## Visual acceptance

Brand-guard CI is not packaged visual proof. Packaged Electron screenshots of
Checking, Ready, Fixing, Success, and Failure belong under this repository
when they are captured from the shipped `.exe`.
