/**
 * Session Integration Tests
 *
 * End-to-end tests for the session orchestrator using mock dependencies.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Plan, ProductDefinition, Snapshot } from '../../src/shared/types';
import type { Scanner } from '../../src/main/core/scanning/types';
import type { Correlator } from '../../src/main/core/correlation/types';
import type { PlanBuilder } from '../../src/main/core/planning/types';
import type { StepEngine, ExecutionResult } from '../../src/main/core/execution/types';
import type { Verifier, VerificationResult } from '../../src/main/core/verification/types';
import {
  createTestSessionOrchestrator,
  type SessionEvent,
} from '../../src/main/core/session';
import { validateReport } from '../../src/main/core/session/report-schema';

// Test fixtures
function createZoomProduct(): ProductDefinition {
  return {
    id: 'zoom',
    name: 'Zoom',
    vendor: 'Zoom Video Communications',
    installPaths: [
      'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
      'C:\\Program Files\\Zoom',
    ],
    registryKeys: [
      'HKCU\\SOFTWARE\\Zoom',
      'HKLM\\SOFTWARE\\Zoom',
    ],
    processNames: ['Zoom.exe', 'ZoomWebHost.exe'],
    serviceNames: ['ZoomCptService'],
    taskPaths: ['\\Zoom\\'],
  };
}

function createPreSnapshot(): Snapshot {
  return {
    id: 'pre-snapshot-001',
    productId: 'zoom',
    capturedAt: Date.now(),
    filesystem: {
      files: [
        {
          path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
          exists: true,
          isDirectory: true,
          size: 150 * 1024 * 1024,
        },
        {
          path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\Zoom.exe',
          exists: true,
          isDirectory: false,
          size: 10 * 1024 * 1024,
        },
        {
          path: 'C:\\Program Files\\Zoom',
          exists: true,
          isDirectory: true,
          size: 100 * 1024 * 1024,
        },
      ],
      scanDuration: 500,
    },
    registry: {
      keys: [
        {
          path: 'HKCU\\SOFTWARE\\Zoom',
          exists: true,
          values: { Version: { type: 'REG_SZ', data: '5.17.0' } },
          subkeys: [],
        },
        {
          path: 'HKLM\\SOFTWARE\\Zoom',
          exists: true,
          values: {},
          subkeys: [],
        },
      ],
      scanDuration: 200,
    },
    processes: {
      running: [
        {
          pid: 1000,
          name: 'Zoom.exe',
          executablePath: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom\\Zoom.exe',
        },
      ],
      scanDuration: 50,
    },
    services: {
      installed: [
        {
          name: 'ZoomCptService',
          displayName: 'Zoom Sharing Service',
          state: 'Running',
          startType: 'Automatic',
          binaryPath: '"C:\\Program Files\\Zoom\\ZoomCptService.exe"',
        },
      ],
      scanDuration: 50,
    },
    tasks: {
      scheduled: [
        {
          name: 'ZoomUpdateTaskUserS-1-5-21',
          path: '\\Zoom\\ZoomUpdateTaskUserS-1-5-21',
          enabled: true,
          state: 'Ready',
        },
      ],
      scanDuration: 50,
    },
  };
}

function createPostSnapshot(): Snapshot {
  return {
    id: 'post-snapshot-001',
    productId: 'zoom',
    capturedAt: Date.now(),
    filesystem: {
      files: [], // All removed
      scanDuration: 100,
    },
    registry: {
      keys: [], // All removed
      scanDuration: 50,
    },
    processes: {
      running: [], // All terminated
      scanDuration: 10,
    },
    services: {
      installed: [], // All stopped/removed
      scanDuration: 10,
    },
    tasks: {
      scheduled: [], // All deleted
      scanDuration: 10,
    },
  };
}

function createPlan(): Plan {
  return {
    id: 'zoom-plan-001',
    productId: 'zoom',
    createdAt: Date.now(),
    boundaries: {
      allowedPaths: [
        'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
        'C:\\Program Files\\Zoom',
      ],
      allowedRegistryPrefixes: [
        'HKCU\\SOFTWARE\\Zoom',
        'HKLM\\SOFTWARE\\Zoom',
      ],
      allowedTasks: ['\\Zoom\\'],
    },
    steps: [
      { id: 'step-1', action: 'StopProcess', target: 'Zoom.exe', reason: 'Running process' },
      { id: 'step-2', action: 'StopService', target: 'ZoomCptService', reason: 'Running service' },
      { id: 'step-3', action: 'DeleteScheduledTask', target: '\\Zoom\\ZoomUpdateTaskUserS-1-5-21', reason: 'Scheduled task' },
      { id: 'step-4', action: 'RemoveFolder', target: 'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom', reason: 'Install folder' },
      { id: 'step-5', action: 'RemoveFolder', target: 'C:\\Program Files\\Zoom', reason: 'Install folder' },
      { id: 'step-6', action: 'DeleteRegistryKey', target: 'HKCU\\SOFTWARE\\Zoom', reason: 'Registry key' },
      { id: 'step-7', action: 'DeleteRegistryKey', target: 'HKLM\\SOFTWARE\\Zoom', reason: 'Registry key' },
    ],
    metadata: {
      scanDuration: 500,
      correlatorVersion: '1.0.0',
    },
  };
}

function createSuccessfulExecution(): ExecutionResult {
  const plan = createPlan();
  return {
    planId: plan.id,
    success: true,
    stepResults: plan.steps.map(step => ({
      stepId: step.id,
      action: step.action,
      target: step.target,
      status: 'success',
      message: `Successfully executed ${step.action}`,
      before: { exists: true },
      after: { exists: false },
      durationMs: 50,
    })),
    events: [],
    startedAt: Date.now() - 500,
    completedAt: Date.now(),
    dryRun: false,
  };
}

function createPassingVerification(): VerificationResult {
  return {
    passed: true,
    results: [
      { invariantName: 'NoVendorProcesses', passed: true, severity: 'standard' },
      { invariantName: 'NoVendorServices', passed: true, severity: 'standard' },
      { invariantName: 'NoVendorTasks', passed: true, severity: 'standard' },
      { invariantName: 'PlanPromisesHeld', passed: true, severity: 'standard' },
      { invariantName: 'NoOutOfScopeDamage', passed: true, severity: 'critical' },
    ],
    diff: {
      added: [],
      removed: [
        'C:\\Users\\TestUser\\AppData\\Roaming\\Zoom',
        'C:\\Program Files\\Zoom',
        'HKCU\\SOFTWARE\\Zoom',
        'HKLM\\SOFTWARE\\Zoom',
      ],
      changed: [],
    },
  };
}

// Mock dependencies factory
function createMockDependencies(scenario: 'success' | 'partial_failure' | 'policy_breach' = 'success') {
  let scanCount = 0;

  const scanner: Scanner = {
    async scan(_product, _options) {
      scanCount++;
      if (scanCount === 1) {
        return createPreSnapshot();
      }
      return createPostSnapshot();
    },
  };

  const correlator: Correlator = {
    async correlate(snapshot, _product) {
      return {
        ...snapshot,
        relationships: [],
      };
    },
  };

  const planBuilder: PlanBuilder = {
    async build(_input) {
      return createPlan();
    },
  };

  let executionResult = createSuccessfulExecution();
  let verificationResult = createPassingVerification();

  if (scenario === 'partial_failure') {
    executionResult = {
      ...executionResult,
      success: false,
      stepResults: executionResult.stepResults.map((step, i) =>
        i === 3
          ? { ...step, status: 'failed', message: 'File locked by another process' }
          : step
      ),
    };
    verificationResult = {
      ...verificationResult,
      passed: false,
      results: verificationResult.results.map(r =>
        r.invariantName === 'PlanPromisesHeld'
          ? { ...r, passed: false, message: 'Step step-4 did not achieve intended effect' }
          : r
      ),
    };
  }

  if (scenario === 'policy_breach') {
    executionResult = {
      ...executionResult,
      success: false,
      stepResults: [
        {
          stepId: 'step-1',
          action: 'RemoveFolder',
          target: 'C:\\Windows\\System32\\config',
          status: 'skipped',
          message: 'Policy violation: Path outside allowed boundaries',
          before: {},
          after: {},
          durationMs: 5,
        },
      ],
    };
    verificationResult = {
      passed: true, // No actual damage occurred
      results: [
        { invariantName: 'NoOutOfScopeDamage', passed: true, severity: 'critical' },
      ],
      diff: { added: [], removed: [], changed: [] },
    };
  }

  const stepEngine: StepEngine = {
    async execute(_plan, _dryRun, _elevated) {
      return executionResult;
    },
    async executeStep(_step, _plan, _dryRun, _elevated) {
      return executionResult.stepResults[0];
    },
    getHandlerRegistry() {
      return new Map();
    },
  };

  const verifier: Verifier = {
    async verify(_input) {
      return verificationResult;
    },
  };

  return { scanner, correlator, planBuilder, stepEngine, verifier };
}

describe('Session Orchestrator Integration', () => {
  describe('Happy path - successful remediation', () => {
    it('should complete full remediation pipeline', async () => {
      const events: SessionEvent[] = [];
      const orchestrator = createTestSessionOrchestrator({
        ...createMockDependencies('success'),
        onEvent: e => events.push(e),
      });

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.sessionId).toBeTruthy();
      expect(output.preSnapshot).toBeDefined();
      expect(output.plan).toBeDefined();
      expect(output.execution).not.toBeNull();
      expect(output.postSnapshot).not.toBeNull();
      expect(output.verification).not.toBeNull();
      expect(output.report.status).toBe('pass');
    });

    it('should produce a valid report', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const validation = validateReport(output.report);
      expect(validation.valid).toBe(true);
    });

    it('should record all session events', async () => {
      const events: SessionEvent[] = [];
      const orchestrator = createTestSessionOrchestrator({
        ...createMockDependencies('success'),
        onEvent: e => events.push(e),
      });

      await orchestrator.clean(createZoomProduct(), {}, true);

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('session_start');
      expect(eventTypes).toContain('pre_scan_complete');
      expect(eventTypes).toContain('plan_build_complete');
      expect(eventTypes).toContain('execution_complete');
      expect(eventTypes).toContain('post_scan_complete');
      expect(eventTypes).toContain('verification_complete');
      expect(eventTypes).toContain('session_complete');
    });

    it('should include quarantine info in report', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(
        createZoomProduct(),
        { quarantineFiles: true },
        true
      );

      // The report should have quarantine advisory
      const quarantineAdvisory = output.report.advisories.find(
        a => a.code === 'QUARANTINE_ENABLED'
      );
      expect(quarantineAdvisory).toBeDefined();
    });

    it('should show diff counts in report', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.report.diff).not.toBeNull();
      expect(output.report.diff!.counts.foldersRemoved).toBeGreaterThan(0);
      expect(output.report.diff!.counts.registryKeysRemoved).toBeGreaterThan(0);
    });
  });

  describe('Audit mode', () => {
    it('should complete without execution', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.audit(createZoomProduct());

      expect(output.execution).toBeNull();
      expect(output.postSnapshot).toBeNull();
      expect(output.verification).toBeNull();
      expect(output.report.status).toBe('pass');
      expect(output.report.statusReason).toContain('Audit');
    });

    it('should still build a plan', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.audit(createZoomProduct());

      expect(output.plan).toBeDefined();
      expect(output.plan.steps.length).toBeGreaterThan(0);
    });
  });

  describe('Partial failure scenario', () => {
    it('should still produce post-snapshot on failure', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('partial_failure')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.postSnapshot).not.toBeNull();
    });

    it('should set report status to fail', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('partial_failure')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.report.status).toBe('fail');
    });

    it('should include failure advisories', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('partial_failure')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const failureAdvisory = output.report.advisories.find(
        a => a.code === 'STEP_FAILED'
      );
      expect(failureAdvisory).toBeDefined();
      expect(failureAdvisory!.severity).toBe('error');
    });

    it('should show which step failed in report', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('partial_failure')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const failedStep = output.report.execution?.stepResults.find(
        s => s.status === 'failed'
      );
      expect(failedStep).toBeDefined();
      expect(failedStep!.message).toContain('locked');
    });
  });

  describe('Policy breach simulation', () => {
    it('should block out-of-scope operations', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('policy_breach')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const skippedStep = output.report.execution?.stepResults.find(
        s => s.status === 'skipped'
      );
      expect(skippedStep).toBeDefined();
      expect(skippedStep!.message).toContain('Policy violation');
    });

    it('should report no out-of-scope damage', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('policy_breach')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const noScopeDamage = output.report.verification?.invariantResults.find(
        r => r.name === 'NoOutOfScopeDamage'
      );
      expect(noScopeDamage?.passed).toBe(true);
    });
  });

  describe('Dry run mode', () => {
    it('should not execute in dry run mode', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(
        createZoomProduct(),
        { dryRun: true },
        true
      );

      expect(output.report.session.dryRun).toBe(true);
      expect(output.report.status).toBe('pass');
    });

    it('should include dry run advisory', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(
        createZoomProduct(),
        { dryRun: true },
        true
      );

      const dryRunAdvisory = output.report.advisories.find(
        a => a.code === 'DRY_RUN'
      );
      expect(dryRunAdvisory).toBeDefined();
    });
  });

  describe('Session persistence', () => {
    it('should persist session data', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      const persistence = orchestrator.getPersistence();
      const loadedReport = await persistence.loadReport(output.sessionId);

      expect(loadedReport).not.toBeNull();
      expect(loadedReport!.reportId).toBe(output.report.reportId);
    });

    it('should be able to list sessions', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      await orchestrator.clean(createZoomProduct(), {}, true);
      await orchestrator.audit(createZoomProduct());

      const persistence = orchestrator.getPersistence();
      const sessions = await persistence.listSessions();

      expect(sessions.length).toBe(2);
    });
  });

  describe('Timing information', () => {
    it('should record all timing milestones', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.timing.startedAt).toBeLessThan(output.timing.preSnapshotAt);
      expect(output.timing.preSnapshotAt).toBeLessThan(output.timing.planBuiltAt);
      expect(output.timing.planBuiltAt).toBeLessThan(output.timing.executionStartedAt!);
      expect(output.timing.executionStartedAt!).toBeLessThan(output.timing.executionCompletedAt!);
      expect(output.timing.executionCompletedAt!).toBeLessThan(output.timing.postSnapshotAt!);
      expect(output.timing.postSnapshotAt!).toBeLessThan(output.timing.verificationAt!);
      expect(output.timing.verificationAt!).toBeLessThanOrEqual(output.timing.completedAt);
    });

    it('should include timing in report', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.report.timing).toBeDefined();
      expect(output.report.timing.startedAt).toBe(output.timing.startedAt);
      expect(output.report.timing.completedAt).toBe(output.timing.completedAt);
    });
  });

  describe('Report integrity', () => {
    it('should have valid content hash', async () => {
      const orchestrator = createTestSessionOrchestrator(
        createMockDependencies('success')
      );

      const output = await orchestrator.clean(createZoomProduct(), {}, true);

      expect(output.report.integrity.contentHash).toBeTruthy();
      expect(output.report.integrity.contentHash.length).toBe(64); // SHA-256 hex
    });
  });
});
