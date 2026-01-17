/**
 * StepEngine Unit Tests
 *
 * Tests step handlers and engine execution with mock adapters.
 * No real OS operations are performed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Plan, PlanStep, ProductDefinition } from '../../src/shared/types';
import type { RemediationPolicy } from '../../src/main/core/policy/types';
import {
  createStepEngine,
  createMockSystemAdapter,
  createInMemoryBackupStore,
  createStepHandlerRegistry,
  type MockSystemState,
  type ExecutionOptions,
} from '../../src/main/core/execution';

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

function createTestPolicy(): RemediationPolicy {
  return {
    assertAllowedPath: () => {}, // Allow all in tests
    assertAllowedRegistryKey: () => {}, // Allow all in tests
  };
}

function createTestPlan(steps: PlanStep[]): Plan {
  return {
    id: 'test-plan-001',
    productId: 'test-product',
    createdAt: Date.now(),
    boundaries: {
      allowedPaths: ['C:\\Program Files\\TestProduct'],
      allowedRegistryPrefixes: ['HKLM\\SOFTWARE\\TestVendor\\TestProduct'],
      allowedTasks: ['\\TestVendor\\'],
    },
    steps,
    metadata: {
      scanDuration: 100,
      correlatorVersion: '1.0.0',
    },
  };
}

function createMockState(): MockSystemState {
  return {
    files: {
      'C:\\Program Files\\TestProduct': {
        path: 'C:\\Program Files\\TestProduct',
        exists: true,
        isDirectory: true,
        size: 1024,
        children: ['app.exe', 'config.json'],
      },
      'C:\\Program Files\\TestProduct\\app.exe': {
        path: 'C:\\Program Files\\TestProduct\\app.exe',
        exists: true,
        isDirectory: false,
        size: 512,
      },
    },
    registry: {
      'HKLM\\SOFTWARE\\TestVendor\\TestProduct': {
        exists: true,
        values: {
          InstallPath: { type: 'REG_SZ', data: 'C:\\Program Files\\TestProduct' },
          Version: { type: 'REG_SZ', data: '1.0.0' },
        },
        subkeys: ['Settings'],
      },
    },
    processes: [
      {
        pid: 1234,
        name: 'testapp.exe',
        executablePath: 'C:\\Program Files\\TestProduct\\app.exe',
      },
    ],
    services: {
      TestService: {
        name: 'TestService',
        displayName: 'Test Service',
        state: 'Running',
        startType: 'Automatic',
        binaryPath: '"C:\\Program Files\\TestProduct\\svc.exe"',
      },
    },
    tasks: {
      '\\TestVendor\\UpdateTask': {
        name: 'UpdateTask',
        path: '\\TestVendor\\UpdateTask',
        enabled: true,
        state: 'Ready',
      },
    },
  };
}

describe('StepEngine', () => {
  describe('createStepHandlerRegistry', () => {
    it('should create registry with all handlers', () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const registry = createStepHandlerRegistry(system);

      expect(registry.has('StopProcess')).toBe(true);
      expect(registry.has('StopService')).toBe(true);
      expect(registry.has('RemoveFolder')).toBe(true);
      expect(registry.has('DeleteRegistryKey')).toBe(true);
      expect(registry.has('DeleteScheduledTask')).toBe(true);
    });
  });

  describe('StopProcess handler', () => {
    it('should terminate processes within allowed paths', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopProcess',
        target: 'testapp.exe',
        reason: 'Process is running',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
      expect(mockState.processes.length).toBe(0);
    });

    it('should skip if process not found', async () => {
      const mockState = createMockState();
      mockState.processes = []; // No processes
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopProcess',
        target: 'nonexistent.exe',
        reason: 'Process is running',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('No processes named');
    });

    it('should reject process outside allowed paths', async () => {
      const mockState = createMockState();
      mockState.processes = [
        {
          pid: 5678,
          name: 'other.exe',
          executablePath: 'C:\\Windows\\System32\\other.exe',
        },
      ];
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopProcess',
        target: 'other.exe',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('outside allowed paths');
    });
  });

  describe('StopService handler', () => {
    it('should stop services within allowed paths', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopService',
        target: 'TestService',
        reason: 'Service is running',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
      expect(mockState.services['TestService'].state).toBe('Stopped');
    });

    it('should skip if service not found', async () => {
      const mockState = createMockState();
      mockState.services = {}; // No services
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopService',
        target: 'NonexistentService',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('not found');
    });

    it('should skip if service already stopped', async () => {
      const mockState = createMockState();
      mockState.services['TestService'].state = 'Stopped';
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopService',
        target: 'TestService',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('already stopped');
    });
  });

  describe('RemoveFolder handler', () => {
    it('should move folder to quarantine by default', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
        options: { quarantineFiles: true },
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        reason: 'Product installation folder',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
      // Original path should not exist
      expect(mockState.files['C:\\Program Files\\TestProduct']?.exists).toBe(false);
    });

    it('should hard delete when quarantine disabled', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
        options: { quarantineFiles: false },
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        reason: 'Product installation folder',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
    });

    it('should skip if path does not exist', async () => {
      const mockState = createMockState();
      delete mockState.files['C:\\Program Files\\TestProduct'];
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('does not exist');
    });

    it('should reject path outside allowed boundaries', async () => {
      const mockState = createMockState();
      mockState.files['C:\\Windows\\System32\\evil'] = {
        path: 'C:\\Windows\\System32\\evil',
        exists: true,
        isDirectory: true,
        size: 100,
      };
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'RemoveFolder',
        target: 'C:\\Windows\\System32\\evil',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('outside allowed boundaries');
    });
  });

  describe('DeleteRegistryKey handler', () => {
    it('should delete registry key within allowed prefixes', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteRegistryKey',
        target: 'HKLM\\SOFTWARE\\TestVendor\\TestProduct',
        reason: 'Product registry key',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
      expect(mockState.registry['HKLM\\SOFTWARE\\TestVendor\\TestProduct']?.exists).toBe(false);
    });

    it('should skip if key does not exist', async () => {
      const mockState = createMockState();
      delete mockState.registry['HKLM\\SOFTWARE\\TestVendor\\TestProduct'];
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteRegistryKey',
        target: 'HKLM\\SOFTWARE\\TestVendor\\TestProduct',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('does not exist');
    });

    it('should reject key outside allowed prefixes', async () => {
      const mockState = createMockState();
      mockState.registry['HKLM\\SOFTWARE\\Microsoft\\Windows'] = {
        exists: true,
        values: {},
        subkeys: [],
      };
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteRegistryKey',
        target: 'HKLM\\SOFTWARE\\Microsoft\\Windows',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('outside allowed boundaries');
    });
  });

  describe('DeleteScheduledTask handler', () => {
    it('should delete scheduled task within allowed paths', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteScheduledTask',
        target: '\\TestVendor\\UpdateTask',
        reason: 'Product scheduled task',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.success).toBe(true);
      expect(result.stepResults[0].status).toBe('success');
      expect(mockState.tasks['\\TestVendor\\UpdateTask']).toBeUndefined();
    });

    it('should skip if task does not exist', async () => {
      const mockState = createMockState();
      delete mockState.tasks['\\TestVendor\\UpdateTask'];
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteScheduledTask',
        target: '\\TestVendor\\UpdateTask',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('does not exist');
    });

    it('should reject task outside allowed paths', async () => {
      const mockState = createMockState();
      mockState.tasks['\\Microsoft\\Windows\\UpdateTask'] = {
        name: 'UpdateTask',
        path: '\\Microsoft\\Windows\\UpdateTask',
        enabled: true,
        state: 'Ready',
      };
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'DeleteScheduledTask',
        target: '\\Microsoft\\Windows\\UpdateTask',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('outside allowed boundaries');
    });
  });

  describe('Dry run mode', () => {
    it('should not execute any operations in dry run mode', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const steps: PlanStep[] = [
        { id: 'step-1', action: 'StopProcess', target: 'testapp.exe', reason: 'Test' },
        { id: 'step-2', action: 'StopService', target: 'TestService', reason: 'Test' },
        { id: 'step-3', action: 'RemoveFolder', target: 'C:\\Program Files\\TestProduct', reason: 'Test' },
      ];

      const plan = createTestPlan(steps);
      const result = await engine.execute(plan, true, true); // dryRun = true

      expect(result.dryRun).toBe(true);
      expect(result.stepResults.every(r => r.status === 'dryrun')).toBe(true);

      // Verify nothing changed
      expect(mockState.processes.length).toBe(1);
      expect(mockState.services['TestService'].state).toBe('Running');
      expect(mockState.files['C:\\Program Files\\TestProduct'].exists).toBe(true);
    });
  });

  describe('Execution flow', () => {
    it('should stop on failure when continueOnFailure is false', async () => {
      const mockState = createMockState();
      // Make the service stop fail
      delete mockState.services['TestService'];

      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
        options: { continueOnFailure: false },
      });

      const steps: PlanStep[] = [
        { id: 'step-1', action: 'StopProcess', target: 'testapp.exe', reason: 'Test' },
        { id: 'step-2', action: 'StopService', target: 'TestService', reason: 'Test' }, // Will be skipped
        { id: 'step-3', action: 'RemoveFolder', target: 'C:\\Program Files\\TestProduct', reason: 'Test' },
      ];

      const plan = createTestPlan(steps);
      const result = await engine.execute(plan, false, true);

      // Step 1 succeeds, step 2 skipped (not found), step 3 executes
      expect(result.stepResults[0].status).toBe('success');
      expect(result.stepResults[1].status).toBe('skipped');
      expect(result.stepResults[2].status).toBe('success');
    });

    it('should continue on failure when continueOnFailure is true', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
        options: { continueOnFailure: true },
      });

      const steps: PlanStep[] = [
        { id: 'step-1', action: 'StopProcess', target: 'nonexistent.exe', reason: 'Test' }, // Will be skipped
        { id: 'step-2', action: 'StopService', target: 'TestService', reason: 'Test' },
        { id: 'step-3', action: 'RemoveFolder', target: 'C:\\Program Files\\TestProduct', reason: 'Test' },
      ];

      const plan = createTestPlan(steps);
      const result = await engine.execute(plan, false, true);

      // All steps should execute
      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[1].status).toBe('success');
      expect(result.stepResults[2].status).toBe('success');
    });

    it('should skip steps requiring admin when not elevated', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopService',
        target: 'TestService',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, false); // elevated = false

      expect(result.stepResults[0].status).toBe('skipped');
      expect(result.stepResults[0].message).toContain('Admin privileges required');
    });

    it('should record events throughout execution', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'StopProcess',
        target: 'testapp.exe',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      const result = await engine.execute(plan, false, true);

      expect(result.events.length).toBeGreaterThan(0);

      // Should have execution_start and execution_complete events
      const startEvent = result.events.find(e => e.type === 'execution_start');
      const completeEvent = result.events.find(e => e.type === 'execution_complete');

      expect(startEvent).toBeDefined();
      expect(completeEvent).toBeDefined();
    });
  });

  describe('Backup store', () => {
    it('should save backup info for folder removal', async () => {
      const mockState = createMockState();
      const system = createMockSystemAdapter(mockState);
      const backupStore = createInMemoryBackupStore();

      const engine = createStepEngine({
        system,
        policy: createTestPolicy(),
        product: createTestProduct(),
        backupStore,
        options: { quarantineFiles: true },
      });

      const step: PlanStep = {
        id: 'step-1',
        action: 'RemoveFolder',
        target: 'C:\\Program Files\\TestProduct',
        reason: 'Test',
      };

      const plan = createTestPlan([step]);
      await engine.execute(plan, false, true);

      const backup = await backupStore.get('step-1');
      expect(backup).toBeDefined();
      expect(backup?.type).toBe('folder-quarantine');
    });
  });
});
