# 1132 Eliminator

**Forensic Zoom Error 1132 elimination tool — device fingerprint purge and clean reset.**

A Windows utility that resolves Zoom Error 1132 (device bans) by performing a forensic-grade purge of all Zoom artifacts, device fingerprints, and telemetry data, then optionally reinstalls a clean copy of Zoom.

## Installation

### Installer (Recommended)
1. Download **1132 Eliminator Setup 3.2.0.exe** from [Releases](../../releases)
2. Run the installer — UAC will prompt for admin automatically
3. Desktop shortcut is created — launch from your desktop

### Portable
1. Download **1132 Eliminator Portable 3.2.0.exe** from [Releases](../../releases)
2. Run directly (no installation needed)

## What It Does

The elimination protocol runs a 9-step purge sequence:

| Step | Operation | Description |
|------|-----------|-------------|
| 1 | **Kill Processes** | Terminates all Zoom processes and services (116+ process variants) |
| 2 | **Uninstall Zoom** | 5-method escalating uninstall chain |
| 3 | **Remove Services** | Deletes Windows services, scheduled tasks, and WMI subscriptions |
| 4 | **Clean Registry** | Purges 70+ registry key paths across HKCU, HKLM, HKCR, WOW64 |
| 5 | **Wipe Fingerprints** | Eliminates device telemetry, Amcache, SRUM, credentials, prefetch |
| 6 | **Delete Folders** | Removes 40+ Zoom data locations across all user profiles |
| 7 | **Clean Recycle Bin** | Purges deleted Zoom files from the recycle bin |
| 8 | **Rebuild Icon Cache** | Clears cached Zoom icons from the shell |
| 9 | **Reinstall Zoom** | Downloads and installs a fresh copy with hardened settings |

### Settings Preservation
Your Zoom preferences (theme, audio devices, meeting options, video settings) are automatically backed up before each purge and restored after reinstall. No need to reconfigure Zoom after every reset.

### Fingerprint Targets
The core of Error 1132 resolution — these device identifiers cause the ban:
- Telemetry databases (telemetrydata.db, zoomus.db, zoom.db)
- CptService device ID storage
- Registry service fingerprints
- Amcache program execution database
- SRUM resource usage monitor
- Windows credentials and cached tokens
- Prefetch execution history, event logs, DNS cache
- Firewall rules, jump lists, crash dumps, certificates

## Options

| Option | Default | Description |
|--------|---------|-------------|
| Uninstall Zoom | On | Remove Zoom before purge |
| Reinstall Zoom | On | Download and install fresh Zoom after purge |
| Launch Zoom | Off | Auto-launch Zoom after reinstall |

## CLI Mode

Run headless from the command line:

```bash
# Full reset
1132-eliminator.exe --cli --full-reset

# Self-test (dry run, no changes)
1132-eliminator.exe --cli --self-test

# Skip reinstall
1132-eliminator.exe --cli --full-reset --no-reinstall

# Export session as JSON
1132-eliminator.exe --cli --full-reset --json

# List preset profiles
1132-eliminator.exe --cli --list-presets

# Apply a preset
1132-eliminator.exe --cli --apply-preset quiet-meetings
```

### Presets
Pre-built Zoom configuration profiles applied after reinstall:
- **quiet-meetings** — Mute on join, no video, no notifications
- **studio-audio** — High quality audio, original sound, stereo
- **low-bandwidth** — Disable video, optimize for slow connections
- **presentation** — HD video, screen sharing optimized
- **privacy** — Video off, no sync, no chat history

## Building from Source

```bash
npm install

# Run in development
npm start

# Build installer
npm run build:installer

# Build portable
npm run build

# Build both
npm run build:all
```

## Requirements
- Windows 10/11 (64-bit)
- Administrator privileges (UAC prompt on launch via Windows manifest)

## Version
**v3.2.0** — 1132 Eliminator

## Author
High Texas

## License
MIT
