/**
 * Acquisition Layer Types
 * Defines scanner interfaces and artifact subtypes
 */

import type {
  Artifact,
  ArtifactType,
  OwnerTag,
  ScannerId,
} from '../../../shared/types';

// ============================================================================
// Product Definition (loaded from YAML config)
// ============================================================================

export interface ProductDefinition {
  id: string;
  vendor: string;
  displayName: string;
  version?: string;

  // Scoped boundaries for safety
  paths: {
    install: string[];      // e.g., ['%PROGRAMFILES%\\Zoom', '%LOCALAPPDATA%\\Programs\\Zoom']
    appData: string[];      // e.g., ['%APPDATA%\\Zoom', '%LOCALAPPDATA%\\Zoom']
    programData: string[];  // e.g., ['%PROGRAMDATA%\\Zoom']
    logs: string[];
    temp: string[];
  };

  registry: {
    software: string[];     // e.g., ['HKCU\\Software\\Zoom', 'HKLM\\Software\\Zoom']
    uninstall: string[];    // Uninstall entries
    services: string[];     // Service registry paths
    other: string[];
  };

  processes: string[];      // e.g., ['Zoom.exe', 'ZoomWebHost.exe']
  services: string[];       // e.g., ['ZoomCptService']
  tasks: string[];          // e.g., ['\\Zoom\\ZoomUpdateTaskMachine']

  uninstaller?: {
    path: string;           // Path to uninstaller
    args: string[];         // Silent uninstall args
    msiProductCode?: string;
  };

  installer?: {
    downloadUrl: string;
    filename: string;
    silentArgs: string[];
  };

  // Optional: settings to preserve during clean
  preservableSettings?: string[];
}

// ============================================================================
// Scan Context
// ============================================================================

export interface ScanContext {
  product: ProductDefinition;
  includeAllUsers: boolean;
  now: number;
  userProfiles?: UserProfile[];
}

export interface UserProfile {
  username: string;
  sid: string;
  profilePath: string;
  isCurrentUser: boolean;
}

// ============================================================================
// Scanner Interface
// ============================================================================

export interface Scanner<TArtifact extends Artifact = Artifact> {
  id: ScannerId;
  scan(ctx: ScanContext): Promise<TArtifact[]>;
}

// ============================================================================
// File Artifact
// ============================================================================

export interface FileArtifact extends Artifact {
  type: 'file';
  path: string;
  metadata: {
    name: string;
    extension: string;
    size: number;
    created: number;
    modified: number;
    accessed: number;
    isDirectory: boolean;
    isHidden: boolean;
    isSystem: boolean;
    isReadOnly: boolean;
    sha256?: string;
    signature?: SignatureInfo;
  };
}

export interface SignatureInfo {
  isSigned: boolean;
  isValid: boolean;
  signer?: string;
  issuer?: string;
  thumbprint?: string;
  timestamp?: number;
}

// ============================================================================
// Registry Artifact
// ============================================================================

export interface RegistryArtifact extends Artifact {
  type: 'registry';
  path: string;
  metadata: {
    hive: 'HKCU' | 'HKLM' | 'HKU' | 'HKCR' | 'HKCC';
    keyPath: string;
    valueName?: string;
    valueType?: RegistryValueType;
    value?: unknown;
    expandedValue?: string; // Environment variables expanded
    lastWriteTime?: number;
    // Key-level aggregates
    values?: Record<string, unknown>;
    valueCount?: number;
    exists?: boolean;
  };
}

export type RegistryValueType =
  | 'REG_SZ'
  | 'REG_EXPAND_SZ'
  | 'REG_MULTI_SZ'
  | 'REG_DWORD'
  | 'REG_QWORD'
  | 'REG_BINARY'
  | 'REG_NONE';

// ============================================================================
// Process Artifact
// ============================================================================

export interface ProcessArtifact extends Artifact {
  type: 'process';
  metadata: {
    pid: number;
    name: string;
    executablePath?: string;
    commandLine?: string; // Redacted for privacy
    parentPid?: number;
    parentName?: string;
    username?: string;
    startTime?: number;
    sessionId?: number;
    isElevated?: boolean;
    signature?: SignatureInfo;
  };
}

// ============================================================================
// Service Artifact
// ============================================================================

export interface ServiceArtifact extends Artifact {
  type: 'service';
  metadata: {
    name: string;
    displayName: string;
    description?: string;
    binaryPath: string;
    startType: ServiceStartType;
    currentState: ServiceState;
    serviceType: ServiceType;
    account?: string;
    signature?: SignatureInfo;
  };
}

export type ServiceStartType =
  | 'Boot'
  | 'System'
  | 'Automatic'
  | 'Manual'
  | 'Disabled';

export type ServiceState =
  | 'Running'
  | 'Stopped'
  | 'StartPending'
  | 'StopPending'
  | 'Paused'
  | 'PausePending'
  | 'ContinuePending'
  | 'Unknown';

export type ServiceType =
  | 'KernelDriver'
  | 'FileSystemDriver'
  | 'Win32OwnProcess'
  | 'Win32ShareProcess'
  | 'InteractiveProcess';

// ============================================================================
// Task Artifact (Scheduled Task)
// ============================================================================

export interface TaskArtifact extends Artifact {
  type: 'task';
  metadata: {
    name: string;
    path: string;          // Task folder path
    enabled: boolean;
    state: TaskState;
    lastRun?: number;
    nextRun?: number;
    author?: string;
    description?: string;
    actions: TaskAction[];
    triggers: TaskTrigger[];
  };
}

export type TaskState =
  | 'Disabled'
  | 'Queued'
  | 'Ready'
  | 'Running'
  | 'Unknown';

export interface TaskAction {
  type: 'Execute' | 'ComHandler' | 'SendEmail' | 'ShowMessage';
  path?: string;
  arguments?: string;
  workingDirectory?: string;
}

export interface TaskTrigger {
  type: string; // 'Daily', 'Weekly', 'Logon', 'Boot', etc.
  enabled: boolean;
  startBoundary?: string;
  endBoundary?: string;
}

// ============================================================================
// Network Artifact (Read-Only Observer)
// ============================================================================

export interface NetworkArtifact extends Artifact {
  type: 'network';
  metadata: {
    category: NetworkCategory;
    current: unknown;
    isDefault: boolean;
    modifiedBy?: string;
  };
}

export type NetworkCategory =
  | 'dns'
  | 'proxy'
  | 'hosts'
  | 'firewall_rule'
  | 'certificate';

// ============================================================================
// WMI Subscription Artifact (Stealth Persistence Detection)
// ============================================================================

export interface WMISubscriptionArtifact extends Artifact {
  type: 'wmi_subscription';
  metadata: {
    subscriptionType: 'filter' | 'consumer' | 'binding';
    filter?: {
      name: string;
      query: string;
      queryLanguage: string;
      eventNamespace: string;
    };
    consumer?: {
      name: string;
      consumerType: 'CommandLine' | 'ActiveScript' | 'LogFile' | 'SMTP' | 'Unknown';
      executablePath?: string;
      commandLineTemplate?: string;
      scriptingEngine?: string;
      scriptFileName?: string;
    };
    binding?: {
      filter: string;
      consumer: string;
    };
    linkedFilter?: string;
    linkedConsumer?: string;
  };
}

// ============================================================================
// Defender State Artifact (Security State Detection)
// ============================================================================

export interface DefenderStateArtifact extends Artifact {
  type: 'defender_state';
  metadata: {
    state: {
      realTimeProtectionEnabled: boolean;
      behaviorMonitorEnabled: boolean;
      antivirusEnabled: boolean;
      antispywareEnabled: boolean;
      tamperProtectionEnabled: boolean | null;
      exclusions: Array<{
        type: 'path' | 'extension' | 'process' | 'ip';
        value: string;
      }>;
      threatCount: number;
    };
    overallStatus: 'healthy' | 'degraded' | 'compromised' | 'unknown';
    suspiciousIndicators: string[];
  };
}

// ============================================================================
// Scanner Results
// ============================================================================

export interface ScanResult<T extends Artifact = Artifact> {
  scannerId: ScannerId;
  artifacts: T[];
  errors: ScanError[];
  durationMs: number;
}

export interface ScanError {
  path?: string;
  message: string;
  code?: string;
}
