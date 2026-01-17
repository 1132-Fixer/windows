/**
 * WMI Subscription Scanner - Read-Only WMI Event Subscription Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate WMI event filters, consumers, and bindings
 * - This is THE stealth persistence mechanism many tools miss
 * - Capture consumer command lines (redacted for privacy)
 *
 * NON-GOALS (NEVER DO):
 * ❌ No WMI subscription creation/deletion
 * ❌ No WMI query execution beyond enumeration
 * ❌ No "suspicion" scoring
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Command lines are redacted
 * - Never throws for inaccessible WMI namespaces
 *
 * WMI PERSISTENCE MECHANISM:
 * 1. EventFilter - Defines WHEN to trigger (e.g., "every 5 minutes", "on process start")
 * 2. EventConsumer - Defines WHAT to do (e.g., run a script, execute a command)
 * 3. FilterToConsumerBinding - Links Filter to Consumer
 *
 * Attackers use this because:
 * - Survives reboots
 * - No files on disk (can be fileless)
 * - Not visible in Task Scheduler
 * - Often missed by antivirus
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
// WMI Artifact Types
// ============================================================================

export interface WMIEventFilter {
  name: string;
  query: string;
  queryLanguage: string;
  eventNamespace: string;
  creatorSid?: string;
}

export interface WMIEventConsumer {
  name: string;
  consumerType: 'CommandLine' | 'ActiveScript' | 'LogFile' | 'SMTP' | 'Unknown';
  // For CommandLineEventConsumer
  executablePath?: string;
  commandLineTemplate?: string;
  // For ActiveScriptEventConsumer
  scriptingEngine?: string;
  scriptText?: string;
  scriptFileName?: string;
  // Generic
  creatorSid?: string;
}

export interface WMIBinding {
  filter: string;
  consumer: string;
  creatorSid?: string;
}

export interface WMISubscriptionArtifact extends Artifact {
  type: 'wmi_subscription';
  metadata: {
    subscriptionType: 'filter' | 'consumer' | 'binding';
    filter?: WMIEventFilter;
    consumer?: WMIEventConsumer;
    binding?: WMIBinding;
    // Linked objects (for correlation)
    linkedFilter?: string;
    linkedConsumer?: string;
  };
}

// ============================================================================
// Command Line Redaction (Privacy)
// ============================================================================

const SENSITIVE_PATTERNS = [
  /--password[=\s]+\S+/gi,
  /--token[=\s]+\S+/gi,
  /--key[=\s]+\S+/gi,
  /--secret[=\s]+\S+/gi,
  /-p\s+\S+/g,
  /[a-zA-Z0-9+/]{40,}={0,2}/g, // Base64 tokens
];

function redactCommandLine(cmdLine: string | null | undefined): string | undefined {
  if (!cmdLine) return undefined;

  let redacted = cmdLine;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

// ============================================================================
// PowerShell WMI Enumeration
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

/**
 * Get all WMI event filters
 */
async function getEventFilters(): Promise<WMIEventFilter[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $filters = Get-CimInstance -Namespace root/subscription -ClassName __EventFilter | ForEach-Object {
      @{
        Name = $_.Name
        Query = $_.Query
        QueryLanguage = $_.QueryLanguage
        EventNamespace = $_.EventNamespace
        CreatorSid = $_.CreatorSID
      }
    }

    if ($filters) {
      $filters | ConvertTo-Json -Depth 3 -Compress
    } else {
      "[]"
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((f: Record<string, unknown>) => ({
      name: f.Name as string,
      query: f.Query as string,
      queryLanguage: f.QueryLanguage as string || 'WQL',
      eventNamespace: f.EventNamespace as string || 'root\\cimv2',
      creatorSid: f.CreatorSid as string | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Get all WMI event consumers
 */
async function getEventConsumers(): Promise<WMIEventConsumer[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $consumers = @()

    # CommandLineEventConsumer
    Get-CimInstance -Namespace root/subscription -ClassName CommandLineEventConsumer -ErrorAction SilentlyContinue | ForEach-Object {
      $consumers += @{
        Name = $_.Name
        ConsumerType = 'CommandLine'
        ExecutablePath = $_.ExecutablePath
        CommandLineTemplate = $_.CommandLineTemplate
        CreatorSid = $_.CreatorSID
      }
    }

    # ActiveScriptEventConsumer
    Get-CimInstance -Namespace root/subscription -ClassName ActiveScriptEventConsumer -ErrorAction SilentlyContinue | ForEach-Object {
      $consumers += @{
        Name = $_.Name
        ConsumerType = 'ActiveScript'
        ScriptingEngine = $_.ScriptingEngine
        ScriptText = $_.ScriptText
        ScriptFileName = $_.ScriptFileName
        CreatorSid = $_.CreatorSID
      }
    }

    # LogFileEventConsumer
    Get-CimInstance -Namespace root/subscription -ClassName LogFileEventConsumer -ErrorAction SilentlyContinue | ForEach-Object {
      $consumers += @{
        Name = $_.Name
        ConsumerType = 'LogFile'
        CreatorSid = $_.CreatorSID
      }
    }

    # SMTPEventConsumer
    Get-CimInstance -Namespace root/subscription -ClassName SMTPEventConsumer -ErrorAction SilentlyContinue | ForEach-Object {
      $consumers += @{
        Name = $_.Name
        ConsumerType = 'SMTP'
        CreatorSid = $_.CreatorSID
      }
    }

    if ($consumers.Count -gt 0) {
      $consumers | ConvertTo-Json -Depth 3 -Compress
    } else {
      "[]"
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((c: Record<string, unknown>) => ({
      name: c.Name as string,
      consumerType: (c.ConsumerType as WMIEventConsumer['consumerType']) || 'Unknown',
      executablePath: c.ExecutablePath as string | undefined,
      commandLineTemplate: c.CommandLineTemplate as string | undefined,
      scriptingEngine: c.ScriptingEngine as string | undefined,
      scriptText: c.ScriptText as string | undefined,
      scriptFileName: c.ScriptFileName as string | undefined,
      creatorSid: c.CreatorSid as string | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Get all WMI filter-to-consumer bindings
 */
async function getBindings(): Promise<WMIBinding[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $bindings = Get-CimInstance -Namespace root/subscription -ClassName __FilterToConsumerBinding | ForEach-Object {
      # Extract names from WMI paths
      $filterName = $_.Filter.ToString() -replace '.*Name="([^"]+)".*', '$1'
      $consumerName = $_.Consumer.ToString() -replace '.*Name="([^"]+)".*', '$1'

      @{
        Filter = $filterName
        Consumer = $consumerName
        CreatorSid = $_.CreatorSID
      }
    }

    if ($bindings) {
      $bindings | ConvertTo-Json -Depth 3 -Compress
    } else {
      "[]"
    }
  `;

  try {
    const output = await runPowerShell(script);
    if (!output || output === '[]') return [];

    let parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed.map((b: Record<string, unknown>) => ({
      filter: b.Filter as string,
      consumer: b.Consumer as string,
      creatorSid: b.CreatorSid as string | undefined,
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
 * Check if a path is within vendor-defined paths
 */
function isPathOwned(
  checkPath: string | null | undefined,
  vendorPaths: string[],
): boolean {
  if (!checkPath) return false;

  const normalizedPath = normalizePath(expandEnvVars(checkPath));

  for (const vendorPath of vendorPaths) {
    const normalizedVendor = normalizePath(expandEnvVars(vendorPath));
    if (normalizedPath.startsWith(normalizedVendor)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a query references vendor-related content
 */
function isQueryVendorRelated(
  query: string,
  vendorProcesses: string[],
  vendorPaths: string[],
): boolean {
  const normalizedQuery = query.toLowerCase();

  // Check for process names in query
  for (const proc of vendorProcesses) {
    const normalizedProc = proc.toLowerCase().replace(/\.exe$/, '');
    if (normalizedQuery.includes(normalizedProc)) {
      return true;
    }
  }

  // Check for paths in query
  for (const path of vendorPaths) {
    const normalizedPath = normalizePath(expandEnvVars(path));
    if (normalizedQuery.includes(normalizedPath)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// WMI Scanner Implementation
// ============================================================================

export class WMISubscriptionScanner implements Scanner<WMISubscriptionArtifact> {
  readonly id = 'wmi' as const;

  /**
   * Scan WMI event subscriptions for vendor-related persistence
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of WMISubscriptionArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<WMISubscriptionArtifact[]> {
    const { product } = ctx;
    const artifacts: WMISubscriptionArtifact[] = [];

    // Collect all vendor paths for ownership check
    const vendorPaths = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
    ];

    // Get all WMI subscription components
    const [filters, consumers, bindings] = await Promise.all([
      getEventFilters(),
      getEventConsumers(),
      getBindings(),
    ]);

    // Create lookup for bindings
    const filterToConsumer = new Map<string, string>();
    const consumerToFilter = new Map<string, string>();
    for (const binding of bindings) {
      filterToConsumer.set(binding.filter, binding.consumer);
      consumerToFilter.set(binding.consumer, binding.filter);
    }

    // Process filters
    for (const filter of filters) {
      const matchesQuery = isQueryVendorRelated(filter.query, product.processes, vendorPaths);
      const linkedConsumer = filterToConsumer.get(filter.name);

      if (!matchesQuery) {
        continue; // Not vendor-related
      }

      const artifact: WMISubscriptionArtifact = {
        id: `wmi_filter_${crypto.randomUUID()}`,
        type: 'wmi_subscription',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence: 'medium', // Query-based matching
        },
        path: `root/subscription:__EventFilter.Name="${filter.name}"`,
        metadata: {
          subscriptionType: 'filter',
          filter,
          linkedConsumer,
        },
        observedAt: Date.now(),
        source: 'wmi' as const,
      };

      artifacts.push(artifact);
    }

    // Process consumers
    for (const consumer of consumers) {
      const matchesExePath = isPathOwned(consumer.executablePath, vendorPaths);
      const matchesCmdLine = isPathOwned(consumer.commandLineTemplate, vendorPaths);
      const matchesScriptFile = isPathOwned(consumer.scriptFileName, vendorPaths);
      const linkedFilter = consumerToFilter.get(consumer.name);

      if (!matchesExePath && !matchesCmdLine && !matchesScriptFile) {
        continue; // Not vendor-related
      }

      const confidence: OwnerTag['confidence'] =
        matchesExePath ? 'high' :
        matchesCmdLine || matchesScriptFile ? 'medium' : 'low';

      // Redact command lines
      const redactedConsumer = {
        ...consumer,
        commandLineTemplate: redactCommandLine(consumer.commandLineTemplate),
        scriptText: consumer.scriptText ? '[SCRIPT_REDACTED]' : undefined,
      };

      const artifact: WMISubscriptionArtifact = {
        id: `wmi_consumer_${crypto.randomUUID()}`,
        type: 'wmi_subscription',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence,
        },
        path: `root/subscription:${consumer.consumerType}EventConsumer.Name="${consumer.name}"`,
        metadata: {
          subscriptionType: 'consumer',
          consumer: redactedConsumer,
          linkedFilter,
        },
        observedAt: Date.now(),
        source: 'wmi' as const,
      };

      artifacts.push(artifact);
    }

    // Process bindings
    for (const binding of bindings) {
      // A binding is vendor-related if either its filter or consumer is vendor-related
      const filterArtifact = artifacts.find(
        a => a.metadata.subscriptionType === 'filter' &&
             a.metadata.filter?.name === binding.filter
      );
      const consumerArtifact = artifacts.find(
        a => a.metadata.subscriptionType === 'consumer' &&
             a.metadata.consumer?.name === binding.consumer
      );

      if (!filterArtifact && !consumerArtifact) {
        continue; // Neither end is vendor-related
      }

      const artifact: WMISubscriptionArtifact = {
        id: `wmi_binding_${crypto.randomUUID()}`,
        type: 'wmi_subscription',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence: 'medium',
        },
        path: `root/subscription:__FilterToConsumerBinding`,
        metadata: {
          subscriptionType: 'binding',
          binding,
          linkedFilter: binding.filter,
          linkedConsumer: binding.consumer,
        },
        observedAt: Date.now(),
        source: 'wmi' as const,
      };

      artifacts.push(artifact);
    }

    // DETERMINISM: Sort by path
    artifacts.sort((a, b) => (a.path || '').localeCompare(b.path || ''));

    return artifacts;
  }

  /**
   * Get all WMI subscriptions (for broad-spectrum scanning)
   */
  async getAllSubscriptions(): Promise<{
    filters: WMIEventFilter[];
    consumers: WMIEventConsumer[];
    bindings: WMIBinding[];
  }> {
    const [filters, consumers, bindings] = await Promise.all([
      getEventFilters(),
      getEventConsumers(),
      getBindings(),
    ]);
    return { filters, consumers, bindings };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createWMISubscriptionScanner(): WMISubscriptionScanner {
  return new WMISubscriptionScanner();
}
