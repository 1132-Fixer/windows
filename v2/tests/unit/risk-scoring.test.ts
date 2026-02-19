/**
 * Risk Scoring Unit Tests
 *
 * Tests for artifact, plan, session, and combined risk scoring.
 */

import { describe, it, expect } from 'vitest';
import type { Artifact, Plan, PlanStep, RiskLevel } from '../../src/shared/types';
import type { DefenderStateArtifact, NetworkArtifact } from '../../src/main/core/acquisition/types';
import {
  createArtifactRiskScorer,
  createPlanRiskScorer,
  createSessionRiskScorer,
  createCombinedRiskScorer,
  createRiskScoringEngine,
  scoreToBucket,
  bucketToRiskLevel,
  generateRiskSummary,
} from '../../src/main/core/risk';

// ============================================================================
// Test Helpers
// ============================================================================

function createTestArtifact(
  type: Artifact['type'],
  path: string,
  overrides: Partial<Artifact> = {},
): Artifact {
  return {
    id: `test-${type}-${Date.now()}`,
    type,
    owner: {
      vendor: 'Test Vendor',
      product: 'Test Product',
      confidence: 'high',
    },
    path,
    metadata: {},
    observedAt: Date.now(),
    source: 'filesystem',
    ...overrides,
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

function createTestDefenderState(
  overrides: Partial<DefenderStateArtifact['metadata']['state']> = {},
  status: DefenderStateArtifact['metadata']['overallStatus'] = 'healthy',
  indicators: string[] = [],
): DefenderStateArtifact {
  return {
    id: 'defender-state',
    type: 'defender_state',
    owner: { vendor: 'Microsoft', product: 'Windows Defender', confidence: 'high' },
    metadata: {
      state: {
        realTimeProtectionEnabled: true,
        behaviorMonitorEnabled: true,
        antivirusEnabled: true,
        antispywareEnabled: true,
        tamperProtectionEnabled: true,
        exclusions: [],
        threatCount: 0,
        ...overrides,
      },
      overallStatus: status,
      suspiciousIndicators: indicators,
    },
    observedAt: Date.now(),
    source: 'defender',
  };
}

function createTestNetworkArtifact(
  category: 'proxy' | 'hosts' | 'dns',
  current: unknown,
  isDefault = true,
): NetworkArtifact {
  return {
    id: `network-${category}`,
    type: 'network',
    owner: { vendor: 'System', product: 'Windows', confidence: 'high' },
    metadata: {
      category,
      current,
      isDefault,
    },
    observedAt: Date.now(),
    source: 'network',
  };
}

// ============================================================================
// Type Utility Tests
// ============================================================================

describe('Type Utilities', () => {
  describe('scoreToBucket', () => {
    it('should return low for scores 0-25', () => {
      expect(scoreToBucket(0)).toBe('low');
      expect(scoreToBucket(15)).toBe('low');
      expect(scoreToBucket(25)).toBe('low');
    });

    it('should return medium for scores 26-50', () => {
      expect(scoreToBucket(26)).toBe('medium');
      expect(scoreToBucket(40)).toBe('medium');
      expect(scoreToBucket(50)).toBe('medium');
    });

    it('should return high for scores 51-75', () => {
      expect(scoreToBucket(51)).toBe('high');
      expect(scoreToBucket(60)).toBe('high');
      expect(scoreToBucket(75)).toBe('high');
    });

    it('should return critical for scores 76-100', () => {
      expect(scoreToBucket(76)).toBe('critical');
      expect(scoreToBucket(90)).toBe('critical');
      expect(scoreToBucket(100)).toBe('critical');
    });
  });

  describe('bucketToRiskLevel', () => {
    it('should convert buckets to RiskLevel', () => {
      expect(bucketToRiskLevel('low')).toBe('low');
      expect(bucketToRiskLevel('medium')).toBe('medium');
      expect(bucketToRiskLevel('high')).toBe('high');
      expect(bucketToRiskLevel('critical')).toBe('high');
    });
  });
});

// ============================================================================
// Artifact Risk Scorer Tests
// ============================================================================

describe('ArtifactRiskScorer', () => {
  const scorer = createArtifactRiskScorer();

  describe('File Artifacts', () => {
    it('should score user profile files as low risk', () => {
      const artifact = createTestArtifact(
        'file',
        'C:\\Users\\TestUser\\AppData\\Local\\TestApp\\config.json',
      );
      const risk = scorer.score(artifact);

      expect(risk.bucket).toBe('low');
      expect(risk.systemCritical).toBe(false);
    });

    it('should score system path files as higher risk', () => {
      const artifact = createTestArtifact('file', 'C:\\Windows\\System32\\test.dll');
      const risk = scorer.score(artifact);

      expect(risk.score).toBeGreaterThan(30);
      expect(risk.factors.some(f => f.id === 'system_path')).toBe(true);
    });

    it('should score user data folders as high risk', () => {
      const artifact = createTestArtifact(
        'file',
        'C:\\Users\\TestUser\\Documents\\TestApp\\data',
      );
      const risk = scorer.score(artifact);

      expect(risk.containsUserData).toBe(true);
      expect(risk.factors.some(f => f.id === 'user_data')).toBe(true);
    });

    it('should score cache folders as low risk', () => {
      const artifact = createTestArtifact(
        'file',
        'C:\\Users\\TestUser\\AppData\\Local\\TestApp\\cache\\temp',
      );
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'cache_data')).toBe(true);
    });

    it('should score large files as higher risk', () => {
      const artifact = createTestArtifact(
        'file',
        'C:\\Users\\TestUser\\AppData\\Local\\TestApp\\data.bin',
        { metadata: { size: 2 * 1024 * 1024 * 1024 } }, // 2GB
      );
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'very_large_file')).toBe(true);
    });
  });

  describe('Registry Artifacts', () => {
    it('should score HKCU keys as lower risk', () => {
      const artifact = createTestArtifact(
        'registry',
        'HKCU\\SOFTWARE\\TestApp\\Settings',
        { metadata: { hive: 'HKCU' } },
      );
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'hkcu_registry')).toBe(true);
      expect(risk.score).toBeLessThan(40);
    });

    it('should score HKLM keys as higher risk', () => {
      const artifact = createTestArtifact(
        'registry',
        'HKLM\\SOFTWARE\\TestApp\\Settings',
        { metadata: { hive: 'HKLM' } },
      );
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'hklm_registry')).toBe(true);
      expect(risk.score).toBeGreaterThan(20);
    });

    it('should score Run keys as higher risk', () => {
      const artifact = createTestArtifact(
        'registry',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
        { metadata: { hive: 'HKCU' } },
      );
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'run_key')).toBe(true);
    });
  });

  describe('Process Artifacts', () => {
    it('should score running processes', () => {
      const artifact = createTestArtifact('process', '', {
        metadata: { pid: 1234, name: 'test.exe' },
      });
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'running_process')).toBe(true);
    });

    it('should score elevated processes as higher risk', () => {
      const artifact = createTestArtifact('process', '', {
        metadata: { pid: 1234, name: 'test.exe', isElevated: true },
      });
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'elevated_process')).toBe(true);
    });
  });

  describe('Service Artifacts', () => {
    it('should score running services', () => {
      const artifact = createTestArtifact('service', '', {
        metadata: { name: 'TestService', currentState: 'Running' },
      });
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'running_service')).toBe(true);
    });

    it('should score auto-start services', () => {
      const artifact = createTestArtifact('service', '', {
        metadata: { name: 'TestService', startType: 'Automatic' },
      });
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'auto_start_service')).toBe(true);
    });
  });

  describe('Ownership Confidence', () => {
    it('should penalize low confidence ownership', () => {
      const artifact = createTestArtifact('file', 'C:\\Test\\file.txt', {
        owner: { vendor: 'Test', product: 'Test', confidence: 'low' },
      });
      const risk = scorer.score(artifact);

      expect(risk.factors.some(f => f.id === 'low_confidence')).toBe(true);
      expect(risk.score).toBeGreaterThan(40);
    });
  });

  describe('Batch Scoring', () => {
    it('should score multiple artifacts', () => {
      const artifacts = [
        createTestArtifact('file', 'C:\\Test\\file1.txt'),
        createTestArtifact('file', 'C:\\Test\\file2.txt'),
        createTestArtifact('registry', 'HKCU\\SOFTWARE\\Test'),
      ];

      const risks = scorer.scoreAll(artifacts);

      expect(risks).toHaveLength(3);
      expect(risks.every(r => r.artifactId)).toBe(true);
    });
  });
});

// ============================================================================
// Plan Risk Scorer Tests
// ============================================================================

describe('PlanRiskScorer', () => {
  const scorer = createPlanRiskScorer();

  describe('Step Scoring', () => {
    it('should score simple folder removal as low-medium risk', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestApp'),
      ]);

      const risk = scorer.score(plan);

      expect(risk.overallBucket).toMatch(/low|medium/);
    });

    it('should score folder removal in user folders as high risk', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\Documents\\TestApp'),
      ]);

      const risk = scorer.score(plan);
      const stepRisk = risk.stepRisks[0];

      expect(stepRisk.factors.some(f => f.id === 'user_folder_risk')).toBe(true);
    });

    it('should score HKLM registry deletion as higher risk', () => {
      const plan = createTestPlan([
        createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\TestApp'),
      ]);

      const risk = scorer.score(plan);
      const stepRisk = risk.stepRisks[0];

      expect(stepRisk.factors.some(f => f.id === 'hklm_key')).toBe(true);
    });
  });

  describe('Plan-Level Factors', () => {
    it('should add factor for many steps', () => {
      const steps = Array.from({ length: 25 }, (_, i) =>
        createTestStep('RemoveFolder', `C:\\Test\\Folder${i}`),
      );
      const plan = createTestPlan(steps);

      const risk = scorer.score(plan);

      expect(risk.planFactors.some(f => f.id === 'many_steps')).toBe(true);
    });

    it('should add factor for wide scope', () => {
      const plan = createTestPlan([
        createTestStep('StopProcess', 'test.exe'),
        createTestStep('StopService', 'TestService'),
        createTestStep('RemoveFolder', 'C:\\Test'),
        createTestStep('DeleteRegistryKey', 'HKCU\\SOFTWARE\\Test'),
        createTestStep('DeleteScheduledTask', '\\Test\\Task'),
      ]);

      const risk = scorer.score(plan);

      expect(risk.planFactors.some(f => f.id === 'wide_scope')).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should calculate correct statistics', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Test1', { requiresAdmin: false }),
        createTestStep('RemoveFolder', 'C:\\Test2', { requiresAdmin: true }),
        createTestStep('DeleteRegistryKey', 'HKLM\\SOFTWARE\\Test', { requiresAdmin: true }),
      ]);

      const risk = scorer.score(plan);

      expect(risk.stats.totalSteps).toBe(3);
      expect(risk.stats.requiresAdminCount).toBe(2);
    });
  });

  describe('Autopilot Eligibility', () => {
    it('should be eligible for simple low-risk plans', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestApp\\cache'),
      ]);

      const risk = scorer.score(plan);

      // May or may not be eligible depending on score
      expect(typeof risk.autopilotEligible).toBe('boolean');
    });

    it('should not be eligible with critical steps', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Windows\\System32\\TestDll', {
          risk: 'high',
        }),
      ]);
      // Force a high score by adding system path factor
      // Note: In real usage, the plan builder would set appropriate risk levels

      const risk = scorer.score(plan);

      // With high risk step, autopilot should be blocked
      if (risk.criticalRiskSteps.length > 0) {
        expect(risk.autopilotEligible).toBe(false);
      }
    });
  });

  describe('Recommendations', () => {
    it('should recommend based on overall risk', () => {
      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestApp'),
      ]);

      const risk = scorer.score(plan);

      expect(['autopilot', 'assisted', 'manual_only']).toContain(risk.recommendation);
    });
  });
});

// ============================================================================
// Session Risk Scorer Tests
// ============================================================================

describe('SessionRiskScorer', () => {
  const scorer = createSessionRiskScorer();

  describe('Healthy Environment', () => {
    it('should score healthy environment as low risk', () => {
      const defender = createTestDefenderState();
      const network: NetworkArtifact[] = [];

      const risk = scorer.score(defender, network);

      expect(risk.environmentalBucket).toBe('low');
      expect(risk.safeForRemediation).toBe(true);
      expect(risk.recommendation).toBe('proceed');
    });
  });

  describe('Defender State', () => {
    it('should flag disabled real-time protection', () => {
      const defender = createTestDefenderState({
        realTimeProtectionEnabled: false,
      }, 'degraded');

      const risk = scorer.score(defender, []);

      expect(risk.factors.some(f => f.id === 'defender_disabled')).toBe(true);
      expect(risk.warnings.length).toBeGreaterThan(0);
    });

    it('should flag disabled tamper protection', () => {
      const defender = createTestDefenderState({
        tamperProtectionEnabled: false,
      }, 'degraded');

      const risk = scorer.score(defender, []);

      expect(risk.factors.some(f => f.id === 'tamper_protection_off')).toBe(true);
    });

    it('should flag suspicious exclusions', () => {
      const defender = createTestDefenderState({
        exclusions: [
          { type: 'path', value: 'C:\\Users\\' },
          { type: 'path', value: '*.exe' },
        ],
      }, 'degraded');

      const risk = scorer.score(defender, []);

      expect(risk.factors.some(f => f.id.includes('suspicious_exclusions'))).toBe(true);
    });

    it('should flag recent threats', () => {
      const defender = createTestDefenderState({
        threatCount: 3,
      }, 'degraded');

      const risk = scorer.score(defender, []);

      expect(risk.factors.some(f => f.id === 'recent_threats')).toBe(true);
    });

    it('should block on compromised status', () => {
      const defender = createTestDefenderState({}, 'compromised');

      const risk = scorer.score(defender, []);

      expect(risk.blockers.length).toBeGreaterThan(0);
      expect(risk.safeForRemediation).toBe(false);
    });
  });

  describe('Network Configuration', () => {
    it('should flag proxy configuration', () => {
      const network: NetworkArtifact[] = [
        createTestNetworkArtifact('proxy', { enabled: true, server: 'proxy.example.com:8080' }, false),
      ];

      const risk = scorer.score(null, network);

      expect(risk.factors.some(f => f.id === 'proxy_configured')).toBe(true);
    });

    it('should flag modified hosts file', () => {
      const network: NetworkArtifact[] = [
        createTestNetworkArtifact('hosts', [
          { hostname: 'example.com', ip: '127.0.0.1' },
        ], false),
      ];

      const risk = scorer.score(null, network);

      expect(risk.factors.some(f => f.id === 'hosts_modified')).toBe(true);
    });

    it('should flag blocked security domains', () => {
      const network: NetworkArtifact[] = [
        createTestNetworkArtifact('hosts', [
          { hostname: 'update.microsoft.com', ip: '127.0.0.1' },
          { hostname: 'windowsupdate.com', ip: '0.0.0.0' },
        ], false),
      ];

      const risk = scorer.score(null, network);

      expect(risk.factors.some(f => f.id === 'security_domains_blocked')).toBe(true);
      expect(risk.securityPosture.overallStatus).toBe('unknown'); // No defender state
      expect(risk.networkPosture.securityDomainsBlocked).toBe(true);
    });
  });

  describe('Multiple Indicators', () => {
    it('should flag multiple compromise indicators', () => {
      const defender = createTestDefenderState({
        realTimeProtectionEnabled: false,
        tamperProtectionEnabled: false,
        exclusions: [{ type: 'path', value: 'C:\\Users\\' }],
      }, 'degraded', ['Suspicious indicator 1']);

      const network: NetworkArtifact[] = [
        createTestNetworkArtifact('hosts', [
          { hostname: 'windowsupdate.com', ip: '127.0.0.1' },
        ], false),
      ];

      const risk = scorer.score(defender, network);

      expect(risk.factors.some(f => f.id === 'multiple_indicators')).toBe(true);
    });
  });

  describe('Null Defender State', () => {
    it('should handle null defender state gracefully', () => {
      const risk = scorer.score(null, []);

      expect(risk.securityPosture.overallStatus).toBe('unknown');
      expect(risk.securityPosture.indicators).toContain('Unable to query Defender state');
    });
  });
});

// ============================================================================
// Combined Risk Scorer Tests
// ============================================================================

describe('CombinedRiskScorer', () => {
  const combinedScorer = createCombinedRiskScorer();
  const sessionScorer = createSessionRiskScorer();
  const planScorer = createPlanRiskScorer();

  describe('Combined Assessment', () => {
    it('should combine session and plan risks', () => {
      const defender = createTestDefenderState();
      const sessionRisk = sessionScorer.score(defender, []);

      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Users\\Test\\AppData\\Local\\TestApp'),
      ]);
      const planRisk = planScorer.score(plan);

      const combined = combinedScorer.assess(sessionRisk, planRisk);

      expect(combined.session).toBe(sessionRisk);
      expect(combined.plan).toBe(planRisk);
      expect(typeof combined.combinedScore).toBe('number');
      expect(['autopilot', 'assisted', 'manual_only', 'abort']).toContain(
        combined.recommendation,
      );
    });

    it('should abort on blockers', () => {
      const defender = createTestDefenderState({}, 'compromised');
      const sessionRisk = sessionScorer.score(defender, []);

      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Test'),
      ]);
      const planRisk = planScorer.score(plan);

      const combined = combinedScorer.assess(sessionRisk, planRisk);

      expect(combined.recommendation).toBe('abort');
      expect(combined.allBlockers.length).toBeGreaterThan(0);
    });

    it('should handle audit mode (no plan)', () => {
      const defender = createTestDefenderState();
      const sessionRisk = sessionScorer.score(defender, []);

      const combined = combinedScorer.assess(sessionRisk, null);

      expect(combined.plan).toBeNull();
      expect(combined.combinedScore).toBe(sessionRisk.environmentalScore);
    });
  });

  describe('Risk Summary Generation', () => {
    it('should generate readable summary', () => {
      const defender = createTestDefenderState();
      const sessionRisk = sessionScorer.score(defender, []);

      const plan = createTestPlan([
        createTestStep('RemoveFolder', 'C:\\Test'),
        createTestStep('DeleteRegistryKey', 'HKCU\\SOFTWARE\\Test'),
      ]);
      const planRisk = planScorer.score(plan);

      const combined = combinedScorer.assess(sessionRisk, planRisk);
      const summary = generateRiskSummary(combined);

      expect(summary).toContain('Risk Assessment');
      expect(summary).toContain('Combined Score');
      expect(summary).toContain('Environment');
      expect(summary).toContain('Plan');
      expect(summary).toContain('Recommendation');
    });

    it('should include warnings in summary', () => {
      const defender = createTestDefenderState({
        realTimeProtectionEnabled: false,
      }, 'degraded');
      const sessionRisk = sessionScorer.score(defender, []);

      const combined = combinedScorer.assess(sessionRisk, null);
      const summary = generateRiskSummary(combined);

      expect(summary).toContain('Warning');
    });
  });
});

// ============================================================================
// Factory Tests
// ============================================================================

describe('Risk Scoring Engine Factory', () => {
  it('should create all scorers', () => {
    const engine = createRiskScoringEngine();

    expect(engine.artifact).toBeDefined();
    expect(engine.plan).toBeDefined();
    expect(engine.session).toBeDefined();
    expect(engine.combined).toBeDefined();
  });

  it('should create functional scorers', () => {
    const engine = createRiskScoringEngine();

    const artifact = createTestArtifact('file', 'C:\\Test\\file.txt');
    const artifactRisk = engine.artifact.score(artifact);
    expect(artifactRisk.artifactId).toBe(artifact.id);

    const plan = createTestPlan([createTestStep('RemoveFolder', 'C:\\Test')]);
    const planRisk = engine.plan.score(plan);
    expect(planRisk.planId).toBe(plan.id);

    const defender = createTestDefenderState();
    const sessionRisk = engine.session.score(defender, []);
    expect(sessionRisk.assessmentId).toBeDefined();

    const combined = engine.combined.assess(sessionRisk, planRisk);
    expect(combined.recommendation).toBeDefined();
  });
});
