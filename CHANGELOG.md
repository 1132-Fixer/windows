# Changelog

All notable changes to 1132 Remover will be documented in this file.

## [1.1.0] - 2026-01-13

### Added

**Version-Aware Preference System**
- Detect Zoom version from executable file properties
- Template selection hierarchy: exact match → major.minor → major → base
- Built-in templates for Zoom 6.5, 6.6, 6.7 and base fallback
- Full zoomus.conf key mapping (audio, video, appearance, notifications)

**Diff-Based Verification**
- Snapshot system captures config at pre-write, post-write, post-launch
- Compare what you applied vs what Zoom changed after launch
- Per-build diff history saved to `%LOCALAPPDATA%\1132-Remover\zoom-pref-diffs\`
- `waitForFileSettle()` detects when config file stops changing

**Preference Manager**
- Single source of truth for all UI-configurable preferences
- Bidirectional UI ↔ conf key mapping with validation
- `applyPreferences()` - write zoomus.conf with automatic snapshots
- `verifyPreferences()` - compare state after Zoom launch
- `applyAndVerify()` - full apply + launch + verify cycle

**New IPC Handlers**
- `get-zoom-pref-options` - preference schema for UI rendering
- `get/set-user-zoom-prefs` - persist user preference choices
- `apply-zoom-prefs` - write preferences to zoomus.conf
- `verify-zoom-prefs` - diff after Zoom launch
- `get-last-zoom-pref-diff` - retrieve last diff result
- `detect-zoom-version` - get installed Zoom version info
- `full-reset-with-prefs` - one-click reset + prefs mode

**One-Click Mode**
- `full-reset-with-prefs` IPC handler combines:
  - Full reset (uninstall, wipe, reinstall)
  - Apply user preferences before first launch
  - Launch Zoom and verify what stuck
  - Report what Zoom modified
- Builds intelligence about "what sticks" per Zoom version

---

## [1.0.1] - 2026-01-13

### Added

**JSON Session Export**
- `--json` flag exports session summary as JSON file
- Includes all step results, timing data, and verification status
- Useful for support tickets and fleet tooling integration

**Preset Profiles**
- 5 built-in preset profiles for common use cases:
  - `quiet-meetings` - Mute on join, no video, minimal notifications
  - `studio-audio` - High quality audio for podcasting/streaming
  - `low-bandwidth` - Optimized for slow connections
  - `presentation` - Screen sharing optimized
  - `privacy` - Maximum privacy settings
- `--list-presets` to view available profiles
- `--apply-preset <id>` to apply a profile

**Self-Test Mode**
- `--self-test` runs diagnostic check without making changes
- Reports Zoom installation status, registry entries, data folders
- Counts fingerprint files and running services
- Exit code indicates if cleanup is needed

---

## [1.0.0] - 2026-01-13

First production-ready release with comprehensive testing and hardening.

### Added

**Operational Resilience**
- Artifact verification after MSI install - catches corrupt installers that return success but fail to install
- Timeout handling for all subprocess operations with clear error messages
- Admin privilege detection with user-friendly prompts
- Fallback installer URL when primary download fails

**Observability & Logging**
- Session summary with timing data and verification results
- Entry/exit logging for every phase
- Detailed MSI/EXE installer logging with duration tracking
- Structured logging throughout all operations

**Registry Cleanup**
- Added `REGISTRY_CLEANUP_PATHS` for value-by-value cleanup of mixed-data keys
- UserAssist cleanup (execution history)
- BAM/DAM activity moderator cleanup
- Shell history cleanup (RecentDocs, ComDlg32)
- MUI cache cleanup
- Feature usage tracking cleanup

**Fingerprint Wipe**
- CptService folder cleanup (screen sharing device ID)
- Prefetch file cleanup
- Jump list cleanup
- VirtualStore cleanup
- Windows Error Reporting cleanup
- Icon cache rebuild
- Recycle bin cleanup with Zoom file filtering

**System Traces**
- SRUM (System Resource Usage Monitor) awareness
- Amcache awareness
- Notification database cleanup

**CLI Mode**
- Full headless operation with `--cli --full-reset`
- Options: `--reinstall`, `--no-reinstall`, `--uninstall`, `--no-uninstall`
- Exit codes reflect actual success/failure
- Progress output with session summary

### Changed

- Exit codes now reflect actual operation success, not just process completion
- Uninstall verification checks for remaining artifacts, not just exit code
- Folder deletion distinguishes "deleted" vs "nothing to delete"
- All operations return structured results with success/existed/deleted fields

### Fixed

- MSI installs that "vanished" - now verified with artifact check
- Silent failures when uninstall already completed
- Ambiguous outcomes from cleanup operations
- Exit code 0 blindly trusted even when operation failed
- Missing logging for installer completion

### Technical

- `spawnSafe` wrapper with consistent timeout and error handling
- `runPowerShell` using stdin to avoid escaping issues
- Registry key existence check before deletion attempts
- Structured return values from all operations

---

## [Previous Versions]

### 2.0.0
- Major update with Full Reset & Reinstall
- Added UI with multiple reset options

### 1.0.0 (Initial)
- Initial release
- Basic Zoom cleanup functionality
