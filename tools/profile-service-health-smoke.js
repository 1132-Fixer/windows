'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PROFILE_SERVICE_PROBE, checkProfileServiceHealth } = require('../src/main/profile-service-health');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let checks = 0;
function check(condition, label) {
  assert.ok(condition, label);
  checks++;
}

async function mainTest() {
  const healthy = { code: 0, stdout: 'PROFILE_SERVICES=RUNNING\r\n', stderr: '', timedOut: false };
  let observed;
  check((await checkProfileServiceHealth(async (script, options) => {
    observed = { script, options };
    return healthy;
  })).ok, 'healthy service evidence accepted');
  check(observed.script === PROFILE_SERVICE_PROBE && observed.options.timeoutMs === 20000,
    'real read-only probe uses bounded adapter');
  check(/Get-Service -Name ProfSvc, UserManager -ErrorAction Stop/.test(PROFILE_SERVICE_PROBE),
    'both shared services must be readable');
  check(PROFILE_SERVICE_PROBE.includes("$services.Count -ne 2") &&
    PROFILE_SERVICE_PROBE.includes("$_.Status -ne 'Running'"), 'missing and non-running services rejected');

  const invalid = [
    null, undefined, {},
    { ...healthy, code: 1 }, { ...healthy, code: null },
    { ...healthy, timedOut: true }, { ...healthy, stdout: '' },
    { ...healthy, stdout: 'PROFILE_SERVICES=UNHEALTHY' },
    { ...healthy, stdout: 'PROFILE_SERVICES=RUNNING\nPROFILE_SERVICES=UNHEALTHY' },
    { ...healthy, stdout: 'unexpected output\nPROFILE_SERVICES=RUNNING' },
    { ...healthy, stderr: 'Get-Service failed' },
    { ...healthy, stdout: 'PROFSVC_REFRESH=OK' }
  ];
  for (const result of invalid) {
    const decision = await checkProfileServiceHealth(async () => result);
    check(decision.ok === false && typeof decision.code === 'string', 'uncertain service evidence blocks');
  }
  check(!(await checkProfileServiceHealth(async () => { throw new Error('adapter failure'); })).ok,
    'adapter exception blocks');

  // Execute the actual orchestration gate fragments with mocked health and
  // logging adapters. A failed probe must return before either next stage.
  const functionStart = main.indexOf('async function runFixFlow');
  const startGate = main.indexOf('  const profileServiceStart = ', functionStart);
  const step1 = main.indexOf('  // STEP 1:', startGate);
  const endGate = main.indexOf("  send('[3b/8] Checking Windows profile services...", step1);
  const step4 = main.indexOf('  // STEP 4:', endGate);
  check(startGate > functionStart && startGate < step1 && endGate > step1 && step4 > endGate,
    'service gates wrap helper teardown before account creation');

  for (const [start, end] of [[startGate, step1], [endGate, step4]]) {
    const gate = new AsyncFunction('checkProfileServiceHealth', 'runPSCapture', 'send', 'step', 'warnings', 'steps',
      main.slice(start, end) + '\nreturn { continued: true };');
    for (const ok of [false, true]) {
      const lines = [];
      const outcomes = [];
      let calls = 0;
      const result = await gate(async adapter => {
        check(typeof adapter === 'function', 'real capture adapter forwarded');
        calls++;
        return { ok, code: ok ? null : 'profile_services_unverified' };
      }, async () => healthy, (...args) => lines.push(args), (...args) => outcomes.push(args), [], []);
      check(calls === 1, 'one bounded health decision per gate');
      check(ok ? result.continued === true : result.success === false &&
        result.error === 'profile_services_unverified' && !result.continued, 'gate continues only with proof');
      if (!ok) check(lines.some(args => args[1] === 'err'), 'refusal has a visible error');
    }
  }

  check(!/\b(?:Restart-Service|Stop-Service)\s+(?:-Name\s+)?ProfSvc\b/i.test(main),
    'repair never stops or restarts ProfSvc');
  check(!/sc\.exe\s+(?:stop|start)\s+ProfSvc\b/i.test(main), 'no sc.exe fallback for ProfSvc');
  check(!/\b(?:Restart-Service|Stop-Service|Start-Service|Set-Service)\b|\bsc\.exe\b|\breg\.exe\b/i.test(PROFILE_SERVICE_PROBE),
    'health probe cannot mutate services or registry');
  console.log(`profile-service-health-smoke: ${checks} checks passed`);
}

mainTest().catch(error => { console.error(error); process.exitCode = 1; });
