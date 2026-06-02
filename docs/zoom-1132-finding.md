# 1132 Fixer — Project Memory

## Key Finding (2026-03-21)

**Zoom Error 1132 ban follows the WINDOWS USER ACCOUNT, not hardware identifiers.**

- NOT tied to: IP address, MAC address, MachineGuid, volume serial, computer name, WMI hardware serials, SMBIOS data
- IS tied to: The Windows user profile / SID / DPAPI keys
- Proof: Opening Zoom on a brand new Windows user works error-free every time
- Implication: All hardware fingerprint rotation (MachineGuid, MAC spoofing, volume serial, SMBIOS, WMI serials, etc.) is unnecessary
- The correct fix: Create a fresh Windows user → launch Zoom as that user → clean DPAPI keys = new device identity
