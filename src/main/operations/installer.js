/**
 * 1132 Remover - Zoom Installer
 * Downloads and installs fresh Zoom
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_INSTALLER, ZOOM_EXECUTABLE_PATHS } = require('../../shared/constants');

/**
 * Download a file from URL with progress tracking
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, size: number}>}
 */
function downloadFile(url, destPath, onProgress = null) {
  return new Promise((resolve, reject) => {
    logger.info(`Downloading: ${url}`);

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        logger.debug(`Redirecting to: ${redirectUrl}`);
        downloadFile(redirectUrl, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;

      // Ensure directory exists
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;

        if (onProgress && totalSize > 0) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          onProgress({
            step: 'download',
            percent,
            downloaded: downloadedSize,
            total: totalSize,
            message: `Downloading: ${percent}%`
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        logger.ok(`Download complete: ${path.basename(destPath)} (${formatBytes(downloadedSize)})`);
        resolve({ success: true, size: downloadedSize });
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    // Timeout
    request.setTimeout(ZOOM_INSTALLER.timeout, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Download fresh Zoom installer
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, path: string}>}
 */
async function downloadZoomInstaller(onProgress = null) {
  logger.section('Downloading Zoom Installer');

  const destPath = ZOOM_INSTALLER.downloadPath;

  // Clean up old installer if exists
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }

  try {
    await downloadFile(ZOOM_INSTALLER.url, destPath, onProgress);

    // Verify file exists and has content
    if (!fs.existsSync(destPath)) {
      throw new Error('Downloaded file not found');
    }

    const stats = fs.statSync(destPath);
    if (stats.size < 1000000) { // MSI should be at least 1MB
      throw new Error('Downloaded file too small, may be corrupted');
    }

    logger.ok(`Zoom installer ready: ${destPath}`);
    return { success: true, path: destPath };
  } catch (e) {
    logger.error('Failed to download Zoom installer', { error: e.message });

    // Try fallback URL
    logger.info('Trying fallback URL...');
    try {
      const fallbackDest = destPath.replace('.msi', '.exe');
      await downloadFile(ZOOM_INSTALLER.fallbackUrl, fallbackDest, onProgress);
      return { success: true, path: fallbackDest };
    } catch (e2) {
      logger.error('Fallback download also failed', { error: e2.message });
      return { success: false, error: e.message };
    }
  }
}

/**
 * Install Zoom from MSI
 * @param {string} installerPath - Path to installer
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean}>}
 */
async function installZoom(installerPath, onProgress = null) {
  logger.section('Installing Zoom');

  if (!fs.existsSync(installerPath)) {
    logger.error('Installer not found', { path: installerPath });
    return { success: false, error: 'Installer not found' };
  }

  if (onProgress) {
    onProgress({
      step: 'install',
      message: 'Installing Zoom (please wait)...'
    });
  }

  try {
    // Determine install method based on file type
    const ext = path.extname(installerPath).toLowerCase();

    if (ext === '.msi') {
      // MSI silent install
      logger.info('Running MSI installer...');
      const result = await spawnSafe('msiexec', [
        '/i', installerPath,
        '/qn',
        '/norestart',
        'ALLUSERS=1'
      ], { timeout: 300000 }); // 5 min timeout

      if (result.exitCode !== 0) {
        throw new Error(`MSI install failed with exit code ${result.exitCode}`);
      }
    } else {
      // EXE silent install
      logger.info('Running EXE installer...');
      const result = await spawnSafe(installerPath, ['/silent', '/install'], {
        timeout: 300000
      });

      if (result.exitCode !== 0) {
        throw new Error(`EXE install failed with exit code ${result.exitCode}`);
      }
    }

    // Wait for installation to complete
    await new Promise(r => setTimeout(r, 5000));

    // Verify installation
    const installed = await isZoomInstalled();
    if (installed.success) {
      logger.ok('Zoom installed successfully', { path: installed.path });
      return { success: true, zoomPath: installed.path };
    } else {
      throw new Error('Installation verification failed');
    }
  } catch (e) {
    logger.error('Zoom installation failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Check if Zoom is installed and find executable path
 * @returns {Promise<{success: boolean, path?: string}>}
 */
async function isZoomInstalled() {
  for (const p of ZOOM_EXECUTABLE_PATHS) {
    if (fs.existsSync(p)) {
      return { success: true, path: p };
    }
  }

  return { success: false };
}

/**
 * Launch Zoom
 * @returns {Promise<{success: boolean, path?: string}>}
 */
async function launchZoom() {
  logger.info('Launching Zoom...');

  const installed = await isZoomInstalled();
  if (!installed.success) {
    logger.error('Zoom not found');
    return { success: false, error: 'Zoom not installed' };
  }

  try {
    // Use start command to launch detached
    await runPowerShell(`Start-Process "${installed.path}"`, { timeout: 10000 });
    logger.ok('Zoom launched', { path: installed.path });
    return { success: true, path: installed.path };
  } catch (e) {
    logger.error('Failed to launch Zoom', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Clean up installer file
 * @param {string} installerPath - Path to installer
 */
function cleanupInstaller(installerPath) {
  if (installerPath && fs.existsSync(installerPath)) {
    try {
      fs.unlinkSync(installerPath);
      logger.debug('Cleaned up installer file');
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Format bytes to human readable string
 * @param {number} bytes - Bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  downloadFile,
  downloadZoomInstaller,
  installZoom,
  isZoomInstalled,
  launchZoom,
  cleanupInstaller
};
