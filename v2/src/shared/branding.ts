/**
 * Branding Constants
 *
 * Centralized product identity for CleanState Sentinel.
 * Import from here instead of hardcoding names/paths.
 */

/**
 * Product identity
 */
export const PRODUCT = {
  /**
   * Full product name (UI display)
   */
  NAME: 'CleanState Sentinel',

  /**
   * Short name (file paths, identifiers)
   */
  SHORT_NAME: 'CleanStateSentinel',

  /**
   * CLI/package name
   */
  CLI_NAME: 'cleanstate-sentinel',

  /**
   * App ID for Electron
   */
  APP_ID: 'com.cleanstate.sentinel',

  /**
   * Vendor/Author
   */
  VENDOR: 'High Texas',

  /**
   * Product description
   */
  DESCRIPTION: 'Forensic-grade software remediation platform with attestation reporting',

  /**
   * Current version
   */
  VERSION: '2.0.0',

  /**
   * Report schema version
   */
  SCHEMA_VERSION: '1.1.0' as const,
} as const;

/**
 * Legacy product identity (for migration)
 */
export const LEGACY_PRODUCT = {
  NAME: '1132 Remover',
  SHORT_NAME: '1132-Remover',
  APP_ID: 'com.jg2547.1132remover',
} as const;

/**
 * Data directory paths
 */
export const DATA_PATHS = {
  /**
   * Root directory name in LOCALAPPDATA
   */
  ROOT_DIR: 'CleanStateSentinel',

  /**
   * Subdirectories
   */
  SESSIONS: 'sessions',
  REPORTS: 'reports',
  MONITORING: 'monitoring',
  QUARANTINE: 'quarantine',
  LOGS: 'logs',
  POST_REBOOT: 'post-reboot-verify',

  /**
   * Legacy root directory
   */
  LEGACY_ROOT_DIR: '1132-Remover',
} as const;

/**
 * Windows Scheduled Task names
 */
export const TASK_NAMES = {
  /**
   * Post-reboot verification task
   */
  POST_REBOOT_VERIFY: 'CleanStateSentinel_PostRebootVerify',

  /**
   * Monitoring task
   */
  MONITORING: 'CleanStateSentinel_Monitor',

  /**
   * Legacy task names (for cleanup)
   */
  LEGACY: {
    POST_REBOOT_VERIFY: '1132Remover_PostRebootVerify',
  },
} as const;

/**
 * UI text constants
 */
export const UI_TEXT = {
  /**
   * Window title
   */
  WINDOW_TITLE: 'CleanState Sentinel',

  /**
   * Tagline
   */
  TAGLINE: 'Forensic Remediation Platform',

  /**
   * Trust statement (footer)
   */
  TRUST_STATEMENT: 'CleanState Sentinel performs local inspection, remediation, and verification. No system data is transmitted.',

  /**
   * About text
   */
  ABOUT: 'CleanState Sentinel is a forensic-grade software remediation platform that provides auditable, reversible, and verifiable cleanup operations.',
} as const;

/**
 * File names
 */
export const FILE_NAMES = {
  /**
   * Migration marker file
   */
  MIGRATION_MARKER: '.migrated-from-1132',

  /**
   * Monitoring baseline
   */
  MONITORING_BASELINE: 'baseline.json',

  /**
   * Post-reboot context
   */
  POST_REBOOT_CONTEXT: 'context.json',

  /**
   * Alert storage
   */
  ALERTS: 'alerts.json',
} as const;

/**
 * Get full path to app data directory
 */
export function getAppDataPath(): string {
  const localAppData = process.env.LOCALAPPDATA ||
    require('path').join(require('os').homedir(), 'AppData', 'Local');
  return require('path').join(localAppData, DATA_PATHS.ROOT_DIR);
}

/**
 * Get full path to a subdirectory
 */
export function getDataSubPath(subdir: keyof typeof DATA_PATHS): string {
  const value = DATA_PATHS[subdir];
  if (typeof value !== 'string' || subdir === 'ROOT_DIR' || subdir === 'LEGACY_ROOT_DIR') {
    throw new Error(`Invalid subdir: ${subdir}`);
  }
  return require('path').join(getAppDataPath(), value);
}
