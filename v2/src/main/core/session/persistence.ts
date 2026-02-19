/**
 * Session Persistence
 *
 * Handles storing and retrieving session data:
 * - Snapshots
 * - Plans
 * - Execution results
 * - Attestation reports
 *
 * Storage location: %LOCALAPPDATA%\CleanStateSentinel\sessions\
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { getAppDataPath, DATA_PATHS } from '../../../shared/branding';
import type { Plan, Snapshot } from '../../../shared/types';
import type { ExecutionResult } from '../execution/types';
import type {
  AttestationReport,
  SessionMetadata,
  RunSessionOutput,
} from './types';
import { redactReport } from './redaction';

/**
 * Persistence configuration
 */
export interface PersistenceConfig {
  /**
   * Base path for session storage
   * Default: %LOCALAPPDATA%\CleanStateSentinel\sessions
   */
  basePath: string;

  /**
   * Maximum number of sessions to keep
   * Default: 50
   */
  maxSessions: number;

  /**
   * Maximum age in days before cleanup
   * Default: 90
   */
  maxAgeDays: number;
}

/**
 * Default persistence configuration
 */
export const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
  basePath: path.join(getAppDataPath(), DATA_PATHS.SESSIONS),
  maxSessions: 50,
  maxAgeDays: 90,
};

/**
 * Expand environment variables in path
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Get the session directory path
 */
function getSessionDir(basePath: string, sessionId: string): string {
  return path.join(expandEnvVars(basePath), sessionId);
}

/**
 * Deterministic JSON serializer with stable key ordering
 */
export function stableStringify(obj: unknown, indent: number = 2): string {
  return JSON.stringify(obj, sortedReplacer, indent);
}

/**
 * Replacer function that sorts object keys
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as object)
      .sort()
      .reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = (value as Record<string, unknown>)[key];
        return sorted;
      }, {});
  }
  return value;
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Create the persistence layer
 */
export function createPersistence(config: Partial<PersistenceConfig> = {}) {
  const fullConfig: PersistenceConfig = {
    ...DEFAULT_PERSISTENCE_CONFIG,
    ...config,
  };

  return {
    /**
     * Save a complete session
     */
    async saveSession(output: RunSessionOutput): Promise<void> {
      const sessionDir = getSessionDir(fullConfig.basePath, output.sessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      // Save pre-snapshot
      const preSnapshotPath = path.join(sessionDir, 'pre-snapshot.json');
      await fs.writeFile(preSnapshotPath, stableStringify(output.preSnapshot));

      // Save plan
      const planPath = path.join(sessionDir, 'plan.json');
      await fs.writeFile(planPath, stableStringify(output.plan));

      // Save execution result (if present)
      let executionPath: string | undefined;
      if (output.execution) {
        executionPath = path.join(sessionDir, 'execution.json');
        await fs.writeFile(executionPath, stableStringify(output.execution));
      }

      // Save post-snapshot (if present)
      let postSnapshotPath: string | undefined;
      if (output.postSnapshot) {
        postSnapshotPath = path.join(sessionDir, 'post-snapshot.json');
        await fs.writeFile(postSnapshotPath, stableStringify(output.postSnapshot));
      }

      // Save verification (if present)
      if (output.verification) {
        const verificationPath = path.join(sessionDir, 'verification.json');
        await fs.writeFile(verificationPath, stableStringify(output.verification));
      }

      // Save report (internal, non-redacted)
      const reportPath = path.join(sessionDir, 'report.json');
      await fs.writeFile(reportPath, stableStringify(output.report));

      // Save metadata
      const metadata: SessionMetadata = {
        sessionId: output.sessionId,
        productId: output.plan.productId,
        mode: output.report.session.mode,
        status: output.report.status,
        createdAt: output.timing.startedAt,
        completedAt: output.timing.completedAt,
        reportPath,
        preSnapshotPath,
        postSnapshotPath,
        planPath,
        executionPath,
      };

      const metadataPath = path.join(sessionDir, 'metadata.json');
      await fs.writeFile(metadataPath, stableStringify(metadata));
    },

    /**
     * Load session metadata
     */
    async loadMetadata(sessionId: string): Promise<SessionMetadata | null> {
      const metadataPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'metadata.json'
      );

      try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Load a session report
     */
    async loadReport(sessionId: string): Promise<AttestationReport | null> {
      const reportPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'report.json'
      );

      try {
        const content = await fs.readFile(reportPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Load a session's pre-snapshot
     */
    async loadPreSnapshot(sessionId: string): Promise<Snapshot | null> {
      const snapshotPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'pre-snapshot.json'
      );

      try {
        const content = await fs.readFile(snapshotPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Load a session's post-snapshot
     */
    async loadPostSnapshot(sessionId: string): Promise<Snapshot | null> {
      const snapshotPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'post-snapshot.json'
      );

      try {
        const content = await fs.readFile(snapshotPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Load a session's plan
     */
    async loadPlan(sessionId: string): Promise<Plan | null> {
      const planPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'plan.json'
      );

      try {
        const content = await fs.readFile(planPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Load a session's execution result
     */
    async loadExecution(sessionId: string): Promise<ExecutionResult | null> {
      const executionPath = path.join(
        getSessionDir(fullConfig.basePath, sessionId),
        'execution.json'
      );

      try {
        const content = await fs.readFile(executionPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * List all sessions
     */
    async listSessions(): Promise<SessionMetadata[]> {
      const basePath = expandEnvVars(fullConfig.basePath);

      try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        const sessions: SessionMetadata[] = [];

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const metadata = await this.loadMetadata(entry.name);
            if (metadata) {
              sessions.push(metadata);
            }
          }
        }

        // Sort by creation time, newest first
        sessions.sort((a, b) => b.createdAt - a.createdAt);

        return sessions;
      } catch {
        return [];
      }
    },

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<boolean> {
      const sessionDir = getSessionDir(fullConfig.basePath, sessionId);

      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Export a redacted report to a file
     */
    async exportReport(
      sessionId: string,
      outputPath: string,
      options: { redact: boolean } = { redact: true }
    ): Promise<void> {
      const report = await this.loadReport(sessionId);
      if (!report) {
        throw new Error(`Session ${sessionId} not found`);
      }

      const exportReport = options.redact ? redactReport(report) : report;
      await fs.writeFile(outputPath, stableStringify(exportReport));
    },

    /**
     * Clean up old sessions
     */
    async cleanup(): Promise<{ deleted: number }> {
      const sessions = await this.listSessions();
      const cutoffTime = Date.now() - fullConfig.maxAgeDays * 24 * 60 * 60 * 1000;
      let deleted = 0;

      // Delete sessions older than max age
      for (const session of sessions) {
        if (session.createdAt < cutoffTime) {
          if (await this.deleteSession(session.sessionId)) {
            deleted++;
          }
        }
      }

      // Delete excess sessions (keep only maxSessions)
      const remainingSessions = await this.listSessions();
      if (remainingSessions.length > fullConfig.maxSessions) {
        const toDelete = remainingSessions.slice(fullConfig.maxSessions);
        for (const session of toDelete) {
          if (await this.deleteSession(session.sessionId)) {
            deleted++;
          }
        }
      }

      return { deleted };
    },

    /**
     * Get storage statistics
     */
    async getStats(): Promise<{
      sessionCount: number;
      totalSize: number;
      oldestSession: number | null;
      newestSession: number | null;
    }> {
      const sessions = await this.listSessions();

      let totalSize = 0;
      const basePath = expandEnvVars(fullConfig.basePath);

      try {
        totalSize = await calculateDirSize(basePath);
      } catch {
        // Ignore errors
      }

      return {
        sessionCount: sessions.length,
        totalSize,
        oldestSession: sessions.length > 0 ? sessions[sessions.length - 1].createdAt : null,
        newestSession: sessions.length > 0 ? sessions[0].createdAt : null,
      };
    },
  };
}

/**
 * Calculate directory size recursively
 */
async function calculateDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await calculateDirSize(entryPath);
      } else {
        const stat = await fs.stat(entryPath);
        totalSize += stat.size;
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize;
}

/**
 * In-memory persistence for testing
 */
export function createInMemoryPersistence() {
  const sessions = new Map<string, RunSessionOutput>();

  return {
    async saveSession(output: RunSessionOutput): Promise<void> {
      sessions.set(output.sessionId, output);
    },

    async loadMetadata(sessionId: string): Promise<SessionMetadata | null> {
      const session = sessions.get(sessionId);
      if (!session) return null;

      return {
        sessionId: session.sessionId,
        productId: session.plan.productId,
        mode: session.report.session.mode,
        status: session.report.status,
        createdAt: session.timing.startedAt,
        completedAt: session.timing.completedAt,
        reportPath: `/mock/${sessionId}/report.json`,
        preSnapshotPath: `/mock/${sessionId}/pre-snapshot.json`,
        postSnapshotPath: session.postSnapshot
          ? `/mock/${sessionId}/post-snapshot.json`
          : undefined,
        planPath: `/mock/${sessionId}/plan.json`,
        executionPath: session.execution
          ? `/mock/${sessionId}/execution.json`
          : undefined,
      };
    },

    async loadReport(sessionId: string): Promise<AttestationReport | null> {
      return sessions.get(sessionId)?.report || null;
    },

    async loadPreSnapshot(sessionId: string): Promise<Snapshot | null> {
      return sessions.get(sessionId)?.preSnapshot || null;
    },

    async loadPostSnapshot(sessionId: string): Promise<Snapshot | null> {
      return sessions.get(sessionId)?.postSnapshot || null;
    },

    async loadPlan(sessionId: string): Promise<Plan | null> {
      return sessions.get(sessionId)?.plan || null;
    },

    async loadExecution(sessionId: string): Promise<ExecutionResult | null> {
      return sessions.get(sessionId)?.execution || null;
    },

    async listSessions(): Promise<SessionMetadata[]> {
      const metadatas: SessionMetadata[] = [];
      for (const sessionId of sessions.keys()) {
        const metadata = await this.loadMetadata(sessionId);
        if (metadata) metadatas.push(metadata);
      }
      return metadatas.sort((a, b) => b.createdAt - a.createdAt);
    },

    async deleteSession(sessionId: string): Promise<boolean> {
      return sessions.delete(sessionId);
    },

    async exportReport(
      sessionId: string,
      _outputPath: string,
      options: { redact: boolean } = { redact: true }
    ): Promise<void> {
      const report = await this.loadReport(sessionId);
      if (!report) {
        throw new Error(`Session ${sessionId} not found`);
      }
      // In memory, we don't actually write to disk
      if (options.redact) {
        redactReport(report);
      }
    },

    async cleanup(): Promise<{ deleted: number }> {
      return { deleted: 0 };
    },

    async getStats(): Promise<{
      sessionCount: number;
      totalSize: number;
      oldestSession: number | null;
      newestSession: number | null;
    }> {
      const list = await this.listSessions();
      return {
        sessionCount: list.length,
        totalSize: 0,
        oldestSession: list.length > 0 ? list[list.length - 1].createdAt : null,
        newestSession: list.length > 0 ? list[0].createdAt : null,
      };
    },
  };
}
