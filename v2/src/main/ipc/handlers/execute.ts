/**
 * Execute IPC Handlers
 *
 * Handles execution operations: run, get timeline, cancel.
 * Executes remediation plans with real-time progress updates.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import {
  IPC_CHANNELS,
  type ExecuteRunOptions,
  type ExecutionResult,
  type ExecutionTimelineEntry,
  type ExecutionProgressEvent,
  type ExecutionStepEvent,
} from '../channels';
import { getPlanState } from './plan';
import { createStepEngine } from '../../core/execution';
import type { Plan, PlanStep } from '../../../../shared/types';

// ============================================================================
// State
// ============================================================================

interface ExecutionState {
  running: boolean;
  sessionId?: string;
  cancelled: boolean;
  timeline: ExecutionTimelineEntry[];
  startedAt?: number;
}

let currentExecution: ExecutionState = {
  running: false,
  cancelled: false,
  timeline: [],
};

const executionStore = new Map<string, ExecutionResult>();

// ============================================================================
// Helpers
// ============================================================================

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

function sendProgress(event: ExecutionProgressEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.EVENT_EXECUTION_PROGRESS, event);
  }
}

function sendStepEvent(event: ExecutionStepEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.EVENT_EXECUTION_STEP, event);
  }
}

/**
 * Generate confirmation token for assisted lane
 */
function generateConfirmationToken(sessionId: string, lane: string): string {
  return `confirm_${sessionId}_${lane}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Validate confirmation token for assisted lane
 */
function validateConfirmationToken(
  token: string | undefined,
  sessionId: string,
  lane: string,
): boolean {
  // For autopilot, no token required
  if (lane === 'autopilot') {
    return true;
  }

  // For assisted, require a valid token format
  if (!token) {
    return false;
  }

  // Simple validation - in production, would check against issued tokens
  return token.startsWith(`confirm_${sessionId}_${lane}_`);
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Run execution
 */
async function handleExecuteRun(
  _event: Electron.IpcMainInvokeEvent,
  options: ExecuteRunOptions,
): Promise<ExecutionResult> {
  // Prevent concurrent executions
  if (currentExecution.running) {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: 'Execution already in progress',
    };
  }

  // Get plan state
  const planState = getPlanState(options.sessionId);
  if (!planState) {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: 'No plan found. Build a plan first.',
    };
  }

  // Check recommendation allows this lane
  if (planState.recommendation.lane === 'blocked') {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: `Execution blocked: ${planState.recommendation.reason}`,
    };
  }

  // Validate lane selection
  if (options.lane === 'autopilot' && !planState.recommendation.autopilotAvailable) {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: 'Autopilot not available for this session',
    };
  }

  // Validate confirmation token for assisted lane
  if (!validateConfirmationToken(options.confirmationToken, options.sessionId, options.lane)) {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: 'Invalid or missing confirmation token for assisted mode',
    };
  }

  // Select plan based on lane
  const plan = options.lane === 'autopilot'
    ? planState.autopilotPlan
    : planState.assistedPlan;

  if (!plan || plan.steps.length === 0) {
    return {
      success: false,
      sessionId: options.sessionId,
      timeline: [],
      totalDurationMs: 0,
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: `No steps to execute in ${options.lane} lane`,
    };
  }

  try {
    currentExecution = {
      running: true,
      sessionId: options.sessionId,
      cancelled: false,
      timeline: [],
      startedAt: Date.now(),
    };

    // Initialize timeline with pending steps
    currentExecution.timeline = plan.steps.map((step) => ({
      stepId: step.id,
      action: step.action,
      target: step.target,
      status: 'pending' as const,
    }));

    let stepsSucceeded = 0;
    let stepsFailed = 0;
    let stepsSkipped = 0;

    // Execute each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      // Check for cancellation
      if (currentExecution.cancelled) {
        // Mark remaining steps as skipped
        for (let j = i; j < plan.steps.length; j++) {
          currentExecution.timeline[j].status = 'skipped';
          stepsSkipped++;
        }
        break;
      }

      // Update step to running
      currentExecution.timeline[i].status = 'running';
      currentExecution.timeline[i].startedAt = Date.now();

      // Send progress event
      sendProgress({
        sessionId: options.sessionId,
        progress: Math.round((i / plan.steps.length) * 100),
        currentStepId: step.id,
        stepsCompleted: i,
        totalSteps: plan.steps.length,
      });

      sendStepEvent({
        sessionId: options.sessionId,
        stepId: step.id,
        status: 'started',
      });

      try {
        // Simulate step execution
        // In real implementation, would call actual step engine
        await simulateStepExecution(step);

        currentExecution.timeline[i].status = 'success';
        currentExecution.timeline[i].completedAt = Date.now();
        currentExecution.timeline[i].durationMs =
          currentExecution.timeline[i].completedAt! - currentExecution.timeline[i].startedAt!;
        currentExecution.timeline[i].message = 'Completed successfully';
        stepsSucceeded++;

        sendStepEvent({
          sessionId: options.sessionId,
          stepId: step.id,
          status: 'completed',
          durationMs: currentExecution.timeline[i].durationMs,
        });
      } catch (stepError) {
        currentExecution.timeline[i].status = 'failed';
        currentExecution.timeline[i].completedAt = Date.now();
        currentExecution.timeline[i].durationMs =
          currentExecution.timeline[i].completedAt! - currentExecution.timeline[i].startedAt!;
        currentExecution.timeline[i].message =
          stepError instanceof Error ? stepError.message : 'Step failed';
        stepsFailed++;

        sendStepEvent({
          sessionId: options.sessionId,
          stepId: step.id,
          status: 'failed',
          message: currentExecution.timeline[i].message,
          durationMs: currentExecution.timeline[i].durationMs,
        });

        // Continue on failure for now
        // In production, would check options.continueOnFailure
      }
    }

    // Final progress
    sendProgress({
      sessionId: options.sessionId,
      progress: 100,
      currentStepId: '',
      stepsCompleted: plan.steps.length,
      totalSteps: plan.steps.length,
    });

    const totalDurationMs = Date.now() - currentExecution.startedAt!;

    const result: ExecutionResult = {
      success: stepsFailed === 0,
      sessionId: options.sessionId,
      timeline: currentExecution.timeline,
      totalDurationMs,
      stepsSucceeded,
      stepsFailed,
      stepsSkipped,
    };

    // Store result
    executionStore.set(options.sessionId, result);

    currentExecution.running = false;
    return result;
  } catch (error) {
    currentExecution.running = false;

    return {
      success: false,
      sessionId: options.sessionId,
      timeline: currentExecution.timeline,
      totalDurationMs: Date.now() - (currentExecution.startedAt || Date.now()),
      stepsSucceeded: 0,
      stepsFailed: 0,
      stepsSkipped: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Simulate step execution (placeholder for real implementation)
 */
async function simulateStepExecution(step: PlanStep): Promise<void> {
  // Simulate execution time based on action type
  const delays: Record<string, number> = {
    StopProcess: 100,
    StopService: 200,
    RunUninstaller: 1000,
    RemoveFolder: 300,
    DeleteRegistryKey: 100,
    DeleteRegistryValue: 50,
    DeleteScheduledTask: 150,
    Reinstall: 2000,
    RestoreDefault: 50,
  };

  const delay = delays[step.action] || 100;
  await new Promise((resolve) => setTimeout(resolve, delay));

  // Simulate occasional failures for testing
  // In production, would execute actual step
  if (Math.random() < 0.05) {
    throw new Error('Simulated step failure');
  }
}

/**
 * Get execution timeline
 */
async function handleExecuteGetTimeline(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<ExecutionTimelineEntry[]> {
  // Check current execution first
  if (currentExecution.sessionId === sessionId) {
    return currentExecution.timeline;
  }

  // Check stored results
  const stored = executionStore.get(sessionId);
  return stored?.timeline || [];
}

/**
 * Cancel execution
 */
async function handleExecuteCancel(): Promise<{ cancelled: boolean }> {
  if (!currentExecution.running) {
    return { cancelled: false };
  }

  currentExecution.cancelled = true;
  return { cancelled: true };
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all execute IPC handlers
 */
export function registerExecuteHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EXECUTE_RUN, handleExecuteRun);
  ipcMain.handle(IPC_CHANNELS.EXECUTE_GET_TIMELINE, handleExecuteGetTimeline);
  ipcMain.handle(IPC_CHANNELS.EXECUTE_CANCEL, handleExecuteCancel);
}

/**
 * Get execution result (for use by verify handler)
 */
export function getExecutionResult(sessionId: string) {
  return executionStore.get(sessionId);
}

/**
 * Generate a confirmation token for the UI
 */
export function createConfirmationToken(sessionId: string, lane: 'autopilot' | 'assisted'): string {
  return generateConfirmationToken(sessionId, lane);
}
