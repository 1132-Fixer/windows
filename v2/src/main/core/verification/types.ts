/**
 * Verification Engine Types
 *
 * Defines the interfaces for independent post-remediation verification.
 * The verifier proves outcomes through fresh observation and formal rules.
 *
 * PHILOSOPHY:
 * - The verifier does not trust the executor
 * - It trusts only fresh observation + formal rules
 * - If it can't prove something is clean, it must say so
 */

import type {
  Plan,
  Snapshot,
  SnapshotDiff,
  VerificationCheck,
  VerificationResult,
  VerificationStatus,
} from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';

// ============================================================================
// Verifier Interface
// ============================================================================

/**
 * Verifier performs independent verification of remediation outcomes.
 *
 * INVARIANTS:
 * - Must use fresh scan data (no caching)
 * - Must not assume execution success
 * - Must not "fix" anything
 * - Must not silence failures
 */
export interface Verifier {
  /**
   * Verify that post-remediation state satisfies expected invariants
   *
   * @param input - Verification inputs (product, plan, pre/post snapshots)
   * @returns Verification result with status, checks, and diff
   */
  verify(input: VerifyInput): Promise<VerificationResult>;
}

// ============================================================================
// Verification Input
// ============================================================================

export interface VerifyInput {
  /** Product definition for scope validation */
  product: ProductDefinition;

  /** The plan that was executed */
  plan: Plan;

  /** Snapshot taken before remediation */
  preSnapshot: Snapshot;

  /** Snapshot taken after remediation (fresh scan) */
  postSnapshot: Snapshot;
}

// ============================================================================
// Invariants (conditions that must be true for verification to pass)
// ============================================================================

/**
 * An invariant represents a formal rule that must be true after remediation.
 *
 * Each invariant answers one question:
 * "Given the plan that ran, what *must* be true now?"
 */
export interface Invariant {
  /** Unique identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Category for grouping */
  category: InvariantCategory;

  /**
   * Severity level if violated:
   * - 'critical': Violation causes immediate fail (safety invariants)
   * - 'standard': Violation causes fail
   * - 'advisory': Violation causes warning only
   */
  severity: InvariantSeverity;

  /**
   * Check if this invariant applies to the given plan
   *
   * @param plan - The executed plan
   * @returns true if this invariant should be evaluated
   */
  appliesTo(plan: Plan): boolean;

  /**
   * Evaluate the invariant against the verification input
   *
   * @param input - Full verification context
   * @param diff - Pre-computed snapshot diff
   * @returns Evaluation result with status and evidence
   */
  evaluate(input: VerifyInput, diff: SnapshotDiff): InvariantResult;
}

export type InvariantSeverity = 'critical' | 'standard' | 'advisory';

export type InvariantCategory =
  | 'process'       // No unwanted processes running
  | 'service'       // No unwanted services
  | 'file'          // No unwanted files
  | 'registry'      // No unwanted registry keys
  | 'task'          // No unwanted scheduled tasks
  | 'reference'     // No orphaned references
  | 'integrity'     // System integrity checks
  | 'safety';       // Out-of-scope damage checks

/**
 * Result of evaluating a single invariant
 */
export interface InvariantResult {
  /** Pass, warning, or fail */
  status: VerificationStatus;

  /** Human-readable explanation */
  details?: string;

  /** Supporting evidence for the result */
  evidence?: Record<string, unknown>;
}

// ============================================================================
// Built-in Invariants
// ============================================================================

export const INVARIANTS = {
  // Process invariants
  NO_VENDOR_PROCESSES: 'no_vendor_processes',
  NO_ORPHAN_PROCESSES: 'no_orphan_processes',

  // Service invariants
  NO_VENDOR_SERVICES: 'no_vendor_services',
  SERVICES_STOPPED: 'services_stopped',

  // File invariants
  FILES_REMOVED: 'files_removed',
  NO_RESIDUAL_FOLDERS: 'no_residual_folders',

  // Registry invariants
  REGISTRY_KEYS_REMOVED: 'registry_keys_removed',
  NO_ORPHAN_REFERENCES: 'no_orphan_references',
  UNINSTALL_ENTRY_REMOVED: 'uninstall_entry_removed',

  // Task invariants
  TASKS_REMOVED: 'tasks_removed',

  // Reference invariants
  NO_BROKEN_SHORTCUTS: 'no_broken_shortcuts',
  NO_DEAD_AUTORUN: 'no_dead_autorun',
} as const;

export type InvariantId = typeof INVARIANTS[keyof typeof INVARIANTS];

// ============================================================================
// Mode-specific invariant sets
// ============================================================================

export const MODE_INVARIANTS: Record<string, InvariantId[]> = {
  audit: [], // No invariants for audit mode

  clean: [
    INVARIANTS.FILES_REMOVED,
    INVARIANTS.NO_RESIDUAL_FOLDERS,
    INVARIANTS.REGISTRY_KEYS_REMOVED,
    INVARIANTS.NO_ORPHAN_REFERENCES,
  ],

  repair: [
    INVARIANTS.NO_ORPHAN_REFERENCES,
    INVARIANTS.NO_BROKEN_SHORTCUTS,
    INVARIANTS.NO_DEAD_AUTORUN,
  ],

  uninstall: [
    INVARIANTS.NO_VENDOR_PROCESSES,
    INVARIANTS.NO_VENDOR_SERVICES,
    INVARIANTS.FILES_REMOVED,
    INVARIANTS.NO_RESIDUAL_FOLDERS,
    INVARIANTS.REGISTRY_KEYS_REMOVED,
    INVARIANTS.UNINSTALL_ENTRY_REMOVED,
    INVARIANTS.TASKS_REMOVED,
    INVARIANTS.NO_ORPHAN_REFERENCES,
  ],

  reinstall: [
    // After reinstall, we expect the app to be present again
    // so we check different things
    INVARIANTS.NO_ORPHAN_REFERENCES,
  ],
};

// ============================================================================
// Verification Result Builder
// ============================================================================

export function buildVerificationResult(
  invariantResults: Map<InvariantId, InvariantResult>,
  diff?: SnapshotDiff,
): VerificationResult {
  const checks: VerificationCheck[] = [];
  let overallStatus: VerificationStatus = 'pass';

  for (const [id, result] of invariantResults) {
    const check: VerificationCheck = {
      name: id,
      status: result.passed ? 'pass' : (result.severity === 'warning' ? 'warning' : 'fail'),
      details: result.message,
    };
    checks.push(check);

    // Update overall status
    if (!result.passed) {
      if (result.severity === 'error') {
        overallStatus = 'fail';
      } else if (result.severity === 'warning' && overallStatus !== 'fail') {
        overallStatus = 'warning';
      }
    }
  }

  return {
    status: overallStatus,
    checks,
    diff,
    verifiedAt: Date.now(),
  };
}

// ============================================================================
// Post-Reboot Verification
// ============================================================================

export interface PostRebootVerifier {
  /**
   * Schedule a verification to run after next reboot
   */
  schedule(planId: string, product: ProductDefinition): Promise<ScheduleResult>;

  /**
   * Cancel a scheduled verification
   */
  cancel(planId: string): Promise<void>;

  /**
   * Check if a verification is scheduled
   */
  isScheduled(planId: string): Promise<boolean>;

  /**
   * Run the scheduled verification (called by system on startup)
   */
  runScheduled(planId: string): Promise<VerificationResult>;
}

export interface ScheduleResult {
  success: boolean;
  taskName: string;
  scheduledFor: 'next_logon' | 'next_boot';
  error?: string;
}

// ============================================================================
// Verification Report
// ============================================================================

export interface VerificationReport {
  planId: string;
  productId: string;
  verifiedAt: number;

  preRebootVerification: VerificationResult;
  postRebootVerification?: VerificationResult;

  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    failed: number;
  };

  recommendation: VerificationRecommendation;
}

export type VerificationRecommendation =
  | 'clean'           // System is clean
  | 'review_warnings' // Some warnings, user should review
  | 'retry_remediation' // Failed checks, should retry
  | 'manual_review';  // Complex issues, manual review needed
