/**
 * Risk Scoring Module
 *
 * Comprehensive risk assessment for artifacts, plans, and sessions.
 *
 * USAGE:
 * ```typescript
 * import {
 *   createArtifactRiskScorer,
 *   createPlanRiskScorer,
 *   createSessionRiskScorer,
 *   createCombinedRiskScorer,
 *   generateRiskSummary,
 * } from './risk';
 *
 * // Score artifacts
 * const artifactScorer = createArtifactRiskScorer();
 * const artifactRisks = artifactScorer.scoreAll(snapshot.artifacts);
 *
 * // Score plan
 * const planScorer = createPlanRiskScorer();
 * const planRisk = planScorer.score(plan, new Map(
 *   artifactRisks.map(r => [r.artifactId, r])
 * ));
 *
 * // Score session environment
 * const sessionScorer = createSessionRiskScorer();
 * const sessionRisk = sessionScorer.score(defenderArtifact, networkArtifacts);
 *
 * // Get combined assessment
 * const combinedScorer = createCombinedRiskScorer();
 * const assessment = combinedScorer.assess(sessionRisk, planRisk);
 *
 * // Generate human-readable summary
 * console.log(generateRiskSummary(assessment));
 * ```
 */

// Types
export type {
  RiskScore,
  RiskBucket,
  RiskFactor,
  RiskFactorCategory,
  ArtifactRisk,
  StepRisk,
  PlanRisk,
  SessionRisk,
  SecurityPosture,
  NetworkPosture,
  CompleteRiskAssessment,
  ArtifactRiskScorer,
  PlanRiskScorer,
  SessionRiskScorer,
  CombinedRiskScorer,
} from './types';

// Type utilities
export { scoreToBucket, bucketToRiskLevel } from './types';

// Artifact risk scoring
export { createArtifactRiskScorer } from './artifact-risk';

// Plan risk scoring
export { createPlanRiskScorer } from './plan-risk';

// Session risk scoring
export { createSessionRiskScorer } from './session-risk';

// Combined risk scoring
export { createCombinedRiskScorer, generateRiskSummary } from './combined-risk';

// Autopilot policy
export {
  createAutopilotPolicy,
  DEFAULT_AUTOPILOT_RULES,
  type AutopilotDecision,
  type AutopilotRules,
  type AutopilotPolicy,
  type StepAutopilotReason,
} from './autopilot-policy';

// ============================================================================
// Convenience Factory
// ============================================================================

import { createArtifactRiskScorer } from './artifact-risk';
import { createPlanRiskScorer } from './plan-risk';
import { createSessionRiskScorer } from './session-risk';
import { createCombinedRiskScorer } from './combined-risk';

/**
 * Create all risk scorers at once
 */
export function createRiskScoringEngine() {
  return {
    artifact: createArtifactRiskScorer(),
    plan: createPlanRiskScorer(),
    session: createSessionRiskScorer(),
    combined: createCombinedRiskScorer(),
  };
}
