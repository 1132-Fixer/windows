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
  `Independent project. Not affiliated with Zoom.`, Support, Feedback and
  About; Explore is reachable only from the About dialog and is never
  landing chrome.
- Screen composition: static 56px header (Back on the Details view only,
  centered product mark, Exit), one centered column capped at 420px, static
  48px footer. Which controls a screen may show is the allowlist in
  `screen-actions.js`; the compact shell applies it after every renderer
  change, so no control is ever hidden with CSS and none leaks between
  states. **View details** opens the in-place Details view (renderer
  `openDetails`) whose content comes from `details-view.js`: plain English
  only, four status words (Checking · Ready · Needs attention · Unable to
  verify), categories opened one at a time, nothing that scrolls. Back and
  Escape restore the exact prior screen. See `DESIGN-SYNC.md` § "Ready
  screen and Details view".

## Build, test, release

```bash
npm ci
npm test                       # all tools/*-smoke.js, node only, no Electron needed
node feedback-proxy/test.js
npm run build                  # portable exe   (electron-builder)
npm run build:installer        # NSIS installer
node tools/packaged-acceptance.js --exe "dist/win-unpacked/1132 Fixer.exe" --out acceptance-evidence   # add --test-copy where UAC is disabled
```

- `npm test` must pass from the exact final commit. Add a regression test for
  every fixed defect.
- `node tools/ready-screen-capture.js --out <dir>` renders the real page files
  in headless Chromium (global `playwright`) and asserts, per state and
  viewport, the visible-control allowlist, no scrollbars, focus rings, the
  Details round trip and plain English. Attach its captures to any PR that
  touches a user-facing surface; the packaged acceptance driver repeats the
  Details round trip on the shipped binary.
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

## Durable standing rule — complete blocker repair, repository quality, architecture optimization

Operator directive 2026-09-04. Permanent. Applies to every assigned
repository, pull request, issue, deployment, service, migration, redesign
and continuation lane. `CLAUDE.md` resolves to this file; there is no
competing copy.

1. **No "pre-existing" exception.** A failure is not dismissible because it
   existed before the current change. Never justify completion with
   "pre-existing failure", "unrelated to this PR", "already broken on main",
   "outside the touched files", "not introduced by this branch", "legacy
   behavior" or "someone can fix it later". If a discovered problem blocks
   tests, builds, deployment, runtime health, security, accessibility,
   design quality, maintainability, migration or acceptance, investigate and
   address it as part of the active completion program. A blocker may remain
   unresolved only when it needs unavailable authorization, credentials,
   protected infrastructure access, an external vendor correction, or an
   independently owned change that must not be overwritten; then prove it
   with current evidence, create or update a durable tracking issue, record
   owner, dependency, impact, evidence and exact acceptance criteria, link it
   to the PR, project item and checkpoint, keep the parent work marked
   blocked or incomplete, and never report the program as fully complete.
2. **Fix the system, not only the symptom.** Determine the root cause;
   inspect adjacent code paths, shared contracts, callers, tests,
   configuration and deployment topology; correct duplicated, contradictory,
   fragile or misleading behavior; add regression tests and meaningful
   negative controls; verify failure paths as well as success paths; remove
   obsolete fallbacks, dead code, abandoned flags, stale terminology,
   placeholders and misleading documentation when safe; preserve backward
   compatibility only when intentionally supported. No uncontrolled rewrite:
   refactor deliberately, preserve working behavior, keep changes reviewable.
3. **Mandatory repository scrub** before declaring a repository or lane
   complete: open PRs and unresolved review threads; open issues, project
   items and linked blockers; non-default branches and abandoned work;
   failing, skipped, disabled, flaky or startup-failed CI; dependency,
   security, accessibility and configuration warnings; dead files, duplicate
   implementations, stale documentation and obsolete terminology; repository
   settings, default branch, ownership, governance pointers and branch
   protections; build, test, packaging, release, deployment, rollback and
   operational documentation. Preserve valuable work from non-head branches
   before closing or deleting them. Merge completed work into `main` through
   the required review and CI process. Never delete branches, issues,
   services, repositories, databases or environments without verified
   preservation and dependency checks.
4. **Code-quality and performance standard.** Messy code in the assigned
   scope must be improved when it creates meaningful risk, duplication,
   confusion, performance loss or unnecessary operating cost: clear module
   and service ownership; reusable shared contracts instead of duplicated
   logic; predictable error handling and fail-closed behavior; typed and
   validated data boundaries; efficient database access and indexing;
   bounded retries, timeouts, concurrency and background work; caching with
   expiry, invalidation, purge and retention rules; removal of redundant
   requests and repeated computation; lazy loading, code splitting, asset and
   bundle control where applicable; useful structured logs without secrets;
   idempotent migrations, jobs, deployments and recovery; resource limits,
   graceful degradation, rollback safety and health checks. Performance
   claims require measurements or reproducible evidence.
5. **Cost-effective topology and architecture.** Review every affected
   program as a complete operating system: canonical repositories and
   retirement targets; Railway projects, environments, services, workers,
   databases and Redis instances; domains, Cloudflare routes, webhooks,
   scheduled jobs, queues and external integrations; service-to-service
   calls and shared infrastructure; production and staging ownership;
   deployment sources and exact commit SHAs; duplicate, crashed, idle,
   orphaned or obsolete resources. One source of truth per responsibility;
   consolidate duplicates safely; prefer shared infrastructure when isolation
   is not required; preserve tenant, environment, identity and authorization
   boundaries; avoid unnecessary always-on workers, polling, databases and
   cross-service calls; use teardown, scaling, caching, batching and
   retention; minimize cost without weakening reliability, security,
   observability or recovery; document ownership, dependencies, data flow,
   rollback and retirement sequencing; complete migrations before disabling
   or deleting legacy resources; never substitute a local process for
   required Railway production or staging proof. Architecture changes carry a
   before-and-after topology assessment, expected cost or resource impact,
   migration plan, rollback plan and verified runtime evidence.
6. **Design and experience framework.** For any user-facing surface use the
   approved Design Sync, design system, tokens, components, assets and
   documented visual standards. Audit end to end: information architecture
   and navigation; layout density, spacing, alignment and hierarchy;
   typography, contrast, color consistency and readable sizing; responsive
   behavior without horizontal scrolling; keyboard, screen-reader, focus,
   reduced-motion and accessibility behavior; loading, empty, success,
   warning, disabled and failure states; menus, dialogs, wizards,
   confirmations and interactive controls; plain-English labels; consistent
   premium quality across related pages; removal of dead controls, duplicate
   headings, placeholder content and misleading actions; performance impact
   of images, effects, animation and third-party assets. Every visible
   control performs its real function. A redesigned screen is incomplete
   until visually reviewed at all supported viewport sizes and scaling levels
   and its workflow is tested end to end.
7. **README and repository-design compliance.** Read all applicable
   repository instructions before editing; comply with `README.md`,
   `AGENTS.md`, `CLAUDE.md`, Design Sync and design-system references,
   governance files, architecture records, contribution instructions, code
   ownership, testing and release requirements, and operational runbooks.
   Update documentation whenever behavior, topology, ownership, setup,
   architecture, UI, deployment or operating procedures change. The README
   must accurately explain the product, architecture, setup, workflows,
   testing, deployment, troubleshooting, security expectations and status —
   no stale screenshots, retired names, incorrect commands, dead links or
   references to deleted services.
8. **Verification and merge gate.** Work is complete only when all
   applicable evidence is green on the exact final commit: formatting,
   linting, type checking and static analysis; unit, integration, contract,
   accessibility, visual and end-to-end tests; production build and
   packaging; migration and rollback validation; security and secret scans;
   required governance checks; resolved review threads; executable exact-head
   CI; merge into `main`; deployment from the verified merge SHA;
   pre- and post-deployment log review; public health, route, workflow and
   data readback checks; confirmation that production runs the intended
   commit. Never bypass, disable, weaken, quarantine or rewrite a required
   gate to obtain green. A zero-job CI startup failure is not a passing
   check; a successful deployment is not proof of correct behavior; a local
   test result is not a substitute for exact-head CI or live verification.
9. **Completion reporting** distinguishes: completed and verified; fixed but
   awaiting merge; merged but awaiting deployment; deployed and
   live-verified; blocked with verified external dependency; remaining
   tracked work — with exact repository, branch, PR, issue, project item,
   commit SHA, deployment, test totals, runtime evidence and remaining
   blockers. Never claim "done", "complete", "production-ready" or "fully
   resolved" while any gate, blocker, migration step, review thread,
   deployment check or acceptance criterion is outstanding.

Own the complete result: follow discovered defects through code, design,
data, infrastructure, documentation, deployment and production verification
until the program is genuinely complete — or transparently blocked with
durable evidence and an actionable resolution path.

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
