/**
 * Planning Layer Types
 * Defines plan building, risk assessment, and boundaries
 */

import type {
  Mode,
  Plan,
  PlanStep,
  RiskLevel,
  Snapshot,
  StepAction,
} from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';

// ============================================================================
// Plan Builder Interface
// ============================================================================

export interface PlanBuilderInput {
  product: ProductDefinition;
  mode: Mode;
  snapshot: Snapshot;
  options: PlanOptions;
}

export interface PlanOptions {
  reinstall?: boolean;
  preserveUserSettings?: boolean;
  dryRun?: boolean;
}

export interface PlanBuilder {
  /**
   * Build a remediation plan from the current snapshot
   * Plan is bounded by product definition and policy
   */
  build(input: PlanBuilderInput): Promise<PlanBuildResult>;
}

export interface PlanBuildResult {
  plan: Plan;
  warnings: string[];
  skippedArtifacts: SkippedArtifact[];
}

export interface SkippedArtifact {
  artifactId: string;
  reason: string;
}

// ============================================================================
// Step Factory
// ============================================================================

export interface StepFactory {
  /**
   * Create appropriate steps for a given artifact and mode
   */
  createSteps(
    artifact: import('../../../shared/types').Artifact,
    mode: Mode,
    product: ProductDefinition,
  ): PlanStep[];
}

// ============================================================================
// Risk Assessment
// ============================================================================

export interface RiskAssessor {
  /**
   * Assess the risk level of a planned step
   */
  assessStep(step: PlanStep, product: ProductDefinition): RiskAssessment;

  /**
   * Assess overall plan risk
   */
  assessPlan(plan: Plan): PlanRiskAssessment;
}

export interface RiskAssessment {
  level: RiskLevel;
  factors: RiskFactor[];
  mitigations: string[];
}

export interface RiskFactor {
  name: string;
  description: string;
  weight: number; // 0-100
}

export interface PlanRiskAssessment {
  overallRisk: RiskLevel;
  highRiskSteps: string[]; // step IDs
  requiresExplicitApproval: boolean;
  warnings: string[];
}

// ============================================================================
// Step Action Metadata
// ============================================================================

export const STEP_ACTION_META: Record<StepAction, StepActionMeta> = {
  StopProcess: {
    category: 'execution',
    defaultRisk: 'low',
    requiresAdmin: false,
    reversible: false,
    description: 'Terminate a running process',
  },
  StopService: {
    category: 'execution',
    defaultRisk: 'low',
    requiresAdmin: true,
    reversible: true,
    description: 'Stop a Windows service',
  },
  RunUninstaller: {
    category: 'removal',
    defaultRisk: 'medium',
    requiresAdmin: true,
    reversible: false,
    description: 'Execute vendor uninstaller',
  },
  RemoveFolder: {
    category: 'removal',
    defaultRisk: 'medium',
    requiresAdmin: false, // depends on location
    reversible: false,
    description: 'Delete a folder and its contents',
  },
  DeleteRegistryKey: {
    category: 'removal',
    defaultRisk: 'medium',
    requiresAdmin: false, // depends on hive
    reversible: true, // with backup
    description: 'Delete a registry key and subkeys',
  },
  DeleteRegistryValue: {
    category: 'removal',
    defaultRisk: 'low',
    requiresAdmin: false,
    reversible: true,
    description: 'Delete a specific registry value',
  },
  DeleteScheduledTask: {
    category: 'removal',
    defaultRisk: 'low',
    requiresAdmin: true,
    reversible: false,
    description: 'Remove a scheduled task',
  },
  Reinstall: {
    category: 'installation',
    defaultRisk: 'medium',
    requiresAdmin: true,
    reversible: true,
    description: 'Download and install fresh copy',
  },
  RestoreDefault: {
    category: 'repair',
    defaultRisk: 'low',
    requiresAdmin: false,
    reversible: true,
    description: 'Restore setting to default value',
  },
};

export interface StepActionMeta {
  category: 'execution' | 'removal' | 'installation' | 'repair';
  defaultRisk: RiskLevel;
  requiresAdmin: boolean;
  reversible: boolean;
  description: string;
}

// ============================================================================
// Mode-Specific Behaviors
// ============================================================================

export const MODE_BEHAVIORS: Record<Mode, ModeBehavior> = {
  audit: {
    description: 'Read-only scan, no changes',
    allowedActions: [],
    generatesPlan: false,
  },
  clean: {
    description: 'Remove residual files and registry entries',
    allowedActions: ['RemoveFolder', 'DeleteRegistryKey', 'DeleteRegistryValue'],
    generatesPlan: true,
  },
  repair: {
    description: 'Fix orphaned references and broken state',
    allowedActions: ['DeleteRegistryKey', 'DeleteRegistryValue', 'RestoreDefault'],
    generatesPlan: true,
  },
  uninstall: {
    description: 'Complete removal of application',
    allowedActions: [
      'StopProcess',
      'StopService',
      'RunUninstaller',
      'RemoveFolder',
      'DeleteRegistryKey',
      'DeleteRegistryValue',
      'DeleteScheduledTask',
    ],
    generatesPlan: true,
  },
  reinstall: {
    description: 'Uninstall and reinstall fresh',
    allowedActions: [
      'StopProcess',
      'StopService',
      'RunUninstaller',
      'RemoveFolder',
      'DeleteRegistryKey',
      'DeleteRegistryValue',
      'DeleteScheduledTask',
      'Reinstall',
    ],
    generatesPlan: true,
  },
};

export interface ModeBehavior {
  description: string;
  allowedActions: StepAction[];
  generatesPlan: boolean;
}

// ============================================================================
// Step Ordering Rules
// ============================================================================

/**
 * Steps must be executed in this category order
 * to ensure safe remediation
 */
export const STEP_EXECUTION_ORDER: Array<StepActionMeta['category']> = [
  'execution',   // 1. Stop processes/services first
  'removal',     // 2. Then remove files/registry/tasks
  'repair',      // 3. Fix any broken state
  'installation', // 4. Finally reinstall if needed
];

/**
 * Within a category, these actions have priority
 */
export const INTRA_CATEGORY_ORDER: Partial<Record<StepAction, number>> = {
  StopService: 1,   // Stop services before processes (prevents respawn)
  StopProcess: 2,
  RunUninstaller: 1, // Run uninstaller before manual removal
  DeleteScheduledTask: 2,
  RemoveFolder: 3,
  DeleteRegistryKey: 4,
  DeleteRegistryValue: 5,
};

// ============================================================================
// Lane-Based Plan Building (Commit #9)
// ============================================================================

import type {
  CompleteRiskAssessment,
  PlanRisk,
  SessionRisk,
} from '../risk/types';
import type { AutopilotDecision } from '../risk/autopilot-policy';

/**
 * Execution lane for remediation
 */
export type ExecutionLane = 'autopilot' | 'assisted';

/**
 * Input for building lane-partitioned plans
 */
export interface LanePlanBuilderInput extends PlanBuilderInput {
  /**
   * Session risk assessment (from environmental scan)
   */
  sessionRisk: SessionRisk;

  /**
   * Whether quarantine is enabled for file operations
   */
  quarantineEnabled: boolean;
}

/**
 * Result of lane-partitioned plan building
 */
export interface LanePlanBuildResult {
  /**
   * Autopilot plan (only low-risk, high-confidence steps)
   * Null if no steps are autopilot-eligible
   */
  autopilotPlan: Plan | null;

  /**
   * Assisted plan (all remaining steps requiring user confirmation)
   * Always present, may be empty
   */
  assistedPlan: Plan;

  /**
   * Complete risk assessment
   */
  assessment: CompleteRiskAssessment;

  /**
   * Autopilot eligibility decision
   */
  autopilotDecision: AutopilotDecision;

  /**
   * Plan-level risk assessment
   */
  planRisk: PlanRisk;

  /**
   * Warnings from plan building
   */
  warnings: string[];

  /**
   * Skipped artifacts
   */
  skippedArtifacts: SkippedArtifact[];

  /**
   * Recommendation for the user
   */
  recommendation: LaneRecommendation;
}

/**
 * Recommendation for lane selection
 */
export interface LaneRecommendation {
  /**
   * Recommended lane
   */
  lane: 'autopilot' | 'assisted' | 'manual_only' | 'blocked';

  /**
   * Human-readable reason
   */
  reason: string;

  /**
   * Whether autopilot is available (even if not recommended)
   */
  autopilotAvailable: boolean;

  /**
   * Number of steps in each lane
   */
  stepCounts: {
    autopilot: number;
    assisted: number;
  };

  /**
   * User-facing banner text
   */
  bannerText: string;

  /**
   * Banner severity for UI styling
   */
  bannerSeverity: 'success' | 'warning' | 'error' | 'blocked';
}

/**
 * Extended PlanBuilder with lane support
 */
export interface LanePlanBuilder extends PlanBuilder {
  /**
   * Build lane-partitioned plans (autopilot + assisted)
   */
  buildWithLanes(input: LanePlanBuilderInput): Promise<LanePlanBuildResult>;
}
