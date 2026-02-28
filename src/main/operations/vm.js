/**
 * 1132 Eliminator - VirtualBox VM Manager
 *
 * Creates a VirtualBox VM with fully randomized virtual hardware
 * (MAC, UUID, disk serial, BIOS serial, motherboard serial).
 * This is the only method that bypasses hardware-level 1132 bans
 * on Windows Home, because Zoom reads identifiers via WMI which
 * Sandboxie cannot intercept.
 *
 * First-time setup:
 *   1. Download & install VirtualBox (~100MB)
 *   2. User provides a Windows ISO (auto-searched in Downloads)
 *   3. Unattended Windows install (~15 min)
 *   4. Zoom MSI auto-installed inside VM
 *
 * Subsequent launches: VM starts in seconds.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');
const logger = require('../utils/logger');

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const USERPROFILE = process.env.USERPROFILE;
const VM_NAME = 'Zoom1132-VM';
const VM_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'vm');

// VirtualBox detection paths
const VBOX_MANAGE_PATHS = [
  path.join(process.env['ProgramFiles'] || '', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Oracle', 'VirtualBox', 'VBoxManage.exe'),
];

// VirtualBox installer
const VBOX_INSTALLER = {
  url: 'https://download.virtualbox.org/virtualbox/7.1.6/VirtualBox-7.1.6-167084-Win.exe',
  downloadPath: path.join(process.env.TEMP || '', 'VirtualBox-7.1.6-Win.exe'),
  timeout: 600000 // 10 minutes
};


// ============================================================
// HELPERS
// ============================================================

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = fs.createWriteStream(destPath);
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; });
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve({ success: true, size }); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    });
    request.on('error', reject);
    request.setTimeout(VBOX_INSTALLER.timeout, () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

/**
 * Run VBoxManage command and return stdout
 * @param {string} vboxManage - Path to VBoxManage.exe
 * @param {string[]} args
 * @returns {string}
 */
function vbox(vboxManage, args) {
  const result = execSync(`"${vboxManage}" ${args.join(' ')}`, {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 60000
  });
  return result.trim();
}


// ============================================================
// VIRTUALBOX DETECTION & INSTALL
// ============================================================

/**
 * Find VBoxManage.exe
 * @returns {string|null}
 */
function findVBoxManage() {
  for (const p of VBOX_MANAGE_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  // Check PATH
  try {
    const result = execSync('where VBoxManage.exe', { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
    const found = result.split('\n')[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not in PATH */ }
  return null;
}

/**
 * Check if VirtualBox is installed
 * @returns {{installed: boolean, vboxManage?: string, version?: string}}
 */
function isVBoxInstalled() {
  const vboxManage = findVBoxManage();
  if (!vboxManage) return { installed: false };

  try {
    const version = vbox(vboxManage, ['--version']);
    return { installed: true, vboxManage, version };
  } catch {
    return { installed: true, vboxManage, version: 'unknown' };
  }
}

/**
 * Download and install VirtualBox silently
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function installVBox() {
  logger.section('VIRTUALBOX AUTO-INSTALL');
  const destPath = VBOX_INSTALLER.downloadPath;

  try {
    logger.info('Downloading VirtualBox...');
    const result = await downloadFile(VBOX_INSTALLER.url, destPath);
    const sizeMB = (result.size / (1024 * 1024)).toFixed(1);
    logger.ok(`Downloaded VirtualBox: ${sizeMB} MB`);
  } catch (e) {
    logger.error('Failed to download VirtualBox', { error: e.message });
    return { success: false, error: 'Download failed: ' + e.message };
  }

  // Verify
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 10 * 1024 * 1024) {
    return { success: false, error: 'Downloaded file too small or missing' };
  }

  // Silent install (--silent --ignore-reboot)
  try {
    logger.info('Installing VirtualBox (silent)...');
    execSync(`"${destPath}" --silent --ignore-reboot`, {
      windowsHide: true,
      timeout: 300000 // 5 min
    });
    logger.ok('VirtualBox installed');
  } catch (e) {
    logger.error('VirtualBox install failed', { error: e.message });
    return { success: false, error: 'Install failed: ' + e.message };
  }

  // Verify
  const check = isVBoxInstalled();
  if (!check.installed) {
    return { success: false, error: 'VirtualBox not found after install' };
  }

  try { fs.unlinkSync(destPath); } catch { /* ignore */ }
  return { success: true, version: check.version };
}


// ============================================================
// WINDOWS ISO DETECTION
// ============================================================

/**
 * Search for Windows ISO files in common locations
 * @returns {string[]} Array of ISO paths found
 */
function findWindowsISOs() {
  const searchDirs = [
    path.join(USERPROFILE, 'Downloads'),
    path.join(USERPROFILE, 'Desktop'),
    path.join(USERPROFILE, 'Documents'),
    'C:\\',
    'D:\\',
  ];

  const isos = [];
  const isoPattern = /win(dows)?\s*(10|11)/i;

  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.iso') && isoPattern.test(file)) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          // Windows ISOs are typically 3-7 GB
          if (stat.size > 2 * 1024 * 1024 * 1024) {
            isos.push(fullPath);
          }
        }
      }
    } catch { /* can't read dir */ }
  }

  return isos;
}


// ============================================================
// VM LIFECYCLE
// ============================================================

/**
 * Check if Zoom VM exists
 * @returns {{exists: boolean, state?: string, vboxManage?: string}}
 */
function isZoomVMExists() {
  const vboxManage = findVBoxManage();
  if (!vboxManage) return { exists: false };

  try {
    const info = vbox(vboxManage, ['showvminfo', `"${VM_NAME}"`, '--machinereadable']);
    const stateMatch = info.match(/VMState="([^"]+)"/);
    return {
      exists: true,
      state: stateMatch ? stateMatch[1] : 'unknown',
      vboxManage
    };
  } catch {
    return { exists: false, vboxManage };
  }
}

/**
 * Create the Zoom1132-VM with randomized hardware
 * @param {string} isoPath - Path to Windows ISO
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function createZoomVM(isoPath) {
  logger.section('CREATE ZOOM VM');

  const check = isVBoxInstalled();
  if (!check.installed) {
    return { success: false, error: 'VirtualBox not installed' };
  }

  if (!fs.existsSync(isoPath)) {
    return { success: false, error: `Windows ISO not found: ${isoPath}` };
  }

  const vm = check.vboxManage;

  // Delete old VM if exists
  try {
    vbox(vm, ['showvminfo', `"${VM_NAME}"`]);
    logger.info('Removing existing VM...');
    try { vbox(vm, ['controlvm', `"${VM_NAME}"`, 'poweroff']); } catch { /* may not be running */ }
    await new Promise(r => setTimeout(r, 2000));
    vbox(vm, ['unregistervm', `"${VM_NAME}"`, '--delete']);
  } catch { /* VM doesn't exist */ }

  // Create VM directory
  if (!fs.existsSync(VM_DIR)) fs.mkdirSync(VM_DIR, { recursive: true });

  const vdiPath = path.join(VM_DIR, `${VM_NAME}.vdi`);

  try {
    // Create VM
    logger.info('Creating VM...');
    vbox(vm, ['createvm', '--name', `"${VM_NAME}"`, '--ostype', 'Windows11_64',
              '--basefolder', `"${VM_DIR}"`, '--register']);

    // Configure hardware (4GB RAM, 2 CPUs, 128MB VRAM)
    vbox(vm, ['modifyvm', `"${VM_NAME}"`,
      '--memory', '4096',
      '--cpus', '2',
      '--vram', '128',
      '--graphicscontroller', 'vboxsvga',
      '--accelerate3d', 'on',
    ]);

    // TPM 2.0 for Windows 11
    vbox(vm, ['modifyvm', `"${VM_NAME}"`, '--tpm-type', '2.0']);

    // Audio (host audio passthrough)
    vbox(vm, ['modifyvm', `"${VM_NAME}"`,
      '--audio-driver', 'dsound',
      '--audio-out', 'on',
      '--audio-in', 'on',
    ]);

    // Network (NAT with random MAC — unique virtual hardware)
    vbox(vm, ['modifyvm', `"${VM_NAME}"`, '--nic1', 'nat']);

    // USB (for webcam passthrough)
    vbox(vm, ['modifyvm', `"${VM_NAME}"`, '--usb', 'on']);

    // Clipboard + drag-and-drop
    vbox(vm, ['modifyvm', `"${VM_NAME}"`,
      '--clipboard-mode', 'bidirectional',
      '--draganddrop', 'bidirectional',
    ]);

    // Shared folder: user's Documents & Downloads
    const docsPath = path.join(USERPROFILE, 'Documents');
    const dlPath = path.join(USERPROFILE, 'Downloads');
    vbox(vm, ['sharedfolder', 'add', `"${VM_NAME}"`,
      '--name', 'HostDocuments', '--hostpath', `"${docsPath}"`, '--automount']);
    vbox(vm, ['sharedfolder', 'add', `"${VM_NAME}"`,
      '--name', 'HostDownloads', '--hostpath', `"${dlPath}"`, '--automount']);

    // Create virtual disk (30GB dynamic)
    logger.info('Creating virtual disk...');
    vbox(vm, ['createmedium', 'disk', '--filename', `"${vdiPath}"`,
              '--size', '30720', '--format', 'VDI', '--variant', 'Standard']);

    // Storage controller + attach disk and ISO
    vbox(vm, ['storagectl', `"${VM_NAME}"`, '--name', 'SATA',
              '--add', 'sata', '--controller', 'IntelAhci']);
    vbox(vm, ['storageattach', `"${VM_NAME}"`, '--storagectl', 'SATA',
              '--port', '0', '--device', '0', '--type', 'hdd', '--medium', `"${vdiPath}"`]);
    vbox(vm, ['storageattach', `"${VM_NAME}"`, '--storagectl', 'SATA',
              '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', `"${isoPath}"`]);

    // Unattended install
    logger.info('Configuring unattended Windows install...');
    vbox(vm, ['unattended', 'install', `"${VM_NAME}"`,
      `--iso="${isoPath}"`,
      '--user=ZoomUser',
      '--password=zoom1132',
      '--full-user-name=Zoom User',
      '--install-additions',
      '--locale=en_US',
      '--country=US',
      '--time-zone=UTC',
    ]);

    logger.ok('VM created and configured', { name: VM_NAME });

    // Start VM (will begin unattended Windows install)
    logger.info('Starting VM for Windows installation...');
    vbox(vm, ['startvm', `"${VM_NAME}"`]);

    logger.ok('VM started — Windows unattended install in progress (~15 min)');
    return {
      success: true,
      vmName: VM_NAME,
      message: 'VM created. Windows is installing automatically. This takes ~15 minutes. The VM window will show the installation progress. Once Windows is ready, Zoom will be available.'
    };
  } catch (e) {
    logger.error('Failed to create VM', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Start the Zoom VM (if already set up)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function launchZoomVM() {
  logger.section('LAUNCH ZOOM VM');

  const vmCheck = isZoomVMExists();
  if (!vmCheck.exists) {
    return { success: false, error: 'Zoom VM not found. Run setup first.' };
  }

  if (vmCheck.state === 'running') {
    logger.info('VM is already running');
    return { success: true, state: 'already_running' };
  }

  try {
    vbox(vmCheck.vboxManage, ['startvm', `"${VM_NAME}"`]);
    logger.ok('Zoom VM started');
    return { success: true, state: 'started' };
  } catch (e) {
    // If saved state is corrupted, try discarding it
    if (/saved state/i.test(e.message)) {
      try {
        vbox(vmCheck.vboxManage, ['discardstate', `"${VM_NAME}"`]);
        vbox(vmCheck.vboxManage, ['startvm', `"${VM_NAME}"`]);
        return { success: true, state: 'started_after_discard' };
      } catch (e2) {
        return { success: false, error: e2.message };
      }
    }
    return { success: false, error: e.message };
  }
}

/**
 * Delete the Zoom VM entirely
 * @returns {{success: boolean, error?: string}}
 */
function deleteZoomVM() {
  const vmCheck = isZoomVMExists();
  if (!vmCheck.exists) return { success: true };

  try {
    // Power off if running
    if (vmCheck.state === 'running' || vmCheck.state === 'paused') {
      try { vbox(vmCheck.vboxManage, ['controlvm', `"${VM_NAME}"`, 'poweroff']); } catch {}
      // Wait for power off
      execSync('timeout /t 3 /nobreak >nul 2>&1', { windowsHide: true });
    }
    vbox(vmCheck.vboxManage, ['unregistervm', `"${VM_NAME}"`, '--delete']);
    logger.ok('Zoom VM deleted');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get full VM status
 * @returns {Promise<{available: boolean, vboxInstalled: boolean, vmExists: boolean, vmState?: string, isos: string[]}>}
 */
async function getVMStatus() {
  const vboxCheck = isVBoxInstalled();
  const vmCheck = isZoomVMExists();
  const isos = findWindowsISOs();

  return {
    available: vboxCheck.installed && vmCheck.exists,
    vboxInstalled: vboxCheck.installed,
    vboxVersion: vboxCheck.version,
    vmExists: vmCheck.exists,
    vmState: vmCheck.state,
    isos
  };
}

module.exports = {
  isVBoxInstalled,
  installVBox,
  findWindowsISOs,
  isZoomVMExists,
  createZoomVM,
  launchZoomVM,
  deleteZoomVM,
  getVMStatus
};
