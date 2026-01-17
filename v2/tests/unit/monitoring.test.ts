/**
 * Monitoring Unit Tests
 *
 * Tests for persistence monitoring - diff logic, alerting, and risk scoring.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDiff,
  generateDiffSummary,
  calculateDiffRiskScore,
  isDiffClean,
  getMostConcerning,
} from '../../src/main/core/monitoring/diff';
import {
  generateAlerts,
  formatTrayNotification,
  formatBanner,
  formatReportEntry,
  getDetailedMessage,
} from '../../src/main/core/monitoring/alert';
import {
  type MonitoringBaseline,
  type PersistenceArtifact,
  type MonitoringConfig,
  DEFAULT_MONITORING_CONFIG,
} from '../../src/main/core/monitoring/types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestBaseline(overrides: Partial<MonitoringBaseline> = {}): MonitoringBaseline {
  return {
    id: 'baseline-test',
    sessionId: 'session-test',
    productId: 'test-product',
    timestamp: Date.now() - 3600000, // 1 hour ago
    postRebootVerified: true,
    persistence: {
      tasks: [],
      services: [],
      wmi: [],
      autoruns: [],
    },
    totalCount: 0,
    appVersion: '2.0.0',
    ...overrides,
  };
}

function createTestArtifact(
  type: PersistenceArtifact['type'],
  path: string,
  name: string,
  overrides: Partial<PersistenceArtifact> = {},
): PersistenceArtifact {
  return {
    id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    path,
    name,
    contentHash: `hash_${path}`,
    observedAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// Diff Logic Tests
// ============================================================================

describe('Diff Logic', () => {
  describe('computeDiff', () => {
    it('should detect no changes when current matches baseline', () => {
      const task = createTestArtifact('scheduled_task', '\\Test\\Task1', 'Task1');
      const baseline = createTestBaseline({
        persistence: {
          tasks: [task],
          services: [],
          wmi: [],
          autoruns: [],
        },
        totalCount: 1,
      });

      const current = {
        tasks: [{ ...task }], // Same task
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);

      expect(diff.counts.added).toBe(0);
      expect(diff.counts.removed).toBe(0);
      expect(diff.counts.modified).toBe(0);
      expect(diff.hasConcerningChanges).toBe(false);
    });

    it('should detect added artifacts', () => {
      const baseline = createTestBaseline();

      const newTask = createTestArtifact('scheduled_task', '\\NewVendor\\Task', 'NewTask');
      const current = {
        tasks: [newTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);

      expect(diff.counts.added).toBe(1);
      expect(diff.added[0].path).toBe('\\NewVendor\\Task');
      expect(diff.hasConcerningChanges).toBe(true);
    });

    it('should detect removed artifacts', () => {
      const existingTask = createTestArtifact('scheduled_task', '\\Test\\Task', 'Task');
      const baseline = createTestBaseline({
        persistence: {
          tasks: [existingTask],
          services: [],
          wmi: [],
          autoruns: [],
        },
        totalCount: 1,
      });

      const current = {
        tasks: [], // Task removed
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);

      expect(diff.counts.removed).toBe(1);
      expect(diff.removed[0].path).toBe('\\Test\\Task');
      // Removed items don't trigger concern (informational only)
      expect(diff.hasConcerningChanges).toBe(false);
    });

    it('should detect modified artifacts', () => {
      const task = createTestArtifact('scheduled_task', '\\Test\\Task', 'Task', {
        contentHash: 'hash_v1',
      });
      const baseline = createTestBaseline({
        persistence: {
          tasks: [task],
          services: [],
          wmi: [],
          autoruns: [],
        },
      });

      const modifiedTask = createTestArtifact('scheduled_task', '\\Test\\Task', 'Task', {
        contentHash: 'hash_v2', // Different hash
        metadata: { enabled: false }, // Changed
      });
      const current = {
        tasks: [modifiedTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);

      expect(diff.counts.modified).toBe(1);
      expect(diff.modified[0].path).toBe('\\Test\\Task');
    });

    it('should respect ignore paths', () => {
      const baseline = createTestBaseline();

      const systemTask = createTestArtifact('scheduled_task', '\\Microsoft\\Windows\\Update', 'Update');
      const current = {
        tasks: [systemTask],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const config: MonitoringConfig = {
        ...DEFAULT_MONITORING_CONFIG,
        ignorePaths: ['\\Microsoft\\Windows\\'],
      };

      const diff = computeDiff(baseline, current, config);

      expect(diff.counts.added).toBe(0); // Ignored
    });

    it('should skip unwatched types', () => {
      const baseline = createTestBaseline();

      const newService = createTestArtifact('service', 'NewService', 'New Service');
      const current = {
        tasks: [],
        services: [newService],
        wmi: [],
        autoruns: [],
      };

      const config: MonitoringConfig = {
        ...DEFAULT_MONITORING_CONFIG,
        watchedTypes: ['scheduled_task'], // Only watching tasks
      };

      const diff = computeDiff(baseline, current, config);

      expect(diff.counts.added).toBe(0); // Service not watched
    });
  });

  describe('isDiffClean', () => {
    it('should return true for empty diff', () => {
      const diff = computeDiff(createTestBaseline(), {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      expect(isDiffClean(diff)).toBe(true);
    });

    it('should return false when items added', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createTestArtifact('scheduled_task', '\\New\\Task', 'NewTask')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);

      expect(isDiffClean(diff)).toBe(false);
    });

    it('should return true when only items removed (informational)', () => {
      const task = createTestArtifact('scheduled_task', '\\Test\\Task', 'Task');
      const baseline = createTestBaseline({
        persistence: {
          tasks: [task],
          services: [],
          wmi: [],
          autoruns: [],
        },
      });

      const diff = computeDiff(baseline, {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      // Removed items don't make diff "dirty"
      expect(isDiffClean(diff)).toBe(true);
    });
  });

  describe('generateDiffSummary', () => {
    it('should generate clean summary', () => {
      const diff = computeDiff(createTestBaseline(), {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      const summary = generateDiffSummary(diff);

      expect(summary).toContain('No changes detected');
    });

    it('should describe added items', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [
          createTestArtifact('scheduled_task', '\\Test\\Task1', 'Task1'),
          createTestArtifact('scheduled_task', '\\Test\\Task2', 'Task2'),
        ],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const summary = generateDiffSummary(diff);

      expect(summary).toContain('2 new scheduled tasks');
    });
  });

  describe('getMostConcerning', () => {
    it('should prioritize WMI over other types', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createTestArtifact('scheduled_task', '\\Test\\Task', 'Task')],
        services: [createTestArtifact('service', 'TestService', 'TestService')],
        wmi: [createTestArtifact('wmi_subscription', 'TestWMI', 'TestWMI')],
        autoruns: [createTestArtifact('registry_autorun', 'HKCU\\Run\\Test', 'Test')],
      };

      const diff = computeDiff(baseline, current);
      const concerning = getMostConcerning(diff, 2);

      expect(concerning[0].type).toBe('wmi_subscription');
      expect(concerning[1].type).toBe('service');
    });
  });
});

// ============================================================================
// Risk Score Tests
// ============================================================================

describe('Risk Scoring', () => {
  describe('calculateDiffRiskScore', () => {
    it('should return 0 for clean diff', () => {
      const diff = computeDiff(createTestBaseline(), {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      expect(calculateDiffRiskScore(diff)).toBe(0);
    });

    it('should score WMI subscriptions highest', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [],
        services: [],
        wmi: [createTestArtifact('wmi_subscription', 'MaliciousWMI', 'MaliciousWMI')],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const score = calculateDiffRiskScore(diff);

      expect(score).toBeGreaterThanOrEqual(10);
    });

    it('should score services moderately', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [],
        services: [createTestArtifact('service', 'NewService', 'NewService')],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const score = calculateDiffRiskScore(diff);

      expect(score).toBeGreaterThanOrEqual(5);
      expect(score).toBeLessThan(10);
    });

    it('should cap at 30', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: Array.from({ length: 10 }, (_, i) =>
          createTestArtifact('scheduled_task', `\\Test\\Task${i}`, `Task${i}`)
        ),
        services: Array.from({ length: 10 }, (_, i) =>
          createTestArtifact('service', `Service${i}`, `Service${i}`)
        ),
        wmi: Array.from({ length: 5 }, (_, i) =>
          createTestArtifact('wmi_subscription', `WMI${i}`, `WMI${i}`)
        ),
        autoruns: Array.from({ length: 10 }, (_, i) =>
          createTestArtifact('registry_autorun', `HKCU\\Run\\Auto${i}`, `Auto${i}`)
        ),
      };

      const diff = computeDiff(baseline, current);
      const score = calculateDiffRiskScore(diff);

      expect(score).toBe(30);
    });
  });
});

// ============================================================================
// Alert Generation Tests
// ============================================================================

describe('Alert Generation', () => {
  describe('generateAlerts', () => {
    it('should generate no alerts for clean diff', () => {
      const diff = computeDiff(createTestBaseline(), {
        tasks: [],
        services: [],
        wmi: [],
        autoruns: [],
      });

      const alerts = generateAlerts(diff);

      expect(alerts.length).toBe(0);
    });

    it('should generate critical alert for WMI subscription', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [],
        services: [],
        wmi: [createTestArtifact('wmi_subscription', 'MaliciousWMI', 'Malicious')],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(alerts.some(a => a.code === 'NEW_WMI_SUBSCRIPTION')).toBe(true);
      expect(alerts.find(a => a.code === 'NEW_WMI_SUBSCRIPTION')?.severity).toBe('critical');
    });

    it('should generate warning for new service', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [],
        services: [createTestArtifact('service', 'NewService', 'NewService')],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(alerts.some(a => a.code === 'NEW_SERVICE')).toBe(true);
    });

    it('should generate compound alert for multiple items', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [
          createTestArtifact('scheduled_task', '\\Test\\Task1', 'Task1'),
          createTestArtifact('scheduled_task', '\\Test\\Task2', 'Task2'),
        ],
        services: [createTestArtifact('service', 'Service1', 'Service1')],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);

      expect(alerts.some(a => a.code === 'MULTIPLE_NEW_PERSISTENCE')).toBe(true);
    });
  });

  describe('formatTrayNotification', () => {
    it('should format alert for tray', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createTestArtifact('scheduled_task', '\\Test\\Task', 'Task')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);
      const notification = formatTrayNotification(alerts[0]);

      expect(notification.title).toBeDefined();
      expect(notification.body).toBeDefined();
      expect(notification.body.length).toBeLessThanOrEqual(203); // 200 + ...
    });
  });

  describe('formatBanner', () => {
    it('should format alert for banner', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [],
        services: [createTestArtifact('service', 'NewService', 'NewService')],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);
      const banner = formatBanner(alerts[0]);

      expect(banner.text).toBeDefined();
      expect(['info', 'warning', 'error']).toContain(banner.severity);
      expect(banner.actionText).toBeDefined();
    });
  });

  describe('formatReportEntry', () => {
    it('should format alert for report', () => {
      const baseline = createTestBaseline();
      const current = {
        tasks: [createTestArtifact('scheduled_task', '\\Test\\Task', 'Task')],
        services: [],
        wmi: [],
        autoruns: [],
      };

      const diff = computeDiff(baseline, current);
      const alerts = generateAlerts(diff);
      const entry = formatReportEntry(alerts[0]);

      expect(entry.timestamp).toBeDefined();
      expect(entry.severity).toBeDefined();
      expect(entry.code).toBeDefined();
      expect(entry.artifactCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getDetailedMessage', () => {
    it('should provide detailed messages for all codes', () => {
      const codes = [
        'NEW_SCHEDULED_TASK',
        'NEW_SERVICE',
        'NEW_WMI_SUBSCRIPTION',
        'NEW_REGISTRY_AUTORUN',
        'MODIFIED_TASK',
        'MODIFIED_SERVICE',
        'MULTIPLE_NEW_PERSISTENCE',
        'HIGH_RISK_PERSISTENCE',
      ] as const;

      for (const code of codes) {
        const message = getDetailedMessage(code);
        expect(message.length).toBeGreaterThan(20);
      }
    });
  });
});

// ============================================================================
// Concern Assessment Tests
// ============================================================================

describe('Concern Assessment', () => {
  it('should mark WMI as concerning', () => {
    const baseline = createTestBaseline();
    const current = {
      tasks: [],
      services: [],
      wmi: [createTestArtifact('wmi_subscription', 'Test', 'Test')],
      autoruns: [],
    };

    const diff = computeDiff(baseline, current);
    expect(diff.hasConcerningChanges).toBe(true);
  });

  it('should mark new services as concerning', () => {
    const baseline = createTestBaseline();
    const current = {
      tasks: [],
      services: [createTestArtifact('service', 'Test', 'Test')],
      wmi: [],
      autoruns: [],
    };

    const diff = computeDiff(baseline, current);
    expect(diff.hasConcerningChanges).toBe(true);
  });

  it('should mark 3+ new items as concerning', () => {
    const baseline = createTestBaseline();
    const current = {
      tasks: [
        createTestArtifact('scheduled_task', '\\Test1', 'Test1'),
        createTestArtifact('scheduled_task', '\\Test2', 'Test2'),
        createTestArtifact('scheduled_task', '\\Test3', 'Test3'),
      ],
      services: [],
      wmi: [],
      autoruns: [],
    };

    const diff = computeDiff(baseline, current);
    expect(diff.hasConcerningChanges).toBe(true);
  });

  it('should not mark removed items as concerning', () => {
    const task = createTestArtifact('scheduled_task', '\\Test\\Task', 'Task');
    const baseline = createTestBaseline({
      persistence: {
        tasks: [task],
        services: [],
        wmi: [],
        autoruns: [],
      },
    });

    const diff = computeDiff(baseline, {
      tasks: [],
      services: [],
      wmi: [],
      autoruns: [],
    });

    expect(diff.hasConcerningChanges).toBe(false);
  });
});

// ============================================================================
// Default Config Tests
// ============================================================================

describe('Default Config', () => {
  it('should have monitoring disabled by default (opt-in)', () => {
    expect(DEFAULT_MONITORING_CONFIG.enabled).toBe(false);
  });

  it('should watch all persistence types by default', () => {
    expect(DEFAULT_MONITORING_CONFIG.watchedTypes).toContain('scheduled_task');
    expect(DEFAULT_MONITORING_CONFIG.watchedTypes).toContain('service');
    expect(DEFAULT_MONITORING_CONFIG.watchedTypes).toContain('wmi_subscription');
    expect(DEFAULT_MONITORING_CONFIG.watchedTypes).toContain('registry_autorun');
  });

  it('should have reasonable default interval', () => {
    expect(DEFAULT_MONITORING_CONFIG.intervalHours).toBe(12);
  });

  it('should include common system paths in ignore list', () => {
    expect(DEFAULT_MONITORING_CONFIG.ignorePaths.some(p =>
      p.toLowerCase().includes('microsoft\\windows')
    )).toBe(true);
  });
});
