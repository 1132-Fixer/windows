'use strict';

// The design-system gitlink and every document that cites the pin must
// agree. A gitlink bump that forgets DESIGN-SYNC.md or AGENTS.md (or the
// reverse) leaves the app claiming one design source while checking out
// another; this fails the build in that case. Also asserts the submodule is
// declared at its canonical path and remote.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('design-sync-pin-smoke: gitlink');
const ls = spawnSync('git', ['ls-files', '-s', 'design-system'], { cwd: ROOT, encoding: 'utf8' });
const m = /^160000 ([0-9a-f]{40}) 0\tdesign-system$/m.exec(ls.stdout || '');
check(!!m, `design-system is a gitlink (mode 160000): ${(ls.stdout || ls.stderr || '').trim()}`);
const pin = m ? m[1] : '';

const gitmodules = fs.readFileSync(path.join(ROOT, '.gitmodules'), 'utf8');
check(/\[submodule "design-system"\][\s\S]*?path = design-system[\s\S]*?url = https:\/\/github\.com\/1132-Fixer\/design-system\.git/.test(gitmodules),
  '.gitmodules declares design-system at path design-system from 1132-Fixer/design-system.git');
check(!/@|:\/\/[^\/]*:[^\/]*@/.test(gitmodules.replace(/https:\/\/github\.com/g, '')), '.gitmodules carries no credentials');

console.log('design-sync-pin-smoke: documents cite the same pin');
for (const file of ['AGENTS.md', 'DESIGN-SYNC.md']) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const cited = [...text.matchAll(/`design-system`[^`\n]*@ `([0-9a-f]{40})`|pinned to `([0-9a-f]{40})`/g)].map((x) => x[1] || x[2]);
  check(cited.length > 0, `${file} cites a 40-hex design-system pin`);
  const wrong = cited.filter((c) => c !== pin);
  check(wrong.length === 0, `${file}: every cited pin equals the gitlink ${pin.slice(0, 12)}${wrong.length ? ' (found ' + wrong.map((w) => w.slice(0, 12)).join(', ') + ')' : ''}`);
}

console.log('design-sync-pin-smoke: pinned source has the Windows platform record');
const windowsDoc = path.join(ROOT, 'design-system', 'docs', 'platforms', 'windows.md');
const windowsTokens = path.join(ROOT, 'design-system', 'tokens', 'windows.json');
if (fs.existsSync(windowsDoc) && fs.existsSync(windowsTokens)) {
  const doc = fs.readFileSync(windowsDoc, 'utf8');
  const tokens = JSON.parse(fs.readFileSync(windowsTokens, 'utf8'));
  check(!/No shipped Windows UI exists yet/.test(doc), 'platforms/windows.md no longer says no Windows UI ships');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const root = /:root \{([\s\S]*?)\n    \}/.exec(html)[1];
  const cssVar = (name) => (new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(root) || [])[1];
  const pairs = [['bg', 'background'], ['panel', 'surface'], ['panel-2', 'surface-2'], ['accent', 'primary'], ['accent-2', 'primary-hover'], ['accent-pressed', 'primary-pressed'], ['focus', 'focus'], ['success', 'success'], ['warning', 'warning'], ['danger', 'error'], ['text', 'text-primary'], ['muted', 'text-secondary'], ['dim', 'text-muted'], ['border', 'border'], ['border-strong', 'border-strong']];
  for (const [css, tok] of pairs) {
    check((cssVar(css) || '').toUpperCase() === String(tokens.colors[tok] || '').toUpperCase(), `--${css} ${cssVar(css)} == windows.json ${tok} ${tokens.colors[tok]}`);
  }
  check(tokens.window && tokens.window.default[0] === 520 && tokens.window.default[1] === 600 && tokens.window.minimum[0] === 440 && tokens.window.minimum[1] === 520,
    'windows.json window sizes match compactWindowBounds (520x600, min 440x520)');
} else {
  // A checkout without the submodule initialised cannot prove the record;
  // say so rather than pass silently.
  check(false, 'design-system submodule is initialised (docs/platforms/windows.md and tokens/windows.json present)');
}

if (failures) {
  console.error(`design-sync-pin-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('design-sync-pin-smoke: all checks passed');
