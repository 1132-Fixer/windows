/**
 * Shared Types - IPC DTOs and Common Definitions
 * These types are used across main process and renderer
 */

// ============================================================================
// Product & Mode Definitions
// ============================================================================

export type ProductId = 'zoom' | string;

export type Mode = 'audit' | 'clean' | 'repair' | 'uninstall' | 'reinstall';

// ============================================================================
// Artifact Types
// ============================================================================

export type ArtifactType =
  | 'file'
  | 'registry'
  | 'process'
  | 'service'
  | 'task'
  | 'network'
  | 'wmi_subscription'
  | 'defender_state';

export type ScannerId =
  | 'filesystem'
  | 'registry'
  | 'process'
  | 'service'
  | 'task'
  | 'network'
  | 'wmi'
  | 'defender';

export interface OwnerTag {
  vendor: string;
  product: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  owner: OwnerTag;
  path?: string;
  metadata: Record<string, unknown>;
  observedAt: number;
  source: ScannerId;
}

// ============================================================================
// Relationship Types (for correlation graph)
// ============================================================================

export type RelationshipType = 'references' | 'executes' | 'belongs_to';

export interface Relationship {
  fromId: string;
  toId: string;
  type: RelationshipType;
  evidence?: Record<string, unknown>;
}

// ============================================================================
// Snapshot Types
// ============================================================================

export interface Snapshot {
  id: string;
  productId: string;
  createdAt: number;
  artifacts: Artifact[];
  relationships: Relationship[];
}

export interface SnapshotDiff {
  added: Artifact[];
  removed: Artifact[];
  changed: Array<{ before: Artifact; after: Artifact }>;
}

// ============================================================================
// Plan Types
// ============================================================================

export type StepAction =
  | 'StopProcess'
  | 'StopService'
  | 'RunUninstaller'
  | 'RemoveFolder'
  | 'DeleteRegistryKey'
  | 'DeleteRegistryValue'
  | 'DeleteScheduledTask'
  | 'Reinstall'
  | 'RestoreDefault';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PlanStep {
  id: string;
  action: StepAction;
  target: string;
  requiresAdmin: boolean;
  risk: RiskLevel;
  reason: string;
  rollback?: string;
  metadata?: Record<string, unknown>;
}

export interface PlanBoundaries {
  allowedPaths: string[];
  allowedRegistryPrefixes: string[];
  allowedServices: string[];
  allowedTasks: string[];
}

export interface Plan {
  id: string;
  productId: string;
  mode: Mode;
  createdAt: number;
  steps: PlanStep[];
  dryRun: boolean;
  boundaries: PlanBoundaries;
}

// ============================================================================
// Step Execution Types
// ============================================================================

export type StepStatus = 'pending' | 'running' | 'skipped' | 'success' | 'failed';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string;
  };
  durationMs?: number;
}

// ============================================================================
// Verification Types
// ============================================================================

export type VerificationStatus = 'pass' | 'fail' | 'warning';

export interface VerificationCheck {
  name: string;
  status: VerificationStatus;
  details?: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  checks: VerificationCheck[];
  diff?: SnapshotDiff;
  verifiedAt: number;
}

// ============================================================================
// Report Types
// ============================================================================

export interface EnvironmentInfo {
  osVersion: string;
  osBuild: string;
  arch: 'x64' | 'x86' | 'arm64';
  elevated: boolean;
  hostname: string;
  username: string; // will be redacted in exports
}

export interface AttestationReport {
  reportId: string;
  productId: string;
  generatedAt: number;
  environment: EnvironmentInfo;
  plan: Plan;
  results: StepResult[];
  verification: VerificationResult;
  postRebootVerification?: VerificationResult;
  hashes: {
    reportSha256: string;
    logChainHead: string;
  };
  advisories: string[];
}

// ============================================================================
// IPC Request/Response Types
// ============================================================================

export interface AuditRequest {
  productId: ProductId;
  includeAllUsers: boolean;
  includeNetworkObserver: boolean;
}

export interface AuditResponse {
  snapshot: Snapshot;
  issues: AuditIssue[];
  summary: {
    fileCount: number;
    registryCount: number;
    processCount: number;
    serviceCount: number;
    taskCount: number;
  };
}

export interface AuditIssue {
  severity: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  artifactIds: string[];
}

export interface PlanRequest extends AuditRequest {
  mode: Mode;
  options: {
    reinstall?: boolean;
    preserveUserSettings?: boolean;
    dryRun?: boolean;
  };
}

export interface PlanResponse {
  plan: Plan;
  warnings: string[];
  requiresReboot: boolean;
}

export interface ExecuteRequest {
  planId: string;
  approveToken: string;
}

export interface ExecuteResponse {
  results: StepResult[];
  overallStatus: 'success' | 'partial' | 'failed';
  postSnapshot: Snapshot;
}

export interface VerifyRequest {
  planId: string;
  preSnapshot: Snapshot;
  postSnapshot: Snapshot;
  requirePostReboot?: boolean;
}

export interface VerifyResponse {
  verification: VerificationResult;
  postRebootScheduled: boolean;
}

export interface ExportReportRequest {
  reportId: string;
  format: 'json' | 'html' | 'txt';
  redactUsernames: boolean;
}

// ============================================================================
// Progress Events (for real-time UI updates)
// ============================================================================

export interface ProgressEvent {
  type: 'step_start' | 'step_complete' | 'step_error' | 'log';
  stepId?: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}
