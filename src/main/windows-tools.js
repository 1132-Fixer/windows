'use strict';

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

const CORE_DLLS = new Set(['ntdll.dll', 'kernel32.dll', 'kernelbase.dll']);

function loadedSystemIdentity(report, arch) {
  if (!report || !Array.isArray(report.sharedObjects) ||
      report.sharedObjects.some(value => typeof value !== 'string')) return null;
  const identities = new Map();
  let identity = null;
  for (const value of report.sharedObjects) {
    const name = path.win32.basename(value).toLowerCase();
    if (!CORE_DLLS.has(name)) continue;
    if (!isWindowsRoot(value) || /[<>|"*?]/.test(value) || value.slice(2).includes(':')) return null;
    const normalized = path.win32.normalize(value);
    const directory = path.win32.dirname(normalized);
    const systemFolder = path.win32.basename(directory).toLowerCase();
    if (systemFolder !== 'system32' && systemFolder !== 'syswow64') return null;
    const root = path.win32.dirname(directory);
    if (!isWindowsRoot(root)) return null;
    const key = `${root.toLowerCase()}\\${systemFolder}`;
    if ((identity && identity.key !== key) ||
        (identities.has(name) && identities.get(name) !== normalized.toLowerCase())) return null;
    identity = { root, systemFolder, key };
    identities.set(name, normalized.toLowerCase());
  }
  if (identities.size !== CORE_DLLS.size || !identity) return null;
  if (!['ia32', 'x64', 'arm64'].includes(arch) ||
      (arch !== 'ia32' && identity.systemFolder !== 'system32')) return null;
  return Object.freeze({ root: identity.root, systemFolder: identity.systemFolder });
}

function readLoadedLibraries() {
  const api = process.report;
  if (!api || typeof api.getReport !== 'function') return null;
  // Never write a diagnostic report or retain its environment, stack or
  // network sections. Newer Node versions can omit private sections at
  // collection time as well. Restore the process-wide flags immediately.
  const flags = ['excludeEnv', 'excludeNetwork'];
  const changed = [];
  try {
    for (const flag of flags) {
      if (flag in api) {
        changed.push([flag, api[flag]]);
        api[flag] = true;
      }
    }
    const report = api.getReport();
    return { sharedObjects: report && report.sharedObjects };
  } finally {
    for (const [flag, value] of changed.reverse()) api[flag] = value;
  }
}

function createToolResolver({ getReport = readLoadedLibraries, arch = process.arch } = {}) {
  let checked = false;
  let identity = null;
  function systemIdentity() {
    if (!checked) {
      checked = true;
      try { identity = typeof getReport === 'function' ? loadedSystemIdentity(getReport(), arch) : null; }
      catch (_) { identity = null; }
    }
    return identity;
  }
  return Object.freeze({
    resolveSystemRoot() { return systemIdentity()?.root || null; },
    resolveTool(name) {
      if (!TOOL_NAMES.has(name)) {
        const error = new Error('Windows tool is not supported.');
        error.code = 'WINDOWS_TOOL_NOT_ALLOWED';
        throw error;
      }
      const system = systemIdentity();
      if (!system) {
        const error = new Error('Windows system directory could not be verified from OS-loaded libraries.');
        error.code = 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE';
        throw error;
      }
      // WOW64 is established by the loaded DLL directory, never an
      // environment variable. Native x64/arm64 processes use System32.
      const systemDir = arch === 'ia32' && system.systemFolder === 'syswow64' ? 'Sysnative' : 'System32';
      return name === 'powershell.exe'
        ? path.win32.join(system.root, systemDir, 'WindowsPowerShell', 'v1.0', name)
        : path.win32.join(system.root, systemDir, name);
    }
  });
}

const defaultResolver = createToolResolver();
// Establish authority during module initialization, before repair creates
// an account credential. Only the vetted root/folder pair survives.
defaultResolver.resolveSystemRoot();
const injectedResolvers = new WeakMap();
function resolverFor(options) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, 'getReport')) return defaultResolver;
  if (typeof options.getReport !== 'function') return createToolResolver(options);
  let architectures = injectedResolvers.get(options.getReport);
  if (!architectures) { architectures = new Map(); injectedResolvers.set(options.getReport, architectures); }
  const arch = options.arch || process.arch;
  if (!architectures.has(arch)) architectures.set(arch, createToolResolver({ getReport: options.getReport, arch }));
  return architectures.get(arch);
}
function resolveSystemRoot(options) { return resolverFor(options).resolveSystemRoot(); }
function resolveTool(name, options) { return resolverFor(options).resolveTool(name); }

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
  WINDOWS_TOOLS, createToolResolver, resolveSystemRoot, resolveTool,
  PS_UTF8_OUTPUT_PREAMBLE, PS_STDIN_ARGS, prepareScript, parseProbe
};
