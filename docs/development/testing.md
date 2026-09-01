# Testing

From a clone of this repository on Windows:

```bash
npm ci
npm test
node feedback-proxy/test.js
```

`npm test` is the unit and integration smoke chain in `package.json`. It covers
copy, identity, independence wording, brand placement, Fix-now routing,
cancellation, profile safety, Electron isolation, and the updater channel.

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
