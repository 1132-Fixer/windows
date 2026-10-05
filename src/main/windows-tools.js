'use strict';

const fs = require('fs');
const path = require('path');

// These tools belong to Windows. Neither an app directory nor PATH is an
// authority for choosing an executable, even when launched by an installer.
const WINDOWS_TOOLS = Object.freeze([
  'powershell.exe', 'taskkill.exe', 'robocopy.exe', 'icacls.exe',
  'takeown.exe', 'net.exe', 'reg.exe', 'sc.exe', 'attrib.exe',
  'cmd.exe', 'whoami.exe', 'quser.exe', 'logoff.exe', 'msiexec.exe'
]);
const TOOL_NAMES = new Set(WINDOWS_TOOLS);

function isWindowsRoot(value) {
  // win32.isAbsolute also accepts drive-less roots and UNC/device paths.
  // Require a local drive root, with no traversal or control characters.
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) &&
    !/[\x00-\x1f]/.test(value) &&
    !value.split(/[\\/]/).some(part => part === '.' || part === '..');
}

function envValue(env, name) {
  const key = Object.keys(env).find(value => value.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function resolveSystemRoot(env = process.env, existsSync = fs.existsSync) {
  const candidates = ['SystemRoot', 'WINDIR'].map(name => {
    const value = envValue(env, name);
    return typeof value === 'string' ? value.trim() : '';
  });
  candidates.push('C:\\Windows');
  for (const candidate of candidates) {
    if (!isWindowsRoot(candidate)) continue;
    const root = path.win32.normalize(candidate);
    try {
      // An arbitrary existing directory is not a Windows installation root.
      if (existsSync(root) && existsSync(path.win32.join(root, 'System32'))) return root;
    } catch (_) { /* Try the known fallback instead of trusting this root. */ }
  }
  return null;
}

function resolveTool(name, options = {}) {
  if (!TOOL_NAMES.has(name)) {
    const error = new Error('Windows tool is not supported.');
    error.code = 'WINDOWS_TOOL_NOT_ALLOWED';
    throw error;
  }
  const env = options.env || process.env;
  const arch = options.arch || process.arch;
  const root = resolveSystemRoot(env, options.existsSync || fs.existsSync);
  if (!root) {
    const error = new Error('Windows system directory could not be found.');
    error.code = 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE';
    throw error;
  }
  // Only a 32-bit process on 64-bit Windows needs the Sysnative alias. The
  // shipped x64 app must use System32; Sysnative does not exist for it.
  const systemDir = arch === 'ia32' && envValue(env, 'PROCESSOR_ARCHITEW6432')
    ? 'Sysnative' : 'System32';
  return name === 'powershell.exe'
    ? path.win32.join(root, systemDir, 'WindowsPowerShell', 'v1.0', name)
    : path.win32.join(root, systemDir, name);
}

const PS_UTF8_OUTPUT_PREAMBLE =
  'try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {\r\n' +
  '  $fixerStdout = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))\r\n' +
  '  $fixerStdout.AutoFlush = $true; [Console]::SetOut($fixerStdout)\r\n' +
  '  $fixerStderr = [IO.StreamWriter]::new([Console]::OpenStandardError(), [Text.UTF8Encoding]::new($false))\r\n' +
  '  $fixerStderr.AutoFlush = $true; [Console]::SetError($fixerStderr)\r\n' +
  '}\r\n';

// Caller script and credentials travel through stdin only. -Command - parses
// redirected stdin line by line, which loses compound blocks and their final
// line; one fixed expression reads the whole UTF-8 stream before parsing it.
// A parser or terminating error is reported without echoing secret-bearing
// script source into stderr.
const PS_STDIN_ARGS = Object.freeze([
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  "try { [Console]::SetIn([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))); & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine('PowerShell script failed.'); exit 1 }"
]);

const PS_TOOL_PREAMBLE = [
  'function Resolve-FixerTool([string]$Name) {',
  `  $allowed = @(${WINDOWS_TOOLS.map(name => `'${name}'`).join(', ')})`,
  "  if ($Name -cnotin $allowed) { throw 'Windows tool is not supported.' }",
  "  if ($Name -eq 'powershell.exe') { return (Join-Path $PSHOME $Name) }",
  '  $systemDir = [Environment]::SystemDirectory',
  "  if ([string]::IsNullOrWhiteSpace($systemDir) -or -not [IO.Path]::IsPathRooted($systemDir)) { throw 'Windows system directory could not be found.' }",
  '  return (Join-Path $systemDir $Name)',
  '}',
  ''
].join('\r\n');

function prepareScript(script) {
  if (typeof script !== 'string') throw new TypeError('PowerShell script must be a string.');
  return PS_UTF8_OUTPUT_PREAMBLE + PS_TOOL_PREAMBLE + script;
}

const SERVICE_STATUS = new Set([
  'Stopped', 'StartPending', 'StopPending', 'Running',
  'ContinuePending', 'PausePending', 'Paused'
]);
const SERVICE_START_TYPE = new Set(['Automatic', 'Boot', 'Disabled', 'Manual', 'System']);

function parseProbe(result, allTools) {
  if (!Array.isArray(allTools) || !allTools.length ||
      allTools.some(name => !TOOL_NAMES.has(name)) ||
      new Set(allTools).size !== allTools.length) {
    throw new TypeError('Windows tool inventory must contain unique supported tools.');
  }
  const unknown = Object.fromEntries(allTools.map(name => [name, null]));
  const failed = (timedOut) => ({
    ok: false,
    tools: unknown,
    seclogon: { status: 'not checked', startType: 'not checked' },
    diagnostic: {
      code: timedOut ? 'tool_probe_timeout' : 'tool_probe_failed',
      message: timedOut
        ? 'Windows checks timed out. Windows tools could not be verified.'
        : 'Windows checks did not return a complete result. Windows tools could not be verified.',
      exitCode: result && Number.isInteger(result.code) ? result.code : null,
      errorCode: result && typeof result.errorCode === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(result.errorCode) ? result.errorCode : null,
      timedOut: !!timedOut
    }
  });
  if (!result || result.timedOut || result.outcome === 'timeout') return failed(!!result);
  if (result.code !== 0 || result.error ||
      (result.outcome && result.outcome !== 'ok')) return failed(false);
  let inventory;
  try {
    if (typeof result.stdout !== 'string' || !result.stdout.trim()) return failed(false);
    inventory = JSON.parse(result.stdout.trim());
  } catch (_) { return failed(false); }
  if (!inventory || Array.isArray(inventory) || typeof inventory !== 'object') return failed(false);
  if (allTools.some(name => !Object.prototype.hasOwnProperty.call(inventory, name) ||
      typeof inventory[name] !== 'boolean')) return failed(false);
  const status = inventory.seclogon_status;
  const startType = inventory.seclogon_starttype;
  const missing = status === 'MISSING' && startType === 'MISSING';
  if (!missing && (!SERVICE_STATUS.has(status) || !SERVICE_START_TYPE.has(startType))) return failed(false);
  let toolPaths;
  if (Object.prototype.hasOwnProperty.call(inventory, 'tool_paths')) {
    const paths = inventory.tool_paths;
    if (!paths || typeof paths !== 'object' || Array.isArray(paths) ||
        allTools.some(name => {
          const value = paths[name];
          if (!isWindowsRoot(value)) return true;
          const suffix = name === 'powershell.exe'
            ? `\\WindowsPowerShell\\v1.0\\${name}` : `\\${name}`;
          const normalized = path.win32.normalize(value).toLowerCase();
          return !normalized.endsWith(suffix.toLowerCase()) ||
            !/\\(?:system32|sysnative)\\/i.test(normalized);
        })) return failed(false);
    toolPaths = Object.fromEntries(allTools.map(name => [name, paths[name]]));
  }
  return {
    ok: true,
    tools: Object.fromEntries(allTools.map(name => [name, inventory[name]])),
    seclogon: { status, startType },
    ...(toolPaths ? { tool_paths: toolPaths } : {}),
    diagnostic: null
  };
}

module.exports = {
  WINDOWS_TOOLS, resolveSystemRoot, resolveTool,
  PS_UTF8_OUTPUT_PREAMBLE, PS_STDIN_ARGS, prepareScript, parseProbe
};
