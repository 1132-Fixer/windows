/**
 * Post-Reboot Scheduler Unit Tests
 *
 * Tests for post-reboot verification scheduling and execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  createContextPersistence,
  type ContextPersistence,
} from '../../src/main/core/verification/post-reboot/context-persistence';
import {
  type PostRebootVerificationContext,
  type PostRebootVerificationResult,
  type ExpectedAbsentArtifact,
  DEFAULT_SCHEDULE_CONFIG,
  getTaskName,
  getContextIdFromTaskName,
  TASK_NAME_PREFIX,
} from '../../src/main/core/verification/post-reboot/types';
import type { ProductDefinition } from '../../src/main/core/acquisition/types';

// ============================================================================
// Test Fixtures
// ============================================================================

const testProduct: ProductDefinition = {
  id: 'test-product',
  vendor: 'Test Vendor',
  displayName: 'Test Product',
  paths: {
    install: ['C:\\Program Files\\TestProduct'],
    appData: ['%APPDATA%\\TestProduct'],
    programData: ['%PROGRAMDATA%\\TestProduct'],
    logs: [],
    temp: [],
  },
  registry: {
    software: ['HKCU\\SOFTWARE\\TestProduct'],
    uninstall: [],
    services: [],
    other: [],
  },
  processes: ['testapp.exe'],
  services: ['TestService'],
  tasks: ['\\TestProduct\\'],
};

function createTestContext(overrides: Partial<PostRebootVerificationContext> = {}): PostRebootVerificationContext {
  const now = Date.now();
  return {
    contextId: `test_${now}_abc123`,
    sessionId: `session-${now}`,
    product: testProduct,
    planId: `plan-${now}`,
    scheduledAt: now,
    preSnapshotId: `snapshot-pre-${now}`,
    postSnapshotId: `snapshot-post-${now}`,
    expectedAbsent: [
      { type: 'file', path: 'C:\\Program Files\\TestProduct\\app.exe', wasRemoved: true },
      { type: 'registry', path: 'HKCU\\SOFTWARE\\TestProduct', wasRemoved: true },
    ],
    maxRetries: 3,
    retryCount: 0,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
    ...overrides,
  };
}

function createTestResult(contextId: string, overrides: Partial<PostRebootVerificationResult> = {}): PostRebootVerificationResult {
  return {
    contextId,
    sessionId: `session-${Date.now()}`,
    verifiedAt: Date.now(),
    result: {
      status: 'pass',
      checks: [],
      verifiedAt: Date.now(),
    },
    persistenceChecks: [
      {
        type: 'file',
        path: 'C:\\Program Files\\TestProduct\\app.exe',
        expectedState: 'absent',
        actualState: 'absent',
        passed: true,
      },
    ],
    artifactsReappeared: false,
    reappearedArtifacts: [],
    verdict: 'clean',
    summary: 'Post-reboot verification: 1/1 checks passed. System is clean.',
    ...overrides,
  };
}

// ============================================================================
// Context Persistence Tests
// ============================================================================

describe('ContextPersistence', () => {
  let tempDir: string;
  let persistence: ContextPersistence;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = path.join(os.tmpdir(), `post-reboot-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    persistence = createContextPersistence({ storagePath: tempDir });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveContext', () => {
    it('should save a context to disk', async () => {
      const context = createTestContext();

      await persistence.saveContext(context);

      const filePath = path.join(tempDir, `${context.contextId}.context.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const saved = JSON.parse(content);

      expect(saved.contextId).toBe(context.contextId);
      expect(saved.sessionId).toBe(context.sessionId);
    });

    it('should overwrite existing context', async () => {
      const context = createTestContext();
      await persistence.saveContext(context);

      const updatedContext = { ...context, retryCount: 1 };
      await persistence.saveContext(updatedContext);

      const loaded = await persistence.loadContext(context.contextId);
      expect(loaded?.retryCount).toBe(1);
    });
  });

  describe('loadContext', () => {
    it('should load an existing context', async () => {
      const context = createTestContext();
      await persistence.saveContext(context);

      const loaded = await persistence.loadContext(context.contextId);

      expect(loaded).not.toBeNull();
      expect(loaded?.contextId).toBe(context.contextId);
      expect(loaded?.sessionId).toBe(context.sessionId);
      expect(loaded?.product.id).toBe(context.product.id);
    });

    it('should return null for non-existent context', async () => {
      const loaded = await persistence.loadContext('non-existent');
      expect(loaded).toBeNull();
    });
  });

  describe('deleteContext', () => {
    it('should delete an existing context', async () => {
      const context = createTestContext();
      await persistence.saveContext(context);

      const deleted = await persistence.deleteContext(context.contextId);

      expect(deleted).toBe(true);
      const loaded = await persistence.loadContext(context.contextId);
      expect(loaded).toBeNull();
    });

    it('should return false for non-existent context', async () => {
      const deleted = await persistence.deleteContext('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('listContexts', () => {
    it('should list all saved contexts', async () => {
      const context1 = createTestContext({ contextId: 'ctx1' });
      const context2 = createTestContext({ contextId: 'ctx2' });

      await persistence.saveContext(context1);
      await persistence.saveContext(context2);

      const contexts = await persistence.listContexts();

      expect(contexts.length).toBe(2);
      expect(contexts.map(c => c.contextId).sort()).toEqual(['ctx1', 'ctx2']);
    });

    it('should return empty array when no contexts exist', async () => {
      const contexts = await persistence.listContexts();
      expect(contexts).toEqual([]);
    });
  });

  describe('saveResult', () => {
    it('should save a result to disk', async () => {
      const result = createTestResult('ctx1');

      await persistence.saveResult(result);

      const filePath = path.join(tempDir, `${result.contextId}.result.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const saved = JSON.parse(content);

      expect(saved.contextId).toBe(result.contextId);
      expect(saved.verdict).toBe(result.verdict);
    });
  });

  describe('loadResult', () => {
    it('should load an existing result', async () => {
      const result = createTestResult('ctx1');
      await persistence.saveResult(result);

      const loaded = await persistence.loadResult('ctx1');

      expect(loaded).not.toBeNull();
      expect(loaded?.verdict).toBe('clean');
    });

    it('should return null for non-existent result', async () => {
      const loaded = await persistence.loadResult('non-existent');
      expect(loaded).toBeNull();
    });
  });

  describe('getPendingContexts', () => {
    it('should return contexts without results', async () => {
      const context1 = createTestContext({ contextId: 'ctx1' });
      const context2 = createTestContext({ contextId: 'ctx2' });
      const result2 = createTestResult('ctx2');

      await persistence.saveContext(context1);
      await persistence.saveContext(context2);
      await persistence.saveResult(result2);

      const pending = await persistence.getPendingContexts();

      expect(pending.length).toBe(1);
      expect(pending[0].contextId).toBe('ctx1');
    });

    it('should exclude expired contexts', async () => {
      const expiredContext = createTestContext({
        contextId: 'expired',
        expiresAt: Date.now() - 1000, // Already expired
      });

      await persistence.saveContext(expiredContext);

      const pending = await persistence.getPendingContexts();

      expect(pending.length).toBe(0);
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired contexts', async () => {
      const expiredContext = createTestContext({
        contextId: 'expired',
        expiresAt: Date.now() - 1000,
      });
      const validContext = createTestContext({
        contextId: 'valid',
        expiresAt: Date.now() + 1000000,
      });

      await persistence.saveContext(expiredContext);
      await persistence.saveContext(validContext);

      const { removed } = await persistence.cleanupExpired();

      expect(removed).toBe(1);

      const contexts = await persistence.listContexts();
      expect(contexts.length).toBe(1);
      expect(contexts[0].contextId).toBe('valid');
    });
  });

  describe('exists', () => {
    it('should return true for existing context', async () => {
      const context = createTestContext();
      await persistence.saveContext(context);

      const exists = await persistence.exists(context.contextId);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent context', async () => {
      const exists = await persistence.exists('non-existent');
      expect(exists).toBe(false);
    });
  });
});

// ============================================================================
// Task Name Utilities Tests
// ============================================================================

describe('Task Name Utilities', () => {
  describe('getTaskName', () => {
    it('should generate correct task name', () => {
      const contextId = 'abc123';
      const taskName = getTaskName(contextId);

      expect(taskName).toBe(`${TASK_NAME_PREFIX}abc123`);
    });
  });

  describe('getContextIdFromTaskName', () => {
    it('should extract context ID from valid task name', () => {
      const taskName = `${TASK_NAME_PREFIX}abc123`;
      const contextId = getContextIdFromTaskName(taskName);

      expect(contextId).toBe('abc123');
    });

    it('should return null for invalid task name', () => {
      const contextId = getContextIdFromTaskName('SomeOtherTask');
      expect(contextId).toBeNull();
    });

    it('should handle empty suffix', () => {
      const contextId = getContextIdFromTaskName(TASK_NAME_PREFIX);
      expect(contextId).toBe('');
    });
  });
});

// ============================================================================
// Default Config Tests
// ============================================================================

describe('Default Schedule Config', () => {
  it('should have reasonable defaults', () => {
    expect(DEFAULT_SCHEDULE_CONFIG.trigger).toBe('logon');
    expect(DEFAULT_SCHEDULE_CONFIG.delaySeconds).toBe(60);
    expect(DEFAULT_SCHEDULE_CONFIG.runElevated).toBe(false);
    expect(DEFAULT_SCHEDULE_CONFIG.timeoutSeconds).toBe(300);
    expect(DEFAULT_SCHEDULE_CONFIG.expirationDays).toBe(7);
  });
});

// ============================================================================
// Expected Absent Artifact Tests
// ============================================================================

describe('ExpectedAbsentArtifact', () => {
  it('should track removed files', () => {
    const artifact: ExpectedAbsentArtifact = {
      type: 'file',
      path: 'C:\\Program Files\\TestProduct\\app.exe',
      wasRemoved: true,
    };

    expect(artifact.type).toBe('file');
    expect(artifact.wasRemoved).toBe(true);
  });

  it('should track removed registry keys', () => {
    const artifact: ExpectedAbsentArtifact = {
      type: 'registry',
      path: 'HKCU\\SOFTWARE\\TestProduct',
      wasRemoved: true,
    };

    expect(artifact.type).toBe('registry');
    expect(artifact.wasRemoved).toBe(true);
  });

  it('should track removed services', () => {
    const artifact: ExpectedAbsentArtifact = {
      type: 'service',
      path: 'TestService',
      wasRemoved: true,
    };

    expect(artifact.type).toBe('service');
    expect(artifact.wasRemoved).toBe(true);
  });
});

// ============================================================================
// Post-Reboot Verification Result Tests
// ============================================================================

describe('PostRebootVerificationResult', () => {
  describe('verdict: clean', () => {
    it('should indicate no reappeared artifacts', () => {
      const result = createTestResult('ctx1', {
        verdict: 'clean',
        artifactsReappeared: false,
        reappearedArtifacts: [],
      });

      expect(result.verdict).toBe('clean');
      expect(result.artifactsReappeared).toBe(false);
      expect(result.reappearedArtifacts.length).toBe(0);
    });
  });

  describe('verdict: persistence_detected', () => {
    it('should list reappeared artifacts', () => {
      const result = createTestResult('ctx1', {
        verdict: 'persistence_detected',
        artifactsReappeared: true,
        reappearedArtifacts: [
          {
            type: 'file',
            path: 'C:\\Program Files\\TestProduct\\app.exe',
            detectedAt: Date.now(),
            possibleCause: 'scheduled_task',
          },
        ],
      });

      expect(result.verdict).toBe('persistence_detected');
      expect(result.artifactsReappeared).toBe(true);
      expect(result.reappearedArtifacts.length).toBe(1);
      expect(result.reappearedArtifacts[0].possibleCause).toBe('scheduled_task');
    });
  });

  describe('verdict: verification_failed', () => {
    it('should indicate verification error', () => {
      const result = createTestResult('ctx1', {
        verdict: 'verification_failed',
        result: {
          status: 'fail',
          checks: [{
            name: 'error',
            status: 'fail',
            details: 'Could not access file system',
          }],
          verifiedAt: Date.now(),
        },
      });

      expect(result.verdict).toBe('verification_failed');
      expect(result.result.status).toBe('fail');
    });
  });

  describe('verdict: expired', () => {
    it('should indicate context expiration', () => {
      const result = createTestResult('ctx1', {
        verdict: 'expired',
        summary: 'Verification context expired before running.',
      });

      expect(result.verdict).toBe('expired');
      expect(result.summary).toContain('expired');
    });
  });
});

// ============================================================================
// Persistence Check Tests
// ============================================================================

describe('PersistenceCheck', () => {
  it('should track passed checks', () => {
    const result = createTestResult('ctx1', {
      persistenceChecks: [
        {
          type: 'file',
          path: 'C:\\Test\\file.exe',
          expectedState: 'absent',
          actualState: 'absent',
          passed: true,
          details: 'Artifact remains absent',
        },
      ],
    });

    const check = result.persistenceChecks[0];
    expect(check.passed).toBe(true);
    expect(check.expectedState).toBe('absent');
    expect(check.actualState).toBe('absent');
  });

  it('should track failed checks', () => {
    const result = createTestResult('ctx1', {
      persistenceChecks: [
        {
          type: 'file',
          path: 'C:\\Test\\file.exe',
          expectedState: 'absent',
          actualState: 'present',
          passed: false,
          details: 'Artifact reappeared after reboot',
        },
      ],
    });

    const check = result.persistenceChecks[0];
    expect(check.passed).toBe(false);
    expect(check.actualState).toBe('present');
  });
});
