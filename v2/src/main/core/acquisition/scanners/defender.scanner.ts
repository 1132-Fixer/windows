/**
 * DefenderStateScanner - Read-Only Windows Defender State Enumeration
 *
 * RESPONSIBILITIES:
 * - Check Windows Defender tamper protection state
 * - Enumerate exclusions list
 * - Check real-time protection state
 * - Detect disabled or tampered security
 *
 * NON-GOALS (NEVER DO):
 * ❌ No modification of Defender settings
 * ❌ No adding/removing exclusions
 * ❌ No disabling protection
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Requires admin for some queries (gracefully degrades)
 * - Never throws for inaccessible configuration
 *
 * WHY THIS MATTERS:
 * Malware often:
 * - Disables real-time protection
 * - Adds exclusions for malicious paths
 * - Disables tamper protection
 * - Prevents Defender updates
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type { Artifact, OwnerTag } from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  ScanError,
} from '../types';

// ============================================================================
// Defender State Types
// ============================================================================

export interface DefenderExclusion {
  type: 'path' | 'extension' | 'process' | 'ip';
  value: string;
}

export interface DefenderThreat {
  id: string;
  name: string;
  severity: string;
  status: string;
  detectedAt: string | null;
}

export interface DefenderState {
  // Protection states
  realTimeProtectionEnabled: boolean;
  behaviorMonitorEnabled: boolean;
  ioavProtectionEnabled: boolean;
  antivirusEnabled: boolean;
  antispywareEnabled: boolean;
  tamperProtectionEnabled: boolean | null; // null if can't read

  // Update state
  antivirusSignatureLastUpdated: string | null;
  antivirusSignatureVersion: string | null;
  engineVersion: string | null;

  // Exclusions
  exclusions: DefenderExclusion[];

  // Recent threats (summary)
  threatCount: number;
  recentThreats: DefenderThreat[];

  // Suspicious indicators
  suspiciousIndicators: string[];
}

export interface DefenderStateArtifact extends Artifact {
  type: 'defender_state';
  metadata: {
    state: DefenderState;
    overallStatus: 'healthy' | 'degraded' | 'compromised' | 'unknown';
    suspiciousIndicators: string[];
  };
}

// ============================================================================
// PowerShell Commands
// ============================================================================

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

// ============================================================================
// Defender State Collection
// ============================================================================

/**
 * Get Windows Defender status
 */
async function getDefenderStatus(): Promise<{
  realTimeProtectionEnabled: boolean;
  behaviorMonitorEnabled: boolean;
  ioavProtectionEnabled: boolean;
  antivirusEnabled: boolean;
  antispywareEnabled: boolean;
  antivirusSignatureLastUpdated: string | null;
  antivirusSignatureVersion: string | null;
  engineVersion: string | null;
} | null> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    try {
      $status = Get-MpComputerStatus

      if ($status) {
        @{
          RealTimeProtectionEnabled = $status.RealTimeProtectionEnabled
          BehaviorMonitorEnabled = $status.BehaviorMonitorEnabled
          IoavProtectionEnabled = $status.IoavProtectionEnabled
          AntivirusEnabled = $status.AntivirusEnabled
          AntispywareEnabled = $status.AntispywareEnabled
          AntivirusSignatureLastUpdated = if ($status.AntivirusSignatureLastUpdated) { $status.AntivirusSignatureLastUpdated.ToString('o') } else { $null }
          AntivirusSignatureVersion = $status.AntivirusSignatureVersion
          AMEngineVersion = $status.AMEngineVersion
        } | ConvertTo-Json -Compress
      } else {
        'null'
      }
    } catch {
      'null'
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === 'null') return null;

    const parsed = JSON.parse(output);
    return {
      realTimeProtectionEnabled: parsed.RealTimeProtectionEnabled as boolean,
      behaviorMonitorEnabled: parsed.BehaviorMonitorEnabled as boolean,
      ioavProtectionEnabled: parsed.IoavProtectionEnabled as boolean,
      antivirusEnabled: parsed.AntivirusEnabled as boolean,
      antispywareEnabled: parsed.AntispywareEnabled as boolean,
      antivirusSignatureLastUpdated: parsed.AntivirusSignatureLastUpdated as string | null,
      antivirusSignatureVersion: parsed.AntivirusSignatureVersion as string | null,
      engineVersion: parsed.AMEngineVersion as string | null,
    };
  } catch {
    return null;
  }
}

/**
 * Get tamper protection state
 */
async function getTamperProtectionState(): Promise<boolean | null> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    try {
      $prefs = Get-MpPreference
      if ($prefs) {
        if ($prefs.DisableTamperProtection -eq $false) {
          'true'
        } elseif ($prefs.DisableTamperProtection -eq $true) {
          'false'
        } else {
          # Check registry as fallback
          $regValue = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows Defender\\Features' -Name 'TamperProtection' -ErrorAction SilentlyContinue
          if ($regValue.TamperProtection -eq 5) {
            'true'
          } elseif ($regValue.TamperProtection -eq 0 -or $regValue.TamperProtection -eq 4) {
            'false'
          } else {
            'null'
          }
        }
      } else {
        'null'
      }
    } catch {
      'null'
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (output === 'true') return true;
    if (output === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Get Defender exclusions
 */
async function getExclusions(): Promise<DefenderExclusion[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    try {
      $prefs = Get-MpPreference
      $exclusions = @()

      if ($prefs.ExclusionPath) {
        foreach ($path in $prefs.ExclusionPath) {
          $exclusions += @{ Type = 'path'; Value = $path }
        }
      }

      if ($prefs.ExclusionExtension) {
        foreach ($ext in $prefs.ExclusionExtension) {
          $exclusions += @{ Type = 'extension'; Value = $ext }
        }
      }

      if ($prefs.ExclusionProcess) {
        foreach ($proc in $prefs.ExclusionProcess) {
          $exclusions += @{ Type = 'process'; Value = $proc }
        }
      }

      if ($prefs.ExclusionIpAddress) {
        foreach ($ip in $prefs.ExclusionIpAddress) {
          $exclusions += @{ Type = 'ip'; Value = $ip }
        }
      }

      $exclusions | ConvertTo-Json -Compress
    } catch {
      '[]'
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((e: Record<string, unknown>) => ({
      type: e.Type as DefenderExclusion['type'],
      value: e.Value as string,
    }));
  } catch {
    return [];
  }
}

/**
 * Get recent threats
 */
async function getRecentThreats(): Promise<DefenderThreat[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    try {
      $threats = Get-MpThreatDetection | Select-Object -First 10 | ForEach-Object {
        @{
          Id = $_.ThreatID.ToString()
          Name = (Get-MpThreat -ThreatID $_.ThreatID -ErrorAction SilentlyContinue).ThreatName
          Severity = $_.SeverityID.ToString()
          Status = $_.DetectionSourceTypeID.ToString()
          DetectedAt = if ($_.InitialDetectionTime) { $_.InitialDetectionTime.ToString('o') } else { $null }
        }
      }

      if ($threats) {
        $threats | ConvertTo-Json -Compress
      } else {
        '[]'
      }
    } catch {
      '[]'
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((t: Record<string, unknown>) => ({
      id: t.Id as string,
      name: (t.Name as string) || 'Unknown',
      severity: t.Severity as string,
      status: t.Status as string,
      detectedAt: t.DetectedAt as string | null,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Suspicious Indicator Detection
// ============================================================================

/**
 * Suspicious exclusion patterns
 */
const SUSPICIOUS_EXCLUSION_PATTERNS = [
  // Broad user-writable locations
  /^c:\\users\\[^\\]+\\appdata\\local$/i,
  /^c:\\users\\[^\\]+\\appdata\\roaming$/i,
  /^c:\\users\\[^\\]+\\downloads$/i,
  /^c:\\temp$/i,
  /^c:\\windows\\temp$/i,
  // Commonly abused paths
  /\\programdata$/i,
  // Entire drives
  /^[a-z]:$/i,
  /^[a-z]:\\$/i,
  // PowerShell
  /powershell/i,
  /pwsh/i,
  // Script interpreters
  /wscript/i,
  /cscript/i,
  /mshta/i,
  // Dangerous extensions
  /^\.(exe|dll|scr|bat|cmd|ps1|vbs|js|hta)$/i,
];

/**
 * Detect suspicious indicators in Defender configuration
 */
function detectSuspiciousIndicators(
  status: Awaited<ReturnType<typeof getDefenderStatus>>,
  tamperProtection: boolean | null,
  exclusions: DefenderExclusion[],
): string[] {
  const indicators: string[] = [];

  // Check protection states
  if (status) {
    if (!status.realTimeProtectionEnabled) {
      indicators.push('Real-time protection is DISABLED');
    }
    if (!status.behaviorMonitorEnabled) {
      indicators.push('Behavior monitoring is DISABLED');
    }
    if (!status.antivirusEnabled) {
      indicators.push('Antivirus is DISABLED');
    }

    // Check signature age
    if (status.antivirusSignatureLastUpdated) {
      const lastUpdate = new Date(status.antivirusSignatureLastUpdated);
      const daysSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate > 7) {
        indicators.push(`Antivirus signatures are ${Math.floor(daysSinceUpdate)} days old`);
      }
    }
  } else {
    indicators.push('Could not read Defender status (may require admin)');
  }

  // Check tamper protection
  if (tamperProtection === false) {
    indicators.push('Tamper protection is DISABLED');
  } else if (tamperProtection === null) {
    indicators.push('Could not read tamper protection state');
  }

  // Check exclusions
  for (const exclusion of exclusions) {
    for (const pattern of SUSPICIOUS_EXCLUSION_PATTERNS) {
      if (pattern.test(exclusion.value)) {
        indicators.push(`Suspicious exclusion: ${exclusion.type} = "${exclusion.value}"`);
        break;
      }
    }
  }

  // Warn about high exclusion count
  if (exclusions.length > 10) {
    indicators.push(`High number of exclusions: ${exclusions.length}`);
  }

  return indicators;
}

/**
 * Determine overall status based on state
 */
function determineOverallStatus(
  status: Awaited<ReturnType<typeof getDefenderStatus>>,
  tamperProtection: boolean | null,
  indicators: string[],
): 'healthy' | 'degraded' | 'compromised' | 'unknown' {
  if (!status) {
    return 'unknown';
  }

  // Compromised: critical protections disabled
  if (!status.realTimeProtectionEnabled || !status.antivirusEnabled) {
    return 'compromised';
  }

  if (tamperProtection === false) {
    return 'compromised';
  }

  // Degraded: some issues but core protection works
  if (indicators.length > 0) {
    return 'degraded';
  }

  return 'healthy';
}

// ============================================================================
// DefenderStateScanner Implementation
// ============================================================================

export class DefenderStateScanner implements Scanner<DefenderStateArtifact> {
  readonly id = 'defender' as const;

  /**
   * Scan Windows Defender state
   *
   * This scanner operates in "broad-spectrum" mode - it doesn't filter
   * by vendor because Defender state affects overall system security.
   *
   * @param ctx - Scan context (vendor info not used for filtering)
   * @returns Array containing a single DefenderStateArtifact
   */
  async scan(_ctx: ScanContext): Promise<DefenderStateArtifact[]> {
    // Get all Defender state
    const [status, tamperProtection, exclusions, recentThreats] = await Promise.all([
      getDefenderStatus(),
      getTamperProtectionState(),
      getExclusions(),
      getRecentThreats(),
    ]);

    // Detect suspicious indicators
    const suspiciousIndicators = detectSuspiciousIndicators(
      status,
      tamperProtection,
      exclusions
    );

    // Determine overall status
    const overallStatus = determineOverallStatus(
      status,
      tamperProtection,
      suspiciousIndicators
    );

    // Build state object
    const state: DefenderState = {
      realTimeProtectionEnabled: status?.realTimeProtectionEnabled ?? false,
      behaviorMonitorEnabled: status?.behaviorMonitorEnabled ?? false,
      ioavProtectionEnabled: status?.ioavProtectionEnabled ?? false,
      antivirusEnabled: status?.antivirusEnabled ?? false,
      antispywareEnabled: status?.antispywareEnabled ?? false,
      tamperProtectionEnabled: tamperProtection,
      antivirusSignatureLastUpdated: status?.antivirusSignatureLastUpdated ?? null,
      antivirusSignatureVersion: status?.antivirusSignatureVersion ?? null,
      engineVersion: status?.engineVersion ?? null,
      exclusions,
      threatCount: recentThreats.length,
      recentThreats,
      suspiciousIndicators,
    };

    const artifact: DefenderStateArtifact = {
      id: `defender_${crypto.randomUUID()}`,
      type: 'defender_state',
      owner: {
        vendor: 'Microsoft',
        product: 'Windows Defender',
        confidence: 'high',
      },
      metadata: {
        state,
        overallStatus,
        suspiciousIndicators,
      },
      observedAt: Date.now(),
      source: 'defender' as const,
    };

    return [artifact];
  }

  /**
   * Get full Defender state (for detailed analysis)
   */
  async getFullState(): Promise<DefenderState> {
    const [status, tamperProtection, exclusions, recentThreats] = await Promise.all([
      getDefenderStatus(),
      getTamperProtectionState(),
      getExclusions(),
      getRecentThreats(),
    ]);

    const suspiciousIndicators = detectSuspiciousIndicators(
      status,
      tamperProtection,
      exclusions
    );

    return {
      realTimeProtectionEnabled: status?.realTimeProtectionEnabled ?? false,
      behaviorMonitorEnabled: status?.behaviorMonitorEnabled ?? false,
      ioavProtectionEnabled: status?.ioavProtectionEnabled ?? false,
      antivirusEnabled: status?.antivirusEnabled ?? false,
      antispywareEnabled: status?.antispywareEnabled ?? false,
      tamperProtectionEnabled: tamperProtection,
      antivirusSignatureLastUpdated: status?.antivirusSignatureLastUpdated ?? null,
      antivirusSignatureVersion: status?.antivirusSignatureVersion ?? null,
      engineVersion: status?.engineVersion ?? null,
      exclusions,
      threatCount: recentThreats.length,
      recentThreats,
      suspiciousIndicators,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDefenderStateScanner(): DefenderStateScanner {
  return new DefenderStateScanner();
}
