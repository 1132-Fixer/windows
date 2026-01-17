/**
 * Verifier Integration Tests
 *
 * End-to-end verification scenarios:
 * - Successful uninstall verification
 * - Broken cleanup detection
 * - Safety breach detection
 * - Full pipeline: Acquisition → PlanBuilder → (execution) → Verifier
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Snapshot,
  Artifact,
  Plan,
  PlanStep,
} from '../../src/shared/types';
import type { ProductDefinition } from '../../src/main/core/acquisition/types';
import { DefaultVerifier, createVerifier, createStrictVerifier } from '../../src/main/core/verification/verifier';
import { DefaultPlanBuilder } from '../../src/main/core/planning/plan-builder';
import { DefaultRemediationPolicy } from '../../src/main/core/remediation/policy';

// ============================================================================
// Test Fixtures - Realistic Scenarios
// ============================================================================

const testProduct: ProductDefinition = {
  id: 'testapp',
  vendor: 'Test Vendor Inc.',
  displayName: 'Test Application',
  paths: {
    install: ['C:\\Program Files\\TestApp'],
    appData: ['%APPDATA%\\TestApp'],
    programData: ['%PROGRAMDATA%\\TestApp'],
    logs: [],
    temp: [],
  },
  registry: {
    software: ['HKCU\\Software\\TestApp', 'HKLM\\Software\\TestApp'],
    uninstall: ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TestApp'],
    services: [],
    other: [],
  },
  processes: ['TestApp.exe', 'TestAppHelper.exe'],
  services: ['TestAppService'],
  tasks: ['\\TestVendor\\TestAppUpdate'],
};

function createFileArtifact(path: string, id?: string): Artifact {
  return {
    id: id || `file-${path.replace(/[^a-z0-9]/gi, '-')}`,
    type: 'file',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path,
    metadata: { name: path.split('\\').pop(), size: 1024 },
    observedAt: Date.now(),
    source: 'filesystem',
  };
}

function createRegistryArtifact(keyPath: string, values: Record<string, unknown> = {}): Artifact {
  return {
    id: `reg-${keyPath.replace(/[^a-z0-9]/gi, '-')}`,
    type: 'registry',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: keyPath,
    metadata: { hive: 'HKCU', keyPath, values, valueCount: Object.keys(values).length },
    observedAt: Date.now(),
    source: 'registry',
  };
}

function createProcessArtifact(name: string, pid: number): Artifact {
  return {
    id: `proc-${name}-${pid}`,
    type: 'process',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    metadata: { name, pid, executablePath: `C:\\Program Files\\TestApp\\${name}` },
    observedAt: Date.now(),
    source: 'process',
  };
}

function createServiceArtifact(name: string): Artifact {
  return {
    id: `svc-${name}`,
    type: 'service',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}`,
    metadata: {
      name,
      displayName: name,
      binaryPath: `C:\\Program Files\\TestApp\\${name}.exe`,
      startType: 'Automatic',
      currentState: 'Running',
      serviceType: 'Win32OwnProcess',
    },
    observedAt: Date.now(),
    source: 'service',
  };
}

function createTaskArtifact(name: string): Artifact {
  return {
    id: `task-${name}`,
    type: 'task',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: `\\TestVendor\\${name}`,
    metadata: {
      name,
      path: `\\TestVendor\\${name}`,
      enabled: true,
      state: 'Ready',
      actions: [{ type: 'Execute', path: 'C:\\Program Files\\TestApp\\updater.exe' }],
      triggers: [],
    },
    observedAt: Date.now(),
    source: 'task',
  };
}

function createSnapshot(id: string, artifacts: Artifact[]): Snapshot {
  return {
    id,
    productId: testProduct.id,
    createdAt: Date.now(),
    artifacts,
    relationships: [],
  };
}

function createPlan(mode: string, steps: PlanStep[]): Plan {
  return {
    id: 'test-plan',
    productId: testProduct.id,
    mode: mode as any,
    createdAt: Date.now(),
    steps,
    dryRun: false,
    boundaries: {
      allowedPaths: [
        'C:\\Program Files\\TestApp',
        '%APPDATA%\\TestApp',
        '%PROGRAMDATA%\\TestApp',
      ],
      allowedRegistryPrefixes: [
        'HKCU\\Software\\TestApp',
        'HKLM\\Software\\TestApp',
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TestApp',
      ],
      allowedServices: ['TestAppService'],
      allowedTasks: ['\\TestVendor\\TestAppUpdate'],
    },
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Verifier Integration - Successful Uninstall', () => {
  it('should PASS verification for complete uninstall', async () => {
    const verifier = createVerifier();

    // Pre-snapshot: Full installation
    const preSnapshot = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createFileArtifact('C:\\Program Files\\TestApp\\config.json'),
      createRegistryArtifact('HKCU\\Software\\TestApp', { Version: '1.0.0' }),
      createProcessArtifact('TestApp.exe', 1234),
      createServiceArtifact('TestAppService'),
      createTaskArtifact('TestAppUpdate'),
    ]);

    // Post-snapshot: Everything removed
    const postSnapshot = createSnapshot('post', []);

    const plan = createPlan('uninstall', [
      { id: 's1', action: 'StopProcess', target: 'TestApp.exe', requiresAdmin: false, risk: 'low', reason: 'Stop process' },
      { id: 's2', action: 'StopService', target: 'TestAppService', requiresAdmin: true, risk: 'low', reason: 'Stop service' },
      { id: 's3', action: 'RemoveFolder', target: 'C:\\Program Files\\TestApp', requiresAdmin: true, risk: 'medium', reason: 'Remove files' },
      { id: 's4', action: 'DeleteRegistryKey', target: 'HKCU\\Software\\TestApp', requiresAdmin: false, risk: 'low', reason: 'Remove registry' },
      { id: 's5', action: 'DeleteScheduledTask', target: 'TestAppUpdate', requiresAdmin: true, risk: 'low', reason: 'Remove task' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    expect(result.status).toBe('pass');
    expect(result.checks.every(c => c.status === 'pass')).toBe(true);
  });
});

describe('Verifier Integration - Broken Cleanup Detection', () => {
  it('should FAIL when processes still running', async () => {
    const verifier = createVerifier();

    const preSnapshot = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createProcessArtifact('TestApp.exe', 1234),
    ]);

    // Process still running!
    const postSnapshot = createSnapshot('post', [
      createProcessArtifact('TestApp.exe', 1234),
    ]);

    const plan = createPlan('uninstall', [
      { id: 's1', action: 'StopProcess', target: 'TestApp.exe', requiresAdmin: false, risk: 'low', reason: 'Stop' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    expect(result.status).toBe('fail');

    const processCheck = result.checks.find(c => c.name === 'no_vendor_processes');
    expect(processCheck?.status).toBe('fail');
  });

  it('should FAIL when RemoveFolder did not work', async () => {
    const verifier = createVerifier();

    const preSnapshot = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
    ]);

    // File still exists!
    const postSnapshot = createSnapshot('post', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
    ]);

    const plan = createPlan('clean', [
      { id: 's1', action: 'RemoveFolder', target: 'C:\\Program Files\\TestApp', requiresAdmin: true, risk: 'medium', reason: 'Remove' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    expect(result.status).toBe('fail');

    const promiseCheck = result.checks.find(c => c.name === 'plan_promises_held');
    expect(promiseCheck?.status).toBe('fail');
  });

  it('should WARN on orphaned references', async () => {
    const verifier = createVerifier();

    const preSnapshot = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createRegistryArtifact('HKCU\\Software\\TestApp', {
        ExePath: 'C:\\Program Files\\TestApp\\TestApp.exe',
      }),
    ]);

    // File removed but registry still references it
    const postSnapshot = createSnapshot('post', [
      createRegistryArtifact('HKCU\\Software\\TestApp', {
        ExePath: 'C:\\Program Files\\TestApp\\TestApp.exe',
      }),
    ]);

    const plan = createPlan('clean', [
      { id: 's1', action: 'RemoveFolder', target: 'C:\\Program Files\\TestApp', requiresAdmin: true, risk: 'medium', reason: 'Remove' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    // Overall may be warning or fail depending on other checks
    const orphanCheck = result.checks.find(c => c.name === 'no_orphaned_references');
    expect(orphanCheck?.status).toBe('warning');
  });
});

describe('Verifier Integration - Safety Breach Detection (CRITICAL)', () => {
  it('should FAIL CRITICALLY when out-of-scope file removed', async () => {
    const strictVerifier = createStrictVerifier();

    const preSnapshot = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createFileArtifact('C:\\Windows\\System32\\important.dll'), // Out of scope!
    ]);

    // Both removed - including system file!
    const postSnapshot = createSnapshot('post', []);

    const plan = createPlan('clean', [
      { id: 's1', action: 'RemoveFolder', target: 'C:\\Program Files\\TestApp', requiresAdmin: true, risk: 'medium', reason: 'Remove' },
    ]);

    const result = await strictVerifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    expect(result.status).toBe('fail');

    const safetyCheck = result.checks.find(c => c.name === 'no_out_of_scope_damage');
    expect(safetyCheck?.status).toBe('fail');
    expect(safetyCheck?.details).toContain('CRITICAL');
  });

  it('should FAIL CRITICALLY when out-of-scope registry removed', async () => {
    const verifier = createVerifier();

    const preSnapshot = createSnapshot('pre', [
      createRegistryArtifact('HKCU\\Software\\TestApp'),
      createRegistryArtifact('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'), // Out of scope!
    ]);

    // Both removed - including system registry!
    const postSnapshot = createSnapshot('post', []);

    const plan = createPlan('clean', [
      { id: 's1', action: 'DeleteRegistryKey', target: 'HKCU\\Software\\TestApp', requiresAdmin: false, risk: 'low', reason: 'Remove' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot,
      postSnapshot,
    });

    expect(result.status).toBe('fail');

    const safetyCheck = result.checks.find(c => c.name === 'no_out_of_scope_damage');
    expect(safetyCheck?.status).toBe('fail');
  });
});

describe('Verifier Integration - Full Pipeline', () => {
  it('should work with PlanBuilder output', async () => {
    const policy = new DefaultRemediationPolicy();
    const planBuilder = new DefaultPlanBuilder(policy);
    const verifier = createVerifier();

    // Create a snapshot with artifacts
    const snapshot = createSnapshot('scan', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createRegistryArtifact('HKCU\\Software\\TestApp', { Version: '1.0.0' }),
    ]);

    // Build a plan
    const planResult = await planBuilder.build({
      snapshot,
      product: testProduct,
      mode: 'clean',
      options: {},
    });

    expect(planResult.plan).toBeDefined();

    // Simulate successful execution (post = empty)
    const postSnapshot = createSnapshot('post', []);

    // Verify
    const verifyResult = await verifier.verify({
      product: testProduct,
      plan: planResult.plan,
      preSnapshot: snapshot,
      postSnapshot,
    });

    // Should pass if everything was removed
    expect(verifyResult.status).toBe('pass');
  });
});

describe('Verifier Determinism', () => {
  it('should produce identical results for identical inputs', async () => {
    const verifier = createVerifier();

    const pre = createSnapshot('pre', [
      createFileArtifact('C:\\Program Files\\TestApp\\TestApp.exe'),
      createProcessArtifact('TestApp.exe', 1234),
    ]);

    const post = createSnapshot('post', []);

    const plan = createPlan('uninstall', [
      { id: 's1', action: 'StopProcess', target: 'TestApp.exe', requiresAdmin: false, risk: 'low', reason: 'Stop' },
    ]);

    const input = { product: testProduct, plan, preSnapshot: pre, postSnapshot: post };

    const result1 = await verifier.verify(input);
    const result2 = await verifier.verify(input);
    const result3 = await verifier.verify(input);

    // Statuses should match
    expect(result1.status).toBe(result2.status);
    expect(result2.status).toBe(result3.status);

    // Check counts should match
    expect(result1.checks.length).toBe(result2.checks.length);
    expect(result2.checks.length).toBe(result3.checks.length);

    // Individual check statuses should match
    for (let i = 0; i < result1.checks.length; i++) {
      expect(result1.checks[i].name).toBe(result2.checks[i].name);
      expect(result1.checks[i].status).toBe(result2.checks[i].status);
    }
  });
});

describe('Verifier Evidence Quality', () => {
  it('should provide detailed evidence for failures', async () => {
    const verifier = createVerifier();

    const pre = createSnapshot('pre', [
      createProcessArtifact('TestApp.exe', 1234),
      createProcessArtifact('TestAppHelper.exe', 5678),
    ]);

    // Both processes still running
    const post = createSnapshot('post', [
      createProcessArtifact('TestApp.exe', 1234),
      createProcessArtifact('TestAppHelper.exe', 5678),
    ]);

    const plan = createPlan('uninstall', [
      { id: 's1', action: 'StopProcess', target: 'TestApp.exe', requiresAdmin: false, risk: 'low', reason: 'Stop' },
    ]);

    const result = await verifier.verify({
      product: testProduct,
      plan,
      preSnapshot: pre,
      postSnapshot: post,
    });

    const processCheck = result.checks.find(c => c.name === 'no_vendor_processes');
    expect(processCheck?.status).toBe('fail');
    expect(processCheck?.details).toContain('2'); // Two processes
    expect(processCheck?.details).toContain('TestApp.exe');
  });
});
