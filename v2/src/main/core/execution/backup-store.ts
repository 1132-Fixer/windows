/**
 * Backup Store Implementation
 *
 * Manages quarantine and backup files created during plan execution.
 * Provides operations for saving, loading, and restoring backups.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { StepBackup, StepBackupStore } from './types';
import { getAppDataPath, DATA_PATHS } from '../../../shared/branding';

/**
 * Backup manifest that tracks all backups for a plan execution
 */
export interface BackupManifest {
  planId: string;
  productId: string;
  executionId: string;
  createdAt: number;
  backups: Map<string, StepBackup>;
}

/**
 * Configuration for the backup store
 */
export interface BackupStoreConfig {
  /**
   * Base path for quarantine folder
   * Default: %LOCALAPPDATA%\CleanStateSentinel\quarantine
   */
  quarantineBasePath: string;

  /**
   * Maximum age in days before auto-cleanup
   * Default: 30
   */
  maxAgeDays: number;

  /**
   * Maximum total size in bytes for quarantine folder
   * Default: 1GB
   */
  maxTotalSize: number;
}

/**
 * Default configuration
 */
export const DEFAULT_BACKUP_CONFIG: BackupStoreConfig = {
  quarantineBasePath: path.join(getAppDataPath(), DATA_PATHS.QUARANTINE),
  maxAgeDays: 30,
  maxTotalSize: 1024 * 1024 * 1024, // 1GB
};

/**
 * Expand environment variables in a path
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Generate a unique execution ID
 */
function generateExecutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `${timestamp}-${random}`;
}

/**
 * Create a backup store for a specific plan execution
 */
export function createBackupStore(
  planId: string,
  productId: string,
  config: Partial<BackupStoreConfig> = {},
): StepBackupStore {
  const fullConfig: BackupStoreConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...config,
  };

  const executionId = generateExecutionId();
  const backups = new Map<string, StepBackup>();

  const basePath = expandEnvVars(fullConfig.quarantineBasePath);
  const executionPath = path.join(basePath, productId, planId, executionId);

  return {
    getQuarantinePath(planId: string, stepId: string): string {
      const timestamp = Date.now();
      return path.join(executionPath, `${stepId}_${timestamp}`);
    },

    async save(stepId: string, backup: StepBackup): Promise<void> {
      backups.set(stepId, backup);

      // Save manifest
      const manifestPath = path.join(executionPath, 'manifest.json');
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });

      const manifest = {
        planId,
        productId,
        executionId,
        createdAt: Date.now(),
        backups: Object.fromEntries(backups),
      };

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },

    async get(stepId: string): Promise<StepBackup | null> {
      return backups.get(stepId) || null;
    },

    async list(): Promise<StepBackup[]> {
      return Array.from(backups.values());
    },
  };
}

/**
 * In-memory backup store for testing
 */
export function createInMemoryBackupStore(): StepBackupStore {
  const backups = new Map<string, StepBackup>();
  let pathCounter = 0;

  return {
    getQuarantinePath(_planId: string, stepId: string): string {
      pathCounter++;
      return `/mock/quarantine/${stepId}_${pathCounter}`;
    },

    async save(stepId: string, backup: StepBackup): Promise<void> {
      backups.set(stepId, backup);
    },

    async get(stepId: string): Promise<StepBackup | null> {
      return backups.get(stepId) || null;
    },

    async list(): Promise<StepBackup[]> {
      return Array.from(backups.values());
    },
  };
}

/**
 * Load a backup manifest from disk
 */
export async function loadBackupManifest(
  manifestPath: string,
): Promise<BackupManifest | null> {
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const data = JSON.parse(content);

    return {
      planId: data.planId,
      productId: data.productId,
      executionId: data.executionId,
      createdAt: data.createdAt,
      backups: new Map(Object.entries(data.backups)),
    };
  } catch {
    return null;
  }
}

/**
 * List all backup manifests for a product
 */
export async function listBackupManifests(
  productId: string,
  config: Partial<BackupStoreConfig> = {},
): Promise<string[]> {
  const fullConfig: BackupStoreConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...config,
  };

  const basePath = expandEnvVars(fullConfig.quarantineBasePath);
  const productPath = path.join(basePath, productId);

  try {
    const manifests: string[] = [];

    const plans = await fs.readdir(productPath);
    for (const plan of plans) {
      const planPath = path.join(productPath, plan);
      const executions = await fs.readdir(planPath);

      for (const exec of executions) {
        const manifestPath = path.join(planPath, exec, 'manifest.json');
        try {
          await fs.access(manifestPath);
          manifests.push(manifestPath);
        } catch {
          // No manifest
        }
      }
    }

    return manifests;
  } catch {
    return [];
  }
}

/**
 * Clean up old backups based on age
 */
export async function cleanupOldBackups(
  config: Partial<BackupStoreConfig> = {},
): Promise<{ removed: number; freedBytes: number }> {
  const fullConfig: BackupStoreConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...config,
  };

  const basePath = expandEnvVars(fullConfig.quarantineBasePath);
  const cutoffTime = Date.now() - fullConfig.maxAgeDays * 24 * 60 * 60 * 1000;

  let removed = 0;
  let freedBytes = 0;

  try {
    const products = await fs.readdir(basePath);

    for (const product of products) {
      const productPath = path.join(basePath, product);
      const plans = await fs.readdir(productPath);

      for (const plan of plans) {
        const planPath = path.join(productPath, plan);
        const executions = await fs.readdir(planPath);

        for (const exec of executions) {
          const execPath = path.join(planPath, exec);
          const manifestPath = path.join(execPath, 'manifest.json');

          try {
            const manifest = await loadBackupManifest(manifestPath);
            if (manifest && manifest.createdAt < cutoffTime) {
              // Calculate size before removal
              const size = await calculateDirSize(execPath);
              freedBytes += size;

              // Remove the execution directory
              await fs.rm(execPath, { recursive: true, force: true });
              removed++;
            }
          } catch {
            // Skip invalid entries
          }
        }
      }
    }
  } catch {
    // Quarantine folder doesn't exist
  }

  return { removed, freedBytes };
}

/**
 * Calculate total size of a directory
 */
async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await calculateDirSize(entryPath);
      } else {
        const stat = await fs.stat(entryPath);
        totalSize += stat.size;
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize;
}
