Zoom Persistence Toolkit (read-only diagnostics)

Not part of the 1132 Fixer app and not shipped in any release.
Every script here only reads the computer and writes report files.

Includes:
1) Snapshot script:
   - Zoom-Snapshot.ps1
   Captures a point-in-time snapshot of Zoom persistence artifacts (files, folders, registry keys/values,
   services, tasks, firewall rules, credentials, MSI products, and running processes) into JSON.

2) Diff & matrix:
   - Zoom-Diff.ps1
   Compares two snapshot JSON files and produces:
     - Diff JSON
     - Forensic comparison matrix (CSV + Markdown)

3) Monitoring:
   - Zoom-Monitor.ps1
   Checks for (re)creation of persistence artifacts and logs alerts. Run it by hand.

Runners:
- RUN_01_Snapshot_Before.cmd
- RUN_02_Snapshot_After.cmd
- RUN_03_Diff_And_Matrix.cmd

All runners auto-elevate and keep the admin PowerShell window open.

Outputs:
- .\Snapshots\ZoomSnapshot_*.json
- .\Diff\ZoomDiff_*.json, .csv, .md
- .\Monitor\ZoomMonitor_*.log, Windows Event Log source: ZoomPersistenceMonitor

Retired on 2026-11-14 (issue 229): Zoom-Hardened-Install.ps1 and Install-MonitorTask.ps1,
with their runners. They changed the computer (MSI install, registry policy, a scheduled
task that ran with highest privileges) and recorded no way back. They remain in Git history.
See docs/security/tool-scripts-disposition.md.
