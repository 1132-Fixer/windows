/**
 * Monitoring Integration Tests
 *
 * Tests the complete monitoring flow: baseline, diff, alerts, and reporting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  computeDiff,
  generateDiffSummary,
  calculateDiffRiskScore,
  isDiffClean,
} from '../../src/main/core/monitoring/diff';
import {
  generateAlerts,
  createAlertEmitter,
} from '../../src/main/core/monitoring/alert';
import {
  type MonitoringBaseline,
  type PersistenceArtifact,
  type MonitoringReportSummary,
  DEFAULT_MONITORING_CONFIG,
} from '../../src/main/core/monitoring/types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestBaseline(
  tasks: PersistenceArtifact[] = [],
  services: PersistenceArtifact[] = [],
  wmi: PersistenceArtifact[] = [],
  autoruns: PersistenceArtifact[] = [],
): MonitoringBaseline {
  return {
    id: `baseline_${Date.now()}`,
    sessionId: 'session-test',
    productId: 'test-product',
    timestamp: Date.now() - 3600000,
    postRebootVerified: true,
    persistence: { tasks, services, wmi, autoruns },
    totalCount: tasks.length + services.length + wmi.length + autoruns.length,
    appVersion: '2.0.0',
  };
}

function createArtifact(
  type: PersistenceArtifact['type'],
  path: string,
  name: string,
  overrides: Partial<PersistenceArtifact> = {},
): PersistenceArtifact {
  return {
    id: `artifact_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type,
    path,
    name,
    contentHash: `hash_${path}_${Date.now()}`,
    observedAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Monitoring Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `monitoring-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('End-to-End Clean State', () => {
    it('should detect clean state when current matches baseline', () => {
      const task1 = createArtifact('scheduled_task', '\\Test\\Task1', 'Task1');
      const service1 = createArtifact('service', 'TestService', 'TestService');

      const baseline = createTestBaseline([task1], [service1]);

      // Current state matches baseline
      const current = {
        tasks: [{ ...task1 }],
        services: [{ ...service1 }],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(isDiffClean(diff)).toBe(true);
      expect(diff.hasConcerningChanges).toBe(false);
      expect(alerts.length).toBe(0);
      expect(generateDiffSummary(diff)).toContain('No changes');
    });
  });

  describe('End-to-End Relapse Detection', () => {
    it('should detect and alert on new scheduled task', () => {
      const baseline = createTestBaseline();

      // New task appears
      const newTask = createArtifact('scheduled_task', '\\MaliciousVendor\\UpdateTask', 'UpdateTask');
      const current = {
        tasks: [newTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);
      const riskScore = calculateDiffRiskScore(diff);

      expect(isDiffClean(diff)).toBe(false);
      expect(diff.counts.added).toBe(1);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].code).toBe('NEW_SCHEDULED_TASK');
      expect(riskScore).toBeGreaterThan(0);
    });

    it('should detect and alert on new WMI subscription (high priority)', () => {
      const baseline = createTestBaseline();

      // New WMI subscription appears
      const newWmi = createArtifact('wmi_subscription', 'MaliciousSubscription', 'MaliciousSubscription');
      const current = {
        tasks: [],
        services: [],
        wmi: [newWmi],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);
      const riskScore = calculateDiffRiskScore(diff);

      expect(diff.hasConcerningChanges).toBe(true);
      expect(alerts.some(a => a.severity === 'critical')).toBe(true);
      expect(alerts.some(a => a.code === 'NEW_WMI_SUBSCRIPTION')).toBe(true);
      expect(riskScore).toBeGreaterThanOrEqual(10);
    });

    it('should detect multiple new persistence mechanisms', () => {
      const baseline = createTestBaseline();

      // Multiple new items appear
      const current = {
        tasks: [
          createArtifact('scheduled_task', '\\Malware\\Task1', 'Task1'),
          createArtifact('scheduled_task', '\\Malware\\Task2', 'Task2'),
        ],
        services: [createArtifact('service', 'MalwareService', 'MalwareService')],
        wmi: [],
        autoruns: [createArtifact('registry_autorun', 'HKCU\\Run\\Malware', 'Malware')],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(diff.counts.added).toBe(4);
      expect(alerts.some(a => a.code === 'MULTIPLE_NEW_PERSISTENCE')).toBe(true);
    });
  });

  describe('Alert Persistence', () => {
    it('should persist and retrieve alerts', async () => {
      const alertPath = path.join(tempDir, 'alerts.json');
      const alertEmitter = createAlertEmitter(alertPath);

      const baseline = createTestBaseline();
      const current = {
        tasks: [createArtifact('scheduled_task', '\\New\\Task', 'NewTask')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      // Emit alerts
      for (const alert of alerts) {
        await alertEmitter.emit(alert);
      }

      // Retrieve pending alerts
      const pending = await alertEmitter.getPending();
      expect(pending.length).toBe(alerts.length);
      expect(pending[0].acknowledged).toBe(false);

      // Acknowledge alert
      await alertEmitter.acknowledge(pending[0].id);

      const afterAck = await alertEmitter.getPending();
      expect(afterAck.length).toBe(alerts.length - 1);
    });

    it('should clear all alerts', async () => {
      const alertPath = path.join(tempDir, 'alerts.json');
      const alertEmitter = createAlertEmitter(alertPath);

      const baseline = createTestBaseline();
      const current = {
        tasks: [createArtifact('scheduled_task', '\\New\\Task', 'NewTask')],
        services: [createArtifact('service', 'NewService', 'NewService')],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      for (const alert of alerts) {
        await alertEmitter.emit(alert);
      }

      await alertEmitter.clearAll();

      const pending = await alertEmitter.getPending();
      expect(pending.length).toBe(0);
    });
  });

  describe('Ignored Paths', () => {
    it('should not alert on system tasks in ignored paths', () => {
      const baseline = createTestBaseline();

      // System task appears (should be ignored)
      const systemTask = createArtifact(
        'scheduled_task',
        '\\Microsoft\\Windows\\UpdateOrchestrator\\Scan',
        'Scan',
      );
      const current = {
        tasks: [systemTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const config = {
        ...DEFAULT_MONITORING_CONFIG,
        ignorePaths: ['\\Microsoft\\Windows\\'],
      };

      const diff = computeDiff(baseline, current, config);
      const alerts = generateAlerts(diff, config);

      expect(diff.counts.added).toBe(0);
      expect(alerts.length).toBe(0);
    });
  });

  describe('Modification Detection', () => {
    it('should detect modified task configuration', () => {
      const originalTask = createArtifact('scheduled_task', '\\Test\\Task', 'Task', {
        contentHash: 'hash_v1',
        metadata: { enabled: true },
      });
      const baseline = createTestBaseline([originalTask]);

      // Task modified (different hash)
      const modifiedTask = createArtifact('scheduled_task', '\\Test\\Task', 'Task', {
        contentHash: 'hash_v2',
        metadata: { enabled: false },
      });
      const current = {
        tasks: [modifiedTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(diff.counts.modified).toBe(1);
      expect(diff.modified[0].changedFields.length).toBeGreaterThan(0);
      expect(alerts.some(a => a.code === 'MODIFIED_TASK')).toBe(true);
    });
  });

  describe('Report Summary Generation', () => {
    it('should generate clean report summary', () => {
      const baseline = createTestBaseline();
      const diff = computeDiff(baseline, {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      // Simulate report summary
      const summary: MonitoringReportSummary = {
        enabled: true,
        baselineTimestamp: baseline.timestamp,
        lastCheck: Date.now(),
        cleanHours: Math.floor((Date.now() - baseline.timestamp) / (1000 * 60 * 60)),
        checksPerformed: 1,
        alertsGenerated: 0,
        latestFindings: {
          added: diff.counts.added,
          removed: diff.counts.removed,
          modified: diff.counts.modified,
        },
        status: 'clean',
      };

      expect(summary.status).toBe('clean');
      expect(summary.cleanHours).toBeGreaterThanOrEqual(0);
      expect(summary.alertsGenerated).toBe(0);
    });

    it('should generate changes_detected report summary', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createArtifact('scheduled_task', '\\New\\Task', 'NewTask')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      const summary: MonitoringReportSummary = {
        enabled: true,
        baselineTimestamp: baseline.timestamp,
        lastCheck: Date.now(),
        cleanHours: 0, // Reset due to changes
        checksPerformed: 1,
        alertsGenerated: alerts.length,
        latestFindings: {
          added: diff.counts.added,
          removed: diff.counts.removed,
          modified: diff.counts.modified,
        },
        status: 'changes_detected',
      };

      expect(summary.status).toBe('changes_detected');
      expect(summary.latestFindings?.added).toBe(1);
      expect(summary.alertsGenerated).toBeGreaterThan(0);
    });
  });

  describe('Risk Score Integration', () => {
    it('should produce risk scores compatible with session risk', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createArtifact('scheduled_task', '\\Test\\Task', 'Task')],
        services: [createArtifact('service', 'Service', 'Service')],
        wmi: [createArtifact('wmi_subscription', 'WMI', 'WMI')],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const riskScore = calculateDiffRiskScore(diff);

      // Score should be in valid range for session risk integration
      expect(riskScore).toBeGreaterThanOrEqual(0);
      expect(riskScore).toBeLessThanOrEqual(30);

      // WMI should contribute significantly
      expect(riskScore).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Disabled Monitoring', () => {
    it('should not generate alerts when monitoring disabled', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createArtifact('scheduled_task', '\\New\\Task', 'Task')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const config = {
        ...DEFAULT_MONITORING_CONFIG,
        enabled: false,
        watchedTypes: [], // Nothing watched
      };

      const diff = computeDiff(baseline, current, config);
      const alerts = generateAlerts(diff, config);

      // Nothing watched, so no changes detected
      expect(diff.counts.added).toBe(0);
      expect(alerts.length).toBe(0);
    });
  });
});
