/**
 * Monitoring Alerts
 *
 * Generates and manages alerts for persistence changes.
 *
 * ALERT RULES:
 * - No alert for removed items (informational only)
 * - Alert when new persistence appears
 * - Especially alert for WMI or hidden tasks
 *
 * ALERT PHILOSOPHY:
 * - Quiet and respectful
 * - No red panic banners
 * - No sound by default
 * - Clear, actionable messages
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  MonitoringAlert,
  AlertSeverity,
  AlertCode,
  AlertChannel,
  AlertEmitter,
  MonitoringDiff,
  PersistenceArtifact,
  MonitoringConfig,
} from './types';
import { DEFAULT_MONITORING_CONFIG } from './types';
import { getAppDataPath, DATA_PATHS, FILE_NAMES } from '../../../shared/branding';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default alert storage path
 */
function getDefaultAlertPath(): string {
  return path.join(getAppDataPath(), DATA_PATHS.MONITORING, FILE_NAMES.ALERTS);
}

// ============================================================================
// Alert Generation
// ============================================================================

/**
 * Generate alerts from a monitoring diff
 */
export function generateAlerts(
  diff: MonitoringDiff,
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = [];

  // No alerts for empty diffs
  if (diff.added.length === 0 && diff.modified.length === 0) {
    return alerts;
  }

  // Check for WMI subscriptions (highest priority)
  const newWmi = diff.added.filter(a => a.type === 'wmi_subscription');
  if (newWmi.length > 0) {
    alerts.push(createAlert({
      severity: 'critical',
      title: 'New WMI Subscription Detected',
      message: `${newWmi.length} new WMI event subscription(s) detected since last verified clean. WMI subscriptions can be used for persistence. Review recommended.`,
      code: 'NEW_WMI_SUBSCRIPTION',
      artifacts: newWmi,
      channels: config.alertChannels,
      recommendedAction: 'review',
    }));
  }

  // Check for new services (high priority)
  const newServices = diff.added.filter(a => a.type === 'service');
  if (newServices.length > 0) {
    alerts.push(createAlert({
      severity: 'warning',
      title: 'New Service Detected',
      message: `${newServices.length} new service(s) installed since last verified clean. Review recommended.`,
      code: 'NEW_SERVICE',
      artifacts: newServices,
      channels: config.alertChannels,
      recommendedAction: 'review',
    }));
  }

  // Check for new scheduled tasks
  const newTasks = diff.added.filter(a => a.type === 'scheduled_task');
  if (newTasks.length > 0) {
    const hiddenTasks = newTasks.filter(t => isHiddenTask(t));

    if (hiddenTasks.length > 0) {
      alerts.push(createAlert({
        severity: 'warning',
        title: 'Hidden Scheduled Task Detected',
        message: `${hiddenTasks.length} hidden scheduled task(s) detected since last verified clean. Hidden tasks are commonly used for persistence.`,
        code: 'NEW_SCHEDULED_TASK',
        artifacts: hiddenTasks,
        channels: config.alertChannels,
        recommendedAction: 'review',
      }));
    } else if (newTasks.length > 0) {
      alerts.push(createAlert({
        severity: 'info',
        title: 'New Scheduled Task Detected',
        message: `${newTasks.length} new scheduled task(s) detected since last verified clean.`,
        code: 'NEW_SCHEDULED_TASK',
        artifacts: newTasks,
        channels: config.alertChannels,
        recommendedAction: 'review',
      }));
    }
  }

  // Check for new registry autoruns
  const newAutoruns = diff.added.filter(a => a.type === 'registry_autorun');
  if (newAutoruns.length > 0) {
    alerts.push(createAlert({
      severity: 'info',
      title: 'New Registry Autorun Detected',
      message: `${newAutoruns.length} new registry autorun entry/entries detected since last verified clean.`,
      code: 'NEW_REGISTRY_AUTORUN',
      artifacts: newAutoruns,
      channels: config.alertChannels,
      recommendedAction: 'review',
    }));
  }

  // Check for modified items
  const modifiedTasks = diff.modified.filter(m => m.type === 'scheduled_task');
  if (modifiedTasks.length > 0) {
    alerts.push(createAlert({
      severity: 'info',
      title: 'Scheduled Task Modified',
      message: `${modifiedTasks.length} scheduled task(s) modified since last verified clean. Changes may indicate reconfiguration.`,
      code: 'MODIFIED_TASK',
      artifacts: modifiedTasks.map(m => m.after),
      channels: config.alertChannels,
      recommendedAction: 'review',
    }));
  }

  const modifiedServices = diff.modified.filter(m => m.type === 'service');
  if (modifiedServices.length > 0) {
    alerts.push(createAlert({
      severity: 'info',
      title: 'Service Configuration Modified',
      message: `${modifiedServices.length} service(s) modified since last verified clean.`,
      code: 'MODIFIED_SERVICE',
      artifacts: modifiedServices.map(m => m.after),
      channels: config.alertChannels,
      recommendedAction: 'review',
    }));
  }

  // Check for multiple new persistence items (compound alert)
  if (diff.added.length >= 3 && alerts.length > 1) {
    // Add a high-level compound alert
    alerts.unshift(createAlert({
      severity: 'warning',
      title: 'Multiple New Persistence Mechanisms',
      message: `${diff.added.length} new persistence mechanisms detected. This pattern may indicate unwanted software reinstallation.`,
      code: 'MULTIPLE_NEW_PERSISTENCE',
      artifacts: diff.added,
      channels: config.alertChannels,
      recommendedAction: 'remediate',
    }));
  }

  return alerts;
}

/**
 * Check if a task appears hidden
 */
function isHiddenTask(task: PersistenceArtifact): boolean {
  const metadata = task.metadata || {};
  return metadata.hidden === true;
}

/**
 * Create an alert with generated ID and timestamp
 */
function createAlert(params: {
  severity: AlertSeverity;
  title: string;
  message: string;
  code: AlertCode;
  artifacts: PersistenceArtifact[];
  channels: AlertChannel[];
  recommendedAction: 'review' | 'remediate' | 'ignore';
}): MonitoringAlert {
  return {
    id: `alert_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    timestamp: Date.now(),
    severity: params.severity,
    title: params.title,
    message: params.message,
    code: params.code,
    artifacts: params.artifacts,
    channels: params.channels,
    acknowledged: false,
    recommendedAction: params.recommendedAction,
  };
}

// ============================================================================
// Alert Formatting
// ============================================================================

/**
 * Format an alert for tray notification
 */
export function formatTrayNotification(alert: MonitoringAlert): {
  title: string;
  body: string;
} {
  return {
    title: alert.title,
    body: truncate(alert.message, 200),
  };
}

/**
 * Format an alert for banner display
 */
export function formatBanner(alert: MonitoringAlert): {
  text: string;
  severity: 'info' | 'warning' | 'error';
  actionText: string;
} {
  return {
    text: alert.message,
    severity: alert.severity === 'critical' ? 'error' : alert.severity,
    actionText: alert.recommendedAction === 'remediate'
      ? 'Review & Remediate'
      : 'Review',
  };
}

/**
 * Format alert for report inclusion
 */
export function formatReportEntry(alert: MonitoringAlert): {
  timestamp: number;
  severity: string;
  code: string;
  message: string;
  artifactCount: number;
  acknowledged: boolean;
} {
  return {
    timestamp: alert.timestamp,
    severity: alert.severity,
    code: alert.code,
    message: alert.message,
    artifactCount: alert.artifacts.length,
    acknowledged: alert.acknowledged,
  };
}

/**
 * Truncate text to max length
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ============================================================================
// Alert Emitter Implementation
// ============================================================================

/**
 * Create an alert emitter
 */
export function createAlertEmitter(
  alertFilePath?: string,
): AlertEmitter {
  const filePath = alertFilePath ?? getDefaultAlertPath();

  /**
   * Ensure directory exists
   */
  async function ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  /**
   * Load alerts from disk
   */
  async function loadAlerts(): Promise<MonitoringAlert[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * Save alerts to disk
   */
  async function saveAlerts(alerts: MonitoringAlert[]): Promise<void> {
    await ensureDir();
    await fs.writeFile(filePath, JSON.stringify(alerts, null, 2), 'utf-8');
  }

  return {
    /**
     * Emit an alert (add to storage)
     */
    async emit(alert: MonitoringAlert): Promise<void> {
      const alerts = await loadAlerts();
      alerts.unshift(alert); // Add to beginning

      // Keep only last 100 alerts
      const trimmed = alerts.slice(0, 100);

      await saveAlerts(trimmed);
    },

    /**
     * Get pending (unacknowledged) alerts
     */
    async getPending(): Promise<MonitoringAlert[]> {
      const alerts = await loadAlerts();
      return alerts.filter(a => !a.acknowledged);
    },

    /**
     * Acknowledge an alert
     */
    async acknowledge(alertId: string): Promise<void> {
      const alerts = await loadAlerts();
      const alert = alerts.find(a => a.id === alertId);
      if (alert) {
        alert.acknowledged = true;
        await saveAlerts(alerts);
      }
    },

    /**
     * Clear all alerts
     */
    async clearAll(): Promise<void> {
      await saveAlerts([]);
    },
  };
}

// ============================================================================
// Alert Message Templates
// ============================================================================

/**
 * Get detailed message for an alert code
 */
export function getDetailedMessage(code: AlertCode): string {
  const messages: Record<AlertCode, string> = {
    NEW_SCHEDULED_TASK: 'A new scheduled task has been created on your system. Scheduled tasks can run programs automatically at specified times or events. Review the task to ensure it is legitimate.',

    NEW_SERVICE: 'A new Windows service has been installed. Services run in the background and can start automatically. Review the service to ensure it is from a trusted source.',

    NEW_WMI_SUBSCRIPTION: 'A new WMI permanent event subscription has been detected. WMI subscriptions are an advanced persistence mechanism rarely used by legitimate software. This warrants careful review.',

    NEW_REGISTRY_AUTORUN: 'A new program has been added to run automatically when you log in. Check the registry autorun entry to ensure it is a program you recognize.',

    MODIFIED_TASK: 'An existing scheduled task has been modified. The task configuration has changed since the last verified clean state.',

    MODIFIED_SERVICE: 'An existing service configuration has been modified. This may indicate reconfiguration or updates.',

    MULTIPLE_NEW_PERSISTENCE: 'Multiple new persistence mechanisms have appeared simultaneously. This pattern is commonly seen when software is installed without consent or when malware establishes persistence.',

    HIGH_RISK_PERSISTENCE: 'A high-risk persistence mechanism has been detected. Immediate review is recommended.',
  };

  return messages[code] || 'Unknown alert type.';
}
