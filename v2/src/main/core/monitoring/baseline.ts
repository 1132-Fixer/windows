/**
 * Monitoring Baseline
 *
 * Captures and persists a baseline snapshot of persistence surfaces
 * after a verified clean state.
 *
 * WHEN TO CAPTURE:
 * - After successful verification
 * - After successful post-reboot verification
 *
 * WHAT TO CAPTURE:
 * - Scheduled Tasks
 * - Services
 * - WMI Permanent Event Subscriptions
 * - Registry Autoruns (HKCU\Run, HKLM\Run)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  MonitoringBaseline,
  PersistenceArtifact,
  PersistenceType,
  BaselineManager,
} from './types';
import { getAppDataPath, DATA_PATHS, PRODUCT } from '../../../shared/branding';

// ============================================================================
// Configuration
// ============================================================================

/**
 * App version for baseline compatibility
 */
const APP_VERSION = PRODUCT.VERSION;

/**
 * Default storage path
 */
export function getDefaultBaselinePath(): string {
  return path.join(getAppDataPath(), DATA_PATHS.MONITORING);
}

/**
 * Baseline filename
 */
const BASELINE_FILENAME = 'baseline.json';

// ============================================================================
// Artifact Conversion Utilities
// ============================================================================

/**
 * Compute content hash for change detection
 */
function computeContentHash(artifact: Record<string, unknown>): string {
  // Sort keys for deterministic hashing
  const sortedContent = JSON.stringify(artifact, Object.keys(artifact).sort());
  return crypto.createHash('sha256').update(sortedContent).digest('hex').slice(0, 16);
}

/**
 * Convert a task artifact to persistence artifact
 */
export function taskToPersistenceArtifact(task: {
  id: string;
  path?: string;
  metadata?: Record<string, unknown>;
  observedAt: number;
}): PersistenceArtifact {
  const metadata = task.metadata || {};
  return {
    id: task.id,
    type: 'scheduled_task',
    path: task.path || String(metadata.path || ''),
    name: String(metadata.name || task.path || 'Unknown Task'),
    contentHash: computeContentHash({
      path: task.path,
      enabled: metadata.enabled,
      actions: metadata.actions,
      triggers: metadata.triggers,
    }),
    observedAt: task.observedAt,
    metadata: {
      enabled: metadata.enabled,
      state: metadata.state,
      author: metadata.author,
      actions: metadata.actions,
    },
  };
}

/**
 * Convert a service artifact to persistence artifact
 */
export function serviceToPersistenceArtifact(service: {
  id: string;
  path?: string;
  metadata?: Record<string, unknown>;
  observedAt: number;
}): PersistenceArtifact {
  const metadata = service.metadata || {};
  return {
    id: service.id,
    type: 'service',
    path: String(metadata.name || service.path || ''),
    name: String(metadata.displayName || metadata.name || 'Unknown Service'),
    contentHash: computeContentHash({
      name: metadata.name,
      startType: metadata.startType,
      imagePath: metadata.imagePath,
    }),
    observedAt: service.observedAt,
    metadata: {
      name: metadata.name,
      displayName: metadata.displayName,
      startType: metadata.startType,
      state: metadata.state,
      imagePath: metadata.imagePath,
    },
  };
}

/**
 * Convert a WMI subscription artifact to persistence artifact
 */
export function wmiToPersistenceArtifact(wmi: {
  id: string;
  path?: string;
  metadata?: Record<string, unknown>;
  observedAt: number;
}): PersistenceArtifact {
  const metadata = wmi.metadata || {};
  return {
    id: wmi.id,
    type: 'wmi_subscription',
    path: String(metadata.name || wmi.path || ''),
    name: String(metadata.name || 'Unknown WMI Subscription'),
    contentHash: computeContentHash({
      name: metadata.name,
      query: metadata.query,
      consumer: metadata.consumer,
    }),
    observedAt: wmi.observedAt,
    metadata: {
      name: metadata.name,
      query: metadata.query,
      consumer: metadata.consumer,
      type: metadata.type,
    },
  };
}

/**
 * Convert a registry autorun artifact to persistence artifact
 */
export function autorunToPersistenceArtifact(reg: {
  id: string;
  path?: string;
  metadata?: Record<string, unknown>;
  observedAt: number;
}): PersistenceArtifact {
  const metadata = reg.metadata || {};
  return {
    id: reg.id,
    type: 'registry_autorun',
    path: reg.path || '',
    name: String(metadata.valueName || reg.path || 'Unknown Autorun'),
    contentHash: computeContentHash({
      path: reg.path,
      valueName: metadata.valueName,
      valueData: metadata.valueData,
    }),
    observedAt: reg.observedAt,
    metadata: {
      valueName: metadata.valueName,
      valueData: metadata.valueData,
      valueType: metadata.valueType,
    },
  };
}

// ============================================================================
// Baseline Manager Implementation
// ============================================================================

/**
 * Create a baseline manager
 */
export function createBaselineManager(
  storagePath?: string,
): BaselineManager {
  const basePath = storagePath ?? getDefaultBaselinePath();
  const baselineFilePath = path.join(basePath, BASELINE_FILENAME);

  /**
   * Ensure storage directory exists
   */
  async function ensureDir(): Promise<void> {
    await fs.mkdir(basePath, { recursive: true });
  }

  return {
    /**
     * Capture a new baseline from current system state
     */
    async capture(
      sessionId: string,
      productId: string,
      postRebootVerified: boolean,
    ): Promise<MonitoringBaseline> {
      // Import scanners lazily to avoid circular dependencies
      const { TaskScanner } = await import('../acquisition/scanners/task.scanner');
      const { ServiceScanner } = await import('../acquisition/scanners/service.scanner');
      const { WMIScanner } = await import('../acquisition/scanners/wmi.scanner');
      const { RegistryScanner } = await import('../acquisition/scanners/registry.scanner');

      const taskScanner = new TaskScanner();
      const serviceScanner = new ServiceScanner();
      const wmiScanner = new WMIScanner();
      const registryScanner = new RegistryScanner();

      // Scan persistence surfaces
      // Note: We scan ALL tasks/services/etc, not just vendor-specific ones
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
        },
      }));

      // Get all services
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

      // Get all WMI subscriptions
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

      // Get registry autoruns (Run keys)
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

      const baseline: MonitoringBaseline = {
        id: `baseline_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        sessionId,
        productId,
        timestamp: Date.now(),
        postRebootVerified,
        persistence: {
          tasks,
          services,
          wmi,
          autoruns,
        },
        totalCount: tasks.length + services.length + wmi.length + autoruns.length,
        appVersion: APP_VERSION,
      };

      // Save baseline
      await this.save(baseline);

      return baseline;
    },

    /**
     * Load the current baseline from disk
     */
    async load(): Promise<MonitoringBaseline | null> {
      try {
        const content = await fs.readFile(baselineFilePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Save a baseline to disk
     */
    async save(baseline: MonitoringBaseline): Promise<void> {
      await ensureDir();
      await fs.writeFile(baselineFilePath, JSON.stringify(baseline, null, 2), 'utf-8');
    },

    /**
     * Delete the baseline
     */
    async delete(): Promise<boolean> {
      try {
        await fs.unlink(baselineFilePath);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Check if a baseline exists
     */
    async exists(): Promise<boolean> {
      try {
        await fs.access(baselineFilePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
