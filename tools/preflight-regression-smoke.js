'use strict';

// Exercise the production preflight and its real repair entry guard. The
// PowerShell transport is mocked: these tests never modify Windows accounts,
// profiles, services, files or registry values, and run on every CI host.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const windowsTools = require('../src/main/windows-tools');
const messages = require('../messages');

function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `production function ${name} exists`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `production function ${name} closes`);
  return source.slice(start, end + 2);
}

function toolList(name) {
  const declaration = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`).exec(source);
  assert.ok(declaration, `production ${name} list exists`);
  return Array.from(vm.runInNewContext(declaration[1]));
}

const required = toolList('REQUIRED_TOOLS');
const optional = toolList('OPTIONAL_TOOLS');
const allTools = [...required, ...optional];
const preflightSource = functionSource('preflightCheck');
const fixSource = functionSource('runFixFlow');

function inventory(overrides = {}) {
  return {
    ...Object.fromEntries(allTools.map(tool => [tool, true])),
    seclogon_status: 'Running',
    seclogon_starttype: 'Manual',
    ...overrides
  };
}

function probe(payload, overrides = {}) {
  return {
    code: 0,
    stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
    stderr: '',
    timedOut: false,
    ...overrides
  };
}

function harness(initialProbe, healProbe, overrides = {}) {
  const calls = [];
  const destructive = [];
  const logs = [];
  const context = {
    REQUIRED_TOOLS: required,
    OPTIONAL_TOOLS: optional,
    windowsTools,
    messages,
    runPSCapture: async script => {
      calls.push(script);
      if (calls.length === 1) return initialProbe;
      assert.ok(healProbe, 'no unexpected additional PowerShell probe');
      return healProbe;
    },
    isElevatedSync: async () => true,
    os: { userInfo: () => ({ username: 'Owner' }) },
    FIX_USER: 'user1',
    getFirstRunScriptPath: () => 'C:\\App\\zoom-firstrun-setup.ps1',
    fs: { existsSync: () => true },
    resolveZoomInstall: async () => ({ path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe' }),
    zoomInstall: null,
    zoomDetect: { zoomStatusMessage: () => 'Zoom is installed.' },
    profileSafety: { redactSecrets: line => line },
    runProcess: async (...args) => {
      destructive.push(args);
      throw new Error('Destructive repair crossed a failed preflight guard');
    },
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(`${preflightSource}\n${fixSource}`, context, { filename: 'main.js:preflight-regression' });
  return {
    context,
    calls,
    destructive,
    logs,
    preflight: () => context.preflightCheck(),
    repair: () => context.runFixFlow({ sender: { send: (_channel, data) => logs.push(data) } })
  };
}

let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}

async function invalidProbe(name, response, expectedCode) {
  const pre = await harness(response).preflight();
  check(!pre.ok, `${name}: preflight blocks`);
  check(pre.blockers.length === 1 && pre.blockers[0].code === expectedCode,
    `${name}: one accurate probe blocker`);
  check(!pre.blockers.some(blocker => blocker.code === 'missing_tool'),
    `${name}: no invented missing Windows tools`);
  check(allTools.every(tool => pre.info.tools[tool] === null),
    `${name}: tool presence stays unverified`);

  const run = harness(response);
  const result = await run.repair();
  check(result.success === false && result.error === 'preflight_failed',
    `${name}: actual repair stops at preflight`);
  check(run.destructive.length === 0, `${name}: no destructive child process starts`);
  check(!run.logs.some(entry => /^\[1\/8\]/.test(entry.line)),
    `${name}: account/profile repair stage never starts`);
}

async function main() {
  console.log('preflight-regression-smoke: actual production preflight transport failures');
  await invalidProbe('empty stdout', probe(''), 'tool_probe_failed');
  await invalidProbe('empty object', probe({}), 'tool_probe_failed');
  await invalidProbe('malformed JSON', probe('blocked PowerShell output'), 'tool_probe_failed');
  await invalidProbe('nonzero with complete JSON', probe(inventory(), { code: 1 }), 'tool_probe_failed');
  await invalidProbe('timeout with complete JSON', probe(inventory(), { timedOut: true }), 'tool_probe_timeout');
  await invalidProbe('timeout with empty stdout', probe('', { code: -1, timedOut: true }), 'tool_probe_timeout');
  await invalidProbe('launch error with empty stdout', probe('', { code: -1, stderr: 'spawn powershell.exe ENOENT' }), 'tool_probe_failed');
  const partial = inventory();
  delete partial[required[0]];
  await invalidProbe('incomplete tool inventory', probe(partial), 'tool_probe_failed');
  await invalidProbe('wrong boolean type', probe(inventory({ [required[0]]: 'true' })), 'tool_probe_failed');
  await invalidProbe('array payload', probe([]), 'tool_probe_failed');
  const noService = inventory();
  delete noService.seclogon_status;
  await invalidProbe('missing service inventory', probe(noService), 'tool_probe_failed');
  await invalidProbe('wrong service type', probe(inventory({ seclogon_starttype: true })), 'tool_probe_failed');

  console.log('preflight-regression-smoke: verified presence, absence and optional tools');
  {
    const run = harness(probe(inventory()));
    const pre = await run.preflight();
    check(pre.ok && pre.blockers.length === 0, 'complete healthy inventory permits repair');
    check(allTools.every(tool => pre.info.tools[tool] === true), 'healthy tool inventory preserved');
    check(run.calls.length === 1, 'running service needs no start attempt');
    check(run.calls[0].includes('Resolve-FixerTool') && run.calls[0].includes('Test-Path'),
      'actual inventory resolves Windows executables and checks files');
    check(!run.calls[0].includes('Get-Command'), 'tool presence does not depend on inherited PATH');
  }
  {
    const missingTools = required.slice(0, 2);
    const pre = await harness(probe(inventory(Object.fromEntries(missingTools.map(tool => [tool, false]))))).preflight();
    check(!pre.ok && pre.blockers.length === 1 && pre.blockers[0].code === 'missing_tool',
      'verified absent required tools share one blocker');
    assert.deepEqual(Array.from(pre.blockers[0].tools), missingTools);
    check(missingTools.every(tool => pre.info.tools[tool] === false), 'verified absent tools stay false');
    check(required.slice(2).every(tool => pre.info.tools[tool] === true), 'other tools stay verified present');
  }
  {
    const pre = await harness(probe(inventory(Object.fromEntries(optional.map(tool => [tool, false]))))).preflight();
    check(pre.ok, 'absent optional Windows tools do not block repair');
    check(optional.every(tool => pre.info.tools[tool] === false), 'optional absence remains accurate');
  }

  console.log('preflight-regression-smoke: Secondary Logon remains a hard repair gate');
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'MISSING', seclogon_starttype: 'MISSING' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_missing'), 'missing Secondary Logon blocks repair');
  }
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'Stopped', seclogon_starttype: 'Disabled' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_disabled'), 'disabled Secondary Logon blocks repair');
  }
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'Paused', seclogon_starttype: 'Boot' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_not_running'),
      'service that is not running and cannot be started stays blocked');
  }
  {
    const run = harness(probe(inventory({ seclogon_status: 'Stopped' })), probe('SECLOGON_HEAL=RUNNING'));
    const pre = await run.preflight();
    check(pre.ok && pre.info.seclogon.status === 'Running' && pre.info.seclogon.selfHeal === 'started',
      'verified successful service start permits repair');
    check(run.calls.length === 2, 'stopped service gets one bounded start attempt');
  }
  for (const [name, response] of [
    ['service start fails', probe('SECLOGON_HEAL=FAILED=Stopped', { code: 1 })],
    ['nonzero service start with success text', probe('SECLOGON_HEAL=RUNNING', { code: 1 })],
    ['timed out service start with success text', probe('SECLOGON_HEAL=RUNNING', { timedOut: true })]
  ]) {
    const pre = await harness(probe(inventory({ seclogon_status: 'Stopped' })), response).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_start_failed'), `${name}: repair stays blocked`);
    check(pre.info.seclogon.status !== 'Running', `${name}: no false running service state`);
  }

  console.log('preflight-regression-smoke: existing elevation and helper-account safeguards');
  {
    const run = harness(probe(inventory()), undefined, { isElevatedSync: async () => false });
    const pre = await run.preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'not_elevated'),
      'healthy tools never bypass the administrator guard');
  }
  {
    const run = harness(probe(inventory()), undefined, { os: { userInfo: () => ({ username: 'USER1' }) } });
    const pre = await run.preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'running_as_target'),
      'healthy tools never allow rebuilding the signed-in helper account');
    const repair = harness(probe(inventory()), undefined, { os: { userInfo: () => ({ username: 'USER1' }) } });
    const result = await repair.repair();
    check(!result.success && result.error === 'preflight_failed' && repair.destructive.length === 0,
      'actual repair preserves the signed-in helper account');
  }
  console.log(`preflight-regression-smoke: all ${checks} checks passed`);
}

main().catch(error => {
  console.error(`preflight-regression-smoke: ${error.stack || error}`);
  process.exitCode = 1;
});
