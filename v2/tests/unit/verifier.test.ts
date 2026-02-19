/**
 * Verifier Unit Tests
 *
 * Tests for:
 * - Snapshot diffing
 * - Individual invariants (pass, fail, not-applicable cases)
 * - Verifier aggregation logic
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Snapshot,
  Artifact,
  Plan,
  PlanStep,
  PlanBoundaries,
} from '../../src/shared/types';
import type { VerifyInput } from '../../src/main/core/verification/types';
import type { ProductDefinition } from '../../src/main/core/acquisition/types';
import { diffSnapshots, hasChanges, wasPathRemoved } from '../../src/main/core/verification/diff';
import { DefaultVerifier, createVerifier } from '../../src/main/core/verification/verifier';
import {
  NoVendorProcessesInvariant,
  NoVendorServicesInvariant,
  NoVendorTasksInvariant,
  NoOrphanedReferencesInvariant,
  PlanPromisesHeldInvariant,
  NoOutOfScopeDamageInvariant,
} from '../../src/main/core/verification/invariants';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestArtifact(
  id: string,
  type: string,
  path: string,
  vendor: string = 'Test Vendor',
): Artifact {
  return {
    id,
    type: type as any,
    owner: { vendor, product: 'test', confidence: 'high' },
    path,
    metadata: {},
    observedAt: Date.now(),
    source: 'filesystem' as any,
  };
}

function createProcessArtifact(
  id: string,
  name: string,
  pid: number,
  vendor: string = 'Test Vendor',
): Artifact {
  return {
    id,
    type: 'process',
    owner: { vendor, product: 'test', confidence: 'high' },
    metadata: { name, pid, executablePath: `C:\\TestApp\\${name}` },
    observedAt: Date.now(),
    source: 'process' as any,
  };
}

function createServiceArtifact(
  id: string,
  name: string,
  vendor: string = 'Test Vendor',
): Artifact {
  return {
    id,
    type: 'service',
    owner: { vendor, product: 'test', confidence: 'high' },
    path: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}`,
    metadata: {
      name,
      displayName: name,
      binaryPath: `C:\\TestApp\\${name}.exe`,
      startType: 'Automatic',
      currentState: 'Running',
      serviceType: 'Win32OwnProcess',
    },
    observedAt: Date.now(),
    source: 'service' as any,
  };
}

function createTaskArtifact(
  id: string,
  name: string,
  vendor: string = 'Test Vendor',
): Artifact {
  return {
    id,
    type: 'task',
    owner: { vendor, product: 'test', confidence: 'high' },
    path: `\\TestVendor\\${name}`,
    metadata: {
      name,
      path: `\\TestVendor\\${name}`,
      enabled: true,
      state: 'Ready',
      actions: [{ type: 'Execute', path: 'C:\\TestApp\\updater.exe' }],
      triggers: [],
    },
    observedAt: Date.now(),
    source: 'task' as any,
  };
}

function createRegistryArtifact(
  id: string,
  keyPath: string,
  values: Record<string, unknown> = {},
  vendor: string = 'Test Vendor',
): Artifact {
  return {
    id,
    type: 'registry',
    owner: { vendor, product: 'test', confidence: 'high' },
    path: keyPath,
    metadata: {
      hive: 'HKCU',
      keyPath: keyPath.replace(/^HK[A-Z]+\\/, ''),
      values,
      valueCount: Object.keys(values).length,
      exists: true,
    },
    observedAt: Date.now(),
    source: 'registry' as any,
  };
}

function createSnapshot(id: string, artifacts: Artifact[]): Snapshot {
  return {
    id,
    productId: 'test',
    createdAt: Date.now(),
    artifacts,
    relationships: [],
  };
}

function createPlan(
  steps: PlanStep[],
  mode: string = 'clean',
  boundaries?: Partial<PlanBoundaries>,
): Plan {
  return {
    id: 'test-plan',
    productId: 'test',
    mode: mode as any,
    createdAt: Date.now(),
    steps,
    dryRun: false,
    boundaries: {
      allowedPaths: boundaries?.allowedPaths ?? ['C:\\TestApp'],
      allowedRegistryPrefixes: boundaries?.allowedRegistryPrefixes ?? ['HKCU\\Software\\TestApp'],
      allowedServices: boundaries?.allowedServices ?? ['TestService'],
      allowedTasks: boundaries?.allowedTasks ?? ['\\TestVendor\\TestTask'],
    },
  };
}

function createStep(action: string, target: string): PlanStep {
  return {
    id: `step-${action}-${Date.now()}`,
    action: action as any,
    target,
    requiresAdmin: false,
    risk: 'low',
    reason: 'Test step',
  };
}

const testProduct: ProductDefinition = {
  id: 'test',
  vendor: 'Test Vendor',
  displayName: 'Test App',
  paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
  registry: { software: [], uninstall: [], services: [], other: [] },
  processes: [],
  services: [],
  tasks: [],
};

// ============================================================================
// Diff Tests
// ============================================================================

describe('Snapshot Diff', () => {
  it('should detect added artifacts', () => {
    const pre = createSnapshot('pre', []);
    const post = createSnapshot('post', [
      createTestArtifact('file-1', 'file', 'C:\\TestApp\\new.exe'),
    ]);

    const diff = diffSnapshots(pre, post);

    expect(diff.added.length).toBe(1);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
  });

  it('should detect removed artifacts', () => {
    const pre = createSnapshot('pre', [
      createTestArtifact('file-1', 'file', 'C:\\TestApp\\old.exe'),
    ]);
    const post = createSnapshot('post', []);

    const diff = diffSnapshots(pre, post);

    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(1);
    expect(diff.changed.length).toBe(0);
  });

  it('should detect unchanged artifacts as no change', () => {
    const artifact = createTestArtifact('file-1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [artifact]);
    const post = createSnapshot('post', [{ ...artifact, id: 'file-1-new' }]);

    const diff = diffSnapshots(pre, post);

    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0); // Same path = same artifact
  });

  it('should use hasChanges utility correctly', () => {
    const emptyDiff = { added: [], removed: [], changed: [] };
    expect(hasChanges(emptyDiff)).toBe(false);

    const addedDiff = { added: [createTestArtifact('1', 'file', 'C:\\x')], removed: [], changed: [] };
    expect(hasChanges(addedDiff)).toBe(true);
  });

  it('should use wasPathRemoved utility correctly', () => {
    const diff = {
      added: [],
      removed: [createTestArtifact('1', 'file', 'C:\\TestApp\\removed.exe')],
      changed: [],
    };

    expect(wasPathRemoved(diff, 'C:\\TestApp\\removed.exe')).toBe(true);
    expect(wasPathRemoved(diff, 'C:\\TestApp\\still-here.exe')).toBe(false);
  });
});

// ============================================================================
// Individual Invariant Tests
// ============================================================================

describe('NoVendorProcessesInvariant', () => {
  const invariant = NoVendorProcessesInvariant;

  it('should apply when plan mode is uninstall', () => {
    const plan = createPlan([], 'uninstall');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should apply when plan has StopProcess step', () => {
    const plan = createPlan([createStep('StopProcess', 'test.exe')], 'clean');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should NOT apply for audit mode with no stop steps', () => {
    const plan = createPlan([], 'audit');
    expect(invariant.appliesTo(plan)).toBe(false);
  });

  it('should PASS when no vendor processes remain', () => {
    const pre = createSnapshot('pre', [createProcessArtifact('p1', 'test.exe', 1234)]);
    const post = createSnapshot('post', []); // Process removed

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('StopProcess', 'test.exe')], 'clean'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should FAIL when vendor processes remain', () => {
    const process = createProcessArtifact('p1', 'test.exe', 1234, 'Test Vendor');
    const pre = createSnapshot('pre', [process]);
    const post = createSnapshot('post', [process]); // Still running

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('StopProcess', 'test.exe')], 'uninstall'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
    expect(result.evidence?.remainingProcesses).toBeDefined();
  });
});

describe('NoVendorServicesInvariant', () => {
  const invariant = NoVendorServicesInvariant;

  it('should apply for uninstall mode', () => {
    const plan = createPlan([], 'uninstall');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should apply for clean mode', () => {
    const plan = createPlan([], 'clean');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should NOT apply for repair mode', () => {
    const plan = createPlan([], 'repair');
    expect(invariant.appliesTo(plan)).toBe(false);
  });

  it('should PASS when no vendor services remain', () => {
    const pre = createSnapshot('pre', [createServiceArtifact('s1', 'TestService')]);
    const post = createSnapshot('post', []);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'uninstall'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should FAIL when vendor services remain', () => {
    const service = createServiceArtifact('s1', 'TestService', 'Test Vendor');
    const pre = createSnapshot('pre', [service]);
    const post = createSnapshot('post', [service]);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'uninstall'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
  });
});

describe('NoVendorTasksInvariant', () => {
  const invariant = NoVendorTasksInvariant;

  it('should PASS when no vendor tasks remain', () => {
    const pre = createSnapshot('pre', [createTaskArtifact('t1', 'TestTask')]);
    const post = createSnapshot('post', []);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'uninstall'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should FAIL when vendor tasks remain', () => {
    const task = createTaskArtifact('t1', 'TestTask', 'Test Vendor');
    const pre = createSnapshot('pre', [task]);
    const post = createSnapshot('post', [task]);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'clean'),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
  });
});

describe('NoOrphanedReferencesInvariant', () => {
  const invariant = NoOrphanedReferencesInvariant;

  it('should apply when RemoveFolder step exists', () => {
    const plan = createPlan([createStep('RemoveFolder', 'C:\\TestApp')]);
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should PASS when no orphaned references exist', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []); // File removed, no registry

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('RemoveFolder', 'C:\\TestApp')]),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should WARN when registry references removed file', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const registry = createRegistryArtifact('r1', 'HKCU\\Software\\TestApp', {
      Path: 'C:\\TestApp\\app.exe',
    });

    const pre = createSnapshot('pre', [file, registry]);
    const post = createSnapshot('post', [registry]); // File removed but registry remains

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('RemoveFolder', 'C:\\TestApp')]),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('warning'); // Advisory level
    expect(result.evidence?.orphanedReferences).toBeDefined();
  });
});

describe('PlanPromisesHeldInvariant', () => {
  const invariant = PlanPromisesHeldInvariant;

  it('should always apply', () => {
    const plan = createPlan([], 'audit');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should PASS when RemoveFolder step succeeded', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []); // Folder removed

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('RemoveFolder', 'C:\\TestApp')]),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should FAIL when RemoveFolder step did not remove folder', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', [file]); // Still there

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([createStep('RemoveFolder', 'C:\\TestApp')]),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
    expect(result.evidence?.brokenPromises).toBeDefined();
  });
});

describe('NoOutOfScopeDamageInvariant (CRITICAL)', () => {
  const invariant = NoOutOfScopeDamageInvariant;

  it('should always apply', () => {
    const plan = createPlan([], 'audit');
    expect(invariant.appliesTo(plan)).toBe(true);
  });

  it('should have critical severity', () => {
    expect(invariant.severity).toBe('critical');
  });

  it('should PASS when all removals are within boundaries', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'clean', { allowedPaths: ['C:\\TestApp'] }),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('pass');
  });

  it('should FAIL when removal is outside boundaries', () => {
    const file = createTestArtifact('f1', 'file', 'C:\\Windows\\System32\\evil.dll');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []); // File removed outside boundaries!

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'clean', { allowedPaths: ['C:\\TestApp'] }),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
    expect(result.details).toContain('CRITICAL');
    expect(result.evidence?.outOfScopeRemovals).toBeDefined();
  });

  it('should FAIL when registry removal is outside boundaries', () => {
    const registry = createRegistryArtifact('r1', 'HKLM\\SOFTWARE\\Microsoft\\Important');
    const pre = createSnapshot('pre', [registry]);
    const post = createSnapshot('post', []);

    const input: VerifyInput = {
      product: testProduct,
      plan: createPlan([], 'clean', { allowedRegistryPrefixes: ['HKCU\\Software\\TestApp'] }),
      preSnapshot: pre,
      postSnapshot: post,
    };

    const result = invariant.evaluate(input, diffSnapshots(pre, post));
    expect(result.status).toBe('fail');
  });
});

// ============================================================================
// Verifier Tests
// ============================================================================

describe('DefaultVerifier', () => {
  it('should create verifier with default invariants', () => {
    const verifier = new DefaultVerifier();
    expect(verifier.getInvariants().length).toBeGreaterThan(0);
  });

  it('should aggregate status correctly - all pass', async () => {
    const verifier = createVerifier();
    const pre = createSnapshot('pre', []);
    const post = createSnapshot('post', []);

    const result = await verifier.verify({
      product: testProduct,
      plan: createPlan([], 'audit'),
      preSnapshot: pre,
      postSnapshot: post,
    });

    expect(result.status).toBe('pass');
  });

  it('should aggregate status correctly - any fail = overall fail', async () => {
    const verifier = createVerifier();
    const file = createTestArtifact('f1', 'file', 'C:\\Outside\\evil.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []); // Removed outside boundaries

    const result = await verifier.verify({
      product: testProduct,
      plan: createPlan([], 'clean', { allowedPaths: ['C:\\TestApp'] }),
      preSnapshot: pre,
      postSnapshot: post,
    });

    expect(result.status).toBe('fail');
  });

  it('should include diff in result', async () => {
    const verifier = createVerifier();
    const file = createTestArtifact('f1', 'file', 'C:\\TestApp\\app.exe');
    const pre = createSnapshot('pre', [file]);
    const post = createSnapshot('post', []);

    const result = await verifier.verify({
      product: testProduct,
      plan: createPlan([], 'clean'),
      preSnapshot: pre,
      postSnapshot: post,
    });

    expect(result.diff).toBeDefined();
    expect(result.diff?.removed.length).toBe(1);
  });

  it('should only evaluate applicable invariants', async () => {
    const verifier = createVerifier();
    const pre = createSnapshot('pre', []);
    const post = createSnapshot('post', []);

    const result = await verifier.verify({
      product: testProduct,
      plan: createPlan([], 'audit'), // Most invariants don't apply
      preSnapshot: pre,
      postSnapshot: post,
    });

    // Only invariants that apply to audit should have checks
    expect(result.checks.length).toBeLessThan(verifier.getInvariants().length);
  });
});
