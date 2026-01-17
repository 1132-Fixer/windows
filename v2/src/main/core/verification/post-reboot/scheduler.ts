/**
 * Post-Reboot Verification Scheduler
 *
 * Creates Windows scheduled tasks to run verification after system reboot.
 * Uses schtasks.exe for task creation (works without PowerShell remoting).
 *
 * SAFETY INVARIANTS:
 * - Tasks are created in a dedicated folder (\\CleanStateSentinel\\)
 * - Tasks have an expiration date
 * - Tasks run with user privileges by default
 * - Task names are prefixed to prevent collisions
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import type { ProductDefinition } from '../../acquisition/types';
import type {
  PostRebootScheduler,
  PostRebootVerificationContext,
  ScheduleResult,
  ScheduleConfig,
  ExpectedAbsentArtifact,
} from './types';
import {
  DEFAULT_SCHEDULE_CONFIG,
  TASK_FOLDER,
  getTaskName,
} from './types';
import {
  createContextPersistence,
  type ContextPersistence,
} from './context-persistence';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique context ID
 */
function generateContextId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `${timestamp}_${random}`;
}

/**
 * Execute a command and return the output
 */
async function execCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: -1 });
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr, code: -1 });
    }, 30000);
  });
}

/**
 * Get the path to our startup verification runner executable
 */
function getRunnerPath(): string {
  // In development, this would be the electron executable
  // In production, this would be the packaged app
  if (process.env.NODE_ENV === 'development') {
    // Use node to run the verification script directly
    return process.execPath;
  }

  // Get the path to the main executable
  const appPath = process.env.PORTABLE_EXECUTABLE_FILE
    || process.env.APPIMAGE
    || process.execPath;

  return appPath;
}

/**
 * Get command line arguments for the runner
 */
function getRunnerArgs(contextId: string): string[] {
  if (process.env.NODE_ENV === 'development') {
    // In development, run the verification script directly
    return [
      path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'post-reboot-verify.js'),
      contextId,
    ];
  }

  // In production, pass the verify argument
  return ['--post-reboot-verify', contextId];
}

// ============================================================================
// Scheduler Implementation
// ============================================================================

/**
 * Create a post-reboot verification scheduler
 */
export function createPostRebootScheduler(
  persistence?: ContextPersistence,
): PostRebootScheduler {
  const contextStore = persistence ?? createContextPersistence();

  return {
    /**
     * Schedule verification for after next reboot
     */
    async schedule(
      sessionId: string,
      product: ProductDefinition,
      planId: string,
      expectedAbsent: ExpectedAbsentArtifact[],
      config?: Partial<ScheduleConfig>,
    ): Promise<ScheduleResult> {
      const fullConfig: ScheduleConfig = {
        ...DEFAULT_SCHEDULE_CONFIG,
        ...config,
      };

      const contextId = generateContextId();
      const taskName = getTaskName(contextId);

      try {
        // Calculate expiration
        const now = Date.now();
        const expiresAt = now + fullConfig.expirationDays * 24 * 60 * 60 * 1000;

        // Create context
        const context: PostRebootVerificationContext = {
          contextId,
          sessionId,
          product,
          planId,
          scheduledAt: now,
          preSnapshotId: `${sessionId}_pre`,
          postSnapshotId: `${sessionId}_post`,
          expectedAbsent,
          maxRetries: 3,
          retryCount: 0,
          expiresAt,
        };

        // Save context first (so we can clean up if task creation fails)
        await contextStore.saveContext(context);

        // Build the scheduled task
        const runnerPath = getRunnerPath();
        const runnerArgs = getRunnerArgs(contextId);
        const fullCommand = `"${runnerPath}" ${runnerArgs.map(a => `"${a}"`).join(' ')}`;

        // Build schtasks arguments
        const schtasksArgs = buildSchtasksArgs(
          taskName,
          fullCommand,
          fullConfig,
        );

        // Create the scheduled task
        const result = await execCommand('schtasks.exe', schtasksArgs);

        if (result.code !== 0) {
          // Task creation failed, clean up context
          await contextStore.deleteContext(contextId);

          return {
            success: false,
            contextId,
            taskName,
            scheduledFor: fullConfig.trigger,
            error: `Failed to create scheduled task: ${result.stderr || result.stdout}`,
          };
        }

        return {
          success: true,
          contextId,
          taskName,
          scheduledFor: fullConfig.trigger,
        };
      } catch (error) {
        // Clean up on error
        await contextStore.deleteContext(contextId);

        return {
          success: false,
          contextId,
          taskName,
          scheduledFor: fullConfig.trigger,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    /**
     * Cancel a scheduled verification
     */
    async cancel(contextId: string): Promise<boolean> {
      const taskName = getTaskName(contextId);

      try {
        // Delete the scheduled task
        const result = await execCommand('schtasks.exe', [
          '/Delete',
          '/TN', `${TASK_FOLDER}${taskName}`,
          '/F', // Force delete without confirmation
        ]);

        // Delete the context regardless of task deletion result
        await contextStore.deleteContext(contextId);
        await contextStore.deleteResult(contextId);

        // Task may not exist (already ran or was never created)
        return result.code === 0 || result.stderr.includes('does not exist');
      } catch {
        // Try to clean up context anyway
        await contextStore.deleteContext(contextId);
        return false;
      }
    },

    /**
     * Check if verification is scheduled
     */
    async isScheduled(contextId: string): Promise<boolean> {
      const context = await contextStore.loadContext(contextId);
      if (!context) return false;

      // Check if task exists
      const taskName = getTaskName(contextId);
      const result = await execCommand('schtasks.exe', [
        '/Query',
        '/TN', `${TASK_FOLDER}${taskName}`,
      ]);

      return result.code === 0;
    },

    /**
     * List all scheduled verifications
     */
    async listScheduled(): Promise<PostRebootVerificationContext[]> {
      return contextStore.listContexts();
    },

    /**
     * Get context by ID
     */
    async getContext(contextId: string): Promise<PostRebootVerificationContext | null> {
      return contextStore.loadContext(contextId);
    },

    /**
     * Clean up expired contexts and tasks
     */
    async cleanup(): Promise<{ removed: number }> {
      const contexts = await contextStore.listContexts();
      const now = Date.now();
      let removed = 0;

      for (const context of contexts) {
        if (context.expiresAt < now) {
          // Cancel the task and clean up context
          if (await this.cancel(context.contextId)) {
            removed++;
          }
        }
      }

      return { removed };
    },
  };
}

// ============================================================================
// schtasks.exe Argument Builder
// ============================================================================

/**
 * Build schtasks.exe arguments for creating the scheduled task
 */
function buildSchtasksArgs(
  taskName: string,
  command: string,
  config: ScheduleConfig,
): string[] {
  const args: string[] = [
    '/Create',
    '/TN', `${TASK_FOLDER}${taskName}`,
    '/TR', command,
    '/F', // Force overwrite if exists
  ];

  // Set trigger type
  switch (config.trigger) {
    case 'boot':
      args.push('/SC', 'ONSTART');
      break;

    case 'logon':
      args.push('/SC', 'ONLOGON');
      break;

    case 'delay_after_logon':
      args.push('/SC', 'ONLOGON');
      if (config.delaySeconds) {
        args.push('/DELAY', formatDelay(config.delaySeconds));
      }
      break;
  }

  // Set run level
  if (config.runElevated) {
    args.push('/RL', 'HIGHEST');
  } else {
    args.push('/RL', 'LIMITED');
  }

  // Set to run only once (task deletes itself after running)
  // We'll handle this in the runner by calling schtasks /Delete

  return args;
}

/**
 * Format delay for schtasks (MMMM:SS format)
 */
function formatDelay(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes.toString().padStart(4, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}
