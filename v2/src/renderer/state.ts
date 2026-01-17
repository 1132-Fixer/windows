/**
 * Renderer UIState Types
 *
 * Single source of truth for all UI state.
 * Prevents UI drift and race conditions.
 *
 * This file defines the state model and provides helpers
 * for state transitions. No business logic here.
 */

import type {
  AuditSummary,
  PlanSummary,
  StepSummary,
  RiskSummary,
  LaneRecommendation,
  ExecutionTimelineEntry,
  VerificationResult,
  MonitorStatus,
  MonitorAlert,
  SystemInfo,
  ProductInfo,
} from '../main/ipc/channels';

// ============================================================================
// Core State Types
// ============================================================================

/**
 * Application phase - linear progression
 */
export type UIPhase =
  | 'idle'       // Initial state, no session
  | 'audit'     // Scanning for artifacts
  | 'findings'  // Showing scan results
  | 'plan'      // Showing plan with lanes
  | 'execute'   // Running remediation
  | 'verify'    // Running verification
  | 'done';     // Complete, showing results

/**
 * Finding group for display
 */
export interface FindingGroup {
  type: 'process' | 'service' | 'task' | 'file' | 'registry' | 'wmi';
  label: string;
  count: number;
  riskBucket: 'low' | 'medium' | 'high' | 'critical';
  items: FindingItem[];
}

/**
 * Individual finding item
 */
export interface FindingItem {
  id: string;
  name: string;
  path: string;
  riskScore: number;
  riskBucket: 'low' | 'medium' | 'high' | 'critical';
  evidence: string[];
}

/**
 * Plan state with lane info
 */
export interface PlanState {
  autopilot?: PlanSummary;
  assisted: PlanSummary;
  recommendation: LaneRecommendation;
}

/**
 * Execution state
 */
export interface ExecutionState {
  running: boolean;
  lane: 'autopilot' | 'assisted';
  progress: number;
  currentStepId?: string;
  timeline: ExecutionTimelineEntry[];
  stepsCompleted: number;
  totalSteps: number;
}

/**
 * Verification state
 */
export interface VerificationState {
  result?: VerificationResult;
  postRebootPending: boolean;
  postRebootVerdict?: string;
}

/**
 * Main UI State - single source of truth
 */
export interface UIState {
  /**
   * Current phase
   */
  phase: UIPhase;

  /**
   * Current session ID (null if no session)
   */
  sessionId: string | null;

  /**
   * Selected product
   */
  product: ProductInfo | null;

  /**
   * System info
   */
  system: SystemInfo | null;

  /**
   * Audit summary (populated after audit)
   */
  auditSummary: AuditSummary | null;

  /**
   * Grouped findings (populated after audit)
   */
  findings: FindingGroup[] | null;

  /**
   * Risk assessment (populated after plan)
   */
  risk: RiskSummary | null;

  /**
   * Plan state (populated after plan)
   */
  plans: PlanState | null;

  /**
   * Execution state (during/after execution)
   */
  execution: ExecutionState | null;

  /**
   * Verification state (after verification)
   */
  verification: VerificationState | null;

  /**
   * Monitoring status
   */
  monitoring: MonitorStatus | null;

  /**
   * Pending alerts
   */
  alerts: MonitorAlert[];

  /**
   * Loading indicator
   */
  loading: boolean;

  /**
   * Error message (if any)
   */
  error: string | null;
}

// ============================================================================
// Initial State
// ============================================================================

/**
 * Initial UI state
 */
export const INITIAL_STATE: UIState = {
  phase: 'idle',
  sessionId: null,
  product: null,
  system: null,
  auditSummary: null,
  findings: null,
  risk: null,
  plans: null,
  execution: null,
  verification: null,
  monitoring: null,
  alerts: [],
  loading: false,
  error: null,
};

// ============================================================================
// State Transitions
// ============================================================================

/**
 * Valid phase transitions
 */
export const PHASE_TRANSITIONS: Record<UIPhase, UIPhase[]> = {
  idle: ['audit'],
  audit: ['findings', 'idle'], // idle on cancel/error
  findings: ['plan', 'idle'],
  plan: ['execute', 'idle'],
  execute: ['verify', 'idle'], // idle on cancel/error
  verify: ['done', 'idle'],
  done: ['idle'], // Reset to start over
};

/**
 * Check if phase transition is valid
 */
export function canTransition(from: UIPhase, to: UIPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/**
 * Get next valid phases from current
 */
export function getNextPhases(current: UIPhase): UIPhase[] {
  return PHASE_TRANSITIONS[current];
}

// ============================================================================
// State Update Helpers
// ============================================================================

/**
 * Create state update for starting audit
 */
export function startAudit(state: UIState, productId: string): Partial<UIState> {
  return {
    phase: 'audit',
    product: { id: productId, name: productId, vendor: '', description: '', version: '' },
    loading: true,
    error: null,
    auditSummary: null,
    findings: null,
    risk: null,
    plans: null,
    execution: null,
    verification: null,
  };
}

/**
 * Create state update for audit complete
 */
export function completeAudit(
  state: UIState,
  sessionId: string,
  summary: AuditSummary,
  findings: FindingGroup[],
): Partial<UIState> {
  return {
    phase: 'findings',
    sessionId,
    auditSummary: summary,
    findings,
    loading: false,
  };
}

/**
 * Create state update for plan complete
 */
export function completePlan(
  state: UIState,
  plans: PlanState,
  risk: RiskSummary,
): Partial<UIState> {
  return {
    phase: 'plan',
    plans,
    risk,
    loading: false,
  };
}

/**
 * Create state update for starting execution
 */
export function startExecution(
  state: UIState,
  lane: 'autopilot' | 'assisted',
  totalSteps: number,
): Partial<UIState> {
  return {
    phase: 'execute',
    execution: {
      running: true,
      lane,
      progress: 0,
      timeline: [],
      stepsCompleted: 0,
      totalSteps,
    },
    loading: true,
    error: null,
  };
}

/**
 * Create state update for execution progress
 */
export function updateExecutionProgress(
  state: UIState,
  progress: number,
  currentStepId: string,
  stepsCompleted: number,
): Partial<UIState> {
  if (!state.execution) return {};

  return {
    execution: {
      ...state.execution,
      progress,
      currentStepId,
      stepsCompleted,
    },
  };
}

/**
 * Create state update for execution complete
 */
export function completeExecution(
  state: UIState,
  timeline: ExecutionTimelineEntry[],
  success: boolean,
): Partial<UIState> {
  return {
    phase: success ? 'verify' : 'idle',
    execution: state.execution
      ? {
          ...state.execution,
          running: false,
          progress: 100,
          timeline,
        }
      : null,
    loading: false,
    error: success ? null : 'Execution failed',
  };
}

/**
 * Create state update for verification complete
 */
export function completeVerification(
  state: UIState,
  result: VerificationResult,
): Partial<UIState> {
  return {
    phase: 'done',
    verification: {
      result,
      postRebootPending: result.postRebootStatus?.scheduled && !result.postRebootStatus?.completed,
      postRebootVerdict: result.postRebootStatus?.verdict,
    },
    loading: false,
  };
}

/**
 * Create state update for monitoring status
 */
export function updateMonitoring(
  state: UIState,
  status: MonitorStatus,
): Partial<UIState> {
  return {
    monitoring: status,
  };
}

/**
 * Create state update for new alert
 */
export function addAlert(state: UIState, alert: MonitorAlert): Partial<UIState> {
  return {
    alerts: [...state.alerts, alert],
  };
}

/**
 * Create state update for acknowledging alert
 */
export function acknowledgeAlert(state: UIState, alertId: string): Partial<UIState> {
  return {
    alerts: state.alerts.filter((a) => a.id !== alertId),
  };
}

/**
 * Create state update for error
 */
export function setError(state: UIState, error: string): Partial<UIState> {
  return {
    loading: false,
    error,
  };
}

/**
 * Create state update for reset
 */
export function resetState(): UIState {
  return { ...INITIAL_STATE };
}

// ============================================================================
// State Selectors
// ============================================================================

/**
 * Check if audit can be started
 */
export function canStartAudit(state: UIState): boolean {
  return state.phase === 'idle' && !state.loading;
}

/**
 * Check if plan can be built
 */
export function canBuildPlan(state: UIState): boolean {
  return state.phase === 'findings' && state.sessionId !== null && !state.loading;
}

/**
 * Check if execution can start
 */
export function canStartExecution(state: UIState): boolean {
  return state.phase === 'plan' && state.plans !== null && !state.loading;
}

/**
 * Check if autopilot is available
 */
export function isAutopilotAvailable(state: UIState): boolean {
  return state.plans?.recommendation.autopilotAvailable ?? false;
}

/**
 * Get recommended lane
 */
export function getRecommendedLane(state: UIState): 'autopilot' | 'assisted' | 'blocked' | null {
  if (!state.plans) return null;
  const rec = state.plans.recommendation;
  return rec.lane === 'manual_only' ? 'assisted' : rec.lane;
}

/**
 * Get total artifact count
 */
export function getTotalArtifacts(state: UIState): number {
  return state.auditSummary?.totalArtifacts ?? 0;
}

/**
 * Check if session is active
 */
export function hasActiveSession(state: UIState): boolean {
  return state.sessionId !== null && state.phase !== 'idle' && state.phase !== 'done';
}
