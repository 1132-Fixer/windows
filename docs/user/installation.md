# Installation

## Requirements

- Windows 10 or Windows 11, x64
- Administrator approval when Windows asks
- The Windows **Secondary Logon** service available
- Zoom Workplace installed machine-wide (typical path
  `C:\Program Files\Zoom\bin\Zoom.exe`)

## Download

Use the latest [Setup or Portable build](https://github.com/1132-Fixer/windows/releases/latest)
from this repository.

- **Setup** (`1132-Fixer-Setup-*.exe`) — per-machine installer
- **Portable** (`1132-Fixer-Portable-*.exe`) — no installer

Do not download Zoom from 1132 Fixer. Get Zoom from Zoom's official Download
Center if it is not already installed.

## First run

1. Open **1132 Fixer**.
2. Read the safety note. The app deletes and recreates the local `user1`
   helper account.
3. Press **Fix now**.
4. Approve any Windows prompt.
5. Sign in to Zoom in the new session if Zoom asks.
6. Optionally create the desktop shortcut.

## Updates

- **v6.1.0** and later on this repository poll
  `1132-Fixer/windows` GitHub Releases.
- **v5.6.0** polls the Botify broker, which serves the same current installer.
- **v5.5.1 and earlier** still poll
  `PrimeUpYourLife/1132-Fixer-Windows-Releases`. That feed remains for those
  clients. Install a current release from this repository once to move off it.

The update location is fixed when a build is made. An existing install cannot
be pointed somewhere else remotely.

Current builds are **unsigned**. Windows SmartScreen may warn. That warning is
accurate until signing exists. See [code signing](../security/code-signing.md).
