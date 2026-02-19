# CleanState Sentinel - Distribution Guide

This document covers building, signing, and distributing CleanState Sentinel.

## Build Commands

```bash
# Development
npm start                    # Run in dev mode
npm run dev                  # Run with DevTools

# Production builds
npm run build:installer      # Build NSIS installer only
npm run build                # Build portable executable
npm run build:all            # Build both installer and portable
npm run pack                 # Create unpacked directory (for testing)
```

## Output Files

After building, find outputs in `dist/`:

| File | Description |
|------|-------------|
| `CleanState Sentinel Setup 2.0.0.exe` | NSIS installer |
| `CleanState Sentinel Portable 2.0.0.exe` | Portable executable |

## Installer Behavior

### What the Installer Does

**Installs:**
- CleanStateSentinel.exe (main executable)
- Required Electron resources
- Application icon

**Registers:**
- Uninstall entry in Add/Remove Programs
- `.cssr` file association (CleanState Sentinel Reports)

**Asks User (Checkboxes):**
- ☑ Create desktop shortcut (default: on)
- ☑ Create Start Menu entry (default: on)
- ☐ Enable post-reboot verification support (default: off)

### What the Installer Does NOT Do

- Does NOT start any scans
- Does NOT enable monitoring automatically
- Does NOT install background services
- Does NOT auto-start with Windows
- Does NOT touch system settings beyond install location
- Does NOT require elevation for per-user install

## Elevation Model

### Installer Elevation
- **Per-user install**: No elevation required
- **Per-machine install (Program Files)**: Elevation required

### Application Elevation
- **Normal startup**: Runs as standard user (`asInvoker`)
- **Privileged operations**: UAC prompt on-demand

Operations requiring elevation:
- Stopping/deleting system services
- Modifying HKLM registry keys
- Clearing Windows Prefetch
- Creating scheduled tasks (post-reboot verification)
- Modifying system databases (Amcache, SRUM)

## Code Signing

### Why Sign?
- Improves SmartScreen reputation
- Increases Defender trust
- Shows publisher identity
- Builds user confidence

### What to Sign
1. Main executable (`CleanStateSentinel.exe`)
2. Installer (`CleanState Sentinel Setup 2.0.0.exe`)
3. Uninstaller (embedded in installer)

### Signing with electron-builder

Add to `package.json` build config:

```json
{
  "win": {
    "certificateFile": "path/to/certificate.pfx",
    "certificatePassword": "your-password",
    "signAndEditExecutable": true
  }
}
```

Or use environment variables:
```bash
CSC_LINK=path/to/certificate.pfx
CSC_KEY_PASSWORD=your-password
```

### Recommended Certificate Types
1. **EV Code Signing Certificate** (Best)
   - Immediate SmartScreen reputation
   - Hardware token required
   - ~$400-600/year

2. **Standard Code Signing Certificate** (Good)
   - Builds reputation over time
   - Software-based
   - ~$100-300/year

## Pre-Release Checklist

### Build Verification
- [ ] Fresh install on clean VM
- [ ] Install to default location works
- [ ] Install to custom location works
- [ ] Per-user install works (no admin)
- [ ] Per-machine install works (with admin)
- [ ] Desktop shortcut created (if selected)
- [ ] Start Menu entry created (if selected)
- [ ] Uninstall removes all binaries
- [ ] Uninstall preserves user data

### Functionality Verification
- [ ] App starts without elevation
- [ ] Audit scan completes
- [ ] Plan building works
- [ ] Execution requests elevation appropriately
- [ ] Verification completes
- [ ] Reports export correctly
- [ ] Migration from 1132-Remover works

### Branding Verification
- [ ] No "1132" references in UI
- [ ] No "1132" in file paths (except migration)
- [ ] Window title shows "CleanState Sentinel"
- [ ] About/version shows correct info
- [ ] Taskbar icon correct

### Security Verification
- [ ] App does not auto-elevate on start
- [ ] UAC prompts appear for privileged ops
- [ ] No network calls made
- [ ] No telemetry sent
- [ ] User data not accessible to other apps

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 2.0.0 | 2026-01 | Complete rewrite with v2 architecture |
| 1.1.0 | Previous | Legacy 1132-Remover |

## File Locations

### Install Locations
- Per-user: `%LOCALAPPDATA%\Programs\CleanState Sentinel\`
- Per-machine: `C:\Program Files\CleanState Sentinel\`

### User Data Location
- `%LOCALAPPDATA%\CleanStateSentinel\`
  - `sessions/` - Session data
  - `reports/` - Attestation reports
  - `monitoring/` - Monitoring baselines and alerts
  - `quarantine/` - Backed up files
  - `logs/` - Application logs

### Registry Keys
- `HKCU\Software\CleanStateSentinel` - User preferences
- Uninstall entry in standard location

## Troubleshooting

### SmartScreen Warning
If users see SmartScreen warnings:
1. Sign the executable (recommended)
2. Users can click "More info" → "Run anyway"
3. Building reputation takes ~1000 downloads

### Defender False Positive
If Windows Defender flags the app:
1. Submit to Microsoft for analysis
2. Sign with EV certificate
3. Users can add exception

### Installation Fails
Common causes:
- Antivirus blocking installer
- Insufficient permissions
- Disk space issues
- Corrupted download

Solutions:
- Temporarily disable AV during install
- Run installer as administrator
- Free disk space
- Re-download installer
