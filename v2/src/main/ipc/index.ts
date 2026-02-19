/**
 * IPC Module Index
 *
 * Centralized IPC management for Electron main process.
 * Registers all handlers and exports channel definitions.
 */

import {
  registerAuditHandlers,
  registerPlanHandlers,
  registerExecuteHandlers,
  registerVerifyHandlers,
  registerMonitorHandlers,
  registerReportHandlers,
  registerSystemHandlers,
} from './handlers';

// Re-export channels and types
export * from './channels';

// Re-export handler utilities
export {
  getSessionData,
  setSessionData,
  getPlanState,
  getExecutionResult,
  createConfirmationToken,
  setPostRebootStatus,
  getVerificationState,
} from './handlers';

/**
 * Register all IPC handlers
 *
 * Call this once during app initialization.
 * Handlers are registered on ipcMain and will respond to
 * ipcRenderer.invoke() calls from the preload script.
 */
export function registerAllIpcHandlers(): void {
  registerAuditHandlers();
  registerPlanHandlers();
  registerExecuteHandlers();
  registerVerifyHandlers();
  registerMonitorHandlers();
  registerReportHandlers();
  registerSystemHandlers();
}

/**
 * IPC Security Notes
 *
 * 1. All handlers use ipcMain.handle() for request/response pattern
 * 2. Renderer can only call methods exposed via preload
 * 3. Renderer never passes raw paths or shell commands
 * 4. Renderer only selects from predefined options (lane, product ID)
 * 5. Confirmation tokens required for destructive operations
 * 6. No dynamic IPC channel creation
 */
