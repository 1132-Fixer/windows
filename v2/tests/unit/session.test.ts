/**
 * Session Module Unit Tests
 *
 * Tests for report building, redaction, and schema validation.
 */

import { describe, it, expect } from 'vitest';
import type { Plan, ProductDefinition, Snapshot } from '../../src/shared/types';
import type { ExecutionResult } from '../../src/main/core/execution/types';
import type { VerificationResult } from '../../src/main/core/verification/types';
import type { SessionOptions, AttestationReport } from '../../src/main/core/session/types';
import {
  buildReport,
  validateReportIntegrity,
} from '../../src/main/core/session/report-builder';
import {
  redactPath,
  redactUsername,
  redactHostname,
  redactSecrets,
  redactReport,
  checkReportSafety,
  createPublicSummary,
} from '../../src/main/core/session/redaction';
import {
  validateReport,
  parseReport,
} from '../../src/main/core/session/report-schema';
import {
  stableStringify,
  computeHash,
} from '../../src/main/core/session/persistence';

// Test fixtures
function createTestProduct(): ProductDefinition {
  return {
    id: 'test-product',
    name: 'Test Product',
    vendor: 'Test Vendor',
    installPaths: ['C:\\Program Files\\TestProduct'],
    registryKeys: ['HKLM\\SOFTWARE\\TestVendor\\TestProduct'],
    processNames: ['testapp.exe'],
    serviceNames: ['TestService'],
    taskPaths: ['\\TestVendor\\'],
  };
}

function createTestSnapshot(id: string): Snapshot {
  return {
    id,
    productId: 'test-product',
    capturedAt: Date.now(),
    filesystem: {
      files: [
        {
          path: 'C:\\Program Files\\TestProduct\\app.exe',
          exists: true,
          isDirectory: false,
          size: 1024,
        },
      ],
      scanDuration: 100,
    },
    registry: {
      keys: [
        {
          path: 'HKLM\\SOFTWARE\\TestVendor\\TestProduct',
          exists: true,
          values: {},
          subkeys: [],
        },
      ],
      scanDuration: 50,
    },
    processes: {
      running: [
        {
          pid: 1234,
          name: 'testapp.exe',
          executablePath: 'C:\\Program Files\\TestProduct\\app.exe',
        },
      ],
      scanDuration: 10,
    },
    services: {
      installed: [],
      scanDuration: 10,
    },
    tasks: {
      scheduled: [],
      scanDuration: 10,
    },
  };
}

function createTestPlan(): Plan {
  return {
    id: 'test-plan-001',
    productId: 'test-product',
    createdAt: Date.now(),
    boundaries: {
      allowedPaths: ['C:\\Program Files\\TestProduct'],
      allowedRegistryPrefixes: ['HKLM\\SOFTWARE\\TestVendor\\TestProduct'],
      allowedTasks: ['\\TestVendor\\'],
    },
    steps: [
      {
        id: 'step-1',
        action: 'StopProcess',
        target: 'testapp.exe',
        reason: 'Process is running',
      },
      {
        id: 'step-2',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        reason: 'Installation folder',
      },
    ],
    metadata: {
      scanDuration: 100,
      correlatorVersion: '1.0.0',
    },
  };
}

function createTestExecution(): ExecutionResult {
  return {
    planId: 'test-plan-001',
    success: true,
    stepResults: [
      {
        stepId: 'step-1',
        action: 'StopProcess',
        target: 'testapp.exe',
        status: 'success',
        message: 'Process terminated',
        before: { count: 1 },
        after: { count: 0 },
        durationMs: 50,
      },
      {
        stepId: 'step-2',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        status: 'success',
        message: 'Folder removed',
        before: { exists: true },
        after: { exists: false },
        durationMs: 100,
      },
    ],
    events: [],
    startedAt: Date.now() - 200,
    completedAt: Date.now(),
    dryRun: false,
  };
}

function createTestVerification(): VerificationResult {
  return {
    passed: true,
    results: [
      {
        invariantName: 'NoVendorProcesses',
        passed: true,
        severity: 'standard',
      },
      {
        invariantName: 'PlanPromisesHeld',
        passed: true,
        severity: 'standard',
      },
    ],
    diff: {
      added: [],
      removed: ['C:\\Program Files\\TestProduct'],
      changed: [],
    },
  };
}

function createTestOptions(): SessionOptions {
  return {
    includeAllUsers: false,
    includeNetworkObserver: false,
    dryRun: false,
    preserveUserSettings: true,
    continueOnFailure: false,
    quarantineFiles: true,
    verifySteps: true,
  };
}

describe('Report Builder', () => {
  describe('buildReport', () => {
    it('should build a valid report for successful execution', () => {
      const report = buildReport({
        sessionId: 'session-001',
        product: createTestProduct(),
        mode: 'clean',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-001'),
        plan: createTestPlan(),
        execution: createTestExecution(),
        postSnapshot: createTestSnapshot('post-001'),
        verification: createTestVerification(),
        timing: {
          startedAt: Date.now() - 1000,
          preSnapshotAt: Date.now() - 900,
          planBuiltAt: Date.now() - 800,
          executionStartedAt: Date.now() - 700,
          executionCompletedAt: Date.now() - 500,
          postSnapshotAt: Date.now() - 400,
          verificationAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: true,
      });

      expect(report.schemaVersion).toBe('1.0.0');
      expect(report.status).toBe('pass');
      expect(report.sessionId).toBe('session-001');
      expect(report.product.id).toBe('test-product');
      expect(report.execution).not.toBeNull();
      expect(report.verification).not.toBeNull();
      expect(report.integrity.contentHash).toBeTruthy();
    });

    it('should build a report for audit mode (no execution)', () => {
      const report = buildReport({
        sessionId: 'session-002',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-002'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      expect(report.status).toBe('pass');
      expect(report.execution).toBeNull();
      expect(report.postSnapshot).toBeNull();
      expect(report.verification).toBeNull();
    });

    it('should set status to fail when verification fails', () => {
      const failedVerification: VerificationResult = {
        passed: false,
        results: [
          {
            invariantName: 'NoOutOfScopeDamage',
            passed: false,
            severity: 'critical',
            message: 'Out of scope removal detected',
          },
        ],
        diff: { added: [], removed: [], changed: [] },
      };

      const report = buildReport({
        sessionId: 'session-003',
        product: createTestProduct(),
        mode: 'clean',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-003'),
        plan: createTestPlan(),
        execution: createTestExecution(),
        postSnapshot: createTestSnapshot('post-003'),
        verification: failedVerification,
        timing: {
          startedAt: Date.now() - 1000,
          preSnapshotAt: Date.now() - 900,
          planBuiltAt: Date.now() - 800,
          completedAt: Date.now(),
        },
        elevated: true,
      });

      expect(report.status).toBe('fail');
      expect(report.statusReason).toContain('Critical invariant');
    });

    it('should set status to warn for non-critical verification failures', () => {
      const warnVerification: VerificationResult = {
        passed: false,
        results: [
          {
            invariantName: 'NoOrphanedReferences',
            passed: false,
            severity: 'advisory',
            message: 'Some orphaned references found',
          },
        ],
        diff: { added: [], removed: [], changed: [] },
      };

      const report = buildReport({
        sessionId: 'session-004',
        product: createTestProduct(),
        mode: 'clean',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-004'),
        plan: createTestPlan(),
        execution: createTestExecution(),
        postSnapshot: createTestSnapshot('post-004'),
        verification: warnVerification,
        timing: {
          startedAt: Date.now() - 1000,
          preSnapshotAt: Date.now() - 900,
          planBuiltAt: Date.now() - 800,
          completedAt: Date.now(),
        },
        elevated: true,
      });

      expect(report.status).toBe('warn');
    });

    it('should include advisories for dry run', () => {
      const dryRunOptions = { ...createTestOptions(), dryRun: true };

      const report = buildReport({
        sessionId: 'session-005',
        product: createTestProduct(),
        mode: 'clean',
        options: dryRunOptions,
        preSnapshot: createTestSnapshot('pre-005'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      const dryRunAdvisory = report.advisories.find(a => a.code === 'DRY_RUN');
      expect(dryRunAdvisory).toBeDefined();
    });
  });

  describe('validateReportIntegrity', () => {
    it('should return true for unmodified report', () => {
      const report = buildReport({
        sessionId: 'session-006',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-006'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      expect(validateReportIntegrity(report)).toBe(true);
    });

    it('should return false for tampered report', () => {
      const report = buildReport({
        sessionId: 'session-007',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-007'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      // Tamper with the report
      report.status = 'pass';
      report.statusReason = 'Tampered';

      expect(validateReportIntegrity(report)).toBe(false);
    });
  });
});

describe('Redaction', () => {
  describe('redactPath', () => {
    it('should redact username in Windows paths', () => {
      const username = process.env.USERNAME || 'user';
      const path = `C:\\Users\\${username}\\AppData\\Local\\TestApp`;

      const redacted = redactPath(path);

      expect(redacted).not.toContain(username);
      expect(redacted).toContain('%USERNAME%');
    });

    it('should handle paths without username', () => {
      const path = 'C:\\Program Files\\TestApp';

      const redacted = redactPath(path);

      expect(redacted).toBe(path);
    });
  });

  describe('redactSecrets', () => {
    it('should redact API keys', () => {
      const text = 'api_key=sk_live_12345abcdef';

      const redacted = redactSecrets(text);

      expect(redacted).toContain('[REDACTED_KEY]');
      expect(redacted).not.toContain('sk_live');
    });

    it('should redact JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const text = `Bearer ${jwt}`;

      const redacted = redactSecrets(text);

      expect(redacted).toContain('[REDACTED_JWT]');
      expect(redacted).not.toContain('eyJ');
    });

    it('should redact email addresses', () => {
      const text = 'Contact: user@example.com';

      const redacted = redactSecrets(text);

      expect(redacted).toContain('[REDACTED_EMAIL]');
      expect(redacted).not.toContain('user@example.com');
    });
  });

  describe('redactReport', () => {
    it('should mark report as redacted', () => {
      const report = buildReport({
        sessionId: 'session-008',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-008'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      const redacted = redactReport(report);

      expect(redacted.redacted).toBe(true);
      expect(redacted.environment.username).toBe('%USERNAME%');
      expect(redacted.environment.hostname).toBe('%COMPUTERNAME%');
    });

    it('should not modify original report', () => {
      const report = buildReport({
        sessionId: 'session-009',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-009'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      const originalUsername = report.environment.username;
      redactReport(report);

      expect(report.environment.username).toBe(originalUsername);
    });
  });

  describe('createPublicSummary', () => {
    it('should create a minimal safe summary', () => {
      const report = buildReport({
        sessionId: 'session-010',
        product: createTestProduct(),
        mode: 'clean',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-010'),
        plan: createTestPlan(),
        execution: createTestExecution(),
        postSnapshot: createTestSnapshot('post-010'),
        verification: createTestVerification(),
        timing: {
          startedAt: Date.now() - 1000,
          preSnapshotAt: Date.now() - 900,
          planBuiltAt: Date.now() - 800,
          completedAt: Date.now(),
        },
        elevated: true,
      });

      const summary = createPublicSummary(report);

      expect(summary.status).toBe('pass');
      expect(summary.productName).toBe('Test Product');
      expect(summary.mode).toBe('clean');
      expect(summary.stepsExecuted).toBe(2);
    });
  });
});

describe('Report Schema', () => {
  describe('validateReport', () => {
    it('should validate a well-formed report', () => {
      const report = buildReport({
        sessionId: 'session-011',
        product: createTestProduct(),
        mode: 'audit',
        options: createTestOptions(),
        preSnapshot: createTestSnapshot('pre-011'),
        plan: createTestPlan(),
        execution: null,
        postSnapshot: null,
        verification: null,
        timing: {
          startedAt: Date.now() - 500,
          preSnapshotAt: Date.now() - 400,
          planBuiltAt: Date.now() - 300,
          completedAt: Date.now(),
        },
        elevated: false,
      });

      const result = validateReport(report);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject invalid report', () => {
      const invalidReport = {
        schemaVersion: '2.0.0', // Invalid version
        reportId: 'test',
      };

      const result = validateReport(invalidReport);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });
});

describe('Persistence Utilities', () => {
  describe('stableStringify', () => {
    it('should produce deterministic output', () => {
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { a: 1, c: 3, b: 2 };

      expect(stableStringify(obj1)).toBe(stableStringify(obj2));
    });

    it('should handle nested objects', () => {
      const obj1 = { z: { b: 2, a: 1 }, y: 1 };
      const obj2 = { y: 1, z: { a: 1, b: 2 } };

      expect(stableStringify(obj1)).toBe(stableStringify(obj2));
    });
  });

  describe('computeHash', () => {
    it('should produce consistent hashes', () => {
      const content = 'test content';

      const hash1 = computeHash(content);
      const hash2 = computeHash(content);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = computeHash('content1');
      const hash2 = computeHash('content2');

      expect(hash1).not.toBe(hash2);
    });
  });
});
