const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  mainWindow.loadFile('index.html');

  // Properly close and quit when window is closed
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Get ALL Zoom-related paths - replicate fresh user profile
function getZoomDataPaths() {
  const paths = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const temp = process.env.TEMP;
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';

  // All possible Zoom locations
  const candidates = [
    // Main Zoom folders
    appData ? path.join(appData, 'Zoom') : null,
    localAppData ? path.join(localAppData, 'Zoom') : null,
    appData ? path.join(appData, 'Zoom Meetings') : null,
    // Zoomus variants
    appData ? path.join(appData, 'zoomus') : null,
    localAppData ? path.join(localAppData, 'zoomus') : null,
    // User documents
    userProfile ? path.join(userProfile, 'Documents', 'Zoom') : null,
    // Temp files
    temp ? path.join(temp, 'Zoom') : null,
    temp ? path.join(temp, 'zoomus') : null,
    temp ? path.join(temp, 'zoom_installer') : null,
    // Local low (sometimes used)
    userProfile ? path.join(userProfile, 'AppData', 'LocalLow', 'Zoom') : null,
    // Zoom logs
    appData ? path.join(appData, 'ZoomLogs') : null,
    localAppData ? path.join(localAppData, 'ZoomLogs') : null,

    // === NEW LOCATIONS THAT STORE DEVICE IDs ===
    // ProgramData - system-wide Zoom data (stores machine identifiers!)
    path.join(programData, 'Zoom'),
    path.join(programData, 'ZoomVideo'),
    path.join(programData, 'Zoom Video Communications'),

    // CptService - Zoom's Companion service (stores device fingerprints!)
    path.join(programData, 'CptService'),
    path.join(programData, 'CptHost'),
    path.join(programData, 'Zoom CptService'),

    // LocalAppData Programs folder (alternative install location)
    localAppData ? path.join(localAppData, 'Programs', 'Zoom') : null,
    localAppData ? path.join(localAppData, 'Programs', 'zoom.us') : null,

    // Additional cache locations
    localAppData ? path.join(localAppData, 'Zoom', 'data') : null,
    localAppData ? path.join(localAppData, 'Zoom', 'cache') : null,
    appData ? path.join(appData, 'Zoom', 'data') : null,

    // Zoom VDI and plugin folders
    appData ? path.join(appData, 'Zoom VDI') : null,
    localAppData ? path.join(localAppData, 'Zoom VDI') : null,
    programData ? path.join(programData, 'Zoom VDI') : null,

    // Zoom Outlook plugin data
    appData ? path.join(appData, 'ZoomOutlookPlugin') : null,
    localAppData ? path.join(localAppData, 'ZoomOutlookPlugin') : null,

    // === ADDITIONAL ALIAS LOCATIONS ===
    // WebView2 cache (Zoom uses Edge WebView2)
    localAppData ? path.join(localAppData, 'Zoom', 'EBWebView') : null,

    // ZoomUMX (alternative branding)
    appData ? path.join(appData, 'ZoomUMX') : null,
    localAppData ? path.join(localAppData, 'ZoomUMX') : null,

    // zoom.us (old domain-style folder name)
    appData ? path.join(appData, 'zoom.us') : null,
    localAppData ? path.join(localAppData, 'zoom.us') : null,

    // Zoom Workplace (new branding 2024+)
    appData ? path.join(appData, 'Zoom Workplace') : null,
    localAppData ? path.join(localAppData, 'Zoom Workplace') : null,
    'C:\\Program Files\\Zoom Workplace',
    'C:\\Program Files (x86)\\Zoom Workplace',

    // Zoom GIF Collector data
    appData ? path.join(appData, 'ZoomGifCollector') : null,
    localAppData ? path.join(localAppData, 'ZoomGifCollector') : null,

    // Program Files Zoom installations
    'C:\\Program Files\\Zoom',
    'C:\\Program Files (x86)\\Zoom',
    'C:\\Program Files\\Zoom\\bin',

    // Common Files (shared components)
    'C:\\Program Files\\Common Files\\Zoom',
    'C:\\Program Files (x86)\\Common Files\\Zoom',
    'C:\\Program Files\\Common Files\\zoom.us',
    'C:\\Program Files (x86)\\Common Files\\zoom.us',

    // Microsoft WebView2 runtime cache used by Zoom
    localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'EBWebView') : null,

    // Zoom updater folders
    localAppData ? path.join(localAppData, 'zoom-1132-eliminator-updater') : null,
    localAppData ? path.join(localAppData, 'zoom-updater') : null,
    localAppData ? path.join(localAppData, 'squirrel-zoom') : null,

    // Downloads folder - Zoom installers (optional cleanup)
    userProfile ? path.join(userProfile, 'Downloads', 'Zoom*.exe') : null,
    userProfile ? path.join(userProfile, 'Downloads', 'ZoomInstaller*.exe') : null
  ];

  // === CRITICAL: Scan C:\Users\ for ALL user profiles and their Zoom data ===
  const usersDir = 'C:\\Users';
  const currentUser = process.env.USERNAME?.toLowerCase() || '';
  const systemFolders = ['public', 'default', 'default user', 'all users'];

  try {
    if (fs.existsSync(usersDir)) {
      const userFolders = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const entry of userFolders) {
        if (entry.isDirectory()) {
          const folderName = entry.name.toLowerCase();
          const userPath = path.join(usersDir, entry.name);

          // Skip system folders
          if (systemFolders.includes(folderName)) continue;

          // === ADD ZOOM DATA LOCATIONS FOR ALL USER PROFILES ===
          // This ensures we clean Zoom data from ALL users, not just current
          const userAppDataRoaming = path.join(userPath, 'AppData', 'Roaming');
          const userAppDataLocal = path.join(userPath, 'AppData', 'Local');
          const userAppDataLocalLow = path.join(userPath, 'AppData', 'LocalLow');
          const userDocuments = path.join(userPath, 'Documents');
          const userTemp = path.join(userAppDataLocal, 'Temp');

          // Zoom data locations for this user
          const userZoomPaths = [
            path.join(userAppDataRoaming, 'Zoom'),
            path.join(userAppDataRoaming, 'Zoom Meetings'),
            path.join(userAppDataRoaming, 'zoomus'),
            path.join(userAppDataRoaming, 'ZoomLogs'),
            path.join(userAppDataRoaming, 'ZoomUMX'),
            path.join(userAppDataRoaming, 'zoom.us'),
            path.join(userAppDataRoaming, 'Zoom Workplace'),
            path.join(userAppDataRoaming, 'ZoomOutlookPlugin'),
            path.join(userAppDataRoaming, 'ZoomGifCollector'),
            path.join(userAppDataRoaming, 'Zoom VDI'),
            path.join(userAppDataLocal, 'Zoom'),
            path.join(userAppDataLocal, 'zoomus'),
            path.join(userAppDataLocal, 'ZoomLogs'),
            path.join(userAppDataLocal, 'ZoomUMX'),
            path.join(userAppDataLocal, 'zoom.us'),
            path.join(userAppDataLocal, 'Zoom Workplace'),
            path.join(userAppDataLocal, 'ZoomOutlookPlugin'),
            path.join(userAppDataLocal, 'ZoomGifCollector'),
            path.join(userAppDataLocal, 'Zoom VDI'),
            path.join(userAppDataLocal, 'Programs', 'Zoom'),
            path.join(userAppDataLocal, 'Programs', 'zoom.us'),
            path.join(userAppDataLocalLow, 'Zoom'),
            path.join(userDocuments, 'Zoom'),
            path.join(userTemp, 'Zoom'),
            path.join(userTemp, 'zoomus'),
            path.join(userTemp, 'zoom_installer')
          ];

          // Add all existing paths for this user
          for (const zPath of userZoomPaths) {
            if (fs.existsSync(zPath)) {
              candidates.push(zPath);
            }
          }

          // Also check for Zoom-named profile folders (like zoom1132eliminator.JG.010)
          if (folderName.includes('zoom') && folderName !== currentUser) {
            candidates.push(userPath);
          }
          // Check for ZG* folders (old ghost user format)
          if (folderName.startsWith('zg')) {
            candidates.push(userPath);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error scanning Users directory:', err);
  }

  // Deduplicate and filter existing
  const seen = new Set();
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        paths.push(resolved);
      }
    }
  }

  return paths;
}

// Check if file is dangerous temp file
function isDangerousTempFile(filename) {
  const bad = ['-wal', '-shm', '-journal', '.tmp', '.lock', '.lck'];
  const lower = filename.toLowerCase();
  return bad.some(x => lower.includes(x));
}

// Find all Zoom files recursively - delete EVERYTHING to reset identity
function findAllZoomDbFiles(dataDirs) {
  const found = [];
  const scannedDirs = new Set();
  let maxDepth = 10; // Safety limit

  function scanDirectory(dir, depth = 0) {
    if (depth > maxDepth) return;
    if (!fs.existsSync(dir)) return;

    const resolvedDir = path.resolve(dir);
    if (scannedDirs.has(resolvedDir)) return;
    scannedDirs.add(resolvedDir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        try {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            // Recurse into subdirectories (skip symlinks to avoid loops)
            scanDirectory(fullPath, depth + 1);
          } else if (entry.isFile()) {
            // Skip dangerous temp files
            if (isDangerousTempFile(entry.name)) continue;

            const stat = fs.statSync(fullPath);
            found.push({
              path: fullPath,
              name: entry.name,
              size: stat.size
            });
          }
        } catch (err) {
          // Skip files we can't access
        }
      }
    } catch (err) {
      // Skip directories we can't access
    }
  }

  for (const dataDir of dataDirs) {
    scanDirectory(dataDir, 0);
  }

  return found;
}

// Delete file (no placeholder - we want clean slate)
function deleteAndReplace(filePath) {
  try {
    fs.unlinkSync(filePath);
    return { success: true, message: `DELETED → ${path.basename(filePath)}` };
  } catch (err) {
    return { success: false, message: `FAILED → ${path.basename(filePath)} (${err.message})` };
  }
}

// Delete entire directory recursively
function deleteDirectory(dirPath) {
  return new Promise((resolve) => {
    const rmCmd = spawn('cmd', ['/c', `rmdir /s /q "${dirPath}"`], {
      shell: false,
      windowsHide: true
    });

    rmCmd.on('close', (code) => {
      resolve({ success: code === 0, path: dirPath });
    });

    rmCmd.on('error', () => {
      resolve({ success: false, path: dirPath });
    });
  });
}

// Launch Zoom
function launchZoom() {
  try {
    spawn('cmd', ['/c', 'start', 'zoommtg://'], { shell: true, detached: true });
  } catch (err) {
    console.error('Failed to launch Zoom:', err);
  }
}

// Kill all Zoom processes including services - with verification (runs 3x minimum)
function killZoomProcesses() {
  return new Promise(async (resolve) => {
    // Complete list of ALL Zoom-related processes (from official Zoom documentation)
    const zoomProcesses = [
      // === MAIN ZOOM WORKPLACE PROCESSES ===
      'Zoom.exe',
      'Zoomus.exe',
      'Zoom_launcher.exe',
      'ZoomHybridConf.exe',
      'zSafeChecker.exe',

      // === SCREEN SHARING / COMPANION PROCESSES ===
      'CptHost.exe',
      'CptService.exe',
      'CptControl.exe',
      'CptInstall.exe',

      // === SDK RENAMED VARIANTS ===
      'zcscpthost.exe',
      'zCSCptService.exe',
      'zcsairhost.exe',

      // === AUDIO/VIDEO OPTIMIZATION ===
      'aomhost.exe',
      'aomhost64.exe',
      'airhost.exe',

      // === CRASH REPORTING ===
      'zCrashReport.exe',
      'zCrashReport64.exe',

      // === OUTLOOK INTEGRATION ===
      'ZoomOutlookIMPlugin.exe',
      'ZoomOutlookMAPI.exe',
      'ZoomOutlookMAPI64.exe',

      // === DOCUMENT/MEDIA PROCESSING ===
      'ZoomDocConverter.exe',
      'zTscoder.exe',

      // === UPDATER/INSTALLER ===
      'zUpdater.exe',
      'ZoomInstaller.exe',
      'Installer.exe',

      // === WEB/CEF COMPONENTS ===
      'ZoomWebHost.exe',
      'zWebview2Agent.exe',
      'zCefAgent.exe',
      'msedgewebview2.exe',

      // === SDK/MESSENGER ===
      'ZoomSDKMessenger.exe',

      // === ZOOM ROOMS PROCESSES ===
      'ZoomRooms.exe',
      'zrshell.exe',
      'Controller.exe',
      'DigitalSignage.exe',
      'zrairhost.exe',
      'zrcpthost.exe',
      'bcairhost.exe',
      'conmon_server.exe',
      'mDNSResponder.exe',
      'ptp.exe',
      'ZAAPI.exe',
      'zCECHelper.exe',
      'zJob.exe',
      'zPrinterAgent.exe',
      'ZR3rdHW.exe',
      'zrusplayer.exe',
      'apec3.exe',
      'notification_helper.exe',

      // === VDI PROCESSES ===
      'ZoomVDITool.exe',
      'zWspExtension.exe',
      'ZoomVDIPluginManagement.exe'
    ];

    // All Zoom-related Windows services
    const stopServicesCmd = [
      'net stop "Zoom Sharing Service" 2>nul',
      'net stop "CptService" 2>nul',
      'net stop "ZoomCptService" 2>nul',
      'net stop "zCSCptService" 2>nul',
      'net stop "ZoomRooms" 2>nul',
      'sc stop CptService 2>nul',
      'sc stop ZoomCptService 2>nul',
      'sc stop zCSCptService 2>nul',
      'sc stop "Zoom Sharing Service" 2>nul',
      'sc stop ZoomRooms 2>nul'
    ].join(' & ');

    const killCommands = zoomProcesses.map(p => `taskkill /F /IM ${p} 2>nul`).join(' & ');
    const treeKillCommands = zoomProcesses.map(p => `taskkill /F /T /IM ${p} 2>nul`).join(' & ');

    // Run the full kill sequence 3 times minimum for thorough purging
    for (let pass = 0; pass < 3; pass++) {
      // Step 1: Stop services FIRST (they can hold file locks)
      await new Promise((res) => {
        const cmd = spawn('cmd', ['/c', stopServicesCmd], { shell: false, windowsHide: true });
        cmd.on('close', () => res());
        cmd.on('error', () => res());
      });

      // Step 2: Kill all processes (standard kill)
      await new Promise((res) => {
        const cmd = spawn('cmd', ['/c', killCommands], { shell: false, windowsHide: true });
        cmd.on('close', () => res());
        cmd.on('error', () => res());
      });

      // Step 3: Tree kill (kills child processes too)
      await new Promise((res) => {
        const cmd = spawn('cmd', ['/c', treeKillCommands], { shell: false, windowsHide: true });
        cmd.on('close', () => res());
        cmd.on('error', () => res());
      });

      // Step 4: PowerShell verification and force kill (catches any process with zoom/cpt/zr/aom in name)
      await new Promise((res) => {
        const checkCmd = spawn('powershell', ['-Command', `
          $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
            $_.Name -like '*cpt*' -or $_.Name -like '*Cpt*' -or
            $_.Name -like 'zr*' -or $_.Name -like 'ZR*' -or
            $_.Name -like 'aom*' -or $_.Name -like 'z[A-Z]*'
          }
          if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue }
        `], { windowsHide: true });
        checkCmd.on('close', () => res());
        checkCmd.on('error', () => res());
      });

      // Step 5: WMIC aggressive cleanup (expanded patterns)
      await new Promise((res) => {
        const wmicCmd = spawn('cmd', ['/c',
          'wmic process where "name like \'%zoom%\' or name like \'%Zoom%\' or name like \'%cpt%\' or name like \'%Cpt%\' or name like \'zr%\' or name like \'ZR%\' or name like \'aom%\'" delete 2>nul'
        ], { shell: false, windowsHide: true });
        wmicCmd.on('close', () => res());
        wmicCmd.on('error', () => res());
      });

      // Brief delay between passes
      await new Promise(r => setTimeout(r, 300));
    }

    // Final verification pass - ensure nothing is running
    const finalCheck = () => {
      return new Promise((res) => {
        const checkCmd = spawn('powershell', ['-Command', `
          $zoomProcs = @(${zoomProcesses.map(p => `'${p.replace('.exe', '')}'`).join(',')})
          $running = Get-Process -Name $zoomProcs -ErrorAction SilentlyContinue
          if ($running) {
            $running | Stop-Process -Force -ErrorAction SilentlyContinue
            Write-Output 'KILLED'
          } else {
            Write-Output 'CLEAR'
          }
        `], { windowsHide: true });

        let output = '';
        checkCmd.stdout.on('data', (data) => { output += data.toString(); });
        checkCmd.on('close', () => res(output.trim()));
        checkCmd.on('error', () => res('ERROR'));
      });
    };

    // Run final check up to 3 more times if processes persist
    for (let i = 0; i < 3; i++) {
      const result = await finalCheck();
      if (result === 'CLEAR') break;
      await new Promise(r => setTimeout(r, 500));
    }

    resolve({ killed: 1 });
  });
}

// Delete Zoom scheduled tasks that may store device info
function deleteZoomScheduledTasks() {
  return new Promise((resolve) => {
    const commands = [
      // Delete specific Zoom scheduled tasks
      'schtasks /delete /tn "Zoom" /f',
      'schtasks /delete /tn "ZoomUpdateTaskMachine" /f',
      'schtasks /delete /tn "ZoomUpdateTaskUserS-*" /f',
      'schtasks /delete /tn "ZoomInstallUpdate" /f',
      'schtasks /delete /tn "ZoomGifCollector" /f',
      'schtasks /delete /tn "ZoomCleaner" /f',
      'schtasks /delete /tn "ZoomAutoUpdate" /f',

      // Delete any task containing "Zoom" in name (PowerShell)
      'powershell -Command "Get-ScheduledTask | Where-Object {$_.TaskName -like \'*Zoom*\'} | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue"'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], {
      shell: false,
      windowsHide: true
    });

    cmd.on('close', () => resolve({ deleted: true }));
    cmd.on('error', () => resolve({ deleted: false }));
  });
}

// Delete Zoom Windows services
function deleteZoomServices() {
  return new Promise((resolve) => {
    const commands = [
      // Stop and delete Zoom services
      'net stop CptService',
      'net stop ZoomCptService',
      'sc delete CptService',
      'sc delete ZoomCptService',
      'sc delete "Zoom Sharing Service"'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], {
      shell: false,
      windowsHide: true
    });

    cmd.on('close', () => resolve({ deleted: true }));
    cmd.on('error', () => resolve({ deleted: false }));
  });
}

// Delete Zoom registry keys and credentials to reset identity
function deleteZoomRegistry() {
  return new Promise((resolve) => {
    // Delete registry keys AND Windows credentials - COMPREHENSIVE list
    const commands = [
      // HKCU (Current User) keys
      'reg delete "HKCU\\Software\\Zoom" /f',
      'reg delete "HKCU\\Software\\ZoomUMX" /f',
      'reg delete "HKCU\\Software\\zoom.us" /f',
      'reg delete "HKCU\\Software\\Zoom Video Communications" /f',

      // HKLM (Local Machine) keys - require admin
      'reg delete "HKLM\\Software\\Zoom" /f',
      'reg delete "HKLM\\Software\\ZoomUMX" /f',
      'reg delete "HKLM\\Software\\zoom.us" /f',
      'reg delete "HKLM\\Software\\Zoom Video Communications" /f',

      // WOW6432Node (32-bit on 64-bit) keys
      'reg delete "HKLM\\Software\\WOW6432Node\\Zoom" /f',
      'reg delete "HKLM\\Software\\WOW6432Node\\ZoomUMX" /f',
      'reg delete "HKLM\\Software\\WOW6432Node\\zoom.us" /f',

      // CptService registry keys (device fingerprints!)
      'reg delete "HKLM\\Software\\CptService" /f',
      'reg delete "HKCU\\Software\\CptService" /f',
      'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService" /f',
      'reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService" /f',

      // Zoom Run keys (auto-start entries)
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "Zoom" /f',
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "ZoomUMX" /f',

      // Zoom Uninstall registry entries
      'reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX" /f',
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZoomUMX" /f',
      'reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom" /f',
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom" /f',

      // Zoom Workplace (new branding 2024+)
      'reg delete "HKCU\\Software\\Zoom Workplace" /f',
      'reg delete "HKLM\\Software\\Zoom Workplace" /f',

      // ZoomGifCollector
      'reg delete "HKCU\\Software\\ZoomGifCollector" /f',

      // Windows Credentials
      'cmdkey /delete:zoom.us',
      'cmdkey /delete:Zoom',
      'cmdkey /delete:ZoomVideo',
      'cmdkey /delete:ZoomUMX',
      'cmdkey /delete:ZoomWorkplace'
    ].join(' & ');

    const regCmd = spawn('cmd', ['/c', commands], {
      shell: false,
      windowsHide: true
    });

    regCmd.on('close', (code) => {
      resolve({ deleted: 3 });
    });

    regCmd.on('error', () => {
      resolve({ deleted: 0 });
    });
  });
}

// IPC Handlers
ipcMain.handle('scan-files', async () => {
  try {
    const dataDirs = getZoomDataPaths();
    console.log('Found Zoom directories:', dataDirs);

    if (dataDirs.length === 0) {
      return {
        success: false,
        message: 'No Zoom data folders found. Is Zoom installed?',
        files: [],
        directories: []
      };
    }

    const files = findAllZoomDbFiles(dataDirs);
    console.log('Found files:', files.length);

    // Store full list but only send preview to renderer
    global.allFilesToDelete = files;

    // Only send first 100 files to renderer to avoid IPC overload
    const previewFiles = files.slice(0, 100);

    return {
      success: true,
      files: previewFiles,
      totalCount: files.length,
      directories: dataDirs
    };
  } catch (err) {
    console.error('Scan error:', err);
    return {
      success: false,
      message: `Scan error: ${err.message}`,
      files: [],
      directories: []
    };
  }
});

ipcMain.handle('kill-zoom', async () => {
  const result = await killZoomProcesses();
  // Give processes time to fully terminate
  await new Promise(resolve => setTimeout(resolve, 1500));
  return result;
});

ipcMain.handle('delete-files', async (event, filePaths) => {
  // Kill Zoom processes first to release file locks
  await killZoomProcesses();
  // Give processes time to fully terminate
  await new Promise(resolve => setTimeout(resolve, 2500));

  const results = [];
  let deletedCount = 0;

  // Get all Zoom directories and DELETE THEM ENTIRELY
  const zoomDirs = getZoomDataPaths();

  for (const dir of zoomDirs) {
    results.push({ success: true, message: `NUKING → ${dir}` });
    const result = await deleteDirectory(dir);
    if (result.success) {
      deletedCount++;
      results.push({ success: true, message: `DESTROYED → ${path.basename(dir)}` });
    } else {
      results.push({ success: false, message: `FAILED → ${path.basename(dir)} (may be locked)` });
    }
  }

  // Delete scheduled tasks (may store device identifiers)
  results.push({ success: true, message: `TASKS → Deleting Zoom scheduled tasks...` });
  await deleteZoomScheduledTasks();
  results.push({ success: true, message: `TASKS → Cleared Zoom scheduled tasks` });

  // Delete Zoom services
  results.push({ success: true, message: `SERVICES → Stopping and removing Zoom services...` });
  await deleteZoomServices();
  results.push({ success: true, message: `SERVICES → Removed CptService and ZoomCptService` });

  // Delete registry keys and credentials
  results.push({ success: true, message: `REGISTRY → Clearing all Zoom registry keys...` });
  const regResult = await deleteZoomRegistry();
  results.push({
    success: true,
    message: `REGISTRY → Cleared Zoom registry keys (HKCU, HKLM, WOW6432Node)`
  });
  results.push({
    success: true,
    message: `CREDENTIALS → Cleared Windows credentials`
  });

  // Also specifically look for and delete telemetry database
  const telemetryPaths = [
    path.join(process.env.APPDATA, 'Zoom', 'data', 'telemetrydata.db'),
    path.join(process.env.LOCALAPPDATA, 'Zoom', 'data', 'telemetrydata.db'),
    path.join(process.env.APPDATA, 'Zoom', 'telemetrydata.db'),
    path.join(process.env.LOCALAPPDATA, 'Zoom', 'telemetrydata.db')
  ];
  for (const telPath of telemetryPaths) {
    try {
      if (fs.existsSync(telPath)) {
        fs.unlinkSync(telPath);
        results.push({ success: true, message: `TELEMETRY → Deleted ${path.basename(telPath)}` });
      }
    } catch (e) {
      // Already deleted by folder nuke
    }
  }

  return {
    results: results,
    deletedCount: deletedCount,
    totalFiles: zoomDirs.length,
    registryCleared: regResult.deleted
  };
});

ipcMain.handle('launch-zoom', async () => {
  launchZoom();
  return { success: true };
});

ipcMain.handle('show-confirm-dialog', async (event, message) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    title: 'NUCLEAR OPTION',
    message: message
  });

  return result.response === 0; // Return true if "Delete" was clicked
});

ipcMain.handle('show-close-warning', async (event, hasFiles) => {
  if (!hasFiles) return true;

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Close Anyway', 'Cancel'],
    defaultId: 1,
    title: 'Files still remain',
    message: 'There are still database files.\nClose this window only after deletion!'
  });

  return result.response === 0;
});

ipcMain.handle('show-success', async (event, count) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'Success',
    message: `${count} files eliminated!\n\nYou can now close this window.\nZoom will be launched.`
  });
});

// Ghost User Zoom Launcher
const GHOST_USER = 'zoom1132eliminator';
const GHOST_PASS = 'Z1132elim!';
let ghostUserName = null;

async function downloadPsExec() {
  const psexecPath = path.join(process.env.TEMP, 'PsExec64.exe');
  if (fs.existsSync(psexecPath)) {
    return psexecPath;
  }

  return new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(psexecPath);
    https.get('https://live.sysinternals.com/PsExec64.exe', (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(psexecPath);
      });
    }).on('error', (err) => {
      fs.unlink(psexecPath, () => {});
      reject(err);
    });
  });
}

// Check if ghost user already exists
async function ghostUserExists() {
  return new Promise((resolve) => {
    const cmd = spawn('cmd', ['/c', `net user ${GHOST_USER} 2>nul`], {
      shell: false,
      windowsHide: true
    });
    cmd.on('close', (code) => resolve(code === 0));
    cmd.on('error', () => resolve(false));
  });
}

async function createGhostUser(username, password) {
  return new Promise((resolve) => {
    const cmd = spawn('cmd', ['/c', `net user ${username} ${password} /add & net localgroup Users ${username} /add`], {
      shell: false,
      windowsHide: true
    });
    cmd.on('close', () => resolve(true));
    cmd.on('error', () => resolve(false));
  });
}

async function initGhostProfile(psexecPath, username, password) {
  return new Promise((resolve) => {
    const cmd = spawn(psexecPath, ['-accepteula', '-u', username, '-p', password, '-w', 'C:\\', 'cmd', '/c', 'echo init'], {
      windowsHide: true
    });
    cmd.on('close', () => resolve(true));
    cmd.on('error', () => resolve(false));
  });
}

async function linkFolders(ghostUser, mainUser) {
  const folders = ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos'];
  const ghostProfile = `C:\\Users\\${ghostUser}`;
  const mainProfile = `C:\\Users\\${mainUser}`;

  for (const folder of folders) {
    const ghostFolder = path.join(ghostProfile, folder);
    const mainFolder = path.join(mainProfile, folder);

    // Remove existing and create symlink
    await new Promise((resolve) => {
      const cmd = spawn('cmd', ['/c', `rmdir /s /q "${ghostFolder}" 2>nul & mklink /D "${ghostFolder}" "${mainFolder}"`], {
        shell: false,
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
  }
}

async function deleteGhostUser(username) {
  return new Promise((resolve) => {
    const folders = ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos'];
    const profilePath = `C:\\Users\\${username}`;

    // Remove symlinks first (so we don't delete main user's files)
    let unlinkCmds = folders.map(f => `rmdir "${profilePath}\\${f}" 2>nul`).join(' & ');

    const cmd = spawn('cmd', ['/c', `${unlinkCmds} & net user ${username} /delete & rmdir /s /q "${profilePath}" 2>nul`], {
      shell: false,
      windowsHide: true
    });
    cmd.on('close', () => resolve(true));
    cmd.on('error', () => resolve(false));
  });
}

// Configure Zoom settings by writing INI directly
async function configureZoomSettings(ghostUser) {
  const ghostZoomPath = `C:\\Users\\${ghostUser}\\AppData\\Roaming\\Zoom`;
  const ghostZoomData = `${ghostZoomPath}\\data`;

  // Create directory structure
  if (!fs.existsSync(ghostZoomData)) {
    fs.mkdirSync(ghostZoomData, { recursive: true });
  }

  // Write Zoom.us.ini with all settings
  const zoomIniContent = `[ZoomChat]
com.zoom.client.langid=1033
com.zoom.client.theme.mode=2
com.disable.connection.pk.status=false
enableDualMonitor=true
autoFullScreen=false
autoFullScreenWhenViewShare=false
enableAlwaysShowMeetingControls=true
autoHideMeetingControl=false
muteMyMicWhenJoinMeeting=true
showConnectedTime=true
stopIncomingVideo=true
enableMirrorEffect=false
selectedVideoDevice=ManyCam Virtual Webcam
videoDeviceName=ManyCam Virtual Webcam
`;

  const iniPath = path.join(ghostZoomData, 'Zoom.us.ini');
  fs.writeFileSync(iniPath, zoomIniContent, 'utf8');
  console.log('Wrote Zoom.us.ini with all settings');

  // Set permissions for Everyone
  await new Promise((resolve) => {
    const cmd = spawn('cmd', ['/c', `icacls "${ghostZoomPath}" /grant Everyone:(OI)(CI)F /T`], {
      shell: false,
      windowsHide: true
    });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });

  return true;
}

// Cleanup any existing OLD ghost users (not our current one)
async function cleanupExistingGhostUsers() {
  return new Promise((resolve) => {
    // Only delete old-style ghost users - NOT zoom1132eliminator which we want to keep
    const cleanupCmd = `
      for /f "tokens=1" %u in ('net user ^| findstr "ZG"') do @net user %u /delete 2>nul
      net user ZoomUser /delete 2>nul
      net user ZoomGhost /delete 2>nul
      net user Zoom /delete 2>nul
      for /d %d in (C:\\Users\\ZG*) do @rmdir /s /q "%d" 2>nul
    `;
    const cmd = spawn('cmd', ['/c', cleanupCmd.replace(/\n/g, ' & ')], {
      shell: true,
      windowsHide: true
    });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Create junction links for any Zoom profile folders to main user
// IMPORTANT: Don't link the main ghost user folder (zoom1132eliminator) - only link variant folders
async function junctionLinkZoomFolders(mainUser) {
  const mainProfile = `C:\\Users\\${mainUser}`;
  const ghostUserBase = GHOST_USER.toLowerCase(); // zoom1132eliminator

  return new Promise((resolve) => {
    // Find zoom-related folders in C:\Users that are NOT the main ghost user folder
    // Only link variant folders like zoom1132eliminator.JG.010, not the base zoom1132eliminator
    const junctionCmd = `
      powershell -Command "
        $mainUser = '${mainUser}';
        $mainProfile = '${mainProfile}';
        $ghostUserBase = '${ghostUserBase}';
        Get-ChildItem 'C:\\Users' -Directory | Where-Object {
          $_.Name -like '*zoom*' -and
          $_.Name -ne $mainUser -and
          $_.Name.ToLower() -ne $ghostUserBase
        } | ForEach-Object {
          $folder = $_.FullName;
          $name = $_.Name;
          # Check if already a junction
          $item = Get-Item $folder;
          if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            Write-Host 'SKIP (already junction): ' $name;
          } else {
            Write-Host 'Processing: ' $name;
            Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue;
            cmd /c mklink /J $folder $mainProfile;
            Write-Host 'LINKED: ' $name ' -> ' $mainProfile;
          }
        }
      "
    `;

    const cmd = spawn('cmd', ['/c', junctionCmd.replace(/\n/g, ' ')], {
      shell: true,
      windowsHide: true
    });

    let output = '';
    cmd.stdout.on('data', (data) => { output += data.toString(); });
    cmd.stderr.on('data', (data) => { output += data.toString(); });

    cmd.on('close', () => {
      console.log('Junction link results:', output);
      resolve({ success: true, output });
    });
    cmd.on('error', (err) => {
      console.error('Junction link error:', err);
      resolve({ success: false, error: err.message });
    });
  });
}

ipcMain.handle('launch-ghost-zoom', async (event) => {
  const mainUser = process.env.USERNAME;
  ghostUserName = GHOST_USER;

  try {
    // Step 0: Kill any existing Zoom
    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 1000));

    // Cleanup old-style ghost users (ZG*, ZoomUser, ZoomGhost, Zoom) but NOT our main user
    await cleanupExistingGhostUsers();
    await new Promise(r => setTimeout(r, 1000));

    // Step 1: Download PsExec
    const psexecPath = await downloadPsExec();

    // Step 2: Check if user exists, create if not
    const userExists = await ghostUserExists();
    if (!userExists) {
      console.log('Creating ghost user:', GHOST_USER);
      await createGhostUser(GHOST_USER, GHOST_PASS);
      await new Promise(r => setTimeout(r, 2000));

      // Initialize profile
      await initGhostProfile(psexecPath, GHOST_USER, GHOST_PASS);
      await new Promise(r => setTimeout(r, 4000));

      // Link folders to main user
      await linkFolders(GHOST_USER, mainUser);
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log('Ghost user already exists, using existing settings');
    }

    // Apply settings (will persist for existing user)
    await configureZoomSettings(GHOST_USER);
    await new Promise(r => setTimeout(r, 500));

    // Step 3: Find Zoom
    let zoomPath = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }

    // Step 4: Launch Zoom via PsExec
    console.log('Launching Zoom...');
    const zoomProc = spawn(psexecPath, ['-accepteula', '-u', GHOST_USER, '-p', GHOST_PASS, '-i', '-h', zoomPath], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });

    // Hide the window so it can't be closed accidentally
    if (mainWindow) {
      mainWindow.hide();
    }

    // Wait for Zoom to close, then exit (keep user for persistent settings)
    zoomProc.on('close', async () => {
      console.log('Zoom closed, exiting app (user kept for settings)...');
      await killZoomProcesses();
      await new Promise(r => setTimeout(r, 1000));
      app.quit();
    });

    return {
      success: true,
      ghostUser: GHOST_USER,
      message: 'Zoom launched - settings will persist between sessions'
    };

  } catch (err) {
    return {
      success: false,
      message: `Error: ${err.message}`
    };
  }
});

ipcMain.handle('cleanup-ghost-user', async () => {
  if (!ghostUserName) {
    return { success: false, message: 'No ghost user to cleanup' };
  }

  // Kill Zoom first
  await killZoomProcesses();
  await new Promise(r => setTimeout(r, 2000));

  // Delete ghost user
  await deleteGhostUser(ghostUserName);
  const deletedUser = ghostUserName;
  ghostUserName = null;

  return {
    success: true,
    message: `Ghost user ${deletedUser} deleted`
  };
});

// =====================================================
// NEW ZOOM USER MANAGEMENT - Simple "Zoom" user approach
// =====================================================
const ZOOM_USER = 'Zoom';
const ZOOM_PASS = 'Zoom1132!';

// Get actual profile path for a user from registry
async function getActualProfilePath(username) {
  return new Promise((resolve) => {
    const cmd = spawn('powershell', ['-Command', `
      $user = Get-LocalUser -Name '${username}' -ErrorAction SilentlyContinue
      if ($user) {
        $sid = $user.SID.Value
        $profilePath = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
        Write-Output "$profilePath"
      } else {
        Write-Output ""
      }
    `], { windowsHide: true });

    let output = '';
    cmd.stdout.on('data', (data) => { output += data.toString(); });

    cmd.on('close', () => {
      const trimmed = output.trim();
      resolve(trimmed || null);
    });
    cmd.on('error', () => resolve(null));
  });
}

// Check if Zoom user exists
ipcMain.handle('check-zoom-user', async () => {
  return new Promise((resolve) => {
    const cmd = spawn('powershell', ['-Command', `
      $user = Get-LocalUser -Name '${ZOOM_USER}' -ErrorAction SilentlyContinue
      if ($user) {
        $sid = $user.SID.Value
        $profilePath = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
        Write-Output "EXISTS|$sid|$profilePath"
      } else {
        Write-Output "NOTEXIST"
      }
    `], { windowsHide: true });

    let output = '';
    cmd.stdout.on('data', (data) => { output += data.toString(); });
    cmd.stderr.on('data', (data) => { output += data.toString(); });

    cmd.on('close', () => {
      const trimmed = output.trim();
      if (trimmed.startsWith('EXISTS|')) {
        const parts = trimmed.split('|');
        resolve({
          exists: true,
          sid: parts[1] || null,
          profilePath: parts[2] || null
        });
      } else {
        resolve({ exists: false });
      }
    });
    cmd.on('error', () => resolve({ exists: false }));
  });
});

// Find actual Zoom user profile folder by scanning C:\Users
async function findZoomUserProfile() {
  return new Promise((resolve) => {
    const cmd = spawn('powershell', ['-Command', `
      # First try registry
      $user = Get-LocalUser -Name '${ZOOM_USER}' -ErrorAction SilentlyContinue
      if ($user) {
        $sid = $user.SID.Value
        $regPath = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$sid" -ErrorAction SilentlyContinue).ProfileImagePath
        if ($regPath -and (Test-Path $regPath)) {
          Write-Output $regPath
          return
        }
      }
      # Fall back to scanning C:\\Users for Zoom* folders
      $folders = Get-ChildItem 'C:\\Users' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '${ZOOM_USER}*' } | Sort-Object LastWriteTime -Descending
      if ($folders.Count -gt 0) {
        Write-Output $folders[0].FullName
      } else {
        Write-Output ""
      }
    `], { windowsHide: true });

    let output = '';
    cmd.stdout.on('data', (data) => { output += data.toString(); });

    cmd.on('close', () => {
      const trimmed = output.trim();
      resolve(trimmed || null);
    });
    cmd.on('error', () => resolve(null));
  });
}

// Junction link ALL Zoom user variant profile folders to main user
async function junctionLinkAllZoomProfiles(mainUser) {
  const mainProfile = `C:\\Users\\${mainUser}`;
  const foldersToLink = ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos', 'Music'];

  return new Promise((resolve) => {
    const cmd = spawn('powershell', ['-Command', `
      $mainProfile = '${mainProfile}'
      $foldersToLink = @('Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos', 'Music')
      $results = @()

      # Find ALL Zoom profile folders (Zoom, Zoom.COMPUTER.001, etc)
      Get-ChildItem 'C:\\Users' -Directory | Where-Object { $_.Name -like '${ZOOM_USER}*' } | ForEach-Object {
        $profilePath = $_.FullName
        $profileName = $_.Name
        $results += "Processing profile: $profileName at $profilePath"

        foreach ($folder in $foldersToLink) {
          $targetPath = Join-Path $profilePath $folder
          $sourcePath = Join-Path $mainProfile $folder

          # Check if it's already a junction
          if (Test-Path $targetPath) {
            $item = Get-Item $targetPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
              $results += "  SKIP $folder (already junction)"
              continue
            }
          }

          # Remove existing folder and create junction
          if (Test-Path $targetPath) {
            Remove-Item $targetPath -Recurse -Force -ErrorAction SilentlyContinue
          }
          cmd /c mklink /J "$targetPath" "$sourcePath" 2>&1 | Out-Null
          if (Test-Path $targetPath) {
            $results += "  LINKED $folder -> $sourcePath"
          } else {
            $results += "  FAILED $folder"
          }
        }
      }

      $results -join '|'
    `], { windowsHide: true });

    let output = '';
    cmd.stdout.on('data', (data) => { output += data.toString(); });
    cmd.stderr.on('data', (data) => { output += data.toString(); });

    cmd.on('close', () => {
      console.log('Junction link all Zoom profiles results:', output);
      resolve({ success: true, output: output.trim() });
    });
    cmd.on('error', (err) => {
      console.error('Junction link error:', err);
      resolve({ success: false, error: err.message });
    });
  });
}

// Create Zoom user with junction links
ipcMain.handle('create-zoom-user', async () => {
  const mainUser = process.env.USERNAME;
  const mainProfile = `C:\\Users\\${mainUser}`;
  const junctions = [];

  try {
    // Step 1: Create the user
    await new Promise((resolve, reject) => {
      const cmd = spawn('cmd', ['/c', `net user ${ZOOM_USER} ${ZOOM_PASS} /add && net localgroup Users ${ZOOM_USER} /add`], {
        windowsHide: true
      });
      let stderr = '';
      cmd.stderr.on('data', (data) => { stderr += data.toString(); });
      cmd.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || 'Failed to create user'));
      });
      cmd.on('error', reject);
    });

    // Step 2: Initialize the user profile by running a command as that user
    const psexecPath = await downloadPsExec();
    await new Promise((resolve) => {
      const cmd = spawn(psexecPath, ['-accepteula', '-u', ZOOM_USER, '-p', ZOOM_PASS, '-w', 'C:\\', 'cmd', '/c', 'echo Profile initialized'], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });

    // Wait for profile to be created (increased from 3s to 5s for reliability)
    await new Promise(r => setTimeout(r, 5000));

    // Step 3: Find the ACTUAL profile path by scanning C:\Users (more reliable than registry)
    const zoomProfile = await findZoomUserProfile() || `C:\\Users\\${ZOOM_USER}`;
    console.log('Actual Zoom profile path:', zoomProfile);

    // Step 4: Create junction links for ALL Zoom user profile folders (handles variant folders)
    const linkResult = await junctionLinkAllZoomProfiles(mainUser);
    if (linkResult.output) {
      const links = linkResult.output.split('|').filter(l => l.includes('LINKED'));
      links.forEach(l => junctions.push(l.trim()));
    }

    // Step 5: Set permissions on Zoom profile
    await new Promise((resolve) => {
      const cmd = spawn('cmd', ['/c', `icacls "${zoomProfile}" /grant Everyone:(OI)(CI)F /T`], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });

    return {
      success: true,
      junctions: junctions,
      profilePath: zoomProfile
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});

// Delete Zoom user account
ipcMain.handle('delete-zoom-user', async () => {
  try {
    // Kill any Zoom processes first
    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 1000));

    // Delete the user account
    await new Promise((resolve, reject) => {
      const cmd = spawn('cmd', ['/c', `net user ${ZOOM_USER} /delete`], {
        windowsHide: true
      });
      let stderr = '';
      cmd.stderr.on('data', (data) => { stderr += data.toString(); });
      cmd.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || 'Failed to delete user'));
      });
      cmd.on('error', reject);
    });

    // Delete user profile folder
    const zoomProfile = await findZoomUserProfile();
    if (zoomProfile && fs.existsSync(zoomProfile)) {
      await deleteDirectory(zoomProfile);
    }

    // Also try deleting standard profile path
    const standardProfile = `C:\\Users\\${ZOOM_USER}`;
    if (fs.existsSync(standardProfile)) {
      await deleteDirectory(standardProfile);
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});

// Launch Zoom as the Zoom user
ipcMain.handle('launch-zoom-as-user', async () => {
  try {
    // Kill any existing Zoom processes
    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 1000));

    // Download PsExec if needed
    const psexecPath = await downloadPsExec();

    // Find Zoom executable
    let zoomPath = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }
    if (!fs.existsSync(zoomPath)) {
      // Try LocalAppData
      zoomPath = path.join(process.env.LOCALAPPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }

    if (!fs.existsSync(zoomPath)) {
      return {
        success: false,
        error: 'Zoom executable not found. Please install Zoom first.'
      };
    }

    // Launch Zoom as the Zoom user using PsExec
    const zoomProc = spawn(psexecPath, [
      '-accepteula',
      '-u', ZOOM_USER,
      '-p', ZOOM_PASS,
      '-i',  // Interactive - shows window
      '-h',  // Run with elevated token if available
      zoomPath
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    zoomProc.unref();

    return {
      success: true,
      zoomPath: zoomPath
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});

// Reset Zoom user (delete profile completely, recreate, launch)
// Quit the app
ipcMain.handle('quit-app', async () => {
  app.quit();
});

ipcMain.handle('reset-zoom-user', async () => {
  const mainUser = process.env.USERNAME;
  const mainProfile = `C:\\Users\\${mainUser}`;
  const steps = [];
  const foldersToUnlink = ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos', 'Music'];

  try {
    // Step 1: Kill Zoom processes
    steps.push('Killing Zoom processes...');
    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 2000));
    steps.push('Zoom processes terminated');

    // Step 2: Get the CURRENT profile path before deletion (may be Zoom.COMPUTER.001 etc)
    const oldZoomProfile = await getActualProfilePath(ZOOM_USER) || `C:\\Users\\${ZOOM_USER}`;
    steps.push(`Found existing profile at: ${oldZoomProfile}`);

    // Step 3: Delete the Zoom user (this also removes from user list)
    steps.push('Deleting Zoom user account...');
    await new Promise((resolve) => {
      const cmd = spawn('cmd', ['/c', `net user ${ZOOM_USER} /delete 2>nul`], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    await new Promise(r => setTimeout(r, 1000));
    steps.push('User account deleted');

    // Step 4: Delete the user profile folder completely (using actual path)
    steps.push('Deleting user profile folder...');

    // First remove junction links (so we don't delete main user's files!)
    for (const folder of foldersToUnlink) {
      await new Promise((resolve) => {
        const cmd = spawn('cmd', ['/c', `rmdir "${oldZoomProfile}\\${folder}" 2>nul`], {
          windowsHide: true
        });
        cmd.on('close', () => resolve());
        cmd.on('error', () => resolve());
      });
    }

    // Now delete the entire profile folder
    await new Promise((resolve) => {
      const cmd = spawn('cmd', ['/c', `rmdir /s /q "${oldZoomProfile}" 2>nul`], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });

    // Also clean up any stale Zoom profile folders (Zoom.001, Zoom.COMPUTER.002, etc)
    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem 'C:\\Users' -Directory | Where-Object { $_.Name -like '${ZOOM_USER}*' } | ForEach-Object {
          $folder = $_.FullName
          # Remove junctions first
          @('Documents','Downloads','Desktop','Pictures','Videos','Music') | ForEach-Object {
            $jPath = Join-Path $folder $_
            if (Test-Path $jPath) { cmd /c rmdir "$jPath" 2>$null }
          }
          # Then delete folder
          Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue
        }
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    await new Promise(r => setTimeout(r, 1000));
    steps.push('Profile folder(s) deleted');

    // Step 5: Delete from ProfileList registry (cleanup stale entries)
    steps.push('Cleaning registry...');
    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList" | ForEach-Object {
          $path = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ProfileImagePath
          if ($path -like '*\\${ZOOM_USER}' -or $path -like '*\\${ZOOM_USER}.*') {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
          }
        }
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps.push('Registry cleaned');

    // Step 6: Recreate the user
    steps.push('Creating fresh Zoom user...');
    await new Promise((resolve, reject) => {
      const cmd = spawn('cmd', ['/c', `net user ${ZOOM_USER} ${ZOOM_PASS} /add && net localgroup Users ${ZOOM_USER} /add`], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    await new Promise(r => setTimeout(r, 1000));
    steps.push('User created');

    // Step 7: Initialize profile
    steps.push('Initializing user profile...');
    const psexecPath = await downloadPsExec();
    await new Promise((resolve) => {
      const cmd = spawn(psexecPath, ['-accepteula', '-u', ZOOM_USER, '-p', ZOOM_PASS, '-w', 'C:\\', 'cmd', '/c', 'echo init'], {
        windowsHide: true
      });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    // Wait longer for profile to be fully created (increased from 3s to 5s)
    await new Promise(r => setTimeout(r, 5000));

    // Step 8: Get the NEW actual profile path by scanning C:\Users (more reliable)
    const newZoomProfile = await findZoomUserProfile() || `C:\\Users\\${ZOOM_USER}`;
    steps.push(`Profile initialized at: ${newZoomProfile} (new SID assigned)`);

    // Step 9: Create junction links for ALL Zoom profile folders (handles variant folders)
    steps.push('Creating folder links...');
    const linkResult = await junctionLinkAllZoomProfiles(mainUser);
    if (linkResult.output) {
      const linkedCount = linkResult.output.split('|').filter(l => l.includes('LINKED')).length;
      steps.push(`Created ${linkedCount} folder links`);
    } else {
      steps.push('Folder links created');
    }

    // Step 8: Launch Zoom
    steps.push('Launching Zoom...');
    let zoomPath = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.LOCALAPPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }

    const zoomProc = spawn(psexecPath, [
      '-accepteula',
      '-u', ZOOM_USER,
      '-p', ZOOM_PASS,
      '-i',
      '-h',
      zoomPath
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    zoomProc.unref();
    steps.push('Zoom launched with fresh identity');

    return {
      success: true,
      steps: steps
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      steps: steps
    };
  }
});

// ============================================================
// FULL RESET & REINSTALL - One-click complete Zoom reset
// ============================================================
const https = require('https');
const { execSync } = require('child_process');

const ZOOM_INSTALLER_URL = 'https://zoom.us/client/latest/ZoomInstallerFull.msi';
const ZOOM_INSTALLER_PATH = path.join(os.tmpdir(), 'ZoomInstallerFull.msi');

// Download file with progress
function downloadFile(url, destPath, progressCallback) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath, progressCallback)
          .then(resolve)
          .catch(reject);
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (progressCallback && totalSize) {
          progressCallback(Math.round((downloadedSize / totalSize) * 100));
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
    });

    request.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });

    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

// Uninstall Zoom completely
async function uninstallZoom() {
  return new Promise((resolve) => {
    // Try multiple uninstall methods
    const commands = [
      // MSI uninstall
      'msiexec /x {zoom_msi_guid} /qn /norestart',
      // Zoom's own uninstaller
      '"C:\\Program Files\\Zoom\\bin\\Installer.exe" /uninstall',
      '"C:\\Program Files (x86)\\Zoom\\bin\\Installer.exe" /uninstall',
      // Clean up with WMI
      'wmic product where "name like \'%%Zoom%%\'" call uninstall /nointeractive'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Install Zoom from MSI
async function installZoom(msiPath) {
  return new Promise((resolve, reject) => {
    // Silent install with no restart
    const cmd = spawn('msiexec', ['/i', msiPath, '/qn', '/norestart', 'ALLUSERS=1'], {
      windowsHide: true
    });

    cmd.on('close', (code) => {
      if (code === 0 || code === 3010) { // 3010 = success, restart required
        resolve(true);
      } else {
        reject(new Error(`Install failed with code ${code}`));
      }
    });

    cmd.on('error', reject);
  });
}

// Full Reset & Reinstall IPC Handler
ipcMain.handle('full-reset-reinstall', async (event) => {
  const steps = [];

  try {
    // Step 1: Kill all Zoom processes
    steps.push({ step: 'Killing Zoom processes...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 0 });

    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 2000));
    steps[0].status = 'done';

    // Step 2: Uninstall Zoom
    steps.push({ step: 'Uninstalling Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 1 });

    await uninstallZoom();
    await new Promise(r => setTimeout(r, 3000));
    steps[1].status = 'done';

    // Step 3: Delete services
    steps.push({ step: 'Removing Zoom services...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 2 });

    await deleteZoomServices();
    await new Promise(r => setTimeout(r, 1000));
    steps[2].status = 'done';

    // Step 4: Delete scheduled tasks
    steps.push({ step: 'Removing scheduled tasks...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 3 });

    await deleteZoomScheduledTasks();
    await new Promise(r => setTimeout(r, 1000));
    steps[3].status = 'done';

    // Step 5: Delete registry entries
    steps.push({ step: 'Cleaning registry...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 4 });

    await deleteZoomRegistry();
    await new Promise(r => setTimeout(r, 1000));
    steps[4].status = 'done';

    // Step 6: Delete ALL Zoom data folders
    steps.push({ step: 'Deleting all Zoom data...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 5 });

    const zoomDirs = getZoomDataPaths();
    for (const dir of zoomDirs) {
      await deleteDirectory(dir);
    }

    // Also delete Common Files
    await deleteDirectory('C:\\Program Files\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Zoom');

    await new Promise(r => setTimeout(r, 2000));
    steps[5].status = 'done';

    // Step 7: Clean prefetch files
    steps.push({ step: 'Cleaning prefetch files...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 6 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*CPT*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[6].status = 'done';

    // Step 8: Clean firewall rules + MUI cache + DNS
    steps.push({ step: 'Deep cleaning system traces...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 7 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        # Remove firewall rules
        Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' -or $_.DisplayName -like '*zoom*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Clean MUI cache
        $muiKey = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
        if (Test-Path $muiKey) {
          Get-ItemProperty $muiKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $muiKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Clean app compat flags
        $compatKey = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
        if (Test-Path $compatKey) {
          Get-ItemProperty $compatKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $compatKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Flush DNS cache
        ipconfig /flushdns | Out-Null
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[7].status = 'done';

    // Step 9: Download Zoom installer
    steps.push({ step: 'Downloading Zoom installer...', status: 'running', progress: 0 });
    event.sender.send('reset-progress', { steps, currentStep: 8 });

    // Delete old installer if exists
    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }

    await downloadFile(ZOOM_INSTALLER_URL, ZOOM_INSTALLER_PATH, (progress) => {
      steps[8].progress = progress;
      event.sender.send('reset-progress', { steps, currentStep: 8 });
    });

    steps[8].status = 'done';

    // Step 10: Install Zoom
    steps.push({ step: 'Installing Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 9 });

    await installZoom(ZOOM_INSTALLER_PATH);
    await new Promise(r => setTimeout(r, 3000));
    steps[9].status = 'done';

    // Step 11: Cleanup installer
    steps.push({ step: 'Cleaning up...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 10 });

    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }
    steps[10].status = 'done';

    // Done!
    event.sender.send('reset-progress', { steps, currentStep: 11, complete: true });

    return {
      success: true,
      message: 'Zoom has been completely reset and reinstalled!',
      steps: steps.map(s => s.step)
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      steps: steps.map(s => s.step)
    };
  }
});

// Get reset progress (for UI updates)
ipcMain.handle('get-reset-status', async () => {
  return { ready: true };
});

// ============================================================
// QUICK RESET & REINSTALL - Simple reset on current account
// No user creation/management, just clean and reinstall
// ============================================================
ipcMain.handle('quick-reset-reinstall', async (event) => {
  const steps = [];

  try {
    // Step 1: Kill all Zoom processes
    steps.push({ step: 'Killing Zoom processes...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 0 });

    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 2000));
    steps[0].status = 'done';

    // Step 2: Uninstall Zoom
    steps.push({ step: 'Uninstalling Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 1 });

    await uninstallZoom();
    await new Promise(r => setTimeout(r, 3000));
    steps[1].status = 'done';

    // Step 3: Delete services
    steps.push({ step: 'Removing Zoom services...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 2 });

    await deleteZoomServices();
    await new Promise(r => setTimeout(r, 1000));
    steps[2].status = 'done';

    // Step 4: Delete scheduled tasks
    steps.push({ step: 'Removing scheduled tasks...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 3 });

    await deleteZoomScheduledTasks();
    await new Promise(r => setTimeout(r, 1000));
    steps[3].status = 'done';

    // Step 5: Delete registry entries
    steps.push({ step: 'Cleaning registry...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 4 });

    await deleteZoomRegistry();
    await new Promise(r => setTimeout(r, 1000));
    steps[4].status = 'done';

    // Step 6: Delete ALL Zoom data folders (current user only)
    steps.push({ step: 'Deleting all Zoom data...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 5 });

    const zoomDirs = getZoomDataPaths();
    for (const dir of zoomDirs) {
      await deleteDirectory(dir);
    }

    // Also delete Program Files
    await deleteDirectory('C:\\Program Files\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Zoom');

    await new Promise(r => setTimeout(r, 2000));
    steps[5].status = 'done';

    // Step 7: Clean prefetch files
    steps.push({ step: 'Cleaning prefetch files...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 6 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*CPT*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[6].status = 'done';

    // Step 8: Clean firewall rules + MUI cache + DNS
    steps.push({ step: 'Deep cleaning system traces...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 7 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        # Remove firewall rules
        Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' -or $_.DisplayName -like '*zoom*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Clean MUI cache
        $muiKey = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
        if (Test-Path $muiKey) {
          Get-ItemProperty $muiKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $muiKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Clean app compat flags
        $compatKey = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
        if (Test-Path $compatKey) {
          Get-ItemProperty $compatKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $compatKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Flush DNS cache
        ipconfig /flushdns | Out-Null
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[7].status = 'done';

    // Step 9: Download Zoom installer
    steps.push({ step: 'Downloading Zoom installer...', status: 'running', progress: 0 });
    event.sender.send('reset-progress', { steps, currentStep: 8 });

    // Delete old installer if exists
    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }

    await downloadFile(ZOOM_INSTALLER_URL, ZOOM_INSTALLER_PATH, (progress) => {
      steps[8].progress = progress;
      event.sender.send('reset-progress', { steps, currentStep: 8 });
    });

    steps[8].status = 'done';

    // Step 10: Install Zoom
    steps.push({ step: 'Installing Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 9 });

    await installZoom(ZOOM_INSTALLER_PATH);
    await new Promise(r => setTimeout(r, 3000));
    steps[9].status = 'done';

    // Step 11: Cleanup installer
    steps.push({ step: 'Cleaning up...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 10 });

    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }
    steps[10].status = 'done';

    // Done!
    event.sender.send('reset-progress', { steps, currentStep: 11, complete: true });

    return {
      success: true,
      message: 'Zoom has been reset and reinstalled on your account!',
      steps: steps.map(s => s.step)
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      steps: steps.map(s => s.step)
    };
  }
});

// ============================================================
// FULL RESET WITH OPTIONS - Configurable reset
// Options: { uninstall: boolean, reinstall: boolean }
// ============================================================
ipcMain.handle('full-reset', async (event, options = {}) => {
  const { uninstall = true, reinstall = true } = options;
  const steps = [];

  try {
    // Step 1: Kill all Zoom processes
    steps.push({ step: 'Killing Zoom processes...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: 0 });

    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 2000));
    steps[0].status = 'done';

    // Step 2: Uninstall Zoom (conditional)
    if (uninstall) {
      steps.push({ step: 'Uninstalling Zoom...', status: 'running' });
      event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

      await uninstallZoom();
      await new Promise(r => setTimeout(r, 3000));
      steps[steps.length - 1].status = 'done';
    } else {
      steps.push({ step: 'Uninstalling Zoom...', status: 'skipped' });
      event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });
    }

    // Step 3: Delete services
    steps.push({ step: 'Removing Zoom services...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    await deleteZoomServices();
    await new Promise(r => setTimeout(r, 1000));
    steps[steps.length - 1].status = 'done';

    // Step 4: Delete scheduled tasks
    steps.push({ step: 'Removing scheduled tasks...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    await deleteZoomScheduledTasks();
    await new Promise(r => setTimeout(r, 1000));
    steps[steps.length - 1].status = 'done';

    // Step 5: Delete registry entries
    steps.push({ step: 'Cleaning registry...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    await deleteZoomRegistry();
    await new Promise(r => setTimeout(r, 1000));
    steps[steps.length - 1].status = 'done';

    // Step 6: Delete ALL Zoom data folders
    steps.push({ step: 'Deleting all Zoom data...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    const zoomDirs = getZoomDataPaths();
    for (const dir of zoomDirs) {
      await deleteDirectory(dir);
    }

    // Also delete Program Files
    await deleteDirectory('C:\\Program Files\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Zoom');

    await new Promise(r => setTimeout(r, 2000));
    steps[steps.length - 1].status = 'done';

    // Step 7: Clean prefetch files
    steps.push({ step: 'Cleaning prefetch files...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*CPT*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[steps.length - 1].status = 'done';

    // Step 8: Deep clean system traces
    steps.push({ step: 'Deep cleaning system traces...', status: 'running' });
    event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        # Remove firewall rules
        Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' -or $_.DisplayName -like '*zoom*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Clean MUI cache
        $muiKey = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
        if (Test-Path $muiKey) {
          Get-ItemProperty $muiKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $muiKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Clean app compat flags
        $compatKey = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
        if (Test-Path $compatKey) {
          Get-ItemProperty $compatKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty |
            Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } |
            ForEach-Object { Remove-ItemProperty -Path $compatKey -Name $_.Name -ErrorAction SilentlyContinue }
        }

        # Flush DNS cache
        ipconfig /flushdns | Out-Null
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[steps.length - 1].status = 'done';

    // Step 9 & 10: Download and Install Zoom (conditional)
    if (reinstall) {
      steps.push({ step: 'Downloading Zoom installer...', status: 'running', progress: 0 });
      event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

      // Delete old installer if exists
      if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
        fs.unlinkSync(ZOOM_INSTALLER_PATH);
      }

      await downloadFile(ZOOM_INSTALLER_URL, ZOOM_INSTALLER_PATH, (progress) => {
        steps[steps.length - 1].progress = progress;
        event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });
      });

      steps[steps.length - 1].status = 'done';

      // Install Zoom
      steps.push({ step: 'Installing Zoom...', status: 'running' });
      event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });

      await installZoom(ZOOM_INSTALLER_PATH);
      await new Promise(r => setTimeout(r, 3000));
      steps[steps.length - 1].status = 'done';

      // Cleanup installer
      if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
        fs.unlinkSync(ZOOM_INSTALLER_PATH);
      }
    } else {
      steps.push({ step: 'Downloading Zoom installer...', status: 'skipped' });
      steps.push({ step: 'Installing Zoom...', status: 'skipped' });
      event.sender.send('reset-progress', { steps, currentStep: steps.length - 1 });
    }

    // Final step: Complete
    steps.push({ step: 'Finalizing...', status: 'done' });

    // Done!
    event.sender.send('reset-progress', { steps, currentStep: steps.length, complete: true });

    let message = 'Zoom data has been reset!';
    if (reinstall) {
      message = 'Zoom has been reset and reinstalled!';
    }

    return {
      success: true,
      message: message,
      steps: steps.map(s => s.step)
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      steps: steps.map(s => s.step)
    };
  }
});
