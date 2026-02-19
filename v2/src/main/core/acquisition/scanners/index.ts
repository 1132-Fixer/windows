/**
 * Scanners Index
 *
 * Exports all scanners for the acquisition layer.
 *
 * SCANNER CATEGORIES:
 *
 * 1. Vendor-Scoped Scanners (filter by product definition):
 *    - FileSystemScanner - files and folders
 *    - RegistryScanner - registry keys and values
 *    - ProcessScanner - running processes
 *    - ServiceScanner - Windows services
 *    - TaskScanner - scheduled tasks
 *    - WMISubscriptionScanner - WMI event subscriptions
 *
 * 2. System-Wide Scanners (broad-spectrum, no vendor filter):
 *    - NetworkConfigScanner - proxy, DNS, hosts
 *    - DefenderStateScanner - Windows Defender state
 *
 * SAFETY NOTES:
 * - All scanners are READ-ONLY
 * - Scanners never throw for inaccessible items
 * - Output is always deterministic (sorted)
 */

// Filesystem
export {
  FileSystemScanner,
  createFileSystemScanner,
} from './filesystem.scanner';

// Registry
export {
  RegistryScanner,
  createRegistryScanner,
} from './registry.scanner';

// Process
export {
  ProcessScanner,
  createProcessScanner,
} from './process.scanner';

// Service
export {
  ServiceScanner,
  createServiceScanner,
} from './service.scanner';

// Task (Scheduled Tasks)
export {
  TaskScanner,
  createTaskScanner,
} from './task.scanner';

// WMI Subscriptions
export {
  WMISubscriptionScanner,
  createWMISubscriptionScanner,
  type WMIEventFilter,
  type WMIEventConsumer,
  type WMIBinding,
  type WMISubscriptionArtifact,
} from './wmi.scanner';

// Network Configuration
export {
  NetworkConfigScanner,
  createNetworkConfigScanner,
  type ProxySettings,
  type DNSSettings,
  type HostsEntry,
  type NetworkConfigArtifact,
} from './network.scanner';

// Defender State
export {
  DefenderStateScanner,
  createDefenderStateScanner,
  type DefenderExclusion,
  type DefenderThreat,
  type DefenderState,
  type DefenderStateArtifact,
} from './defender.scanner';

// Types
export type {
  Scanner,
  ScanContext,
  ScanResult,
  ScanError,
  FileArtifact,
  RegistryArtifact,
  ProcessArtifact,
  ServiceArtifact,
  TaskArtifact,
  NetworkArtifact,
  SignatureInfo,
} from '../types';

/**
 * Create all vendor-scoped scanners
 */
export function createVendorScanners() {
  return {
    filesystem: createFileSystemScanner(),
    registry: createRegistryScanner(),
    process: createProcessScanner(),
    service: createServiceScanner(),
    task: createTaskScanner(),
    wmi: createWMISubscriptionScanner(),
  };
}

/**
 * Create all system-wide scanners
 */
export function createSystemScanners() {
  return {
    network: createNetworkConfigScanner(),
    defender: createDefenderStateScanner(),
  };
}

/**
 * Create all scanners
 */
export function createAllScanners() {
  return {
    ...createVendorScanners(),
    ...createSystemScanners(),
  };
}
