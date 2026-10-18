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
// Node decodes. This smoke uses the shared fixed-command stdin transport
// and asserts a non-ASCII path string round-trips byte-exact.
//
// main.js cannot be require()d under plain node (Electron imports), so the
// transport comes from the shared runner contract, not a duplicate test copy.
// Exit 0 PASS / 1 FAIL. Reports not-run off Windows: PowerShell requires Windows.

const os = require('os');
const { spawnSync } = require('child_process');
const { resolveTool, PS_STDIN_ARGS, prepareScript } = require('../src/main/windows-tools');

if (process.platform !== 'win32') {
  console.log('ps-encoding-smoke: not-run (Windows PowerShell requires Windows)');
  process.exit(0);
}

// Localized/redirected Desktop shapes from the field reports: Latin accents
// (pt-BR OneDrive "Área de Trabalho"), Cyrillic, CJK. No apostrophes — the
// sample is interpolated into a single-quoted PS string, as main.js does
// (after isSafeZoomPath-style validation).
const SAMPLE = 'C:\\Users\\José\\OneDrive\\Área de Trabalho — Рабочий стол — デスクトップ';

function runPS(scriptContent) {
  const r = spawnSync(resolveTool('powershell.exe'), PS_STDIN_ARGS,
    // A stale inherited working directory must not affect the test. Empty
    // PATH also proves the shared absolute executable contract.
    { input: Buffer.from(prepareScript(scriptContent), 'utf8'),
      windowsHide: true, timeout: 30000, cwd: os.tmpdir(),
      env: { ...process.env, PATH: '' } });
  // Decode exactly the way main.js runProcess does: Buffer#toString() = UTF-8.
  return { code: r.status, stdout: (r.stdout || Buffer.alloc(0)).toString() };
}

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('ps-encoding-smoke: UTF-8 output preamble round-trip');
{
  const r = runPS(`Write-Output '${SAMPLE}'`);
  check(r.code === 0, 'preamble script exits 0');
  check(r.stdout.trim() === SAMPLE,
    'non-ASCII path survives PS stdout -> Node UTF-8 decode byte-exact');
}
{
  // GetFolderPath itself must also pass through undamaged — same call
  // getCanonicalUserDesktop() makes. The value is machine-dependent, so only
  // assert it is non-empty and free of U+FFFD replacement characters.
  const r = runPS(`[Environment]::GetFolderPath('Desktop')`);
  const out = r.stdout.trim();
  check(r.code === 0 && out.length > 0, 'GetFolderPath(Desktop) returns a path');
  check(!out.includes('\ufffd'), 'resolved Desktop path contains no replacement characters');
}

if (failures) {
  console.error(`ps-encoding-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ps-encoding-smoke: all checks passed');
