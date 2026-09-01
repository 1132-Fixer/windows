'use strict';

/**
 * Process-token elevation and UAC relaunch for 1132 Fixer.
 *
 * Elevation is the Windows token elevation bit (TOKEN_ELEVATION), not:
 *   - the signed-in username
 *   - Administrators group membership on a filtered (medium-IL) token
 *   - environment variables
 *   - whether an unrelated command happened to succeed (`net session`)
 *
 * Every child process here has an explicit timeout and is killed on expiry.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ELEVATE_RETRY_FLAG = '--self-elevate-attempted';
const ELEVATION_PROBE_MS = 5000;
const UAC_RELAUNCH_MS = 120000;
const STARTUP_DEADLINE_MS = 20000;

const HIGH_IL_SID = 'S-1-16-12288';
const SYSTEM_IL_SID = 'S-1-16-16384';

const TOKEN_PROBE_PS = [
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  '$code = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class TokenElevationQuery {',
  '  const int TokenElevation = 20;',
  '  const uint TOKEN_QUERY = 0x0008;',
  '  [DllImport("advapi32.dll", SetLastError=true)]',
  '  static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);',
  '  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();',
  '  [DllImport("advapi32.dll", SetLastError=true)]',
  '  static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, ref TOKEN_ELEVATION TokenInformation, int TokenInformationLength, out int ReturnLength);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);',
  '  [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }',
  '  public static int Query() {',
  '    IntPtr token;',
  '    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return -1;',
  '    TOKEN_ELEVATION te = new TOKEN_ELEVATION();',
  '    int len;',
  '    bool ok = GetTokenInformation(token, TokenElevation, ref te, Marshal.SizeOf(te), out len);',
  '    CloseHandle(token);',
  '    if (!ok) return -1;',
  '    return te.TokenIsElevated != 0 ? 1 : 0;',
  '  }',
  '}',
  '"@',
  'Add-Type -TypeDefinition $code -ErrorAction Stop',
  '$v = [TokenElevationQuery]::Query()',
  "Write-Output ('TOKEN_ELEVATED=' + $v)"
].join('\r\n');

function logStage(name, extra) {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[startup] ${name}${suffix}`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
  } catch (_) { /* already gone */ }
}

async function runPsFile(script, timeoutMs, spawnImpl) {
  const tmp = path.join(os.tmpdir(), `fixer-elev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  fs.writeFileSync(tmp, `\ufeff${script}`, 'utf8');
  try {
    return await spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      timeoutMs
    );
  } finally {
    fs.unlink(tmp, () => {});
  }
}

function runTimed(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const started = Date.now();
    const child = spawn(command, args, { windowsHide: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout,
        stderr,
        ms: Date.now() - started
      });
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ timedOut: true, code: -1, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish({ timedOut: false, code: -1, error: err.message }));
    child.on('exit', (code) => finish({ timedOut: false, code, error: null }));
    child.on('close', (code) => finish({ timedOut: false, code, error: null }));
  });
}

function parseTokenProbe(stdout) {
  const text = String(stdout || '');
  const m = text.match(/TOKEN_ELEVATED\s*=\s*(-1|0|1)/i);
  if (!m) return { ok: false, elevated: null };
  if (m[1] === '-1') return { ok: false, elevated: null };
  return { ok: true, elevated: m[1] === '1' };
}

function parseWhoamiIntegrity(stdout) {
  const text = String(stdout || '');
  if (text.includes(HIGH_IL_SID) || text.includes(SYSTEM_IL_SID)) {
    return { ok: true, elevated: true };
  }
  if (/S-1-16-\d+/.test(text)) {
    return { ok: true, elevated: false };
  }
  return { ok: false, elevated: null };
}

function relaunchArgList({ isPackaged, appPath, argv, retryFlag }) {
  const raw = Array.isArray(argv) ? argv.slice(1) : [];
  const extra = raw.filter((a) => a !== retryFlag && a !== appPath);
  if (isPackaged) return extra.concat(retryFlag);
  return [appPath].concat(extra.filter((a) => a !== appPath)).concat(retryFlag);
}

function psSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

function createElevationController(deps = {}) {
  const spawnImpl = deps.runTimed || runTimed;
  const retryFlag = deps.retryFlag || ELEVATE_RETRY_FLAG;
  const probeMs = deps.probeMs || ELEVATION_PROBE_MS;
  const relaunchMs = deps.relaunchMs || UAC_RELAUNCH_MS;
  let memo = null;

  function probeWhoamiSync() {
    const t0 = Date.now();
    try {
      const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
      const r = spawnSync(whoami, ['/groups'], {
        encoding: 'utf8',
        timeout: Math.min(probeMs, 2500),
        windowsHide: true,
        env: process.env
      });
      const il = parseWhoamiIntegrity((r && r.stdout) || '');
      if (il.ok) {
        logStage('elevation.whoami', `sync elevated=${il.elevated} ${Date.now() - t0}ms`);
        return { elevated: il.elevated, method: 'integrity-level', ms: Date.now() - t0, error: null };
      }
      return null;
    } catch (err) {
      logStage('elevation.whoami', `sync failed ${err && err.message}`);
      return null;
    }
  }

  async function probeToken() {
    const t0 = Date.now();
    logStage('elevation.token', 'begin');
    // whoami /groups reads the process token integrity SID and cannot hang
    // on Add-Type. Packaged 6.3.0 stalled on Checking while PowerShell
    // compiled the TOKEN_ELEVATION helper.
    const fast = probeWhoamiSync();
    if (fast) return fast;
    const ps = await runPsFile(TOKEN_PROBE_PS, probeMs, spawnImpl);
    const parsed = parseTokenProbe(ps.stdout);
    if (parsed.ok) {
      logStage('elevation.token', `ok elevated=${parsed.elevated} ${Date.now() - t0}ms`);
      return { elevated: parsed.elevated, method: 'token-elevation', ms: Date.now() - t0, error: null };
    }
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    const who = await spawnImpl(whoami, ['/groups'], probeMs);
    const il = parseWhoamiIntegrity(who.stdout);
    if (il.ok) {
      logStage('elevation.whoami', `ok elevated=${il.elevated} ${Date.now() - t0}ms`);
      return { elevated: il.elevated, method: 'integrity-level', ms: Date.now() - t0, error: null };
    }
    const err = ps.timedOut || who.timedOut
      ? 'elevation probe timed out'
      : (ps.error || who.error || 'elevation probe failed');
    logStage('elevation.fail', err);
    return { elevated: false, method: 'failed', ms: Date.now() - t0, error: err };
  }

  function snapshot() {
    const fast = probeWhoamiSync();
    if (fast) {
      memo = Promise.resolve(fast);
      return fast;
    }
    return { elevated: false, method: 'failed', ms: 0, error: 'whoami integrity SID unavailable' };
  }

  function isElevated() {
    if (memo) return memo;
    return Promise.resolve(snapshot());
  }

  function resetMemoForTests() {
    memo = null;
  }

  async function relaunchElevated(opts) {
    const exe = opts.execPath;
    const args = relaunchArgList({
      isPackaged: !!opts.isPackaged,
      appPath: opts.appPath,
      argv: opts.argv || process.argv,
      retryFlag
    });
    const argList = args.map((a) => `'${psSingleQuote(a)}'`).join(',');
    const script = [
      'try {',
      `  Start-Process -FilePath '${psSingleQuote(exe)}' -ArgumentList @(${argList}) -Verb RunAs`,
      "  Write-Output 'STARTED'",
      '} catch {',
      "  Write-Output ('DECLINED: ' + $_.Exception.Message)",
      '}'
    ].join('\r\n');
    logStage('elevation.relaunch', 'Start-Process -Verb RunAs');
    const r = await runPsFile(script, relaunchMs, spawnImpl);
    const started = !r.timedOut && /STARTED/.test(r.stdout || '');
    const declined = /DECLINED/.test(r.stdout || '') || r.timedOut;
    logStage('elevation.relaunch', started ? 'started' : (declined ? 'declined-or-timeout' : 'failed'));
    return { started, declined, timedOut: !!r.timedOut, stdout: r.stdout || '' };
  }

  return {
    isElevated,
    snapshot,
    relaunchElevated,
    resetMemoForTests,
    retryFlag,
    probeMs,
    relaunchMs,
    startupDeadlineMs: deps.startupDeadlineMs || STARTUP_DEADLINE_MS
  };
}

module.exports = {
  ELEVATE_RETRY_FLAG,
  ELEVATION_PROBE_MS,
  UAC_RELAUNCH_MS,
  STARTUP_DEADLINE_MS,
  HIGH_IL_SID,
  SYSTEM_IL_SID,
  TOKEN_PROBE_PS,
  parseTokenProbe,
  parseWhoamiIntegrity,
  relaunchArgList,
  createElevationController,
  logStage
};
