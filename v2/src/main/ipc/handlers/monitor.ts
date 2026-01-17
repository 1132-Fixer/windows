/**
 * Monitor IPC Handlers
 *
 * Handles monitoring operations: enable, disable, get status, run check, acknowledge.
 * Monitors for persistence relapse after remediation.
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type MonitorStatus,
  type MonitorAlert,
  type MonitorAlertEvent,
} from '../channels';
import {
  createMonitorRunner,
  type MonitorRunner,
} from '../../core/monitoring';

// ============================================================================
// State
// ============================================================================

let monitorRunner: MonitorRunner | null = null;
let monitorEnabled = false;

// ============================================================================
// Helpers
// ============================================================================

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

function sendAlertEvent(alert: MonitorAlert): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.EVENT_MONITOR_ALERT, { alert } as MonitorAlertEvent);
  }
}

/**
 * Initialize monitor runner if not already done
 */
async function ensureMonitorRunner(): Promise<MonitorRunner> {
  if (!monitorRunner) {
    const { createMonitorRunner, DEFAULT_MONITORING_CONFIG } = await import('../../core/monitoring');

    monitorRunner = createMonitorRunner(
      { ...DEFAULT_MONITORING_CONFIG, enabled: monitorEnabled },
      undefined, // Use default state path
    );
  }
  return monitorRunner;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Enable monitoring
 */
async function handleMonitorEnable(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const runner = await ensureMonitorRunner();
    await runner.enable();
    monitorEnabled = true;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to enable monitoring',
    };
  }
}

/**
 * Disable monitoring
 */
async function handleMonitorDisable(): Promise<{ success: boolean; error?: string }> {
  try {
    const runner = await ensureMonitorRunner();
    await runner.disable();
    monitorEnabled = false;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to disable monitoring',
    };
  }
}

/**
 * Get monitoring status
 */
async function handleMonitorGetStatus(): Promise<MonitorStatus> {
  try {
    const runner = await ensureMonitorRunner();
    const state = await runner.getState();
    const summary = await runner.getReportSummary();

    return {
      enabled: state.enabled,
      hasBaseline: state.hasBaseline,
      baselineTimestamp: state.baselineTimestamp,
      lastCheck: state.lastCheck,
      cleanHours: summary.cleanHours,
      pendingAlerts: state.pendingAlerts.length,
      status: summary.status,
    };
  } catch (error) {
    return {
      enabled: false,
      hasBaseline: false,
      cleanHours: 0,
      pendingAlerts: 0,
      status: 'not_monitored',
    };
  }
}

/**
 * Run a manual monitoring check
 */
async function handleMonitorRunCheck(): Promise<{
  success: boolean;
  alerts?: MonitorAlert[];
  error?: string;
}> {
  try {
    const runner = await ensureMonitorRunner();
    const result = await runner.runCheck();

    // Transform internal alerts to UI alerts
    const alerts: MonitorAlert[] = result.alerts.map((a) => ({
      id: a.id,
      code: a.code,
      severity: a.severity,
      title: a.title,
      message: a.message,
      timestamp: a.timestamp,
      acknowledged: a.acknowledged,
      artifactType: a.artifactType,
      artifactPath: a.artifactPath,
    }));

    // Send alert events for new alerts
    for (const alert of alerts) {
      if (!alert.acknowledged) {
        sendAlertEvent(alert);
      }
    }

    return {
      success: true,
      alerts,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Check failed',
    };
  }
}

/**
 * Acknowledge an alert
 */
async function handleMonitorAcknowledgeAlert(
  _event: Electron.IpcMainInvokeEvent,
  alertId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const runner = await ensureMonitorRunner();
    await runner.acknowledgeAlert(alertId);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to acknowledge alert',
    };
  }
}

/**
 * Clear all alerts
 */
async function handleMonitorClearAlerts(): Promise<{ success: boolean; error?: string }> {
  try {
    const runner = await ensureMonitorRunner();
    const state = await runner.getState();

    // Acknowledge all pending alerts
    for (const alert of state.pendingAlerts) {
      await runner.acknowledgeAlert(alert.id);
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear alerts',
    };
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all monitor IPC handlers
 */
export function registerMonitorHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MONITOR_ENABLE, handleMonitorEnable);
  ipcMain.handle(IPC_CHANNELS.MONITOR_DISABLE, handleMonitorDisable);
  ipcMain.handle(IPC_CHANNELS.MONITOR_GET_STATUS, handleMonitorGetStatus);
  ipcMain.handle(IPC_CHANNELS.MONITOR_RUN_CHECK, handleMonitorRunCheck);
  ipcMain.handle(IPC_CHANNELS.MONITOR_ACKNOWLEDGE_ALERT, handleMonitorAcknowledgeAlert);
  ipcMain.handle(IPC_CHANNELS.MONITOR_CLEAR_ALERTS, handleMonitorClearAlerts);
}
