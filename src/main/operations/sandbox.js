/**
 * 1132 Eliminator - Windows Sandbox Launcher
 *
 * Launches Zoom inside Windows Sandbox with mapped user folders.
 * Each sandbox session is a completely fresh Windows environment
 * with zero device fingerprints — immune to Error 1132 bans.
 *
 * Mapped folders (read/write):
 *   - User's Documents folder
 *   - User's Downloads folder
 *
 * The sandbox auto-installs Zoom MSI and applies registry policies
 * on startup, then launches Zoom.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');

const USERPROFILE = process.env.USERPROFILE;
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const SANDBOX_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'sandbox');

/**
 * Registry policies to apply inside the sandbox (mirrors settings-backup.js)
 */
const SANDBOX_POLICIES = {
  'Meetings': {
    MuteVoIPWhenJoinMeeting: 1,
    AudioAutoAdjust: 1,
    EnableOriginalSound: 1,
    SetUseSystemDefaultSpeakerForVOIP: 1,
    SetUseSystemDefaultMicForVOIP: 1,
    TurnOffVideoCameraOnJoin: 1,
    EnableMirrorEffect: 0,
    AutoEnableDualMonitor: 0,
    DisableReceiveVideo: 1,
    EnterFullScreenWhenJoinMeeting: 0,
    AlwaysShowMeetingControls: 1,
    AlwaysShowConnectedTime: 1,
  },
  'General': {
    EnableHardwareAccForVideoSend: 1,
    EnableHardwareAccForVideoReceive: 1,
    EnableGPUComputeUtilization: 1,
  },
  'AU2': {
    AU2_EnableAutoUpdate: 0,
  }
};

/**
 * Build the PowerShell setup script that runs inside the sandbox
 * Downloads Zoom MSI, installs it, applies policies, launches Zoom
 */
function buildSetupScript() {
  const lines = [];

  // Download Zoom MSI
  lines.push('$ErrorActionPreference = "SilentlyContinue"');
  lines.push('$msiUrl = "https://zoom.us/client/latest/ZoomInstallerFull.msi?archType=x64"');
  lines.push('$msiPath = "$env:TEMP\\ZoomInstallerFull.msi"');
  lines.push('');
  lines.push('Write-Host "Downloading Zoom MSI..." -ForegroundColor Cyan');
  lines.push('[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12');
  lines.push('Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing');
  lines.push('');

  // Install Zoom MSI silently
  lines.push('Write-Host "Installing Zoom..." -ForegroundColor Cyan');
  lines.push('Start-Process msiexec -ArgumentList "/i", $msiPath, "/qn", "/norestart", "ALLUSERS=1", "AutoStartAfterReboot=0" -Wait');
  lines.push('');

  // Apply registry policies
  lines.push('Write-Host "Applying settings..." -ForegroundColor Cyan');
  for (const [subkey, values] of Object.entries(SANDBOX_POLICIES)) {
    const regPath = `HKLM:\\SOFTWARE\\Policies\\Zoom\\Zoom Meetings\\${subkey}`;
    lines.push(`New-Item -Path '${regPath}' -Force | Out-Null`);
    for (const [name, value] of Object.entries(values)) {
      lines.push(`New-ItemProperty -Path '${regPath}' -Name '${name}' -PropertyType DWord -Value ${value} -Force | Out-Null`);
    }
  }
  lines.push('');

  // Remove auto-start Run entries
  lines.push('$runKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"');
  lines.push('Remove-ItemProperty -Path $runKey -Name "Zoom" -ErrorAction SilentlyContinue');
  lines.push('Remove-ItemProperty -Path $runKey -Name "ZoomUMX" -ErrorAction SilentlyContinue');
  lines.push('');

  // Write INI settings (dark mode, Outlook sync off)
  lines.push('$zoomDataDir = "$env:APPDATA\\Zoom\\data"');
  lines.push('if (-not (Test-Path $zoomDataDir)) { New-Item -Path $zoomDataDir -ItemType Directory -Force | Out-Null }');
  lines.push('$iniPath = "$zoomDataDir\\Zoom.us.ini"');
  lines.push('$iniContent = @"');
  lines.push('[ZoomChat]');
  lines.push('com.zoom.client.theme.mode=2');
  lines.push('com.disable.connection.pk.status=false');
  lines.push('"@');
  lines.push('Set-Content -Path $iniPath -Value $iniContent -Encoding UTF8');
  lines.push('');

  // Find and launch Zoom
  lines.push('Write-Host "Launching Zoom..." -ForegroundColor Green');
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
  lines.push('  Write-Host "Zoom launched from: $zoomExe" -ForegroundColor Green');
  lines.push('} else {');
  lines.push('  Write-Host "Zoom.exe not found after install" -ForegroundColor Red');
  lines.push('}');
  lines.push('');
  lines.push('Write-Host ""');
  lines.push('Write-Host "Sandbox ready. Close this window when done." -ForegroundColor Yellow');
  lines.push('Write-Host "Documents and Downloads are mapped from your host." -ForegroundColor Yellow');
  lines.push('pause');

  return lines.join('\r\n');
}

/**
 * Generate the .wsb configuration file
 * Maps Documents and Downloads as read/write
 */
function generateWsbConfig() {
  const documentsPath = path.join(USERPROFILE, 'Documents');
  const downloadsPath = path.join(USERPROFILE, 'Downloads');

  // XML escaping for paths
  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The setup script path inside sandbox (mapped from host)
  const setupScriptHost = path.join(SANDBOX_DIR, 'zoom-setup.ps1');
  // Inside sandbox, mapped folders appear under C:\Users\WDAGUtilityAccount\Desktop\...
  // But we use the LogonCommand to run from the mapped sandbox folder
  const sandboxScriptPath = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\1132-Sandbox\\zoom-setup.ps1';

  const wsb = `<Configuration>
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

  return wsb;
}

/**
 * Check if Windows Sandbox is available
 * @returns {Promise<{available: boolean, reason?: string}>}
 */
async function isSandboxAvailable() {
  try {
    // Check if WindowsSandbox.exe exists
    const sandboxExe = 'C:\\Windows\\System32\\WindowsSandbox.exe';
    if (!fs.existsSync(sandboxExe)) {
      return { available: false, reason: 'Windows Sandbox is not installed. Enable it in Windows Features (requires Pro/Enterprise).' };
    }
    return { available: true };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

/**
 * Launch Zoom inside Windows Sandbox
 * @returns {Promise<{success: boolean, wsbPath?: string, error?: string}>}
 */
async function launchSandbox() {
  logger.section('SANDBOX LAUNCH');

  // Check availability
  const check = await isSandboxAvailable();
  if (!check.available) {
    logger.error('Windows Sandbox not available', { reason: check.reason });
    return { success: false, error: check.reason };
  }

  try {
    // Create sandbox directory
    if (!fs.existsSync(SANDBOX_DIR)) {
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    }

    // Write setup script
    const setupScript = buildSetupScript();
    const scriptPath = path.join(SANDBOX_DIR, 'zoom-setup.ps1');
    fs.writeFileSync(scriptPath, setupScript, 'utf-8');
    logger.info('Setup script written', { path: scriptPath });

    // Write .wsb config
    const wsbConfig = generateWsbConfig();
    const wsbPath = path.join(SANDBOX_DIR, 'zoom-sandbox.wsb');
    fs.writeFileSync(wsbPath, wsbConfig, 'utf-8');
    logger.info('WSB config written', { path: wsbPath });

    // Launch the sandbox
    logger.info('Launching Windows Sandbox...');
    const { spawn } = require('child_process');
    const child = spawn('cmd', ['/c', 'start', '', wsbPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    logger.ok('Windows Sandbox launched');
    return { success: true, wsbPath };
  } catch (e) {
    logger.error('Failed to launch sandbox', { error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = {
  isSandboxAvailable,
  launchSandbox
};
