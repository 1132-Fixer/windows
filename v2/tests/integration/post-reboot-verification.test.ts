/**
 * Post-Reboot Verification Integration Tests
 *
 * Tests the complete post-reboot verification flow.
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
  type ExpectedAbsentArtifact,
  type ScheduleConfig,
  DEFAULT_SCHEDULE_CONFIG,
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

// ============================================================================
// Integration Tests
// ============================================================================

describe('Post-Reboot Verification Integration', () => {
  let tempDir: string;
  let persistence: ContextPersistence;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `post-reboot-integration-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    persistence = createContextPersistence({ storagePath: tempDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Context Lifecycle', () => {
    it('should complete full lifecycle: create -> save -> load -> verify -> cleanup', async () => {
      // 1. Create context
      const expectedAbsent: ExpectedAbsentArtifact[] = [
        { type: 'file', path: 'C:\\Test\\file.exe', wasRemoved: true },
        { type: 'registry', path: 'HKCU\\SOFTWARE\\Test', wasRemoved: true },
      ];

      const context: PostRebootVerificationContext = {
        contextId: `test_${Date.now()}`,
        sessionId: `session-${Date.now()}`,
        product: testProduct,
        planId: `plan-${Date.now()}`,
        scheduledAt: Date.now(),
        preSnapshotId: 'pre-snapshot',
        postSnapshotId: 'post-snapshot',
        expectedAbsent,
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      // 2. Save context
      await persistence.saveContext(context);

      // 3. Verify it's in pending list
      let pending = await persistence.getPendingContexts();
      expect(pending.length).toBe(1);
      expect(pending[0].contextId).toBe(context.contextId);

      // 4. Load and verify content
      const loaded = await persistence.loadContext(context.contextId);
      expect(loaded).not.toBeNull();
      expect(loaded?.expectedAbsent.length).toBe(2);
      expect(loaded?.product.id).toBe(testProduct.id);

      // 5. Simulate verification result
      await persistence.saveResult({
        contextId: context.contextId,
        sessionId: context.sessionId,
        verifiedAt: Date.now(),
        result: {
          status: 'pass',
          checks: [],
          verifiedAt: Date.now(),
        },
        persistenceChecks: [
          {
            type: 'file',
            path: 'C:\\Test\\file.exe',
            expectedState: 'absent',
            actualState: 'absent',
            passed: true,
          },
          {
            type: 'registry',
            path: 'HKCU\\SOFTWARE\\Test',
            expectedState: 'absent',
            actualState: 'absent',
            passed: true,
          },
        ],
        artifactsReappeared: false,
        reappearedArtifacts: [],
        verdict: 'clean',
        summary: 'All checks passed',
      });

      // 6. Verify it's no longer pending
      pending = await persistence.getPendingContexts();
      expect(pending.length).toBe(0);

      // 7. Verify result can be loaded
      const result = await persistence.loadResult(context.contextId);
      expect(result).not.toBeNull();
      expect(result?.verdict).toBe('clean');

      // 8. Cleanup
      await persistence.deleteContext(context.contextId);
      await persistence.deleteResult(context.contextId);

      // 9. Verify cleanup
      expect(await persistence.exists(context.contextId)).toBe(false);
      expect(await persistence.loadResult(context.contextId)).toBeNull();
    });

    it('should handle multiple concurrent contexts', async () => {
      const contexts: PostRebootVerificationContext[] = [];

      // Create multiple contexts
      for (let i = 0; i < 5; i++) {
        const context: PostRebootVerificationContext = {
          contextId: `ctx_${i}`,
          sessionId: `session-${i}`,
          product: testProduct,
          planId: `plan-${i}`,
          scheduledAt: Date.now(),
          preSnapshotId: `pre-${i}`,
          postSnapshotId: `post-${i}`,
          expectedAbsent: [
            { type: 'file', path: `C:\\Test\\file${i}.exe`, wasRemoved: true },
          ],
          maxRetries: 3,
          retryCount: 0,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        };
        contexts.push(context);
        await persistence.saveContext(context);
      }

      // Verify all are pending
      const pending = await persistence.getPendingContexts();
      expect(pending.length).toBe(5);

      // Process some results
      for (let i = 0; i < 3; i++) {
        await persistence.saveResult({
          contextId: `ctx_${i}`,
          sessionId: `session-${i}`,
          verifiedAt: Date.now(),
          result: { status: 'pass', checks: [], verifiedAt: Date.now() },
          persistenceChecks: [],
          artifactsReappeared: false,
          reappearedArtifacts: [],
          verdict: 'clean',
          summary: 'Passed',
        });
      }

      // Verify remaining pending
      const stillPending = await persistence.getPendingContexts();
      expect(stillPending.length).toBe(2);
      expect(stillPending.map(c => c.contextId).sort()).toEqual(['ctx_3', 'ctx_4']);
    });
  });

  describe('Expiration Handling', () => {
    it('should correctly identify expired contexts', async () => {
      // Create expired context
      const expiredContext: PostRebootVerificationContext = {
        contextId: 'expired',
        sessionId: 'session-expired',
        product: testProduct,
        planId: 'plan-expired',
        scheduledAt: Date.now() - 100000,
        preSnapshotId: 'pre',
        postSnapshotId: 'post',
        expectedAbsent: [],
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() - 1000, // Already expired
      };

      // Create valid context
      const validContext: PostRebootVerificationContext = {
        contextId: 'valid',
        sessionId: 'session-valid',
        product: testProduct,
        planId: 'plan-valid',
        scheduledAt: Date.now(),
        preSnapshotId: 'pre',
        postSnapshotId: 'post',
        expectedAbsent: [],
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() + 1000000, // Far future
      };

      await persistence.saveContext(expiredContext);
      await persistence.saveContext(validContext);

      // Only valid context should be pending
      const pending = await persistence.getPendingContexts();
      expect(pending.length).toBe(1);
      expect(pending[0].contextId).toBe('valid');

      // Cleanup should remove expired
      const { removed } = await persistence.cleanupExpired();
      expect(removed).toBe(1);

      // Only valid context should remain
      const all = await persistence.listContexts();
      expect(all.length).toBe(1);
      expect(all[0].contextId).toBe('valid');
    });
  });

  describe('Retry Tracking', () => {
    it('should track retry attempts', async () => {
      const context: PostRebootVerificationContext = {
        contextId: 'retry-test',
        sessionId: 'session-retry',
        product: testProduct,
        planId: 'plan-retry',
        scheduledAt: Date.now(),
        preSnapshotId: 'pre',
        postSnapshotId: 'post',
        expectedAbsent: [],
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() + 1000000,
      };

      await persistence.saveContext(context);

      // Simulate retry increments
      for (let i = 1; i <= 3; i++) {
        const loaded = await persistence.loadContext('retry-test');
        expect(loaded).not.toBeNull();

        loaded!.retryCount = i;
        await persistence.saveContext(loaded!);

        const updated = await persistence.loadContext('retry-test');
        expect(updated?.retryCount).toBe(i);
      }

      // After max retries, should still be loadable
      const final = await persistence.loadContext('retry-test');
      expect(final?.retryCount).toBe(3);
      expect(final?.maxRetries).toBe(3);
    });
  });

  describe('Schedule Config Merging', () => {
    it('should merge custom config with defaults', () => {
      const customConfig: Partial<ScheduleConfig> = {
        trigger: 'boot',
        delaySeconds: 120,
      };

      const merged: ScheduleConfig = {
        ...DEFAULT_SCHEDULE_CONFIG,
        ...customConfig,
      };

      expect(merged.trigger).toBe('boot');
      expect(merged.delaySeconds).toBe(120);
      expect(merged.runElevated).toBe(DEFAULT_SCHEDULE_CONFIG.runElevated);
      expect(merged.timeoutSeconds).toBe(DEFAULT_SCHEDULE_CONFIG.timeoutSeconds);
      expect(merged.expirationDays).toBe(DEFAULT_SCHEDULE_CONFIG.expirationDays);
    });
  });

  describe('Persistence Check Aggregation', () => {
    it('should correctly aggregate check results', async () => {
      const context: PostRebootVerificationContext = {
        contextId: 'aggregation-test',
        sessionId: 'session-agg',
        product: testProduct,
        planId: 'plan-agg',
        scheduledAt: Date.now(),
        preSnapshotId: 'pre',
        postSnapshotId: 'post',
        expectedAbsent: [
          { type: 'file', path: 'C:\\Test\\file1.exe', wasRemoved: true },
          { type: 'file', path: 'C:\\Test\\file2.exe', wasRemoved: true },
          { type: 'registry', path: 'HKCU\\SOFTWARE\\Test1', wasRemoved: true },
          { type: 'registry', path: 'HKCU\\SOFTWARE\\Test2', wasRemoved: true },
          { type: 'service', path: 'TestService', wasRemoved: true },
        ],
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() + 1000000,
      };

      await persistence.saveContext(context);

      // Simulate mixed results (3 passed, 2 failed)
      const result = {
        contextId: 'aggregation-test',
        sessionId: 'session-agg',
        verifiedAt: Date.now(),
        result: { status: 'fail' as const, checks: [], verifiedAt: Date.now() },
        persistenceChecks: [
          { type: 'file' as const, path: 'C:\\Test\\file1.exe', expectedState: 'absent' as const, actualState: 'absent' as const, passed: true },
          { type: 'file' as const, path: 'C:\\Test\\file2.exe', expectedState: 'absent' as const, actualState: 'present' as const, passed: false },
          { type: 'registry' as const, path: 'HKCU\\SOFTWARE\\Test1', expectedState: 'absent' as const, actualState: 'absent' as const, passed: true },
          { type: 'registry' as const, path: 'HKCU\\SOFTWARE\\Test2', expectedState: 'absent' as const, actualState: 'present' as const, passed: false },
          { type: 'service' as const, path: 'TestService', expectedState: 'absent' as const, actualState: 'absent' as const, passed: true },
        ],
        artifactsReappeared: true,
        reappearedArtifacts: [
          { type: 'file' as const, path: 'C:\\Test\\file2.exe', detectedAt: Date.now(), possibleCause: 'scheduled_task' as const },
          { type: 'registry' as const, path: 'HKCU\\SOFTWARE\\Test2', detectedAt: Date.now(), possibleCause: 'registry_autorun' as const },
        ],
        verdict: 'persistence_detected' as const,
        summary: '3/5 checks passed. 2 artifacts reappeared.',
      };

      await persistence.saveResult(result);

      const loaded = await persistence.loadResult('aggregation-test');
      expect(loaded).not.toBeNull();

      const passed = loaded!.persistenceChecks.filter(c => c.passed).length;
      const failed = loaded!.persistenceChecks.filter(c => !c.passed).length;

      expect(passed).toBe(3);
      expect(failed).toBe(2);
      expect(loaded!.artifactsReappeared).toBe(true);
      expect(loaded!.reappearedArtifacts.length).toBe(2);
    });
  });

  describe('Product Definition Persistence', () => {
    it('should correctly persist and restore product definition', async () => {
      const context: PostRebootVerificationContext = {
        contextId: 'product-test',
        sessionId: 'session-product',
        product: testProduct,
        planId: 'plan-product',
        scheduledAt: Date.now(),
        preSnapshotId: 'pre',
        postSnapshotId: 'post',
        expectedAbsent: [],
        maxRetries: 3,
        retryCount: 0,
        expiresAt: Date.now() + 1000000,
      };

      await persistence.saveContext(context);

      const loaded = await persistence.loadContext('product-test');
      expect(loaded).not.toBeNull();

      // Verify product definition is fully restored
      expect(loaded!.product.id).toBe(testProduct.id);
      expect(loaded!.product.vendor).toBe(testProduct.vendor);
      expect(loaded!.product.displayName).toBe(testProduct.displayName);
      expect(loaded!.product.paths.install).toEqual(testProduct.paths.install);
      expect(loaded!.product.paths.appData).toEqual(testProduct.paths.appData);
      expect(loaded!.product.registry.software).toEqual(testProduct.registry.software);
      expect(loaded!.product.processes).toEqual(testProduct.processes);
      expect(loaded!.product.services).toEqual(testProduct.services);
      expect(loaded!.product.tasks).toEqual(testProduct.tasks);
    });
  });
});
