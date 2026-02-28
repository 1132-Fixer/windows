/**
 * 1132 Eliminator - Sandbox Launcher
 *
 * Two isolation methods, auto-detected by Windows edition:
 *
 * 1. Windows Sandbox (Pro/Enterprise) — full Hyper-V VM, best isolation
 *    - Fresh OS instance per launch, zero host fingerprints
 *    - Downloads + installs Zoom inside the VM
 *    - Audio/video/clipboard/network passthrough
 *
 * 2. Sandboxie-Plus (any edition, including Home) — application-level sandbox
 *    - Uses kernel driver to virtualize file/registry writes
 *    - Spoofs MAC address + disk serial per sandbox
 *    - Auto-deletes sandbox data on close
 *    - Runs host-installed Zoom inside isolated container
 *
 * Both methods map user's Documents and Downloads folders.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const vm = require('./vm');

const USERPROFILE = process.env.USERPROFILE;
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const SANDBOX_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'sandbox');

// Sandboxie-Plus detection paths
const SANDBOXIE_START_PATHS = [
  path.join(process.env['ProgramFiles'] || '', 'Sandboxie-Plus', 'Start.exe'),
  path.join(process.env['ProgramFiles'] || '', 'Sandboxie', 'Start.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Sandboxie-Plus', 'Start.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Sandboxie', 'Start.exe'),
];

const SANDBOXIE_BOX_NAME = 'Zoom1132';

// Sandboxie-Plus auto-installer
const SANDBOXIE_INSTALLER = {
  url: 'https://github.com/sandboxie-plus/Sandboxie/releases/download/v1.17.2/Sandboxie-Plus-x64-v1.17.2.exe',
  downloadPath: path.join(process.env.TEMP || '', 'Sandboxie-Plus-x64-v1.17.2.exe'),
  timeout: 300000 // 5 minutes
};

// Zoom executable search paths (mirrors constants.js)
const ZOOM_EXE_PATHS = [
  path.join(process.env.APPDATA || '', 'Zoom', 'bin', 'Zoom.exe'),
  path.join(LOCALAPPDATA || '', 'Zoom', 'bin', 'Zoom.exe'),
  path.join(LOCALAPPDATA || '', 'Programs', 'Zoom', 'Zoom.exe'),
  path.join(LOCALAPPDATA || '', 'Programs', 'Zoom', 'bin', 'Zoom.exe'),
  'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
  'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe',
  'C:\\Program Files\\Zoom\\Zoom.exe',
  'C:\\Program Files (x86)\\Zoom\\Zoom.exe',
];

// ============================================================
// REGISTRY POLICIES (mirrors settings-backup.js)
// Applied inside Windows Sandbox; host policies cover Sandboxie
// ============================================================

const SANDBOX_POLICIES = {
  Meetings: {
    MuteVoIPWhenJoinMeeting: 1,
    AudioAutoAdjust: 1,
    EnableOriginalSound: 1,
    SetUseSystemDefaultSpeakerForVOIP: 1,
    SetUseSystemDefaultMicForVOIP: 1,
    EnableMirrorEffect: 0,
    AutoEnableDualMonitor: 0,
    DisableReceiveVideo: 1,
    EnterFullScreenWhenJoinMeeting: 0,
    AlwaysShowMeetingControls: 1,
    AlwaysShowConnectedTime: 1,
  },
  General: {
    EnableHardwareAccForVideoSend: 1,
    EnableHardwareAccForVideoReceive: 1,
    EnableGPUComputeUtilization: 1,
  },
  AU2: {
    AU2_EnableAutoUpdate: 0,
  }
};


// ============================================================
// COMMON HELPERS
// ============================================================

/**
 * Detect Windows edition (Home, Pro, Enterprise, etc.)
 * @returns {string}
 */
function getWindowsEdition() {
  try {
    const caption = execSync('wmic os get caption /format:value', {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000
    });
    const match = caption.match(/Caption=(.+)/);
    return match ? match[1].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Find Zoom.exe on the host
 * @returns {string|null}
 */
function findZoomExe() {
  for (const p of ZOOM_EXE_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}


// ============================================================
// SANDBOXIE-PLUS DOWNLOAD & INSTALL
// ============================================================

/**
 * Download a file from URL, following redirects (GitHub uses them)
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @returns {Promise<{success: boolean, size: number}>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(destPath);
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; });
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve({ success: true, size });
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', reject);
    request.setTimeout(SANDBOXIE_INSTALLER.timeout, () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

/**
 * Download and install Sandboxie-Plus silently.
 * Called automatically when sandbox is requested but Sandboxie is not installed.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function installSandboxie() {
  logger.section('SANDBOXIE-PLUS AUTO-INSTALL');
  const destPath = SANDBOXIE_INSTALLER.downloadPath;

  // Download
  try {
    logger.info('Downloading Sandboxie-Plus...');
    const result = await downloadFile(SANDBOXIE_INSTALLER.url, destPath);
    const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
    logger.ok(`Downloaded Sandboxie-Plus: ${sizeMB} MB`);
  } catch (e) {
    logger.error('Failed to download Sandboxie-Plus', { error: e.message });
    return { success: false, error: 'Download failed: ' + e.message };
  }

  // Verify file
  if (!fs.existsSync(destPath)) {
    return { success: false, error: 'Downloaded file not found' };
  }
  const stat = fs.statSync(destPath);
  if (stat.size < 5 * 1024 * 1024) {
    return { success: false, error: 'Downloaded file too small — possible bad download' };
  }

  // Silent install (will trigger UAC if not already elevated)
  try {
    logger.info('Installing Sandboxie-Plus (silent)...');
    execSync(`"${destPath}" /S`, {
      windowsHide: true,
      timeout: 120000 // 2 minutes
    });
    logger.ok('Sandboxie-Plus installed');
  } catch (e) {
    logger.error('Silent install failed', { error: e.message });
    return { success: false, error: 'Install failed: ' + e.message };
  }

  // Wait for service to appear
  let retries = 10;
  while (retries-- > 0) {
    const sbie = checkSandboxie();
    if (sbie.installed && sbie.serviceRunning) {
      logger.ok('Sandboxie-Plus service is running');
      // Cleanup installer
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      return { success: true };
    }
    // Wait 1 second between checks
    await new Promise(r => setTimeout(r, 1000));
  }

  // Installed but service may need a manual start
  const finalCheck = checkSandboxie();
  if (finalCheck.installed) {
    try {
      execSync('net start SbieSvc', { windowsHide: true, timeout: 10000 });
    } catch { /* may already be starting */ }
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    return { success: true };
  }

  return { success: false, error: 'Sandboxie-Plus installed but service did not start' };
}


// ============================================================
// SANDBOXIE-PLUS
// ============================================================

/**
 * Find Sandboxie-Plus Start.exe
 * Checks known install paths, then falls back to registry
 * @returns {string|null} Path to Start.exe or null
 */
function findSandboxieStartExe() {
  // Check file system first (fastest)
  for (const p of SANDBOXIE_START_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }

  // Fall back to registry (service ImagePath)
  try {
    const result = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\SbieSvc" /v ImagePath',
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
    );
    const match = result.match(/ImagePath\s+REG_EXPAND_SZ\s+(.+)/i);
    if (match) {
      const svcPath = match[1].trim().replace(/"/g, '');
      const installDir = path.dirname(svcPath);
      const startExe = path.join(installDir, 'Start.exe');
      if (fs.existsSync(startExe)) return startExe;
    }
  } catch { /* not installed */ }

  return null;
}

/**
 * Check if Sandboxie-Plus is installed and operational
 * @returns {{installed: boolean, startExe?: string, serviceRunning?: boolean}}
 */
function checkSandboxie() {
  const startExe = findSandboxieStartExe();
  if (!startExe) return { installed: false };

  // Check if service is running
  let serviceRunning = false;
  try {
    const result = execSync('sc query SbieSvc', {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000
    });
    serviceRunning = /RUNNING/i.test(result);
  } catch { /* service not found */ }

  return { installed: true, startExe, serviceRunning };
}

/**
 * Build the Sandboxie.ini [Zoom1132] section content
 * @returns {string}
 */
function buildSandboxieBoxConfig() {
  const documentsPath = path.join(USERPROFILE, 'Documents');
  const downloadsPath = path.join(USERPROFILE, 'Downloads');

  const lines = [
    `[${SANDBOXIE_BOX_NAME}]`,
    'Enabled=y',
    'AutoDelete=y',
    '',
    '# ── Fingerprint spoofing ──',
    'HideDiskSerialNumber=y',
    'HideNetworkAdapterMAC=y',
    'HideOtherBoxes=y',
    'CoverBoxedWindows=y',
    'HideHostProcess=SandboxieRpcSs.exe',
    'HideHostProcess=SbieSvc.exe',
    'HideHostProcess=SandmanPlus.exe',
    '',
    '# Spoof MachineGuid (primary Zoom fingerprint)',
    'OverrideRegistryValue=HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid=%RandGuid%',
    '',
    '# ── Isolation (full kernel-driver mode) ──',
    'DropAdminRights=y',
    '',
    '# ── Audio/video passthrough ──',
    'Template=OpenCOM',
    'OpenDevCMApi=y',
    'OpenIpcPath=\\RPC Control\\AudioClientRpc',
    'OpenIpcPath=\\RPC Control\\AudioSrv',
    'OpenIpcPath=\\BaseNamedObjects\\Windows.Foundation.UniversalApiContract*',
    'OpenIpcPath=\\Sessions\\*\\BaseNamedObjects\\*AudioClient*',
    '',
    '# ── Host folder access (read/write) ──',
    `OpenFilePath=${documentsPath}\\`,
    `OpenFilePath=${downloadsPath}\\`,
    '',
    '# ── Network ──',
    'BlockNetworkFiles=n',
  ];

  return lines.join('\r\n');
}

/**
 * Write the [Zoom1132] box config into Sandboxie.ini
 * @param {string} startExe - Path to Start.exe (for /reload)
 * @returns {{success: boolean, error?: string}}
 */
function configureSandboxieBox(startExe) {
  const iniPath = 'C:\\Windows\\Sandboxie.ini';
  const sectionHeader = `[${SANDBOXIE_BOX_NAME}]`;

  try {
    let content = '';
    if (fs.existsSync(iniPath)) {
      content = fs.readFileSync(iniPath, 'utf-16le');
      // Handle BOM
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }
    }

    // Remove existing [Zoom1132] section if present
    const sectionRegex = new RegExp(
      `\\[${SANDBOXIE_BOX_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`,
      'g'
    );
    content = content.replace(sectionRegex, '').trim();

    // Append our box config
    const boxConfig = buildSandboxieBoxConfig();
    content = content + '\r\n\r\n' + boxConfig + '\r\n';

    // Write back (Sandboxie.ini is UTF-16 LE with BOM)
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from(content, 'utf-16le');
    fs.writeFileSync(iniPath, Buffer.concat([bom, body]));

    logger.info('Sandboxie.ini updated', { box: SANDBOXIE_BOX_NAME });

    // Reload config
    try {
      execSync(`"${startExe}" /reload`, {
        windowsHide: true,
        timeout: 5000
      });
      logger.info('Sandboxie config reloaded');
    } catch (e) {
      logger.warn('Config reload failed (may need service restart)', { error: e.message });
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Launch Zoom inside Sandboxie-Plus
 * @returns {Promise<{success: boolean, method: string, error?: string}>}
 */
async function launchSandboxie() {
  logger.section('SANDBOXIE-PLUS LAUNCH');

  const sbie = checkSandboxie();
  if (!sbie.installed) {
    return { success: false, method: 'sandboxie', error: 'Sandboxie-Plus not found' };
  }

  if (!sbie.serviceRunning) {
    logger.warn('Sandboxie service not running, attempting to start...');
    try {
      execSync('net start SbieSvc', { windowsHide: true, timeout: 10000 });
    } catch (e) {
      return {
        success: false,
        method: 'sandboxie',
        error: 'Sandboxie service failed to start: ' + e.message
      };
    }
  }

  // Find Zoom on host
  const zoomExe = findZoomExe();
  if (!zoomExe) {
    return {
      success: false,
      method: 'sandboxie',
      error: 'Zoom is not installed. Run a full reset with reinstall first.'
    };
  }

  // Write box config to Sandboxie.ini
  const configResult = configureSandboxieBox(sbie.startExe);
  if (!configResult.success) {
    logger.error('Failed to configure Sandboxie box', { error: configResult.error });
    return { success: false, method: 'sandboxie', error: configResult.error };
  }

  // Delete old sandbox contents (clean fingerprint)
  try {
    logger.info('Cleaning previous sandbox data...');
    execSync(
      `"${sbie.startExe}" /box:${SANDBOXIE_BOX_NAME} delete_sandbox_silent`,
      { windowsHide: true, timeout: 15000 }
    );
  } catch {
    // Box may not exist yet — that's fine
  }

  // Launch Zoom inside sandbox
  try {
    logger.info('Launching Zoom in Sandboxie-Plus...', { box: SANDBOXIE_BOX_NAME, zoom: zoomExe });
    const { spawn } = require('child_process');
    const child = spawn(
      sbie.startExe,
      ['/box:' + SANDBOXIE_BOX_NAME, '/silent', '/nosbiectrl', zoomExe],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();

    logger.ok('Zoom launched in Sandboxie-Plus', { box: SANDBOXIE_BOX_NAME });
    return { success: true, method: 'sandboxie', box: SANDBOXIE_BOX_NAME };
  } catch (e) {
    logger.error('Failed to launch Zoom in Sandboxie-Plus', { error: e.message });
    return { success: false, method: 'sandboxie', error: e.message };
  }
}


// ============================================================
// WINDOWS SANDBOX
// ============================================================

/**
 * Build the PowerShell setup script for Windows Sandbox.
 * Downloads Zoom MSI, installs it, applies policies, launches Zoom.
 */
function buildWindowsSandboxScript() {
  const lines = [];

  lines.push('$ErrorActionPreference = "Stop"');
  lines.push('$ProgressPreference = "SilentlyContinue"');
  lines.push('[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12');
  lines.push('');
  lines.push('Write-Host ""');
  lines.push('Write-Host "========================================" -ForegroundColor Red');
  lines.push('Write-Host "  1132 ELIMINATOR - SANDBOX MODE" -ForegroundColor Red');
  lines.push('Write-Host "========================================" -ForegroundColor Red');
  lines.push('Write-Host ""');

  // Download Zoom MSI
  lines.push('$msiUrl = "https://zoom.us/client/latest/ZoomInstallerFull.msi?archType=x64"');
  lines.push('$msiPath = "$env:TEMP\\ZoomInstallerFull.msi"');
  lines.push('');
  lines.push('try {');
  lines.push('  Write-Host "[1/4] Downloading Zoom MSI..." -ForegroundColor Cyan');
  lines.push('  Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing');
  lines.push('  $size = [math]::Round((Get-Item $msiPath).Length / 1MB, 1)');
  lines.push('  Write-Host "      Downloaded: ${size} MB" -ForegroundColor Green');
  lines.push('} catch {');
  lines.push('  Write-Host "      Download failed: $_" -ForegroundColor Red');
  lines.push('  Read-Host "Press Enter to exit"');
  lines.push('  exit 1');
  lines.push('}');
  lines.push('');

  // Install Zoom MSI silently
  lines.push('Write-Host "[2/4] Installing Zoom..." -ForegroundColor Cyan');
  lines.push('$install = Start-Process msiexec -ArgumentList "/i", $msiPath, "/qn", "/norestart", "ALLUSERS=1", "AutoStartAfterReboot=0" -Wait -PassThru');
  lines.push('if ($install.ExitCode -ne 0) {');
  lines.push('  Write-Host "      MSI install returned exit code $($install.ExitCode)" -ForegroundColor Yellow');
  lines.push('}');
  lines.push('Start-Sleep -Seconds 3');
  lines.push('Write-Host "      Zoom installed" -ForegroundColor Green');
  lines.push('');

  // Apply registry policies
  lines.push('Write-Host "[3/4] Applying settings..." -ForegroundColor Cyan');
  lines.push('$count = 0');
  for (const [subkey, values] of Object.entries(SANDBOX_POLICIES)) {
    const regPath = `HKLM:\\SOFTWARE\\Policies\\Zoom\\Zoom Meetings\\${subkey}`;
    lines.push(`New-Item -Path '${regPath}' -Force -ErrorAction SilentlyContinue | Out-Null`);
    for (const [name, value] of Object.entries(values)) {
      lines.push(`New-ItemProperty -Path '${regPath}' -Name '${name}' -PropertyType DWord -Value ${value} -Force -ErrorAction SilentlyContinue | Out-Null`);
      lines.push('$count++');
    }
  }
  lines.push('');

  // Remove auto-start Run entries
  lines.push('$runKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"');
  lines.push('@("Zoom","ZoomUMX","ZoomWorkplace") | ForEach-Object {');
  lines.push('  Remove-ItemProperty -Path $runKey -Name $_ -ErrorAction SilentlyContinue');
  lines.push('}');
  lines.push('');

  // Write INI settings (dark mode, Outlook sync off)
  lines.push('$zoomDataDir = "$env:APPDATA\\Zoom\\data"');
  lines.push('if (-not (Test-Path $zoomDataDir)) { New-Item -Path $zoomDataDir -ItemType Directory -Force | Out-Null }');
  lines.push('Set-Content -Path "$zoomDataDir\\Zoom.us.ini" -Value @"');
  lines.push('[ZoomChat]');
  lines.push('com.zoom.client.theme.mode=2');
  lines.push('com.disable.connection.pk.status=false');
  lines.push('"@ -Encoding UTF8');
  lines.push('Write-Host "      $count policies + INI applied" -ForegroundColor Green');
  lines.push('');

  // Find and launch Zoom
  lines.push('Write-Host "[4/4] Launching Zoom..." -ForegroundColor Cyan');
  lines.push('$zoomPaths = @(');
  lines.push('  "$env:APPDATA\\Zoom\\bin\\Zoom.exe",');
  lines.push('  "$env:LOCALAPPDATA\\Zoom\\bin\\Zoom.exe",');
  lines.push('  "$env:LOCALAPPDATA\\Programs\\Zoom\\Zoom.exe",');
  lines.push('  "C:\\Program Files\\Zoom\\bin\\Zoom.exe",');
  lines.push('  "C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe"');
  lines.push(')');
  lines.push('$zoomExe = $zoomPaths | Where-Object { Test-Path $_ } | Select-Object -First 1');
  lines.push('if ($zoomExe) {');
  lines.push('  Start-Process $zoomExe');
  lines.push('  Write-Host "      Zoom launched: $zoomExe" -ForegroundColor Green');
  lines.push('} else {');
  lines.push('  Write-Host "      Zoom.exe not found after install" -ForegroundColor Red');
  lines.push('}');
  lines.push('');

  // Status
  lines.push('Write-Host ""');
  lines.push('Write-Host "========================================" -ForegroundColor Green');
  lines.push('Write-Host "  SANDBOX READY" -ForegroundColor Green');
  lines.push('Write-Host "========================================" -ForegroundColor Green');
  lines.push('Write-Host ""');
  lines.push('Write-Host "  Documents: mapped from host (read/write)" -ForegroundColor Yellow');
  lines.push('Write-Host "  Downloads: mapped from host (read/write)" -ForegroundColor Yellow');
  lines.push('Write-Host "  Audio:     passthrough enabled" -ForegroundColor Yellow');
  lines.push('Write-Host "  Webcam:    passthrough enabled" -ForegroundColor Yellow');
  lines.push('Write-Host ""');
  lines.push('Write-Host "  Close this sandbox window when done." -ForegroundColor Gray');
  lines.push('Write-Host "  All Zoom data will be destroyed on close." -ForegroundColor Gray');
  lines.push('Write-Host ""');
  lines.push('Read-Host "Press Enter to keep sandbox open"');

  return lines.join('\r\n');
}

/**
 * Generate .wsb config for Windows Sandbox
 */
function generateWsbConfig() {
  const documentsPath = path.join(USERPROFILE, 'Documents');
  const downloadsPath = path.join(USERPROFILE, 'Downloads');
  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sandboxScriptPath = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\1132-Sandbox\\zoom-setup.ps1';

  return `<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${escXml(documentsPath)}</HostFolder>
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Documents</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escXml(downloadsPath)}</HostFolder>
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Downloads</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escXml(SANDBOX_DIR)}</HostFolder>
      <SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\1132-Sandbox</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -ExecutionPolicy Bypass -File "${sandboxScriptPath}"</Command>
  </LogonCommand>
  <MemoryInMB>4096</MemoryInMB>
  <AudioInput>Enable</AudioInput>
  <VideoInput>Enable</VideoInput>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Enable</ClipboardRedirection>
</Configuration>`;
}

/**
 * Check if Windows Sandbox is available
 * @returns {{available: boolean, reason?: string, edition?: string}}
 */
function checkWindowsSandbox() {
  const edition = getWindowsEdition();

  if (/Home/i.test(edition)) {
    return { available: false, reason: 'Requires Pro or Enterprise', edition };
  }

  const sandboxExe = 'C:\\Windows\\System32\\WindowsSandbox.exe';
  if (!fs.existsSync(sandboxExe)) {
    return {
      available: false,
      reason: 'Windows Sandbox feature not enabled. Enable it in Settings > Apps > Optional Features > More Windows Features.',
      edition
    };
  }

  return { available: true, edition };
}

/**
 * Launch Zoom inside Windows Sandbox
 * @returns {Promise<{success: boolean, method: string, error?: string}>}
 */
async function launchWindowsSandbox() {
  logger.section('WINDOWS SANDBOX LAUNCH');

  const check = checkWindowsSandbox();
  if (!check.available) {
    return { success: false, method: 'windows-sandbox', error: check.reason };
  }

  try {
    if (!fs.existsSync(SANDBOX_DIR)) {
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    }

    // Write setup script
    const setupScript = buildWindowsSandboxScript();
    const scriptPath = path.join(SANDBOX_DIR, 'zoom-setup.ps1');
    fs.writeFileSync(scriptPath, setupScript, 'utf-8');
    logger.info('Setup script written', { path: scriptPath });

    // Write .wsb config
    const wsbConfig = generateWsbConfig();
    const wsbPath = path.join(SANDBOX_DIR, 'zoom-sandbox.wsb');
    fs.writeFileSync(wsbPath, wsbConfig, 'utf-8');
    logger.info('WSB config written', { path: wsbPath });

    // Launch
    const { spawn } = require('child_process');
    const child = spawn('cmd', ['/c', 'start', '', wsbPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    logger.ok('Windows Sandbox launched', { wsbPath });
    return { success: true, method: 'windows-sandbox', wsbPath };
  } catch (e) {
    logger.error('Failed to launch Windows Sandbox', { error: e.message });
    return { success: false, method: 'windows-sandbox', error: e.message };
  }
}


// ============================================================
// PUBLIC API
// ============================================================

/**
 * Check sandbox availability across all methods.
 * Returns which method is available and details.
 *
 * @returns {Promise<{available: boolean, method?: string, details: Object}>}
 */
async function isSandboxAvailable() {
  const edition = getWindowsEdition();
  const wsSandbox = checkWindowsSandbox();
  const sbie = checkSandboxie();
  const vmStatus = await vm.getVMStatus();

  // Windows Sandbox takes priority (best isolation)
  if (wsSandbox.available) {
    return {
      available: true,
      method: 'windows-sandbox',
      details: { edition, windowsSandbox: true, sandboxie: sbie.installed, vm: vmStatus.vmExists }
    };
  }

  // VirtualBox VM — best for Windows Home (full hardware spoof)
  if (vmStatus.available) {
    return {
      available: true,
      method: 'vm',
      details: {
        edition,
        windowsSandbox: false,
        sandboxie: sbie.installed,
        vm: true,
        vmState: vmStatus.vmState
      }
    };
  }

  // Sandboxie-Plus fallback (NOTE: cannot spoof WMI hardware IDs)
  if (sbie.installed) {
    return {
      available: true,
      method: 'sandboxie',
      details: {
        edition,
        windowsSandbox: false,
        sandboxie: true,
        sandboxieService: sbie.serviceRunning,
        startExe: sbie.startExe,
        vm: false
      }
    };
  }

  // Nothing available — check if VBox installed but VM not set up yet
  if (vmStatus.vboxInstalled && !vmStatus.vmExists) {
    return {
      available: false,
      method: null,
      reason: 'VirtualBox installed but Zoom VM not set up yet. Click "VM Setup" to create it.',
      details: { edition, windowsSandbox: false, sandboxie: false, vm: false, vboxInstalled: true, isos: vmStatus.isos }
    };
  }

  // Nothing available at all
  return {
    available: false,
    method: null,
    reason: 'No isolation method found. Click "VM Setup" to install VirtualBox and create a Zoom VM (best method for bypassing hardware bans).',
    details: { edition, windowsSandbox: false, sandboxie: false, vm: false, vboxInstalled: false }
  };
}

/**
 * Launch sandbox using the best available method.
 * Auto-detects Windows Sandbox vs Sandboxie-Plus.
 * If neither is available, auto-downloads and installs Sandboxie-Plus.
 *
 * @returns {Promise<{success: boolean, method: string, error?: string}>}
 */
async function launchSandbox() {
  const check = await isSandboxAvailable();

  if (check.available) {
    if (check.method === 'windows-sandbox') {
      return await launchWindowsSandbox();
    }
    if (check.method === 'vm') {
      const result = await vm.launchZoomVM();
      return { ...result, method: 'vm' };
    }
    return await launchSandboxie();
  }

  // No method available — try auto-install Sandboxie-Plus as quick fallback
  logger.info('No sandbox found. Auto-installing Sandboxie-Plus...');
  const installResult = await installSandboxie();
  if (!installResult.success) {
    return {
      success: false,
      method: 'none',
      error: 'No isolation method available. ' + installResult.error +
        '\n\nFor best results, use VM Setup to create a VirtualBox VM (fully spoofs hardware IDs).'
    };
  }

  // Retry launch after install
  return await launchSandboxie();
}

module.exports = {
  isSandboxAvailable,
  launchSandbox,
  installSandboxie
};
