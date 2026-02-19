/**
 * Report Schema (Zod)
 *
 * Validates attestation reports to ensure schema compliance.
 * This is the canonical schema - any changes require version bump.
 */

import { z } from 'zod';

/**
 * Environment info schema
 */
export const EnvironmentInfoSchema = z.object({
  osVersion: z.string(),
  arch: z.string(),
  elevated: z.boolean(),
  username: z.string(),
  hostname: z.string(),
  appVersion: z.string(),
  timestamp: z.number(),
});

/**
 * Diff summary schema
 */
export const DiffSummarySchema = z.object({
  counts: z.object({
    filesRemoved: z.number(),
    foldersRemoved: z.number(),
    registryKeysRemoved: z.number(),
    registryValuesRemoved: z.number(),
    processesTerminated: z.number(),
    servicesStopped: z.number(),
    tasksDeleted: z.number(),
  }),
  examples: z.object({
    filesRemoved: z.array(z.string()),
    foldersRemoved: z.array(z.string()),
    registryKeysRemoved: z.array(z.string()),
  }),
});

/**
 * Quarantine summary schema
 */
export const QuarantineSummarySchema = z.object({
  rootPath: z.string(),
  itemCount: z.number(),
  totalBytes: z.number(),
  manifests: z.array(z.object({
    stepId: z.string(),
    type: z.string(),
    description: z.string(),
  })),
  restoreFeasibility: z.enum(['full', 'partial', 'none']),
  restoreNotes: z.string(),
});

/**
 * Advisory schema
 */
export const AdvisorySchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
  stepId: z.string().optional(),
});

/**
 * Session timing schema
 */
export const SessionTimingSchema = z.object({
  startedAt: z.number(),
  preSnapshotAt: z.number(),
  planBuiltAt: z.number(),
  executionStartedAt: z.number().optional(),
  executionCompletedAt: z.number().optional(),
  postSnapshotAt: z.number().optional(),
  verificationAt: z.number().optional(),
  completedAt: z.number(),
});

/**
 * Snapshot summary schema
 */
export const SnapshotSummarySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  counts: z.object({
    files: z.number(),
    registryKeys: z.number(),
    processes: z.number(),
    services: z.number(),
    tasks: z.number(),
  }),
});

/**
 * Plan summary schema
 */
export const PlanSummarySchema = z.object({
  id: z.string(),
  stepCount: z.number(),
  boundaries: z.object({
    allowedPaths: z.array(z.string()),
    allowedRegistryPrefixes: z.array(z.string()),
    allowedTasks: z.array(z.string()),
  }),
});

/**
 * Execution summary schema
 */
export const ExecutionSummarySchema = z.object({
  success: z.boolean(),
  stepResults: z.array(z.object({
    stepId: z.string(),
    action: z.string(),
    target: z.string(),
    status: z.string(),
    message: z.string(),
    durationMs: z.number(),
  })),
  totalDurationMs: z.number(),
});

/**
 * Verification summary schema
 */
export const VerificationSummarySchema = z.object({
  passed: z.boolean(),
  invariantResults: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    severity: z.string(),
    message: z.string().optional(),
  })),
});

/**
 * Session options schema
 */
export const SessionOptionsSchema = z.object({
  includeAllUsers: z.boolean(),
  includeNetworkObserver: z.boolean(),
  dryRun: z.boolean(),
  preserveUserSettings: z.boolean(),
  continueOnFailure: z.boolean(),
  quarantineFiles: z.boolean(),
  verifySteps: z.boolean(),
  schedulePostRebootVerification: z.boolean().optional(), // v1.1.0+
});

/**
 * Integrity schema
 */
export const IntegritySchema = z.object({
  contentHash: z.string(),
  signature: z.string().optional(),
});

// ============================================================================
// Risk Assessment Schemas (v1.1.0)
// ============================================================================

/**
 * Security posture schema
 */
export const SecurityPostureSchema = z.object({
  defenderActive: z.boolean(),
  realTimeProtection: z.boolean(),
  tamperProtection: z.boolean().nullable(),
  suspiciousExclusions: z.number(),
  recentThreats: z.number(),
  overallStatus: z.enum(['healthy', 'degraded', 'compromised', 'unknown']),
  indicators: z.array(z.string()),
});

/**
 * Network posture schema
 */
export const NetworkPostureSchema = z.object({
  proxyConfigured: z.boolean(),
  suspiciousProxy: z.boolean(),
  hostsModified: z.boolean(),
  securityDomainsBlocked: z.boolean(),
  dnsHijacked: z.boolean(),
  indicators: z.array(z.string()),
});

/**
 * Session risk summary schema
 */
export const SessionRiskSummarySchema = z.object({
  score: z.number(),
  bucket: z.enum(['low', 'medium', 'high', 'critical']),
  securityPosture: SecurityPostureSchema,
  networkPosture: NetworkPostureSchema,
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
  safeForRemediation: z.boolean(),
});

/**
 * Plan risk summary schema
 */
export const PlanRiskSummarySchema = z.object({
  score: z.number(),
  bucket: z.enum(['low', 'medium', 'high', 'critical']),
  stepCounts: z.object({
    low: z.number(),
    medium: z.number(),
    high: z.number(),
    critical: z.number(),
  }),
  highRiskSteps: z.array(z.string()),
  criticalRiskSteps: z.array(z.string()),
  autopilotEligible: z.boolean(),
});

/**
 * Autopilot decision schema
 */
export const AutopilotDecisionSchema = z.object({
  eligible: z.boolean(),
  reasonCodes: z.array(z.string()),
  allowedSteps: z.array(z.string()),
  blockedSteps: z.array(z.string()),
  sessionBlockers: z.array(z.string()),
});

/**
 * Lane recommendation schema
 */
export const LaneRecommendationSchema = z.object({
  lane: z.enum(['autopilot', 'assisted', 'manual_only', 'blocked']),
  reason: z.string(),
  autopilotAvailable: z.boolean(),
  stepCounts: z.object({
    autopilot: z.number(),
    assisted: z.number(),
  }),
  bannerText: z.string(),
  bannerSeverity: z.enum(['success', 'warning', 'error', 'blocked']),
});

/**
 * Risk assessment schema (v1.1.0 addition)
 */
export const RiskAssessmentSchema = z.object({
  sessionRisk: SessionRiskSummarySchema,
  planRisk: PlanRiskSummarySchema.nullable(),
  combinedScore: z.number(),
  combinedBucket: z.enum(['low', 'medium', 'high', 'critical']),
  recommendation: z.enum(['autopilot', 'assisted', 'manual_only', 'abort']),
  recommendationReason: z.string(),
  autopilotDecision: AutopilotDecisionSchema.nullable(),
  laneRecommendation: LaneRecommendationSchema.nullable(),
});

/**
 * Post-reboot verification result schema
 */
export const PostRebootVerificationResultSchema = z.object({
  verdict: z.enum(['clean', 'clean_with_warnings', 'persistence_detected', 'verification_failed', 'expired']).nullable(),
  verifiedAt: z.number().nullable(),
  checksPassed: z.number(),
  checksFailed: z.number(),
  artifactsReappeared: z.boolean(),
  reappearedArtifactPaths: z.array(z.string()),
  summary: z.string(),
});

/**
 * Post-reboot verification summary schema (v1.1.0 addition)
 */
export const PostRebootVerificationSummarySchema = z.object({
  scheduled: z.boolean(),
  contextId: z.string().nullable(),
  scheduledFor: z.enum(['boot', 'logon', 'delay_after_logon']).nullable(),
  completed: z.boolean(),
  result: PostRebootVerificationResultSchema.nullable(),
  error: z.string().nullable(),
});

/**
 * Monitoring latest findings schema
 */
export const MonitoringLatestFindingsSchema = z.object({
  added: z.number(),
  removed: z.number(),
  modified: z.number(),
});

/**
 * Monitoring summary schema (v1.1.0 addition)
 */
export const MonitoringSummarySchema = z.object({
  enabled: z.boolean(),
  baselineTimestamp: z.number().nullable(),
  lastCheck: z.number().nullable(),
  cleanHours: z.number(),
  checksPerformed: z.number(),
  alertsGenerated: z.number(),
  latestFindings: MonitoringLatestFindingsSchema.nullable(),
  status: z.enum(['clean', 'changes_detected', 'not_monitored']),
});

// ============================================================================
// Full Report Schemas
// ============================================================================

/**
 * Full Attestation Report schema (v1.0.0) - for backwards compatibility
 */
export const AttestationReportSchemaV1_0_0 = z.object({
  schemaVersion: z.literal('1.0.0'),
  reportId: z.string(),
  sessionId: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  statusReason: z.string(),

  environment: EnvironmentInfoSchema,

  product: z.object({
    id: z.string(),
    name: z.string(),
    vendor: z.string(),
    definitionHash: z.string(),
  }),

  session: z.object({
    mode: z.enum(['audit', 'clean', 'uninstall']),
    options: SessionOptionsSchema,
    dryRun: z.boolean(),
  }),

  preSnapshot: SnapshotSummarySchema,
  plan: PlanSummarySchema,

  execution: ExecutionSummarySchema.nullable(),
  postSnapshot: SnapshotSummarySchema.nullable(),
  verification: VerificationSummarySchema.nullable(),

  diff: DiffSummarySchema.nullable(),
  quarantine: QuarantineSummarySchema.nullable(),

  advisories: z.array(AdvisorySchema),
  timing: SessionTimingSchema,
  integrity: IntegritySchema,
  redacted: z.boolean(),
});

/**
 * Full Attestation Report schema (v1.1.0) - with risk assessment
 */
export const AttestationReportSchemaV1_1_0 = z.object({
  schemaVersion: z.literal('1.1.0'),
  reportId: z.string(),
  sessionId: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  statusReason: z.string(),

  environment: EnvironmentInfoSchema,

  product: z.object({
    id: z.string(),
    name: z.string(),
    vendor: z.string(),
    definitionHash: z.string(),
  }),

  session: z.object({
    mode: z.enum(['audit', 'clean', 'uninstall']),
    options: SessionOptionsSchema,
    dryRun: z.boolean(),
    lane: z.enum(['autopilot', 'assisted']).optional(),
  }),

  preSnapshot: SnapshotSummarySchema,
  plan: PlanSummarySchema,

  execution: ExecutionSummarySchema.nullable(),
  postSnapshot: SnapshotSummarySchema.nullable(),
  verification: VerificationSummarySchema.nullable(),

  diff: DiffSummarySchema.nullable(),
  quarantine: QuarantineSummarySchema.nullable(),

  // New in v1.1.0
  risk: RiskAssessmentSchema.nullable(),
  postRebootVerification: PostRebootVerificationSummarySchema.nullable(),
  monitoring: MonitoringSummarySchema.nullable(),

  advisories: z.array(AdvisorySchema),
  timing: SessionTimingSchema,
  integrity: IntegritySchema,
  redacted: z.boolean(),
});

/**
 * Union schema that accepts both versions
 */
export const AttestationReportSchema = z.union([
  AttestationReportSchemaV1_1_0,
  AttestationReportSchemaV1_0_0,
]);

/**
 * Type inference from schema
 */
export type AttestationReportZod = z.infer<typeof AttestationReportSchema>;

/**
 * Validate a report against the schema
 */
export function validateReport(report: unknown): {
  valid: boolean;
  errors?: z.ZodError;
  report?: AttestationReportZod;
} {
  const result = AttestationReportSchema.safeParse(report);

  if (result.success) {
    return { valid: true, report: result.data };
  }

  return { valid: false, errors: result.error };
}

/**
 * Parse and validate a report, throwing on error
 */
export function parseReport(report: unknown): AttestationReportZod {
  return AttestationReportSchema.parse(report);
}
