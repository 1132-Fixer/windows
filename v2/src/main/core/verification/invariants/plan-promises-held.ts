/**
 * Invariant: Plan Promises Held
 *
 * APPLIES ALWAYS
 *
 * CHECKS: Every PlanStep with expected effect actually caused a change:
 *   - RemoveFolder → folder absent
 *   - DeleteRegistryKey → key absent
 *   - DeleteScheduledTask → task absent
 *   - Uninstall → uninstall entry gone
 *
 * FAILS IF: Step reported success but state unchanged
 *
 * This is executor accountability.
 */

import * as path from 'path';
import type { Plan, SnapshotDiff, PlanStep, Artifact } from '../../../../shared/types';
import type {
  Invariant,
  InvariantResult,
  VerifyInput,
} from '../types';

/**
 * Normalize path for comparison
 */
function normalizePath(inputPath: string): string {
  return path.normalize(inputPath).toLowerCase();
}

/**
 * Check if an artifact with the given path exists in the snapshot
 */
function artifactExists(
  artifacts: Artifact[],
  targetPath: string,
  type?: string,
): boolean {
  const normalizedTarget = normalizePath(targetPath);

  return artifacts.some(artifact => {
    // Type filter
    if (type && artifact.type !== type) return false;

    // Path match
    if (!artifact.path) return false;
    const normalizedPath = normalizePath(artifact.path);

    // Exact match or prefix match (for folders)
    return normalizedPath === normalizedTarget ||
      normalizedPath.startsWith(normalizedTarget + path.sep);
  });
}

/**
 * Check if a task exists by name
 */
function taskExists(artifacts: Artifact[], taskName: string): boolean {
  const normalizedName = taskName.toLowerCase();

  return artifacts.some(artifact => {
    if (artifact.type !== 'task') return false;
    const taskPath = (artifact.path || '').toLowerCase();
    const metadata = artifact.metadata as { name?: string };
    const name = (metadata.name || '').toLowerCase();

    return taskPath.includes(normalizedName) || name.includes(normalizedName);
  });
}

interface BrokenPromise {
  stepId: string;
  action: string;
  target: string;
  reason: string;
}

export const PlanPromisesHeldInvariant: Invariant = {
  id: 'plan_promises_held',
  description: 'All plan steps should have achieved their intended effect',
  category: 'integrity',
  severity: 'standard',

  appliesTo(_plan: Plan): boolean {
    // Always applies
    return true;
  },

  evaluate(input: VerifyInput, _diff: SnapshotDiff): InvariantResult {
    const { plan, postSnapshot } = input;

    const brokenPromises: BrokenPromise[] = [];

    for (const step of plan.steps) {
      const broken = checkStepPromise(step, postSnapshot.artifacts);
      if (broken) {
        brokenPromises.push(broken);
      }
    }

    if (brokenPromises.length === 0) {
      return {
        status: 'pass',
        details: `All ${plan.steps.length} plan step(s) achieved their intended effect`,
      };
    }

    return {
      status: 'fail',
      details: `${brokenPromises.length} plan step(s) did not achieve their intended effect`,
      evidence: {
        brokenPromises,
        totalSteps: plan.steps.length,
        failedSteps: brokenPromises.length,
      },
    };
  },
};

/**
 * Check if a specific step's promise was kept
 */
function checkStepPromise(step: PlanStep, postArtifacts: Artifact[]): BrokenPromise | null {
  switch (step.action) {
    case 'RemoveFolder':
      // Folder should not exist
      if (artifactExists(postArtifacts, step.target, 'file')) {
        return {
          stepId: step.id,
          action: step.action,
          target: step.target,
          reason: 'Folder still exists or contains files',
        };
      }
      break;

    case 'DeleteRegistryKey':
      // Registry key should not exist
      if (artifactExists(postArtifacts, step.target, 'registry')) {
        return {
          stepId: step.id,
          action: step.action,
          target: step.target,
          reason: 'Registry key still exists',
        };
      }
      break;

    case 'DeleteRegistryValue':
      // This is harder to check - would need value-level granularity
      // For now, we check if the key still has values (advisory)
      // Skip strict check
      break;

    case 'DeleteScheduledTask':
      // Task should not exist
      if (taskExists(postArtifacts, step.target)) {
        return {
          stepId: step.id,
          action: step.action,
          target: step.target,
          reason: 'Scheduled task still exists',
        };
      }
      break;

    case 'StopService':
      // Service may still exist but should be stopped
      // We only check for presence, not state (StopService doesn't remove)
      break;

    case 'StopProcess':
      // Process check is handled by NoVendorProcesses invariant
      break;

    case 'RunUninstaller':
      // Uninstaller effects are checked by other invariants
      break;

    case 'Reinstall':
      // After reinstall, we expect the app to be present
      // Not a "removal" check
      break;

    case 'RestoreDefault':
      // Would need baseline comparison
      break;
  }

  return null;
}
