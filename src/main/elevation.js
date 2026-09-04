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
 * Every child process here has an explicit timeout, is killed as a tree on
 * expiry, and settles exactly once. Every result carries an `outcome` so a
 * caller can tell success, decline, timeout, launch error and failure apart.
 *
 * Nothing here writes a script file. Smart App Control treats an unknown
 * .ps1 under %TEMP% as "part of this app" and blocks it even when
 * powershell.exe itself is trusted, so every PowerShell call is `-Command`
 * with the script passed in memory.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ELEVATE_RETRY_FLAG = '--self-elevate-attempted';
const ELEVATION_PROBE_MS = 5000;
const UAC_RELAUNCH_MS = 120000;
const STARTUP_DEADLINE_MS = 20000;
// After a child reports `exit`, wait this long for `close` (stdio drained)
// before settling with whatever output arrived. A grandchild that inherited
// the pipes (the elevated app itself, briefly) must not hold the parent open.
const EXIT_CLOSE_GRACE_MS = 500;

const HIGH_IL_SID = 'S-1-16-12288';
const SYSTEM_IL_SID = 'S-1-16-16384';

// Result sentinels. The parser accepts them only as a whole line so unrelated
// PowerShell output (warnings, banners, an error that happens to contain the
// word STARTED) can never be read as a successful relaunch.
const RELAUNCH_STARTED = 'FIXER_RELAUNCH=STARTED';
const RELAUNCH_DECLINED = 'FIXER_RELAUNCH=DECLINED';

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

// %SystemRoot% is trusted only when it is an absolute directory that exists.
// A missing or relative value (a stripped launcher environment) falls back to
// C:\Windows. Returns null when no Windows directory can be found at all so
// the caller reports a launch error instead of spawning a nonexistent path.
function resolveSystemRoot(env = process.env, existsSync = fs.existsSync) {
  const candidates = [];
  const raw = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (raw && path.win32.isAbsolute(raw)) candidates.push(raw);
  candidates.push('C:\\Windows');
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch (_) { /* treat as missing */ }
  }
  return null;
}

function systemPowerShell(env = process.env, existsSync = fs.existsSync) {
  const root = resolveSystemRoot(env, existsSync);
  if (!root) return null;
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function systemWhoami(env = process.env, existsSync = fs.existsSync) {
  const root = resolveSystemRoot(env, existsSync);
  if (!root) return null;
  return path.win32.join(root, 'System32', 'whoami.exe');
}

// In-memory -Command only (see the module header). The script is one argv
// entry: Node quotes it for CreateProcess and PowerShell reads the whole
// argument as the command text, so no shell ever re-parses it.
function runPsCommand(script, timeoutMs, spawnImpl) {
  const exe = systemPowerShell();
  if (!exe) {
    return Promise.resolve({
      outcome: 'launch-error', timedOut: false, code: -1,
      error: 'Windows directory not found', stdout: '', stderr: '', ms: 0
    });
  }
  return spawnImpl(
    exe,
    ['-NoProfile', '-NonInteractive', '-Command', String(script)],
    timeoutMs
  );
}

// Bounded child runner. Settles exactly once with one of:
//   outcome 'ok'           — child exited (code may still be nonzero)
//   outcome 'timeout'      — deadline hit; the process tree was killed
//   outcome 'launch-error' — spawn itself failed (missing exe, EACCES, ...)
function runTimed(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let graceTimer = null;
    const started = Date.now();
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ ...result, stdout, stderr, ms: Date.now() - started });
    };
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      finish({ outcome: 'launch-error', timedOut: false, code: -1, error: err.message });
      return;
    }
    timer = setTimeout(() => {
      killTree(child.pid);
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ outcome: 'timeout', timedOut: true, code: -1, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish({ outcome: 'launch-error', timedOut: false, code: -1, error: err.message }));
    // `close` fires after stdio has drained, so the result carries every
    // byte the child wrote. `exit` alone can arrive first with the tail of
    // stdout still in flight — settling there dropped the STARTED line and
    // reported a real relaunch as failed. If a grandchild holds the pipes
    // open, the grace timer settles instead of waiting forever.
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => finish({ outcome: 'ok', timedOut: false, code, error: null }), EXIT_CLOSE_GRACE_MS);
    });
    child.on('close', (code) => finish({ outcome: 'ok', timedOut: false, code, error: null }));
  });
}

function parseTokenProbe(stdout) {
  const text = String(stdout || '');
  const m = text.match(/^\s*TOKEN_ELEVATED\s*=\s*(-1|0|1)\s*$/im);
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

// Whole-line sentinel match only. Returns 'started', 'declined' or null.
function parseRelaunchOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(RELAUNCH_STARTED)) return 'started';
  if (lines.some((l) => l.startsWith(RELAUNCH_DECLINED))) return 'declined';
  return null;
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

// The PowerShell text that asks Windows for approval. Single-quoted literals
// only: inside '...' PowerShell expands nothing, and the only character that
// needs escaping is the apostrophe (doubled by psSingleQuote). Spaces,
// quotes, Unicode, `$`, backticks and semicolons in paths or arguments pass
// through untouched. Statements are joined with '; ' so the whole script is
// one line for -Command.
function buildRelaunchScript(exe, args) {
  const argList = args.map((a) => `'${psSingleQuote(a)}'`).join(',');
  const argPart = args.length ? ` -ArgumentList @(${argList})` : '';
  return [
    'try {',
    `Start-Process -FilePath '${psSingleQuote(exe)}'${argPart} -Verb RunAs -ErrorAction Stop`,
    `Write-Output '${RELAUNCH_STARTED}'`,
    '} catch {',
    `Write-Output ('${RELAUNCH_DECLINED}: ' + $_.Exception.Message)`,
    '}'
  ].join('; ');
}

function createElevationController(deps = {}) {
  const spawnImpl = deps.runTimed || runTimed;
  const spawnSyncImpl = deps.spawnSync || spawnSync;
  const retryFlag = deps.retryFlag || ELEVATE_RETRY_FLAG;
  const probeMs = deps.probeMs || ELEVATION_PROBE_MS;
  const relaunchMs = deps.relaunchMs || UAC_RELAUNCH_MS;
  let memo = null;

  // Fast path: whoami /groups prints the process token's integrity SID. It
  // is synchronous, bounded, and cannot stall on Add-Type. Packaged 6.3.0
  // stayed on Checking while PowerShell compiled the TOKEN_ELEVATION helper.
  function probeWhoamiSync() {
    const t0 = Date.now();
    try {
      const whoami = systemWhoami();
      if (!whoami) return null;
      const r = spawnSyncImpl(whoami, ['/groups'], {
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

  // Slow path, only when whoami gave nothing usable: the TOKEN_ELEVATION
  // query through PowerShell, bounded by probeMs and tree-killed on expiry.
  // Worst case before the window opens: whoami (2.5 s) + this (5 s).
  // Every branch returns; doubt is reported as not elevated, never as a
  // hang.
  async function probeToken() {
    const t0 = Date.now();
    logStage('elevation.token', 'begin');
    const fast = probeWhoamiSync();
    if (fast) return fast;
    const ps = await runPsCommand(TOKEN_PROBE_PS, probeMs, spawnImpl);
    const parsed = parseTokenProbe(ps.stdout);
    if (parsed.ok) {
      logStage('elevation.token', `ok elevated=${parsed.elevated} ${Date.now() - t0}ms`);
      return { elevated: parsed.elevated, method: 'token-elevation', ms: Date.now() - t0, error: null };
    }
    const err = ps.timedOut
      ? 'elevation probe timed out'
      : (ps.error || 'elevation probe returned no usable result');
    logStage('elevation.fail', err);
    return { elevated: false, method: 'failed', ms: Date.now() - t0, error: err };
  }

  // Synchronous answer for the startup-status IPC. Never elevated on doubt.
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
    memo = probeToken().catch((err) => ({
      elevated: false, method: 'failed', ms: 0, error: String((err && err.message) || err)
    }));
    return memo;
  }

  function resetMemoForTests() {
    memo = null;
  }

  // Asks Windows for approval and reports exactly one outcome:
  //   'started'      — the elevated instance was launched; caller quits
  //   'declined'     — the user cancelled the prompt (or Windows refused,
  //                    e.g. Smart App Control); caller stays and explains
  //   'timeout'      — nobody answered the prompt within relaunchMs
  //   'launch-error' — PowerShell itself could not be started
  //   'failed'       — PowerShell ran but printed neither sentinel
  async function relaunchElevated(opts) {
    const exe = opts.execPath;
    const args = relaunchArgList({
      isPackaged: !!opts.isPackaged,
      appPath: opts.appPath,
      argv: opts.argv || process.argv,
      retryFlag
    });
    const script = buildRelaunchScript(exe, args);
    logStage('elevation.relaunch', 'Start-Process -Verb RunAs (no script file)');
    const r = await runPsCommand(script, relaunchMs, spawnImpl);
    let outcome;
    if (r.outcome === 'timeout' || r.timedOut) outcome = 'timeout';
    else if (r.outcome === 'launch-error') outcome = 'launch-error';
    else outcome = parseRelaunchOutput(r.stdout) || 'failed';
    const started = outcome === 'started';
    const declined = outcome === 'declined' || outcome === 'timeout';
    logStage('elevation.relaunch', outcome);
    return {
      started,
      declined,
      outcome,
      timedOut: outcome === 'timeout',
      launchError: outcome === 'launch-error' ? (r.error || 'PowerShell could not be started') : null,
      stdout: r.stdout || ''
    };
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
  EXIT_CLOSE_GRACE_MS,
  HIGH_IL_SID,
  SYSTEM_IL_SID,
  RELAUNCH_STARTED,
  RELAUNCH_DECLINED,
  TOKEN_PROBE_PS,
  parseTokenProbe,
  parseWhoamiIntegrity,
  parseRelaunchOutput,
  relaunchArgList,
  buildRelaunchScript,
  resolveSystemRoot,
  systemPowerShell,
  runTimed,
  createElevationController,
  logStage
};
