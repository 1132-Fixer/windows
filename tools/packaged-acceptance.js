'use strict';

/**
 * Packaged-build acceptance driver for 1132 Fixer (Windows).
 *
 * Launches the REAL packaged executable (dist/win-unpacked/1132 Fixer.exe by
 * default) through Playwright's Electron driver, walks the user journey, and
 * writes screenshots plus a machine-readable report. It is the evidence that
 * the shipped binary starts, leaves "Checking" within the deadline, renders
 * every state without scrollbars, and that Fix now drives the real repair
 * orchestrator — not a mock, not the dev checkout.
 *
 * What it proves, per case, is written to <out>/report.json and
 * <out>/report.md with one of: passed | failed | not-run (with the reason).
 * A case that could not run on this host is reported as not-run, never as
 * passed.
 *
 * Run:  node tools/packaged-acceptance.js [--exe <path>] [--out <dir>]
 *                                         [--scales 1,1.25,1.5]
 *                                         [--fix-timeout-ms 360000]
 *                                         [--skip-fix] [--test-copy]
 *                                         [--artifact-kind setup|portable]
 *                                         [--artifact-head <sha>] [--expected-head <sha>]
 *                                         [--expected-exe-sha256 <sha256>]
 *                                         [--expected-support-endpoint <https-url>]
 *                                         [--expected-config-revision <sha256>]
 *                                         [--operator-attestation <json-file>]
 *
 * Exit code 1 when any case fails or a mandatory case does not run. Optional
 * not-run cases remain explicit in the report without changing the exit code.
 *
 * Native release-evidence expectations: disposable Windows, UAC enabled, an
 * elevated (administrator) session, no Smart App Control enforcement, exact
 * artifact identity and an operator attestation. GitHub-hosted runners use
 * --test-copy for non-interactive diagnostic automation; that modified-manifest
 * run is never native final-artifact acceptance.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const screenActions = require(path.join(ROOT, 'screen-actions.js'));
const windowsTools = require(path.join(ROOT, 'src', 'main', 'windows-tools.js'));
const supportClient = require(path.join(ROOT, 'src', 'main', 'support-client.js'));
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const SHIPPED_EXE = path.resolve(argOf('--exe', path.join(ROOT, 'dist', 'win-unpacked', '1132 Fixer.exe')));
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'acceptance-evidence')));
// --test-copy: drive a throwaway copy of the unpacked app whose exe manifest
// is stamped asInvoker. This lets non-interactive automation drive packaged
// code without claiming to exercise the shipped requireAdministrator manifest
// or an operator's UAC choice. The shipped artifact is not modified. The report
// records which binary was driven.
const TEST_COPY = has('--test-copy');
const SCALES = String(argOf('--scales', '1,1.25,1.5')).split(',').map(Number).filter((n) => n > 0);
const FIX_TIMEOUT_MS = Number(argOf('--fix-timeout-ms', 360000));
const SKIP_FIX = has('--skip-fix');
const ACCEPTANCE_MODE = TEST_COPY && SKIP_FIX
  ? 'diagnostic-test-copy-skip-fix'
  : TEST_COPY
    ? 'diagnostic-test-copy'
    : SKIP_FIX
      ? 'diagnostic-skip-fix'
      : 'native-candidate';

function normalizeHead(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{40}$/.test(text) ? text : '';
}

function normalizeSha256(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function normalizeArtifactKind(value) {
  return value === 'setup' || value === 'portable' ? value : '';
}

function loadOperatorAttestation(file) {
  const empty = { present: !!file, valid: false };
  if (!file) return empty;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = [
      'artifactHead', 'artifactKind', 'disposableWindowsBoundary', 'executableSha256',
      'schemaVersion', 'supportConfigRevision', 'uacAcceptObserved',
      'uacCancelObserved', 'uacEnabled'
    ];
    const keys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
    const exactShape = keys.length === allowed.length &&
      keys.every((key, index) => key === allowed[index]);
    const safe = {
      present: true,
      valid: exactShape && value.schemaVersion === 1 &&
        !!normalizeArtifactKind(value.artifactKind) && !!normalizeHead(value.artifactHead) &&
        !!normalizeSha256(value.executableSha256) && !!normalizeSha256(value.supportConfigRevision) &&
        value.uacEnabled === true && value.uacAcceptObserved === true &&
        value.uacCancelObserved === true && value.disposableWindowsBoundary === true
    };
    if (!safe.valid) return safe;
    return {
      ...safe,
      schemaVersion: 1,
      artifactKind: normalizeArtifactKind(value.artifactKind),
      artifactHead: normalizeHead(value.artifactHead),
      executableSha256: normalizeSha256(value.executableSha256),
      supportConfigRevision: normalizeSha256(value.supportConfigRevision),
      uacEnabled: true,
      uacAcceptObserved: true,
      uacCancelObserved: true,
      disposableWindowsBoundary: true
    };
  } catch (_) {
    return empty;
  }
}

function nativeReleaseEligibility(facts, cases) {
  const reasons = [];
  const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  const rows = Array.isArray(cases) ? cases : [];
  if (facts.testCopy) add('test-copy');
  if (facts.skipFix) add('skip-fix');
  if (facts.platform !== 'win32') add('non-windows-host');
  if (facts.enableLUA !== 1) add('uac-not-enabled');
  if (!normalizeArtifactKind(facts.artifactKind)) add('artifact-kind-unbound');
  if (!normalizeHead(facts.artifactHead) || !normalizeHead(facts.expectedHead)) add('head-unbound');
  else if (facts.artifactHead !== facts.expectedHead) add('mixed-head');
  if (!normalizeSha256(facts.expectedExeSha256)) add('expected-binary-hash-missing');
  if (!normalizeSha256(facts.shippedExeSha256) || !normalizeSha256(facts.drivenExeSha256) ||
      facts.shippedExeSha256 !== facts.drivenExeSha256 ||
      facts.shippedExeSha256 !== facts.expectedExeSha256) add('binary-hash-mismatch');
  if (facts.supportConfigSource !== 'bundled') add('support-config-not-bundled');
  if (facts.supportConfigIntegrity !== true) add('support-config-invalid');
  if (!facts.expectedSupportEndpoint) add('support-endpoint-unbound');
  else if (facts.effectiveSupportEndpoint !== facts.expectedSupportEndpoint) add('support-endpoint-mismatch');
  if (!normalizeSha256(facts.expectedSupportConfigRevision) ||
      !normalizeSha256(facts.supportConfigRevision) ||
      facts.supportConfigRevision !== facts.expectedSupportConfigRevision) add('support-config-revision-mismatch');
  if (facts.runtimeConfigConsistent !== true) add('runtime-config-inconsistent');
  const attestation = facts.operatorAttestation;
  if (!attestation || !attestation.present) add('operator-attestation-missing');
  else if (!attestation.valid) add('operator-attestation-invalid');
  else if (attestation.artifactKind !== facts.artifactKind ||
      attestation.artifactHead !== facts.artifactHead ||
      attestation.executableSha256 !== facts.shippedExeSha256 ||
      attestation.supportConfigRevision !== facts.supportConfigRevision ||
      attestation.uacEnabled !== true || attestation.uacAcceptObserved !== true ||
      attestation.uacCancelObserved !== true || attestation.disposableWindowsBoundary !== true) {
    add('operator-attestation-identity-mismatch');
  }
  if (!rows.length) add('acceptance-cases-missing');
  if (rows.some(testCase => testCase.status === 'failed')) add('acceptance-case-failed');
  if (rows.some(testCase => testCase.status === 'not-run' && testCase.mandatory === true)) {
    add('mandatory-case-not-run');
  }
  return { eligible: reasons.length === 0, reasons };
}

const ARTIFACT_KIND = normalizeArtifactKind(argOf('--artifact-kind', ''));
const ARTIFACT_HEAD = normalizeHead(argOf('--artifact-head', ''));
const EXPECTED_HEAD = normalizeHead(argOf('--expected-head', ''));
const EXPECTED_EXE_SHA256 = normalizeSha256(argOf('--expected-exe-sha256', ''));
const expectedEndpointUrl = supportClient.endpointUrl(argOf('--expected-support-endpoint', ''));
const EXPECTED_SUPPORT_ENDPOINT = expectedEndpointUrl ? expectedEndpointUrl.href : '';
const EXPECTED_CONFIG_REVISION = normalizeSha256(argOf('--expected-config-revision', ''));
const OPERATOR_ATTESTATION = loadOperatorAttestation(argOf('--operator-attestation', ''));

// Startup contract (renderer STARTUP_DEADLINE_MS is 8 s; main's whoami probe
// is bounded at 2.5 s). The packaged app must leave Checking well inside this.
const WINDOW_DEADLINE_MS = 30000;
const CHECKING_DEADLINE_MS = 15000;
const DISCLOSURE = 'Independent project. Not affiliated with Zoom.';
const TERMINAL_STATES = ['success', 'error', 'notice', 'cancelled', 'blocked', 'ready'];

let EXE = SHIPPED_EXE;
const report = {
  exe: EXE,
  shippedExe: SHIPPED_EXE,
  testCopy: TEST_COPY,
  mode: ACCEPTANCE_MODE,
  evidenceClass: 'diagnostic',
  releaseGateEligible: false,
  releaseEligibilityReasons: [],
  acceptanceIdentity: {
    artifactKind: ARTIFACT_KIND,
    artifactHead: ARTIFACT_HEAD,
    expectedHead: EXPECTED_HEAD,
    expectedExeSha256: EXPECTED_EXE_SHA256,
    expectedSupportEndpoint: EXPECTED_SUPPORT_ENDPOINT,
    expectedSupportConfigRevision: EXPECTED_CONFIG_REVISION,
    shippedExeSha256: '',
    drivenExeSha256: '',
    effectiveSupportEndpoint: '',
    supportConfigRevision: '',
    supportConfigSource: '',
    supportConfigIntegrity: false,
    runtimeConfigConsistent: false,
    operatorAttestation: OPERATOR_ATTESTATION
  },
  startedAt: new Date().toISOString(),
  host: {},
  cases: []
};
function record(id, status, detail, extra) {
  const row = { id, status, detail: detail || '', ...(extra || {}) };
  report.cases.push(row);
  const mark = status === 'passed' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip';
  console.log(`  ${mark}  ${id}${detail ? ` — ${detail}` : ''}`);
  return row;
}
const passed = (id, detail, extra) => record(id, 'passed', detail, extra);
const failed = (id, detail, extra) => record(id, 'failed', detail, extra);
const notRun = (id, detail, extra) => record(id, 'not-run', detail, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixJourneySucceeded(state) {
  return state === 'success';
}

function acceptanceExitCode(cases) {
  for (const testCase of cases) {
    if (testCase.status === 'failed') return 1;
    if (testCase.status === 'not-run' && testCase.mandatory === true) return 1;
  }
  return 0;
}

// Keep only the closed launch marker. Free-form process output, exception
// messages, account data and unrelated repair output never enter the artifact.
function selectFixLaunchTrace(entries) {
  if (!Array.isArray(entries)) return [];
  const allowed = /^Launch diagnostic: phase=(?:pre_launch|credential|start_process) outcome=(?:success|failure) exceptionClass=(?:none|[A-Za-z][A-Za-z0-9_.]{0,127}) hresult=(?:none|-?\d{1,12}) nativeCode=(?:none|-?\d{1,12}) exitCode=(?:none|-?\d{1,12}) timeout=(?:true|false) markerPresent=(?:true|false)$/;
  return entries.map((entry) => typeof entry === 'string' ? entry : entry && entry.line)
    .filter((line) => typeof line === 'string')
    .map((line) => line.trim().slice(0, 512))
    .filter((line) => allowed.test(line))
    .slice(0, 8);
}

let playwright;
try {
  playwright = require('playwright-core');
} catch (err) {
  console.error('packaged-acceptance: playwright-core is not installed (npm ci)');
  process.exit(2);
}
const { _electron: electron } = playwright;

fs.mkdirSync(OUT, { recursive: true });

async function stateOf(page) {
  return page.evaluate(() => document.body.dataset.compactState || '');
}

async function waitForState(page, pred, timeoutMs, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    last = await stateOf(page).catch(() => '');
    if (pred(last)) return { ok: true, state: last, ms: Date.now() - t0 };
    await sleep(200);
  }
  return { ok: false, state: last, ms: Date.now() - t0, label };
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return path.relative(ROOT, file);
}

async function layoutFacts(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const b = document.body;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflow = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.hidden) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.bottom > vh + 1) {
        overflow.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${Math.round(r.right)}x${Math.round(r.bottom)})`);
        if (overflow.length >= 5) break;
      }
    }
    const footer = document.querySelector('.app-footer');
    const disclosure = document.getElementById('projectDisclosure');
    const explore = document.getElementById('btnExplore');
    const version = document.getElementById('appVersion');
    return {
      viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
      docScroll: { w: de.scrollWidth, h: de.scrollHeight, cw: de.clientWidth, ch: de.clientHeight },
      bodyScroll: { w: b.scrollWidth, h: b.scrollHeight },
      overflow,
      footerText: footer ? footer.innerText.replace(/\s+/g, ' ').trim() : null,
      disclosureText: disclosure ? disclosure.textContent.trim() : null,
      disclosureInFooter: !!(footer && disclosure && footer.contains(disclosure)),
      disclosureClipped: !!(disclosure && ([...disclosure.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1) ||
        (() => { const r = disclosure.getBoundingClientRect(); return r.bottom > vh + 1 || r.top < 0 || r.right > vw + 1; })())),
      // Rendered, not merely un-hidden: Explore lives inside the closed About
      // dialog, so its own attributes say nothing about what is on screen.
      exploreVisible: !!(explore && !explore.hidden && getComputedStyle(explore).display !== 'none' && explore.getBoundingClientRect().height > 0),
      versionText: version ? version.textContent.trim() : null,
      title: (document.querySelector('.wiz-pane.active h2, .wiz-pane.active h1, [data-compact-title]') || {}).textContent || null
    };
  });
}

async function keyboardFacts(page) {
  return page.evaluate(() => {
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.hidden || el.disabled) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const rows = [];
    for (const el of els) {
      el.focus();
      const cs = getComputedStyle(el);
      const name = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      // A checkbox's target is its label (WCAG 2.5.8 measures the whole
      // target), and the label is also where its focus ring is drawn
      // (:focus-within), so the ring is looked for on the target too.
      const target = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label') ? el.closest('label') : el;
      const tcs = getComputedStyle(target);
      const ring = (cs.outlineStyle && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
        (cs.boxShadow && cs.boxShadow !== 'none') || (tcs.boxShadow && tcs.boxShadow !== 'none');
      const r = target.getBoundingClientRect();
      rows.push({ tag: el.tagName.toLowerCase(), id: el.id || null, name, focusVisible: !!ring, w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return rows;
  });
}

async function runtimeAuthority(app, tag, fakeRoot) {
  // This callback executes in the actual packaged Electron main process.
  // Return narrow runtime evidence only, never a diagnostic report.
  const proof = await app.evaluate(({ app }, fakeRoot) => {
    const facts = { packaged: app.isPackaged, electron: process.versions.electron,
      node: process.versions.node, arch: process.arch,
      reportAvailable: !!(process.report && typeof process.report.getReport === 'function') };
    if (!facts.reportAvailable) return { ...facts, stage: 'report-unavailable' };
    if (typeof process.getBuiltinModule !== 'function') return { ...facts, stage: 'builtin-api-unavailable' };
    const path = process.getBuiltinModule('path');
    const load = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const runtimeConfig = load('./src/main/config.js');
    const runtimeSupport = load('./src/main/support-client.js');
    const runtimeEndpoint = runtimeSupport.endpointUrl(runtimeConfig.FEEDBACK_PROXY_URL);
    Object.assign(facts, {
      effectiveSupportEndpoint: runtimeEndpoint ? runtimeEndpoint.href : '',
      supportConfigRevision: typeof runtimeConfig.FEEDBACK_CONFIG_REVISION === 'string'
        ? runtimeConfig.FEEDBACK_CONFIG_REVISION.toLowerCase()
        : '',
      supportConfigSource: runtimeConfig.FEEDBACK_CONFIG_SOURCE,
      supportConfigIntegrity: runtimeConfig.FEEDBACK_CONFIG_INTEGRITY === true
    });
    const environmentKey = /^(?:systemroot|windir|path|processor_architew6432|comspec)$/i;
    const forgedEnvironment = fakeRoot ? { SystemRoot: fakeRoot, WINDIR: fakeRoot, PATH: '', PROCESSOR_ARCHITEW6432: 'FORGED',
      ComSpec: path.join(fakeRoot, 'System32', 'cmd.exe') } : null;
    const originalEnvironment = { ...(process.env || {}) };
    const savedEnvironment = Object.entries(originalEnvironment).filter(([key]) => environmentKey.test(key));
    let forgedEnvironmentApplied = !fakeRoot;
    let proof;
    try {
      if (fakeRoot) {
        for (const key of Object.keys(process.env)) {
          if (environmentKey.test(key)) delete process.env[key];
        }
        Object.assign(process.env, forgedEnvironment);
        forgedEnvironmentApplied = Object.entries(forgedEnvironment).every(([key, value]) => process.env[key] === value);
      }
      const tools = load('./src/main/windows-tools.js');
      const api = process.report;
      const changed = [];
      let sharedObjects;
      try {
        for (const flag of ['excludeEnv', 'excludeNetwork']) {
          if (flag in api) { changed.push([flag, api[flag]]); api[flag] = true; }
        }
        let diagnostic = api.getReport();
        sharedObjects = diagnostic && diagnostic.sharedObjects;
        diagnostic = null;
      } finally {
        for (const [flag, value] of changed.reverse()) api[flag] = value;
      }
      const root = tools.resolveSystemRoot();
      const freshRoot = tools.createToolResolver({ getReport: () => ({ sharedObjects }), arch: process.arch }).resolveSystemRoot();
      if (!root || !freshRoot || root.toLowerCase() !== freshRoot.toLowerCase()) {
        proof = { ...facts, stage: 'root-unverified', forgedEnvironmentApplied };
      } else {
        const powershell = tools.resolveTool('powershell.exe');
        const cmd = tools.resolveTool('cmd.exe');
        const coreDlls = sharedObjects.filter(value => /^(?:ntdll|kernel32|kernelbase)\.dll$/i.test(path.basename(value)));
        const resolvedPathsTrusted = !fakeRoot || ![root, powershell, cmd].some(value => value.toLowerCase().startsWith(fakeRoot.toLowerCase()));
        const coreLibrariesTrusted = !fakeRoot || (coreDlls.length >= 3 && !coreDlls.some(value => value.toLowerCase().startsWith(fakeRoot.toLowerCase())));
        if (!resolvedPathsTrusted || !coreLibrariesTrusted) {
          proof = { ...facts, stage: 'untrusted-paths', appPath: app.getAppPath(), root, powershell, cmd, coreDlls,
            exitCode: null, trusted: false, resolvedPathsTrusted, coreLibrariesTrusted,
            forgedEnvironmentApplied, nativeEnvironmentApplied: false, nativePathTrusted: false, commandMatches: false };
        } else {
          // PowerShell starts with the untouched host environment. Only after
          // bootstrap does the proof apply all five hostile values.
          const powershellEnv = fakeRoot ? {
            ...originalEnvironment,
            FIXER_TEST_FORGED_ENV: JSON.stringify(forgedEnvironment)
          } : process.env;
          const applyForgedEnvironment = fakeRoot
            ? "$fixerTestEnvironment = $env:FIXER_TEST_FORGED_ENV | ConvertFrom-Json; Remove-Item Env:FIXER_TEST_FORGED_ENV; $fixerTestSystemRoot = [string]$fixerTestEnvironment.SystemRoot; $env:SystemRoot = $fixerTestSystemRoot; $env:WINDIR = [string]$fixerTestEnvironment.WINDIR; $env:PATH = [string]$fixerTestEnvironment.PATH; $env:PROCESSOR_ARCHITEW6432 = [string]$fixerTestEnvironment.PROCESSOR_ARCHITEW6432; $env:ComSpec = [string]$fixerTestEnvironment.ComSpec; $fixerTestForged = ($env:SystemRoot -eq $fixerTestSystemRoot -and $env:WINDIR -eq [string]$fixerTestEnvironment.WINDIR -and [string]::IsNullOrEmpty($env:PATH) -and $env:PROCESSOR_ARCHITEW6432 -eq [string]$fixerTestEnvironment.PROCESSOR_ARCHITEW6432 -and $env:ComSpec -eq [string]$fixerTestEnvironment.ComSpec); "
            : "$fixerTestSystemRoot = ''; $fixerTestForged = $true; ";
          const nativeCommand = "$fixerTestCmd = Resolve-FixerTool 'cmd.exe'; $fixerTestNativePathTrusted = ([string]::IsNullOrEmpty($fixerTestSystemRoot) -or -not $fixerTestCmd.StartsWith($fixerTestSystemRoot, [StringComparison]::OrdinalIgnoreCase)); $fixerTestMarker = if ($fixerTestNativePathTrusted) { & $fixerTestCmd /d /c 'echo FIXER_TRUSTED_RUNTIME' } else { $null }; $r = @{ systemDir = [Environment]::SystemDirectory; marker = $fixerTestMarker; forgedEnvironment = $fixerTestForged; nativePathTrusted = $fixerTestNativePathTrusted }; $r | ConvertTo-Json -Compress";
          const result = process.getBuiltinModule('child_process').spawnSync(powershell, tools.PS_STDIN_ARGS, {
            input: Buffer.from(tools.prepareScript(applyForgedEnvironment + nativeCommand), 'utf8'),
            env: powershellEnv, windowsHide: true, timeout: 15000, encoding: 'utf8'
          });
          let command;
          try { command = JSON.parse((result.stdout || '').trim()); } catch (_) {}
          const nativeSystemDir = command && typeof command.systemDir === 'string' ? command.systemDir : '';
          const nativeMarker = !!(command && command.marker === 'FIXER_TRUSTED_RUNTIME');
          const nativeEnvironmentApplied = !fakeRoot || !!(command && command.forgedEnvironment === true);
          const nativePathTrusted = !fakeRoot || !!(command && command.nativePathTrusted === true);
          // Sysnative is the caller's WOW64 alias; native PowerShell reports
          // the same physical directory as System32.
          const expectedDir = path.join(root, 'System32');
          proof = { ...facts, stage: 'checked', appPath: app.getAppPath(), root, powershell, cmd, coreDlls,
            nativeSystemDir, exitCode: result.status, trusted: true, resolvedPathsTrusted, coreLibrariesTrusted,
            forgedEnvironmentApplied, nativeEnvironmentApplied, nativePathTrusted,
            commandMatches: result.status === 0 && !result.error && nativeMarker && nativeEnvironmentApplied &&
              nativePathTrusted && nativeSystemDir.toLowerCase() === expectedDir.toLowerCase() };
        }
      }
    } catch (_) {
      proof = { ...facts, stage: 'proof-error', forgedEnvironmentApplied };
    } finally {
      if (fakeRoot && process.env) {
        for (const key of Object.keys(process.env)) {
          if (environmentKey.test(key)) delete process.env[key];
        }
        for (const [key, value] of savedEnvironment) process.env[key] = value;
        const restoredKeys = Object.keys(process.env).filter(key => environmentKey.test(key));
        proof.environmentRestored = restoredKeys.length === savedEnvironment.length &&
          savedEnvironment.every(([key, value]) => process.env[key] === value);
      } else if (fakeRoot) {
        proof.environmentRestored = false;
      }
    }
    return proof;
  }, fakeRoot || null);
  const observedEndpointUrl = supportClient.endpointUrl(proof.effectiveSupportEndpoint);
  const observedEndpoint = observedEndpointUrl ? observedEndpointUrl.href : '';
  const observedRevision = normalizeSha256(proof.supportConfigRevision);
  const configShapeValid = (proof.effectiveSupportEndpoint === '' || !!observedEndpointUrl) &&
    !!observedRevision && ['bundled', 'development'].includes(proof.supportConfigSource) &&
    proof.supportConfigIntegrity === true;
  const identity = report.acceptanceIdentity;
  if (!identity.runtimeConfigObserved) {
    identity.runtimeConfigObserved = true;
    identity.effectiveSupportEndpoint = observedEndpoint;
    identity.supportConfigRevision = observedRevision;
    identity.supportConfigSource = proof.supportConfigSource || '';
    identity.supportConfigIntegrity = proof.supportConfigIntegrity === true;
    identity.runtimeConfigConsistent = configShapeValid;
  } else if (identity.effectiveSupportEndpoint !== observedEndpoint ||
      identity.supportConfigRevision !== observedRevision ||
      identity.supportConfigSource !== proof.supportConfigSource ||
      identity.supportConfigIntegrity !== (proof.supportConfigIntegrity === true)) {
    identity.runtimeConfigConsistent = false;
  }
  const expectedConfigMatches = (!EXPECTED_SUPPORT_ENDPOINT || observedEndpoint === EXPECTED_SUPPORT_ENDPOINT) &&
    (!EXPECTED_CONFIG_REVISION || observedRevision === EXPECTED_CONFIG_REVISION);
  (configShapeValid && identity.runtimeConfigConsistent && expectedConfigMatches ? passed : failed)(
    `${tag}.support-config-identity`,
    `source=${proof.supportConfigSource || 'invalid'}, configured=${!!observedEndpoint}, revision=${observedRevision || 'invalid'}, consistent=${identity.runtimeConfigConsistent}`,
    { supportConfig: { endpoint: observedEndpoint, revision: observedRevision,
      source: proof.supportConfigSource || '', integrity: proof.supportConfigIntegrity === true } }
  );

  const expectedElectron = require('electron/package.json').version;
  const expectedArchive = path.join(path.dirname(EXE), 'resources', 'app.asar');
  const forgedProof = !fakeRoot || (proof.forgedEnvironmentApplied && proof.environmentRestored &&
    proof.resolvedPathsTrusted && proof.coreLibrariesTrusted && proof.nativeEnvironmentApplied && proof.nativePathTrusted);
  const ok = proof.packaged && proof.electron === expectedElectron && proof.reportAvailable &&
    proof.stage === 'checked' && proof.trusted && proof.commandMatches && forgedProof &&
    path.resolve(proof.appPath || '').toLowerCase() === expectedArchive.toLowerCase();
  (ok ? passed : failed)(`${tag}.os-tool-authority`,
    `actual main: Electron ${proof.electron}, Node ${proof.node}, stage=${proof.stage}, report=${proof.reportAvailable}, trusted command=${!!proof.commandMatches}`,
    { runtime: proof });
  return ok;
}

async function launch(scale, env) {
  const launchArgs = [];
  if (scale && scale !== 1) launchArgs.push(`--force-device-scale-factor=${scale}`);
  const t0 = Date.now();
  const app = await electron.launch({ executablePath: EXE, args: launchArgs, env, timeout: WINDOW_DEADLINE_MS });
  try {
    const page = await app.firstWindow({ timeout: WINDOW_DEADLINE_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: WINDOW_DEADLINE_MS }).catch(() => {});
    return { app, page, ms: Date.now() - t0 };
  } catch (err) { await app.close().catch(() => {}); throw err; }
}

async function runLanding(scale, tag) {
  let app = null;
  try {
    const l = await launch(scale);
    app = l.app;
    const page = l.page;
    await runtimeAuthority(app, tag);
    passed(`${tag}.window-visible`, `first window in ${l.ms} ms`);
    const first = await stateOf(page);
    const firstShot = await shot(page, `${tag}-01-first-paint-${first || 'unknown'}`);
    const left = await waitForState(page, (s) => s && s !== 'checking', CHECKING_DEADLINE_MS, 'leave checking');
    if (left.ok) passed(`${tag}.leaves-checking`, `state=${left.state} after ${left.ms} ms`, { screenshot: firstShot });
    else failed(`${tag}.leaves-checking`, `still "${left.state || 'checking'}" after ${left.ms} ms — startup freeze`, { screenshot: firstShot });
    await sleep(600); // let the environment scan settle its cards
    const state = await stateOf(page);
    const landingShot = await shot(page, `${tag}-02-landing-${state}`);
    const facts = await layoutFacts(page);
    const noScroll = facts.docScroll.h <= facts.docScroll.ch + 1 && facts.docScroll.w <= facts.docScroll.cw + 1 && facts.overflow.length === 0;
    (noScroll ? passed : failed)(`${tag}.no-scrollbars`, noScroll
      ? `viewport ${facts.viewport.w}x${facts.viewport.h} @${facts.viewport.dpr}, content fits`
      : `overflow: ${facts.overflow.join('; ') || `doc ${facts.docScroll.w}x${facts.docScroll.h} > ${facts.docScroll.cw}x${facts.docScroll.ch}`}`,
      { screenshot: landingShot, facts });
    const disclosureOk = facts.disclosureInFooter && (facts.disclosureText || '').includes(DISCLOSURE) && (facts.footerText || '').includes(DISCLOSURE) && !facts.disclosureClipped;
    (disclosureOk ? passed : failed)(`${tag}.footer-disclosure`, `footer: ${facts.footerText}${facts.disclosureClipped ? ' (disclosure clipped)' : ''}`);
    (!facts.exploreVisible ? passed : failed)(`${tag}.explore-hidden`, facts.exploreVisible ? 'Explore visible in landing chrome' : 'Explore absent from landing chrome');
    (facts.versionText && /\d+\.\d+\.\d+/.test(facts.versionText) ? passed : failed)(`${tag}.version-shown`, `version: ${facts.versionText}`);
    // Keyboard modality first: Chromium shows :focus-visible on script focus
    // only after keyboard input, exactly like a keyboard user arriving.
    await page.keyboard.press('Tab');
    const kb = await keyboardFacts(page);
    const noRing = kb.filter((k) => !k.focusVisible);
    const small = kb.filter((k) => k.w < 24 || k.h < 24);
    (noRing.length === 0 ? passed : failed)(`${tag}.focus-visible`, noRing.length ? `no visible focus on: ${noRing.map((k) => k.id || k.name).join(', ')}` : `${kb.length} focusable controls, all with a visible focus ring`, { controls: kb });
    (small.length === 0 ? passed : failed)(`${tag}.target-size`, small.length ? `targets under 24px: ${small.map((k) => `${k.id || k.name} ${k.w}x${k.h}`).join(', ')}` : 'all targets ≥ 24px');
    // Screen action map: only the controls this state allows are visible.
    const leak = await page.evaluate(({ allowed, managed }) => {
      const visible = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
      return managed.filter((id) => visible(document.getElementById(id)) && allowed.indexOf(id) === -1);
    }, { allowed: screenActions.allowedControls(state), managed: screenActions.MANAGED_CONTROLS });
    (leak.length === 0 ? passed : failed)(`${tag}.controls-belong-to-state`, leak.length ? `controls from another screen visible on ${state}: ${leak.join(', ')}` : `only ${state} controls are visible`);
    await runDetailsRoundTrip(page, tag, state);
    return { app, page, state };
  } catch (err) {
    failed(`${tag}.launch`, `could not drive the packaged app: ${err && err.message}`);
    if (app) await app.close().catch(() => {});
    return null;
  }
}

async function runForgedRoot() {
  const fakeRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fixer-fake-windows-'));
  let app;
  try {
    const system32 = path.join(fakeRoot, 'System32');
    const psHome = path.join(system32, 'WindowsPowerShell', 'v1.0');
    fs.mkdirSync(psHome, { recursive: true });
    const names = windowsTools.WINDOWS_TOOLS;
    for (const name of names) fs.writeFileSync(path.join(name === 'powershell.exe' ? psHome : system32, name), 'invalid fake executable; must never run');
    // Bootstrap Electron with the real host environment. runtimeAuthority
    // applies the hostile fixture only inside the packaged main-process proof.
    const launched = await launch(1);
    app = launched.app;
    await runtimeAuthority(app, 'forged-root', fakeRoot);
    const left = await waitForState(launched.page, state => state && state !== 'checking', CHECKING_DEADLINE_MS, 'forged-root startup');
    (left.ok ? passed : failed)('forged-root.leaves-checking', `state=${left.state || 'checking'} after ${left.ms} ms`);
  } catch (_) { failed('forged-root.os-tool-authority', 'could not verify the actual packaged main process with forged root variables and empty PATH'); }
  finally { if (app) await app.close().catch(() => {}); fs.rmSync(fakeRoot, { recursive: true, force: true }); }
}

// View details opens the in-place Details view (Back in the header, plain
// English, nothing scrolls) and Back restores the exact prior screen with
// focus on View details.
async function runDetailsRoundTrip(page, tag, state) {
  const hasDetails = await page.evaluate(() => { const b = document.getElementById('detailsBtn'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; });
  if (!hasDetails) {
    notRun(`${tag}.details-round-trip`, `View details is not offered on "${state}"`, { mandatory: true });
    return;
  }
  const checkboxBefore = await page.evaluate(() => { const c = document.getElementById('shortcutOptInput'); return c ? c.checked : null; });
  await page.click('#detailsBtn');
  await sleep(300);
  const open = await page.evaluate(() => {
    const visible = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const de = document.documentElement;
    const nested = [...document.querySelectorAll('body *')].filter((el) => visible(el) && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).map((el) => el.id || el.className);
    const text = (document.getElementById('detailsView') || {}).innerText || '';
    return {
      view: document.body.dataset.view || '',
      back: visible(document.getElementById('backBtn')),
      fixVisible: visible(document.getElementById('fixBtn')),
      launchVisible: visible(document.getElementById('launchBtn')),
      exploreVisible: visible(document.getElementById('btnExplore')),
      focused: document.activeElement && document.activeElement.id,
      docScroll: de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1,
      nested,
      technical: /HKLM|HKCU|HKU\b|NTUSER|\breg\.exe|\bsc\.exe|Start-Process|\buser1\b|[A-Z]:\\/.test(text),
      rows: document.querySelectorAll('#detailsOverview .details-row').length,
      text: text.replace(/\s+/g, ' ').slice(0, 160)
    };
  });
  const detailsShot = await shot(page, `${tag}-03-details`);
  (open.view === 'details' && open.back ? passed : failed)(`${tag}.details-opens-in-place`, `view=${open.view} back=${open.back} focus=#${open.focused}`, { screenshot: detailsShot });
  (open.focused === 'backBtn' ? passed : failed)(`${tag}.details-focus-starts-on-back`, `focus on #${open.focused}`);
  (!open.fixVisible && !open.launchVisible && !open.exploreVisible ? passed : failed)(`${tag}.details-no-foreign-controls`, `Fix now=${open.fixVisible} Open Zoom=${open.launchVisible} Explore=${open.exploreVisible}`);
  (!open.docScroll && open.nested.length === 0 ? passed : failed)(`${tag}.details-no-scrollbars`, open.nested.length ? `nested scroll on ${open.nested.join(', ')}` : 'no document or nested scrollbar');
  (!open.technical ? passed : failed)(`${tag}.details-plain-english`, open.technical ? `technical text on the Details surface: ${open.text}` : `plain English: ${open.text}`);
  (open.rows >= 5 ? passed : failed)(`${tag}.details-categories`, `${open.rows} category rows`);
  if (open.rows) {
    await page.click('#detailsOverview .details-row');
    await sleep(200);
    const cat = await page.evaluate(() => ({ focused: document.activeElement && document.activeElement.id, title: (document.getElementById('detailsCategoryTitle') || {}).textContent, checks: document.querySelectorAll('#detailsChecks .details-check').length, doubled: /Checking…[\s\S]*Checking/.test((document.getElementById('detailsView') || {}).innerText || '') }));
    const catShot = await shot(page, `${tag}-04-details-category`);
    (cat.checks > 0 && cat.focused === 'detailsOverviewBtn' && !cat.doubled ? passed : failed)(`${tag}.details-category-opens`, `${cat.title}: ${cat.checks} checks, focus on #${cat.focused}`, { screenshot: catShot });
    await page.click('#detailsOverviewBtn');
    await sleep(150);
  }
  await page.click('#backBtn');
  await sleep(300);
  const after = await page.evaluate(() => ({
    view: document.body.dataset.view || '',
    state: document.body.dataset.compactState || '',
    focused: document.activeElement && document.activeElement.id,
    checkbox: (document.getElementById('shortcutOptInput') || {}).checked,
    back: (() => { const b = document.getElementById('backBtn'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; })()
  }));
  const backShot = await shot(page, `${tag}-05-back`);
  (after.view === '' && after.state === state && !after.back ? passed : failed)(`${tag}.details-back-restores-state`, `state=${after.state} (was ${state}) back hidden=${!after.back}`, { screenshot: backShot });
  (after.focused === 'detailsBtn' ? passed : failed)(`${tag}.details-back-returns-focus`, `focus on #${after.focused}`);
  (after.checkbox === checkboxBefore ? passed : failed)(`${tag}.details-back-preserves-option`, `shortcut option ${checkboxBefore} -> ${after.checkbox}`);
}

async function runSecondInstance(page) {
  const t0 = Date.now();
  const child = spawn(EXE, [], { windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
  });
  if (exit.timedOut) {
    try { child.kill(); } catch (_) {}
    failed('single-instance.second-launch-exits', 'second instance still running after 15 s');
  } else {
    passed('single-instance.second-launch-exits', `second instance exited in ${Date.now() - t0} ms (code ${exit.code})`);
  }
  const stillOpen = await page.evaluate(() => document.visibilityState).then(() => true).catch(() => false);
  (stillOpen ? passed : failed)('single-instance.first-window-survives', stillOpen ? 'first window still open' : 'first window gone');
}

async function runFixJourney(page) {
  const state = await stateOf(page);
  if (state !== 'ready') {
    notRun('fix.journey', `landing state is "${state}", not ready (Zoom Workplace not detected on this host?) — Fix now cannot be exercised here`, { mandatory: true });
    await page.click('#detailsBtn').catch(() => {});
    await sleep(300);
    await shot(page, '03-details-' + state);
    return;
  }
  // Enter on the landing surface, with no control focused, activates the
  // primary action (Fix now). (With View details focused — where the Details
  // round trip left it — Enter would open Details, as it should.)
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press('Enter');
  const overlayShown = await page.waitForSelector('#fixConfirmOverlay:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false);
  (overlayShown ? passed : failed)('fix.confirm-opens-on-enter', overlayShown ? 'confirmation dialog opened from the keyboard' : 'confirmation did not open');
  if (!overlayShown) return;
  const confirmShot = await shot(page, '03-confirm');
  const confirmFacts = await page.evaluate(() => {
    const d = document.querySelector('#fixConfirmOverlay .fix-confirm-dialog');
    const r = d ? d.getBoundingClientRect() : null;
    return {
      role: document.getElementById('fixConfirmOverlay').getAttribute('role'),
      labelledBy: document.getElementById('fixConfirmOverlay').getAttribute('aria-labelledby'),
      body: (document.getElementById('fixConfirmBody') || {}).textContent,
      inside: r ? r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight : false,
      focused: document.activeElement && document.activeElement.id
    };
  });
  (confirmFacts.role === 'dialog' && confirmFacts.labelledBy ? passed : failed)('fix.confirm-dialog-semantics', `role=${confirmFacts.role} labelledby=${confirmFacts.labelledBy}`, { screenshot: confirmShot });
  (confirmFacts.inside ? passed : failed)('fix.confirm-fits-window', confirmFacts.inside ? 'dialog inside the window' : 'dialog extends outside the window');
  (/personal files will not be changed/.test(confirmFacts.body || '') ? passed : failed)('fix.confirm-copy', (confirmFacts.body || '').slice(0, 120));
  // Escape = Go back; focus must return to Fix now.
  await page.keyboard.press('Escape');
  await sleep(200);
  const afterEsc = await page.evaluate(() => ({ hidden: document.getElementById('fixConfirmOverlay').hidden, focused: document.activeElement && document.activeElement.id }));
  (afterEsc.hidden ? passed : failed)('fix.confirm-escape-goes-back', `overlay hidden=${afterEsc.hidden}`);
  (afterEsc.focused === 'fixBtn' ? passed : failed)('fix.confirm-focus-returns', `focus on #${afterEsc.focused}`);
  if (SKIP_FIX) {
    notRun('fix.run', '--skip-fix is diagnostic-only; required Fix now acceptance did not run', {
      mandatory: true,
      acceptanceResult: 'non-acceptance'
    });
    return;
  }

  // Real run: click Fix now, Continue, and follow the orchestrator to a
  // terminal state. Rapid double-click must not start two repairs.
  await page.evaluate(() => {
    if (typeof window.__fixerAcceptanceStopFixLog === 'function') window.__fixerAcceptanceStopFixLog();
    window.__fixerAcceptanceFixLog = [];
    window.__fixerAcceptanceStopFixLog = window.electronAPI.onFixLog((entry) => {
      if (!entry || typeof entry.line !== 'string') return;
      const line = entry.line.trim();
      const launchLine = /^Launch diagnostic: phase=(?:pre_launch|credential|start_process) outcome=(?:success|failure) exceptionClass=(?:none|[A-Za-z][A-Za-z0-9_.]{0,127}) hresult=(?:none|-?\d{1,12}) nativeCode=(?:none|-?\d{1,12}) exitCode=(?:none|-?\d{1,12}) timeout=(?:true|false) markerPresent=(?:true|false)$/.test(line);
      if (launchLine && window.__fixerAcceptanceFixLog.length < 32) {
        window.__fixerAcceptanceFixLog.push({ line, kind: entry.kind || '' });
      }
    });
  });
  const stopFixLogCapture = async () => selectFixLaunchTrace(await page.evaluate(() => {
    const entries = Array.isArray(window.__fixerAcceptanceFixLog) ? window.__fixerAcceptanceFixLog.slice() : [];
    if (typeof window.__fixerAcceptanceStopFixLog === 'function') window.__fixerAcceptanceStopFixLog();
    delete window.__fixerAcceptanceStopFixLog;
    delete window.__fixerAcceptanceFixLog;
    return entries;
  }));
  await page.click('#fixBtn');
  await page.waitForSelector('#fixConfirmOverlay:not([hidden])', { timeout: 5000 });
  await page.click('#fixConfirmContinue');
  await page.click('#fixConfirmContinue', { force: true }).catch(() => {});
  const fixing = await waitForState(page, (s) => s === 'fixing' || s === 'cancelling' || s === 'success' || s === 'error' || s === 'notice', 15000, 'fixing');
  const fixingCase = (fixing.ok ? passed : failed)('fix.starts', `state=${fixing.state} after ${fixing.ms} ms`);
  if (!fixing.ok) {
    const launchTrace = await stopFixLogCapture();
    if (launchTrace.length) fixingCase.launchTrace = launchTrace;
    return;
  }
  const fixingShot = await shot(page, '04-fixing');
  const progress = await page.evaluate(() => {
    const p = document.querySelector('#stepLine[role="progressbar"], .compact-step-line[role="progressbar"]');
    const line = document.querySelector('.compact-step-line, #stepLine');
    const btn = document.getElementById('fixBtn');
    return { aria: p ? p.getAttribute('aria-valuetext') : null, step: line ? line.textContent : null, fixDisabledOrHidden: !btn || btn.hidden || btn.disabled };
  });
  (progress.fixDisabledOrHidden ? passed : failed)('fix.no-duplicate-run', 'Fix now unavailable while fixing', { screenshot: fixingShot, progress });
  (progress.aria ? passed : failed)('fix.progress-announced', `progress: ${progress.aria || 'none'}`);
  const done = await waitForState(page, (s) => ['success', 'error', 'notice', 'cancelled'].includes(s), FIX_TIMEOUT_MS, 'terminal');
  const endShot = await shot(page, `05-end-${done.state || 'timeout'}`);
  const launchTrace = await stopFixLogCapture();
  if (!done.ok) {
    failed('fix.reaches-terminal-state', `still "${done.state}" after ${done.ms} ms — no terminal state`, {
      screenshot: endShot,
      ...(launchTrace.length ? { launchTrace } : {})
    });
    return;
  }
  passed('fix.reaches-terminal-state', `state=${done.state} after ${done.ms} ms`, { screenshot: endShot });
  (fixJourneySucceeded(done.state) ? passed : failed)(
    'fix.completes-successfully',
    `state=${done.state}`,
    { screenshot: endShot, ...(launchTrace.length ? { launchTrace } : {}) }
  );
  const endFacts = await page.evaluate(() => {
    const launch = document.getElementById('launchBtn');
    const title = document.querySelector('.wiz-pane.active h2, .wiz-pane.active h1');
    // Only a still-looping animation counts; a finished one-shot transition
    // still reports animationPlayState "running".
    const spinning = [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName && cs.animationName !== 'none' && cs.animationIterationCount === 'infinite' && cs.animationPlayState === 'running' && el.getBoundingClientRect().width > 0 && !el.hidden;
    }).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]}`);
    return { openZoomVisible: !!(launch && !launch.hidden), title: title ? title.textContent.trim() : null, spinning: spinning.length ? spinning.join(', ') : '' };
  });
  if (done.state === 'success') {
    (endFacts.openZoomVisible ? passed : failed)('fix.open-zoom-after-success', `Open Zoom visible=${endFacts.openZoomVisible}; title=${endFacts.title}`);
  } else {
    (!endFacts.openZoomVisible ? passed : failed)('fix.no-open-zoom-without-success', `state=${done.state}; Open Zoom visible=${endFacts.openZoomVisible}; title=${endFacts.title}`);
  }
  (!endFacts.spinning ? passed : failed)('fix.no-animation-after-end', endFacts.spinning ? `looping animation still running on: ${endFacts.spinning}` : 'no looping animation');
  const rawPs = await page.evaluate(() => /\$_\.|Write-Output|Start-Process|At line:\d+ char:\d+/.test(document.querySelector('.wiz-pane.active') ? document.querySelector('.wiz-pane.active').innerText : ''));
  (!rawPs ? passed : failed)('fix.no-raw-powershell-on-primary-surface', rawPs ? 'PowerShell text visible on the primary surface' : 'primary surface is plain English');
  await runDetailsRoundTrip(page, 'fix-end', done.state);
}

function readEnableLua() {
  try {
    const r = require('child_process').spawnSync(windowsTools.resolveTool('reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'EnableLUA'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = /EnableLUA\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout || '');
    return m ? parseInt(m[1], 16) : null;
  } catch (_) { return null; }
}

async function prepareTestCopy() {
  const srcDir = path.dirname(SHIPPED_EXE);
  const dstDir = path.join(path.dirname(srcDir), 'acceptance-unpacked');
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  const exe = path.join(dstDir, path.basename(SHIPPED_EXE));
  const { stampExecutionLevel } = require('../scripts/stamp-exe-manifest');
  const how = await stampExecutionLevel(exe, 'asInvoker');
  return { exe, how };
}

// Raw launch without the debugger: the app's own stderr for 12 s, so a
// renderer/GPU child launch failure is visible in the report even when the
// driver cannot attach.
async function rawLaunchProbe(exe) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let exitObserved = false;
    let timeoutStarted = false;
    let timer = null;
    let killVerificationTimer = null;
    let child;
    const finishProbe = (receipt) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killVerificationTimer) clearTimeout(killVerificationTimer);
      resolve({ ...receipt, out: out.slice(-4000) });
    };
    try {
      child = spawn(exe, ['--enable-logging=stderr'], { windowsHide: true });
    } catch (err) {
      finishProbe({ why: `error:${String((err && (err.code || err.name)) || 'launch')}`, timedOut: false, terminationProved: true });
      return;
    }
    timer = setTimeout(() => {
      if (settled || exitObserved || child.exitCode !== null || child.signalCode !== null) return;
      timeoutStarted = true;
      let killed;
      try {
        killed = require('child_process').spawnSync(windowsTools.resolveTool('taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      } catch (_) {
        finishProbe({ why: 'timeout', timedOut: true, terminationProved: false });
        return;
      }
      if (!killed || killed.error || killed.status !== 0) {
        finishProbe({ why: 'timeout', timedOut: true, terminationProved: false });
        return;
      }
      // A successful /T /F request is not enough by itself. Keep the original
      // ChildProcess identity until Node observes its exit; otherwise stop the
      // acceptance run instead of overlapping a possibly live tree.
      killVerificationTimer = setTimeout(() => {
        finishProbe({ why: 'timeout', timedOut: true, terminationProved: false });
      }, 2000);
    }, 12000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => {
      finishProbe({
        why: `error:${String((err && (err.code || err.name)) || 'process')}`,
        timedOut: timeoutStarted,
        terminationProved: !timeoutStarted && !child.pid
      });
    });
    child.on('exit', (code) => {
      exitObserved = true;
      finishProbe(timeoutStarted
        ? { why: 'timeout', timedOut: true, terminationProved: true }
        : { why: `exited ${code}`, timedOut: false, terminationProved: true });
    });
  });
}

function rawLaunchSucceeded(receipt, fatalOutput) {
  return !!receipt && receipt.timedOut === true && receipt.terminationProved === true && fatalOutput !== true;
}

(async () => {
  report.host = { platform: process.platform, release: require('os').release(), enableLUA: readEnableLua(), exeExists: fs.existsSync(SHIPPED_EXE) };
  console.log(`packaged-acceptance: ${SHIPPED_EXE} (EnableLUA=${report.host.enableLUA})`);
  if (!fs.existsSync(SHIPPED_EXE)) { failed('exe-present', `missing ${SHIPPED_EXE}`); finish(); return; }
  passed('exe-present', path.basename(SHIPPED_EXE));
  if (TEST_COPY) {
    try {
      const c = await prepareTestCopy();
      EXE = c.exe;
      report.exe = EXE;
      passed('test-copy', `asInvoker copy stamped via ${c.how}: ${path.relative(ROOT, EXE)} (shipped artifact untouched; host EnableLUA=${report.host.enableLUA})`);
    } catch (err) {
      failed('test-copy', `could not prepare the asInvoker copy: ${err && err.message}`);
      finish();
      return;
    }
  }
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  report.acceptanceIdentity.shippedExeSha256 = digest(SHIPPED_EXE);
  report.acceptanceIdentity.drivenExeSha256 = digest(EXE);
  passed('executable-hash-recorded', TEST_COPY
    ? 'recorded distinct shipped and diagnostic-copy executable identities'
    : 'the driven executable is the byte-identical shipped executable', {
    executableIdentity: {
      shippedSha256: report.acceptanceIdentity.shippedExeSha256,
      drivenSha256: report.acceptanceIdentity.drivenExeSha256
    }
  });
  if (EXPECTED_EXE_SHA256) {
    (report.acceptanceIdentity.shippedExeSha256 === EXPECTED_EXE_SHA256 ? passed : failed)(
      'executable-expected-hash',
      report.acceptanceIdentity.shippedExeSha256 === EXPECTED_EXE_SHA256
        ? 'shipped executable matches the independently supplied SHA-256'
        : 'shipped executable does not match the independently supplied SHA-256'
    );
  }
  if (ARTIFACT_HEAD && EXPECTED_HEAD) {
    (ARTIFACT_HEAD === EXPECTED_HEAD ? passed : failed)(
      'artifact-head-identity',
      ARTIFACT_HEAD === EXPECTED_HEAD
        ? 'artifact head matches the acceptance target head'
        : 'artifact head does not match the acceptance target head'
    );
  }
  const shippedArchive = path.join(path.dirname(SHIPPED_EXE), 'resources', 'app.asar');
  const drivenArchive = path.join(path.dirname(EXE), 'resources', 'app.asar');
  if (!fs.existsSync(shippedArchive) || !fs.existsSync(drivenArchive)) {
    failed('shipped-archive', 'the shipped and driven app.asar archives are required for runtime proof');
    finish(); return;
  }
  const archiveSha256 = digest(shippedArchive);
  if (digest(drivenArchive) !== archiveSha256) {
    failed('shipped-archive', 'the driven archive differs from the shipped archive');
    finish(); return;
  }
  passed('shipped-archive', 'actual main process will load the byte-identical shipped app.asar', { archiveSha256 });
  const raw = await rawLaunchProbe(EXE);
  const rawFatal = /render-process-gone|GPU process launch failed|FATAL/.test(raw.out);
  const rawOk = rawLaunchSucceeded(raw, rawFatal);
  (rawOk ? passed : failed)('raw-launch', `${raw.why}; terminationProved=${raw.terminationProved}; ${rawFatal ? 'renderer/GPU launch failure in stderr' : 'no fatal child-launch error in 12 s'}`, { stderrTail: raw.out.split(/\r?\n/).filter(Boolean).slice(-12) });
  if (!raw.terminationProved) { finish(); return; }

  const main = await runLanding(1, 'scale100');
  if (main) {
    await runSecondInstance(main.page);
    await runFixJourney(main.page);
    await main.app.close().catch(() => {});
  }
  for (const s of SCALES.filter((x) => x !== 1)) {
    const tag = `scale${Math.round(s * 100)}`;
    const r = await runLanding(s, tag);
    if (r) await r.app.close().catch(() => {});
  }
  await runForgedRoot();
  finish();
})().catch((err) => {
  failed('driver', `crashed: ${err && err.stack || err}`);
  finish();
});

function finish() {
  report.finishedAt = new Date().toISOString();
  const counts = { passed: 0, failed: 0, 'not-run': 0 };
  for (const c of report.cases) counts[c.status]++;
  report.counts = counts;
  report.blockingNotRun = report.cases.filter(c => c.status === 'not-run' && c.mandatory === true).length;
  const exitCode = acceptanceExitCode(report.cases);
  const releaseEligibility = nativeReleaseEligibility({
    ...report.acceptanceIdentity,
    testCopy: report.testCopy,
    skipFix: SKIP_FIX,
    platform: report.host.platform,
    enableLUA: report.host.enableLUA
  }, report.cases);
  report.releaseGateEligible = releaseEligibility.eligible;
  report.releaseEligibilityReasons = releaseEligibility.reasons;
  report.evidenceClass = releaseEligibility.eligible ? 'native-final-artifact' : 'diagnostic';
  report.executionResult = exitCode === 0 ? 'passed' : 'failed';
  report.acceptanceResult = releaseEligibility.eligible
    ? 'passed'
    : (!TEST_COPY && !SKIP_FIX && exitCode !== 0 ? 'failed' : 'non-acceptance');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const lines = ['# Packaged acceptance', '', `Executable driven: \`${report.exe}\``, `Shipped executable: \`${report.shippedExe}\` (${report.testCopy ? 'packaged code driven through a manifest-modified asInvoker diagnostic copy; shipped executable untouched' : 'driven directly'})`, `Host: ${report.host.platform} ${report.host.release}, EnableLUA=${report.host.enableLUA}`, `Run: ${report.startedAt} → ${report.finishedAt}`, '',
    `Mode: ${report.mode} · Evidence: ${report.evidenceClass} · Execution: ${report.executionResult} · Release gate eligible: ${report.releaseGateEligible} · Result: ${report.acceptanceResult}`,
    `Release eligibility blockers: ${report.releaseEligibilityReasons.join(', ') || 'none'}`, '',
    '## Acceptance identity', '',
    `- Artifact kind: ${report.acceptanceIdentity.artifactKind || 'unbound'}`,
    `- Artifact head / expected head: ${report.acceptanceIdentity.artifactHead || 'unbound'} / ${report.acceptanceIdentity.expectedHead || 'unbound'}`,
    `- Shipped executable SHA-256 / expected: ${report.acceptanceIdentity.shippedExeSha256 || 'unavailable'} / ${report.acceptanceIdentity.expectedExeSha256 || 'unbound'}`,
    `- Effective support endpoint: ${report.acceptanceIdentity.effectiveSupportEndpoint || 'unset'}`,
    `- Support configuration revision / expected: ${report.acceptanceIdentity.supportConfigRevision || 'unavailable'} / ${report.acceptanceIdentity.expectedSupportConfigRevision || 'unbound'}`,
    `- Support configuration source/integrity: ${report.acceptanceIdentity.supportConfigSource || 'unavailable'} / ${report.acceptanceIdentity.supportConfigIntegrity}`,
    `- Operator attestation: ${report.acceptanceIdentity.operatorAttestation.present ? (report.acceptanceIdentity.operatorAttestation.valid ? 'valid' : 'invalid') : 'missing'}`, '',
    `Passed ${counts.passed} · Failed ${counts.failed} · Not run ${counts['not-run']} · Mandatory not run ${report.blockingNotRun}`, '',
    '| Case | Result | Detail | Evidence |', '|---|---|---|---|'];
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const c of report.cases) {
    const evidence = [c.screenshot || '', Array.isArray(c.launchTrace) && c.launchTrace.length
      ? `launch trace: ${c.launchTrace.join(' ⟶ ')}` : ''].filter(Boolean).join(' · ');
    lines.push(`| ${c.id} | ${c.status} | ${cell(c.detail)} | ${cell(evidence)} |`);
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
  console.log(`packaged-acceptance: execution=${report.executionResult} evidence=${report.evidenceClass} releaseEligible=${report.releaseGateEligible} passed=${counts.passed} failed=${counts.failed} not-run=${counts['not-run']} → ${OUT}`);
  process.exit(exitCode);
}
