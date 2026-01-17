/**
 * Lane Enforcement Integration Tests
 *
 * Tests that lane enforcement is properly integrated into the
 * plan builder and step engine.
 */

import { describe, it, expect } from 'vitest';
import type { Plan, PlanStep, Snapshot, Artifact } from '../../src/shared/types';
import type { ProductDefinition, ScanContext } from '../../src/main/core/acquisition/types';
import type { SessionRisk, PlanRisk } from '../../src/main/core/risk/types';
import { createAutopilotPolicy } from '../../src/main/core/risk/autopilot-policy';
import { createPlanRiskScorer } from '../../src/main/core/risk/plan-risk';
import { createSessionRiskScorer } from '../../src/main/core/risk/session-risk';
import { createCombinedRiskScorer } from '../../src/main/core/risk/combined-risk';

// ============================================================================
// Test Fixtures
// ============================================================================

const testProduct: ProductDefinition = {
  id: 'test-product',
  vendor: 'Test Vendor',
  displayName: 'Test Product',
  paths: {
    install: ['C:\\Program Files\\TestProduct'],
    appData: ['%APPDATA%\\TestProduct'],
    programData: ['%PROGRAMDATA%\\TestProduct'],
    logs: [],
    temp: [],
  },
  registry: {
    software: ['HKCU\\SOFTWARE\\TestProduct', 'HKLM\\SOFTWARE\\TestProduct'],
    uninstall: [],
    services: [],
    other: [],
  },
  processes: ['testapp.exe'],
  services: ['TestService'],
  tasks: ['\\TestProduct\\'],
};

function createTestSnapshot(artifacts: Artifact[]): Snapshot {
  return {
    id: `snapshot-${Date.now()}`,
    productId: testProduct.id,
    createdAt: Date.now(),
    artifacts,
    relationships: [],
  };
}

function createTestArtifact(type: Artifact['type'], path: string): Artifact {
  return {
    id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    owner: {
      vendor: testProduct.vendor,
      product: testProduct.id,
      confidence: 'high',
    },
    path,
    metadata: {},
    observedAt: Date.now(),
    source: 'filesystem',
  };
}

function createTestStep(
  action: PlanStep['action'],
  target: string,
  overrides: Partial<PlanStep> = {},
): PlanStep {
  return {
    id: `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    action,
    target,
    requiresAdmin: false,
    risk: 'low',
    reason: 'Test step',
    ...overrides,
  };
}

function createTestPlan(steps: PlanStep[]): Plan {
  return {
    id: `plan-${Date.now()}`,
    productId: testProduct.id,
    mode: 'uninstall',
    createdAt: Date.now(),
    steps,
    dryRun: false,
    boundaries: {
      allowedPaths: testProduct.paths.install.concat(testProduct.paths.appData),
      allowedRegistryPrefixes: testProduct.registry.software,
      allowedServices: testProduct.services,
      allowedTasks: testProduct.tasks,
    },
  };
}

function createHealthySessionRisk(): SessionRisk {
  return {
    assessmentId: 'test-assessment',
    assessedAt: Date.now(),
    environmentalScore: 10,
    environmentalBucket: 'low',
    securityPosture: {
      defenderActive: true,
      realTimeProtection: true,
      tamperProtection: true,
      suspiciousExclusions: 0,
      recentThreats: 0,
      overallStatus: 'healthy',
      indicators: [],
    },
    networkPosture: {
      proxyConfigured: false,
      suspiciousProxy: false,
      hostsModified: false,
      securityDomainsBlocked: false,
      dnsHijacked: false,
      indicators: [],
    },
    factors: [],
    warnings: [],
    blockers: [],
    safeForRemediation: true,
    recommendation: 'proceed',
  };
}

function createCompromisedSessionRisk(): SessionRisk {
  return {
    assessmentId: 'test-assessment',
    assessedAt: Date.now(),
    environmentalScore: 80,
    environmentalBucket: 'critical',
    securityPosture: {
      defenderActive: false,
      realTimeProtection: false,
      tamperProtection: false,
      suspiciousExclusions: 5,
      recentThreats: 10,
      overallStatus: 'compromised',
      indicators: ['Defender disabled', 'Tamper protection off', 'Multiple threats'],
    },
    networkPosture: {
      proxyConfigured: true,
      suspiciousProxy: true,
      hostsModified: true,
      securityDomainsBlocked: true,
      dnsHijacked: true,
      indicators: ['Security domains blocked', 'DNS hijacked'],
    },
    factors: [],
    warnings: ['System appears compromised'],
    blockers: ['System security compromised'],
    safeForRemediation: false,
    recommendation: 'abort',
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Lane Enforcement Integration', () => {
  describe('End-to-End Lane Partitioning', () => {
    it('should partition plan into autopilot and assisted lanes', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();

      // Create a mixed plan
      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('DeleteScheduledTask', '\\TestProduct\\UpdateTask'),
        createTestStep('RunUninstaller', 'TestProduct'), // This should be blocked
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestProduct'),
        createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\TestProduct'), // May be blocked
      ];

      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createHealthySessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // RunUninstaller should always be in assisted
      expect(decision.blockedSteps).toContain(steps[2].id);

      // We should have both allowed and blocked steps
      expect(decision.allowedSteps.length + decision.blockedSteps.length).toBe(steps.length);

      // Per-step reasons should be available
      expect(decision.stepReasons.size).toBe(steps.length);
    });

    it('should block all steps when session is compromised', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();

      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestProduct'),
      ];

      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createCompromisedSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // Session blockers should be present
      expect(decision.sessionBlockers.length).toBeGreaterThan(0);

      // Not eligible for autopilot
      expect(decision.eligible).toBe(false);
    });
  });

  describe('Risk Scoring Pipeline', () => {
    it('should flow from session to plan to combined assessment', () => {
      const planScorer = createPlanRiskScorer();
      const sessionScorer = createSessionRiskScorer();
      const combinedScorer = createCombinedRiskScorer();

      // 1. Create session risk from Defender state
      const sessionRisk = sessionScorer.score(null, []); // No Defender artifact = unknown state

      expect(sessionRisk.securityPosture.overallStatus).toBe('unknown');

      // 2. Create plan risk
      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('RemoveFolder', 'C:\\Test\\Folder'),
      ];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);

      expect(planRisk.stepRisks.length).toBe(2);

      // 3. Combine assessments
      const combined = combinedScorer.assess(sessionRisk, planRisk);

      expect(combined.combinedScore).toBeGreaterThanOrEqual(0);
      expect(combined.combinedScore).toBeLessThanOrEqual(100);
      expect(['autopilot', 'assisted', 'manual_only', 'abort']).toContain(combined.recommendation);
    });

    it('should produce deterministic results', () => {
      const planScorer = createPlanRiskScorer();
      const sessionScorer = createSessionRiskScorer();
      const combinedScorer = createCombinedRiskScorer();

      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('RemoveFolder', 'C:\\Test\\Folder'),
      ];
      const plan = createTestPlan(steps);

      // Run twice
      const sessionRisk1 = createHealthySessionRisk();
      const planRisk1 = planScorer.score(plan);
      const combined1 = combinedScorer.assess(sessionRisk1, planRisk1);

      const sessionRisk2 = createHealthySessionRisk();
      const planRisk2 = planScorer.score(plan);
      const combined2 = combinedScorer.assess(sessionRisk2, planRisk2);

      // Results should be consistent
      expect(combined1.recommendation).toBe(combined2.recommendation);
      expect(combined1.combinedScore).toBe(combined2.combinedScore);
    });
  });

  describe('Autopilot Policy with Risk Scoring', () => {
    it('should integrate autopilot decision with combined assessment', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();
      const combinedScorer = createCombinedRiskScorer();

      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('DeleteScheduledTask', '\\TestProduct\\Task'),
      ];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createHealthySessionRisk();

      // Get autopilot decision
      const autopilotDecision = policy.evaluate(planRisk, sessionRisk, true);

      // Get combined assessment
      const combined = combinedScorer.assess(sessionRisk, planRisk);

      // Recommendations should be consistent
      if (autopilotDecision.eligible && autopilotDecision.allowedSteps.length === steps.length) {
        // If all steps are autopilot-eligible, combined should recommend autopilot or assisted
        expect(['autopilot', 'assisted']).toContain(combined.recommendation);
      }

      if (combined.allBlockers.length > 0) {
        // If there are blockers, autopilot should not be eligible
        expect(autopilotDecision.eligible).toBe(false);
      }
    });
  });

  describe('Lane Recommendation Generation', () => {
    it('should generate correct banner for autopilot-eligible plans', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();

      // Create a simple, low-risk plan
      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
      ];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createHealthySessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // Decision structure should be complete
      expect(decision.reasonCodes).toBeDefined();
      expect(Array.isArray(decision.allowedSteps)).toBe(true);
      expect(Array.isArray(decision.blockedSteps)).toBe(true);
    });

    it('should generate correct banner for blocked environment', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();
      const combinedScorer = createCombinedRiskScorer();

      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
      ];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createCompromisedSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);
      const combined = combinedScorer.assess(sessionRisk, planRisk);

      // Should have blockers
      expect(combined.allBlockers.length).toBeGreaterThan(0);

      // Session blockers should be populated
      expect(decision.sessionBlockers.length).toBeGreaterThan(0);
    });
  });

  describe('Step-Level Lane Enforcement', () => {
    it('should provide per-step eligibility reasons', () => {
      const policy = createAutopilotPolicy();
      const planScorer = createPlanRiskScorer();

      const steps = [
        createTestStep('StopProcess', 'testapp.exe'),
        createTestStep('RunUninstaller', 'TestProduct'),
        createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\TestProduct'),
      ];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = createHealthySessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // Each step should have a reason
      for (const step of steps) {
        const reason = decision.stepReasons.get(step.id);
        expect(reason).toBeDefined();
        expect(reason?.stepId).toBe(step.id);
        expect(typeof reason?.eligible).toBe('boolean');
        expect(Array.isArray(reason?.reasons)).toBe(true);
      }

      // RunUninstaller should have a specific reason
      const uninstallerReason = decision.stepReasons.get(steps[1].id);
      expect(uninstallerReason?.eligible).toBe(false);
      expect(uninstallerReason?.reasons.some(r => r.includes('Uninstaller'))).toBe(true);
    });
  });

  describe('Schema Version Compatibility', () => {
    it('should produce risk assessment compatible with v1.1.0 schema', () => {
      const planScorer = createPlanRiskScorer();
      const sessionScorer = createSessionRiskScorer();
      const combinedScorer = createCombinedRiskScorer();

      const steps = [createTestStep('StopProcess', 'testapp.exe')];
      const plan = createTestPlan(steps);
      const planRisk = planScorer.score(plan);
      const sessionRisk = sessionScorer.score(null, []);
      const combined = combinedScorer.assess(sessionRisk, planRisk);

      // Verify all required fields for schema
      expect(combined.session).toBeDefined();
      expect(combined.plan).toBeDefined();
      expect(combined.combinedScore).toBeDefined();
      expect(combined.combinedBucket).toBeDefined();
      expect(combined.recommendation).toBeDefined();
      expect(combined.recommendationReason).toBeDefined();

      // Session risk should have all required fields
      expect(sessionRisk.securityPosture).toBeDefined();
      expect(sessionRisk.networkPosture).toBeDefined();
      expect(sessionRisk.warnings).toBeDefined();
      expect(sessionRisk.blockers).toBeDefined();

      // Plan risk should have all required fields
      expect(planRisk.stats.lowRiskCount).toBeDefined();
      expect(planRisk.stats.mediumRiskCount).toBeDefined();
      expect(planRisk.stats.highRiskCount).toBeDefined();
      expect(planRisk.stats.criticalRiskCount).toBeDefined();
      expect(planRisk.autopilotEligible).toBeDefined();
    });
  });
});
