/**
 * StopProcess Step Handler
 *
 * Terminates running processes owned by the product.
 *
 * SAFETY:
 * - Only kills processes whose executable path is within product allowlist
 * - Attempts graceful shutdown first
 * - Validates ownership before termination
 */

import * as path from 'path';
import type { PlanStep } from '../../../../shared/types';
import type {
  StepHandler,
  PrecheckResult,
  ExecutionContext,
  StepBackup,
} from '../types';
import type { SystemAdapter, ProcessInfo } from '../adapters/system-adapter';

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
 * Check if a process executable path is within allowed paths
 */
function isProcessOwned(
  executablePath: string | undefined,
  allowedPaths: string[],
): boolean {
  if (!executablePath) return false;

  const normalizedExePath = normalizePath(executablePath);

  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizePath(allowed);
    if (normalizedExePath.startsWith(normalizedAllowed)) {
      return true;
    }
  }

  return false;
}

export function createStopProcessHandler(system: SystemAdapter): StepHandler {
  return {
    action: 'StopProcess',

    async precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult> {
      const processName = step.target;

      // Find processes with this name
      const processes = await system.process.getByName(processName);

      if (processes.length === 0) {
        return {
          canExecute: false,
          reason: `No processes named "${processName}" are running`,
        };
      }

      // Validate ownership - at least one must be owned
      const ownedProcesses = processes.filter(p =>
        isProcessOwned(p.executablePath, ctx.plan.boundaries.allowedPaths),
      );

      if (ownedProcesses.length === 0) {
        return {
          canExecute: false,
          reason: `No "${processName}" processes found within allowed paths`,
        };
      }

      return {
        canExecute: true,
        requiresAdmin: false, // Process termination usually doesn't require admin
      };
    },

    async captureBefore(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const processName = step.target;
      const processes = await system.process.getByName(processName);

      return {
        processes: processes.map(p => ({
          pid: p.pid,
          name: p.name,
          executablePath: p.executablePath,
          startTime: p.startTime,
        })),
        count: processes.length,
      };
    },

    async backup(_step: PlanStep, _ctx: ExecutionContext): Promise<StepBackup | null> {
      // No backup needed for process termination
      return null;
    },

    async execute(step: PlanStep, ctx: ExecutionContext): Promise<void> {
      const processName = step.target;
      const processes = await system.process.getByName(processName);

      // Filter to only owned processes
      const ownedProcesses = processes.filter(p =>
        isProcessOwned(p.executablePath, ctx.plan.boundaries.allowedPaths),
      );

      for (const proc of ownedProcesses) {
        ctx.record({
          type: 'step_progress',
          stepId: step.id,
          message: `Terminating ${proc.name} (PID ${proc.pid})`,
          timestamp: Date.now(),
        });

        // Try graceful shutdown first
        if (ctx.options.gracefulProcessShutdown) {
          const graceful = await system.process.terminateGracefully(
            proc.pid,
            ctx.timeouts.gracefulShutdownMs,
          );

          if (graceful) {
            ctx.record({
              type: 'log',
              level: 'info',
              message: `Process ${proc.name} (PID ${proc.pid}) terminated gracefully`,
              timestamp: Date.now(),
            });
            continue;
          }
        }

        // Force terminate
        await system.process.terminateForce(proc.pid);
        ctx.record({
          type: 'log',
          level: 'info',
          message: `Process ${proc.name} (PID ${proc.pid}) force terminated`,
          timestamp: Date.now(),
        });
      }
    },

    async captureAfter(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const processName = step.target;
      const processes = await system.process.getByName(processName);

      return {
        processes: processes.map(p => ({
          pid: p.pid,
          name: p.name,
          executablePath: p.executablePath,
        })),
        count: processes.length,
      };
    },

    async verify(
      step: PlanStep,
      _before: Record<string, unknown>,
      after: Record<string, unknown>,
      ctx: ExecutionContext,
    ): Promise<boolean> {
      const processes = after.processes as Array<{ executablePath?: string }>;

      // Verify no owned processes remain
      const ownedRemaining = processes.filter(p =>
        isProcessOwned(p.executablePath, ctx.plan.boundaries.allowedPaths),
      );

      return ownedRemaining.length === 0;
    },
  };
}
