/**
 * StepEngine Types
 *
 * Defines interfaces for safe, policy-enforced plan execution.
 *
 * PRINCIPLES:
 * - Execute the plan, nothing more
 * - Re-enforce policy at runtime
 * - Capture before/after for every step
 * - Support dry-run end-to-end
 * - Quarantine-by-default for destructive operations
 */

import type {
  Plan,
  PlanStep,
  StepResult,
  StepStatus,
  StepAction,
} from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';
import type { RemediationPolicy } from '../remediation/policy';
import type { ExecutionLane } from '../planning/types';
import type { SessionRisk, PlanRisk, StepRisk } from '../risk/types';
import type { AutopilotDecision } from '../risk/autopilot-policy';

// ============================================================================
// Execution Context
// ============================================================================

/**
 * Context provided to the StepEngine for execution
 */
export interface ExecutionContext {
  /** Product being remediated */
  product: ProductDefinition;

  /** The approved plan to execute */
  plan: Plan;

  /** If true, simulate execution without system changes */
  dryRun: boolean;

  /** Whether the current process has admin/elevated privileges */
  elevated: boolean;

  /** Policy for runtime enforcement */
  policy: RemediationPolicy;

  /** Event recorder for logging */
  record: (event: StepEvent) => void;

  /** Backup store for rollback capability */
  backup: StepBackupStore;

  /** Timeout configuration */
  timeouts: TimeoutConfig;

  /** Execution options */
  options: ExecutionOptions;

  /** Execution lane (autopilot or assisted) */
  lane: ExecutionLane;

  /** Lane enforcement configuration */
  laneEnforcement?: LaneEnforcement;
}

/**
 * Lane enforcement configuration for runtime checks
 */
export interface LaneEnforcement {
  /** Session risk assessment for environmental checks */
  sessionRisk: SessionRisk;

  /** Plan risk assessment for step risk checks */
  planRisk: PlanRisk;

  /** Autopilot decision containing allowed/blocked steps */
  autopilotDecision: AutopilotDecision;

  /** Step risk map for quick lookup */
  stepRiskMap: Map<string, StepRisk>;

  /** Whether to strictly enforce lane boundaries */
  strictMode: boolean;
}

export interface TimeoutConfig {
  /** Timeout per step in milliseconds (default: 60000) */
  perStepMs: number;

  /** Timeout for graceful process shutdown (default: 5000) */
  gracefulShutdownMs: number;

  /** Timeout for service stop (default: 30000) */
  serviceStopMs: number;
}

export interface ExecutionOptions {
  /** Continue execution after non-critical failures (default: false) */
  continueOnFailure: boolean;

  /** Use quarantine instead of delete for files (default: true) */
  quarantineFiles: boolean;

  /** Attempt graceful process shutdown before force kill (default: true) */
  gracefulProcessShutdown: boolean;

  /** Verify each step's effect immediately after execution */
  verifySteps: boolean;
}

// ============================================================================
// StepEngine Interface
// ============================================================================

/**
 * StepEngine executes an approved plan
 */
export interface StepEngine {
  /**
   * Execute all steps in the plan
   *
   * @param ctx - Execution context
   * @returns Execution result with all step outcomes
   */
  execute(ctx: ExecutionContext): Promise<ExecutionRunResult>;
}

export interface ExecutionRunResult {
  /** Plan ID that was executed */
  planId: string;

  /** Overall execution status */
  status: ExecutionStatus;

  /** Results for each step */
  results: StepResult[];

  /** When execution started */
  startedAt: number;

  /** When execution finished */
  finishedAt: number;

  /** Duration in milliseconds */
  durationMs: number;

  /** Summary statistics */
  summary: ExecutionSummary;
}

export type ExecutionStatus =
  | 'success'           // All steps completed successfully
  | 'partial'           // Some steps failed but execution continued
  | 'failed'            // Execution stopped due to failure
  | 'dry-run'           // Dry run completed (no actual changes)
  | 'aborted'           // Execution aborted due to policy violation
  | 'lane-violation';   // Execution stopped due to lane enforcement

export interface ExecutionSummary {
  totalSteps: number;
  executed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

// ============================================================================
// Step Events (for logging/progress)
// ============================================================================

export type StepEvent =
  | StepStartEvent
  | StepProgressEvent
  | StepCompleteEvent
  | StepSkippedEvent
  | StepErrorEvent
  | ExecutionLogEvent;

export interface StepStartEvent {
  type: 'step_start';
  stepId: string;
  action: StepAction;
  target: string;
  timestamp: number;
}

export interface StepProgressEvent {
  type: 'step_progress';
  stepId: string;
  message: string;
  progress?: number; // 0-100
  timestamp: number;
}

export interface StepCompleteEvent {
  type: 'step_complete';
  stepId: string;
  status: StepStatus;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  durationMs: number;
  timestamp: number;
}

export interface StepSkippedEvent {
  type: 'step_skipped';
  stepId: string;
  reason: string;
  timestamp: number;
}

export interface StepErrorEvent {
  type: 'step_error';
  stepId: string;
  error: string;
  code?: string;
  timestamp: number;
}

export interface ExecutionLogEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// Step Backup Store
// ============================================================================

/**
 * Store for step backups (for potential rollback)
 */
export interface StepBackupStore {
  /**
   * Save a backup for a step
   */
  save(stepId: string, backup: StepBackup): Promise<void>;

  /**
   * Load a backup for a step
   */
  load(stepId: string): Promise<StepBackup | null>;

  /**
   * List all backups for a plan
   */
  listForPlan(planId: string): Promise<StepBackupInfo[]>;

  /**
   * Delete a backup
   */
  delete(stepId: string): Promise<void>;

  /**
   * Get the quarantine directory path
   */
  getQuarantinePath(planId: string, stepId: string): string;
}

export type StepBackup =
  | RegistryExportBackup
  | FolderQuarantineBackup
  | ManifestBackup;

export interface RegistryExportBackup {
  type: 'reg-export';
  keyPath: string;
  filePath: string;
  exportedAt: number;
}

export interface FolderQuarantineBackup {
  type: 'folder-quarantine';
  originalPath: string;
  quarantinePath: string;
  fileCount: number;
  totalSize: number;
  movedAt: number;
}

export interface ManifestBackup {
  type: 'manifest';
  description: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface StepBackupInfo {
  stepId: string;
  planId: string;
  backupType: StepBackup['type'];
  createdAt: number;
  size?: number;
}

// ============================================================================
// Step Handler Interface
// ============================================================================

/**
 * Handler for a specific step action type
 */
export interface StepHandler {
  /** The action type this handler supports */
  action: StepAction;

  /**
   * Pre-check: verify step can be executed
   * @returns true if step should execute, false to skip
   */
  precheck(step: PlanStep, ctx: ExecutionContext): Promise<PrecheckResult>;

  /**
   * Capture state before execution
   */
  captureBefore(step: PlanStep, ctx: ExecutionContext): Promise<Record<string, unknown>>;

  /**
   * Create backup before destructive operation
   */
  backup(step: PlanStep, ctx: ExecutionContext): Promise<StepBackup | null>;

  /**
   * Execute the step
   */
  execute(step: PlanStep, ctx: ExecutionContext): Promise<void>;

  /**
   * Capture state after execution
   */
  captureAfter(step: PlanStep, ctx: ExecutionContext): Promise<Record<string, unknown>>;

  /**
   * Verify the step had its intended effect
   */
  verify(
    step: PlanStep,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<boolean>;
}

export interface PrecheckResult {
  canExecute: boolean;
  reason?: string;
  requiresAdmin?: boolean;
}

// ============================================================================
// Quarantine Configuration
// ============================================================================

export interface QuarantineConfig {
  /** Base directory for quarantine (default: %PROGRAMDATA%\Remediator\Quarantine) */
  basePath: string;

  /** Retention period in days (default: 30) */
  retentionDays: number;

  /** Maximum quarantine size in bytes (default: 10GB) */
  maxSizeBytes: number;
}

export const DEFAULT_QUARANTINE_CONFIG: QuarantineConfig = {
  basePath: '%PROGRAMDATA%\\Remediator\\Quarantine',
  retentionDays: 30,
  maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10GB
};

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  perStepMs: 60000,
  gracefulShutdownMs: 5000,
  serviceStopMs: 30000,
};

export const DEFAULT_EXECUTION_OPTIONS: ExecutionOptions = {
  continueOnFailure: false,
  quarantineFiles: true,
  gracefulProcessShutdown: true,
  verifySteps: true,
};
