# 1132 Remover

**Zoom Data Cleaner & System Reset Tool**

A powerful Windows utility to completely reset Zoom, removing all traces and reinstalling fresh. Built with Electron.

## Two Versions Available

### 1132 Remover (Full Version)
Full-featured app with multiple options:
- **Quick Reset & Reinstall** - Reset on current account
- **Full Reset (with User)** - Creates dedicated Windows user
- **Create Zoom User** - User management options
- **Launch Zoom as User** - Run Zoom in isolated environment

### 1132 Quick Reset (Simple Version)
Streamlined single-button app in `/simple` folder:
- One button: "Reset & Reinstall Zoom"
- Detects if Zoom is installed, prompts to install if not
- Resets on current user account only
- Auto-launches Zoom after reinstall
- Auto-closes when complete

## Features

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

### Full Version
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

### Simple Version
```bash
cd simple

# Install dependencies
npm install

# Run in development
npm start

# Build installer
npm run build
```

## Requirements
- Windows 10/11 (64-bit)
- Administrator privileges (required for full cleanup)

## Versions
- **1132 Remover**: v2.0.0
- **1132 Quick Reset**: v2.1.0

## Author
High Texas

## License
MIT
