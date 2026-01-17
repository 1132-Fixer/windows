/**
 * DeleteScheduledTask Step Handler
 *
 * Deletes scheduled tasks owned by the product.
 *
 * SAFETY:
 * - Validates task is within allowed task paths
 * - Requires admin privileges
 * - Captures task info before deletion
 */

import type { PlanStep } from '../../../../shared/types';
import type {
  StepHandler,
  PrecheckResult,
  ExecutionContext,
  StepBackup,
  ManifestBackup,
} from '../types';
import type { SystemAdapter } from '../adapters/system-adapter';

/**
 * Check if a task path is within allowed task paths
 */
function isTaskAllowed(
  taskPath: string,
  allowedTasks: string[],
): boolean {
  const normalizedTask = taskPath.toLowerCase();

  for (const allowed of allowedTasks) {
    const normalizedAllowed = allowed.toLowerCase();
    if (
      normalizedTask === normalizedAllowed ||
      normalizedTask.startsWith(normalizedAllowed + '\\') ||
      normalizedTask.includes(normalizedAllowed)
    ) {
      return true;
    }
  }

  return false;
}

export function createDeleteScheduledTaskHandler(system: SystemAdapter): StepHandler {
  return {
    action: 'DeleteScheduledTask',

    async precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult> {
      const taskPath = step.target;

      // Check if task exists
      const exists = await system.taskScheduler.exists(taskPath);
      if (!exists) {
        return {
          canExecute: false,
          reason: `Scheduled task "${taskPath}" does not exist`,
        };
      }

      // Validate task is within boundaries
      if (!isTaskAllowed(taskPath, ctx.plan.boundaries.allowedTasks)) {
        return {
          canExecute: false,
          reason: `Scheduled task "${taskPath}" is outside allowed boundaries`,
        };
      }

      return {
        canExecute: true,
        requiresAdmin: true, // Task scheduler operations require admin
      };
    },

    async captureBefore(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const taskPath = step.target;

      const task = await system.taskScheduler.get(taskPath);
      if (!task) {
        return { exists: false };
      }

      return {
        exists: true,
        name: task.name,
        path: task.path,
        enabled: task.enabled,
        state: task.state,
        lastRun: task.lastRun?.toISOString(),
        nextRun: task.nextRun?.toISOString(),
      };
    },

    async backup(step: PlanStep, ctx: ExecutionContext): Promise<StepBackup | null> {
      const taskPath = step.target;

      const task = await system.taskScheduler.get(taskPath);
      if (!task) {
        return null;
      }

      // Create a manifest backup with task info
      const backup: ManifestBackup = {
        type: 'manifest',
        description: `Scheduled task: ${taskPath}`,
        data: {
          name: task.name,
          path: task.path,
          enabled: task.enabled,
          state: task.state,
          lastRun: task.lastRun?.toISOString(),
          nextRun: task.nextRun?.toISOString(),
        },
        createdAt: Date.now(),
      };

      await ctx.backup.save(step.id, backup);

      return backup;
    },

    async execute(step: PlanStep, ctx: ExecutionContext): Promise<void> {
      const taskPath = step.target;

      // Re-validate at execution time (defense in depth)
      if (!isTaskAllowed(taskPath, ctx.plan.boundaries.allowedTasks)) {
        throw new Error(`Scheduled task "${taskPath}" is outside allowed boundaries`);
      }

      ctx.record({
        type: 'step_progress',
        stepId: step.id,
        message: `Deleting scheduled task "${taskPath}"`,
        timestamp: Date.now(),
      });

      await system.taskScheduler.delete(taskPath);

      ctx.record({
        type: 'log',
        level: 'info',
        message: `Deleted scheduled task "${taskPath}"`,
        timestamp: Date.now(),
      });
    },

    async captureAfter(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const taskPath = step.target;
      const exists = await system.taskScheduler.exists(taskPath);

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
