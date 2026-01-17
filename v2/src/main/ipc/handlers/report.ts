/**
 * Report IPC Handlers
 *
 * Handles report operations: list, get, export, delete, copy hash.
 * Manages attestation reports and their export.
 */

import { ipcMain, clipboard, dialog, shell } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  IPC_CHANNELS,
  type ReportListEntry,
  type ReportExportOptions,
  type ReportExportResult,
} from '../channels';
import {
  type AttestationReport,
  redactReport,
  createPersistence,
} from '../../core/session';
import { getAppDataPath, DATA_PATHS } from '../../../shared/branding';

// ============================================================================
// State
// ============================================================================

// Get reports directory
function getReportsDir(): string {
  return path.join(getAppDataPath(), DATA_PATHS.REPORTS);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load all reports from disk
 */
async function loadReports(): Promise<AttestationReport[]> {
  const reportsDir = getReportsDir();

  try {
    await fs.mkdir(reportsDir, { recursive: true });
    const files = await fs.readdir(reportsDir);
    const reports: AttestationReport[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = await fs.readFile(path.join(reportsDir, file), 'utf-8');
          const report = JSON.parse(content) as AttestationReport;
          reports.push(report);
        } catch {
          // Skip invalid files
        }
      }
    }

    // Sort by timestamp descending (newest first)
    reports.sort((a, b) => b.timing.completedAt - a.timing.completedAt);

    return reports;
  } catch {
    return [];
  }
}

/**
 * Load a single report by session ID
 */
async function loadReport(sessionId: string): Promise<AttestationReport | null> {
  const reportsDir = getReportsDir();
  const reportPath = path.join(reportsDir, `${sessionId}.json`);

  try {
    const content = await fs.readFile(reportPath, 'utf-8');
    return JSON.parse(content) as AttestationReport;
  } catch {
    // Try to find by scanning all files
    const reports = await loadReports();
    return reports.find((r) => r.sessionId === sessionId) || null;
  }
}

/**
 * Convert report to list entry
 */
function toListEntry(report: AttestationReport): ReportListEntry {
  return {
    sessionId: report.sessionId,
    reportId: report.reportId,
    productId: report.product.id,
    productName: report.product.name,
    mode: report.session.mode,
    status: report.status,
    createdAt: report.timing.startedAt,
    completedAt: report.timing.completedAt,
  };
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * List all reports
 */
async function handleReportList(): Promise<ReportListEntry[]> {
  const reports = await loadReports();
  return reports.map(toListEntry);
}

/**
 * Get a specific report
 */
async function handleReportGet(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<AttestationReport | null> {
  return loadReport(sessionId);
}

/**
 * Export a report
 */
async function handleReportExport(
  _event: Electron.IpcMainInvokeEvent,
  options: ReportExportOptions,
): Promise<ReportExportResult> {
  const report = await loadReport(options.sessionId);

  if (!report) {
    return {
      success: false,
      error: 'Report not found',
    };
  }

  try {
    // Apply redaction if requested (default true)
    const exportReport = options.redacted !== false
      ? redactReport(report)
      : report;

    // Show save dialog
    const format = options.format || 'json';
    const defaultName = `report_${report.sessionId}_${Date.now()}.${format}`;

    const result = await dialog.showSaveDialog({
      title: 'Export Report',
      defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
      filters: format === 'json'
        ? [{ name: 'JSON Files', extensions: ['json'] }]
        : [{ name: 'HTML Files', extensions: ['html'] }],
    });

    if (result.canceled || !result.filePath) {
      return {
        success: false,
        error: 'Export cancelled',
      };
    }

    // Generate content
    let content: string;

    if (format === 'html') {
      content = generateHtmlReport(exportReport);
    } else {
      content = JSON.stringify(exportReport, null, 2);
    }

    // Write file
    await fs.writeFile(result.filePath, content, 'utf-8');

    return {
      success: true,
      path: result.filePath,
      hash: exportReport.integrity.contentHash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Export failed',
    };
  }
}

/**
 * Generate HTML report
 */
function generateHtmlReport(report: AttestationReport): string {
  const statusColor = report.status === 'pass' ? '#00FF88'
    : report.status === 'warn' ? '#FFD93D'
    : '#FF2D2D';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attestation Report - ${report.sessionId}</title>
  <style>
    :root {
      --bg: #0A0A0F;
      --surface: #12141A;
      --border: #2D3139;
      --text: #F0F0F5;
      --muted: #8B9099;
      --accent: #00F0FF;
      --success: #00FF88;
      --warning: #FFD93D;
      --error: #FF2D2D;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 40px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 {
      font-size: 28px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--accent);
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin: 32px 0 16px;
      color: var(--text);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      background: ${statusColor}20;
      color: ${statusColor};
      border: 1px solid ${statusColor}40;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      margin-top: 8px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .value {
      font-size: 16px;
      font-weight: 500;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
    }
    .hash {
      font-family: monospace;
      font-size: 12px;
      color: var(--accent);
      word-break: break-all;
      background: var(--bg);
      padding: 8px 12px;
      border-radius: 4px;
      margin-top: 16px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Attestation Report</h1>
    <div class="status-badge">${report.status.toUpperCase()}</div>
    <div class="meta">
      Session ID: ${report.sessionId}<br>
      Generated: ${new Date(report.timing.completedAt).toISOString()}
    </div>

    <h2>Environment</h2>
    <div class="card">
      <div class="grid">
        <div>
          <div class="label">OS Version</div>
          <div class="value">${report.environment.osVersion}</div>
        </div>
        <div>
          <div class="label">Architecture</div>
          <div class="value">${report.environment.arch}</div>
        </div>
        <div>
          <div class="label">Elevated</div>
          <div class="value">${report.environment.elevated ? 'Yes' : 'No'}</div>
        </div>
        <div>
          <div class="label">App Version</div>
          <div class="value">${report.environment.appVersion}</div>
        </div>
      </div>
    </div>

    <h2>Product</h2>
    <div class="card">
      <div class="grid">
        <div>
          <div class="label">Name</div>
          <div class="value">${report.product.name}</div>
        </div>
        <div>
          <div class="label">Vendor</div>
          <div class="value">${report.product.vendor}</div>
        </div>
      </div>
    </div>

    <h2>Session</h2>
    <div class="card">
      <div class="grid">
        <div>
          <div class="label">Mode</div>
          <div class="value">${report.session.mode}</div>
        </div>
        <div>
          <div class="label">Dry Run</div>
          <div class="value">${report.session.dryRun ? 'Yes' : 'No'}</div>
        </div>
      </div>
    </div>

    ${report.execution ? `
    <h2>Execution</h2>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Target</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${report.execution.stepResults.map((step) => `
          <tr>
            <td>${step.action}</td>
            <td>${step.target}</td>
            <td>${step.status}</td>
            <td>${step.durationMs}ms</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <h2>Integrity</h2>
    <div class="card">
      <div class="label">Content Hash (SHA-256)</div>
      <div class="hash">${report.integrity.contentHash}</div>
    </div>

    <div class="footer">
      Generated by CleanStateSentinel v${report.environment.appVersion}
      ${report.redacted ? ' (Redacted)' : ''}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Delete a report
 */
async function handleReportDelete(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  const reportsDir = getReportsDir();
  const reportPath = path.join(reportsDir, `${sessionId}.json`);

  try {
    await fs.unlink(reportPath);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Delete failed',
    };
  }
}

/**
 * Copy report hash to clipboard
 */
async function handleReportCopyHash(
  _event: Electron.IpcMainInvokeEvent,
  sessionId: string,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const report = await loadReport(sessionId);

  if (!report) {
    return {
      success: false,
      error: 'Report not found',
    };
  }

  try {
    clipboard.writeText(report.integrity.contentHash);
    return {
      success: true,
      hash: report.integrity.contentHash,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Copy failed',
    };
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all report IPC handlers
 */
export function registerReportHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.REPORT_LIST, handleReportList);
  ipcMain.handle(IPC_CHANNELS.REPORT_GET, handleReportGet);
  ipcMain.handle(IPC_CHANNELS.REPORT_EXPORT, handleReportExport);
  ipcMain.handle(IPC_CHANNELS.REPORT_DELETE, handleReportDelete);
  ipcMain.handle(IPC_CHANNELS.REPORT_COPY_HASH, handleReportCopyHash);
}
