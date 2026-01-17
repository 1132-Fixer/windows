/**
 * Data Migration Module
 *
 * Handles migration from legacy 1132-Remover data paths to CleanState Sentinel.
 * Preserves sessions, reports, and monitoring baselines.
 *
 * POLICY:
 * - Detection is automatic on startup
 * - Migration requires user consent
 * - Old directory is never auto-deleted
 * - Only session data is migrated (not configs)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Constants
// ============================================================================

/**
 * Legacy app data directory name
 */
export const LEGACY_APP_NAME = '1132-Remover';

/**
 * New app data directory name
 */
export const NEW_APP_NAME = 'CleanStateSentinel';

/**
 * Subdirectories to migrate
 */
export const MIGRATABLE_DIRS = [
  'sessions',
  'reports',
  'monitoring',
  'quarantine',
] as const;

/**
 * Files to migrate from root
 */
export const MIGRATABLE_FILES = [
  'monitoring-baseline.json',
  'post-reboot-context.json',
] as const;

// ============================================================================
// Types
// ============================================================================

export interface MigrationStatus {
  /**
   * Whether legacy data exists
   */
  legacyDataExists: boolean;

  /**
   * Legacy data path
   */
  legacyPath: string;

  /**
   * New data path
   */
  newPath: string;

  /**
   * Whether migration has already been done
   */
  alreadyMigrated: boolean;

  /**
   * Items available for migration
   */
  itemsToMigrate: {
    directories: string[];
    files: string[];
    totalSessions: number;
    totalReports: number;
  };
}

export interface MigrationResult {
  /**
   * Whether migration succeeded
   */
  success: boolean;

  /**
   * Items migrated
   */
  migrated: {
    directories: string[];
    files: string[];
    sessionCount: number;
    reportCount: number;
  };

  /**
   * Errors encountered (non-fatal)
   */
  errors: string[];

  /**
   * Warning messages
   */
  warnings: string[];
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get the legacy app data directory
 */
export function getLegacyAppDataPath(): string {
  const localAppData = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, LEGACY_APP_NAME);
}

/**
 * Get the new app data directory
 */
export function getNewAppDataPath(): string {
  const localAppData = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, NEW_APP_NAME);
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if legacy data exists and needs migration
 */
export async function detectLegacyData(): Promise<MigrationStatus> {
  const legacyPath = getLegacyAppDataPath();
  const newPath = getNewAppDataPath();

  const status: MigrationStatus = {
    legacyDataExists: false,
    legacyPath,
    newPath,
    alreadyMigrated: false,
    itemsToMigrate: {
      directories: [],
      files: [],
      totalSessions: 0,
      totalReports: 0,
    },
  };

  try {
    // Check if legacy directory exists
    await fs.access(legacyPath);
    status.legacyDataExists = true;
  } catch {
    // Legacy directory doesn't exist
    return status;
  }

  // Check if migration marker exists in new directory
  try {
    await fs.access(path.join(newPath, '.migrated-from-1132'));
    status.alreadyMigrated = true;
    return status;
  } catch {
    // No migration marker - check what can be migrated
  }

  // Scan for migratable directories
  for (const dir of MIGRATABLE_DIRS) {
    const dirPath = path.join(legacyPath, dir);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        status.itemsToMigrate.directories.push(dir);

        // Count sessions and reports
        if (dir === 'sessions') {
          const files = await fs.readdir(dirPath);
          status.itemsToMigrate.totalSessions = files.filter(
            (f) => f.endsWith('.json'),
          ).length;
        } else if (dir === 'reports') {
          const files = await fs.readdir(dirPath);
          status.itemsToMigrate.totalReports = files.filter(
            (f) => f.endsWith('.json'),
          ).length;
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Scan for migratable files
  for (const file of MIGRATABLE_FILES) {
    const filePath = path.join(legacyPath, file);
    try {
      await fs.access(filePath);
      status.itemsToMigrate.files.push(file);
    } catch {
      // File doesn't exist
    }
  }

  return status;
}

// ============================================================================
// Migration
// ============================================================================

/**
 * Migrate data from legacy path to new path
 */
export async function migrateData(
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migrated: {
      directories: [],
      files: [],
      sessionCount: 0,
      reportCount: 0,
    },
    errors: [],
    warnings: [],
  };

  const status = await detectLegacyData();

  if (!status.legacyDataExists) {
    result.warnings.push('No legacy data found');
    result.success = true;
    return result;
  }

  if (status.alreadyMigrated) {
    result.warnings.push('Migration already completed');
    result.success = true;
    return result;
  }

  const { legacyPath, newPath } = status;

  try {
    // Create new directory if needed
    if (!options.dryRun) {
      await fs.mkdir(newPath, { recursive: true });
    }

    // Migrate directories
    for (const dir of status.itemsToMigrate.directories) {
      const srcDir = path.join(legacyPath, dir);
      const destDir = path.join(newPath, dir);

      try {
        if (!options.dryRun) {
          await copyDirectory(srcDir, destDir);
        }
        result.migrated.directories.push(dir);

        // Count migrated items
        if (dir === 'sessions') {
          const files = await fs.readdir(srcDir);
          result.migrated.sessionCount = files.filter(
            (f) => f.endsWith('.json'),
          ).length;
        } else if (dir === 'reports') {
          const files = await fs.readdir(srcDir);
          result.migrated.reportCount = files.filter(
            (f) => f.endsWith('.json'),
          ).length;
        }
      } catch (error) {
        result.errors.push(
          `Failed to migrate ${dir}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    // Migrate files
    for (const file of status.itemsToMigrate.files) {
      const srcFile = path.join(legacyPath, file);
      const destFile = path.join(newPath, file);

      try {
        if (!options.dryRun) {
          await fs.copyFile(srcFile, destFile);
        }
        result.migrated.files.push(file);
      } catch (error) {
        result.errors.push(
          `Failed to migrate ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    // Create migration marker
    if (!options.dryRun) {
      const marker = {
        migratedAt: new Date().toISOString(),
        legacyPath,
        itemsMigrated: {
          directories: result.migrated.directories,
          files: result.migrated.files,
          sessions: result.migrated.sessionCount,
          reports: result.migrated.reportCount,
        },
      };
      await fs.writeFile(
        path.join(newPath, '.migrated-from-1132'),
        JSON.stringify(marker, null, 2),
      );
    }

    result.success = result.errors.length === 0;

    if (result.success) {
      result.warnings.push(
        `Legacy data preserved at: ${legacyPath}`,
        'You may manually delete the old directory after verifying migration.',
      );
    }

    return result;
  } catch (error) {
    result.errors.push(
      `Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    return result;
  }
}

/**
 * Copy a directory recursively
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ============================================================================
// Cleanup (Optional - User-Initiated Only)
// ============================================================================

/**
 * Remove legacy data directory
 * ONLY call after explicit user confirmation
 */
export async function removeLegacyData(): Promise<{ success: boolean; error?: string }> {
  const legacyPath = getLegacyAppDataPath();

  try {
    // Verify migration was completed first
    const newPath = getNewAppDataPath();
    await fs.access(path.join(newPath, '.migrated-from-1132'));
  } catch {
    return {
      success: false,
      error: 'Cannot remove legacy data - migration not completed',
    };
  }

  try {
    await fs.rm(legacyPath, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export const migration = {
  detectLegacyData,
  migrateData,
  removeLegacyData,
  getLegacyAppDataPath,
  getNewAppDataPath,
  LEGACY_APP_NAME,
  NEW_APP_NAME,
};
