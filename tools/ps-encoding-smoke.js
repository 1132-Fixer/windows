'use strict';

// Regression transport coverage for the W6-SHORTCUT encoding defect (#93/#111).
// The historical defect involved legacy redirected output. Live checks now
// require PowerShell 7, without changing execution policy or starting 5.1.
// Keep the UTF-8 BOM + output-preamble file transport, multilingual text and
// real Desktop-path result. A deliberately ASCII-encoded child output is a
// negative control; it must fail the same round-trip comparison.
//
// main.js cannot be imported under plain Node (Electron imports). This driver
// mirrors its file/output encoding contract, without claiming 5.1 runtime proof.
// Missing/incompatible PowerShell 7 or a blocked fixture is a failure, no skip.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function requirePowerShell7() {
  const command = process.env.PWSH7_PATH || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  if (process.env.PWSH7_PATH && (!path.isAbsolute(command) || !/^pwsh(?:\.exe)?$/i.test(path.basename(command)))) {
    throw new Error('POWERSHELL7_REQUIRED_NOT_AVAILABLE: PWSH7_PATH must name an absolute pwsh executable.');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 Core is required' }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; executable = [IO.Path]::Combine($PSHOME, $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })) } | ConvertTo-Json -Compress"
  ].join('; ');
  const probe = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error && probe.error.code || String(probe.stderr || 'version probe failed').trim().slice(0, 240);
    throw new Error('POWERSHELL7_REQUIRED_NOT_AVAILABLE: native version probe failed (status ' +
      probe.status + ', ' + detail + '). An installed PowerShell 7 must be available on PATH or PWSH7_PATH.');
  }
  let info;
  try { info = JSON.parse(probe.stdout.trim()); } catch (_) { /* rejected below */ }
  if (!info || info.edition !== 'Core' || typeof info.version !== 'string' ||
      !/^\d+\./.test(info.version) || Number(info.version.split('.')[0]) < 7 ||
      typeof info.executable !== 'string' || !path.isAbsolute(info.executable) ||
      !/^pwsh(?:\.exe)?$/i.test(path.basename(info.executable))) {
    throw new Error('POWERSHELL7_REQUIRED_NOT_AVAILABLE: the native host returned no valid PowerShell 7 identity.');
  }
  try { return { ...info, executable: fs.realpathSync(info.executable) }; }
  catch (error) {
    throw new Error('POWERSHELL7_REQUIRED_NOT_AVAILABLE: verified pwsh executable could not be resolved (' + error.code + ').');
  }
}

let ps7;
try { ps7 = requirePowerShell7(); }
catch (error) { console.error('FAIL ps-encoding-smoke: ' + error.message); process.exit(1); }
console.log('ps-encoding-smoke: native PowerShell ' + ps7.version + ' (' + ps7.edition + ')');

// Must stay byte-identical to main.js's PS_UTF8_OUTPUT_PREAMBLE.
const PS_UTF8_OUTPUT_PREAMBLE =
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}\r\n';

// Preserve the original multilingual fixture: Latin, Cyrillic and Japanese.
const SAMPLE = 'C:\\Users\\José\\OneDrive\\Área de Trabalho — Рабочий стол — デスクトップ';

function runPS(scriptContent, withPreamble, withBom = true) {
  const tmp = path.join(os.tmpdir(),
    'fixer-smoke-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.ps1');
  const body = (withPreamble ? PS_UTF8_OUTPUT_PREAMBLE : '') + scriptContent;
  const input = Buffer.from((withBom ? '\ufeff' : '') + body, 'utf8');
  fs.writeFileSync(tmp, input);
  try {
    const written = fs.readFileSync(tmp);
    if (!written.equals(input) ||
        (withBom && !written.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))) {
      throw new Error('UTF-8 script fixture bytes or BOM changed before execution');
    }
    const r = spawnSync(ps7.executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', tmp],
      { windowsHide: true, timeout: 30000, cwd: os.tmpdir() });
    if (r.error || r.status !== 0) {
      const detail = r.error && r.error.code || (r.stderr || Buffer.alloc(0)).toString('utf8').trim().slice(0, 300);
      throw new Error('POWERSHELL7_TRANSPORT_FAILED: script fixture refused or failed (status ' + r.status + ', ' + detail + '). No policy override was applied.');
    }
    return {
      code: r.status,
      stdout: (r.stdout || Buffer.alloc(0)).toString('utf8'),
      stderr: (r.stderr || Buffer.alloc(0)).toString('utf8'),
      launchError: r.error && r.error.code || null
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

let failures = 0;
function check(cond, name) {
  if (cond) console.log('  ok  ' + name);
  else { console.error('FAIL  ' + name); failures++; }
}

console.log('ps-encoding-smoke: UTF-8 output preamble round-trip');
{
  const r = runPS("Write-Output '" + SAMPLE + "'", true);
  check(r.code === 0, 'preamble script exits 0 (status ' + r.code + ', ' + (r.launchError || 'native transport') + ')');
  check(r.stdout.trim() === SAMPLE, 'non-ASCII path survives script BOM and Node UTF-8 decode byte-exact');
}
{
  const r = runPS("[Environment]::GetFolderPath('Desktop')", true);
  const out = r.stdout.trim();
  check(r.code === 0 && out.length > 0, 'GetFolderPath(Desktop) returns a path');
  check(!out.includes('\ufffd'), 'resolved Desktop path contains no replacement characters');
}
{
  // Core can inherit a legacy Windows console code page. Measure this control
  // in the same child instead of assuming that every Core console is UTF-8.
  // The positive transport checks above still require byte-exact UTF-8.
  const r = runPS("Write-Output ('CODEPAGE=' + [Console]::OutputEncoding.CodePage); Write-Output ('SAMPLE=' + '" + SAMPLE + "')", false);
  const lines = r.stdout.split(/\r?\n/);
  const codePageLine = lines.find(line => /^CODEPAGE=[0-9]+$/.test(line));
  const sampleLine = lines.find(line => line.startsWith('SAMPLE='));
  check(r.code === 0 && !!codePageLine && !!sampleLine, 'unconfigured-output control reports its actual inherited encoding');
  if (codePageLine && sampleLine) {
    const utf8 = codePageLine === 'CODEPAGE=65001';
    check(utf8 ? sampleLine.slice(7) === SAMPLE : sampleLine.slice(7) !== SAMPLE,
      utf8 ? 'inherited UTF-8 console preserves the control payload'
        : 'legacy console corruption is detected; it cannot satisfy the UTF-8 transport contract');
  }
}
{
  const r = runPS("Write-Output '" + SAMPLE + "'", true, false);
  check(r.code === 0 && r.stdout.trim() === SAMPLE, 'PowerShell 7 reads BOM-less UTF-8 script source without corruption');
}
{
  const r = runPS("[Console]::OutputEncoding = [Text.Encoding]::ASCII; [Console]::Out.WriteLine('" + SAMPLE + "')", true);
  check(r.code === 0, 'isolated ASCII-output negative control executes successfully');
  check(r.stdout.trim() !== SAMPLE && r.stdout.includes('?'), 'round-trip comparison rejects deliberately corrupted output');
}

if (failures) {
  console.error('ps-encoding-smoke: ' + failures + ' FAILURE(S)');
  process.exit(1);
}
console.log('ps-encoding-smoke: all checks passed; no transport checks skipped');
