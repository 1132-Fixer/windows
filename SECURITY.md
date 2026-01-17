# Security Policy

CleanState Sentinel is a local forensic remediation platform. This document describes its security model, threat boundaries, and responsible disclosure process.

## Security Model

### Core Principles

1. **Local-Only Operation**
   - All scanning, analysis, and remediation occurs on the local device
   - No network communication except optional installer download
   - No telemetry, analytics, or remote reporting

2. **Read-Before-Write**
   - Discovery phase is always read-only
   - All modifications require explicit user consent
   - Changes are logged and reversible where possible

3. **Minimal Privilege**
   - Application starts as standard user (`asInvoker`)
   - Elevation requested only for specific operations
   - Elevated operations run for shortest possible duration

4. **Auditable Actions**
   - Every remediation step is logged with timestamps
   - Attestation reports provide cryptographic verification
   - Quarantined files are preserved for recovery

## Threat Model

### What CleanState Sentinel Protects Against

| Threat | Mitigation |
|--------|------------|
| Persistent software fingerprints | Comprehensive discovery and removal |
| Service auto-restart loops | Services stopped before process termination |
| Incomplete uninstallation | Multi-layer cleanup (files, registry, tasks, WMI) |
| Silent re-registration | Post-reboot verification detects recurrence |

### What CleanState Sentinel Does NOT Protect Against

| Non-Goal | Reason |
|----------|--------|
| Malware detection | Not an antivirus; use dedicated security software |
| Network-level tracking | Operates at filesystem/registry level only |
| Hardware fingerprints | Cannot modify BIOS, TPM, or hardware identifiers |
| Kernel-level persistence | Does not operate in kernel space |

## Explicit Non-Goals

CleanState Sentinel is **NOT** designed for:

- **Evasion**: Not intended to help users evade legitimate security controls, bans, or access restrictions
- **Data Exfiltration**: Contains no capability to transmit user data externally
- **Remote Control**: No remote access, command-and-control, or external management
- **Privilege Escalation Attacks**: Elevation is user-initiated via standard UAC
- **Anti-Forensics**: Designed to assist legitimate system administration, not hide activity

## Elevation Model

### Operations Requiring Elevation

| Operation | Why Elevation Needed |
|-----------|---------------------|
| Stop system services | Service Control Manager requires admin |
| Delete HKLM registry keys | Protected system keys |
| Create scheduled tasks | Task Scheduler security |
| Clear Windows Prefetch | System-protected directory |
| Modify Amcache/SRUM | Protected system databases |

### Operations NOT Requiring Elevation

| Operation | Runs As |
|-----------|---------|
| Application startup | Standard user |
| Audit/discovery scan | Standard user |
| Plan generation | Standard user |
| Report viewing/export | Standard user |
| User registry cleanup (HKCU) | Standard user |
| User profile file deletion | Standard user |

## Risk Governance

### Lane System

CleanState Sentinel uses a risk-based lane system:

| Lane | Description | When Used |
|------|-------------|-----------|
| **Autopilot** | Fully automated, low-risk operations | Risk score ≤ 30, no critical items |
| **Assisted** | Step-by-step with user confirmation | Risk score > 30 or critical items present |
| **Blocked** | Manual intervention required | Protected system components detected |

### Risk Scoring

Each artifact is scored based on:
- Type (process, service, registry, file, WMI)
- Location (user space vs system space)
- Persistence mechanism strength
- Potential for system impact

## Data Handling

### What Is Stored Locally

| Data | Location | Purpose |
|------|----------|---------|
| Session snapshots | `%LOCALAPPDATA%\CleanStateSentinel\sessions\` | Audit trail |
| Attestation reports | `%LOCALAPPDATA%\CleanStateSentinel\reports\` | Verification proof |
| Quarantined files | `%LOCALAPPDATA%\CleanStateSentinel\quarantine\` | Recovery capability |
| Monitoring baselines | `%LOCALAPPDATA%\CleanStateSentinel\monitoring\` | Change detection |

### What Is NEVER Stored or Transmitted

- Personal documents or files unrelated to target software
- Credentials or authentication tokens
- Network traffic or connection logs
- Hardware identifiers or system fingerprints
- Any data to external servers

## Reporting Security Issues

### Responsible Disclosure

If you discover a security vulnerability in CleanState Sentinel:

1. **Do NOT** open a public GitHub issue
2. **Email**: [security contact to be added]
3. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Your suggested fix (optional)

### Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgment | 48 hours |
| Initial assessment | 7 days |
| Fix development | 30 days (critical), 90 days (moderate) |
| Public disclosure | After fix is released |

## Code Signing

Production releases are signed with:
- **Publisher**: High Texas
- **Certificate Type**: [To be added when obtained]

Unsigned builds should only be used for development. Always verify signatures on downloaded installers.

## Dependencies

CleanState Sentinel uses:
- **Electron**: Chromium-based application framework
- **Node.js**: JavaScript runtime (bundled)
- **NSIS**: Installer framework (build-time only)

All dependencies are bundled; no runtime downloads occur.

## Version History

| Version | Security Notes |
|---------|---------------|
| 2.0.0 | Complete architecture rewrite with hardened IPC, lane-based risk governance |
| 1.x | Legacy architecture (deprecated) |

---

*Last updated: January 2026*
*CleanState Sentinel v2.0.0*
