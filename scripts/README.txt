Zoom Toolkit (Windows) — One‑Click Admin Runners

Files:
- Zoom-Toolkit.ps1
- RUN_01_AllCleanup_Only.cmd        (MSI cleanup + deep wipe; does NOT reinstall)
- RUN_02_AllCleanup_And_Reinstall.cmd (MSI cleanup + deep wipe + download/install fresh Zoom MSI)
- RUN_03_DryRun_WhatIf.cmd          (preview only; no deletions)

How to use:
1) Extract this folder somewhere (Desktop recommended).
2) Right‑click the RUN_*.cmd you want → Run as administrator.
3) Approve UAC. A new elevated PowerShell window will open and stay open.

Outputs:
- A report folder is created next to the scripts: .\Reports\ZoomToolkit_YYYYMMDD_HHMMSS\
  containing transcript, actions report (TXT), and JSON.

Notes:
- “Deep wipe” follows your provided Zoom cleanup targets and additionally clears:
  - Run keys (Zoom / ZoomUMX)
  - MUI cache + AppCompatFlags entries containing “zoom”
  - Zoom credential manager entries (cmdkey)
  - Zoom firewall rules
  - Prefetch entries matching *ZOOM*/*CPT*
- MSI cleanup removes Zoom MSI products found in Uninstall registry keys by GUID (msiexec /x {GUID} /qn).
