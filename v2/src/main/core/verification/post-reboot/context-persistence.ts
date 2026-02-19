/**
 * Post-Reboot Verification Context Persistence
 *
 * Stores verification contexts to disk so they survive reboot.
 * Contexts are stored in %LOCALAPPDATA%\CleanStateSentinel\post-reboot-verify\
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { PostRebootVerificationContext, PostRebootVerificationResult } from './types';
import { getAppDataPath, DATA_PATHS } from '../../../../shared/branding';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default storage path
 */
export function getDefaultStoragePath(): string {
  return path.join(getAppDataPath(), DATA_PATHS.POST_REBOOT);
}

/**
 * Persistence configuration
 */
export interface ContextPersistenceConfig {
  storagePath: string;
}

// ============================================================================
// Context Persistence
// ============================================================================

/**
 * Create context persistence layer
 */
export function createContextPersistence(config?: Partial<ContextPersistenceConfig>) {
  const storagePath = config?.storagePath ?? getDefaultStoragePath();

  /**
   * Ensure storage directory exists
   */
  async function ensureStorageDir(): Promise<void> {
    await fs.mkdir(storagePath, { recursive: true });
  }

  /**
   * Get context file path
   */
  function getContextPath(contextId: string): string {
    return path.join(storagePath, `${contextId}.context.json`);
  }

  /**
   * Get result file path
   */
  function getResultPath(contextId: string): string {
    return path.join(storagePath, `${contextId}.result.json`);
  }

  return {
    /**
     * Save a verification context
     */
    async saveContext(context: PostRebootVerificationContext): Promise<void> {
      await ensureStorageDir();
      const filePath = getContextPath(context.contextId);
      await fs.writeFile(filePath, JSON.stringify(context, null, 2), 'utf-8');
    },

    /**
     * Load a verification context
     */
    async loadContext(contextId: string): Promise<PostRebootVerificationContext | null> {
      const filePath = getContextPath(contextId);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Delete a verification context
     */
    async deleteContext(contextId: string): Promise<boolean> {
      const filePath = getContextPath(contextId);
      try {
        await fs.unlink(filePath);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * List all pending contexts
     */
    async listContexts(): Promise<PostRebootVerificationContext[]> {
      await ensureStorageDir();
      const contexts: PostRebootVerificationContext[] = [];

      try {
        const entries = await fs.readdir(storagePath);
        for (const entry of entries) {
          if (entry.endsWith('.context.json')) {
            const contextId = entry.replace('.context.json', '');
            const context = await this.loadContext(contextId);
            if (context) {
              contexts.push(context);
            }
          }
        }
      } catch {
        // Directory may not exist yet
      }

      return contexts;
    },

    /**
     * Save a verification result
     */
    async saveResult(result: PostRebootVerificationResult): Promise<void> {
      await ensureStorageDir();
      const filePath = getResultPath(result.contextId);
      await fs.writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
    },

    /**
     * Load a verification result
     */
    async loadResult(contextId: string): Promise<PostRebootVerificationResult | null> {
      const filePath = getResultPath(contextId);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },

    /**
     * Delete a verification result
     */
    async deleteResult(contextId: string): Promise<boolean> {
      const filePath = getResultPath(contextId);
      try {
        await fs.unlink(filePath);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * List all results
     */
    async listResults(): Promise<PostRebootVerificationResult[]> {
      await ensureStorageDir();
      const results: PostRebootVerificationResult[] = [];

      try {
        const entries = await fs.readdir(storagePath);
        for (const entry of entries) {
          if (entry.endsWith('.result.json')) {
            const contextId = entry.replace('.result.json', '');
            const result = await this.loadResult(contextId);
            if (result) {
              results.push(result);
            }
          }
        }
      } catch {
        // Directory may not exist yet
      }

      return results;
    },

    /**
     * Clean up expired contexts (no result, past expiration)
     */
    async cleanupExpired(): Promise<{ removed: number }> {
      const contexts = await this.listContexts();
      const now = Date.now();
      let removed = 0;

      for (const context of contexts) {
        if (context.expiresAt < now) {
          // Context has expired
          await this.deleteContext(context.contextId);
          await this.deleteResult(context.contextId);
          removed++;
        }
      }

      return { removed };
    },

    /**
     * Get storage path
     */
    getStoragePath(): string {
      return storagePath;
    },

    /**
     * Check if a context exists
     */
    async exists(contextId: string): Promise<boolean> {
      const context = await this.loadContext(contextId);
      return context !== null;
    },

    /**
     * Get pending contexts (scheduled but not yet verified)
     */
    async getPendingContexts(): Promise<PostRebootVerificationContext[]> {
      const contexts = await this.listContexts();
      const results = await this.listResults();
      const resultIds = new Set(results.map(r => r.contextId));
      const now = Date.now();

      return contexts.filter(ctx =>
        !resultIds.has(ctx.contextId) && ctx.expiresAt > now
      );
    },
  };
}

/**
 * Type for the context persistence layer
 */
export type ContextPersistence = ReturnType<typeof createContextPersistence>;
