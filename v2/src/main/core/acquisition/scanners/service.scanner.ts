/**
 * ServiceScanner - Read-Only Windows Service Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate Windows services matching vendor criteria
 * - Capture service configuration (start type, account, binary path)
 * - Identify vendor ownership via binary path matching
 *
 * NON-GOALS (NEVER DO):
 * ❌ No service stop/start/modify
 * ❌ No driver enumeration (separate scanner for that)
 * ❌ No "suspicion" scoring
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Never throws for inaccessible services
 * - Deterministic ordering
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type { OwnerTag } from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  ServiceArtifact,
  ServiceStartType,
  ServiceState,
  ServiceType,
  SignatureInfo,
  ScanError,
} from '../types';

// ============================================================================
// PowerShell Service Enumeration
// ============================================================================

interface ServiceInfo {
  name: string;
  displayName: string;
  description: string | null;
  binaryPath: string;
  startType: string;
  state: string;
  serviceType: string;
  account: string | null;
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
 * Get all Windows services with detailed configuration
 */
async function getAllServices(): Promise<ServiceInfo[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $services = Get-CimInstance Win32_Service | ForEach-Object {
      @{
        Name = $_.Name
        DisplayName = $_.DisplayName
        Description = $_.Description
        BinaryPath = $_.PathName
        StartType = $_.StartMode
        State = $_.State
        ServiceType = $_.ServiceType
        Account = $_.StartName
      }
    }

    $services | ConvertTo-Json -Depth 2 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output) return [];

    let parsed = JSON.parse(output);

    // Handle single service case
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    return parsed.map((s: Record<string, unknown>) => ({
      name: s.Name as string,
      displayName: s.DisplayName as string,
      description: s.Description as string | null,
      binaryPath: s.BinaryPath as string || '',
      startType: s.StartType as string,
      state: s.State as string,
      serviceType: s.ServiceType as string,
      account: s.Account as string | null,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Type Mapping
// ============================================================================

/**
 * Map WMI start mode to our ServiceStartType
 */
function mapStartType(wmiStartType: string): ServiceStartType {
  const mapping: Record<string, ServiceStartType> = {
    'Boot': 'Boot',
    'System': 'System',
    'Auto': 'Automatic',
    'Automatic': 'Automatic',
    'Manual': 'Manual',
    'Disabled': 'Disabled',
  };
  return mapping[wmiStartType] || 'Manual';
}

/**
 * Map WMI state to our ServiceState
 */
function mapState(wmiState: string): ServiceState {
  const mapping: Record<string, ServiceState> = {
    'Running': 'Running',
    'Stopped': 'Stopped',
    'Start Pending': 'StartPending',
    'Stop Pending': 'StopPending',
    'Paused': 'Paused',
    'Pause Pending': 'PausePending',
    'Continue Pending': 'ContinuePending',
  };
  return mapping[wmiState] || 'Unknown';
}

/**
 * Map WMI service type to our ServiceType
 */
function mapServiceType(wmiType: string): ServiceType {
  if (wmiType.includes('Kernel')) return 'KernelDriver';
  if (wmiType.includes('File System')) return 'FileSystemDriver';
  if (wmiType.includes('Own Process')) return 'Win32OwnProcess';
  if (wmiType.includes('Share Process')) return 'Win32ShareProcess';
  if (wmiType.includes('Interactive')) return 'InteractiveProcess';
  return 'Win32OwnProcess';
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
 * Extract executable path from service binary path
 * Handles quoted paths and arguments
 */
function extractExecutablePath(binaryPath: string): string {
  let cleaned = binaryPath.trim();

  // Handle quoted paths
  if (cleaned.startsWith('"')) {
    const endQuote = cleaned.indexOf('"', 1);
    if (endQuote > 1) {
      cleaned = cleaned.substring(1, endQuote);
    }
  } else {
    // Take first space-separated segment (might have arguments)
    const firstSpace = cleaned.indexOf(' ');
    if (firstSpace > 0) {
      // Check if this looks like a path with spaces
      // e.g., "C:\Program Files\..." vs "C:\app.exe -arg"
      if (!cleaned.substring(0, firstSpace).includes('\\')) {
        // Probably just the executable
        cleaned = cleaned.substring(0, firstSpace);
      } else {
        // Could be path with spaces, try to find .exe
        const exeIndex = cleaned.toLowerCase().indexOf('.exe');
        if (exeIndex > 0) {
          cleaned = cleaned.substring(0, exeIndex + 4);
        }
      }
    }
  }

  return cleaned;
}

/**
 * Check if a service binary path is within vendor-defined paths
 */
function isServiceOwned(
  binaryPath: string,
  vendorPaths: string[],
): boolean {
  if (!binaryPath) return false;

  const execPath = extractExecutablePath(binaryPath);
  const normalizedExe = normalizePath(execPath);

  for (const vendorPath of vendorPaths) {
    const normalizedVendor = normalizePath(expandEnvVars(vendorPath));
    if (normalizedExe.startsWith(normalizedVendor)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if service name matches vendor-defined service names
 */
function isServiceNameMatch(
  serviceName: string,
  vendorServiceNames: string[],
): boolean {
  const normalizedName = serviceName.toLowerCase();

  for (const vendorName of vendorServiceNames) {
    if (normalizedName === vendorName.toLowerCase()) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// ServiceScanner Implementation
// ============================================================================

export class ServiceScanner implements Scanner<ServiceArtifact> {
  readonly id = 'service' as const;

  /**
   * Scan Windows services for vendor-related services
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of ServiceArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<ServiceArtifact[]> {
    const { product } = ctx;
    const artifacts: ServiceArtifact[] = [];

    // Collect all vendor paths for ownership check
    const vendorPaths = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
    ];

    // Get all services
    const services = await getAllServices();

    for (const svc of services) {
      // Check if service matches vendor criteria
      const matchesName = isServiceNameMatch(svc.name, product.services);
      const matchesPath = isServiceOwned(svc.binaryPath, vendorPaths);

      if (!matchesName && !matchesPath) {
        continue; // Not vendor-related
      }

      // Determine confidence based on match type
      const confidence: OwnerTag['confidence'] =
        matchesPath && matchesName ? 'high' :
        matchesPath ? 'high' :
        matchesName ? 'medium' : 'low';

      const artifact: ServiceArtifact = {
        id: `svc_${crypto.randomUUID()}`,
        type: 'service',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence,
        },
        path: extractExecutablePath(svc.binaryPath) || undefined,
        metadata: {
          name: svc.name,
          displayName: svc.displayName,
          description: svc.description || undefined,
          binaryPath: svc.binaryPath,
          startType: mapStartType(svc.startType),
          currentState: mapState(svc.state),
          serviceType: mapServiceType(svc.serviceType),
          account: svc.account || undefined,
          signature: undefined, // Would require Authenticode verification
        },
        observedAt: Date.now(),
        source: 'service',
      };

      artifacts.push(artifact);
    }

    // DETERMINISM: Sort by service name
    artifacts.sort((a, b) =>
      (a.metadata.name as string).localeCompare(b.metadata.name as string)
    );

    return artifacts;
  }

  /**
   * Get all services (for broad-spectrum scanning)
   */
  async getAllServices(): Promise<ServiceInfo[]> {
    return getAllServices();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createServiceScanner(): ServiceScanner {
  return new ServiceScanner();
}
