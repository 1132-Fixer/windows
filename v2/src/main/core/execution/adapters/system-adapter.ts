/**
 * System Adapter Interface
 *
 * Abstracts OS-level operations for:
 * - Testing (mock adapter)
 * - Windows runtime (real adapter)
 *
 * All system mutations go through this interface,
 * making the StepEngine testable and auditable.
 */

// ============================================================================
// Filesystem Adapter
// ============================================================================

export interface FilesystemAdapter {
  /**
   * Check if a path exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Check if a path is a directory
   */
  isDirectory(path: string): Promise<boolean>;

  /**
   * Get directory contents
   */
  readdir(path: string): Promise<string[]>;

  /**
   * Get file/folder stats
   */
  stat(path: string): Promise<FileStats>;

  /**
   * Move a file or folder
   */
  move(source: string, destination: string): Promise<void>;

  /**
   * Delete a file or folder recursively
   */
  remove(path: string): Promise<void>;

  /**
   * Create directory (recursive)
   */
  mkdir(path: string): Promise<void>;

  /**
   * Copy a file or folder
   */
  copy(source: string, destination: string): Promise<void>;

  /**
   * Calculate total size of a directory
   */
  calculateSize(path: string): Promise<number>;
}

export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  created: Date;
  modified: Date;
}

// ============================================================================
// Registry Adapter
// ============================================================================

export interface RegistryAdapter {
  /**
   * Check if a registry key exists
   */
  keyExists(keyPath: string): Promise<boolean>;

  /**
   * Get all values in a registry key
   */
  getValues(keyPath: string): Promise<Record<string, RegistryValue>>;

  /**
   * Get a specific registry value
   */
  getValue(keyPath: string, valueName: string): Promise<RegistryValue | null>;

  /**
   * Export a registry key to a .reg file
   */
  exportKey(keyPath: string, filePath: string): Promise<void>;

  /**
   * Import a .reg file
   */
  importKey(filePath: string): Promise<void>;

  /**
   * Delete a registry key and all subkeys
   */
  deleteKey(keyPath: string): Promise<void>;

  /**
   * Delete a specific registry value
   */
  deleteValue(keyPath: string, valueName: string): Promise<void>;

  /**
   * Get subkey names
   */
  getSubkeys(keyPath: string): Promise<string[]>;
}

export interface RegistryValue {
  name: string;
  type: string;
  data: unknown;
}

// ============================================================================
// Process Adapter
// ============================================================================

export interface ProcessAdapter {
  /**
   * List running processes
   */
  list(): Promise<ProcessInfo[]>;

  /**
   * Get processes by name
   */
  getByName(name: string): Promise<ProcessInfo[]>;

  /**
   * Get a specific process by PID
   */
  getByPid(pid: number): Promise<ProcessInfo | null>;

  /**
   * Terminate a process gracefully (WM_CLOSE)
   */
  terminateGracefully(pid: number, timeoutMs: number): Promise<boolean>;

  /**
   * Force terminate a process
   */
  terminateForce(pid: number): Promise<void>;

  /**
   * Check if a process is running
   */
  isRunning(pid: number): Promise<boolean>;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  executablePath?: string;
  commandLine?: string;
  parentPid?: number;
  startTime?: Date;
}

// ============================================================================
// Service Adapter
// ============================================================================

export interface ServiceAdapter {
  /**
   * List all services
   */
  list(): Promise<ServiceInfo[]>;

  /**
   * Get a service by name
   */
  get(serviceName: string): Promise<ServiceInfo | null>;

  /**
   * Stop a service
   */
  stop(serviceName: string, timeoutMs: number): Promise<void>;

  /**
   * Start a service
   */
  start(serviceName: string): Promise<void>;

  /**
   * Get service state
   */
  getState(serviceName: string): Promise<ServiceState>;

  /**
   * Check if a service exists
   */
  exists(serviceName: string): Promise<boolean>;

  /**
   * Delete a service (unregister)
   */
  delete(serviceName: string): Promise<void>;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  state: ServiceState;
  startType: string;
  binaryPath: string;
  account?: string;
}

export type ServiceState =
  | 'Running'
  | 'Stopped'
  | 'StartPending'
  | 'StopPending'
  | 'Paused'
  | 'Unknown';

// ============================================================================
// Task Scheduler Adapter
// ============================================================================

export interface TaskSchedulerAdapter {
  /**
   * Check if a task exists
   */
  exists(taskPath: string): Promise<boolean>;

  /**
   * Get task info
   */
  get(taskPath: string): Promise<ScheduledTaskInfo | null>;

  /**
   * Delete a scheduled task
   */
  delete(taskPath: string): Promise<void>;

  /**
   * Disable a scheduled task
   */
  disable(taskPath: string): Promise<void>;
}

export interface ScheduledTaskInfo {
  name: string;
  path: string;
  enabled: boolean;
  state: string;
  lastRun?: Date;
  nextRun?: Date;
}

// ============================================================================
// Exec Adapter (for running commands)
// ============================================================================

export interface ExecAdapter {
  /**
   * Execute a command and wait for completion
   */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  /**
   * Execute PowerShell script
   */
  execPowerShell(script: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Spawn a process (detached)
   */
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<number>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  elevated?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions extends ExecOptions {
  detached?: boolean;
}

// ============================================================================
// Combined System Adapter
// ============================================================================

/**
 * Combined adapter for all system operations
 */
export interface SystemAdapter {
  filesystem: FilesystemAdapter;
  registry: RegistryAdapter;
  process: ProcessAdapter;
  service: ServiceAdapter;
  taskScheduler: TaskSchedulerAdapter;
  exec: ExecAdapter;
}
