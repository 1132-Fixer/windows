'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// GitHub's published Ed25519 host key. The deploy-key transport refuses any
// other host key; it never learns one on first use.
const GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const DESIGN_HTTPS_URL = 'https://github.com/1132-Fixer/design-system.git';
const DESIGN_SSH_URL = 'git@github.com:1132-Fixer/design-system.git';

// Write the read-only deploy key and the pinned host key into a private
// temporary directory. The caller removes the directory in a finally block.
function stageDeployKey(deployKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-design-key-'));
  const keyFile = path.join(dir, 'key');
  const hostsFile = path.join(dir, 'known_hosts');
  fs.writeFileSync(keyFile, deployKey.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.writeFileSync(hostsFile, GITHUB_HOST_KEY + '\n', { mode: 0o600 });
  if (process.platform === 'win32' && process.env.USERNAME) {
    // OpenSSH on Windows refuses a private key that other accounts can read.
    // Full control for the current account only, so the cleanup can delete it.
    spawnSync('icacls', [keyFile, '/inheritance:r', '/grant:r', process.env.USERNAME + ':(F)'],
      { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  }
  const posix = file => file.replace(/\\/g, '/');
  const sshCommand = 'ssh -F none -i "' + posix(keyFile) + '" -o IdentitiesOnly=yes -o IdentityAgent=none' +
    ' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="' + posix(hostsFile) + '"';
  return { dir, sshCommand };
}

function fetchFailure(result) {
  // Classify captured diagnostics locally. Never return or log Git's raw
  // output: authentication messages can contain private URLs or headers.
  if (result && result.error && result.error.code === 'ETIMEDOUT') {
    return { ok: false, code: 'DESIGN_FETCH_TIMEOUT', reason: 'Private design-system fetch timed out. Check the runner connection before retrying.' };
  }
  const diagnostic = String(result && result.stderr || '');
  if (/repository not found|authentication failed|could not read username|access denied|permission denied|returned error: (?:401|403|404)/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_ACCESS_UNAVAILABLE', reason: 'The runner could not access the canonical private design repository. Check that DESIGN_SYSTEM_DEPLOY_KEY (or DESIGN_SYSTEM_TOKEN) has read access to 1132-Fixer/design-system. Repository absence and denied access can both appear as 404. No anonymous fallback was attempted.' };
  }
  if (/not our ref|reference is not a tree|did not contain|unadvertised object|couldn.t find remote ref/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_PIN_UNAVAILABLE', reason: 'The canonical design repository did not provide the pinned commit. Preserve the pin and verify its availability with the design owner.' };
  }
  if (/could not resolve host|failed to connect|connection timed out|connection reset|host key verification failed|unable to access.*(?:SSL|TLS)/i.test(diagnostic)) {
    return { ok: false, code: 'DESIGN_FETCH_CONNECTION_FAILED', reason: 'The runner connection to the private design repository failed. Check network and TLS access without changing security protections.' };
  }
  return { ok: false, code: 'DESIGN_FETCH_FAILED', reason: 'Private design-system fetch failed. Verify repository availability, the pinned commit, and read-only credential scope. No anonymous fallback was attempted.' };
}

// GITHUB_TOKEN is scoped to this repository and cannot stand in for the
// existing, read-only DESIGN_SYSTEM_TOKEN contract. Never persist either
// credential or put the derived HTTP header on the git command line.
//
// DESIGN_SYSTEM_DEPLOY_KEY is the preferred credential: a read-only deploy key
// that can read only 1132-Fixer/design-system. When it is present the token is
// not used. The key exists on disk only for the duration of the fetch.
function fetchDesignSystem({ env = process.env, run = spawnSync } = {}) {
  const token = env.DESIGN_SYSTEM_TOKEN;
  const deployKey = env.DESIGN_SYSTEM_DEPLOY_KEY;
  const useDeployKey = typeof deployKey === 'string' && deployKey.trim().length > 0;
  if (!useDeployKey && (typeof token !== 'string' || token.length === 0)) {
    return { ok: false, reason: 'DESIGN_SYSTEM_DEPLOY_KEY and DESIGN_SYSTEM_TOKEN are both missing. A read-only credential for the canonical private design repository is required.' };
  }
  const childEnv = { ...env };
  delete childEnv.DESIGN_SYSTEM_TOKEN;
  delete childEnv.DESIGN_SYSTEM_DEPLOY_KEY;
  delete childEnv.GIT_SSH;
  delete childEnv.GIT_SSH_COMMAND;
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
  let staged = null;
  let fetched = null;
  try {
    if (useDeployKey) {
      staged = stageDeployKey(deployKey);
      childEnv.GIT_CONFIG_COUNT = '2';
      childEnv.GIT_CONFIG_KEY_0 = 'url.' + DESIGN_SSH_URL + '.insteadOf';
      childEnv.GIT_CONFIG_VALUE_0 = DESIGN_HTTPS_URL;
      childEnv.GIT_CONFIG_KEY_1 = 'core.sshCommand';
      childEnv.GIT_CONFIG_VALUE_1 = staged.sshCommand;
    } else {
      childEnv.GIT_CONFIG_COUNT = '1';
      childEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      childEnv.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
    }
    fetched = invoke(['submodule', 'update', '--init', '--depth=1', '--', 'design-system']);
  } catch (_) {
    fetched = null;
  } finally {
    if (staged) {
      try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch (_) { /* best effort; the runner temp is discarded */ }
    }
  }
  delete childEnv.GIT_CONFIG_COUNT;
  delete childEnv.GIT_CONFIG_KEY_0;
  delete childEnv.GIT_CONFIG_VALUE_0;
  delete childEnv.GIT_CONFIG_KEY_1;
  delete childEnv.GIT_CONFIG_VALUE_1;
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
