const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const config = require('./src/main/config');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const FIX_USER = 'user1';
const FIX_PASS = 'user1';
const ZOOM_PATH = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';

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

  autoUpdater.on('update-downloaded', () => {
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true);
    }, 2000);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.ico');
}

function runProcess(exe, args, onLine) {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const child = spawn(exe, args, { windowsHide: true });
    const emit = (buf, kind) => {
      const text = buf.toString();
      if (kind === 'err') stderrBuf += text; else stdoutBuf += text;
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed) onLine(trimmed, kind);
      });
    };
    child.stdout.on('data', d => emit(d, 'out'));
    child.stderr.on('data', d => emit(d, 'err'));
    child.on('error', err => {
      onLine(`Failed to launch ${exe}: ${err.message}`, 'err');
      resolve({ code: -1, stdout: stdoutBuf, stderr: stderrBuf });
    });
    child.on('close', code => resolve({ code, stdout: stdoutBuf, stderr: stderrBuf }));
  });
}

function userExists(username) {
  return new Promise(resolve => {
    const child = spawn('net.exe', ['user', username], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

ipcMain.handle('run-fix', async (event) => {
  const send = (line, kind = 'out') => event.sender.send('fix-log', { line, kind });
  const noop = () => {};

  const exists = await userExists(FIX_USER);
  if (exists) {
    send(`[1/3] User '${FIX_USER}' exists — resetting password...`, 'header');
    const r = await runProcess('net.exe', ['user', FIX_USER, FIX_PASS], send);
    if (r.code !== 0) {
      send('ERROR: Failed to reset password.', 'err');
      return { success: false, error: 'set_password_failed' };
    }
  } else {
    send(`[1/3] Creating user '${FIX_USER}'...`, 'header');
    const r = await runProcess('net.exe', ['user', FIX_USER, FIX_PASS, '/add'], send);
    if (r.code !== 0) {
      send('ERROR: Failed to create user.', 'err');
      return { success: false, error: 'create_user_failed' };
    }
  }

  send(`[2/3] Ensuring '${FIX_USER}' is in Administrators...`, 'header');
  const memberCheck = await runProcess('net.exe', ['localgroup', 'administrators'], noop);
  const inAdmins = new RegExp(`(^|\\s)${FIX_USER}(\\s|$)`, 'mi').test(memberCheck.stdout);
  if (inAdmins) {
    send(`'${FIX_USER}' is already in Administrators.`, 'out');
  } else {
    const r = await runProcess('net.exe', ['localgroup', 'administrators', FIX_USER, '/add'], send);
    if (r.code !== 0) {
      send('ERROR: Failed to add to administrators.', 'err');
      return { success: false, error: 'add_admin_failed' };
    }
  }

  send(`[3/3] Launching Zoom as ${FIX_USER}...`, 'header');
  if (!fs.existsSync(ZOOM_PATH)) {
    send(`ERROR: Zoom not found at ${ZOOM_PATH}`, 'err');
    return { success: false, error: 'zoom_not_found' };
  }

  const psLaunch =
    `$p = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force; ` +
    `$c = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $p); ` +
    `Start-Process -FilePath '${ZOOM_PATH}' -Credential $c`;
  const launch = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psLaunch],
    send
  );
  if (launch.code !== 0) {
    send('ERROR: Failed to launch Zoom as user1.', 'err');
    return { success: false, error: 'launch_failed' };
  }

  send('Done. Zoom should appear momentarily.', 'success');
  return { success: true };
});

ipcMain.handle('create-shortcut', async () => {
  const desktop = path.join(os.homedir(), 'Desktop');
  const shortcutPath = path.join(desktop, `Launch Zoom as ${FIX_USER}.lnk`);
  const iconPath = getIconPath();

  const scriptDir = path.join(app.getPath('appData'), '1132 Fixer');
  const scriptPath = path.join(scriptDir, `launch-zoom-as-${FIX_USER}.ps1`);
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptContent =
      `$p = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force\r\n` +
      `$c = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $p)\r\n` +
      `Start-Process -FilePath '${ZOOM_PATH}' -Credential $c\r\n`;
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  } catch (err) {
    return { success: false, error: `Failed to write launcher script: ${err.message}` };
  }

  const escape = s => s.replace(/'/g, "''");
  const ps = [
    "$s = New-Object -ComObject WScript.Shell",
    `$sc = $s.CreateShortcut('${escape(shortcutPath)}')`,
    "$sc.TargetPath = 'powershell.exe'",
    `$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"${escape(scriptPath)}\"'`,
    `$sc.IconLocation = '${escape(iconPath)}'`,
    `$sc.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')`,
    `$sc.Description = 'Launch Zoom as ${FIX_USER}'`,
    "$sc.Save()"
  ].join('; ');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => resolve({ success: false, error: err.message }));
    child.on('close', code => {
      if (code === 0) resolve({ success: true, path: shortcutPath });
      else resolve({ success: false, error: stderr.trim() || `Exit ${code}` });
    });
  });
});

ipcMain.handle('show-shortcut-prompt', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Yes, create shortcut', 'No thanks'],
    defaultId: 0,
    cancelId: 1,
    title: 'Create Desktop Shortcut',
    message: `Place a "Launch Zoom as ${FIX_USER}" shortcut on your desktop?`,
    detail: `One-click re-launch of Zoom as ${FIX_USER}. Windows may ask for the ${FIX_USER} password the first time (saved for later).`
  });
  return result.response === 0;
});

ipcMain.handle('show-fix-confirm', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Confirm Fix',
    message: 'This fix creates a new Windows user on your computer and launches Zoom Workplace as that user.',
    detail:
      `Username: ${FIX_USER}\n` +
      `Password: ${FIX_PASS}\n\n` +
      'The user will be added to the local Administrators group. ' +
      'Windows may ask for permission before continuing.'
  });
  return result.response === 0;
});

ipcMain.handle('is-elevated', async () => {
  return new Promise(resolve => {
    const child = spawn('net.exe', ['session'], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-system-info', () => {
  return {
    version: app.getVersion(),
    os: `Windows ${os.release()}`,
    admin: true
  };
});

ipcMain.handle('submit-feedback', async (event, type, text) => {
  try {
    const version = app.getVersion();
    const title = `[${type}] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`;
    const body = `**Type:** ${type}\n**App Version:** ${version}\n**OS:** Windows ${os.release()}\n\n---\n\n${text}`;

    const token = config.GH_ISSUES_TOKEN;
    if (!token) {
      return { success: false, error: 'Feedback service not configured' };
    }

    const label = type === 'User Rating' ? 'user-rating' : type.toLowerCase().replace(' ', '-');
    const postData = JSON.stringify({ title, body, labels: [label] });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${config.GH_ISSUES_REPO}/issues`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `1132Fixer/${version}`,
          'Accept': 'application/vnd.github+json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 201) resolve({ success: true });
          else resolve({ success: false, error: 'Submission failed' });
        });
      });
      req.on('error', () => resolve({ success: false, error: 'Network error' }));
      req.write(postData);
      req.end();
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});
