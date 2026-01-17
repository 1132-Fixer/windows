/**
 * Autopilot Policy
 *
 * Defines the rules for when a step is eligible for automated execution.
 *
 * AUTOPILOT MUST REQUIRE ALL OF:
 * - Step risk bucket ≤ LOW
 * - Session risk posture not degraded (Defender active, no critical tampering)
 * - Step is reversible OR quarantine-first
 * - Ownership confidence high (or medium with strong evidence)
 * - Target path is user-writable OR vendor-owned scope
 *
 * AUTOPILOT MUST EXCLUDE:
 * - System-critical registry areas
 * - Deleting without quarantine/backup
 * - Removing services/tasks unless ownership high AND evidence exists
 * - Any critical risk step
 */

import type { PlanStep } from '../../../shared/types';
import type { StepRisk, SessionRisk, PlanRisk } from './types';
import { STEP_ACTION_META } from '../planning/types';

// ============================================================================
// Autopilot Decision Types
// ============================================================================

/**
 * Result of autopilot eligibility check
 */
export interface AutopilotDecision {
  /**
   * Is the plan eligible for autopilot at all?
   */
  eligible: boolean;

  /**
   * Human-readable reason codes explaining the decision
   */
  reasonCodes: string[];

  /**
   * Step IDs that can run in autopilot
   */
  allowedSteps: string[];

  /**
   * Step IDs that must run in assisted mode
   */
  blockedSteps: string[];

  /**
   * Session-level blockers (environmental issues)
   */
  sessionBlockers: string[];

  /**
   * Per-step reason mapping
   */
  stepReasons: Map<string, StepAutopilotReason>;
}

export interface StepAutopilotReason {
  stepId: string;
  eligible: boolean;
  reasons: string[];
}

// ============================================================================
// Autopilot Rules Configuration
// ============================================================================

export interface AutopilotRules {
  /**
   * Maximum risk bucket for autopilot eligibility
   */
  maxRiskBucket: 'low' | 'medium';

  /**
   * Require quarantine for file operations?
   */
  requireQuarantine: boolean;

  /**
   * Minimum ownership confidence for autopilot
   */
  minOwnershipConfidence: 'high' | 'medium' | 'low';

  /**
   * Allow services to be stopped in autopilot?
   */
  allowServiceStop: boolean;

  /**
   * Allow tasks to be deleted in autopilot?
   */
  allowTaskDelete: boolean;

  /**
   * Allow HKLM registry keys to be deleted in autopilot?
   */
  allowHklmRegistry: boolean;

  /**
   * Maximum number of steps for autopilot
   */
  maxSteps: number;

  /**
   * Environmental requirements
   */
  environmental: {
    /** Require Defender to be active */
    requireDefenderActive: boolean;

    /** Require real-time protection to be on */
    requireRealTimeProtection: boolean;

    /** Block if security domains are blocked in hosts */
    blockOnSecurityDomainsBlocked: boolean;

    /** Block if tamper protection is off */
    blockOnTamperProtectionOff: boolean;
  };
}

/**
 * Default autopilot rules (conservative)
 */
export const DEFAULT_AUTOPILOT_RULES: AutopilotRules = {
  maxRiskBucket: 'low',
  requireQuarantine: true,
  minOwnershipConfidence: 'medium',
  allowServiceStop: true, // Safe with proper ownership
  allowTaskDelete: true,  // Safe with proper ownership
  allowHklmRegistry: false, // HKLM requires explicit approval
  maxSteps: 50,
  environmental: {
    requireDefenderActive: false, // Don't block if Defender is off
    requireRealTimeProtection: false, // Don't block if RTP is off
    blockOnSecurityDomainsBlocked: true, // This is suspicious
    blockOnTamperProtectionOff: true, // This is suspicious
  },
};

// ============================================================================
// Autopilot Policy Implementation
// ============================================================================

/**
 * Create an autopilot policy checker
 */
export function createAutopilotPolicy(rules: AutopilotRules = DEFAULT_AUTOPILOT_RULES) {
  return {
    /**
     * Evaluate autopilot eligibility for a plan
     */
    evaluate(
      planRisk: PlanRisk,
      sessionRisk: SessionRisk,
      quarantineEnabled: boolean,
    ): AutopilotDecision {
      const reasonCodes: string[] = [];
      const sessionBlockers: string[] = [];
      const stepReasons = new Map<string, StepAutopilotReason>();
      const allowedSteps: string[] = [];
      const blockedSteps: string[] = [];

      // ======================================================================
      // Session-Level Checks
      // ======================================================================

      if (!checkSessionEnvironment(sessionRisk, rules, sessionBlockers)) {
        // Session is not safe for autopilot
        reasonCodes.push('SESSION_ENVIRONMENT_UNSAFE');
      }

      // ======================================================================
      // Plan-Level Checks
      // ======================================================================

      // Check overall plan risk
      if (planRisk.overallBucket !== 'low' && rules.maxRiskBucket === 'low') {
        reasonCodes.push('PLAN_RISK_TOO_HIGH');
      }

      // Check step count
      if (planRisk.stats.totalSteps > rules.maxSteps) {
        reasonCodes.push('TOO_MANY_STEPS');
      }

      // Check quarantine requirement
      if (rules.requireQuarantine && !quarantineEnabled) {
        reasonCodes.push('QUARANTINE_REQUIRED');
      }

      // ======================================================================
      // Step-Level Checks
      // ======================================================================

      for (const stepRisk of planRisk.stepRisks) {
        const stepResult = checkStepEligibility(stepRisk, rules, quarantineEnabled);
        stepReasons.set(stepRisk.stepId, stepResult);

        if (stepResult.eligible && sessionBlockers.length === 0) {
          allowedSteps.push(stepRisk.stepId);
        } else {
          blockedSteps.push(stepRisk.stepId);
        }
      }

      // ======================================================================
      // Final Decision
      // ======================================================================

      const eligible =
        sessionBlockers.length === 0 &&
        allowedSteps.length > 0 &&
        !reasonCodes.includes('PLAN_RISK_TOO_HIGH') &&
        !reasonCodes.includes('QUARANTINE_REQUIRED');

      if (eligible) {
        reasonCodes.push('AUTOPILOT_ELIGIBLE');
      }

      return {
        eligible,
        reasonCodes,
        allowedSteps,
        blockedSteps,
        sessionBlockers,
        stepReasons,
      };
    },

    /**
     * Check if a specific step is autopilot-eligible
     */
    isStepEligible(
      stepRisk: StepRisk,
      sessionRisk: SessionRisk,
      quarantineEnabled: boolean,
    ): boolean {
      const sessionBlockers: string[] = [];
      if (!checkSessionEnvironment(sessionRisk, rules, sessionBlockers)) {
        return false;
      }

      const result = checkStepEligibility(stepRisk, rules, quarantineEnabled);
      return result.eligible;
    },

    /**
     * Get the rules being used
     */
    getRules(): AutopilotRules {
      return { ...rules };
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function checkSessionEnvironment(
  sessionRisk: SessionRisk,
  rules: AutopilotRules,
  blockers: string[],
): boolean {
  const env = rules.environmental;

  // Check Defender active
  if (env.requireDefenderActive && !sessionRisk.securityPosture.defenderActive) {
    blockers.push('Windows Defender is not active');
  }

  // Check real-time protection
  if (env.requireRealTimeProtection && !sessionRisk.securityPosture.realTimeProtection) {
    blockers.push('Real-time protection is disabled');
  }

  // Check tamper protection (suspicious if disabled)
  if (env.blockOnTamperProtectionOff && sessionRisk.securityPosture.tamperProtection === false) {
    blockers.push('Tamper protection is disabled (suspicious)');
  }

  // Check security domains blocked
  if (env.blockOnSecurityDomainsBlocked && sessionRisk.networkPosture.securityDomainsBlocked) {
    blockers.push('Security domains are blocked in hosts file');
  }

  // Check if session recommends abort or investigation
  if (sessionRisk.recommendation === 'abort') {
    blockers.push('Session environment recommends abort');
  }

  if (sessionRisk.recommendation === 'investigate_first') {
    blockers.push('Session environment requires investigation');
  }

  return blockers.length === 0;
}

function checkStepEligibility(
  stepRisk: StepRisk,
  rules: AutopilotRules,
  quarantineEnabled: boolean,
): StepAutopilotReason {
  const reasons: string[] = [];

  // Check risk bucket
  if (stepRisk.bucket === 'critical') {
    reasons.push('Step is critical risk');
  } else if (stepRisk.bucket === 'high') {
    reasons.push('Step is high risk');
  } else if (stepRisk.bucket === 'medium' && rules.maxRiskBucket === 'low') {
    reasons.push('Step is medium risk (autopilot requires low)');
  }

  // Check action-specific rules
  const actionMeta = STEP_ACTION_META[stepRisk.action];

  // Check reversibility for file operations
  if (stepRisk.action === 'RemoveFolder') {
    if (!actionMeta.reversible && !quarantineEnabled) {
      reasons.push('Folder removal not reversible without quarantine');
    }
  }

  // Check HKLM registry
  if (stepRisk.action === 'DeleteRegistryKey' || stepRisk.action === 'DeleteRegistryValue') {
    if (!rules.allowHklmRegistry && /^HKLM/i.test(stepRisk.target)) {
      reasons.push('HKLM registry changes require assisted mode');
    }
  }

  // Check service operations
  if (stepRisk.action === 'StopService' && !rules.allowServiceStop) {
    reasons.push('Service operations require assisted mode');
  }

  // Check task operations
  if (stepRisk.action === 'DeleteScheduledTask' && !rules.allowTaskDelete) {
    reasons.push('Task operations require assisted mode');
  }

  // Check uninstaller (always assisted)
  if (stepRisk.action === 'RunUninstaller') {
    reasons.push('Uninstaller execution requires assisted mode');
  }

  // Check reinstall (always assisted)
  if (stepRisk.action === 'Reinstall') {
    reasons.push('Reinstallation requires assisted mode');
  }

  return {
    stepId: stepRisk.stepId,
    eligible: reasons.length === 0,
    reasons,
  };
}

// ============================================================================
// Autopilot Policy Type Export
// ============================================================================

export type AutopilotPolicy = ReturnType<typeof createAutopilotPolicy>;
