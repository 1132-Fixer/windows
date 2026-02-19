/**
 * Preload Script
 *
 * Exposes a secure, minimal API to the renderer process.
 * All IPC communication goes through this layer.
 *
 * SECURITY:
 * - contextIsolation: true (renderer can't access Node.js)
 * - nodeIntegration: false (no require() in renderer)
 * - Only specific IPC methods are exposed
 * - No filesystem, shell, or other Node.js APIs exposed
 * - No dynamic channel names
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AuditRunOptions,
  AuditResult,
  AuditStatus,
  PlanBuildOptions,
  PlanBuildResult,
  RiskSummary,
  PlanSummary,
  ExecuteRunOptions,
  ExecutionResult,
  ExecutionTimelineEntry,
  VerificationResult,
  PostRebootStatus,
  MonitorStatus,
  MonitorAlert,
  ReportListEntry,
  ReportExportOptions,
  ReportExportResult,
  SystemInfo,
  ProductInfo,
  AuditProgressEvent,
  ExecutionProgressEvent,
  ExecutionStepEvent,
  MonitorAlertEvent,
  SessionUpdateEvent,
} from '../main/ipc/channels';

// Import channel names
const CHANNELS = {
  // Audit
  AUDIT_RUN: 'audit.run',
  AUDIT_GET_STATUS: 'audit.getStatus',
  AUDIT_CANCEL: 'audit.cancel',

  // Plan
  PLAN_BUILD_WITH_LANES: 'plan.buildWithLanes',
  PLAN_GET_RISK_SUMMARY: 'plan.getRiskSummary',
  PLAN_GET_CURRENT: 'plan.getCurrent',

  // Execute
  EXECUTE_RUN: 'execute.run',
  EXECUTE_GET_TIMELINE: 'execute.getTimeline',
  EXECUTE_CANCEL: 'execute.cancel',

  // Verify
  VERIFY_RUN: 'verify.run',
  VERIFY_GET_RESULTS: 'verify.getResults',
  VERIFY_POST_REBOOT_STATUS: 'verify.postRebootStatus',

  // Monitor
  MONITOR_ENABLE: 'monitor.enable',
  MONITOR_DISABLE: 'monitor.disable',
  MONITOR_GET_STATUS: 'monitor.getStatus',
  MONITOR_RUN_CHECK: 'monitor.runCheck',
  MONITOR_ACKNOWLEDGE_ALERT: 'monitor.acknowledgeAlert',
  MONITOR_CLEAR_ALERTS: 'monitor.clearAlerts',

  // Report
  REPORT_LIST: 'report.list',
  REPORT_GET: 'report.get',
  REPORT_EXPORT: 'report.export',
  REPORT_DELETE: 'report.delete',
  REPORT_COPY_HASH: 'report.copyHash',

  // Session
  SESSION_GET_CURRENT: 'session.getCurrent',
  SESSION_GET_HISTORY: 'session.getHistory',

  // Product
  PRODUCT_LIST: 'product.list',
  PRODUCT_GET: 'product.get',

  // System
  SYSTEM_GET_INFO: 'system.getInfo',
  SYSTEM_CHECK_ADMIN: 'system.checkAdmin',
  SYSTEM_GET_LOG_PATH: 'system.getLogPath',
  SYSTEM_OPEN_LOG_FOLDER: 'system.openLogFolder',

  // Migration
  MIGRATION_CHECK: 'migration.check',
  MIGRATION_RUN: 'migration.run',
  MIGRATION_CLEANUP: 'migration.cleanup',

  // Events
  EVENT_AUDIT_PROGRESS: 'event.audit.progress',
  EVENT_EXECUTION_PROGRESS: 'event.execution.progress',
  EVENT_EXECUTION_STEP: 'event.execution.step',
  EVENT_MONITOR_ALERT: 'event.monitor.alert',
  EVENT_SESSION_UPDATE: 'event.session.update',
} as const;

/**
 * Type-safe cleanup function
 */
type CleanupFunction = () => void;

/**
 * Sentinel API exposed to renderer
 */
const sentinelAPI = {
  // ============================================================================
  // Audit Operations
  // ============================================================================

  audit: {
    /**
     * Run audit scan for a product
     */
    run: (options: AuditRunOptions): Promise<AuditResult> =>
      ipcRenderer.invoke(CHANNELS.AUDIT_RUN, options),

    /**
     * Get current audit status
     */
    getStatus: (): Promise<AuditStatus> =>
      ipcRenderer.invoke(CHANNELS.AUDIT_GET_STATUS),

    /**
     * Cancel running audit
     */
    cancel: (): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke(CHANNELS.AUDIT_CANCEL),

    /**
     * Subscribe to audit progress events
     */
    onProgress: (callback: (event: AuditProgressEvent) => void): CleanupFunction => {
      const handler = (_: Electron.IpcRendererEvent, data: AuditProgressEvent) => callback(data);
      ipcRenderer.on(CHANNELS.EVENT_AUDIT_PROGRESS, handler);
      return () => ipcRenderer.removeListener(CHANNELS.EVENT_AUDIT_PROGRESS, handler);
    },
  },

  // ============================================================================
  // Plan Operations
  // ============================================================================

  plan: {
    /**
     * Build plans with lane partitioning
     */
    buildWithLanes: (options: PlanBuildOptions): Promise<PlanBuildResult> =>
      ipcRenderer.invoke(CHANNELS.PLAN_BUILD_WITH_LANES, options),

    /**
     * Get risk summary for session
     */
    getRiskSummary: (sessionId: string): Promise<RiskSummary | null> =>
      ipcRenderer.invoke(CHANNELS.PLAN_GET_RISK_SUMMARY, sessionId),

    /**
     * Get current plans for session
     */
    getCurrent: (sessionId: string): Promise<{ autopilot?: PlanSummary; assisted: PlanSummary } | null> =>
      ipcRenderer.invoke(CHANNELS.PLAN_GET_CURRENT, sessionId),
  },

  // ============================================================================
  // Execute Operations
  // ============================================================================

  execute: {
    /**
     * Run execution with selected lane
     */
    run: (options: ExecuteRunOptions): Promise<ExecutionResult> =>
      ipcRenderer.invoke(CHANNELS.EXECUTE_RUN, options),

    /**
     * Get execution timeline
     */
    getTimeline: (sessionId: string): Promise<ExecutionTimelineEntry[]> =>
      ipcRenderer.invoke(CHANNELS.EXECUTE_GET_TIMELINE, sessionId),

    /**
     * Cancel running execution
     */
    cancel: (): Promise<{ cancelled: boolean }> =>
      ipcRenderer.invoke(CHANNELS.EXECUTE_CANCEL),

    /**
     * Subscribe to execution progress events
     */
    onProgress: (callback: (event: ExecutionProgressEvent) => void): CleanupFunction => {
      const handler = (_: Electron.IpcRendererEvent, data: ExecutionProgressEvent) => callback(data);
      ipcRenderer.on(CHANNELS.EVENT_EXECUTION_PROGRESS, handler);
      return () => ipcRenderer.removeListener(CHANNELS.EVENT_EXECUTION_PROGRESS, handler);
    },

    /**
     * Subscribe to execution step events
     */
    onStep: (callback: (event: ExecutionStepEvent) => void): CleanupFunction => {
      const handler = (_: Electron.IpcRendererEvent, data: ExecutionStepEvent) => callback(data);
      ipcRenderer.on(CHANNELS.EVENT_EXECUTION_STEP, handler);
      return () => ipcRenderer.removeListener(CHANNELS.EVENT_EXECUTION_STEP, handler);
    },
  },

  // ============================================================================
  // Verify Operations
  // ============================================================================

  verify: {
    /**
     * Run verification
     */
    run: (sessionId: string): Promise<VerificationResult> =>
      ipcRenderer.invoke(CHANNELS.VERIFY_RUN, sessionId),

    /**
     * Get verification results
     */
    getResults: (sessionId: string): Promise<VerificationResult | null> =>
      ipcRenderer.invoke(CHANNELS.VERIFY_GET_RESULTS, sessionId),

    /**
     * Get post-reboot verification status
     */
    getPostRebootStatus: (sessionId: string): Promise<PostRebootStatus | null> =>
      ipcRenderer.invoke(CHANNELS.VERIFY_POST_REBOOT_STATUS, sessionId),
  },

  // ============================================================================
  // Monitor Operations
  // ============================================================================

  monitor: {
    /**
     * Enable monitoring
     */
    enable: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_ENABLE, sessionId),

    /**
     * Disable monitoring
     */
    disable: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_DISABLE),

    /**
     * Get monitoring status
     */
    getStatus: (): Promise<MonitorStatus> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_GET_STATUS),

    /**
     * Run a manual check
     */
    runCheck: (): Promise<{ success: boolean; alerts?: MonitorAlert[]; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_RUN_CHECK),

    /**
     * Acknowledge an alert
     */
    acknowledgeAlert: (alertId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_ACKNOWLEDGE_ALERT, alertId),

    /**
     * Clear all alerts
     */
    clearAlerts: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MONITOR_CLEAR_ALERTS),

    /**
     * Subscribe to monitor alert events
     */
    onAlert: (callback: (event: MonitorAlertEvent) => void): CleanupFunction => {
      const handler = (_: Electron.IpcRendererEvent, data: MonitorAlertEvent) => callback(data);
      ipcRenderer.on(CHANNELS.EVENT_MONITOR_ALERT, handler);
      return () => ipcRenderer.removeListener(CHANNELS.EVENT_MONITOR_ALERT, handler);
    },
  },

  // ============================================================================
  // Report Operations
  // ============================================================================

  report: {
    /**
     * List all reports
     */
    list: (): Promise<ReportListEntry[]> =>
      ipcRenderer.invoke(CHANNELS.REPORT_LIST),

    /**
     * Get a specific report
     */
    get: (sessionId: string): Promise<unknown> =>
      ipcRenderer.invoke(CHANNELS.REPORT_GET, sessionId),

    /**
     * Export a report
     */
    export: (options: ReportExportOptions): Promise<ReportExportResult> =>
      ipcRenderer.invoke(CHANNELS.REPORT_EXPORT, options),

    /**
     * Delete a report
     */
    delete: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.REPORT_DELETE, sessionId),

    /**
     * Copy report hash to clipboard
     */
    copyHash: (sessionId: string): Promise<{ success: boolean; hash?: string; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.REPORT_COPY_HASH, sessionId),
  },

  // ============================================================================
  // Product Operations
  // ============================================================================

  product: {
    /**
     * List available products
     */
    list: (): Promise<ProductInfo[]> =>
      ipcRenderer.invoke(CHANNELS.PRODUCT_LIST),

    /**
     * Get product details
     */
    get: (productId: string): Promise<ProductInfo | null> =>
      ipcRenderer.invoke(CHANNELS.PRODUCT_GET, productId),
  },

  // ============================================================================
  // System Operations
  // ============================================================================

  system: {
    /**
     * Get system information
     */
    getInfo: (): Promise<SystemInfo> =>
      ipcRenderer.invoke(CHANNELS.SYSTEM_GET_INFO),

    /**
     * Check admin privileges
     */
    checkAdmin: (): Promise<{ elevated: boolean }> =>
      ipcRenderer.invoke(CHANNELS.SYSTEM_CHECK_ADMIN),

    /**
     * Get log path
     */
    getLogPath: (): Promise<{ path: string }> =>
      ipcRenderer.invoke(CHANNELS.SYSTEM_GET_LOG_PATH),

    /**
     * Open log folder
     */
    openLogFolder: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.SYSTEM_OPEN_LOG_FOLDER),
  },

  // ============================================================================
  // Migration Operations
  // ============================================================================

  migration: {
    /**
     * Check for legacy data that can be migrated
     */
    check: (): Promise<{
      legacyDataExists: boolean;
      legacyPath: string;
      newPath: string;
      alreadyMigrated: boolean;
      itemsToMigrate: {
        directories: string[];
        files: string[];
        totalSessions: number;
        totalReports: number;
      };
    }> => ipcRenderer.invoke(CHANNELS.MIGRATION_CHECK),

    /**
     * Run migration from legacy data path
     */
    run: (options?: { dryRun?: boolean }): Promise<{
      success: boolean;
      migrated: {
        directories: string[];
        files: string[];
        sessionCount: number;
        reportCount: number;
      };
      errors: string[];
      warnings: string[];
    }> => ipcRenderer.invoke(CHANNELS.MIGRATION_RUN, options),

    /**
     * Remove legacy data after migration (requires user confirmation)
     */
    cleanup: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.MIGRATION_CLEANUP),
  },

  // ============================================================================
  // Session Events
  // ============================================================================

  session: {
    /**
     * Subscribe to session update events
     */
    onUpdate: (callback: (event: SessionUpdateEvent) => void): CleanupFunction => {
      const handler = (_: Electron.IpcRendererEvent, data: SessionUpdateEvent) => callback(data);
      ipcRenderer.on(CHANNELS.EVENT_SESSION_UPDATE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.EVENT_SESSION_UPDATE, handler);
    },
  },
};

// Expose API to renderer
contextBridge.exposeInMainWorld('sentinel', sentinelAPI);

// Type declaration for renderer
declare global {
  interface Window {
    sentinel: typeof sentinelAPI;
  }
}
