/**
 * RegistryScanner - Read-Only Registry Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate vendor-scoped registry keys and values
 * - Emit RegistryArtifact for each discovered key
 *
 * NON-GOALS (NEVER DO):
 * ❌ No deletion
 * ❌ No value modification
 * ❌ No enumeration of execution history (UserAssist, BAM, etc.)
 * ❌ No discovery outside allowlisted prefixes
 *
 * SAFETY INVARIANTS:
 * - All registry paths must start with an allowlisted prefix
 * - Registry read errors → emit exists: false, do not throw
 * - Deterministic key ordering (alphabetical)
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type {
  OwnerTag,
} from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  RegistryArtifact,
  RegistryValueType,
  ScanError,
} from '../types';

// ============================================================================
// Protected Registry Patterns (Defensive Layer)
// ============================================================================

const PROTECTED_REGISTRY_PATTERNS: RegExp[] = [
  // System-critical registry keys
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Services($|\\)/i, // All services registry
  /^HKLM\\BCD/i,
  /^HKLM\\SAM/i,
  /^HKLM\\SECURITY/i,
  /^HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows$/i,
  /^HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies$/i,
  /^HKLM\\SOFTWARE\\Microsoft\\\.NETFramework/i,
  // Execution history (forensic telemetry - out of scope)
  /UserAssist/i,
  /BAM\\State/i,
  /DAM\\State/i,
  /MuiCache/i,
  /AppCompatFlags/i,
];

/**
 * Check if a registry path is protected
 */
function isProtectedRegistry(keyPath: string): boolean {
  return PROTECTED_REGISTRY_PATTERNS.some(pattern => pattern.test(keyPath));
}

/**
 * Normalize registry path for comparison
 * Converts short hive names to full names and normalizes case
 */
function normalizeRegistryPath(keyPath: string): string {
  let normalized = keyPath.trim();

  // Expand short hive names
  const hiveMap: Record<string, string> = {
    'HKCU': 'HKEY_CURRENT_USER',
    'HKLM': 'HKEY_LOCAL_MACHINE',
    'HKU': 'HKEY_USERS',
    'HKCR': 'HKEY_CLASSES_ROOT',
    'HKCC': 'HKEY_CURRENT_CONFIG',
  };

  for (const [short, full] of Object.entries(hiveMap)) {
    if (normalized.toUpperCase().startsWith(short + '\\')) {
      normalized = full + normalized.slice(short.length);
      break;
    }
  }

  return normalized;
}

/**
 * Get short hive name from full path
 */
function getHive(keyPath: string): RegistryArtifact['metadata']['hive'] {
  const upper = keyPath.toUpperCase();
  if (upper.startsWith('HKEY_CURRENT_USER') || upper.startsWith('HKCU')) return 'HKCU';
  if (upper.startsWith('HKEY_LOCAL_MACHINE') || upper.startsWith('HKLM')) return 'HKLM';
  if (upper.startsWith('HKEY_USERS') || upper.startsWith('HKU')) return 'HKU';
  if (upper.startsWith('HKEY_CLASSES_ROOT') || upper.startsWith('HKCR')) return 'HKCR';
  if (upper.startsWith('HKEY_CURRENT_CONFIG') || upper.startsWith('HKCC')) return 'HKCC';
  return 'HKCU'; // Default
}

/**
 * Extract key path without hive
 */
function getKeyPath(fullPath: string): string {
  const normalized = normalizeRegistryPath(fullPath);
  const firstSlash = normalized.indexOf('\\');
  if (firstSlash === -1) return '';
  return normalized.slice(firstSlash + 1);
}

// ============================================================================
// PowerShell Registry Access
// ============================================================================

interface RegistryKeyData {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
  subkeys: string[];
  error?: string;
}

/**
 * Execute PowerShell command and return output
 */
async function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Don't reject on registry access errors - they're expected
        resolve('');
      }
    });

    ps.on('error', (err) => {
      reject(err);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      ps.kill();
      resolve('');
    }, 30000);
  });
}

/**
 * Convert PowerShell registry path to standard format
 * e.g., HKCU:\Software\Zoom → HKCU\Software\Zoom
 */
function psPathToStandard(psPath: string): string {
  return psPath.replace(/^(HK[A-Z]+):/, '$1');
}

/**
 * Convert standard registry path to PowerShell format
 * e.g., HKCU\Software\Zoom → HKCU:\Software\Zoom
 */
function standardToPsPath(path: string): string {
  return path.replace(/^(HK[A-Z]+)\\/, '$1:\\');
}

/**
 * Enumerate all subkeys under a registry path (recursive)
 */
async function enumerateRegistryTree(prefix: string): Promise<string[]> {
  const psPath = standardToPsPath(prefix);

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $keys = @()

    function Get-SubKeys {
      param([string]$Path)

      if (Test-Path $Path) {
        $keys += $Path
        $item = Get-Item $Path -ErrorAction SilentlyContinue
        if ($item) {
          foreach ($subkey in $item.GetSubKeyNames()) {
            Get-SubKeys "$Path\\$subkey"
          }
        }
      }
    }

    Get-SubKeys '${psPath.replace(/'/g, "''")}'
    $keys | ForEach-Object { $_ -replace '^(HK[A-Z]+):', '$1' }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output) return [];

    const keys = output.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(psPathToStandard);

    return keys;
  } catch {
    return [];
  }
}

/**
 * Read all values from a registry key
 */
async function readRegistryValues(keyPath: string): Promise<Record<string, unknown>> {
  const psPath = standardToPsPath(keyPath);

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $result = @{}

    if (Test-Path '${psPath.replace(/'/g, "''")}') {
      $key = Get-Item '${psPath.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
      if ($key) {
        foreach ($name in $key.GetValueNames()) {
          $value = $key.GetValue($name)
          $type = $key.GetValueKind($name)
          $result[$name] = @{
            value = $value
            type = $type.ToString()
          }
        }
      }
    }

    $result | ConvertTo-Json -Depth 3 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '{}' || output === '') {
      return {};
    }

    const parsed = JSON.parse(output);
    const result: Record<string, unknown> = {};

    for (const [name, data] of Object.entries(parsed)) {
      if (data && typeof data === 'object' && 'value' in data) {
        result[name] = (data as { value: unknown }).value;
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Check if a registry key exists
 */
async function registryKeyExists(keyPath: string): Promise<boolean> {
  const psPath = standardToPsPath(keyPath);
  const script = `Test-Path '${psPath.replace(/'/g, "''")}'`;

  try {
    const output = await runPowerShell(script);
    return output.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

// ============================================================================
// RegistryScanner Implementation
// ============================================================================

export class RegistryScanner implements Scanner<RegistryArtifact> {
  readonly id = 'registry' as const;

  /**
   * Scan vendor-defined registry locations
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of RegistryArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<RegistryArtifact[]> {
    const { product } = ctx;
    const artifacts: RegistryArtifact[] = [];
    const errors: ScanError[] = [];

    // Collect all registry prefixes from product definition
    const prefixes = [
      ...product.registry.software,
      ...product.registry.uninstall,
      ...product.registry.services,
      ...product.registry.other,
    ];

    // Normalize prefixes for validation
    const allowedPrefixes = prefixes.map(p => normalizeRegistryPath(p).toUpperCase());

    for (const prefix of prefixes) {
      // DEFENSIVE: Skip protected registry paths
      if (isProtectedRegistry(prefix)) {
        errors.push({
          path: prefix,
          message: 'Skipped protected registry path',
          code: 'PROTECTED_REGISTRY',
        });
        continue;
      }

      // Check if prefix exists
      const exists = await registryKeyExists(prefix);
      if (!exists) {
        // Prefix doesn't exist - normal, not an error
        continue;
      }

      // Enumerate all keys under this prefix
      const keys = await enumerateRegistryTree(prefix);

      for (const keyPath of keys) {
        // SAFETY: Verify key is within allowed prefixes
        const normalizedKey = normalizeRegistryPath(keyPath).toUpperCase();
        const isAllowed = allowedPrefixes.some(allowed =>
          normalizedKey.startsWith(allowed),
        );

        if (!isAllowed) {
          // Should never happen, but defensive check
          errors.push({
            path: keyPath,
            message: 'Registry key outside allowed prefixes (skipped)',
            code: 'OUTSIDE_ALLOWLIST',
          });
          continue;
        }

        // DEFENSIVE: Skip if this specific key is protected
        if (isProtectedRegistry(keyPath)) {
          continue;
        }

        // Read values
        const values = await readRegistryValues(keyPath);

        const artifact: RegistryArtifact = {
          id: `reg_${crypto.randomUUID()}`,
          type: 'registry',
          owner: {
            vendor: product.vendor,
            product: product.id,
            confidence: 'high', // Key is under vendor prefix
          },
          path: keyPath,
          metadata: {
            hive: getHive(keyPath),
            keyPath: getKeyPath(keyPath),
            valueName: undefined, // Key-level artifact, not value-level
            valueType: undefined,
            value: undefined,
            expandedValue: undefined,
            lastWriteTime: undefined, // Would need native API
            values,
            valueCount: Object.keys(values).length,
            exists: true,
          },
          observedAt: Date.now(),
          source: 'registry',
        };

        artifacts.push(artifact);
      }
    }

    // DETERMINISM: Sort artifacts by path
    artifacts.sort((a, b) => a.path.localeCompare(b.path));

    return artifacts;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRegistryScanner(): RegistryScanner {
  return new RegistryScanner();
}
