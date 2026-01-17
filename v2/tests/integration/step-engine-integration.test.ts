/**
 * StepEngine Integration Tests
 *
 * End-to-end tests for plan execution scenarios.
 * Uses mock adapters to simulate real system operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Plan, PlanStep, ProductDefinition } from '../../src/shared/types';
import type { RemediationPolicy } from '../../src/main/core/policy/types';
import {
  createStepEngine,
  createMockSystemAdapter,
  createInMemoryBackupStore,
  type MockSystemState,
  type ExecutionResult,
} from '../../src/main/core/execution';

/**
 * Creates a realistic Zoom-like product definition
 */
function createZoomProduct(): ProductDefinition {
  return {
    id: 'zoom',
    name: 'Zoom',
    vendor: 'Zoom Video Communications',
    installPaths: [
      'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
      'C:\\Program Files\\Zoom',
    ],
    registryKeys: [
      'HKCU\\SOFTWARE\\Zoom',
      'HKLM\\SOFTWARE\\Zoom',
    ],
    processNames: ['Zoom.exe', 'ZoomWebHost.exe'],
    serviceNames: ['ZoomCptService'],
    taskPaths: ['\\Zoom\\'],
  };
}

/**
 * Creates a strict policy that enforces vendor boundaries
 */
function createStrictPolicy(): RemediationPolicy {
  return {
    assertAllowedPath(path: string, plan: Plan): void {
      const normalized = path.toLowerCase();
      const allowed = plan.boundaries.allowedPaths.some(p =>
        normalized.startsWith(p.toLowerCase())
      );
      if (!allowed) {
        throw new Error(`Path ${path} is not in allowed boundaries`);
      }
    },
    assertAllowedRegistryKey(key: string, plan: Plan): void {
      const normalized = key.toLowerCase();
      const allowed = plan.boundaries.allowedRegistryPrefixes.some(p =>
        normalized.startsWith(p.toLowerCase())
      );
      if (!allowed) {
        throw new Error(`Registry key ${key} is not in allowed boundaries`);
      }
    },
  };
}

/**
 * Creates a mock system state simulating a Zoom installation
 */
function createZoomSystemState(): MockSystemState {
  return {
    files: {
      'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom': {
        path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
        exists: true,
        isDirectory: true,
        size: 150 * 1024 * 1024, // 150MB
        children: ['bin', 'data', 'Zoom.exe', 'ZoomWebHost.exe'],
      },
      'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\bin': {
        path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\bin',
        exists: true,
        isDirectory: true,
        size: 50 * 1024 * 1024,
        children: ['cpthost.exe'],
      },
      'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\Zoom.exe': {
        path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\Zoom.exe',
        exists: true,
        isDirectory: false,
        size: 10 * 1024 * 1024,
      },
      'C:\\Program Files\\Zoom': {
        path: 'C:\\Program Files\\Zoom',
        exists: true,
        isDirectory: true,
        size: 100 * 1024 * 1024,
        children: ['Zoom.exe', 'ZoomCptService.exe'],
      },
    },
    registry: {
      'HKCU\\SOFTWARE\\Zoom': {
        exists: true,
        values: {
          InstallPath: { type: 'REG_SZ', data: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom' },
          Version: { type: 'REG_SZ', data: '5.17.0' },
        },
        subkeys: ['ZoomChat', 'ZoomWebHost'],
      },
      'HKLM\\SOFTWARE\\Zoom': {
        exists: true,
        values: {
          InstallPath: { type: 'REG_SZ', data: 'C:\\Program Files\\Zoom' },
        },
        subkeys: ['ZoomCptService'],
      },
    },
    processes: [
      {
        pid: 1000,
        name: 'Zoom.exe',
        executablePath: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\Zoom.exe',
        startTime: new Date(),
      },
      {
        pid: 1001,
        name: 'ZoomWebHost.exe',
        executablePath: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\ZoomWebHost.exe',
        startTime: new Date(),
      },
    ],
    services: {
      ZoomCptService: {
        name: 'ZoomCptService',
        displayName: 'Zoom Sharing Service',
        state: 'Running',
        startType: 'Automatic',
        binaryPath: '"C:\\Program Files\\Zoom\\ZoomCptService.exe"',
      },
    },
    tasks: {
      '\\Zoom\\ZoomUpdateTaskUserS-1-5-21': {
        name: 'ZoomUpdateTaskUserS-1-5-21',
        path: '\\Zoom\\ZoomUpdateTaskUserS-1-5-21',
        enabled: true,
        state: 'Ready',
      },
    },
  };
}

/**
 * Creates a full remediation plan for Zoom
 */
function createZoomRemediationPlan(): Plan {
  return {
    id: 'zoom-remediation-001',
    productId: 'zoom',
    createdAt: Date.now(),
    boundaries: {
      allowedPaths: [
        'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
        'C:\\Program Files\\Zoom',
      ],
      allowedRegistryPrefixes: [
        'HKCU\\SOFTWARE\\Zoom',
        'HKLM\\SOFTWARE\\Zoom',
      ],
      allowedTasks: ['\\Zoom\\'],
    },
    steps: [
      // Phase 1: Stop processes
      {
        id: 'step-1',
        action: 'StopProcess',
        target: 'Zoom.exe',
        reason: 'Process is running from Zoom installation',
      },
      {
        id: 'step-2',
        action: 'StopProcess',
        target: 'ZoomWebHost.exe',
        reason: 'Process is running from Zoom installation',
      },
      // Phase 2: Stop services
      {
        id: 'step-3',
        action: 'StopService',
        target: 'ZoomCptService',
        reason: 'Service binary is in Zoom installation',
      },
      // Phase 3: Delete scheduled tasks
      {
        id: 'step-4',
        action: 'DeleteScheduledTask',
        target: '\\Zoom\\ZoomUpdateTaskUserS-1-5-21',
        reason: 'Task is in Zoom namespace',
      },
      // Phase 4: Remove folders
      {
        id: 'step-5',
        action: 'RemoveFolder',
        target: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
        reason: 'User Zoom installation folder',
      },
      {
        id: 'step-6',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\Zoom',
        reason: 'System Zoom installation folder',
      },
      // Phase 5: Delete registry keys
      {
        id: 'step-7',
        action: 'DeleteRegistryKey',
        target: 'HKCU\\SOFTWARE\\Zoom',
        reason: 'User Zoom registry key',
      },
      {
        id: 'step-8',
        action: 'DeleteRegistryKey',
        target: 'HKLM\\SOFTWARE\\Zoom',
        reason: 'System Zoom registry key',
      },
    ],
    metadata: {
      scanDuration: 500,
      correlatorVersion: '1.0.0',
    },
  };
}

describe('StepEngine Integration', () => {
  describe('Full Zoom remediation scenario', () => {
    it('should execute complete remediation in dry-run mode', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      const plan = createZoomRemediationPlan();
      const result = await engine.execute(plan, true, true);

      expect(result.dryRun).toBe(true);
      expect(result.stepResults.every(r => r.status === 'dryrun')).toBe(true);

      // Verify nothing changed
      expect(mockState.processes.length).toBe(2);
      expect(mockState.services['ZoomCptService'].state).toBe('Running');
      expect(mockState.files['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'].exists).toBe(true);
      expect(mockState.registry['HKCU\\SOFTWARE\\Zoom'].exists).toBe(true);
    });

    it('should execute complete remediation with quarantine', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const backupStore = createInMemoryBackupStore();

      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
        backupStore,
        options: { quarantineFiles: true },
      });

      const plan = createZoomRemediationPlan();
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);

      // Verify all steps succeeded
      const successCount = result.stepResults.filter(r => r.status === 'success').length;
      expect(successCount).toBe(8);

      // Verify system state
      expect(mockState.processes.length).toBe(0);
      expect(mockState.services['ZoomCptService'].state).toBe('Stopped');
      expect(mockState.tasks['\\Zoom\\ZoomUpdateTaskUserS-1-5-21']).toBeUndefined();
      expect(mockState.files['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom']?.exists).toBe(false);
      expect(mockState.files['C:\\Program Files\\Zoom']?.exists).toBe(false);
      expect(mockState.registry['HKCU\\SOFTWARE\\Zoom']?.exists).toBe(false);
      expect(mockState.registry['HKLM\\SOFTWARE\\Zoom']?.exists).toBe(false);

      // Verify backups were created for folder operations
      const backups = await backupStore.list();
      expect(backups.length).toBeGreaterThan(0);
    });

    it('should handle partial remediation gracefully', async () => {
      const mockState = createZoomSystemState();
      // Remove some items to simulate partial installation
      delete mockState.services['ZoomCptService'];
      delete mockState.tasks['\\Zoom\\ZoomUpdateTaskUserS-1-5-21'];

      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
        options: { continueOnFailure: true },
      });

      const plan = createZoomRemediationPlan();
      const result = await engine.execute(plan, false, true);

      // Should still succeed overall (skipped steps are not failures)
      expect(result.success).toBe(true);

      // Verify skipped steps
      const step3 = result.stepResults.find(r => r.stepId === 'step-3');
      const step4 = result.stepResults.find(r => r.stepId === 'step-4');
      expect(step3?.status).toBe('skipped');
      expect(step4?.status).toBe('skipped');

      // Verify other steps succeeded
      const step5 = result.stepResults.find(r => r.stepId === 'step-5');
      expect(step5?.status).toBe('success');
    });
  });

  describe('Security boundary enforcement', () => {
    it('should block attempts to access paths outside boundaries', async () => {
      const mockState = createZoomSystemState();
      // Add a system file that should NOT be touched
      mockState.files['C:\\Windows\\System32\\important.dll'] = {
        path: 'C:\\Windows\\System32\\important.dll',
        exists: true,
        isDirectory: false,
        size: 1024,
      };

      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      // Create a malicious plan trying to access system files
      const maliciousPlan: Plan = {
        id: 'malicious-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: ['HKCU\\SOFTWARE\\Zoom'],
          allowedTasks: ['\\Zoom\\'],
        },
        steps: [
          {
            id: 'step-1',
            action: 'RemoveFolder',
            target: 'C:\\Windows\\System32\\important.dll',
            reason: 'Malicious attempt',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(maliciousPlan, false, true);

      // Step should be skipped due to boundary violation
      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('outside allowed boundaries');

      // System file should still exist
      expect(mockState.files['C:\\Windows\\System32\\important.dll'].exists).toBe(true);
    });

    it('should block attempts to delete protected registry keys', async () => {
      const mockState = createZoomSystemState();
      mockState.registry['HKLM\\SYSTEM\\CurrentControlSet\\Services'] = {
        exists: true,
        values: {},
        subkeys: ['important'],
      };

      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      const maliciousPlan: Plan = {
        id: 'malicious-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: ['HKCU\\SOFTWARE\\Zoom'],
          allowedTasks: ['\\Zoom\\'],
        },
        steps: [
          {
            id: 'step-1',
            action: 'DeleteRegistryKey',
            target: 'HKLM\\SYSTEM\\CurrentControlSet\\Services',
            reason: 'Malicious attempt',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(maliciousPlan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(mockState.registry['HKLM\\SYSTEM\\CurrentControlSet\\Services'].exists).toBe(true);
    });

    it('should enforce policy at execution time (defense in depth)', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);

      // Create a policy that throws during execution
      const throwingPolicy: RemediationPolicy = {
        assertAllowedPath(path: string): void {
          if (path.includes('Program Files')) {
            throw new Error('Policy violation: Cannot touch Program Files');
          }
        },
        assertAllowedRegistryKey(): void {},
      };

      const engine = createStepEngine({
        system,
        policy: throwingPolicy,
        product: createZoomProduct(),
      });

      const plan: Plan = {
        id: 'test-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Program Files\\Zoom'], // Allowed by boundaries
          allowedRegistryPrefixes: [],
          allowedTasks: [],
        },
        steps: [
          {
            id: 'step-1',
            action: 'RemoveFolder',
            target: 'C:\\Program Files\\Zoom',
            reason: 'Test',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(plan, false, true);

      // Should fail due to policy violation at execution time
      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('Policy violation');
    });
  });

  describe('Event recording and audit trail', () => {
    it('should record comprehensive events for audit', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      const plan: Plan = {
        id: 'audit-test-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: [],
          allowedTasks: [],
        },
        steps: [
          {
            id: 'step-1',
            action: 'StopProcess',
            target: 'Zoom.exe',
            reason: 'Test',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(plan, false, true);

      // Verify event types
      const eventTypes = result.events.map(e => e.type);

      expect(eventTypes).toContain('execution_start');
      expect(eventTypes).toContain('step_start');
      expect(eventTypes).toContain('step_progress');
      expect(eventTypes).toContain('step_complete');
      expect(eventTypes).toContain('execution_complete');

      // Verify event timestamps are sequential
      for (let i = 1; i < result.events.length; i++) {
        expect(result.events[i].timestamp).toBeGreaterThanOrEqual(
          result.events[i - 1].timestamp
        );
      }
    });

    it('should record before/after state in step results', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      const plan: Plan = {
        id: 'state-test-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: [],
          allowedTasks: [],
        },
        steps: [
          {
            id: 'step-1',
            action: 'StopProcess',
            target: 'Zoom.exe',
            reason: 'Test',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(plan, false, true);

      const stepResult = result.stepResults[0];

      // Before state should show processes existed
      expect(stepResult.before).toHaveProperty('processes');
      expect(stepResult.before).toHaveProperty('count');

      // After state should show no processes remain
      expect(stepResult.after).toHaveProperty('processes');
      expect(stepResult.after).toHaveProperty('count');
    });
  });

  describe('Execution timing', () => {
    it('should record accurate timing for steps', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
      });

      const plan: Plan = {
        id: 'timing-test-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: [],
          allowedTasks: [],
        },
        steps: [
          {
            id: 'step-1',
            action: 'StopProcess',
            target: 'Zoom.exe',
            reason: 'Test',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(plan, false, true);

      // Verify timing metadata
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);

      // Each step should have duration
      expect(result.stepResults[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Step verification', () => {
    it('should verify step outcomes when verifySteps is enabled', async () => {
      const mockState = createZoomSystemState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createStrictPolicy(),
        product: createZoomProduct(),
        options: { verifySteps: true },
      });

      const plan: Plan = {
        id: 'verify-test-plan',
        productId: 'zoom',
        createdAt: Date.now(),
        boundaries: {
          allowedPaths: ['C:\\Users\\TestUser\\AppData\\Roaming\\Zoom'],
          allowedRegistryPrefixes: [],
          allowedTasks: [],
        },
        steps: [
          {
            id: 'step-1',
            action: 'StopProcess',
            target: 'Zoom.exe',
            reason: 'Test',
          },
        ],
        metadata: { scanDuration: 0, correlatorVersion: '1.0.0' },
      };

      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].verified).toBe(true);

      // Check for verification event
      const verifyEvent = result.events.find(e => e.type === 'step_verified');
      expect(verifyEvent).toBeDefined();
    });
  });
});
