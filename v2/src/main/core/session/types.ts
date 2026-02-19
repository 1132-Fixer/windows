/**
 * Session Types
 *
 * Types for the run-session orchestrator and attestation reporting.
 */

import type { Plan, ProductDefinition, Snapshot } from '../../../shared/types';
import type { ExecutionResult } from '../execution/types';
import type { VerificationResult } from '../verification/types';

/**
 * Remediation mode
 */
export type SessionMode = 'audit' | 'clean' | 'uninstall';

/**
 * Session options
 */
export interface SessionOptions {
  /**
   * Scan all user profiles (requires admin)
   */
  includeAllUsers: boolean;

  /**
   * Include network traffic observation (future)
   */
  includeNetworkObserver: boolean;

  /**
   * Dry run - don't actually execute
   */
  dryRun: boolean;

  /**
   * Preserve user settings during clean
   */
  preserveUserSettings: boolean;

  /**
   * Continue execution on step failure
   */
  continueOnFailure: boolean;

  /**
   * Quarantine files instead of hard delete
   */
  quarantineFiles: boolean;

  /**
   * Verify each step after execution
   */
  verifySteps: boolean;

  /**
   * Schedule post-reboot verification
   */
  schedulePostRebootVerification: boolean;
}

/**
 * Default session options
 */
export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  includeAllUsers: false,
  includeNetworkObserver: false,
  dryRun: false,
  preserveUserSettings: true,
  continueOnFailure: false,
  quarantineFiles: true,
  verifySteps: true,
  schedulePostRebootVerification: true,
};

/**
 * Input to start a remediation session
 */
export interface RunSessionInput {
  /**
   * Product to remediate
   */
  product: ProductDefinition;

  /**
   * Remediation mode
   */
  mode: SessionMode;

  /**
   * Session options
   */
  options: Partial<SessionOptions>;

  /**
   * Whether running with admin privileges
   */
  elevated: boolean;
}

/**
 * Output from a remediation session
 */
export interface RunSessionOutput {
  /**
   * Unique session ID
   */
  sessionId: string;

  /**
   * Pre-remediation snapshot
   */
  preSnapshot: Snapshot;

  /**
   * The remediation plan
   */
  plan: Plan;

  /**
   * Execution result (null if audit mode)
   */
  execution: ExecutionResult | null;

  /**
   * Post-remediation snapshot (null if audit mode or execution failed completely)
   */
  postSnapshot: Snapshot | null;

  /**
   * Verification result (null if audit mode)
   */
  verification: VerificationResult | null;

  /**
   * Attestation report
   */
  report: AttestationReport;

  /**
   * Session timing
   */
  timing: SessionTiming;
}

/**
 * Session timing information
 */
export interface SessionTiming {
  startedAt: number;
  preSnapshotAt: number;
  planBuiltAt: number;
  executionStartedAt?: number;
  executionCompletedAt?: number;
  postSnapshotAt?: number;
  verificationAt?: number;
  completedAt: number;
}

/**
 * Environment information for reports
 */
export interface EnvironmentInfo {
  /**
   * OS version string
   */
  osVersion: string;

  /**
   * Architecture (x64, arm64, etc.)
   */
  arch: string;

  /**
   * Whether running elevated (admin)
   */
  elevated: boolean;

  /**
   * Current username (redacted in exports)
   */
  username: string;

  /**
   * Hostname (redacted in exports)
   */
  hostname: string;

  /**
   * App version
   */
  appVersion: string;

  /**
   * Timestamp
   */
  timestamp: number;
}

/**
 * Diff summary for reports
 */
export interface DiffSummary {
  /**
   * Counts by category
   */
  counts: {
    filesRemoved: number;
    foldersRemoved: number;
    registryKeysRemoved: number;
    registryValuesRemoved: number;
    processesTerminated: number;
    servicesStopped: number;
    tasksDeleted: number;
  };

  /**
   * Example items (top N for each category)
   */
  examples: {
    filesRemoved: string[];
    foldersRemoved: string[];
    registryKeysRemoved: string[];
  };
}

/**
 * Quarantine summary for reports
 */
export interface QuarantineSummary {
  /**
   * Quarantine root path
   */
  rootPath: string;

  /**
   * Number of items moved
   */
  itemCount: number;

  /**
   * Total bytes moved
   */
  totalBytes: number;

  /**
   * Per-step manifests
   */
  manifests: Array<{
    stepId: string;
    type: string;
    description: string;
  }>;

  /**
   * Restore feasibility
   */
  restoreFeasibility: 'full' | 'partial' | 'none';

  /**
   * Restore notes
   */
  restoreNotes: string;
}

/**
 * Advisory message in reports
 */
export interface Advisory {
  /**
   * Severity level
   */
  severity: 'info' | 'warning' | 'error';

  /**
   * Advisory code
   */
  code: string;

  /**
   * Human-readable message
   */
  message: string;

  /**
   * Related step ID (if applicable)
   */
  stepId?: string;
}

/**
 * Attestation report status
 */
export type ReportStatus = 'pass' | 'warn' | 'fail';

/**
 * Report schema version
 */
export type ReportSchemaVersion = '1.0.0' | '1.1.0';

/**
 * Risk assessment summary for reports (v1.1.0+)
 */
export interface RiskAssessmentSummary {
  /**
   * Session-level risk
   */
  sessionRisk: {
    score: number;
    bucket: 'low' | 'medium' | 'high' | 'critical';
    securityPosture: {
      defenderActive: boolean;
      realTimeProtection: boolean;
      tamperProtection: boolean | null;
      suspiciousExclusions: number;
      recentThreats: number;
      overallStatus: 'healthy' | 'degraded' | 'compromised' | 'unknown';
      indicators: string[];
    };
    networkPosture: {
      proxyConfigured: boolean;
      suspiciousProxy: boolean;
      hostsModified: boolean;
      securityDomainsBlocked: boolean;
      dnsHijacked: boolean;
      indicators: string[];
    };
    warnings: string[];
    blockers: string[];
    safeForRemediation: boolean;
  };

  /**
   * Plan-level risk (null if audit mode)
   */
  planRisk: {
    score: number;
    bucket: 'low' | 'medium' | 'high' | 'critical';
    stepCounts: {
      low: number;
      medium: number;
      high: number;
      critical: number;
    };
    highRiskSteps: string[];
    criticalRiskSteps: string[];
    autopilotEligible: boolean;
  } | null;

  /**
   * Combined assessment
   */
  combinedScore: number;
  combinedBucket: 'low' | 'medium' | 'high' | 'critical';
  recommendation: 'autopilot' | 'assisted' | 'manual_only' | 'abort';
  recommendationReason: string;

  /**
   * Autopilot decision (null if not evaluated)
   */
  autopilotDecision: {
    eligible: boolean;
    reasonCodes: string[];
    allowedSteps: string[];
    blockedSteps: string[];
    sessionBlockers: string[];
  } | null;

  /**
   * Lane recommendation
   */
  laneRecommendation: {
    lane: 'autopilot' | 'assisted' | 'manual_only' | 'blocked';
    reason: string;
    autopilotAvailable: boolean;
    stepCounts: {
      autopilot: number;
      assisted: number;
    };
    bannerText: string;
    bannerSeverity: 'success' | 'warning' | 'error' | 'blocked';
  } | null;
}

/**
 * Post-reboot verification summary for reports (v1.1.0+)
 */
export interface PostRebootVerificationSummary {
  /**
   * Whether post-reboot verification was scheduled
   */
  scheduled: boolean;

  /**
   * Context ID for tracking (if scheduled)
   */
  contextId: string | null;

  /**
   * Scheduled trigger type
   */
  scheduledFor: 'boot' | 'logon' | 'delay_after_logon' | null;

  /**
   * Whether verification has been completed
   */
  completed: boolean;

  /**
   * Verification result (populated after reboot)
   */
  result: {
    /**
     * Overall verdict
     */
    verdict: 'clean' | 'clean_with_warnings' | 'persistence_detected' | 'verification_failed' | 'expired' | null;

    /**
     * When verification ran
     */
    verifiedAt: number | null;

    /**
     * Number of checks passed
     */
    checksPassed: number;

    /**
     * Number of checks failed
     */
    checksFailed: number;

    /**
     * Whether any artifacts reappeared
     */
    artifactsReappeared: boolean;

    /**
     * List of reappeared artifacts (paths)
     */
    reappearedArtifactPaths: string[];

    /**
     * Human-readable summary
     */
    summary: string;
  } | null;

  /**
   * Error message if scheduling failed
   */
  error: string | null;
}

/**
 * Monitoring summary for reports (v1.1.0+)
 */
export interface MonitoringReportSummary {
  /**
   * Whether monitoring is enabled
   */
  enabled: boolean;

  /**
   * Baseline timestamp (if any)
   */
  baselineTimestamp: number | null;

  /**
   * Last check timestamp
   */
  lastCheck: number | null;

  /**
   * Hours since baseline with no concerning changes
   */
  cleanHours: number;

  /**
   * Number of checks performed
   */
  checksPerformed: number;

  /**
   * Number of alerts generated
   */
  alertsGenerated: number;

  /**
   * Latest findings (if any)
   */
  latestFindings: {
    added: number;
    removed: number;
    modified: number;
  } | null;

  /**
   * Overall status
   */
  status: 'clean' | 'changes_detected' | 'not_monitored';
}

/**
 * Attestation Report - the canonical output format
 */
export interface AttestationReport {
  /**
   * Report schema version
   */
  schemaVersion: ReportSchemaVersion;

  /**
   * Unique report ID
   */
  reportId: string;

  /**
   * Session ID
   */
  sessionId: string;

  /**
   * Overall status
   */
  status: ReportStatus;

  /**
   * Status reason
   */
  statusReason: string;

  /**
   * Environment information
   */
  environment: EnvironmentInfo;

  /**
   * Product information
   */
  product: {
    id: string;
    name: string;
    vendor: string;
    definitionHash: string;
  };

  /**
   * Session mode and options
   */
  session: {
    mode: SessionMode;
    options: SessionOptions;
    dryRun: boolean;
  };

  /**
   * Pre-snapshot summary
   */
  preSnapshot: {
    id: string;
    timestamp: number;
    counts: {
      files: number;
      registryKeys: number;
      processes: number;
      services: number;
      tasks: number;
    };
  };

  /**
   * Plan summary
   */
  plan: {
    id: string;
    stepCount: number;
    boundaries: {
      allowedPaths: string[];
      allowedRegistryPrefixes: string[];
      allowedTasks: string[];
    };
  };

  /**
   * Execution summary (null if audit mode)
   */
  execution: {
    success: boolean;
    stepResults: Array<{
      stepId: string;
      action: string;
      target: string;
      status: string;
      message: string;
      durationMs: number;
    }>;
    totalDurationMs: number;
  } | null;

  /**
   * Post-snapshot summary (null if audit mode)
   */
  postSnapshot: {
    id: string;
    timestamp: number;
    counts: {
      files: number;
      registryKeys: number;
      processes: number;
      services: number;
      tasks: number;
    };
  } | null;

  /**
   * Verification summary (null if audit mode)
   */
  verification: {
    passed: boolean;
    invariantResults: Array<{
      name: string;
      passed: boolean;
      severity: string;
      message?: string;
    }>;
  } | null;

  /**
   * Diff summary
   */
  diff: DiffSummary | null;

  /**
   * Quarantine summary
   */
  quarantine: QuarantineSummary | null;

  /**
   * Risk assessment (v1.1.0+)
   */
  risk: RiskAssessmentSummary | null;

  /**
   * Post-reboot verification (v1.1.0+)
   */
  postRebootVerification: PostRebootVerificationSummary | null;

  /**
   * Monitoring summary (v1.1.0+)
   */
  monitoring: MonitoringReportSummary | null;

  /**
   * Advisories
   */
  advisories: Advisory[];

  /**
   * Timing information
   */
  timing: SessionTiming;

  /**
   * Report integrity
   */
  integrity: {
    /**
     * SHA-256 hash of report content (excluding this field)
     */
    contentHash: string;

    /**
     * Signature (future: signed by app key)
     */
    signature?: string;
  };

  /**
   * Whether this is a redacted export
   */
  redacted: boolean;
}

/**
 * Session persistence metadata
 */
export interface SessionMetadata {
  sessionId: string;
  productId: string;
  mode: SessionMode;
  status: ReportStatus;
  createdAt: number;
  completedAt: number;
  reportPath: string;
  preSnapshotPath: string;
  postSnapshotPath?: string;
  planPath: string;
  executionPath?: string;
}
