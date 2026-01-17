/**
 * Artifact Risk Scorer
 *
 * Scores individual artifacts based on their characteristics.
 *
 * SCORING FACTORS:
 * - Location (system paths vs user paths)
 * - Type (file, registry, process, service, task)
 * - Content indicators (user data, config, cache)
 * - Ownership confidence
 * - Size (for files)
 */

import type { Artifact } from '../../../shared/types';
import type {
  ArtifactRisk,
  ArtifactRiskScorer,
  RiskFactor,
  RiskScore,
} from './types';
import { scoreToBucket } from './types';

// ============================================================================
// Risk Factor Definitions
// ============================================================================

const FACTORS = {
  // Location-based factors
  systemPath: {
    id: 'system_path',
    name: 'System Path Location',
    description: 'Artifact is in a system-critical location',
    category: 'system_impact' as const,
    weight: 30,
    confidence: 'high' as const,
    mitigations: ['Verify ownership before deletion', 'Create backup'],
  },
  programFiles: {
    id: 'program_files',
    name: 'Program Files Location',
    description: 'Artifact is in Program Files directory',
    category: 'scope' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Standard installation path'],
  },
  userProfile: {
    id: 'user_profile',
    name: 'User Profile Location',
    description: 'Artifact is in user profile (lower risk)',
    category: 'scope' as const,
    weight: 5,
    confidence: 'high' as const,
    mitigations: ['User-scoped data only'],
  },
  roamingData: {
    id: 'roaming_data',
    name: 'Roaming AppData',
    description: 'Contains roaming settings that sync',
    category: 'data_loss' as const,
    weight: 20,
    confidence: 'medium' as const,
    mitigations: ['Consider preserveUserSettings option'],
  },

  // Registry-based factors
  hklmRegistry: {
    id: 'hklm_registry',
    name: 'HKLM Registry Key',
    description: 'Machine-wide registry change',
    category: 'scope' as const,
    weight: 20,
    confidence: 'high' as const,
    mitigations: ['Requires admin', 'Affects all users'],
  },
  hkcuRegistry: {
    id: 'hkcu_registry',
    name: 'HKCU Registry Key',
    description: 'User-specific registry change',
    category: 'scope' as const,
    weight: 10,
    confidence: 'high' as const,
    mitigations: ['User-scoped only'],
  },
  runKey: {
    id: 'run_key',
    name: 'Run/RunOnce Key',
    description: 'Startup registry key (autorun)',
    category: 'system_impact' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Verify not needed for other apps'],
  },
  shellExtension: {
    id: 'shell_extension',
    name: 'Shell Extension',
    description: 'Explorer shell integration',
    category: 'system_impact' as const,
    weight: 25,
    confidence: 'medium' as const,
    mitigations: ['May require explorer restart'],
  },

  // Process/Service factors
  runningProcess: {
    id: 'running_process',
    name: 'Running Process',
    description: 'Process is currently running',
    category: 'system_impact' as const,
    weight: 10,
    confidence: 'high' as const,
    mitigations: ['Stop process before file removal'],
  },
  elevatedProcess: {
    id: 'elevated_process',
    name: 'Elevated Process',
    description: 'Process running with admin rights',
    category: 'privilege' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Requires admin to terminate'],
  },
  runningService: {
    id: 'running_service',
    name: 'Running Service',
    description: 'Windows service is running',
    category: 'system_impact' as const,
    weight: 20,
    confidence: 'high' as const,
    mitigations: ['Stop service first'],
  },
  autoStartService: {
    id: 'auto_start_service',
    name: 'Auto-Start Service',
    description: 'Service starts automatically',
    category: 'reversibility' as const,
    weight: 10,
    confidence: 'high' as const,
    mitigations: ['Will restart on reboot if not fully removed'],
  },

  // Task factors
  enabledTask: {
    id: 'enabled_task',
    name: 'Enabled Scheduled Task',
    description: 'Task is enabled and may run',
    category: 'system_impact' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Disable before removal'],
  },
  systemTask: {
    id: 'system_task',
    name: 'System Task Folder',
    description: 'Task in system folder (Microsoft, etc.)',
    category: 'system_impact' as const,
    weight: 40,
    confidence: 'high' as const,
    mitigations: ['Verify ownership - may be critical'],
  },

  // Content-based factors
  userData: {
    id: 'user_data',
    name: 'User Data Folder',
    description: 'Likely contains user-created data',
    category: 'data_loss' as const,
    weight: 35,
    confidence: 'medium' as const,
    mitigations: ['Backup first', 'Confirm with user'],
  },
  configData: {
    id: 'config_data',
    name: 'Configuration Data',
    description: 'Contains application configuration',
    category: 'data_loss' as const,
    weight: 20,
    confidence: 'medium' as const,
    mitigations: ['preserveUserSettings option'],
  },
  cacheData: {
    id: 'cache_data',
    name: 'Cache Data',
    description: 'Temporary/cache data (safe to delete)',
    category: 'data_loss' as const,
    weight: 2,
    confidence: 'high' as const,
    mitigations: ['Safe to remove'],
  },
  logData: {
    id: 'log_data',
    name: 'Log Data',
    description: 'Application logs',
    category: 'data_loss' as const,
    weight: 5,
    confidence: 'high' as const,
    mitigations: ['Generally safe to remove'],
  },

  // Ownership factors
  lowConfidence: {
    id: 'low_confidence',
    name: 'Low Ownership Confidence',
    description: 'Not certain this belongs to target vendor',
    category: 'scope' as const,
    weight: 40,
    confidence: 'low' as const,
    mitigations: ['Manual verification recommended'],
  },
  mediumConfidence: {
    id: 'medium_confidence',
    name: 'Medium Ownership Confidence',
    description: 'Moderately confident this belongs to vendor',
    category: 'scope' as const,
    weight: 15,
    confidence: 'medium' as const,
    mitigations: ['Review before deletion'],
  },

  // Size factors
  largeFile: {
    id: 'large_file',
    name: 'Large File/Folder',
    description: 'Over 100MB - likely installers or data',
    category: 'data_loss' as const,
    weight: 10,
    confidence: 'medium' as const,
    mitigations: ['Ensure sufficient quarantine space'],
  },
  veryLargeFile: {
    id: 'very_large_file',
    name: 'Very Large File/Folder',
    description: 'Over 1GB - significant data',
    category: 'data_loss' as const,
    weight: 25,
    confidence: 'high' as const,
    mitigations: ['May be user recordings/data'],
  },
};

// ============================================================================
// Path Patterns for Classification
// ============================================================================

const PATH_PATTERNS = {
  system: [
    /^[A-Z]:\\Windows\\/i,
    /^[A-Z]:\\System32\\/i,
    /^[A-Z]:\\SysWOW64\\/i,
  ],
  programFiles: [
    /^[A-Z]:\\Program Files\\/i,
    /^[A-Z]:\\Program Files \(x86\)\\/i,
  ],
  userProfile: [
    /^[A-Z]:\\Users\\[^\\]+\\/i,
    /%USERPROFILE%/i,
  ],
  roamingAppData: [
    /\\AppData\\Roaming\\/i,
    /%APPDATA%/i,
  ],
  localAppData: [
    /\\AppData\\Local\\/i,
    /%LOCALAPPDATA%/i,
  ],
  programData: [
    /^[A-Z]:\\ProgramData\\/i,
    /%PROGRAMDATA%/i,
  ],
  userData: [
    /\\Documents\\/i,
    /\\Downloads\\/i,
    /\\Desktop\\/i,
    /\\Videos\\/i,
    /\\Music\\/i,
    /\\Pictures\\/i,
    /\\Recordings\\/i,
    /\\meetings\\/i,
  ],
  cache: [
    /\\cache\\/i,
    /\\temp\\/i,
    /\\tmp\\/i,
    /\\.cache/i,
  ],
  logs: [
    /\\logs?\\/i,
    /\\.log$/i,
  ],
  config: [
    /\\config\\/i,
    /\\settings\\/i,
    /\\preferences\\/i,
    /\\.ini$/i,
    /\\.json$/i,
    /\\.xml$/i,
  ],
};

const REGISTRY_PATTERNS = {
  run: [
    /\\Run$/i,
    /\\RunOnce$/i,
    /\\RunOnceEx$/i,
  ],
  shellExtension: [
    /\\ShellEx\\/i,
    /\\ContextMenuHandlers\\/i,
    /\\PropertySheetHandlers\\/i,
  ],
  uninstall: [
    /\\Uninstall\\/i,
  ],
  services: [
    /\\Services\\/i,
  ],
};

const TASK_PATTERNS = {
  system: [
    /^\\Microsoft\\/i,
    /^\\Apple\\/i,
    /^\\Google\\/i,
  ],
};

// ============================================================================
// Scorer Implementation
// ============================================================================

/**
 * Create an artifact risk scorer
 */
export function createArtifactRiskScorer(): ArtifactRiskScorer {
  return {
    score(artifact: Artifact): ArtifactRisk {
      const factors: RiskFactor[] = [];
      let baseScore = 10; // Minimum baseline
      let systemCritical = false;
      let containsUserData = false;
      let reversible = true;

      // Score by artifact type
      switch (artifact.type) {
        case 'file':
          scoreFileArtifact(artifact, factors);
          break;
        case 'registry':
          scoreRegistryArtifact(artifact, factors);
          break;
        case 'process':
          scoreProcessArtifact(artifact, factors);
          break;
        case 'service':
          scoreServiceArtifact(artifact, factors);
          break;
        case 'task':
          scoreTaskArtifact(artifact, factors);
          break;
      }

      // Score by ownership confidence
      if (artifact.owner.confidence === 'low') {
        factors.push(FACTORS.lowConfidence);
      } else if (artifact.owner.confidence === 'medium') {
        factors.push(FACTORS.mediumConfidence);
      }

      // Calculate total score
      const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
      const score = Math.min(100, baseScore + totalWeight);

      // Check for user data
      containsUserData = factors.some(f => f.category === 'data_loss' && f.weight > 20);

      // Check for system critical
      systemCritical = factors.some(
        f => f.category === 'system_impact' && f.weight >= 30
      );

      // Check reversibility
      reversible = !factors.some(
        f => f.category === 'reversibility' || (f.category === 'data_loss' && f.weight > 30)
      );

      return {
        artifactId: artifact.id,
        score,
        bucket: scoreToBucket(score),
        factors,
        systemCritical,
        containsUserData,
        reversible,
      };
    },

    scoreAll(artifacts: Artifact[]): ArtifactRisk[] {
      return artifacts.map(a => this.score(a));
    },
  };
}

// ============================================================================
// Type-Specific Scorers
// ============================================================================

function scoreFileArtifact(artifact: Artifact, factors: RiskFactor[]): void {
  const path = artifact.path || '';
  const metadata = artifact.metadata as Record<string, unknown>;

  // Location scoring
  if (matchesAny(path, PATH_PATTERNS.system)) {
    factors.push(FACTORS.systemPath);
  } else if (matchesAny(path, PATH_PATTERNS.programFiles)) {
    factors.push(FACTORS.programFiles);
  } else if (matchesAny(path, PATH_PATTERNS.userProfile)) {
    factors.push(FACTORS.userProfile);
  }

  if (matchesAny(path, PATH_PATTERNS.roamingAppData)) {
    factors.push(FACTORS.roamingData);
  }

  // Content type scoring
  if (matchesAny(path, PATH_PATTERNS.userData)) {
    factors.push(FACTORS.userData);
  } else if (matchesAny(path, PATH_PATTERNS.cache)) {
    factors.push(FACTORS.cacheData);
  } else if (matchesAny(path, PATH_PATTERNS.logs)) {
    factors.push(FACTORS.logData);
  } else if (matchesAny(path, PATH_PATTERNS.config)) {
    factors.push(FACTORS.configData);
  }

  // Size scoring
  const size = metadata.size as number | undefined;
  if (size !== undefined) {
    if (size > 1024 * 1024 * 1024) { // 1GB
      factors.push(FACTORS.veryLargeFile);
    } else if (size > 100 * 1024 * 1024) { // 100MB
      factors.push(FACTORS.largeFile);
    }
  }
}

function scoreRegistryArtifact(artifact: Artifact, factors: RiskFactor[]): void {
  const path = artifact.path || '';
  const metadata = artifact.metadata as Record<string, unknown>;

  // Hive scoring
  const hive = metadata.hive as string | undefined;
  if (hive === 'HKLM') {
    factors.push(FACTORS.hklmRegistry);
  } else if (hive === 'HKCU') {
    factors.push(FACTORS.hkcuRegistry);
  }

  // Key type scoring
  if (matchesAny(path, REGISTRY_PATTERNS.run)) {
    factors.push(FACTORS.runKey);
  }
  if (matchesAny(path, REGISTRY_PATTERNS.shellExtension)) {
    factors.push(FACTORS.shellExtension);
  }
}

function scoreProcessArtifact(artifact: Artifact, factors: RiskFactor[]): void {
  const metadata = artifact.metadata as Record<string, unknown>;

  // Always a running process (that's how we found it)
  factors.push(FACTORS.runningProcess);

  // Elevation scoring
  if (metadata.isElevated === true) {
    factors.push(FACTORS.elevatedProcess);
  }
}

function scoreServiceArtifact(artifact: Artifact, factors: RiskFactor[]): void {
  const metadata = artifact.metadata as Record<string, unknown>;

  // State scoring
  if (metadata.currentState === 'Running') {
    factors.push(FACTORS.runningService);
  }

  // Start type scoring
  const startType = metadata.startType as string | undefined;
  if (startType === 'Automatic' || startType === 'Boot' || startType === 'System') {
    factors.push(FACTORS.autoStartService);
  }
}

function scoreTaskArtifact(artifact: Artifact, factors: RiskFactor[]): void {
  const metadata = artifact.metadata as Record<string, unknown>;
  const path = metadata.path as string || '';

  // State scoring
  if (metadata.enabled === true) {
    factors.push(FACTORS.enabledTask);
  }

  // Path scoring - check if it's in a system folder
  if (matchesAny(path, TASK_PATTERNS.system)) {
    factors.push(FACTORS.systemTask);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(value));
}
