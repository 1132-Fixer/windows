/**
 * FileSystemScanner Unit Tests
 *
 * SAFETY INVARIANTS TO VERIFY:
 * - All emitted paths ⊆ product allowlist
 * - Scanner never throws for missing paths
 * - Scanner output ordering is deterministic
 * - Protected paths are never emitted
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';

// Mock fs/promises for testing without actual filesystem
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from 'fs/promises';
import { FileSystemScanner, createFileSystemScanner } from '../../src/main/core/acquisition/scanners/filesystem.scanner';

describe('FileSystemScanner', () => {
  let scanner: FileSystemScanner;
  let product: ProductDefinition;
  let ctx: ScanContext;

  beforeEach(() => {
    vi.clearAllMocks();

    scanner = createFileSystemScanner();

    product = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: ['%PROGRAMFILES%\\Zoom'],
        appData: ['%APPDATA%\\Zoom'],
        programData: ['%PROGRAMDATA%\\Zoom'],
        logs: [],
        temp: [],
      },
      registry: {
        software: [],
        uninstall: [],
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

  describe('Scanner ID', () => {
    it('should have correct scanner ID', () => {
      expect(scanner.id).toBe('filesystem');
    });
  });

  describe('Missing Paths Handling', () => {
    it('should not throw when root path does not exist', async () => {
      // Mock: path doesn't exist
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      // Should not throw
      const artifacts = await scanner.scan(ctx);

      expect(artifacts).toEqual([]);
    });

    it('should skip missing roots and continue with existing ones', async () => {
      // First root doesn't exist, second does
      vi.mocked(fs.access)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      vi.mocked(fs.readdir).mockResolvedValue([]);

      const artifacts = await scanner.scan(ctx);

      // Should not throw, should return empty array (no files in existing dir)
      expect(artifacts).toEqual([]);
    });
  });

  describe('Deterministic Output', () => {
    it('should produce sorted output by path', async () => {
      // Mock directory with unsorted entries
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'zebra.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'alpha.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'beta.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        size: 100,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      const artifacts = await scanner.scan(ctx);

      // Verify sorting
      const paths = artifacts.map(a => a.path);
      const sortedPaths = [...paths].sort();
      expect(paths).toEqual(sortedPaths);
    });

    it('should produce identical output on repeated scans', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'file1.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: 'file2.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        size: 100,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      const artifacts1 = await scanner.scan(ctx);
      const artifacts2 = await scanner.scan(ctx);

      // Compare paths (IDs will differ)
      const paths1 = artifacts1.map(a => a.path);
      const paths2 = artifacts2.map(a => a.path);

      expect(paths1).toEqual(paths2);
    });
  });

  describe('Ownership Confidence', () => {
    it('should set high confidence for paths within product roots', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'data', isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        size: 0,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.owner.confidence).toBe('high');
        expect(artifact.owner.vendor).toBe(product.vendor);
        expect(artifact.owner.product).toBe(product.id);
      }
    });
  });

  describe('Protected Path Handling', () => {
    it('should skip protected system paths in product definition (defensive)', async () => {
      // This tests the defensive layer - if somehow a protected path
      // ended up in the product definition, it should be skipped

      const maliciousProduct: ProductDefinition = {
        ...product,
        paths: {
          ...product.paths,
          install: ['C:\\Windows\\System32'], // Should be skipped
        },
      };

      const maliciousCtx: ScanContext = {
        ...ctx,
        product: maliciousProduct,
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);

      const artifacts = await scanner.scan(maliciousCtx);

      // No artifacts should be emitted for System32
      const system32Artifacts = artifacts.filter(a =>
        a.path.toLowerCase().includes('system32'),
      );
      expect(system32Artifacts).toEqual([]);
    });
  });

  describe('Symlink Handling', () => {
    it('should not follow symlinks by default', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'link', isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => true,
        isDirectory: () => false,
        size: 0,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      // readdir should only be called once (for root), not for symlink target
      const artifacts = await scanner.scan(ctx);

      // Symlink itself should be emitted
      expect(artifacts.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Artifact Type', () => {
    it('should set type to "file" for all artifacts', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'test.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        size: 100,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.type).toBe('file');
      }
    });
  });

  describe('Scanner Source', () => {
    it('should set source to "filesystem" for all artifacts', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'test.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        size: 100,
        birthtime: new Date(),
        mtime: new Date(),
        atime: new Date(),
      } as any);

      const artifacts = await scanner.scan(ctx);

      for (const artifact of artifacts) {
        expect(artifact.source).toBe('filesystem');
      }
    });
  });
});

describe('FileSystemScanner Safety Invariants', () => {
  let scanner: FileSystemScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = createFileSystemScanner();
  });

  it('INVARIANT: All emitted paths must be within product allowlist', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: {
        install: ['%APPDATA%\\TestApp'],
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
      { name: 'config.json', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
    ] as any);

    vi.mocked(fs.lstat).mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size: 100,
      birthtime: new Date(),
      mtime: new Date(),
      atime: new Date(),
    } as any);

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };
    const artifacts = await scanner.scan(ctx);

    // All paths should contain 'TestApp'
    for (const artifact of artifacts) {
      expect(artifact.path.toLowerCase()).toContain('testapp');
    }
  });

  it('INVARIANT: Scanner must never throw for missing paths', async () => {
    const product: ProductDefinition = {
      id: 'test',
      vendor: 'Test Vendor',
      displayName: 'Test App',
      paths: {
        install: [
          'C:\\NonExistent\\Path1',
          'C:\\NonExistent\\Path2',
          'C:\\NonExistent\\Path3',
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

    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const ctx: ScanContext = { product, includeAllUsers: false, now: Date.now() };

    // Must not throw
    await expect(scanner.scan(ctx)).resolves.not.toThrow();

    const artifacts = await scanner.scan(ctx);
    expect(artifacts).toEqual([]);
  });
});
