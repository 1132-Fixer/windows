/**
 * Risk Scoring Types
 *
 * Comprehensive risk assessment for artifacts, plans, and sessions.
 *
 * RISK CATEGORIES:
 * 1. Artifact Risk - Individual item characteristics
 * 2. Step Risk - What the action could break
 * 3. Plan Risk - Aggregated complexity and danger
 * 4. Session Risk - Environmental factors (Defender disabled, proxies, etc.)
 *
 * SCORING MODEL:
 * - 0-25: Low risk (green light, can autopilot)
 * - 26-50: Medium risk (yellow light, show warnings)
 * - 51-75: High risk (orange light, require confirmation)
 * - 76-100: Critical risk (red light, manual approval only)
 */

import type { Artifact, Plan, PlanStep, RiskLevel, StepAction } from '../../../shared/types';
import type { DefenderStateArtifact, NetworkArtifact } from '../acquisition/types';

// ============================================================================
// Core Risk Score
// ============================================================================

/**
 * Numeric risk score (0-100)
 */
export type RiskScore = number;

/**
 * Risk bucket derived from score
 */
export type RiskBucket = 'low' | 'medium' | 'high' | 'critical';

/**
 * Convert score to bucket
 */
export function scoreToBucket(score: RiskScore): RiskBucket {
  if (score <= 25) return 'low';
  if (score <= 50) return 'medium';
  if (score <= 75) return 'high';
  return 'critical';
}

/**
 * Convert bucket to RiskLevel (for compatibility)
 */
export function bucketToRiskLevel(bucket: RiskBucket): RiskLevel {
  switch (bucket) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'critical':
      return 'high';
  }
}

// ============================================================================
// Risk Factor
// ============================================================================

/**
 * A single factor contributing to risk
 */
export interface RiskFactor {
  /**
   * Unique identifier for this factor
   */
  id: string;

  /**
   * Human-readable name
   */
  name: string;

  /**
   * Detailed description
   */
  description: string;

  /**
   * Category of risk
   */
  category: RiskFactorCategory;

  /**
   * Weight contribution (0-100)
   */
  weight: number;

  /**
   * Confidence in this factor (affects weight)
   */
  confidence: 'high' | 'medium' | 'low';

  /**
   * Possible mitigations
   */
  mitigations: string[];
}

export type RiskFactorCategory =
  | 'system_impact'      // Could affect system stability
  | 'data_loss'          // Could lose user data
  | 'security'           // Security implications
  | 'reversibility'      // Can we undo this?
  | 'scope'              // How much is affected
  | 'privilege'          // Admin required
  | 'environmental';     // External factors (Defender off, etc.)

// ============================================================================
// Artifact Risk Assessment
// ============================================================================

/**
 * Risk assessment for a single artifact
 */
export interface ArtifactRisk {
  /**
   * Artifact ID
   */
  artifactId: string;

  /**
   * Numeric risk score
   */
  score: RiskScore;

  /**
   * Risk bucket
   */
  bucket: RiskBucket;

  /**
   * Contributing factors
   */
  factors: RiskFactor[];

  /**
   * Is this artifact critical to system function?
   */
  systemCritical: boolean;

  /**
   * Does this artifact contain user data?
   */
  containsUserData: boolean;

  /**
   * Is deletion reversible?
   */
  reversible: boolean;
}

// ============================================================================
// Step Risk Assessment
// ============================================================================

/**
 * Risk assessment for a plan step
 */
export interface StepRisk {
  /**
   * Step ID
   */
  stepId: string;

  /**
   * Action being performed
   */
  action: StepAction;

  /**
   * Target of the action
   */
  target: string;

  /**
   * Numeric risk score
   */
  score: RiskScore;

  /**
   * Risk bucket
   */
  bucket: RiskBucket;

  /**
   * Contributing factors
   */
  factors: RiskFactor[];

  /**
   * Aggregated mitigations
   */
  mitigations: string[];

  /**
   * Requires explicit user approval
   */
  requiresApproval: boolean;

  /**
   * Recommended action
   */
  recommendation: 'autopilot' | 'warn' | 'confirm' | 'block';
}

// ============================================================================
// Plan Risk Assessment
// ============================================================================

/**
 * Risk assessment for an entire plan
 */
export interface PlanRisk {
  /**
   * Plan ID
   */
  planId: string;

  /**
   * Overall numeric score (weighted average + penalties)
   */
  overallScore: RiskScore;

  /**
   * Overall bucket
   */
  overallBucket: RiskBucket;

  /**
   * Per-step risk assessments
   */
  stepRisks: StepRisk[];

  /**
   * High-risk step IDs
   */
  highRiskSteps: string[];

  /**
   * Critical-risk step IDs
   */
  criticalRiskSteps: string[];

  /**
   * Plan-level factors (scope, complexity, etc.)
   */
  planFactors: RiskFactor[];

  /**
   * Summary statistics
   */
  stats: {
    totalSteps: number;
    lowRiskCount: number;
    mediumRiskCount: number;
    highRiskCount: number;
    criticalRiskCount: number;
    requiresAdminCount: number;
    irreversibleCount: number;
  };

  /**
   * Whether the plan can run in autopilot mode
   */
  autopilotEligible: boolean;

  /**
   * Reasons autopilot is not eligible (if any)
   */
  autopilotBlockers: string[];

  /**
   * Overall recommendation
   */
  recommendation: 'autopilot' | 'assisted' | 'manual_only';

  /**
   * Human-readable summary
   */
  summary: string;
}

// ============================================================================
// Session Risk Assessment
// ============================================================================

/**
 * Environmental risk assessment for the session
 */
export interface SessionRisk {
  /**
   * Unique assessment ID
   */
  assessmentId: string;

  /**
   * Timestamp
   */
  assessedAt: number;

  /**
   * Overall environmental score (0-100)
   */
  environmentalScore: RiskScore;

  /**
   * Environmental bucket
   */
  environmentalBucket: RiskBucket;

  /**
   * Security posture assessment
   */
  securityPosture: SecurityPosture;

  /**
   * Network configuration assessment
   */
  networkPosture: NetworkPosture;

  /**
   * Environmental factors
   */
  factors: RiskFactor[];

  /**
   * Warnings to display to user
   */
  warnings: string[];

  /**
   * Blockers (things that should prevent execution)
   */
  blockers: string[];

  /**
   * Is the environment safe for remediation?
   */
  safeForRemediation: boolean;

  /**
   * Recommendation
   */
  recommendation: 'proceed' | 'proceed_with_caution' | 'investigate_first' | 'abort';
}

/**
 * Security posture from Defender state
 */
export interface SecurityPosture {
  /**
   * Is Windows Defender active?
   */
  defenderActive: boolean;

  /**
   * Is real-time protection on?
   */
  realTimeProtection: boolean;

  /**
   * Is tamper protection on?
   */
  tamperProtection: boolean | null;

  /**
   * Number of suspicious exclusions
   */
  suspiciousExclusions: number;

  /**
   * Recent threat count
   */
  recentThreats: number;

  /**
   * Overall status
   */
  overallStatus: 'healthy' | 'degraded' | 'compromised' | 'unknown';

  /**
   * Indicators of compromise
   */
  indicators: string[];
}

/**
 * Network posture assessment
 */
export interface NetworkPosture {
  /**
   * Is proxy configured?
   */
  proxyConfigured: boolean;

  /**
   * Is the proxy suspicious?
   */
  suspiciousProxy: boolean;

  /**
   * Non-standard hosts entries
   */
  hostsModified: boolean;

  /**
   * Security domains blocked in hosts
   */
  securityDomainsBlocked: boolean;

  /**
   * DNS appears hijacked
   */
  dnsHijacked: boolean;

  /**
   * Indicators of network tampering
   */
  indicators: string[];
}

// ============================================================================
// Combined Assessment
// ============================================================================

/**
 * Complete risk assessment combining all levels
 */
export interface CompleteRiskAssessment {
  /**
   * Session environment risk
   */
  session: SessionRisk;

  /**
   * Plan risk (null if audit mode)
   */
  plan: PlanRisk | null;

  /**
   * Combined overall score
   */
  combinedScore: RiskScore;

  /**
   * Combined bucket
   */
  combinedBucket: RiskBucket;

  /**
   * Final recommendation
   */
  recommendation: 'autopilot' | 'assisted' | 'manual_only' | 'abort';

  /**
   * Human-readable recommendation reason
   */
  recommendationReason: string;

  /**
   * All warnings aggregated
   */
  allWarnings: string[];

  /**
   * All blockers aggregated
   */
  allBlockers: string[];
}

// ============================================================================
// Scorer Interfaces
// ============================================================================

/**
 * Artifact risk scorer interface
 */
export interface ArtifactRiskScorer {
  /**
   * Score a single artifact
   */
  score(artifact: Artifact): ArtifactRisk;

  /**
   * Score multiple artifacts
   */
  scoreAll(artifacts: Artifact[]): ArtifactRisk[];
}

/**
 * Plan risk scorer interface
 */
export interface PlanRiskScorer {
  /**
   * Score a remediation plan
   */
  score(plan: Plan, artifactRisks?: Map<string, ArtifactRisk>): PlanRisk;
}

/**
 * Session risk scorer interface
 */
export interface SessionRiskScorer {
  /**
   * Score session environment
   */
  score(
    defenderState: DefenderStateArtifact | null,
    networkConfig: NetworkArtifact[],
  ): SessionRisk;
}

/**
 * Combined risk scorer interface
 */
export interface CombinedRiskScorer {
  /**
   * Create complete assessment
   */
  assess(
    session: SessionRisk,
    plan: PlanRisk | null,
  ): CompleteRiskAssessment;
}
