'use strict';

const assert = require('assert/strict');
const { fetchDesignSystem } = require('../.github/scripts/fetch-design-system');
const token = 'fixture-opaque-token';
const pin = '516b5ac7d53c488b9ac4266402318fcabf24189f';
const canonical = 'https://github.com/1132-Fixer/design-system.git';
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
let missingCalls = 0;
check(!fetchDesignSystem({ env: {}, run: () => { missingCalls++; } }).ok && missingCalls === 0,
  'missing private credential fails before any git/network operation');

function fixture(options = {}) {
  const calls = [];
  const env = { DESIGN_SYSTEM_TOKEN: token, GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'unexpected', GIT_CONFIG_VALUE_0: 'unexpected' };
  const result = fetchDesignSystem({ env, run: (exe, args, settings) => {
    calls.push({ exe, args, env: { ...settings.env }, timeout: settings.timeout });
    if (options.throwAt === calls.length) throw new Error(token);
    if (options.failAt === calls.length) return { status: 128, stdout: token, stderr: token };
    const stdout = calls.length === 1 ? options.url || canonical : calls.length === 2 ? options.pin || pin : pin;
    if (calls.length === 4 && options.wrongHead) return { status: 0, stdout: 'a'.repeat(40) };
    return { status: 0, stdout };
  } });
  return { calls, env, result };
}
const ok = fixture();
check(ok.result.ok && ok.calls.length === 4, 'canonical pin fetch is followed by exact-head readback');
check(ok.calls.every(call => call.exe === 'git' && call.timeout === 120000), 'all git operations have bounded deadlines');
check(ok.calls.every(call => !JSON.stringify(call.args).includes(token) && !call.args.includes('-c')),
  'credential and derived header never enter command arguments');
check(ok.calls.every(call => !('GIT_TRACE_CURL' in call.env) && !('GIT_CURL_VERBOSE' in call.env)),
  'inherited tracing cannot print the private header');
check(ok.calls[2].env.GIT_CONFIG_KEY_0 === 'http.https://github.com/.extraheader' &&
  ok.calls[2].env.GIT_CONFIG_VALUE_0.endsWith(Buffer.from('x-access-token:' + token).toString('base64')),
  'private header exists only in scoped child environment for the fetch');
check(!('GIT_CONFIG_VALUE_0' in ok.calls[3].env) && !('DESIGN_SYSTEM_TOKEN' in ok.calls[3].env),
  'readback has no private fetch credential');
check(ok.env.DESIGN_SYSTEM_TOKEN === token && ok.env.GIT_CONFIG_VALUE_0 === 'unexpected',
  'parent environment is preserved');
for (const options of [{ url: 'https://untrusted.example/repo' }, { pin: 'unverified' }, { wrongHead: true },
  ...[1, 2, 3, 4].map(failAt => ({ failAt })), ...[1, 2, 3, 4].map(throwAt => ({ throwAt }))]) {
  const run = fixture(options);
  check(!run.result.ok && !JSON.stringify(run.result).includes(token), 'failure blocks and returns no secret/raw git output');
  if (options.url || options.pin) check(run.calls.length < 3, 'unverified URL or pin never reaches credentialed fetch');
}
console.log(`design-fetch-smoke: ${checks} checks passed`);
