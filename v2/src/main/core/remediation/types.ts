/**
 * Remediation Engine Types
 * Defines step execution, transactions, and rollback
 */

import type {
  Plan,
  PlanStep,
  StepAction,
  StepResult,
  StepStatus,
} from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';

// ============================================================================
// Step Context (passed to each step during execution)
// ============================================================================

export interface StepContext {
  plan: Plan;
  product: ProductDefinition;
  dryRun: boolean;
  elevated: boolean;
  log: (event: StepLogEvent) => void;
  policy: import('./policy').RemediationPolicy;
}

export interface StepLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// Step Interface (each action type implements this)
// ============================================================================

export interface Step {
  /**
   * The action this step handles
   */
  action: StepAction;

  /**
   * Check if step is needed (returns false to skip)
   */
  precheck(ctx: StepContext, step: PlanStep): Promise<PrecheckResult>;

  /**
   * Execute the step (or simulate in dryRun mode)
   */
  execute(ctx: StepContext, step: PlanStep): Promise<StepResult>;

  /**
   * Verify the step completed successfully
   */
  verify(ctx: StepContext, step: PlanStep): Promise<boolean>;

  /**
   * Attempt to rollback (best effort, may not always be possible)
   */
  rollback?(ctx: StepContext, step: PlanStep, backup: StepBackup): Promise<void>;
}

export interface PrecheckResult {
  needed: boolean;
  reason: string;
  currentState?: Record<string, unknown>;
}

// ============================================================================
// Step Backup (for rollback)
// ============================================================================

export interface StepBackup {
  stepId: string;
  action: StepAction;
  target: string;
  backupType: 'file' | 'registry' | 'state';
  backupPath?: string;
  backupData?: unknown;
  createdAt: number;
}

// ============================================================================
// Transaction Log
// ============================================================================

export interface TransactionEntry {
  id: string;
  planId: string;
  stepId: string;
  action: StepAction;
  target: string;
  timestamp: number;

  before: {
    state: Record<string, unknown>;
    hash?: string;
  };

  executed: {
    success: boolean;
    dryRun: boolean;
    error?: string;
  };

  after: {
    state: Record<string, unknown>;
    hash?: string;
  };

  backup?: StepBackup;
  verified: boolean;
}

export interface TransactionLog {
  /**
   * Record a transaction entry
   */
  record(entry: TransactionEntry): Promise<void>;

  /**
   * Get all entries for a plan
   */
  getByPlanId(planId: string): Promise<TransactionEntry[]>;

  /**
   * Get the hash chain head for integrity verification
   */
  getChainHead(): Promise<string>;

  /**
   * Verify log integrity
   */
  verifyIntegrity(): Promise<boolean>;
}

// ============================================================================
// Step Engine Interface
// ============================================================================

export interface StepEngine {
  /**
   * Execute all steps in a plan
   */
  execute(
    plan: Plan,
    product: ProductDefinition,
    options: ExecutionOptions,
  ): Promise<ExecutionResult>;

  /**
   * Rollback a plan execution
   */
  rollback(planId: string): Promise<RollbackResult>;

  /**
   * Get execution status
   */
  getStatus(planId: string): Promise<ExecutionStatus>;
}

export interface ExecutionOptions {
  dryRun: boolean;
  elevated: boolean;
  onProgress?: (event: ExecutionProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export interface ExecutionResult {
  planId: string;
  results: StepResult[];
  overallStatus: 'success' | 'partial' | 'failed' | 'aborted';
  transactionLogPath: string;
  backupPaths: string[];
  durationMs: number;
}

export interface RollbackResult {
  planId: string;
  rolledBack: string[];
  failed: Array<{ stepId: string; error: string }>;
  overallStatus: 'success' | 'partial' | 'failed';
}

export interface ExecutionStatus {
  planId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  currentStepId?: string;
  completedSteps: number;
  totalSteps: number;
  results: StepResult[];
}

export interface ExecutionProgressEvent {
  type: 'step_start' | 'step_complete' | 'step_skip' | 'step_error' | 'log';
  stepId?: string;
  stepIndex?: number;
  totalSteps?: number;
  status?: StepStatus;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// Step Registry
// ============================================================================

export interface StepRegistry {
  /**
   * Register a step implementation
   */
  register(step: Step): void;

  /**
   * Get step implementation for an action
   */
  get(action: StepAction): Step | undefined;

  /**
   * Check if an action is supported
   */
  has(action: StepAction): boolean;
}
