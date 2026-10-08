# Testing

From a clone of this repository on Windows:

```bash
npm ci
npm test
```

`npm test` is the unit and integration smoke chain in `package.json`. It covers
copy, identity, independence wording, brand placement, Fix-now routing,
cancellation, profile safety, Electron isolation, the updater channel, the
screen action map (`tools/screen-actions-smoke.js`), the plain-English
Details model (`tools/details-view-smoke.js`) and the release checksum
manifest bytes (`tools/release-checksums-smoke.js`: no CR, no BOM, final LF,
sorted, hashes match, `sha256sum -c` passes unmodified and rejects a wrong
digest or changed binary; needs `sha256sum` — coreutils or Git for Windows).
The repository byte-format verifier rejects CRLF regardless of the installed
tool version. GNU Coreutils 9.0 and later accept CRLF checksum input, so that
tool's acceptance does not replace the repository's strict LF gate.

## Windows tool and preflight regression checks

These Node-only checks run in `npm test`:

- `tools/windows-tools-smoke.js`: OS-loaded DLL consensus, forged environment
  and folder candidates, mismatching roots, missing DLLs, malformed paths,
  unavailable reports, caching, spaces and Unicode, and probe-result validation.
  On Windows it also starts a real Node child with forged `SystemRoot`/`WINDIR`
  and an empty PATH, then runs read-only commands through the trusted executable.
- `tools/preflight-regression-smoke.js`: the real preflight function with
  controlled process results. Empty output, malformed or incomplete JSON,
  nonzero exit, timeout and launch failure each produce one check blocker;
  none invents seven missing tools. A successful inventory can report actual
  missing tools, and service-check failure cannot pass the repair gate.
- `tools/windows-process-smoke.js`: actual production process functions with
  controlled children, deadline and single completion checks, UTF-8 chunk
  decoding, and stdin failures.
- `tools/packaged-runtime-smoke.js`: the actual acceptance gate with controlled
  main-process facts. Missing APIs, wrong archives, conflicting DLLs and failed
  child commands cannot produce a passing runtime result.
- `tools/ps-encoding-smoke.js`: fixed UTF-8 standard-input transport, no
  dynamic script or helper secret in arguments or a temporary script file,
  and the PowerShell preparation contract.

These checks prove the source contracts. They do not prove what stopped
PowerShell on a reported user's PC. Preserve process status and checked paths
in a redacted Support Report to diagnose that environment.

On a disposable Windows VM, exercise both Setup and Portable builds from
folders with spaces and with a restricted or empty PATH. Confirm the tool
check uses Windows system-folder executables and that **Fix now** reaches the
expected repair gate. Also test missing-tool and failed-check cases without
changing the real system tools: use the controlled fixtures, then confirm
their renderer outcomes in the capture harness. A failed check must show one
plain-English explanation with retry and support actions. Report unavailable
Windows runtime or packaged cases as `not-run`.

`tools/packaged-acceptance.js` has mandatory actual Electron main-process
checks for the shipped archive hash, diagnostic-report availability, all three
loaded OS DLLs, resolved system tools and a read-only PowerShell command. A
separate launch supplies fake Windows tool folders, forged root variables and
an empty PATH. These cases fail if the packaged runtime cannot establish OS
authority or execute the trusted command; a Node-only pass cannot replace them.
The driver records only narrow runtime metadata, never the diagnostic report.
CI uses `--test-copy` for non-interactive diagnostic automation. A successful
CI execution stays useful as packaged-code evidence, but its report is explicitly
`diagnostic` and `releaseGateEligible=false`. Native release evidence must bind
the exact unmodified executable hash and head, UAC-enabled disposable host,
effective bundled support endpoint/revision, mandatory cases and operator
attestation.

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
`tools/packaged-acceptance.js` on CI (diagnostic packaged-code evidence, not
native UAC or final-artifact acceptance).

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

## Support submission boundary

`tools/support-submission-smoke.js` exercises the actual desktop client and
renderer submission handler against a local mock endpoint. It checks one POST,
acknowledgment validation, failed responses, draft retention, explicit retry,
size limits and numeric overall ratings. No live Discord message is posted.
The separate support service owns its HTTP and Discord integration tests;
this Windows repository does not need Postgres or Redis.
