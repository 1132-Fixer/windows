/**
 * Startup Verification Runner
 *
 * Runs on system startup/logon to verify that remediation persisted across reboot.
 * This is invoked by the scheduled task created by PostRebootScheduler.
 *
 * RESPONSIBILITIES:
 * - Load verification context from disk
 * - Re-scan the system for expected-absent artifacts
 * - Detect any artifacts that reappeared (persistence mechanisms)
 * - Store verification results
 * - Clean up the scheduled task after running
 *
 * SAFETY INVARIANTS:
 * - Read-only operations only (no remediation)
 * - Never throws to the caller (catches all errors)
 * - Always cleans up the scheduled task
 */

import { spawn } from 'child_process';
import type { Artifact, VerificationResult, VerificationCheck } from '../../../../shared/types';
import type {
  StartupVerificationRunner,
  PostRebootVerificationContext,
  PostRebootVerificationResult,
  PersistenceCheck,
  ReappearedArtifact,
  PostRebootVerdict,
  PersistenceCause,
} from './types';
import { TASK_FOLDER, getTaskName } from './types';
import {
  createContextPersistence,
  type ContextPersistence,
} from './context-persistence';
import { FileSystemScanner } from '../../acquisition/scanners/filesystem.scanner';
import { RegistryScanner } from '../../acquisition/scanners/registry.scanner';
import { ProcessScanner } from '../../acquisition/scanners/process.scanner';
import { ServiceScanner } from '../../acquisition/scanners/service.scanner';
import { TaskScanner } from '../../acquisition/scanners/task.scanner';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Delete the scheduled task after running
 */
async function deleteTask(contextId: string): Promise<void> {
  const taskName = getTaskName(contextId);

  return new Promise((resolve) => {
    const proc = spawn('schtasks.exe', [
      '/Delete',
      '/TN', `${TASK_FOLDER}${taskName}`,
      '/F',
    ], {
      windowsHide: true,
      shell: false,
    });

    proc.on('close', () => resolve());
    proc.on('error', () => resolve());

    // Timeout after 10 seconds
    setTimeout(() => {
      proc.kill();
      resolve();
    }, 10000);
  });
}

/**
 * Analyze why an artifact might have reappeared
 */
function analyzePersistenceCause(
  type: string,
  path: string,
): PersistenceCause {
  const pathLower = path.toLowerCase();

  // Check for common persistence mechanisms
  if (pathLower.includes('\\run\\') || pathLower.includes('\\runonce\\')) {
    return 'registry_autorun';
  }

  if (pathLower.includes('\\services\\')) {
    return 'service_auto_start';
  }

  if (type === 'task') {
    return 'scheduled_task';
  }

  if (pathLower.includes('\\drivers\\')) {
    return 'driver';
  }

  if (pathLower.includes('onedrive') || pathLower.includes('dropbox') || pathLower.includes('google drive')) {
    return 'cloud_sync';
  }

  return 'unknown';
}

// ============================================================================
// Startup Runner Implementation
// ============================================================================

/**
 * Create a startup verification runner
 */
export function createStartupVerificationRunner(
  persistence?: ContextPersistence,
): StartupVerificationRunner {
  const contextStore = persistence ?? createContextPersistence();

  // Scanners for re-checking
  const fileScanner = new FileSystemScanner();
  const registryScanner = new RegistryScanner();
  const processScanner = new ProcessScanner();
  const serviceScanner = new ServiceScanner();
  const taskScanner = new TaskScanner();

  /**
   * Check if a specific artifact exists
   */
  async function checkArtifactExists(
    type: 'file' | 'registry' | 'process' | 'service' | 'task',
    artifactPath: string,
    product: PostRebootVerificationContext['product'],
  ): Promise<{ exists: boolean; artifact?: Artifact }> {
    const scanContext = { product };

    try {
      switch (type) {
        case 'file': {
          const artifacts = await fileScanner.scan(scanContext);
          const found = artifacts.find(a =>
            a.path?.toLowerCase() === artifactPath.toLowerCase()
          );
          return { exists: !!found, artifact: found };
        }

        case 'registry': {
          const artifacts = await registryScanner.scan(scanContext);
          const found = artifacts.find(a =>
            a.path?.toLowerCase() === artifactPath.toLowerCase()
          );
          return { exists: !!found, artifact: found };
        }

        case 'process': {
          const artifacts = await processScanner.scan(scanContext);
          const found = artifacts.find(a =>
            (a.metadata as { imageName?: string })?.imageName?.toLowerCase() ===
            artifactPath.toLowerCase()
          );
          return { exists: !!found, artifact: found };
        }

        case 'service': {
          const artifacts = await serviceScanner.scan(scanContext);
          const found = artifacts.find(a =>
            (a.metadata as { name?: string })?.name?.toLowerCase() ===
            artifactPath.toLowerCase()
          );
          return { exists: !!found, artifact: found };
        }

        case 'task': {
          const artifacts = await taskScanner.scan(scanContext);
          const found = artifacts.find(a =>
            a.path?.toLowerCase() === artifactPath.toLowerCase()
          );
          return { exists: !!found, artifact: found };
        }

        default:
          return { exists: false };
      }
    } catch {
      // If we can't check, assume it doesn't exist (fail open for safety)
      return { exists: false };
    }
  }

  /**
   * Run verification for a single context
   */
  async function runVerification(
    context: PostRebootVerificationContext,
  ): Promise<PostRebootVerificationResult> {
    const now = Date.now();
    const persistenceChecks: PersistenceCheck[] = [];
    const reappearedArtifacts: ReappearedArtifact[] = [];
    const verificationChecks: VerificationCheck[] = [];

    // Check each expected-absent artifact
    for (const expected of context.expectedAbsent) {
      const { exists, artifact } = await checkArtifactExists(
        expected.type,
        expected.path,
        context.product,
      );

      const check: PersistenceCheck = {
        type: expected.type,
        path: expected.path,
        expectedState: 'absent',
        actualState: exists ? 'present' : 'absent',
        passed: !exists,
        details: exists
          ? `Artifact reappeared after reboot`
          : `Artifact remains absent`,
      };

      persistenceChecks.push(check);

      if (exists) {
        reappearedArtifacts.push({
          type: expected.type,
          path: expected.path,
          detectedAt: now,
          possibleCause: analyzePersistenceCause(expected.type, expected.path),
        });
      }

      // Add to verification checks
      verificationChecks.push({
        name: `post_reboot_${expected.type}_${expected.path.replace(/[^a-zA-Z0-9]/g, '_')}`.slice(0, 100),
        status: exists ? 'fail' : 'pass',
        details: check.details,
      });
    }

    // Determine overall status
    const artifactsReappeared = reappearedArtifacts.length > 0;
    const allPassed = persistenceChecks.every(c => c.passed);
    const someFailed = persistenceChecks.some(c => !c.passed);

    let verdict: PostRebootVerdict;
    if (allPassed) {
      verdict = 'clean';
    } else if (artifactsReappeared) {
      verdict = 'persistence_detected';
    } else {
      verdict = 'clean_with_warnings';
    }

    // Build verification result
    const verificationResult: VerificationResult = {
      status: allPassed ? 'pass' : someFailed ? 'fail' : 'warning',
      checks: verificationChecks,
      verifiedAt: now,
    };

    // Build summary
    const summary = buildSummary(
      persistenceChecks,
      reappearedArtifacts,
      verdict,
    );

    return {
      contextId: context.contextId,
      sessionId: context.sessionId,
      verifiedAt: now,
      result: verificationResult,
      persistenceChecks,
      artifactsReappeared,
      reappearedArtifacts,
      verdict,
      summary,
    };
  }

  /**
   * Build human-readable summary
   */
  function buildSummary(
    checks: PersistenceCheck[],
    reappeared: ReappearedArtifact[],
    verdict: PostRebootVerdict,
  ): string {
    const total = checks.length;
    const passed = checks.filter(c => c.passed).length;
    const failed = checks.filter(c => !c.passed).length;

    let summary = `Post-reboot verification: ${passed}/${total} checks passed.`;

    if (verdict === 'clean') {
      summary += ' System is clean - no artifacts reappeared.';
    } else if (verdict === 'persistence_detected') {
      summary += ` PERSISTENCE DETECTED: ${reappeared.length} artifact(s) reappeared after reboot.`;

      // Group by cause
      const causes = new Map<PersistenceCause, number>();
      for (const item of reappeared) {
        causes.set(item.possibleCause, (causes.get(item.possibleCause) || 0) + 1);
      }

      const causeDescriptions = Array.from(causes.entries())
        .map(([cause, count]) => `${count} via ${cause.replace(/_/g, ' ')}`)
        .join(', ');

      summary += ` Possible causes: ${causeDescriptions}.`;
    } else if (verdict === 'clean_with_warnings') {
      summary += ' Some warnings were generated but no critical issues found.';
    }

    return summary;
  }

  return {
    /**
     * Check if there are pending verifications to run
     */
    async hasPending(): Promise<boolean> {
      const pending = await contextStore.getPendingContexts();
      return pending.length > 0;
    },

    /**
     * Run all pending verifications
     */
    async runPending(): Promise<PostRebootVerificationResult[]> {
      const pending = await contextStore.getPendingContexts();
      const results: PostRebootVerificationResult[] = [];

      for (const context of pending) {
        try {
          const result = await this.runOne(context.contextId);
          results.push(result);
        } catch (error) {
          // Create a failed result
          const failedResult: PostRebootVerificationResult = {
            contextId: context.contextId,
            sessionId: context.sessionId,
            verifiedAt: Date.now(),
            result: {
              status: 'fail',
              checks: [{
                name: 'verification_error',
                status: 'fail',
                details: error instanceof Error ? error.message : String(error),
              }],
              verifiedAt: Date.now(),
            },
            persistenceChecks: [],
            artifactsReappeared: false,
            reappearedArtifacts: [],
            verdict: 'verification_failed',
            summary: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
          };

          results.push(failedResult);
          await contextStore.saveResult(failedResult);
        }
      }

      return results;
    },

    /**
     * Run a specific verification by context ID
     */
    async runOne(contextId: string): Promise<PostRebootVerificationResult> {
      // Load context
      const context = await contextStore.loadContext(contextId);
      if (!context) {
        throw new Error(`Verification context not found: ${contextId}`);
      }

      // Check if expired
      if (context.expiresAt < Date.now()) {
        const expiredResult: PostRebootVerificationResult = {
          contextId,
          sessionId: context.sessionId,
          verifiedAt: Date.now(),
          result: {
            status: 'warning',
            checks: [{
              name: 'context_expired',
              status: 'warning',
              details: 'Verification context expired before running',
            }],
            verifiedAt: Date.now(),
          },
          persistenceChecks: [],
          artifactsReappeared: false,
          reappearedArtifacts: [],
          verdict: 'expired',
          summary: 'Verification context expired before running.',
        };

        await contextStore.saveResult(expiredResult);
        await deleteTask(contextId);
        return expiredResult;
      }

      try {
        // Run the verification
        const result = await runVerification(context);

        // Save result
        await contextStore.saveResult(result);

        // Delete the scheduled task
        await deleteTask(contextId);

        return result;
      } catch (error) {
        // Increment retry count
        context.retryCount++;

        if (context.retryCount >= context.maxRetries) {
          // Max retries reached, fail permanently
          const failedResult: PostRebootVerificationResult = {
            contextId,
            sessionId: context.sessionId,
            verifiedAt: Date.now(),
            result: {
              status: 'fail',
              checks: [{
                name: 'max_retries_exceeded',
                status: 'fail',
                details: `Verification failed after ${context.maxRetries} attempts`,
              }],
              verifiedAt: Date.now(),
            },
            persistenceChecks: [],
            artifactsReappeared: false,
            reappearedArtifacts: [],
            verdict: 'verification_failed',
            summary: `Verification failed after ${context.maxRetries} attempts.`,
          };

          await contextStore.saveResult(failedResult);
          await deleteTask(contextId);
          return failedResult;
        }

        // Save updated context for retry
        await contextStore.saveContext(context);
        throw error;
      }
    },
  };
}

/**
 * Type for the startup verification runner
 */
export type StartupRunner = ReturnType<typeof createStartupVerificationRunner>;
