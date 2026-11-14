# Tool scripts: what each one is for, and what happened to it

Owner decisions for issue 229, recorded 2026-11-14.

## Decision 1: ruleset bypass list

**The bypass list of both default-branch rulesets stays empty.**

| Ruleset | Rules | Bypass actors |
| --- | --- | --- |
| `21240372` `default-branch` | `deletion`; `required_status_checks` (seven checks, strict) | none |
| `24340021` `default-branch-review` | `pull_request` (review threads must be resolved) | none |

Read back on 2026-11-14: both active, both with zero bypass actors. This replaces
the 2026-10-01 ruling, which allowed an admin exception through a pull request.
There is now no exception path: every change to `main` needs a pull request with
all seven checks green and all review threads resolved.

Both rulesets were found disabled on 2026-11-13 22:51 UTC and were set to active
again on 2026-11-14.

## Decision 2: the 30 local-only files

A recovery on 2026-10-01 listed 30 files from a local build folder as missing
from this repository. A byte comparison that ignored line endings showed that
21 were already on `main`. The other 9 are generated files, caches, logs and
settings records, and stay out of source.

The rule applied to the 21: a script that changes a computer and records no
way back is either given a rollback or retired.

### Shipped in releases (`build.extraResources`)

| File | What it changes | Rollback | Result |
| --- | --- | --- | --- |
| `scripts/grant-media-consent.ps1` | Camera and microphone consent to `Allow` in the helper account's own registry hive. Machine privacy policy and the FrameServer service are read only. | Not needed. The value is inside the helper profile, which **Fix now** deletes and rebuilds. Nothing outside that profile is written. | Kept. The machine-wide writes described in the 2026-10-02 review were removed in 6.4.1 (#254). `tools/retired-scripts-smoke.js` fails if a machine-wide write returns. |
| `scripts/zoom-firstrun-setup.ps1` | Runs as the helper account. Changes Zoom settings in the helper's own profile. | Not needed, for the same reason. | Kept. |

### Not shipped, read-only

| File | Result |
| --- | --- |
| `tools/qa/qa-context.ps1`, `tools/qa/qa-preflight-live.ps1` | Kept. They only read. |
| `scripts/Zoom Persistence Toolkit/Zoom-Snapshot.ps1`, `Zoom-Diff.ps1`, `Zoom-Monitor.ps1`, `RUN_01` to `RUN_03` runners, `README.txt` | Kept. They read the computer and write report files. |
| `legacy/user.bat` | Kept as history. `legacy/` is not packaged and nothing runs it. |

### Not shipped, changed a computer, no rollback: retired

These files are removed from `main`. They remain in Git history.

| File | What it changed | Why retired and not repaired |
| --- | --- | --- |
| `tools/merge-user1-profiles.ps1` | Copied stale profile folders into `C:\Users\user1`, then deleted the stale folders. | A one-time repair for one computer: the computer name is written into the script. Nothing can be restored after the delete. The app handles this case itself since 6.4.1. |
| `tools/repoint-profilelist.ps1` | Set `ProfileImagePath` for one account identifier written into the script, and deleted ProfileList subkeys without exporting them. | Same: one computer, no export before the delete. |
| `scripts/Zoom-Toolkit.ps1`, `scripts/RUN_01_AllCleanup_Only.cmd`, `scripts/RUN_02_AllCleanup_And_Reinstall.cmd`, `scripts/RUN_03_DryRun_WhatIf.cmd`, `scripts/README.txt` | Removed Zoom for every user of the computer: MSI products, folders, registry keys. Optionally downloaded and installed Zoom again. | It deletes user data for every account and records nothing. The app never called it. 1132 Fixer does not remove a user's Zoom installation. |
| `scripts/Zoom Persistence Toolkit/Zoom-Hardened-Install.ps1`, `RUN_04_Hardened_Install.cmd` | Installed Zoom from a downloaded MSI, turned Zoom's update policy off in the registry, removed Run entries. | Changes machine policy with no record of the earlier values. |
| `scripts/Zoom Persistence Toolkit/Install-MonitorTask.ps1`, `RUN_05_Install_Monitor_Task.cmd` | Registered a scheduled task that ran hourly with highest privileges. | A persistent elevated task with no uninstall step. |

### Never in source

| File | Reason |
| --- | --- |
| `.task-artifacts/ruleset-21240372-*.json` (6) | Settings records from 2026-09-01. Summarized in issue 229. |
| `.task-artifacts/npm-cache/**` (2) | Log and cache. The log contains local paths. |
| `src/main/config.generated.js` | Generated at build time. |

## Test

`tools/retired-scripts-smoke.js` (part of `npm run test:core`) checks that the
retired files are absent, that releases ship exactly the two reviewed scripts,
and that neither shipped script writes outside the helper account.
