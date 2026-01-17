/**
 * Monitoring Module
 *
 * Persistence monitoring for relapse detection after verified clean.
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
 * USAGE:
 * ```typescript
 * import {
 *   createBaselineManager,
 *   createMonitorRunner,
 *   createAlertEmitter,
 * } from './monitoring';
 *
 * // After successful verification, capture baseline
 * const baselineManager = createBaselineManager();
 * await baselineManager.capture(sessionId, productId, true);
 *
 * // Enable monitoring (creates scheduled task)
 * const runner = createMonitorRunner();
 * await runner.enable({ intervalHours: 12 });
 *
 * // Run a check (called by scheduled task)
 * const result = await runner.runCheck();
 * if (result.foundConcerningChanges) {
 *   console.log(result.summary);
 * }
 *
 * // Get report summary
 * const summary = await runner.getReportSummary();
 * ```
 */

// Types
export type {
  PersistenceType,
  PersistenceArtifact,
  MonitoringBaseline,
  PersistenceChange,
  MonitoringDiff,
  AlertSeverity,
  AlertChannel,
  AlertCode,
  MonitoringAlert,
  MonitoringConfig,
  MonitoringState,
  MonitoringCheckResult,
  MonitoringReportSummary,
  BaselineManager,
  MonitorRunner,
  AlertEmitter,
} from './types';

export { DEFAULT_MONITORING_CONFIG } from './types';

// Baseline management
export {
  createBaselineManager,
  getDefaultBaselinePath,
  taskToPersistenceArtifact,
  serviceToPersistenceArtifact,
  wmiToPersistenceArtifact,
  autorunToPersistenceArtifact,
} from './baseline';

// Diff computation
export {
  computeDiff,
  generateDiffSummary,
  calculateDiffRiskScore,
  isDiffClean,
  getMostConcerning,
} from './diff';

// Alerting
export {
  generateAlerts,
  createAlertEmitter,
  formatTrayNotification,
  formatBanner,
  formatReportEntry,
  getDetailedMessage,
} from './alert';

// Monitor runner
export {
  createMonitorRunner,
  getMonitoringRiskContribution,
} from './monitor-runner';
