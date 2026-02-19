/**
 * Plan IPC Handlers
 *
 * Handles plan operations: build with lanes, get risk summary, get current.
 * Plans are generated from audit snapshots with risk-based lane partitioning.
 */

import { ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type PlanBuildOptions,
  type PlanBuildResult,
  type PlanSummary,
  type StepSummary,
  type RiskSummary,
  type LaneRecommendation,
} from '../channels';
import { getSessionData, setSessionData } from './audit';
import { createPlanBuilder, createLanePlanBuilder } from '../../core/planning/plan-builder';
import { createRiskScoringEngine } from '../../core/risk';
import { createAutopilotPolicy } from '../../core/risk/autopilot-policy';
import type { Plan, PlanStep } from '../../../../shared/types';

// ============================================================================
// State
// ============================================================================

interface PlanState {
  sessionId: string;
  autopilotPlan?: Plan;
  assistedPlan: Plan;
  recommendation: LaneRecommendation;
  riskSummary: RiskSummary;
}

const planStore = new Map<string, PlanState>();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a full plan to a UI-friendly summary
 */
function toPlanSummary(plan: Plan): PlanSummary {
  return {
    planId: plan.id,
    stepCount: plan.steps.length,
    steps: plan.steps.map(toStepSummary),
  };
}

/**
 * Convert a step to UI-friendly summary
 */
function toStepSummary(step: PlanStep): StepSummary {
  return {
    id: step.id,
    action: step.action,
    target: step.target,
    description: step.reason || `${step.action} on ${step.target}`,
    riskBucket: step.risk,
    reversible: isReversible(step.action),
    autopilotEligible: isAutopilotEligible(step),
  };
}

/**
 * Check if an action is reversible
 */
function isReversible(action: string): boolean {
  const reversibleActions = new Set([
    'StopService',
    'DeleteRegistryKey',
    'DeleteRegistryValue',
    'RestoreDefault',
    'Reinstall',
  ]);
  return reversibleActions.has(action);
}

/**
 * Check if a step is autopilot eligible
 */
function isAutopilotEligible(step: PlanStep): boolean {
  // Low risk + not critical targets
  if (step.risk === 'high' || step.risk === 'critical') {
    return false;
  }

  // Certain actions always require user confirmation
  const assistedOnlyActions = new Set([
    'RunUninstaller',
    'Reinstall',
  ]);

  return !assistedOnlyActions.has(step.action);
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Build plans with lane partitioning
 */
async function handlePlanBuildWithLanes(
  _event: Electron.IpcMainInvokeEvent,
  options: PlanBuildOptions,
): Promise<PlanBuildResult> {
  const session = getSessionData(options.sessionId);

  if (!session) {
    return {
      success: false,
      autopilotPlan: undefined,
      assistedPlan: { planId: '', stepCount: 0, steps: [] },
      recommendation: {
        lane: 'blocked',
        reason: 'Session not found',
        autopilotAvailable: false,
        stepCounts: { autopilot: 0, assisted: 0 },
        bannerText: 'Session expired. Please run a new audit.',
        bannerSeverity: 'error',
      },
      riskSummary: {
        sessionRiskScore: 0,
        sessionRiskBucket: 'low',
        planRiskScore: 0,
        planRiskBucket: 'low',
        combinedScore: 0,
        combinedBucket: 'low',
        safeForRemediation: false,
        warnings: ['Session not found'],
        blockers: ['Session not found'],
      },
      error: 'Session not found. Run audit first.',
    };
  }

  try {
    // Create risk scoring engine
    const riskEngine = createRiskScoringEngine();
    const autopilotPolicy = createAutopilotPolicy();

    // Get snapshot from session
    const snapshot = session.snapshot as {
      processes: unknown[];
      services: unknown[];
      tasks: unknown[];
      files: unknown[];
      registry: unknown[];
      wmi: unknown[];
    };

    // Calculate artifact counts for mock session risk
    // In real implementation, would use actual Defender/Network scanners
    const sessionRisk = {
      score: 15,
      bucket: 'low' as const,
      securityPosture: {
        defenderActive: true,
        realTimeProtection: true,
        tamperProtection: null,
        suspiciousExclusions: 0,
        recentThreats: 0,
        overallStatus: 'healthy' as const,
        indicators: [],
      },
      networkPosture: {
        proxyConfigured: false,
        suspiciousProxy: false,
        hostsModified: false,
        securityDomainsBlocked: false,
        dnsHijacked: false,
        indicators: [],
      },
      warnings: [],
      blockers: [],
      safeForRemediation: true,
    };

    // Build mock plan for now
    // In real implementation, would call the actual plan builder
    const totalSteps = (snapshot.services?.length || 0) +
      (snapshot.tasks?.length || 0) +
      (snapshot.files?.length || 0) +
      (snapshot.registry?.length || 0);

    const mockSteps: PlanStep[] = [];
    let stepNum = 1;

    // Stop services first
    if (Array.isArray(snapshot.services)) {
      for (const svc of snapshot.services) {
        mockSteps.push({
          id: `step_${stepNum++}`,
          action: 'StopService',
          target: (svc as { name?: string }).name || 'UnknownService',
          requiresAdmin: true,
          risk: 'low',
          reason: 'Stop service before removal',
        });
      }
    }

    // Delete tasks
    if (Array.isArray(snapshot.tasks)) {
      for (const task of snapshot.tasks) {
        mockSteps.push({
          id: `step_${stepNum++}`,
          action: 'DeleteScheduledTask',
          target: (task as { path?: string }).path || 'UnknownTask',
          requiresAdmin: true,
          risk: 'low',
          reason: 'Remove scheduled task',
        });
      }
    }

    // Remove folders
    if (Array.isArray(snapshot.files)) {
      for (const file of snapshot.files) {
        mockSteps.push({
          id: `step_${stepNum++}`,
          action: 'RemoveFolder',
          target: (file as { path?: string }).path || 'UnknownPath',
          requiresAdmin: false,
          risk: 'medium',
          reason: 'Remove application folder',
        });
      }
    }

    // Delete registry
    if (Array.isArray(snapshot.registry)) {
      for (const reg of snapshot.registry) {
        mockSteps.push({
          id: `step_${stepNum++}`,
          action: 'DeleteRegistryKey',
          target: (reg as { path?: string }).path || 'UnknownKey',
          requiresAdmin: false,
          risk: 'medium',
          reason: 'Remove registry key',
        });
      }
    }

    // Partition into autopilot vs assisted
    const autopilotSteps = mockSteps.filter(isAutopilotEligible);
    const assistedSteps = mockSteps.filter((s) => !isAutopilotEligible(s));

    const autopilotPlan: Plan | null = autopilotSteps.length > 0
      ? {
          id: `plan_autopilot_${Date.now()}`,
          sessionId: options.sessionId,
          productId: session.productId,
          mode: options.mode,
          steps: autopilotSteps,
          boundaries: {
            allowedPaths: [],
            allowedRegistryPrefixes: [],
            allowedTasks: [],
          },
          createdAt: Date.now(),
          hash: '',
        }
      : null;

    const assistedPlan: Plan = {
      id: `plan_assisted_${Date.now()}`,
      sessionId: options.sessionId,
      productId: session.productId,
      mode: options.mode,
      steps: assistedSteps,
      boundaries: {
        allowedPaths: [],
        allowedRegistryPrefixes: [],
        allowedTasks: [],
      },
      createdAt: Date.now(),
      hash: '',
    };

    // Calculate plan risk
    const planRiskScore = mockSteps.reduce((sum, step) => {
      switch (step.risk) {
        case 'critical': return sum + 10;
        case 'high': return sum + 5;
        case 'medium': return sum + 2;
        default: return sum + 1;
      }
    }, 0);

    const planRiskBucket = planRiskScore > 50 ? 'critical'
      : planRiskScore > 30 ? 'high'
      : planRiskScore > 15 ? 'medium'
      : 'low';

    // Generate recommendation
    const hasBlockers = sessionRisk.blockers.length > 0;
    const hasHighRiskSteps = mockSteps.some((s) => s.risk === 'high' || s.risk === 'critical');

    const recommendation: LaneRecommendation = hasBlockers
      ? {
          lane: 'blocked',
          reason: sessionRisk.blockers[0],
          autopilotAvailable: false,
          stepCounts: { autopilot: 0, assisted: 0 },
          bannerText: `Cannot proceed: ${sessionRisk.blockers[0]}`,
          bannerSeverity: 'blocked',
        }
      : autopilotSteps.length > 0 && !hasHighRiskSteps
      ? {
          lane: 'autopilot',
          reason: `${autopilotSteps.length} steps can run automatically`,
          autopilotAvailable: true,
          stepCounts: {
            autopilot: autopilotSteps.length,
            assisted: assistedSteps.length,
          },
          bannerText: 'Autopilot available - Low-risk steps can run automatically',
          bannerSeverity: 'success',
        }
      : {
          lane: 'assisted',
          reason: hasHighRiskSteps
            ? 'High-risk steps require manual confirmation'
            : 'Manual confirmation recommended',
          autopilotAvailable: autopilotSteps.length > 0,
          stepCounts: {
            autopilot: autopilotSteps.length,
            assisted: assistedSteps.length,
          },
          bannerText: hasHighRiskSteps
            ? 'Manual review required - Some steps are high-risk'
            : 'Assisted mode - Review and confirm each step',
          bannerSeverity: 'warning',
        };

    const riskSummary: RiskSummary = {
      sessionRiskScore: sessionRisk.score,
      sessionRiskBucket: sessionRisk.bucket,
      planRiskScore,
      planRiskBucket,
      combinedScore: sessionRisk.score + planRiskScore,
      combinedBucket: sessionRisk.score + planRiskScore > 60 ? 'critical'
        : sessionRisk.score + planRiskScore > 40 ? 'high'
        : sessionRisk.score + planRiskScore > 20 ? 'medium'
        : 'low',
      safeForRemediation: sessionRisk.safeForRemediation && !hasBlockers,
      warnings: sessionRisk.warnings,
      blockers: sessionRisk.blockers,
    };

    // Store plan state
    planStore.set(options.sessionId, {
      sessionId: options.sessionId,
      autopilotPlan: autopilotPlan || undefined,
      assistedPlan,
      recommendation,
      riskSummary,
    });

    return {
      success: true,
      autopilotPlan: autopilotPlan ? toPlanSummary(autopilotPlan) : undefined,
      assistedPlan: toPlanSummary(assistedPlan),
      recommendation,
      riskSummary,
    };
  } catch (error) {
    return {
      success: false,
      autopilotPlan: undefined,
      assistedPlan: { planId: '', stepCount: 0, steps: [] },
      recommendation: {
        lane: 'blocked',
        reason: error instanceof Error ? error.message : 'Unknown error',
        autopilotAvailable: false,
        stepCounts: { autopilot: 0, assisted: 0 },
        bannerText: 'Plan building failed',
        bannerSeverity: 'error',
      },
      riskSummary: {
        sessionRiskScore: 0,
        sessionRiskBucket: 'low',
        planRiskScore: 0,
        planRiskBucket: 'low',
        combinedScore: 0,
        combinedBucket: 'low',
        safeForRemediation: false,
        warnings: [],
        blockers: [error instanceof Error ? error.message : 'Unknown error'],
      },
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get risk summary for current session
 */
async function handlePlanGetRiskSummary(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<RiskSummary | null> {
  const planState = planStore.get(sessionId);
  return planState?.riskSummary || null;
}

/**
 * Get current plan for session
 */
async function handlePlanGetCurrent(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<{ autopilot?: PlanSummary; assisted: PlanSummary } | null> {
  const planState = planStore.get(sessionId);

  if (!planState) {
    return null;
  }

  return {
    autopilot: planState.autopilotPlan ? toPlanSummary(planState.autopilotPlan) : undefined,
    assisted: toPlanSummary(planState.assistedPlan),
  };
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all plan IPC handlers
 */
export function registerPlanHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PLAN_BUILD_WITH_LANES, handlePlanBuildWithLanes);
  ipcMain.handle(IPC_CHANNELS.PLAN_GET_RISK_SUMMARY, handlePlanGetRiskSummary);
  ipcMain.handle(IPC_CHANNELS.PLAN_GET_CURRENT, handlePlanGetCurrent);
}

/**
 * Get plan state for session (for use by execute handler)
 */
export function getPlanState(sessionId: string) {
  return planStore.get(sessionId);
}
