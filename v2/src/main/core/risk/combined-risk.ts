/**
 * Combined Risk Scorer
 *
 * Combines session environmental risk and plan risk into
 * a final recommendation for the user.
 */

import type {
  CombinedRiskScorer,
  CompleteRiskAssessment,
  PlanRisk,
  RiskScore,
  SessionRisk,
} from './types';
import { scoreToBucket } from './types';

/**
 * Create a combined risk scorer
 */
export function createCombinedRiskScorer(): CombinedRiskScorer {
  return {
    assess(session: SessionRisk, plan: PlanRisk | null): CompleteRiskAssessment {
      // Aggregate all warnings and blockers
      const allWarnings = [...session.warnings];
      const allBlockers = [...session.blockers];

      if (plan) {
        // Add warnings from plan
        if (plan.criticalRiskSteps.length > 0) {
          allWarnings.push(
            `Plan contains ${plan.criticalRiskSteps.length} critical-risk step(s)`,
          );
        }
        if (plan.highRiskSteps.length > 3) {
          allWarnings.push(`Plan contains ${plan.highRiskSteps.length} high-risk steps`);
        }
        if (!plan.autopilotEligible) {
          allWarnings.push(...plan.autopilotBlockers);
        }
      }

      // Calculate combined score
      // Environmental issues have outsized impact (40% weight when problematic)
      // Plan risk is the baseline (60% weight when present)
      let combinedScore: RiskScore;

      if (plan) {
        const envWeight = session.environmentalScore > 30 ? 0.4 : 0.2;
        const planWeight = 1 - envWeight;
        combinedScore = Math.round(
          session.environmentalScore * envWeight + plan.overallScore * planWeight,
        );
      } else {
        // Audit mode - only environmental
        combinedScore = session.environmentalScore;
      }

      const combinedBucket = scoreToBucket(combinedScore);

      // Determine final recommendation
      let recommendation: CompleteRiskAssessment['recommendation'];
      let recommendationReason: string;

      // Blockers always abort
      if (allBlockers.length > 0) {
        recommendation = 'abort';
        recommendationReason = `Cannot proceed: ${allBlockers[0]}`;
      }
      // Environmental concerns dominate
      else if (session.recommendation === 'abort') {
        recommendation = 'abort';
        recommendationReason = 'Environmental conditions unsafe for remediation';
      } else if (session.recommendation === 'investigate_first') {
        recommendation = 'manual_only';
        recommendationReason =
          'Environmental concerns require investigation before remediation';
      }
      // Plan-level concerns
      else if (plan) {
        if (plan.recommendation === 'manual_only') {
          recommendation = 'manual_only';
          recommendationReason =
            'Plan complexity or risk level requires manual approval';
        } else if (
          plan.recommendation === 'assisted' ||
          session.recommendation === 'proceed_with_caution'
        ) {
          recommendation = 'assisted';
          recommendationReason =
            'Recommend assisted mode with step-by-step confirmation';
        } else if (plan.autopilotEligible && combinedScore <= 30) {
          recommendation = 'autopilot';
          recommendationReason =
            'Low risk, automated execution is safe';
        } else {
          recommendation = 'assisted';
          recommendationReason =
            'Moderate risk, recommend user confirmation for key steps';
        }
      }
      // Audit mode
      else {
        recommendation = session.safeForRemediation ? 'autopilot' : 'assisted';
        recommendationReason = session.safeForRemediation
          ? 'Read-only audit, safe to proceed'
          : 'Environmental concerns noted, audit will proceed with caution';
      }

      return {
        session,
        plan,
        combinedScore,
        combinedBucket,
        recommendation,
        recommendationReason,
        allWarnings,
        allBlockers,
      };
    },
  };
}

/**
 * Generate a human-readable risk summary
 */
export function generateRiskSummary(assessment: CompleteRiskAssessment): string {
  const lines: string[] = [];

  // Header with overall status
  lines.push(`Risk Assessment: ${assessment.combinedBucket.toUpperCase()}`);
  lines.push(`Combined Score: ${assessment.combinedScore}/100`);
  lines.push('');

  // Environment section
  lines.push('Environment:');
  const sec = assessment.session.securityPosture;
  lines.push(
    `  Defender: ${sec.defenderActive ? 'Active' : 'INACTIVE'} | ` +
      `RTP: ${sec.realTimeProtection ? 'On' : 'OFF'} | ` +
      `Tamper: ${sec.tamperProtection === null ? 'Unknown' : sec.tamperProtection ? 'On' : 'OFF'}`,
  );
  if (sec.suspiciousExclusions > 0) {
    lines.push(`  Warning: ${sec.suspiciousExclusions} suspicious exclusion(s)`);
  }
  if (sec.recentThreats > 0) {
    lines.push(`  Warning: ${sec.recentThreats} recent threat(s) detected`);
  }

  const net = assessment.session.networkPosture;
  if (net.proxyConfigured || net.hostsModified || net.dnsHijacked) {
    lines.push('  Network:');
    if (net.proxyConfigured) {
      lines.push(`    Proxy: Configured${net.suspiciousProxy ? ' (SUSPICIOUS)' : ''}`);
    }
    if (net.hostsModified) {
      lines.push(
        `    Hosts: Modified${net.securityDomainsBlocked ? ' (SECURITY DOMAINS BLOCKED!)' : ''}`,
      );
    }
    if (net.dnsHijacked) {
      lines.push('    DNS: POTENTIALLY HIJACKED');
    }
  }
  lines.push('');

  // Plan section (if present)
  if (assessment.plan) {
    const plan = assessment.plan;
    lines.push('Plan:');
    lines.push(`  Steps: ${plan.stats.totalSteps}`);
    lines.push(
      `  Risk Distribution: ${plan.stats.lowRiskCount} low, ` +
        `${plan.stats.mediumRiskCount} medium, ` +
        `${plan.stats.highRiskCount} high, ` +
        `${plan.stats.criticalRiskCount} critical`,
    );
    if (plan.criticalRiskSteps.length > 0) {
      lines.push(`  Critical Steps: ${plan.criticalRiskSteps.join(', ')}`);
    }
    lines.push(`  Autopilot Eligible: ${plan.autopilotEligible ? 'Yes' : 'No'}`);
    if (plan.autopilotBlockers.length > 0) {
      lines.push(`  Blockers: ${plan.autopilotBlockers.join('; ')}`);
    }
    lines.push('');
  }

  // Recommendation
  lines.push(`Recommendation: ${assessment.recommendation.toUpperCase()}`);
  lines.push(`  ${assessment.recommendationReason}`);

  // Warnings
  if (assessment.allWarnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    assessment.allWarnings.forEach(w => lines.push(`  - ${w}`));
  }

  // Blockers
  if (assessment.allBlockers.length > 0) {
    lines.push('');
    lines.push('BLOCKERS:');
    assessment.allBlockers.forEach(b => lines.push(`  - ${b}`));
  }

  return lines.join('\n');
}
