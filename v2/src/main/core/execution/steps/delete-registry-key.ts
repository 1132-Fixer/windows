/**
 * DeleteRegistryKey Step Handler
 *
 * Deletes registry keys owned by the product.
 *
 * SAFETY:
 * - Exports key to backup before deletion
 * - Validates key is within allowed prefixes
 * - Policy enforcement at runtime
 */

import * as path from 'path';
import * as crypto from 'crypto';
import type { PlanStep } from '../../../../shared/types';
import type {
  StepHandler,
  PrecheckResult,
  ExecutionContext,
  StepBackup,
  RegistryExportBackup,
} from '../types';
import type { SystemAdapter } from '../adapters/system-adapter';

/**
 * Check if a registry path is within allowed prefixes
 */
function isRegistryPathAllowed(
  keyPath: string,
  allowedPrefixes: string[],
): boolean {
  const normalizedKey = keyPath.toLowerCase();

  for (const allowed of allowedPrefixes) {
    const normalizedAllowed = allowed.toLowerCase();
    if (
      normalizedKey === normalizedAllowed ||
      normalizedKey.startsWith(normalizedAllowed + '\\')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a unique backup file path
 */
function generateBackupPath(
  basePath: string,
  planId: string,
  stepId: string,
  keyPath: string,
): string {
  const timestamp = Date.now();
  const hash = crypto.createHash('md5').update(keyPath).digest('hex').slice(0, 8);
  const keyName = keyPath.split('\\').pop() || 'key';

  return path.join(
    basePath,
    planId,
    `${stepId}_${timestamp}_${hash}_${keyName}.reg`,
  );
}

export function createDeleteRegistryKeyHandler(system: SystemAdapter): StepHandler {
  return {
    action: 'DeleteRegistryKey',

    async precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult> {
      const keyPath = step.target;

      // Check if key exists
      const exists = await system.registry.keyExists(keyPath);
      if (!exists) {
        return {
          canExecute: false,
          reason: `Registry key "${keyPath}" does not exist`,
        };
      }

      // Validate key is within boundaries
      if (!isRegistryPathAllowed(keyPath, ctx.plan.boundaries.allowedRegistryPrefixes)) {
        return {
          canExecute: false,
          reason: `Registry key "${keyPath}" is outside allowed boundaries`,
        };
      }

      // Policy check
      try {
        ctx.policy.assertAllowedRegistryKey(keyPath, ctx.plan);
      } catch (error) {
        return {
          canExecute: false,
          reason: `Policy violation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }

      // HKLM keys typically require admin
      const requiresAdmin = keyPath.toUpperCase().startsWith('HKLM') ||
        keyPath.toUpperCase().startsWith('HKEY_LOCAL_MACHINE');

      return {
        canExecute: true,
        requiresAdmin,
      };
    },

    async captureBefore(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const keyPath = step.target;

      const exists = await system.registry.keyExists(keyPath);
      if (!exists) {
        return { exists: false };
      }

      const values = await system.registry.getValues(keyPath);
      const subkeys = await system.registry.getSubkeys(keyPath);

      return {
        exists: true,
        keyPath,
        valueCount: Object.keys(values).length,
        subkeyCount: subkeys.length,
        values: Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, { type: v.type, data: v.data }]),
        ),
        subkeys,
      };
    },

    async backup(step: PlanStep, ctx: ExecutionContext): Promise<StepBackup | null> {
      const keyPath = step.target;

      // Generate backup path
      const quarantineBase = ctx.backup.getQuarantinePath(ctx.plan.id, step.id);
      const backupPath = path.join(path.dirname(quarantineBase), `${step.id}_registry.reg`);

      // Export the key
      await system.registry.exportKey(keyPath, backupPath);

      const backup: RegistryExportBackup = {
        type: 'reg-export',
        keyPath,
        filePath: backupPath,
        exportedAt: Date.now(),
      };

      await ctx.backup.save(step.id, backup);

      return backup;
    },

    async execute(step: PlanStep, ctx: ExecutionContext): Promise<void> {
      const keyPath = step.target;

      // Re-validate at execution time (defense in depth)
      if (!isRegistryPathAllowed(keyPath, ctx.plan.boundaries.allowedRegistryPrefixes)) {
        throw new Error(`Registry key "${keyPath}" is outside allowed boundaries`);
      }

      ctx.policy.assertAllowedRegistryKey(keyPath, ctx.plan);

      ctx.record({
        type: 'step_progress',
        stepId: step.id,
        message: `Deleting registry key "${keyPath}"`,
        timestamp: Date.now(),
      });

      await system.registry.deleteKey(keyPath);

      ctx.record({
        type: 'log',
        level: 'info',
        message: `Deleted registry key "${keyPath}"`,
        timestamp: Date.now(),
      });
    },

    async captureAfter(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const keyPath = step.target;
      const exists = await system.registry.keyExists(keyPath);

      return {
        exists,
        deleted: !exists,
      };
    },

    async verify(
      _step: PlanStep,
      _before: Record<string, unknown>,
      after: Record<string, unknown>,
      _ctx: ExecutionContext,
    ): Promise<boolean> {
      return after.deleted === true;
    },
  };
}
