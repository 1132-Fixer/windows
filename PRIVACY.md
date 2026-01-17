# Privacy Policy

CleanState Sentinel is designed with privacy as a core architectural principle. This document describes exactly what data the application accesses, stores, and—critically—what it does NOT do.

## Summary

**CleanState Sentinel operates entirely locally on your device.**

- No data is transmitted to external servers
- No telemetry or analytics are collected
- No account or registration is required
- No internet connection is required for operation

## Data Access

### What CleanState Sentinel Reads

During discovery/audit operations, the application reads:

| Data Type | Purpose | Scope |
|-----------|---------|-------|
| Process list | Identify running target software | System-wide |
| Service list | Identify target services | System-wide |
| Registry keys | Find software configuration and fingerprints | Target-specific paths only |
| File system | Locate data folders and executables | Target-specific paths only |
| Scheduled tasks | Identify persistence mechanisms | Target-specific tasks only |
| WMI subscriptions | Identify advanced persistence | Target-specific only |

**Important**: Discovery is read-only. No modifications occur during the audit phase.

### What CleanState Sentinel Modifies

During remediation (with explicit user consent):

| Data Type | Action | Reversibility |
|-----------|--------|---------------|
| Processes | Terminate | N/A (processes restart on next launch) |
| Services | Stop and optionally delete | Service can be reinstalled |
| Registry keys | Delete target-specific keys | Keys recreated on reinstall |
| Files/folders | Delete or quarantine | Quarantined files can be restored |
| Scheduled tasks | Delete | Tasks recreated on reinstall |
| WMI subscriptions | Remove | Subscriptions recreated on reinstall |

### What CleanState Sentinel NEVER Accesses

- Personal documents (Documents, Pictures, Videos, etc.)
- Email or messaging content
- Browser history or cookies (except target software cache)
- Credentials or passwords
- Other installed applications
- Network traffic or connections
- Hardware identifiers (MAC address, CPU ID, etc.)

## Data Storage

### Local Storage Only

All data created by CleanState Sentinel is stored locally:

```
%LOCALAPPDATA%\CleanStateSentinel\
├── sessions/      # Scan results and execution logs
├── reports/       # Attestation reports (JSON)
├── quarantine/    # Backed-up files before deletion
├── monitoring/    # Baseline snapshots for change detection
└── logs/          # Application logs
```

### Data Retention

| Data Type | Retention | User Control |
|-----------|-----------|--------------|
| Sessions | 90 days default | Delete anytime via app |
| Reports | Indefinite | Delete anytime via app |
| Quarantine | 30 days default | Restore or delete anytime |
| Logs | 30 days | Delete via file system |

### Uninstall Behavior

When you uninstall CleanState Sentinel:
- Application files are removed
- **User data is preserved** (reports, sessions)
- You can manually delete `%LOCALAPPDATA%\CleanStateSentinel\` to remove all data

## Network Activity

### Default Behavior: No Network Access

CleanState Sentinel does not require internet connectivity and makes no network requests during normal operation.

### Optional Network Features

| Feature | Network Use | User Control |
|---------|-------------|--------------|
| Zoom reinstall | Downloads installer from zoom.us | Explicit opt-in checkbox |
| Update check | None (manual updates only) | N/A |
| Telemetry | None | N/A |

**Note**: Even when downloading installers, no user data is transmitted. The download is a standard HTTPS GET request to the software vendor's public URL.

## Monitoring Feature

### How Monitoring Works

The optional monitoring feature:
1. Creates a baseline snapshot of system persistence mechanisms
2. Periodically compares current state against baseline
3. Generates local alerts if changes are detected

### Monitoring Privacy

- Monitoring runs locally via Windows Task Scheduler
- No data is transmitted externally
- Alerts are stored locally only
- Monitoring is **disabled by default**
- User must explicitly enable monitoring

### Disabling Monitoring

To disable monitoring:
1. Open CleanState Sentinel
2. Navigate to Monitoring settings
3. Click "Disable Monitoring"

This removes the scheduled task and stops all monitoring activity.

## Attestation Reports

### What Reports Contain

Attestation reports include:
- Timestamp and session ID
- List of discovered artifacts
- Actions taken during remediation
- Verification results
- Cryptographic hash for integrity

### What Reports Do NOT Contain

- Personal information
- System hardware identifiers
- User account names (redacted by default)
- File contents (only paths)
- Network information

### Report Sharing

Reports are designed to be shareable if needed (e.g., with IT support). The redaction feature removes sensitive paths before export.

## Third-Party Services

CleanState Sentinel does not integrate with any third-party services:

- No cloud storage
- No authentication providers
- No analytics services
- No advertising networks
- No crash reporting services

## Children's Privacy

CleanState Sentinel does not collect any personal information and therefore has no specific provisions for children's data. The application is a system utility with no user accounts or personal data collection.

## Your Rights

Since CleanState Sentinel stores all data locally on your device:

- **Access**: View all data in `%LOCALAPPDATA%\CleanStateSentinel\`
- **Deletion**: Delete any or all data at any time
- **Portability**: Copy your reports folder to any location
- **Rectification**: Edit or delete any stored data

No request to the developer is needed—you have full control.

## Changes to This Policy

Privacy policy changes will be:
- Documented in release notes
- Reflected in updated PRIVACY.md
- Never retroactively applied to existing data

## Contact

For privacy-related questions:
- GitHub Issues: [repository URL]
- Email: [contact to be added]

---

## Commitment

CleanState Sentinel is built on the principle that **forensic tools should not create new privacy concerns**. The application is designed to help you understand and control what software leaves behind on your system—not to collect information about you.

**No telemetry. No accounts. No cloud. Just local tools for local problems.**

---

*Last updated: January 2026*
*CleanState Sentinel v2.0.0*
