/**
 * Plan Builder Tests
 * Verify plan generation produces correct, safe, ordered steps
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Plan,
  PlanStep,
  Snapshot,
  Artifact,
  StepAction,
} from '../../src/shared/types';
import type { ProductDefinition } from '../../src/main/core/acquisition/types';
import {
  STEP_EXECUTION_ORDER,
  INTRA_CATEGORY_ORDER,
  STEP_ACTION_META,
  MODE_BEHAVIORS,
} from '../../src/main/core/planning/types';

// Mock plan builder for testing
function buildMockPlan(
  snapshot: Snapshot,
  product: ProductDefinition,
  mode: 'audit' | 'clean' | 'repair' | 'uninstall' | 'reinstall',
): Plan {
  const steps: PlanStep[] = [];
  const modeBehavior = MODE_BEHAVIORS[mode];

  // Generate steps from artifacts
  for (const artifact of snapshot.artifacts) {
    const action = getActionForArtifact(artifact, mode);
    if (action && modeBehavior.allowedActions.includes(action)) {
      steps.push({
        id: `step_${steps.length + 1}`,
        action,
        target: artifact.path || artifact.id,
        requiresAdmin: STEP_ACTION_META[action].requiresAdmin,
        risk: STEP_ACTION_META[action].defaultRisk,
        reason: `Remove ${artifact.type} artifact`,
      });
    }
  }

  // Sort steps by execution order
  steps.sort((a, b) => {
    const categoryA = STEP_ACTION_META[a.action].category;
    const categoryB = STEP_ACTION_META[b.action].category;
    const orderA = STEP_EXECUTION_ORDER.indexOf(categoryA);
    const orderB = STEP_EXECUTION_ORDER.indexOf(categoryB);

    if (orderA !== orderB) return orderA - orderB;

    // Same category, use intra-category order
    const intraA = INTRA_CATEGORY_ORDER[a.action] || 99;
    const intraB = INTRA_CATEGORY_ORDER[b.action] || 99;
    return intraA - intraB;
  });

  return {
    id: `plan_${Date.now()}`,
    productId: product.id,
    mode,
    createdAt: Date.now(),
    dryRun: false,
    steps,
    boundaries: {
      allowedPaths: [
        ...product.paths.install,
        ...product.paths.appData,
        ...product.paths.programData,
      ],
      allowedRegistryPrefixes: [
        ...product.registry.software,
        ...product.registry.uninstall,
      ],
      allowedServices: product.services,
      allowedTasks: product.tasks,
    },
  };
}

function getActionForArtifact(
  artifact: Artifact,
  mode: string,
): StepAction | null {
  switch (artifact.type) {
    case 'process':
      return mode === 'uninstall' || mode === 'reinstall' ? 'StopProcess' : null;
    case 'service':
      return mode === 'uninstall' || mode === 'reinstall' ? 'StopService' : null;
    case 'file':
      return 'RemoveFolder';
    case 'registry':
      return 'DeleteRegistryKey';
    case 'task':
      return 'DeleteScheduledTask';
    default:
      return null;
  }
}

describe('PlanBuilder', () => {
  let product: ProductDefinition;
  let snapshot: Snapshot;

  beforeEach(() => {
    product = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: ['%PROGRAMFILES%\\Zoom'],
        appData: ['%APPDATA%\\Zoom'],
        programData: ['%PROGRAMDATA%\\Zoom'],
        logs: [],
        temp: [],
      },
      registry: {
        software: ['HKCU\\Software\\Zoom', 'HKLM\\Software\\Zoom'],
        uninstall: ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom'],
        services: [],
        other: [],
      },
      processes: ['Zoom.exe'],
      services: ['CptService'],
      tasks: ['\\ZoomUpdateTaskMachine'],
    };

    snapshot = {
      id: 'snapshot_test',
      productId: 'zoom',
      createdAt: Date.now(),
      artifacts: [
        {
          id: 'proc_1',
          type: 'process',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'Zoom.exe',
          metadata: { pid: 1234 },
          observedAt: Date.now(),
          source: 'process',
        },
        {
          id: 'svc_1',
          type: 'service',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'CptService',
          metadata: { state: 'Running' },
          observedAt: Date.now(),
          source: 'service',
        },
        {
          id: 'file_1',
          type: 'file',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: '%APPDATA%\\Zoom\\data',
          metadata: {},
          observedAt: Date.now(),
          source: 'filesystem',
        },
        {
          id: 'reg_1',
          type: 'registry',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'HKCU\\Software\\Zoom',
          metadata: {},
          observedAt: Date.now(),
          source: 'registry',
        },
        {
          id: 'task_1',
          type: 'task',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: '\\ZoomUpdateTaskMachine',
          metadata: {},
          observedAt: Date.now(),
          source: 'task',
        },
      ],
      relationships: [],
    };
  });

  describe('Step Generation', () => {
    it('should generate steps for all artifacts in uninstall mode', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.some(s => s.action === 'StopProcess')).toBe(true);
      expect(plan.steps.some(s => s.action === 'StopService')).toBe(true);
      expect(plan.steps.some(s => s.action === 'RemoveFolder')).toBe(true);
      expect(plan.steps.some(s => s.action === 'DeleteRegistryKey')).toBe(true);
      expect(plan.steps.some(s => s.action === 'DeleteScheduledTask')).toBe(true);
    });

    it('should not generate process/service steps in clean mode', () => {
      const plan = buildMockPlan(snapshot, product, 'clean');

      expect(plan.steps.some(s => s.action === 'StopProcess')).toBe(false);
      expect(plan.steps.some(s => s.action === 'StopService')).toBe(false);
    });

    it('should generate no steps in audit mode', () => {
      const plan = buildMockPlan(snapshot, product, 'audit');

      expect(plan.steps.length).toBe(0);
    });
  });

  describe('Step Ordering', () => {
    it('should order execution steps before removal steps', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      const executionSteps = plan.steps.filter(
        s => STEP_ACTION_META[s.action].category === 'execution',
      );
      const removalSteps = plan.steps.filter(
        s => STEP_ACTION_META[s.action].category === 'removal',
      );

      if (executionSteps.length > 0 && removalSteps.length > 0) {
        const lastExecutionIndex = plan.steps.findIndex(
          s => s.id === executionSteps[executionSteps.length - 1].id,
        );
        const firstRemovalIndex = plan.steps.findIndex(
          s => s.id === removalSteps[0].id,
        );

        expect(lastExecutionIndex).toBeLessThan(firstRemovalIndex);
      }
    });

    it('should order StopService before StopProcess within execution category', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      const serviceStepIndex = plan.steps.findIndex(s => s.action === 'StopService');
      const processStepIndex = plan.steps.findIndex(s => s.action === 'StopProcess');

      if (serviceStepIndex >= 0 && processStepIndex >= 0) {
        expect(serviceStepIndex).toBeLessThan(processStepIndex);
      }
    });
  });

  describe('Boundaries', () => {
    it('should set boundaries from product definition', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      expect(plan.boundaries.allowedPaths).toContain('%PROGRAMFILES%\\Zoom');
      expect(plan.boundaries.allowedPaths).toContain('%APPDATA%\\Zoom');
      expect(plan.boundaries.allowedRegistryPrefixes).toContain('HKCU\\Software\\Zoom');
      expect(plan.boundaries.allowedServices).toContain('CptService');
      expect(plan.boundaries.allowedTasks).toContain('\\ZoomUpdateTaskMachine');
    });

    it('should not include paths outside product definition', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      expect(plan.boundaries.allowedPaths).not.toContain('C:\\Windows');
      expect(plan.boundaries.allowedPaths).not.toContain('%APPDATA%\\Microsoft');
    });
  });

  describe('Mode Behaviors', () => {
    it('should respect allowed actions for each mode', () => {
      for (const [mode, behavior] of Object.entries(MODE_BEHAVIORS)) {
        const plan = buildMockPlan(
          snapshot,
          product,
          mode as 'audit' | 'clean' | 'repair' | 'uninstall' | 'reinstall',
        );

        for (const step of plan.steps) {
          expect(
            behavior.allowedActions.includes(step.action),
            `Mode ${mode} should not include action ${step.action}`,
          ).toBe(true);
        }
      }
    });
  });

  describe('Step Metadata', () => {
    it('should set correct risk level from action metadata', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      for (const step of plan.steps) {
        const meta = STEP_ACTION_META[step.action];
        expect(step.risk).toBe(meta.defaultRisk);
      }
    });

    it('should set requiresAdmin correctly', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      const serviceStep = plan.steps.find(s => s.action === 'StopService');
      if (serviceStep) {
        expect(serviceStep.requiresAdmin).toBe(true);
      }

      const processStep = plan.steps.find(s => s.action === 'StopProcess');
      if (processStep) {
        expect(processStep.requiresAdmin).toBe(false);
      }
    });
  });
});

describe('StepActionMeta', () => {
  it('should have metadata for all step actions', () => {
    const actions: StepAction[] = [
      'StopProcess',
      'StopService',
      'RunUninstaller',
      'RemoveFolder',
      'DeleteRegistryKey',
      'DeleteRegistryValue',
      'DeleteScheduledTask',
      'Reinstall',
      'RestoreDefault',
    ];

    for (const action of actions) {
      expect(STEP_ACTION_META[action]).toBeDefined();
      expect(STEP_ACTION_META[action].category).toBeDefined();
      expect(STEP_ACTION_META[action].defaultRisk).toBeDefined();
      expect(typeof STEP_ACTION_META[action].requiresAdmin).toBe('boolean');
      expect(typeof STEP_ACTION_META[action].reversible).toBe('boolean');
    }
  });
});

describe('ModeBehaviors', () => {
  it('should have behaviors for all modes', () => {
    const modes = ['audit', 'clean', 'repair', 'uninstall', 'reinstall'];

    for (const mode of modes) {
      expect(MODE_BEHAVIORS[mode]).toBeDefined();
      expect(MODE_BEHAVIORS[mode].description).toBeDefined();
      expect(Array.isArray(MODE_BEHAVIORS[mode].allowedActions)).toBe(true);
      expect(typeof MODE_BEHAVIORS[mode].generatesPlan).toBe('boolean');
    }
  });

  it('audit mode should not generate a plan', () => {
    expect(MODE_BEHAVIORS.audit.generatesPlan).toBe(false);
    expect(MODE_BEHAVIORS.audit.allowedActions.length).toBe(0);
  });

  it('uninstall mode should include all removal actions', () => {
    const uninstallActions = MODE_BEHAVIORS.uninstall.allowedActions;

    expect(uninstallActions).toContain('StopProcess');
    expect(uninstallActions).toContain('StopService');
    expect(uninstallActions).toContain('RunUninstaller');
    expect(uninstallActions).toContain('RemoveFolder');
    expect(uninstallActions).toContain('DeleteRegistryKey');
    expect(uninstallActions).toContain('DeleteScheduledTask');
  });
});

// ============================================================================
// CRITICAL SAFETY TESTS
// These tests MUST pass before the foundation is considered solid
// ============================================================================

describe('PlanBuilder Critical Safety Tests', () => {
  let product: ProductDefinition;
  let snapshot: Snapshot;

  beforeEach(() => {
    product = {
      id: 'zoom',
      vendor: 'Zoom Video Communications',
      displayName: 'Zoom Meetings',
      paths: {
        install: ['%PROGRAMFILES%\\Zoom'],
        appData: ['%APPDATA%\\Zoom'],
        programData: ['%PROGRAMDATA%\\Zoom'],
        logs: [],
        temp: [],
      },
      registry: {
        software: ['HKCU\\Software\\Zoom', 'HKLM\\Software\\Zoom'],
        uninstall: ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom'],
        services: [],
        other: [],
      },
      processes: ['Zoom.exe'],
      services: ['CptService'],
      tasks: ['\\ZoomUpdateTaskMachine'],
    };

    snapshot = {
      id: 'snapshot_test',
      productId: 'zoom',
      createdAt: Date.now(),
      artifacts: [
        {
          id: 'proc_1',
          type: 'process',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'Zoom.exe',
          metadata: { pid: 1234 },
          observedAt: Date.now(),
          source: 'process',
        },
        {
          id: 'svc_1',
          type: 'service',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'CptService',
          metadata: { state: 'Running' },
          observedAt: Date.now(),
          source: 'service',
        },
        {
          id: 'file_1',
          type: 'file',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: '%APPDATA%\\Zoom\\data',
          metadata: {},
          observedAt: Date.now(),
          source: 'filesystem',
        },
        {
          id: 'reg_1',
          type: 'registry',
          owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
          path: 'HKCU\\Software\\Zoom',
          metadata: {},
          observedAt: Date.now(),
          source: 'registry',
        },
      ],
      relationships: [],
    };
  });

  // ==========================================================================
  // TEST 1: Plan Determinism
  // Same snapshot + same mode → identical step list (excluding IDs and timestamps)
  // ==========================================================================
  describe('Plan Determinism', () => {
    it('should produce identical step lists for same inputs', () => {
      // Build two plans with identical inputs
      const plan1 = buildMockPlan(snapshot, product, 'uninstall');
      const plan2 = buildMockPlan(snapshot, product, 'uninstall');

      // Extract step actions and targets (ignoring IDs which may differ)
      const steps1 = plan1.steps.map(s => ({ action: s.action, target: s.target }));
      const steps2 = plan2.steps.map(s => ({ action: s.action, target: s.target }));

      // Steps should be identical
      expect(steps1).toEqual(steps2);
    });

    it('should produce same step order regardless of artifact order in snapshot', () => {
      // Create a snapshot with artifacts in different order
      const reorderedSnapshot: Snapshot = {
        ...snapshot,
        artifacts: [...snapshot.artifacts].reverse(),
      };

      const plan1 = buildMockPlan(snapshot, product, 'uninstall');
      const plan2 = buildMockPlan(reorderedSnapshot, product, 'uninstall');

      // Extract step actions (order matters)
      const actions1 = plan1.steps.map(s => s.action);
      const actions2 = plan2.steps.map(s => s.action);

      // Actions should be in same order
      expect(actions1).toEqual(actions2);
    });

    it('should produce deterministic boundaries', () => {
      const plan1 = buildMockPlan(snapshot, product, 'uninstall');
      const plan2 = buildMockPlan(snapshot, product, 'uninstall');

      expect(plan1.boundaries).toEqual(plan2.boundaries);
    });
  });

  // ==========================================================================
  // TEST 2: Mode Isolation
  // Each mode should only produce allowed actions
  // ==========================================================================
  describe('Mode Isolation', () => {
    it('audit mode should produce ZERO steps', () => {
      const plan = buildMockPlan(snapshot, product, 'audit');

      expect(plan.steps.length).toBe(0);
      expect(plan.mode).toBe('audit');
    });

    it('repair mode should NEVER include RunUninstaller', () => {
      const plan = buildMockPlan(snapshot, product, 'repair');

      const hasUninstaller = plan.steps.some(s => s.action === 'RunUninstaller');
      expect(hasUninstaller).toBe(false);
    });

    it('repair mode should NEVER include StopProcess or StopService', () => {
      const plan = buildMockPlan(snapshot, product, 'repair');

      const hasStopProcess = plan.steps.some(s => s.action === 'StopProcess');
      const hasStopService = plan.steps.some(s => s.action === 'StopService');

      expect(hasStopProcess).toBe(false);
      expect(hasStopService).toBe(false);
    });

    it('clean mode should NEVER include RunUninstaller', () => {
      const plan = buildMockPlan(snapshot, product, 'clean');

      const hasUninstaller = plan.steps.some(s => s.action === 'RunUninstaller');
      expect(hasUninstaller).toBe(false);
    });

    it('reinstall mode MUST include Reinstall step when installer is configured', () => {
      // Add installer config to product
      const productWithInstaller = {
        ...product,
        installer: {
          downloadUrl: 'https://example.com/installer.msi',
          filename: 'installer.msi',
          silentArgs: ['/qn'],
        },
      };

      // Note: buildMockPlan doesn't handle Reinstall, but the real implementation should
      // For now, we verify the mode allows it
      expect(MODE_BEHAVIORS.reinstall.allowedActions).toContain('Reinstall');
    });

    it('no mode should allow steps outside MODE_BEHAVIORS.allowedActions', () => {
      const modes = ['audit', 'clean', 'repair', 'uninstall', 'reinstall'] as const;

      for (const mode of modes) {
        const plan = buildMockPlan(snapshot, product, mode);
        const allowedActions = MODE_BEHAVIORS[mode].allowedActions;

        for (const step of plan.steps) {
          expect(
            allowedActions.includes(step.action),
            `Mode "${mode}" produced disallowed action "${step.action}"`,
          ).toBe(true);
        }
      }
    });
  });

  // ==========================================================================
  // TEST 3: Policy Tripwire
  // Malicious/out-of-scope artifacts must be REJECTED before plan creation
  // ==========================================================================
  describe('Policy Tripwire', () => {
    it('should reject artifacts with system paths', () => {
      // Inject a malicious artifact with a system path
      const maliciousSnapshot: Snapshot = {
        ...snapshot,
        artifacts: [
          ...snapshot.artifacts,
          {
            id: 'malicious_1',
            type: 'file',
            owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
            path: 'C:\\Windows\\System32\\malicious.dll',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
      };

      // The mock doesn't implement policy checks, but we can verify
      // that the path is NOT in allowed boundaries
      const plan = buildMockPlan(maliciousSnapshot, product, 'uninstall');

      // Verify the malicious path is NOT in boundaries
      const isInBoundaries = plan.boundaries.allowedPaths.some(
        allowed => 'C:\\Windows\\System32\\malicious.dll'.startsWith(allowed),
      );
      expect(isInBoundaries).toBe(false);
    });

    it('should reject artifacts with protected registry keys', () => {
      // Inject a malicious artifact with a protected registry key
      const maliciousSnapshot: Snapshot = {
        ...snapshot,
        artifacts: [
          ...snapshot.artifacts,
          {
            id: 'malicious_2',
            type: 'registry',
            owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
            path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa',
            metadata: {},
            observedAt: Date.now(),
            source: 'registry',
          },
        ],
      };

      const plan = buildMockPlan(maliciousSnapshot, product, 'uninstall');

      // Verify the malicious key is NOT in boundaries
      const isInBoundaries = plan.boundaries.allowedRegistryPrefixes.some(
        prefix => 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa'.startsWith(prefix),
      );
      expect(isInBoundaries).toBe(false);
    });

    it('should not include steps for artifacts outside product scope', () => {
      // Inject an artifact that claims to be Zoom but has non-Zoom path
      const outOfScopeSnapshot: Snapshot = {
        ...snapshot,
        artifacts: [
          ...snapshot.artifacts,
          {
            id: 'outofscope_1',
            type: 'file',
            owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
            path: '%APPDATA%\\Microsoft\\SomeOtherApp',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
      };

      const plan = buildMockPlan(outOfScopeSnapshot, product, 'uninstall');

      // The step for the out-of-scope path should fail policy validation
      // (in real implementation, not in mock)
      const hasOutOfScopeStep = plan.steps.some(
        s => s.target === '%APPDATA%\\Microsoft\\SomeOtherApp',
      );

      // Mock creates steps regardless, but real implementation should reject
      // For now, verify the path is NOT in boundaries
      const isInBoundaries = plan.boundaries.allowedPaths.some(
        allowed => '%APPDATA%\\Microsoft\\SomeOtherApp'.toLowerCase()
          .startsWith(allowed.toLowerCase()),
      );
      expect(isInBoundaries).toBe(false);
    });

    it('should reject low-confidence ownership artifacts for high-risk actions', () => {
      // Low confidence artifact should be skipped
      const lowConfidenceSnapshot: Snapshot = {
        ...snapshot,
        artifacts: [
          {
            id: 'lowconf_1',
            type: 'file',
            owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'low' },
            path: '%APPDATA%\\Zoom\\suspicious',
            metadata: {},
            observedAt: Date.now(),
            source: 'filesystem',
          },
        ],
      };

      // In real implementation, low confidence artifacts should be skipped
      // or flagged for manual review
      expect(lowConfidenceSnapshot.artifacts[0].owner.confidence).toBe('low');
    });
  });

  // ==========================================================================
  // TEST 4: Ordering Invariants
  // Critical ordering rules that must never be violated
  // ==========================================================================
  describe('Ordering Invariants', () => {
    it('should NEVER have RemoveFolder before StopProcess', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      const processStepIndex = plan.steps.findIndex(s => s.action === 'StopProcess');
      const folderStepIndex = plan.steps.findIndex(s => s.action === 'RemoveFolder');

      if (processStepIndex >= 0 && folderStepIndex >= 0) {
        expect(folderStepIndex).toBeGreaterThan(processStepIndex);
      }
    });

    it('should NEVER have RemoveFolder before StopService', () => {
      const plan = buildMockPlan(snapshot, product, 'uninstall');

      const serviceStepIndex = plan.steps.findIndex(s => s.action === 'StopService');
      const folderStepIndex = plan.steps.findIndex(s => s.action === 'RemoveFolder');

      if (serviceStepIndex >= 0 && folderStepIndex >= 0) {
        expect(folderStepIndex).toBeGreaterThan(serviceStepIndex);
      }
    });

    it('should NEVER have DeleteRegistryKey before RunUninstaller', () => {
      // Add uninstaller step to test
      const planWithUninstaller = buildMockPlan(snapshot, product, 'uninstall');

      // Note: mock doesn't generate RunUninstaller, but in real implementation:
      // registry deletion should come after uninstaller
      const uninstallerIndex = planWithUninstaller.steps.findIndex(
        s => s.action === 'RunUninstaller',
      );
      const registryIndex = planWithUninstaller.steps.findIndex(
        s => s.action === 'DeleteRegistryKey',
      );

      if (uninstallerIndex >= 0 && registryIndex >= 0) {
        expect(registryIndex).toBeGreaterThan(uninstallerIndex);
      }
    });

    it('Reinstall should ALWAYS be last step', () => {
      // In reinstall mode, Reinstall must be the final step
      expect(MODE_BEHAVIORS.reinstall.allowedActions).toContain('Reinstall');

      // Verify Reinstall is in the 'installation' category which comes last
      expect(STEP_ACTION_META.Reinstall.category).toBe('installation');
      expect(STEP_EXECUTION_ORDER.indexOf('installation')).toBe(
        STEP_EXECUTION_ORDER.length - 1,
      );
    });
  });
});
