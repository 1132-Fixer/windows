/**
 * Snapshot Diff - Verifier-Owned Diff Logic
 *
 * Computes the difference between two snapshots.
 * This is strict, deterministic, and owned by the verifier.
 *
 * RULES:
 * - Sorting identical to acquisition (type → path → id)
 * - No inference or heuristics
 * - Strict equality for change detection
 */

import type {
  Snapshot,
  SnapshotDiff,
  Artifact,
} from '../../../shared/types';

// ============================================================================
// Artifact Comparison
// ============================================================================

/**
 * Generate a stable key for an artifact for comparison
 * Uses type + path as the primary key
 */
function getArtifactKey(artifact: Artifact): string {
  const path = artifact.path || '';
  return `${artifact.type}:${path.toLowerCase()}`;
}

/**
 * Check if two artifacts are semantically equal
 * Ignores transient fields like observedAt and id
 */
function artifactsEqual(a: Artifact, b: Artifact): boolean {
  // Type must match
  if (a.type !== b.type) return false;

  // Path must match (normalized)
  const pathA = (a.path || '').toLowerCase();
  const pathB = (b.path || '').toLowerCase();
  if (pathA !== pathB) return false;

  // Owner must match
  if (a.owner.vendor !== b.owner.vendor) return false;
  if (a.owner.product !== b.owner.product) return false;

  // Source must match
  if (a.source !== b.source) return false;

  // For detailed comparison, check metadata
  // Note: This is a deep comparison but excludes volatile fields
  return metadataEqual(a.metadata, b.metadata, a.type);
}

/**
 * Compare metadata based on artifact type
 * Some fields are considered volatile and ignored
 */
function metadataEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  type: string,
): boolean {
  // Fields to ignore in comparison (volatile/transient)
  const volatileFields = new Set([
    'accessed', // File access time changes frequently
    'pid',      // Process ID changes on restart
    'startTime', // Process start time changes
    'sessionId', // Session ID changes
    'lastRun',  // Task last run time
    'nextRun',  // Task next run time
  ]);

  // Get comparable keys
  const keysA = Object.keys(a).filter(k => !volatileFields.has(k));
  const keysB = Object.keys(b).filter(k => !volatileFields.has(k));

  // Key count must match
  if (keysA.length !== keysB.length) return false;

  // Sort for deterministic comparison
  keysA.sort();
  keysB.sort();

  // Keys must be identical
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
  }

  // Values must match
  for (const key of keysA) {
    const valA = a[key];
    const valB = b[key];

    if (!valuesEqual(valA, valB)) {
      return false;
    }
  }

  return true;
}

/**
 * Deep equality check for values
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  // Null/undefined check
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  if (b === null || b === undefined) {
    return false;
  }

  // Type check
  const typeA = typeof a;
  const typeB = typeof b;
  if (typeA !== typeB) return false;

  // Primitive types
  if (typeA !== 'object') {
    return a === b;
  }

  // Array check
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Object comparison
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();

  if (keysA.length !== keysB.length) return false;

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!valuesEqual(objA[keysA[i]], objB[keysB[i]])) return false;
  }

  return true;
}

// ============================================================================
// Diff Computation
// ============================================================================

/**
 * Compute the diff between two snapshots
 *
 * @param preSnapshot - Snapshot before remediation
 * @param postSnapshot - Snapshot after remediation (fresh scan)
 * @returns Diff with added, removed, and changed artifacts
 */
export function diffSnapshots(
  preSnapshot: Snapshot,
  postSnapshot: Snapshot,
): SnapshotDiff {
  // Build index for pre-snapshot
  const preIndex = new Map<string, Artifact>();
  for (const artifact of preSnapshot.artifacts) {
    const key = getArtifactKey(artifact);
    preIndex.set(key, artifact);
  }

  // Build index for post-snapshot
  const postIndex = new Map<string, Artifact>();
  for (const artifact of postSnapshot.artifacts) {
    const key = getArtifactKey(artifact);
    postIndex.set(key, artifact);
  }

  const added: Artifact[] = [];
  const removed: Artifact[] = [];
  const changed: Array<{ before: Artifact; after: Artifact }> = [];

  // Find removed and changed
  for (const [key, preArtifact] of preIndex) {
    const postArtifact = postIndex.get(key);

    if (!postArtifact) {
      // Artifact was removed
      removed.push(preArtifact);
    } else if (!artifactsEqual(preArtifact, postArtifact)) {
      // Artifact was changed
      changed.push({ before: preArtifact, after: postArtifact });
    }
    // If equal, no change - skip
  }

  // Find added
  for (const [key, postArtifact] of postIndex) {
    if (!preIndex.has(key)) {
      // Artifact was added
      added.push(postArtifact);
    }
  }

  // Sort all arrays for determinism
  const sortArtifacts = (artifacts: Artifact[]) => {
    return artifacts.sort((a, b) => {
      // Type first
      const typeCompare = a.type.localeCompare(b.type);
      if (typeCompare !== 0) return typeCompare;

      // Path second
      const pathA = a.path || '';
      const pathB = b.path || '';
      const pathCompare = pathA.localeCompare(pathB);
      if (pathCompare !== 0) return pathCompare;

      // ID last
      return a.id.localeCompare(b.id);
    });
  };

  return {
    added: sortArtifacts(added),
    removed: sortArtifacts(removed),
    changed: changed.sort((a, b) => {
      const keyA = getArtifactKey(a.before);
      const keyB = getArtifactKey(b.before);
      return keyA.localeCompare(keyB);
    }),
  };
}

// ============================================================================
// Diff Utilities
// ============================================================================

/**
 * Check if diff indicates any changes
 */
export function hasChanges(diff: SnapshotDiff): boolean {
  return diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.changed.length > 0;
}

/**
 * Get all removed artifacts of a specific type
 */
export function getRemovedByType(
  diff: SnapshotDiff,
  type: string,
): Artifact[] {
  return diff.removed.filter(a => a.type === type);
}

/**
 * Get all added artifacts of a specific type
 */
export function getAddedByType(
  diff: SnapshotDiff,
  type: string,
): Artifact[] {
  return diff.added.filter(a => a.type === type);
}

/**
 * Check if a specific path was removed
 */
export function wasPathRemoved(
  diff: SnapshotDiff,
  path: string,
): boolean {
  const normalizedPath = path.toLowerCase();
  return diff.removed.some(a =>
    a.path && a.path.toLowerCase() === normalizedPath,
  );
}

/**
 * Check if a specific path exists in post-snapshot
 * (was not removed or was added)
 */
export function pathExistsAfter(
  diff: SnapshotDiff,
  postSnapshot: Snapshot,
  path: string,
): boolean {
  const normalizedPath = path.toLowerCase();
  return postSnapshot.artifacts.some(a =>
    a.path && a.path.toLowerCase() === normalizedPath,
  );
}

/**
 * Get summary statistics for a diff
 */
export function getDiffStats(diff: SnapshotDiff): {
  addedCount: number;
  removedCount: number;
  changedCount: number;
  totalChanges: number;
} {
  return {
    addedCount: diff.added.length,
    removedCount: diff.removed.length,
    changedCount: diff.changed.length,
    totalChanges: diff.added.length + diff.removed.length + diff.changed.length,
  };
}
