/**
 * Acquisition Runner - Snapshot Assembly
 *
 * Coordinates multiple scanners to produce a complete Snapshot.
 * Scanners run independently and don't communicate with each other.
 *
 * RESPONSIBILITIES:
 * - Run all registered scanners
 * - Collect and merge artifacts
 * - Produce deterministic, sorted Snapshot
 *
 * NON-GOALS:
 * ❌ No correlation (that's Commit #3)
 * ❌ No mutation
 * ❌ No policy enforcement (scanners handle their own safety)
 */

import * as crypto from 'crypto';
import type {
  Artifact,
  Snapshot,
} from '../../../shared/types';
import type {
  Scanner,
  ScanContext,
  ProductDefinition,
} from './types';

// ============================================================================
// Snapshot ID Generation
// ============================================================================

/**
 * Generate a unique, timestamped snapshot ID
 */
function generateSnapshotId(productId: string): string {
  const timestamp = Date.now();
  const random = crypto.randomUUID().slice(0, 8);
  return `snapshot_${productId}_${timestamp}_${random}`;
}

// ============================================================================
// Artifact Sorting
// ============================================================================

/**
 * Sort artifacts deterministically
 * Order: type → path → id
 */
function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => {
    // First by type
    const typeCompare = a.type.localeCompare(b.type);
    if (typeCompare !== 0) return typeCompare;

    // Then by path (if present)
    const pathA = a.path || '';
    const pathB = b.path || '';
    const pathCompare = pathA.localeCompare(pathB);
    if (pathCompare !== 0) return pathCompare;

    // Finally by id
    return a.id.localeCompare(b.id);
  });
}

// ============================================================================
// Acquisition Runner
// ============================================================================

export interface AcquisitionRunnerOptions {
  /**
   * Run scanners in parallel (faster) or sequentially (more predictable)
   * Default: true (parallel)
   */
  parallel?: boolean;

  /**
   * Timeout for each scanner in milliseconds
   * Default: 60000 (1 minute)
   */
  scannerTimeoutMs?: number;
}

export interface AcquisitionResult {
  snapshot: Snapshot;
  durationMs: number;
  scannerResults: ScannerResult[];
}

export interface ScannerResult {
  scannerId: string;
  artifactCount: number;
  durationMs: number;
  error?: string;
}

/**
 * Run acquisition with the given scanners and produce a Snapshot
 *
 * @param scanners - Array of scanners to run
 * @param ctx - Scan context with product definition
 * @param options - Runner options
 * @returns Acquisition result with snapshot
 */
export async function runAcquisition(
  scanners: Scanner[],
  ctx: ScanContext,
  options: AcquisitionRunnerOptions = {},
): Promise<AcquisitionResult> {
  const startTime = Date.now();
  const { parallel = true, scannerTimeoutMs = 60000 } = options;

  const scannerResults: ScannerResult[] = [];
  const allArtifacts: Artifact[] = [];

  /**
   * Run a single scanner with timeout
   */
  async function runScanner(scanner: Scanner): Promise<void> {
    const scannerStart = Date.now();

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Scanner timeout')), scannerTimeoutMs);
      });

      // Race between scanner and timeout
      const artifacts = await Promise.race([
        scanner.scan(ctx),
        timeoutPromise,
      ]);

      const durationMs = Date.now() - scannerStart;

      scannerResults.push({
        scannerId: scanner.id,
        artifactCount: artifacts.length,
        durationMs,
      });

      allArtifacts.push(...artifacts);
    } catch (error) {
      const durationMs = Date.now() - scannerStart;
      scannerResults.push({
        scannerId: scanner.id,
        artifactCount: 0,
        durationMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Run scanners
  if (parallel) {
    await Promise.all(scanners.map(runScanner));
  } else {
    for (const scanner of scanners) {
      await runScanner(scanner);
    }
  }

  // Sort artifacts deterministically
  const sortedArtifacts = sortArtifacts(allArtifacts);

  // Build snapshot
  const snapshot: Snapshot = {
    id: generateSnapshotId(ctx.product.id),
    productId: ctx.product.id,
    createdAt: Date.now(),
    artifacts: sortedArtifacts,
    relationships: [], // Populated in Commit #3 (Correlator)
  };

  const durationMs = Date.now() - startTime;

  return {
    snapshot,
    durationMs,
    scannerResults,
  };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a ScanContext from a ProductDefinition
 */
export function createScanContext(
  product: ProductDefinition,
  options: Partial<Omit<ScanContext, 'product'>> = {},
): ScanContext {
  return {
    product,
    includeAllUsers: options.includeAllUsers ?? false,
    now: options.now ?? Date.now(),
    userProfiles: options.userProfiles,
  };
}

/**
 * Create a minimal snapshot for testing or manual construction
 */
export function createEmptySnapshot(productId: string): Snapshot {
  return {
    id: generateSnapshotId(productId),
    productId,
    createdAt: Date.now(),
    artifacts: [],
    relationships: [],
  };
}

// ============================================================================
// Scanner Registry
// ============================================================================

/**
 * Registry of available scanners
 * Allows dynamic scanner registration and retrieval
 */
export class ScannerRegistry {
  private scanners: Map<string, Scanner> = new Map();

  /**
   * Register a scanner
   */
  register(scanner: Scanner): void {
    this.scanners.set(scanner.id, scanner);
  }

  /**
   * Get a scanner by ID
   */
  get(id: string): Scanner | undefined {
    return this.scanners.get(id);
  }

  /**
   * Get all registered scanners
   */
  getAll(): Scanner[] {
    return Array.from(this.scanners.values());
  }

  /**
   * Check if a scanner is registered
   */
  has(id: string): boolean {
    return this.scanners.has(id);
  }

  /**
   * Get scanner IDs
   */
  getIds(): string[] {
    return Array.from(this.scanners.keys());
  }
}

/**
 * Create a scanner registry with default scanners
 */
export function createScannerRegistry(): ScannerRegistry {
  const registry = new ScannerRegistry();

  // Import and register default scanners
  // Note: Actual registration happens in the main module
  // to avoid circular dependencies

  return registry;
}
