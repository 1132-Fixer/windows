/**
 * Invariant: No Vendor Services or Tasks
 *
 * APPLIES WHEN: Plan mode = uninstall or clean
 *
 * CHECKS: No ServiceArtifact or TaskArtifact owned by product
 *
 * FAILS IF: Any vendor services or tasks remain
 */

import type { Plan, SnapshotDiff } from '../../../../shared/types';
import type {
  Invariant,
  InvariantResult,
  VerifyInput,
} from '../types';
import type { ServiceArtifact, TaskArtifact } from '../../acquisition/types';

export const NoVendorServicesInvariant: Invariant = {
  id: 'no_vendor_services',
  description: 'No vendor services should exist after remediation',
  category: 'service',
  severity: 'standard',

  appliesTo(plan: Plan): boolean {
    return plan.mode === 'uninstall' || plan.mode === 'clean';
  },

  evaluate(input: VerifyInput, _diff: SnapshotDiff): InvariantResult {
    const { product, postSnapshot } = input;

    // Find any remaining vendor services
    const vendorServices = postSnapshot.artifacts.filter(artifact => {
      if (artifact.type !== 'service') return false;
      return artifact.owner.vendor === product.vendor;
    }) as ServiceArtifact[];

    if (vendorServices.length === 0) {
      return {
        status: 'pass',
        details: 'No vendor services present',
      };
    }

    const serviceInfo = vendorServices.map(s => ({
      name: s.metadata.name,
      displayName: s.metadata.displayName,
      state: s.metadata.currentState,
    }));

    return {
      status: 'fail',
      details: `${vendorServices.length} vendor service(s) still present: ${serviceInfo.map(s => s.name).join(', ')}`,
      evidence: {
        remainingServices: serviceInfo,
        count: vendorServices.length,
      },
    };
  },
};

export const NoVendorTasksInvariant: Invariant = {
  id: 'no_vendor_tasks',
  description: 'No vendor scheduled tasks should exist after remediation',
  category: 'task',
  severity: 'standard',

  appliesTo(plan: Plan): boolean {
    return plan.mode === 'uninstall' || plan.mode === 'clean';
  },

  evaluate(input: VerifyInput, _diff: SnapshotDiff): InvariantResult {
    const { product, postSnapshot } = input;

    // Find any remaining vendor tasks
    const vendorTasks = postSnapshot.artifacts.filter(artifact => {
      if (artifact.type !== 'task') return false;
      return artifact.owner.vendor === product.vendor;
    }) as TaskArtifact[];

    if (vendorTasks.length === 0) {
      return {
        status: 'pass',
        details: 'No vendor scheduled tasks present',
      };
    }

    const taskInfo = vendorTasks.map(t => ({
      name: t.metadata.name,
      path: t.metadata.path,
      enabled: t.metadata.enabled,
    }));

    return {
      status: 'fail',
      details: `${vendorTasks.length} vendor task(s) still present: ${taskInfo.map(t => t.name).join(', ')}`,
      evidence: {
        remainingTasks: taskInfo,
        count: vendorTasks.length,
      },
    };
  },
};
