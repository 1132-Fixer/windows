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
    icon: path.join(__dirname, 'icon.ico')
  });

  mainWindow.loadFile('index.html');

  // Prevent closing if files remain
  mainWindow.on('close', (event) => {
    // This will be handled by renderer
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
    localAppData ? path.join(localAppData, 'ZoomOutlookPlugin') : null
  ];

  // === CRITICAL: Scan C:\Users\ for Zoom profile folders ===
  // These are variant profile folders like "zoom1132eliminator.JG.010"
  // that Windows creates and contain device identifiers!
  const usersDir = 'C:\\Users';
  const currentUser = process.env.USERNAME?.toLowerCase() || '';
  try {
    if (fs.existsSync(usersDir)) {
      const userFolders = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const entry of userFolders) {
        if (entry.isDirectory()) {
          const folderName = entry.name.toLowerCase();
          // Find folders with "zoom" in name (but not the current user's folder)
          if (folderName.includes('zoom') && folderName !== currentUser) {
            candidates.push(path.join(usersDir, entry.name));
          }
          // Also check for ZG* folders (old ghost user format)
          if (folderName.startsWith('zg')) {
            candidates.push(path.join(usersDir, entry.name));
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

// Kill all Zoom processes including services
function killZoomProcesses() {
  return new Promise((resolve) => {
    // Kill processes AND stop services - COMPREHENSIVE list
    const killCommands = [
      // Kill all Zoom processes
      'taskkill /F /IM Zoom.exe',
      'taskkill /F /IM ZoomWebHost.exe',
      'taskkill /F /IM CptHost.exe',
      'taskkill /F /IM CptService.exe',
      'taskkill /F /IM zCrashReport.exe',
      'taskkill /F /IM ZoomOutlookIMPlugin.exe',
      'taskkill /F /IM ZoomInstaller.exe',
      'taskkill /F /IM Zoomus.exe',
      'taskkill /F /IM ZoomSDKMessenger.exe',

      // Stop Zoom services
      'net stop "Zoom Sharing Service"',
      'net stop "CptService"',
      'net stop "ZoomCptService"',
      'sc stop CptService',
      'sc stop ZoomCptService',

      // Kill with tree (child processes)
      'taskkill /F /T /IM Zoom.exe',
      'taskkill /F /T /IM CptService.exe',
      'taskkill /F /T /IM CptHost.exe'
    ].join(' & ');

    const killCmd = spawn('cmd', ['/c', killCommands], {
      shell: false,
      windowsHide: true
    });

    killCmd.on('close', (code) => {
      resolve({ killed: 1 });
    });

    killCmd.on('error', () => {
      resolve({ killed: 0 });
    });
  });
}

// Delete Zoom scheduled tasks that may store device info
function deleteZoomScheduledTasks() {
  return new Promise((resolve) => {
    const commands = [
      // Delete Zoom scheduled tasks
      'schtasks /delete /tn "Zoom" /f',
      'schtasks /delete /tn "ZoomUpdateTaskMachine" /f',
      'schtasks /delete /tn "ZoomUpdateTaskUserS-*" /f',
      'schtasks /delete /tn "ZoomInstallUpdate" /f',

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

      // Windows Credentials
      'cmdkey /delete:zoom.us',
      'cmdkey /delete:Zoom',
      'cmdkey /delete:ZoomVideo',
      'cmdkey /delete:ZoomUMX'
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
