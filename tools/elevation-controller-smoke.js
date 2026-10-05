'use strict';

/**
 * Elevation controller behaviour tests for 1132 Fixer.
 *
 * Drives createElevationController() with fake child-process runners so every
 * outcome is exercised without a UAC prompt: already elevated, approved,
 * cancelled, PowerShell missing, PowerShell launch error, probe timeout,
 * relaunch timeout, empty / malformed / unrelated output, nonzero exit,
 * Smart App Control style refusal, exit-before-output, output-without-exit,
 * special-character paths and arguments, and the no-temp-file guarantee.
 *
 * The last section runs the real System32 PowerShell (no -Verb RunAs) to
 * prove the -Command transport carries apostrophes, spaces, quotes, `$`,
 * backticks, semicolons and non-ASCII text byte-for-byte. It is skipped on
 * non-Windows hosts and reported as such.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const elev = require('../src/main/elevation');

let failures = 0;
let skipped = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}
function skip(name, why) {
  console.log(`  skip ${name} (${why})`);
  skipped++;
}

const HIGH = `Mandatory Label\\High Mandatory Level  Label  ${elev.HIGH_IL_SID}`;
const MEDIUM = 'Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192';

function fakeSync(stdout) {
  return () => ({ stdout, stderr: '', status: 0 });
}
function throwingSync() {
  return () => { throw new Error('whoami unavailable'); };
}
function recordingRunner(reply) {
  const calls = [];
  const fn = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    const r = typeof reply === 'function' ? reply(cmd, args, timeoutMs) : reply;
    return { outcome: 'ok', timedOut: false, code: 0, error: null, stdout: '', stderr: '', ms: 1, ...r };
  };
  fn.calls = calls;
  return fn;
}
function controller(opts) {
  return elev.createElevationController({
    spawnSync: opts.sync,
    runTimed: opts.runner,
    probeMs: opts.probeMs || 50,
    relaunchMs: opts.relaunchMs || 50,
    // Process mocks still use the real resolver. Model loaded Windows DLL
    // evidence explicitly so these behaviour cases run on every CI host.
    env: opts.env || { SystemRoot: 'C:\\Windows', PATH: '' },
    getReport: Object.prototype.hasOwnProperty.call(opts, 'getReport') ? opts.getReport :
      () => ({ sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `C:\\Windows\\System32\\${name}`) }),
    arch: opts.arch || 'x64'
  });
}
const RELAUNCH_OPTS = {
  execPath: 'C:\\Program Files\\1132 Fixer\\1132 Fixer.exe',
  isPackaged: true,
  appPath: 'C:\\Program Files\\1132 Fixer\\resources\\app.asar',
  argv: ['C:\\Program Files\\1132 Fixer\\1132 Fixer.exe']
};

(async () => {
  console.log('elevation-controller-smoke: probe outcomes');
  {
    const runner = recordingRunner({});
    const c = controller({ sync: fakeSync(HIGH), runner });
    const r = await c.isElevated();
    check(r.elevated === true && r.method === 'integrity-level', 'already elevated via whoami High IL');
    check(runner.calls.length === 0, 'elevated fast path spawns no PowerShell');
    const snap = c.snapshot();
    check(snap.elevated === true, 'snapshot agrees with the probe');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({}) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'integrity-level', 'medium IL is not elevated');
  }
  {
    const runner = recordingRunner({ stdout: 'TOKEN_ELEVATED=1\r\n' });
    const c = controller({ sync: throwingSync(), runner });
    const r = await c.isElevated();
    check(r.elevated === true && r.method === 'token-elevation', 'whoami failure falls back to the token probe');
    check(runner.calls.length === 1 && /powershell\.exe$/i.test(runner.calls[0].cmd), 'fallback runs System32 PowerShell');
    check(runner.calls[0].args.includes('-Command') && !runner.calls[0].args.includes('-File'), 'fallback is -Command, never -File');
    check(runner.calls[0].timeoutMs === 50, 'token probe carries the probe deadline');
  }
  {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ stdout: '' }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed' && /no usable result/.test(r.error), 'empty probe output fails closed');
  }
  {
    const c = controller({ sync: fakeSync('garbage'), runner: recordingRunner({ stdout: 'Elevated: yes, TOKEN_ELEVATED=maybe' }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed', 'malformed probe output fails closed');
  }
  {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ outcome: 'timeout', timedOut: true, code: -1, error: 'timeout after 50ms' }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed' && /timed out/.test(r.error), 'probe timeout is reported, not hung');
  }
  {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ outcome: 'ok', code: 1, stdout: '' }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed', 'nonzero exit without a sentinel fails closed');
  }
  for (const [name, reply] of [
    ['nonzero exit', { code: 1 }],
    ['missing exit code', { code: null }],
    ['timeout', { outcome: 'timeout', timedOut: true, code: -1 }],
    ['spawn error', { outcome: 'launch-error', code: -1, error: 'spawn denied' }],
    ['error with zero exit', { code: 0, error: 'probe failed' }],
    ['unknown outcome', { outcome: 'unknown', code: 0 }]
  ]) {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ stdout: 'TOKEN_ELEVATED=1\r\n', ...reply }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed', `${name} with a valid token sentinel never grants elevation`);
  }
  for (const [name, reply] of [
    ['nonzero whoami exit', { status: 1 }],
    ['whoami process error', { status: 0, error: new Error('probe denied') }],
    ['whoami timeout signal', { status: null, signal: 'SIGTERM' }]
  ]) {
    const runner = recordingRunner({ stdout: 'TOKEN_ELEVATED=0\r\n' });
    const c = controller({ sync: () => ({ stdout: HIGH, ...reply }), runner });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'token-elevation' && runner.calls.length === 1,
      `${name} with a valid integrity SID requires a successful independent token probe`);
  }
  {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ outcome: 'launch-error', code: -1, error: 'spawn ENOENT' }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed' && /ENOENT/.test(r.error), 'PowerShell launch error surfaces as a failed probe');
  }
  {
    const c = controller({ sync: fakeSync(''), runner: async () => { throw new Error('runner exploded'); } });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed' && /exploded/.test(r.error), 'a throwing runner still resolves the probe');
  }
  {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({}) });
    const snap = c.snapshot();
    check(snap.elevated === false && snap.method === 'failed', 'snapshot fails closed when whoami gives nothing');
  }

  console.log('elevation-controller-smoke: relaunch outcomes');
  {
    const runner = recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n` });
    const c = controller({ sync: fakeSync(MEDIUM), runner });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === true && r.outcome === 'started' && r.declined === false, 'UAC approved reports started');
    const call = runner.calls[0];
    check(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(call.cmd), 'relaunch uses the absolute System32 PowerShell');
    check(call.args[0] === '-NoProfile' && call.args[1] === '-NonInteractive' && call.args[2] === '-Command',
      'relaunch argv is -NoProfile -NonInteractive -Command <script>');
    check(call.args.length === 4, 'the script is one argv entry (not flattened into several)');
    const script = call.args[3];
    check(/Start-Process -FilePath '/.test(script), 'Start-Process receives -FilePath');
    check(!/-LiteralPath/.test(script), 'Start-Process is not given -LiteralPath (not a Start-Process parameter)');
    check(/-Verb RunAs/.test(script), 'relaunch asks for the Windows approval prompt');
    check(/-ErrorAction Stop/.test(script), 'a Start-Process failure reaches the catch block');
    check(script.includes("'C:\\Program Files\\1132 Fixer\\1132 Fixer.exe'"), 'intended executable is passed');
    check(script.includes(`'${elev.ELEVATE_RETRY_FLAG}'`), 'relaunched instance carries the retry flag (no elevation loop)');
    check(call.timeoutMs === 50, 'relaunch carries the UAC deadline');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ stdout: `${elev.RELAUNCH_DECLINED}: The operation was canceled by the user.\r\n` }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.declined === true && r.outcome === 'declined', 'UAC cancelled reports declined');
  }
  {
    const sac = `${elev.RELAUNCH_DECLINED}: This program is blocked by group policy. For more information, contact your system administrator.\r\n`;
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ stdout: sac }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'declined', 'Smart App Control refusal is a decline, never a loop');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'timeout', timedOut: true, code: -1, error: 'timeout after 50ms', stdout: '' }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'timeout' && r.timedOut === true && r.declined === true, 'unanswered prompt is a bounded timeout');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'launch-error', code: -1, error: 'spawn ENOENT' }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'launch-error' && /ENOENT/.test(r.launchError), 'PowerShell missing is a launch error');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'ok', code: 0, stdout: '' }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'failed', 'child exits before emitting a result: failed, not started');
  }
  for (const [name, reply, expected] of [
    ['nonzero exit', { code: 1 }, 'failed'],
    ['missing exit code', { code: null }, 'failed'],
    ['timeout', { outcome: 'timeout', timedOut: true, code: -1 }, 'timeout'],
    ['spawn error', { outcome: 'launch-error', code: -1, error: 'spawn denied' }, 'launch-error'],
    ['error with zero exit', { code: 0, error: 'relaunch failed' }, 'failed'],
    ['unknown outcome', { outcome: 'unknown', code: 0 }, 'failed']
  ]) {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n`, ...reply }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(!r.started && r.outcome === expected, `${name} cannot promote a valid relaunch sentinel to success`);
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'ok', code: 1, stdout: 'At line:1 char:1 STARTED is not recognized' }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'failed', 'unrelated output containing STARTED is not a start');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'ok', code: 1, stdout: `NOT ${elev.RELAUNCH_STARTED}\r\n` }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false, 'sentinel must be a whole line');
  }
  {
    // Child printed the sentinel, then a grandchild kept the pipes open:
    // runTimed settles via the exit grace timer with the output intact.
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ outcome: 'ok', code: 0, stdout: `${elev.RELAUNCH_STARTED}\r\n` }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === true, 'result emitted before a delayed close still counts');
  }

  console.log('elevation-controller-smoke: quoting and special characters');
  {
    const exe = "C:\\Users\\O'Brien\\Área ünïcode\\1132 \"Fixer\".exe";
    const script = elev.buildRelaunchScript(exe, ['--flag', "it's $env:TEMP `x; y", elev.ELEVATE_RETRY_FLAG]);
    check(script.includes("'C:\\Users\\O''Brien\\Área ünïcode\\1132 \"Fixer\".exe'"), 'apostrophes doubled, quotes/Unicode/spaces untouched in the path');
    check(script.includes("'it''s $env:TEMP `x; y'"), '$, backtick and semicolon are inert inside single quotes');
    check(!/\r|\n/.test(script), 'script is a single line for -Command');
    check(script.split('Start-Process').length === 2, 'exactly one Start-Process');
  }
  {
    const script = elev.buildRelaunchScript('C:\\x.exe', []);
    check(!script.includes('-ArgumentList'), 'no -ArgumentList when there are no arguments');
  }
  {
    check(elev.parseRelaunchOutput(`  ${elev.RELAUNCH_STARTED}  \r\n`) === 'started', 'sentinel tolerates surrounding whitespace');
    check(elev.parseRelaunchOutput(`${elev.RELAUNCH_DECLINED}: x`) === 'declined', 'declined sentinel with message');
    check(elev.parseRelaunchOutput('') === null && elev.parseRelaunchOutput(null) === null, 'empty output parses to null');
  }

  console.log('elevation-controller-smoke: OS-loaded root authority');
  {
    const opts = { arch: 'x64', getReport: () => ({ sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `D:\\Win\\System32\\${name}`) }),
      env: { SystemRoot: 'C:\\Fake', WINDIR: 'C:\\Fake', PATH: 'C:\\Fake' }, existsSync: () => true };
    check(elev.resolveSystemRoot(opts) === 'D:\\Win', 'elevation root comes from loaded OS libraries');
    check(elev.systemPowerShell(opts) === 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'forged environment and matching disk shape cannot replace elevation PowerShell');
    check(elev.systemWhoami(opts) === 'D:\\Win\\System32\\whoami.exe', 'whoami uses the same loaded-library root');
    const absent = { ...opts, getReport: null };
    check(elev.systemPowerShell(absent) === null && elev.systemWhoami(absent) === null,
      'no report means no privileged executable, even with existing forged folders');
    const wow64 = { arch: 'ia32', getReport: () => ({ sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `D:\\Win\\SysWOW64\\${name}`) }) };
    check(elev.systemPowerShell(wow64) === 'D:\\Win\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe',
      'loaded WOW64 libraries select native PowerShell without an environment flag');
    const runner = recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n` });
    const missing = controller({ sync: fakeSync(HIGH), runner, env: { SystemRoot: 'C:\\Fake', PATH: 'C:\\Fake' }, getReport: null });
    const missingResult = await missing.relaunchElevated(RELAUNCH_OPTS);
    check(missingResult.outcome === 'launch-error' && runner.calls.length === 0,
      'missing OS authority reports launch error without a fixed-drive or PATH fallback');
  }

  console.log('elevation-controller-smoke: no temporary script file');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'elevation.js'), 'utf8');
    check(!/fixer-elev-/.test(src), 'fixer-elev- temp name is gone');
    check(!/['"]-File['"]/.test(src), 'no -File argument anywhere in the elevation module');
    check(!/writeFileSync|writeFile\(|os\.tmpdir/.test(src), 'elevation module never writes a file');
    check(/-LiteralPath/.test(src) === false || !/Start-Process[^\n]*-LiteralPath/.test(src), 'Start-Process never uses -LiteralPath');
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fixer-elev-')).length;
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n` }) });
    await c.relaunchElevated(RELAUNCH_OPTS);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('fixer-elev-')).length;
    check(after === before, 'relaunch leaves no fixer-elev-*.ps1 in %TEMP%');
  }

  console.log('elevation-controller-smoke: real runTimed is bounded and settles once');
  {
    const r = await elev.runTimed(process.execPath, ['-e', 'process.stdout.write("hello\\n")'], 10000);
    check(r.outcome === 'ok' && r.code === 0 && r.stdout.trim() === 'hello', 'runTimed captures stdout through close');
    const t = await elev.runTimed(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], 300);
    check(t.outcome === 'timeout' && t.timedOut === true, 'runTimed times out and kills the child');
    const e = await elev.runTimed(path.join(os.tmpdir(), 'definitely-missing-1132.exe'), [], 1000);
    check(e.outcome === 'launch-error' && !!e.error, 'runTimed reports a missing executable as launch-error');
    // Grandchild inherits stdio and outlives the child: exit fires, close is
    // delayed, the grace timer settles with the output already received.
    const grand = await elev.runTimed(process.execPath, ['-e',
      "const {spawn}=require('child_process');process.stdout.write('EARLY\\n');const g=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit',detached:true});g.unref();"
    ], 10000);
    check(grand.outcome === 'ok' && /EARLY/.test(grand.stdout) && grand.ms < 3000, 'inherited handles do not hold runTimed open past the grace period');
  }

  console.log('elevation-controller-smoke: -Command transport through real PowerShell');
  if (process.platform !== 'win32') {
    skip('PowerShell transport', 'not Windows');
  } else {
    const ps = elev.systemPowerShell();
    if (!ps || !fs.existsSync(ps)) {
      skip('PowerShell transport', 'System32 PowerShell not present');
    } else {
      const probe = "C:\\Users\\O'Brien\\Área ünïcode\\1132 \"Fixer\".exe $env:TEMP `x; y";
      const script = [
        'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
        `Write-Output ('ECHO=' + '${probe.replace(/'/g, "''")}')`
      ].join('; ');
      const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('ECHO='));
      check(r.status === 0 && line === `ECHO=${probe}`, 'apostrophes, spaces, quotes, $, backtick, semicolon and Unicode survive -Command byte-for-byte');
      const bad = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -LiteralPath 'x' -ErrorAction Stop"], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      check(bad.status !== 0 && /LiteralPath/.test(String(bad.stderr || '') + String(bad.stdout || '')), 'this host rejects Start-Process -LiteralPath (documents why -FilePath is required)');
    }
  }

  if (failures) {
    console.error(`elevation-controller-smoke: ${failures} failure(s), ${skipped} skipped`);
    process.exit(1);
  }
  console.log(`elevation-controller-smoke: all checks passed (${skipped} skipped)`);
})().catch((err) => {
  console.error('elevation-controller-smoke: crashed', err && err.stack || err);
  process.exit(1);
});
