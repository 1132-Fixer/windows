/**
 * Correlator Unit Tests
 *
 * SAFETY INVARIANTS TO VERIFY:
 * - Artifacts are never modified
 * - Relationships are deterministic (same input → same output)
 * - All relationships have evidence
 * - No relationships to non-emitted paths
 * - No relationships to protected paths
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Snapshot,
  Artifact,
  Relationship,
} from '../../src/shared/types';
import type {
  FileArtifact,
  RegistryArtifact,
  ServiceArtifact,
  ProcessArtifact,
  TaskArtifact,
} from '../../src/main/core/acquisition/types';
import { DefaultCorrelator, createCorrelator } from '../../src/main/core/correlation/correlator';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestFileArtifact(id: string, filePath: string): FileArtifact {
  return {
    id,
    type: 'file',
    owner: { vendor: 'Test Vendor', product: 'test', confidence: 'high' },
    path: filePath,
    metadata: {
      name: filePath.split('\\').pop() || '',
      extension: '.exe',
      size: 1000,
      created: Date.now(),
      modified: Date.now(),
      accessed: Date.now(),
      isDirectory: false,
      isHidden: false,
      isSystem: false,
      isReadOnly: false,
    },
    observedAt: Date.now(),
    source: 'filesystem',
  };
}

function createTestRegistryArtifact(
  id: string,
  keyPath: string,
  values: Record<string, unknown>,
): RegistryArtifact {
  return {
    id,
    type: 'registry',
    owner: { vendor: 'Test Vendor', product: 'test', confidence: 'high' },
    path: keyPath,
    metadata: {
      hive: 'HKCU',
      keyPath: keyPath.replace(/^HK[A-Z]+\\/, ''),
      values,
      valueCount: Object.keys(values).length,
      exists: true,
    },
    observedAt: Date.now(),
    source: 'registry',
  };
}

function createTestServiceArtifact(
  id: string,
  serviceName: string,
  binaryPath: string,
): ServiceArtifact {
  return {
    id,
    type: 'service',
    owner: { vendor: 'Test Vendor', product: 'test', confidence: 'high' },
    path: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
    metadata: {
      name: serviceName,
      displayName: serviceName,
      binaryPath,
      startType: 'Automatic',
      currentState: 'Running',
      serviceType: 'Win32OwnProcess',
    },
    observedAt: Date.now(),
    source: 'service',
  };
}

function createTestProcessArtifact(
  id: string,
  processName: string,
  executablePath?: string,
): ProcessArtifact {
  return {
    id,
    type: 'process',
    owner: { vendor: 'Test Vendor', product: 'test', confidence: 'high' },
    metadata: {
      pid: 1234,
      name: processName,
      executablePath,
    },
    observedAt: Date.now(),
    source: 'process',
  };
}

function createTestTaskArtifact(
  id: string,
  taskName: string,
  actionPath?: string,
): TaskArtifact {
  return {
    id,
    type: 'task',
    owner: { vendor: 'Test Vendor', product: 'test', confidence: 'high' },
    path: `\\TestVendor\\${taskName}`,
    metadata: {
      name: taskName,
      path: `\\TestVendor\\${taskName}`,
      enabled: true,
      state: 'Ready',
      actions: actionPath
        ? [{ type: 'Execute', path: actionPath }]
        : [],
      triggers: [],
    },
    observedAt: Date.now(),
    source: 'task',
  };
}

function createTestSnapshot(artifacts: Artifact[]): Snapshot {
  return {
    id: 'test-snapshot-1',
    productId: 'test',
    createdAt: Date.now(),
    artifacts,
    relationships: [],
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

describe('Correlator', () => {
  let correlator: DefaultCorrelator;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
  });

  describe('Factory Function', () => {
    it('should create a correlator instance', () => {
      const instance = createCorrelator();
      expect(instance).toBeDefined();
      expect(instance.correlate).toBeDefined();
    });
  });

  describe('Empty Snapshot', () => {
    it('should handle empty snapshot gracefully', async () => {
      const snapshot = createTestSnapshot([]);
      const result = await correlator.correlate(snapshot);

      expect(result.relationships).toEqual([]);
      expect(result.artifacts).toEqual([]);
    });
  });

  describe('Belongs To Relationships', () => {
    it('should create belongs_to for every artifact', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {});

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      const belongsToRels = result.relationships.filter(r => r.type === 'belongs_to');
      expect(belongsToRels.length).toBe(2);

      // Each artifact should have exactly one belongs_to
      const fromIds = belongsToRels.map(r => r.fromId);
      expect(fromIds).toContain('file-1');
      expect(fromIds).toContain('reg-1');

      // All should point to product
      for (const rel of belongsToRels) {
        expect(rel.toId).toBe('product:test');
      }
    });

    it('should include evidence in belongs_to relationships', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const snapshot = createTestSnapshot([file]);
      const result = await correlator.correlate(snapshot);

      const belongsTo = result.relationships.find(r => r.type === 'belongs_to');
      expect(belongsTo).toBeDefined();
      expect(belongsTo?.evidence).toBeDefined();
      expect((belongsTo?.evidence as any).productId).toBe('test');
      expect((belongsTo?.evidence as any).vendor).toBe('Test Vendor');
    });
  });

  describe('Registry → File (references)', () => {
    it('should create references when registry value matches file path', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        InstallPath: 'C:\\TestApp\\app.exe',
      });

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(1);

      const rel = referencesRels[0];
      expect(rel.fromId).toBe('reg-1');
      expect(rel.toId).toBe('file-1');
    });

    it('should include evidence for references relationship', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        InstallPath: 'C:\\TestApp\\app.exe',
      });

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      const rel = result.relationships.find(r => r.type === 'references');
      expect(rel?.evidence).toBeDefined();
      expect((rel?.evidence as any).registryKey).toBe('HKCU\\Software\\Test');
      expect((rel?.evidence as any).valueName).toBe('InstallPath');
      expect((rel?.evidence as any).rawValue).toBe('C:\\TestApp\\app.exe');
    });

    it('should handle quoted paths in registry values', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\Program Files\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        Command: '"C:\\Program Files\\TestApp\\app.exe" --silent',
      });

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(1);
    });

    it('should handle case-insensitive path matching', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TESTAPP\\APP.EXE');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        Path: 'c:\\testapp\\app.exe',
      });

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(1);
    });

    it('should NOT create relationship for non-existent file paths', async () => {
      // Registry points to a path, but no matching file artifact exists
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        InstallPath: 'C:\\NonExistent\\app.exe',
      });

      const snapshot = createTestSnapshot([registry]);
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(0);
    });

    it('should handle multiple path values in same registry key', async () => {
      const file1 = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const file2 = createTestFileArtifact('file-2', 'C:\\TestApp\\helper.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        MainApp: 'C:\\TestApp\\app.exe',
        Helper: 'C:\\TestApp\\helper.exe',
      });

      const snapshot = createTestSnapshot([file1, file2, registry]);
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(2);
    });
  });

  describe('Service → Binary (executes)', () => {
    it('should create executes when service binaryPath matches file', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\service.exe');
      const service = createTestServiceArtifact('svc-1', 'TestService', 'C:\\TestApp\\service.exe');

      const snapshot = createTestSnapshot([file, service]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(1);

      const rel = executesRels[0];
      expect(rel.fromId).toBe('svc-1');
      expect(rel.toId).toBe('file-1');
    });

    it('should include evidence for service executes relationship', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\service.exe');
      const service = createTestServiceArtifact('svc-1', 'TestService', 'C:\\TestApp\\service.exe');

      const snapshot = createTestSnapshot([file, service]);
      const result = await correlator.correlate(snapshot);

      const rel = result.relationships.find(r => r.type === 'executes');
      expect(rel?.evidence).toBeDefined();
      expect((rel?.evidence as any).sourceType).toBe('service');
      expect((rel?.evidence as any).sourceName).toBe('TestService');
      expect((rel?.evidence as any).configField).toBe('binaryPath');
    });

    it('should handle quoted service binaryPath', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\Program Files\\TestApp\\service.exe');
      const service = createTestServiceArtifact(
        'svc-1',
        'TestService',
        '"C:\\Program Files\\TestApp\\service.exe" -service',
      );

      const snapshot = createTestSnapshot([file, service]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(1);
    });

    it('should NOT create relationship for non-existent binary', async () => {
      const service = createTestServiceArtifact('svc-1', 'TestService', 'C:\\NonExistent\\service.exe');

      const snapshot = createTestSnapshot([service]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(0);
    });
  });

  describe('Task → Binary (executes)', () => {
    it('should create executes when task action path matches file', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\updater.exe');
      const task = createTestTaskArtifact('task-1', 'TestUpdate', 'C:\\TestApp\\updater.exe');

      const snapshot = createTestSnapshot([file, task]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(1);

      const rel = executesRels[0];
      expect(rel.fromId).toBe('task-1');
      expect(rel.toId).toBe('file-1');
    });

    it('should include evidence for task executes relationship', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\updater.exe');
      const task = createTestTaskArtifact('task-1', 'TestUpdate', 'C:\\TestApp\\updater.exe');

      const snapshot = createTestSnapshot([file, task]);
      const result = await correlator.correlate(snapshot);

      const rel = result.relationships.find(r => r.type === 'executes');
      expect(rel?.evidence).toBeDefined();
      expect((rel?.evidence as any).sourceType).toBe('task');
      expect((rel?.evidence as any).sourceName).toBe('TestUpdate');
    });

    it('should NOT create relationship for task with no Execute action', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\updater.exe');
      const task = createTestTaskArtifact('task-1', 'TestUpdate'); // No action path

      const snapshot = createTestSnapshot([file, task]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(0);
    });
  });

  describe('Process → Binary (executes)', () => {
    it('should create executes when process executablePath matches file', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const process = createTestProcessArtifact('proc-1', 'app.exe', 'C:\\TestApp\\app.exe');

      const snapshot = createTestSnapshot([file, process]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(1);

      const rel = executesRels[0];
      expect(rel.fromId).toBe('proc-1');
      expect(rel.toId).toBe('file-1');
    });

    it('should include evidence for process executes relationship', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const process = createTestProcessArtifact('proc-1', 'app.exe', 'C:\\TestApp\\app.exe');

      const snapshot = createTestSnapshot([file, process]);
      const result = await correlator.correlate(snapshot);

      const rel = result.relationships.find(r => r.type === 'executes');
      expect(rel?.evidence).toBeDefined();
      expect((rel?.evidence as any).sourceType).toBe('process');
      expect((rel?.evidence as any).sourceName).toBe('app.exe');
    });

    it('should NOT create relationship for process without executablePath', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const process = createTestProcessArtifact('proc-1', 'app.exe'); // No executablePath

      const snapshot = createTestSnapshot([file, process]);
      const result = await correlator.correlate(snapshot);

      const executesRels = result.relationships.filter(r => r.type === 'executes');
      expect(executesRels.length).toBe(0);
    });
  });

  describe('Immutability', () => {
    it('should NOT modify input snapshot artifacts', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const originalArtifacts = [file];
      const snapshot = createTestSnapshot(originalArtifacts);

      // Deep copy for comparison
      const artifactsBefore = JSON.stringify(snapshot.artifacts);

      await correlator.correlate(snapshot);

      // Artifacts should be unchanged
      expect(JSON.stringify(snapshot.artifacts)).toBe(artifactsBefore);
    });

    it('should return new snapshot object', async () => {
      const snapshot = createTestSnapshot([]);
      const result = await correlator.correlate(snapshot);

      expect(result).not.toBe(snapshot);
    });
  });

  describe('Determinism', () => {
    it('should produce identical output for identical input', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        Path: 'C:\\TestApp\\app.exe',
      });
      const service = createTestServiceArtifact('svc-1', 'TestService', 'C:\\TestApp\\app.exe');

      const snapshot = createTestSnapshot([file, registry, service]);

      const result1 = await correlator.correlate(snapshot);
      const result2 = await correlator.correlate(snapshot);

      expect(JSON.stringify(result1.relationships)).toBe(JSON.stringify(result2.relationships));
    });

    it('should sort relationships by fromId, type, toId', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const reg1 = createTestRegistryArtifact('reg-a', 'HKCU\\Software\\TestA', {
        Path: 'C:\\TestApp\\app.exe',
      });
      const reg2 = createTestRegistryArtifact('reg-b', 'HKCU\\Software\\TestB', {
        Path: 'C:\\TestApp\\app.exe',
      });

      const snapshot = createTestSnapshot([file, reg2, reg1]); // Intentionally out of order
      const result = await correlator.correlate(snapshot);

      const referencesRels = result.relationships.filter(r => r.type === 'references');

      // Should be sorted by fromId
      expect(referencesRels[0].fromId).toBe('reg-a');
      expect(referencesRels[1].fromId).toBe('reg-b');
    });
  });

  describe('Deduplication', () => {
    it('should not create duplicate relationships', async () => {
      const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
      const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
        Path1: 'C:\\TestApp\\app.exe',
        Path2: 'C:\\TestApp\\app.exe', // Same path, different value name
      });

      const snapshot = createTestSnapshot([file, registry]);
      const result = await correlator.correlate(snapshot);

      // Should have 2 references (one per value name pointing to same file)
      // This is actually correct - they're different values
      const referencesRels = result.relationships.filter(r => r.type === 'references');
      expect(referencesRels.length).toBe(2);

      // But belongs_to should only be 2 (one per artifact)
      const belongsToRels = result.relationships.filter(r => r.type === 'belongs_to');
      expect(belongsToRels.length).toBe(2);
    });
  });
});

describe('Correlator Negative Tests (Critical Safety)', () => {
  let correlator: DefaultCorrelator;

  beforeEach(() => {
    correlator = new DefaultCorrelator();
  });

  it('should NOT create relationship for partial string match', async () => {
    const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
    const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      Description: 'This app is located at C:\\TestApp\\app', // Substring, not exact path
    });

    const snapshot = createTestSnapshot([file, registry]);
    const result = await correlator.correlate(snapshot);

    const referencesRels = result.relationships.filter(r => r.type === 'references');
    expect(referencesRels.length).toBe(0);
  });

  it('should NOT create relationship for non-path strings', async () => {
    const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
    const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      Version: '1.0.0',
      Name: 'TestApp',
      Enabled: 'true',
    });

    const snapshot = createTestSnapshot([file, registry]);
    const result = await correlator.correlate(snapshot);

    const referencesRels = result.relationships.filter(r => r.type === 'references');
    expect(referencesRels.length).toBe(0);
  });

  it('should NOT create relationship for URL strings', async () => {
    const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
    const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      UpdateUrl: 'https://example.com/update',
    });

    const snapshot = createTestSnapshot([file, registry]);
    const result = await correlator.correlate(snapshot);

    const referencesRels = result.relationships.filter(r => r.type === 'references');
    expect(referencesRels.length).toBe(0);
  });

  it('should NOT follow symlinks or resolve indirect paths', async () => {
    // If a registry points to a symlink, don't resolve it
    // This test is conceptual - the correlator only matches exact normalized paths
    const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
    const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      Path: 'C:\\Symlink\\app.exe', // Different path, even if it's a symlink
    });

    const snapshot = createTestSnapshot([file, registry]);
    const result = await correlator.correlate(snapshot);

    const referencesRels = result.relationships.filter(r => r.type === 'references');
    expect(referencesRels.length).toBe(0); // No match because paths are different
  });

  it('should handle null/undefined values in registry gracefully', async () => {
    const file = createTestFileArtifact('file-1', 'C:\\TestApp\\app.exe');
    const registry = createTestRegistryArtifact('reg-1', 'HKCU\\Software\\Test', {
      NullValue: null,
      UndefinedValue: undefined,
      EmptyString: '',
      ValidPath: 'C:\\TestApp\\app.exe',
    });

    const snapshot = createTestSnapshot([file, registry]);

    // Should not throw
    const result = await correlator.correlate(snapshot);

    const referencesRels = result.relationships.filter(r => r.type === 'references');
    expect(referencesRels.length).toBe(1); // Only ValidPath matches
  });

  it('should handle artifacts with missing optional fields', async () => {
    const process: ProcessArtifact = {
      id: 'proc-1',
      type: 'process',
      owner: { vendor: 'Test', product: 'test', confidence: 'high' },
      metadata: {
        pid: 1234,
        name: 'test.exe',
        // executablePath is optional and missing
      },
      observedAt: Date.now(),
      source: 'process',
    };

    const snapshot = createTestSnapshot([process]);

    // Should not throw
    const result = await correlator.correlate(snapshot);

    const executesRels = result.relationships.filter(r => r.type === 'executes');
    expect(executesRels.length).toBe(0);
  });
});
