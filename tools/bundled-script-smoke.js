'use strict';

// Bundled scripts run through stdin, not through "-File <path>" (#266).
// These checks run real Windows PowerShell with the app's own launch
// arguments, so they prove parameter binding, quoting, error reporting and
// the exit code of the wrapped form.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBundledScriptInvocation, psLiteral } = require('../src/main/bundled-script');
const windowsTools = require('../src/main/windows-tools');

const root = path.join(__dirname, '..');
let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
}

assert.strictEqual(process.platform, 'win32', 'bundled-script-smoke needs Windows PowerShell');

function run(script) {
  const result = spawnSync('powershell.exe', windowsTools.PS_STDIN_ARGS, {
    input: windowsTools.prepareScript(script), encoding: 'utf8', windowsHide: true, timeout: 60000
  });
  return { code: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

// Special characters are built from code points so this file stays ASCII.
const ch = (...codes) => String.fromCharCode(...codes);
const RIGHT_QUOTE = ch(0x2019);
const LEFT_QUOTE = ch(0x2018);

// --- literals -------------------------------------------------------------
check(psLiteral("O'Brien") === "'O''Brien'", 'apostrophe is doubled');
check(psLiteral('a' + RIGHT_QUOTE + 'b') === "'a" + RIGHT_QUOTE + RIGHT_QUOTE + "b'", 'typographic quote is doubled');
check(psLiteral('$env:TEMP `n $(1)') === "'$env:TEMP `n $(1)'", 'expansion characters stay literal');
for (const bad of [ch(0x0A), ch(0x0D), ch(0x00), ch(0x2028), ch(0x85)].map((c) => 'a' + c + 'b')) {
  assert.throws(() => psLiteral(bad), RangeError, 'control character is refused');
  passed += 1;
}
assert.throws(() => psLiteral(5), TypeError); passed += 1;
assert.throws(() => buildBundledScriptInvocation('', {}), TypeError); passed += 1;
assert.throws(() => buildBundledScriptInvocation('"x"', { 'Bad Name': 'v' }), RangeError); passed += 1;
assert.throws(() => buildBundledScriptInvocation('"x"', { 'Sid;calc': 'v' }), RangeError); passed += 1;

// --- real PowerShell: binding and quoting ---------------------------------
const fixture = [
  ch(0xFEFF) + '# comment before the param block',
  '[CmdletBinding()]',
  'param(',
  '  [Parameter(Mandatory=$true)][string] $Sid,',
  '  [Parameter(Mandatory=$true)][string] $ProfilePath',
  ')',
  "Write-Output ('SID=' + $Sid)",
  "Write-Output ('PATH=' + $ProfilePath)",
  "Write-Output ('ROOT=[' + $PSScriptRoot + ']') # comment on the last line"
].join('\r\n');
const awkward = "C:\\Users\\O'Brien " + RIGHT_QUOTE + 'x' + LEFT_QUOTE + ' $env:TEMP `n $(Get-Date) ' + ch(0xE9, 0x4E2D);
{
  const r = run(buildBundledScriptInvocation(fixture, { Sid: 'S-1-5-21-1-2-3-1001', ProfilePath: awkward }));
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  check(r.code === 0, 'wrapped script exits 0');
  check(r.stderr.trim() === '', 'wrapped script writes nothing to stderr');
  check(lines.includes('SID=S-1-5-21-1-2-3-1001'), 'first named argument is bound');
  check(lines.includes('PATH=' + awkward), 'quotes, expansion characters and non-ASCII text arrive unchanged');
  check(lines.includes('ROOT=[]'), 'no script file path exists in the stdin form');
}

// --- real PowerShell: failures stay failures ------------------------------
{
  const r = run(buildBundledScriptInvocation("param([string]$Sid)\r\nthrow 'fixture failure'", { Sid: 'x' }));
  check(r.code === 1, 'a terminating error exits 1');
  check(/fixture failure/.test(r.stderr), 'the error text reaches stderr');
  check(r.stdout.trim() === '', 'a failed script prints no result');
}
{
  const r = run(buildBundledScriptInvocation('param([Parameter(Mandatory=$true)][string]$Sid)\r\n"ran"', {}));
  check(r.code === 1 && !/ran/.test(r.stdout), 'a missing mandatory argument fails and does not prompt');
}

// --- the shipped script parses in the wrapped form ------------------------
{
  const consent = fs.readFileSync(path.join(root, 'scripts', 'grant-media-consent.ps1'), 'utf8');
  const wrapped = buildBundledScriptInvocation(consent, {
    Sid: 'S-1-5-21-1-2-3-1001', User: 'user1', ProfilePath: 'C:\\Users\\user1', Receipt: 'r'
  });
  const parse = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$t = [Console]::In.ReadToEnd(); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e); 'ERRORS=' + @($e).Count"],
  { input: wrapped, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  check(/ERRORS=0/.test(String(parse.stdout)), 'grant-media-consent.ps1 parses inside the wrapper');
  check(!/^\s*exit\b/m.test(consent), 'the shipped script has no top-level exit that would bypass the wrapper');
  check(!/\$PSScriptRoot|\$PSCommandPath|\$MyInvocation/.test(consent), 'the shipped script does not depend on its own file path');
}

// --- the repair uses the stdin form ---------------------------------------
{
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  check(!/'-File',\s*consentScript/.test(main), 'the consent step no longer launches a script file');
  check(/buildBundledScriptInvocation\(consentSource,/.test(main), 'the consent step builds the stdin form');
  const fileLaunches = (main.match(/runProcess\('powershell\.exe',\s*\[[^\]]*'-File'/g) || []).length;
  check(fileLaunches === 0, 'no timed PowerShell step launches a script file');
}

console.log(`bundled-script-smoke: ${passed} checks passed`);
