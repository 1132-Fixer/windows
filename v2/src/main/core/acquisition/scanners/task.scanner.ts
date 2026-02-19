/**
 * TaskScanner - Read-Only Scheduled Task Enumeration
 *
 * RESPONSIBILITIES:
 * - Enumerate scheduled tasks matching vendor criteria
 * - Capture task configuration (triggers, actions, principal)
 * - Identify vendor ownership via task path and action paths
 *
 * NON-GOALS (NEVER DO):
 * ❌ No task creation/deletion/modification
 * ❌ No task execution
 * ❌ No "suspicion" scoring
 *
 * SAFETY INVARIANTS:
 * - Read-only observation only
 * - Command line arguments are redacted
 * - Never throws for inaccessible tasks
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type { OwnerTag } from '../../../../shared/types';
import type {
  Scanner,
  ScanContext,
  TaskArtifact,
  TaskState,
  TaskAction,
  TaskTrigger,
  ScanError,
} from '../types';

// ============================================================================
// Command Line Redaction (Privacy)
// ============================================================================

const SENSITIVE_PATTERNS = [
  /--password[=\s]+\S+/gi,
  /--token[=\s]+\S+/gi,
  /--key[=\s]+\S+/gi,
  /--secret[=\s]+\S+/gi,
  /-p\s+\S+/g,
];

function redactArguments(args: string | null | undefined): string | undefined {
  if (!args) return undefined;

  let redacted = args;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

// ============================================================================
// PowerShell Task Enumeration
// ============================================================================

interface TaskInfo {
  name: string;
  path: string;
  enabled: boolean;
  state: string;
  lastRun: string | null;
  nextRun: string | null;
  author: string | null;
  description: string | null;
  actions: Array<{
    type: string;
    path: string | null;
    arguments: string | null;
    workingDirectory: string | null;
  }>;
  triggers: Array<{
    type: string;
    enabled: boolean;
    startBoundary: string | null;
    endBoundary: string | null;
  }>;
  principal: {
    userId: string | null;
    runLevel: string | null;
  };
  hidden: boolean;
}

/**
 * Execute PowerShell command and return output
 */
async function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      resolve(stdout.trim());
    });

    ps.on('error', (err) => {
      reject(err);
    });

    // Timeout after 120 seconds (task enumeration can be slow)
    setTimeout(() => {
      ps.kill();
      resolve('');
    }, 120000);
  });
}

/**
 * Get all scheduled tasks with detailed configuration
 */
async function getAllTasks(): Promise<TaskInfo[]> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'

    $tasks = Get-ScheduledTask | ForEach-Object {
      $task = $_
      $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue

      $actions = @($task.Actions | ForEach-Object {
        @{
          Type = $_.CimClass.CimClassName -replace 'MSFT_Task', '' -replace 'Action', ''
          Path = $_.Execute
          Arguments = $_.Arguments
          WorkingDirectory = $_.WorkingDirectory
        }
      })

      $triggers = @($task.Triggers | ForEach-Object {
        @{
          Type = $_.CimClass.CimClassName -replace 'MSFT_Task', '' -replace 'Trigger', ''
          Enabled = $_.Enabled
          StartBoundary = $_.StartBoundary
          EndBoundary = $_.EndBoundary
        }
      })

      @{
        Name = $task.TaskName
        Path = $task.TaskPath
        Enabled = $task.State -ne 'Disabled'
        State = $task.State.ToString()
        LastRun = if ($info.LastRunTime -and $info.LastRunTime -ne [DateTime]::MinValue) { $info.LastRunTime.ToString('o') } else { $null }
        NextRun = if ($info.NextRunTime -and $info.NextRunTime -ne [DateTime]::MinValue) { $info.NextRunTime.ToString('o') } else { $null }
        Author = $task.Author
        Description = $task.Description
        Actions = $actions
        Triggers = $triggers
        Principal = @{
          UserId = $task.Principal.UserId
          RunLevel = $task.Principal.RunLevel.ToString()
        }
        Hidden = $task.Settings.Hidden
      }
    }

    $tasks | ConvertTo-Json -Depth 5 -Compress
  `;

  try {
    const output = await runPowerShell(script);
    if (!output) return [];

    let parsed = JSON.parse(output);

    // Handle single task case
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    return parsed.map((t: Record<string, unknown>) => ({
      name: t.Name as string,
      path: t.Path as string,
      enabled: t.Enabled as boolean,
      state: t.State as string,
      lastRun: t.LastRun as string | null,
      nextRun: t.NextRun as string | null,
      author: t.Author as string | null,
      description: t.Description as string | null,
      actions: (t.Actions as Array<Record<string, unknown>>)?.map(a => ({
        type: a.Type as string,
        path: a.Path as string | null,
        arguments: a.Arguments as string | null,
        workingDirectory: a.WorkingDirectory as string | null,
      })) || [],
      triggers: (t.Triggers as Array<Record<string, unknown>>)?.map(tr => ({
        type: tr.Type as string,
        enabled: tr.Enabled as boolean,
        startBoundary: tr.StartBoundary as string | null,
        endBoundary: tr.EndBoundary as string | null,
      })) || [],
      principal: {
        userId: (t.Principal as Record<string, unknown>)?.UserId as string | null,
        runLevel: (t.Principal as Record<string, unknown>)?.RunLevel as string | null,
      },
      hidden: t.Hidden as boolean,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Type Mapping
// ============================================================================

/**
 * Map Windows task state to our TaskState
 */
function mapState(state: string): TaskState {
  const mapping: Record<string, TaskState> = {
    'Disabled': 'Disabled',
    'Queued': 'Queued',
    'Ready': 'Ready',
    'Running': 'Running',
  };
  return mapping[state] || 'Unknown';
}

/**
 * Map action type to our TaskAction type
 */
function mapActionType(type: string): TaskAction['type'] {
  const mapping: Record<string, TaskAction['type']> = {
    'Exec': 'Execute',
    'Execute': 'Execute',
    'ComHandler': 'ComHandler',
    'SendEmail': 'SendEmail',
    'ShowMessage': 'ShowMessage',
  };
  return mapping[type] || 'Execute';
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Expand environment variables in a path
 */
function expandEnvVars(inputPath: string): string {
  return inputPath.replace(/%([^%]+)%/g, (_, varName) => {
    return process.env[varName] || process.env[varName.toUpperCase()] || `%${varName}%`;
  });
}

/**
 * Normalize path for comparison
 */
function normalizePath(inputPath: string): string {
  return inputPath.toLowerCase().replace(/\//g, '\\');
}

/**
 * Check if a task path matches vendor-defined task paths
 */
function isTaskPathMatch(
  taskPath: string,
  vendorTaskPaths: string[],
): boolean {
  const normalizedTask = normalizePath(taskPath);

  for (const vendorPath of vendorTaskPaths) {
    const normalizedVendor = normalizePath(vendorPath);
    if (
      normalizedTask === normalizedVendor ||
      normalizedTask.startsWith(normalizedVendor)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a task action path is within vendor-defined paths
 */
function isActionPathOwned(
  actionPath: string | null,
  vendorPaths: string[],
): boolean {
  if (!actionPath) return false;

  const normalizedAction = normalizePath(expandEnvVars(actionPath));

  for (const vendorPath of vendorPaths) {
    const normalizedVendor = normalizePath(expandEnvVars(vendorPath));
    if (normalizedAction.startsWith(normalizedVendor)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// TaskScanner Implementation
// ============================================================================

export class TaskScanner implements Scanner<TaskArtifact> {
  readonly id = 'task' as const;

  /**
   * Scan scheduled tasks for vendor-related tasks
   *
   * @param ctx - Scan context containing product definition
   * @returns Array of TaskArtifacts (sorted, deterministic)
   */
  async scan(ctx: ScanContext): Promise<TaskArtifact[]> {
    const { product } = ctx;
    const artifacts: TaskArtifact[] = [];

    // Collect all vendor paths for ownership check
    const vendorPaths = [
      ...product.paths.install,
      ...product.paths.appData,
      ...product.paths.programData,
    ];

    // Get all tasks
    const tasks = await getAllTasks();

    for (const task of tasks) {
      // Check if task matches vendor criteria
      const matchesTaskPath = isTaskPathMatch(task.path, product.tasks);

      // Check if any action path is vendor-owned
      const matchesActionPath = task.actions.some(a =>
        isActionPathOwned(a.path, vendorPaths)
      );

      if (!matchesTaskPath && !matchesActionPath) {
        continue; // Not vendor-related
      }

      // Determine confidence based on match type
      const confidence: OwnerTag['confidence'] =
        matchesTaskPath && matchesActionPath ? 'high' :
        matchesTaskPath ? 'high' :
        matchesActionPath ? 'medium' : 'low';

      // Map actions
      const actions: TaskAction[] = task.actions.map(a => ({
        type: mapActionType(a.type),
        path: a.path || undefined,
        arguments: redactArguments(a.arguments),
        workingDirectory: a.workingDirectory || undefined,
      }));

      // Map triggers
      const triggers: TaskTrigger[] = task.triggers.map(t => ({
        type: t.type,
        enabled: t.enabled,
        startBoundary: t.startBoundary || undefined,
        endBoundary: t.endBoundary || undefined,
      }));

      const artifact: TaskArtifact = {
        id: `task_${crypto.randomUUID()}`,
        type: 'task',
        owner: {
          vendor: product.vendor,
          product: product.id,
          confidence,
        },
        path: `${task.path}${task.name}`,
        metadata: {
          name: task.name,
          path: task.path,
          enabled: task.enabled,
          state: mapState(task.state),
          lastRun: task.lastRun ? new Date(task.lastRun).getTime() : undefined,
          nextRun: task.nextRun ? new Date(task.nextRun).getTime() : undefined,
          author: task.author || undefined,
          description: task.description || undefined,
          actions,
          triggers,
        },
        observedAt: Date.now(),
        source: 'task',
      };

      artifacts.push(artifact);
    }

    // DETERMINISM: Sort by full task path
    artifacts.sort((a, b) =>
      (a.path || '').localeCompare(b.path || '')
    );

    return artifacts;
  }

  /**
   * Get all tasks (for broad-spectrum scanning)
   */
  async getAllTasks(): Promise<TaskInfo[]> {
    return getAllTasks();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createTaskScanner(): TaskScanner {
  return new TaskScanner();
}
