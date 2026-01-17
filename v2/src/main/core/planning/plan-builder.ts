/**
 * PlanBuilder - Core Planning Engine
 *
 * Produces a deterministic, explainable, policy-compliant Plan from a Snapshot.
 *
 * Responsibilities:
 * - Filter artifacts by ownership confidence
 * - Generate appropriate steps for the requested mode
 * - Order steps according to execution rules
 * - Validate all steps against policy before returning
 *
 * This module is PURE LOGIC - no side effects, no mutations.
 */

import type {
  Artifact,
  Mode,
  Plan,
  PlanBoundaries,
  PlanStep,
  RiskLevel,
  Snapshot,
  StepAction,
} from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';
import type { RemediationPolicy } from '../remediation/policy';
import {
  MODE_BEHAVIORS,
  STEP_ACTION_META,
  STEP_EXECUTION_ORDER,
  INTRA_CATEGORY_ORDER,
  type PlanBuilder,
  type PlanBuilderInput,
  type PlanBuildResult,
  type PlanOptions,
  type SkippedArtifact,
  type LanePlanBuilder,
  type LanePlanBuilderInput,
  type LanePlanBuildResult,
  type LaneRecommendation,
} from './types';
import {
  createPlanRiskScorer,
  createCombinedRiskScorer,
} from '../risk';
import {
  createAutopilotPolicy,
  type AutopilotDecision,
} from '../risk/autopilot-policy';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a deterministic ID for plans and steps
 * Uses timestamp + counter for reproducibility in tests
 */
let stepCounter = 0;
export function resetStepCounter(): void {
  stepCounter = 0;
}

function generateStepId(): string {
  return `step_${++stepCounter}`;
}

function generatePlanId(productId: string, mode: Mode): string {
  const timestamp = Date.now();
  const hash = Math.random().toString(36).substring(2, 6);
  return `plan_${productId}_${mode}_${timestamp}_${hash}`;
}

// ============================================================================
// Step Creation Helpers
// ============================================================================

interface StepCreationContext {
  product: ProductDefinition;
  mode: Mode;
  options: PlanOptions;
}

function createStopProcessStep(
  processName: string,
  ctx: StepCreationContext,
): PlanStep {
  return {
    id: generateStepId(),
    action: 'StopProcess',
    target: processName,
    requiresAdmin: false,
    risk: 'low',
    reason: `Process "${processName}" must be stopped to release file handles.`,
    metadata: { processName },
  };
}

function createStopServiceStep(
  serviceName: string,
  ctx: StepCreationContext,
): PlanStep {
  return {
    id: generateStepId(),
    action: 'StopService',
    target: serviceName,
    requiresAdmin: true,
    risk: 'low',
    reason: `Service "${serviceName}" must be stopped before removal.`,
    metadata: { serviceName },
  };
}

function createRunUninstallerStep(
  product: ProductDefinition,
): PlanStep {
  return {
    id: generateStepId(),
    action: 'RunUninstaller',
    target: product.displayName,
    requiresAdmin: true,
    risk: 'medium',
    reason: `Run official ${product.vendor} uninstaller to remove registered components.`,
    metadata: {
      uninstallerPath: product.uninstaller?.path,
      uninstallerArgs: product.uninstaller?.args,
      msiProductCode: product.uninstaller?.msiProductCode,
    },
  };
}

function createRemoveFolderStep(
  folderPath: string,
  ctx: StepCreationContext,
): PlanStep {
  // HKLM paths require admin, HKCU doesn't
  const requiresAdmin = folderPath.toLowerCase().includes('programdata') ||
                        folderPath.toLowerCase().includes('program files');

  return {
    id: generateStepId(),
    action: 'RemoveFolder',
    target: folderPath,
    requiresAdmin,
    risk: 'medium',
    reason: `Remove ${ctx.product.displayName} data folder.`,
    metadata: { folderPath },
  };
}

function createDeleteRegistryKeyStep(
  keyPath: string,
  ctx: StepCreationContext,
): PlanStep {
  // HKLM keys require admin, HKCU doesn't
  const requiresAdmin = keyPath.toUpperCase().startsWith('HKLM') ||
                        keyPath.toUpperCase().startsWith('HKEY_LOCAL_MACHINE');

  return {
    id: generateStepId(),
    action: 'DeleteRegistryKey',
    target: keyPath,
    requiresAdmin,
    risk: 'medium',
    reason: `Remove ${ctx.product.displayName} registry configuration.`,
    rollback: 'Registry key will be backed up before deletion.',
    metadata: { keyPath },
  };
}

function createDeleteScheduledTaskStep(
  taskPath: string,
  ctx: StepCreationContext,
): PlanStep {
  return {
    id: generateStepId(),
    action: 'DeleteScheduledTask',
    target: taskPath,
    requiresAdmin: true,
    risk: 'low',
    reason: `Remove ${ctx.product.displayName} scheduled task.`,
    metadata: { taskPath },
  };
}

function createReinstallStep(
  product: ProductDefinition,
): PlanStep {
  return {
    id: generateStepId(),
    action: 'Reinstall',
    target: product.displayName,
    requiresAdmin: true,
    risk: 'medium',
    reason: `Download and install fresh copy of ${product.displayName}.`,
    metadata: {
      downloadUrl: product.installer?.downloadUrl,
      filename: product.installer?.filename,
      silentArgs: product.installer?.silentArgs,
    },
  };
}

// ============================================================================
// Step Ordering
// ============================================================================

/**
 * Sort steps according to execution rules:
 * 1. By category (execution → removal → installation)
 * 2. Within category, by action priority
 */
function orderSteps(steps: PlanStep[]): PlanStep[] {
  return [...steps].sort((a, b) => {
    const metaA = STEP_ACTION_META[a.action];
    const metaB = STEP_ACTION_META[b.action];

    // First sort by category
    const categoryOrderA = STEP_EXECUTION_ORDER.indexOf(metaA.category);
    const categoryOrderB = STEP_EXECUTION_ORDER.indexOf(metaB.category);

    if (categoryOrderA !== categoryOrderB) {
      return categoryOrderA - categoryOrderB;
    }

    // Within same category, sort by intra-category order
    const intraOrderA = INTRA_CATEGORY_ORDER[a.action] ?? 99;
    const intraOrderB = INTRA_CATEGORY_ORDER[b.action] ?? 99;

    if (intraOrderA !== intraOrderB) {
      return intraOrderA - intraOrderB;
    }

    // Finally, sort by target name for determinism
    return a.target.localeCompare(b.target);
  });
}

// ============================================================================
// Artifact Filtering & Extraction
// ============================================================================

/**
 * Filter artifacts to only those owned by the target product
 * with sufficient confidence
 */
function filterOwnedArtifacts(
  artifacts: Artifact[],
  product: ProductDefinition,
  minConfidence: 'high' | 'medium' | 'low' = 'medium',
): Artifact[] {
  const confidenceLevels = { high: 3, medium: 2, low: 1 };
  const minLevel = confidenceLevels[minConfidence];

  return artifacts.filter(artifact => {
    // Check vendor matches
    const vendorMatch =
      artifact.owner.vendor.toLowerCase() === product.vendor.toLowerCase() ||
      artifact.owner.product.toLowerCase() === product.id.toLowerCase();

    // Check confidence level
    const confidenceLevel = confidenceLevels[artifact.owner.confidence];
    const confidenceOk = confidenceLevel >= minLevel;

    return vendorMatch && confidenceOk;
  });
}

/**
 * Extract unique process names from artifacts
 */
function extractProcessNames(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter(a => a.type === 'process')
      .map(a => a.path || (a.metadata as { name?: string }).name || '')
      .filter(Boolean),
  )];
}

/**
 * Extract unique service names from artifacts
 */
function extractServiceNames(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter(a => a.type === 'service')
      .map(a => a.path || (a.metadata as { name?: string }).name || '')
      .filter(Boolean),
  )];
}

/**
 * Extract unique folder paths from artifacts
 */
function extractFolderPaths(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter(a => a.type === 'file')
      .map(a => a.path || '')
      .filter(Boolean),
  )];
}

/**
 * Extract unique registry key paths from artifacts
 */
function extractRegistryKeys(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter(a => a.type === 'registry')
      .map(a => a.path || '')
      .filter(Boolean),
  )];
}

/**
 * Extract unique task paths from artifacts
 */
function extractTaskPaths(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter(a => a.type === 'task')
      .map(a => a.path || '')
      .filter(Boolean),
  )];
}

// ============================================================================
// Plan Boundaries
// ============================================================================

/**
 * Generate plan boundaries from product definition
 */
function createBoundaries(product: ProductDefinition): PlanBoundaries {
  return {
    allowedPaths: [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
      ...product.paths.logs,
      ...product.paths.temp,
    ],
    allowedRegistryPrefixes: [
      ...product.registry.software,
      ...product.registry.uninstall,
      ...product.registry.services,
      ...product.registry.other,
    ],
    allowedServices: [...product.services],
    allowedTasks: [...product.tasks],
  };
}

// ============================================================================
// Default PlanBuilder Implementation
// ============================================================================

export class DefaultPlanBuilder implements LanePlanBuilder {
  private planRiskScorer = createPlanRiskScorer();
  private combinedRiskScorer = createCombinedRiskScorer();
  private autopilotPolicy = createAutopilotPolicy();

  constructor(private policy: RemediationPolicy) {}

  async build(input: PlanBuilderInput): Promise<PlanBuildResult> {
    const { product, mode, snapshot, options } = input;
    const modeBehavior = MODE_BEHAVIORS[mode];
    const warnings: string[] = [];
    const skippedArtifacts: SkippedArtifact[] = [];

    // Reset step counter for deterministic IDs in tests
    resetStepCounter();

    // ========================================================================
    // 1. Handle audit mode (no steps)
    // ========================================================================
    if (!modeBehavior.generatesPlan) {
      return {
        plan: {
          id: generatePlanId(product.id, mode),
          productId: product.id,
          mode,
          createdAt: Date.now(),
          dryRun: options.dryRun ?? true,
          steps: [],
          boundaries: createBoundaries(product),
        },
        warnings: ['Audit mode: no actions will be taken.'],
        skippedArtifacts: [],
      };
    }

    // ========================================================================
    // 2. Filter artifacts by ownership
    // ========================================================================
    const ownedArtifacts = filterOwnedArtifacts(snapshot.artifacts, product);

    // Track skipped low-confidence artifacts
    const lowConfidence = snapshot.artifacts.filter(
      a => a.owner.confidence === 'low' &&
           (a.owner.vendor.toLowerCase() === product.vendor.toLowerCase() ||
            a.owner.product.toLowerCase() === product.id.toLowerCase()),
    );
    for (const artifact of lowConfidence) {
      skippedArtifacts.push({
        artifactId: artifact.id,
        reason: 'Low ownership confidence - requires manual review',
      });
    }

    // ========================================================================
    // 3. Extract targets from artifacts
    // ========================================================================
    const processNames = extractProcessNames(ownedArtifacts);
    const serviceNames = extractServiceNames(ownedArtifacts);
    const folderPaths = extractFolderPaths(ownedArtifacts);
    const registryKeys = extractRegistryKeys(ownedArtifacts);
    const taskPaths = extractTaskPaths(ownedArtifacts);

    // ========================================================================
    // 4. Create step context
    // ========================================================================
    const ctx: StepCreationContext = { product, mode, options };
    const steps: PlanStep[] = [];
    const allowedActions = modeBehavior.allowedActions;

    // ========================================================================
    // 5. Build steps based on mode
    // ========================================================================

    // Stop processes (if allowed by mode)
    if (allowedActions.includes('StopProcess')) {
      for (const processName of processNames) {
        steps.push(createStopProcessStep(processName, ctx));
      }
    }

    // Stop services (if allowed by mode)
    if (allowedActions.includes('StopService')) {
      for (const serviceName of serviceNames) {
        steps.push(createStopServiceStep(serviceName, ctx));
      }
    }

    // Run uninstaller (if allowed by mode and uninstaller exists)
    if (allowedActions.includes('RunUninstaller') && product.uninstaller) {
      steps.push(createRunUninstallerStep(product));
    }

    // Delete scheduled tasks (if allowed by mode)
    if (allowedActions.includes('DeleteScheduledTask')) {
      for (const taskPath of taskPaths) {
        steps.push(createDeleteScheduledTaskStep(taskPath, ctx));
      }
    }

    // Remove folders (if allowed by mode)
    if (allowedActions.includes('RemoveFolder')) {
      // Filter out folders if preserveUserSettings is enabled
      const foldersToRemove = options.preserveUserSettings
        ? folderPaths.filter(p => !this.isPreservableSetting(p, product))
        : folderPaths;

      for (const folderPath of foldersToRemove) {
        steps.push(createRemoveFolderStep(folderPath, ctx));
      }

      // Track skipped preservable settings
      if (options.preserveUserSettings) {
        const preserved = folderPaths.filter(p =>
          this.isPreservableSetting(p, product),
        );
        for (const path of preserved) {
          warnings.push(`Preserving user setting: ${path}`);
        }
      }
    }

    // Delete registry keys (if allowed by mode)
    if (allowedActions.includes('DeleteRegistryKey')) {
      for (const keyPath of registryKeys) {
        steps.push(createDeleteRegistryKeyStep(keyPath, ctx));
      }
    }

    // Reinstall (if mode is reinstall)
    if (allowedActions.includes('Reinstall') && mode === 'reinstall') {
      if (product.installer) {
        steps.push(createReinstallStep(product));
      } else {
        warnings.push('Reinstall requested but no installer configured for product.');
      }
    }

    // ========================================================================
    // 6. Order steps according to execution rules
    // ========================================================================
    const orderedSteps = orderSteps(steps);

    // ========================================================================
    // 7. Validate ALL steps against policy (hard stop on violation)
    // ========================================================================
    const boundaries = createBoundaries(product);
    const mockPlan: Plan = {
      id: 'validation',
      productId: product.id,
      mode,
      createdAt: Date.now(),
      dryRun: true,
      steps: orderedSteps,
      boundaries,
    };

    // This will throw PolicyViolationError if any step is out of bounds
    for (const step of orderedSteps) {
      this.validateStepAgainstPolicy(step, mockPlan);
    }

    // ========================================================================
    // 8. Build and return final plan
    // ========================================================================
    const plan: Plan = {
      id: generatePlanId(product.id, mode),
      productId: product.id,
      mode,
      createdAt: Date.now(),
      dryRun: options.dryRun ?? true,
      steps: orderedSteps,
      boundaries,
    };

    // Add warning if no steps generated
    if (orderedSteps.length === 0) {
      warnings.push('No artifacts found that require action.');
    }

    return { plan, warnings, skippedArtifacts };
  }

  /**
   * Check if a path is a preservable user setting
   */
  private isPreservableSetting(path: string, product: ProductDefinition): boolean {
    if (!product.preservableSettings) return false;

    const normalizedPath = path.toLowerCase();
    return product.preservableSettings.some(
      preservable => normalizedPath.includes(preservable.toLowerCase()),
    );
  }

  /**
   * Validate a step against policy boundaries
   * Throws PolicyViolationError on violation
   */
  private validateStepAgainstPolicy(step: PlanStep, plan: Plan): void {
    switch (step.action) {
      case 'RemoveFolder':
        this.policy.assertAllowedPath(step.target, plan);
        break;

      case 'DeleteRegistryKey':
      case 'DeleteRegistryValue':
        this.policy.assertAllowedRegistryKey(step.target, plan);
        break;

      case 'StopService':
        this.policy.assertAllowedService(step.target, plan);
        break;

      case 'DeleteScheduledTask':
        this.policy.assertAllowedTask(step.target, plan);
        break;

      // StopProcess, RunUninstaller, Reinstall, RestoreDefault
      // don't have path-based policy checks (they use other validations)
    }
  }

  // ==========================================================================
  // Lane-Based Plan Building
  // ==========================================================================

  async buildWithLanes(input: LanePlanBuilderInput): Promise<LanePlanBuildResult> {
    const { sessionRisk, quarantineEnabled, ...buildInput } = input;

    // 1. Build the full plan first
    const fullResult = await this.build(buildInput);
    const fullPlan = fullResult.plan;

    // 2. Score the plan
    const planRisk = this.planRiskScorer.score(fullPlan);

    // 3. Get combined assessment
    const assessment = this.combinedRiskScorer.assess(sessionRisk, planRisk);

    // 4. Evaluate autopilot eligibility
    const autopilotDecision = this.autopilotPolicy.evaluate(
      planRisk,
      sessionRisk,
      quarantineEnabled,
    );

    // 5. Partition steps into lanes
    const autopilotSteps = fullPlan.steps.filter(
      step => autopilotDecision.allowedSteps.includes(step.id),
    );
    const assistedSteps = fullPlan.steps.filter(
      step => autopilotDecision.blockedSteps.includes(step.id),
    );

    // 6. Create lane-specific plans
    const autopilotPlan: Plan | null = autopilotSteps.length > 0
      ? {
          ...fullPlan,
          id: `${fullPlan.id}_autopilot`,
          steps: autopilotSteps,
        }
      : null;

    const assistedPlan: Plan = {
      ...fullPlan,
      id: `${fullPlan.id}_assisted`,
      steps: assistedSteps,
    };

    // 7. Generate recommendation
    const recommendation = this.generateRecommendation(
      autopilotDecision,
      assessment,
      autopilotSteps.length,
      assistedSteps.length,
    );

    // 8. Collect all warnings
    const warnings = [
      ...fullResult.warnings,
      ...assessment.allWarnings,
    ];

    return {
      autopilotPlan,
      assistedPlan,
      assessment,
      autopilotDecision,
      planRisk,
      warnings,
      skippedArtifacts: fullResult.skippedArtifacts,
      recommendation,
    };
  }

  /**
   * Generate lane recommendation for the user
   */
  private generateRecommendation(
    autopilotDecision: AutopilotDecision,
    assessment: import('../risk/types').CompleteRiskAssessment,
    autopilotCount: number,
    assistedCount: number,
  ): LaneRecommendation {
    const totalSteps = autopilotCount + assistedCount;

    // Handle blocked case
    if (assessment.allBlockers.length > 0) {
      return {
        lane: 'blocked',
        reason: assessment.allBlockers[0],
        autopilotAvailable: false,
        stepCounts: { autopilot: 0, assisted: 0 },
        bannerText: `🚫 Blocked: ${assessment.allBlockers[0]}`,
        bannerSeverity: 'blocked',
      };
    }

    // Handle manual-only case
    if (assessment.recommendation === 'manual_only') {
      return {
        lane: 'manual_only',
        reason: assessment.recommendationReason,
        autopilotAvailable: false,
        stepCounts: { autopilot: 0, assisted: assistedCount },
        bannerText: `⛔ Manual review required: ${assistedCount} action(s) need expert review`,
        bannerSeverity: 'error',
      };
    }

    // Handle autopilot available
    if (autopilotDecision.eligible && autopilotCount > 0) {
      if (assistedCount === 0) {
        // All steps are autopilot-eligible
        return {
          lane: 'autopilot',
          reason: 'All steps are low-risk and eligible for automated execution',
          autopilotAvailable: true,
          stepCounts: { autopilot: autopilotCount, assisted: 0 },
          bannerText: `✅ Autopilot available: ${autopilotCount} safe action(s)`,
          bannerSeverity: 'success',
        };
      } else {
        // Mixed: some autopilot, some assisted
        return {
          lane: 'assisted',
          reason: `${autopilotCount} action(s) can run automatically, ${assistedCount} need review`,
          autopilotAvailable: true,
          stepCounts: { autopilot: autopilotCount, assisted: assistedCount },
          bannerText: `⚠️ Assisted required: ${assistedCount} action(s) need review (${autopilotCount} can run automatically)`,
          bannerSeverity: 'warning',
        };
      }
    }

    // No autopilot available
    return {
      lane: 'assisted',
      reason: autopilotDecision.reasonCodes.join('; ') || 'Autopilot not available',
      autopilotAvailable: false,
      stepCounts: { autopilot: 0, assisted: assistedCount },
      bannerText: `⚠️ Assisted required: ${assistedCount} action(s) need review`,
      bannerSeverity: 'warning',
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPlanBuilder(policy: RemediationPolicy): LanePlanBuilder {
  return new DefaultPlanBuilder(policy);
}
