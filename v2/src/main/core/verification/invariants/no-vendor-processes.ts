/**
 * Invariant: No Running Vendor Processes
 *
 * APPLIES WHEN: Plan includes StopProcess or Uninstall
 *
 * CHECKS: No ProcessArtifacts with owner.vendor === product.vendor
 *
 * FAILS IF: Any vendor processes remain running
 */

import type { Plan, SnapshotDiff } from '../../../../shared/types';
import type {
  Invariant,
  InvariantResult,
  VerifyInput,
} from '../types';
import type { ProcessArtifact } from '../../acquisition/types';

export const NoVendorProcessesInvariant: Invariant = {
  id: 'no_vendor_processes',
  description: 'No vendor processes should be running after remediation',
  category: 'process',
  severity: 'standard',

  appliesTo(plan: Plan): boolean {
    // Applies when plan includes StopProcess or mode is uninstall
    if (plan.mode === 'uninstall') return true;

    return plan.steps.some(step =>
      step.action === 'StopProcess' ||
      step.action === 'RunUninstaller',
    );
  },

  evaluate(input: VerifyInput, _diff: SnapshotDiff): InvariantResult {
    const { product, postSnapshot } = input;

    // Find any remaining vendor processes
    const vendorProcesses = postSnapshot.artifacts.filter(artifact => {
      if (artifact.type !== 'process') return false;
      return artifact.owner.vendor === product.vendor;
    }) as ProcessArtifact[];

    if (vendorProcesses.length === 0) {
      return {
        status: 'pass',
        details: 'No vendor processes running',
      };
    }

    // Build evidence of remaining processes
    const processInfo = vendorProcesses.map(p => ({
      name: p.metadata.name,
      pid: p.metadata.pid,
      path: p.metadata.executablePath,
    }));

    return {
      status: 'fail',
      details: `${vendorProcesses.length} vendor process(es) still running: ${processInfo.map(p => `${p.name} (PID ${p.pid})`).join(', ')}`,
      evidence: {
        remainingProcesses: processInfo,
        count: vendorProcesses.length,
      },
    };
  },
};
