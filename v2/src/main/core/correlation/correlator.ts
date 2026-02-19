/**
 * Correlator - Relationship Graph Builder
 *
 * Transforms a flat Snapshot (artifacts only) into a relationship-aware
 * Snapshot by adding edges that explain why things exist and how they relate.
 *
 * RESPONSIBILITIES:
 * - Add relationship edges between artifacts
 * - Provide evidence for each relationship
 * - Maintain deterministic output
 *
 * NON-GOALS (NEVER DO):
 * ❌ No modification of artifacts
 * ❌ No inference or heuristics
 * ❌ No threat classification
 * ❌ No scanning or discovery
 * ❌ No linking to protected paths
 *
 * PRINCIPLE: The correlator explains reality. It does not judge it.
 */

import * as path from 'path';
import type {
  Snapshot,
  Relationship,
  RelationshipType,
  Artifact,
} from '../../../shared/types';
import type {
  Correlator,
  CorrelationResult,
  CorrelationStats,
  ReferencesEvidence,
  ExecutesEvidence,
  BelongsToEvidence,
} from './types';
import type {
  RegistryArtifact,
  ServiceArtifact,
  ProcessArtifact,
  TaskArtifact,
  FileArtifact,
} from '../acquisition/types';

// ============================================================================
// Path Normalization (for consistent matching)
// ============================================================================

/**
 * Normalize a filesystem path for comparison
 * - Lowercase (Windows is case-insensitive)
 * - Normalize slashes
 * - Resolve . and ..
 */
function normalizePath(inputPath: string): string {
  if (!inputPath) return '';
  return path.normalize(inputPath).toLowerCase();
}

/**
 * Expand Windows environment variables in a path
 */
function expandEnvVars(inputPath: string): string {
  if (!inputPath) return '';
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Normalize and expand a path for matching
 */
function normalizeForMatching(inputPath: string): string {
  return normalizePath(expandEnvVars(inputPath));
}

// ============================================================================
// Path Value Extraction
// ============================================================================

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

  // UNC path: \\server\share (but we won't follow these)
  // Skip UNC for safety

  return false;
}

/**
 * Extract potential file paths from a registry artifact's values
 */
function extractPathsFromRegistry(artifact: RegistryArtifact): Array<{
  valueName: string;
  rawValue: string;
  normalizedPath: string;
}> {
  const results: Array<{
    valueName: string;
    rawValue: string;
    normalizedPath: string;
  }> = [];

  const values = artifact.metadata.values;
  if (!values || typeof values !== 'object') return results;

  for (const [valueName, rawValue] of Object.entries(values)) {
    if (typeof rawValue !== 'string') continue;

    // Check if this value looks like a path
    if (looksLikePath(rawValue)) {
      // Extract just the path portion (handle quoted paths, paths with args)
      const extractedPath = extractPathFromValue(rawValue);
      if (extractedPath) {
        results.push({
          valueName,
          rawValue,
          normalizedPath: normalizeForMatching(extractedPath),
        });
      }
    }
  }

  return results;
}

/**
 * Extract a clean path from a value that might contain quotes or arguments
 * e.g., '"C:\Program Files\App\app.exe" --arg' → 'C:\Program Files\App\app.exe'
 */
function extractPathFromValue(value: string): string | null {
  if (!value) return null;

  let cleaned = value.trim();

  // Handle quoted paths: "C:\path\to\file.exe" --args
  if (cleaned.startsWith('"')) {
    const endQuote = cleaned.indexOf('"', 1);
    if (endQuote > 1) {
      cleaned = cleaned.substring(1, endQuote);
    }
  } else {
    // Handle unquoted paths with arguments: C:\path\file.exe --args
    // Find first space that's not part of the path
    // This is tricky because paths can have spaces
    // Heuristic: if it has a file extension before a space, stop there
    const extMatch = cleaned.match(/^([a-zA-Z]:\\[^"<>|*?]+\.[a-zA-Z0-9]{1,5})(\s|$)/i);
    if (extMatch) {
      cleaned = extMatch[1];
    } else {
      // Take everything up to first space (may be incomplete)
      const firstSpace = cleaned.indexOf(' ');
      if (firstSpace > 0) {
        // Only use this if what we have looks like a path
        const candidate = cleaned.substring(0, firstSpace);
        if (looksLikePath(candidate)) {
          cleaned = candidate;
        }
      }
    }
  }

  // Final validation
  if (looksLikePath(cleaned)) {
    return cleaned;
  }

  return null;
}

// ============================================================================
// Relationship Factories
// ============================================================================

/**
 * Create a 'references' relationship (registry → file)
 */
function createReferencesRelationship(
  registryArtifact: RegistryArtifact,
  fileArtifactId: string,
  evidence: ReferencesEvidence,
): Relationship {
  return {
    fromId: registryArtifact.id,
    toId: fileArtifactId,
    type: 'references',
    evidence: evidence as unknown as Record<string, unknown>,
  };
}

/**
 * Create an 'executes' relationship (service/task/process → binary)
 */
function createExecutesRelationship(
  sourceArtifact: Artifact,
  fileArtifactId: string,
  evidence: ExecutesEvidence,
): Relationship {
  return {
    fromId: sourceArtifact.id,
    toId: fileArtifactId,
    type: 'executes',
    evidence: evidence as unknown as Record<string, unknown>,
  };
}

/**
 * Create a 'belongs_to' relationship (artifact → product)
 */
function createBelongsToRelationship(
  artifact: Artifact,
  productId: string,
): Relationship {
  const evidence: BelongsToEvidence = {
    productId,
    vendor: artifact.owner.vendor,
    confidence: artifact.owner.confidence,
  };

  return {
    fromId: artifact.id,
    toId: `product:${productId}`,
    type: 'belongs_to',
    evidence: evidence as unknown as Record<string, unknown>,
  };
}

// ============================================================================
// File Index Builder
// ============================================================================

/**
 * Build an index of file artifacts by normalized path
 * Returns: normalizedPath → artifactId
 */
function buildFileIndex(artifacts: Artifact[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const artifact of artifacts) {
    if (artifact.type === 'file' && artifact.path) {
      const normalizedPath = normalizeForMatching(artifact.path);
      index.set(normalizedPath, artifact.id);
    }
  }

  return index;
}

/**
 * Find a file artifact by path (with normalization)
 */
function findFileByPath(
  normalizedPath: string,
  fileIndex: Map<string, string>,
): string | undefined {
  return fileIndex.get(normalizedPath);
}

// ============================================================================
// Correlation Rules
// ============================================================================

/**
 * Rule 1: Registry → File (references)
 *
 * When a registry value contains a filesystem path that resolves to
 * an emitted FileArtifact, create a 'references' relationship.
 */
function correlateRegistryToFile(
  artifacts: Artifact[],
  fileIndex: Map<string, string>,
): Relationship[] {
  const relationships: Relationship[] = [];

  for (const artifact of artifacts) {
    if (artifact.type !== 'registry') continue;
    const registryArtifact = artifact as RegistryArtifact;

    const pathRefs = extractPathsFromRegistry(registryArtifact);

    for (const ref of pathRefs) {
      const fileId = findFileByPath(ref.normalizedPath, fileIndex);
      if (fileId) {
        relationships.push(createReferencesRelationship(
          registryArtifact,
          fileId,
          {
            registryKey: registryArtifact.path,
            valueName: ref.valueName,
            rawValue: ref.rawValue,
            resolvedPath: ref.normalizedPath,
          },
        ));
      }
    }
  }

  return relationships;
}

/**
 * Rule 2: Service → Binary (executes)
 *
 * When a ServiceArtifact has a binaryPath that matches a FileArtifact,
 * create an 'executes' relationship.
 */
function correlateServiceToBinary(
  artifacts: Artifact[],
  fileIndex: Map<string, string>,
): Relationship[] {
  const relationships: Relationship[] = [];

  for (const artifact of artifacts) {
    if (artifact.type !== 'service') continue;
    const serviceArtifact = artifact as ServiceArtifact;

    const binaryPath = serviceArtifact.metadata.binaryPath;
    if (!binaryPath) continue;

    // Extract clean path (services often have quoted paths with args)
    const cleanPath = extractPathFromValue(binaryPath);
    if (!cleanPath) continue;

    const normalizedPath = normalizeForMatching(cleanPath);
    const fileId = findFileByPath(normalizedPath, fileIndex);

    if (fileId) {
      relationships.push(createExecutesRelationship(
        serviceArtifact,
        fileId,
        {
          sourceType: 'service',
          sourceName: serviceArtifact.metadata.name,
          configField: 'binaryPath',
          binaryPath: cleanPath,
        },
      ));
    }
  }

  return relationships;
}

/**
 * Rule 3: Scheduled Task → Binary (executes)
 *
 * When a TaskArtifact action path matches a FileArtifact,
 * create an 'executes' relationship.
 */
function correlateTaskToBinary(
  artifacts: Artifact[],
  fileIndex: Map<string, string>,
): Relationship[] {
  const relationships: Relationship[] = [];

  for (const artifact of artifacts) {
    if (artifact.type !== 'task') continue;
    const taskArtifact = artifact as TaskArtifact;

    const actions = taskArtifact.metadata.actions;
    if (!actions || !Array.isArray(actions)) continue;

    for (const action of actions) {
      if (action.type !== 'Execute' || !action.path) continue;

      const cleanPath = extractPathFromValue(action.path);
      if (!cleanPath) continue;

      const normalizedPath = normalizeForMatching(cleanPath);
      const fileId = findFileByPath(normalizedPath, fileIndex);

      if (fileId) {
        relationships.push(createExecutesRelationship(
          taskArtifact,
          fileId,
          {
            sourceType: 'task',
            sourceName: taskArtifact.metadata.name,
            configField: 'actions[].path',
            binaryPath: cleanPath,
          },
        ));
      }
    }
  }

  return relationships;
}

/**
 * Rule 4: Process → Binary (executes)
 *
 * When a ProcessArtifact executable path matches a FileArtifact,
 * create an 'executes' relationship.
 */
function correlateProcessToBinary(
  artifacts: Artifact[],
  fileIndex: Map<string, string>,
): Relationship[] {
  const relationships: Relationship[] = [];

  for (const artifact of artifacts) {
    if (artifact.type !== 'process') continue;
    const processArtifact = artifact as ProcessArtifact;

    const execPath = processArtifact.metadata.executablePath;
    if (!execPath) continue;

    const normalizedPath = normalizeForMatching(execPath);
    const fileId = findFileByPath(normalizedPath, fileIndex);

    if (fileId) {
      relationships.push(createExecutesRelationship(
        processArtifact,
        fileId,
        {
          sourceType: 'process',
          sourceName: processArtifact.metadata.name,
          configField: 'executablePath',
          binaryPath: execPath,
        },
      ));
    }
  }

  return relationships;
}

/**
 * Rule 5: Artifact → Product (belongs_to)
 *
 * Every artifact always has a 'belongs_to' relationship with its product.
 * This is foundational and enables filtering by product.
 */
function correlateBelongsTo(
  artifacts: Artifact[],
  productId: string,
): Relationship[] {
  return artifacts.map(artifact => createBelongsToRelationship(artifact, productId));
}

// ============================================================================
// Relationship Sorting (Determinism)
// ============================================================================

/**
 * Sort relationships deterministically
 * Order: fromId → type → toId
 */
function sortRelationships(relationships: Relationship[]): Relationship[] {
  return [...relationships].sort((a, b) => {
    // First by fromId
    const fromCompare = a.fromId.localeCompare(b.fromId);
    if (fromCompare !== 0) return fromCompare;

    // Then by type
    const typeCompare = a.type.localeCompare(b.type);
    if (typeCompare !== 0) return typeCompare;

    // Finally by toId
    return a.toId.localeCompare(b.toId);
  });
}

/**
 * Deduplicate relationships (same from/to/type)
 */
function deduplicateRelationships(relationships: Relationship[]): Relationship[] {
  const seen = new Set<string>();
  const result: Relationship[] = [];

  for (const rel of relationships) {
    const key = `${rel.fromId}|${rel.type}|${rel.toId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(rel);
    }
  }

  return result;
}

// ============================================================================
// DefaultCorrelator Implementation
// ============================================================================

export class DefaultCorrelator implements Correlator {
  /**
   * Add relationship edges to a snapshot
   *
   * @param snapshot - Snapshot with artifacts
   * @returns Same snapshot with relationships populated
   */
  async correlate(snapshot: Snapshot): Promise<Snapshot> {
    const startTime = Date.now();

    // Build file index for efficient lookups
    const fileIndex = buildFileIndex(snapshot.artifacts);

    // Collect all relationships from rules
    const relationships: Relationship[] = [];

    // Rule 1: Registry → File (references)
    relationships.push(...correlateRegistryToFile(snapshot.artifacts, fileIndex));

    // Rule 2: Service → Binary (executes)
    relationships.push(...correlateServiceToBinary(snapshot.artifacts, fileIndex));

    // Rule 3: Task → Binary (executes)
    relationships.push(...correlateTaskToBinary(snapshot.artifacts, fileIndex));

    // Rule 4: Process → Binary (executes)
    relationships.push(...correlateProcessToBinary(snapshot.artifacts, fileIndex));

    // Rule 5: Artifact → Product (belongs_to)
    relationships.push(...correlateBelongsTo(snapshot.artifacts, snapshot.productId));

    // Deduplicate and sort for determinism
    const uniqueRelationships = deduplicateRelationships(relationships);
    const sortedRelationships = sortRelationships(uniqueRelationships);

    const durationMs = Date.now() - startTime;

    // Return new snapshot with relationships
    // Note: We don't modify the input snapshot (immutability)
    return {
      ...snapshot,
      relationships: sortedRelationships,
    };
  }

  /**
   * Correlate with statistics (for debugging/logging)
   */
  async correlateWithStats(snapshot: Snapshot): Promise<CorrelationResult> {
    const startTime = Date.now();
    const correlatedSnapshot = await this.correlate(snapshot);
    const durationMs = Date.now() - startTime;

    // Compute stats
    const byType: Record<RelationshipType, number> = {
      references: 0,
      executes: 0,
      belongs_to: 0,
    };

    for (const rel of correlatedSnapshot.relationships) {
      byType[rel.type]++;
    }

    const stats: CorrelationStats = {
      totalRelationships: correlatedSnapshot.relationships.length,
      byType,
      byRule: {
        'registry-to-file': byType.references,
        'service-to-binary': 0, // Would need separate tracking
        'task-to-binary': 0,
        'process-to-binary': 0,
        'belongs-to': byType.belongs_to,
      },
      durationMs,
    };

    return {
      snapshot: correlatedSnapshot,
      stats,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCorrelator(): Correlator {
  return new DefaultCorrelator();
}
