'use strict';

/**
 * Elevation controller behaviour tests for 1132 Fixer.
 *
 * Fake runners cover elevation, UAC approval/decline, unavailable tools,
 * launch/probe/relaunch failures, malformed results and interrupted output.
 * Owned Node fixtures cover bounded children and inherited stdio.
 *
 * Live transport uses PowerShell 7 without RunAs or execution-policy changes.
 * It preserves apostrophes, spaces, quotes, dollar signs, backticks, semicolons
 * and Unicode through the production protected-host bootstrap and stdin.
 * Missing PowerShell 7 fails usefully. UAC stays mocked throughout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const elev = require('../src/main/elevation');
const ps7Host = require('../src/main/powershell7');

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

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
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
  const fn = async (cmd, args, timeoutMs, options) => {
    calls.push({ cmd, args, timeoutMs, options });
    const r = typeof reply === 'function' ? reply(cmd, args, timeoutMs, options) : reply;
    return { outcome: 'ok', timedOut: false, code: 0, error: null, stdout: '', stderr: '', ms: 1, stdinComplete: true, ...r };
  };
  fn.calls = calls;
  return fn;
}
const protectedFs = {
  realpathSync: value => value,
  lstatSync: value => ({ isSymbolicLink: () => false, isFile: () => value === ps7Host.PWSH_PATH })
};
function controller(opts) {
  return elev.createElevationController({
    spawnSync: opts.sync,
    runTimed: opts.runner,
    preparePowerShellScript: opts.prepareScript || (script => ps7Host.preparePowerShellScript(script, { fs: protectedFs })),
    probeMs: opts.probeMs || 50,
    relaunchMs: opts.relaunchMs || 50
  });
}
const RELAUNCH_OPTS = {
  execPath: 'C:\\Program Files\\1132 Fixer\\1132 Fixer.exe',
  isPackaged: true,
  appPath: 'C:\\Program Files\\1132 Fixer\\resources\\app.asar',
  argv: ['C:\\Program Files\\1132 Fixer\\1132 Fixer.exe']
};

(async () => {
  const ps7 = requirePowerShell7();
  console.log('elevation-controller-smoke: native PowerShell ' + ps7.version + ' (' + ps7.edition + '); UAC stays mocked');
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
    check(runner.calls.length === 1 && runner.calls[0].cmd === ps7Host.PWSH_PATH, 'mock fallback uses the protected Core7 resolver');
    check(runner.calls[0].args.includes('-Command') && !runner.calls[0].args.includes('-File'), 'fallback is -Command, never -File');
    check(JSON.stringify(runner.calls[0].args) === JSON.stringify(ps7Host.SCRIPT_ARGS), 'fallback argv contains only the fixed Core7 bootstrap');
    check(Buffer.isBuffer(runner.calls[0].options.stdinInput) && runner.calls[0].options.stdinInput.toString() === elev.TOKEN_PROBE_PS,
      'token probe source travels through bounded UTF8 stdin');
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
  for (const reply of [{ outcome: 'ok', code: 1 }, { outcome: 'timeout', timedOut: true }, { stdinComplete: false },
    { cleanupConfirmed: false }, { stdoutTruncated: true }, { stderrTruncated: true }]) {
    const c = controller({ sync: fakeSync(''), runner: recordingRunner({ stdout: 'TOKEN_ELEVATED=1\r\n', ...reply }) });
    const r = await c.isElevated();
    check(r.elevated === false && r.method === 'failed', 'positive token text cannot override failed exit, timeout, incomplete IO or uncertain cleanup');
  }
  {
    const runner = recordingRunner({ stdout: 'TOKEN_ELEVATED=1\r\n' });
    const missingFs = { realpathSync() { throw new Error('missing host'); } };
    const c = controller({ sync: fakeSync(''), runner,
      prepareScript: script => ps7Host.preparePowerShellScript(script, { fs: missingFs }) });
    const r = await c.isElevated();
    check(r.elevated === false && /PowerShell 7/.test(r.error), 'unavailable protected host fails the token probe usefully');
    check(runner.calls.length === 0, 'missing Core7 host never falls back to another executable');
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
    check(call.cmd === ps7Host.PWSH_PATH, 'mock relaunch uses the absolute protected Core7 host');
    check(JSON.stringify(call.args) === JSON.stringify(ps7Host.SCRIPT_ARGS), 'relaunch argv is the fixed Core7 stdin bootstrap');
    check(call.args.length === 5 && !call.args.join(' ').includes(RELAUNCH_OPTS.execPath), 'target-specific source is absent from argv');
    const script = call.options.stdinInput.toString('utf8');
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
  for (const reply of [{ code: 1 }, { stdinComplete: false }, { stdoutTruncated: true }, { stderrTruncated: true }]) {
    const c = controller({ sync: fakeSync(MEDIUM), runner: recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n`, ...reply }) });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.started === false && r.outcome === 'failed', 'started text cannot override failed exit or incomplete IO');
  }
  {
    const runner = recordingRunner({ stdout: `${elev.RELAUNCH_STARTED}\r\n` });
    const c = controller({ sync: fakeSync(MEDIUM), runner,
      prepareScript: () => { throw new Error('host denied'); } });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.outcome === 'launch-error' && /PowerShell 7/.test(r.launchError), 'missing protected Core7 produces useful relaunch failure');
    check(runner.calls.length === 0, 'relaunch never selects an alternate host on resolver failure');
  }
  {
    const c = controller({ sync: fakeSync(MEDIUM), runner: async () => { throw new Error('private runner exception'); } });
    const r = await c.relaunchElevated(RELAUNCH_OPTS);
    check(r.outcome === 'launch-error' && r.started === false && !r.launchError.includes('private'), 'throwing UAC runner resolves with sanitized launch error');
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

  console.log('elevation-controller-smoke: SystemRoot resolution');
  {
    const exists = (p) => p === 'D:\\Win' || p === 'C:\\Windows';
    check(elev.resolveSystemRoot({ SystemRoot: 'D:\\Win' }, exists) === 'D:\\Win', 'absolute existing SystemRoot is used');
    check(elev.resolveSystemRoot({ SystemRoot: 'Win' }, exists) === 'C:\\Windows', 'relative SystemRoot is ignored');
    check(elev.resolveSystemRoot({}, exists) === 'C:\\Windows', 'missing SystemRoot falls back to C:\\Windows');
    check(elev.resolveSystemRoot({ SystemRoot: 'D:\\Nope' }, exists) === 'C:\\Windows', 'nonexistent SystemRoot falls back');
    check(elev.resolveSystemRoot({}, () => false) === null, 'no Windows directory at all resolves to null');
    check(elev.systemPowerShell({ fs: protectedFs }) === ps7Host.PWSH_PATH, 'PowerShell uses the maintained protected Core7 path');
    check(elev.systemPowerShell({ fs: { realpathSync() { throw new Error('not found'); } } }) === null, 'missing protected PowerShell resolves to null');
    check(elev.systemPowerShell({ fs: { ...protectedFs, realpathSync: () => 'D:\\Untrusted\\pwsh.exe' } }) === null, 'redirected host is refused');
    check(elev.systemPowerShell({ fs: { ...protectedFs, lstatSync: () => ({ isSymbolicLink: () => true }) } }) === null, 'reparse host ancestry is refused');
  }

  console.log('elevation-controller-smoke: no temporary script file');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'elevation.js'), 'utf8');
    check(!/fixer-elev-/.test(src), 'fixer-elev- temp name is gone');
    check(!/['"]-File['"]/.test(src), 'no -File argument anywhere in the elevation module');
    check(!/writeFileSync|writeFile\(|os\.tmpdir/.test(src), 'elevation module never writes a file');
    check(!/WindowsPowerShell|ExecutionPolicy|taskkill/.test(src), 'elevation has no legacy host, policy override or PID tree kill');
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

  console.log('elevation-controller-smoke: fixed bootstrap and stdin through protected PowerShell 7');
  {
    const probe = "C:\\Users\\O'Brien\\Área ünïcode\\1132 \"Fixer\".exe $env:TEMP `x; y";
    const script = [
      'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
      "Write-Output ('ECHO=' + '" + probe.replace(/'/g, "''") + "')"
    ].join('; ');
    const invocation = ps7Host.preparePowerShellScript(script);
    check(!invocation.args.join(' ').includes(probe), 'native quoting fixture remains out of bootstrap argv');
    const r = await elev.runTimed(invocation.exe, invocation.args, 20000, { stdinInput: invocation.input });
    const line = String(r.stdout || '').split(/\r?\n/).find(value => value.startsWith('ECHO='));
    check(r.outcome === 'ok' && r.code === 0 && r.stdinComplete === true && line === 'ECHO=' + probe,
      'apostrophes, spaces, quotes, $, backtick, semicolon and Unicode survive production stdin transport byte-for-byte');

    // Parameter binding must fail before any launch. WhatIf also prevents
    // launching a target if a future host ever adds this unsupported parameter.
    const badInvocation = ps7Host.preparePowerShellScript("Start-Process -LiteralPath 'x' -WhatIf -ErrorAction Stop");
    const bad = await elev.runTimed(badInvocation.exe, badInvocation.args, 20000, { stdinInput: badInvocation.input });
    check(bad.code !== 0 && bad.stdinComplete === true && /LiteralPath/.test(String(bad.stderr || '') + String(bad.stdout || '')),
      'PowerShell 7 rejects Start-Process -LiteralPath (the product uses -FilePath)');
  }
  if (failures) {
    console.error('elevation-controller-smoke: ' + failures + ' failure(s)');
    process.exit(1);
  }
  console.log('elevation-controller-smoke: all checks passed; no transport checks skipped');
})().catch((err) => {
  console.error('elevation-controller-smoke: crashed', err && err.stack || err);
  process.exit(1);
});
