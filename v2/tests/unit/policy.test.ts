/**
 * Policy Tests
 * Verify that safety boundaries are enforced correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultRemediationPolicy,
  PolicyViolationError,
  type RemediationPolicy,
} from '../../src/main/core/remediation/policy';
import type { Plan, Artifact } from '../../src/shared/types';

describe('RemediationPolicy', () => {
  let policy: RemediationPolicy;
  let basePlan: Plan;

  beforeEach(() => {
    policy = new DefaultRemediationPolicy();

    basePlan = {
      id: 'test_plan',
      productId: 'zoom',
      mode: 'uninstall',
      createdAt: Date.now(),
      dryRun: false,
      steps: [],
      boundaries: {
        allowedPaths: [
          '%APPDATA%\\Zoom',
          '%LOCALAPPDATA%\\Zoom',
          '%PROGRAMFILES%\\Zoom',
          '%PROGRAMDATA%\\Zoom',
        ],
        allowedRegistryPrefixes: [
          'HKCU\\Software\\Zoom',
          'HKLM\\Software\\Zoom',
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
        ],
        allowedServices: ['CptService', 'ZoomCptService'],
        allowedTasks: ['\\Zoom', '\\ZoomUpdateTaskMachine'],
      },
    };
  });

  describe('assertAllowedPath', () => {
    it('should allow paths within vendor scope', () => {
      expect(() => {
        policy.assertAllowedPath('%APPDATA%\\Zoom\\data\\config.json', basePlan);
      }).not.toThrow();

      expect(() => {
        policy.assertAllowedPath('%PROGRAMFILES%\\Zoom\\bin\\Zoom.exe', basePlan);
      }).not.toThrow();
    });

    it('should reject paths outside vendor scope', () => {
      expect(() => {
        policy.assertAllowedPath('%APPDATA%\\Microsoft\\config.json', basePlan);
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedPath('C:\\OtherApp\\data.txt', basePlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject protected system paths', () => {
      // Even if somehow added to allowlist, system paths should be rejected
      const dangerousPlan = {
        ...basePlan,
        boundaries: {
          ...basePlan.boundaries,
          allowedPaths: ['C:\\Windows\\System32'],
        },
      };

      expect(() => {
        policy.assertAllowedPath('C:\\Windows\\System32\\cmd.exe', dangerousPlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject Windows directory', () => {
      expect(() => {
        policy.assertAllowedPath('C:\\Windows\\System32\\drivers\\etc\\hosts', basePlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject boot and recovery paths', () => {
      expect(() => {
        policy.assertAllowedPath('C:\\Boot\\BCD', basePlan);
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedPath('C:\\Recovery\\WindowsRE', basePlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject root drive paths', () => {
      expect(() => {
        policy.assertAllowedPath('C:\\', basePlan);
      }).toThrow(PolicyViolationError);
    });
  });

  describe('assertAllowedRegistryKey', () => {
    it('should allow registry keys within vendor scope', () => {
      expect(() => {
        policy.assertAllowedRegistryKey('HKCU\\Software\\Zoom\\Settings', basePlan);
      }).not.toThrow();

      expect(() => {
        policy.assertAllowedRegistryKey(
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zoom',
          basePlan,
        );
      }).not.toThrow();
    });

    it('should reject registry keys outside vendor scope', () => {
      expect(() => {
        policy.assertAllowedRegistryKey('HKCU\\Software\\Microsoft\\Windows', basePlan);
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedRegistryKey('HKLM\\Software\\OtherVendor', basePlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject protected system registry keys', () => {
      expect(() => {
        policy.assertAllowedRegistryKey(
          'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager',
          basePlan,
        );
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedRegistryKey('HKLM\\SAM', basePlan);
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedRegistryKey('HKLM\\SECURITY', basePlan);
      }).toThrow(PolicyViolationError);
    });

    it('should reject LSA security keys', () => {
      expect(() => {
        policy.assertAllowedRegistryKey(
          'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Security Packages',
          basePlan,
        );
      }).toThrow(PolicyViolationError);
    });
  });

  describe('assertAllowedService', () => {
    it('should allow services in the allowlist', () => {
      expect(() => {
        policy.assertAllowedService('CptService', basePlan);
      }).not.toThrow();

      expect(() => {
        policy.assertAllowedService('ZoomCptService', basePlan);
      }).not.toThrow();
    });

    it('should be case-insensitive', () => {
      expect(() => {
        policy.assertAllowedService('cptservice', basePlan);
      }).not.toThrow();

      expect(() => {
        policy.assertAllowedService('CPTSERVICE', basePlan);
      }).not.toThrow();
    });

    it('should reject services not in allowlist', () => {
      expect(() => {
        policy.assertAllowedService('SomeOtherService', basePlan);
      }).toThrow(PolicyViolationError);

      expect(() => {
        policy.assertAllowedService('wuauserv', basePlan);
      }).toThrow(PolicyViolationError);
    });
  });

  describe('assertAllowedTask', () => {
    it('should allow tasks in the allowlist', () => {
      expect(() => {
        policy.assertAllowedTask('\\Zoom', basePlan);
      }).not.toThrow();

      expect(() => {
        policy.assertAllowedTask('\\ZoomUpdateTaskMachine', basePlan);
      }).not.toThrow();
    });

    it('should allow subtasks under allowed paths', () => {
      expect(() => {
        policy.assertAllowedTask('\\Zoom\\SubTask', basePlan);
      }).not.toThrow();
    });

    it('should reject tasks not in allowlist', () => {
      expect(() => {
        policy.assertAllowedTask('\\Microsoft\\Windows\\UpdateTask', basePlan);
      }).toThrow(PolicyViolationError);
    });
  });

  describe('assertOwnershipConfidence', () => {
    it('should allow high confidence for high requirement', () => {
      const artifact: Artifact = {
        id: 'test',
        type: 'file',
        owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'high' },
        metadata: {},
        observedAt: Date.now(),
        source: 'filesystem',
      };

      expect(() => {
        policy.assertOwnershipConfidence(artifact, 'high');
      }).not.toThrow();
    });

    it('should reject low confidence for high requirement', () => {
      const artifact: Artifact = {
        id: 'test',
        type: 'file',
        owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'low' },
        metadata: {},
        observedAt: Date.now(),
        source: 'filesystem',
      };

      expect(() => {
        policy.assertOwnershipConfidence(artifact, 'high');
      }).toThrow(PolicyViolationError);
    });

    it('should allow medium confidence for medium requirement', () => {
      const artifact: Artifact = {
        id: 'test',
        type: 'file',
        owner: { vendor: 'Zoom', product: 'Zoom', confidence: 'medium' },
        metadata: {},
        observedAt: Date.now(),
        source: 'filesystem',
      };

      expect(() => {
        policy.assertOwnershipConfidence(artifact, 'medium');
      }).not.toThrow();
    });
  });
});

describe('PolicyViolationError', () => {
  it('should include violation details', () => {
    const error = new PolicyViolationError(
      'Path is outside allowed scope',
      'PATH_OUTSIDE_ALLOWLIST',
      'C:\\SomePath',
      ['%APPDATA%\\Zoom'],
    );

    expect(error.code).toBe('PATH_OUTSIDE_ALLOWLIST');
    expect(error.target).toBe('C:\\SomePath');
    expect(error.allowedScope).toEqual(['%APPDATA%\\Zoom']);
    expect(error.message).toBe('Path is outside allowed scope');
  });
});
