# 1132 Remover - Complete Rebuild Plan

## Executive Summary

Rebuild the Electron app with proper error handling, modular architecture, and verified cleanup operations. Focus on **reliability over features** - a tool that works 100% of the time beats one with fancy features that fails silently.

---

## Architecture Redesign

### Current (Broken)
```
main.js (2,212 lines - everything)
renderer.js (283 lines)
preload.js (23 lines)
```

### Target (Clean)
```
src/
├── main/
│   ├── index.js              # App lifecycle, window management
│   ├── ipc-handlers.js       # All IPC handler registrations
│   ├── operations/
│   │   ├── process-killer.js # Kill Zoom processes (verified)
│   │   ├── uninstaller.js    # Uninstall Zoom (multiple methods)
│   │   ├── registry.js       # Registry cleanup (with verification)
│   │   ├── folders.js        # Folder deletion (with verification)
│   │   ├── services.js       # Services & scheduled tasks
│   │   ├── fingerprint.js    # Device fingerprint wipe (CptService, telemetry)
│   │   └── installer.js      # Download & install fresh Zoom
│   └── utils/
│       ├── logger.js         # Persistent file logging
│       ├── powershell.js     # Safe PowerShell execution wrapper
│       ├── spawn-safe.js     # Process spawning with timeout
│       └── verification.js   # Verify operations succeeded
├── renderer/
│   ├── index.js              # UI logic
│   ├── progress.js           # Progress tracking
│   └── styles.css            # Extracted from HTML
├── preload.js                # Context bridge (minimal)
└── shared/
    └── constants.js          # Paths, process names, registry keys
```

---

## Phase 1: Core Fixes (Make It Work)

### 1.1 Fix Process Killing
**Current:** Multiple methods, no verification
**Fix:** Verify processes actually stopped

```javascript
// operations/process-killer.js
async function killZoomProcesses() {
  const ZOOM_PROCESSES = [
    'Zoom', 'ZoomWebHost', 'CptHost', 'CptService', 'zCrashReport',
    // ... all 47 processes
  ];

  const results = [];

  for (const proc of ZOOM_PROCESSES) {
    // Kill with taskkill
    await spawnSafe('taskkill', ['/F', '/IM', `${proc}.exe`]);

    // Verify it's dead
    const stillRunning = await isProcessRunning(proc);
    if (stillRunning) {
      // Escalate to WMIC
      await spawnSafe('wmic', ['process', 'where', `name='${proc}.exe'`, 'delete']);
    }

    // Final verification
    const finalCheck = await isProcessRunning(proc);
    results.push({ process: proc, killed: !finalCheck });
  }

  return results;
}
```

### 1.2 Fix Uninstaller (Critical)
**Current:** Uses placeholder GUID that never works
**Fix:** Multiple verified methods

```javascript
// operations/uninstaller.js
async function uninstallZoom() {
  const methods = [
    // Method 1: Zoom's own uninstaller
    async () => {
      const paths = [
        'C:\\Program Files\\Zoom\\bin\\Installer.exe',
        'C:\\Program Files (x86)\\Zoom\\bin\\Installer.exe',
        path.join(process.env.LOCALAPPDATA, 'Programs\\Zoom\\Installer.exe')
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          await spawnSafe(p, ['/uninstall'], { timeout: 60000 });
          return true;
        }
      }
      return false;
    },

    // Method 2: WMI (actually works)
    async () => {
      const result = await spawnSafe('wmic', [
        'product', 'where', 'name like "%Zoom%"', 'call', 'uninstall', '/nointeractive'
      ], { timeout: 120000 });
      return result.exitCode === 0;
    },

    // Method 3: PowerShell Get-Package
    async () => {
      const script = `
        $pkg = Get-Package -Name '*Zoom*' -ErrorAction SilentlyContinue
        if ($pkg) {
          $pkg | Uninstall-Package -Force
          $true
        } else {
          $false
        }
      `;
      return await runPowerShell(script);
    }
  ];

  for (const method of methods) {
    try {
      const success = await method();
      if (success) return { success: true, method: methods.indexOf(method) };
    } catch (e) {
      // Try next method
    }
  }

  return { success: false, error: 'All uninstall methods failed' };
}
```

### 1.3 Fix Registry Cleanup (Critical)
**Current:** Returns hardcoded `{ deleted: 3 }` even when nothing deleted
**Fix:** Verify each deletion

```javascript
// operations/registry.js
async function cleanRegistry() {
  const keys = [
    'HKCU\\Software\\Zoom',
    'HKCU\\Software\\ZoomUMX',
    'HKCU\\Software\\zoom.us',
    'HKLM\\Software\\Zoom',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    // ... all keys
  ];

  const results = [];

  for (const key of keys) {
    // Check if exists first
    const exists = await registryKeyExists(key);
    if (!exists) {
      results.push({ key, status: 'not_found' });
      continue;
    }

    // Delete it
    await spawnSafe('reg', ['delete', key, '/f']);

    // Verify deletion
    const stillExists = await registryKeyExists(key);
    results.push({
      key,
      status: stillExists ? 'FAILED' : 'deleted'
    });
  }

  const failed = results.filter(r => r.status === 'FAILED');
  if (failed.length > 0) {
    throw new Error(`Failed to delete: ${failed.map(f => f.key).join(', ')}`);
  }

  return results;
}
```

### 1.4 Add Timeout Wrapper
**Current:** Operations can hang forever
**Fix:** Timeout wrapper for all spawn operations

```javascript
// utils/spawn-safe.js
function spawnSafe(command, args, options = {}) {
  const timeout = options.timeout || 30000;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      windowsHide: true,
      ...options
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timeout after ${timeout}ms: ${command} ${args.join(' ')}`));
    }, timeout);

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', d => stdout += d);
    proc.stderr?.on('data', d => stderr += d);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

### 1.5 Add Persistent Logging
**Current:** No logs, impossible to debug failures
**Fix:** File-based logging

```javascript
// utils/logger.js
const logPath = path.join(
  process.env.LOCALAPPDATA,
  '1132-Remover',
  `reset-${Date.now()}.log`
);

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };

  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');

  // Also send to renderer for UI display
  if (mainWindow) {
    mainWindow.webContents.send('log', entry);
  }
}
```

---

## Phase 2: Fingerprint Wipe (The Real Purpose)

### 2.1 Device Identity Locations

The **critical** locations that identify the device to Zoom:

```javascript
const FINGERPRINT_LOCATIONS = {
  // Device fingerprint databases
  telemetry: [
    '%APPDATA%\\Zoom\\data\\telemetrydata.db',
    '%LOCALAPPDATA%\\Zoom\\data\\telemetrydata.db'
  ],

  // CptService (Screen Sharing Service) - contains device ID
  cptService: [
    'C:\\ProgramData\\CptService',
    'C:\\ProgramData\\CptHost',
    'C:\\ProgramData\\Zoom CptService'
  ],

  // Registry device identifiers
  registryFingerprints: [
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService',
    'HKCU\\Software\\CptService'
  ],

  // Windows credentials (may contain cached tokens)
  credentials: [
    'zoom.us',
    'Zoom',
    'ZoomVideo',
    'ZoomUMX',
    'ZoomWorkplace'
  ],

  // Prefetch files (Windows tracks execution history)
  prefetch: [
    'C:\\Windows\\Prefetch\\*ZOOM*.pf',
    'C:\\Windows\\Prefetch\\*CPT*.pf'
  ]
};
```

### 2.2 Fingerprint Wipe Operation

```javascript
// operations/fingerprint.js
async function wipeDeviceFingerprint() {
  const steps = [];

  // 1. Delete telemetry databases (most important)
  for (const db of FINGERPRINT_LOCATIONS.telemetry) {
    const expanded = db.replace('%APPDATA%', process.env.APPDATA)
                       .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA);
    if (fs.existsSync(expanded)) {
      fs.unlinkSync(expanded);
      steps.push({ action: 'delete', path: expanded, success: true });
    }
  }

  // 2. Wipe CptService data (device identifiers)
  for (const folder of FINGERPRINT_LOCATIONS.cptService) {
    if (fs.existsSync(folder)) {
      await deleteFolder(folder);
      steps.push({ action: 'delete', path: folder, success: !fs.existsSync(folder) });
    }
  }

  // 3. Clean registry fingerprints
  for (const key of FINGERPRINT_LOCATIONS.registryFingerprints) {
    await spawnSafe('reg', ['delete', key, '/f']);
    steps.push({ action: 'registry', key });
  }

  // 4. Remove Windows credentials
  for (const target of FINGERPRINT_LOCATIONS.credentials) {
    await spawnSafe('cmdkey', ['/delete:' + target]);
    steps.push({ action: 'credential', target });
  }

  // 5. Clear prefetch (requires admin)
  const prefetchFiles = glob.sync('C:\\Windows\\Prefetch\\*ZOOM*.pf');
  for (const pf of prefetchFiles) {
    fs.unlinkSync(pf);
    steps.push({ action: 'prefetch', path: pf });
  }

  // 6. Flush DNS cache (may contain Zoom lookups)
  await spawnSafe('ipconfig', ['/flushdns']);

  return steps;
}
```

---

## Phase 3: UI Improvements

### 3.1 Progress Tracking
Real-time progress with step verification:

```javascript
const RESET_STEPS = [
  { id: 'kill', name: 'Stopping Zoom Processes', weight: 5 },
  { id: 'uninstall', name: 'Uninstalling Zoom', weight: 15 },
  { id: 'services', name: 'Removing Services', weight: 5 },
  { id: 'tasks', name: 'Removing Scheduled Tasks', weight: 5 },
  { id: 'registry', name: 'Cleaning Registry', weight: 15 },
  { id: 'fingerprint', name: 'Wiping Device Fingerprint', weight: 20 },
  { id: 'folders', name: 'Deleting Zoom Data', weight: 15 },
  { id: 'download', name: 'Downloading Fresh Zoom', weight: 10 },
  { id: 'install', name: 'Installing Zoom', weight: 10 }
];

function emitProgress(stepId, status, details = {}) {
  const step = RESET_STEPS.find(s => s.id === stepId);
  const completedWeight = RESET_STEPS
    .filter(s => s.id !== stepId && completedSteps.has(s.id))
    .reduce((sum, s) => sum + s.weight, 0);

  mainWindow.webContents.send('progress', {
    step: step.name,
    percent: completedWeight + (status === 'complete' ? step.weight : step.weight / 2),
    status,
    ...details
  });
}
```

### 3.2 Error Recovery
Allow retry of failed steps:

```javascript
// If registry cleanup fails, offer retry
if (registryResult.failed.length > 0) {
  const retry = await dialog.showMessageBox({
    type: 'warning',
    message: `Failed to delete ${registryResult.failed.length} registry keys. Retry?`,
    buttons: ['Retry', 'Skip', 'Abort']
  });

  if (retry.response === 0) {
    // Retry with escalated privileges
    await cleanRegistry({ escalate: true });
  } else if (retry.response === 2) {
    throw new Error('User aborted');
  }
}
```

---

## Phase 4: Verification Layer

### 4.1 Post-Reset Verification
Verify the reset actually worked:

```javascript
async function verifyReset() {
  const issues = [];

  // Check no Zoom processes running
  const procs = await getRunningProcesses();
  const zoomProcs = procs.filter(p => p.toLowerCase().includes('zoom'));
  if (zoomProcs.length > 0) {
    issues.push({ type: 'process', items: zoomProcs });
  }

  // Check no Zoom registry keys
  for (const key of CRITICAL_REGISTRY_KEYS) {
    if (await registryKeyExists(key)) {
      issues.push({ type: 'registry', key });
    }
  }

  // Check no fingerprint data
  for (const fp of FINGERPRINT_LOCATIONS.cptService) {
    if (fs.existsSync(fp)) {
      issues.push({ type: 'fingerprint', path: fp });
    }
  }

  return {
    clean: issues.length === 0,
    issues
  };
}
```

---

## Implementation Order

1. **Week 1: Foundation**
   - [ ] Create modular file structure
   - [ ] Implement spawn-safe with timeouts
   - [ ] Implement persistent logger
   - [ ] Port process killer with verification

2. **Week 2: Core Operations**
   - [ ] Fix uninstaller (multiple methods)
   - [ ] Fix registry cleanup (with verification)
   - [ ] Implement fingerprint wipe
   - [ ] Add verification layer

3. **Week 3: UI & Polish**
   - [ ] Refactor renderer with proper state
   - [ ] Add error recovery dialogs
   - [ ] Add log viewer
   - [ ] Test on multiple Windows versions

4. **Week 4: Testing & Release**
   - [ ] Create test suite
   - [ ] Test on Windows 10/11
   - [ ] Test on fresh VM (verify 1132 bypass works)
   - [ ] Build release packages

---

## Success Criteria

The rebuild is successful when:

1. **Reliability:** Every operation verifies it succeeded
2. **Transparency:** Full log of what was changed
3. **Recovery:** Failed steps can be retried
4. **Verification:** Post-reset check confirms clean state
5. **Maintainability:** Modular code with clear separation
6. **Testability:** Unit tests for each operation module

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Zoom changes fingerprint locations | Keep fingerprint list in config, easy to update |
| Registry permissions block deletion | Use TrustedInstaller escalation or notify user |
| Antivirus flags as malware | Code sign the executable, submit to AV vendors |
| Breaks on Windows updates | Test on Windows Insider builds |
