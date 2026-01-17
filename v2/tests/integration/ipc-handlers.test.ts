/**
 * IPC Handlers Integration Tests
 *
 * Tests the complete IPC flow from handler through to response.
 * Uses mocked Electron IPC and adapters.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Electron before importing handlers
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  dialog: {
    showSaveDialog: vi.fn(() => ({ canceled: true })),
  },
  shell: {
    openPath: vi.fn(),
  },
  app: {
    getVersion: vi.fn(() => '2.0.0'),
  },
}));

// Import types
import type {
  AuditRunOptions,
  AuditResult,
  PlanBuildOptions,
  PlanBuildResult,
  ExecuteRunOptions,
  ExecutionResult,
  VerificationResult,
  MonitorStatus,
} from '../../src/main/ipc/channels';

// ============================================================================
// Test Utilities
// ============================================================================

// Store registered handlers
const registeredHandlers = new Map<string, Function>();

// Mock ipcMain.handle to capture handlers
vi.mocked(await import('electron')).ipcMain.handle.mockImplementation(
  (channel: string, handler: Function) => {
    registeredHandlers.set(channel, handler);
  },
);

// Helper to invoke handler
async function invokeHandler<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return handler({ sender: {} }, ...args) as Promise<T>;
}

// ============================================================================
// Tests
// ============================================================================

describe('IPC Handlers Integration', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
  });

  describe('Handler Registration', () => {
    it('should register all handlers without error', async () => {
      // Import will register handlers due to mock
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');

      // Should not throw
      expect(() => registerAllIpcHandlers()).not.toThrow();

      // Check core channels are registered
      expect(registeredHandlers.has('audit.run')).toBe(true);
      expect(registeredHandlers.has('plan.buildWithLanes')).toBe(true);
      expect(registeredHandlers.has('execute.run')).toBe(true);
      expect(registeredHandlers.has('verify.run')).toBe(true);
      expect(registeredHandlers.has('monitor.getStatus')).toBe(true);
      expect(registeredHandlers.has('report.list')).toBe(true);
    });
  });

  describe('Audit Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registerAllIpcHandlers();
    });

    it('should return error when audit already running', async () => {
      // Start first audit
      const firstAudit = invokeHandler<AuditResult>('audit.run', {
        productId: 'zoom',
      });

      // Try to start second audit immediately
      const secondResult = await invokeHandler<AuditResult>('audit.run', {
        productId: 'zoom',
      });

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain('already in progress');

      // Wait for first to complete
      await firstAudit;
    });

    it('should return status when no audit running', async () => {
      const status = await invokeHandler<{ running: boolean }>('audit.getStatus');

      expect(status).toHaveProperty('running');
      expect(typeof status.running).toBe('boolean');
    });

    it('should cancel running audit', async () => {
      const cancelResult = await invokeHandler<{ cancelled: boolean }>('audit.cancel');

      // Should return cancelled status (false if nothing running)
      expect(cancelResult).toHaveProperty('cancelled');
    });
  });

  describe('Plan Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return error when session not found', async () => {
      const result = await invokeHandler<PlanBuildResult>('plan.buildWithLanes', {
        sessionId: 'nonexistent',
        mode: 'clean',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.recommendation.lane).toBe('blocked');
    });

    it('should return null for nonexistent risk summary', async () => {
      const result = await invokeHandler<null>('plan.getRiskSummary', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for nonexistent current plan', async () => {
      const result = await invokeHandler<null>('plan.getCurrent', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('Execute Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return error when no plan exists', async () => {
      const result = await invokeHandler<ExecutionResult>('execute.run', {
        sessionId: 'nonexistent',
        lane: 'assisted',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No plan found');
    });

    it('should return empty timeline for nonexistent session', async () => {
      const timeline = await invokeHandler<[]>('execute.getTimeline', 'nonexistent');
      expect(timeline).toEqual([]);
    });

    it('should return cancelled false when nothing running', async () => {
      const result = await invokeHandler<{ cancelled: boolean }>('execute.cancel');
      expect(result.cancelled).toBe(false);
    });
  });

  describe('Verify Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return error when no execution result', async () => {
      const result = await invokeHandler<VerificationResult>('verify.run', 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.checks[0].passed).toBe(false);
    });

    it('should return null for nonexistent results', async () => {
      const result = await invokeHandler<null>('verify.getResults', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for nonexistent post-reboot status', async () => {
      const result = await invokeHandler<null>('verify.postRebootStatus', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('Monitor Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return status', async () => {
      const status = await invokeHandler<MonitorStatus>('monitor.getStatus');

      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('status');
      expect(status).toHaveProperty('cleanHours');
    });
  });

  describe('Report Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return empty list when no reports', async () => {
      const reports = await invokeHandler<[]>('report.list');
      expect(Array.isArray(reports)).toBe(true);
    });

    it('should return null for nonexistent report', async () => {
      const report = await invokeHandler<null>('report.get', 'nonexistent');
      expect(report).toBeNull();
    });

    it('should return error for nonexistent report export', async () => {
      const result = await invokeHandler<{ success: boolean; error?: string }>(
        'report.export',
        { sessionId: 'nonexistent', redacted: true },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('System Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should return system info', async () => {
      const info = await invokeHandler<{ osVersion: string; arch: string }>(
        'system.getInfo',
      );

      expect(info).toHaveProperty('osVersion');
      expect(info).toHaveProperty('arch');
      expect(info).toHaveProperty('elevated');
      expect(info).toHaveProperty('appVersion');
    });

    it('should check admin status', async () => {
      const result = await invokeHandler<{ elevated: boolean }>('system.checkAdmin');
      expect(result).toHaveProperty('elevated');
      expect(typeof result.elevated).toBe('boolean');
    });

    it('should return log path', async () => {
      const result = await invokeHandler<{ path: string }>('system.getLogPath');
      expect(result).toHaveProperty('path');
      expect(typeof result.path).toBe('string');
    });
  });

  describe('Product Handlers', () => {
    beforeEach(async () => {
      const { registerAllIpcHandlers } = await import('../../src/main/ipc');
      registeredHandlers.clear();
      registerAllIpcHandlers();
    });

    it('should list products', async () => {
      const products = await invokeHandler<Array<{ id: string; name: string }>>(
        'product.list',
      );

      expect(Array.isArray(products)).toBe(true);
      expect(products.length).toBeGreaterThan(0);
      expect(products[0]).toHaveProperty('id');
      expect(products[0]).toHaveProperty('name');
    });

    it('should get product by id', async () => {
      const product = await invokeHandler<{ id: string; name: string } | null>(
        'product.get',
        'zoom',
      );

      expect(product).not.toBeNull();
      expect(product?.id).toBe('zoom');
    });

    it('should return null for unknown product', async () => {
      const product = await invokeHandler<null>('product.get', 'unknown');
      expect(product).toBeNull();
    });
  });
});

describe('UIState', () => {
  describe('Phase Transitions', () => {
    it('should define valid transitions', async () => {
      const { PHASE_TRANSITIONS, canTransition } = await import(
        '../../src/renderer/state'
      );

      // Idle can go to audit
      expect(canTransition('idle', 'audit')).toBe(true);

      // Audit can go to findings or idle
      expect(canTransition('audit', 'findings')).toBe(true);
      expect(canTransition('audit', 'idle')).toBe(true);

      // Cannot skip phases
      expect(canTransition('idle', 'execute')).toBe(false);
      expect(canTransition('audit', 'done')).toBe(false);
    });
  });

  describe('State Updates', () => {
    it('should create valid audit start state', async () => {
      const { INITIAL_STATE, startAudit } = await import('../../src/renderer/state');

      const update = startAudit(INITIAL_STATE, 'zoom');

      expect(update.phase).toBe('audit');
      expect(update.loading).toBe(true);
      expect(update.error).toBeNull();
      expect(update.product?.id).toBe('zoom');
    });

    it('should create valid reset state', async () => {
      const { INITIAL_STATE, resetState } = await import('../../src/renderer/state');

      const reset = resetState();

      expect(reset).toEqual(INITIAL_STATE);
    });
  });

  describe('State Selectors', () => {
    it('should correctly check audit availability', async () => {
      const { INITIAL_STATE, canStartAudit } = await import('../../src/renderer/state');

      expect(canStartAudit(INITIAL_STATE)).toBe(true);
      expect(canStartAudit({ ...INITIAL_STATE, loading: true })).toBe(false);
      expect(canStartAudit({ ...INITIAL_STATE, phase: 'audit' })).toBe(false);
    });
  });
});
