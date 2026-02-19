/**
 * Correlator Types
 *
 * Defines the interfaces for relationship correlation between artifacts.
 * The correlator transforms a flat Snapshot into a relationship-aware graph.
 */

import type { Snapshot, Relationship, RelationshipType } from '../../../shared/types';

// ============================================================================
// Correlator Interface
// ============================================================================

/**
 * Correlator transforms a Snapshot by adding relationship edges
 * between artifacts based on evidence from their metadata.
 *
 * INVARIANTS:
 * - Read-only: artifacts are never modified
 * - Deterministic: same input always produces same output
 * - Evidence-based: no inference or heuristics
 * - Vendor-scoped: only relates artifacts within the same product
 */
export interface Correlator {
  /**
   * Add relationship edges to a snapshot
   *
   * @param snapshot - Snapshot with artifacts (may have empty relationships)
   * @returns Same snapshot with relationships populated
   */
  correlate(snapshot: Snapshot): Promise<Snapshot>;
}

// ============================================================================
// Correlation Rule Types
// ============================================================================

/**
 * A correlation rule produces relationships from artifacts
 */
export interface CorrelationRule {
  /** Unique identifier for this rule */
  id: string;

  /** Human-readable description */
  description: string;

  /** Relationship type this rule produces */
  produces: RelationshipType;

  /**
   * Apply this rule to the snapshot and return relationships
   *
   * @param snapshot - The snapshot to analyze
   * @param fileIndex - Pre-built index of file artifacts by normalized path
   * @returns Array of relationships discovered by this rule
   */
  apply(
    snapshot: Snapshot,
    fileIndex: Map<string, string>, // path → artifactId
  ): Relationship[];
}

// ============================================================================
// Evidence Types (for explainability)
// ============================================================================

/**
 * Evidence for a 'references' relationship (registry → file)
 */
export interface ReferencesEvidence {
  registryKey: string;
  valueName: string;
  rawValue: string;
  resolvedPath: string;
}

/**
 * Evidence for an 'executes' relationship (service/task/process → binary)
 */
export interface ExecutesEvidence {
  sourceType: 'service' | 'task' | 'process';
  sourceName: string;
  configField: string;
  binaryPath: string;
}

/**
 * Evidence for a 'belongs_to' relationship (artifact → product)
 */
export interface BelongsToEvidence {
  productId: string;
  vendor: string;
  confidence: string;
}

// ============================================================================
// Correlation Statistics (for debugging/logging)
// ============================================================================

export interface CorrelationStats {
  /** Total relationships created */
  totalRelationships: number;

  /** Breakdown by relationship type */
  byType: Record<RelationshipType, number>;

  /** Breakdown by rule ID */
  byRule: Record<string, number>;

  /** Duration of correlation in milliseconds */
  durationMs: number;
}

export interface CorrelationResult {
  snapshot: Snapshot;
  stats: CorrelationStats;
}
