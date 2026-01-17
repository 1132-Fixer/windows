/**
 * Invariants Index
 *
 * Exports all verification invariants and provides a default set.
 */

import type { Invariant } from '../types';

// Import all invariants
import { NoVendorProcessesInvariant } from './no-vendor-processes';
import { NoVendorServicesInvariant, NoVendorTasksInvariant } from './no-vendor-services-tasks';
import { NoOrphanedReferencesInvariant } from './no-orphaned-references';
import { PlanPromisesHeldInvariant } from './plan-promises-held';
import { NoOutOfScopeDamageInvariant } from './no-out-of-scope-damage';

// Re-export individual invariants
export {
  NoVendorProcessesInvariant,
  NoVendorServicesInvariant,
  NoVendorTasksInvariant,
  NoOrphanedReferencesInvariant,
  PlanPromisesHeldInvariant,
  NoOutOfScopeDamageInvariant,
};

/**
 * Default set of invariants for verification
 *
 * Order matters:
 * 1. Safety invariants first (critical)
 * 2. Core invariants second (standard)
 * 3. Advisory invariants last
 */
export const DEFAULT_INVARIANTS: Invariant[] = [
  // Critical (safety) - checked first, fail fast
  NoOutOfScopeDamageInvariant,

  // Standard (core) - executor accountability
  PlanPromisesHeldInvariant,
  NoVendorProcessesInvariant,
  NoVendorServicesInvariant,
  NoVendorTasksInvariant,

  // Advisory - warnings for edge cases
  NoOrphanedReferencesInvariant,
];

/**
 * Get invariants filtered by severity
 */
export function getInvariantsBySeverity(
  invariants: Invariant[],
  severity: 'critical' | 'standard' | 'advisory',
): Invariant[] {
  return invariants.filter(inv => inv.severity === severity);
}

/**
 * Get invariants filtered by category
 */
export function getInvariantsByCategory(
  invariants: Invariant[],
  category: string,
): Invariant[] {
  return invariants.filter(inv => inv.category === category);
}

/**
 * Get invariant by ID
 */
export function getInvariantById(
  invariants: Invariant[],
  id: string,
): Invariant | undefined {
  return invariants.find(inv => inv.id === id);
}
