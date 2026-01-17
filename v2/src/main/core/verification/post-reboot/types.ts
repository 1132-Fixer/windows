/**
 * Post-Reboot Verification Types
 *
 * Types for scheduling and executing verification after system reboot.
 * This provides assurance that remediation is persistent across reboots.
 */

import type { ProductDefinition } from '../../acquisition/types';
import type { VerificationResult } from '../../../../shared/types';
import { TASK_NAMES, PRODUCT } from '../../../../shared/branding';

// ============================================================================
// Verification Context (persisted before reboot)
// ============================================================================

/**
 * Context needed to run verification after reboot
 */
export interface PostRebootVerificationContext {
  /**
   * Unique context ID (matches scheduled task identifier)
   */
  contextId: string;

  /**
   * Original session ID for linking results
   */
  sessionId: string;

  /**
   * Product definition for re-scanning
   */
  product: ProductDefinition;

  /**
   * Plan ID that was executed
   */
  planId: string;

  /**
   * Timestamp when scheduled
   */
  scheduledAt: number;

  /**
   * Pre-remediation snapshot ID for comparison
   */
  preSnapshotId: string;

  /**
   * Immediately post-remediation snapshot ID (before reboot)
   */
  postSnapshotId: string;

  /**
   * Expected artifacts to remain absent
   */
  expectedAbsent: ExpectedAbsentArtifact[];

  /**
   * Maximum retries if verification fails
   */
  maxRetries: number;

  /**
   * Current retry count
   */
  retryCount: number;

  /**
   * Expiration timestamp (after which context is cleaned up)
   */
  expiresAt: number;
}

/**
 * Artifact that should remain absent after reboot
 */
export interface ExpectedAbsentArtifact {
  type: 'file' | 'registry' | 'process' | 'service' | 'task';
  path: string;
  wasRemoved: boolean;
}

// ============================================================================
// Scheduling Types
// ============================================================================

/**
 * Trigger type for scheduled verification
 */
export type VerificationTrigger = 'boot' | 'logon' | 'delay_after_logon';

/**
 * Schedule configuration
 */
export interface ScheduleConfig {
  /**
   * When to trigger verification
   */
  trigger: VerificationTrigger;

  /**
   * Delay in seconds after trigger (for delay_after_logon)
   */
  delaySeconds?: number;

  /**
   * Run elevated (requires admin privileges)
   */
  runElevated: boolean;

  /**
   * Maximum runtime in seconds before timeout
   */
  timeoutSeconds: number;

  /**
   * Number of days before auto-cleanup
   */
  expirationDays: number;
}

/**
 * Default schedule configuration
 */
export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  trigger: 'logon',
  delaySeconds: 60, // Wait 1 minute after logon for system stability
  runElevated: false,
  timeoutSeconds: 300, // 5 minute timeout
  expirationDays: 7,
};

/**
 * Result of scheduling operation
 */
export interface ScheduleResult {
  success: boolean;
  contextId: string;
  taskName: string;
  scheduledFor: VerificationTrigger;
  error?: string;
}

// ============================================================================
// Verification Result Types
// ============================================================================

/**
 * Post-reboot verification outcome
 */
export interface PostRebootVerificationResult {
  /**
   * Context ID that was verified
   */
  contextId: string;

  /**
   * Original session ID
   */
  sessionId: string;

  /**
   * Timestamp when verification ran
   */
  verifiedAt: number;

  /**
   * Overall verification result
   */
  result: VerificationResult;

  /**
   * Persistence check results
   */
  persistenceChecks: PersistenceCheck[];

  /**
   * Whether any artifacts reappeared (persistence mechanisms)
   */
  artifactsReappeared: boolean;

  /**
   * List of artifacts that reappeared
   */
  reappearedArtifacts: ReappearedArtifact[];

  /**
   * Overall verdict
   */
  verdict: PostRebootVerdict;

  /**
   * Human-readable summary
   */
  summary: string;
}

/**
 * Individual persistence check
 */
export interface PersistenceCheck {
  type: 'file' | 'registry' | 'process' | 'service' | 'task';
  path: string;
  expectedState: 'absent' | 'present';
  actualState: 'absent' | 'present' | 'unknown';
  passed: boolean;
  details?: string;
}

/**
 * Artifact that reappeared after reboot
 */
export interface ReappearedArtifact {
  type: 'file' | 'registry' | 'process' | 'service' | 'task';
  path: string;
  detectedAt: number;
  possibleCause: PersistenceCause;
}

/**
 * Possible cause of artifact reappearance
 */
export type PersistenceCause =
  | 'scheduled_task'
  | 'service_auto_start'
  | 'registry_autorun'
  | 'wmi_subscription'
  | 'driver'
  | 'system_restore'
  | 'cloud_sync'
  | 'unknown';

/**
 * Overall verdict for post-reboot verification
 */
export type PostRebootVerdict =
  | 'clean'              // All checks passed, no reappearance
  | 'clean_with_warnings' // Passed but some warnings
  | 'persistence_detected' // Artifacts reappeared
  | 'verification_failed' // Could not complete verification
  | 'expired';            // Context expired before verification ran

// ============================================================================
// Scheduler Interface
// ============================================================================

/**
 * Post-reboot verification scheduler
 */
export interface PostRebootScheduler {
  /**
   * Schedule verification for after next reboot
   */
  schedule(
    sessionId: string,
    product: ProductDefinition,
    planId: string,
    expectedAbsent: ExpectedAbsentArtifact[],
    config?: Partial<ScheduleConfig>,
  ): Promise<ScheduleResult>;

  /**
   * Cancel a scheduled verification
   */
  cancel(contextId: string): Promise<boolean>;

  /**
   * Check if verification is scheduled
   */
  isScheduled(contextId: string): Promise<boolean>;

  /**
   * List all scheduled verifications
   */
  listScheduled(): Promise<PostRebootVerificationContext[]>;

  /**
   * Get context by ID
   */
  getContext(contextId: string): Promise<PostRebootVerificationContext | null>;

  /**
   * Clean up expired contexts and tasks
   */
  cleanup(): Promise<{ removed: number }>;
}

// ============================================================================
// Startup Runner Interface
// ============================================================================

/**
 * Startup verification runner (runs on boot/logon)
 */
export interface StartupVerificationRunner {
  /**
   * Check if there are pending verifications to run
   */
  hasPending(): Promise<boolean>;

  /**
   * Run all pending verifications
   */
  runPending(): Promise<PostRebootVerificationResult[]>;

  /**
   * Run a specific verification by context ID
   */
  runOne(contextId: string): Promise<PostRebootVerificationResult>;
}

// ============================================================================
// Task Name Constants
// ============================================================================

/**
 * Task name prefix for our scheduled tasks
 */
export const TASK_NAME_PREFIX = `${TASK_NAMES.POST_REBOOT_VERIFY}_`;

/**
 * Task folder path
 */
export const TASK_FOLDER = `\\${PRODUCT.SHORT_NAME}\\`;

/**
 * Get full task name from context ID
 */
export function getTaskName(contextId: string): string {
  return `${TASK_NAME_PREFIX}${contextId}`;
}

/**
 * Extract context ID from task name
 */
export function getContextIdFromTaskName(taskName: string): string | null {
  if (taskName.startsWith(TASK_NAME_PREFIX)) {
    return taskName.slice(TASK_NAME_PREFIX.length);
  }
  return null;
}
