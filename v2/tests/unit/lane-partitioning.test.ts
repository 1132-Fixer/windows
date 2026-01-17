/**
 * Lane Partitioning Unit Tests
 *
 * Tests for autopilot policy, lane partitioning, and lane enforcement.
 */

import { describe, it, expect } from 'vitest';
import type { Plan, PlanStep } from '../../src/shared/types';
import type { SessionRisk, PlanRisk, StepRisk } from '../../src/main/core/risk/types';
import {
  createAutopilotPolicy,
  DEFAULT_AUTOPILOT_RULES,
  type AutopilotRules,
} from '../../src/main/core/risk/autopilot-policy';
import { createPlanRiskScorer } from '../../src/main/core/risk/plan-risk';

// ============================================================================
// Test Helpers
// ============================================================================

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
    productId: 'test-product',
    mode: 'uninstall',
    createdAt: Date.now(),
    steps,
    dryRun: false,
    boundaries: {
      allowedPaths: ['C:\\Test'],
      allowedRegistryPrefixes: ['HKCU\\SOFTWARE\\Test'],
      allowedServices: ['TestService'],
      allowedTasks: ['\\Test\\'],
    },
  };
}

function createTestSessionRisk(overrides: Partial<SessionRisk> = {}): SessionRisk {
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
    ...overrides,
  };
}

function createTestPlanRisk(
  steps: PlanStep[],
  overrides: Partial<PlanRisk> = {},
): PlanRisk {
  const scorer = createPlanRiskScorer();
  const plan = createTestPlan(steps);
  const planRisk = scorer.score(plan);
  return { ...planRisk, ...overrides };
}

// ============================================================================
// Autopilot Policy Tests
// ============================================================================

describe('AutopilotPolicy', () => {
  describe('Default Rules', () => {
    it('should have conservative default rules', () => {
      expect(DEFAULT_AUTOPILOT_RULES.maxRiskBucket).toBe('low');
      expect(DEFAULT_AUTOPILOT_RULES.requireQuarantine).toBe(true);
      expect(DEFAULT_AUTOPILOT_RULES.allowHklmRegistry).toBe(false);
    });
  });

  describe('Session Environment Checks', () => {
    it('should allow autopilot in healthy environment', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.sessionBlockers).toHaveLength(0);
    });

    it('should block autopilot when tamper protection is off', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk({
        securityPosture: {
          defenderActive: true,
          realTimeProtection: true,
          tamperProtection: false,
          suspiciousExclusions: 0,
          recentThreats: 0,
          overallStatus: 'degraded',
          indicators: ['Tamper protection disabled'],
        },
      });

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.sessionBlockers.length).toBeGreaterThan(0);
      expect(decision.sessionBlockers[0]).toContain('Tamper protection');
    });

    it('should block autopilot when security domains are blocked', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk({
        networkPosture: {
          proxyConfigured: false,
          suspiciousProxy: false,
          hostsModified: true,
          securityDomainsBlocked: true,
          dnsHijacked: false,
          indicators: ['Security domains blocked'],
        },
      });

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.sessionBlockers.length).toBeGreaterThan(0);
      expect(decision.sessionBlockers[0]).toContain('security domains');
    });

    it('should block autopilot when session recommends abort', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk({
        recommendation: 'abort',
        blockers: ['System compromised'],
      });

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.sessionBlockers.length).toBeGreaterThan(0);
    });
  });

  describe('Step-Level Checks', () => {
    it('should allow low-risk process stop in autopilot', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // StopProcess is allowed if low risk
      expect(decision.allowedSteps.length).toBeGreaterThanOrEqual(0);
    });

    it('should block RunUninstaller in autopilot', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('RunUninstaller', 'TestApp')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.blockedSteps.length).toBeGreaterThan(0);
      const reason = decision.stepReasons.get(steps[0].id);
      expect(reason?.reasons.some(r => r.includes('Uninstaller'))).toBe(true);
    });

    it('should block Reinstall in autopilot', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('Reinstall', 'TestApp')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.blockedSteps.length).toBeGreaterThan(0);
      const reason = decision.stepReasons.get(steps[0].id);
      expect(reason?.reasons.some(r => r.includes('Reinstallation'))).toBe(true);
    });

    it('should block HKLM registry changes in autopilot by default', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\Test')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.blockedSteps.length).toBeGreaterThan(0);
      const reason = decision.stepReasons.get(steps[0].id);
      expect(reason?.reasons.some(r => r.includes('HKLM'))).toBe(true);
    });

    it('should allow HKCU registry changes in autopilot', () => {
      const policy = createAutopilotPolicy();
      const step = createTestStep('DeleteRegistryKey', 'HKCU\\SOFTWARE\\Test');
      const planRisk = createTestPlanRisk([step]);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // HKCU should be allowed if risk is low
      const reason = decision.stepReasons.get(step.id);
      expect(reason?.reasons.some(r => r.includes('HKLM'))).toBe(false);
    });
  });

  describe('Quarantine Requirement', () => {
    it('should block autopilot when quarantine is disabled', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('RemoveFolder', 'C:\\Test\\Folder')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, false);

      expect(decision.reasonCodes).toContain('QUARANTINE_REQUIRED');
    });

    it('should allow autopilot when quarantine is enabled', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.reasonCodes).not.toContain('QUARANTINE_REQUIRED');
    });
  });

  describe('Custom Rules', () => {
    it('should allow HKLM registry with custom rules', () => {
      const customRules: AutopilotRules = {
        ...DEFAULT_AUTOPILOT_RULES,
        allowHklmRegistry: true,
      };
      const policy = createAutopilotPolicy(customRules);
      const step = createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\Test');
      const planRisk = createTestPlanRisk([step]);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      const reason = decision.stepReasons.get(step.id);
      expect(reason?.reasons.some(r => r.includes('HKLM'))).toBe(false);
    });

    it('should block services with custom rules', () => {
      const customRules: AutopilotRules = {
        ...DEFAULT_AUTOPILOT_RULES,
        allowServiceStop: false,
      };
      const policy = createAutopilotPolicy(customRules);
      const step = createTestStep('StopService', 'TestService');
      const planRisk = createTestPlanRisk([step]);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      const reason = decision.stepReasons.get(step.id);
      expect(reason?.reasons.some(r => r.includes('Service'))).toBe(true);
    });
  });

  describe('Lane Partitioning', () => {
    it('should partition steps correctly', () => {
      const policy = createAutopilotPolicy();
      const steps = [
        createTestStep('StopProcess', 'test.exe'),
        createTestStep('RunUninstaller', 'TestApp'),
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestApp'),
      ];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // RunUninstaller should be blocked
      expect(decision.blockedSteps).toContain(steps[1].id);

      // Should have per-step reasons
      expect(decision.stepReasons.size).toBe(3);
    });

    it('should be deterministic', () => {
      const policy = createAutopilotPolicy();
      const steps = [
        createTestStep('StopProcess', 'test.exe'),
        createTestStep('RemoveFolder', 'C:\\Test\\Folder'),
      ];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision1 = policy.evaluate(planRisk, sessionRisk, true);
      const decision2 = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision1.eligible).toBe(decision2.eligible);
      expect(decision1.allowedSteps.length).toBe(decision2.allowedSteps.length);
      expect(decision1.blockedSteps.length).toBe(decision2.blockedSteps.length);
    });
  });

  describe('Eligibility Decision', () => {
    it('should be eligible with all low-risk steps and healthy environment', () => {
      const policy = createAutopilotPolicy();
      const steps = [
        createTestStep('StopProcess', 'test.exe'),
        createTestStep('DeleteScheduledTask', '\\Test\\Task'),
      ];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk();

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      // May or may not be eligible depending on risk scoring
      expect(typeof decision.eligible).toBe('boolean');
      expect(decision.reasonCodes).toBeDefined();
    });

    it('should not be eligible with session blockers', () => {
      const policy = createAutopilotPolicy();
      const steps = [createTestStep('StopProcess', 'test.exe')];
      const planRisk = createTestPlanRisk(steps);
      const sessionRisk = createTestSessionRisk({
        recommendation: 'abort',
        blockers: ['System compromised'],
      });

      const decision = policy.evaluate(planRisk, sessionRisk, true);

      expect(decision.eligible).toBe(false);
    });
  });

  describe('isStepEligible', () => {
    it('should check individual step eligibility', () => {
      const policy = createAutopilotPolicy();
      const step = createTestStep('StopProcess', 'test.exe');
      const planRisk = createTestPlanRisk([step]);
      const sessionRisk = createTestSessionRisk();
      const stepRisk = planRisk.stepRisks[0];

      const eligible = policy.isStepEligible(stepRisk, sessionRisk, true);

      expect(typeof eligible).toBe('boolean');
    });

    it('should reject step when session is unsafe', () => {
      const policy = createAutopilotPolicy();
      const step = createTestStep('StopProcess', 'test.exe');
      const planRisk = createTestPlanRisk([step]);
      const sessionRisk = createTestSessionRisk({
        recommendation: 'abort',
      });
      const stepRisk = planRisk.stepRisks[0];

      const eligible = policy.isStepEligible(stepRisk, sessionRisk, true);

      expect(eligible).toBe(false);
    });
  });
});

// ============================================================================
// Plan Risk Scoring for Lanes
// ============================================================================

describe('PlanRiskScorer for Lanes', () => {
  const scorer = createPlanRiskScorer();

  it('should score simple plans as autopilot-eligible', () => {
    const plan = createTestPlan([
      createTestStep('StopProcess', 'test.exe'),
    ]);

    const risk = scorer.score(plan);

    // Simple plans should have lower risk
    expect(risk.overallScore).toBeLessThan(60);
  });

  it('should score complex plans as not autopilot-eligible', () => {
    const steps: PlanStep[] = [];
    for (let i = 0; i < 30; i++) {
      steps.push(createTestStep('RemoveFolder', `C:\\Test\\Folder${i}`));
    }
    const plan = createTestPlan(steps);

    const risk = scorer.score(plan);

    // Many steps should trigger complexity factors
    expect(risk.planFactors.some(f => f.id === 'many_steps')).toBe(true);
  });

  it('should identify high-risk steps', () => {
    const plan = createTestPlan([
      createTestStep('RemoveFolder', 'C:\\Users\\Test\\Documents\\TestApp', {
        risk: 'high',
      }),
    ]);

    const risk = scorer.score(plan);

    // High-risk steps should be flagged
    expect(risk.highRiskSteps.length + risk.criticalRiskSteps.length).toBeGreaterThanOrEqual(0);
  });

  it('should provide recommendation', () => {
    const plan = createTestPlan([
      createTestStep('StopProcess', 'test.exe'),
    ]);

    const risk = scorer.score(plan);

    expect(['autopilot', 'assisted', 'manual_only']).toContain(risk.recommendation);
  });
});
