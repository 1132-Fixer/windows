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
    backgroundColor: '#0a1020',
    alwaysOnTop: true,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'icon.ico')
  });

  mainWindow.loadFile('index.html');

  mainWindow.setMenu(null);
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

// Get Zoom data paths
function getZoomDataPaths() {
  const paths = [];
  const home = os.homedir();
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;

  const candidates = [
    appData ? path.join(appData, 'Zoom', 'data') : null,
    localAppData ? path.join(localAppData, 'Zoom', 'data') : null,
    path.join(home, 'AppData', 'Roaming', 'Zoom', 'data'),
    path.join(home, 'AppData', 'Local', 'Zoom', 'data')
  ];

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

// Find all Zoom database files
function findAllZoomDbFiles(dataDirs) {
  const found = [];
  const extensions = ['.db', '.enc', '.rdb', '.kvs', '.ldb'];

  for (const dataDir of dataDirs) {
    if (!fs.existsSync(dataDir)) continue;

    try {
      const files = fs.readdirSync(dataDir);
      for (const filename of files) {
        const fullPath = path.join(dataDir, filename);

        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;

          const ext = path.extname(filename).toLowerCase();

          // Check if it matches known extensions
          if (extensions.includes(ext) && !isDangerousTempFile(filename)) {
            found.push({
              path: fullPath,
              name: filename,
              size: stat.size
            });
          }
          // Also catch extensionless files > 1KB
          else if (ext === '' && stat.size > 1000 && !isDangerousTempFile(filename)) {
            found.push({
              path: fullPath,
              name: filename,
              size: stat.size
            });
          }
        } catch (err) {
          console.error(`Error reading file ${fullPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`Error reading directory ${dataDir}:`, err);
    }
  }

  return found;
}

// Delete and replace file
function deleteAndReplace(filePath) {
  try {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    const placeholder = path.join(dir, `${baseName}.txt`);

    // Try to delete the file
    fs.unlinkSync(filePath);

    // Create placeholder
    fs.writeFileSync(placeholder, 'This file was deleted by Zoom 1132 Eliminator\n', 'utf8');

    return { success: true, message: `DELETED → ${path.basename(filePath)}` };
  } catch (err) {
    return { success: false, message: `FAILED → ${path.basename(filePath)} (${err.message})` };
  }
}

// Launch Zoom
function launchZoom() {
  try {
    spawn('cmd', ['/c', 'start', 'zoommtg://'], { shell: true, detached: true });
  } catch (err) {
    console.error('Failed to launch Zoom:', err);
  }
}

// IPC Handlers
ipcMain.handle('scan-files', async () => {
  const dataDirs = getZoomDataPaths();

  if (dataDirs.length === 0) {
    return {
      success: false,
      message: 'No Zoom data folders found. Is Zoom installed?',
      files: [],
      directories: []
    };
  }

  const files = findAllZoomDbFiles(dataDirs);

  return {
    success: true,
    files: files,
    directories: dataDirs
  };
});

ipcMain.handle('delete-files', async (event, filePaths) => {
  const results = [];
  let deletedCount = 0;

  for (const filePath of filePaths) {
    const result = deleteAndReplace(filePath);
    results.push(result);
    if (result.success) {
      deletedCount++;
    }
  }

  return {
    results: results,
    deletedCount: deletedCount
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

ipcMain.handle('show-success', async (event, count) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'Success',
    message: `${count} files eliminated!\n\nZoom will be launched.`
  });
});

ipcMain.handle('quit-app', async () => {
  app.quit();
});
