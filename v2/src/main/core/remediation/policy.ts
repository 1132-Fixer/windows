/**
 * Remediation Policy - Safety Boundaries
 *
 * This module enforces strict boundaries on what can be modified.
 * It is the primary safety mechanism preventing accidental or
 * malicious modification of system files/registry.
 */

import type { Artifact, Plan, PlanStep } from '../../../shared/types';
import type { ProductDefinition } from '../acquisition/types';

// ============================================================================
// Policy Errors
// ============================================================================

export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly code: PolicyErrorCode,
    public readonly target: string,
    public readonly allowedScope: string[],
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export type PolicyErrorCode =
  | 'PATH_OUTSIDE_ALLOWLIST'
  | 'REGISTRY_OUTSIDE_ALLOWLIST'
  | 'SERVICE_OUTSIDE_ALLOWLIST'
  | 'TASK_OUTSIDE_ALLOWLIST'
  | 'LOW_OWNERSHIP_CONFIDENCE'
  | 'SYSTEM_PATH_PROTECTED'
  | 'ACTION_NOT_ALLOWED_FOR_MODE';

// ============================================================================
// Protected System Paths (NEVER touch these)
// ============================================================================

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  // Windows core
  /^[A-Z]:\\Windows\\System32/i,
  /^[A-Z]:\\Windows\\SysWOW64/i,
  /^[A-Z]:\\Windows\\WinSxS/i,
  /^[A-Z]:\\Windows\\assembly/i,
  /^[A-Z]:\\Windows\\Microsoft\.NET/i,

  // System drives root
  /^[A-Z]:\\$/,

  // Program Files root (but not subdirectories)
  /^[A-Z]:\\Program Files\\?$/i,
  /^[A-Z]:\\Program Files \(x86\)\\?$/i,

  // User profile root
  /^[A-Z]:\\Users\\[^\\]+\\?$/i,

  // Boot and recovery
  /^[A-Z]:\\Boot/i,
  /^[A-Z]:\\Recovery/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^[A-Z]:\\System Volume Information/i,
];

const PROTECTED_REGISTRY_PATTERNS: RegExp[] = [
  // System hives
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa/i,
  /^HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot/i,

  // Boot configuration
  /^HKLM\\BCD/i,

  // Security
  /^HKLM\\SAM/i,
  /^HKLM\\SECURITY/i,

  // Core Windows
  /^HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows$/i,
  /^HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies$/i,

  // .NET Framework
  /^HKLM\\SOFTWARE\\Microsoft\\\.NETFramework/i,
];

// ============================================================================
// Remediation Policy Interface
// ============================================================================

export interface RemediationPolicy {
  /**
   * Assert that a file/folder path is within allowed boundaries
   * @throws PolicyViolationError if not allowed
   */
  assertAllowedPath(path: string, plan: Plan): void;

  /**
   * Assert that a registry key is within allowed boundaries
   * @throws PolicyViolationError if not allowed
   */
  assertAllowedRegistryKey(key: string, plan: Plan): void;

  /**
   * Assert that a service is within allowed boundaries
   * @throws PolicyViolationError if not allowed
   */
  assertAllowedService(serviceName: string, plan: Plan): void;

  /**
   * Assert that a scheduled task is within allowed boundaries
   * @throws PolicyViolationError if not allowed
   */
  assertAllowedTask(taskPath: string, plan: Plan): void;

  /**
   * Assert that an artifact has sufficient ownership confidence
   * for the requested action
   * @throws PolicyViolationError if confidence too low
   */
  assertOwnershipConfidence(
    artifact: Artifact,
    requiredConfidence: 'high' | 'medium' | 'low',
  ): void;

  /**
   * Validate entire plan against policy
   * @returns Array of policy warnings (non-blocking)
   * @throws PolicyViolationError on blocking violations
   */
  validatePlan(plan: Plan, product: ProductDefinition): string[];
}

// ============================================================================
// Default Policy Implementation
// ============================================================================

export class DefaultRemediationPolicy implements RemediationPolicy {
  private expandPath(path: string): string {
    // Expand common environment variables
    return path
      .replace(/%APPDATA%/gi, process.env.APPDATA || '')
      .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
      .replace(/%PROGRAMDATA%/gi, process.env.PROGRAMDATA || '')
      .replace(/%PROGRAMFILES%/gi, process.env.PROGRAMFILES || '')
      .replace(/%PROGRAMFILES\(X86\)%/gi, process.env['PROGRAMFILES(X86)'] || '')
      .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '')
      .replace(/%TEMP%/gi, process.env.TEMP || '')
      .replace(/%SYSTEMROOT%/gi, process.env.SYSTEMROOT || 'C:\\Windows');
  }

  private isProtectedPath(path: string): boolean {
    const expanded = this.expandPath(path);
    return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(expanded));
  }

  private isProtectedRegistry(key: string): boolean {
    return PROTECTED_REGISTRY_PATTERNS.some(pattern => pattern.test(key));
  }

  private isWithinAllowedPaths(path: string, allowedPaths: string[]): boolean {
    const expandedPath = this.expandPath(path).toLowerCase();

    return allowedPaths.some(allowed => {
      const expandedAllowed = this.expandPath(allowed).toLowerCase();
      return expandedPath.startsWith(expandedAllowed);
    });
  }

  private isWithinAllowedRegistryPrefixes(key: string, prefixes: string[]): boolean {
    const normalizedKey = key.toUpperCase();

    return prefixes.some(prefix => {
      const normalizedPrefix = prefix.toUpperCase();
      return normalizedKey.startsWith(normalizedPrefix);
    });
  }

  assertAllowedPath(path: string, plan: Plan): void {
    // First check if it's a protected system path
    if (this.isProtectedPath(path)) {
      throw new PolicyViolationError(
        `Path is a protected system location: ${path}`,
        'SYSTEM_PATH_PROTECTED',
        path,
        [],
      );
    }

    // Then check if it's within the plan's allowed boundaries
    if (!this.isWithinAllowedPaths(path, plan.boundaries.allowedPaths)) {
      throw new PolicyViolationError(
        `Path is outside allowed scope: ${path}`,
        'PATH_OUTSIDE_ALLOWLIST',
        path,
        plan.boundaries.allowedPaths,
      );
    }
  }

  assertAllowedRegistryKey(key: string, plan: Plan): void {
    // Check protected registry locations
    if (this.isProtectedRegistry(key)) {
      throw new PolicyViolationError(
        `Registry key is a protected system location: ${key}`,
        'SYSTEM_PATH_PROTECTED',
        key,
        [],
      );
    }

    // Check within allowed prefixes
    if (!this.isWithinAllowedRegistryPrefixes(key, plan.boundaries.allowedRegistryPrefixes)) {
      throw new PolicyViolationError(
        `Registry key is outside allowed scope: ${key}`,
        'REGISTRY_OUTSIDE_ALLOWLIST',
        key,
        plan.boundaries.allowedRegistryPrefixes,
      );
    }
  }

  assertAllowedService(serviceName: string, plan: Plan): void {
    const normalizedName = serviceName.toLowerCase();
    const allowed = plan.boundaries.allowedServices.map(s => s.toLowerCase());

    if (!allowed.includes(normalizedName)) {
      throw new PolicyViolationError(
        `Service is outside allowed scope: ${serviceName}`,
        'SERVICE_OUTSIDE_ALLOWLIST',
        serviceName,
        plan.boundaries.allowedServices,
      );
    }
  }

  assertAllowedTask(taskPath: string, plan: Plan): void {
    const normalizedPath = taskPath.toLowerCase();

    const isAllowed = plan.boundaries.allowedTasks.some(allowed => {
      const normalizedAllowed = allowed.toLowerCase();
      return normalizedPath.startsWith(normalizedAllowed) ||
             normalizedPath === normalizedAllowed;
    });

    if (!isAllowed) {
      throw new PolicyViolationError(
        `Scheduled task is outside allowed scope: ${taskPath}`,
        'TASK_OUTSIDE_ALLOWLIST',
        taskPath,
        plan.boundaries.allowedTasks,
      );
    }
  }

  assertOwnershipConfidence(
    artifact: Artifact,
    requiredConfidence: 'high' | 'medium' | 'low',
  ): void {
    const confidenceLevels = { high: 3, medium: 2, low: 1 };
    const artifactLevel = confidenceLevels[artifact.owner.confidence];
    const requiredLevel = confidenceLevels[requiredConfidence];

    if (artifactLevel < requiredLevel) {
      throw new PolicyViolationError(
        `Artifact ownership confidence (${artifact.owner.confidence}) is below required level (${requiredConfidence})`,
        'LOW_OWNERSHIP_CONFIDENCE',
        artifact.path || artifact.id,
        [],
      );
    }
  }

  validatePlan(plan: Plan, product: ProductDefinition): string[] {
    const warnings: string[] = [];

    // Validate all steps against policy
    for (const step of plan.steps) {
      try {
        this.validateStep(step, plan);
      } catch (error) {
        if (error instanceof PolicyViolationError) {
          // Re-throw blocking violations
          throw error;
        }
        warnings.push(`Step ${step.id}: ${error}`);
      }
    }

    // Check plan boundaries match product definition
    const productPaths = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
      ...product.paths.logs,
      ...product.paths.temp,
    ];

    for (const allowedPath of plan.boundaries.allowedPaths) {
      if (!productPaths.some(pp => this.expandPath(pp) === this.expandPath(allowedPath))) {
        warnings.push(`Allowed path "${allowedPath}" not in product definition`);
      }
    }

    return warnings;
  }

  private validateStep(step: PlanStep, plan: Plan): void {
    switch (step.action) {
      case 'RemoveFolder':
        this.assertAllowedPath(step.target, plan);
        break;
      case 'DeleteRegistryKey':
      case 'DeleteRegistryValue':
        this.assertAllowedRegistryKey(step.target, plan);
        break;
      case 'StopService':
        this.assertAllowedService(step.target, plan);
        break;
      case 'DeleteScheduledTask':
        this.assertAllowedTask(step.target, plan);
        break;
      // StopProcess, RunUninstaller, Reinstall, RestoreDefault
      // have their own validation logic in their step implementations
    }
  }
}

// ============================================================================
// Policy Factory
// ============================================================================

export function createPolicy(): RemediationPolicy {
  return new DefaultRemediationPolicy();
}
