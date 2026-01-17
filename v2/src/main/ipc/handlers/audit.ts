/**
 * Audit IPC Handlers
 *
 * Handles audit operations: run, get status, cancel.
 * Audit is read-only scanning of vendor artifacts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import {
  IPC_CHANNELS,
  type AuditRunOptions,
  type AuditResult,
  type AuditStatus,
  type AuditProgressEvent,
} from '../channels';
import {
  createVendorScanners,
  createSystemScanners,
  type ScanContext,
} from '../../core/acquisition/scanners';
import type { ProductDefinition } from '../../../../shared/types';

// ============================================================================
// State
// ============================================================================

interface AuditState {
  running: boolean;
  sessionId?: string;
  progress: number;
  currentStep: string;
  cancelled: boolean;
}

let currentAudit: AuditState = {
  running: false,
  progress: 0,
  currentStep: '',
  cancelled: false,
};

// Store for session data (in real app, would use persistence layer)
const sessionStore = new Map<string, {
  productId: string;
  snapshot: unknown;
  artifactCounts: {
    processes: number;
    services: number;
    tasks: number;
    files: number;
    registry: number;
    wmi: number;
  };
}>();

// ============================================================================
// Helpers
// ============================================================================

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

function sendProgress(event: AuditProgressEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.EVENT_AUDIT_PROGRESS, event);
  }
}

function updateProgress(
  sessionId: string,
  progress: number,
  currentStep: string,
  artifactsFound: number,
): void {
  currentAudit.progress = progress;
  currentAudit.currentStep = currentStep;

  sendProgress({
    sessionId,
    progress,
    currentStep,
    artifactsFound,
  });
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Run audit scan
 */
async function handleAuditRun(
  _event: Electron.IpcMainInvokeEvent,
  options: AuditRunOptions,
): Promise<AuditResult> {
  // Prevent concurrent audits
  if (currentAudit.running) {
    return {
      success: false,
      error: 'Audit already in progress',
    };
  }

  const sessionId = `session_${randomUUID()}`;

  try {
    currentAudit = {
      running: true,
      sessionId,
      progress: 0,
      currentStep: 'Initializing',
      cancelled: false,
    };

    updateProgress(sessionId, 5, 'Initializing scanners', 0);

    // Create scanners
    const vendorScanners = createVendorScanners();
    const systemScanners = createSystemScanners();

    // Create scan context
    // In real implementation, would load product definition from registry
    const scanContext: ScanContext = {
      productId: options.productId,
      productName: options.productId, // Simplified
      paths: [], // Would come from product definition
      registryPaths: [],
      processPatterns: [],
      servicePatterns: [],
      taskPatterns: [],
    };

    const counts = {
      processes: 0,
      services: 0,
      tasks: 0,
      files: 0,
      registry: 0,
      wmi: 0,
    };

    let totalArtifacts = 0;

    // Check for cancellation between steps
    const checkCancelled = (): boolean => {
      if (currentAudit.cancelled) {
        throw new Error('Audit cancelled by user');
      }
      return false;
    };

    // Scan processes
    updateProgress(sessionId, 10, 'Scanning processes', totalArtifacts);
    checkCancelled();
    const processResult = await vendorScanners.process.scan(scanContext);
    counts.processes = processResult.artifacts.length;
    totalArtifacts += counts.processes;

    // Scan services
    updateProgress(sessionId, 25, 'Scanning services', totalArtifacts);
    checkCancelled();
    const serviceResult = await vendorScanners.service.scan(scanContext);
    counts.services = serviceResult.artifacts.length;
    totalArtifacts += counts.services;

    // Scan scheduled tasks
    updateProgress(sessionId, 40, 'Scanning scheduled tasks', totalArtifacts);
    checkCancelled();
    const taskResult = await vendorScanners.task.scan(scanContext);
    counts.tasks = taskResult.artifacts.length;
    totalArtifacts += counts.tasks;

    // Scan filesystem
    updateProgress(sessionId, 55, 'Scanning filesystem', totalArtifacts);
    checkCancelled();
    const fileResult = await vendorScanners.filesystem.scan(scanContext);
    counts.files = fileResult.artifacts.length;
    totalArtifacts += counts.files;

    // Scan registry
    updateProgress(sessionId, 70, 'Scanning registry', totalArtifacts);
    checkCancelled();
    const registryResult = await vendorScanners.registry.scan(scanContext);
    counts.registry = registryResult.artifacts.length;
    totalArtifacts += counts.registry;

    // Scan WMI subscriptions
    updateProgress(sessionId, 85, 'Scanning WMI subscriptions', totalArtifacts);
    checkCancelled();
    const wmiResult = await vendorScanners.wmi.scan(scanContext);
    counts.wmi = wmiResult.artifacts.length;
    totalArtifacts += counts.wmi;

    // Scan system-wide artifacts (for risk assessment)
    updateProgress(sessionId, 95, 'Scanning system state', totalArtifacts);
    checkCancelled();
    await systemScanners.defender.scan({} as ScanContext);
    await systemScanners.network.scan({} as ScanContext);

    updateProgress(sessionId, 100, 'Complete', totalArtifacts);

    // Store session data
    sessionStore.set(sessionId, {
      productId: options.productId,
      snapshot: {
        processes: processResult.artifacts,
        services: serviceResult.artifacts,
        tasks: taskResult.artifacts,
        files: fileResult.artifacts,
        registry: registryResult.artifacts,
        wmi: wmiResult.artifacts,
      },
      artifactCounts: counts,
    });

    currentAudit.running = false;

    return {
      success: true,
      sessionId,
      summary: {
        processCount: counts.processes,
        serviceCount: counts.services,
        taskCount: counts.tasks,
        fileCount: counts.files,
        registryCount: counts.registry,
        wmiCount: counts.wmi,
        totalArtifacts,
      },
    };
  } catch (error) {
    currentAudit.running = false;

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get audit status
 */
async function handleAuditGetStatus(): Promise<AuditStatus> {
  return {
    running: currentAudit.running,
    sessionId: currentAudit.sessionId,
    progress: currentAudit.progress,
    currentStep: currentAudit.currentStep,
  };
}

/**
 * Cancel running audit
 */
async function handleAuditCancel(): Promise<{ cancelled: boolean }> {
  if (!currentAudit.running) {
    return { cancelled: false };
  }

  currentAudit.cancelled = true;
  return { cancelled: true };
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all audit IPC handlers
 */
export function registerAuditHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AUDIT_RUN, handleAuditRun);
  ipcMain.handle(IPC_CHANNELS.AUDIT_GET_STATUS, handleAuditGetStatus);
  ipcMain.handle(IPC_CHANNELS.AUDIT_CANCEL, handleAuditCancel);
}

/**
 * Get session data (for use by other handlers)
 */
export function getSessionData(sessionId: string) {
  return sessionStore.get(sessionId);
}

/**
 * Store session data (for use by other handlers)
 */
export function setSessionData(sessionId: string, data: unknown): void {
  const existing = sessionStore.get(sessionId);
  if (existing) {
    sessionStore.set(sessionId, { ...existing, ...data } as typeof existing);
  }
}
