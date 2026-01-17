/**
 * Plan + Policy Integration Tests
 *
 * These tests verify that the PlanBuilder and RemediationPolicy
 * work together correctly to enforce safety boundaries.
 *
 * CRITICAL: These tests use the REAL implementations, not mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Snapshot, Artifact } from '../../src/shared/types';
import type { ProductDefinition } from '../../src/main/core/acquisition/types';
import {
  DefaultPlanBuilder,
  createPlanBuilder,
  resetStepCounter,
} from '../../src/main/core/planning/plan-builder';
import {
  DefaultRemediationPolicy,
  PolicyViolationError,
  createPolicy,
} from '../../src/main/core/remediation/policy';

describe('PlanBuilder + Policy Integration', () => {
  let product: ProductDefinition;
  let policy: DefaultRemediationPolicy;
  let planBuilder: DefaultPlanBuilder;

  beforeEach(() => {
    resetStepCounter();

    policy = createPolicy() as DefaultRemediationPolicy;
    planBuilder = createPlanBuilder(policy) as DefaultPlanBuilder;

    product = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: ['%PROGRAMFILES%\\Zoom'],
        appData: ['%APPDATA%\\Zoom', '%LOCALAPPDATA%\\Zoom'],
        programData: ['%PROGRAMDATA%\\Zoom'],
        logs: [],
        temp: [],
      },
      registry: {
        software: ['HKCU\\Software\\Zoom', 'HKLM\\Software\\Zoom'],
        uninstall: ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom'],
        services: ['HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService'],
        other: [],
      },
      processes: ['Zoom.exe', 'CptHost.exe'],
      services: ['CptService'],
      tasks: ['\\ZoomUpdateTaskMachine'],
      uninstaller: {
        path: '%APPDATA%\\Zoom\\bin\\Installer.exe',
        args: ['/uninstall', '/silent'],
      },
    };
  });

  // ==========================================================================
  // CRITICAL: Policy Tripwire Tests with Real Implementation
  // ==========================================================================
  describe('Policy Tripwire (Real Implementation)', () => {
    it('should THROW when artifact path is in C:\\Windows\\System32', async () => {
      const maliciousSnapshot: Snapshot = {
        id: 'snapshot_malicious',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'malicious_file',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'C:\\Windows\\System32\\evil.dll',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
        relationships: [],
      };

      // This MUST throw PolicyViolationError
      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: maliciousSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when artifact path is in C:\\Windows\\SysWOW64', async () => {
      const maliciousSnapshot: Snapshot = {
        id: 'snapshot_malicious',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'malicious_file',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'C:\\Windows\\SysWOW64\\malware.exe',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: maliciousSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when registry key is in HKLM\\SAM', async () => {
      const maliciousSnapshot: Snapshot = {
        id: 'snapshot_malicious',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'malicious_reg',
            type: 'registry',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'HKLM\\SAM\\SAM\\Domains',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: maliciousSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when registry key is in HKLM\\SECURITY', async () => {
      const maliciousSnapshot: Snapshot = {
        id: 'snapshot_malicious',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'malicious_reg',
            type: 'registry',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'HKLM\\SECURITY\\Policy',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: maliciousSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when registry key is LSA security providers', async () => {
      const maliciousSnapshot: Snapshot = {
        id: 'snapshot_malicious',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'malicious_reg',
            type: 'registry',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Security Packages',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: maliciousSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when file path is outside product boundaries', async () => {
      const outOfScopeSnapshot: Snapshot = {
        id: 'snapshot_oos',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'oos_file',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Microsoft\\Teams\\data',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: outOfScopeSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('should THROW when service is not in product allowlist', async () => {
      const outOfScopeSnapshot: Snapshot = {
        id: 'snapshot_oos',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'oos_service',
            type: 'service',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'wuauserv', // Windows Update service
            metadata: { name: 'wuauserv' },
            observedAt: Date.now(),
            source: 'service',
          },
        ],
        relationships: [],
      };

      await expect(
        planBuilder.build({
          product,
          mode: 'uninstall',
          snapshot: outOfScopeSnapshot,
          options: { dryRun: true },
        }),
      ).rejects.toThrow(PolicyViolationError);
    });
  });

  // ==========================================================================
  // Valid Snapshot Tests
  // ==========================================================================
  describe('Valid Snapshots', () => {
    it('should successfully build plan for valid Zoom artifacts', async () => {
      const validSnapshot: Snapshot = {
        id: 'snapshot_valid',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'valid_file',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Zoom\\data',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
          {
            id: 'valid_reg',
            type: 'registry',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'HKCU\\Software\\Zoom\\Settings',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
          {
            id: 'valid_process',
            type: 'process',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'Zoom.exe',
            metadata: { pid: 1234 },
            observedAt: Date.now(),
            source: 'process',
          },
          {
            id: 'valid_service',
            type: 'service',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'CptService',
            metadata: { name: 'CptService' },
            observedAt: Date.now(),
            source: 'service',
          },
        ],
        relationships: [],
      };

      // This should NOT throw
      const result = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot: validSnapshot,
        options: { dryRun: true },
      });

      expect(result.plan).toBeDefined();
      expect(result.plan.steps.length).toBeGreaterThan(0);
      expect(result.plan.mode).toBe('uninstall');
    });

    it('should filter out low-confidence artifacts', async () => {
      const mixedSnapshot: Snapshot = {
        id: 'snapshot_mixed',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'high_conf',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Zoom\\config',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
          {
            id: 'low_conf',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'low' },
            path: '%APPDATA%\\Zoom\\suspicious',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
        relationships: [],
      };

      const result = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot: mixedSnapshot,
        options: { dryRun: true },
      });

      // Low confidence artifact should be skipped
      expect(result.skippedArtifacts).toContainEqual(
        expect.objectContaining({ artifactId: 'low_conf' }),
      );
    });

    it('should produce empty plan for audit mode', async () => {
      const validSnapshot: Snapshot = {
        id: 'snapshot_audit',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'file_1',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Zoom\\data',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
        relationships: [],
      };

      const result = await planBuilder.build({
        product,
        mode: 'audit',
        snapshot: validSnapshot,
        options: { dryRun: true },
      });

      expect(result.plan.steps.length).toBe(0);
      expect(result.plan.mode).toBe('audit');
    });
  });

  // ==========================================================================
  // Step Ordering Integration Tests
  // ==========================================================================
  describe('Step Ordering', () => {
    it('should order StopService before StopProcess', async () => {
      const snapshot: Snapshot = {
        id: 'snapshot_order',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'process_1',
            type: 'process',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'Zoom.exe',
            metadata: {},
            observedAt: Date.now(),
            source: 'process',
          },
          {
            id: 'service_1',
            type: 'service',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'CptService',
            metadata: {},
            observedAt: Date.now(),
            source: 'service',
          },
        ],
        relationships: [],
      };

      const result = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot,
        options: { dryRun: true },
      });

      const serviceIndex = result.plan.steps.findIndex(s => s.action === 'StopService');
      const processIndex = result.plan.steps.findIndex(s => s.action === 'StopProcess');

      expect(serviceIndex).toBeLessThan(processIndex);
    });

    it('should order execution steps before removal steps', async () => {
      const snapshot: Snapshot = {
        id: 'snapshot_order',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'file_1',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Zoom\\data',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
          {
            id: 'process_1',
            type: 'process',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'Zoom.exe',
            metadata: {},
            observedAt: Date.now(),
            source: 'process',
          },
        ],
        relationships: [],
      };

      const result = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot,
        options: { dryRun: true },
      });

      const processIndex = result.plan.steps.findIndex(s => s.action === 'StopProcess');
      const folderIndex = result.plan.steps.findIndex(s => s.action === 'RemoveFolder');

      expect(processIndex).toBeLessThan(folderIndex);
    });
  });

  // ==========================================================================
  // Determinism Tests
  // ==========================================================================
  describe('Determinism', () => {
    it('should produce identical plans for identical inputs', async () => {
      const snapshot: Snapshot = {
        id: 'snapshot_det',
        productId: 'zoom',
        createdAt: Date.now(),
        artifacts: [
          {
            id: 'file_1',
            type: 'file',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: '%APPDATA%\\Zoom\\data',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
          {
            id: 'reg_1',
            type: 'registry',
            owner: { vendor: 'Zoom Video Communications', product: 'zoom', confidence: 'high' },
            path: 'HKCU\\Software\\Zoom',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
        ],
        relationships: [],
      };

      resetStepCounter();
      const result1 = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot,
        options: { dryRun: true },
      });

      resetStepCounter();
      const result2 = await planBuilder.build({
        product,
        mode: 'uninstall',
        snapshot,
        options: { dryRun: true },
      });

      // Compare step actions and targets (IDs may differ due to timestamps in plan ID)
      const steps1 = result1.plan.steps.map(s => ({ action: s.action, target: s.target }));
      const steps2 = result2.plan.steps.map(s => ({ action: s.action, target: s.target }));

      expect(steps1).toEqual(steps2);
    });
  });
});
