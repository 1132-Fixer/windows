const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 550,
    backgroundColor: '#0f0f23',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// ============================================================
// ZOOM DATA PATHS - All locations where Zoom stores data
// ============================================================
function getZoomDataPaths() {
  const paths = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const temp = process.env.TEMP;
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';

  const candidates = [
    // Main Zoom folders
    appData ? path.join(appData, 'Zoom') : null,
    localAppData ? path.join(localAppData, 'Zoom') : null,
    appData ? path.join(appData, 'Zoom Meetings') : null,
    appData ? path.join(appData, 'zoomus') : null,
    localAppData ? path.join(localAppData, 'zoomus') : null,
    userProfile ? path.join(userProfile, 'Documents', 'Zoom') : null,
    temp ? path.join(temp, 'Zoom') : null,
    temp ? path.join(temp, 'zoomus') : null,
    temp ? path.join(temp, 'zoom_installer') : null,
    userProfile ? path.join(userProfile, 'AppData', 'LocalLow', 'Zoom') : null,
    appData ? path.join(appData, 'ZoomLogs') : null,
    localAppData ? path.join(localAppData, 'ZoomLogs') : null,

    // ProgramData
    path.join(programData, 'Zoom'),
    path.join(programData, 'ZoomVideo'),
    path.join(programData, 'Zoom Video Communications'),
    path.join(programData, 'CptService'),
    path.join(programData, 'CptHost'),
    path.join(programData, 'Zoom CptService'),

    // Programs folder
    localAppData ? path.join(localAppData, 'Programs', 'Zoom') : null,
    localAppData ? path.join(localAppData, 'Programs', 'zoom.us') : null,

    // VDI and plugins
    appData ? path.join(appData, 'Zoom VDI') : null,
    localAppData ? path.join(localAppData, 'Zoom VDI') : null,
    appData ? path.join(appData, 'ZoomOutlookPlugin') : null,
    appData ? path.join(appData, 'ZoomUMX') : null,
    localAppData ? path.join(localAppData, 'ZoomUMX') : null,
    appData ? path.join(appData, 'zoom.us') : null,
    localAppData ? path.join(localAppData, 'zoom.us') : null,
    appData ? path.join(appData, 'Zoom Workplace') : null,
    localAppData ? path.join(localAppData, 'Zoom Workplace') : null,

    // Program Files
    'C:\\Program Files\\Zoom',
    'C:\\Program Files (x86)\\Zoom',
    'C:\\Program Files\\Zoom Workplace',
    'C:\\Program Files (x86)\\Zoom Workplace',
    'C:\\Program Files\\Common Files\\Zoom',
    'C:\\Program Files (x86)\\Common Files\\Zoom'
  ];

  // Scan ALL user profiles for Zoom data
  const usersDir = 'C:\\Users';
  const systemFolders = ['public', 'default', 'default user', 'all users'];

  try {
    if (fs.existsSync(usersDir)) {
      const userFolders = fs.readdirSync(usersDir, { withFileTypes: true });
      for (const entry of userFolders) {
        if (entry.isDirectory()) {
          const folderName = entry.name.toLowerCase();
          const userPath = path.join(usersDir, entry.name);

          if (systemFolders.includes(folderName)) continue;

          const userAppDataRoaming = path.join(userPath, 'AppData', 'Roaming');
          const userAppDataLocal = path.join(userPath, 'AppData', 'Local');
          const userDocuments = path.join(userPath, 'Documents');

          const userZoomPaths = [
            path.join(userAppDataRoaming, 'Zoom'),
            path.join(userAppDataRoaming, 'Zoom Meetings'),
            path.join(userAppDataRoaming, 'zoomus'),
            path.join(userAppDataRoaming, 'ZoomLogs'),
            path.join(userAppDataRoaming, 'ZoomUMX'),
            path.join(userAppDataRoaming, 'zoom.us'),
            path.join(userAppDataRoaming, 'Zoom Workplace'),
            path.join(userAppDataLocal, 'Zoom'),
            path.join(userAppDataLocal, 'zoomus'),
            path.join(userAppDataLocal, 'ZoomLogs'),
            path.join(userAppDataLocal, 'ZoomUMX'),
            path.join(userAppDataLocal, 'zoom.us'),
            path.join(userAppDataLocal, 'Zoom Workplace'),
            path.join(userAppDataLocal, 'Programs', 'Zoom'),
            path.join(userDocuments, 'Zoom')
          ];

          for (const zPath of userZoomPaths) {
            if (fs.existsSync(zPath)) {
              candidates.push(zPath);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error scanning Users:', err);
  }

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

// Kill Zoom processes
function killZoomProcesses() {
  return new Promise((resolve) => {
    const commands = [
      'taskkill /F /IM Zoom.exe',
      'taskkill /F /IM ZoomWebHost.exe',
      'taskkill /F /IM CptHost.exe',
      'taskkill /F /IM CptService.exe',
      'taskkill /F /IM zCrashReport.exe',
      'taskkill /F /IM ZoomOutlookIMPlugin.exe',
      'taskkill /F /IM ZoomInstaller.exe',
      'taskkill /F /IM Zoomus.exe',
      'net stop "Zoom Sharing Service"',
      'net stop CptService',
      'sc stop CptService'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Delete directory
function deleteDirectory(dirPath) {
  return new Promise((resolve) => {
    const cmd = spawn('cmd', ['/c', `rmdir /s /q "${dirPath}"`], { windowsHide: true });
    cmd.on('close', (code) => resolve({ success: code === 0 }));
    cmd.on('error', () => resolve({ success: false }));
  });
}

// Delete scheduled tasks
function deleteZoomScheduledTasks() {
  return new Promise((resolve) => {
    const commands = [
      'schtasks /delete /tn "Zoom" /f',
      'schtasks /delete /tn "ZoomUpdateTaskMachine" /f',
      'powershell -Command "Get-ScheduledTask | Where-Object {$_.TaskName -like \'*Zoom*\'} | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue"'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Delete services
function deleteZoomServices() {
  return new Promise((resolve) => {
    const commands = [
      'net stop CptService',
      'sc delete CptService',
      'sc delete ZoomCptService',
      'sc delete "Zoom Sharing Service"'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Delete registry
function deleteZoomRegistry() {
  return new Promise((resolve) => {
    const commands = [
      'reg delete "HKCU\\Software\\Zoom" /f',
      'reg delete "HKCU\\Software\\ZoomUMX" /f',
      'reg delete "HKCU\\Software\\zoom.us" /f',
      'reg delete "HKLM\\Software\\Zoom" /f',
      'reg delete "HKLM\\Software\\ZoomUMX" /f',
      'reg delete "HKLM\\Software\\WOW6432Node\\Zoom" /f',
      'reg delete "HKLM\\Software\\CptService" /f',
      'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "Zoom" /f',
      'cmdkey /delete:zoom.us',
      'cmdkey /delete:Zoom'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Uninstall Zoom
function uninstallZoom() {
  return new Promise((resolve) => {
    const commands = [
      '"C:\\Program Files\\Zoom\\bin\\Installer.exe" /uninstall',
      '"C:\\Program Files (x86)\\Zoom\\bin\\Installer.exe" /uninstall',
      'wmic product where "name like \'%%Zoom%%\'" call uninstall /nointeractive'
    ].join(' & ');

    const cmd = spawn('cmd', ['/c', commands], { windowsHide: true });
    cmd.on('close', () => resolve());
    cmd.on('error', () => resolve());
  });
}

// Download file
const ZOOM_INSTALLER_URL = 'https://zoom.us/client/latest/ZoomInstallerFull.msi?archType=x64';
const ZOOM_INSTALLER_PATH = path.join(os.tmpdir(), 'ZoomInstallerFull.msi');

function downloadFile(url, destPath, progressCallback) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath, progressCallback)
          .then(resolve).catch(reject);
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

// Install Zoom
function installZoom(msiPath) {
  return new Promise((resolve, reject) => {
    const cmd = spawn('msiexec', ['/i', msiPath, '/qn', '/norestart', 'ALLUSERS=1'], { windowsHide: true });
    cmd.on('close', (code) => {
      if (code === 0 || code === 3010) resolve(true);
      else reject(new Error(`Install failed with code ${code}`));
    });
    cmd.on('error', reject);
  });
}

// Launch Zoom
function launchZoom() {
  return new Promise((resolve) => {
    let zoomPath = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }
    if (!fs.existsSync(zoomPath)) {
      zoomPath = path.join(process.env.LOCALAPPDATA, 'Zoom', 'bin', 'Zoom.exe');
    }

    if (fs.existsSync(zoomPath)) {
      const proc = spawn(zoomPath, [], { detached: true, stdio: 'ignore' });
      proc.unref();
      resolve(true);
    } else {
      // Try protocol launch
      spawn('cmd', ['/c', 'start', 'zoommtg://'], { shell: true, detached: true });
      resolve(true);
    }
  });
}

// Quick Reset & Reinstall with auto-launch
ipcMain.handle('quick-reset-reinstall', async (event) => {
  const steps = [];

  try {
    // Step 1: Kill processes
    steps.push({ step: 'Killing Zoom processes...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await killZoomProcesses();
    await new Promise(r => setTimeout(r, 2000));
    steps[0].status = 'done';

    // Step 2: Uninstall
    steps.push({ step: 'Uninstalling Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await uninstallZoom();
    await new Promise(r => setTimeout(r, 3000));
    steps[1].status = 'done';

    // Step 3: Services
    steps.push({ step: 'Removing services...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await deleteZoomServices();
    await new Promise(r => setTimeout(r, 1000));
    steps[2].status = 'done';

    // Step 4: Tasks
    steps.push({ step: 'Removing scheduled tasks...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await deleteZoomScheduledTasks();
    await new Promise(r => setTimeout(r, 1000));
    steps[3].status = 'done';

    // Step 5: Registry
    steps.push({ step: 'Cleaning registry...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await deleteZoomRegistry();
    await new Promise(r => setTimeout(r, 1000));
    steps[4].status = 'done';

    // Step 6: Delete data
    steps.push({ step: 'Deleting all Zoom data...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    const zoomDirs = getZoomDataPaths();
    for (const dir of zoomDirs) {
      await deleteDirectory(dir);
    }
    await deleteDirectory('C:\\Program Files\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Common Files\\Zoom');
    await deleteDirectory('C:\\Program Files\\Zoom');
    await deleteDirectory('C:\\Program Files (x86)\\Zoom');
    await new Promise(r => setTimeout(r, 2000));
    steps[5].status = 'done';

    // Step 7: Clean prefetch
    steps.push({ step: 'Cleaning system traces...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await new Promise((resolve) => {
      const cmd = spawn('powershell', ['-Command', `
        Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Zoom*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        ipconfig /flushdns | Out-Null
      `], { windowsHide: true });
      cmd.on('close', () => resolve());
      cmd.on('error', () => resolve());
    });
    steps[6].status = 'done';

    // Step 8: Download
    steps.push({ step: 'Downloading Zoom...', status: 'running', progress: 0 });
    event.sender.send('reset-progress', { steps });
    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }
    await downloadFile(ZOOM_INSTALLER_URL, ZOOM_INSTALLER_PATH, (progress) => {
      steps[7].progress = progress;
      event.sender.send('reset-progress', { steps });
    });
    steps[7].status = 'done';

    // Step 9: Install
    steps.push({ step: 'Installing Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await installZoom(ZOOM_INSTALLER_PATH);
    await new Promise(r => setTimeout(r, 3000));
    steps[8].status = 'done';

    // Step 10: Cleanup
    steps.push({ step: 'Cleaning up...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }
    steps[9].status = 'done';

    // Step 11: Launch Zoom
    steps.push({ step: 'Launching Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await launchZoom();
    await new Promise(r => setTimeout(r, 2000));
    steps[10].status = 'done';

    event.sender.send('reset-progress', { steps, complete: true });

    // Close app after successful reset
    setTimeout(() => {
      app.quit();
    }, 3000);

    return {
      success: true,
      message: 'Zoom has been reset, reinstalled, and launched!'
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

// Check if Zoom is installed
ipcMain.handle('check-zoom-installed', async () => {
  const zoomPaths = [
    'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
    'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe',
    path.join(process.env.APPDATA || '', 'Zoom', 'bin', 'Zoom.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Zoom', 'bin', 'Zoom.exe')
  ];

  for (const zoomPath of zoomPaths) {
    if (fs.existsSync(zoomPath)) {
      return true;
    }
  }
  return false;
});

// Install Zoom only (no reset)
ipcMain.handle('install-zoom-only', async (event) => {
  const steps = [];

  try {
    // Step 1: Download
    steps.push({ step: 'Downloading Zoom...', status: 'running', progress: 0 });
    event.sender.send('reset-progress', { steps });

    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }

    await downloadFile(ZOOM_INSTALLER_URL, ZOOM_INSTALLER_PATH, (progress) => {
      steps[0].progress = progress;
      event.sender.send('reset-progress', { steps });
    });
    steps[0].status = 'done';

    // Step 2: Install
    steps.push({ step: 'Installing Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await installZoom(ZOOM_INSTALLER_PATH);
    await new Promise(r => setTimeout(r, 3000));
    steps[1].status = 'done';

    // Step 3: Cleanup
    steps.push({ step: 'Cleaning up...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    if (fs.existsSync(ZOOM_INSTALLER_PATH)) {
      fs.unlinkSync(ZOOM_INSTALLER_PATH);
    }
    steps[2].status = 'done';

    // Step 4: Launch
    steps.push({ step: 'Launching Zoom...', status: 'running' });
    event.sender.send('reset-progress', { steps });
    await launchZoom();
    await new Promise(r => setTimeout(r, 2000));
    steps[3].status = 'done';

    event.sender.send('reset-progress', { steps, complete: true });

    // Close app after install
    setTimeout(() => {
      app.quit();
    }, 3000);

    return {
      success: true,
      message: 'Zoom installed and launched!'
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
});
