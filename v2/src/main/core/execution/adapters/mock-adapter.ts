/**
 * Mock System Adapter
 *
 * In-memory implementation for testing StepEngine
 * without touching the real operating system.
 */

import type {
  SystemAdapter,
  FilesystemAdapter,
  RegistryAdapter,
  ProcessAdapter,
  ServiceAdapter,
  TaskSchedulerAdapter,
  ExecAdapter,
  FileStats,
  RegistryValue,
  ProcessInfo,
  ServiceInfo,
  ServiceState,
  ScheduledTaskInfo,
  ExecOptions,
  ExecResult,
  SpawnOptions,
} from './system-adapter';

// ============================================================================
// Mock Filesystem
// ============================================================================

export class MockFilesystemAdapter implements FilesystemAdapter {
  private files = new Map<string, MockFileEntry>();

  constructor(initialFiles?: Record<string, MockFileEntry>) {
    if (initialFiles) {
      for (const [path, entry] of Object.entries(initialFiles)) {
        this.files.set(this.normalizePath(path), entry);
      }
    }
  }

  private normalizePath(path: string): string {
    return path.toLowerCase().replace(/\//g, '\\');
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);
    return this.files.has(normalized) ||
      Array.from(this.files.keys()).some(k => k.startsWith(normalized + '\\'));
  }

  async isDirectory(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path);
    const entry = this.files.get(normalized);
    return entry?.isDirectory ?? false;
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = this.normalizePath(path);
    const prefix = normalized + '\\';
    const children = new Set<string>();

    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const relative = key.slice(prefix.length);
        const firstPart = relative.split('\\')[0];
        children.add(firstPart);
      }
    }

    return Array.from(children);
  }

  async stat(path: string): Promise<FileStats> {
    const normalized = this.normalizePath(path);
    const entry = this.files.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    return {
      isFile: !entry.isDirectory,
      isDirectory: entry.isDirectory,
      size: entry.size ?? 0,
      created: entry.created ?? new Date(),
      modified: entry.modified ?? new Date(),
    };
  }

  async move(source: string, destination: string): Promise<void> {
    const normalizedSource = this.normalizePath(source);
    const normalizedDest = this.normalizePath(destination);

    // Move all entries starting with source
    const toMove: [string, MockFileEntry][] = [];
    for (const [key, value] of this.files.entries()) {
      if (key === normalizedSource || key.startsWith(normalizedSource + '\\')) {
        toMove.push([key, value]);
      }
    }

    for (const [key] of toMove) {
      this.files.delete(key);
    }

    for (const [key, value] of toMove) {
      const newKey = key === normalizedSource
        ? normalizedDest
        : normalizedDest + key.slice(normalizedSource.length);
      this.files.set(newKey, value);
    }
  }

  async remove(path: string): Promise<void> {
    const normalized = this.normalizePath(path);

    // Remove all entries starting with path
    const toRemove: string[] = [];
    for (const key of this.files.keys()) {
      if (key === normalized || key.startsWith(normalized + '\\')) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.files.delete(key);
    }
  }

  async mkdir(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    this.files.set(normalized, { isDirectory: true });
  }

  async copy(source: string, destination: string): Promise<void> {
    const normalizedSource = this.normalizePath(source);
    const normalizedDest = this.normalizePath(destination);

    for (const [key, value] of this.files.entries()) {
      if (key === normalizedSource || key.startsWith(normalizedSource + '\\')) {
        const newKey = key === normalizedSource
          ? normalizedDest
          : normalizedDest + key.slice(normalizedSource.length);
        this.files.set(newKey, { ...value });
      }
    }
  }

  async calculateSize(path: string): Promise<number> {
    const normalized = this.normalizePath(path);
    let totalSize = 0;

    for (const [key, value] of this.files.entries()) {
      if (key === normalized || key.startsWith(normalized + '\\')) {
        totalSize += value.size ?? 0;
      }
    }

    return totalSize;
  }

  // Test helpers
  addFile(path: string, entry: MockFileEntry): void {
    this.files.set(this.normalizePath(path), entry);
  }

  getFiles(): Map<string, MockFileEntry> {
    return new Map(this.files);
  }
}

interface MockFileEntry {
  isDirectory: boolean;
  size?: number;
  created?: Date;
  modified?: Date;
  content?: string;
}

// ============================================================================
// Mock Registry
// ============================================================================

export class MockRegistryAdapter implements RegistryAdapter {
  private keys = new Map<string, Map<string, RegistryValue>>();
  private exports = new Map<string, string>();

  constructor(initialKeys?: Record<string, Record<string, unknown>>) {
    if (initialKeys) {
      for (const [keyPath, values] of Object.entries(initialKeys)) {
        const valueMap = new Map<string, RegistryValue>();
        for (const [name, data] of Object.entries(values)) {
          valueMap.set(name, { name, type: 'REG_SZ', data });
        }
        this.keys.set(this.normalizePath(keyPath), valueMap);
      }
    }
  }

  private normalizePath(path: string): string {
    return path.toLowerCase();
  }

  async keyExists(keyPath: string): Promise<boolean> {
    return this.keys.has(this.normalizePath(keyPath));
  }

  async getValues(keyPath: string): Promise<Record<string, RegistryValue>> {
    const normalized = this.normalizePath(keyPath);
    const values = this.keys.get(normalized);
    if (!values) return {};

    const result: Record<string, RegistryValue> = {};
    for (const [name, value] of values.entries()) {
      result[name] = value;
    }
    return result;
  }

  async getValue(keyPath: string, valueName: string): Promise<RegistryValue | null> {
    const normalized = this.normalizePath(keyPath);
    const values = this.keys.get(normalized);
    return values?.get(valueName) ?? null;
  }

  async exportKey(keyPath: string, filePath: string): Promise<void> {
    const normalized = this.normalizePath(keyPath);
    const values = this.keys.get(normalized);

    // Simulate export
    const exportContent = JSON.stringify({
      keyPath,
      values: values ? Object.fromEntries(values) : {},
    });
    this.exports.set(filePath.toLowerCase(), exportContent);
  }

  async importKey(filePath: string): Promise<void> {
    const content = this.exports.get(filePath.toLowerCase());
    if (!content) {
      throw new Error(`Export file not found: ${filePath}`);
    }

    const data = JSON.parse(content);
    const valueMap = new Map<string, RegistryValue>();
    for (const [name, value] of Object.entries(data.values)) {
      valueMap.set(name, value as RegistryValue);
    }
    this.keys.set(this.normalizePath(data.keyPath), valueMap);
  }

  async deleteKey(keyPath: string): Promise<void> {
    const normalized = this.normalizePath(keyPath);

    // Delete key and all subkeys
    const toDelete: string[] = [];
    for (const key of this.keys.keys()) {
      if (key === normalized || key.startsWith(normalized + '\\')) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.keys.delete(key);
    }
  }

  async deleteValue(keyPath: string, valueName: string): Promise<void> {
    const normalized = this.normalizePath(keyPath);
    const values = this.keys.get(normalized);
    values?.delete(valueName);
  }

  async getSubkeys(keyPath: string): Promise<string[]> {
    const normalized = this.normalizePath(keyPath);
    const prefix = normalized + '\\';
    const subkeys = new Set<string>();

    for (const key of this.keys.keys()) {
      if (key.startsWith(prefix)) {
        const relative = key.slice(prefix.length);
        const firstPart = relative.split('\\')[0];
        subkeys.add(firstPart);
      }
    }

    return Array.from(subkeys);
  }

  // Test helpers
  addKey(keyPath: string, values: Record<string, unknown>): void {
    const valueMap = new Map<string, RegistryValue>();
    for (const [name, data] of Object.entries(values)) {
      valueMap.set(name, { name, type: 'REG_SZ', data });
    }
    this.keys.set(this.normalizePath(keyPath), valueMap);
  }

  getKeys(): Map<string, Map<string, RegistryValue>> {
    return new Map(this.keys);
  }
}

// ============================================================================
// Mock Process
// ============================================================================

export class MockProcessAdapter implements ProcessAdapter {
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 1000;

  constructor(initialProcesses?: ProcessInfo[]) {
    if (initialProcesses) {
      for (const proc of initialProcesses) {
        this.processes.set(proc.pid, proc);
      }
    }
  }

  async list(): Promise<ProcessInfo[]> {
    return Array.from(this.processes.values());
  }

  async getByName(name: string): Promise<ProcessInfo[]> {
    const normalizedName = name.toLowerCase();
    return Array.from(this.processes.values()).filter(
      p => p.name.toLowerCase() === normalizedName,
    );
  }

  async getByPid(pid: number): Promise<ProcessInfo | null> {
    return this.processes.get(pid) ?? null;
  }

  async terminateGracefully(pid: number, _timeoutMs: number): Promise<boolean> {
    if (this.processes.has(pid)) {
      this.processes.delete(pid);
      return true;
    }
    return false;
  }

  async terminateForce(pid: number): Promise<void> {
    this.processes.delete(pid);
  }

  async isRunning(pid: number): Promise<boolean> {
    return this.processes.has(pid);
  }

  // Test helpers
  addProcess(info: Partial<ProcessInfo> & { name: string }): number {
    const pid = info.pid ?? this.nextPid++;
    this.processes.set(pid, {
      pid,
      name: info.name,
      executablePath: info.executablePath,
      commandLine: info.commandLine,
      parentPid: info.parentPid,
      startTime: info.startTime,
    });
    return pid;
  }

  getProcesses(): Map<number, ProcessInfo> {
    return new Map(this.processes);
  }
}

// ============================================================================
// Mock Service
// ============================================================================

export class MockServiceAdapter implements ServiceAdapter {
  private services = new Map<string, ServiceInfo>();

  constructor(initialServices?: ServiceInfo[]) {
    if (initialServices) {
      for (const svc of initialServices) {
        this.services.set(svc.name.toLowerCase(), svc);
      }
    }
  }

  async list(): Promise<ServiceInfo[]> {
    return Array.from(this.services.values());
  }

  async get(serviceName: string): Promise<ServiceInfo | null> {
    return this.services.get(serviceName.toLowerCase()) ?? null;
  }

  async stop(serviceName: string, _timeoutMs: number): Promise<void> {
    const normalized = serviceName.toLowerCase();
    const svc = this.services.get(normalized);
    if (svc) {
      this.services.set(normalized, { ...svc, state: 'Stopped' });
    }
  }

  async start(serviceName: string): Promise<void> {
    const normalized = serviceName.toLowerCase();
    const svc = this.services.get(normalized);
    if (svc) {
      this.services.set(normalized, { ...svc, state: 'Running' });
    }
  }

  async getState(serviceName: string): Promise<ServiceState> {
    const svc = this.services.get(serviceName.toLowerCase());
    return svc?.state ?? 'Unknown';
  }

  async exists(serviceName: string): Promise<boolean> {
    return this.services.has(serviceName.toLowerCase());
  }

  async delete(serviceName: string): Promise<void> {
    this.services.delete(serviceName.toLowerCase());
  }

  // Test helpers
  addService(info: ServiceInfo): void {
    this.services.set(info.name.toLowerCase(), info);
  }

  getServices(): Map<string, ServiceInfo> {
    return new Map(this.services);
  }
}

// ============================================================================
// Mock Task Scheduler
// ============================================================================

export class MockTaskSchedulerAdapter implements TaskSchedulerAdapter {
  private tasks = new Map<string, ScheduledTaskInfo>();

  constructor(initialTasks?: ScheduledTaskInfo[]) {
    if (initialTasks) {
      for (const task of initialTasks) {
        this.tasks.set(task.path.toLowerCase(), task);
      }
    }
  }

  async exists(taskPath: string): Promise<boolean> {
    return this.tasks.has(taskPath.toLowerCase());
  }

  async get(taskPath: string): Promise<ScheduledTaskInfo | null> {
    return this.tasks.get(taskPath.toLowerCase()) ?? null;
  }

  async delete(taskPath: string): Promise<void> {
    this.tasks.delete(taskPath.toLowerCase());
  }

  async disable(taskPath: string): Promise<void> {
    const normalized = taskPath.toLowerCase();
    const task = this.tasks.get(normalized);
    if (task) {
      this.tasks.set(normalized, { ...task, enabled: false });
    }
  }

  // Test helpers
  addTask(info: ScheduledTaskInfo): void {
    this.tasks.set(info.path.toLowerCase(), info);
  }

  getTasks(): Map<string, ScheduledTaskInfo> {
    return new Map(this.tasks);
  }
}

// ============================================================================
// Mock Exec
// ============================================================================

export class MockExecAdapter implements ExecAdapter {
  private execResults = new Map<string, ExecResult>();
  public execCalls: Array<{ command: string; args: string[] }> = [];

  setResult(command: string, result: ExecResult): void {
    this.execResults.set(command.toLowerCase(), result);
  }

  async exec(command: string, args: string[], _options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, args });

    const result = this.execResults.get(command.toLowerCase());
    if (result) return result;

    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async execPowerShell(script: string, _options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command: 'powershell', args: [script] });
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async spawn(command: string, args: string[], _options?: SpawnOptions): Promise<number> {
    this.execCalls.push({ command, args });
    return 12345; // Return mock PID
  }
}

// ============================================================================
// Create Mock System Adapter
// ============================================================================

export interface MockSystemState {
  files?: Record<string, MockFileEntry>;
  registry?: Record<string, Record<string, unknown>>;
  processes?: ProcessInfo[];
  services?: ServiceInfo[];
  tasks?: ScheduledTaskInfo[];
}

export function createMockSystemAdapter(state: MockSystemState = {}): SystemAdapter & {
  filesystem: MockFilesystemAdapter;
  registry: MockRegistryAdapter;
  process: MockProcessAdapter;
  service: MockServiceAdapter;
  taskScheduler: MockTaskSchedulerAdapter;
  exec: MockExecAdapter;
} {
  return {
    filesystem: new MockFilesystemAdapter(state.files),
    registry: new MockRegistryAdapter(state.registry),
    process: new MockProcessAdapter(state.processes),
    service: new MockServiceAdapter(state.services),
    taskScheduler: new MockTaskSchedulerAdapter(state.tasks),
    exec: new MockExecAdapter(),
  };
}
