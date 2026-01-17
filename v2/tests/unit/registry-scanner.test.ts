/**
 * RegistryScanner Unit Tests
 *
 * SAFETY INVARIANTS TO VERIFY:
 * - All registry paths must start with an allowlisted prefix
 * - Registry read errors → emit exists: false, do not throw
 * - Deterministic key ordering (alphabetical)
 * - Protected registry paths are never emitted
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';

// Mock child_process for testing without actual registry access
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { RegistryScanner, createRegistryScanner } from '../../src/main/core/acquisition/scanners/registry.scanner';

// Helper to create mock spawn
function createMockSpawn(stdout: string, exitCode: number = 0) {
  const mockProcess = {
    stdout: {
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from(stdout));
        }
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event, callback) => {
      if (event === 'close') {
        setTimeout(() => callback(exitCode), 10);
      }
    }),
    kill: vi.fn(),
  };

  vi.mocked(spawn).mockReturnValue(mockProcess as any);
  return mockProcess;
}

describe('RegistryScanner', () => {
  let scanner: RegistryScanner;
  let product: ProductDefinition;
  let ctx: ScanContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    scanner = createRegistryScanner();

    product = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: [],
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: {
        software: ['HKCU\\Software\\Zoom', 'HKLM\\Software\\Zoom'],
        uninstall: ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom'],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    ctx = {
      product,
      includeAllUsers: false,
      now: Date.now(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Scanner ID', () => {
    it('should have correct scanner ID', () => {
      expect(scanner.id).toBe('registry');
    });
  });

  describe('Ownership Confidence', () => {
    it('should set high confidence for keys within product prefixes', async () => {
      // Mock: key exists with some values
      createMockSpawn('True');

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.owner.confidence).toBe('high');
        expect(artifact.owner.vendor).toBe(product.vendor);
        expect(artifact.owner.product).toBe(product.id);
      }
    });
  });

  describe('Artifact Type', () => {
    it('should set type to "registry" for all artifacts', async () => {
      createMockSpawn('HKCU\\Software\\Zoom');

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.type).toBe('registry');
      }
    });
  });

  describe('Scanner Source', () => {
    it('should set source to "registry" for all artifacts', async () => {
      createMockSpawn('HKCU\\Software\\Zoom');

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.source).toBe('registry');
      }
    });
  });

  describe('Empty/Missing Keys', () => {
    it('should handle non-existent registry keys gracefully', async () => {
      // Mock: key doesn't exist
      createMockSpawn('False');

      // Should not throw
      const artifacts = await scanner.scan(ctx);

      expect(Array.isArray(artifacts)).toBe(true);
    });

    it('should skip prefixes that do not exist', async () => {
      createMockSpawn('False');

      const artifacts = await scanner.scan(ctx);

      // Empty result is valid for non-existent keys
      expect(artifacts.length).toBe(0);
    });
  });
});

describe('RegistryScanner Safety Invariants', () => {
  let scanner: RegistryScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scanner = createRegistryScanner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('INVARIANT: All emitted paths must start with allowlisted prefix', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKCU\\Software\\TestApp'],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock: return some keys
    createMockSpawn('HKCU\\Software\\TestApp\nHKCU\\Software\\TestApp\\Settings');

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    // All paths should start with the prefix
    for (const artifact of artifacts) {
      const startsWithPrefix = artifact.path.toUpperCase().startsWith('HKCU\\SOFTWARE\\TESTAPP');
      expect(startsWithPrefix).toBe(true);
    }
  });

  it('INVARIANT: Scanner must never throw for registry errors', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKCU\\Software\\NonExistent'],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock: PowerShell fails
    createMockSpawn('', 1);

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };

    // Must not throw
    await expect(scanner.scan(ctx)).resolves.not.toThrow();
  });

  it('INVARIANT: Protected registry paths must never be emitted', async () => {
    // This tests defensive behavior - even if somehow a protected path
    // was included, it should be filtered out

    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [
          'HKLM\\SAM', // Protected - should be skipped
          'HKLM\\SECURITY', // Protected - should be skipped
          'HKCU\\Software\\TestApp', // Valid
        ],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKCU\\Software\\TestApp');

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    // No SAM or SECURITY keys should be emitted
    const protectedArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('\\SAM') ||
      a.path.toUpperCase().includes('\\SECURITY'),
    );
    expect(protectedArtifacts).toEqual([]);
  });

  it('INVARIANT: Execution history keys must never be emitted', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [
          'HKCU\\Software\\TestApp',
        ],
        uninstall: [],
        services: [],
        other: [
          // These are forensic telemetry - out of scope
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist',
          'HKLM\\SYSTEM\\CurrentControlSet\\Services\\bam\\State',
        ],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKCU\\Software\\TestApp');

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    // No UserAssist or BAM keys should be emitted
    const forensicArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('USERASSIST') ||
      a.path.toUpperCase().includes('BAM\\STATE'),
    );
    expect(forensicArtifacts).toEqual([]);
  });
});

describe('RegistryScanner Hive Handling', () => {
  let scanner: RegistryScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scanner = createRegistryScanner();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should correctly identify HKCU hive', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKCU\\Software\\Test'],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKCU\\Software\\Test');

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    for (const artifact of artifacts) {
      if (artifact.path.toUpperCase().startsWith('HKCU')) {
        expect(artifact.metadata.hive).toBe('HKCU');
      }
    }
  });

  it('should correctly identify HKLM hive', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKLM\\Software\\Test'],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\Software\\Test');

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    for (const artifact of artifacts) {
      if (artifact.path.toUpperCase().startsWith('HKLM')) {
        expect(artifact.metadata.hive).toBe('HKLM');
      }
    }
  });
});
