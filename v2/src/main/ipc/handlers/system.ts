/**
 * System IPC Handlers
 *
 * Handles system operations: get info, check admin, log paths, migration.
 */

import { ipcMain, shell, app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS, type SystemInfo, type ProductInfo } from '../channels';
import { getAppDataPath, DATA_PATHS } from '../../../shared/branding';
import {
  detectLegacyData,
  migrateData,
  removeLegacyData,
  type MigrationStatus,
  type MigrationResult,
} from '../../core/migration';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if running as administrator
 */
async function isAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    // Try to access a path that requires admin
    const { execSync } = await import('child_process');
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get log directory
 */
function getLogDir(): string {
  return path.join(getAppDataPath(), DATA_PATHS.LOGS);
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Get system info
 */
async function handleSystemGetInfo(): Promise<SystemInfo> {
  const elevated = await isAdmin();

  return {
    osVersion: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    elevated,
    appVersion: app.getVersion(),
    username: os.userInfo().username,
    hostname: os.hostname(),
  };
}

/**
 * Check admin privileges
 */
async function handleSystemCheckAdmin(): Promise<{ elevated: boolean }> {
  return { elevated: await isAdmin() };
}

/**
 * Get log path
 */
async function handleSystemGetLogPath(): Promise<{ path: string }> {
  return { path: getLogDir() };
}

/**
 * Open log folder
 */
async function handleSystemOpenLogFolder(): Promise<{ success: boolean; error?: string }> {
  try {
    const logDir = getLogDir();
    await shell.openPath(logDir);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to open folder',
    };
  }
}

/**
 * List available products
 */
async function handleProductList(): Promise<ProductInfo[]> {
  // For now, return hardcoded Zoom product
  // In real implementation, would load from product definitions
  return [
    {
      id: 'zoom',
      name: 'Zoom',
      vendor: 'Zoom Video Communications',
      description: 'Video conferencing application',
      version: '1.0.0',
    },
  ];
}

/**
 * Get product details
 */
async function handleProductGet(
  _event: Electron.IpcMainInvokeEvent,
  productId: string,
): Promise<ProductInfo | null> {
  const products = await handleProductList();
  return products.find((p) => p.id === productId) || null;
}

// ============================================================================
// Migration Handlers
// ============================================================================

/**
 * Check for legacy data migration
 */
async function handleMigrationCheck(): Promise<MigrationStatus> {
  return detectLegacyData();
}

/**
 * Execute migration
 */
async function handleMigrationRun(
  _event: Electron.IpcMainInvokeEvent,
  options?: { dryRun?: boolean },
): Promise<MigrationResult> {
  return migrateData(options);
}

/**
 * Remove legacy data after migration
 */
async function handleMigrationCleanup(): Promise<{ success: boolean; error?: string }> {
  return removeLegacyData();
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all system IPC handlers
 */
export function registerSystemHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_INFO, handleSystemGetInfo);
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CHECK_ADMIN, handleSystemCheckAdmin);
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_LOG_PATH, handleSystemGetLogPath);
  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_LOG_FOLDER, handleSystemOpenLogFolder);
  ipcMain.handle(IPC_CHANNELS.PRODUCT_LIST, handleProductList);
  ipcMain.handle(IPC_CHANNELS.PRODUCT_GET, handleProductGet);

  // Migration handlers
  ipcMain.handle('migration.check', handleMigrationCheck);
  ipcMain.handle('migration.run', handleMigrationRun);
  ipcMain.handle('migration.cleanup', handleMigrationCleanup);
}
