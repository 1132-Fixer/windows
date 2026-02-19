/**
 * Monitoring Types
 *
 * Types for persistence monitoring - detecting relapse after verified clean.
 *
 * DESIGN PRINCIPLES:
 * ✅ Read-only
 * ✅ Opt-in
 * ✅ Low frequency
 * ❌ No process injection
 * ❌ No kernel hooks
 * ❌ No memory scanning
 * ❌ No automatic remediation
 *
 * This module answers ONE question:
 * "Did something come back after we proved the system clean?"
 */

import type { Artifact } from '../../../shared/types';

// ============================================================================
// Persistence Artifact Types
// ============================================================================

/**
 * Types of persistence we monitor
 */
export type PersistenceType =
  | 'scheduled_task'
  | 'service'
  | 'wmi_subscription'
  | 'registry_autorun';

/**
 * A persistence artifact (subset of full Artifact for monitoring)
 */
export interface PersistenceArtifact {
  /**
   * Unique identifier
   */
  id: string;

  /**
   * Type of persistence
   */
  type: PersistenceType;

  /**
   * Path or identifier (task path, service name, registry key)
   */
  path: string;

  /**
   * Human-readable name
   */
  name: string;

  /**
   * Hash of relevant properties for change detection
   */
  contentHash: string;

  /**
   * When this artifact was observed
   */
  observedAt: number;

  /**
   * Raw metadata (type-specific)
   */
  metadata: Record<string, unknown>;
}

// ============================================================================
// Baseline Types
// ============================================================================

/**
 * Monitoring baseline - snapshot of persistence surfaces after verified clean
 */
export interface MonitoringBaseline {
  /**
   * Baseline ID
   */
  id: string;

  /**
   * Session ID this baseline was created from
   */
  sessionId: string;

  /**
   * Product ID that was cleaned
   */
  productId: string;

  /**
   * When the baseline was captured
   */
  timestamp: number;

  /**
   * Whether this was after post-reboot verification
   */
  postRebootVerified: boolean;

  /**
   * Persistence surfaces at baseline
   */
  persistence: {
    tasks: PersistenceArtifact[];
    services: PersistenceArtifact[];
    wmi: PersistenceArtifact[];
    autoruns: PersistenceArtifact[];
  };

  /**
   * Total count for quick reference
   */
  totalCount: number;

  /**
   * App version that created this baseline
   */
  appVersion: string;
}

// ============================================================================
// Diff Types
// ============================================================================

/**
 * A change to a persistence artifact
 */
export interface PersistenceChange {
  /**
   * The artifact path
   */
  path: string;

  /**
   * Type of persistence
   */
  type: PersistenceType;

  /**
   * State before
   */
  before: PersistenceArtifact;

  /**
   * State after
   */
  after: PersistenceArtifact;

  /**
   * What changed
   */
  changedFields: string[];
}

/**
 * Diff between baseline and current state
 */
export interface MonitoringDiff {
  /**
   * Baseline ID this diff is against
   */
  baselineId: string;

  /**
   * When the diff was computed
   */
  computedAt: number;

  /**
   * New persistence artifacts (not in baseline)
   */
  added: PersistenceArtifact[];

  /**
   * Removed persistence artifacts (in baseline but not current)
   */
  removed: PersistenceArtifact[];

  /**
   * Modified persistence artifacts
   */
  modified: PersistenceChange[];

  /**
   * Whether any concerning changes were found
   */
  hasConcerningChanges: boolean;

  /**
   * Summary counts
   */
  counts: {
    added: number;
    removed: number;
    modified: number;
  };
}

// ============================================================================
// Alert Types
// ============================================================================

/**
 * Alert severity
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Alert channel
 */
export type AlertChannel = 'tray' | 'banner' | 'report';

/**
 * A monitoring alert
 */
export interface MonitoringAlert {
  /**
   * Unique alert ID
   */
  id: string;

  /**
   * When the alert was generated
   */
  timestamp: number;

  /**
   * Severity level
   */
  severity: AlertSeverity;

  /**
   * Alert title
   */
  title: string;

  /**
   * Alert message
   */
  message: string;

  /**
   * Alert code for programmatic handling
   */
  code: AlertCode;

  /**
   * Related persistence artifacts
   */
  artifacts: PersistenceArtifact[];

  /**
   * Channels this alert was sent to
   */
  channels: AlertChannel[];

  /**
   * Whether the user has acknowledged this alert
   */
  acknowledged: boolean;

  /**
   * Recommended action
   */
  recommendedAction: 'review' | 'remediate' | 'ignore';
}

/**
 * Alert codes for programmatic handling
 */
export type AlertCode =
  | 'NEW_SCHEDULED_TASK'
  | 'NEW_SERVICE'
  | 'NEW_WMI_SUBSCRIPTION'
  | 'NEW_REGISTRY_AUTORUN'
  | 'MODIFIED_TASK'
  | 'MODIFIED_SERVICE'
  | 'MULTIPLE_NEW_PERSISTENCE'
  | 'HIGH_RISK_PERSISTENCE';

// ============================================================================
// Monitor Configuration
// ============================================================================

/**
 * Monitoring configuration
 */
export interface MonitoringConfig {
  /**
   * Whether monitoring is enabled
   */
  enabled: boolean;

  /**
   * Check interval in hours
   */
  intervalHours: number;

  /**
   * Alert channels to use
   */
  alertChannels: AlertChannel[];

  /**
   * Whether to show tray notifications
   */
  showTrayNotifications: boolean;

  /**
   * Persistence types to monitor
   */
  watchedTypes: PersistenceType[];

  /**
   * Paths to ignore (e.g., known-good system tasks)
   */
  ignorePaths: string[];

  /**
   * Whether to feed findings to risk engine
   */
  feedRiskEngine: boolean;
}

/**
 * Default monitoring configuration
 */
export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: false, // Opt-in
  intervalHours: 12,
  alertChannels: ['tray', 'banner', 'report'],
  showTrayNotifications: true,
  watchedTypes: ['scheduled_task', 'service', 'wmi_subscription', 'registry_autorun'],
  ignorePaths: [
    // Known-good Windows system tasks
    '\\Microsoft\\Windows\\',
    // Known-good system services
    'BITS', 'wuauserv', 'Spooler',
  ],
  feedRiskEngine: true,
};

// ============================================================================
// Monitor State
// ============================================================================

/**
 * Current monitoring state
 */
export interface MonitoringState {
  /**
   * Whether monitoring is active
   */
  active: boolean;

  /**
   * Current baseline (if any)
   */
  baseline: MonitoringBaseline | null;

  /**
   * Last check timestamp
   */
  lastCheck: number | null;

  /**
   * Last check result
   */
  lastDiff: MonitoringDiff | null;

  /**
   * Pending alerts
   */
  pendingAlerts: MonitoringAlert[];

  /**
   * Check history (last N checks)
   */
  checkHistory: MonitoringCheckResult[];

  /**
   * Hours since baseline with no concerning changes
   */
  cleanHours: number;
}

/**
 * Result of a single monitoring check
 */
export interface MonitoringCheckResult {
  /**
   * Check ID
   */
  id: string;

  /**
   * When the check ran
   */
  timestamp: number;

  /**
   * Duration in milliseconds
   */
  durationMs: number;

  /**
   * Whether concerning changes were found
   */
  foundConcerningChanges: boolean;

  /**
   * Summary of findings
   */
  summary: string;

  /**
   * Number of new persistence items found
   */
  newPersistenceCount: number;

  /**
   * Alerts generated (if any)
   */
  alertIds: string[];
}

// ============================================================================
// Report Integration
// ============================================================================

/**
 * Monitoring summary for reports
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

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Baseline manager interface
 */
export interface BaselineManager {
  /**
   * Capture a new baseline
   */
  capture(sessionId: string, productId: string, postRebootVerified: boolean): Promise<MonitoringBaseline>;

  /**
   * Load the current baseline
   */
  load(): Promise<MonitoringBaseline | null>;

  /**
   * Save a baseline
   */
  save(baseline: MonitoringBaseline): Promise<void>;

  /**
   * Delete the baseline
   */
  delete(): Promise<boolean>;

  /**
   * Check if a baseline exists
   */
  exists(): Promise<boolean>;
}

/**
 * Monitor runner interface
 */
export interface MonitorRunner {
  /**
   * Run a single monitoring check
   */
  runCheck(): Promise<MonitoringCheckResult>;

  /**
   * Get current state
   */
  getState(): Promise<MonitoringState>;

  /**
   * Enable monitoring
   */
  enable(config?: Partial<MonitoringConfig>): Promise<void>;

  /**
   * Disable monitoring
   */
  disable(): Promise<void>;

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): Promise<void>;

  /**
   * Get report summary
   */
  getReportSummary(): Promise<MonitoringReportSummary>;
}

/**
 * Alert emitter interface
 */
export interface AlertEmitter {
  /**
   * Emit an alert
   */
  emit(alert: MonitoringAlert): Promise<void>;

  /**
   * Get pending alerts
   */
  getPending(): Promise<MonitoringAlert[]>;

  /**
   * Acknowledge an alert
   */
  acknowledge(alertId: string): Promise<void>;

  /**
   * Clear all alerts
   */
  clearAll(): Promise<void>;
}
