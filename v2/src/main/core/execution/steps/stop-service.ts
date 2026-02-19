/**
 * StopService Step Handler
 *
 * Stops Windows services owned by the product.
 *
 * SAFETY:
 * - Only stops services whose binary path is within product allowlist
 * - Validates service ownership before stopping
 * - Requires admin/elevated privileges
 */

import * as path from 'path';
import type { PlanStep } from '../../../../shared/types';
import type {
  StepHandler,
  PrecheckResult,
  ExecutionContext,
  StepBackup,
} from '../types';
import type { SystemAdapter, ServiceInfo } from '../adapters/system-adapter';

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
 * Extract executable path from service binary path
 * Handles quoted paths and arguments
 */
function extractExecutablePath(binaryPath: string): string {
  let cleaned = binaryPath.trim();

  // Handle quoted paths
  if (cleaned.startsWith('"')) {
    const endQuote = cleaned.indexOf('"', 1);
    if (endQuote > 1) {
      cleaned = cleaned.substring(1, endQuote);
    }
  } else {
    // Take first space-separated segment
    const firstSpace = cleaned.indexOf(' ');
    if (firstSpace > 0) {
      cleaned = cleaned.substring(0, firstSpace);
    }
  }

  return cleaned;
}

/**
 * Check if a service binary path is within allowed paths
 */
function isServiceOwned(
  binaryPath: string,
  allowedPaths: string[],
): boolean {
  const execPath = extractExecutablePath(binaryPath);
  const normalizedExePath = normalizePath(execPath);

  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizePath(allowed);
    if (normalizedExePath.startsWith(normalizedAllowed)) {
      return true;
    }
  }

  return false;
}

export function createStopServiceHandler(system: SystemAdapter): StepHandler {
  return {
    action: 'StopService',

    async precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult> {
      const serviceName = step.target;

      // Check if service exists
      const service = await system.service.get(serviceName);

      if (!service) {
        return {
          canExecute: false,
          reason: `Service "${serviceName}" not found`,
        };
      }

      // Validate ownership
      if (!isServiceOwned(service.binaryPath, ctx.plan.boundaries.allowedPaths)) {
        return {
          canExecute: false,
          reason: `Service "${serviceName}" binary path is outside allowed boundaries`,
        };
      }

      // Check if already stopped
      if (service.state === 'Stopped') {
        return {
          canExecute: false,
          reason: `Service "${serviceName}" is already stopped`,
        };
      }

      return {
        canExecute: true,
        requiresAdmin: true, // Stopping services requires admin
      };
    },

    async captureBefore(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const serviceName = step.target;
      const service = await system.service.get(serviceName);

      if (!service) {
        return { exists: false };
      }

      return {
        exists: true,
        name: service.name,
        displayName: service.displayName,
        state: service.state,
        startType: service.startType,
        binaryPath: service.binaryPath,
      };
    },

    async backup(_step: PlanStep, _ctx: ExecutionContext): Promise<StepBackup | null> {
      // No backup needed for stopping a service (non-destructive)
      return null;
    },

    async execute(step: PlanStep, ctx: ExecutionContext): Promise<void> {
      const serviceName = step.target;

      // Re-validate ownership at execution time (defense in depth)
      const service = await system.service.get(serviceName);
      if (!service) {
        throw new Error(`Service "${serviceName}" not found`);
      }

      if (!isServiceOwned(service.binaryPath, ctx.plan.boundaries.allowedPaths)) {
        throw new Error(`Service "${serviceName}" is not owned by the product`);
      }

      ctx.record({
        type: 'step_progress',
        stepId: step.id,
        message: `Stopping service "${serviceName}"`,
        timestamp: Date.now(),
      });

      await system.service.stop(serviceName, ctx.timeouts.serviceStopMs);

      ctx.record({
        type: 'log',
        level: 'info',
        message: `Service "${serviceName}" stopped successfully`,
        timestamp: Date.now(),
      });
    },

    async captureAfter(step: PlanStep, _ctx: ExecutionContext): Promise<Record<string, unknown>> {
      const serviceName = step.target;
      const state = await system.service.getState(serviceName);

      return {
        state,
        stopped: state === 'Stopped',
      };
    },

    async verify(
      _step: PlanStep,
      _before: Record<string, unknown>,
      after: Record<string, unknown>,
      _ctx: ExecutionContext,
    ): Promise<boolean> {
      return after.stopped === true;
    },
  };
}
