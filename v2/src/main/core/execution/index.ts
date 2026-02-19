/**
 * Execution Module Index
 *
 * Exports StepEngine and related types for executing remediation plans.
 */

// Core types
export type {
  StepEngine,
  StepHandler,
  ExecutionContext,
  ExecutionResult,
  StepResult,
  PrecheckResult,
  StepEvent,
  StepBackup,
  StepBackupStore,
  FolderQuarantineBackup,
  RegistryExportBackup,
  ManifestBackup,
  ExecutionOptions,
  TimeoutConfig,
} from './types';

export {
  DEFAULT_EXECUTION_OPTIONS,
  DEFAULT_TIMEOUTS,
} from './types';

// System adapter
export type {
  SystemAdapter,
  FilesystemAdapter,
  RegistryAdapter,
  ProcessAdapter,
  ServiceAdapter,
  TaskSchedulerAdapter,
  ExecAdapter,
  FileInfo,
  RegistryValue,
  ProcessInfo,
  ServiceInfo,
  ScheduledTask,
} from './adapters/system-adapter';

// Mock adapter for testing
export {
  createMockSystemAdapter,
  type MockSystemState,
} from './adapters/mock-adapter';

// Step handlers
export {
  createStepHandlerRegistry,
  getHandler,
  type StepHandlerRegistry,
  createStopProcessHandler,
  createStopServiceHandler,
  createRemoveFolderHandler,
  createDeleteRegistryKeyHandler,
  createDeleteScheduledTaskHandler,
} from './steps';

// Backup store
export {
  createBackupStore,
  createInMemoryBackupStore,
  loadBackupManifest,
  listBackupManifests,
  cleanupOldBackups,
  DEFAULT_BACKUP_CONFIG,
  type BackupManifest,
  type BackupStoreConfig,
} from './backup-store';

// Main engine
export {
  createStepEngine,
  createDryRunEngine,
  type StepEngineConfig,
} from './step-engine';
