/**
 * RemoveFolder Step Handler
 *
 * Removes folders/files owned by the product.
 *
 * SAFETY:
 * - Quarantine-by-default (move to quarantine folder instead of delete)
 * - Validates path is within allowed boundaries
 * - Creates detailed manifest of removed items
 */

import * as path from 'path';
import * as crypto from 'crypto';
import type { PlanStep } from '../../../../shared/types';
import type {
  StepHandler,
  PrecheckResult,
  ExecutionContext,
  StepBackup,
  FolderQuarantineBackup,
} from '../types';
import type { SystemAdapter } from '../adapters/system-adapter';

/**
 * Expand environment variables in a path
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Normalize path for comparison
 */
function normalizePath(inputPath: string): string {
  return path.normalize(expandEnvVars(inputPath)).toLowerCase();
}

/**
 * Check if a path is within allowed boundaries
 */
function isPathAllowed(targetPath: string, allowedPaths: string[]): boolean {
  const normalizedTarget = normalizePath(targetPath);

  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizePath(allowed);
    if (
      normalizedTarget === normalizedAllowed ||
      normalizedTarget.startsWith(normalizedAllowed + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a unique quarantine path
 */
function generateQuarantinePath(
  basePath: string,
  planId: string,
  stepId: string,
  originalPath: string,
): string {
  const timestamp = Date.now();
  const hash = crypto.createHash('md5').update(originalPath).digest('hex').slice(0, 8);
  const folderName = path.basename(originalPath);

  return path.join(
    expandEnvVars(basePath),
    planId,
    `${stepId}_${timestamp}_${hash}`,
    folderName,
  );
}

export function createRemoveFolderHandler(system: SystemAdapter): StepHandler {
  return {
    action: 'RemoveFolder',

    async precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult> {
      const targetPath = expandEnvVars(step.target);

      // Check if path exists
      const exists = await system.filesystem.exists(targetPath);
      if (!exists) {
        return {
          canExecute: false,
          reason: `Path "${targetPath}" does not exist`,
        };
      }

      // Validate path is within boundaries
      if (!isPathAllowed(targetPath, ctx.plan.boundaries.allowedPaths)) {
        return {
          canExecute: false,
          reason: `Path "${targetPath}" is outside allowed boundaries`,
        };
      }

      // Policy check
      try {
        ctx.policy.assertAllowedPath(targetPath, ctx.plan);
      } catch (error) {
        return {
          canExecute: false,
          reason: `Policy violation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }

      return {
        canExecute: true,
        requiresAdmin: true, // File deletion in Program Files usually requires admin
      };
    },

    async captureBefore(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const targetPath = expandEnvVars(step.target);

      const exists = await system.filesystem.exists(targetPath);
      if (!exists) {
        return { exists: false };
      }

      const isDir = await system.filesystem.isDirectory(targetPath);
      const size = await system.filesystem.calculateSize(targetPath);

      let fileCount = 0;
      if (isDir) {
        const contents = await system.filesystem.readdir(targetPath);
        fileCount = contents.length;
      }

      return {
        exists: true,
        path: targetPath,
        isDirectory: isDir,
        size,
        fileCount,
      };
    },

    async backup(step: PlanStep, ctx: ExecutionContext): Promise<StepBackup | null> {
      const targetPath = expandEnvVars(step.target);

      // Calculate size first
      const size = await system.filesystem.calculateSize(targetPath);

      // Generate quarantine path
      const quarantinePath = ctx.backup.getQuarantinePath(ctx.plan.id, step.id);

      // Create parent directory
      const parentDir = path.dirname(quarantinePath);
      await system.filesystem.mkdir(parentDir);

      // If quarantine is enabled, we'll do the backup during execute
      // Just return the planned backup info
      const isDir = await system.filesystem.isDirectory(targetPath);
      const fileCount = isDir
        ? (await system.filesystem.readdir(targetPath)).length
        : 1;

      const backup: FolderQuarantineBackup = {
        type: 'folder-quarantine',
        originalPath: targetPath,
        quarantinePath,
        fileCount,
        totalSize: size,
        movedAt: Date.now(),
      };

      return backup;
    },

    async execute(step: PlanStep, ctx: ExecutionContext): Promise<void> {
      const targetPath = expandEnvVars(step.target);

      // Re-validate at execution time (defense in depth)
      if (!isPathAllowed(targetPath, ctx.plan.boundaries.allowedPaths)) {
        throw new Error(`Path "${targetPath}" is outside allowed boundaries`);
      }

      ctx.policy.assertAllowedPath(targetPath, ctx.plan);

      const quarantinePath = ctx.backup.getQuarantinePath(ctx.plan.id, step.id);

      if (ctx.options.quarantineFiles) {
        // Move to quarantine
        ctx.record({
          type: 'step_progress',
          stepId: step.id,
          message: `Moving "${targetPath}" to quarantine`,
          timestamp: Date.now(),
        });

        // Create quarantine directory
        const parentDir = path.dirname(quarantinePath);
        await system.filesystem.mkdir(parentDir);

        // Move the folder
        await system.filesystem.move(targetPath, quarantinePath);

        ctx.record({
          type: 'log',
          level: 'info',
          message: `Moved "${targetPath}" to "${quarantinePath}"`,
          data: { originalPath: targetPath, quarantinePath },
          timestamp: Date.now(),
        });

        // Save backup info
        const size = await system.filesystem.calculateSize(quarantinePath);
        const isDir = await system.filesystem.isDirectory(quarantinePath);
        const fileCount = isDir
          ? (await system.filesystem.readdir(quarantinePath)).length
          : 1;

        await ctx.backup.save(step.id, {
          type: 'folder-quarantine',
          originalPath: targetPath,
          quarantinePath,
          fileCount,
          totalSize: size,
          movedAt: Date.now(),
        });
      } else {
        // Hard delete (only if quarantine disabled)
        ctx.record({
          type: 'step_progress',
          stepId: step.id,
          message: `Deleting "${targetPath}"`,
          timestamp: Date.now(),
        });

        await system.filesystem.remove(targetPath);

        ctx.record({
          type: 'log',
          level: 'info',
          message: `Deleted "${targetPath}"`,
          timestamp: Date.now(),
        });
      }
    },

    async captureAfter(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const targetPath = expandEnvVars(step.target);
      const exists = await system.filesystem.exists(targetPath);

      return {
        exists,
        removed: !exists,
      };
    },

    async verify(
      _step: PlanStep,
      _before: Record<string, unknown>,
      after: Record<string, unknown>,
      _ctx: ExecutionContext,
    ): Promise<boolean> {
      return after.removed === true;
    },
  };
}
