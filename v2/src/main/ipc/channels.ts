/**
 * IPC Channel Definitions
 *
 * Centralized definitions for all IPC channels between main and renderer.
 * This is the contract - any changes here require version consideration.
 *
 * Security rules:
 * - Renderer NEVER passes raw paths or commands
 * - Renderer NEVER chooses execution details
 * - Renderer only selects lane and approval
 */

/**
 * IPC Channel names
 * Naming convention: domain.action
 */
export const IPC_CHANNELS = {
  // ============================================================================
  // Audit Operations
  // ============================================================================
  AUDIT_RUN: 'audit.run',
  AUDIT_GET_STATUS: 'audit.getStatus',
  AUDIT_CANCEL: 'audit.cancel',

  // ============================================================================
  // Planning Operations
  // ============================================================================
  PLAN_BUILD_WITH_LANES: 'plan.buildWithLanes',
  PLAN_GET_RISK_SUMMARY: 'plan.getRiskSummary',
  PLAN_GET_CURRENT: 'plan.getCurrent',

  // ============================================================================
  // Execution Operations
  // ============================================================================
  EXECUTE_RUN: 'execute.run',
  EXECUTE_GET_TIMELINE: 'execute.getTimeline',
  EXECUTE_CANCEL: 'execute.cancel',

  // ============================================================================
  // Verification Operations
  // ============================================================================
  VERIFY_RUN: 'verify.run',
  VERIFY_GET_RESULTS: 'verify.getResults',
  VERIFY_POST_REBOOT_STATUS: 'verify.postRebootStatus',

  // ============================================================================
  // Monitoring Operations
  // ============================================================================
  MONITOR_ENABLE: 'monitor.enable',
  MONITOR_DISABLE: 'monitor.disable',
  MONITOR_GET_STATUS: 'monitor.getStatus',
  MONITOR_RUN_CHECK: 'monitor.runCheck',
  MONITOR_ACKNOWLEDGE_ALERT: 'monitor.acknowledgeAlert',
  MONITOR_CLEAR_ALERTS: 'monitor.clearAlerts',

  // ============================================================================
  // Report Operations
  // ============================================================================
  REPORT_LIST: 'report.list',
  REPORT_GET: 'report.get',
  REPORT_EXPORT: 'report.export',
  REPORT_DELETE: 'report.delete',
  REPORT_COPY_HASH: 'report.copyHash',

  // ============================================================================
  // Session Operations
  // ============================================================================
  SESSION_GET_CURRENT: 'session.getCurrent',
  SESSION_GET_HISTORY: 'session.getHistory',

  // ============================================================================
  // Product Operations
  // ============================================================================
  PRODUCT_LIST: 'product.list',
  PRODUCT_GET: 'product.get',

  // ============================================================================
  // System Operations
  // ============================================================================
  SYSTEM_GET_INFO: 'system.getInfo',
  SYSTEM_CHECK_ADMIN: 'system.checkAdmin',
  SYSTEM_GET_LOG_PATH: 'system.getLogPath',
  SYSTEM_OPEN_LOG_FOLDER: 'system.openLogFolder',

  // ============================================================================
  // Event Channels (main -> renderer, push notifications)
  // ============================================================================
  EVENT_AUDIT_PROGRESS: 'event.audit.progress',
  EVENT_EXECUTION_PROGRESS: 'event.execution.progress',
  EVENT_EXECUTION_STEP: 'event.execution.step',
  EVENT_MONITOR_ALERT: 'event.monitor.alert',
  EVENT_SESSION_UPDATE: 'event.session.update',
} as const;

/**
 * Channel type helper
 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Audit run options (renderer -> main)
 */
export interface AuditRunOptions {
  productId: string;
  includeAllUsers?: boolean;
}

/**
 * Audit summary for UI
 */
export interface AuditSummary {
  processCount: number;
  serviceCount: number;
  taskCount: number;
  fileCount: number;
  registryCount: number;
  wmiCount: number;
  totalArtifacts: number;
}

/**
 * Audit result (main -> renderer)
 */
export interface AuditResult {
  success: boolean;
  sessionId?: string;
  summary?: AuditSummary;
  error?: string;
}

/**
 * Audit status
 */
export interface AuditStatus {
  running: boolean;
  sessionId?: string;
  progress?: number;
  currentStep?: string;
}

/**
 * Plan build options
 */
export interface PlanBuildOptions {
  sessionId: string;
  mode: 'audit' | 'clean' | 'uninstall';
  options?: {
    preserveUserSettings?: boolean;
    quarantineFiles?: boolean;
    schedulePostRebootVerification?: boolean;
  };
}

/**
 * Lane recommendation from risk engine
 */
export interface LaneRecommendation {
  lane: 'autopilot' | 'assisted' | 'manual_only' | 'blocked';
  reason: string;
  autopilotAvailable: boolean;
  stepCounts: {
    autopilot: number;
    assisted: number;
  };
  bannerText: string;
  bannerSeverity: 'success' | 'warning' | 'error' | 'blocked';
}

/**
 * Step summary for UI display
 */
export interface StepSummary {
  id: string;
  action: string;
  target: string;
  description: string;
  riskBucket: 'low' | 'medium' | 'high' | 'critical';
  reversible: boolean;
  autopilotEligible: boolean;
}

/**
 * Plan summary for UI display
 */
export interface PlanSummary {
  planId: string;
  stepCount: number;
  steps: StepSummary[];
}

/**
 * Risk summary for UI
 */
export interface RiskSummary {
  sessionRiskScore: number;
  sessionRiskBucket: 'low' | 'medium' | 'high' | 'critical';
  planRiskScore: number;
  planRiskBucket: 'low' | 'medium' | 'high' | 'critical';
  combinedScore: number;
  combinedBucket: 'low' | 'medium' | 'high' | 'critical';
  safeForRemediation: boolean;
  warnings: string[];
  blockers: string[];
}

/**
 * Plan build result with lanes
 */
export interface PlanBuildResult {
  success: boolean;
  autopilotPlan?: PlanSummary;
  assistedPlan: PlanSummary;
  recommendation: LaneRecommendation;
  riskSummary: RiskSummary;
  error?: string;
}

/**
 * Execute run options
 */
export interface ExecuteRunOptions {
  sessionId: string;
  lane: 'autopilot' | 'assisted';
  confirmationToken?: string; // Required for assisted lane
}

/**
 * Execution timeline entry
 */
export interface ExecutionTimelineEntry {
  stepId: string;
  action: string;
  target: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  message?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean;
  sessionId: string;
  timeline: ExecutionTimelineEntry[];
  totalDurationMs: number;
  stepsSucceeded: number;
  stepsFailed: number;
  stepsSkipped: number;
  error?: string;
}

/**
 * Verification check result
 */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'error';
  message?: string;
}

/**
 * Post-reboot verification status
 */
export interface PostRebootStatus {
  scheduled: boolean;
  scheduledFor?: 'boot' | 'logon' | 'delay_after_logon';
  completed: boolean;
  verdict?: 'clean' | 'clean_with_warnings' | 'persistence_detected' | 'verification_failed' | 'expired';
  verifiedAt?: number;
  summary?: string;
}

/**
 * Verification result for UI
 */
export interface VerificationResult {
  success: boolean;
  passed: boolean;
  checks: VerificationCheck[];
  postRebootStatus?: PostRebootStatus;
}

/**
 * Monitor status
 */
export interface MonitorStatus {
  enabled: boolean;
  hasBaseline: boolean;
  baselineTimestamp?: number;
  lastCheck?: number;
  cleanHours: number;
  pendingAlerts: number;
  status: 'clean' | 'changes_detected' | 'not_monitored';
}

/**
 * Monitor alert for UI
 */
export interface MonitorAlert {
  id: string;
  code: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  timestamp: number;
  acknowledged: boolean;
  artifactType?: string;
  artifactPath?: string;
}

/**
 * Report list entry
 */
export interface ReportListEntry {
  sessionId: string;
  reportId: string;
  productId: string;
  productName: string;
  mode: string;
  status: 'pass' | 'warn' | 'fail';
  createdAt: number;
  completedAt: number;
}

/**
 * Export options
 */
export interface ReportExportOptions {
  sessionId: string;
  redacted?: boolean;
  format?: 'json' | 'html';
}

/**
 * Export result
 */
export interface ReportExportResult {
  success: boolean;
  path?: string;
  hash?: string;
  error?: string;
}

/**
 * System info
 */
export interface SystemInfo {
  osVersion: string;
  arch: string;
  elevated: boolean;
  appVersion: string;
  username: string;
  hostname: string;
}

/**
 * Product definition for UI
 */
export interface ProductInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  version: string;
}

// ============================================================================
// Event Payload Types
// ============================================================================

/**
 * Audit progress event
 */
export interface AuditProgressEvent {
  sessionId: string;
  progress: number;
  currentStep: string;
  artifactsFound: number;
}

/**
 * Execution progress event
 */
export interface ExecutionProgressEvent {
  sessionId: string;
  progress: number;
  currentStepId: string;
  stepsCompleted: number;
  totalSteps: number;
}

/**
 * Execution step event
 */
export interface ExecutionStepEvent {
  sessionId: string;
  stepId: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  message?: string;
  durationMs?: number;
}

/**
 * Monitor alert event
 */
export interface MonitorAlertEvent {
  alert: MonitorAlert;
}

/**
 * Session update event
 */
export interface SessionUpdateEvent {
  sessionId: string;
  phase: 'audit' | 'plan' | 'execute' | 'verify' | 'done';
  status: 'running' | 'completed' | 'failed';
}
