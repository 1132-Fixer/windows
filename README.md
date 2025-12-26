# 1132 Remover

**Zoom Data Cleaner & System Reset Tool**

A powerful Windows utility to completely reset Zoom, removing all traces and reinstalling fresh. Built with Electron.

## Features

### Quick Reset & Reinstall
- Resets Zoom on current user account
- No Windows user management
- One-click complete reset

### Full Reset (with User)
- Creates dedicated Windows user for Zoom
- Complete isolation of Zoom data
- Advanced user management

### What It Does
1. Kills all Zoom processes
2. Completely uninstalls Zoom
3. Deletes ALL Zoom data (all users)
4. Removes Zoom services (CptService, ZoomCptService)
5. Cleans scheduled tasks
6. Clears registry entries (HKCU, HKLM, WOW6432Node)
7. Removes Windows credentials
8. Cleans prefetch files
9. Removes firewall rules
10. Flushes DNS cache
11. Downloads fresh Zoom installer
12. Reinstalls Zoom
13. Launches Zoom automatically

### Data Locations Cleaned
- `%APPDATA%\Zoom`
- `%LOCALAPPDATA%\Zoom`
- `%PROGRAMDATA%\Zoom`
- `C:\Program Files\Zoom`
- `C:\Program Files\Common Files\Zoom`
- All user profiles (`C:\Users\*`)
- And 50+ other locations including aliases

## Installation

### Option 1: Installer (Recommended)
1. Download `1132 Remover Setup.exe` from Releases
2. Run the installer
3. Desktop shortcut will be created automatically

### Option 2: Portable
1. Download `1132 Remover.exe` from Releases
2. Run directly (no installation needed)

## Building from Source

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build installer
npm run build:installer

# Build portable
npm run build
```

## Requirements
- Windows 10/11 (64-bit)
- Administrator privileges (required for full cleanup)

## Version
**v2.0.0**

## Author
High Texas

## License
MIT
