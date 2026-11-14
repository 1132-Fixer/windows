'use strict';

// Packaged Windows commands use the protected, x64 MSI installation. PATH and
// caller-controlled executable environment variables cannot select this host.
const fs = require('node:fs');
const path = require('node:path').win32;
const PWSH_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const SCRIPT_BOOTSTRAP = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  "if ($PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or -not [Environment]::Is64BitProcess) { throw 'PowerShell 7 x64 is required' }",
  '$source = [Console]::In.ReadToEnd()',
  '& ([scriptblock]::Create($source))'
].join('; ');
const SCRIPT_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT_BOOTSTRAP]);

function unavailable() {
  const error = new Error('PowerShell 7 x64 is unavailable at its supported protected installation.');
  error.code = 'ERR_POWERSHELL7_UNAVAILABLE';
  return error;
}

function resolvePowerShell7(deps = {}) {
  const io = deps.fs || fs;
  try {
    const real = io.realpathSync(PWSH_PATH);
    if (typeof real !== 'string' || path.normalize(real).toLowerCase() !== PWSH_PATH.toLowerCase()) throw unavailable();
    let current = PWSH_PATH;
    while (true) {
      const stat = io.lstatSync(current);
      if (stat.isSymbolicLink() || (current === PWSH_PATH && !stat.isFile())) throw unavailable();
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return real;
  } catch (_) { throw unavailable(); }
}

function preparePowerShellScript(script, deps = {}) {
  if (typeof script !== 'string' || !script.trim()) throw new TypeError('A nonempty internal script is required');
  const input = Buffer.from(script, 'utf8');
  if (input.length > MAX_SCRIPT_BYTES) throw new RangeError('Internal script exceeds its input bound');
  return Object.freeze({ exe: resolvePowerShell7(deps), args: [...SCRIPT_ARGS], input });
}

module.exports = { PWSH_PATH, MAX_SCRIPT_BYTES, SCRIPT_ARGS, resolvePowerShell7, preparePowerShellScript };
