#!/usr/bin/env node
'use strict';

/**
 * UI state-capture harness for the Zoom-requirement guided recovery card
 * (§31 evidence tooling; UI directive 2026-08-09).
 *
 * Loads the REAL index.html / messages.js / run-verdict.js / renderer.js in
 * headless Chromium (global Playwright, resolved the same way the Chrome
 * repo's scripts/test-popup-e2e.js does) with a mocked window.electronAPI
 * that forces each card state through the REAL renderer code paths, then
 * captures labeled screenshots and asserts the rendered state string
 * byte-equals the messages.js catalog.
 *
 * HONESTY LABEL (applies to every capture this tool produces):
 *   "harness render, mocked states — not the packaged app"
 * The page code, styles, and copy are the shipped files; the electronAPI
 * data (scan results, installer verdicts) is mocked. Packaged-app visual
 * inspection is a separate, real-environment step.
 *
 * Also captures the PRE-CHANGE blocked state: the base-commit versions of
 * the four page files are extracted with `git show <base>:<file>` into a
 * temp dir (assets copied from the worktree — identical at both commits)
 * and rendered with the same mock for the before/after comparison.
 *
 * Run:  node tools/ui-state-capture.js --out <dir> [--base 38d265a]
 * Exits non-zero if any state render FAILS its assertion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const messages = require('../messages.js');
const zoomDetect = require('../zoom-detect.js');

const ROOT = path.resolve(__dirname, '..');
const LABEL = 'harness render, mocked states — not the packaged app';
const Z = messages.ZOOM_RECOVERY;

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, '.ui-captures')));
const BASE_SHA = argOf('--base', '38d265a');

// ---------------------------------------------------------------- playwright
// Same resolution strategy as 1132-Fixer-Chrome scripts/lib/playwright.js:
// normal resolution -> global npm root -> Windows global npm prefix. No
// repo dependency is added.
function requirePlaywright() {
  const candidates = ['playwright'];
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = execFileSync(npm, ['root', '-g'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (root) candidates.push(path.join(root, 'playwright'));
  } catch { /* npm not on PATH — fall through */ }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
  }
  const tried = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { tried.push(`${c} (${e.code || e.message})`); }
  }
  throw new Error('playwright could not be resolved. Install globally: npm install -g playwright\nTried:\n  ' + tried.join('\n  '));
}
const { chromium } = requirePlaywright();

// ---------------------------------------------------------------- scan data
// The zoom row + blocker reuse the REAL detection copy (zoom-detect.js);
// the other checklist rows carry plausible mocked text — covered by LABEL.
const NOT_FOUND_INSTALL = { path: null, dir: null, source: null, perUserPath: null };
const PER_USER_INSTALL = { path: null, dir: null, source: null, perUserPath: 'C:\\Users\\user\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' };
const FOUND_INSTALL = { path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe', dir: 'C:\\Program Files\\Zoom\\bin', source: 'default-x64', perUserPath: null };

function baseCards() {
  return {
    admin:       { status: 'ready', label: 'Administrator',       message: 'Running elevated.' },
    helperUser:  { status: 'ready', label: 'Helper account',      message: "'user1' will be created on FIX NOW." },
    seclogon:    { status: 'ready', label: 'Secondary Logon',     message: 'Running — ready to launch Zoom as user1.' },
    camPolicy:   { status: 'ready', label: 'Camera policy',       message: 'No restrictive policy detected.' },
    micPolicy:   { status: 'ready', label: 'Microphone policy',   message: 'No restrictive policy detected.' },
    hku:         { status: 'ready', label: 'User registry hive',  message: "No 'user1' SID yet — fresh create, nothing to mount." },
    frameServer: { status: 'ready', label: 'Camera Frame Server', message: 'Running / Manual.' }
  };
}

function blockedScan(install) {
  const cards = baseCards();
  cards.zoom = { status: 'blocked', label: 'Zoom Workplace', message: zoomDetect.zoomStatusMessage(install) };
  return {
    cards, overall: 'blocked', canRunFix: false,
    blockers: [{ code: 'zoom_not_found', message: zoomDetect.zoomStatusMessage(install) }],
    warnings: [], info: { zoomInstall: install }
  };
}

function readyScan() {
  const cards = baseCards();
  cards.zoom = { status: 'ready', label: 'Zoom Workplace', message: zoomDetect.zoomStatusMessage(FOUND_INSTALL) };
  return { cards, overall: 'ready', canRunFix: true, blockers: [], warnings: [], info: { zoomInstall: FOUND_INSTALL } };
}

// ---------------------------------------------------------------- mock
// Injected before page scripts. cfg.scans: per-call preflightScan results
// ('HANG' = pending forever; past the end repeats the last entry).
function mockScript(cfg) {
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const pending = () => new Promise(() => {});
  let scanCall = 0;
  window.electronAPI = {
    runFix: pending, createShortcut: pending,
    shortcutExists: async () => ({ exists: true, valid: true, path: 'C:\\\\Users\\\\user\\\\Desktop\\\\Launch Zoom.lnk' }),
    isElevated: async () => true,
    preflight: pending,
    preflightScan: async () => {
      const i = Math.min(scanCall, CFG.scans.length - 1);
      const r = CFG.scans[scanCall < CFG.scans.length ? scanCall : i];
      scanCall++;
      if (r === 'HANG') return pending();
      return r;
    },
    supportReport: async () => ({ markdown: '(mock support report)' }),
    onFixLog: () => () => {}, onUpdateStatus: () => () => {}, onZoomInstallerDone: () => () => {},
    installUpdateNow: pending, deferUpdate: pending, openDownloadPage: pending, openWebsite: pending,
    minimizeWindow: async () => {}, maximizeWindow: async () => {}, quitApp: async () => {},
    submitFeedback: async () => ({ success: true }),
    getVersion: async () => '5.6.0',
    getSystemInfo: async () => ({ version: '5.6.0', os: 'harness', admin: true }),
    zoomOpenDownload: async () => (CFG.openDownload === 'HANG' ? pending() : CFG.openDownload),
    zoomChooseInstaller: async () => (CFG.chooseInstaller === 'HANG' ? pending() : CFG.chooseInstaller),
    zoomRunInstaller: async () => ({ started: true })
  };
})();`;
}

// ---------------------------------------------------------------- scenarios
// Each scenario drives the REAL renderer through user-visible steps and
// asserts the card's end state. expectState strings come straight from the
// messages.js catalog (byte-equality in the page).
const SCENARIOS = [
  {
    id: 'blocked-initial',
    desc: 'Machine-wide Zoom missing — first render of the recovery card (no state line yet)',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL)] },
    expect: { cardVisible: true, stateHidden: true }
  },
  {
    id: 'wrong-version',
    desc: 'Per-user Zoom only (perUserPath present, path null) — Wrong-version state',
    cfg: { scans: [blockedScan(PER_USER_INSTALL)] },
    expect: { cardVisible: true, state: Z.STATES.wrong_version }
  },
  {
    id: 'downloading',
    desc: 'Download Zoom MSI clicked; openExternal still in flight — Downloading state',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL)], openDownload: 'HANG' },
    action: { click: '#zrDownloadBtn' },
    expect: { cardVisible: true, state: Z.STATES.downloading }
  },
  {
    id: 'waiting',
    desc: 'Download page opened successfully — Waiting state',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL)], openDownload: { success: true } },
    action: { click: '#zrDownloadBtn' },
    expect: { cardVisible: true, state: Z.STATES.waiting }
  },
  {
    id: 'offline',
    desc: 'openExternal failed — Offline state',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL)], openDownload: { success: false } },
    action: { click: '#zrDownloadBtn' },
    expect: { cardVisible: true, state: Z.STATES.offline }
  },
  {
    id: 'checking',
    desc: 'I installed it — Check again clicked; re-scan in flight — Checking state',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL), 'HANG'] },
    action: { click: '#zrRecheckBtn' },
    expect: { cardVisible: true, state: Z.STATES.checking }
  },
  {
    id: 'still-not-found',
    desc: 'Re-check completed, still no machine-wide install — Still-not-found state',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL), blockedScan(NOT_FOUND_INSTALL)] },
    action: { click: '#zrRecheckBtn' },
    expect: { cardVisible: true, state: Z.STATES.still_not_found }
  },
  {
    id: 'success-pass',
    desc: 'Re-check found the machine-wide install — Success state, card flips to pass',
    cfg: { scans: [blockedScan(NOT_FOUND_INSTALL), readyScan()] },
    action: { click: '#zrRecheckBtn' },
    expect: { cardVisible: true, state: Z.STATES.success, dataState: 'pass' }
  },
  {
    id: 'refusal-publisher',
    desc: 'Chosen installer signed by the wrong publisher — explained refusal, nothing run',
    cfg: {
      scans: [blockedScan(NOT_FOUND_INSTALL)],
      chooseInstaller: { ok: false, message: messages.zoomInstallerRefusal('publisher', 'Evil Corp') }
    },
    action: { click: '#zrChooseBtn' },
    expect: { cardVisible: true, state: messages.zoomInstallerRefusal('publisher', 'Evil Corp') }
  },
  {
    id: 'uac-note',
    desc: 'Chosen installer passed all checks — admin-approval explanation before msiexec',
    cfg: {
      scans: [blockedScan(NOT_FOUND_INSTALL)],
      chooseInstaller: { ok: true, fileName: 'ZoomInstallerFull.msi' }
    },
    action: { click: '#zrChooseBtn' },
    expect: { cardVisible: true, state: Z.UAC_NOTE }
  },
  {
    id: 'tech-details-open',
    desc: 'Technical details disclosure open — raw paths demoted there',
    cfg: { scans: [blockedScan(PER_USER_INSTALL)] },
    action: { openTechDetails: true },
    expect: { cardVisible: true, techOpen: true }
  }
];

// Viewport variants. 200pct-stress: 450 CSS px wide at deviceScaleFactor 2
// — the width the layout gets at 200% zoom of a 900px window (WCAG 1.4.4
// reflow stress); the canvas is tall so the card itself is in frame.
// HONESTY BOUNDARY: the packaged app can never reach a 450-px CSS viewport
// — Electron enforces minWidth 720 in DIPs, and Windows display scaling
// changes physical pixels, not CSS pixels (at 200% display scaling the
// layout is identical to the 100% shots). So the stress variant is a
// synthetic harder-than-reality wrap test, and its clicks are PROGRAMMATIC
// (element.click()): below the app's real minimum the compressed layout
// can cover the button center, which Playwright's strict pointer hit-test
// correctly refuses. Pointer clicks at 100% remain the genuine
// clickability evidence.
const VARIANTS = [
  { id: '100pct', viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, clickMode: 'pointer' },
  { id: '200pct-stress', viewport: { width: 450, height: 900 }, deviceScaleFactor: 2, clickMode: 'programmatic' }
];
const MIN_WINDOW_VARIANT = { id: 'min-window-720x640', viewport: { width: 720, height: 640 }, deviceScaleFactor: 1, clickMode: 'pointer' };

// ---------------------------------------------------------------- helpers
let passed = 0;
let failed = 0;
const manifest = [];

function verdict(ok, name, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
  return ok ? 'PASS' : 'FAIL';
}

async function renderScenario(pageUrl, scenario, variant, fileName, meta) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: variant.viewport,
      deviceScaleFactor: variant.deviceScaleFactor
    });
    await context.addInitScript(mockScript(scenario.cfg));
    const page = await context.newPage();
    const pageErrors = [];
    const external = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith('file:')) external.push(r.url()); });

    await page.goto(pageUrl, { waitUntil: 'load' });

    // Bootstrap settles when the first scan result has rendered.
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.chk-row');
      return rows.length > 0 && !document.querySelector('.chk-row[data-status="pending"]');
    }, null, { timeout: 15000 });

    if (scenario.action && scenario.action.click) {
      if (variant.clickMode === 'programmatic') {
        await page.waitForSelector(scenario.action.click, { timeout: 15000 });
        await page.evaluate(sel => document.querySelector(sel).click(), scenario.action.click);
      } else {
        await page.click(scenario.action.click, { timeout: 15000 });
      }
    }
    if (scenario.action && scenario.action.openTechDetails) {
      await page.evaluate(() => {
        const tech = document.getElementById('zrTech');
        if (tech) tech.closest('details').open = true;
      });
    }

    // Wait for the expected end state, then judge it.
    const exp = scenario.expect;
    if (exp.state) {
      await page.waitForFunction((want) => {
        const el = document.getElementById('zrStatus');
        return el && !el.hidden && el.textContent === want;
      }, exp.state, { timeout: 15000 }).catch(() => {});
    }
    const got = await page.evaluate(() => {
      const card = document.getElementById('zoomRecovery');
      const st = document.getElementById('zrStatus');
      const tech = document.getElementById('zrTech');
      return {
        hasCard: !!card,
        cardVisible: !!card && !card.hidden,
        dataState: card ? card.dataset.state || '' : '',
        stateHidden: st ? st.hidden : null,
        stateText: st ? st.textContent : null,
        techOpen: tech ? tech.closest('details').open : null,
        techText: tech ? tech.textContent : null,
        bodyScrollW: document.body.scrollWidth,
        innerW: window.innerWidth
      };
    });

    let ok = true;
    const problems = [];
    if (exp.noCardElement) {
      if (got.hasCard) { ok = false; problems.push('old tree unexpectedly has #zoomRecovery'); }
    } else {
      if (got.cardVisible !== exp.cardVisible) { ok = false; problems.push(`cardVisible=${got.cardVisible}`); }
      if (exp.state && got.stateText !== exp.state) { ok = false; problems.push(`state text mismatch: ${JSON.stringify(got.stateText)}`); }
      if (exp.stateHidden && got.stateHidden !== true) { ok = false; problems.push('state line should be hidden'); }
      if (exp.dataState && got.dataState !== exp.dataState) { ok = false; problems.push(`data-state=${got.dataState}`); }
      if (exp.techOpen && got.techOpen !== true) { ok = false; problems.push('tech details not open'); }
      if (exp.techOpen && !/Program Files/.test(got.techText || '')) { ok = false; problems.push('tech details missing raw path'); }
    }
    if (got.bodyScrollW > got.innerW) { ok = false; problems.push(`horizontal overflow: scrollW ${got.bodyScrollW} > ${got.innerW}`); }
    if (pageErrors.length) { ok = false; problems.push('page errors: ' + pageErrors.join('; ')); }
    if (external.length) { ok = false; problems.push('non-file:// requests: ' + external.join('; ')); }

    // Bring the card into view for the shot (old tree: the checklist).
    await page.evaluate(() => {
      const el = document.getElementById('zoomRecovery') || document.getElementById('checkList');
      if (el && !el.hidden) el.scrollIntoView({ block: 'nearest' });
    });
    fs.mkdirSync(path.dirname(fileName), { recursive: true });
    await page.screenshot({ path: fileName });

    const v = verdict(ok, `${meta.tree} ${scenario.id} [${variant.id}]`, problems.join(' | '));
    manifest.push({
      file: path.basename(fileName),
      label: LABEL,
      tree: meta.tree,
      commit: meta.commit,
      branch: meta.branch,
      scenario: scenario.id,
      description: scenario.desc,
      variant: variant.id,
      viewportCss: `${variant.viewport.width}x${variant.viewport.height}`,
      deviceScaleFactor: variant.deviceScaleFactor,
      clickMode: (scenario.action && scenario.action.click) ? variant.clickMode : 'none',
      theme: 'app dark theme (only theme shipped)',
      data: 'mocked electronAPI scan/installer results; zoom-row copy from real zoom-detect.js',
      verdict: v,
      problems
    });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- old tree
function extractOldTree(sha) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-ui-old-'));
  // ui-state.js is optional: base commits older than the truthful-UI-state
  // change do not have it, and index.html there does not load it.
  for (const f of ['index.html', 'messages.js', 'run-verdict.js', 'ui-state.js', 'renderer.js']) {
    let buf;
    try {
      buf = execFileSync('git', ['show', `${sha}:${f}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    } catch (_) {
      if (f === 'ui-state.js') continue;
      throw new Error(`extractOldTree: ${f} missing at ${sha}`);
    }
    fs.writeFileSync(path.join(tmp, f), buf);
  }
  // Assets are identical at both commits (verified by git diff --stat).
  fs.cpSync(path.join(ROOT, 'assets'), path.join(tmp, 'assets'), { recursive: true });
  return tmp;
}

// ---------------------------------------------------------------- main
(async () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const newUrl = pathToFileURL(path.join(ROOT, 'index.html')).href;
  const shotsDir = path.join(OUT_DIR, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  console.log(`ui-state-capture: HEAD ${commit.slice(0, 7)} (${branch}) -> ${OUT_DIR}`);
  console.log(`LABEL for every capture: ${LABEL}\n`);

  // --- BEFORE: base-commit blocked state --------------------------------
  console.log(`OLD tree @ ${BASE_SHA} (pre-change blocked state)`);
  const oldDir = extractOldTree(BASE_SHA);
  try {
    const oldUrl = pathToFileURL(path.join(oldDir, 'index.html')).href;
    await renderScenario(
      oldUrl,
      {
        id: 'old-blocked',
        desc: `PRE-CHANGE baseline @ ${BASE_SHA}: blocked zoom checklist row, no recovery card in the DOM`,
        cfg: { scans: [blockedScan(NOT_FOUND_INSTALL)] },
        expect: { noCardElement: true }
      },
      VARIANTS[0],
      path.join(shotsDir, `harness-mocked--old-${BASE_SHA}-blocked--100pct.png`),
      { tree: `old@${BASE_SHA}`, commit: BASE_SHA, branch }
    );
  } finally {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  // --- AFTER: every card state at 100% and the 200% stress --------------
  // One capture failing must never sink the rest of the evidence run: each
  // scenario/variant is isolated and a crash records a FAIL entry.
  const guarded = async (scenario, variant, file, meta) => {
    try {
      await renderScenario(newUrl, scenario, variant, file, meta);
    } catch (e) {
      verdict(false, `${meta.tree} ${scenario.id} [${variant.id}]`, `capture crashed: ${e.message}`);
      manifest.push({
        file: path.basename(file), label: LABEL, tree: meta.tree, commit: meta.commit,
        branch: meta.branch, scenario: scenario.id, description: scenario.desc,
        variant: variant.id, verdict: 'FAIL', problems: ['capture crashed: ' + e.message]
      });
    }
  };
  for (const scenario of SCENARIOS) {
    console.log(`\n${scenario.id} — ${scenario.desc}`);
    for (const variant of VARIANTS) {
      await guarded(
        scenario, variant,
        path.join(shotsDir, `harness-mocked--${scenario.id}--${variant.id}.png`),
        { tree: 'new@HEAD', commit, branch }
      );
    }
  }

  // --- minimum-window shot ---------------------------------------------
  console.log('\nminimum window 720x640 (blocked-initial)');
  await guarded(
    SCENARIOS[0], MIN_WINDOW_VARIANT,
    path.join(shotsDir, `harness-mocked--blocked-initial--${MIN_WINDOW_VARIANT.id}.png`),
    { tree: 'new@HEAD', commit, branch }
  );

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
    label: LABEL,
    generated: new Date().toISOString(),
    repo: '1132-Fixer-Windows',
    branch,
    headCommit: commit,
    baseCommit: BASE_SHA,
    tool: 'tools/ui-state-capture.js (headless Chromium via global Playwright)',
    captures: manifest
  }, null, 2));

  console.log(`\nPassed: ${passed}  Failed: ${failed}`);
  console.log(`Wrote ${manifest.length} captures + manifest.json under ${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('\nui-state-capture crashed:', (e && e.stack) || e);
  process.exit(1);
});
