#!/usr/bin/env node
'use strict';

/**
 * Repair-panel main-window state capture (feat/repair-panel-redesign).
 *
 * Loads the REAL index.html / messages.js / run-verdict.js / ui-state.js /
 * renderer.js in headless Chromium (global Playwright, same resolution
 * strategy as tools/ui-state-capture.js) with a mocked window.electronAPI,
 * and drives the MAIN wizard shell through its user-visible states:
 *   checking, fix-available, action-needed, repairing, success, error.
 * Each state is screenshotted at ~1000x760 (the supported window size) and
 * checked for vertical/horizontal overflow of the viewport.
 *
 * HONESTY LABEL: "harness render, mocked electronAPI — not the packaged app".
 * The page code, styles and copy are the shipped files; the scan/fix data
 * is mocked.
 *
 * Run:  node tools/repair-panel-capture.js --out .audit/repair-panel
 * Exits non-zero if any capture reports viewport overflow or a page error.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const LABEL = 'harness render, mocked electronAPI — not the packaged app';

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, '.audit', 'repair-panel')));
const VIEWPORT = { width: 1000, height: 760 };

// ---------------------------------------------------------------- playwright
function requirePlaywright() {
  const candidates = ['playwright'];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
  }
  const tried = [];
  for (const c of candidates) {
    try { return require(c); } catch (e) { tried.push(`${c} (${e.code || e.message})`); }
  }
  throw new Error('playwright not resolvable. Install: npm i -g playwright\nTried:\n  ' + tried.join('\n  '));
}
const { chromium } = requirePlaywright();

// ---------------------------------------------------------------- scan data
const FOUND_INSTALL = { path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe', dir: 'C:\\Program Files\\Zoom\\bin', source: 'default-x64', perUserPath: null };

// Every CHECK_ORDER card the renderer expects, all 'ready' by default.
function readyCards() {
  return {
    admin:       { status: 'ready', label: 'Administrator',       message: 'Running elevated.' },
    zoom:        { status: 'ready', label: 'Zoom Workplace',      message: 'Zoom Workplace found (machine-wide install).' },
    helperUser:  { status: 'ready', label: 'Helper account',      message: "'user1' will be created on FIX NOW." },
    helperProfile: { status: 'ready', label: 'Helper profile',    message: 'Fresh create — no stale profile to repair.' },
    seclogon:    { status: 'ready', label: 'Secondary Logon',     message: 'Running — ready to launch Zoom as user1.' },
    camPolicy:   { status: 'ready', label: 'Camera policy',       message: 'No restrictive policy detected.' },
    micPolicy:   { status: 'ready', label: 'Microphone policy',   message: 'No restrictive policy detected.' },
    hku:         { status: 'ready', label: 'User registry hive',  message: "No 'user1' SID yet — fresh create." },
    frameServer: { status: 'ready', label: 'Camera Frame Server', message: 'Running / Manual.' }
  };
}

// A repairable helper profile -> "Fix available" result state.
function repairableScan() {
  const cards = readyCards();
  cards.helperUser = { status: 'repairable', label: 'Helper account', message: "Existing 'user1' profile is TEMP/suffixed — the fix will repair it." };
  return { cards, overall: 'repairable', canRunFix: true, blockers: [], warnings: [], info: { zoomInstall: FOUND_INSTALL } };
}

// A blocked check (non-Zoom) -> "Action required" result state.
function blockedScan() {
  const cards = readyCards();
  cards.seclogon = { status: 'blocked', label: 'Secondary Logon', message: 'Secondary Logon service is Disabled — it must be Manual or Automatic to launch Zoom as user1.' };
  return {
    cards, overall: 'blocked', canRunFix: false,
    blockers: [{ code: 'seclogon_disabled', message: 'Secondary Logon service is disabled.' }],
    warnings: [], info: { zoomInstall: FOUND_INSTALL }
  };
}

function readyScan() {
  return { cards: readyCards(), overall: 'ready', canRunFix: true, blockers: [], warnings: [], info: { zoomInstall: FOUND_INSTALL } };
}

const FIX_SUCCESS = {
  success: true, partial: false, warnings: [],
  steps: [
    { key: 'prep', label: 'Prepare', outcome: 'ok', detail: 'Prepared.' },
    { key: 'helper', label: 'Helper account', outcome: 'ok', detail: 'user1 ready.' },
    { key: 'consent', label: 'Camera & mic', outcome: 'ok', detail: 'Granted.' },
    { key: 'launch', label: 'Launch', outcome: 'ok', detail: 'Launched.' },
    { key: 'receipt', label: 'Verify', outcome: 'ok', detail: 'Verified.' }
  ],
  receipt: { camera: 'ok', microphone: 'ok', hive: 'ok', frameServer: 'ok' }
};
const FIX_FAILURE = { success: false, error: 'The helper account could not be created (Windows returned access denied).', blockers: [{ code: 'net_user_failed', message: 'net user creation failed with exit code 2.' }], warnings: [] };

// ---------------------------------------------------------------- mock
function mockScript(cfg) {
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const pending = () => new Promise(() => {});
  let scanCall = 0;
  window.electronAPI = {
    isElevated: async () => true,
    preflightScan: async () => {
      const i = Math.min(scanCall, CFG.scans.length - 1);
      const r = CFG.scans[i];
      scanCall++;
      if (r === 'HANG') return pending();
      return r;
    },
    runFix: async () => (CFG.fix === 'HANG' ? pending() : CFG.fix),
    createShortcut: async () => ({ success: true, path: 'C:\\\\Users\\\\user\\\\Desktop\\\\Zoom — User1.lnk', legacyRemoved: [], legacyRemovalFailed: [] }),
    shortcutExists: async () => ({ exists: false, valid: false, path: null }),
    launchZoomHelper: async () => ({ ok: true }),
    relaunchElevated: async () => ({ started: false }),
    preflight: pending,
    supportReport: async () => ({ markdown: '(mock support report)' }),
    onFixLog: () => () => {}, onUpdateStatus: () => () => {}, onZoomInstallerDone: () => () => {},
    installUpdateNow: pending, deferUpdate: pending, openDownloadPage: pending,
    openExploreDestination: async () => ({ success: true }),
    minimizeWindow: async () => {}, maximizeWindow: async () => {}, quitApp: async () => {},
    submitFeedback: async () => ({ success: true }),
    getVersion: async () => '6.1.0',
    getSystemInfo: async () => ({ version: '6.1.0', os: 'harness', admin: true }),
    zoomOpenDownload: async () => ({ success: true }),
    zoomChooseInstaller: async () => ({ ok: true, fileName: 'x.msi' }),
    zoomRunInstaller: async () => ({ started: true })
  };
})();`;
}

// ---------------------------------------------------------------- scenarios
const SCENARIOS = [
  {
    id: '1-checking',
    desc: 'Environment scan in flight — Checking pane',
    cfg: { scans: ['HANG'] },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizChecking').classList.contains('active'), null, { timeout: 8000 });
      await page.waitForTimeout(300);
    }
  },
  {
    id: '2-fix-available',
    desc: 'Repairable helper profile — Fix available result pane',
    cfg: { scans: [repairableScan()] },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizResult').classList.contains('active'), null, { timeout: 10000 });
      await page.waitForFunction(() => !document.getElementById('fixBtn').hidden, null, { timeout: 5000 });
      await page.waitForTimeout(300);
    }
  },
  {
    id: '3-action-needed',
    desc: 'Non-Zoom blocker (Secondary Logon disabled) — Action required result pane',
    cfg: { scans: [blockedScan()] },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizResult').classList.contains('active'), null, { timeout: 10000 });
      await page.waitForTimeout(300);
    }
  },
  {
    id: '4-repairing',
    desc: 'Fix running — Repairing pane (stage rail)',
    cfg: { scans: [repairableScan()], fix: 'HANG' },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizResult').classList.contains('active'), null, { timeout: 10000 });
      await page.click('#fixBtn', { timeout: 8000 });
      // Fix now has a short countdown before it starts; wait for the fixing pane.
      await page.waitForFunction(() => document.getElementById('wizFixing').classList.contains('active'), null, { timeout: 12000 });
      await page.waitForTimeout(400);
    }
  },
  {
    id: '5-success',
    desc: 'Fix succeeded — Success notice pane',
    cfg: { scans: [repairableScan()], fix: FIX_SUCCESS },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizResult').classList.contains('active'), null, { timeout: 10000 });
      await page.click('#fixBtn', { timeout: 8000 });
      await page.waitForFunction(() => document.getElementById('wizNotice').classList.contains('active') &&
        !/wrong|fail/i.test(document.getElementById('wizNoticeTitle').textContent || ''), null, { timeout: 15000 });
      await page.waitForTimeout(300);
    }
  },
  {
    id: '6-error',
    desc: 'Fix failed — Error notice pane',
    cfg: { scans: [repairableScan()], fix: FIX_FAILURE },
    settle: async (page) => {
      await page.waitForFunction(() => document.getElementById('wizResult').classList.contains('active'), null, { timeout: 10000 });
      await page.click('#fixBtn', { timeout: 8000 });
      await page.waitForFunction(() => document.getElementById('wizNotice').classList.contains('active'), null, { timeout: 15000 });
      await page.waitForTimeout(300);
    }
  }
];

// ---------------------------------------------------------------- run
let passed = 0, failed = 0;
const manifest = [];

async function capture(pageUrl, scenario) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(mockScript(scenario.cfg));
    const page = await context.newPage();
    const pageErrors = [];
    const external = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) external.push(r.url()); });

    await page.goto(pageUrl, { waitUntil: 'load' });
    await scenario.settle(page);

    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const panel = document.querySelector('.repair-panel');
      const r = panel ? panel.getBoundingClientRect() : null;
      return {
        scrollW: de.scrollWidth, scrollH: de.scrollHeight,
        innerW: window.innerWidth, innerH: window.innerHeight,
        panel: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) } : null,
        // Optical-centering probe: space above vs below the card within .main.
        mainRect: (() => { const m = document.querySelector('.main'); const mr = m.getBoundingClientRect(); return { top: Math.round(mr.top), bottom: Math.round(mr.bottom) }; })()
      };
    });

    const problems = [];
    if (metrics.scrollH > metrics.innerH + 1) problems.push(`VERTICAL overflow: scrollH ${metrics.scrollH} > innerH ${metrics.innerH}`);
    if (metrics.scrollW > metrics.innerW + 1) problems.push(`HORIZONTAL overflow: scrollW ${metrics.scrollW} > innerW ${metrics.innerW}`);
    if (pageErrors.length) problems.push('page errors: ' + pageErrors.join('; '));
    if (external.length) problems.push('non-local requests: ' + external.join('; '));

    const file = path.join(OUT_DIR, `${scenario.id}.png`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: file });

    const ok = problems.length === 0;
    if (ok) { passed++; console.log(`  PASS  ${scenario.id}`); }
    else { failed++; console.log(`  FAIL  ${scenario.id} — ${problems.join(' | ')}`); }

    let centering = null;
    if (metrics.panel) {
      const above = metrics.panel.top - metrics.mainRect.top;
      const below = metrics.mainRect.bottom - metrics.panel.bottom;
      centering = { above, below, delta: above - below };
    }
    manifest.push({
      file: path.basename(file), scenario: scenario.id, description: scenario.desc,
      label: LABEL, viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      panel: metrics.panel, centering, verdict: ok ? 'PASS' : 'FAIL', problems
    });
  } finally {
    await browser.close();
  }
}

(async () => {
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`repair-panel-capture -> ${OUT_DIR}  (viewport ${VIEWPORT.width}x${VIEWPORT.height})`);
  console.log(`LABEL: ${LABEL}\n`);
  for (const s of SCENARIOS) {
    console.log(`${s.id} — ${s.desc}`);
    try { await capture(url, s); }
    catch (e) { failed++; console.log(`  FAIL  ${s.id} — capture crashed: ${e.message.split('\n')[0]}`); manifest.push({ scenario: s.id, verdict: 'FAIL', problems: ['crash: ' + e.message.split('\n')[0]] }); }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ label: LABEL, generated: new Date().toISOString(), viewport: VIEWPORT, captures: manifest }, null, 2));
  console.log(`\nPassed ${passed}  Failed ${failed}\nWrote ${manifest.length} captures + manifest.json to ${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('capture crashed:', e.stack || e); process.exit(1); });
