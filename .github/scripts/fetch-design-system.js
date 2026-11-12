'use strict';

const { spawnSync } = require('child_process');

function fetchFailure(result) {
  // Classify captured diagnostics locally. Never return or log Git's raw
  // output: authentication messages can contain private URLs or headers.
  if (result && result.error && result.error.code === 'ETIMEDOUT') {
    return { ok: false, code: 'DESIGN_FETCH_TIMEOUT', reason: 'Private design-system fetch timed out. Check the runner connection before retrying.' };
  }
  const diagnostic = String(result && result.stderr || '');
  if (/repository not found|authentication failed|could not read username|access denied|permission denied|returned error: (?:401|403|404)/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_ACCESS_UNAVAILABLE', reason: 'The runner could not access the canonical private design repository. Check DESIGN_SYSTEM_TOKEN read access to 1132-Fixer/design-system. Repository absence and denied access can both appear as 404. No anonymous fallback was attempted.' };
  }
  if (/not our ref|reference is not a tree|did not contain|unadvertised object|couldn.t find remote ref/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_PIN_UNAVAILABLE', reason: 'The canonical design repository did not provide the pinned commit. Preserve the pin and verify its availability with the design owner.' };
  }
  if (/could not resolve host|failed to connect|connection timed out|connection reset|unable to access.*(?:SSL|TLS)/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_CONNECTION_FAILED', reason: 'The runner connection to the private design repository failed. Check network and TLS access without changing security protections.' };
  }
  return { ok: false, code: 'DESIGN_FETCH_FAILED', reason: 'Private design-system fetch failed. Verify repository availability, the pinned commit, and read-only credential scope. No anonymous fallback was attempted.' };
}

// GITHUB_TOKEN is scoped to this repository and cannot stand in for the
// existing, read-only DESIGN_SYSTEM_TOKEN contract. Never persist either
// credential or put the derived HTTP header on the git command line.
function fetchDesignSystem({ env = process.env, run = spawnSync } = {}) {
  const token = env.DESIGN_SYSTEM_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'DESIGN_SYSTEM_TOKEN is missing. A read-only credential for the canonical private design repository is required.' };
  }
  const childEnv = { ...env };
  delete childEnv.DESIGN_SYSTEM_TOKEN;
  for (const key of Object.keys(childEnv)) {
    if (/^GIT_TRACE/i.test(key) || key === 'GIT_CURL_VERBOSE' || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete childEnv[key];
  }
  const options = { env: childEnv, encoding: 'utf8', timeout: 120000, windowsHide: true };
  const invoke = args => {
    try { return run('git', args, options); } catch (_) { return null; }
  };
  const clean = result => !!result && result.status === 0 && !result.error && !result.signal;
  const url = invoke(['config', '-f', '.gitmodules', '--get', 'submodule.design-system.url']);
  if (!clean(url) || String(url.stdout || '').trim() !== 'https://github.com/1132-Fixer/design-system.git') {
    return { ok: false, reason: 'Canonical design-system URL is missing or changed. No credentialed fetch was attempted.' };
  }
  const pin = invoke(['rev-parse', 'HEAD:design-system']);
  const expected = String(pin && pin.stdout || '').trim();
  if (!clean(pin) || !/^[0-9a-f]{40}$/.test(expected)) {
    return { ok: false, reason: 'Pinned design-system commit could not be verified.' };
  }
  childEnv.GIT_CONFIG_COUNT = '1';
  childEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
  childEnv.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
  const fetched = invoke(['submodule', 'update', '--init', '--depth=1', '--', 'design-system']);
  delete childEnv.GIT_CONFIG_COUNT;
  delete childEnv.GIT_CONFIG_KEY_0;
  delete childEnv.GIT_CONFIG_VALUE_0;
  delete childEnv.DESIGN_SYSTEM_TOKEN;
  if (!clean(fetched)) {
    return fetchFailure(fetched);
  }
  const head = invoke(['-C', 'design-system', 'rev-parse', 'HEAD']);
  if (!clean(head) || String(head.stdout || '').trim() !== expected) {
    return { ok: false, reason: 'Fetched design-system commit does not match the consumer pin.' };
  }
  return { ok: true, reason: 'Pinned design-system commit verified.' };
}

if (require.main === module) {
  const result = fetchDesignSystem();
  // Git output can contain credential diagnostics. Report only a fixed,
  // classified message, never raw stdout/stderr or inherited environment.
  (result.ok ? console.log : console.error)((result.code ? result.code + ': ' : '') + result.reason);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { fetchDesignSystem };
