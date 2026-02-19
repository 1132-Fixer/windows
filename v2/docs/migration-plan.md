# Migration Plan: 1132-Remover → Windows App Remediator

## Overview

This document maps the current 1132-Remover modules to the new v2 architecture and outlines a phased migration strategy.

---

## Current Module Inventory

```
src/
├── main/
│   ├── index.js                      # Electron entry point
│   ├── ipc-handlers.js               # IPC handlers (full-reset, quick-reset, etc.)
│   └── operations/
│       ├── process-killer.js         # Kill Zoom processes and services
│       ├── registry.js               # Delete registry keys
│       ├── folders.js                # Delete folders
│       ├── services.js               # Stop/delete services and tasks
│       ├── fingerprint.js            # Wipe device fingerprints (OUT OF SCOPE)
│       ├── uninstaller.js            # Uninstall Zoom
│       ├── installer.js              # Download and install Zoom
│       ├── pref-manager.js           # Manage Zoom preferences
│       ├── self-test.js              # Dry-run audit
│       └── presets.js                # Preset configurations
│   └── utils/
│       ├── spawn-safe.js             # Safe child_process wrapper
│       └── logger.js                 # Logging
├── shared/
│   ├── constants.js                  # Zoom paths, registry keys, processes
│   └── zoom-prefs/                   # Zoom preference utilities
└── renderer/                         # UI (HTML/CSS/JS)
```

---

## Module Mapping: Current → v2

### 1. Process Killer (`process-killer.js`)

**Current Functions:**
- `stopZoomServices()` - Stop Windows services
- `killProcess(processName)` - Kill single process (5 methods)
- `killAllZoomProcesses(onProgress)` - Kill all Zoom processes
- `findZoomProcesses()` - Enumerate running processes
- `isZoomRunning()` - Check if processes exist
- `waitForZoomExit(timeoutMs)` - Poll until processes exit

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `findZoomProcesses()` | ProcessScanner | `acquisition/scanners/process.scanner.ts` |
| `killProcess()` | StopProcessStep | `remediation/steps/stop-process.step.ts` |
| `killAllZoomProcesses()` | StepEngine (orchestrates steps) | `remediation/step-engine.ts` |
| `stopZoomServices()` | StopServiceStep | `remediation/steps/stop-service.step.ts` |
| `isZoomRunning()` | Verifier (invariant check) | `verification/verifier.ts` |

**Migration Notes:**
- Split enumeration (scanner) from action (step)
- Remove hardcoded process list → load from `products/zoom.yaml`
- Add ownership validation before killing

---

### 2. Registry (`registry.js`)

**Current Functions:**
- `cleanRegistry(onProgress)` - Delete all Zoom registry keys
- `verifyRegistryClean()` - Confirm keys deleted

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| Registry enumeration | RegistryScanner | `acquisition/scanners/registry.scanner.ts` |
| `cleanRegistry()` | DeleteRegistryKeyStep | `remediation/steps/delete-regkey.step.ts` |
| `verifyRegistryClean()` | Verifier (invariant) | `verification/invariants.ts` |

**Migration Notes:**
- Split enumeration from deletion
- Add registry backup before deletion (for rollback)
- Load key paths from `products/zoom.yaml`
- Policy check before each deletion

---

### 3. Folders (`folders.js`)

**Current Functions:**
- `deleteAllZoomFolders(onProgress)` - Delete folders recursively
- `scanZoomFolders()` - Find existing folders
- `scanAllUserProfiles()` - Check all user accounts
- `calculateTotalSize()` - Size audit
- `verifyFoldersDeleted()` - Confirm deletion

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `scanZoomFolders()` | FileSystemScanner | `acquisition/scanners/filesystem.scanner.ts` |
| `scanAllUserProfiles()` | ScanContext (userProfiles) | `acquisition/types.ts` |
| `deleteAllZoomFolders()` | RemoveFolderStep | `remediation/steps/remove-folder.step.ts` |
| `verifyFoldersDeleted()` | Verifier (invariant) | `verification/invariants.ts` |

**Migration Notes:**
- Scanner returns artifact list with metadata (size, file count, hashes)
- Step receives specific paths from plan (not hardcoded)
- Policy boundary check before deletion

---

### 4. Services (`services.js`)

**Current Functions:**
- `stopService(serviceName)` - Stop service (3 methods)
- `deleteService(serviceName)` - Delete service registry
- `deleteScheduledTask(taskName)` - Remove task
- `cleanServicesAndTasks(onProgress)` - Master cleanup

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| Service enumeration | ServiceScanner | `acquisition/scanners/service.scanner.ts` |
| Task enumeration | TaskScanner | `acquisition/scanners/task.scanner.ts` |
| `stopService()` | StopServiceStep | `remediation/steps/stop-service.step.ts` |
| `deleteService()` | DeleteRegistryKeyStep | `remediation/steps/delete-regkey.step.ts` |
| `deleteScheduledTask()` | DeleteScheduledTaskStep | `remediation/steps/delete-task.step.ts` |

**Migration Notes:**
- Separate service scanning from task scanning
- Service deletion = registry deletion (reuse step)
- Add service state tracking (before/after)

---

### 5. Uninstaller (`uninstaller.js`)

**Current Functions:**
- `isZoomInstalled()` - Check via file system and WMI
- `uninstallWithOwnInstaller()` - Use Zoom's uninstaller
- `uninstallViaWmi()` - Use Windows package manager
- `uninstallForceful()` - Force delete
- `uninstallZoom(onProgress)` - Master function

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `isZoomInstalled()` | FileSystemScanner + RegistryScanner | acquisition layer |
| `uninstallWithOwnInstaller()` | RunUninstallerStep | `remediation/steps/run-uninstaller.step.ts` |
| `uninstallViaWmi()` | RunUninstallerStep (fallback) | `remediation/steps/run-uninstaller.step.ts` |

**Migration Notes:**
- Uninstaller path comes from `products/zoom.yaml`
- Multiple uninstall methods are fallbacks in single step
- Remove `uninstallForceful()` - use explicit folder/registry steps instead

---

### 6. Installer (`installer.js`)

**Current Functions:**
- `downloadZoomInstaller(onProgress)` - Download from zoom.us
- `installZoom(installerPath, onProgress)` - Silent install
- `launchZoom()` - Start Zoom
- `cleanupInstaller(path)` - Delete temp installer
- `isZoomInstalled()` - Verify installation

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `downloadZoomInstaller()` | ReinstallStep (download phase) | `remediation/steps/reinstall.step.ts` |
| `installZoom()` | ReinstallStep (install phase) | `remediation/steps/reinstall.step.ts` |
| `launchZoom()` | Out of scope (user action) | — |
| `isZoomInstalled()` | Verifier | `verification/verifier.ts` |

**Migration Notes:**
- Download URL from `products/zoom.yaml`
- Signature verification on downloaded installer
- Progress reporting via step context

---

### 7. Constants (`constants.js`)

**Current Content:**
- `ZOOM_PROCESSES` (100+ process names)
- `ZOOM_DATA_PATHS` (30+ locations)
- `REGISTRY_KEYS` (100+ registry locations)
- `ZOOM_SERVICES`, `ZOOM_SCHEDULED_TASKS`
- `FINGERPRINT_LOCATIONS` (OUT OF SCOPE)
- `ZOOM_INSTALLER` config

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| All Zoom constants | Product Definition | `config/products/zoom.yaml` |

**Migration Notes:**
- YAML is more maintainable than JS constants
- Enables adding new products without code changes
- `FINGERPRINT_LOCATIONS` removed (out of scope for ethical tool)

---

### 8. IPC Handlers (`ipc-handlers.js`)

**Current Handlers:**
- `full-reset` - Complete cleanup and reinstall
- `quick-reset` - User-only cleanup
- `audit` - Read-only scan
- `kill-zoom` - Force kill processes
- `launch-zoom` - Start application
- `check-zoom` - Verify installation
- `full-reset-with-prefs` - Reset + preferences

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `audit` | `audit` handler | `ipc/handlers.ts` |
| `full-reset` | `build-plan` + `execute-plan` | `ipc/handlers.ts` |
| `quick-reset` | `build-plan` (clean mode) + `execute-plan` | `ipc/handlers.ts` |
| `check-zoom` | `verify` handler | `ipc/handlers.ts` |

**Migration Notes:**
- Split monolithic handlers into discrete operations
- Add `build-plan`, `execute-plan`, `verify`, `export-report`
- Remove `kill-zoom`, `launch-zoom` (user-initiated actions)

---

### 9. Fingerprint (`fingerprint.js`) — OUT OF SCOPE

**Current Functions:**
- `wipeTelemetryDatabases()` - Delete tracking DBs
- `wipeCptServiceData()` - Remove service identifiers
- `cleanRecycleBin()` - Delete Recycle Bin
- `rebuildIconCache()` - Restart Explorer
- `cleanJumpLists()` - Remove taskbar history

**Migration:**
- **NOT MIGRATED** - These functions enable ban evasion
- Remove from v2 codebase entirely
- Document exclusion in README

---

### 10. Logger (`logger.js`)

**Current Functions:**
- `initLogger()` - Create log file
- `info()`, `ok()`, `warn()`, `error()`, `debug()` - Log methods
- `section()`, `logStep()` - Structured logging
- `recordStep()`, `setVerification()` - Session tracking
- `exportSessionJson()` - JSON export
- `finalize()` - Close log

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| All logging | TamperEvidentLog | `security/tamper-evident-log.ts` |
| JSON export | ReportWriter | `reporting/report-writer.ts` |

**Migration Notes:**
- Add hash chaining for tamper evidence
- Integrate with transaction log
- Structured event format

---

### 11. Spawn Safe (`spawn-safe.js`)

**Current Functions:**
- `spawnSafe(command, args, options)` - Execute command
- `runPowerShell(script, options)` - Execute PowerShell
- `isProcessRunning(processName)` - Check process
- `deleteRegistryKey(keyPath)` - Delete registry
- `deleteRegistryValue(keyPath, valueName)` - Delete value
- `registryKeyExists(keyPath)` - Check key

**Maps To:**

| Current | v2 Module | v2 File |
|---------|-----------|---------|
| `spawnSafe()` | exec utility | `util/exec.ts` |
| `runPowerShell()` | exec utility | `util/exec.ts` |
| Registry functions | RegistryScanner / Steps | acquisition + remediation |

**Migration Notes:**
- Keep core exec wrapper
- Move registry helpers to appropriate modules
- Add timeout and error handling improvements

---

## Out-of-Scope Modules (Not Migrated)

These modules are **intentionally excluded** from v2:

| Module | Reason |
|--------|--------|
| `fingerprint.js` | Enables ban evasion (device identity manipulation) |
| `FINGERPRINT_LOCATIONS` | Same as above |
| `SYSTEM_TRACE_LOCATIONS` | Deletion of OS forensic data (Amcache, SRUM, Prefetch) |

---

## Migration Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Establish core architecture with Zoom product definition

**Commits:**
1. Create v2 directory structure
2. Add shared types (`types.ts`)
3. Add product definition schema + Zoom YAML
4. Implement policy module with tests
5. Create acquisition layer interfaces
6. Implement FileSystemScanner (migrate from `folders.js`)
7. Implement RegistryScanner (migrate from `registry.js`)

**Deliverable:** Read-only audit capability

---

### Phase 2: Planning + Remediation (Weeks 3-4)

**Goal:** Implement plan building and step execution

**Commits:**
8. Implement ProcessScanner (migrate from `process-killer.js`)
9. Implement ServiceScanner, TaskScanner (migrate from `services.js`)
10. Implement plan builder with ordering logic
11. Implement step engine (transactional)
12. Implement steps: StopProcess, StopService
13. Implement steps: RemoveFolder, DeleteRegistryKey
14. Implement steps: RunUninstaller, DeleteScheduledTask
15. Implement ReinstallStep (migrate from `installer.js`)

**Deliverable:** Full remediation capability (CLI)

---

### Phase 3: Verification + Reporting (Weeks 5-6)

**Goal:** Add verification and attestation

**Commits:**
16. Implement verification engine + invariants
17. Implement snapshot diff
18. Implement transaction log with hash chaining
19. Implement attestation report generator
20. Add post-reboot verification scheduling
21. Implement IPC handlers
22. Add CLI mode

**Deliverable:** Full verification + reports

---

### Phase 4: UI + Polish (Weeks 7-8)

**Goal:** Complete UI and release prep

**Commits:**
23. Implement Audit screen
24. Implement Plan screen
25. Implement Approve screen
26. Implement Execute screen (real-time progress)
27. Implement Verify screen
28. Add export functionality
29. Integration testing
30. Documentation + release

**Deliverable:** v2.0 release

---

## Parallel Development Strategy

During migration, both v1 and v2 can coexist:

```
1132-Remover/
├── src/           # v1 (current)
├── v2/            # v2 (new)
├── package.json   # Both can run
└── README.md
```

**Development commands:**
```bash
# Run v1
npm run start

# Run v2 (once ready)
npm run start:v2

# Run v2 tests
npm run test:v2
```

---

## Function-Level Migration Map

### `process-killer.js` → v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT: process-killer.js                                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  stopZoomServices()          ──────►  StopServiceStep.execute()        │
│                                       (for each service in plan)        │
│                                                                         │
│  killProcess(name)           ──────►  StopProcessStep.execute()        │
│                                       (policy check first)              │
│                                                                         │
│  killAllZoomProcesses()      ──────►  StepEngine.execute(plan)         │
│                                       (orchestrates all steps)          │
│                                                                         │
│  findZoomProcesses()         ──────►  ProcessScanner.scan(ctx)         │
│                                       (returns ProcessArtifact[])       │
│                                                                         │
│  isZoomRunning()             ──────►  Verifier.check('no_vendor_procs') │
│                                       (invariant check)                 │
│                                                                         │
│  waitForZoomExit()           ──────►  StopProcessStep.verify()         │
│                                       (built into step)                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### `folders.js` → v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT: folders.js                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  scanZoomFolders()           ──────►  FileSystemScanner.scan(ctx)      │
│                                       (returns FileArtifact[])          │
│                                                                         │
│  scanAllUserProfiles()       ──────►  ScanContext.userProfiles         │
│                                       (passed to all scanners)          │
│                                                                         │
│  deleteAllZoomFolders()      ──────►  RemoveFolderStep.execute()       │
│                                       (for each folder in plan)         │
│                                                                         │
│  calculateTotalSize()        ──────►  FileArtifact.metadata.size       │
│                                       (captured during scan)            │
│                                                                         │
│  verifyFoldersDeleted()      ──────►  Verifier.check('files_removed')  │
│                                       (invariant check)                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### `registry.js` → v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT: registry.js                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  cleanRegistry()             ──────►  DeleteRegistryKeyStep.execute()  │
│    (iterates keys)                    (for each key in plan)           │
│                                                                         │
│  Key enumeration             ──────►  RegistryScanner.scan(ctx)        │
│    (from constants.js)                (returns RegistryArtifact[])     │
│                                                                         │
│  verifyRegistryClean()       ──────►  Verifier.check('registry_clean') │
│                                       (invariant check)                 │
│                                                                         │
│  Backup (not implemented)    ──────►  DeleteRegistryKeyStep.backup     │
│                                       (new: .reg export before delete)  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Testing Strategy for Migration

### Unit Tests (per module)

```typescript
// Example: test FileSystemScanner migration
describe('FileSystemScanner', () => {
  it('should find same files as legacy scanZoomFolders()', async () => {
    // Run both implementations
    const legacyResult = await scanZoomFolders();
    const v2Result = await fileSystemScanner.scan(ctx);

    // Compare results
    expect(v2Result.map(a => a.path).sort())
      .toEqual(legacyResult.map(f => f.path).sort());
  });
});
```

### Integration Tests

```typescript
// Example: test full uninstall flow
describe('Uninstall Flow', () => {
  it('should produce same outcome as legacy full-reset', async () => {
    // Snapshot before
    const before = await audit();

    // Run v2 uninstall
    const plan = await buildPlan({ mode: 'uninstall', ... });
    await executePlan(plan);

    // Verify outcome matches legacy
    const verification = await verify();
    expect(verification.status).toBe('pass');
  });
});
```

### Regression Tests

Each bug fix in v1 becomes a test case in v2:
- "Service respawns after kill" → Test that StopService runs before StopProcess
- "Folder locked" → Test retry logic in RemoveFolderStep
- "Registry re-created" → Test verification detects re-creation

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing functionality | Keep v1 working during migration |
| Policy too restrictive | Comprehensive policy tests |
| Missing edge cases | Import all v1 test scenarios |
| Performance regression | Benchmark v1 vs v2 |
| User confusion | Clear v2 naming/branding |

---

## Success Criteria

Migration is complete when:

1. ✅ All v1 functionality (except fingerprint) works in v2
2. ✅ Policy prevents out-of-scope modifications
3. ✅ Verification confirms remediation success
4. ✅ Attestation reports are generated
5. ✅ All tests pass
6. ✅ Documentation complete
7. ✅ v1 can be deprecated

---

## Recommended First Commit

Start with **plan-builder + policy** because:

1. Forces architectural decisions early
2. Policy is the safety foundation
3. Testable in isolation
4. Unblocks parallel work on scanners and steps

```bash
# First commit contents
v2/
├── src/
│   ├── shared/types.ts
│   └── main/core/
│       ├── config/schema.ts
│       ├── planning/types.ts
│       └── remediation/policy.ts
└── tests/
    └── unit/
        ├── policy.test.ts
        └── plan-builder.test.ts
```
