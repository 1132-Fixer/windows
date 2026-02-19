/**
 * Correlator Integration Tests
 *
 * Verifies the full pipeline: Acquisition → Correlator → PlanBuilder
 *
 * CRITICAL INVARIANTS:
 * - PlanBuilder behavior unchanged after correlation
 * - Relationships used only for justification/explanation
 * - Protected paths are never linked
 * - Correlation is transparent to planning
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Snapshot,
  Artifact,
  Plan,
} from '../../src/shared/types';
import type {
  FileArtifact,
  RegistryArtifact,
  ServiceArtifact,
  ProcessArtifact,
  TaskArtifact,
  ProductDefinition,
} from '../../src/main/core/acquisition/types';
import { DefaultCorrelator } from '../../src/main/core/correlation/correlator';
import { DefaultPlanBuilder } from '../../src/main/core/planning/plan-builder';
import { DefaultRemediationPolicy } from '../../src/main/core/remediation/policy';

// ============================================================================
// Test Fixtures - Realistic Zoom-like product
// ============================================================================

const testProduct: ProductDefinition = {
  id: 'testapp',
  vendor: 'Test Vendor',
  displayName: 'Test Application',
  paths: {
    install: ['%PROGRAMFILES%\\TestApp'],
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

function createRealisticFileArtifact(id: string, filePath: string, name: string): FileArtifact {
  return {
    id,
    type: 'file',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: filePath,
    metadata: {
      name,
      extension: name.includes('.') ? '.' + name.split('.').pop() : '',
      size: 1024000,
      created: Date.now() - 86400000,
      modified: Date.now() - 3600000,
      accessed: Date.now(),
      isDirectory: false,
      isHidden: false,
      isSystem: false,
      isReadOnly: false,
      sha256: 'abc123def456',
    },
    observedAt: Date.now(),
    source: 'filesystem',
  };
}

function createRealisticRegistryArtifact(
  id: string,
  keyPath: string,
  values: Record<string, unknown>,
): RegistryArtifact {
  const hive = keyPath.startsWith('HKCU') ? 'HKCU' : 'HKLM';
  return {
    id,
    type: 'registry',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: keyPath,
    metadata: {
      hive,
      keyPath: keyPath.replace(/^HK[A-Z]+\\/, ''),
      values,
      valueCount: Object.keys(values).length,
      exists: true,
    },
    observedAt: Date.now(),
    source: 'registry',
  };
}

function createRealisticServiceArtifact(
  id: string,
  serviceName: string,
  binaryPath: string,
): ServiceArtifact {
  return {
    id,
    type: 'service',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
    metadata: {
      name: serviceName,
      displayName: `${testProduct.displayName} Service`,
      description: 'Background service for Test Application',
      binaryPath,
      startType: 'Automatic',
      currentState: 'Running',
      serviceType: 'Win32OwnProcess',
    },
    observedAt: Date.now(),
    source: 'service',
  };
}

function createRealisticProcessArtifact(
  id: string,
  name: string,
  executablePath: string,
): ProcessArtifact {
  return {
    id,
    type: 'process',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    metadata: {
      pid: Math.floor(Math.random() * 10000) + 1000,
      name,
      executablePath,
      startTime: Date.now() - 3600000,
      isElevated: false,
    },
    observedAt: Date.now(),
    source: 'process',
  };
}

function createRealisticTaskArtifact(
  id: string,
  taskName: string,
  actionPath: string,
): TaskArtifact {
  return {
    id,
    type: 'task',
    owner: { vendor: testProduct.vendor, product: testProduct.id, confidence: 'high' },
    path: `\\TestVendor\\${taskName}`,
    metadata: {
      name: taskName,
      path: `\\TestVendor\\${taskName}`,
      enabled: true,
      state: 'Ready',
      author: testProduct.vendor,
      actions: [{ type: 'Execute', path: actionPath }],
      triggers: [{ type: 'Daily', enabled: true }],
    },
    observedAt: Date.now(),
    source: 'task',
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Correlator → PlanBuilder Integration', () => {
  let correlator: DefaultCorrelator;
  let planBuilder: DefaultPlanBuilder;
  let policy: DefaultRemediationPolicy;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
    policy = new DefaultRemediationPolicy();
    planBuilder = new DefaultPlanBuilder(policy);
  });

  it('should produce valid plan from correlated snapshot', async () => {
    // Create realistic artifacts
    const file = createRealisticFileArtifact(
      'file-1',
      'C:\\Program Files\\TestApp\\TestApp.exe',
      'TestApp.exe',
    );
    const registry = createRealisticRegistryArtifact(
      'reg-1',
      'HKCU\\Software\\TestApp',
      { InstallPath: 'C:\\Program Files\\TestApp\\TestApp.exe' },
    );

    const snapshot: Snapshot = {
      id: 'test-snapshot-1',
      productId: testProduct.id,
      createdAt: Date.now(),
      artifacts: [file, registry],
      relationships: [],
    };

    // Correlate
    const correlatedSnapshot = await correlator.correlate(snapshot);

    // Verify relationships were added
    expect(correlatedSnapshot.relationships.length).toBeGreaterThan(0);

    // Plan should still work
    const planResult = await planBuilder.build({
      snapshot: correlatedSnapshot,
      product: testProduct,
      mode: 'clean',
      options: { preserveUserSettings: false },
    });

    expect(planResult.plan).toBeDefined();
    expect(planResult.plan.steps.length).toBeGreaterThan(0);
  });

  it('PlanBuilder should produce identical plans with or without relationships', async () => {
    const file = createRealisticFileArtifact(
      'file-1',
      'C:\\Program Files\\TestApp\\TestApp.exe',
      'TestApp.exe',
    );
    const registry = createRealisticRegistryArtifact(
      'reg-1',
      'HKCU\\Software\\TestApp',
      { InstallPath: 'C:\\Program Files\\TestApp\\TestApp.exe' },
    );

    const snapshotWithoutRels: Snapshot = {
      id: 'test-snapshot-1',
      productId: testProduct.id,
      createdAt: Date.now(),
      artifacts: [file, registry],
      relationships: [],
    };

    // Correlate to add relationships
    const snapshotWithRels = await correlator.correlate(snapshotWithoutRels);

    // Build plans from both
    const planWithoutRels = await planBuilder.build({
      snapshot: snapshotWithoutRels,
      product: testProduct,
      mode: 'clean',
      options: {},
    });

    const planWithRels = await planBuilder.build({
      snapshot: snapshotWithRels,
      product: testProduct,
      mode: 'clean',
      options: {},
    });

    // Plans should have the same steps (relationships don't affect planning)
    expect(planWithRels.plan.steps.length).toBe(planWithoutRels.plan.steps.length);

    // Step actions and targets should match
    const actionsWithout = planWithoutRels.plan.steps.map(s => `${s.action}:${s.target}`).sort();
    const actionsWith = planWithRels.plan.steps.map(s => `${s.action}:${s.target}`).sort();
    expect(actionsWith).toEqual(actionsWithout);
  });

  it('should handle full realistic scenario with all artifact types', async () => {
    // Create a realistic set of artifacts
    const artifacts: Artifact[] = [
      // Files
      createRealisticFileArtifact(
        'file-exe',
        'C:\\Program Files\\TestApp\\TestApp.exe',
        'TestApp.exe',
      ),
      createRealisticFileArtifact(
        'file-helper',
        'C:\\Program Files\\TestApp\\TestAppHelper.exe',
        'TestAppHelper.exe',
      ),
      createRealisticFileArtifact(
        'file-service',
        'C:\\Program Files\\TestApp\\TestAppService.exe',
        'TestAppService.exe',
      ),
      createRealisticFileArtifact(
        'file-updater',
        'C:\\Program Files\\TestApp\\TestAppUpdater.exe',
        'TestAppUpdater.exe',
      ),

      // Registry
      createRealisticRegistryArtifact('reg-software', 'HKCU\\Software\\TestApp', {
        InstallPath: 'C:\\Program Files\\TestApp',
        MainExe: 'C:\\Program Files\\TestApp\\TestApp.exe',
        Version: '1.0.0',
      }),

      // Service
      createRealisticServiceArtifact(
        'svc-main',
        'TestAppService',
        '"C:\\Program Files\\TestApp\\TestAppService.exe" -service',
      ),

      // Process
      createRealisticProcessArtifact(
        'proc-main',
        'TestApp.exe',
        'C:\\Program Files\\TestApp\\TestApp.exe',
      ),

      // Task
      createRealisticTaskArtifact(
        'task-update',
        'TestAppUpdate',
        'C:\\Program Files\\TestApp\\TestAppUpdater.exe',
      ),
    ];

    const snapshot: Snapshot = {
      id: 'test-full-snapshot',
      productId: testProduct.id,
      createdAt: Date.now(),
      artifacts,
      relationships: [],
    };

    // Correlate
    const correlatedSnapshot = await correlator.correlate(snapshot);

    // Verify expected relationships
    const references = correlatedSnapshot.relationships.filter(r => r.type === 'references');
    const executes = correlatedSnapshot.relationships.filter(r => r.type === 'executes');
    const belongsTo = correlatedSnapshot.relationships.filter(r => r.type === 'belongs_to');

    // Registry should reference files
    expect(references.length).toBeGreaterThan(0);

    // Service, process, task should execute binaries
    expect(executes.length).toBe(3); // service, process, task

    // Every artifact should belong to product
    expect(belongsTo.length).toBe(artifacts.length);

    // Build plan
    const planResult = await planBuilder.build({
      snapshot: correlatedSnapshot,
      product: testProduct,
      mode: 'clean',
      options: {},
    });

    expect(planResult.plan.steps.length).toBeGreaterThan(0);

    // Verify plan has correct step types
    const stepActions = planResult.plan.steps.map(s => s.action);
    expect(stepActions).toContain('StopService');
    expect(stepActions).toContain('StopProcess');
    expect(stepActions).toContain('DeleteScheduledTask');
    expect(stepActions).toContain('RemoveFolder');
    expect(stepActions).toContain('DeleteRegistryKey');
  });
});

describe('Correlator Safety - Protected Path Non-Linkage', () => {
  let correlator: DefaultCorrelator;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
  });

  it('should NOT create relationship to file outside snapshot', async () => {
    // Registry points to system file not in snapshot
    const registry = createRealisticRegistryArtifact(
      'reg-1',
      'HKCU\\Software\\TestApp',
      { SystemPath: 'C:\\Windows\\System32\\kernel32.dll' },
    );

    const snapshot: Snapshot = {
      id: 'test-snapshot',
      productId: testProduct.id,
      createdAt: Date.now(),
      artifacts: [registry],
      relationships: [],
    };

    const result = await correlator.correlate(snapshot);

    // No references should be created (file not in snapshot)
    const references = result.relationships.filter(r => r.type === 'references');
    expect(references.length).toBe(0);
  });

  it('should only link to artifacts actually present in snapshot', async () => {
    const file = createRealisticFileArtifact(
      'file-1',
      'C:\\Program Files\\TestApp\\TestApp.exe',
      'TestApp.exe',
    );
    const registry = createRealisticRegistryArtifact(
      'reg-1',
      'HKCU\\Software\\TestApp',
      {
        MainExe: 'C:\\Program Files\\TestApp\\TestApp.exe', // Present
        OtherExe: 'C:\\Program Files\\OtherApp\\Other.exe', // Not present
      },
    );

    const snapshot: Snapshot = {
      id: 'test-snapshot',
      productId: testProduct.id,
      createdAt: Date.now(),
      artifacts: [file, registry],
      relationships: [],
    };

    const result = await correlator.correlate(snapshot);

    const references = result.relationships.filter(r => r.type === 'references');

    // Only one reference should exist (to the present file)
    expect(references.length).toBe(1);
    expect(references[0].toId).toBe('file-1');
  });
});

describe('Correlator Determinism', () => {
  let correlator: DefaultCorrelator;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
  });

  it('should produce identical relationships on repeated correlations', async () => {
    const artifacts: Artifact[] = [
      createRealisticFileArtifact('file-1', 'C:\\TestApp\\app.exe', 'app.exe'),
      createRealisticFileArtifact('file-2', 'C:\\TestApp\\helper.exe', 'helper.exe'),
      createRealisticRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        Main: 'C:\\TestApp\\app.exe',
        Helper: 'C:\\TestApp\\helper.exe',
      }),
      createRealisticServiceArtifact('svc-1', 'TestSvc', 'C:\\TestApp\\app.exe'),
    ];

    const snapshot: Snapshot = {
      id: 'test-snapshot',
      productId: 'test',
      createdAt: Date.now(),
      artifacts,
      relationships: [],
    };

    // Run correlation multiple times
    const results = await Promise.all([
      correlator.correlate(snapshot),
      correlator.correlate(snapshot),
      correlator.correlate(snapshot),
    ]);

    // All should be identical
    const rel1 = JSON.stringify(results[0].relationships);
    const rel2 = JSON.stringify(results[1].relationships);
    const rel3 = JSON.stringify(results[2].relationships);

    expect(rel1).toBe(rel2);
    expect(rel2).toBe(rel3);
  });

  it('should produce same output regardless of artifact order in input', async () => {
    const file1 = createRealisticFileArtifact('file-a', 'C:\\TestApp\\a.exe', 'a.exe');
    const file2 = createRealisticFileArtifact('file-b', 'C:\\TestApp\\b.exe', 'b.exe');
    const registry = createRealisticRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      PathA: 'C:\\TestApp\\a.exe',
      PathB: 'C:\\TestApp\\b.exe',
    });

    const snapshot1: Snapshot = {
      id: 'test-snapshot',
      productId: 'test',
      createdAt: Date.now(),
      artifacts: [file1, file2, registry], // Order 1
      relationships: [],
    };

    const snapshot2: Snapshot = {
      id: 'test-snapshot',
      productId: 'test',
      createdAt: Date.now(),
      artifacts: [registry, file2, file1], // Order 2
      relationships: [],
    };

    const result1 = await correlator.correlate(snapshot1);
    const result2 = await correlator.correlate(snapshot2);

    // Relationships should be sorted identically regardless of input order
    expect(JSON.stringify(result1.relationships)).toBe(JSON.stringify(result2.relationships));
  });
});

describe('Correlation Evidence Quality', () => {
  let correlator: DefaultCorrelator;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
  });

  it('should provide complete evidence for all relationships', async () => {
    const file = createRealisticFileArtifact('file-1', 'C:\\TestApp\\app.exe', 'app.exe');
    const registry = createRealisticRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      MainExe: 'C:\\TestApp\\app.exe',
    });
    const service = createRealisticServiceArtifact('svc-1', 'TestSvc', 'C:\\TestApp\\app.exe');

    const snapshot: Snapshot = {
      id: 'test-snapshot',
      productId: 'test',
      createdAt: Date.now(),
      artifacts: [file, registry, service],
      relationships: [],
    };

    const result = await correlator.correlate(snapshot);

    // All relationships should have evidence
    for (const rel of result.relationships) {
      expect(rel.evidence).toBeDefined();
      expect(Object.keys(rel.evidence!).length).toBeGreaterThan(0);
    }

    // Check specific evidence fields
    const refRel = result.relationships.find(r => r.type === 'references');
    expect(refRel?.evidence).toHaveProperty('registryKey');
    expect(refRel?.evidence).toHaveProperty('valueName');
    expect(refRel?.evidence).toHaveProperty('rawValue');

    const execRel = result.relationships.find(r => r.type === 'executes');
    expect(execRel?.evidence).toHaveProperty('sourceType');
    expect(execRel?.evidence).toHaveProperty('sourceName');
    expect(execRel?.evidence).toHaveProperty('binaryPath');

    const belongsRel = result.relationships.find(r => r.type === 'belongs_to');
    expect(belongsRel?.evidence).toHaveProperty('productId');
    expect(belongsRel?.evidence).toHaveProperty('vendor');
  });
});
