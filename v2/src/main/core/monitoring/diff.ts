/**
 * Monitoring Diff
 *
 * Computes the difference between a baseline and current persistence state.
 * Deterministic and read-only.
 *
 * DETECTS:
 * - Added persistence (new items not in baseline)
 * - Removed persistence (items in baseline but not current) - informational only
 * - Modified persistence (items with different content hashes)
 *
 * CONCERN LEVELS:
 * - WMI subscriptions: Always concerning (rare in normal use)
 * - Hidden scheduled tasks: Concerning
 * - New services: Concerning
 * - New autoruns: Moderate concern
 * - Removed items: Informational (no alert)
 */

import type {
  MonitoringBaseline,
  MonitoringDiff,
  PersistenceArtifact,
  PersistenceChange,
  PersistenceType,
  MonitoringConfig,
} from './types';
import { DEFAULT_MONITORING_CONFIG } from './types';

// ============================================================================
// Diff Logic
// ============================================================================

/**
 * Compute diff between baseline and current state
 */
export function computeDiff(
  baseline: MonitoringBaseline,
  current: {
    tasks: PersistenceArtifact[];
    services: PersistenceArtifact[];
    wmi: PersistenceArtifact[];
    autoruns: PersistenceArtifact[];
  },
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
): MonitoringDiff {
  const added: PersistenceArtifact[] = [];
  const removed: PersistenceArtifact[] = [];
  const modified: PersistenceChange[] = [];

  // Process each persistence type
  const types: Array<{
    type: PersistenceType;
    baselineItems: PersistenceArtifact[];
    currentItems: PersistenceArtifact[];
  }> = [
    { type: 'scheduled_task', baselineItems: baseline.persistence.tasks, currentItems: current.tasks },
    { type: 'service', baselineItems: baseline.persistence.services, currentItems: current.services },
    { type: 'wmi_subscription', baselineItems: baseline.persistence.wmi, currentItems: current.wmi },
    { type: 'registry_autorun', baselineItems: baseline.persistence.autoruns, currentItems: current.autoruns },
  ];

  for (const { type, baselineItems, currentItems } of types) {
    // Skip if type is not being watched
    if (!config.watchedTypes.includes(type)) {
      continue;
    }

    // Build maps for efficient lookup
    const baselineByPath = new Map<string, PersistenceArtifact>();
    for (const item of baselineItems) {
      baselineByPath.set(normalizePath(item.path), item);
    }

    const currentByPath = new Map<string, PersistenceArtifact>();
    for (const item of currentItems) {
      currentByPath.set(normalizePath(item.path), item);
    }

    // Find added items (in current but not baseline)
    for (const [normalizedPath, currentItem] of currentByPath) {
      // Skip ignored paths
      if (isIgnoredPath(currentItem.path, config.ignorePaths)) {
        continue;
      }

      if (!baselineByPath.has(normalizedPath)) {
        added.push(currentItem);
      }
    }

    // Find removed items (in baseline but not current)
    for (const [normalizedPath, baselineItem] of baselineByPath) {
      if (!currentByPath.has(normalizedPath)) {
        removed.push(baselineItem);
      }
    }

    // Find modified items (same path but different content hash)
    for (const [normalizedPath, currentItem] of currentByPath) {
      const baselineItem = baselineByPath.get(normalizedPath);
      if (baselineItem && baselineItem.contentHash !== currentItem.contentHash) {
        // Skip ignored paths
        if (isIgnoredPath(currentItem.path, config.ignorePaths)) {
          continue;
        }

        const changedFields = detectChangedFields(baselineItem, currentItem);
        if (changedFields.length > 0) {
          modified.push({
            path: currentItem.path,
            type,
            before: baselineItem,
            after: currentItem,
            changedFields,
          });
        }
      }
    }
  }

  // Determine if there are concerning changes
  const hasConcerningChanges = assessConcern(added, modified);

  return {
    baselineId: baseline.id,
    computedAt: Date.now(),
    added,
    removed,
    modified,
    hasConcerningChanges,
    counts: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
    },
  };
}

/**
 * Normalize path for comparison (case-insensitive)
 */
function normalizePath(inputPath: string): string {
  return inputPath.toLowerCase().trim();
}

/**
 * Check if a path should be ignored
 */
function isIgnoredPath(itemPath: string, ignorePaths: string[]): boolean {
  const normalizedItem = normalizePath(itemPath);
  for (const ignorePath of ignorePaths) {
    const normalizedIgnore = normalizePath(ignorePath);
    if (normalizedItem.includes(normalizedIgnore)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect which fields changed between baseline and current
 */
function detectChangedFields(
  before: PersistenceArtifact,
  after: PersistenceArtifact,
): string[] {
  const changed: string[] = [];

  // Compare metadata fields
  const beforeMeta = before.metadata || {};
  const afterMeta = after.metadata || {};

  const allKeys = new Set([...Object.keys(beforeMeta), ...Object.keys(afterMeta)]);

  for (const key of allKeys) {
    const beforeValue = JSON.stringify(beforeMeta[key]);
    const afterValue = JSON.stringify(afterMeta[key]);

    if (beforeValue !== afterValue) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Assess whether changes are concerning
 */
function assessConcern(
  added: PersistenceArtifact[],
  modified: PersistenceChange[],
): boolean {
  // Any new WMI subscription is concerning
  if (added.some(a => a.type === 'wmi_subscription')) {
    return true;
  }

  // Any new service is concerning
  if (added.some(a => a.type === 'service')) {
    return true;
  }

  // Multiple new items are concerning
  if (added.length >= 3) {
    return true;
  }

  // Hidden tasks are concerning
  if (added.some(a => a.type === 'scheduled_task' && isHiddenTask(a))) {
    return true;
  }

  // Modified tasks or services are moderately concerning
  if (modified.some(m => m.type === 'scheduled_task' || m.type === 'service')) {
    return true;
  }

  // Single new autorun or task is less concerning but still worth noting
  return added.length > 0;
}

/**
 * Check if a task appears to be hidden
 */
function isHiddenTask(task: PersistenceArtifact): boolean {
  const metadata = task.metadata || {};

  // Check for hidden flag
  if (metadata.hidden === true) {
    return true;
  }

  // Check for suspicious paths (not under standard Microsoft paths)
  const taskPath = task.path.toLowerCase();
  if (!taskPath.startsWith('\\microsoft\\')) {
    // Non-Microsoft tasks in root are more suspicious
    const pathParts = taskPath.split('\\').filter(p => p);
    if (pathParts.length <= 2) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Risk Assessment Integration
// ============================================================================

/**
 * Calculate risk score contribution from monitoring diff
 *
 * Returns a score 0-30 that can be added to session risk
 */
export function calculateDiffRiskScore(diff: MonitoringDiff): number {
  let score = 0;

  // WMI subscriptions are high risk (10 points each, max 20)
  const wmiCount = diff.added.filter(a => a.type === 'wmi_subscription').length;
  score += Math.min(wmiCount * 10, 20);

  // New services are moderate risk (5 points each, max 15)
  const serviceCount = diff.added.filter(a => a.type === 'service').length;
  score += Math.min(serviceCount * 5, 15);

  // New tasks are low-moderate risk (3 points each, max 12)
  const taskCount = diff.added.filter(a => a.type === 'scheduled_task').length;
  score += Math.min(taskCount * 3, 12);

  // New autoruns are low risk (2 points each, max 8)
  const autorunCount = diff.added.filter(a => a.type === 'registry_autorun').length;
  score += Math.min(autorunCount * 2, 8);

  // Modified items add small risk (1 point each, max 5)
  score += Math.min(diff.modified.length, 5);

  // Cap at 30
  return Math.min(score, 30);
}

/**
 * Generate human-readable diff summary
 */
export function generateDiffSummary(diff: MonitoringDiff): string {
  const parts: string[] = [];

  if (diff.added.length > 0) {
    const byType = groupByType(diff.added);
    for (const [type, items] of byType) {
      parts.push(`${items.length} new ${formatType(type)}${items.length > 1 ? 's' : ''}`);
    }
  }

  if (diff.modified.length > 0) {
    parts.push(`${diff.modified.length} modified`);
  }

  if (diff.removed.length > 0) {
    parts.push(`${diff.removed.length} removed (informational)`);
  }

  if (parts.length === 0) {
    return 'No changes detected since baseline.';
  }

  return `Changes detected: ${parts.join(', ')}.`;
}

/**
 * Group artifacts by type
 */
function groupByType(artifacts: PersistenceArtifact[]): Map<PersistenceType, PersistenceArtifact[]> {
  const groups = new Map<PersistenceType, PersistenceArtifact[]>();

  for (const artifact of artifacts) {
    const existing = groups.get(artifact.type) || [];
    existing.push(artifact);
    groups.set(artifact.type, existing);
  }

  return groups;
}

/**
 * Format persistence type for display
 */
function formatType(type: PersistenceType): string {
  switch (type) {
    case 'scheduled_task':
      return 'scheduled task';
    case 'service':
      return 'service';
    case 'wmi_subscription':
      return 'WMI subscription';
    case 'registry_autorun':
      return 'registry autorun';
    default:
      return type;
  }
}

// ============================================================================
// Diff Utilities
// ============================================================================

/**
 * Check if diff indicates clean state
 */
export function isDiffClean(diff: MonitoringDiff): boolean {
  return diff.added.length === 0 && diff.modified.length === 0;
}

/**
 * Get most concerning items from diff
 */
export function getMostConcerning(diff: MonitoringDiff, limit: number = 5): PersistenceArtifact[] {
  // Sort by risk level: WMI > services > tasks > autoruns
  const sortedAdded = [...diff.added].sort((a, b) => {
    const riskOrder: Record<PersistenceType, number> = {
      wmi_subscription: 0,
      service: 1,
      scheduled_task: 2,
      registry_autorun: 3,
    };
    return riskOrder[a.type] - riskOrder[b.type];
  });

  return sortedAdded.slice(0, limit);
}
