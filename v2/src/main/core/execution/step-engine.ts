/**
 * DefaultStepEngine Implementation
 *
 * Executes approved plans step-by-step with:
 * - Policy re-enforcement at execution time (defense in depth)
 * - Before/after state capture for verification
 * - Quarantine-by-default for file operations
 * - Dry-run support for safe previews
 * - Detailed event recording for audit trail
 */

import type { Plan, PlanStep, ProductDefinition } from '../../../shared/types';
import type { RemediationPolicy } from '../policy/types';
import type { SystemAdapter } from './adapters/system-adapter';
import type {
  StepEngine,
  StepHandler,
  ExecutionContext,
  ExecutionResult,
  StepResult,
  StepEvent,
  ExecutionOptions,
  TimeoutConfig,
  StepBackupStore,
} from './types';
import { DEFAULT_EXECUTION_OPTIONS, DEFAULT_TIMEOUTS } from './types';
import { createStepHandlerRegistry, type StepHandlerRegistry } from './steps';
import { createBackupStore, createInMemoryBackupStore } from './backup-store';

/**
 * Configuration for creating a StepEngine
 */
export interface StepEngineConfig {
  /**
   * System adapter for OS operations
   */
  system: SystemAdapter;

  /**
   * Policy to enforce during execution
   */
  policy: RemediationPolicy;

  /**
   * Product definition for ownership checks
   */
  product: ProductDefinition;

  /**
   * Execution options
   */
  options?: Partial<ExecutionOptions>;

  /**
   * Timeout configuration
   */
  timeouts?: Partial<TimeoutConfig>;

  /**
   * Custom backup store (for testing)
   */
  backupStore?: StepBackupStore;
}

import type { ExecutionLane } from '../planning/types';
import type { LaneEnforcement } from './types';

/**
 * Create an execution context for a plan
 */
function createExecutionContext(
  plan: Plan,
  config: StepEngineConfig,
  dryRun: boolean,
  elevated: boolean,
  events: StepEvent[],
  lane: ExecutionLane = 'assisted',
  laneEnforcement?: LaneEnforcement,
): ExecutionContext {
  const options: ExecutionOptions = {
    ...DEFAULT_EXECUTION_OPTIONS,
    ...config.options,
  };

  const timeouts: TimeoutConfig = {
    ...DEFAULT_TIMEOUTS,
    ...config.timeouts,
  };

  const backupStore =
    config.backupStore ||
    (dryRun
      ? createInMemoryBackupStore()
      : createBackupStore(plan.id, config.product.id));

  return {
    product: config.product,
    plan,
    dryRun,
    elevated,
    policy: config.policy,
    record: (event: StepEvent) => events.push(event),
    backup: backupStore,
    timeouts,
    options,
    lane,
    laneEnforcement,
  };
}

/**
 * Create the default StepEngine implementation
 */
export function createStepEngine(config: StepEngineConfig): StepEngine {
  const handlerRegistry = createStepHandlerRegistry(config.system);

  return {
    async execute(
      plan: Plan,
      dryRun: boolean = false,
      elevated: boolean = false,
    ): Promise<ExecutionResult> {
      const events: StepEvent[] = [];
      const stepResults: StepResult[] = [];
      const ctx = createExecutionContext(plan, config, dryRun, elevated, events);

      // Record execution start
      ctx.record({
        type: 'execution_start',
        planId: plan.id,
        stepCount: plan.steps.length,
        dryRun,
        elevated,
        timestamp: Date.now(),
      });

      let overallSuccess = true;
      let aborted = false;

      for (const step of plan.steps) {
        if (aborted) {
          // Mark remaining steps as skipped
          stepResults.push({
            stepId: step.id,
            action: step.action,
            target: step.target,
            status: 'skipped',
            message: 'Execution aborted due to previous failure',
            before: {},
            after: {},
            durationMs: 0,
          });
          continue;
        }

        const stepResult = await executeStep(step, ctx, handlerRegistry);
        stepResults.push(stepResult);

        if (stepResult.status === 'failed') {
          overallSuccess = false;

          if (!ctx.options.continueOnFailure) {
            aborted = true;
          }
        }
      }

      // Record execution complete
      ctx.record({
        type: 'execution_complete',
        planId: plan.id,
        success: overallSuccess,
        timestamp: Date.now(),
      });

      return {
        planId: plan.id,
        success: overallSuccess,
        stepResults,
        events,
        startedAt: events[0]?.timestamp || Date.now(),
        completedAt: Date.now(),
        dryRun,
      };
    },

    async executeStep(
      step: PlanStep,
      plan: Plan,
      dryRun: boolean = false,
      elevated: boolean = false,
    ): Promise<StepResult> {
      const events: StepEvent[] = [];
      const ctx = createExecutionContext(plan, config, dryRun, elevated, events);

      return executeStep(step, ctx, handlerRegistry);
    },

    getHandlerRegistry(): StepHandlerRegistry {
      return handlerRegistry;
    },
  };
}

/**
 * Check if a step is allowed in the current lane
 */
function checkLaneEnforcement(
  step: PlanStep,
  ctx: ExecutionContext,
): { allowed: boolean; reason?: string } {
  // No enforcement = allowed
  if (!ctx.laneEnforcement) {
    return { allowed: true };
  }

  const { autopilotDecision, stepRiskMap, sessionRisk, strictMode } = ctx.laneEnforcement;

  // Autopilot lane has strict requirements
  if (ctx.lane === 'autopilot') {
    // Check if step is in autopilot allowed list
    if (!autopilotDecision.allowedSteps.includes(step.id)) {
      return {
        allowed: false,
        reason: `Step ${step.id} is not in autopilot allowed list`,
      };
    }

    // Check step risk bucket
    const stepRisk = stepRiskMap.get(step.id);
    if (stepRisk && stepRisk.bucket !== 'low') {
      return {
        allowed: false,
        reason: `Step ${step.id} has ${stepRisk.bucket} risk (autopilot requires low)`,
      };
    }

    // Check session environment (in strict mode)
    if (strictMode) {
      // Block if tamper protection is off
      if (sessionRisk.securityPosture.tamperProtection === false) {
        return {
          allowed: false,
          reason: 'Tamper protection is disabled - autopilot blocked',
        };
      }

      // Block if security domains are blocked
      if (sessionRisk.networkPosture.securityDomainsBlocked) {
        return {
          allowed: false,
          reason: 'Security domains blocked in hosts file - autopilot blocked',
        };
      }
    }
  }

  // Assisted lane - allow everything (user has approved)
  return { allowed: true };
}

/**
 * Execute a single step
 */
async function executeStep(
  step: PlanStep,
  ctx: ExecutionContext,
  registry: StepHandlerRegistry,
): Promise<StepResult> {
  const startTime = Date.now();

  // Lane enforcement check (defense in depth)
  const laneCheck = checkLaneEnforcement(step, ctx);
  if (!laneCheck.allowed) {
    ctx.record({
      type: 'step_error',
      stepId: step.id,
      error: `Lane violation: ${laneCheck.reason}`,
      timestamp: Date.now(),
    });

    return {
      stepId: step.id,
      action: step.action,
      target: step.target,
      status: 'failed',
      message: `Lane violation: ${laneCheck.reason}`,
      error: laneCheck.reason,
      before: {},
      after: {},
      durationMs: Date.now() - startTime,
    };
  }

  // Get handler for this action
  const handler = registry.get(step.action);
  if (!handler) {
    ctx.record({
      type: 'step_error',
      stepId: step.id,
      error: `No handler for action: ${step.action}`,
      timestamp: Date.now(),
    });

    return {
      stepId: step.id,
      action: step.action,
      target: step.target,
      status: 'failed',
      message: `No handler for action: ${step.action}`,
      before: {},
      after: {},
      durationMs: Date.now() - startTime,
    };
  }

  // Record step start
  ctx.record({
    type: 'step_start',
    stepId: step.id,
    action: step.action,
    target: step.target,
    timestamp: Date.now(),
  });

  try {
    // 1. Precheck
    const precheck = await handler.precheck(step, ctx);

    if (!precheck.canExecute) {
      ctx.record({
        type: 'step_skipped',
        stepId: step.id,
        reason: precheck.reason || 'Precheck failed',
        timestamp: Date.now(),
      });

      return {
        stepId: step.id,
        action: step.action,
        target: step.target,
        status: 'skipped',
        message: precheck.reason || 'Precheck failed',
        before: {},
        after: {},
        durationMs: Date.now() - startTime,
      };
    }

    // Check if admin is required but not available
    if (precheck.requiresAdmin && !ctx.elevated) {
      ctx.record({
        type: 'step_skipped',
        stepId: step.id,
        reason: 'Admin privileges required but not available',
        timestamp: Date.now(),
      });

      return {
        stepId: step.id,
        action: step.action,
        target: step.target,
        status: 'skipped',
        message: 'Admin privileges required but not available',
        before: {},
        after: {},
        durationMs: Date.now() - startTime,
      };
    }

    // 2. Capture before state
    const before = await handler.captureBefore(step, ctx);

    ctx.record({
      type: 'step_progress',
      stepId: step.id,
      message: 'Captured before state',
      data: { before },
      timestamp: Date.now(),
    });

    // 3. Dry run - stop here and return preview
    if (ctx.dryRun) {
      ctx.record({
        type: 'step_dryrun',
        stepId: step.id,
        action: step.action,
        target: step.target,
        wouldExecute: true,
        before,
        timestamp: Date.now(),
      });

      return {
        stepId: step.id,
        action: step.action,
        target: step.target,
        status: 'dryrun',
        message: 'Dry run - would execute',
        before,
        after: {},
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Create backup
    const backup = await handler.backup(step, ctx);

    if (backup) {
      ctx.record({
        type: 'step_progress',
        stepId: step.id,
        message: 'Created backup',
        data: { backupType: backup.type },
        timestamp: Date.now(),
      });
    }

    // 5. Execute
    await handler.execute(step, ctx);

    // 6. Capture after state
    const after = await handler.captureAfter(step, ctx);

    ctx.record({
      type: 'step_progress',
      stepId: step.id,
      message: 'Captured after state',
      data: { after },
      timestamp: Date.now(),
    });

    // 7. Verify
    let verified = true;
    if (ctx.options.verifySteps) {
      verified = await handler.verify(step, before, after, ctx);

      ctx.record({
        type: 'step_verified',
        stepId: step.id,
        verified,
        timestamp: Date.now(),
      });
    }

    // 8. Record completion
    const status = verified ? 'success' : 'failed';
    const message = verified
      ? `Successfully executed ${step.action} on ${step.target}`
      : `Verification failed for ${step.action} on ${step.target}`;

    ctx.record({
      type: 'step_complete',
      stepId: step.id,
      status,
      before,
      after,
      verified,
      timestamp: Date.now(),
    });

    return {
      stepId: step.id,
      action: step.action,
      target: step.target,
      status,
      message,
      before,
      after,
      backup: backup || undefined,
      verified,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    ctx.record({
      type: 'step_error',
      stepId: step.id,
      error: errorMessage,
      timestamp: Date.now(),
    });

    return {
      stepId: step.id,
      action: step.action,
      target: step.target,
      status: 'failed',
      message: errorMessage,
      error: errorMessage,
      before: {},
      after: {},
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Create a StepEngine for dry-run only (no real operations)
 */
export function createDryRunEngine(config: StepEngineConfig): StepEngine {
  const engine = createStepEngine(config);

  return {
    async execute(plan: Plan): Promise<ExecutionResult> {
      return engine.execute(plan, true, false);
    },

    async executeStep(
      step: PlanStep,
      plan: Plan,
    ): Promise<StepResult> {
      return engine.executeStep(step, plan, true, false);
    },

    getHandlerRegistry() {
      return engine.getHandlerRegistry();
    },
  };
}
