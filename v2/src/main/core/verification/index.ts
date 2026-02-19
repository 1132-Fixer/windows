/**
 * Verification Module
 *
 * Independent proof engine for remediation verification.
 *
 * USAGE:
 * ```typescript
 * import {
 *   createVerifier,
 *   createPostRebootScheduler,
 *   createStartupVerificationRunner,
 * } from './verification';
 *
 * // Immediate verification
 * const verifier = createVerifier();
 * const result = await verifier.verify({
 *   product,
 *   plan,
 *   preSnapshot,
 *   postSnapshot,
 * });
 *
 * // Schedule post-reboot verification
 * const scheduler = createPostRebootScheduler();
 * await scheduler.schedule(sessionId, product, planId, expectedAbsent);
 *
 * // On startup
 * const runner = createStartupVerificationRunner();
 * if (await runner.hasPending()) {
 *   await runner.runPending();
 * }
 * ```
 */

// Core verifier
export {
  DefaultVerifier,
  createVerifier,
  createStrictVerifier,
  createComprehensiveVerifier,
  type VerifierOptions,
} from './verifier';

// Types
export type {
  Verifier,
  VerifyInput,
  Invariant,
  InvariantSeverity,
  InvariantCategory,
  InvariantResult,
  PostRebootVerifier,
  ScheduleResult as LegacyScheduleResult,
  VerificationReport,
  VerificationRecommendation,
} from './types';

export {
  INVARIANTS,
  MODE_INVARIANTS,
  buildVerificationResult,
} from './types';

// Diff utility
export { diffSnapshots } from './diff';

// Invariants
export {
  DEFAULT_INVARIANTS,
  NoVendorProcessesInvariant,
  NoVendorServicesInvariant,
  NoVendorTasksInvariant,
  NoOrphanedReferencesInvariant,
  PlanPromisesHeldInvariant,
  NoOutOfScopeDamageInvariant,
  getInvariantsBySeverity,
  getInvariantsByCategory,
  getInvariantById,
} from './invariants';

// Post-reboot verification
export {
  createPostRebootScheduler,
  createStartupVerificationRunner,
  createContextPersistence,
  getDefaultStoragePath,
  DEFAULT_SCHEDULE_CONFIG,
  TASK_NAME_PREFIX,
  TASK_FOLDER,
  getTaskName,
  getContextIdFromTaskName,
  type PostRebootVerificationContext,
  type ExpectedAbsentArtifact,
  type VerificationTrigger,
  type ScheduleConfig,
  type ScheduleResult,
  type PostRebootVerificationResult,
  type PersistenceCheck,
  type ReappearedArtifact,
  type PersistenceCause,
  type PostRebootVerdict,
  type PostRebootScheduler,
  type StartupVerificationRunner,
  type ContextPersistence,
  type StartupRunner,
} from './post-reboot';
