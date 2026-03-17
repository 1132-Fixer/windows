/**
 * 1132 Remover - Zoom Persistence Snapshot & Diff
 * Captures point-in-time snapshots of Zoom artifacts and compares them.
 * Based on Zoom Persistence Toolkit by High Texas.
 *
 * Features:
 * - takeSnapshot(): JSON snapshot of all Zoom artifacts
 * - compareSnapshots(): Before/after diff with forensic matrix
 * - checkPersistence(): Quick monitor for re-created artifacts
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const {
  ZOOM_PROCESSES,
  ZOOM_DATA_PATHS,
  ZOOM_SERVICES,
  ZOOM_CREDENTIALS,
  REGISTRY_KEYS,
  FINGERPRINT_LOCATIONS
} = require('../../shared/constants');

// Snapshot storage directory (inside user's appdata for the app)
const SNAPSHOT_DIR = path.join(
  process.env.APPDATA || process.env.LOCALAPPDATA,
  '1132 Eliminator',
  'Snapshots'
);

/**
 * Ensure snapshot directory exists
 */
function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

/**
 * Capture a point-in-time snapshot of all Zoom persistence artifacts
 * @param {string} label - Snapshot label (e.g. "Before", "After")
 * @returns {Promise<{success: boolean, path: string, snapshot: Object}>}
 */
async function takeSnapshot(label = 'Snapshot') {
  logger.info(`Taking persistence snapshot: ${label}`);
  ensureSnapshotDir();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = path.join(SNAPSHOT_DIR, `ZoomSnapshot_${safeLabel}_${ts}.json`);

  const snapshot = {
    meta: {
      label,
      timestamp: new Date().toISOString(),
      computerName: process.env.COMPUTERNAME || 'unknown',
      user: process.env.USERNAME || 'unknown'
    },
    processes: [],
    services: [],
    scheduledTasks: [],
    firewallRules: [],
    credentials: [],
    msiProducts: [],
    registry: {
      keys: [],
      runValues: []
    },
    paths: {
      folders: [],
      files: [],
      prefetchFiles: []
    }
  };

  // --- Running processes ---
  try {
    const result = await spawnSafe('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000 });
    const lines = (result.stdout || '').split('\n');
    for (const line of lines) {
      const match = line.match(/"([^"]+\.exe)"/i);
      if (match) {
        const procName = match[1].toLowerCase();
        if (procName.includes('zoom') || procName.includes('cpt') || procName.includes('zcs')) {
          snapshot.processes.push(match[1]);
        }
      }
    }
    snapshot.processes = [...new Set(snapshot.processes)];
  } catch (e) {
    logger.debug('Process snapshot failed', { error: e.message });
  }

  // --- Services ---
  try {
    const svcList = ZOOM_SERVICES.map(s => "'" + s + "'").join(',');
    const psScript = '$out = @()\n' +
      '$names = @(' + svcList + ')\n' +
      'foreach ($n in $names) {\n' +
      '  $svc = Get-Service -Name $n -ErrorAction SilentlyContinue\n' +
      '  if ($svc) { $out += "$($svc.Name)|$($svc.DisplayName)|$($svc.Status)" }\n' +
      '}\n' +
      'Get-Service | Where-Object { $_.Name -like \'*zoom*\' -or $_.Name -like \'*cpt*\' } | ForEach-Object {\n' +
      '  if ($_.Name -notin $names) { $out += "$($_.Name)|$($_.DisplayName)|$($_.Status)" }\n' +
      '}\n' +
      '$out -join [char]10';
    const result = await runPowerShell(psScript, { timeout: 15000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        if (parts.length >= 3) {
          snapshot.services.push({ name: parts[0], displayName: parts[1], status: parts[2] });
        }
      }
    }
  } catch (e) {
    logger.debug('Service snapshot failed', { error: e.message });
  }

  // --- Scheduled Tasks ---
  try {
    const result = await runPowerShell(`
      Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.TaskName -like '*Zoom*' -or $_.TaskPath -like '*Zoom*'
      } | ForEach-Object {
        "$($_.TaskPath)$($_.TaskName)|$($_.State)"
      }
    `, { timeout: 15000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        snapshot.scheduledTasks.push({ name: parts[0], state: parts[1] || '' });
      }
    }
  } catch (e) {
    logger.debug('Task snapshot failed', { error: e.message });
  }

  // --- Firewall Rules ---
  try {
    const result = await runPowerShell(`
      Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' } |
        ForEach-Object { "$($_.DisplayName)|$($_.Enabled)|$($_.Direction)|$($_.Action)" }
    `, { timeout: 15000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        snapshot.firewallRules.push({
          displayName: parts[0], enabled: parts[1], direction: parts[2], action: parts[3]
        });
      }
    }
  } catch (e) {
    logger.debug('Firewall snapshot failed', { error: e.message });
  }

  // --- Credentials ---
  try {
    const result = await spawnSafe('cmdkey', ['/list'], { timeout: 5000 });
    const output = result.stdout || '';
    for (const target of ZOOM_CREDENTIALS) {
      if (output.toLowerCase().includes(target.toLowerCase())) {
        snapshot.credentials.push(target);
      }
    }
  } catch (e) {
    logger.debug('Credential snapshot failed', { error: e.message });
  }

  // --- MSI Products ---
  try {
    const result = await runPowerShell(`
      $roots = @(
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      )
      foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
          $p = Get-ItemProperty $_.PsPath -ErrorAction SilentlyContinue
          if (-not $p -or -not $p.DisplayName -or $p.DisplayName -notmatch 'Zoom') { return }
          $u = $p.UninstallString
          if (-not $u) { return }
          $m = [regex]::Match($u, '\\{[0-9A-Fa-f\\-]{36}\\}')
          if ($m.Success) {
            Write-Output "$($p.DisplayName)|$($p.DisplayVersion)|$($m.Value)"
          }
        }
      }
    `, { timeout: 30000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        if (parts.length >= 3) {
          snapshot.msiProducts.push({ displayName: parts[0], version: parts[1], guid: parts[2] });
        }
      }
    }
  } catch (e) {
    logger.debug('MSI product snapshot failed', { error: e.message });
  }

  // --- Registry keys ---
  const allKeys = [
    ...REGISTRY_KEYS.HKCU,
    ...REGISTRY_KEYS.HKLM,
    ...REGISTRY_KEYS.WOW64,
    ...(REGISTRY_KEYS.HKCR || []),
    ...(REGISTRY_KEYS.TRACING || [])
  ];

  // Check in batches via PowerShell for speed
  try {
    const keyList = allKeys.map(k => k.replace(/^HKCU\\/, 'HKCU:\\').replace(/^HKLM\\/, 'HKLM:\\').replace(/^HKCR\\/, 'HKCR:\\')).join("','");
    const result = await runPowerShell(`
      $keys = @('${keyList}')
      foreach ($k in $keys) { if (Test-Path $k -ErrorAction SilentlyContinue) { Write-Output $k } }
    `, { timeout: 30000 });

    if (result.stdout && result.stdout.trim()) {
      snapshot.registry.keys = result.stdout.trim().split('\n').map(s => s.trim()).filter(s => s);
    }
  } catch (e) {
    logger.debug('Registry key snapshot failed', { error: e.message });
  }

  // --- Run values ---
  try {
    const result = await runPowerShell(`
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomUMX','ZoomWorkplace')) {
        if (Get-ItemProperty -Path $runKey -Name $v -ErrorAction SilentlyContinue) {
          Write-Output "HKCU_Run|$v"
        }
      }
      $runKeyLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomCptService')) {
        if (Get-ItemProperty -Path $runKeyLM -Name $v -ErrorAction SilentlyContinue) {
          Write-Output "HKLM_Run|$v"
        }
      }
    `, { timeout: 10000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        snapshot.registry.runValues.push({ hive: parts[0], name: parts[1] });
      }
    }
  } catch (e) {
    logger.debug('Run value snapshot failed', { error: e.message });
  }

  // --- Folders ---
  for (const p of ZOOM_DATA_PATHS) {
    if (fs.existsSync(p)) {
      snapshot.paths.folders.push(p);
    }
  }

  // --- Telemetry files ---
  for (const f of FINGERPRINT_LOCATIONS.telemetryDatabases) {
    if (fs.existsSync(f)) {
      snapshot.paths.files.push(f);
    }
  }

  // --- Prefetch ---
  try {
    const result = await runPowerShell(`
      Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*.pf' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
      Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*CPT*.pf' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    `, { timeout: 10000 });

    if (result.stdout && result.stdout.trim()) {
      snapshot.paths.prefetchFiles = result.stdout.trim().split('\n').map(s => s.trim()).filter(s => s);
    }
  } catch (e) {
    logger.debug('Prefetch snapshot failed', { error: e.message });
  }

  // Write snapshot
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  logger.ok(`Snapshot saved: ${outPath}`);

  return { success: true, path: outPath, snapshot };
}

/**
 * Compare two snapshots and produce a diff with forensic matrix
 * @param {Object} before - Before snapshot object
 * @param {Object} after - After snapshot object
 * @returns {{diff: Object, matrix: Array}}
 */
function compareSnapshots(before, after) {
  function diffSet(bArr, aArr) {
    const bSet = new Set((bArr || []).map(String));
    const aSet = new Set((aArr || []).map(String));
    return {
      added: [...aSet].filter(x => !bSet.has(x)),
      removed: [...bSet].filter(x => !aSet.has(x)),
      kept: [...aSet].filter(x => bSet.has(x))
    };
  }

  const diff = {
    meta: {
      beforeLabel: before.meta?.label || 'Before',
      afterLabel: after.meta?.label || 'After',
      timestamp: new Date().toISOString()
    },
    sets: {
      processes: diffSet(before.processes, after.processes),
      services: diffSet(
        (before.services || []).map(s => s.name),
        (after.services || []).map(s => s.name)
      ),
      scheduledTasks: diffSet(
        (before.scheduledTasks || []).map(t => t.name),
        (after.scheduledTasks || []).map(t => t.name)
      ),
      firewallRules: diffSet(
        (before.firewallRules || []).map(r => r.displayName),
        (after.firewallRules || []).map(r => r.displayName)
      ),
      credentials: diffSet(before.credentials, after.credentials),
      msiProducts: diffSet(
        (before.msiProducts || []).map(p => `${p.displayName} ${p.version} ${p.guid}`),
        (after.msiProducts || []).map(p => `${p.displayName} ${p.version} ${p.guid}`)
      ),
      registryKeys: diffSet(before.registry?.keys, after.registry?.keys),
      folders: diffSet(before.paths?.folders, after.paths?.folders),
      files: diffSet(before.paths?.files, after.paths?.files),
      prefetchFiles: diffSet(before.paths?.prefetchFiles, after.paths?.prefetchFiles)
    }
  };

  // Build forensic matrix rows
  const matrix = [];
  function addRows(category, setDiff, notes) {
    for (const item of setDiff.added) {
      matrix.push({ category, item, before: false, after: true, change: 'ADDED', notes });
    }
    for (const item of setDiff.removed) {
      matrix.push({ category, item, before: true, after: false, change: 'REMOVED', notes });
    }
    for (const item of setDiff.kept) {
      matrix.push({ category, item, before: true, after: true, change: 'UNCHANGED', notes });
    }
  }

  addRows('Process', diff.sets.processes, '');
  addRows('Service', diff.sets.services, 'CPT/Sharing service may reappear on some builds');
  addRows('ScheduledTask', diff.sets.scheduledTasks, 'Update tasks may be enterprise-dependent');
  addRows('FirewallRule', diff.sets.firewallRules, 'Often re-created on install');
  addRows('Credential', diff.sets.credentials, 'Created after login/auth');
  addRows('MSIProduct', diff.sets.msiProducts, '');
  addRows('RegistryKey', diff.sets.registryKeys, '');
  addRows('Folder', diff.sets.folders, '');
  addRows('File', diff.sets.files, '');
  addRows('Prefetch', diff.sets.prefetchFiles, 'Windows-managed; reappears after execution');

  return { diff, matrix };
}

/**
 * Check for persistence - quick monitor that reports any re-created Zoom artifacts
 * @returns {Promise<{clean: boolean, alerts: string[], counts: Object}>}
 */
async function checkPersistence() {
  logger.info('Checking for Zoom persistence artifacts...');

  const alerts = [];
  const counts = { folders: 0, registryKeys: 0, runValues: 0, services: 0, tasks: 0, firewallRules: 0 };

  // Key folders
  const keyFolders = [
    path.join(process.env.APPDATA, 'Zoom'),
    path.join(process.env.LOCALAPPDATA, 'Zoom'),
    'C:\\Program Files\\Zoom',
    'C:\\Program Files (x86)\\Zoom',
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'CptService')
  ];

  for (const f of keyFolders) {
    if (fs.existsSync(f)) {
      alerts.push(`Folder exists: ${f}`);
      counts.folders++;
    }
  }

  // Key registry keys + Run values + services + tasks + firewall
  try {
    const result = await runPowerShell(`
      $alerts = @()

      # Registry keys
      $keys = @('HKCU:\\Software\\Zoom','HKLM:\\Software\\Zoom','HKLM:\\SOFTWARE\\Policies\\Zoom\\Zoom Meetings\\AU2')
      foreach ($k in $keys) {
        if (Test-Path $k -ErrorAction SilentlyContinue) { $alerts += "REG|$k" }
      }

      # Run values
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      if (Get-ItemProperty -Path $runKey -Name 'Zoom' -ErrorAction SilentlyContinue) { $alerts += "RUN|Zoom" }

      # Services
      foreach ($s in @('ZoomCptService','Zoom Sharing Service','CptService')) {
        if (Get-Service -Name $s -ErrorAction SilentlyContinue) { $alerts += "SVC|$s" }
      }

      # Tasks
      $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like '*Zoom*' -or $_.TaskPath -like '*Zoom*' }
      foreach ($t in $tasks) { $alerts += "TASK|$($t.TaskPath)$($t.TaskName)" }

      # Firewall
      $fw = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' }
      foreach ($r in $fw) { $alerts += "FW|$($r.DisplayName)" }

      $alerts -join [char]10
    `, { timeout: 30000 });

    if (result.stdout && result.stdout.trim()) {
      for (const line of result.stdout.trim().split('\n')) {
        const parts = line.trim().split('|');
        const type = parts[0];
        const value = parts.slice(1).join('|');

        switch (type) {
          case 'REG': alerts.push(`Registry key exists: ${value}`); counts.registryKeys++; break;
          case 'RUN': alerts.push(`Run value exists: ${value}`); counts.runValues++; break;
          case 'SVC': alerts.push(`Service exists: ${value}`); counts.services++; break;
          case 'TASK': alerts.push(`Scheduled task exists: ${value}`); counts.tasks++; break;
          case 'FW': alerts.push(`Firewall rule: ${value}`); counts.firewallRules++; break;
        }
      }
    }
  } catch (e) {
    logger.debug('Persistence check PS failed', { error: e.message });
  }

  const clean = alerts.length === 0;

  if (clean) {
    logger.ok('No Zoom persistence detected');
  } else {
    logger.warn(`Zoom persistence detected: ${alerts.length} artifacts`, { alerts });
  }

  return { clean, alerts, counts };
}

/**
 * List all saved snapshots
 * @returns {Array<{name: string, path: string, size: number, mtime: string}>}
 */
function listSnapshots() {
  ensureSnapshotDir();

  try {
    return fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fullPath = path.join(SNAPSHOT_DIR, f);
        const stat = fs.statSync(fullPath);
        return { name: f, path: fullPath, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (e) {
    return [];
  }
}

/**
 * Load a snapshot from disk
 * @param {string} snapshotPath - Path to snapshot JSON
 * @returns {Object|null}
 */
function loadSnapshot(snapshotPath) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    logger.error('Failed to load snapshot', { path: snapshotPath, error: e.message });
    return null;
  }
}

module.exports = {
  takeSnapshot,
  compareSnapshots,
  checkPersistence,
  listSnapshots,
  loadSnapshot,
  SNAPSHOT_DIR
};
