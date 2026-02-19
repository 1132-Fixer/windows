/**
 * FileSystemScanner - Read-Only Filesystem Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate vendor-defined filesystem locations
 * - Emit FileArtifact for each discovered file/folder
 * - Calculate SHA256 hashes (optional, bounded by size)
 *
 * NON-GOALS (NEVER DO):
 * ❌ No deletion
 * ❌ No chmod/ACL changes
 * ❌ No ADS traversal outside vendor paths
 * ❌ No heuristics, entropy scoring, or "suspicion" logic
 * ❌ No path discovery beyond product definition
 *
 * SAFETY INVARIANTS:
 * - All emitted paths ⊆ product allowlist
 * - Never throws for missing paths
 * - Output ordering is deterministic (sorted)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  Artifact,
  OwnerTag,
} from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  FileArtifact,
  SignatureInfo,
  ScanResult,
  ScanError,
} from '../types';

// ============================================================================
// Configuration
// ============================================================================

/** Maximum file size for SHA256 hashing (50MB) */
const MAX_HASH_SIZE = 50 * 1024 * 1024;

/** File extensions that are executables (for signature verification stub) */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.sys', '.msi', '.ocx', '.scr',
]);

// ============================================================================
// Environment Variable Expansion
// ============================================================================

/**
 * Expand Windows environment variables in a path
 * e.g., %APPDATA%\Zoom → C:\Users\user\AppData\Roaming\Zoom
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Normalize path for consistent comparison
 */
function normalizePath(inputPath: string): string {
  return path.normalize(inputPath).toLowerCase();
}

// ============================================================================
// Protected Path Check (Defensive Layer)
// ============================================================================

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  // Windows system directories
  /^[a-z]:\\windows($|\\)/i,  // Entire Windows directory
  /^[a-z]:\\windows\\system32/i,
  /^[a-z]:\\windows\\syswow64/i,
  /^[a-z]:\\windows\\winsxs/i,
  /^[a-z]:\\windows\\assembly/i,
  /^[a-z]:\\windows\\microsoft\.net/i,
  // Root-level protected directories
  /^[a-z]:\\$/i,
  /^[a-z]:\\boot($|\\)/i,
  /^[a-z]:\\recovery($|\\)/i,
  /^[a-z]:\\\$recycle\.bin/i,
  /^[a-z]:\\system volume information/i,
  // Program Files root (too broad - only specific app subfolders allowed)
  /^[a-z]:\\program files$/i,
  /^[a-z]:\\program files \(x86\)$/i,
  // User profile root (too broad - only specific app subfolders allowed)
  /^[a-z]:\\users\\[^\\]+$/i,
  /^%userprofile%$/i,
];

/**
 * Check if a path is a protected system location
 * This is a defensive check - should never trigger if product definition is correct
 */
function isProtectedPath(checkPath: string): boolean {
  const normalized = normalizePath(checkPath);
  // Check both raw path (for %USERPROFILE% etc) and normalized path
  return PROTECTED_PATH_PATTERNS.some(pattern =>
    pattern.test(normalized) || pattern.test(checkPath.toLowerCase()),
  );
}

// ============================================================================
// Hashing (Bounded)
// ============================================================================

/**
 * Calculate SHA256 hash of a file
 * Returns undefined if file is too large or read fails
 */
async function calculateHash(filePath: string, maxSize: number): Promise<string | undefined> {
  try {
    const stats = await fs.stat(filePath);

    // Skip files larger than limit
    if (stats.size > maxSize) {
      return undefined;
    }

    // Skip directories
    if (stats.isDirectory()) {
      return undefined;
    }

    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

// ============================================================================
// Signature Verification Stub (v3 implementation)
// ============================================================================

/**
 * Stub for signature verification
 * Full implementation deferred to v3 (requires native bindings)
 */
async function verifySignature(_filePath: string): Promise<SignatureInfo | undefined> {
  // v3: Use Authenticode verification
  // For now, return undefined (not verified)
  return undefined;
}

// ============================================================================
// Directory Walker
// ============================================================================

interface WalkOptions {
  followSymlinks: boolean;
  includePatterns: string[];
  excludePatterns: string[];
}

/**
 * Recursively walk a directory and yield file paths
 * Safe: handles errors gracefully, never throws
 */
async function* walkDirectory(
  rootPath: string,
  options: WalkOptions,
): AsyncGenerator<string> {
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const currentPath = queue.shift()!;

    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      // Permission denied, path doesn't exist, etc.
      continue;
    }

    // Sort for deterministic ordering
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      // Check if path matches exclude patterns
      if (matchesAnyPattern(fullPath, options.excludePatterns)) {
        continue;
      }

      // Handle symlinks
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          // Still emit the symlink itself, but don't follow it
          yield fullPath;
          continue;
        }
        // If following symlinks, resolve and check if directory
        try {
          const resolved = await fs.realpath(fullPath);
          const stats = await fs.stat(resolved);
          if (stats.isDirectory()) {
            queue.push(fullPath);
          }
          yield fullPath;
        } catch {
          // Broken symlink
          yield fullPath;
        }
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
        yield fullPath;
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}

/**
 * Check if a path matches any of the given glob patterns
 * Simple implementation for common patterns
 */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalized = normalizePath(filePath);

  for (const pattern of patterns) {
    const normalizedPattern = normalizePath(pattern);

    // Handle **/* pattern (match all)
    if (normalizedPattern === '**/*') {
      return true;
    }

    // Handle *.ext pattern
    if (normalizedPattern.startsWith('*')) {
      const ext = normalizedPattern.slice(1);
      if (normalized.endsWith(ext)) {
        return true;
      }
    }

    // Handle **/*.ext pattern
    if (normalizedPattern.startsWith('**/')) {
      const suffix = normalizedPattern.slice(3);
      if (suffix.startsWith('*')) {
        const ext = suffix.slice(1);
        if (normalized.endsWith(ext)) {
          return true;
        }
      }
    }

    // Direct match
    if (normalized === normalizedPattern || normalized.endsWith(normalizedPattern)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// FileSystemScanner Implementation
// ============================================================================

export class FileSystemScanner implements Scanner<FileArtifact> {
  readonly id = 'filesystem' as const;

  /**
   * Scan vendor-defined filesystem locations
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of FileArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<FileArtifact[]> {
    const { product } = ctx;
    const artifacts: FileArtifact[] = [];
    const errors: ScanError[] = [];

    // Collect all roots from product definition
    const roots = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
      ...product.paths.logs,
      ...product.paths.temp,
    ];

    // Build allowlist for validation
    const allowedRoots = roots.map(r => normalizePath(expandEnvVars(r)));

    // Walk options from product definition (with safe defaults)
    const walkOptions: WalkOptions = {
      followSymlinks: false, // Safe default
      includePatterns: ['**/*'],
      excludePatterns: [],
    };

    for (const root of roots) {
      const expandedRoot = expandEnvVars(root);
      const normalizedRoot = normalizePath(expandedRoot);

      // DEFENSIVE: Skip protected system paths
      // This should never trigger if product definition is correct
      if (isProtectedPath(expandedRoot)) {
        errors.push({
          path: expandedRoot,
          message: 'Skipped protected system path',
          code: 'PROTECTED_PATH',
        });
        continue;
      }

      // Check if root exists
      try {
        await fs.access(expandedRoot);
      } catch {
        // Root doesn't exist - this is normal, not an error
        continue;
      }

      // Walk the directory
      for await (const filePath of walkDirectory(expandedRoot, walkOptions)) {
        // SAFETY: Verify path is within allowed roots
        const normalizedPath = normalizePath(filePath);
        const isAllowed = allowedRoots.some(allowed =>
          normalizedPath.startsWith(allowed),
        );

        if (!isAllowed) {
          // This should never happen, but defensive check
          errors.push({
            path: filePath,
            message: 'Path outside allowed roots (skipped)',
            code: 'OUTSIDE_ALLOWLIST',
          });
          continue;
        }

        // Get file stats
        const artifact = await this.createFileArtifact(filePath, product);
        if (artifact) {
          artifacts.push(artifact);
        }
      }
    }

    // DETERMINISM: Sort artifacts by path
    artifacts.sort((a, b) => a.path.localeCompare(b.path));

    return artifacts;
  }

  /**
   * Create a FileArtifact from a file path
   */
  private async createFileArtifact(
    filePath: string,
    product: import('../types').ProductDefinition,
  ): Promise<FileArtifact | null> {
    try {
      const stats = await fs.lstat(filePath);
      const isSymlink = stats.isSymbolicLink();
      const isDirectory = stats.isDirectory();
      const ext = path.extname(filePath).toLowerCase();
      const isExecutable = EXECUTABLE_EXTENSIONS.has(ext);

      // Calculate hash for non-directory files within size limit
      let sha256: string | undefined;
      if (!isDirectory && !isSymlink) {
        sha256 = await calculateHash(filePath, MAX_HASH_SIZE);
      }

      // Signature verification stub (v3)
      let signature: SignatureInfo | undefined;
      if (isExecutable && !isDirectory && !isSymlink) {
        signature = await verifySignature(filePath);
      }

      const artifact: FileArtifact = {
        id: `file_${crypto.randomUUID()}`,
        type: 'file',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence: 'high', // Path is within product roots
        },
        path: filePath,
        metadata: {
          name: path.basename(filePath),
          extension: ext,
          size: stats.size,
          created: stats.birthtime.getTime(),
          modified: stats.mtime.getTime(),
          accessed: stats.atime.getTime(),
          isDirectory,
          isHidden: path.basename(filePath).startsWith('.'),
          isSystem: false, // Would need native API to detect
          isReadOnly: false, // Would need to check permissions
          sha256,
          signature,
        },
        observedAt: Date.now(),
        source: 'filesystem',
      };

      return artifact;
    } catch {
      // File may have been deleted between enumeration and stat
      return null;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createFileSystemScanner(): FileSystemScanner {
  return new FileSystemScanner();
}
