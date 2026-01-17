/**
 * Invariant: No Out-of-Scope Damage
 *
 * APPLIES ALWAYS
 *
 * CHECKS: Diff contains no removals outside:
 *   - plan.boundaries.allowedPaths
 *   - plan.boundaries.allowedRegistryPrefixes
 *
 * FAILS IMMEDIATELY if violated.
 *
 * This is the NUCLEAR SAFETY INVARIANT.
 * If this fails, something went terribly wrong.
 */

import * as path from 'path';
import type { Plan, SnapshotDiff, Artifact } from '../../../../shared/types';
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
 * Expand environment variables
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Check if a path is within allowed boundaries
 */
function isPathAllowed(
  artifactPath: string,
  allowedPaths: string[],
): boolean {
  const normalizedArtifact = normalizePath(expandEnvVars(artifactPath));

  for (const allowed of allowedPaths) {
    const normalizedAllowed = normalizePath(expandEnvVars(allowed));

    // Check if artifact path is within or equal to allowed path
    if (
      normalizedArtifact === normalizedAllowed ||
      normalizedArtifact.startsWith(normalizedAllowed + path.sep)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a registry path is within allowed boundaries
 */
function isRegistryPathAllowed(
  registryPath: string,
  allowedPrefixes: string[],
): boolean {
  const normalizedRegistry = registryPath.toLowerCase();

  for (const allowed of allowedPrefixes) {
    const normalizedAllowed = allowed.toLowerCase();

    // Check if registry path starts with allowed prefix
    if (
      normalizedRegistry === normalizedAllowed ||
      normalizedRegistry.startsWith(normalizedAllowed + '\\')
    ) {
      return true;
    }
  }

  return false;
}

interface OutOfScopeRemoval {
  type: string;
  path: string;
  reason: string;
}

export const NoOutOfScopeDamageInvariant: Invariant = {
  id: 'no_out_of_scope_damage',
  description: 'No artifacts outside plan boundaries should be removed',
  category: 'safety',
  severity: 'critical', // NUCLEAR SAFETY INVARIANT

  appliesTo(_plan: Plan): boolean {
    // Always applies
    return true;
  },

  evaluate(input: VerifyInput, diff: SnapshotDiff): InvariantResult {
    const { plan } = input;
    const { allowedPaths, allowedRegistryPrefixes } = plan.boundaries;

    const outOfScopeRemovals: OutOfScopeRemoval[] = [];

    // Check all removed artifacts
    for (const artifact of diff.removed) {
      if (!artifact.path) continue;

      let isAllowed = false;
      let checkType = '';

      if (artifact.type === 'file') {
        isAllowed = isPathAllowed(artifact.path, allowedPaths);
        checkType = 'filesystem';
      } else if (artifact.type === 'registry') {
        isAllowed = isRegistryPathAllowed(artifact.path, allowedRegistryPrefixes);
        checkType = 'registry';
      } else {
        // Other artifact types (process, service, task) are checked by name
        // against product definition, not path boundaries
        continue;
      }

      if (!isAllowed) {
        outOfScopeRemovals.push({
          type: artifact.type,
          path: artifact.path,
          reason: `Removed ${checkType} path outside allowed boundaries`,
        });
      }
    }

    if (outOfScopeRemovals.length === 0) {
      return {
        status: 'pass',
        details: 'All removals were within plan boundaries',
      };
    }

    // CRITICAL FAILURE
    return {
      status: 'fail',
      details: `CRITICAL: ${outOfScopeRemovals.length} artifact(s) removed outside plan boundaries!`,
      evidence: {
        outOfScopeRemovals,
        count: outOfScopeRemovals.length,
        boundaries: {
          allowedPaths,
          allowedRegistryPrefixes,
        },
      },
    };
  },
};
