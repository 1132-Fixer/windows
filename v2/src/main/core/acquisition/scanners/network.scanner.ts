/**
 * NetworkConfigScanner - Read-Only Network Configuration Enumeration
 *
 * RESPONSIBILITIES:
 * - Read proxy settings (IE/WinHTTP/system)
 * - Read DNS server configuration
 * - Read hosts file entries
 * - Detect suspicious network tampering
 *
 * NON-GOALS (NEVER DO):
 * ❌ No modification of proxy settings
 * ❌ No modification of DNS settings
 * ❌ No modification of hosts file
 * ❌ No network traffic interception
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Never throws for inaccessible configuration
 * - Sensitive hostnames/IPs are preserved for analysis
 *
 * WHY THIS MATTERS:
 * Malware often:
 * - Hijacks proxy to intercept traffic
 * - Changes DNS to redirect to malicious servers
 * - Modifies hosts file to block security updates
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Artifact, OwnerTag } from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  NetworkArtifact,
  NetworkCategory,
  ScanError,
} from '../types';

// ============================================================================
// Extended Network Artifact
// ============================================================================

export interface ProxySettings {
  enabled: boolean;
  server: string | null;
  bypass: string | null;
  autoConfigUrl: string | null;
  autoDetect: boolean;
}

export interface DNSSettings {
  servers: string[];
  suffixes: string[];
  interface: string;
}

export interface HostsEntry {
  ip: string;
  hostname: string;
  comment?: string;
  lineNumber: number;
}

export interface NetworkConfigArtifact extends Artifact {
  type: 'network';
  metadata: {
    category: NetworkCategory;
    current: unknown;
    isDefault: boolean;
    modifiedBy?: string;
    // Extended fields
    proxy?: ProxySettings;
    dns?: DNSSettings;
    hostsEntries?: HostsEntry[];
    suspiciousIndicators?: string[];
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

    // Timeout after 30 seconds
    setTimeout(() => {
      ps.kill();
      resolve('');
    }, 30000);
  });
}

// ============================================================================
// Proxy Settings Detection
// ============================================================================

/**
 * Get current proxy settings from multiple sources
 */
async function getProxySettings(): Promise<ProxySettings[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $proxies = @()

    # IE/System Proxy Settings
    $ieSettings = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
    if ($ieSettings) {
      $proxies += @{
        Source = 'IE/System'
        Enabled = [bool]$ieSettings.ProxyEnable
        Server = $ieSettings.ProxyServer
        Bypass = $ieSettings.ProxyOverride
        AutoConfigUrl = $ieSettings.AutoConfigURL
        AutoDetect = [bool]$ieSettings.AutoDetect
      }
    }

    # WinHTTP Proxy (netsh winhttp show proxy)
    $winhttp = netsh winhttp show proxy 2>$null
    if ($winhttp) {
      $enabled = $winhttp -notmatch 'Direct access'
      $server = ($winhttp | Select-String -Pattern 'Proxy Server\\s*:\\s*(.+)' -ErrorAction SilentlyContinue).Matches.Groups[1].Value
      $bypass = ($winhttp | Select-String -Pattern 'Bypass List\\s*:\\s*(.+)' -ErrorAction SilentlyContinue).Matches.Groups[1].Value

      $proxies += @{
        Source = 'WinHTTP'
        Enabled = $enabled
        Server = $server
        Bypass = $bypass
        AutoConfigUrl = $null
        AutoDetect = $false
      }
    }

    $proxies | ConvertTo-Json -Depth 2 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((p: Record<string, unknown>) => ({
      enabled: p.Enabled as boolean,
      server: p.Server as string | null,
      bypass: p.Bypass as string | null,
      autoConfigUrl: p.AutoConfigUrl as string | null,
      autoDetect: p.AutoDetect as boolean,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// DNS Settings Detection
// ============================================================================

/**
 * Get current DNS server settings
 */
async function getDNSSettings(): Promise<DNSSettings[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $dnsSettings = @()

    Get-NetIPConfiguration | Where-Object { $_.DNSServer } | ForEach-Object {
      $dnsSettings += @{
        Interface = $_.InterfaceAlias
        Servers = @($_.DNSServer.ServerAddresses)
        Suffixes = @($_.ConnectionSpecificDnsSuffix)
      }
    }

    $dnsSettings | ConvertTo-Json -Depth 2 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((d: Record<string, unknown>) => ({
      interface: d.Interface as string,
      servers: (d.Servers as string[]) || [],
      suffixes: (d.Suffixes as string[]) || [],
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Hosts File Parsing
// ============================================================================

/**
 * Parse the hosts file
 */
async function getHostsEntries(): Promise<HostsEntry[]> {
  const hostsPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'drivers',
    'etc',
    'hosts'
  );

  try {
    const content = await fs.readFile(hostsPath, 'utf-8');
    const entries: HostsEntry[] = [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and full-line comments
      if (!line || line.startsWith('#')) continue;

      // Parse entry (IP hostname [hostname...] [#comment])
      const commentIndex = line.indexOf('#');
      const mainPart = commentIndex >= 0 ? line.substring(0, commentIndex).trim() : line;
      const comment = commentIndex >= 0 ? line.substring(commentIndex + 1).trim() : undefined;

      const parts = mainPart.split(/\s+/);
      if (parts.length >= 2) {
        const ip = parts[0];
        // Each hostname gets its own entry
        for (let j = 1; j < parts.length; j++) {
          entries.push({
            ip,
            hostname: parts[j],
            comment,
            lineNumber: i + 1,
          });
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}

// ============================================================================
// Suspicious Indicator Detection
// ============================================================================

/**
 * Known suspicious proxy patterns
 */
const SUSPICIOUS_PROXY_PATTERNS = [
  /localhost:\d{4,5}/i, // Local proxy on high port
  /127\.0\.0\.1:\d{4,5}/i,
  /\.onion/i, // Tor
  /\.i2p/i, // I2P
];

/**
 * Known suspicious DNS servers
 */
const SUSPICIOUS_DNS_SERVERS = [
  // These are actually legitimate, but unusual if not explicitly set
  // Malware might use these to bypass local DNS
  '1.1.1.1', '1.0.0.1', // Cloudflare
  '8.8.8.8', '8.8.4.4', // Google
  '9.9.9.9', // Quad9
  '208.67.222.222', '208.67.220.220', // OpenDNS
];

/**
 * Legitimate system hosts entries
 */
const LEGITIMATE_HOSTS_ENTRIES = [
  'localhost',
  'localhost.localdomain',
  'local',
];

/**
 * Known malware blocking targets in hosts file
 */
const SECURITY_BLOCKING_PATTERNS = [
  /windowsupdate/i,
  /microsoft\.com/i,
  /windows\.com/i,
  /\.av\./i,
  /kaspersky/i,
  /norton/i,
  /mcafee/i,
  /avast/i,
  /avg\./i,
  /malwarebytes/i,
  /virustotal/i,
];

/**
 * Check for suspicious indicators in network configuration
 */
function detectSuspiciousIndicators(
  proxies: ProxySettings[],
  dnsSettings: DNSSettings[],
  hostsEntries: HostsEntry[],
): string[] {
  const indicators: string[] = [];

  // Check proxy settings
  for (const proxy of proxies) {
    if (proxy.enabled && proxy.server) {
      for (const pattern of SUSPICIOUS_PROXY_PATTERNS) {
        if (pattern.test(proxy.server)) {
          indicators.push(`Suspicious proxy pattern detected: ${proxy.server}`);
          break;
        }
      }
    }

    if (proxy.autoConfigUrl) {
      indicators.push(`Auto-config proxy URL set: ${proxy.autoConfigUrl}`);
    }
  }

  // Check for non-standard DNS (not necessarily bad, but notable)
  for (const dns of dnsSettings) {
    const hasNonLocalDNS = dns.servers.some(
      s => !s.startsWith('192.168.') &&
           !s.startsWith('10.') &&
           !s.startsWith('172.16.') &&
           !s.startsWith('172.17.') &&
           !s.startsWith('172.18.') &&
           !s.startsWith('172.19.') &&
           !s.startsWith('172.2') &&
           !s.startsWith('172.30.') &&
           !s.startsWith('172.31.')
    );

    if (hasNonLocalDNS) {
      indicators.push(`Non-local DNS servers on ${dns.interface}: ${dns.servers.join(', ')}`);
    }
  }

  // Check hosts file for security blocking
  for (const entry of hostsEntries) {
    // Skip localhost entries
    if (LEGITIMATE_HOSTS_ENTRIES.includes(entry.hostname.toLowerCase())) {
      continue;
    }

    // Check if blocking to 127.0.0.1 or 0.0.0.0
    if (entry.ip === '127.0.0.1' || entry.ip === '0.0.0.0') {
      for (const pattern of SECURITY_BLOCKING_PATTERNS) {
        if (pattern.test(entry.hostname)) {
          indicators.push(`Hosts file blocks security-related domain: ${entry.hostname} → ${entry.ip}`);
          break;
        }
      }
    }
  }

  return indicators;
}

// ============================================================================
// NetworkConfigScanner Implementation
// ============================================================================

export class NetworkConfigScanner implements Scanner<NetworkConfigArtifact> {
  readonly id = 'network' as const;

  /**
   * Scan network configuration for suspicious settings
   *
   * This scanner operates in "broad-spectrum" mode - it doesn't filter
   * by vendor because network tampering affects the whole system.
   *
   * @param ctx - Scan context (vendor info not used for filtering)
   * @returns Array of NetworkConfigArtifacts
   */
  async scan(ctx: ScanContext): Promise<NetworkConfigArtifact[]> {
    const { product } = ctx;
    const artifacts: NetworkConfigArtifact[] = [];

    // Get all network configuration
    const [proxies, dnsSettings, hostsEntries] = await Promise.all([
      getProxySettings(),
      getDNSSettings(),
      getHostsEntries(),
    ]);

    // Detect suspicious indicators
    const suspiciousIndicators = detectSuspiciousIndicators(
      proxies,
      dnsSettings,
      hostsEntries
    );

    // Create proxy artifact
    for (const proxy of proxies) {
      if (proxy.enabled || proxy.autoConfigUrl) {
        artifacts.push({
          id: `net_proxy_${crypto.randomUUID()}`,
          type: 'network',
          owner: {
            vendor: 'System',
            product: 'Windows',
            confidence: 'low', // We can't attribute proxy changes
          },
          metadata: {
            category: 'proxy',
            current: proxy,
            isDefault: !proxy.enabled && !proxy.autoConfigUrl,
            proxy,
            suspiciousIndicators: suspiciousIndicators.filter(i => i.includes('proxy')),
          },
          observedAt: Date.now(),
          source: 'network',
        });
      }
    }

    // Create DNS artifact
    for (const dns of dnsSettings) {
      if (dns.servers.length > 0) {
        artifacts.push({
          id: `net_dns_${crypto.randomUUID()}`,
          type: 'network',
          owner: {
            vendor: 'System',
            product: 'Windows',
            confidence: 'low',
          },
          metadata: {
            category: 'dns',
            current: dns,
            isDefault: false, // Would need to compare to DHCP-assigned
            dns,
            suspiciousIndicators: suspiciousIndicators.filter(i => i.includes('DNS')),
          },
          observedAt: Date.now(),
          source: 'network',
        });
      }
    }

    // Create hosts file artifact (only for non-standard entries)
    const nonStandardEntries = hostsEntries.filter(
      e => !LEGITIMATE_HOSTS_ENTRIES.includes(e.hostname.toLowerCase())
    );

    if (nonStandardEntries.length > 0) {
      artifacts.push({
        id: `net_hosts_${crypto.randomUUID()}`,
        type: 'network',
        owner: {
          vendor: 'System',
          product: 'Windows',
          confidence: 'low',
        },
        metadata: {
          category: 'hosts',
          current: { entryCount: nonStandardEntries.length },
          isDefault: false,
          hostsEntries: nonStandardEntries,
          suspiciousIndicators: suspiciousIndicators.filter(i => i.includes('Hosts')),
        },
        observedAt: Date.now(),
        source: 'network',
      });
    }

    return artifacts;
  }

  /**
   * Get all network configuration (for detailed analysis)
   */
  async getFullConfiguration(): Promise<{
    proxies: ProxySettings[];
    dnsSettings: DNSSettings[];
    hostsEntries: HostsEntry[];
    suspiciousIndicators: string[];
  }> {
    const [proxies, dnsSettings, hostsEntries] = await Promise.all([
      getProxySettings(),
      getDNSSettings(),
      getHostsEntries(),
    ]);

    const suspiciousIndicators = detectSuspiciousIndicators(
      proxies,
      dnsSettings,
      hostsEntries
    );

    return { proxies, dnsSettings, hostsEntries, suspiciousIndicators };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createNetworkConfigScanner(): NetworkConfigScanner {
  return new NetworkConfigScanner();
}
