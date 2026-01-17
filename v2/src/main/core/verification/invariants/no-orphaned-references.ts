/**
 * Invariant: No Orphaned References
 *
 * APPLIES WHEN: Any RemoveFolder/DeleteRegistryKey ran
 *
 * CHECKS: Registry values do not reference paths that:
 *   - existed in pre-snapshot
 *   - do not exist in post-snapshot
 *
 * This catches:
 * - Half-removals
 * - Broken installs
 * - Incomplete cleanup
 */

import * as path from 'path';
import type { Plan, SnapshotDiff, Artifact } from '../../../../shared/types';
import type {
  Invariant,
  InvariantResult,
  VerifyInput,
} from '../types';
import type { RegistryArtifact, FileArtifact } from '../../acquisition/types';

/**
 * Check if a string looks like a Windows filesystem path
 */
function looksLikePath(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  if (value.length < 3) return false;

  // Drive letter path: C:\...
  if (/^[a-zA-Z]:\\/.test(value)) return true;

  // Environment variable path: %APPDATA%\...
  if (/^%[^%]+%\\/.test(value)) return true;

  return false;
}

/**
 * Extract paths from registry values
 */
function extractPathsFromValues(values: Record<string, unknown>): string[] {
  const paths: string[] = [];

  for (const value of Object.values(values)) {
    if (typeof value !== 'string') continue;
    if (!looksLikePath(value)) continue;

    // Extract path (handle quoted paths with args)
    let cleanPath = value.trim();

    if (cleanPath.startsWith('"')) {
      const endQuote = cleanPath.indexOf('"', 1);
      if (endQuote > 1) {
        cleanPath = cleanPath.substring(1, endQuote);
      }
    } else {
      // Take first space-separated segment if it looks like a path
      const firstSpace = cleanPath.indexOf(' ');
      if (firstSpace > 0) {
        const candidate = cleanPath.substring(0, firstSpace);
        if (looksLikePath(candidate)) {
          cleanPath = candidate;
        }
      }
    }

    if (looksLikePath(cleanPath)) {
      paths.push(cleanPath.toLowerCase());
    }
  }

  return paths;
}

/**
 * Normalize path for comparison
 */
function normalizePath(inputPath: string): string {
  return path.normalize(inputPath).toLowerCase();
}

export const NoOrphanedReferencesInvariant: Invariant = {
  id: 'no_orphaned_references',
  description: 'Registry should not reference files that were removed',
  category: 'reference',
  severity: 'advisory', // Warning level - may be expected in some cases

  appliesTo(plan: Plan): boolean {
    // Applies when files or folders were removed
    return plan.steps.some(step =>
      step.action === 'RemoveFolder' ||
      step.action === 'DeleteRegistryKey' ||
      step.action === 'RunUninstaller',
    );
  },

  evaluate(input: VerifyInput, diff: SnapshotDiff): InvariantResult {
    const { preSnapshot, postSnapshot } = input;

    // Build set of paths that existed before but don't exist after
    const removedPaths = new Set<string>();
    for (const artifact of diff.removed) {
      if (artifact.type === 'file' && artifact.path) {
        removedPaths.add(normalizePath(artifact.path));
      }
    }

    // If nothing was removed, pass
    if (removedPaths.size === 0) {
      return {
        status: 'pass',
        details: 'No files were removed, no orphaned references possible',
      };
    }

    // Build set of paths that exist in post-snapshot
    const existingPaths = new Set<string>();
    for (const artifact of postSnapshot.artifacts) {
      if (artifact.type === 'file' && artifact.path) {
        existingPaths.add(normalizePath(artifact.path));
      }
    }

    // Check all remaining registry entries for references to removed paths
    const orphanedReferences: Array<{
      registryKey: string;
      referencedPath: string;
    }> = [];

    for (const artifact of postSnapshot.artifacts) {
      if (artifact.type !== 'registry') continue;
      const regArtifact = artifact as RegistryArtifact;

      const values = regArtifact.metadata.values;
      if (!values) continue;

      const referencedPaths = extractPathsFromValues(values);

      for (const refPath of referencedPaths) {
        const normalizedRefPath = normalizePath(refPath);

        // Check if this path was removed
        if (removedPaths.has(normalizedRefPath)) {
          // And doesn't exist anymore
          if (!existingPaths.has(normalizedRefPath)) {
            orphanedReferences.push({
              registryKey: regArtifact.path,
              referencedPath: refPath,
            });
          }
        }
      }
    }

    if (orphanedReferences.length === 0) {
      return {
        status: 'pass',
        details: 'No orphaned references found',
      };
    }

    return {
      status: 'warning', // Advisory level - warning not fail
      details: `${orphanedReferences.length} registry key(s) reference removed files`,
      evidence: {
        orphanedReferences,
        count: orphanedReferences.length,
      },
    };
  },
};
