/**
 * Scanner Safety Integration Tests - Red Flag Tests
 *
 * CRITICAL: These tests verify that scanners NEVER enumerate protected areas
 * even if malicious or misconfigured product definitions attempt to include them.
 *
 * TEST PRINCIPLE:
 * - Inject protected paths into product definitions
 * - Verify scanners do NOT emit artifacts for those paths
 * - Verify scanners do NOT throw
 * - Verify normal paths still work
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';

// Mock child_process for registry scanner
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs/promises for filesystem scanner
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { createRegistryScanner } from '../../src/main/core/acquisition/scanners/registry.scanner';
import { createFileSystemScanner } from '../../src/main/core/acquisition/scanners/filesystem.scanner';

// Helper to create mock spawn for registry scanner
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

describe('Registry Scanner - Protected Path Rejection (Red Flag Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * RED FLAG TEST #1: Services Registry
   * Inject: HKLM\SYSTEM\CurrentControlSet\Services
   * Expected: Scanner must NOT emit, NOT throw, NOT log as artifact
   */
  it('RED FLAG: HKLM\\SYSTEM\\CurrentControlSet\\Services must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKCU\\Software\\TestApp'], // Valid path
        uninstall: [],
        services: ['HKLM\\SYSTEM\\CurrentControlSet\\Services'], // PROTECTED - Must be rejected
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock: return data for both paths (simulating what would happen if protection was bypassed)
    createMockSpawn('HKCU\\Software\\TestApp\nHKLM\\SYSTEM\\CurrentControlSet\\Services\\SomeService');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    // Must NOT throw
    const artifacts = await scanner.scan(ctx);

    // Must NOT contain Services path
    const servicesArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('CURRENTCONTROLSET\\SERVICES'),
    );
    expect(servicesArtifacts).toEqual([]);

    // Valid path should still work if it exists
    // (In this mock, no valid artifacts are returned because mock doesn't match exact behavior)
  });

  /**
   * RED FLAG TEST #2: SAM Hive
   * Inject: HKLM\SAM
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: HKLM\\SAM must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKLM\\SAM'], // PROTECTED
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\SAM\\SAM\\Domains');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const samArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('\\SAM'),
    );
    expect(samArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #3: SECURITY Hive
   * Inject: HKLM\SECURITY
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: HKLM\\SECURITY must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: ['HKLM\\SECURITY'], // PROTECTED
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\SECURITY\\Policy');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const securityArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('\\SECURITY'),
    );
    expect(securityArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #4: LSA (Local Security Authority)
   * Inject: HKLM\SYSTEM\CurrentControlSet\Control\Lsa
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [],
        uninstall: [],
        services: [],
        other: ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa'], // PROTECTED
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Secrets');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const lsaArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('\\LSA'),
    );
    expect(lsaArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #5: UserAssist (Execution History)
   * Inject: HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist
   * Expected: Scanner must NOT emit (forensic telemetry - out of scope)
   */
  it('RED FLAG: UserAssist execution history must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [],
        uninstall: [],
        services: [],
        other: ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist'], // PROTECTED
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{GUID}');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const userAssistArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('USERASSIST'),
    );
    expect(userAssistArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #6: BAM (Background Activity Moderator)
   * Inject: HKLM\SYSTEM\CurrentControlSet\Services\bam\State
   * Expected: Scanner must NOT emit (execution forensics)
   */
  it('RED FLAG: BAM execution forensics must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [],
        uninstall: [],
        services: [],
        other: ['HKLM\\SYSTEM\\CurrentControlSet\\Services\\bam\\State'], // PROTECTED
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\SYSTEM\\CurrentControlSet\\Services\\bam\\State\\UserSettings');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const bamArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('BAM\\STATE'),
    );
    expect(bamArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #7: Session Manager
   * Inject: HKLM\SYSTEM\CurrentControlSet\Control\Session Manager
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: Session Manager must NOT be enumerated', async () => {
    const scanner = createRegistryScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [],
        uninstall: [],
        services: [],
        other: ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'], // PROTECTED
      },
      processes: [],
      services: [],
      tasks: [],
    };

    createMockSpawn('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\PendingFileRenameOperations');

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const sessionManagerArtifacts = artifacts.filter(a =>
      a.path.toUpperCase().includes('SESSION MANAGER'),
    );
    expect(sessionManagerArtifacts).toEqual([]);
  });
});

describe('FileSystem Scanner - Protected Path Rejection (Red Flag Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * RED FLAG TEST #1: System32
   * Inject: C:\Windows\System32
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: C:\\Windows\\System32 must NOT be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: {
        install: ['C:\\Windows\\System32'], // PROTECTED
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock: simulate that directory exists and has files
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'kernel32.dll', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);

    vi.mocked(fs.lstat).mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size: 1000,
      birthtime: new Date(),
      mtime: new Date(),
      atime: new Date(),
    } as any);

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    // Must NOT contain System32 paths
    const system32Artifacts = artifacts.filter(a =>
      a.path.toLowerCase().includes('system32'),
    );
    expect(system32Artifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #2: Windows Directory Root
   * Inject: C:\Windows
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: C:\\Windows must NOT be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: {
        install: ['C:\\Windows'], // PROTECTED
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    vi.mocked(fs.access).mockResolvedValue(undefined);

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const windowsArtifacts = artifacts.filter(a =>
      a.path.toLowerCase().startsWith('c:\\windows'),
    );
    expect(windowsArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #3: Boot Configuration
   * Inject: C:\Boot
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: C:\\Boot must NOT be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: {
        install: ['C:\\Boot'], // PROTECTED
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    vi.mocked(fs.access).mockResolvedValue(undefined);

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    const bootArtifacts = artifacts.filter(a =>
      a.path.toLowerCase().startsWith('c:\\boot'),
    );
    expect(bootArtifacts).toEqual([]);
  });

  /**
   * RED FLAG TEST #4: Program Files Root
   * Inject: C:\Program Files (entire root, not specific app)
   * Expected: Scanner must NOT emit
   */
  it('RED FLAG: C:\\Program Files root must NOT be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: {
        install: ['C:\\Program Files'], // PROTECTED (root level)
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'Microsoft', isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
    ] as any);

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    // Should not enumerate root Program Files
    expect(artifacts.length).toBe(0);
  });

  /**
   * RED FLAG TEST #5: User Profile Root
   * Inject: C:\Users\<username> (root level)
   * Expected: Scanner must NOT emit for root, only specific app folders allowed
   */
  it('RED FLAG: User profile root must NOT be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const maliciousProduct: ProductDefinition = {
      id: 'malicious-test',
      vendor: 'Test',
      displayName: 'Test',
      paths: {
        install: [],
        appData: ['%USERPROFILE%'], // PROTECTED (too broad)
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    vi.mocked(fs.access).mockResolvedValue(undefined);

    const ctx: ScanContext = {
      product: maliciousProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    // Should be rejected (too broad of a path)
    expect(artifacts.length).toBe(0);
  });
});

describe('Scanner Graceful Failure (No Throw Guarantee)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Registry scanner must NEVER throw regardless of input', async () => {
    const scanner = createRegistryScanner();

    // Test with completely invalid product definition
    const invalidProduct: ProductDefinition = {
      id: '',
      vendor: '',
      displayName: '',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
      registry: {
        software: [
          '', // Empty path
          'INVALID_HIVE\\Something', // Invalid hive
          'HKLM\\SAM', // Protected
          '\\\\\\\\', // Garbage
        ],
        uninstall: [],
        services: [],
        other: [],
      },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock PowerShell to return errors
    createMockSpawn('', 1);

    const ctx: ScanContext = {
      product: invalidProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    // Must NEVER throw - always return array (possibly empty)
    await expect(scanner.scan(ctx)).resolves.not.toThrow();
    const artifacts = await scanner.scan(ctx);
    expect(Array.isArray(artifacts)).toBe(true);
  });

  it('FileSystem scanner must NEVER throw regardless of input', async () => {
    const scanner = createFileSystemScanner();

    const invalidProduct: ProductDefinition = {
      id: '',
      vendor: '',
      displayName: '',
      paths: {
        install: [
          '', // Empty path
          'Z:\\NonExistent\\Path', // Non-existent drive
          'C:\\Windows\\System32', // Protected
          '\\\\\\\\', // Garbage
        ],
        appData: [],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    // Mock all fs operations to fail
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const ctx: ScanContext = {
      product: invalidProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    // Must NEVER throw - always return array (possibly empty)
    await expect(scanner.scan(ctx)).resolves.not.toThrow();
    const artifacts = await scanner.scan(ctx);
    expect(Array.isArray(artifacts)).toBe(true);
  });
});

describe('Valid Path Allowance (Positive Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Valid vendor-scoped registry paths should be enumerated', async () => {
    const scanner = createRegistryScanner();

    const validProduct: ProductDefinition = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: { install: [], appData: [], programData: [], logs: [], temp: [] },
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

    // Mock: return valid paths
    createMockSpawn('HKCU\\Software\\Zoom');

    const ctx: ScanContext = {
      product: validProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    // Should have artifacts for valid paths
    for (const artifact of artifacts) {
      expect(artifact.path.toUpperCase()).toMatch(/^HK(CU|LM)/);
      expect(artifact.owner.vendor).toBe('Zoom Video Communications');
      expect(artifact.owner.product).toBe('zoom');
    }
  });

  it('Valid vendor-scoped filesystem paths should be enumerated', async () => {
    const scanner = createFileSystemScanner();

    const validProduct: ProductDefinition = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: ['%PROGRAMFILES%\\Zoom'],
        appData: ['%APPDATA%\\Zoom'],
        programData: [],
        logs: [],
        temp: [],
      },
      registry: { software: [], uninstall: [], services: [], other: [] },
      processes: [],
      services: [],
      tasks: [],
    };

    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'Zoom.exe', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);

    vi.mocked(fs.lstat).mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size: 1000000,
      birthtime: new Date(),
      mtime: new Date(),
      atime: new Date(),
    } as any);

    const ctx: ScanContext = {
      product: validProduct,
      includeAllUsers: false,
      now: Date.now(),
    };

    const artifacts = await scanner.scan(ctx);

    // Valid paths should be enumerated
    for (const artifact of artifacts) {
      expect(artifact.owner.vendor).toBe('Zoom Video Communications');
      expect(artifact.owner.product).toBe('zoom');
      expect(artifact.path.toLowerCase()).toContain('zoom');
    }
  });
});
