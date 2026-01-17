/**
 * Run Session Orchestrator
 *
 * Coordinates the full remediation pipeline:
 * Acquire(pre) → Correlate → Plan → Execute → Acquire(post) → Correlate → Verify → Report
 *
 * This is the main entry point for remediation operations.
 */

import * as crypto from 'crypto';
import type { ProductDefinition, Snapshot } from '../../../shared/types';
import type { Scanner } from '../scanning/types';
import type { Correlator } from '../correlation/types';
import type { PlanBuilder } from '../planning/types';
import type { StepEngine } from '../execution/types';
import type { Verifier } from '../verification/types';
import type {
  RunSessionInput,
  RunSessionOutput,
  SessionOptions,
  SessionTiming,
} from './types';
import { DEFAULT_SESSION_OPTIONS } from './types';
import { buildReport } from './report-builder';
import { createPersistence, createInMemoryPersistence } from './persistence';

/**
 * Session event for progress tracking
 */
export interface SessionEvent {
  type:
    | 'session_start'
    | 'pre_scan_start'
    | 'pre_scan_complete'
    | 'correlation_start'
    | 'correlation_complete'
    | 'plan_build_start'
    | 'plan_build_complete'
    | 'execution_start'
    | 'execution_progress'
    | 'execution_complete'
    | 'post_scan_start'
    | 'post_scan_complete'
    | 'verification_start'
    | 'verification_complete'
    | 'report_build_start'
    | 'report_build_complete'
    | 'session_complete'
    | 'session_error';
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Event handler for session progress
 */
export type SessionEventHandler = (event: SessionEvent) => void;

/**
 * Dependencies for the session orchestrator
 */
export interface SessionDependencies {
  /**
   * Scanner for acquiring snapshots
   */
  scanner: Scanner;

  /**
   * Correlator for building relationship graphs
   */
  correlator: Correlator;

  /**
   * Plan builder for creating remediation plans
   */
  planBuilder: PlanBuilder;

  /**
   * Step engine for executing plans
   */
  stepEngine: StepEngine;

  /**
   * Verifier for checking invariants
   */
  verifier: Verifier;

  /**
   * Optional event handler for progress tracking
   */
  onEvent?: SessionEventHandler;

  /**
   * Optional persistence layer (defaults to file-based)
   */
  persistence?: ReturnType<typeof createPersistence>;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `session-${timestamp}-${random}`;
}

/**
 * Create a session orchestrator
 */
export function createSessionOrchestrator(deps: SessionDependencies) {
  const {
    scanner,
    correlator,
    planBuilder,
    stepEngine,
    verifier,
    onEvent,
    persistence = createPersistence(),
  } = deps;

  /**
   * Emit an event
   */
  function emit(
    type: SessionEvent['type'],
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (onEvent) {
      onEvent({
        type,
        timestamp: Date.now(),
        message,
        data,
      });
    }
  }

  return {
    /**
     * Run a complete remediation session
     */
    async run(input: RunSessionInput): Promise<RunSessionOutput> {
      const sessionId = generateSessionId();
      const options: SessionOptions = {
        ...DEFAULT_SESSION_OPTIONS,
        ...input.options,
      };

      const timing: SessionTiming = {
        startedAt: Date.now(),
        preSnapshotAt: 0,
        planBuiltAt: 0,
        completedAt: 0,
      };

      emit('session_start', `Starting ${input.mode} session for ${input.product.name}`, {
        sessionId,
        mode: input.mode,
        productId: input.product.id,
      });

      try {
        // Phase 1: Acquire pre-snapshot
        emit('pre_scan_start', 'Acquiring pre-remediation snapshot');
        const preSnapshot = await scanner.scan(input.product, {
          includeAllUsers: options.includeAllUsers,
        });
        timing.preSnapshotAt = Date.now();
        emit('pre_scan_complete', 'Pre-snapshot acquired', {
          snapshotId: preSnapshot.id,
          fileCount: preSnapshot.filesystem?.files?.length ?? 0,
        });

        // Phase 2: Correlate pre-snapshot
        emit('correlation_start', 'Building relationship graph');
        const correlatedPre = await correlator.correlate(preSnapshot, input.product);
        emit('correlation_complete', 'Correlation complete', {
          relationshipCount: correlatedPre.relationships?.length ?? 0,
        });

        // Phase 3: Build plan
        emit('plan_build_start', 'Building remediation plan');
        const plan = await planBuilder.build({
          product: input.product,
          snapshot: correlatedPre,
          mode: input.mode,
          options: {
            preserveUserSettings: options.preserveUserSettings,
          },
        });
        timing.planBuiltAt = Date.now();
        emit('plan_build_complete', 'Plan built', {
          planId: plan.id,
          stepCount: plan.steps.length,
        });

        // Phase 4: Execute (if not audit mode)
        let execution = null;
        let postSnapshot: Snapshot | null = null;
        let verification = null;

        if (input.mode !== 'audit') {
          emit('execution_start', 'Starting plan execution');
          timing.executionStartedAt = Date.now();

          execution = await stepEngine.execute(
            plan,
            options.dryRun,
            input.elevated
          );

          timing.executionCompletedAt = Date.now();
          emit('execution_complete', 'Execution complete', {
            success: execution.success,
            stepsExecuted: execution.stepResults.length,
          });

          // Phase 5: Acquire post-snapshot (always, for evidence)
          emit('post_scan_start', 'Acquiring post-remediation snapshot');
          postSnapshot = await scanner.scan(input.product, {
            includeAllUsers: options.includeAllUsers,
          });
          timing.postSnapshotAt = Date.now();
          emit('post_scan_complete', 'Post-snapshot acquired', {
            snapshotId: postSnapshot.id,
          });

          // Phase 6: Correlate post-snapshot
          const correlatedPost = await correlator.correlate(postSnapshot, input.product);

          // Phase 7: Verify
          emit('verification_start', 'Verifying remediation');
          verification = await verifier.verify({
            product: input.product,
            plan,
            preSnapshot: correlatedPre,
            postSnapshot: correlatedPost,
          });
          timing.verificationAt = Date.now();
          emit('verification_complete', 'Verification complete', {
            passed: verification.passed,
          });
        }

        // Phase 8: Build report
        emit('report_build_start', 'Building attestation report');

        // Collect backups from execution
        const backups = execution?.stepResults
          .filter(r => r.backup)
          .map(r => r.backup!) ?? [];

        const report = buildReport({
          sessionId,
          product: input.product,
          mode: input.mode,
          options,
          preSnapshot: correlatedPre,
          plan,
          execution,
          postSnapshot,
          verification,
          timing: { ...timing, completedAt: Date.now() },
          elevated: input.elevated,
          backups,
        });

        timing.completedAt = Date.now();
        emit('report_build_complete', 'Report built', {
          reportId: report.reportId,
          status: report.status,
        });

        // Build output
        const output: RunSessionOutput = {
          sessionId,
          preSnapshot: correlatedPre,
          plan,
          execution,
          postSnapshot,
          verification,
          report,
          timing,
        };

        // Persist session
        await persistence.saveSession(output);

        emit('session_complete', `Session completed with status: ${report.status}`, {
          sessionId,
          status: report.status,
          durationMs: timing.completedAt - timing.startedAt,
        });

        return output;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        emit('session_error', `Session failed: ${errorMessage}`, {
          sessionId,
          error: errorMessage,
        });

        throw error;
      }
    },

    /**
     * Run audit mode (snapshot + plan only, no execution)
     */
    async audit(product: ProductDefinition): Promise<RunSessionOutput> {
      return this.run({
        product,
        mode: 'audit',
        options: {},
        elevated: false,
      });
    },

    /**
     * Run clean mode (preserve user settings)
     */
    async clean(
      product: ProductDefinition,
      options: Partial<SessionOptions> = {},
      elevated: boolean = false
    ): Promise<RunSessionOutput> {
      return this.run({
        product,
        mode: 'clean',
        options: {
          ...options,
          preserveUserSettings: true,
        },
        elevated,
      });
    },

    /**
     * Run uninstall mode (complete removal)
     */
    async uninstall(
      product: ProductDefinition,
      options: Partial<SessionOptions> = {},
      elevated: boolean = false
    ): Promise<RunSessionOutput> {
      return this.run({
        product,
        mode: 'uninstall',
        options: {
          ...options,
          preserveUserSettings: false,
        },
        elevated,
      });
    },

    /**
     * Get the persistence layer
     */
    getPersistence() {
      return persistence;
    },
  };
}

/**
 * Create a session orchestrator for testing (uses in-memory persistence)
 */
export function createTestSessionOrchestrator(
  deps: Omit<SessionDependencies, 'persistence'>
): ReturnType<typeof createSessionOrchestrator> {
  return createSessionOrchestrator({
    ...deps,
    persistence: createInMemoryPersistence(),
  });
}
