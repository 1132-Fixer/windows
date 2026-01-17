/**
 * Plan Risk Scorer
 *
 * Aggregates step-level risks and adds plan-level factors.
 *
 * PLAN FACTORS:
 * - Total step count (complexity)
 * - High-risk step concentration
 * - Admin requirement count
 * - Irreversible action count
 * - Scope (files, registry, services affected)
 */

import type { Plan, PlanStep, StepAction } from '../../../shared/types';
import type {
  ArtifactRisk,
  PlanRisk,
  PlanRiskScorer,
  RiskFactor,
  RiskScore,
  StepRisk,
} from './types';
import { scoreToBucket } from './types';
import { STEP_ACTION_META } from '../planning/types';

// ============================================================================
// Plan-Level Risk Factors
// ============================================================================

const PLAN_FACTORS = {
  // Scope factors
  manySteps: {
    id: 'many_steps',
    name: 'Many Steps',
    description: 'Plan has many steps (over 20)',
    category: 'scope' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Review plan carefully', 'Consider breaking into phases'],
  },
  veryManySteps: {
    id: 'very_many_steps',
    name: 'Very Many Steps',
    description: 'Plan has very many steps (over 50)',
    category: 'scope' as const,
    weight: 25,
    confidence: 'high' as const,
    mitigations: ['Extended remediation', 'Monitor progress closely'],
  },
  wideScope: {
    id: 'wide_scope',
    name: 'Wide Scope',
    description: 'Plan touches multiple system areas',
    category: 'scope' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Verify all targets are vendor-owned'],
  },

  // Admin factors
  manyAdminSteps: {
    id: 'many_admin_steps',
    name: 'Many Admin Steps',
    description: 'Many steps require admin (over 10)',
    category: 'privilege' as const,
    weight: 15,
    confidence: 'high' as const,
    mitigations: ['Ensure running elevated'],
  },

  // Reversibility factors
  manyIrreversible: {
    id: 'many_irreversible',
    name: 'Many Irreversible Steps',
    description: 'Many steps cannot be undone (over 10)',
    category: 'reversibility' as const,
    weight: 20,
    confidence: 'high' as const,
    mitigations: ['Verify quarantine enabled', 'Review each step'],
  },
  allIrreversible: {
    id: 'all_irreversible',
    name: 'All Steps Irreversible',
    description: 'No steps can be undone',
    category: 'reversibility' as const,
    weight: 30,
    confidence: 'high' as const,
    mitigations: ['Enable quarantine', 'Consider backup first'],
  },

  // High-risk concentration
  highRiskConcentration: {
    id: 'high_risk_concentration',
    name: 'High Risk Concentration',
    description: 'Over 30% of steps are high-risk',
    category: 'system_impact' as const,
    weight: 25,
    confidence: 'high' as const,
    mitigations: ['Manual review recommended'],
  },
  criticalStepsPresent: {
    id: 'critical_steps_present',
    name: 'Critical Steps Present',
    description: 'Plan contains critical-risk steps',
    category: 'system_impact' as const,
    weight: 35,
    confidence: 'high' as const,
    mitigations: ['Explicit approval required'],
  },

  // Service/process factors
  manyServicesToStop: {
    id: 'many_services_to_stop',
    name: 'Many Services to Stop',
    description: 'Stopping multiple services (over 3)',
    category: 'system_impact' as const,
    weight: 15,
    confidence: 'medium' as const,
    mitigations: ['Verify services are vendor-owned'],
  },
  manyProcessesToStop: {
    id: 'many_processes_to_stop',
    name: 'Many Processes to Stop',
    description: 'Stopping many processes (over 5)',
    category: 'system_impact' as const,
    weight: 10,
    confidence: 'medium' as const,
    mitigations: ['Verify processes are vendor-owned'],
  },
};

// ============================================================================
// Step Risk Scoring
// ============================================================================

function scoreStep(
  step: PlanStep,
  artifactRisk?: ArtifactRisk,
): StepRisk {
  const factors: RiskFactor[] = [];
  const mitigations: string[] = [];

  // Get base risk from action metadata
  const actionMeta = STEP_ACTION_META[step.action];
  let baseScore = riskLevelToScore(actionMeta?.defaultRisk || 'medium');

  // Add action-specific factors
  addActionFactors(step.action, step.target, factors);

  // Incorporate artifact risk if available
  if (artifactRisk) {
    factors.push(...artifactRisk.factors);
    mitigations.push(...artifactRisk.factors.flatMap(f => f.mitigations));
  }

  // Admin requirement adds risk
  if (step.requiresAdmin) {
    factors.push({
      id: 'requires_admin',
      name: 'Requires Admin',
      description: 'Step requires administrator privileges',
      category: 'privilege',
      weight: 10,
      confidence: 'high',
      mitigations: ['Run as administrator'],
    });
  }

  // Explicit risk level from plan step
  if (step.risk === 'high') {
    baseScore = Math.max(baseScore, 60);
  }

  // Calculate total
  const factorWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const score = Math.min(100, baseScore + factorWeight);
  const bucket = scoreToBucket(score);

  // Determine recommendation
  let recommendation: StepRisk['recommendation'];
  let requiresApproval = false;

  if (score <= 25) {
    recommendation = 'autopilot';
  } else if (score <= 50) {
    recommendation = 'warn';
  } else if (score <= 75) {
    recommendation = 'confirm';
    requiresApproval = true;
  } else {
    recommendation = 'block';
    requiresApproval = true;
  }

  return {
    stepId: step.id,
    action: step.action,
    target: step.target,
    score,
    bucket,
    factors,
    mitigations: [...new Set(mitigations)],
    requiresApproval,
    recommendation,
  };
}

function addActionFactors(
  action: StepAction,
  target: string,
  factors: RiskFactor[],
): void {
  switch (action) {
    case 'StopProcess':
      factors.push({
        id: 'stop_process',
        name: 'Process Termination',
        description: 'Forcefully terminates a running process',
        category: 'system_impact',
        weight: 10,
        confidence: 'high',
        mitigations: ['Verify process belongs to target vendor'],
      });
      break;

    case 'StopService':
      factors.push({
        id: 'stop_service',
        name: 'Service Stop',
        description: 'Stops a Windows service',
        category: 'system_impact',
        weight: 15,
        confidence: 'high',
        mitigations: ['Service may be restarted by system'],
      });
      break;

    case 'RunUninstaller':
      factors.push({
        id: 'run_uninstaller',
        name: 'Vendor Uninstaller',
        description: 'Executes vendor-provided uninstaller',
        category: 'scope',
        weight: 20,
        confidence: 'medium',
        mitigations: ['Uninstaller behavior is vendor-controlled'],
      });
      break;

    case 'RemoveFolder':
      factors.push({
        id: 'remove_folder',
        name: 'Folder Removal',
        description: 'Deletes a folder and all contents',
        category: 'data_loss',
        weight: 15,
        confidence: 'high',
        mitigations: ['Quarantine enabled', 'Verify no user data'],
      });
      // Check for sensitive paths
      if (/Documents|Desktop|Downloads/i.test(target)) {
        factors.push({
          id: 'user_folder_risk',
          name: 'User Folder Location',
          description: 'Folder is in a user data location',
          category: 'data_loss',
          weight: 30,
          confidence: 'high',
          mitigations: ['Manual verification required'],
        });
      }
      break;

    case 'DeleteRegistryKey':
      factors.push({
        id: 'delete_registry_key',
        name: 'Registry Key Deletion',
        description: 'Deletes registry key and subkeys',
        category: 'system_impact',
        weight: 15,
        confidence: 'high',
        mitigations: ['Registry backup recommended'],
      });
      // Check for HKLM
      if (/^HKLM/i.test(target)) {
        factors.push({
          id: 'hklm_key',
          name: 'Machine-Wide Key',
          description: 'Affects all users on this machine',
          category: 'scope',
          weight: 15,
          confidence: 'high',
          mitigations: ['Requires admin', 'Affects all users'],
        });
      }
      break;

    case 'DeleteRegistryValue':
      factors.push({
        id: 'delete_registry_value',
        name: 'Registry Value Deletion',
        description: 'Deletes a specific registry value',
        category: 'system_impact',
        weight: 5,
        confidence: 'high',
        mitigations: ['Lower risk than key deletion'],
      });
      break;

    case 'DeleteScheduledTask':
      factors.push({
        id: 'delete_task',
        name: 'Task Deletion',
        description: 'Removes a scheduled task',
        category: 'system_impact',
        weight: 10,
        confidence: 'high',
        mitigations: ['Verify task belongs to vendor'],
      });
      break;

    case 'Reinstall':
      factors.push({
        id: 'reinstall',
        name: 'Application Reinstall',
        description: 'Downloads and installs fresh copy',
        category: 'scope',
        weight: 20,
        confidence: 'medium',
        mitigations: ['Requires internet', 'Settings may be lost'],
      });
      break;

    case 'RestoreDefault':
      factors.push({
        id: 'restore_default',
        name: 'Setting Restoration',
        description: 'Restores a setting to default value',
        category: 'system_impact',
        weight: 5,
        confidence: 'high',
        mitigations: ['Low risk operation'],
      });
      break;
  }
}

function riskLevelToScore(level: 'low' | 'medium' | 'high'): number {
  switch (level) {
    case 'low':
      return 15;
    case 'medium':
      return 35;
    case 'high':
      return 60;
  }
}

// ============================================================================
// Plan Risk Scoring
// ============================================================================

/**
 * Create a plan risk scorer
 */
export function createPlanRiskScorer(): PlanRiskScorer {
  return {
    score(plan: Plan, artifactRisks?: Map<string, ArtifactRisk>): PlanRisk {
      // Score all steps
      const stepRisks = plan.steps.map(step => {
        const artifactRisk = artifactRisks?.get(step.id);
        return scoreStep(step, artifactRisk);
      });

      // Calculate statistics
      const stats = {
        totalSteps: plan.steps.length,
        lowRiskCount: stepRisks.filter(s => s.bucket === 'low').length,
        mediumRiskCount: stepRisks.filter(s => s.bucket === 'medium').length,
        highRiskCount: stepRisks.filter(s => s.bucket === 'high').length,
        criticalRiskCount: stepRisks.filter(s => s.bucket === 'critical').length,
        requiresAdminCount: plan.steps.filter(s => s.requiresAdmin).length,
        irreversibleCount: plan.steps.filter(s => {
          const meta = STEP_ACTION_META[s.action];
          return meta && !meta.reversible;
        }).length,
      };

      // Identify high/critical risk steps
      const highRiskSteps = stepRisks
        .filter(s => s.bucket === 'high')
        .map(s => s.stepId);
      const criticalRiskSteps = stepRisks
        .filter(s => s.bucket === 'critical')
        .map(s => s.stepId);

      // Calculate plan-level factors
      const planFactors: RiskFactor[] = [];

      // Scope factors
      if (stats.totalSteps > 50) {
        planFactors.push(PLAN_FACTORS.veryManySteps);
      } else if (stats.totalSteps > 20) {
        planFactors.push(PLAN_FACTORS.manySteps);
      }

      // Check scope width
      const actionTypes = new Set(plan.steps.map(s => s.action));
      if (actionTypes.size >= 4) {
        planFactors.push(PLAN_FACTORS.wideScope);
      }

      // Admin factors
      if (stats.requiresAdminCount > 10) {
        planFactors.push(PLAN_FACTORS.manyAdminSteps);
      }

      // Reversibility factors
      if (stats.irreversibleCount === stats.totalSteps && stats.totalSteps > 0) {
        planFactors.push(PLAN_FACTORS.allIrreversible);
      } else if (stats.irreversibleCount > 10) {
        planFactors.push(PLAN_FACTORS.manyIrreversible);
      }

      // High-risk concentration
      const highRiskRatio =
        (stats.highRiskCount + stats.criticalRiskCount) / Math.max(1, stats.totalSteps);
      if (highRiskRatio > 0.3) {
        planFactors.push(PLAN_FACTORS.highRiskConcentration);
      }

      if (stats.criticalRiskCount > 0) {
        planFactors.push(PLAN_FACTORS.criticalStepsPresent);
      }

      // Service/process factors
      const serviceStops = plan.steps.filter(s => s.action === 'StopService').length;
      const processStops = plan.steps.filter(s => s.action === 'StopProcess').length;
      if (serviceStops > 3) {
        planFactors.push(PLAN_FACTORS.manyServicesToStop);
      }
      if (processStops > 5) {
        planFactors.push(PLAN_FACTORS.manyProcessesToStop);
      }

      // Calculate overall score
      // Base: weighted average of step scores
      const avgStepScore =
        stepRisks.reduce((sum, s) => sum + s.score, 0) / Math.max(1, stepRisks.length);

      // Add plan-level factors
      const planFactorWeight = planFactors.reduce((sum, f) => sum + f.weight, 0);

      // Cap the plan factor contribution at 40 points
      const planContribution = Math.min(40, planFactorWeight);

      const overallScore = Math.min(100, Math.round(avgStepScore + planContribution));
      const overallBucket = scoreToBucket(overallScore);

      // Determine autopilot eligibility
      const autopilotBlockers: string[] = [];

      if (stats.criticalRiskCount > 0) {
        autopilotBlockers.push(`${stats.criticalRiskCount} critical-risk steps require manual approval`);
      }
      if (stats.highRiskCount > 3) {
        autopilotBlockers.push(`Too many high-risk steps (${stats.highRiskCount})`);
      }
      if (overallScore > 50) {
        autopilotBlockers.push('Overall plan risk too high for autopilot');
      }
      if (stats.requiresAdminCount > 0 && plan.steps.some(s => s.requiresAdmin)) {
        // This is a soft blocker - still autopilotable if elevated
        // autopilotBlockers.push('Admin steps require elevated execution');
      }

      const autopilotEligible = autopilotBlockers.length === 0;

      // Determine recommendation
      let recommendation: PlanRisk['recommendation'];
      if (autopilotEligible && overallScore <= 25) {
        recommendation = 'autopilot';
      } else if (overallScore <= 50 && stats.criticalRiskCount === 0) {
        recommendation = 'assisted';
      } else {
        recommendation = 'manual_only';
      }

      // Generate summary
      const summary = generatePlanSummary(stats, overallScore, recommendation);

      return {
        planId: plan.id,
        overallScore,
        overallBucket,
        stepRisks,
        highRiskSteps,
        criticalRiskSteps,
        planFactors,
        stats,
        autopilotEligible,
        autopilotBlockers,
        recommendation,
        summary,
      };
    },
  };
}

function generatePlanSummary(
  stats: PlanRisk['stats'],
  score: number,
  recommendation: PlanRisk['recommendation'],
): string {
  const parts: string[] = [];

  parts.push(`Plan contains ${stats.totalSteps} step(s)`);

  if (stats.criticalRiskCount > 0) {
    parts.push(`including ${stats.criticalRiskCount} critical-risk action(s)`);
  } else if (stats.highRiskCount > 0) {
    parts.push(`including ${stats.highRiskCount} high-risk action(s)`);
  }

  if (stats.requiresAdminCount > 0) {
    parts.push(`${stats.requiresAdminCount} requiring admin`);
  }

  parts.push(`Overall risk score: ${score}/100`);

  switch (recommendation) {
    case 'autopilot':
      parts.push('Safe for automated execution');
      break;
    case 'assisted':
      parts.push('Recommend assisted mode with confirmation');
      break;
    case 'manual_only':
      parts.push('Manual review and approval required');
      break;
  }

  return parts.join('. ') + '.';
}
