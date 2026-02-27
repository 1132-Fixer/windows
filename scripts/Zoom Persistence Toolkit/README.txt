Zoom Persistence Toolkit

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

3) Hardened install:
   - Zoom-Hardened-Install.ps1
   Downloads the Zoom MSI, installs with MSI properties that reduce persistence (e.g., AutoStartAfterReboot=0),
   disables client auto-update via Zoom AU2 policy key, and removes any Zoom Run entries.

4) Monitoring:
   - Zoom-Monitor.ps1
   Checks for (re)creation of persistence artifacts and logs alerts.
   Optional runner:
     - Install-MonitorTask.ps1 creates a scheduled task to run Zoom-Monitor.ps1 at logon and every hour.

Runners:
- RUN_01_Snapshot_Before.cmd
- RUN_02_Snapshot_After.cmd
- RUN_03_Diff_And_Matrix.cmd
- RUN_04_Hardened_Install.cmd
- RUN_05_Install_Monitor_Task.cmd

All runners auto-elevate and keep the admin PowerShell window open.

Outputs:
- .\Snapshots\ZoomSnapshot_*.json
- .\Diff\ZoomDiff_*.json, .csv, .md
- .\Monitor\ZoomMonitor_*.log, Windows Event Log source: ZoomPersistenceMonitor
