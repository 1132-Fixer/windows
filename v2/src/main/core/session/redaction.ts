/**
 * Redaction Utility
 *
 * Provides safe export of reports by redacting sensitive information:
 * - Usernames in paths
 * - Hostnames
 * - Registry values that look like tokens/keys
 * - Command line arguments
 *
 * Conservative approach: redact more rather than less.
 */

import type { AttestationReport } from './types';

/**
 * Patterns for sensitive data detection
 */
const SENSITIVE_PATTERNS = {
  // API keys, tokens, secrets (common patterns)
  apiKey: /(?:api[_-]?key|token|secret|password|auth|bearer)[=:]\s*["']?[\w\-\.]+["']?/gi,

  // Base64-encoded strings (potential tokens)
  base64Token: /[A-Za-z0-9+/]{40,}={0,2}/g,

  // JWT tokens
  jwt: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,

  // UUIDs (might be session IDs)
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,

  // Email addresses
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // IP addresses (internal)
  internalIp: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
};

/**
 * Get current username for redaction
 */
function getCurrentUsername(): string {
  return process.env.USERNAME || process.env.USER || 'user';
}

/**
 * Get current hostname for redaction
 */
function getCurrentHostname(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'computer';
}

/**
 * Redact username from a path
 */
export function redactPath(path: string): string {
  const username = getCurrentUsername();

  // Case-insensitive replacement of username in paths
  const usernamePattern = new RegExp(
    `(C:\\\\Users\\\\)${escapeRegex(username)}(\\\\|$)`,
    'gi'
  );

  let redacted = path.replace(usernamePattern, '$1%USERNAME%$2');

  // Also handle forward slashes
  const usernamePatternFwd = new RegExp(
    `(C:/Users/)${escapeRegex(username)}(/|$)`,
    'gi'
  );
  redacted = redacted.replace(usernamePatternFwd, '$1%USERNAME%$2');

  // Redact AppData paths
  redacted = redacted.replace(
    /C:\\Users\\[^\\]+\\AppData/gi,
    'C:\\Users\\%USERNAME%\\AppData'
  );

  return redacted;
}

/**
 * Redact hostname
 */
export function redactHostname(text: string): string {
  const hostname = getCurrentHostname();

  if (hostname.length < 3) return text; // Too short to safely redact

  return text.replace(
    new RegExp(escapeRegex(hostname), 'gi'),
    '%COMPUTERNAME%'
  );
}

/**
 * Redact username
 */
export function redactUsername(text: string): string {
  const username = getCurrentUsername();

  if (username.length < 3) return text; // Too short to safely redact

  return text.replace(
    new RegExp(`\\b${escapeRegex(username)}\\b`, 'gi'),
    '%USERNAME%'
  );
}

/**
 * Redact potential secrets from a string
 */
export function redactSecrets(text: string): string {
  let redacted = text;

  // Redact API keys and tokens
  redacted = redacted.replace(SENSITIVE_PATTERNS.apiKey, '[REDACTED_KEY]');

  // Redact JWTs
  redacted = redacted.replace(SENSITIVE_PATTERNS.jwt, '[REDACTED_JWT]');

  // Redact long base64 strings (likely tokens)
  redacted = redacted.replace(SENSITIVE_PATTERNS.base64Token, '[REDACTED_TOKEN]');

  // Redact emails
  redacted = redacted.replace(SENSITIVE_PATTERNS.email, '[REDACTED_EMAIL]');

  // Redact internal IPs
  redacted = redacted.replace(SENSITIVE_PATTERNS.internalIp, '[REDACTED_IP]');

  return redacted;
}

/**
 * Redact registry value data
 */
export function redactRegistryValue(value: string): string {
  let redacted = redactPath(value);
  redacted = redactUsername(redacted);
  redacted = redactHostname(redacted);
  redacted = redactSecrets(redacted);
  return redacted;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deep clone an object
 */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Redact all strings in an object recursively
 */
function redactObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    let redacted = redactPath(obj);
    redacted = redactUsername(redacted);
    redacted = redactHostname(redacted);
    redacted = redactSecrets(redacted);
    return redacted;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item));
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObject(value);
    }
    return result;
  }

  return obj;
}

/**
 * Redact an attestation report for safe export
 */
export function redactReport(report: AttestationReport): AttestationReport {
  // Deep clone to avoid mutating original
  const redacted = deepClone(report);

  // Mark as redacted
  redacted.redacted = true;

  // Redact environment
  redacted.environment.username = '%USERNAME%';
  redacted.environment.hostname = '%COMPUTERNAME%';

  // Redact paths in plan boundaries
  redacted.plan.boundaries.allowedPaths = redacted.plan.boundaries.allowedPaths.map(
    p => redactPath(p)
  );

  // Redact pre-snapshot (if paths are included)
  // Note: snapshot summaries don't include raw paths, but examples might

  // Redact execution step targets
  if (redacted.execution) {
    redacted.execution.stepResults = redacted.execution.stepResults.map(step => ({
      ...step,
      target: redactPath(step.target),
      message: redactPath(redactSecrets(step.message)),
    }));
  }

  // Redact diff examples
  if (redacted.diff) {
    redacted.diff.examples.filesRemoved = redacted.diff.examples.filesRemoved.map(
      p => redactPath(p)
    );
    redacted.diff.examples.foldersRemoved = redacted.diff.examples.foldersRemoved.map(
      p => redactPath(p)
    );
    redacted.diff.examples.registryKeysRemoved = redacted.diff.examples.registryKeysRemoved.map(
      p => redactPath(p)
    );
  }

  // Redact quarantine paths
  if (redacted.quarantine) {
    redacted.quarantine.rootPath = redactPath(redacted.quarantine.rootPath);
    redacted.quarantine.manifests = redacted.quarantine.manifests.map(m => ({
      ...m,
      description: redactPath(m.description),
    }));
    redacted.quarantine.restoreNotes = redactPath(redacted.quarantine.restoreNotes);
  }

  // Redact advisories
  redacted.advisories = redacted.advisories.map(a => ({
    ...a,
    message: redactPath(redactSecrets(a.message)),
  }));

  return redacted;
}

/**
 * Check if a report is safe to export (no obvious sensitive data)
 */
export function checkReportSafety(report: AttestationReport): {
  safe: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const reportJson = JSON.stringify(report);

  const username = getCurrentUsername();
  const hostname = getCurrentHostname();

  // Check for username
  if (username.length >= 3 && reportJson.toLowerCase().includes(username.toLowerCase())) {
    warnings.push('Report may contain username');
  }

  // Check for hostname
  if (hostname.length >= 3 && reportJson.toLowerCase().includes(hostname.toLowerCase())) {
    warnings.push('Report may contain hostname');
  }

  // Check for potential secrets
  if (SENSITIVE_PATTERNS.jwt.test(reportJson)) {
    warnings.push('Report may contain JWT tokens');
  }

  if (SENSITIVE_PATTERNS.apiKey.test(reportJson)) {
    warnings.push('Report may contain API keys or tokens');
  }

  if (SENSITIVE_PATTERNS.email.test(reportJson)) {
    warnings.push('Report may contain email addresses');
  }

  return {
    safe: warnings.length === 0,
    warnings,
  };
}

/**
 * Create a minimal safe summary for public sharing
 */
export function createPublicSummary(report: AttestationReport): {
  status: string;
  productName: string;
  mode: string;
  stepsExecuted: number;
  stepsSucceeded: number;
  stepsFailed: number;
  verificationPassed: boolean | null;
  timestamp: string;
} {
  return {
    status: report.status,
    productName: report.product.name,
    mode: report.session.mode,
    stepsExecuted: report.execution?.stepResults.length ?? 0,
    stepsSucceeded: report.execution?.stepResults.filter(s => s.status === 'success').length ?? 0,
    stepsFailed: report.execution?.stepResults.filter(s => s.status === 'failed').length ?? 0,
    verificationPassed: report.verification?.passed ?? null,
    timestamp: new Date(report.environment.timestamp).toISOString(),
  };
}
