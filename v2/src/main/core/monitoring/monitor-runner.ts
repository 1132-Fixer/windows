/**
 * Monitor Runner
 *
 * Orchestrates periodic monitoring checks:
 * 1. Load baseline
 * 2. Re-scan persistence surfaces
 * 3. Compute diff
 * 4. Generate alerts if needed
 * 5. Feed findings to risk engine
 *
 * EXECUTION:
 * - Scheduled Task (opt-in)
 * - Trigger: once every X hours (default: 12h)
 * - Action: CleanStateSentinel.exe --monitor
 *
 * NO REMEDIATION. READ-ONLY.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type {
  MonitorRunner,
  MonitoringState,
  MonitoringCheckResult,
  MonitoringConfig,
  MonitoringReportSummary,
  MonitoringBaseline,
  PersistenceArtifact,
  PersistenceType,
  MonitoringAlert,
} from './types';
import { DEFAULT_MONITORING_CONFIG } from './types';
import { createBaselineManager } from './baseline';
import { computeDiff, generateDiffSummary, calculateDiffRiskScore, isDiffClean } from './diff';
import { generateAlerts, createAlertEmitter } from './alert';
import { getAppDataPath, DATA_PATHS, TASK_NAMES, PRODUCT } from '../../../shared/branding';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default state file path
 */
function getDefaultStatePath(): string {
  return path.join(getAppDataPath(), DATA_PATHS.MONITORING, 'state.json');
}

/**
 * Task name for scheduled monitoring
 */
const MONITOR_TASK_NAME = TASK_NAMES.MONITORING;
const MONITOR_TASK_FOLDER = `\\${PRODUCT.SHORT_NAME}\\`;

// ============================================================================
// Current State Scanner
// ============================================================================

/**
 * Scan current persistence surfaces
 */
async function scanCurrentPersistence(): Promise<{
  tasks: PersistenceArtifact[];
  services: PersistenceArtifact[];
  wmi: PersistenceArtifact[];
  autoruns: PersistenceArtifact[];
}> {
  // Import scanners
  const { TaskScanner } = await import('../acquisition/scanners/task.scanner');
  const { ServiceScanner } = await import('../acquisition/scanners/service.scanner');
  const { WMIScanner } = await import('../acquisition/scanners/wmi.scanner');
  const { RegistryScanner } = await import('../acquisition/scanners/registry.scanner');

  const taskScanner = new TaskScanner();
  const serviceScanner = new ServiceScanner();
  const wmiScanner = new WMIScanner();
  const registryScanner = new RegistryScanner();

  // Scan all persistence surfaces
  const allTasks = await taskScanner.getAllTasks();
  const tasks: PersistenceArtifact[] = allTasks.map(t => ({
    id: `task_${crypto.randomUUID()}`,
    type: 'scheduled_task' as PersistenceType,
    path: `${t.path}${t.name}`,
    name: t.name,
    contentHash: computeContentHash({
      path: t.path,
      name: t.name,
      enabled: t.enabled,
      actions: t.actions,
    }),
    observedAt: Date.now(),
    metadata: {
      enabled: t.enabled,
      state: t.state,
      author: t.author,
      actions: t.actions,
      triggers: t.triggers,
      hidden: t.hidden,
    },
  }));

  const allServices = await serviceScanner.getAllServices();
  const services: PersistenceArtifact[] = allServices.map(s => ({
    id: `service_${crypto.randomUUID()}`,
    type: 'service' as PersistenceType,
    path: s.name,
    name: s.displayName || s.name,
    contentHash: computeContentHash({
      name: s.name,
      startType: s.startType,
      imagePath: s.imagePath,
    }),
    observedAt: Date.now(),
    metadata: {
      name: s.name,
      displayName: s.displayName,
      startType: s.startType,
      state: s.state,
      imagePath: s.imagePath,
    },
  }));

  const allWmi = await wmiScanner.getAllSubscriptions();
  const wmi: PersistenceArtifact[] = allWmi.map(w => ({
    id: `wmi_${crypto.randomUUID()}`,
    type: 'wmi_subscription' as PersistenceType,
    path: w.name,
    name: w.name,
    contentHash: computeContentHash({
      name: w.name,
      query: w.filter?.query,
      consumer: w.consumer?.name,
    }),
    observedAt: Date.now(),
    metadata: {
      name: w.name,
      filterName: w.filter?.name,
      filterQuery: w.filter?.query,
      consumerName: w.consumer?.name,
      consumerType: w.consumer?.type,
    },
  }));

  // Get registry autoruns
  const autorunKeys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  ];

  const autoruns: PersistenceArtifact[] = [];
  for (const keyPath of autorunKeys) {
    try {
      const values = await registryScanner.getKeyValues(keyPath);
      for (const value of values) {
        autoruns.push({
          id: `autorun_${crypto.randomUUID()}`,
          type: 'registry_autorun',
          path: `${keyPath}\\${value.name}`,
          name: value.name,
          contentHash: computeContentHash({
            path: keyPath,
            name: value.name,
            data: value.data,
          }),
          observedAt: Date.now(),
          metadata: {
            keyPath,
            valueName: value.name,
            valueData: value.data,
            valueType: value.type,
          },
        });
      }
    } catch {
      // Key may not exist or be inaccessible
    }
  }

  return { tasks, services, wmi, autoruns };
}

/**
 * Compute content hash for change detection
 */
function computeContentHash(obj: Record<string, unknown>): string {
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

// ============================================================================
// State Persistence
// ============================================================================

/**
 * Load monitoring state from disk
 */
async function loadState(filePath: string): Promise<MonitoringState | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Save monitoring state to disk
 */
async function saveState(filePath: string, state: MonitoringState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ============================================================================
// Scheduled Task Management
// ============================================================================

/**
 * Create monitoring scheduled task
 */
async function createMonitoringTask(intervalHours: number): Promise<boolean> {
  const appPath = process.execPath;
  const command = `"${appPath}" --monitor`;

  return new Promise((resolve) => {
    const proc = spawn('schtasks.exe', [
      '/Create',
      '/TN', `${MONITOR_TASK_FOLDER}${MONITOR_TASK_NAME}`,
      '/TR', command,
      '/SC', 'HOURLY',
      '/MO', String(intervalHours),
      '/RL', 'LIMITED',
      '/F',
    ], {
      windowsHide: true,
      shell: false,
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Delete monitoring scheduled task
 */
async function deleteMonitoringTask(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('schtasks.exe', [
      '/Delete',
      '/TN', `${MONITOR_TASK_FOLDER}${MONITOR_TASK_NAME}`,
      '/F',
    ], {
      windowsHide: true,
      shell: false,
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

// ============================================================================
// Monitor Runner Implementation
// ============================================================================

/**
 * Create a monitor runner
 */
export function createMonitorRunner(
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
  statePath?: string,
): MonitorRunner {
  const stateFilePath = statePath ?? getDefaultStatePath();
  const baselineManager = createBaselineManager();
  const alertEmitter = createAlertEmitter();

  /**
   * Get default empty state
   */
  function getDefaultState(): MonitoringState {
    return {
      active: false,
      baseline: null,
      lastCheck: null,
      lastDiff: null,
      pendingAlerts: [],
      checkHistory: [],
      cleanHours: 0,
    };
  }

  return {
    /**
     * Run a single monitoring check
     */
    async runCheck(): Promise<MonitoringCheckResult> {
      const startTime = Date.now();
      const checkId = `check_${startTime}_${crypto.randomBytes(4).toString('hex')}`;

      // Load baseline
      const baseline = await baselineManager.load();
      if (!baseline) {
        return {
          id: checkId,
          timestamp: startTime,
          durationMs: Date.now() - startTime,
          foundConcerningChanges: false,
          summary: 'No baseline found. Monitoring skipped.',
          newPersistenceCount: 0,
          alertIds: [],
        };
      }

      // Scan current state
      const current = await scanCurrentPersistence();

      // Compute diff
      const diff = computeDiff(baseline, current, config);

      // Generate alerts if needed
      const alerts: MonitoringAlert[] = [];
      if (diff.hasConcerningChanges) {
        const newAlerts = generateAlerts(diff, config);
        for (const alert of newAlerts) {
          await alertEmitter.emit(alert);
          alerts.push(alert);
        }
      }

      // Update state
      const state = (await loadState(stateFilePath)) ?? getDefaultState();
      state.lastCheck = startTime;
      state.lastDiff = diff;
      state.pendingAlerts = await alertEmitter.getPending();

      // Calculate clean hours
      if (isDiffClean(diff)) {
        const hoursSinceBaseline = (startTime - baseline.timestamp) / (1000 * 60 * 60);
        state.cleanHours = Math.floor(hoursSinceBaseline);
      } else {
        state.cleanHours = 0;
      }

      // Add to check history (keep last 50)
      const checkResult: MonitoringCheckResult = {
        id: checkId,
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        foundConcerningChanges: diff.hasConcerningChanges,
        summary: generateDiffSummary(diff),
        newPersistenceCount: diff.added.length,
        alertIds: alerts.map(a => a.id),
      };

      state.checkHistory = [checkResult, ...state.checkHistory].slice(0, 50);

      await saveState(stateFilePath, state);

      return checkResult;
    },

    /**
     * Get current monitoring state
     */
    async getState(): Promise<MonitoringState> {
      const state = await loadState(stateFilePath);
      if (!state) {
        return getDefaultState();
      }

      // Update baseline from disk
      state.baseline = await baselineManager.load();
      state.pendingAlerts = await alertEmitter.getPending();

      return state;
    },

    /**
     * Enable monitoring
     */
    async enable(customConfig?: Partial<MonitoringConfig>): Promise<void> {
      const finalConfig = { ...config, ...customConfig };

      // Create scheduled task
      await createMonitoringTask(finalConfig.intervalHours);

      // Update state
      const state = (await loadState(stateFilePath)) ?? getDefaultState();
      state.active = true;
      await saveState(stateFilePath, state);
    },

    /**
     * Disable monitoring
     */
    async disable(): Promise<void> {
      // Delete scheduled task
      await deleteMonitoringTask();

      // Update state
      const state = (await loadState(stateFilePath)) ?? getDefaultState();
      state.active = false;
      await saveState(stateFilePath, state);
    },

    /**
     * Acknowledge an alert
     */
    async acknowledgeAlert(alertId: string): Promise<void> {
      await alertEmitter.acknowledge(alertId);

      // Update state
      const state = (await loadState(stateFilePath)) ?? getDefaultState();
      state.pendingAlerts = await alertEmitter.getPending();
      await saveState(stateFilePath, state);
    },

    /**
     * Get report summary
     */
    async getReportSummary(): Promise<MonitoringReportSummary> {
      const state = await this.getState();
      const baseline = await baselineManager.load();

      // Calculate clean hours
      let cleanHours = 0;
      if (baseline && state.lastDiff && isDiffClean(state.lastDiff)) {
        const hoursSinceBaseline = (Date.now() - baseline.timestamp) / (1000 * 60 * 60);
        cleanHours = Math.floor(hoursSinceBaseline);
      }

      // Determine status
      let status: 'clean' | 'changes_detected' | 'not_monitored' = 'not_monitored';
      if (state.active && baseline) {
        if (state.lastDiff && !state.lastDiff.hasConcerningChanges) {
          status = 'clean';
        } else if (state.lastDiff?.hasConcerningChanges) {
          status = 'changes_detected';
        }
      }

      return {
        enabled: state.active,
        baselineTimestamp: baseline?.timestamp ?? null,
        lastCheck: state.lastCheck,
        cleanHours,
        checksPerformed: state.checkHistory.length,
        alertsGenerated: state.checkHistory.reduce((sum, c) => sum + c.alertIds.length, 0),
        latestFindings: state.lastDiff
          ? {
              added: state.lastDiff.counts.added,
              removed: state.lastDiff.counts.removed,
              modified: state.lastDiff.counts.modified,
            }
          : null,
        status,
      };
    },
  };
}

// ============================================================================
// Risk Engine Integration
// ============================================================================

/**
 * Get risk score contribution from monitoring state
 *
 * Returns a score 0-30 to add to session risk
 */
export async function getMonitoringRiskContribution(
  runner: MonitorRunner,
): Promise<{
  score: number;
  reason: string;
}> {
  const state = await runner.getState();

  if (!state.active || !state.lastDiff) {
    return { score: 0, reason: 'Monitoring not active' };
  }

  const riskScore = calculateDiffRiskScore(state.lastDiff);

  if (riskScore === 0) {
    return { score: 0, reason: 'No persistence changes detected' };
  }

  return {
    score: riskScore,
    reason: `${state.lastDiff.added.length} new persistence mechanism(s) detected since last clean`,
  };
}
