/**
 * DefaultVerifier - Independent Proof Engine
 *
 * Given pre/post snapshots and a plan, determines whether the system
 * satisfies expected invariants.
 *
 * PHILOSOPHY:
 * - The verifier does not trust the executor
 * - It trusts only fresh observation + formal rules
 * - If it can't prove something is clean, it must say so
 *
 * GUARANTEES:
 * - Independent (uses only provided snapshots)
 * - Deterministic (same inputs → same outputs)
 * - Explainable (evidence for every result)
 * - Conservative (fail > false pass)
 */

import type {
  VerificationResult,
  VerificationCheck,
  VerificationStatus,
  SnapshotDiff,
} from '../../../shared/types';
import type {
  Verifier,
  VerifyInput,
  Invariant,
  InvariantResult,
} from './types';
import { diffSnapshots } from './diff';
import { DEFAULT_INVARIANTS } from './invariants';

// ============================================================================
// Status Aggregation
// ============================================================================

/**
 * Aggregate individual check statuses into overall status
 *
 * Rules:
 * - Any 'fail' → overall 'fail'
 * - No fail + any 'warning' → overall 'warning'
 * - All pass → overall 'pass'
 */
function aggregateStatus(checks: VerificationCheck[]): VerificationStatus {
  let hasFail = false;
  let hasWarning = false;

  for (const check of checks) {
    if (check.status === 'fail') {
      hasFail = true;
      break; // No need to continue
    }
    if (check.status === 'warning') {
      hasWarning = true;
    }
  }

  if (hasFail) return 'fail';
  if (hasWarning) return 'warning';
  return 'pass';
}

// ============================================================================
// Verification Options
// ============================================================================

export interface VerifierOptions {
  /** Custom invariants to use (default: DEFAULT_INVARIANTS) */
  invariants?: Invariant[];

  /** Continue evaluation after first failure (default: true) */
  continueOnFailure?: boolean;

  /** Include advisory-level invariants (default: true) */
  includeAdvisory?: boolean;

  /** Stop on first critical failure (default: true) */
  stopOnCritical?: boolean;
}

// ============================================================================
// DefaultVerifier Implementation
// ============================================================================

export class DefaultVerifier implements Verifier {
  private readonly invariants: Invariant[];
  private readonly options: Required<VerifierOptions>;

  constructor(options: VerifierOptions = {}) {
    this.invariants = options.invariants ?? DEFAULT_INVARIANTS;
    this.options = {
      invariants: this.invariants,
      continueOnFailure: options.continueOnFailure ?? true,
      includeAdvisory: options.includeAdvisory ?? true,
      stopOnCritical: options.stopOnCritical ?? true,
    };
  }

  /**
   * Verify that post-remediation state satisfies expected invariants
   */
  async verify(input: VerifyInput): Promise<VerificationResult> {
    // Step 1: Compute diff
    const diff = diffSnapshots(input.preSnapshot, input.postSnapshot);

    // Step 2: Filter invariants
    let activeInvariants = this.invariants;

    if (!this.options.includeAdvisory) {
      activeInvariants = activeInvariants.filter(inv => inv.severity !== 'advisory');
    }

    // Step 3: Evaluate invariants
    const checks: VerificationCheck[] = [];
    let criticalFailure = false;

    for (const invariant of activeInvariants) {
      // Check if invariant applies to this plan
      if (!invariant.appliesTo(input.plan)) {
        continue;
      }

      // Evaluate the invariant
      const result = invariant.evaluate(input, diff);

      // Convert to VerificationCheck
      const check: VerificationCheck = {
        name: invariant.id,
        status: result.status,
        details: result.details,
      };
      checks.push(check);

      // Check for critical failure
      if (result.status === 'fail' && invariant.severity === 'critical') {
        criticalFailure = true;
        if (this.options.stopOnCritical) {
          break;
        }
      }

      // Check for regular failure
      if (result.status === 'fail' && !this.options.continueOnFailure) {
        break;
      }
    }

    // Step 4: Aggregate status
    const status = aggregateStatus(checks);

    // Step 5: Build result
    return {
      status,
      checks,
      diff,
      verifiedAt: Date.now(),
    };
  }

  /**
   * Get the invariants used by this verifier
   */
  getInvariants(): Invariant[] {
    return [...this.invariants];
  }

  /**
   * Create a verifier with additional invariants
   */
  withInvariants(additionalInvariants: Invariant[]): DefaultVerifier {
    return new DefaultVerifier({
      ...this.options,
      invariants: [...this.invariants, ...additionalInvariants],
    });
  }

  /**
   * Create a verifier with only specific invariant IDs
   */
  withOnlyInvariants(ids: string[]): DefaultVerifier {
    const idSet = new Set(ids);
    return new DefaultVerifier({
      ...this.options,
      invariants: this.invariants.filter(inv => idSet.has(inv.id)),
    });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a verifier with default configuration
 */
export function createVerifier(options?: VerifierOptions): Verifier {
  return new DefaultVerifier(options);
}

/**
 * Create a strict verifier (no advisory, stop on any failure)
 */
export function createStrictVerifier(): Verifier {
  return new DefaultVerifier({
    includeAdvisory: false,
    continueOnFailure: false,
    stopOnCritical: true,
  });
}

/**
 * Create a comprehensive verifier (all invariants, continue on failure)
 */
export function createComprehensiveVerifier(): Verifier {
  return new DefaultVerifier({
    includeAdvisory: true,
    continueOnFailure: true,
    stopOnCritical: false,
  });
}
