'use strict';

// Pure host-selection and private-input fixtures. No executable is launched.
const assert = require('node:assert/strict');
const path = require('node:path').win32;
const { PWSH_PATH, MAX_SCRIPT_BYTES, SCRIPT_ARGS, resolvePowerShell7, preparePowerShellScript } = require('../src/main/powershell7');
let checks = 0;
function check(name, fn) { fn(); ++checks; console.log('  ok  ' + name); }
const good = () => ({
  realpathSync: value => value,
  lstatSync: value => ({ isSymbolicLink: () => false, isFile: () => value === PWSH_PATH })
});
check('protected canonical host is selected without PATH or executable overrides', () => {
  const originalPath = process.env.PATH;
  const originalOverride = process.env.PWSH7_PATH;
  try {
    process.env.PATH = 'C:\\untrusted'; process.env.PWSH7_PATH = 'C:\\untrusted\\pwsh.exe';
    assert.equal(resolvePowerShell7({ fs: good() }), PWSH_PATH);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalOverride === undefined) delete process.env.PWSH7_PATH; else process.env.PWSH7_PATH = originalOverride;
  }
});
for (const altered of ['C:\\untrusted\\pwsh.exe', 'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']) {
  check('redirected or legacy host is refused: ' + altered, () => {
    const io = good(); io.realpathSync = () => altered;
    assert.throws(() => resolvePowerShell7({ fs: io }), { code: 'ERR_POWERSHELL7_UNAVAILABLE' });
  });
}
for (const candidate of [PWSH_PATH, path.dirname(PWSH_PATH), 'C:\\Program Files', 'C:\\']) {
  check('reparse point is refused at ' + candidate, () => {
    const io = good(); const original = io.lstatSync;
    io.lstatSync = value => value === candidate ? { isSymbolicLink: () => true, isFile: () => true } : original(value);
    assert.throws(() => resolvePowerShell7({ fs: io }), { code: 'ERR_POWERSHELL7_UNAVAILABLE' });
  });
}
check('missing, denied and non-file hosts fail closed without leaking native errors', () => {
  for (const io of [{ ...good(), realpathSync() { throw new Error('private native detail'); } },
    { ...good(), lstatSync() { return { isSymbolicLink: () => false, isFile: () => false }; } }]) {
    assert.throws(() => resolvePowerShell7({ fs: io }), error => error.code === 'ERR_POWERSHELL7_UNAVAILABLE' && !error.message.includes('private'));
  }
});
check('Unicode and secret script content uses bounded UTF-8 stdin only', () => {
  const script = "Write-Output 'caf\u00e9 \u6587'; $privateValue = 'synthetic-secret';";
  const call = preparePowerShellScript(script, { fs: good() });
  assert.equal(call.exe, PWSH_PATH);
  assert.equal(call.input.toString('utf8'), script);
  assert.deepEqual(call.args, [...SCRIPT_ARGS]);
  assert.equal(call.args.some(arg => arg.includes('synthetic-secret') || arg.includes('caf')), false);
  assert.equal(/ExecutionPolicy|Bypass|-File/.test(call.args.join(' ')), false);
  assert.match(call.args.at(-1), /ReadToEnd/);
  assert.match(call.args.at(-1), /OutputEncoding/);
});
check('empty, malformed and oversized input is rejected before host access', () => {
  const io = { realpathSync() { throw new Error('should not access host'); } };
  for (const value of ['', '  ', null, {}, 5]) assert.throws(() => preparePowerShellScript(value, { fs: io }), TypeError);
  assert.throws(() => preparePowerShellScript('x'.repeat(MAX_SCRIPT_BYTES + 1), { fs: io }), RangeError);
});
console.log('powershell7-host-smoke: ' + checks + ' passed; no native execution');
