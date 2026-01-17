/**
 * Post-Reboot Verification Module
 *
 * Provides post-reboot verification scheduling and execution.
 *
 * USAGE:
 * ```typescript
 * import {
 *   createPostRebootScheduler,
 *   createStartupVerificationRunner,
 * } from './verification/post-reboot';
 *
 * // Schedule verification after reboot
 * const scheduler = createPostRebootScheduler();
 * const result = await scheduler.schedule(
 *   sessionId,
 *   product,
 *   planId,
 *   expectedAbsentArtifacts,
 * );
 *
 * // On startup, run pending verifications
 * const runner = createStartupVerificationRunner();
 * if (await runner.hasPending()) {
 *   const results = await runner.runPending();
 * }
 * ```
 */

// Types
export type {
  PostRebootVerificationContext,
  ExpectedAbsentArtifact,
  VerificationTrigger,
  ScheduleConfig,
  ScheduleResult,
  PostRebootVerificationResult,
  PersistenceCheck,
  ReappearedArtifact,
  PersistenceCause,
  PostRebootVerdict,
  PostRebootScheduler,
  StartupVerificationRunner,
} from './types';

export {
  DEFAULT_SCHEDULE_CONFIG,
  TASK_NAME_PREFIX,
  TASK_FOLDER,
  getTaskName,
  getContextIdFromTaskName,
} from './types';

// Context persistence
export {
  createContextPersistence,
  getDefaultStoragePath,
  type ContextPersistence,
  type ContextPersistenceConfig,
} from './context-persistence';

// Scheduler
export { createPostRebootScheduler } from './scheduler';

// Startup runner
export { createStartupVerificationRunner, type StartupRunner } from './startup-runner';
