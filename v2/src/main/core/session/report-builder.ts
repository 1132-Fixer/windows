/**
 * Report Builder
 *
 * Builds attestation reports from session data.
 * Produces deterministic, schema-compliant reports.
 */

import * as os from 'os';
import * as crypto from 'crypto';
import type { Plan, ProductDefinition, Snapshot } from '../../../shared/types';
import type { ExecutionResult, StepBackup } from '../execution/types';
import type { VerificationResult } from '../verification/types';
import type {
  AttestationReport,
  ReportStatus,
  SessionTiming,
  SessionOptions,
  SessionMode,
  EnvironmentInfo,
  DiffSummary,
  QuarantineSummary,
  Advisory,
  RiskAssessmentSummary,
  PostRebootVerificationSummary,
} from './types';
import { stableStringify, computeHash } from './persistence';

/**
 * App version (should come from package.json in production)
 */
const APP_VERSION = '2.0.0';

/**
 * Maximum number of examples to include in diff summary
 */
const MAX_DIFF_EXAMPLES = 10;

/**
 * Input for building a report
 */
export interface ReportBuilderInput {
  sessionId: string;
  product: ProductDefinition;
  mode: SessionMode;
  options: SessionOptions;
  preSnapshot: Snapshot;
  plan: Plan;
  execution: ExecutionResult | null;
  postSnapshot: Snapshot | null;
  verification: VerificationResult | null;
  timing: SessionTiming;
  elevated: boolean;
  backups?: StepBackup[];
  /** Risk assessment (v1.1.0+) */
  risk?: RiskAssessmentSummary | null;
  /** Post-reboot verification (v1.1.0+) */
  postRebootVerification?: PostRebootVerificationSummary | null;
  /** Execution lane (v1.1.0+) */
  lane?: 'autopilot' | 'assisted';
}

/**
 * Get environment information
 */
function getEnvironmentInfo(elevated: boolean): EnvironmentInfo {
  return {
    osVersion: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    elevated,
    username: os.userInfo().username,
    hostname: os.hostname(),
    appVersion: APP_VERSION,
    timestamp: Date.now(),
  };
}

/**
 * Compute product definition hash
 */
function computeProductHash(product: ProductDefinition): string {
  const content = stableStringify(product);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Count items in a snapshot
 */
function countSnapshotItems(snapshot: Snapshot): {
  files: number;
  registryKeys: number;
  processes: number;
  services: number;
  tasks: number;
} {
  return {
    files: snapshot.filesystem?.files?.length ?? 0,
    registryKeys: snapshot.registry?.keys?.length ?? 0,
    processes: snapshot.processes?.running?.length ?? 0,
    services: snapshot.services?.installed?.length ?? 0,
    tasks: snapshot.tasks?.scheduled?.length ?? 0,
  };
}

/**
 * Build diff summary between pre and post snapshots
 */
function buildDiffSummary(
  preSnapshot: Snapshot,
  postSnapshot: Snapshot | null
): DiffSummary | null {
  if (!postSnapshot) {
    return null;
  }

  // Get pre items
  const preFiles = new Set(preSnapshot.filesystem?.files?.map(f => f.path) ?? []);
  const preFolders = new Set(preSnapshot.filesystem?.files?.filter(f => f.isDirectory).map(f => f.path) ?? []);
  const preKeys = new Set(preSnapshot.registry?.keys?.map(k => k.path) ?? []);
  const preProcesses = new Set(preSnapshot.processes?.running?.map(p => p.name) ?? []);
  const preServices = new Set(preSnapshot.services?.installed?.map(s => s.name) ?? []);
  const preTasks = new Set(preSnapshot.tasks?.scheduled?.map(t => t.path) ?? []);

  // Get post items
  const postFiles = new Set(postSnapshot.filesystem?.files?.map(f => f.path) ?? []);
  const postFolders = new Set(postSnapshot.filesystem?.files?.filter(f => f.isDirectory).map(f => f.path) ?? []);
  const postKeys = new Set(postSnapshot.registry?.keys?.map(k => k.path) ?? []);
  const postProcesses = new Set(postSnapshot.processes?.running?.map(p => p.name) ?? []);
  const postServices = new Set(postSnapshot.services?.installed?.map(s => s.name) ?? []);
  const postTasks = new Set(postSnapshot.tasks?.scheduled?.map(t => t.path) ?? []);

  // Calculate removed items
  const filesRemoved = [...preFiles].filter(f => !postFiles.has(f));
  const foldersRemoved = [...preFolders].filter(f => !postFolders.has(f));
  const keysRemoved = [...preKeys].filter(k => !postKeys.has(k));
  const processesTerminated = [...preProcesses].filter(p => !postProcesses.has(p));
  const servicesStopped = [...preServices].filter(s => !postServices.has(s));
  const tasksDeleted = [...preTasks].filter(t => !postTasks.has(t));

  // Count registry values (simplified - count keys as having values)
  const registryValuesRemoved = keysRemoved.length; // Approximation

  return {
    counts: {
      filesRemoved: filesRemoved.length - foldersRemoved.length, // Files only
      foldersRemoved: foldersRemoved.length,
      registryKeysRemoved: keysRemoved.length,
      registryValuesRemoved,
      processesTerminated: processesTerminated.length,
      servicesStopped: servicesStopped.length,
      tasksDeleted: tasksDeleted.length,
    },
    examples: {
      filesRemoved: filesRemoved.slice(0, MAX_DIFF_EXAMPLES),
      foldersRemoved: foldersRemoved.slice(0, MAX_DIFF_EXAMPLES),
      registryKeysRemoved: keysRemoved.slice(0, MAX_DIFF_EXAMPLES),
    },
  };
}

/**
 * Build quarantine summary from backups
 */
function buildQuarantineSummary(
  execution: ExecutionResult | null,
  backups: StepBackup[]
): QuarantineSummary | null {
  if (!execution || backups.length === 0) {
    return null;
  }

  const folderBackups = backups.filter(b => b.type === 'folder-quarantine');
  if (folderBackups.length === 0) {
    return null;
  }

  // Get the root path from the first backup
  const firstBackup = folderBackups[0] as { quarantinePath?: string };
  const rootPath = firstBackup.quarantinePath
    ? firstBackup.quarantinePath.split(/[/\\]/).slice(0, -2).join('\\')
    : '%LOCALAPPDATA%\\1132-Remover\\quarantine';

  let totalBytes = 0;
  let itemCount = 0;

  const manifests = folderBackups.map(backup => {
    const fb = backup as {
      type: string;
      originalPath?: string;
      fileCount?: number;
      totalSize?: number;
    };

    itemCount += fb.fileCount ?? 1;
    totalBytes += fb.totalSize ?? 0;

    // Find corresponding step
    const stepResult = execution.stepResults.find(
      r => r.backup?.type === 'folder-quarantine'
    );

    return {
      stepId: stepResult?.stepId ?? 'unknown',
      type: 'folder-quarantine',
      description: fb.originalPath ?? 'Unknown path',
    };
  });

  return {
    rootPath,
    itemCount,
    totalBytes,
    manifests,
    restoreFeasibility: 'full',
    restoreNotes: 'All quarantined items can be restored by moving them back to their original locations.',
  };
}

/**
 * Generate advisories from session data
 */
function generateAdvisories(
  execution: ExecutionResult | null,
  verification: VerificationResult | null,
  options: SessionOptions
): Advisory[] {
  const advisories: Advisory[] = [];

  // Dry run advisory
  if (options.dryRun) {
    advisories.push({
      severity: 'info',
      code: 'DRY_RUN',
      message: 'This was a dry run. No actual changes were made to the system.',
    });
  }

  // Execution failures
  if (execution) {
    const failedSteps = execution.stepResults.filter(r => r.status === 'failed');
    for (const step of failedSteps) {
      advisories.push({
        severity: 'error',
        code: 'STEP_FAILED',
        message: `Step "${step.action}" on "${step.target}" failed: ${step.message}`,
        stepId: step.stepId,
      });
    }

    const skippedSteps = execution.stepResults.filter(r => r.status === 'skipped');
    if (skippedSteps.length > 0) {
      advisories.push({
        severity: 'warning',
        code: 'STEPS_SKIPPED',
        message: `${skippedSteps.length} step(s) were skipped. Check step details for reasons.`,
      });
    }
  }

  // Verification failures
  if (verification && !verification.passed) {
    const failedInvariants = verification.results.filter(r => !r.passed);
    for (const inv of failedInvariants) {
      advisories.push({
        severity: inv.severity === 'critical' ? 'error' : 'warning',
        code: `INVARIANT_${inv.invariantName.toUpperCase().replace(/\s+/g, '_')}`,
        message: inv.message || `Invariant "${inv.invariantName}" failed`,
      });
    }
  }

  // Quarantine advisory
  if (options.quarantineFiles) {
    advisories.push({
      severity: 'info',
      code: 'QUARANTINE_ENABLED',
      message: 'Files were moved to quarantine instead of being permanently deleted. They can be restored if needed.',
    });
  }

  return advisories;
}

/**
 * Determine overall report status
 */
function determineStatus(
  mode: SessionMode,
  execution: ExecutionResult | null,
  verification: VerificationResult | null,
  options: SessionOptions
): { status: ReportStatus; reason: string } {
  // Audit mode always passes (it's just observation)
  if (mode === 'audit') {
    return {
      status: 'pass',
      reason: 'Audit completed successfully',
    };
  }

  // Dry run
  if (options.dryRun) {
    return {
      status: 'pass',
      reason: 'Dry run completed - no changes made',
    };
  }

  // Check verification first (most authoritative)
  if (verification) {
    const criticalFailures = verification.results.filter(
      r => !r.passed && r.severity === 'critical'
    );

    if (criticalFailures.length > 0) {
      return {
        status: 'fail',
        reason: `Critical invariant violation: ${criticalFailures[0].invariantName}`,
      };
    }

    if (!verification.passed) {
      return {
        status: 'warn',
        reason: 'Verification completed with warnings',
      };
    }
  }

  // Check execution
  if (execution) {
    const failedSteps = execution.stepResults.filter(r => r.status === 'failed');

    if (failedSteps.length > 0) {
      return {
        status: 'fail',
        reason: `${failedSteps.length} step(s) failed during execution`,
      };
    }

    if (!execution.success) {
      return {
        status: 'fail',
        reason: 'Execution did not complete successfully',
      };
    }
  }

  return {
    status: 'pass',
    reason: 'Remediation completed successfully',
  };
}

/**
 * Build an attestation report
 */
export function buildReport(input: ReportBuilderInput): AttestationReport {
  const { status, reason } = determineStatus(
    input.mode,
    input.execution,
    input.verification,
    input.options
  );

  // Determine schema version based on input
  const hasV11Features = input.risk !== undefined || input.postRebootVerification !== undefined || input.lane !== undefined;
  const schemaVersion = hasV11Features ? '1.1.0' : '1.0.0';

  // Build the report without integrity hash first
  const reportWithoutHash: Omit<AttestationReport, 'integrity'> & { integrity: { contentHash: string } } = {
    schemaVersion,
    reportId: crypto.randomUUID(),
    sessionId: input.sessionId,
    status,
    statusReason: reason,

    environment: getEnvironmentInfo(input.elevated),

    product: {
      id: input.product.id,
      name: input.product.name,
      vendor: input.product.vendor,
      definitionHash: computeProductHash(input.product),
    },

    session: {
      mode: input.mode,
      options: input.options,
      dryRun: input.options.dryRun,
      ...(input.lane ? { lane: input.lane } : {}),
    },

    preSnapshot: {
      id: input.preSnapshot.id,
      timestamp: input.preSnapshot.capturedAt,
      counts: countSnapshotItems(input.preSnapshot),
    },

    plan: {
      id: input.plan.id,
      stepCount: input.plan.steps.length,
      boundaries: input.plan.boundaries,
    },

    execution: input.execution
      ? {
          success: input.execution.success,
          stepResults: input.execution.stepResults.map(r => ({
            stepId: r.stepId,
            action: r.action,
            target: r.target,
            status: r.status,
            message: r.message,
            durationMs: r.durationMs,
          })),
          totalDurationMs: input.execution.completedAt - input.execution.startedAt,
        }
      : null,

    postSnapshot: input.postSnapshot
      ? {
          id: input.postSnapshot.id,
          timestamp: input.postSnapshot.capturedAt,
          counts: countSnapshotItems(input.postSnapshot),
        }
      : null,

    verification: input.verification
      ? {
          passed: input.verification.passed,
          invariantResults: input.verification.results.map(r => ({
            name: r.invariantName,
            passed: r.passed,
            severity: r.severity,
            message: r.message,
          })),
        }
      : null,

    diff: buildDiffSummary(input.preSnapshot, input.postSnapshot),

    quarantine: buildQuarantineSummary(input.execution, input.backups ?? []),

    // v1.1.0 fields
    risk: input.risk ?? null,
    postRebootVerification: input.postRebootVerification ?? null,

    advisories: generateAdvisories(input.execution, input.verification, input.options),

    timing: input.timing,

    integrity: {
      contentHash: '', // Will be filled in
    },

    redacted: false,
  };

  // Compute content hash (excluding the integrity field itself)
  const contentForHash = { ...reportWithoutHash };
  delete (contentForHash as Record<string, unknown>).integrity;
  const contentHash = computeHash(stableStringify(contentForHash));

  // Return complete report
  return {
    ...reportWithoutHash,
    integrity: {
      contentHash,
    },
  };
}

/**
 * Validate report integrity
 */
export function validateReportIntegrity(report: AttestationReport): boolean {
  const contentForHash = { ...report };
  delete (contentForHash as Record<string, unknown>).integrity;
  const computedHash = computeHash(stableStringify(contentForHash));

  return computedHash === report.integrity.contentHash;
}
