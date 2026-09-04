# AGENTS.md

Repository-specific instructions for `1132-Fixer/windows` — the Electron
desktop app **1132 Fixer** for Windows. `CLAUDE.md` at the root is a symlink to
this file.

## Product and ownership

- Product name is `1132 Fixer`. No rebrand has been performed or proposed; the
  repository, organization, executable, installer, updater feed, app ID,
  package identity, `UpgradeCode`, install path and publisher wording
  (High Texas) are unchanged.
- Purpose: repair Zoom Error 1132 by replacing the local helper account and its
  profile, then opening Zoom Workplace in that fresh helper environment. It is
  not a Zoom dashboard, an administrator console or a diagnostic utility.
- Canonical repository: <https://github.com/1132-Fixer/windows>, default branch
  `main`. Releases are GitHub Releases on this repository, built by
  `.github/workflows/release.yml` from a `v*` tag. Releases are **unsigned**
  (see `docs/security/code-signing.md`); never claim otherwise, and never add
  signing secrets, SignPath, or self-signed roots.
- Tracking: Botify Network Project 2 (`PVT_kwDODytvn84BfNBY`). Every issue and
  PR here has a Project 2 item; an item is Done only after the change is
  merged to `main` and verified there.
- Code owners: `.github/CODEOWNERS` (`@JG2547`, `@patricktobias86`).

## Architecture

| Layer | Files | Boundary |
|---|---|---|
| Main process | `main.js`, `src/main/*` | Only place that spawns processes, touches the registry, the file system or credentials. Every child process has a timeout and a single settle path. |
| Elevation | `src/main/elevation.js` | `whoami /groups` integrity SID first, PowerShell token query only as a bounded fallback. UAC relaunch is `Start-Process -FilePath … -Verb RunAs` through System32 PowerShell `-Command`; **never a temp `.ps1`** (Smart App Control blocks it). Outcomes: `started`, `declined`, `timeout`, `launch-error`, `failed`. |
| Security | `src/main/electron-security.js` | IPC channel allowlist, navigation/new-window denial, URL allowlist for Explore, path validation. Do not weaken it to fix a UI or startup problem. |
| Preload | `preload.js`, `src/preload/compact-shell.js` | `contextIsolation` on, `nodeIntegration` off; exposes only the `window.electronAPI` surface. The compact shell maps renderer panes onto `body[data-compact-state]` (`checking`, `ready`, `blocked`, `fixing`, `cancelling`, `cancelled`, `success`, `error`, `notice`). |
| Renderer | `index.html`, `renderer.js`, `messages.js` | All user-facing copy lives in `messages.js`; `index.html` design tokens are the single `:root` block. |
| Repair | `main.js` (`run-fix`) | The real orchestrator: confirm once → refuse while signed in as the helper → stop helper Zoom → remove account/profile → recreate → configure → launch → verify → report. Idempotent; a second run repairs a partial run. |

## Design

- Visual source of truth: `design-system/` (pinned submodule,
  `1132-Fixer/design-system`), plus `DESIGN-SYNC.md` for the decisions this
  repository owns and any recorded divergence. Read both before touching a
  user-facing surface; update `DESIGN-SYNC.md` first when a decision changes.
- The submodule **is** a git submodule (`.gitmodules`, gitlink mode `160000`,
  pinned to `7f3ddaf402f1456b10911264886719de62776b83`). The `brand-assets`
  required check depends on it: `.github/workflows/brand.yml` checks out with
  `submodules: true` and runs `design-system/scripts/brand-assets.sh`. Do not
  remove it, do not vendor a second copy of the guard or of the canonical
  PNGs; `.brand-assets.tsv` maps its exports to the assets this repo ships. An
  earlier version of this file said the opposite, written while the pin
  pointed at a rewritten-away commit; the pin was repaired, the instruction
  was not. Re-pin if it breaks again; never un-submodule it. Do not advance
  the pin without reviewing the design-system diff.
- Primary states are only: Checking, Ready, Fixing, Complete, Unable. Copy
  rules: `Ready to fix Zoom`, `Fix now`, one confirmation, `Open Zoom` only
  after verified success, never `Everything looks good.`, never raw
  PowerShell or stack traces on the primary surface (details go behind
  **View details**). Footer shows only version, the exact line
  `Independent project. Not affiliated with Zoom.`, Support and Feedback;
  Explore is not landing chrome.

## Build, test, release

```bash
npm ci
npm test                       # all tools/*-smoke.js, node only, no Electron needed
node feedback-proxy/test.js
npm run build                  # portable exe   (electron-builder)
npm run build:installer        # NSIS installer
node tools/packaged-acceptance.js --exe "dist/win-unpacked/1132 Fixer.exe" --out .acceptance
```

- `npm test` must pass from the exact final commit. Add a regression test for
  every fixed defect.
- The packaged acceptance driver needs an elevated Windows session **without**
  Smart App Control enforcement (SAC blocks the unsigned host binary before
  Electron starts). CI runs it on the `windows-latest` runner and uploads the
  `packaged-acceptance` artifact (screenshots + `report.md`). A case that
  cannot run is reported `not-run`, never `passed`.
- Release: bump `package.json` (`npm version patch`), update `CHANGELOG.md`,
  merge to `main`, tag `vX.Y.Z` on the `main` commit, push the tag, read the
  release run, then download the published assets and verify
  `checksums-sha256.txt`. Never re-tag or replace a published asset; roll
  forward with a higher version. See `docs/development/release-process.md`.

## Required-check policy (durable)

> A pre-existing failure in any required test, build, lint, type-check,
> security, packaging, installer, deployment, or release check remains a
> blocker. Reproducing the failure on a clean default branch establishes
> provenance only; it does not make the failure out of scope and does not
> permit completion or merge.

- Fix failures encountered in a required verification lane.
- Never waive a failure because it predates the current branch.
- Never skip, disable, quarantine, suppress, or weaken a required check.
- Never lower a coverage, security, lint, or quality threshold to obtain green.
- Never remove or relax an assertion to make a defect disappear.
- Rerun the complete required suite from the exact final commit.
- If a genuinely external dependency prevents resolution, leave the lane
  blocked and report the evidence. Do not call the work complete.
- "Works on my machine" is not proof; a clean-`main` reproduction means
  "repository defect confirmed", not "out of scope".

## Branch and PR workflow

- Work on a non-default branch; open a PR to `main`; every review thread
  resolved; required checks green on the exact head; merge; verify on `main`;
  delete the branch; close the linked issue; update Project 2. A branch or an
  open PR is not completion.
- Repository blobs are LF (`.gitattributes`); `git diff --check` must be clean.
- Free GitHub features only.

## Prohibited in user-facing text

`Everything looks good.`, raw PowerShell, stack traces, `Open Zoom as user1`,
internal account implementation details on the main screen, any claim that a
release is signed or that Smart App Control allows it.

## Response style

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
