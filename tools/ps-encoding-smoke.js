// Regression smoke for the W6-SHORTCUT encoding fix (#93 #111, FileNotFound
// class on OneDrive-redirected / non-ASCII Desktop folders).
//
// Mechanism under test: Windows PowerShell 5.1 writes REDIRECTED stdout in
// the legacy OEM codepage while main.js's runProcess decodes the pipe as
// UTF-8. A localized OneDrive Desktop path returned by
// [Environment]::GetFolderPath('Desktop') ("Área de Trabalho",
// "Рабочий стол") therefore arrived corrupted, and shortcut creation then
// targeted a folder that does not exist. The fix writes
// PS_UTF8_OUTPUT_PREAMBLE as the script's first statement so PS emits what
// Node decodes. This smoke mirrors the exact runner pattern (UTF-8 BOM +
// preamble temp .ps1, spawn powershell.exe -File, decode stdout as UTF-8)
// and asserts a non-ASCII path string round-trips byte-exact.
//
// main.js cannot be require()d under plain node (Electron imports), so the
// pattern is mirrored — same approach as tools/shortcut-legacy-smoke.js.
// Exit 0 PASS / 1 FAIL. Skips (pass) off Windows: powershell.exe only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('ps-encoding-smoke: skipped (powershell.exe requires Windows)');
  process.exit(0);
}

// Must stay byte-identical to main.js's PS_UTF8_OUTPUT_PREAMBLE.
const PS_UTF8_OUTPUT_PREAMBLE =
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}\r\n';

// Localized/redirected Desktop shapes from the field reports: Latin accents
// (pt-BR OneDrive "Área de Trabalho"), Cyrillic, CJK. No apostrophes — the
// sample is interpolated into a single-quoted PS string, as main.js does
// (after isSafeZoomPath-style validation).
const SAMPLE = 'C:\\Users\\José\\OneDrive\\Área de Trabalho — Рабочий стол — デスクトップ';

function runPS(scriptContent, withPreamble) {
  const tmp = path.join(os.tmpdir(),
    `fixer-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  const body = (withPreamble ? PS_UTF8_OUTPUT_PREAMBLE : '') + scriptContent;
  fs.writeFileSync(tmp, '\ufeff' + body, 'utf8');
  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { windowsHide: true, timeout: 30000 });
    // Decode exactly the way main.js runProcess does: Buffer#toString() = UTF-8.
    return {
      code: r.status,
      stdout: (r.stdout || Buffer.alloc(0)).toString()
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('ps-encoding-smoke: UTF-8 output preamble round-trip');
{
  const r = runPS(`Write-Output '${SAMPLE}'`, true);
  check(r.code === 0, 'preamble script exits 0');
  check(r.stdout.trim() === SAMPLE,
    'non-ASCII path survives PS stdout -> Node UTF-8 decode byte-exact');
}
{
  // GetFolderPath itself must also pass through undamaged — same call
  // getCanonicalUserDesktop() makes. The value is machine-dependent, so only
  // assert it is non-empty and free of U+FFFD replacement characters.
  const r = runPS(`[Environment]::GetFolderPath('Desktop')`, true);
  const out = r.stdout.trim();
  check(r.code === 0 && out.length > 0, 'GetFolderPath(Desktop) returns a path');
  check(!out.includes('\ufffd'), 'resolved Desktop path contains no replacement characters');
}
{
  // Informational control: the same round-trip WITHOUT the preamble. On most
  // machines (OEM codepage stdout) this corrupts — which is the #93/#111 bug.
  // Not a pass/fail check: a box whose console codepage is already UTF-8
  // would legitimately round-trip clean.
  const r = runPS(`Write-Output '${SAMPLE}'`, false);
  console.log(`  info: without preamble round-trip ${r.stdout.trim() === SAMPLE ? 'survived (console already UTF-8 on this box)' : 'CORRUPTED (the pre-fix behavior)'}`);
}

if (failures) {
  console.error(`ps-encoding-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ps-encoding-smoke: all checks passed');
