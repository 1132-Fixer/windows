/**
 * Session Module Index
 *
 * Exports the session orchestrator and related types for
 * running complete remediation sessions.
 */

// Core types
export type {
  SessionMode,
  SessionOptions,
  RunSessionInput,
  RunSessionOutput,
  SessionTiming,
  EnvironmentInfo,
  DiffSummary,
  QuarantineSummary,
  Advisory,
  ReportStatus,
  ReportSchemaVersion,
  AttestationReport,
  SessionMetadata,
  RiskAssessmentSummary,
  PostRebootVerificationSummary,
  MonitoringReportSummary,
} from './types';

export { DEFAULT_SESSION_OPTIONS } from './types';

// Report schema (Zod)
export {
  AttestationReportSchema,
  AttestationReportSchemaV1_0_0,
  AttestationReportSchemaV1_1_0,
  PostRebootVerificationSummarySchema,
  RiskAssessmentSchema,
  MonitoringSummarySchema,
  validateReport,
  parseReport,
  type AttestationReportZod,
} from './report-schema';

// Redaction
export {
  redactReport,
  redactPath,
  redactUsername,
  redactHostname,
  redactSecrets,
  redactRegistryValue,
  checkReportSafety,
  createPublicSummary,
} from './redaction';

// Persistence
export {
  createPersistence,
  createInMemoryPersistence,
  stableStringify,
  computeHash,
  DEFAULT_PERSISTENCE_CONFIG,
  type PersistenceConfig,
} from './persistence';

// Report builder
export {
  buildReport,
  validateReportIntegrity,
  type ReportBuilderInput,
} from './report-builder';

// Session orchestrator
export {
  createSessionOrchestrator,
  createTestSessionOrchestrator,
  type SessionDependencies,
  type SessionEvent,
  type SessionEventHandler,
} from './run-session';
