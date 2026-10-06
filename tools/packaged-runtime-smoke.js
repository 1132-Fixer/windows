'use strict';

// Exercise the actual packaged driver's gate with controlled runtime facts.
// The Windows acceptance run separately proves these facts in real Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const windowsTools = require('../src/main/windows-tools');
const source = fs.readFileSync(path.join(__dirname, 'packaged-acceptance.js'), 'utf8');
const start = source.indexOf('async function runtimeAuthority(');
const end = source.indexOf('\nasync function launch(', start);
assert.ok(start >= 0 && end > start, 'the production packaged runtime gate is present');
const root = 'C:\\Windows';
const archive = 'D:\\build\\resources\\app.asar';
const objects = ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `${root}\\System32\\${name}`);
const originalEnvironment = {
  SystemRoot: root,
  WINDIR: root,
  PATH: `${root}\\System32`,
  PROCESSOR_ARCHITEW6432: 'AMD64',
  ComSpec: `${root}\\System32\\cmd.exe`,
  FIXER_UNRELATED: 'preserve-me'
};
let checks = 0;

async function run(options = {}) {
  const records = [];
  const runtimeEnvironment = { ...originalEnvironment };
  const expectedForgedEnvironment = options.fakeRoot ? {
    SystemRoot: options.fakeRoot,
    WINDIR: options.fakeRoot,
    PATH: '',
    PROCESSOR_ARCHITEW6432: 'FORGED',
    ComSpec: path.win32.join(options.fakeRoot, 'System32', 'cmd.exe')
  } : null;
  let reports = 0;
  const report = { excludeEnv: false, excludeNetwork: false, getReport() {
    reports++;
    assert.equal(this.excludeEnv, true);
    assert.equal(this.excludeNetwork, true);
    if (expectedForgedEnvironment) {
      assert.deepEqual(runtimeEnvironment, { ...originalEnvironment, ...expectedForgedEnvironment });
    }
    if (options.reportThrows) throw new Error('PRIVATE_REPORT_ERROR');
    return { sharedObjects: options.objects || objects, environmentVariables: { PRIVATE: 'PRIVATE_REPORT_CONTENT' } };
  } };
  const tools = {
    ...windowsTools,
    resolveSystemRoot: () => options.cachedRoot || root,
    resolveTool: name => windowsTools.resolveTool(name, { getReport: () => ({ sharedObjects: objects }), arch: 'x64' })
  };
  let commands = 0;
  const runtime = {
    versions: { electron: options.electron || '44.2.0', node: '22.0.0' }, arch: 'x64',
    env: runtimeEnvironment,
    report: options.noReport ? undefined : report,
    getBuiltinModule: options.noBuiltin ? undefined : name => {
      if (name === 'path') return path.win32;
      if (name === 'module') return { createRequire: file => {
        assert.equal(file, path.win32.join(options.archive || archive, 'package.json'));
        return name => { assert.equal(name, './src/main/windows-tools.js'); return tools; };
      } };
      if (name === 'child_process') return { spawnSync: (exe, args, spawnOptions) => {
        commands++;
        assert.equal(exe, `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
        assert.deepEqual(args, windowsTools.PS_STDIN_ARGS);
        assert.equal(spawnOptions.timeout, 15000);
        assert.ok(spawnOptions.input.toString().includes("$fixerTestCmd = Resolve-FixerTool 'cmd.exe'"));
        assert.ok(spawnOptions.input.toString().includes('& $fixerTestCmd'));
        assert.ok(spawnOptions.input.toString().endsWith('$r | ConvertTo-Json -Compress'));
        if (options.fakeRoot) {
          assert.deepEqual(runtime.env, { ...originalEnvironment, ...expectedForgedEnvironment });
          assert.deepEqual(JSON.parse(spawnOptions.env.FIXER_TEST_FORGED_ENV), expectedForgedEnvironment);
          for (const [key, value] of Object.entries(originalEnvironment)) assert.equal(spawnOptions.env[key], value);
          assert.ok(spawnOptions.input.toString().includes('$env:ComSpec = [string]$fixerTestEnvironment.ComSpec'));
          assert.ok(spawnOptions.input.toString().includes('$env:ComSpec -eq [string]$fixerTestEnvironment.ComSpec'));
        }
        const reply = { systemDir: `${root}\\System32`, marker: 'FIXER_TRUSTED_RUNTIME',
          ...(options.fakeRoot ? { forgedEnvironment: true, nativePathTrusted: true } : {}) };
        return { status: options.exitCode ?? 0, stdout: options.stdout || JSON.stringify(reply),
          ...(options.spawnError ? { error: new Error('PRIVATE_PROCESS_ERROR') } : {}) };
      } };
      throw new Error('unexpected builtin');
    }
  };
  const context = {
    process: runtime, Buffer, path: path.win32, EXE: 'D:\\build\\1132 Fixer.exe',
    require: name => { assert.equal(name, 'electron/package.json'); return { version: '44.2.0' }; },
    passed: (id, detail, extra) => records.push({ id, status: 'passed', detail, ...extra }),
    failed: (id, detail, extra) => records.push({ id, status: 'failed', detail, ...extra })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.gate = runtimeAuthority;', context);
  const app = {
    evaluate: callback => callback({ app: { isPackaged: options.packaged !== false, getAppPath: () => options.archive || archive } }, options.fakeRoot || null)
  };
  const ok = await context.gate(app, 'fixture', options.fakeRoot);
  assert.equal(records.length, 1, 'each gate produces one authoritative result');
  assert.equal(report.excludeEnv, false);
  assert.equal(report.excludeNetwork, false);
  assert.deepEqual(runtime.env, originalEnvironment, 'the packaged main environment is restored exactly');
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'), 'report and process errors cannot reach runtime evidence');
  return { ok, records, commands, reports };
}

(async () => {
  const good = await run();
  assert.equal(good.ok, true);
  assert.equal(good.commands, 1);
  checks++;
  const forged = await run({ fakeRoot: 'E:\\Fake Windows' });
  assert.equal(forged.ok, true);
  assert.equal(forged.commands, 1);
  assert.equal(forged.reports, 1);
  assert.equal(forged.records[0].runtime.forgedEnvironmentApplied, true);
  assert.equal(forged.records[0].runtime.nativeEnvironmentApplied, true);
  assert.equal(forged.records[0].runtime.nativePathTrusted, true);
  assert.equal(forged.records[0].runtime.environmentRestored, true);
  checks++;
  for (const [name, options] of [
    ['report API unavailable', { noReport: true }],
    ['report collection throws', { reportThrows: true }],
    ['builtin API unavailable', { noBuiltin: true }],
    ['missing core DLL', { objects: objects.slice(0, 2) }],
    ['conflicting DLL root', { objects: [objects[0], objects[1], 'E:\\Fake\\System32\\kernelbase.dll'] }],
    ['cache differs from OS report', { cachedRoot: 'E:\\Fake' }],
    ['wrong packaged archive', { archive: 'E:\\other\\app.asar' }],
    ['unpackaged application', { packaged: false }],
    ['different Electron runtime', { electron: '43.0.0' }],
    ['nonzero trusted command', { exitCode: 7 }],
    ['spawn error despite successful status', { spawnError: true }],
    ['malformed command response', { stdout: 'not JSON' }],
    ['command reports different system directory', { stdout: JSON.stringify({ systemDir: 'E:\\Fake\\System32', marker: 'FIXER_TRUSTED_RUNTIME' }) }],
    ['embedded native command has no marker', { stdout: JSON.stringify({ systemDir: `${root}\\System32` }) }],
    ['tool resolves inside forged root', { fakeRoot: root }]
  ]) {
    const result = await run(options);
    assert.equal(result.ok, false, name);
    assert.equal(result.records[0].status, 'failed', name);
    if (name === 'tool resolves inside forged root') assert.equal(result.commands, 0, 'fake PowerShell is never executed');
    checks++;
  }
  console.log(`packaged-runtime-smoke: ${checks} authoritative runtime gate checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
