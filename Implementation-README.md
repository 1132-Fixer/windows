# 1132 Remover — Implementation Package (Audit → Consolidate → Cleanup)

This package is designed to safely inventory, consolidate, and (optionally) remove **1132 Remover / 1132 / Zoom-related** artifacts on Windows.

**Final consolidated filepath (target root):**
- `C:\Users\justy\Documents\Bot\Local Files\1132-Remover`

## What you get
- A **single main PowerShell script** that supports staged execution:
  - `Audit` (read-only, default)
  - `Consolidate` (copy only)
  - `Cleanup` (quarantine move only)
  - `Full` (Consolidate + Cleanup; delete only with `-ForceDelete`)
- Wrapper scripts for each stage (easy to run in order)
- Logging + CSV inventory + summary output
- Conservative defaults (exclusions for Windows/system folders; no registry edits)

## Quick start (recommended)
Open **PowerShell as Administrator** (Start menu → PowerShell → Run as administrator)

1) **Stage 0 — Preflight checks (no changes)**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\stages\Stage0-Preflight.ps1
```

2) **Stage 1 — Audit (no changes)**
```powershell
.\stages\Stage1-Audit.ps1
```

3) **Review the report**
Audit output is written to a timestamped folder:
- `C:\Temp\1132_Audit\<timestamp>\audit.csv`
- `C:\Temp\1132_Audit\<timestamp>\summary.txt`
- `C:\Temp\1132_Audit\<timestamp>\actions.log`

4) **Stage 2 — Consolidate (copy only)**
```powershell
.\stages\Stage2-Consolidate.ps1
```
This copies all items classified `Required` into:
- `C:\Users\justy\Documents\Bot\Local Files\1132-Remover\_consolidated\...`

5) **Verify**
Confirm your app runs from consolidated locations and shortcuts resolve.

6) **Stage 3 — Cleanup (quarantine only, reversible)**
```powershell
.\stages\Stage3-Cleanup.ps1
```
Moves `CandidateRemove` items into:
- `C:\Temp\1132_Quarantine\<timestamp>\...`

7) **Stage 4 — Final delete (only when you're sure)**
```powershell
.\stages\Stage4-Delete.ps1
```
This **permanently deletes** quarantined items for the run. It requires `-ForceDelete`.

---

## Notes
- Default behavior is **non-destructive**.
- The script will not delete anything unless:
  - `-Mode Cleanup` (quarantine move), or
  - `-Mode Full -ForceDelete` (delete quarantined items), or
  - `Stage4-Delete.ps1` (delete quarantined items) is executed.

If you want stricter or looser matching (e.g., more aggressive Zoom searches), edit:
- `src\1132-Remover.ps1` → the `$Keywords` and `$Extensions` arrays.
