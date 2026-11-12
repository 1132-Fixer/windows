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
    if (calls.length === 3 && options.fetchError) return options.fetchError;
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
check(ok.calls.every(call => !('DESIGN_SYSTEM_TOKEN' in call.env)),
  'the private token variable never enters a git child environment');
check(ok.calls.slice(0, 2).every(call => !('GIT_CONFIG_VALUE_0' in call.env)),
  'local URL and pin checks receive no authorization header');
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
for (const [fetchError, code] of [
  [{ status: 128, stderr: 'remote: Repository not found. ' + token }, 'DESIGN_FETCH_ACCESS_UNAVAILABLE'],
  [{ status: 128, stderr: 'fatal: Authentication failed ' + token }, 'DESIGN_FETCH_ACCESS_UNAVAILABLE'],
  [{ status: 128, stderr: 'fatal: not our ref ' + pin }, 'DESIGN_FETCH_PIN_UNAVAILABLE'],
  [{ status: 128, stderr: 'fatal: Could not resolve host: github.com ' + token }, 'DESIGN_FETCH_CONNECTION_FAILED'],
  [{ status: null, error: { code: 'ETIMEDOUT', message: token } }, 'DESIGN_FETCH_TIMEOUT'],
  [{ status: 128, stderr: 'unclassified ' + token }, 'DESIGN_FETCH_FAILED']
]) {
  const failed = fixture({ fetchError });
  check(!failed.result.ok && failed.result.code === code, 'fetch failure has a useful fixed classification');
  check(!JSON.stringify(failed.result).includes(token) && failed.calls.length === 3,
    'classified failure discloses no diagnostic or secret and performs no retry');
}
// Read-only deploy key transport: preferred when present, never mixed with the token.
{
  const fs = require('fs');
  const keyText = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-opaque-key-material\n-----END OPENSSH PRIVATE KEY-----';
  const calls = [];
  let keyFileDuringFetch = null;
  let keyBodyDuringFetch = null;
  const env = { DESIGN_SYSTEM_DEPLOY_KEY: keyText, DESIGN_SYSTEM_TOKEN: token, GIT_SSH_COMMAND: 'ssh -v', GIT_SSH: 'unexpected' };
  const result = fetchDesignSystem({ env, run: (exe, args, settings) => {
    calls.push({ exe, args, env: { ...settings.env } });
    if (calls.length === 3) {
      const match = /-i "([^"]+)"/.exec(settings.env.GIT_CONFIG_VALUE_1 || '');
      keyFileDuringFetch = match && match[1];
      keyBodyDuringFetch = keyFileDuringFetch && fs.readFileSync(keyFileDuringFetch, 'utf8');
    }
    return { status: 0, stdout: calls.length === 1 ? canonical : pin };
  } });
  check(result.ok && calls.length === 4, 'deploy-key fetch is followed by exact-head readback');
  check(calls.every(call => !('DESIGN_SYSTEM_DEPLOY_KEY' in call.env) && !('DESIGN_SYSTEM_TOKEN' in call.env) &&
    !('GIT_SSH_COMMAND' in call.env) && !('GIT_SSH' in call.env)),
    'neither credential nor an inherited ssh override enters a git child environment');
  check(calls.every(call => !JSON.stringify(call.args).includes('fixture-opaque-key-material') && !call.args.includes('-c')),
    'key material never enters command arguments');
  check(calls[2].env.GIT_CONFIG_COUNT === '2' &&
    calls[2].env.GIT_CONFIG_KEY_0 === 'url.git@github.com:1132-Fixer/design-system.git.insteadOf' &&
    calls[2].env.GIT_CONFIG_VALUE_0 === canonical && calls[2].env.GIT_CONFIG_KEY_1 === 'core.sshCommand',
    'only the canonical design URL is rewritten to the deploy-key transport');
  check(!JSON.stringify(calls[2].env).includes('x-access-token') && !JSON.stringify(calls[2].env).includes('extraheader'),
    'the token header is not sent when the deploy key is used');
  const ssh = calls[2].env.GIT_CONFIG_VALUE_1;
  check(/-o StrictHostKeyChecking=yes/.test(ssh) && /-o IdentitiesOnly=yes/.test(ssh) && /-o BatchMode=yes/.test(ssh) &&
    /-F none/.test(ssh) && /UserKnownHostsFile="/.test(ssh) && !ssh.includes('fixture-opaque-key-material'),
    'ssh pins the host key, uses only the staged key and cannot prompt');
  check(keyBodyDuringFetch === keyText + '\n', 'the staged key file holds the exact key with one trailing newline');
  check(keyFileDuringFetch && !fs.existsSync(keyFileDuringFetch), 'the staged key is removed after the fetch');
  check(calls.slice(0, 2).concat(calls.slice(3)).every(call => !('GIT_CONFIG_VALUE_1' in call.env) && !('GIT_CONFIG_VALUE_0' in call.env)),
    'local checks and readback receive no transport configuration');
  let leaked = null;
  const failed = fetchDesignSystem({ env: { DESIGN_SYSTEM_DEPLOY_KEY: keyText }, run: (exe, args, settings) => {
    if (args[0] === 'config') return { status: 0, stdout: canonical };
    if (args[0] === 'rev-parse') return { status: 0, stdout: pin };
    leaked = (/-i "([^"]+)"/.exec(settings.env.GIT_CONFIG_VALUE_1 || '') || [])[1];
    return { status: 128, stderr: 'git@github.com: Permission denied (publickey). fixture-opaque-key-material' };
  } });
  check(!failed.ok && failed.code === 'DESIGN_FETCH_ACCESS_UNAVAILABLE' && !JSON.stringify(failed).includes('fixture-opaque-key-material'),
    'a refused deploy key is classified without disclosing diagnostics');
  check(leaked && !fs.existsSync(leaked), 'the staged key is removed after a failed fetch');
  const hostKey = fetchDesignSystem({ env: { DESIGN_SYSTEM_DEPLOY_KEY: keyText }, run: (exe, args) => {
    if (args[0] === 'config') return { status: 0, stdout: canonical };
    if (args[0] === 'rev-parse') return { status: 0, stdout: pin };
    return { status: 128, stderr: 'Host key verification failed.' };
  } });
  check(!hostKey.ok && hostKey.code === 'DESIGN_FETCH_CONNECTION_FAILED', 'a changed host key blocks the fetch');
}
console.log(`design-fetch-smoke: ${checks} checks passed`);
