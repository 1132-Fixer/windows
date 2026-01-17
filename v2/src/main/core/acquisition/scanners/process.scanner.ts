/**
 * ProcessScanner - Read-Only Process Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate running processes with parent-child relationships
 * - Identify processes matching vendor-defined process names
 * - Capture command lines (redacted for privacy)
 *
 * NON-GOALS (NEVER DO):
 * ❌ No process termination
 * ❌ No memory injection or reading
 * ❌ No handle manipulation
 * ❌ No "suspicion" scoring
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Command lines are redacted to remove sensitive arguments
 * - Never throws for inaccessible processes
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type { OwnerTag } from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  ProcessArtifact,
  SignatureInfo,
  ScanError,
} from '../types';

// ============================================================================
// Command Line Redaction (Privacy)
// ============================================================================

/**
 * Patterns that indicate sensitive arguments
 */
const SENSITIVE_PATTERNS = [
  /--password[=\s]+\S+/gi,
  /--token[=\s]+\S+/gi,
  /--key[=\s]+\S+/gi,
  /--secret[=\s]+\S+/gi,
  /--api[-_]?key[=\s]+\S+/gi,
  /-p\s+\S+/g, // Common password flag
  /Bearer\s+\S+/gi,
];

/**
 * Redact sensitive information from command line
 */
function redactCommandLine(cmdLine: string | null | undefined): string | undefined {
  if (!cmdLine) return undefined;

  let redacted = cmdLine;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

// ============================================================================
// PowerShell Process Enumeration
// ============================================================================

interface ProcessInfo {
  pid: number;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
  parentPid: number | null;
  parentName: string | null;
  username: string | null;
  startTime: string | null;
  sessionId: number | null;
  isElevated: boolean | null;
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
      resolve(stdout.trim());
    });

    ps.on('error', (err) => {
      reject(err);
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      ps.kill();
      resolve('');
    }, 60000);
  });
}

/**
 * Get all running processes with detailed information
 */
async function getAllProcesses(): Promise<ProcessInfo[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    # Get WMI process info for command lines and parent PIDs
    $wmiProcesses = @{}
    Get-CimInstance Win32_Process | ForEach-Object {
      $wmiProcesses[$_.ProcessId] = @{
        CommandLine = $_.CommandLine
        ParentProcessId = $_.ParentProcessId
        ExecutablePath = $_.ExecutablePath
      }
    }

    # Get process list
    $processes = Get-Process | ForEach-Object {
      $pid = $_.Id
      $wmi = $wmiProcesses[$pid]
      $parentPid = if ($wmi) { $wmi.ParentProcessId } else { $null }
      $parentName = $null

      if ($parentPid) {
        $parentProc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
        if ($parentProc) { $parentName = $parentProc.ProcessName }
      }

      # Try to get username (may fail for system processes)
      $owner = $null
      try {
        $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue).GetOwner()
        if ($owner -and $owner.User) {
          $owner = "$($owner.Domain)\\$($owner.User)"
        } else {
          $owner = $null
        }
      } catch { }

      @{
        Pid = $pid
        Name = $_.ProcessName
        ExecutablePath = if ($wmi) { $wmi.ExecutablePath } else { $_.Path }
        CommandLine = if ($wmi) { $wmi.CommandLine } else { $null }
        ParentPid = $parentPid
        ParentName = $parentName
        Username = $owner
        StartTime = if ($_.StartTime) { $_.StartTime.ToString('o') } else { $null }
        SessionId = $_.SessionId
      }
    }

    $processes | ConvertTo-Json -Depth 3 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output) return [];

    let parsed = JSON.parse(output);

    // Handle single process case (PowerShell returns object instead of array)
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    return parsed.map((p: Record<string, unknown>) => ({
      pid: p.Pid as number,
      name: p.Name as string,
      executablePath: p.ExecutablePath as string | null,
      commandLine: p.CommandLine as string | null,
      parentPid: p.ParentPid as number | null,
      parentName: p.ParentName as string | null,
      username: p.Username as string | null,
      startTime: p.StartTime as string | null,
      sessionId: p.SessionId as number | null,
      isElevated: null, // Would require additional checks
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Expand environment variables in a path
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Normalize path for comparison
 */
function normalizePath(inputPath: string): string {
  return inputPath.toLowerCase().replace(/\//g, '\\');
}

/**
 * Check if a process executable path is within vendor-defined paths
 */
function isProcessOwned(
  executablePath: string | null,
  vendorPaths: string[],
): boolean {
  if (!executablePath) return false;

  const normalizedExe = normalizePath(executablePath);

  for (const vendorPath of vendorPaths) {
    const normalizedVendor = normalizePath(expandEnvVars(vendorPath));
    if (normalizedExe.startsWith(normalizedVendor)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if process name matches vendor-defined process names
 */
function isProcessNameMatch(
  processName: string,
  vendorProcessNames: string[],
): boolean {
  const normalizedName = processName.toLowerCase();

  for (const vendorName of vendorProcessNames) {
    // Remove .exe extension for comparison
    const normalizedVendor = vendorName.toLowerCase().replace(/\.exe$/, '');
    if (normalizedName === normalizedVendor || normalizedName === vendorName.toLowerCase()) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// ProcessScanner Implementation
// ============================================================================

export class ProcessScanner implements Scanner<ProcessArtifact> {
  readonly id = 'process' as const;

  /**
   * Scan running processes for vendor-related processes
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of ProcessArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<ProcessArtifact[]> {
    const { product } = ctx;
    const artifacts: ProcessArtifact[] = [];

    // Collect all vendor paths for ownership check
    const vendorPaths = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
    ];

    // Get all processes
    const processes = await getAllProcesses();

    for (const proc of processes) {
      // Check if process matches vendor criteria
      const matchesName = isProcessNameMatch(proc.name, product.processes);
      const matchesPath = isProcessOwned(proc.executablePath, vendorPaths);

      if (!matchesName && !matchesPath) {
        continue; // Not vendor-related
      }

      // Determine confidence based on match type
      const confidence: OwnerTag['confidence'] =
        matchesPath && matchesName ? 'high' :
        matchesPath ? 'high' :
        matchesName ? 'medium' : 'low';

      const artifact: ProcessArtifact = {
        id: `proc_${crypto.randomUUID()}`,
        type: 'process',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence,
        },
        path: proc.executablePath || undefined,
        metadata: {
          pid: proc.pid,
          name: proc.name,
          executablePath: proc.executablePath || undefined,
          commandLine: redactCommandLine(proc.commandLine),
          parentPid: proc.parentPid || undefined,
          parentName: proc.parentName || undefined,
          username: proc.username || undefined,
          startTime: proc.startTime ? new Date(proc.startTime).getTime() : undefined,
          sessionId: proc.sessionId || undefined,
          isElevated: proc.isElevated || undefined,
          signature: undefined, // Would require Authenticode verification
        },
        observedAt: Date.now(),
        source: 'process',
      };

      artifacts.push(artifact);
    }

    // DETERMINISM: Sort by PID
    artifacts.sort((a, b) => (a.metadata.pid as number) - (b.metadata.pid as number));

    return artifacts;
  }

  /**
   * Get full process tree (all processes with parent relationships)
   * Useful for correlation graph building
   */
  async getProcessTree(): Promise<ProcessInfo[]> {
    return getAllProcesses();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createProcessScanner(): ProcessScanner {
  return new ProcessScanner();
}
