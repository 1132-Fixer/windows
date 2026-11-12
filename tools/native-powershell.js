'use strict';

// Operator/native test commands require PowerShell 7. Product compatibility
// with inbox Windows PowerShell is a separate contract; do not execute 5.1
// as a fallback from a test driver. Resolve from loaded Windows identity,
// never PATH, SystemRoot, or a writable temporary executable.
const fs = require('fs');
const path = require('path');
const { resolveSystemRoot, prepareScript, PS_STDIN_ARGS } = require('../src/main/windows-tools');

// Reuse the fixed UTF-8 stdin expression without changing execution policy.
// Product compatibility arguments are never native verification authority.
const NATIVE_PS_STDIN_ARGS = Object.freeze([
  '-NoProfile', '-NonInteractive', '-Command', PS_STDIN_ARGS.at(-1)
]);

function nativePowerShell7({ systemRoot = resolveSystemRoot(), existsSync = fs.existsSync } = {}) {
  if (typeof systemRoot !== 'string' || !/^[a-z]:\\[^\x00-\x1f]+$/i.test(systemRoot) ||
      systemRoot.split('\\').some(part => part === '.' || part === '..')) {
    throw new Error('Native PowerShell 7 check requires verified Windows identity.');
  }
  const exe = path.win32.join(path.win32.parse(systemRoot).root, 'Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (!existsSync(exe)) throw new Error('PowerShell 7 is unavailable at its required native test path. No Windows PowerShell fallback is allowed.');
  return exe;
}

function prepareNativeScript(script) {
  return prepareScript("if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PowerShell 7 is required for native verification' }\n" + script);
}

module.exports = { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript };
